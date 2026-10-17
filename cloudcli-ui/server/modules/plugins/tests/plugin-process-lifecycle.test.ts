import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import realSpawn from 'cross-spawn';

class PluginChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  signals: string[] = [];
  kill(signal = 'SIGTERM') { this.signals.push(signal); return true; }
  ready(port = 4100) { this.stdout.emit('data', Buffer.from(`${JSON.stringify({ ready: true, port })}\n`)); }
}

const children: PluginChild[] = [];
const environments: NodeJS.ProcessEnv[] = [];
let realChild: ReturnType<typeof realSpawn> | undefined;
mock.module('cross-spawn', {
  defaultExport: (command: string, args: string[], options: Parameters<typeof realSpawn>[2]) => {
    environments.push(options?.env ?? {});
    if (args[0]?.endsWith('os-child.cjs')) {
      realChild = realSpawn(command, args, options);
      return realChild;
    }
    const child = new PluginChild();
    children.push(child);
    return child;
  },
});
const { getPluginPort, isPluginRunning, startPluginServer, stopPluginServer } = await import('../plugin-process.service.js');
const settle = async () => { for (let count = 0; count < 8; count++) await Promise.resolve(); };

test('credential store paths reach only the shipped usage reader, never host token values', async () => {
  const keys = ['CLAUDE_SECURESTORAGE_CONFIG_DIR', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY'] as const;
  const before = keys.map((key) => process.env[key]);
  process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = '/shared/credentials';
  process.env.CLAUDE_CONFIG_DIR = '/private/claude';
  process.env.ANTHROPIC_API_KEY = 'host-secret-must-not-leak';
  try {
    const { getPluginDir } = await import('../plugin-registry.service.js');
    const shippedDirectory = getPluginDir('claude-usage');
    assert.ok(shippedDirectory);
    for (const [name, directory, expected] of [
      ['claude-usage', shippedDirectory, true],
      ['other-plugin', '/fixture', false],
      ['claude-usage', '/untrusted/usage', false],
    ] as const) {
      const startup = startPluginServer(name, directory, 'server.js');
      const child = children.at(-1)!;
      const env = environments.at(-1)!;
      assert.equal(env.CLAUDE_SECURESTORAGE_CONFIG_DIR, expected ? '/shared/credentials' : undefined);
      assert.equal(env.CLAUDE_CONFIG_DIR, expected ? '/private/claude' : undefined);
      assert.equal(env.ANTHROPIC_API_KEY, undefined);
      child.ready();
      await startup;
      const stopping = stopPluginServer(name);
      child.emit('exit', 0);
      await stopping;
    }
  } finally {
    keys.forEach((key, index) => {
      if (before[index] === undefined) delete process.env[key];
      else process.env[key] = before[index];
    });
  }
});

test('readiness is accepted once and a stop resolves only after real exit, not SIGKILL dispatch', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const startup = startPluginServer('stop-exit', '/fixture', 'server.js');
  const child = children.at(-1)!;
  child.stdout.emit('data', Buffer.from('{"ready":true,"port":4101}\n{"ready":true,"port":4102}\n'));
  assert.equal(await startup, 4101);
  assert.equal(getPluginPort('stop-exit'), 4101);
  let stopped = false;
  const stopping = stopPluginServer('stop-exit').then(() => { stopped = true; });
  assert.equal(getPluginPort('stop-exit'), undefined);
  assert.equal(isPluginRunning('stop-exit'), true);
  context.mock.timers.tick(5000);
  await settle();
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(stopped, false);
  await assert.rejects(startPluginServer('stop-exit', '/fixture', 'server.js'), /shutdown is not confirmed/);
  child.emit('exit', 0);
  await stopping;
  assert.equal(stopped, true);
  assert.equal(isPluginRunning('stop-exit'), false);
});

test('unconfirmed startup timeout retains its name and allows an explicit stop retry after failure', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const startup = startPluginServer('timeout-reserved', '/fixture', 'server.js');
  const child = children.at(-1)!;
  const failed = assert.rejects(startup, /did not report ready.*exit was not confirmed/);
  context.mock.timers.tick(10000);
  await settle();
  const spawned = children.length;
  await assert.rejects(startPluginServer('timeout-reserved', '/fixture', 'server.js'), /shutdown is not confirmed/);
  assert.equal(children.length, spawned);
  assert.equal(isPluginRunning('timeout-reserved'), true);
  context.mock.timers.tick(10000);
  await failed;
  assert.equal(isPluginRunning('timeout-reserved'), true);
  const stopped = stopPluginServer('timeout-reserved');
  child.emit('exit', 0);
  await stopped;
  assert.equal(isPluginRunning('timeout-reserved'), false);
});

test('a duplicate old exit/close cannot remove the replacement process entry', async () => {
  const first = startPluginServer('replace-identity', '/fixture', 'server.js');
  const old = children.at(-1)!;
  old.ready(4103);
  await first;
  old.emit('exit', 0);
  const replacement = startPluginServer('replace-identity', '/fixture', 'server.js');
  const current = children.at(-1)!;
  current.ready(4104);
  await replacement;
  old.emit('exit', 0);
  old.emit('close', 0);
  assert.equal(getPluginPort('replace-identity'), 4104);
  assert.equal(isPluginRunning('replace-identity'), true);
  current.emit('exit', 0);
});

test('disable during startup cancels readiness and cannot report success until child exit', async () => {
  const startup = startPluginServer('cancel-startup', '/fixture', 'server.js');
  const child = children.at(-1)!;
  const failed = assert.rejects(startup, /startup was canceled/);
  let stopped = false;
  const stopping = stopPluginServer('cancel-startup').then(() => { stopped = true; });
  child.ready();
  await settle();
  assert.equal(stopped, false);
  assert.equal(getPluginPort('cancel-startup'), undefined);
  child.emit('exit', 0);
  await Promise.all([stopping, failed]);
  assert.equal(stopped, true);
});

test('real OS child readiness and stop confirm process exit before returning', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chisa-plugin-exit-'));
  const fixture = path.join(directory, 'os-child.cjs');
  await writeFile(fixture, 'console.log(JSON.stringify({ready:true,port:4105}));setInterval(()=>{},1000);');
  try {
    assert.equal(await startPluginServer('os-child', directory, 'os-child.cjs'), 4105);
    assert.equal(getPluginPort('os-child'), 4105);
    const pid = realChild?.pid;
    assert.ok(pid);
    process.kill(pid, 0);
    const stopping = stopPluginServer('os-child');
    assert.equal(getPluginPort('os-child'), undefined);
    await stopping;
    assert.equal(isPluginRunning('os-child'), false);
    assert.ok(realChild?.exitCode !== null || realChild?.signalCode !== null);
    assert.throws(() => process.kill(pid, 0));
  } finally {
    await stopPluginServer('os-child');
    await rm(directory, { recursive: true, force: true });
  }
});
