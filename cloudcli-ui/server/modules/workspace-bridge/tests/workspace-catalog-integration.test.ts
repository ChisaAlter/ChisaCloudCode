import assert from 'node:assert/strict';
import childProcess, { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs, { existsSync, realpathSync } from 'node:fs';
import fileSystem, { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import type { WorkspaceDescriptor } from '@/shared/index.js';

const fixtureRoot = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'chisa-catalog-integration-')));
process.env.WORKSPACES_ROOT = fixtureRoot;
// This real-Git fixture owns its protocol-3 roots without an account Docker runtime.
mock.module('@/modules/workspace-runtime/index.js', { namedExports: {
  ensureCloudWorkspaceBinding() {}, excludeCloudWorkspaceMetadata() {}, getWorkspaceRuntimeIdentity() { return undefined; },
  executeWorkspaceRuntimePreview() { assert.fail('unexpected preview'); },
} });
const { admitWorkspaceExecution, assertWorkspaceDescriptor, describeWorkspaceSelection, integrateWorkspaceSession, withWorkspaceWriteOperation } = await import('@/modules/workspace-bridge/index.js');
const { createWorkspaceChangesService } = await import('@/modules/workspace-changes/index.js');
const changes = createWorkspaceChangesService();
const originalText = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\n';

test.after(async () => {
  assert.equal(path.dirname(fixtureRoot), realpathSync(os.tmpdir()));
  await rm(fixtureRoot, { recursive: true, force: true });
});

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['--no-optional-locks', ...args], { cwd, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
    const output: Buffer[] = []; const errors: Buffer[] = [];
    child.stdout.on('data', chunk => output.push(Buffer.from(chunk)));
    child.stderr.on('data', chunk => errors.push(Buffer.from(chunk)));
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(Buffer.concat(output).toString()) : reject(new Error(Buffer.concat(errors).toString())));
  });
}

async function fixture(run: (root: string) => Promise<void>, repository = true): Promise<void> {
  const root = await mkdtemp(path.join(fixtureRoot, 'project-'));
  await writeFile(path.join(root, '.chisa-bridge.json'), JSON.stringify({ protocol: 3, root, owner: 'cloud-catalog-fixture', bindingEpoch: 'fixture' }));
  try {
    if (repository) {
      await git(['init', '-b', 'main'], root);
      await git(['config', 'core.autocrlf', 'false'], root);
      await mkdir(path.join(root, '.git', 'info'), { recursive: true });
      await writeFile(path.join(root, '.git', 'info', 'exclude'), '.chisa-bridge.json\n');
      await writeFile(path.join(root, 'alpha.txt'), originalText);
      await writeFile(path.join(root, 'beta.txt'), 'beta committed\n');
      await git(['add', '.'], root);
      await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'base'], root);
    }
    await run(root);
  } finally {
    for (const target of [root, root + '.chisa-lease', root + '.chisa-worktrees', root + '.chisa-state']) {
      assert.equal(path.dirname(path.resolve(target)), fixtureRoot);
      await rm(target, { recursive: true, force: true });
    }
  }
}

function describe(root: string, sessionId: string) {
  return describeWorkspaceSelection({ projectId: path.basename(root), sourceRoot: root, sessionId, requestedMode: 'isolated' });
}

function session(root: string, sessionId: string): WorkspaceDescriptor {
  const descriptor = describe(root, sessionId).session;
  assert.ok(descriptor, 'an admitted session must resolve its exact durable execution identity');
  return descriptor;
}

async function materialize(root: string, sessionId: string): Promise<WorkspaceDescriptor> {
  const run = await admitWorkspaceExecution({ cwd: root, sessionId, workspaceMode: 'isolated', directExecution: true });
  await run.close();
  return session(root, sessionId);
}

async function preview(descriptor: WorkspaceDescriptor) {
  const result = await integrateWorkspaceSession({ descriptor, action: 'preview' });
  assert.ok('previewId' in result);
  return result;
}

function applyRequest(descriptor: WorkspaceDescriptor, result: Awaited<ReturnType<typeof preview>>, operationId = randomUUID()) {
  return { descriptor, action: 'apply' as const, previewId: result.previewId, expectedSourceRevision: result.sourceRevision, expectedTargetRevision: result.targetRevision, operationId };
}

function readRecord(file: string): Record<string, unknown> { return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>; }

function inspectOperation(descriptor: WorkspaceDescriptor, operationId: string) {
  return changes.inspectIntegration({ sessionId: descriptor.sessionId!, sourceRoot: descriptor.sourceRoot, executionRoot: descriptor.rootPath, targetRoot: descriptor.sourceRoot, operationId, assertPinned: () => assertWorkspaceDescriptor(descriptor) });
}

function assertReleased(descriptor: WorkspaceDescriptor): void {
  for (const root of [descriptor.sourceRoot, descriptor.rootPath]) {
    assert.equal(existsSync(root + '.chisa-integration.json'), false, 'completed operations must remove both integration barriers');
    assert.equal(existsSync(root + '.chisa-lease'), false, 'completed operations must release both exact reservations');
  }
}

async function assertIntegrationBlocked(descriptor: WorkspaceDescriptor, operationId: string): Promise<void> {
  const current = describe(descriptor.sourceRoot, descriptor.sessionId!);
  assert.equal(current.cloudReplica.phase, 'recovery');
  assert.equal(current.session?.phase, 'recovery');
  assert.equal(current.cloudReplica.capabilities.write, false);
  assert.equal(current.session?.capabilities.integrate, false);
  for (const root of [descriptor.sourceRoot, descriptor.rootPath]) {
    let entered = false;
    await assert.rejects(withWorkspaceWriteOperation(root, async () => { entered = true; }), { code: 'WORKSPACE_RECOVERY_REQUIRED' });
    assert.equal(entered, false);
    await assert.rejects(admitWorkspaceExecution({ cwd: root, sessionId: root === descriptor.rootPath ? descriptor.sessionId : 'blocked-new-run', workspaceMode: root === descriptor.rootPath ? 'isolated' : 'shared', directExecution: true }), { code: 'WORKSPACE_RECOVERY_REQUIRED' });
  }
  await assert.rejects(preview(descriptor), { code: 'WORKSPACE_RECOVERY_REQUIRED' });
  await assert.rejects(integrateWorkspaceSession({ descriptor, action: 'recover', operationId: operationId + '-foreign' }), { code: 'WORKSPACE_RECOVERY_REQUIRED' });
}

// Faults run after the real persistence primitive, so recovery observes actual
// interrupted metadata and target bytes rather than a mocked service result.
async function interruptIntegration(request: ReturnType<typeof applyRequest>, point: 'partial-journal' | 'receipt' | 'publication' | 'marker-only'): Promise<void> {
  const operation = createHash('sha256').update(request.operationId).digest('hex');
  const state = request.descriptor.rootPath + '.chisa-state';
  const journal = path.join(state, 'changes', 'operations', operation + '.json');
  const receipt = path.join(state, 'changes', 'receipts', operation + '.json');
  const publication = path.join(state, 'session-' + createHash('sha256').update(request.descriptor.sessionId!).digest('hex') + '.json');
  const injected = Object.assign(new Error('injected integration interruption: ' + point), { code: 'INJECTED_INTEGRATION_FAILURE' });
  let interrupted = false;
  const interrupt = () => { interrupted = true; throw injected; };
  const originalRename = fs.renameSync; const originalLink = fs.linkSync; const originalSpawn = childProcess.spawnSync;
  const renamed = mock.method(fs, 'renameSync', (...args: Parameters<typeof fs.renameSync>) => {
    originalRename(...args);
    if (interrupted) return;
    const destination = String(args[1]);
    if (point === 'partial-journal' && destination === journal && readRecord(journal).phase === 'applying') interrupt();
    if (point === 'publication' && destination === publication && readRecord(publication).publicationState === 'integrated') interrupt();
    if (point === 'marker-only' && destination === request.descriptor.rootPath + '.chisa-integration.json') interrupt();
  });
  const linked = mock.method(fs, 'linkSync', (...args: Parameters<typeof fs.linkSync>) => {
    originalLink(...args);
    if (!interrupted && point === 'receipt' && String(args[1]) === receipt) interrupt();
  });
  const spawned = mock.method(childProcess, 'spawnSync', (...args: Parameters<typeof childProcess.spawnSync>) => {
    const result = originalSpawn(...args);
    if (!interrupted && point === 'marker-only' && args[0] === 'python3' && result.status === 0 && args[2]?.input) {
      const input = JSON.parse(String(args[2].input)) as Record<string, unknown>;
      if (input.action === 'begin') interrupt();
    }
    return result;
  });
  syncBuiltinESMExports();
  try { await assert.rejects(integrateWorkspaceSession(request), { code: point === 'marker-only' && process.platform === 'linux' ? 'WORKSPACE_INTEGRATION_INVALID' : 'INJECTED_INTEGRATION_FAILURE' }); }
  finally { renamed.mock.restore(); linked.mock.restore(); spawned.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(interrupted, true, 'the requested durable boundary must be reached');
}

test('catalog publishes the final isolated descriptor only after a pinned cloud snapshot and immutable baseline exist', { timeout: 120_000 }, async () => {
  await fixture(async root => {
    const sessionId = 'first-dirty-snapshot';
    const initial = describe(root, sessionId);
    assert.equal(initial.session, null);
    await writeFile(path.join(root, 'alpha.txt'), 'staged before snapshot\n');
    await git(['add', 'alpha.txt'], root);
    await writeFile(path.join(root, 'alpha.txt'), 'working before snapshot\n');
    await writeFile(path.join(root, 'baseline-untracked.txt'), 'untracked before snapshot\n');
    const begun = gate(); const pinned = gate();
    const originalCopy = fileSystem.cp;
    const copying = mock.method(fileSystem, 'cp', async (...args: Parameters<typeof fileSystem.cp>) => {
      begun.resolve(); await pinned.promise;
      return originalCopy(...args);
    });
    syncBuiltinESMExports();
    const pending = admitWorkspaceExecution({ cwd: root, sessionId, workspaceMode: 'isolated', directExecution: true });
    let run: Awaited<ReturnType<typeof admitWorkspaceExecution>> | undefined;
    try {
      await begun.promise;
      const waiting = describe(root, sessionId);
      assert.equal(waiting.session, null);
      assert.equal(waiting.cloudReplica.phase, 'running');
      pinned.resolve();
      run = await pending;
      const current = session(root, sessionId);
      assert.equal(current.rootPath, run.executionRoot);
      assert.equal(current.sourceRoot, root);
      assert.equal(current.effectiveMode, 'isolated');
      assert.equal(current.phase, 'running');
      assert.equal(current.capabilities.integrate, false);
      assert.ok(current.baseRevision);
      assert.equal(describe(root, sessionId).cloudReplica.workspaceId, initial.cloudReplica.workspaceId);
      assert.equal(await readFile(path.join(run.cwd, 'alpha.txt'), 'utf8'), 'working before snapshot\n');
      assert.equal(await git(['show', ':alpha.txt'], run.cwd), 'staged before snapshot\n');
      assert.equal(await readFile(path.join(run.cwd, 'baseline-untracked.txt'), 'utf8'), 'untracked before snapshot\n');
      const baselineInput = { sessionId, sourceRoot: root, executionRoot: run.executionRoot, assertPinned: () => {}, withLock: async <T>(operation: () => Promise<T>) => operation() };
      const baseline = await changes.inspectBaseline(baselineInput);
      assert.equal(baseline.available, true);
      if (baseline.available) assert.equal(baseline.baselineId, current.baseRevision);
      await writeFile(path.join(run.cwd, 'alpha.txt'), 'later session result\n');
      assert.deepEqual(await changes.inspectBaseline(baselineInput), baseline);
      await run.close();
      const ready = session(root, sessionId);
      assert.equal(ready.generation, current.generation);
      assert.equal(ready.workspaceId, current.workspaceId);
      assert.equal(ready.baseRevision, current.baseRevision);
      assert.equal(ready.phase, 'idle');
      assert.equal(ready.capabilities.integrate, true);
      assertWorkspaceDescriptor(current);
    } finally {
      pinned.resolve();
      copying.mock.restore(); syncBuiltinESMExports();
      run ??= await pending;
      await run.close();
    }
  });
});

test('bridge integrates only B-to-A into divergent T, preserves target index, and replays an exact receipt', { timeout: 120_000 }, async () => {
  await fixture(async root => {
    const baselineText = originalText.replace('one\n', 'baseline dirty one\n');
    await writeFile(path.join(root, 'alpha.txt'), baselineText);
    await writeFile(path.join(root, 'beta.txt'), 'baseline staged beta\n');
    await git(['add', 'beta.txt'], root);
    await writeFile(path.join(root, 'beta.txt'), 'baseline working beta\n');
    await writeFile(path.join(root, 'baseline-only.txt'), 'old untracked dirt\n');
    const descriptor = await materialize(root, 'dirty-delta');
    await writeFile(path.join(descriptor.rootPath, 'alpha.txt'), baselineText.replace('five\n', 'session five\n'));
    await writeFile(path.join(descriptor.rootPath, 'session-only.txt'), 'new session file\n');
    await git(['reset', '--hard', 'HEAD'], root);
    const baselineOnly = path.join(root, 'baseline-only.txt');
    assert.equal(path.dirname(baselineOnly), root);
    await rm(baselineOnly);
    await writeFile(path.join(root, 'alpha.txt'), originalText.replace('nine\n', 'target nine\n'));
    await writeFile(path.join(root, 'beta.txt'), 'target staged beta\n');
    await git(['add', 'beta.txt'], root);
    const targetIndex = await readFile(path.join(root, '.git', 'index'));
    const targetHead = await git(['rev-parse', 'HEAD'], root);
    const reviewed = await preview(descriptor);
    assert.equal(reviewed.baselineId, descriptor.baseRevision);
    assert.equal(reviewed.canApply, true);
    assert.deepEqual(reviewed.conflicts, []);
    assert.deepEqual(reviewed.changes.map(change => change.path), ['alpha.txt', 'session-only.txt']);
    const request = applyRequest(descriptor, reviewed);
    const applied = await integrateWorkspaceSession(request);
    assert.ok('status' in applied && applied.status === 'applied');
    assert.equal(applied.replayed, false);
    assert.equal(await readFile(path.join(root, 'alpha.txt'), 'utf8'), originalText.replace('five\n', 'session five\n').replace('nine\n', 'target nine\n'));
    assert.equal(await readFile(path.join(root, 'beta.txt'), 'utf8'), 'target staged beta\n');
    assert.equal(existsSync(baselineOnly), false);
    assert.equal(await readFile(path.join(descriptor.rootPath, 'baseline-only.txt'), 'utf8'), 'old untracked dirt\n');
    assert.deepEqual(await readFile(path.join(root, '.git', 'index')), targetIndex);
    assert.equal(await git(['rev-parse', 'HEAD'], root), targetHead);
    assert.equal(session(root, descriptor.sessionId!).publicationState, 'integrated');
    const unchanged = await preview(descriptor);
    assert.deepEqual(unchanged.changes, []);
    await writeFile(path.join(root, 'beta.txt'), 'target changed after successful integration\n');
    await writeFile(path.join(descriptor.rootPath, 'session-only.txt'), 'later session edit\n');
    const replayed = await integrateWorkspaceSession(request);
    assert.ok('status' in replayed && replayed.status === 'applied');
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.operationId, applied.operationId);
    assert.equal(await readFile(path.join(root, 'beta.txt'), 'utf8'), 'target changed after successful integration\n');
    assert.equal(await readFile(path.join(root, 'session-only.txt'), 'utf8'), 'new session file\n');
  });
});

test('conflict leaves target bytes untouched and idle recovery does not relabel publication', { timeout: 120_000 }, async () => {
  await fixture(async root => {
    const descriptor = await materialize(root, 'conflicting-session');
    await writeFile(path.join(descriptor.rootPath, 'beta.txt'), 'session beta\n');
    await writeFile(path.join(descriptor.rootPath, 'clean-add.txt'), 'must not apply\n');
    await writeFile(path.join(root, 'beta.txt'), 'target beta\n');
    const reviewed = await preview(descriptor);
    assert.equal(reviewed.canApply, false);
    assert.deepEqual(reviewed.conflicts.map(conflict => conflict.path), ['beta.txt']);
    const result = await integrateWorkspaceSession(applyRequest(descriptor, reviewed));
    assert.ok('status' in result && result.status === 'conflict');
    assert.equal(await readFile(path.join(root, 'beta.txt'), 'utf8'), 'target beta\n');
    assert.equal(existsSync(path.join(root, 'clean-add.txt')), false);
    assert.equal(session(root, descriptor.sessionId!).publicationState, 'conflicted');
    const recovered = await integrateWorkspaceSession({ descriptor, action: 'recover' });
    assert.ok('status' in recovered && recovered.status === 'idle');
    assert.equal(session(root, descriptor.sessionId!).publicationState, 'conflicted');
  });
});

test('stale source or target revisions and stale descriptor generations fail before integration writes', { timeout: 120_000 }, async () => {
  await fixture(async root => {
    const descriptor = await materialize(root, 'stale-session');
    await writeFile(path.join(descriptor.rootPath, 'beta.txt'), 'first session result\n');
    const first = await preview(descriptor);
    const staleSource = applyRequest(descriptor, first);
    await writeFile(path.join(descriptor.rootPath, 'beta.txt'), 'second session result\n');
    await assert.rejects(integrateWorkspaceSession(staleSource), { code: 'WORKSPACE_CHANGES_STALE' });
    assert.equal(await readFile(path.join(root, 'beta.txt'), 'utf8'), 'beta committed\n');
    assert.equal(inspectOperation(descriptor, staleSource.operationId).status, 'idle');
    assertReleased(descriptor);
    const second = await preview(descriptor);
    const staleTarget = applyRequest(descriptor, second);
    await writeFile(path.join(root, 'alpha.txt'), 'target changed after review\n');
    await assert.rejects(integrateWorkspaceSession(staleTarget), { code: 'WORKSPACE_CHANGES_STALE' });
    assert.equal(await readFile(path.join(root, 'beta.txt'), 'utf8'), 'beta committed\n');
    assert.equal(inspectOperation(descriptor, staleTarget.operationId).status, 'idle');
    assertReleased(descriptor);
    assert.equal(session(root, descriptor.sessionId!).publicationState, 'unpublished');
    let entered = 0;
    for (const candidate of [root, descriptor.rootPath]) await withWorkspaceWriteOperation(candidate, async () => { entered++; });
    assert.equal(entered, 2, 'prewrite stale failure must not strand either write scope');
    const admitted = await admitWorkspaceExecution({ cwd: root, sessionId: 'after-stale-shared', workspaceMode: 'shared', directExecution: true });
    await admitted.close();
    assertReleased(descriptor);
    const stale = { ...descriptor, generation: randomUUID() };
    assert.throws(() => assertWorkspaceDescriptor(stale), { code: 'WORKSPACE_GENERATION_CHANGED' });
    await assert.rejects(preview(stale), { code: 'WORKSPACE_GENERATION_CHANGED' });
    const marker = path.join(root, '.chisa-bridge.json');
    const binding = JSON.parse(await readFile(marker, 'utf8')) as Record<string, unknown>;
    await writeFile(marker, JSON.stringify({ ...binding, bindingEpoch: 'new-binding' }));
    await assert.rejects(preview(descriptor), { code: 'WORKSPACE_IDENTITY_CHANGED' });
  });
});

test('unmaterialized selectors never fall back to the cloud replica or synthesize a baseline', { timeout: 30_000 }, async () => {
  await fixture(async root => {
    const sessionId = 'not-admitted';
    const unresolved = describe(root, sessionId);
    assert.equal(unresolved.session, null);
    assert.equal(existsSync(root + '.chisa-worktrees'), false);
    const forged: WorkspaceDescriptor = { ...unresolved.cloudReplica, kind: 'session', sessionId, requestedMode: 'isolated', effectiveMode: 'isolated', baseRevision: 'unverified' };
    assert.throws(() => assertWorkspaceDescriptor(forged), { code: 'WORKSPACE_SELECTION_MISMATCH' });
    await assert.rejects(preview(forged), { code: 'WORKSPACE_SELECTION_MISMATCH' });
    assert.equal(describe(root, sessionId).session, null);
    assert.equal(existsSync(root + '.chisa-worktrees'), false);
  });
});

test('successful shared and non-Git fallback admissions record their actual execution descriptor', { timeout: 120_000 }, async t => {
  for (const requestedMode of ['shared', 'isolated'] as const) await t.test(requestedMode, async () => {
    await fixture(async root => {
      const sessionId = 'admitted-' + requestedMode;
      assert.equal(describe(root, sessionId).session, null);
      const run = await admitWorkspaceExecution({ cwd: root, sessionId, workspaceMode: requestedMode, directExecution: true });
      try {
        assert.equal(run.isolated, false);
        const descriptor = session(root, sessionId);
        assert.equal(descriptor.rootPath, root);
        assert.equal(descriptor.requestedMode, requestedMode);
        assert.equal(descriptor.effectiveMode, 'shared');
        assert.equal(descriptor.baseRevision, undefined);
        assert.equal(descriptor.capabilities.integrate, false);
        assert.equal(descriptor.phase, 'running');
      } finally { await run.close(); }
      assert.equal(session(root, sessionId).phase, 'idle');
    }, requestedMode === 'shared');
  });
});

test('retained legacy sessions acquire an exact descriptor without adopting their current edits as a baseline', { timeout: 120_000 }, async () => {
  await fixture(async root => {
    const sessionId = 'legacy-session';
    const original = await materialize(root, sessionId);
    await writeFile(path.join(original.rootPath, 'beta.txt'), 'retained legacy result\n');
    // Older retained worktrees have execution markers, but no identity/baseline store.
    const legacyState = original.rootPath + '.chisa-state';
    assert.equal(path.dirname(legacyState), root + '.chisa-worktrees');
    await rm(legacyState, { recursive: true });
    assert.equal(describe(root, sessionId).session, null);
    const run = await admitWorkspaceExecution({ cwd: root, sessionId, workspaceMode: 'isolated', directExecution: true });
    try {
      const retained = session(root, sessionId);
      assert.equal(retained.rootPath, original.rootPath);
      assert.equal(retained.baseRevision, undefined);
      assert.equal(retained.capabilities.integrate, false);
      assert.equal(await readFile(path.join(run.cwd, 'beta.txt'), 'utf8'), 'retained legacy result\n');
    } finally { await run.close(); }
    const retained = session(root, sessionId);
    await assert.rejects(preview(retained), { code: 'WORKSPACE_BASELINE_UNAVAILABLE' });
    assert.equal(existsSync(path.join(legacyState, 'changes', 'baseline.json')), false);
  });
});

test('cloud integration publication is durable before either exact reservation is released', { timeout: 120_000 }, async () => {
  await fixture(async root => {
    const descriptor = await materialize(root, 'publication-order');
    await writeFile(path.join(descriptor.rootPath, 'beta.txt'), 'publish before release\n');
    const reviewed = await preview(descriptor);
    const originalRemove = fs.rmSync;
    let releases = 0;
    const removing = mock.method(fs, 'rmSync', (...args: Parameters<typeof fs.rmSync>) => {
      if ([root + '.chisa-lease', descriptor.rootPath + '.chisa-lease'].includes(String(args[0]))) {
        releases++;
        assert.equal(session(root, descriptor.sessionId!).publicationState, 'integrated');
        assert.equal(existsSync(root + '.chisa-integration.json'), false);
        assert.equal(existsSync(descriptor.rootPath + '.chisa-integration.json'), false);
      }
      return originalRemove(...args);
    });
    syncBuiltinESMExports();
    try {
      const result = await integrateWorkspaceSession(applyRequest(descriptor, reviewed));
      assert.ok('status' in result && result.status === 'applied');
      assert.equal(releases, 2);
    } finally { removing.mock.restore(); syncBuiltinESMExports(); }
  });
});

for (const point of ['partial-journal', 'receipt', 'publication', 'marker-only'] as const) {
  test('integration interruption at ' + point + ' fences both cloud roots and resumes the exact original operation', { timeout: 120_000 }, async () => {
    await fixture(async root => {
      const descriptor = await materialize(root, 'interrupted-' + point);
      await writeFile(path.join(descriptor.rootPath, 'alpha.txt'), 'integrated alpha\n');
      await writeFile(path.join(descriptor.rootPath, 'beta.txt'), 'integrated beta\n');
      const reviewed = await preview(descriptor);
      const request = applyRequest(descriptor, reviewed);
      const index = await readFile(path.join(root, '.git', 'index'));
      const head = await git(['rev-parse', 'HEAD'], root);
      await interruptIntegration(request, point);
      const sourceLease = readRecord(path.join(root + '.chisa-lease', 'state.json'));
      const sessionLease = readRecord(path.join(descriptor.rootPath + '.chisa-lease', 'state.json'));
      assert.equal(sourceLease.owner, 'claude');
      assert.equal(sessionLease.owner, 'claude');
      for (const candidate of [root, descriptor.rootPath]) {
        const marker = readRecord(candidate + '.chisa-integration.json');
        assert.deepEqual(marker.intent, {
          workspaceId: descriptor.workspaceId, generation: descriptor.generation, baseRevision: descriptor.baseRevision,
          sourceRoot: root, executionRoot: descriptor.rootPath, sessionId: descriptor.sessionId, bindingEpoch: 'fixture',
          operationId: request.operationId, previewId: request.previewId,
          expectedSourceRevision: request.expectedSourceRevision, expectedTargetRevision: request.expectedTargetRevision,
        });
      }
      const interrupted = inspectOperation(descriptor, request.operationId);
      if (point === 'marker-only') {
        assert.equal(interrupted.status, 'idle');
        assert.equal(await readFile(path.join(root, 'alpha.txt'), 'utf8'), originalText);
      } else if (point === 'publication') {
        assert.equal(interrupted.status, 'committed');
        assert.equal(interrupted.active, false);
      } else {
        assert.equal(interrupted.status, 'pending');
        assert.equal(interrupted.active, true);
        assert.equal(interrupted.phase, point === 'receipt' ? 'applied' : 'applying');
        assert.equal(interrupted.receipt?.operationId ?? null, point === 'receipt' ? request.operationId : null);
      }
      assert.equal(await readFile(path.join(root, 'beta.txt'), 'utf8'), point === 'partial-journal' || point === 'marker-only' ? 'beta committed\n' : 'integrated beta\n');
      assert.equal(session(root, descriptor.sessionId!).publicationState, point === 'publication' ? 'integrated' : 'unpublished');
      await assertIntegrationBlocked(descriptor, request.operationId);
      assert.deepEqual(readRecord(path.join(root + '.chisa-lease', 'state.json')), sourceLease);
      assert.deepEqual(readRecord(path.join(descriptor.rootPath + '.chisa-lease', 'state.json')), sessionLease);
      const recovered = await integrateWorkspaceSession({ descriptor, action: 'recover', operationId: request.operationId });
      assert.ok('status' in recovered && recovered.status === 'applied');
      assert.equal(recovered.operationId, request.operationId);
      assert.equal(recovered.replayed, point === 'receipt' || point === 'publication');
      assertReleased(descriptor);
      const committed = inspectOperation(descriptor, request.operationId);
      assert.equal(committed.status, 'committed');
      assert.equal(committed.active, false);
      assert.equal(await readFile(path.join(root, 'alpha.txt'), 'utf8'), 'integrated alpha\n');
      assert.equal(await readFile(path.join(root, 'beta.txt'), 'utf8'), 'integrated beta\n');
      assert.deepEqual(await readFile(path.join(root, '.git', 'index')), index);
      assert.equal(await git(['rev-parse', 'HEAD'], root), head);
      assert.equal(session(root, descriptor.sessionId!).phase, 'idle');
      assert.equal(session(root, descriptor.sessionId!).publicationState, 'integrated');
    });
  });
}

