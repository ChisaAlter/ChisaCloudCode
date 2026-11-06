import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'chat-stop-task-')));
const previousDatabase = process.env.DATABASE_PATH;
const previousRoot = process.env.WORKSPACES_ROOT;
const accountRoot = path.join(directory, 'account');
const projectPath = path.join(accountRoot, 'project');
const privateHome = path.join(directory, 'home');
process.env.DATABASE_PATH = path.join(directory, 'fixture.db');
process.env.WORKSPACES_ROOT = accountRoot;
await mkdir(projectPath, { recursive: true });
await mkdir(path.join(privateHome, '.chisa-workspace-runtime'), { recursive: true });
await writeFile(process.env.DATABASE_PATH, '');
mock.method(os, 'homedir', () => privateHome);
const statePath = path.join(privateHome, '.chisa-workspace-runtime', createHash('sha256').update(accountRoot).digest('hex').slice(0, 24) + '.json');
async function setOwner(userId: string) {
  const owner = createHash('sha256').update(accountRoot + '\0' + userId).digest('hex').slice(0, 24);
  await writeFile(statePath, JSON.stringify({ version: 1, root: accountRoot, userId, owner }), { mode: 0o600 });
}
await setOwner('1');
const { closeConnection, initializeDatabase, sessionsDb, userDb, sshProjectTargetsDb } = await import('@/modules/database/index.js');
const { handleChatConnection } = await import('../services/chat-websocket.service.js');
const { chatRunRegistry } = await import('../services/chat-run-registry.service.js');
const { connectedClients } = await import('../services/websocket-state.service.js');
await initializeDatabase();
userDb.createUser('owner', 'fixture');
userDb.createUser('other', 'fixture');
const SESSION_ID = 'held-session';
sessionsDb.createAppSession(SESSION_ID, 'claude', projectPath);
sessionsDb.createAppSession('other-session', 'claude', projectPath);
const anchor = path.join(accountRoot, '.chisa-ssh-projects', 'ssh-project');
await mkdir(anchor, { recursive: true });
sshProjectTargetsDb.createWithProject({ projectId: 'ssh-project', ownerId: '1', connectionId: 'laptop',
  connectionLabel: 'Laptop', rootPath: 'C:\\work\\App', rootIdentity: 'volume:file', anchorPath: anchor, displayName: 'Local App' });
sessionsDb.createAppSession('ssh-session', 'claude', anchor);

test.after(async () => {
  connectedClients.clear();
  chatRunRegistry.clearAll();
  closeConnection();
  mock.restoreAll();
  if (previousDatabase === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previousDatabase;
  if (previousRoot === undefined) delete process.env.WORKSPACES_ROOT; else process.env.WORKSPACES_ROOT = previousRoot;
  assert.equal(path.dirname(directory), await realpath(os.tmpdir()));
  await rm(directory, { recursive: true, force: true });
});

type StopCall = { provider: string; sessionId: string; taskId: string };

/** Real persisted ownership surrounds a runtime with one retained task and no foreground run. */
function gateway(user: Record<string, unknown> = { id: 1 }, taskSession = SESSION_ID) {
  const socket = Object.assign(new EventEmitter(), { readyState: 1, frames: [] as Record<string, unknown>[],
    send(value: string) { this.frames.push(JSON.parse(value)); } });
  const checks: StopCall[] = [];
  const stops: StopCall[] = [];
  const membership = (provider: string, sessionId: string, taskId: string) => provider === 'claude' && sessionId === taskSession && taskId === 'task-1';
  handleChatConnection(socket as never, { user } as never, { isSessionActive: () => true, runtime: {
    hasRuntime: () => true,
    run: async () => assert.fail('stop must not create a foreground run'),
    abort: async () => assert.fail('stop must not abort the foreground run'),
    hasBackgroundWork: () => true,
    hasBackgroundTask(provider, sessionId, taskId) { checks.push({ provider, sessionId, taskId }); return membership(provider, sessionId, taskId); },
    async stopBackgroundTask(provider, sessionId, taskId) { stops.push({ provider, sessionId, taskId }); return membership(provider, sessionId, taskId); },
    getPendingApprovalsForSession: () => [],
    resolveToolApproval: () => assert.fail('stop must not resolve permissions'),
  } });
  async function send(fields: Record<string, unknown> = {}) {
    for (const listener of socket.listeners('message')) {
      await listener(JSON.stringify({ type: 'chat.stop-task', sessionId: SESSION_ID, taskId: 'task-1', ...fields }));
    }
  }
  function close() { socket.emit('close'); connectedClients.delete(socket as never); }
  return { socket, checks, stops, send, close };
}

test('persisted cloud owner can stop tracked work after the foreground turn has finished', async () => {
  const h = gateway();
  try {
    assert.equal(chatRunRegistry.getRun(SESSION_ID), undefined);
    await h.send();
    assert.deepEqual(h.stops, [{ provider: 'claude', sessionId: SESSION_ID, taskId: 'task-1' }]);
    assert.deepEqual(h.socket.frames, []);
  } finally { h.close(); }
});

test('unknown task and cross-session task are rejected before stop invocation', async () => {
  for (const fields of [{ taskId: 'already-settled' }, { sessionId: 'other-session' }]) {
    const h = gateway();
    try {
      await h.send(fields);
      assert.equal(h.checks.length, 1);
      assert.deepEqual(h.stops, []);
      assert.equal(h.socket.frames.at(-1)?.kind, 'protocol_error');
      assert.equal(h.socket.frames.at(-1)?.code, 'NO_SUCH_TASK');
      assert.equal(h.socket.frames.at(-1)?.taskId, fields.taskId ?? 'task-1');
    } finally { h.close(); }
  }
});

test('missing session, missing task, missing persisted session and forged provider never reach task lookup', async () => {
  for (const [fields, code] of [
    [{ sessionId: '' }, 'SESSION_ID_REQUIRED'], [{ taskId: '' }, 'TASK_ID_REQUIRED'],
    [{ sessionId: 'no-such-session' }, 'SESSION_NOT_FOUND'], [{ provider: 'codex' }, 'PROVIDER_MISMATCH'],
    [{ provider: 'unknown' }, 'PROVIDER_MISMATCH'],
  ] as const) {
    const h = gateway();
    try {
      await h.send(fields);
      assert.equal(h.socket.frames.at(-1)?.code, code);
      assert.deepEqual(h.checks, []);
      assert.deepEqual(h.stops, []);
    } finally { h.close(); }
  }
});

test('missing identity and username-only identities fail closed even when frame supplies an owner', async () => {
  for (const user of [{}, { username: 'owner' }, { id: '' }, { id: 'owner\n' }]) {
    const h = gateway(user);
    try {
      await h.send({ userId: 1, ownerId: 1 });
      assert.equal(h.socket.frames.at(-1)?.code, 'UNAUTHORIZED');
      assert.deepEqual(h.checks, []);
      assert.deepEqual(h.stops, []);
    } finally { h.close(); }
  }
});

test('foreign cloud and SSH owners cannot inspect or stop another account task', async () => {
  for (const [sessionId, code] of [[SESSION_ID, 'WORKSPACE_FORBIDDEN'], ['ssh-session', 'SSH_WORKSPACE_FORBIDDEN']]) {
    const h = gateway({ id: 2 }, sessionId);
    try {
      await h.send({ sessionId, userId: 1 });
      assert.equal(h.socket.frames.at(-1)?.code, code);
      assert.deepEqual(h.checks, []);
      assert.deepEqual(h.stops, []);
    } finally { h.close(); }
  }
});

test('SSH owner uses trusted userId alias and persisted provider for a valid stop', async () => {
  const h = gateway({ userId: '1' }, 'ssh-session');
  try {
    await h.send({ sessionId: 'ssh-session', provider: 'claude' });
    assert.deepEqual(h.stops, [{ provider: 'claude', sessionId: 'ssh-session', taskId: 'task-1' }]);
    assert.deepEqual(h.socket.frames, []);
  } finally { h.close(); }
});

test('ownership is reloaded for every stop instead of cached when the socket connects', async () => {
  const h = gateway();
  try {
    await setOwner('2');
    await h.send();
    assert.equal(h.socket.frames.at(-1)?.code, 'WORKSPACE_FORBIDDEN');
    assert.deepEqual(h.checks, []);
    assert.deepEqual(h.stops, []);
  } finally { await setOwner('1'); h.close(); }
});
