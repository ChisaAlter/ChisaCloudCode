import assert from 'node:assert/strict';
import test from 'node:test';

import { createCursorRuntime } from '@/modules/providers/list/cursor/cursor-runtime.provider.js';
import { createOpenCodeRuntime } from '@/modules/providers/list/opencode/opencode-runtime.provider.js';
import type { AnyRecord, ProviderRuntimeContext } from '@/shared/index.js';

const context: ProviderRuntimeContext = {
  resolveProviderSessionId: () => null,
  resolveResumeModel: async () => undefined,
  getProviderModels: async () => ({ OPTIONS: [], DEFAULT: '' }),
  normalizeMessage: () => [],
  isProviderInstalled: async () => true,
};

for (const [provider, createRuntime] of [['cursor', createCursorRuntime], ['opencode', createOpenCodeRuntime]] as const) {
  test(`${provider} worker stderr strips terminal styling and ignores styling-only chunks`, async () => {
    const sent: AnyRecord[] = [];
    const runtime = createRuntime(async (_job, handlers) => {
      handlers.stderr?.('\u001b[93m\u001b[1m');
      handlers.stderr?.('\u001b[93mwarning from provider\u001b[0m');
      return { code: 0 };
    });
    await runtime.run('fixture', { cwd: process.cwd() }, { send: (message) => sent.push(message as AnyRecord) }, context);
    assert.deepEqual(sent.filter((message) => message.kind === 'error').map((message) => message.content), ['warning from provider']);
    assert.equal(sent.filter((message) => message.kind === 'complete').length, 1);
  });
}

test('Cursor recognizes a styled workspace trust prompt and retries before emitting an error', async () => {
  let attempts = 0;
  const sent: AnyRecord[] = [];
  const runtime = createCursorRuntime(async (job, handlers) => {
    assert.equal(job.kind, 'cli');
    if (job.kind !== 'cli') throw new Error('missing CLI job');
    attempts += 1;
    if (attempts === 1) {
      handlers.stderr?.('\u001b[93mWorkspace trust required\u001b[0m');
      return { code: 1 };
    }
    assert.ok(job.args.includes('--trust'));
    return { code: 0 };
  });
  await runtime.run('fixture', { cwd: process.cwd() }, { send: (message) => sent.push(message as AnyRecord) }, context);
  assert.equal(attempts, 2);
  assert.equal(sent.some((message) => message.kind === 'error'), false);
  assert.equal(sent.filter((message) => message.kind === 'complete').length, 1);
});
