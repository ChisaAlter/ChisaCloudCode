import assert from 'node:assert/strict';
import childProcess, { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import fileSystem, { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

const fixtureRoot = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'chisa-admission-real-git-')));
process.env.WORKSPACES_ROOT = fixtureRoot;
// Admission fixtures supply explicit cloud markers without restoring an account runtime.
mock.module('@/modules/workspace-runtime/index.js', { namedExports: {
  ensureCloudWorkspaceBinding() {}, excludeCloudWorkspaceMetadata() {}, getWorkspaceRuntimeIdentity() { return undefined; },
  executeWorkspaceRuntimePreview() { assert.fail('unexpected preview'); },
} });
const { admitWorkspaceExecution, assertWorkspaceDescriptor, bridgeFileSystem, describeWorkspaceSelection, withWorkspaceWriteOperation } = await import('@/modules/workspace-bridge/index.js');
test.after(async () => { assert.equal(path.dirname(fixtureRoot), realpathSync(os.tmpdir())); await rm(fixtureRoot, { recursive: true, force: true }); });

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
async function fixture(run: (root: string) => Promise<void>, protocol = 3) {
  const root = await mkdtemp(path.join(fixtureRoot, 'project-'));
  const marker = protocol === 3
    ? { protocol, root, owner: 'cloud-admission-fixture', bindingEpoch: 'fixture' }
    : { protocol, port: 19081, token: 'retired-fixture', bindingEpoch: 'fixture' };
  await writeFile(path.join(root, '.chisa-bridge.json'), JSON.stringify(marker));
  try {
    await git(['init', '-b', 'main'], root);
    await mkdir(path.join(root, '.git', 'info'), { recursive: true });
    await writeFile(path.join(root, '.git', 'info', 'exclude'), '.chisa-bridge.json\n');
    await writeFile(path.join(root, 'deleted.txt'), 'base\n');
    await writeFile(path.join(root, 'renamed.txt'), 'base\n');
    await git(['add', '.'], root);
    await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'base'], root);
    await run(root);
  } finally {
    for (const target of [root, root + '.chisa-lease', root + '.chisa-worktrees', root + '.chisa-state']) { assert.equal(path.dirname(target), fixtureRoot); await rm(target, { recursive: true, force: true }); }
  }
}

function describe(root: string, sessionId?: string) {
  return describeWorkspaceSelection({ projectId: 'admission-fixture', sourceRoot: root, ...(sessionId ? { sessionId } : {}) });
}
async function replaceBindingEpoch(root: string) {
  const marker = path.join(root, '.chisa-bridge.json');
  const binding = JSON.parse(await readFile(marker, 'utf8')) as Record<string, unknown>;
  await writeFile(marker, JSON.stringify({ ...binding, bindingEpoch: 'replacement-binding' }));
}

// Hold the real snapshot copy rather than the retired desktop callback. The
// source reservation must already exist before the first project byte is read.
function holdSnapshot() {
  const copying = gate(); const resume = gate();
  const original = fileSystem.cp;
  const copyingFile = mock.method(fileSystem, 'cp', async (...args: Parameters<typeof fileSystem.cp>) => {
    copying.resolve(); await resume.promise;
    return original(...args);
  });
  syncBuiltinESMExports();
  return { copying: copying.promise, resume: resume.resolve, restore: () => { copyingFile.mock.restore(); syncBuiltinESMExports(); } };
}

test('cloud isolated admission reserves the exact snapshot and plan reuses retained identity', async () => {
  await fixture(async root => {
    await rm(path.join(root, 'deleted.txt'));
    await git(['mv', 'renamed.txt', 'new-name.txt'], root);
    await git(['add', '-A'], root);
    const snapshot = holdSnapshot();
    const pending = admitWorkspaceExecution({ cwd: root, sessionId: 'retained', workspaceMode: 'isolated', directExecution: true });
    let run: Awaited<typeof pending>;
    try {
      await snapshot.copying;
      await assert.rejects(admitWorkspaceExecution({ cwd: root, workspaceMode: 'shared' }), { code: 'WORKSPACE_BUSY' });
      await assert.rejects(bridgeFileSystem({} as never).writeTextFile(path.join(root, 'editor.txt'), 'no'), { code: 'WORKSPACE_BUSY' });
      assert.equal(existsSync(root + '.chisa-lease'), true);
      snapshot.resume();
      run = await pending;
    } finally { snapshot.resume(); snapshot.restore(); }
    assert.equal(run.sourceCwd, root); assert.equal(run.sourceRoot, root); assert.equal(run.isolated, true);
    assert.equal(existsSync(path.join(run.cwd, 'deleted.txt')), false);
    assert.equal(existsSync(path.join(run.cwd, 'renamed.txt')), false);
    assert.equal(await readFile(path.join(run.cwd, 'new-name.txt'), 'utf8'), 'base\n');
    const marker = JSON.parse(await readFile(path.join(run.cwd, '.chisa-bridge.json'), 'utf8'));
    assert.deepEqual(marker, { protocol: 3, root: run.cwd, owner: 'cloud-admission-fixture', bindingEpoch: 'fixture', execution: 'isolated-worktree', sessionId: 'retained' });
    assert.equal(existsSync(root + '.chisa-lease'), false);
    assert.equal(existsSync(run.cwd + '.chisa-lease'), true);
    await assert.rejects(withWorkspaceWriteOperation(run.cwd, async () => { throw new Error('active worktree must not be merged or removed'); }), { code: 'WORKSPACE_BUSY' });
    await assert.rejects(admitWorkspaceExecution({ cwd: root, sessionId: 'retained', readOnly: true }), { code: 'WORKSPACE_BUSY' });
    await run.close(); await run.close();
    assert.equal(existsSync(run.cwd + '.chisa-lease'), false);
    await writeFile(path.join(run.cwd, 'retained-edit.txt'), 'keep this retained work');
    await writeFile(path.join(root, 'later-source.txt'), 'must not absorb later source edits');
    const plan = await admitWorkspaceExecution({ cwd: root, sessionId: 'retained', readOnly: true, directExecution: true });
    assert.equal(plan.cwd, run.cwd); assert.equal(plan.sourceCwd, root);
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
  });
});

test('independent cloud sessions keep separate roots, leases and edits while running concurrently', async () => {
  await fixture(async root => {
    const first = await admitWorkspaceExecution({ cwd: root, sessionId: 'first' });
    const second = await admitWorkspaceExecution({ cwd: root, sessionId: 'second' });
    try {
      assert.notEqual(first.cwd, second.cwd);
      assert.equal(existsSync(first.cwd + '.chisa-lease'), true);
      assert.equal(existsSync(second.cwd + '.chisa-lease'), true);
      await writeFile(path.join(first.cwd, 'first-only.txt'), 'private');
      assert.equal(existsSync(path.join(second.cwd, 'first-only.txt')), false);
      assert.equal(existsSync(path.join(root, 'first-only.txt')), false);
      await first.close();
      assert.equal(existsSync(second.cwd + '.chisa-lease'), true);
      assert.equal(describe(root, 'second').session?.phase, 'running');
    } finally { await first.close(); await second.close(); }
  });
});

test('a cloud Git repository without an initial commit falls back to its actual shared root', async () => {
  const root = await mkdtemp(path.join(fixtureRoot, 'unborn-'));
  await writeFile(path.join(root, '.chisa-bridge.json'), JSON.stringify({ protocol: 3, root, owner: 'cloud-admission-fixture', bindingEpoch: 'fixture' }));
  try {
    await git(['init', '-b', 'main'], root);
    const run = await admitWorkspaceExecution({ cwd: root, sessionId: 'unborn', workspaceMode: 'isolated' });
    try {
      assert.equal(run.executionRoot, root); assert.equal(run.isolated, false);
      const selected = describe(root, 'unborn').session;
      assert.ok(selected); assert.equal(selected.rootPath, root); assert.equal(selected.requestedMode, 'isolated');
      assert.equal(selected.effectiveMode, 'shared'); assert.equal(selected.baseRevision, undefined);
      assert.equal(selected.capabilities.integrate, false);
      assert.equal(existsSync(root + '.chisa-worktrees'), false);
    } finally { await run.close(); }
  } finally {
    for (const target of [root, root + '.chisa-lease', root + '.chisa-state']) { assert.equal(path.dirname(target), fixtureRoot); await rm(target, { recursive: true, force: true }); }
  }
});

test('Git inspection errors reject isolated admission instead of silently using the shared root', async () => {
  await fixture(async root => {
    await writeFile(path.join(root, '.git', 'config'), '[core\n');
    await assert.rejects(admitWorkspaceExecution({ cwd: root, sessionId: 'bad-git', workspaceMode: 'isolated' }), { code: 'WORKSPACE_WORKTREE_CREATE_FAILED' });
    assert.equal(describe(root, 'bad-git').session, null);
    assert.equal(existsSync(root + '.chisa-lease'), false);
    assert.equal(existsSync(root + '.chisa-worktrees'), false);
  });
});

test('worktree Git ignores inherited repository selectors and disables repository hooks', async () => {
  await fixture(async root => {
    const hookMarker = path.join(root, 'hook-ran.txt');
    await writeFile(path.join(root, '.git', 'hooks', 'post-checkout'), '#!/bin/sh\nprintf unsafe > "' + hookMarker.replaceAll('\\', '/') + '"\n');
    const observed: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const originalSpawn = childProcess.spawn;
    const spawn = mock.method(childProcess, 'spawn', (...args: Parameters<typeof childProcess.spawn>) => {
      const [command, argv, options] = args;
      if (command === 'git') observed.push({ args: argv as string[], env: (options as { env: NodeJS.ProcessEnv }).env });
      return originalSpawn(...args);
    });
    const previous = process.env.GIT_DIR;
    process.env.GIT_DIR = path.join(root, 'foreign-git-directory');
    syncBuiltinESMExports();
    let run: Awaited<ReturnType<typeof admitWorkspaceExecution>> | undefined;
    try {
      run = await admitWorkspaceExecution({ cwd: root, sessionId: 'clean-git-env', workspaceMode: 'isolated' });
      assert.equal(run.isolated, true);
      assert.ok(observed.length > 0);
      for (const invocation of observed) assert.equal(invocation.env.GIT_DIR, undefined);
      const worktreeCommands = observed.filter(invocation => invocation.args.some(argument => argument.startsWith('safe.directory=')));
      assert.ok(worktreeCommands.length > 0);
      for (const invocation of worktreeCommands) {
        assert.equal(invocation.env.GIT_CONFIG_NOSYSTEM, '1');
        assert.ok(invocation.args.includes('core.hooksPath=/dev/null'));
        assert.ok(invocation.args.includes('core.fsmonitor=false'));
      }
      assert.equal(existsSync(hookMarker), false);
    } finally {
      if (previous === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previous;
      spawn.mock.restore(); syncBuiltinESMExports();
      await run?.close();
    }
  });
});

test('unconfirmed cloud cleanup retains its barrier until exact external recovery', async () => {
  await fixture(async root => {
    const run = await admitWorkspaceExecution({ cwd: root, workspaceMode: 'shared', directExecution: true });
    await writeFile(path.join(root + '.chisa-lease', 'sync-job.json'), '{}');
    await assert.rejects(run.close(), { code: 'WORKSPACE_CLEANUP_FAILED', workspaceCleanupError: true });
    assert.equal(existsSync(root + '.chisa-lease'), true);
    await assert.rejects(admitWorkspaceExecution({ cwd: root }), { code: 'WORKSPACE_BUSY' });
    await rm(root + '.chisa-lease', { recursive: true });
    const recovered = await admitWorkspaceExecution({ cwd: root, workspaceMode: 'shared' });
    await recovered.close();
    assert.equal(existsSync(root + '.chisa-lease'), false);
  });
});

test('revoking an unconfirmed provider teardown keeps the in-process barrier even if a lease disappears', async () => {
  await fixture(async root => {
    const run = await admitWorkspaceExecution({ cwd: root, workspaceMode: 'shared' });
    run.revoke();
    await rm(root + '.chisa-lease', { recursive: true });
    await assert.rejects(admitWorkspaceExecution({ cwd: root }), { code: 'WORKSPACE_BUSY' });
  });
});

test('direct providers reject retired local execution and the all-projects root before launch', async () => {
  await fixture(async root => {
    await assert.rejects(admitWorkspaceExecution({ cwd: root, directExecution: true, readOnly: true }), { code: 'LOCAL_WORKSPACE_REMOVED' });
  }, 1);
  await assert.rejects(admitWorkspaceExecution({ cwd: fixtureRoot }), { code: 'WORKSPACE_PROJECT_REQUIRED' });
});

test('a stale catalog generation rejects admission before lease creation', async () => {
  await fixture(async root => {
    const selected = describe(root).cloudReplica;
    assertWorkspaceDescriptor(selected);
    await replaceBindingEpoch(root);
    const current = describe(root).cloudReplica;
    assert.equal(current.workspaceId, selected.workspaceId);
    assert.notEqual(current.generation, selected.generation);
    assert.throws(() => assertWorkspaceDescriptor(selected), { code: 'WORKSPACE_GENERATION_CHANGED' });
    await assert.rejects(admitWorkspaceExecution({ cwd: root, sessionId: 'stale-generation', workspaceMode: 'isolated', directExecution: true, expectedWorkspace: selected }), { code: 'WORKSPACE_GENERATION_CHANGED' });
    assert.equal(existsSync(root + '.chisa-lease'), false);
    assert.equal(existsSync(root + '.chisa-worktrees'), false);
    assert.equal(describe(root, 'stale-generation').session, null);
    let entered = false;
    await withWorkspaceWriteOperation(root, async () => { entered = true; });
    assert.equal(entered, true, 'stale admission must not strand an in-process reservation');
  });
});

test('a selected cloud replica bootstraps one new isolated session and returns a pinned handle', async () => {
  await fixture(async root => {
    const sessionId = 'selected-bootstrap';
    const initial = describe(root, sessionId);
    assert.equal(initial.session, null);
    const run = await admitWorkspaceExecution({ cwd: root, sessionId, workspaceMode: 'isolated', directExecution: true, expectedWorkspace: initial.cloudReplica });
    try {
      const selected = describe(root, sessionId).session;
      assert.ok(selected);
      assert.equal(selected.kind, 'session');
      assert.notEqual(selected.workspaceId, initial.cloudReplica.workspaceId);
      assert.equal(selected.rootPath, run.executionRoot);
      assert.equal(selected.effectiveMode, 'isolated');
      assert.ok(selected.baseRevision);
      assert.equal(run.isolated, true);
      assert.equal(run.sourceRoot, root);
      assert.doesNotThrow(() => run.assertCurrent());
      assert.equal(await readFile(path.join(run.cwd, 'deleted.txt'), 'utf8'), 'base\n');
    } finally { await run.close(); }
    assert.equal(describe(root, sessionId).session?.phase, 'idle');
  });
});

test('a materialized session rejects its old replica selector before lease creation', async () => {
  await fixture(async root => {
    const sessionId = 'selected-materialized';
    const selected = describe(root).cloudReplica;
    const original = await admitWorkspaceExecution({ cwd: root, sessionId, expectedWorkspace: selected });
    await original.close();
    const retained = describe(root, sessionId).session;
    assert.ok(retained);
    assert.doesNotThrow(() => assertWorkspaceDescriptor(selected));
    for (const cwd of [root, retained.rootPath]) {
      await assert.rejects(admitWorkspaceExecution({ cwd, sessionId, workspaceMode: 'isolated', expectedWorkspace: selected }), { code: 'WORKSPACE_SELECTION_MISMATCH' });
    }
    assert.equal(existsSync(root + '.chisa-lease'), false);
    assert.equal(existsSync(retained.rootPath + '.chisa-lease'), false);
    assert.equal(describe(root, sessionId).session?.generation, retained.generation);
  });
});

test('an exact session catalog descriptor reuses its root despite a conflicting incoming mode', async () => {
  await fixture(async root => {
    const sessionId = 'selected-reuse';
    const initial = describe(root).cloudReplica;
    const original = await admitWorkspaceExecution({ cwd: root, sessionId, expectedWorkspace: initial });
    await original.close();
    const selected = describe(root, sessionId).session;
    assert.ok(selected);
    await writeFile(path.join(selected.rootPath, 'retained-selection.txt'), 'keep the existing session\n');
    await writeFile(path.join(root, 'later-source.txt'), 'exclude later source edits\n');
    for (const cwd of [root, selected.rootPath]) {
      const run = await admitWorkspaceExecution({ cwd, sessionId, workspaceMode: 'shared', readOnly: true, directExecution: true, expectedWorkspace: selected });
      try {
        assert.equal(run.cwd, selected.rootPath);
        assert.equal(run.executionRoot, selected.rootPath);
        assert.equal(run.sourceCwd, root);
        assert.equal(run.readOnly, true);
        assert.doesNotThrow(() => run.assertCurrent());
        assert.equal(await readFile(path.join(run.cwd, 'retained-selection.txt'), 'utf8'), 'keep the existing session\n');
        assert.equal(existsSync(path.join(run.cwd, 'later-source.txt')), false);
        const current = describe(root, sessionId).session;
        assert.equal(current?.workspaceId, selected.workspaceId);
        assert.equal(current?.generation, selected.generation);
        assert.equal(current?.baseRevision, selected.baseRevision);
      } finally { await run.close(); }
    }
    assert.equal(describe(root, sessionId).session?.phase, 'idle');
    const sharedId = 'selected-shared-reuse';
    const firstShared = await admitWorkspaceExecution({ cwd: root, sessionId: sharedId, workspaceMode: 'shared', expectedWorkspace: describe(root).cloudReplica });
    await firstShared.close();
    const shared = describe(root, sharedId).session;
    assert.ok(shared);
    assert.equal(shared.effectiveMode, 'shared');
    const reusedShared = await admitWorkspaceExecution({ cwd: root, sessionId: sharedId, workspaceMode: 'isolated', readOnly: true, directExecution: true, expectedWorkspace: shared });
    try {
      assert.equal(reusedShared.executionRoot, root);
      assert.equal(reusedShared.isolated, false);
      assert.doesNotThrow(() => reusedShared.assertCurrent());
      const current = describe(root, sharedId).session;
      assert.equal(current?.workspaceId, shared.workspaceId);
      assert.equal(current?.generation, shared.generation);
      assert.equal(current?.requestedMode, 'shared');
      assert.equal(current?.effectiveMode, 'shared');
      assert.equal(current?.baseRevision, undefined);
    } finally { await reusedShared.close(); }
  });
});

test('binding replacement during the cloud copy rejects before publishing a session snapshot', async () => {
  await fixture(async root => {
    const sessionId = 'selected-waiting';
    const selected = describe(root).cloudReplica;
    const snapshot = holdSnapshot();
    const pending = admitWorkspaceExecution({ cwd: root, sessionId, expectedWorkspace: selected });
    const rejected = assert.rejects(pending, { code: 'WORKSPACE_GENERATION_CHANGED' });
    try {
      await snapshot.copying;
      assert.equal(existsSync(root + '.chisa-lease'), true);
      await replaceBindingEpoch(root);
      const current = describe(root).cloudReplica;
      assert.equal(current.workspaceId, selected.workspaceId);
      assert.notEqual(current.generation, selected.generation);
      snapshot.resume();
      await rejected;
    } finally { snapshot.resume(); snapshot.restore(); }
    assert.equal(describe(root, sessionId).session, null);
  });
});

test('a bootstrapped handle pins the resulting session before assertCurrent, RPC and process spawn', async () => {
  await fixture(async root => {
    const sessionId = 'selected-final-pin';
    const selected = describe(root).cloudReplica;
    const run = await admitWorkspaceExecution({ cwd: root, sessionId, directExecution: true, expectedWorkspace: selected });
    const sessionName = 'session-' + createHash('sha256').update(sessionId).digest('hex') + '.json';
    const statePath = path.join(run.executionRoot + '.chisa-state', sessionName);
    const original = await readFile(statePath, 'utf8');
    const identity = JSON.parse(original) as Record<string, unknown>;
    const leasePath = path.join(run.executionRoot + '.chisa-lease', 'state.json');
    const originalLease = await readFile(leasePath, 'utf8');
    try {
      assert.doesNotThrow(() => run.assertCurrent());
      await writeFile(statePath, JSON.stringify({ ...identity, generation: randomUUID() }));
      assert.doesNotThrow(() => assertWorkspaceDescriptor(selected), 'the original replica pin remains valid');
      assert.throws(() => run.assertCurrent(), { code: 'WORKSPACE_GENERATION_CHANGED' });
      const forbiddenSpawn = mock.method(childProcess, 'spawn', () => { throw new Error('a stale execution must fail before launching any child'); });
      syncBuiltinESMExports();
      try {
        await assert.rejects(run.execute({ op: 'read', path: '/workspace/deleted.txt' }), { code: 'WORKSPACE_GENERATION_CHANGED' });
        await assert.rejects(run.spawnProcess({ command: 'true', args: [] }), { code: 'WORKSPACE_GENERATION_CHANGED' });
        assert.equal(forbiddenSpawn.mock.callCount(), 0);
      } finally { forbiddenSpawn.mock.restore(); syncBuiltinESMExports(); }
      assert.equal(await readFile(leasePath, 'utf8'), originalLease, 'a rejected launch must not mutate the lease');
    } finally {
      await writeFile(statePath, original);
      await run.close();
    }
  });
});
