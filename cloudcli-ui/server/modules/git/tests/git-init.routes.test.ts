import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import express from 'express';

import { createGitRouter } from '@/modules/git/git.routes.js';
import { bridgeGitFileSystem } from '@/modules/workspace-bridge/index.js';
import { WORKSPACES_ROOT } from '@/shared/index.js';

test('git init does not run when repository validation fails for an execution error', async () => {
  const commands: string[][] = [];
  const spawnProcess = ((_command: string, args: string[]) => {
    commands.push(args);
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    process.nextTick(() => {
      child.emit('error', Object.assign(new Error('permission denied'), { code: 'EACCES' }));
      child.emit('close', -1);
    });
    return child;
  }) as Parameters<typeof createGitRouter>[0]['spawnProcess'];
  const unexpectedProvider = async (): Promise<never> => { throw new Error('unexpected provider call'); };
  const router = createGitRouter({
    fileSystem: { access: async () => undefined } as unknown as Parameters<typeof createGitRouter>[0]['fileSystem'],
    spawnProcess,
    resolveProjectPathById: () => '/workspace/repo',
    queryClaude: unexpectedProvider,
    queryCursor: unexpectedProvider,
  });
  const app = express();
  app.use(express.json());
  app.use('/api/git', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/git/init`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'project-1' }),
    });
    const body = await response.json() as { success: boolean; error: string };
    assert.equal(body.success, false);
    assert.match(body.error, /permission denied/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  assert.deepEqual(commands, [['rev-parse', '--is-inside-work-tree']]);
});

test('delete branch parses force and uses Git force deletion', async () => {
  const commands: string[][] = [];
  const spawnProcess = ((_command: string, args: string[]) => {
    commands.push(args);
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    process.nextTick(() => {
      if (args.includes('--is-inside-work-tree')) child.stdout.write('true\n');
      if (args.includes('--show-toplevel')) child.stdout.write('/workspace/repo\n');
      if (args.includes('--show-current')) child.stdout.write('main\n');
      if (args.includes('-D')) child.stdout.write('Deleted branch feature/unmerged.\n');
      child.stdout.end();
      child.stderr.end();
      child.emit('close', 0);
    });
    return child;
  }) as Parameters<typeof createGitRouter>[0]['spawnProcess'];
  const unexpectedProvider = async (): Promise<never> => { throw new Error('unexpected provider call'); };
  const router = createGitRouter({
    fileSystem: { access: async () => undefined } as unknown as Parameters<typeof createGitRouter>[0]['fileSystem'],
    spawnProcess,
    resolveProjectPathById: () => '/workspace/repo',
    queryClaude: unexpectedProvider,
    queryCursor: unexpectedProvider,
  });
  const app = express();
  app.use(express.json());
  app.use('/api/git', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/git/delete-branch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'project-1', branch: 'feature/unmerged', force: true }),
    });
    const body = await response.json() as { success: boolean; output: string };
    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.match(body.output, /Deleted branch/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  assert.deepEqual(commands.at(-1), ['branch', '-D', '--', 'feature/unmerged']);
});

test('delete branch rejects a non-boolean force value before running Git', async () => {
  const spawnProcess = (() => {
    throw new Error('Git must not run for invalid input');
  }) as Parameters<typeof createGitRouter>[0]['spawnProcess'];
  const unexpectedProvider = async (): Promise<never> => { throw new Error('unexpected provider call'); };
  const router = createGitRouter({
    fileSystem: { access: async () => undefined } as unknown as Parameters<typeof createGitRouter>[0]['fileSystem'],
    spawnProcess,
    resolveProjectPathById: () => '/workspace/repo',
    queryClaude: unexpectedProvider,
    queryCursor: unexpectedProvider,
  });
  const app = express();
  app.use(express.json());
  app.use('/api/git', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/git/delete-branch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'project-1', branch: 'feature/unmerged', force: 'yes' }),
    });
    const body = await response.json() as { error: string };
    assert.equal(response.status, 400);
    assert.equal(body.error, 'force must be a boolean');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('initial commit preserves an authoritative workspace failure instead of treating it as missing HEAD', async () => {
  const root = await mkdtemp(path.join(path.resolve(WORKSPACES_ROOT), 'git-authoritative-'));
  const calls: Array<Record<string, unknown>> = [];
  const control = createServer(async (incoming, outgoing) => {
    const bytes: Buffer[] = [];
    for await (const chunk of incoming) bytes.push(Buffer.from(chunk));
    const request = JSON.parse(Buffer.concat(bytes).toString()) as Record<string, unknown>;
    calls.push(request);
    if (request.op === 'stat') outgoing.end(JSON.stringify({ size: 0, mtime: 1, mode: 0o755, dir: true }));
    else if ((request.argv as string[]).includes('--is-inside-work-tree')) outgoing.end(JSON.stringify({ stdout: 'true', exitCode: 0 }));
    else if ((request.argv as string[]).includes('--show-toplevel')) outgoing.end(JSON.stringify({ stdout: '/workspace\n', exitCode: 0 }));
    else { outgoing.statusCode = 503; outgoing.end(JSON.stringify({ error: 'workspace unavailable', code: 'WORKSPACE_UNAVAILABLE' })); }
  });
  control.listen(0, '127.0.0.1');
  await once(control, 'listening');
  const controlPort = (control.address() as AddressInfo).port;
  await writeFile(path.join(root, '.chisa-bridge.json'), JSON.stringify({ protocol: 1, port: controlPort, token: 'fixture', bindingEpoch: 'fixture' }));
  const app = express();
  app.use(express.json());
  const unexpected = async () => { throw new Error('unexpected provider'); };
  app.use(createGitRouter({
    fileSystem: bridgeGitFileSystem({} as never),
    resolveProjectPathById: () => root,
    spawnProcess: (() => { throw new Error('unexpected local Git'); }) as never,
    queryClaude: unexpected, queryCursor: unexpected,
  }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/initial-commit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: 'fixture' }) });
    assert.equal(response.status, 500);
    assert.match((await response.json() as { error: string }).error, /workspace unavailable/);
    assert.equal(calls.filter(call => call.op === 'exec').length, 3);
    assert.equal(calls.some(call => (call.argv as string[] | undefined)?.includes('add')), false);
  } finally {
    for (const listener of [server, control]) { listener.closeAllConnections(); await new Promise<void>(resolve => listener.close(() => resolve())); }
    assert.equal(path.dirname(root), path.resolve(WORKSPACES_ROOT));
    await rm(root, { recursive: true, force: true });
  }
});

test('HTTP disconnection cancels local Git and prevents a later commit stage', { timeout: 5000 }, async () => {
  const entering = (() => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; })();
  const cancelled = (() => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; })();
  const calls: string[][] = [];
  const spawnProcess = ((_command: string, args: string[], options: { signal: AbortSignal }) => {
    calls.push(args);
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
    queueMicrotask(() => {
      if (args.includes('--is-inside-work-tree')) child.stdout.write('true');
      if (args.includes('--show-toplevel')) child.stdout.write('/fixture-repo');
      if (args.includes('symbolic-ref')) {
        entering.resolve();
        options.signal.addEventListener('abort', () => {
          child.emit('error', Object.assign(new Error('cancelled'), { name: 'AbortError' }));
          child.emit('close', -1);
          cancelled.resolve();
        }, { once: true });
      } else child.emit('close', 0);
    });
    return child;
  }) as Parameters<typeof createGitRouter>[0]['spawnProcess'];
  const app = express();
  app.use(express.json());
  const unexpected = async () => { throw new Error('unexpected provider'); };
  app.use(createGitRouter({ fileSystem: { access: async () => {} } as never, spawnProcess, resolveProjectPathById: () => '/fixture-repo', queryClaude: unexpected, queryCursor: unexpected }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const client = httpRequest({ hostname: '127.0.0.1', port: (server.address() as AddressInfo).port, path: '/pull', method: 'POST', headers: { 'Content-Type': 'application/json' } });
  client.on('error', () => {});
  client.end(JSON.stringify({ project: 'fixture' }));
  try {
    await entering.promise;
    client.destroy();
    await cancelled.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(calls.length, 3);
    assert.equal(calls.some(args => args.includes('pull')), false);
  } finally {
    client.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
