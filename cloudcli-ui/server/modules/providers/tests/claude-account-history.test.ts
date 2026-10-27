import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import { claudeAccountsDb, closeConnection, initializeDatabase, sessionsDb, userDb } from '@/modules/database/index.js';
import { ClaudeSessionSynchronizer } from '@/modules/providers/list/claude/claude-session-synchronizer.provider.js';
import { claudeHistoryRoots, onClaudeHistoryRoot, prepareClaudeAccountHistory, prepareClaudeUserHistory, resolveClaudeHistoryArtifact } from '@/modules/providers/services/claude-account-history.service.js';
import type { ClaudeAccountLaunchSnapshot } from '@/shared/types.js';

const PROVIDER_SESSION = 'f5237de7-325a-4a50-bb03-f9184557a724';
const APP_SESSION = 'history-app-session';

type Fixture = { root: string; userId: number; cwd: string; defaultDir: string; userHistory: string };
async function fixture(run: (value: Fixture) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chisa-claude-history-'));
  const environment = new Map(['DATABASE_PATH', 'CLAUDE_CONFIG_DIR', 'WORKSPACES_ROOT'].map((key) => [key, process.env[key]]));
  const home = mock.method(os, 'homedir', () => root);
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'data', 'auth.db');
  process.env.CLAUDE_CONFIG_DIR = path.join(root, '.claude');
  delete process.env.WORKSPACES_ROOT;
  await mkdir(path.dirname(process.env.DATABASE_PATH), { recursive: true });
  await writeFile(process.env.DATABASE_PATH, '');
  await initializeDatabase();
  const userId = Number(userDb.createUser('first', 'fixture-hash').id);
  const cwd = path.join(root, 'project');
  await mkdir(cwd);
  try { await run({ root, userId, cwd, defaultDir: process.env.CLAUDE_CONFIG_DIR, userHistory: path.join(root, 'data', 'claude-accounts', 'users', String(userId), 'history') }); }
  finally {
    closeConnection();
    for (const [key, previous] of environment) { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; }
    home.mock.restore();
    await rm(root, { recursive: true, force: true });
  }
}
async function profile(value: Fixture, userId = value.userId): Promise<ClaudeAccountLaunchSnapshot> {
  const accountId = randomUUID();
  claudeAccountsDb.save(userId, { id: accountId, name: 'Account', email: 'fixture@example.test', organizationUuid: null, organizationName: null, plan: 'max', createdAt: 1, updatedAt: 1 });
  const configDir = path.join(value.root, 'data', 'claude-accounts', 'users', String(userId), 'profiles', accountId, 'home');
  await mkdir(configDir, { recursive: true });
  await writeFile(path.join(path.dirname(configDir), 'owner.json'), JSON.stringify({ version: 1, userId, accountId }));
  return { userId, accountId, configDir, authDir: configDir, email: 'fixture@example.test', release: () => {} };
}
function defaultSnapshot(value: Fixture): ClaudeAccountLaunchSnapshot {
  return { userId: value.userId, accountId: 'default', configDir: value.defaultDir, authDir: value.defaultDir, email: null, release: () => {} };
}
function encodedProject(value: Fixture): string { return value.cwd.replace(/[^a-zA-Z0-9-]/g, '-'); }
async function transcript(value: Fixture, home: string, content = 'previous conversation'): Promise<string> {
  const file = path.join(home, 'projects', encodedProject(value), `${PROVIDER_SESSION}.jsonl`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ type: 'user', sessionId: PROVIDER_SESSION, cwd: value.cwd, message: { role: 'user', content } }) + '\n');
  return file;
}
function register(value: Fixture, file: string): void {
  sessionsDb.createAppSession(APP_SESSION, 'claude', value.cwd, 'Existing conversation');
  sessionsDb.assignProviderSessionId(APP_SESSION, PROVIDER_SESSION);
  sessionsDb.createSession(PROVIDER_SESSION, 'claude', value.cwd, undefined, undefined, undefined, file);
}
function resume(value: Fixture) { return { sessionId: APP_SESSION, providerSessionId: PROVIDER_SESSION, cwd: value.cwd }; }

test('same-user account profiles share only history and preserve a conversation when switching', async () => {
  await fixture(async (value) => {
    const first = await profile(value);
    const second = await profile(value);
    const notifications: string[] = [];
    const stop = onClaudeHistoryRoot((home) => { notifications.push(home); });
    try {
      await Promise.all([prepareClaudeAccountHistory(first), prepareClaudeAccountHistory(second)]);
      assert.equal(await realpath(path.join(first.configDir, 'projects')), path.join(value.userHistory, 'projects'));
      assert.equal(await realpath(path.join(second.configDir, 'projects')), path.join(value.userHistory, 'projects'));
      for (const privateFile of ['.credentials.json', '.claude.json', 'settings.json', 'sessions']) {
        assert.equal((await readdir(first.configDir)).includes(privateFile), false);
      }
      const file = await transcript(value, value.userHistory);
      register(value, file);
      await prepareClaudeAccountHistory(second, resume(value));
      assert.match(await readFile(path.join(second.configDir, 'projects', encodedProject(value), `${PROVIDER_SESSION}.jsonl`), 'utf8'), /previous conversation/);
      assert.equal(sessionsDb.getSessionById(APP_SESSION)?.jsonl_path, file);
      assert.deepEqual(await claudeHistoryRoots(), [{ userId: value.userId, home: value.userHistory }]);
      assert.ok(notifications.length >= 2);
    } finally { stop(); }
  });
});

test('authorized default-to-managed import copies only one conversation subtree and keeps the index canonical', async () => {
  await fixture(async (value) => {
    const source = await transcript(value, value.defaultDir);
    const subtree = path.join(path.dirname(source), PROVIDER_SESSION, 'subagents');
    await mkdir(subtree, { recursive: true });
    await writeFile(path.join(subtree, 'agent-one.jsonl'), '{"type":"assistant","message":{"content":"subagent"}}\n');
    await writeFile(path.join(path.dirname(source), 'unrelated.jsonl'), 'not this conversation');
    register(value, source);
    const account = await profile(value);
    await prepareClaudeAccountHistory(account, resume(value));
    const target = path.join(value.userHistory, 'projects', encodedProject(value), path.basename(source));
    assert.equal(await readFile(target, 'utf8'), await readFile(source, 'utf8'));
    assert.match(await readFile(path.join(path.dirname(target), PROVIDER_SESSION, 'subagents', 'agent-one.jsonl'), 'utf8'), /subagent/);
    assert.equal((await readdir(path.dirname(target))).includes('unrelated.jsonl'), false);
    assert.equal(sessionsDb.getSessionById(APP_SESSION)?.jsonl_path, target);
    assert.match(await readFile(source, 'utf8'), /previous conversation/);
  });
});

test('managed-to-default resume indexes its actual stable destination so later default CLI updates remain visible', async () => {
  await fixture(async (value) => {
    const account = await profile(value);
    await prepareClaudeAccountHistory(account);
    const source = await transcript(value, value.userHistory);
    register(value, source);
    await mkdir(value.defaultDir);
    await prepareClaudeAccountHistory(defaultSnapshot(value), resume(value));
    const target = path.join(value.defaultDir, 'projects', encodedProject(value), `${PROVIDER_SESSION}.jsonl`);
    assert.equal(await readFile(target, 'utf8'), await readFile(source, 'utf8'));
    assert.equal(sessionsDb.getSessionById(APP_SESSION)?.jsonl_path, target);
    assert.equal((await lstat(path.join(value.defaultDir, 'projects'))).isSymbolicLink(), false);
    await new ClaudeSessionSynchronizer().synchronize();
    assert.equal(sessionsDb.getSessionById(APP_SESSION)?.jsonl_path, target);
  });
});

test('managed to default and back appends only the missing continuation and retains a destination already ahead', async () => {
  await fixture(async (value) => {
    const account = await profile(value);
    await prepareClaudeAccountHistory(account);
    const central = await transcript(value, value.userHistory);
    register(value, central);
    await mkdir(value.defaultDir);
    await prepareClaudeAccountHistory(defaultSnapshot(value), resume(value));
    const legacy = path.join(value.defaultDir, 'projects', encodedProject(value), `${PROVIDER_SESSION}.jsonl`);
    const defaultTurn = JSON.stringify({ type: 'assistant', sessionId: PROVIDER_SESSION, cwd: value.cwd, message: { content: 'continued on default' } }) + '\n';
    await appendFile(legacy, defaultTurn);
    await prepareClaudeAccountHistory(account, resume(value));
    assert.equal(await readFile(central, 'utf8'), await readFile(legacy, 'utf8'));
    assert.match(await readFile(central, 'utf8'), /continued on default/);
    assert.equal(sessionsDb.getSessionById(APP_SESSION)?.jsonl_path, central);
    const centralTurn = JSON.stringify({ type: 'assistant', sessionId: PROVIDER_SESSION, cwd: value.cwd, message: { content: 'newer central continuation' } }) + '\n';
    await appendFile(central, centralTurn);
    // Simulate an older cached index: the longer destination is retained instead of rolling history back.
    sessionsDb.createSession(PROVIDER_SESSION, 'claude', value.cwd, undefined, undefined, undefined, legacy);
    await prepareClaudeAccountHistory(account, resume(value));
    assert.match(await readFile(central, 'utf8'), /newer central continuation/);
    assert.equal((await readFile(central, 'utf8')).split('continued on default').length, 2);
    assert.equal(sessionsDb.getSessionById(APP_SESSION)?.jsonl_path, central);
    await appendFile(legacy, JSON.stringify({ sessionId: PROVIDER_SESSION, cwd: value.cwd, message: { content: 'actual divergent branch' } }) + '\n');
    sessionsDb.createSession(PROVIDER_SESSION, 'claude', value.cwd, undefined, undefined, undefined, legacy);
    const beforeCentral = await readFile(central, 'utf8');
    const beforeLegacy = await readFile(legacy, 'utf8');
    await assert.rejects(prepareClaudeAccountHistory(account, resume(value)), { code: 'CLAUDE_HISTORY_DESTINATION_EXISTS' });
    assert.equal(await readFile(central, 'utf8'), beforeCentral);
    assert.equal(await readFile(legacy, 'utf8'), beforeLegacy);
  });
});

test('API-only users get separate runtime homes and cannot resume another Chisa user history', async () => {
  await fixture(async (value) => {
    const firstHome = await prepareClaudeUserHistory(value.userId);
    const file = await transcript(value, value.userHistory);
    register(value, file);
    const secondUser = Number(userDb.createUser('second', 'fixture-hash').id);
    const secondHome = await prepareClaudeUserHistory(secondUser);
    assert.notEqual(await realpath(path.join(firstHome, 'projects')), await realpath(path.join(secondHome, 'projects')));
    await assert.rejects(prepareClaudeUserHistory(secondUser, resume(value)), (error: unknown) => ['WORKSPACE_FORBIDDEN', 'CLAUDE_HISTORY_OWNER_INVALID'].includes((error as { code: string }).code));
    const secondProjects = await realpath(path.join(secondHome, 'projects'));
    assert.deepEqual(await readdir(secondProjects), []);
    const forged = await transcript(value, path.dirname(secondProjects));
    assert.equal(await new ClaudeSessionSynchronizer().synchronizeFile(forged), null, 'A duplicate provider id in another user store cannot repoint the original session');
    assert.equal(sessionsDb.getSessionById(APP_SESSION)?.jsonl_path, file);
    await assert.rejects(prepareClaudeAccountHistory(defaultSnapshot(value)), { code: 'CLAUDE_HISTORY_OWNER_INVALID' });
  });
});

test('existing nonempty profile history and conflicting destination transcripts are never overwritten', async () => {
  await fixture(async (value) => {
    const account = await profile(value);
    const own = path.join(account.configDir, 'projects');
    await mkdir(own);
    await writeFile(path.join(own, 'keep.jsonl'), 'user-owned history');
    await assert.rejects(prepareClaudeAccountHistory(account), { code: 'CLAUDE_HISTORY_CONFLICT' });
    assert.equal(await readFile(path.join(own, 'keep.jsonl'), 'utf8'), 'user-owned history');
    const clean = await profile(value);
    await prepareClaudeAccountHistory(clean);
    const source = await transcript(value, value.defaultDir);
    register(value, source);
    const destination = await transcript(value, value.userHistory, 'existing divergent copy');
    await assert.rejects(prepareClaudeAccountHistory(clean, resume(value)), { code: 'CLAUDE_HISTORY_DESTINATION_EXISTS' });
    assert.match(await readFile(destination, 'utf8'), /existing divergent copy/);
    assert.equal(sessionsDb.getSessionById(APP_SESSION)?.jsonl_path, source);
  });
});

test('history setup refuses foreign links, owner marker mismatches and linked transcript subtrees', async () => {
  await fixture(async (value) => {
    const foreign = path.join(value.root, 'foreign-projects');
    await mkdir(foreign);
    const account = await profile(value);
    await symlink(foreign, path.join(account.configDir, 'projects'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(prepareClaudeAccountHistory(account), { code: 'CLAUDE_HISTORY_OWNER_INVALID' });
    assert.equal(await realpath(path.join(account.configDir, 'projects')), foreign);
    const clean = await profile(value);
    await prepareClaudeAccountHistory(clean);
    const file = await transcript(value, value.defaultDir);
    register(value, file);
    const subtree = path.join(path.dirname(file), PROVIDER_SESSION);
    await mkdir(subtree);
    await symlink(foreign, path.join(subtree, 'subagents'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(prepareClaudeAccountHistory(clean, resume(value)), { code: 'CLAUDE_HISTORY_PATH_INVALID' });
    assert.deepEqual(await readdir(path.join(value.userHistory, 'projects')), []);
    await writeFile(path.join(value.userHistory, '.chisa-history-owner.json'), JSON.stringify({ version: 1, userId: value.userId + 1, kind: 'history' }));
    await assert.rejects(prepareClaudeAccountHistory(clean), { code: 'CLAUDE_HISTORY_OWNER_INVALID' });
  });
});

test('missing or mismatched resume transcripts fail clearly instead of starting a fresh conversation', async () => {
  await fixture(async (value) => {
    const account = await profile(value);
    sessionsDb.createAppSession(APP_SESSION, 'claude', value.cwd);
    sessionsDb.assignProviderSessionId(APP_SESSION, PROVIDER_SESSION);
    await assert.rejects(prepareClaudeAccountHistory(account, resume(value)), { code: 'CLAUDE_RESUME_HISTORY_MISSING' });
    const file = await transcript(value, value.defaultDir);
    sessionsDb.createSession(PROVIDER_SESSION, 'claude', value.cwd, undefined, undefined, undefined, file);
    await writeFile(file, JSON.stringify({ sessionId: 'different-session', cwd: value.cwd }) + '\n');
    await assert.rejects(prepareClaudeAccountHistory(account, resume(value)), { code: 'CLAUDE_HISTORY_SESSION_MISMATCH' });
    const offScope = path.join(value.root, `${PROVIDER_SESSION}.jsonl`);
    await writeFile(offScope, JSON.stringify({ sessionId: PROVIDER_SESSION, cwd: value.cwd }) + '\n');
    sessionsDb.createSession(PROVIDER_SESSION, 'claude', value.cwd, undefined, undefined, undefined, offScope);
    await assert.rejects(prepareClaudeAccountHistory(account, resume(value)), { code: 'CLAUDE_RESUME_HISTORY_MISSING' });
  });
});

test('indexer canonicalizes profile aliases and default rescans cannot replace central history', async () => {
  await fixture(async (value) => {
    const account = await profile(value);
    const source = await transcript(value, value.defaultDir);
    register(value, source);
    await prepareClaudeAccountHistory(account, resume(value));
    const central = path.join(value.userHistory, 'projects', encodedProject(value), `${PROVIDER_SESSION}.jsonl`);
    const alias = path.join(account.configDir, 'projects', encodedProject(value), `${PROVIDER_SESSION}.jsonl`);
    assert.equal((await resolveClaudeHistoryArtifact(alias))?.filePath, central);
    const indexer = new ClaudeSessionSynchronizer();
    assert.equal(await indexer.synchronizeFile(alias), APP_SESSION);
    assert.equal(await indexer.synchronizeFile(source), null);
    await indexer.synchronize();
    assert.equal(sessionsDb.getSessionById(APP_SESSION)?.jsonl_path, central);
    assert.equal(sessionsDb.getSessionById(APP_SESSION)?.project_path, value.cwd);
    assert.equal(sessionsDb.getSessionById(APP_SESSION)?.custom_name, 'Existing conversation');
    await rm(path.dirname(account.configDir), { recursive: true, force: true });
    assert.match(await readFile(central, 'utf8'), /previous conversation/);
    assert.equal(await indexer.synchronizeFile(central), APP_SESSION);
  });
});
