import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import type { IProvider } from '@/shared/interfaces.js';
import type { LLMProvider, ProviderProcessRunner, ProviderRuntimeContext } from '@/shared/types.js';

mock.module('@/modules/providers/services/provider-state.service.js', { namedExports: { resolveProviderHome: () => '/fixed-fixture/no-provider-store', managedProviderHome: () => '/fixed-fixture/no-provider-store', registerManagedProviderProfile: () => '/fixed-fixture/no-provider-store', profileForArtifact: () => null, registeredProviderProfiles: () => [], onManagedProviderProfile: () => () => {} } });
mock.module('@/modules/providers/services/sessions.service.js', { namedExports: { sessionsService: { resolveProviderSessionId: () => null } } });
mock.module('@/modules/providers/services/provider-models.service.js', { namedExports: { providerModelsService: { resolveResumeModel: async () => 'fixture-model', getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'fixture-model' }) } } });
mock.module('@/modules/providers/provider.registry.js', { namedExports: { providerRegistry: { listProviders: () => [], resolveProvider: () => { throw new Error('The fixture injects its own provider'); } } } });
const { codexRuntime } = await import('@/modules/providers/list/codex/codex-runtime.provider.js');
const { cursorRuntime } = await import('@/modules/providers/list/cursor/cursor-runtime.provider.js');
const { opencodeRuntime } = await import('@/modules/providers/list/opencode/opencode-runtime.provider.js');
const { createProviderRuntimeService } = await import('@/modules/providers/services/provider-runtime.service.js');
const runtimes = { codex: codexRuntime, cursor: cursorRuntime, opencode: opencodeRuntime };
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture(provider: keyof typeof runtimes, runner: ProviderProcessRunner, close: () => Promise<void>) {
  const runtime = runtimes[provider];
  const adapter = { id: provider, runtime, sessions: { normalizeMessage: () => [] }, auth: { getStatus: async () => ({ installed: true }) } } as unknown as IProvider;
  let profile = '';
  const service = createProviderRuntimeService({
    listProviders: () => [adapter], resolveProvider: () => adapter,
    resolveProviderSessionId: () => 'native-' + provider,
    resolveResumeModel: async () => 'fixture-model',
    getProviderModels: async () => ({ DEFAULT: 'fixture-model', OPTIONS: [] }),
    getSessionSource: () => ({ project_path: '/source', workspace_mode: 'isolated', provider }),
    authorizeRun() {},
    registerManagedProviderProfile: (_provider, app) => { profile = app; return '/private/' + app; },
    createContainerProviderRunner: () => runner,
    admitWorkspaceExecution: async () => ({ sourceCwd: '/source', cwd: '/isolated', sourceRoot: '/source', executionRoot: '/isolated', bound: true, bindingKind: 'vps', isolated: true, readOnly: false, assertCurrent() {}, execute: async () => ({}), spawnProcess: async () => assert.fail('The injected trusted runner owns this fixture process'), revoke() {}, close }) as any,
  });
  return { service, profile: () => profile };
}
for (const provider of ['codex', 'cursor', 'opencode'] as const) {
  test(`${provider} public adapter routes an admitted VPS run through its owned process and exact handback`, async () => {
    const entered = gate(); const stopped = gate(); const closing = gate(); const handedBack = gate();
    const frames: any[] = [];
    const { service, profile } = fixture(provider, async (job, handlers) => {
      assert.equal(job.kind, provider === 'codex' ? 'codex' : 'cli');
      if (job.kind === 'codex') assert.equal(job.threadOptions.workingDirectory, '/isolated');
      else assert.equal(job.cwd, '/isolated');
      entered.resolve();
      await stopped.promise;
      return { code: 0 };
    }, async () => { closing.resolve(); await handedBack.promise; });
    const running = service.run(provider as LLMProvider, 'fixed fixture', { sessionId: 'route-' + provider, cwd: '/untrusted-request', runId: 'kept-run' }, { isWebSocketWriter: true, send: (frame: any) => frames.push(frame) });
    await entered.promise;
    assert.equal(profile(), 'route-' + provider);
    await assert.rejects(service.run(provider, 'duplicate', { sessionId: 'route-' + provider }, { send() {} }), { code: 'RUN_IN_PROGRESS' });
    assert.equal(frames.some((frame) => frame.kind === 'complete'), false);
    stopped.resolve(); await closing.promise;
    assert.equal(frames.some((frame) => frame.kind === 'complete'), false);
    handedBack.resolve(); await running;
    assert.equal(frames.filter((frame) => frame.kind === 'complete').length, 1);
    assert.equal(frames.filter((frame) => frame.text === 'model_stopped').length, 0);
    assert.equal(await service.abort(provider, 'route-' + provider), false);
  });

  test(`${provider} workspace cancellation waits for confirmed process stop and handback without publishing completion`, async () => {
    const entered = gate(); const aborted = gate(); const stopped = gate(); const closing = gate(); const handedBack = gate();
    const frames: any[] = [];
    const { service } = fixture(provider, async (_job, _handlers, signal) => {
      signal!.addEventListener('abort', () => aborted.resolve(), { once: true });
      entered.resolve(); await aborted.promise; await stopped.promise;
      throw Object.assign(new Error('fixed fixture cancelled'), { name: 'AbortError' });
    }, async () => { closing.resolve(); await handedBack.promise; });
    const running = service.run(provider, 'fixed fixture', { sessionId: 'cancel-route-' + provider }, { isWebSocketWriter: true, send: (frame: any) => frames.push(frame) });
    void running.catch(() => {});
    await entered.promise;
    let returned = false;
    const cancelled = service.abort(provider, 'cancel-route-' + provider).then((value) => { returned = true; return value; });
    await aborted.promise;
    assert.equal(frames.some((frame) => frame.text === 'model_stopped'), false);
    stopped.resolve(); await closing.promise;
    assert.equal(frames.filter((frame) => frame.text === 'model_stopped').length, 0, 'the chat dispatcher owns cancellation status');
    assert.equal(returned, false);
    handedBack.resolve(); assert.equal(await cancelled, true);
    await running.catch(() => {});
    assert.equal(frames.filter((frame) => frame.kind === 'complete').length, 0);
    assert.equal(await service.abort(provider, 'cancel-route-' + provider), false);
  });
}
