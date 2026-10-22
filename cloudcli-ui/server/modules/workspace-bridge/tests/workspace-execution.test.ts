import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'chisa-admission-real-git-'));
process.env.WORKSPACES_ROOT = fixtureRoot;
const { admitWorkspaceExecution, bridgeFileSystem, executeSyncTransportWorker, prepareSyncTransportPreview, withWorkspaceMutation, withWorkspaceWriteOperation } = await import('@/modules/workspace-bridge/index.js');
test.after(async () => { assert.equal(path.dirname(fixtureRoot), os.tmpdir()); await rm(fixtureRoot, { recursive: true, force: true }); });

function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function git(args: string[], cwd: string) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn('git', args, { cwd, windowsHide: true });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
  });
}
async function fixture(run: (root: string, controls: { calls: Record<string, unknown>[]; onBegin?: (request: Record<string, unknown>) => Promise<void>; pin: boolean; release: boolean }) => Promise<void>, protocol = 2) {
  const root = await mkdtemp(path.join(fixtureRoot, 'project-'));
  const controls: { calls: Record<string, unknown>[]; onBegin?: (request: Record<string, unknown>) => Promise<void>; pin: boolean; release: boolean } = { calls: [], pin: true, release: true };
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      controls.calls.push(request);
      if (request.op === 'sync_begin') await controls.onBegin?.(request);
      const result: Record<string, unknown> = { ok: true };
      if (request.op === 'sync_begin' && request.snapshot && controls.pin) Object.assign(result, { snapshotPinned: true, bindingEpoch: 'fixture' });
      if (request.op === 'sync_end' && controls.release) {
        const lease = JSON.parse(await readFile(root + '.chisa-lease/state.json', 'utf8'));
        assert.equal(lease.id, request.runId); assert.equal(lease.epoch, 'fixture'); assert.equal(lease.owner, 'sync-needed');
        await rm(root + '.chisa-lease', { recursive: true });
        Object.assign(result, { releasedRunId: request.runId, bindingEpoch: 'fixture' });
      }
      outgoing.end(JSON.stringify(result));
    })().catch(error => { outgoing.statusCode = 500; outgoing.end(JSON.stringify({ error: String(error), code: 'FIXTURE_FAILED' })); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  await writeFile(path.join(root, '.chisa-bridge.json'), JSON.stringify({ protocol, port: address.port, token: 'fixture', bindingEpoch: 'fixture' }));
  try {
    await git(['init', '-b', 'main'], root);
    await mkdir(path.join(root, '.git', 'info'), { recursive: true });
    await writeFile(path.join(root, '.git', 'info', 'exclude'), '.chisa-bridge.json\n');
    await writeFile(path.join(root, 'deleted.txt'), 'base\n');
    await writeFile(path.join(root, 'renamed.txt'), 'base\n');
    await git(['add', '.'], root);
    await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'base'], root);
    await run(root, controls);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    for (const target of [root, root + '.chisa-lease', root + '.chisa-worktrees']) { assert.equal(path.dirname(target), fixtureRoot); await rm(target, { recursive: true, force: true }); }
  }
}

test('first isolated admission waits for pinned freshness, blocks shared/native/editor writes, and plan reuses exact retained identity', async () => {
  await fixture(async (root, control) => {
    const begin = gate(); const pinned = gate();
    control.onBegin = async request => {
      assert.equal(request.snapshot, true);
      begin.resolve(); await pinned.promise;
      // A real desktop flush updates the replica before snapshot acknowledgement.
      await rm(path.join(root, 'deleted.txt'));
      await git(['mv', 'renamed.txt', 'new-name.txt'], root);
      await git(['add', '-A'], root);
    };
    const pending = admitWorkspaceExecution({ cwd: root, sessionId: 'retained', workspaceMode: 'isolated', directExecution: true });
    await begin.promise;
    await assert.rejects(admitWorkspaceExecution({ cwd: root, workspaceMode: 'shared' }), { code: 'WORKSPACE_BUSY' });
    await assert.rejects(bridgeFileSystem({} as never).writeTextFile(path.join(root, 'editor.txt'), 'no'), { code: 'WORKSPACE_BUSY' });
    await assert.rejects(executeSyncTransportWorker(root, 'fixture', { op: 'write', path: '/workspace/native.txt' }), { code: 'WORKSPACE_BUSY' });
    assert.throws(() => prepareSyncTransportPreview(root, 'fixture'), { code: 'WORKSPACE_BUSY' });
    pinned.resolve();
    const run = await pending;
    assert.equal(run.sourceCwd, root); assert.equal(run.sourceRoot, root); assert.equal(run.isolated, true);
    assert.equal(existsSync(path.join(run.cwd, 'deleted.txt')), false);
    assert.equal(existsSync(path.join(run.cwd, 'renamed.txt')), false);
    assert.equal(await readFile(path.join(run.cwd, 'new-name.txt'), 'utf8'), 'base\n');
    assert.equal(existsSync(root + '.chisa-lease'), false);
    assert.equal(existsSync(run.cwd + '.chisa-lease'), true);
    await assert.rejects(withWorkspaceWriteOperation(run.cwd, async () => { throw new Error('active worktree must not be merged or removed'); }), { code: 'WORKSPACE_BUSY' });
    await assert.rejects(admitWorkspaceExecution({ cwd: root, sessionId: 'retained', readOnly: true }), { code: 'WORKSPACE_BUSY' });
    await run.close(); await run.close();
    assert.equal(existsSync(run.cwd + '.chisa-lease'), false);
    await writeFile(path.join(run.cwd, 'retained-edit.txt'), 'keep this retained work');
    await writeFile(path.join(root, 'later-source.txt'), 'must not absorb later source edits');
    control.onBegin = undefined;
    const count = control.calls.length;
    const plan = await admitWorkspaceExecution({ cwd: root, sessionId: 'retained', readOnly: true, directExecution: true });
    assert.equal(plan.cwd, run.cwd); assert.equal(plan.sourceCwd, root); assert.equal(control.calls.length, count);
    assert.equal(await readFile(path.join(plan.cwd, 'retained-edit.txt'), 'utf8'), 'keep this retained work');
    assert.equal(existsSync(path.join(plan.cwd, 'later-source.txt')), false);
    await plan.close();
    await git(['add', '-A'], plan.cwd);
    await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'manual retained commit'], plan.cwd);
    assert.equal(await git(['status', '--porcelain'], plan.cwd), '');
    assert.doesNotMatch(await git(['ls-files'], plan.cwd), /\.chisa-(session|bridge)\.json/);
    let mutations = 0;
    await withWorkspaceWriteOperation(plan.cwd, () => withWorkspaceWriteOperation(plan.cwd, async () => { mutations++; }));
    assert.equal(mutations, 1);
    assert.deepEqual(control.calls.map(call => call.op), ['sync_begin', 'sync_end']);
  });
});

test('an older native client without an exact snapshot pin is rejected and exact handback still completes', async () => {
  await fixture(async (root, control) => {
    control.pin = false;
    await assert.rejects(admitWorkspaceExecution({ cwd: root, sessionId: 'no-pin' }), { code: 'WORKSPACE_SNAPSHOT_UNSUPPORTED' });
    assert.deepEqual(control.calls.map(call => call.op), ['sync_begin', 'sync_end']);
    assert.equal(existsSync(root + '.chisa-lease'), false);
    assert.equal(existsSync(root + '.chisa-worktrees'), false);
  });
});

test('release without an exact atomic receipt retains its matching lease and rejects completion', async () => {
  await fixture(async (root, control) => {
    control.release = false;
    const run = await admitWorkspaceExecution({ cwd: root, workspaceMode: 'shared', directExecution: true });
    await assert.rejects(run.close(), { code: 'WORKSPACE_CLEANUP_FAILED', workspaceCleanupError: true });
    const lease = JSON.parse(await readFile(root + '.chisa-lease/state.json', 'utf8'));
    assert.equal(lease.owner, 'sync-needed');
    await assert.rejects(admitWorkspaceExecution({ cwd: root }), { code: 'WORKSPACE_BUSY' });
    // Model/tools have ended; explicit native recovery atomically removes the
    // durable barrier. A new admission must not need a Node server restart.
    await rm(root + '.chisa-lease', { recursive: true });
    control.release = true;
    let hostMutations = 0;
    await withWorkspaceMutation(root, async () => { hostMutations++; });
    assert.equal(hostMutations, 1, 'native recovery also reopens the public host transaction entry point');
    const recovered = await admitWorkspaceExecution({ cwd: root, workspaceMode: 'shared' });
    await recovered.close();
  });
});

test('revoking an unconfirmed provider teardown keeps the in-process barrier even if a lease disappears', async () => {
  await fixture(async root => {
    const run = await admitWorkspaceExecution({ cwd: root, workspaceMode: 'shared' });
    run.revoke();
    await rm(root + '.chisa-lease', { recursive: true });
    await assert.rejects(admitWorkspaceExecution({ cwd: root }), { code: 'WORKSPACE_BUSY' });
    await assert.rejects(withWorkspaceMutation(root, async () => { throw new Error('host Git must not borrow a revoked execution'); }), { code: 'WORKSPACE_BUSY' });
  });
});

test('direct providers reject local bridges and the all-projects root before launch', async () => {
  await fixture(async root => {
    await assert.rejects(admitWorkspaceExecution({ cwd: root, directExecution: true, readOnly: true }), { code: 'WORKSPACE_PROVIDER_UNSUPPORTED' });
  }, 1);
  await assert.rejects(admitWorkspaceExecution({ cwd: fixtureRoot }), { code: 'WORKSPACE_PROJECT_REQUIRED' });
});
