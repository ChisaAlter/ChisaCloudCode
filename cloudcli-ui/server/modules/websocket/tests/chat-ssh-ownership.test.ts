import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, mock } from 'node:test';

import type { AnyRecord } from '@/shared/index.js';

const directory = await mkdtemp(path.join(tmpdir(), 'chat-ssh-owner-'));
const previousDatabase = process.env.DATABASE_PATH;
const previousRoot = process.env.WORKSPACES_ROOT;
process.env.DATABASE_PATH = path.join(directory, 'fixture.db');
process.env.WORKSPACES_ROOT = directory;
await writeFile(process.env.DATABASE_PATH, '');
let anchorLookups = 0;
mock.module('@/modules/providers/index.js', { namedExports: {
  providerModelsService: { getProviderModels: async () => ({ DEFAULT: 'model' }) },
  sessionsService: { resolveEditAnchor: async () => { anchorLookups += 1; return { found: true, resumeThroughId: null }; } },
  sessionSynchronizerService: { synchronizeSessions: async () => assert.fail('unexpected filesystem synchronization in ownership fixture') },
} });
mock.module('@/modules/websocket/services/session-upsert-broadcast.service.js', { namedExports: {
  broadcastSessionUpserted: async () => {}, broadcastSessionUpsertedBatch: async () => {},
} });
const { assertCloudWorkspaceOwner } = await import('@/modules/workspace-runtime/index.js');
mock.module('@/modules/workspace-runtime/index.js', { namedExports: {
  assertCloudWorkspaceOwner: (...args: Parameters<typeof import('@/modules/workspace-runtime/index.js').assertCloudWorkspaceOwner>) => assertCloudWorkspaceOwner(...args),
  ensureCloudWorkspaceBinding() {}, excludeCloudWorkspaceMetadata() {}, getWorkspaceRuntimeIdentity() { return undefined; },
  executeWorkspaceRuntimePreview() { assert.fail('unexpected preview'); }, createWorkspaceRuntimeService() { assert.fail('unexpected restore'); },
} });
const { closeConnection, initializeDatabase, sessionsDb, sshProjectTargetsDb, getConnection } = await import('@/modules/database/index.js');
const { describeWorkspaceSelection } = await import('@/modules/workspace-bridge/index.js');
const { handleChatConnection, runDetachedChatTurn } = await import('../services/chat-websocket.service.js');
const { chatRunRegistry } = await import('../services/chat-run-registry.service.js');
const { connectedClients } = await import('../services/websocket-state.service.js');
await initializeDatabase();
const anchor = path.join(directory, '.chisa-ssh-projects', 'ssh-project');
await mkdir(anchor, { recursive: true });
const target = sshProjectTargetsDb.createWithProject({ projectId: 'ssh-project', ownerId: 'owner-1', connectionId: 'laptop',
  connectionLabel: 'Laptop', rootPath: 'C:\\work\\App', rootIdentity: 'volume:file', anchorPath: anchor, displayName: 'Local App' });
sessionsDb.createAppSession('ssh-session', 'claude', anchor);
sessionsDb.createAppSession('cloud-session', 'claude', path.join(directory, 'cloud'));
const descriptor = describeWorkspaceSelection({ projectId: target.projectId, sourceRoot: anchor, sessionId: 'ssh-session', requestedMode: 'shared' }).session!;
const selector = { projectId: target.projectId, workspaceId: descriptor.workspaceId, generation: descriptor.generation };

after(async () => {
  chatRunRegistry.clearAll();
  closeConnection();
  if (previousDatabase === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previousDatabase;
  if (previousRoot === undefined) delete process.env.WORKSPACES_ROOT; else process.env.WORKSPACES_ROOT = previousRoot;
  await rm(directory, { recursive: true, force: true });
});

function socket() {
  const value = new EventEmitter() as EventEmitter & { readyState: number; frames: AnyRecord[]; send(data: string): void };
  value.readyState = 1;
  value.frames = [];
  value.send = data => value.frames.push(JSON.parse(data) as AnyRecord);
  return value;
}

function fixture(owner = 'owner-1') {
  chatRunRegistry.clearAll();
  anchorLookups = 0;
  const ws = socket();
  const aborts: string[] = [];
  const approvals: string[] = [];
  const pending = new Map<string, unknown[]>([['ssh-session', [{ requestId: 'ssh-request', input: { secretSource: 'private' } }]], ['cloud-session', [{ requestId: 'cloud-request' }]]]);
  const dependencies: Parameters<typeof handleChatConnection>[2] = { runtime: {
    hasRuntime: () => true,
    run: async () => assert.fail('unexpected provider run'),
    abort: async (_provider, sessionId) => { aborts.push(sessionId); return true; },
    getPendingApprovalsForSession: sessionId => pending.get(sessionId) ?? [],
    resolveToolApproval: requestId => { approvals.push(requestId); },
  } };
  handleChatConnection(ws as never, { user: { id: owner } } as never, dependencies);
  const frame = async (data: AnyRecord) => {
    for (const listener of ws.listeners('message')) await listener(JSON.stringify(data));
  };
  const start = (sessionId = 'ssh-session') => {
    const run = chatRunRegistry.startRun({ appSessionId: sessionId, provider: 'claude', providerSessionId: null, connection: null, userId: 'owner-1' });
    assert.ok(run);
    return run;
  };
  const close = () => { ws.emit('close'); connectedClients.delete(ws as never); chatRunRegistry.clearAll(); };
  return { ws, aborts, approvals, dependencies, frame, start, close };
}

test('foreign SSH subscriber cannot replay code, approvals or attach to later stream events', async () => {
  const f = fixture('other-owner');
  try {
    const run = f.start();
    run.writer.send({ kind: 'stream_delta', content: 'private source', sessionId: 'ssh-session', provider: 'claude' });
    await f.frame({ type: 'chat.subscribe', sessions: [{ sessionId: 'ssh-session' }] });
    assert.equal(f.ws.frames.at(-1)?.code, 'SSH_WORKSPACE_FORBIDDEN');
    assert.equal(f.ws.frames.some(frame => frame.kind === 'chat_subscribed' || frame.kind === 'stream_delta'), false);
    run.writer.send({ kind: 'stream_delta', content: 'more private source', sessionId: 'ssh-session', provider: 'claude' });
    assert.equal(f.ws.frames.some(frame => frame.kind === 'stream_delta'), false);
  } finally { f.close(); }
});

test('foreign SSH abort and edit are rejected before runtime cancellation or transcript inspection', async () => {
  const f = fixture('other-owner');
  try {
    f.start();
    await f.frame({ type: 'chat.abort', sessionId: 'ssh-session' });
    assert.equal(f.ws.frames.at(-1)?.code, 'SSH_WORKSPACE_FORBIDDEN');
    assert.deepEqual(f.aborts, []);
    assert.equal(chatRunRegistry.isProcessing('ssh-session'), true);
    await f.frame({ type: 'chat.edit-send', sessionId: 'ssh-session', ...selector, anchorId: 'anchor', content: 'replace' });
    assert.equal(f.ws.frames.at(-1)?.code, 'SSH_WORKSPACE_FORBIDDEN');
    assert.equal(anchorLookups, 0);
  } finally { f.close(); }
});

test('approval resolves only its actual pending SSH session owner and cannot be retargeted by client sessionId', async () => {
  const foreign = fixture('other-owner');
  try {
    foreign.start();
    await foreign.frame({ type: 'chat.permission-response', requestId: 'ssh-request', sessionId: 'cloud-session', allow: true });
    assert.equal(foreign.ws.frames.at(-1)?.code, 'SSH_WORKSPACE_FORBIDDEN');
    assert.deepEqual(foreign.approvals, []);
  } finally { foreign.close(); }
  const owner = fixture();
  try {
    owner.start();
    await owner.frame({ type: 'chat.permission-response', requestId: 'ssh-request', allow: true });
    assert.deepEqual(owner.approvals, ['ssh-request']);
    await owner.frame({ type: 'chat.permission-response', requestId: 'unknown-request', allow: true });
    assert.equal(owner.ws.frames.at(-1)?.code, 'PERMISSION_REQUEST_NOT_FOUND');
    assert.deepEqual(owner.approvals, ['ssh-request']);
  } finally { owner.close(); }
});

test('foreign scheduled turn cannot interrupt an owned SSH run before dispatch rejects it', async () => {
  const f = fixture();
  try {
    f.start();
    const result = await runDetachedChatTurn({ sessionId: 'ssh-session', userId: 'other-owner', content: 'replace run',
      interruptActiveRun: true, options: { workspace: selector } }, f.dependencies);
    assert.equal(result.started, false);
    assert.equal(result.code, 'SSH_WORKSPACE_FORBIDDEN');
    assert.deepEqual(f.aborts, []);
    assert.equal(chatRunRegistry.isProcessing('ssh-session'), true);
  } finally { f.close(); }
});

test('unsupported SSH provider is rejected before a scheduled replacement can stop the current run', async () => {
  const f = fixture();
  getConnection().prepare('UPDATE sessions SET provider = ? WHERE session_id = ?').run('codex', 'ssh-session');
  try {
    f.start();
    const result = await runDetachedChatTurn({ sessionId: 'ssh-session', userId: 'owner-1', content: 'unsupported replacement',
      interruptActiveRun: true, options: { workspace: selector } }, f.dependencies);
    assert.equal(result.code, 'WORKSPACE_PROVIDER_UNSUPPORTED');
    assert.deepEqual(f.aborts, []);
    assert.equal(chatRunRegistry.isProcessing('ssh-session'), true);
  } finally {
    getConnection().prepare('UPDATE sessions SET provider = ? WHERE session_id = ?').run('claude', 'ssh-session');
    f.close();
  }
});

test('authorized SSH and existing cloud subscribers and approvals retain their normal behavior', async () => {
  const owner = fixture();
  try {
    owner.start();
    await owner.frame({ type: 'chat.subscribe', sessions: [{ sessionId: 'ssh-session' }] });
    assert.equal(owner.ws.frames.find(frame => frame.kind === 'chat_subscribed')?.pendingPermissions.length, 1);
    await owner.frame({ type: 'chat.abort', sessionId: 'ssh-session' });
    assert.deepEqual(owner.aborts, ['ssh-session']);
  } finally { owner.close(); }
  const cloud = fixture('other-owner');
  try {
    cloud.start('cloud-session');
    await cloud.frame({ type: 'chat.subscribe', sessions: [{ sessionId: 'cloud-session' }] });
    assert.ok(cloud.ws.frames.some(frame => frame.kind === 'chat_subscribed'));
    await cloud.frame({ type: 'chat.permission-response', requestId: 'cloud-request', allow: true });
    assert.deepEqual(cloud.approvals, ['cloud-request']);
    await cloud.frame({ type: 'chat.abort', sessionId: 'cloud-session' });
    assert.deepEqual(cloud.aborts, ['cloud-session']);
  } finally { cloud.close(); }
});
