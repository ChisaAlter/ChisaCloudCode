import assert from 'node:assert/strict';
import { spawn as realSpawn } from 'node:child_process';
import * as childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test, { mock } from 'node:test';

let launch: ((args: string[], options: { signal?: AbortSignal }) => ReturnType<typeof realSpawn>) | undefined;
mock.module('node:child_process', { namedExports: {
  ...childProcess,
  spawn: (_command: string, args: string[], options: { signal?: AbortSignal }) => launch!(args, options),
} });
const { spawnWorkspaceProcess } = await import('../workspace-process.service.js');
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(run: (context: { root: string; sourceRoot: string; workspacesRoot: string; runtime: string }) => Promise<void>) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'chisa-provider-container-'));
  const workspacesRoot = path.join(parent, 'workspaces'); const root = path.join(workspacesRoot, 'project'); const runtime = path.join(parent, 'runtime');
  await mkdir(root, { recursive: true }); await mkdir(runtime);
  try { await run({ root, sourceRoot: root, workspacesRoot, runtime }); }
  finally { assert.equal(path.dirname(workspacesRoot), parent); await rm(parent, { recursive: true, force: true }); }
}

test('streaming process preserves exact mount boundary and completes only after container removal', async () => {
  await fixture(async ({ runtime, ...context }) => {
    const removed = gate(); const removing = gate();
    const recorded: boolean[] = [];
    let child!: EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough };
    launch = args => {
      assert.ok(args.includes('localhost/chisa-workspace:3'));
      assert.ok(args.includes('--read-only'));
      assert.ok(args.includes(`type=bind,src=${context.root},dst=${context.root},readonly`));
      assert.ok(args.includes(`type=bind,src=${runtime},dst=/runtime/provider-state/home/.codex/sessions`));
      assert.ok(args.includes('--env=HOME=/runtime/provider-state/home'));
      assert.ok(args.includes(`type=bind,src=/dev/null,dst=${path.join(context.root, '.chisa-bridge.json')},readonly`));
      assert.ok(!args.some(value => value.includes('src=' + path.join(context.root, '.chisa-bridge.json'))));
      assert.ok(!args.some(value => value.includes('/var/run/docker.sock')));
      child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
      return child as unknown as ReturnType<typeof realSpawn>;
    };
    const process = spawnWorkspaceProcess({ command: 'node', args: ['worker'], runtimeMounts: [{ source: runtime, target: '/runtime/provider-state/home/.codex/sessions', writable: true }] }, {
      ...context, readOnly: true, isolated: false, gitMounts: [], name: 'chisa-rpc-fixture', network: 'bridge', record: pending => recorded.push(pending),
      async remove() { removing.resolve(); await removed.promise; },
    });
    let completed = false;
    const completion = process.completion.then(() => { completed = true; });
    child.emit('close', 0, null);
    await removing.promise;
    assert.equal(completed, false); assert.deepEqual(recorded, [true]);
    removed.resolve(); await completion;
    assert.deepEqual(recorded, [true, false]);
  });
});

test('own close cancellation succeeds only after cleanup while external abort and cleanup errors remain failures', async () => {
  for (const external of [false, true]) for (const cleanupFails of [false, true]) await fixture(async ({ runtime: _runtime, ...context }) => {
    const caller = new AbortController(); const recorded: boolean[] = [];
    launch = (_args, options) => {
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
      options.signal!.addEventListener('abort', () => {
        child.emit('error', Object.assign(new Error('aborted'), { name: 'AbortError' }));
        child.emit('close', 1, 'SIGKILL');
      }, { once: true });
      return child as unknown as ReturnType<typeof realSpawn>;
    };
    const process = spawnWorkspaceProcess({ command: 'node', args: ['worker'], signal: caller.signal }, {
      ...context, readOnly: false, isolated: false, gitMounts: [], name: 'chisa-rpc-fixture', network: 'bridge', record: pending => recorded.push(pending),
      async remove() { if (cleanupFails) throw Object.assign(new Error('cleanup unconfirmed'), { code: 'WORKSPACE_CLEANUP_FAILED' }); },
    });
    if (external) caller.abort();
    if (cleanupFails) await assert.rejects(process.close(), { code: 'WORKSPACE_CLEANUP_FAILED' });
    else if (external) await assert.rejects(process.close(), { name: 'AbortError' });
    else await process.close();
    assert.deepEqual(recorded, cleanupFails ? [true] : [true, false]);
  });
});

test('runtime mounts cannot cover workspace, credentials, host root or writable code', async () => {
  await fixture(async ({ runtime, ...context }) => {
    launch = () => { throw new Error('invalid mounts must not launch'); };
    const workspace = { ...context, readOnly: false, isolated: false, gitMounts: [], name: 'chisa-rpc-fixture', network: 'bridge', record() {}, async remove() {} };
    for (const mount of [
      { source: context.root, target: '/runtime/provider-code/project', writable: false },
      { source: runtime, target: context.root, writable: false },
      { source: runtime, target: '/runtime/provider-code/lib', writable: true },
      { source: path.parse(runtime).root, target: '/runtime/provider-code/all', writable: false },
    ]) assert.throws(() => spawnWorkspaceProcess({ command: 'node', args: [], runtimeMounts: [mount] }, workspace), { code: 'WORKSPACE_RUNTIME_INVALID' });
  });
});
