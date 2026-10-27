import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import { createOpenCodeRuntime, resolveOpenCodePermissionOptions } from '@/modules/providers/list/opencode/opencode-runtime.provider.js';
import { OpenCodeSessionsProvider } from '@/modules/providers/list/opencode/opencode-sessions.provider.js';
import type { ProviderProcessJob, ProviderRuntimeContext } from '@/shared/index.js';

const previousDatabasePath = process.env.DATABASE_PATH;
let databaseDirectory: string | undefined;

before(async () => {
  databaseDirectory = await mkdtemp(path.join(os.tmpdir(), 'opencode-runtime-db-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(databaseDirectory, 'app.db');
  // Completion resolves the provider profile through app sessions. Create the
  // empty fixture first so initialization cannot import a legacy database.
  await writeFile(process.env.DATABASE_PATH, '');
  await initializeDatabase();
});

after(async () => {
  closeConnection();
  if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = previousDatabasePath;
  if (databaseDirectory) {
    assert.equal(path.dirname(databaseDirectory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(databaseDirectory).startsWith('opencode-runtime-db-'));
    await rm(databaseDirectory, { recursive: true, force: true });
  }
});

const sessions = new OpenCodeSessionsProvider();
const context: ProviderRuntimeContext = {
  resolveProviderSessionId: () => null,
  resolveResumeModel: async (_sessionId, requestedModel) => requestedModel || undefined,
  getProviderModels: async () => ({ OPTIONS: [], DEFAULT: '' }),
  normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
  isProviderInstalled: async () => true,
};

for (const permissionMode of [undefined, 'default', 'plan', 'bypassPermissions', 'acceptEdits']) {
  test(`OpenCode preserves normalization, attachments, cwd and ${permissionMode ?? 'omitted'} permissions`, async () => {
    let job: ProviderProcessJob | undefined;
    const messages: any[] = [];
    const runtime = createOpenCodeRuntime(async (input, handlers) => {
      job = input;
      handlers.stdout?.('{"type":"text","sessionID":"open-live-1","text":"assistant ');
      handlers.stdout?.('response"}\n{"type":"step_finish","sessionID":"open-live-1"}');
      assert.equal(messages.some((message) => message.kind === 'complete'), false);
      return { code: 0 };
    });
    await runtime.run('', {
      cwd: '/execution', permissionMode, model: 'provider/model',
      files: [{ path: '/assets/brief.pdf', name: 'brief.pdf', mimeType: 'application/pdf' }],
      images: [{ path: '/assets/image.png', name: 'image.png', mimeType: 'image/png' }],
    }, { send: (message) => messages.push(message) }, context);
    assert.equal(job?.kind, 'cli');
    if (job?.kind !== 'cli') throw new Error('missing CLI job');
    assert.equal(job.cwd, '/execution');
    assert.deepEqual(job.args.slice(0, 5), ['run', '--format', 'json', '--dir', '/execution']);
    assert.ok(job.args.at(-1)?.includes('<files_input>'));
    assert.ok(job.args.at(-1)?.includes('<images_input>'));
    const permissions = resolveOpenCodePermissionOptions(permissionMode);
    assert.deepEqual(job.env, permissions.env);
    for (const arg of permissions.args) assert.ok(job.args.includes(arg));
    assert.equal(messages[0]?.kind, 'session_created');
    assert.equal(messages.find((message) => message.kind === 'stream_delta')?.content, 'assistant response');
    assert.equal(messages.filter((message) => message.kind === 'complete').length, 1);
    assert.equal(messages.at(-1)?.sessionId, 'open-live-1');
  });
}

test('OpenCode does not spawn after cancellation while resolving the model', async () => {
  let resolveModel!: (model: string) => void;
  const model = new Promise<string>((resolve) => { resolveModel = resolve; });
  const runtime = createOpenCodeRuntime(async () => assert.fail('cancelled model lookup launched a process'));
  const running = runtime.run('fixture', { sessionId: 'slow-model' }, { send() { assert.fail('cancelled terminal'); } }, { ...context, resolveResumeModel: () => model });
  let settled = false;
  const aborting = runtime.abort('slow-model').then((value) => { settled = true; return value; });
  await Promise.resolve();
  assert.equal(settled, false);
  resolveModel('model');
  await running;
  assert.equal(await aborting, true);
});
