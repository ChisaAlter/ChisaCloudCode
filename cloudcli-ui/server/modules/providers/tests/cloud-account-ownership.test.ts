import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import express from 'express';

const fixture = await mkdtemp(path.join(os.tmpdir(), 'cloud-account-owner-'));
const accountRoot = path.join(fixture, 'account');
const privateHome = path.join(fixture, 'home');
const projectPath = path.join(accountRoot, 'private-project');
process.env.DATABASE_PATH = path.join(fixture, 'db.sqlite');
process.env.WORKSPACES_ROOT = accountRoot;
await mkdir(projectPath, { recursive: true });
await mkdir(path.join(privateHome, '.chisa-workspace-runtime'), { recursive: true });
await writeFile(process.env.DATABASE_PATH, '');
mock.method(os, 'homedir', () => privateHome);
const owner = createHash('sha256').update(accountRoot + '\0' + '1').digest('hex').slice(0, 24);
const statePath = path.join(privateHome, '.chisa-workspace-runtime', createHash('sha256').update(accountRoot).digest('hex').slice(0, 24) + '.json');
await writeFile(statePath, JSON.stringify({ version: 1, root: accountRoot, userId: '1', owner }), { mode: 0o600 });
const markerPath = path.join(projectPath, '.chisa-bridge.json');
await writeFile(markerPath, JSON.stringify({ protocol: 3, root: projectPath, owner, bindingEpoch: 'fixture' }), { mode: 0o600 });
const db = await import('@/modules/database/index.js');
await db.initializeDatabase();
db.userDb.createUser('account-a', 'fixture');
db.userDb.createUser('account-b', 'fixture');
const project = db.projectsDb.createProjectPath(projectPath, 'Private cloud project').project!;
db.sessionsDb.createAppSession('private-session', 'claude', projectPath, 'Private cloud title');
db.sessionsDb.assignProviderSessionId('private-session', 'native-private');
const { readCloudWorkspaceOwner, assertCloudWorkspaceOwner } = await import('@/modules/workspace-runtime/index.js');
const { projectsRoutes: projectRouter } = await import('@/modules/projects/index.js');
const { default: providerRouter } = await import('../provider.routes.js');
const { providerRegistry } = await import('../provider.registry.js');
const { sessionSynchronizerService } = await import('../services/session-synchronizer.service.js');
mock.method(sessionSynchronizerService, 'synchronizeSessions', async () => undefined);
const { handleChatConnection, broadcastSessionUpserted, connectedClients, setConnectedClientUserId } = await import('@/modules/websocket/index.js');
const { queryClaudeSDK } = await import('../list/claude/claude-runtime.provider.js');
const { AppError } = await import('@/shared/index.js');
const app = express().use(express.json()).use((request, _response, next) => {
  (request as express.Request & { user: { id: string } }).user = { id: request.header('x-user') ?? '1' }; next();
}).use('/projects', projectRouter).use('/providers', providerRouter);
app.use(((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  response.status(error instanceof AppError ? error.statusCode : 500).json({ code: error instanceof AppError ? error.code : 'INTERNAL' });
}) as express.ErrorRequestHandler);
const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const request = (url: string, user = '2', method = 'GET', body?: unknown) => fetch(base + url, { method, headers: { 'x-user': user, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
test.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); connectedClients.clear(); db.closeConnection(); mock.restoreAll(); assert.equal(path.dirname(fixture), os.tmpdir()); await rm(fixture, { recursive: true, force: true }); });

function socket(user: string) {
  const value = Object.assign(new EventEmitter(), { readyState: 1, frames: [] as Record<string, any>[], send(data: string) { this.frames.push(JSON.parse(data)); } });
  connectedClients.add(value as never); setConnectedClientUserId(value as never, user);
  return value;
}

test('existing cloud account owner is read without restoration or metadata changes; unknown multiaccount imports fail closed', async () => {
  const before = await readFile(statePath, 'utf8');
  assert.equal(readCloudWorkspaceOwner(projectPath), '1');
  assert.doesNotThrow(() => assertCloudWorkspaceOwner(projectPath, '1', ['1', '2']));
  assert.throws(() => assertCloudWorkspaceOwner(projectPath, '2', ['1', '2']), { code: 'WORKSPACE_FORBIDDEN' });
  assert.throws(() => assertCloudWorkspaceOwner(path.join(fixture, 'unbound'), '2', ['1', '2']), { code: 'WORKSPACE_FORBIDDEN' });
  assert.doesNotThrow(() => assertCloudWorkspaceOwner(path.join(fixture, 'unbound'), '1', ['1']));
  assert.equal(await readFile(statePath, 'utf8'), before);
});

test('foreign project/recent/search/archive metadata is filtered before totals and raw routes reject ownership', async () => {
  assert.deepEqual(await (await request('/projects?skipSync=1')).json(), []);
  assert.equal((await request(`/projects/${project.project_id}/sessions`)).status, 403);
  assert.equal((await request(`/projects/${project.project_id}/settings`)).status, 403);
  const recent = await (await request('/providers/sessions/recent?limit=1')).json() as { data: { total: number; conversations: unknown[] } };
  assert.equal(recent.data.total, 0); assert.deepEqual(recent.data.conversations, []);
  const search = await (await request('/providers/search/sessions?q=Private')).text();
  assert.doesNotMatch(search, /private-session|Private cloud/);
  const ownerProjects = await (await request('/projects?skipSync=1', '1')).json() as { projectId: string }[];
  assert.equal(ownerProjects[0]?.projectId, project.project_id);
});

test('foreign history/delete/fork/model/session creation are rejected before provider or credential lookups', async () => {
  let lookups = 0;
  const resolve = mock.method(providerRegistry, 'resolveProvider', () => { lookups++; throw new Error('Provider must not be resolved'); });
  try {
    for (const [method, suffix] of [['GET', ''], ['GET', '/messages'], ['GET', '/token-usage'], ['GET', '/provider-id'], ['DELETE', ''], ['PUT', ''], ['POST', '/fork'], ['POST', '/restore']] as const) {
      assert.equal((await request('/providers/sessions/private-session' + suffix, '2', method, method === 'GET' || method === 'DELETE' ? undefined : {})).status, 403, method + suffix);
    }
    assert.equal((await request('/providers/sessions/native-private/messages')).status, 403);
    assert.equal((await request('/providers/sessions', '2', 'POST', { provider: 'claude', projectPath })).status, 403);
    assert.equal(lookups, 0);
    assert.ok(db.sessionsDb.getSessionById('private-session'));
  } finally { resolve.mock.restore(); }
});

test('foreign chat send/replay and direct Claude stop before provider/model/credentials', async () => {
  const ws = socket('2'); let providerRuns = 0;
  handleChatConnection(ws as never, { user: { id: '2' } } as never, { runtime: {
    hasRuntime: () => true, run: async () => { providerRuns++; }, abort: async () => { providerRuns++; return true; },
    getPendingApprovalsForSession: () => [], resolveToolApproval() { providerRuns++; },
  } });
  for (const payload of [{ type: 'chat.send', sessionId: 'private-session', content: 'run' }, { type: 'chat.subscribe', sessions: [{ sessionId: 'private-session' }] }]) {
    for (const listener of ws.listeners('message')) await listener(JSON.stringify(payload));
  }
  assert.equal(ws.frames.filter(frame => frame.code === 'WORKSPACE_FORBIDDEN').length, 2);
  assert.equal(providerRuns, 0);
  let contextCalls = 0;
  const context = { resolveProviderSessionId() { contextCalls++; return null; }, resolveResumeModel: async () => { contextCalls++; return 'sonnet'; }, getProviderModels: async () => { contextCalls++; return {} as never; }, isProviderInstalled: async () => { contextCalls++; return true; }, normalizeMessage: () => [] };
  await assert.rejects(queryClaudeSDK('run', { cwd: projectPath, sessionId: 'private-session' }, { userId: 2, send() {} }, context), { code: 'WORKSPACE_FORBIDDEN' });
  assert.equal(contextCalls, 0); ws.emit('close'); connectedClients.delete(ws as never);
});

test('all provider dispatchers reject foreign app and native sessions before resolving providers', async () => {
  const { createProviderRuntimeService } = await import('../services/provider-runtime.service.js');
  let lookups = 0;
  const runtime = createProviderRuntimeService({ resolveProvider: () => { lookups++; throw new Error('Provider resolution must not run'); } });
  for (const provider of ['claude', 'codex', 'cursor', 'opencode'] as const) {
    for (const sessionId of ['private-session', 'native-private']) {
      await assert.rejects(runtime.run(provider, 'run', { cwd: path.join(fixture, 'unbound'), sessionId }, { userId: 2, send() {} }), { code: 'WORKSPACE_FORBIDDEN' });
    }
    await assert.rejects(runtime.run(provider, 'run', { cwd: projectPath }, { userId: 2, send() {} }), { code: 'WORKSPACE_FORBIDDEN' });
  }
  assert.equal(lookups, 0);
});

test('cloud live upserts reach only the persisted account owner', async () => {
  connectedClients.clear(); const first = socket('1'); const second = socket('2');
  await broadcastSessionUpserted('private-session');
  assert.equal(first.frames[0]?.sessionId, 'private-session'); assert.deepEqual(second.frames, []);
});
