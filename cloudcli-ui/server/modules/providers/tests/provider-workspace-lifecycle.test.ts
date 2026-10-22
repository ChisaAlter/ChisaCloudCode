import assert from 'node:assert/strict';
import test from 'node:test';

import { createProviderRuntimeService } from '@/modules/providers/services/provider-runtime.service.js';
import type { IProvider, IProviderRuntime, LLMProvider } from '@/shared/index.js';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function makeService(provider: LLMProvider, runtime: IProviderRuntime, admission: any) {
  const adapter = { id: provider, runtime, sessions: { normalizeMessage: () => [] }, auth: { getStatus: async () => ({ installed: true }) } } as unknown as IProvider;
  return createProviderRuntimeService({
    listProviders: () => [adapter], resolveProvider: () => adapter,
    resolveProviderSessionId: () => 'native-session', resolveResumeModel: async () => 'model',
    getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'model' }),
    getSessionSource: () => ({ project_path: '/source', workspace_mode: 'isolated', provider }),
    admitWorkspaceExecution: admission,
    registerManagedProviderProfile: () => '/fixture/profile',
  });
}

function lease(close: () => Promise<void>) {
  return { sourceCwd: '/source', cwd: '/isolated', sourceRoot: '/source', executionRoot: '/isolated', bound: true, bindingKind: 'vps', isolated: true, readOnly: false, revoke() {}, close };
}

for (const provider of ['codex', 'cursor', 'opencode'] as const) {
  test(`${provider} keeps source identity and delays complete until process and handback`, async () => {
    const processStopped = deferred();
    const closeStarted = deferred();
    const handback = deferred();
    const messages: any[] = [];
    const marker: string[] = [];
    const service = makeService(provider, {
      async run(_command, options, writer) {
        assert.equal(options.cwd, '/isolated');
        assert.equal(options.projectPath, '/source');
        assert.equal(options.sourceCwd, '/source');
        writer.send({ kind: 'complete', exitCode: 0 });
        await processStopped.promise;
        marker.push('process-stopped');
      }, abort: () => false,
    }, async (input: any) => {
      assert.equal(input.cwd, '/source', 'stored session wins over caller cwd');
      assert.equal(input.workspaceMode, 'isolated');
      assert.equal(input.directExecution, true);
      return lease(async () => { assert.deepEqual(marker, ['process-stopped']); closeStarted.resolve(); await handback.promise; marker.push('handback'); });
    });
    const running = service.run(provider, 'fixture', { sessionId: 'app', cwd: '/stale', workspaceMode: 'shared' }, { send: (message) => messages.push(message) });
    await Promise.resolve();
    assert.deepEqual(messages, []);
    processStopped.resolve();
    await closeStarted.promise;
    assert.deepEqual(messages, []);
    await assert.rejects(service.run(provider, 'next', { sessionId: 'app' }, { send() {} }), { code: 'RUN_IN_PROGRESS' });
    handback.resolve();
    await running;
    assert.deepEqual(marker, ['process-stopped', 'handback']);
    assert.equal(messages.length, 1);
    assert.equal((messages[0] as { kind?: string }).kind, 'complete');
  });
}

test('abort during admission waits cleanup and never launches provider', async () => {
  const entered = deferred();
  const returnLease = deferred();
  const handback = deferred();
  let started = false;
  let closed = false;
  const service = makeService('opencode', { async run() { started = true; }, abort: () => false }, async (input: any) => {
    entered.resolve();
    await returnLease.promise;
    assert.equal(input.signal.aborted, true);
    return lease(async () => { await handback.promise; closed = true; });
  });
  const running = service.run('opencode', 'fixture', { sessionId: 'app' }, { send() { assert.fail('cancelled run emitted terminal'); } });
  void running.catch(() => {});
  await entered.promise;
  let aborted = false;
  const aborting = service.abort('opencode', 'app').then((result) => { aborted = true; return result; });
  returnLease.resolve();
  await Promise.resolve();
  assert.equal(started, false);
  assert.equal(aborted, false);
  handback.resolve();
  assert.equal(await aborting, true);
  await assert.rejects(running, { name: 'AbortError' });
  assert.equal(closed, true);
});

test('abort during finalization remains pending until exact handback succeeds', async () => {
  const closing = deferred();
  const handback = deferred();
  const messages: unknown[] = [];
  const service = makeService('cursor', { async run(_command, _options, writer) { writer.send({ kind: 'complete' }); }, abort: () => false }, async () => lease(async () => { closing.resolve(); await handback.promise; }));
  const running = service.run('cursor', 'fixture', { sessionId: 'app' }, { send: (message) => messages.push(message) });
  await closing.promise;
  let settled = false;
  const aborting = service.abort('cursor', 'app').then((result) => { settled = true; return result; });
  await Promise.resolve();
  assert.equal(settled, false);
  handback.resolve();
  assert.equal(await aborting, true);
  await running;
  assert.deepEqual(messages, []);
});

test('unconfirmed process teardown keeps lease and blocks next run without complete', async () => {
  let closed = false;
  const service = makeService('codex', { async run() { throw Object.assign(new Error('child still alive'), { processTeardownError: true }); }, abort: () => false }, async () => lease(async () => { closed = true; }));
  await assert.rejects(service.run('codex', 'fixture', { sessionId: 'app' }, { send() { assert.fail('unsafe terminal'); } }), { workspaceCleanupError: true });
  assert.equal(closed, false);
  await assert.rejects(service.abort('codex', 'app'), { workspaceCleanupError: true });
  await assert.rejects(service.run('codex', 'next', { sessionId: 'app' }, { send() {} }), { code: 'RUN_IN_PROGRESS' });
});

for (const provider of ['codex', 'cursor', 'opencode'] as const) {
  test(`${provider} retries admission after confirmed teardown and recovers handback without restarting`, async () => {
    let admissionCalls = 0;
    let providerRuns = 0;
    let nativeBarrier = false;
    let handbacks = 0;
    const messages: any[] = [];
    const service = makeService(provider, {
      async run(_command, _options, writer) {
        providerRuns += 1;
        writer.send({ kind: 'complete', exitCode: 0 });
      },
      abort: () => false,
    }, async () => {
      admissionCalls += 1;
      if (nativeBarrier) throw Object.assign(new Error('Exact native handback is still pending'), { code: 'WORKSPACE_BUSY', workspaceAdmissionRejected: true });
      return lease(async () => {
        handbacks += 1;
        if (handbacks === 1) {
          nativeBarrier = true;
          throw new Error('sync_end receipt not confirmed');
        }
      });
    });
    const writer = { send: (message: unknown) => messages.push(message) };
    await assert.rejects(service.run(provider, 'first', { sessionId: 'app' }, writer), { workspaceCleanupError: true });
    assert.equal(providerRuns, 1, 'initial process was already confirmed stopped');
    assert.equal(messages.length, 0, 'failed handback must not publish success');
    await assert.rejects(service.run(provider, 'blocked', { sessionId: 'app' }, writer), { code: 'WORKSPACE_BUSY' });
    assert.equal(admissionCalls, 2, 'dispatcher must consult the durable workspace barrier');
    assert.equal(providerRuns, 1, 'pending native ownership must still block execution');
    nativeBarrier = false; // Exact native recovery completed outside this Node runtime.
    await service.run(provider, 'after recovery', { sessionId: 'app' }, writer);
    assert.equal(admissionCalls, 3);
    assert.equal(providerRuns, 2);
    assert.equal(handbacks, 2);
    assert.equal(messages.length, 1);
    assert.equal((messages[0] as { kind: string }).kind, 'complete');
  });
}

test('a runtime error after early success complete becomes failure only after safe close', async () => {
  let closed = false;
  const messages: any[] = [];
  const service = makeService('cursor', { async run(_command, _options, writer) { writer.send({ kind: 'complete', exitCode: 0 }); throw new Error('late provider failure'); }, abort: () => false }, async () => lease(async () => { closed = true; }));
  await assert.rejects(service.run('cursor', 'fixture', { sessionId: 'app' }, { send(message) { assert.equal(closed, true); messages.push(message); } }), /late provider failure/);
  assert.equal(messages[0]?.exitCode, 1);
});

test('Claude keeps its workspaceQuery lifecycle without a second admission', async () => {
  let calls = 0;
  const service = makeService('claude', { async run() { calls += 1; }, abort: () => false }, async () => assert.fail('double lifecycle'));
  await service.run('claude', 'fixture', { sessionId: 'app' }, { send() {} });
  assert.equal(calls, 1);
});
