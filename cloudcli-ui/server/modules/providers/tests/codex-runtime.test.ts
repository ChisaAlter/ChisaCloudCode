import assert from 'node:assert/strict';
import test from 'node:test';

import { createCodexRuntime } from '@/modules/providers/list/codex/codex-runtime.provider.js';
import type { ProviderProcessJob, ProviderRuntimeContext } from '@/shared/index.js';

for (const resumed of [false, true]) {
  for (const permissionMode of [undefined, 'default', 'unknown', 'acceptEdits', 'bypassPermissions', 'plan']) {
    test(`Codex ${resumed ? 'resumes' : 'starts'} with supported permissions (${permissionMode ?? 'omitted'})`, async () => {
      let job: ProviderProcessJob | undefined;
      const messages: any[] = [];
      const runtime = createCodexRuntime(async (input, handlers) => {
        job = input;
        handlers.event?.({ type: 'thread.started', thread_id: 'native-thread' });
        handlers.event?.({ type: 'turn.completed', usage: { input_tokens: 4, output_tokens: 2 } });
        assert.equal(messages.some((message) => message.kind === 'complete'), false, 'stream completion must not finish a live process');
        return { code: 0 };
      });
      const context: ProviderRuntimeContext = {
        resolveProviderSessionId: () => resumed ? 'native-thread' : null,
        resolveResumeModel: async () => 'test-model',
        getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'test-model' }),
        normalizeMessage: (event: any) => event.type === 'turn_complete' ? [{ kind: 'complete' } as any] : [],
        isProviderInstalled: async () => true,
      };
      await runtime.run('hey there', { sessionId: `app-${resumed}-${permissionMode}`, permissionMode, cwd: process.cwd() }, { isWebSocketWriter: true, send: (message) => messages.push(message) }, context);
      assert.equal(job?.kind, 'codex');
      if (job?.kind !== 'codex') throw new Error('missing Codex job');
      assert.equal(job.providerSessionId, resumed ? 'native-thread' : null);
      assert.equal(job.input, 'hey there');
      assert.equal(job.threadOptions.sandboxMode, permissionMode === 'plan' ? 'read-only' : permissionMode === 'bypassPermissions' ? 'danger-full-access' : 'workspace-write');
      assert.equal(job.threadOptions.approvalPolicy, ['acceptEdits', 'bypassPermissions', 'plan'].includes(permissionMode || '') ? 'never' : 'on-request');
      assert.equal(messages.filter((message) => message.kind === 'complete').length, 1);
      assert.equal(messages.find((message) => message.kind === 'complete')?.exitCode, 0);
    });
  }
}

test('Codex abort waits for process teardown and propagates an unconfirmed teardown', async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let finish!: () => void;
  const teardown = new Promise<void>((resolve) => { finish = resolve; });
  const runtime = createCodexRuntime(async (_job, _handlers, signal) => {
    entered();
    await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));
    await teardown;
    throw Object.assign(new Error('tool still alive'), { processTeardownError: true });
  });
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => 'model',
    getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'model' }),
    normalizeMessage: () => [], isProviderInstalled: async () => true,
  };
  const messages: unknown[] = [];
  const running = runtime.run('fixture', { sessionId: 'abort-test' }, { isWebSocketWriter: true, send: (message) => messages.push(message) }, context);
  void running.catch(() => {});
  await started;
  let aborted = false;
  const aborting = runtime.abort('abort-test').finally(() => { aborted = true; });
  void aborting.catch(() => {});
  await Promise.resolve();
  assert.equal(aborted, false);
  finish();
  await assert.rejects(running, /tool still alive/);
  await assert.rejects(aborting, /tool still alive/);
  assert.deepEqual(messages, []);
});
