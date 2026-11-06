import assert from 'node:assert/strict';
import test from 'node:test';

import { providerRegistry } from '../provider.registry.js';
import { createProviderRuntimeService } from '../services/provider-runtime.service.js';
import type { IProvider, IProviderRuntime, LLMProvider } from '@/shared/index.js';

function createRuntime(overrides: Partial<IProviderRuntime> = {}): IProviderRuntime {
  return {
    async run() {
      return undefined;
    },
    abort() {
      return false;
    },
    ...overrides,
  };
}

function createProvider(id: LLMProvider, runtime: IProviderRuntime): IProvider {
  return {
    id,
    runtime,
    auth: {
      async getStatus() {
        return {
          provider: id,
          installed: true,
          authenticated: true,
          method: 'test',
          details: {},
        };
      },
    },
    sessions: {
      normalizeMessage(raw: unknown, sessionId: string | null) {
        return [{ kind: 'assistant', content: String(raw), sessionId, provider: id }];
      },
      async fetchHistory() {
        return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
      },
    },
  } as unknown as IProvider;
}

function createService(providers: IProvider[]) {
  const providerMap = new Map(providers.map((provider) => [provider.id, provider]));
  return createProviderRuntimeService({
    listProviders: () => providers,
    resolveProvider(providerName) {
      const provider = providerMap.get(providerName as LLMProvider);
      if (!provider) {
        throw new Error(`Missing provider: ${providerName}`);
      }
      return provider;
    },
    getSessionSource: () => null,
    getWorkspaceAttachmentMode: () => 'host',
    resolveProviderSessionId: (sessionId) => sessionId ? `native-${sessionId}` : null,
    async resolveResumeModel(_provider, _sessionId, requestedModel) {
      return requestedModel?.trim() || undefined;
    },
    async getProviderModels() {
      return {
        OPTIONS: [],
        DEFAULT: 'default-model',
      };
    },
  });
}

test('providerRegistry owns one runtime for every registered provider', () => {
  const providers = providerRegistry.listProviders();

  assert.deepEqual(providers.map((provider) => provider.id), [
    'claude',
    'codex',
    'cursor',
    'opencode',
  ]);
  assert.equal(providers.every((provider) => typeof provider.runtime.run === 'function'), true);
  assert.equal(providers.every((provider) => typeof provider.runtime.abort === 'function'), true);
});

test('dispatches runs and aborts through the runtime owned by providerRegistry', async () => {
  const calls: unknown[][] = [];
  const runtime = createRuntime({
    async run(command, options, writer, context) {
      calls.push(['run', command, options, writer]);
      assert.equal(context.resolveProviderSessionId('session-1'), 'native-session-1');
      assert.equal(await context.resolveResumeModel('session-1', 'sonnet'), 'sonnet');
      assert.deepEqual(await context.getProviderModels(), { OPTIONS: [], DEFAULT: 'default-model' });
      assert.equal(context.normalizeMessage('hello', 'session-1')[0]?.provider, 'claude');
      assert.equal(await context.isProviderInstalled(), true);
      return 'complete';
    },
    async abort(sessionId) {
      calls.push(['abort', sessionId]);
      return true;
    },
  });
  const service = createService([createProvider('claude', runtime)]);
  const writer = { userId: 'owner', send() {} };

  assert.equal(service.hasRuntime('claude'), true);
  assert.equal(service.hasRuntime('unknown'), false);
  assert.equal(await service.getRunner('claude')('hello', { model: 'sonnet' }, writer), 'complete');
  assert.equal(await service.abort('claude', 'session-1'), true);
  assert.deepEqual(calls, [
    ['run', 'hello', { model: 'sonnet' }, writer],
    ['abort', 'session-1'],
  ]);
});

test('routes permission decisions through provider-owned runtime capabilities', () => {
  const decisions: unknown[][] = [];
  const claudeRuntime = createRuntime({
    permissions: {
      resolve(requestId, decision) {
        decisions.push([requestId, decision]);
      },
      listPending(sessionId) {
        return [{ requestId: 'request-1', sessionId }];
      },
    },
  });
  const service = createService([
    createProvider('claude', claudeRuntime),
    createProvider('cursor', createRuntime()),
  ]);
  const decision = { allow: true, message: 'approved' };

  service.resolveToolApproval('request-1', decision);

  assert.deepEqual(decisions, [['request-1', decision]]);
  assert.deepEqual(service.getPendingApprovalsForSession('session-1'), [
    { requestId: 'request-1', sessionId: 'session-1' },
  ]);
});

test('background stops require exact provider, session and task membership without a foreground run', async () => {
  const stops: string[][] = [];
  let active = true;
  const runtime = createRuntime({
    listBackgroundWork: () => active ? [{ sessionId: 'held-session', tasks: [{ taskId: 'held-task', toolUseId: 'tool', taskType: 'agent', description: 'Held background work', startedAt: 1 }] }] : [],
    async stopBackgroundTask(sessionId, taskId) { stops.push([sessionId, taskId]); return true; },
  });
  const provider = createProvider('claude', runtime);
  // Registry's historical fallback is intentional in this fixture.
  const service = createProviderRuntimeService({ resolveProvider: () => provider, listProviders: () => [provider] });
  for (const [providerName, sessionId, taskId] of [
    ['codex', 'held-session', 'held-task'], ['unknown', 'held-session', 'held-task'],
    ['claude', 'other-session', 'held-task'], ['claude', 'held-session', 'missing'],
  ]) {
    assert.equal(service.hasBackgroundTask(providerName as LLMProvider, sessionId, taskId), false);
    assert.equal(await service.stopBackgroundTask(providerName as LLMProvider, sessionId, taskId), false);
  }
  assert.deepEqual(stops, []);
  assert.equal(service.hasBackgroundTask('claude', 'held-session', 'held-task'), true);
  assert.equal(await service.stopBackgroundTask('claude', 'held-session', 'held-task'), true);
  assert.deepEqual(stops, [['held-session', 'held-task']]);
  active = false;
  assert.equal(await service.stopBackgroundTask('claude', 'held-session', 'held-task'), false);
  assert.equal(stops.length, 1);
});

for (const providerName of ['claude', 'codex', 'cursor', 'opencode'] as const) {
  test(`${providerName} default authorization rejects invalid trusted identities before any provider work`, async () => {
    const calls = { lookup: 0, mode: 0, admission: 0 };
    const service = createProviderRuntimeService({
      resolveProvider() { calls.lookup++; assert.fail('Invalid identity must not look up a provider'); },
      getWorkspaceAttachmentMode() { calls.mode++; assert.fail('Invalid identity must not inspect workspace binding'); },
      async admitWorkspaceExecution() { calls.admission++; assert.fail('Invalid identity must not acquire a workspace'); },
    });
    for (const userId of [undefined, null, '', '  ', Number.NaN, Number.POSITIVE_INFINITY, 'owner\nforged', 'owner\0forged']) {
      await assert.rejects(service.run(providerName, 'reject', {
        sessionId: 'identity-denial', cwd: '/unowned', userId: 'forged', attachmentMode: 'host',
      }, { userId, send() { assert.fail('Invalid identity must not publish output'); } }), { code: 'UNAUTHORIZED' });
    }
    assert.deepEqual(calls, { lookup: 0, mode: 0, admission: 0 });
  });
}

for (const attachmentMode of ['host', 'slot'] as const) {
  test(`Claude selects ${attachmentMode} attachments from its authorized stored source`, async () => {
    const entered = authorizationGate();
    const authorized = authorizationGate();
    const calls: string[] = [];
    const provider = createProvider('claude', createRuntime({
      async run(_command, _options, writer, context) {
        calls.push('run');
        assert.equal(writer.userId, 'owner');
        assert.equal(context.attachmentMode, attachmentMode);
        assert.equal(context.readWorkspaceImage, undefined);
      },
    }));
    const service = createProviderRuntimeService({
      async authorizeRun() { calls.push('authorize'); entered.release(); await authorized.promise; calls.push('authorized'); },
      resolveProvider() { calls.push('lookup'); return provider; },
      getSessionSource(sessionId) {
        calls.push('stored');
        assert.equal(sessionId, 'stored-session');
        return { project_path: '/stored/source', workspace_mode: 'shared', provider: 'claude' };
      },
      getWorkspaceAttachmentMode(sourceRoot) {
        calls.push('mode');
        assert.equal(sourceRoot, '/stored/source');
        return attachmentMode;
      },
      async admitWorkspaceExecution() { assert.fail('Claude must retain its single workspaceQuery lifecycle'); },
    });
    const running = service.run('claude', 'fixture', {
      sessionId: 'stored-session', cwd: '/forged/cwd', projectPath: '/forged/project',
      attachmentMode: attachmentMode === 'host' ? 'slot' : 'host',
      readWorkspaceImage() { assert.fail('Transport must not install a project image reader'); },
    }, { userId: 'owner', assertActive() {}, send() {} });
    try {
      await entered.promise;
      assert.deepEqual(calls, ['authorize']);
      authorized.release();
      await running;
      assert.deepEqual(calls, ['authorize', 'authorized', 'lookup', 'stored', 'mode', 'run']);
    } finally { authorized.release(); }
  });
}

/** Holds authorization at an await boundary without depending on elapsed time. */
function authorizationGate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

for (const providerName of ['claude', 'codex', 'cursor', 'opencode'] as const) {
  test(`${providerName} waits for authorization and rejects before provider lookup or admission`, async () => {
    const entered = authorizationGate();
    const decision = authorizationGate();
    const denied = Object.assign(new Error('Attachment ownership changed'), { code: 'ATTACHMENT_NOT_FOUND' });
    const calls = { lookup: 0, admission: 0, launch: 0 };
    const provider = createProvider(providerName, createRuntime({ async run() { calls.launch++; } }));
    const service = createProviderRuntimeService({
      async authorizeRun() { entered.release(); await decision.promise; throw denied; },
      resolveProvider() { calls.lookup++; return provider; },
      async admitWorkspaceExecution() { calls.admission++; assert.fail('Denied authorization must not acquire a workspace'); },
    });
    const running = service.run(providerName, 'fixture', { sessionId: 'authorization-pending' }, { userId: 'owner', send() { assert.fail('Denied authorization must not publish output'); } });
    const rejected = assert.rejects(running, (error: unknown) => error === denied);
    await entered.promise;
    assert.deepEqual(calls, { lookup: 0, admission: 0, launch: 0 });
    decision.release();
    await rejected;
    assert.deepEqual(calls, { lookup: 0, admission: 0, launch: 0 });
  });
}

for (const providerName of ['claude', 'codex', 'cursor', 'opencode'] as const) {
  test(`${providerName} rechecks a revoked session after asynchronous authorization`, async () => {
    const entered = authorizationGate();
    const decision = authorizationGate();
    const revoked = Object.assign(new Error('Authentication session has ended'), { code: 'UNAUTHORIZED' });
    const calls = { lookup: 0, admission: 0, launch: 0 };
    let active = true;
    const provider = createProvider(providerName, createRuntime({ async run() { calls.launch++; } }));
    const service = createProviderRuntimeService({
      async authorizeRun() { entered.release(); await decision.promise; },
      resolveProvider() { calls.lookup++; return provider; },
      async admitWorkspaceExecution() { calls.admission++; assert.fail('Revoked authorization must not acquire a workspace'); },
    });
    const running = service.run(providerName, 'fixture', { sessionId: 'revoked-authorization' }, {
      userId: 'owner',
      assertActive() { if (!active) throw revoked; },
      send() { assert.fail('Revoked authorization must not publish output'); },
    });
    const rejected = assert.rejects(running, (error: unknown) => error === revoked);
    try {
      await entered.promise;
      active = false;
      decision.release();
      await rejected;
      assert.deepEqual(calls, { lookup: 0, admission: 0, launch: 0 });
    } finally { decision.release(); }
  });
}

for (const providerName of ['codex', 'cursor', 'opencode'] as const) {
  test(`${providerName} registers cancellation before authorization starts`, async () => {
    const calls = { authorization: 0, lookup: 0, admission: 0, launch: 0, runtimeAbort: 0 };
    const provider = createProvider(providerName, createRuntime({
      async run() { calls.launch++; },
      abort() { calls.runtimeAbort++; return false; },
    }));
    const service = createProviderRuntimeService({
      async authorizeRun() { calls.authorization++; },
      resolveProvider() { calls.lookup++; return provider; },
      getSessionSource: () => null,
      async admitWorkspaceExecution() { calls.admission++; assert.fail('Immediate cancellation must not acquire a workspace'); },
    });
    const running = service.run(providerName, 'fixture', { sessionId: 'cancel-immediate' }, { userId: 'owner', send() { assert.fail('Cancelled authorization must not publish output'); } });
    const rejected = assert.rejects(running, { name: 'AbortError' });
    assert.equal(await service.abort(providerName, 'cancel-immediate'), true);
    await rejected;
    assert.deepEqual(calls, { authorization: 0, lookup: 0, admission: 0, launch: 0, runtimeAbort: 0 });
  });

  test(`${providerName} cancels pending authorization before lookup or admission`, async () => {
    const entered = authorizationGate();
    const decision = authorizationGate();
    const calls = { lookup: 0, admission: 0, launch: 0, runtimeAbort: 0 };
    const provider = createProvider(providerName, createRuntime({
      async run() { calls.launch++; },
      abort() { calls.runtimeAbort++; return false; },
    }));
    const service = createProviderRuntimeService({
      async authorizeRun() { entered.release(); await decision.promise; },
      resolveProvider() { calls.lookup++; return provider; },
      getSessionSource: () => null,
      async admitWorkspaceExecution() { calls.admission++; assert.fail('Cancelled authorization must not acquire a workspace'); },
    });
    const running = service.run(providerName, 'fixture', { sessionId: 'cancel-pending' }, { userId: 'owner', send() { assert.fail('Cancelled authorization must not publish output'); } });
    const rejected = assert.rejects(running, { name: 'AbortError' });
    await entered.promise;
    assert.deepEqual(calls, { lookup: 0, admission: 0, launch: 0, runtimeAbort: 0 });
    const stopping = service.abort(providerName, 'cancel-pending');
    decision.release();
    assert.equal(await stopping, true);
    await rejected;
    assert.deepEqual(calls, { lookup: 0, admission: 0, launch: 0, runtimeAbort: 0 });
  });
}

