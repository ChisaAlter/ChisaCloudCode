import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import express, { type ErrorRequestHandler } from 'express';

import { AppError } from '@/shared/index.js';
import type { WorkspaceDescriptor } from '@/shared/index.js';

const fixture = await realpath(await mkdtemp(path.join(os.tmpdir(), 'workspace-cloud-owner-')));
const accountRoot = path.join(fixture, 'account');
const privateHome = path.join(fixture, 'home');
const cloudRoot = path.join(accountRoot, 'project');
const legacyRoot = path.join(fixture, 'legacy');
const previousRoot = process.env.WORKSPACES_ROOT;
const nativePlatform = process.platform;
process.env.WORKSPACES_ROOT = accountRoot;
await mkdir(cloudRoot, { recursive: true });
await mkdir(legacyRoot);
await mkdir(path.join(privateHome, '.chisa-workspace-runtime'), { recursive: true });
mock.method(os, 'homedir', () => privateHome);
const owner = createHash('sha256').update(accountRoot + '\0' + '1').digest('hex').slice(0, 24);
await writeFile(path.join(privateHome, '.chisa-workspace-runtime', createHash('sha256').update(accountRoot).digest('hex').slice(0, 24) + '.json'), JSON.stringify({ version: 1, root: accountRoot, userId: '1', owner }), { mode: 0o600 });
await writeFile(path.join(cloudRoot, '.chisa-bridge.json'), JSON.stringify({ protocol: 3, root: cloudRoot, owner, bindingEpoch: 'test' }), { mode: 0o600 });
const { assertCloudWorkspaceOwner } = await import('@/modules/workspace-runtime/index.js');
const events: string[] = [];
let activeIds = ['1', '2'];
const projectRoots: Record<string, string> = { cloud: cloudRoot, legacy: legacyRoot };
mock.module('@/modules/database/index.js', { namedExports: {
  projectsDb: { getProjectPathById: (id: string) => projectRoots[id] ?? null },
  userDb: { getActiveUserIds: () => { events.push('accounts'); return activeIds; } },
  sessionsDb: {
    getSessionById: (id: string) => { events.push('session'); return { session_id: id, project_path: cloudRoot, workspace_mode: 'isolated' }; },
    getSessionsByProjectPathIncludingArchived: () => { events.push('sessions'); return []; },
  },
} });
mock.module('@/modules/workspace-runtime/index.js', { namedExports: {
  assertCloudWorkspaceOwner: (...args: Parameters<typeof assertCloudWorkspaceOwner>) => {
    events.push('authorize');
    // Router tests exercise Linux restoration on every host. File metadata must
    // still use the actual host's permission semantics during authorization.
    const platform = process.platform;
    Object.defineProperty(process, 'platform', { value: nativePlatform });
    try { assertCloudWorkspaceOwner(...args); }
    finally { Object.defineProperty(process, 'platform', { value: platform }); }
  },
  createWorkspaceRuntimeService: () => ({ restore: async (userId: string) => { events.push('restore:' + userId); } }),
} });
function descriptor(projectId: string, sourceRoot: string): WorkspaceDescriptor {
  return {
    projectId, workspaceId: 'replica', generation: 'generation', kind: 'cloudReplica',
    rootPath: sourceRoot, sourceRoot, requestedMode: 'shared', effectiveMode: 'shared', phase: 'idle', publicationState: 'integrated',
    capabilities: { read: true, write: true, git: true, shell: true, preview: true, integrate: false, cloudExecutionIndependentOfDesktop: true },
  };
}
mock.module('@/modules/workspace-bridge/index.js', { namedExports: {
  assertWorkspaceDescriptor: () => { events.push('validate'); },
  assertSshProjectOwner: () => { assert.fail('Cloud project must not use SSH authorization'); },
  resolveSshProjectTarget: () => null,
  describeWorkspaceSelection: ({ projectId, sourceRoot, sessionId }: { projectId: string; sourceRoot: string; sessionId?: string }) => {
    events.push('describe');
    const replica = descriptor(projectId, sourceRoot);
    return { cloudReplica: replica, session: sessionId ? { ...replica, workspaceId: 'session-workspace', kind: 'session', sessionId } : null };
  },
  integrateWorkspaceSession: async () => { events.push('integrate'); return { integrated: true }; },
  isWorkspaceBound: () => { events.push('bound'); return false; },
  workspaceRequestScope: (_request: unknown, _response: unknown, next: () => void) => next(),
} });
const { createWorkspacesRouter, resolveSelectedWorkspace } = await import('../workspaces.module.js');
const { workspaceSelectionScope } = await import('../workspace-selection-scope.js');
const app = express().use(express.json()).use((request, _response, next) => {
  (request as express.Request & { user: { id: string } }).user = { id: request.header('x-user') ?? '1' };
  next();
});
app.get('/selected/:projectId', workspaceSelectionScope, (request, response, next) => {
  try { response.json(resolveSelectedWorkspace(String(request.params.projectId))); }
  catch (error) { next(error); }
});
app.use('/workspaces', createWorkspacesRouter());
app.use(((error, _request, response, _next) => response.status(error instanceof AppError ? error.statusCode : 500).json({ code: error.code })) as ErrorRequestHandler);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const request = (url: string, userId = '1', body?: unknown) => fetch(base + url, {
  method: body === undefined ? 'GET' : 'POST', headers: { 'x-user': userId, 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
test.beforeEach(() => { events.length = 0; activeIds = ['1', '2']; });
test.after(async () => {
  Object.defineProperty(process, 'platform', { value: nativePlatform });
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  mock.restoreAll();
  if (previousRoot === undefined) delete process.env.WORKSPACES_ROOT;
  else process.env.WORKSPACES_ROOT = previousRoot;
  assert.equal(path.dirname(fixture), await realpath(os.tmpdir()));
  await rm(fixture, { recursive: true, force: true });
});

test('selected cloud workspace rejects a foreign account before catalog or bridge dispatch', async () => {
  const response = await request('/selected/cloud?workspaceId=replica&generation=generation', '2');
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { code: 'WORKSPACE_FORBIDDEN' });
  assert.deepEqual(events, ['accounts', 'authorize']);
});

test('selected cloud workspace admits its persisted owner with the exact selector', async () => {
  const response = await request('/selected/cloud?workspaceId=replica&generation=generation');
  assert.equal(response.status, 200);
  assert.equal((await response.json() as WorkspaceDescriptor).rootPath, cloudRoot);
  assert.deepEqual(events, ['accounts', 'authorize', 'describe', 'validate']);
});

test('legacy selected workspaces require authenticated single-account ownership', async () => {
  assert.equal((await request('/selected/legacy', '2')).status, 403);
  assert.deepEqual(events, ['accounts', 'authorize']);
  events.length = 0;
  activeIds = ['1'];
  assert.equal((await request('/selected/legacy')).status, 200);
  assert.deepEqual(events, ['accounts', 'authorize', 'bound', 'describe', 'validate']);
});

test('trusted internal null callers omit legacy account lookup but cannot bypass persisted owners', () => {
  assert.equal(resolveSelectedWorkspace('legacy').rootPath, legacyRoot);
  assert.deepEqual(events, ['authorize', 'bound', 'describe', 'validate']);
  events.length = 0;
  assert.throws(() => resolveSelectedWorkspace('cloud'), { code: 'WORKSPACE_FORBIDDEN' });
  assert.deepEqual(events, ['authorize']);
});

test('cloud catalog resolve rejects foreign owner before Linux runtime restore and catalog dispatch', async () => {
  Object.defineProperty(process, 'platform', { value: 'linux' });
  try {
    const response = await request('/workspaces/resolve?projectId=cloud&sessionId=chat', '2');
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { code: 'WORKSPACE_FORBIDDEN' });
    assert.deepEqual(events, ['accounts', 'authorize']);
    events.length = 0;
    const owned = await request('/workspaces/resolve?projectId=cloud&sessionId=chat');
    assert.equal(owned.status, 200);
    assert.equal((await owned.json() as { session: WorkspaceDescriptor }).session.sessionId, 'chat');
    assert.deepEqual(events, ['accounts', 'authorize', 'restore:1', 'session', 'describe', 'validate', 'validate']);
  } finally { Object.defineProperty(process, 'platform', { value: nativePlatform }); }
});

test('cloud integration rejects foreign owner before restore, descriptor lookup or integration', async () => {
  Object.defineProperty(process, 'platform', { value: 'linux' });
  try {
    const body = { projectId: 'cloud', sessionId: 'chat', workspaceId: 'session-workspace', generation: 'generation' };
    assert.equal((await request('/workspaces/integration/recover', '2', body)).status, 403);
    assert.deepEqual(events, ['accounts', 'authorize']);
    events.length = 0;
    activeIds = ['2'];
    // A caller-owned legacy query must not mask a foreign POST body project.
    assert.equal((await request('/workspaces/integration/recover?projectId=legacy', '2', body)).status, 403);
    assert.deepEqual(events, ['accounts', 'authorize']);
    events.length = 0;
    activeIds = ['1', '2'];
    assert.equal((await request('/workspaces/integration/recover', '1', body)).status, 200);
    assert.deepEqual(events, ['accounts', 'authorize', 'restore:1', 'session', 'describe', 'validate', 'integrate']);
  } finally { Object.defineProperty(process, 'platform', { value: nativePlatform }); }
});
