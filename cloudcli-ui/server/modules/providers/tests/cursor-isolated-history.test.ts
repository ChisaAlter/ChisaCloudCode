import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import Database from 'better-sqlite3';

import { CursorSessionsProvider } from '@/modules/providers/list/cursor/cursor-sessions.provider.js';
import { sessionsDb } from '@/modules/database/index.js';

async function fixture(run: (root: string, create: (cwd: string, nativeId: string, text: string) => Promise<void>) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chisa-cursor-history-'));
  const home = mock.method(os, 'homedir', () => root);
  const byId = mock.method(sessionsDb, 'getSessionById', () => null);
  const byNative = mock.method(sessionsDb, 'getSessionByProviderSessionId', () => null);
  const create = async (cwd: string, nativeId: string, text: string) => {
    const hash = crypto.createHash('md5').update(cwd).digest('hex');
    const directory = path.join(root, '.cursor', 'chats', hash, nativeId);
    await mkdir(directory, { recursive: true });
    const database = new Database(path.join(directory, 'store.db'));
    try {
      database.exec('CREATE TABLE blobs(id TEXT, data BLOB)');
      database.prepare('INSERT INTO blobs(id, data) VALUES(?, ?)').run('abc', Buffer.from(JSON.stringify({ role: 'assistant', content: text })));
    } finally { database.close(); }
  };
  try { await run(root, create); }
  finally { byId.mock.restore(); byNative.mock.restore(); home.mock.restore(); await rm(root, { recursive: true, force: true }); }
}

test('Cursor loads a unique isolated native session without changing app source identity', async () => {
  await fixture(async (_root, create) => {
    await create('/isolated/private-app', 'native-session', 'isolated history');
    const result = await new CursorSessionsProvider().fetchHistory('app-session', { projectPath: '/source', providerSessionId: 'native-session' });
    assert.equal(result.total, 1);
    assert.equal(result.messages[0].content, 'isolated history');
    assert.equal(result.messages[0].sessionId, 'app-session');
  });
});

test('Cursor refuses an ambiguous native session from multiple cwd stores', async () => {
  await fixture(async (_root, create) => {
    await create('/isolated/one', 'native-session', 'one');
    await create('/isolated/two', 'native-session', 'two');
    const warning = mock.method(console, 'warn', () => {});
    try {
      const result = await new CursorSessionsProvider().fetchHistory('app-session', { projectPath: '/source', providerSessionId: 'native-session' });
      assert.equal(result.total, 0);
      assert.match(String(warning.mock.calls[0]?.arguments[1]), /ambiguous/);
    } finally { warning.mock.restore(); }
  });
});

test('Cursor keeps the exact source cwd store when it exists', async () => {
  await fixture(async (_root, create) => {
    await create('/source', 'native-session', 'source');
    await create('/isolated/two', 'native-session', 'other');
    const result = await new CursorSessionsProvider().fetchHistory('app-session', { projectPath: '/source', providerSessionId: 'native-session' });
    assert.equal(result.messages[0].content, 'source');
  });
});
