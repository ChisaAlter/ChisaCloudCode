import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
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

for (const command of ['', '  \n\t']) {
  test(`Codex supplies a prompt for an image-only turn (${JSON.stringify(command)})`, async () => {
    let job: ProviderProcessJob | undefined;
    const imagePath = path.join(process.cwd(), 'admitted-project', 'shot.png');
    const bytes = Buffer.from('verified image bytes');
    let stagedPath = '';
    const runtime = createCodexRuntime(async (input) => {
      job = input;
      if (input.kind !== 'codex' || !Array.isArray(input.input)) throw new Error('missing image input');
      const image = input.input.find((item) => item.type === 'local_image');
      if (image?.type !== 'local_image') throw new Error('missing prepared image');
      stagedPath = image.path;
      assert.notEqual(stagedPath, imagePath);
      assert.deepEqual(await fs.readFile(stagedPath), bytes, 'snapshot remains until the process runner confirms teardown');
      return { code: 0 };
    });
    const context: ProviderRuntimeContext = {
      resolveProviderSessionId: () => null,
      resolveResumeModel: async () => 'test-model',
      getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'test-model' }),
      normalizeMessage: () => [],
      isProviderInstalled: async () => true,
      attachmentMode: 'host',
      readWorkspaceImage: async (selector) => {
        assert.equal(selector, imagePath);
        return { path: selector, mimeType: 'image/png', size: bytes.length, bytes };
      },
    };
    await runtime.run(command, { cwd: process.cwd(), images: [{ path: imagePath, mimeType: 'image/png' }] }, { isWebSocketWriter: true, send() {} }, context);
    assert.equal(job?.kind, 'codex');
    if (job?.kind !== 'codex') throw new Error('missing Codex job');
    assert.deepEqual(job.input, [
      { type: 'text', text: 'Please analyze the attached image(s).' },
      { type: 'local_image', path: stagedPath },
    ]);
    await assert.rejects(fs.stat(stagedPath), { code: 'ENOENT' });
  });
}

for (const confirmed of [true, false]) {
  test(`Codex ${confirmed ? 'disposes snapshots after confirmed teardown' : 'retains snapshots after uncertain teardown'}`, { timeout: 10_000 }, async () => {
    const sessionId = `snapshot-teardown-${randomUUID()}`;
    const imagePath = path.join(process.cwd(), 'admitted-project', 'shot.png');
    const bytes = Buffer.from('verified image snapshot retained until teardown');
    const teardownError = Object.assign(new Error('tool tree is still alive'), { processTeardownError: true });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let finish!: () => void;
    const teardown = new Promise<void>((resolve) => { finish = resolve; });
    let stagedPath = '';
    const runtime = createCodexRuntime(async (job, _handlers, signal) => {
      if (job.kind !== 'codex' || !Array.isArray(job.input)) throw new Error('missing image job');
      const image = job.input.find((item) => item.type === 'local_image');
      if (image?.type !== 'local_image') throw new Error('missing staged image');
      stagedPath = image.path;
      const aborted = new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));
      entered();
      await aborted;
      await teardown;
      assert.deepEqual(await fs.readFile(stagedPath), bytes, 'abort cannot remove a snapshot while a tool may still be using it');
      if (!confirmed) throw teardownError;
      return { code: 0 };
    });
    const context: ProviderRuntimeContext = {
      resolveProviderSessionId: () => null,
      resolveResumeModel: async () => 'test-model',
      getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'test-model' }),
      normalizeMessage: () => [],
      isProviderInstalled: async () => true,
      attachmentMode: 'host',
      readWorkspaceImage: async (selector) => ({ path: selector, mimeType: 'image/png', size: bytes.length, bytes }),
    };
    const messages: unknown[] = [];
    const running = runtime.run('inspect', { sessionId, cwd: process.cwd(), images: [{ path: imagePath }] }, { isWebSocketWriter: true, send: (message) => messages.push(message) }, context);
    void running.catch(() => {});
    let aborting: Promise<unknown> | undefined;
    try {
      await Promise.race([started, running.then(() => { throw new Error('Run ended before the image job started'); })]);
      assert.notEqual(stagedPath, imagePath);
      let settled = false;
      aborting = runtime.abort(sessionId).finally(() => { settled = true; });
      void aborting.catch(() => {});
      assert.deepEqual(await fs.readFile(stagedPath), bytes);
      assert.equal(settled, false, 'abort must wait for the process-tree teardown result');
      finish();
      if (confirmed) {
        await running;
        await aborting;
        await assert.rejects(fs.stat(stagedPath), { code: 'ENOENT' });
      } else {
        await assert.rejects(running, (error) => error === teardownError);
        await assert.rejects(aborting, (error) => error === teardownError);
        assert.deepEqual(await fs.readFile(stagedPath), bytes, 'unconfirmed teardown must retain the private file after both promises reject');
      }
      assert.deepEqual(messages, [], 'aborted or uncertain teardown cannot announce successful completion');
    } finally {
      finish();
      if (!aborting) aborting = runtime.abort(sessionId);
      await Promise.allSettled([running, aborting]);
      if (stagedPath) {
        const directory = path.dirname(stagedPath);
        assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
        assert.match(path.basename(directory), /^chisa-provider-attachments-/);
        // This injected runner launched no OS process; remove only its proven private fixture directory.
        await fs.rm(directory, { recursive: true, force: true, maxRetries: 2 });
      }
    }
  });
}
