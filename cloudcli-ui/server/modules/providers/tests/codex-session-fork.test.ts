import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import { codexAppServer } from '@/modules/providers/list/codex/codex-app-server.client.js';
import { CodexForkProvider } from '@/modules/providers/list/codex/codex-fork.provider.js';

const previousDatabasePath = process.env.DATABASE_PATH;
let databaseDirectory: string | undefined;

before(async () => {
  databaseDirectory = await mkdtemp(path.join(os.tmpdir(), 'codex-fork-db-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(databaseDirectory, 'app.db');
  // Profile lookup now reads app sessions; an existing empty file prevents
  // initialization from importing a developer's legacy database.
  await writeFile(process.env.DATABASE_PATH, '');
  await initializeDatabase();
});

after(async () => {
  closeConnection();
  if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = previousDatabasePath;
  if (databaseDirectory) {
    assert.equal(path.dirname(databaseDirectory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(databaseDirectory).startsWith('codex-fork-db-'));
    await rm(databaseDirectory, { recursive: true, force: true });
  }
});

/**
 * The fork endpoint itself is exercised against the real `codex app-server` in
 * codex-message-editing.test.ts, which is where the rewind that depends on it
 * lives. What is left for the fork provider is the mapping either side of it.
 */

test('a Codex fork asks for the whole thread when no anchor is given', { concurrency: false }, async () => {
  const realForkThread = codexAppServer.forkThread;
  const forkCalls: unknown[] = [];
  codexAppServer.forkThread = async (input) => {
    forkCalls.push(input);
    return { threadId: 'thread-2', path: '/tmp/rollout-thread-2.jsonl' };
  };

  try {
    const forked = await new CodexForkProvider().forkSession({
      providerSessionId: 'thread-1',
      jsonlPath: '/tmp/rollout-thread-1.jsonl',
      projectPath: '/tmp/workspace',
      title: 'ignored by codex',
    });
    assert.deepEqual(forked, { providerSessionId: 'thread-2', jsonlPath: '/tmp/rollout-thread-2.jsonl' });
  } finally {
    codexAppServer.forkThread = realForkThread;
  }

  assert.deepEqual(forkCalls, [{ threadId: 'thread-1', lastTurnId: undefined, cwd: '/tmp/workspace' }]);
});

test('forking from a message cuts through that message\'s turn', async () => {
  const realForkThread = codexAppServer.forkThread;
  const forkCalls: unknown[] = [];
  codexAppServer.forkThread = async (input) => {
    forkCalls.push(input);
    return { threadId: 'thread-2', path: '/tmp/rollout-thread-2.jsonl' };
  };

  try {
    await new CodexForkProvider().forkSession({
      providerSessionId: 'thread-1',
      jsonlPath: '/tmp/rollout-thread-1.jsonl',
      projectPath: '/tmp/workspace',
      upToAnchorId: 'turn-b',
    });
  } finally {
    codexAppServer.forkThread = realForkThread;
  }

  // Inclusive of the turn it names, so the branch keeps the message that was
  // forked from *and* the answer it got. A turn is written as one thing; there
  // is no cut that stops between them.
  assert.deepEqual(forkCalls, [{ threadId: 'thread-1', lastTurnId: 'turn-b', cwd: '/tmp/workspace' }]);
});
