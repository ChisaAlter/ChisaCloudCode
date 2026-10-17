import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import test, { mock } from 'node:test';

import { Codex, type Thread, type ThreadEvent } from '@openai/codex-sdk';

import { createCompleteMessage } from '@/shared/index.js';
import type { NormalizedMessage, ProviderRuntimeContext } from '@/shared/index.js';

mock.module('@/modules/notifications/index.js', {
  namedExports: { notifyRunStopped() {}, notifyRunFailed() {} },
});
const { codexRuntime } = await import('@/modules/providers/list/codex/codex-runtime.provider.js');

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function context(overrides: Partial<ProviderRuntimeContext> = {}): ProviderRuntimeContext {
  return {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => 'fixture-model',
    getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'fixture-model' }),
    normalizeMessage: () => [],
    isProviderInstalled: async () => true,
    ...overrides,
  };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('Codex preparation cancellation owns this run until discovery settles and never launches SDK execution', { timeout: 5000 }, async (t) => {
  const entered = gate();
  const ready = gate();
  const frames: NormalizedMessage[] = [];
  const start = t.mock.method(Codex.prototype, 'startThread', () => { throw new Error('Cancelled run must not start'); });
  const controller = new AbortController();
  const run = codexRuntime.run('fixture', { sessionId: 'codex-preparation', abortSignal: controller.signal }, { isWebSocketWriter: true, send: (frame: NormalizedMessage) => frames.push(frame) }, context({
    resolveResumeModel: async () => { entered.resolve(); await ready.promise; return 'fixture-model'; },
  }));
  await entered.promise;
  controller.abort();
  let confirmed = false;
  const stop = codexRuntime.abort('codex-preparation').then((value) => { confirmed = value; });
  await tick();
  assert.equal(confirmed, false);
  assert.equal(frames.length, 0);
  ready.resolve();
  await Promise.all([run, stop]);
  assert.equal(confirmed, true);
  assert.equal(start.mock.callCount(), 0);
  assert.deepEqual(frames.map((frame) => [frame.kind, frame.text, frame.canInterrupt]), [['status', 'model_stopped', false]]);
  assert.equal(await codexRuntime.abort('codex-preparation'), false);
});

test('Codex completed handles cannot cancel a later preparation run', { timeout: 5000 }, async (t) => {
  const frames: NormalizedMessage[] = [];
  const thread = { id: 'native-old', async runStreamed() { return { events: (async function* () {})() }; } } as unknown as Thread;
  const start = t.mock.method(Codex.prototype, 'startThread', () => thread);
  const writer = { isWebSocketWriter: true, send: (frame: NormalizedMessage) => frames.push(frame) };
  await codexRuntime.run('old', { sessionId: 'codex-reuse' }, writer, context());
  assert.equal(await codexRuntime.abort('codex-reuse'), false);
  const entered = gate();
  const ready = gate();
  const run = codexRuntime.run('new', { sessionId: 'codex-reuse' }, writer, context({
    resolveResumeModel: async () => { entered.resolve(); await ready.promise; return 'fixture-model'; },
  }));
  await entered.promise;
  let stopped = false;
  const stop = codexRuntime.abort('codex-reuse').then((success) => { stopped = success; });
  await tick();
  assert.equal(stopped, false);
  assert.equal(start.mock.callCount(), 1);
  ready.resolve();
  await Promise.all([run, stop]);
  assert.equal(stopped, true);
  assert.equal(start.mock.callCount(), 1);
  assert.equal(frames.filter((frame) => frame.kind === 'complete').length, 1);
});

test('Codex SDK turn.completed is not terminal before the iterator has exited', { timeout: 5000 }, async (t) => {
  const result = gate();
  const exited = gate();
  const frames: NormalizedMessage[] = [];
  const thread = {
    id: 'native-pending',
    async runStreamed() {
      return { events: (async function* () {
        yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 2, cached_input_tokens: 0, cache_write_input_tokens: 0, reasoning_output_tokens: 0 } } as ThreadEvent;
        await exited.promise;
      })() };
    },
  } as unknown as Thread;
  t.mock.method(Codex.prototype, 'startThread', () => thread);
  const run = codexRuntime.run('fixture', { sessionId: 'codex-protocol-complete' }, { isWebSocketWriter: true, send: (frame: NormalizedMessage) => frames.push(frame) }, context({
    normalizeMessage: (raw) => {
      assert.equal((raw as { type: string }).type, 'turn_complete');
      result.resolve();
      return [createCompleteMessage({ provider: 'codex', sessionId: 'codex-protocol-complete', exitCode: 0 })];
    },
  }));
  await result.promise;
  await tick();
  assert.equal(frames.some((frame) => frame.kind === 'complete'), false);
  exited.resolve();
  await run;
  assert.equal(frames.filter((frame) => frame.kind === 'complete').length, 1);
  assert.equal(frames.find((frame) => frame.kind === 'complete')?.exitCode, 0);
});

test('Codex cancellation survives iterator.return AbortError and waits for its actual child; explicit stop can retry', { timeout: 10000 }, async (t) => {
  const spawned = gate();
  const cancelled = gate();
  const returned = gate();
  const frames: NormalizedMessage[] = [];
  let child: ChildProcess | undefined;
  const thread = {
    id: 'native-real-child',
    async runStreamed(_prompt: unknown, options: { signal: AbortSignal }) {
      let started = false;
      options.signal.addEventListener('abort', cancelled.resolve, { once: true });
      const events = {
        async next() {
          if (!started) {
            started = true;
            child = spawn(process.execPath, ['-e', "process.stdout.write('ready\\n'); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
            await once(child.stdout!, 'data');
            spawned.resolve();
            return { done: false, value: { type: 'thread.started', thread_id: 'native-real-child' } };
          }
          await cancelled.promise;
          throw Object.assign(new Error('stream cancelled'), { name: 'AbortError' });
        },
        async return() {
          // The installed SDK clears its listeners in transport cleanup.
          child!.removeAllListeners();
          returned.resolve();
          throw Object.assign(new Error('iterator return cancelled'), { name: 'AbortError' });
        },
      };
      return { events };
    },
  } as unknown as Thread;
  t.mock.method(Codex.prototype, 'startThread', () => thread);
  t.after(() => { if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const run = codexRuntime.run('fixture', { sessionId: 'codex-real-child' }, { isWebSocketWriter: true, send: (frame: NormalizedMessage) => frames.push(frame) }, context());
  await spawned.promise;
  let confirmed = false;
  const stop = codexRuntime.abort('codex-real-child').then((success) => { confirmed = success; });
  await returned.promise;
  await tick();
  assert.equal(confirmed, false);
  assert.equal(child!.exitCode, null);
  assert.equal(child!.signalCode, null);
  assert.equal(frames.some((frame) => frame.text === 'model_stopped' || frame.kind === 'complete'), false);
  const retry = codexRuntime.abort('codex-real-child');
  await Promise.all([run, stop]);
  assert.equal(await retry, true);
  assert.equal(confirmed, true);
  assert.equal(child!.exitCode !== null || child!.signalCode !== null, true);
  assert.equal(frames.filter((frame) => frame.text === 'model_stopped').length, 1);
  assert.equal(frames.some((frame) => frame.kind === 'complete'), false);
  assert.equal(await codexRuntime.abort('codex-real-child'), false);
});

test('Codex non-cancel iterator cleanup error becomes one failed terminal result and releases its handle', { timeout: 5000 }, async (t) => {
  const frames: NormalizedMessage[] = [];
  const thread = {
    id: 'native-cleanup-error',
    async runStreamed() {
      return { events: {
        async next() { return { done: true }; },
        async return() { throw new Error('fixture iterator cleanup failed'); },
      } };
    },
  } as unknown as Thread;
  t.mock.method(Codex.prototype, 'startThread', () => thread);
  await codexRuntime.run('fixture', { sessionId: 'codex-cleanup-error' }, { isWebSocketWriter: true, send: (frame: NormalizedMessage) => frames.push(frame) }, context());
  assert.equal(frames.filter((frame) => frame.kind === 'complete').length, 1);
  assert.equal(frames.find((frame) => frame.kind === 'complete')?.exitCode, 1);
  assert.match(String(frames.find((frame) => frame.kind === 'error')?.content), /fixture iterator cleanup failed/);
  assert.equal(await codexRuntime.abort('codex-cleanup-error'), false);
});
