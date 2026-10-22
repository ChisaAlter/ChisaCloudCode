import assert from 'node:assert/strict';
import { spawn as realSpawn } from 'node:child_process';
import * as childProcess from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test, { mock } from 'node:test';

const fixture = await mkdtemp(path.join(os.tmpdir(), 'chisa-worker-admission-'));
process.env.WORKSPACES_ROOT = fixture;

type FakeChild = EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough; kill(): void };
let commands: string[][] = [];
let onRun: ((child: FakeChild, args: string[]) => void) | undefined;
let onCleanup: ((child: FakeChild, args: string[]) => void) | undefined;
let cleanupFails = false;
const finish = (child: FakeChild, code = 0, output = '') => queueMicrotask(() => {
  if (output) child.stdout.write(output);
  child.emit('close', code);
});
mock.module('node:child_process', { namedExports: {
  ...childProcess,
  ...childProcess,
  spawn: (_command: string, args: string[]) => {
    commands.push(args);
    const child: FakeChild = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill() {},
    });
    if (args[0] === 'run') queueMicrotask(() => {
      if (onRun) onRun(child, args);
      else finish(child, 0, JSON.stringify({ ok: true, stdout: 'completed', exitCode: 0 }));
    });
    else if (onCleanup) queueMicrotask(() => onCleanup!(child, args));
    else finish(child, cleanupFails ? 1 : 0);
    return child as unknown as ReturnType<typeof realSpawn>;
  },
} });
const { executeSyncTransportWorker, prepareSyncTransportPreview, workspaceQuery, isActiveWorkspaceLease } = await import('@/modules/workspace-bridge/index.js');
const { registerWorkspaceSyncNetwork } = await import('@/shared/index.js');
const network = 'chisa-workspace-network-' + 'a'.repeat(24);
registerWorkspaceSyncNetwork(fixture, network, '172.18.0.2');

type Lease = { id: string; epoch: string; owner: string; pid?: number; mayWrite?: boolean; cleanupPending?: string[] };
const epoch = 'current-binding';
const leasePath = (root: string) => root + '.chisa-lease';
const statePath = (root: string) => path.join(leasePath(root), 'state.json');
const readLease = (root: string): Lease => JSON.parse(readFileSync(statePath(root), 'utf8')) as Lease;
const saveLease = async (root: string, lease: Lease) => {
  await mkdir(leasePath(root), { recursive: true });
  await writeFile(statePath(root), JSON.stringify(lease));
};
async function withWorkspace(run: (root: string) => Promise<void>) {
  commands = [];
  onRun = undefined;
  onCleanup = undefined;
  cleanupFails = false;
  const root = await mkdtemp(path.join(fixture, 'project-'));
  await writeFile(path.join(root, '.chisa-bridge.json'), JSON.stringify({ protocol: 2, port: 18082, token: 'fixture', bindingEpoch: epoch }));
  try { await run(root); }
  finally {
    await rm(leasePath(root), { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
}
test.after(() => rm(fixture, { recursive: true, force: true }));

for (const owner of ['pi', 'sync', 'sync-needed']) {
  test(`prepared worker rejects ${owner} without spawning Docker or changing ownership`, async () => {
    await withWorkspace(async root => {
      const lease = { id: 'foreign', epoch, owner };
      await saveLease(root, lease);
      await assert.rejects(executeSyncTransportWorker(root, epoch, { op: 'write', path: '/workspace/file' }), { code: 'WORKSPACE_BUSY' });
      assert.deepEqual(readLease(root), lease);
      assert.equal(commands.length, 0);
    });
  });
}

test('prepared worker rejects stale marker and lease epochs before Docker', async () => {
  await withWorkspace(async root => {
    await assert.rejects(executeSyncTransportWorker(root, 'previous-binding', { op: 'read' }), { code: 'STALE_BINDING' });
    await saveLease(root, { id: 'old', epoch: 'previous-binding', owner: 'claude' });
    await assert.rejects(executeSyncTransportWorker(root, epoch, { op: 'read' }), { code: 'WORKSPACE_BUSY' });
    assert.equal(commands.length, 0);
  });
});

test('snapshot reads and read-only exec remain lease-free and use the account network', async () => {
  await withWorkspace(async root => {
    onRun = child => {
      assert.equal(existsSync(leasePath(root)), false);
      finish(child, 0, JSON.stringify({ ok: true, stdout: 'snapshot', exitCode: 0 }));
    };
    await executeSyncTransportWorker(root, epoch, { op: 'read', path: '/workspace/file' });
    await executeSyncTransportWorker(root, epoch, { op: 'exec', command: 'inspect', readOnly: true });
    assert.equal(existsSync(leasePath(root)), false);
    const runs = commands.filter(args => args[0] === 'run');
    assert.ok(runs.every(args => args.includes('--network=' + network)));
    assert.ok(runs.every(args => args.includes(root + ':/workspace:ro')));
  });
});

test('current Claude consumes prepared execution, marks writes and retains its exact lease', async () => {
  await withWorkspace(async root => {
    await saveLease(root, { id: 'running-model', epoch, owner: 'claude', mayWrite: false });
    await executeSyncTransportWorker(root, epoch, { op: 'exec', command: 'inspect', readOnly: true });
    assert.equal(readLease(root).mayWrite, false);
    await executeSyncTransportWorker(root, epoch, { op: 'write', path: '/workspace/file' });
    assert.deepEqual(readLease(root), { id: 'running-model', epoch, owner: 'claude', mayWrite: true, cleanupPending: [] });
  });
});

for (const op of ['write', 'exec']) {
  test(`idle ${op} holds a temporary exact lease through Docker cleanup and blocks a new model`, async () => {
    await withWorkspace(async root => {
      const running = new EventEmitter();
      let child!: FakeChild;
      onRun = current => { child = current; running.emit('started'); };
      const started = once(running, 'started');
      const execution = executeSyncTransportWorker(root, epoch, { op, command: 'edit', path: '/workspace/file' });
      await started;
      const lease = readLease(root);
      assert.equal(lease.owner, 'claude');
      assert.equal(lease.epoch, epoch);
      assert.equal(isActiveWorkspaceLease(root, lease.id, epoch), true);
      assert.equal(isActiveWorkspaceLease(root, lease.id, 'old-epoch'), false);
      assert.equal(isActiveWorkspaceLease(root, 'other-id', epoch), false);
      assert.equal(lease.mayWrite, true);
      assert.equal(lease.cleanupPending?.length, 1);
      await assert.rejects(workspaceQuery({ prompt: 'must not overlap', options: { cwd: root } }).next(), { code: 'WORKSPACE_BUSY' });
      finish(child, 0, JSON.stringify({ ok: true, exitCode: 0 }));
      await execution;
      assert.equal(existsSync(leasePath(root)), false);
      assert.equal(isActiveWorkspaceLease(root, lease.id, epoch), false);
      assert.equal(commands.filter(args => args[0] === 'rm').length, 1);
    });
  });
}

test('prepared calls serialize actual worker execution and an aborted queued call never spawns', async () => {
  await withWorkspace(async root => {
    const running = new EventEmitter();
    let firstChild!: FakeChild;
    onRun = child => { firstChild = child; running.emit('started'); };
    const started = once(running, 'started');
    const first = executeSyncTransportWorker(root, epoch, { op: 'write' });
    await started;
    const cancellation = new AbortController();
    const second = executeSyncTransportWorker(root, epoch, { op: 'write' }, cancellation.signal);
    const rejected = assert.rejects(second, { name: 'AbortError' });
    cancellation.abort();
    assert.equal(commands.filter(args => args[0] === 'run').length, 1);
    finish(firstChild, 0, JSON.stringify({ ok: true }));
    await first;
    await rejected;
    assert.equal(commands.filter(args => args[0] === 'run').length, 1);
    assert.equal(existsSync(leasePath(root)), false);
  });
});

test('a preview cannot borrow an idle worker reservation while its Docker client is running', async () => {
  await withWorkspace(async root => {
    const running = new EventEmitter();
    let child!: FakeChild;
    onRun = current => { child = current; running.emit('started'); };
    const started = once(running, 'started');
    const execution = executeSyncTransportWorker(root, epoch, { op: 'write' });
    await started;
    const lease = readLease(root);
    assert.throws(() => prepareSyncTransportPreview(root, epoch), { code: 'WORKSPACE_CLEANUP_FAILED' });
    assert.deepEqual(readLease(root), lease);
    finish(child, 0, JSON.stringify({ ok: true }));
    await execution;
    assert.equal(existsSync(leasePath(root)), false);
  });
});

test('another preview and worker cannot borrow an idle preview startup reservation', async () => {
  await withWorkspace(async root => {
    const preview = prepareSyncTransportPreview(root, epoch);
    const lease = readLease(root);
    assert.throws(() => prepareSyncTransportPreview(root, epoch), { code: 'WORKSPACE_BUSY' });
    await assert.rejects(executeSyncTransportWorker(root, epoch, { op: 'write' }), { code: 'WORKSPACE_BUSY' });
    assert.deepEqual(readLease(root), lease);
    assert.equal(commands.length, 0);
    await preview.finish(true);
    assert.equal(existsSync(leasePath(root)), false);
  });
});

test('Docker auto-removal presence is retried while the exact lease remains held until verified absence', async () => {
  await withWorkspace(async root => {
    let container = ''; let queries = 0; let removals = 0;
    onRun = (child, args) => { container = args[args.indexOf('--name') + 1]!; finish(child, 0, JSON.stringify({ ok: true })); };
    onCleanup = (child, args) => {
      assert.deepEqual(readLease(root).cleanupPending, [container]);
      if (args[0] === 'rm') { assert.equal(args[2], container); removals++; finish(child, 1); }
      else {
        assert.equal(args[0], 'ps'); assert.ok(args.includes(`name=^/${container}$`));
        queries++; finish(child, 0, queries === 1 ? container + '\n' : '');
      }
    };
    await executeSyncTransportWorker(root, epoch, { op: 'write' });
    assert.equal(removals, 2); assert.equal(queries, 2);
    assert.equal(existsSync(leasePath(root)), false);
  });
});

test('a container that remains present exhausts cleanup budget and retains its exact barrier', { timeout: 15_000 }, async () => {
  await withWorkspace(async root => {
    let container = ''; let queries = 0;
    onRun = (child, args) => { container = args[args.indexOf('--name') + 1]!; finish(child, 0, JSON.stringify({ ok: true })); };
    onCleanup = (child, args) => {
      if (args[0] === 'rm') finish(child, 1);
      else { queries++; finish(child, 0, container + '\n'); }
    };
    const start = Date.now();
    await assert.rejects(executeSyncTransportWorker(root, epoch, { op: 'write' }), { code: 'WORKSPACE_CLEANUP_FAILED' });
    assert.ok(Date.now() - start < 12_000); assert.ok(queries > 1);
    assert.deepEqual(readLease(root).cleanupPending, [container]);
    assert.equal(readLease(root).owner, 'sync-needed');
  });
});

for (const query of [{ code: 1, output: '' }, { code: 0, output: 'unexpected-container\n' }]) test(`unconfirmed daemon query never retries cleanup: ${query.code}/${query.output.trim()}`, async () => {
  await withWorkspace(async root => {
    onCleanup = (child, args) => finish(child, args[0] === 'rm' ? 1 : query.code, args[0] === 'rm' ? '' : query.output);
    await assert.rejects(executeSyncTransportWorker(root, epoch, { op: 'write' }), { code: 'WORKSPACE_CLEANUP_FAILED' });
    assert.equal(commands.filter(args => args[0] === 'rm').length, 1);
    assert.equal(commands.filter(args => args[0] === 'ps').length, 1);
    assert.equal(readLease(root).cleanupPending?.length, 1);
  });
});

test('unconfirmed Docker cleanup retains the exact recovery barrier', async () => {
  await withWorkspace(async root => {
    cleanupFails = true;
    await assert.rejects(executeSyncTransportWorker(root, epoch, { op: 'write' }), { code: 'WORKSPACE_CLEANUP_FAILED' });
    const lease = readLease(root);
    assert.equal(lease.owner, 'sync-needed');
    assert.equal(lease.epoch, epoch);
    assert.equal(lease.cleanupPending?.length, 1);
    assert.match(lease.cleanupPending![0], /^chisa-rpc-/);
  });
});

for (const replacement of [
  { id: 'replacement', epoch, owner: 'claude' },
  { id: 'replacement', epoch: 'new-binding', owner: 'claude' },
  { id: 'replacement', epoch, owner: 'pi' },
]) {
  test(`cleanup failure does not alter replacement id, epoch or owner: ${replacement.owner}/${replacement.epoch}`, async () => {
    await withWorkspace(async root => {
      cleanupFails = true;
      onRun = child => { void saveLease(root, replacement).then(() => finish(child, 0, JSON.stringify({ ok: true }))); };
      await assert.rejects(executeSyncTransportWorker(root, epoch, { op: 'write' }), { code: 'WORKSPACE_CLEANUP_FAILED' });
      assert.deepEqual(readLease(root), replacement);
    });
  });
}

test('confirmed cleanup releases only its own lease even when the command reports failure', async () => {
  await withWorkspace(async root => {
    onRun = child => finish(child, 1);
    await assert.rejects(executeSyncTransportWorker(root, epoch, { op: 'exec' }), { code: 'WORKSPACE_UNAVAILABLE' });
    assert.equal(existsSync(leasePath(root)), false);
  });
});

test('an already aborted prepared request never inspects or spawns a worker', async () => {
  const cancellation = new AbortController();
  cancellation.abort();
  const before = commands.length;
  await assert.rejects(executeSyncTransportWorker('not-a-project', epoch, { op: 'write' }, cancellation.signal), { name: 'AbortError' });
  assert.equal(commands.length, before);
});
