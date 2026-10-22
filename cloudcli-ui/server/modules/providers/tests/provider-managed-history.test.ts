import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import Database from 'better-sqlite3';

import { initializeDatabase, sessionsDb, closeConnection } from '@/modules/database/index.js';
import { CodexSessionSynchronizer } from '@/modules/providers/list/codex/codex-session-synchronizer.provider.js';
import { CursorSessionSynchronizer } from '@/modules/providers/list/cursor/cursor-session-synchronizer.provider.js';
import { CodexForkProvider } from '@/modules/providers/list/codex/codex-fork.provider.js';
import { CodexSessionsProvider } from '@/modules/providers/list/codex/codex-sessions.provider.js';
import { codexAppServer } from '@/modules/providers/list/codex/codex-app-server.client.js';
import { prepareProviderProfile } from '@/modules/providers/services/provider-profile.service.js';
import { CursorSessionsProvider } from '@/modules/providers/list/cursor/cursor-sessions.provider.js';
import { OpenCodeSessionsProvider } from '@/modules/providers/list/opencode/opencode-sessions.provider.js';
import { registerManagedProviderProfile, resolveProviderHome } from '@/modules/providers/services/provider-state.service.js';

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chisa-managed-history-'));
  const home = mock.method(os, 'homedir', () => root);
  const previous = process.env.DATABASE_PATH;
  closeConnection(); process.env.DATABASE_PATH = path.join(root, 'auth.db'); await writeFile(process.env.DATABASE_PATH, ''); await initializeDatabase();
  try { await run(root); }
  finally { closeConnection(); if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous; home.mock.restore(); await rm(root, { recursive: true, force: true }); }
}

test('Cursor reads a durable private profile while retaining source project and app session identity', async () => {
  await fixture(async () => {
    sessionsDb.createAppSession('app', 'cursor', '/source'); sessionsDb.assignProviderSessionId('app', 'native');
    const profile = registerManagedProviderProfile('cursor', 'app');
    const hash = crypto.createHash('md5').update('/isolated').digest('hex');
    const folder = path.join(profile, '.cursor', 'chats', hash, 'native'); await mkdir(folder, { recursive: true });
    const db = new Database(path.toNamespacedPath(path.join(folder, 'store.db')));
    db.exec('CREATE TABLE blobs(id TEXT,data BLOB)'); db.prepare('INSERT INTO blobs VALUES(?,?)').run('id', Buffer.from(JSON.stringify({ role: 'assistant', content: 'managed history' }))); db.close();
    const result = await new CursorSessionsProvider().fetchHistory('app', { projectPath: '/source', providerSessionId: 'native', providerProfilePath: profile });
    assert.equal(result.messages[0]?.content, 'managed history'); assert.equal(result.messages[0]?.sessionId, 'app');
    assert.equal(sessionsDb.getSessionById('app')?.project_path, path.normalize('/source'));
  });
});

test('OpenCode reads its registered private database without a deletable shared transcript path', async () => {
  await fixture(async () => {
    sessionsDb.createAppSession('app', 'opencode', '/source'); sessionsDb.assignProviderSessionId('app', 'native');
    const profile = registerManagedProviderProfile('opencode', 'app');
    const folder = path.join(profile, '.local', 'share', 'opencode'); await mkdir(folder, { recursive: true });
    const db = new Database(path.toNamespacedPath(path.join(folder, 'opencode.db')));
    db.exec('CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,data TEXT);CREATE TABLE part(id TEXT,message_id TEXT,session_id TEXT,time_created INTEGER,data TEXT);CREATE TABLE session(id TEXT,tokens_input INTEGER,tokens_output INTEGER,tokens_reasoning INTEGER,tokens_cache_read INTEGER,tokens_cache_write INTEGER);');
    db.prepare('INSERT INTO message VALUES(?,?,?,?)').run('m','native',1,JSON.stringify({role:'assistant'}));
    db.prepare('INSERT INTO part VALUES(?,?,?,?,?)').run('p','m','native',1,JSON.stringify({type:'text',text:'managed sqlite history'})); db.close();
    const result = await new OpenCodeSessionsProvider().fetchHistory('app', { providerSessionId: 'native', providerProfilePath: profile });
    assert.ok(result.messages.some((message) => message.content === 'managed sqlite history'));
    assert.equal(sessionsDb.getSessionById('app')?.jsonl_path, null);
  });
});

test('Codex fork and rewind select the registered profile and lazily import a fork into its own app profile', async () => {
  await fixture(async () => {
    sessionsDb.createAppSession('parent', 'codex', '/source'); sessionsDb.assignProviderSessionId('parent', 'native-parent');
    const parentHome = registerManagedProviderProfile('codex', 'parent');
    const folder = path.join(parentHome, '.codex', 'sessions', '2026', '10', '21'); await mkdir(folder, { recursive: true });
    const original = path.join(folder, 'rollout-native-parent.jsonl'); await writeFile(original, '{"type":"session_meta","payload":{"id":"native-parent","cwd":"/source"}}\n');
    sessionsDb.createSession('native-parent','codex','/source',undefined,undefined,undefined,original);
    const forkPath = path.join(folder, 'rollout-native-fork.jsonl'); await writeFile(forkPath, '{"type":"session_meta","payload":{"id":"native-fork","cwd":"/source"}}\n');
    const calls: Array<{ profileHome?: string }> = [];
    const fork = mock.method(codexAppServer, 'forkThread', async (input: Parameters<typeof codexAppServer.forkThread>[0]) => { calls.push(input); return { threadId: 'native-fork', path: forkPath }; });
    try {
      await new CodexForkProvider().forkSession({ providerSessionId: 'native-parent', jsonlPath: original, projectPath: '/source' });
      assert.equal(calls[0].profileHome, parentHome);
      await new CodexSessionsProvider().rewindSession('parent', 'turn-kept');
      assert.equal(calls[1].profileHome, parentHome);
      sessionsDb.createForkedSession({ sessionId: 'child', provider: 'codex', projectPath: '/source', customName: null, providerSessionId: 'native-child', jsonlPath: forkPath, forkedFromSessionId: 'parent', model: null, effort: null });
      const childHome = registerManagedProviderProfile('codex', 'child');
      const profile = await prepareProviderProfile('codex', 'child', { kind: 'codex', providerSessionId: 'native-child', threadOptions: {}, input: '' });
      const imported = path.join(childHome, '.codex', 'sessions', '2026', '10', '21', path.basename(forkPath));
      assert.notEqual(imported, forkPath);
      const { readFile } = await import('node:fs/promises');
      assert.equal(await readFile(imported, 'utf8'), await readFile(forkPath, 'utf8'));
      await profile.finish('publish');
      assert.equal(sessionsDb.getSessionById('child')?.provider_profile_path, childHome);
    } finally { fork.mock.restore(); }
  });
});

test('managed scanners retain each fork app profile when its transcript is still in the parent profile', async () => {
  await fixture(async () => {
    for (const provider of ['codex', 'cursor'] as const) {
      const parentId = provider + '-parent'; const childId = provider + '-child'; const nativeId = provider + '-native-child';
      sessionsDb.createAppSession(parentId, provider, '/source');
      const parentHome = registerManagedProviderProfile(provider, parentId);
      const hash = crypto.createHash('md5').update('/source').digest('hex');
      const transcript = provider === 'codex'
        ? path.join(parentHome, '.codex', 'sessions', '2026', '10', '21', 'rollout-' + nativeId + '.jsonl')
        : path.join(parentHome, '.cursor', 'projects', hash, 'agent-transcripts', nativeId + '.jsonl');
      await mkdir(path.dirname(transcript), { recursive: true });
      await writeFile(transcript, JSON.stringify(provider === 'codex' ? { type: 'session_meta', payload: { id: nativeId, cwd: '/source' } } : { role: 'user', message: { content: [{ text: 'fork prompt' }] } }) + '\n');
      if (provider === 'cursor') {
        await writeFile(path.join(parentHome, '.cursor', 'projects', 'worker.log'), 'workspacePath=/source\n');
        const chats = path.join(parentHome, '.cursor', 'chats', hash, nativeId); await mkdir(chats, { recursive: true });
        const db = new Database(path.toNamespacedPath(path.join(chats, 'store.db'))); db.exec('CREATE TABLE blobs(id TEXT,data BLOB)'); db.close();
      }
      sessionsDb.createForkedSession({ sessionId: childId, provider, projectPath: '/source', customName: null, providerSessionId: nativeId, jsonlPath: transcript, forkedFromSessionId: parentId, model: null, effort: null });
      const scanner = provider === 'codex' ? new CodexSessionSynchronizer() : new CursorSessionSynchronizer();
      await scanner.synchronize();
      assert.equal(sessionsDb.getSessionById(childId)?.provider_profile_path, null, 'A parent artifact cannot register its HOME for the child app session');
      const childHome = registerManagedProviderProfile(provider, childId);
      const prepared = await prepareProviderProfile(provider, childId, provider === 'codex' ? { kind: 'codex', providerSessionId: nativeId, threadOptions: {}, input: '' } : { kind: 'cli', command: 'unused', args: ['--resume=' + nativeId], cwd: '/source' });
      await prepared.finish('publish');
      await scanner.synchronize();
      assert.equal(sessionsDb.getSessionById(childId)?.provider_profile_path, childHome);
      assert.equal(resolveProviderHome(provider, childId), childHome);
    }
  });
});

test('managed history rejects a forged profile registration outside the app-session hash', async () => {
  await fixture(async () => {
    sessionsDb.createAppSession('app', 'cursor', '/source');
    sessionsDb.setProviderProfilePath('app', '/unrelated/profile');
    assert.throws(() => resolveProviderHome('cursor', 'app'), { code: 'WORKSPACE_PROVIDER_PROFILE_INVALID' });
  });
});
