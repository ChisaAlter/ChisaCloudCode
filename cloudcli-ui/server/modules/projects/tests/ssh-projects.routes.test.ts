import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import test, { mock } from 'node:test';

import express from 'express';

const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'ssh-project-routes-'));
const previousDatabase = process.env.DATABASE_PATH;
const previousRoot = process.env.WORKSPACES_ROOT;
process.env.DATABASE_PATH = path.join(fixtureRoot, 'fixture.db');
process.env.WORKSPACES_ROOT = fixtureRoot;
await writeFile(process.env.DATABASE_PATH, '');
let probes = 0;
const rootAliases = new Map<string, string>();
mock.module('@/modules/providers/index.js', { namedExports: { sessionSynchronizerService: { synchronizeSessions: async () => {} } } });
const progressClients = new Set<{ readyState: number; owner: string; frames: Array<Record<string, unknown>>; send(value: string): void }>();
mock.module('@/modules/websocket/index.js', { namedExports: { WS_OPEN_STATE: 1, connectedClients: progressClients,
  getConnectedClientUserId: (client: { owner: string }) => client.owner } });
mock.module('@/modules/ssh-workspaces/index.js', { namedExports: {
  probeSshWorkspace: async ({ connectionId, rootPath, userId }: { connectionId: string; rootPath: string; userId: string }) => {
    probes += 1;
    assert.ok(['laptop', 'alias-laptop'].includes(connectionId));
    return { ok: true, connectionId, connectionLabel: 'Laptop', platform: 'win32', rootPath, rootIdentity: rootAliases.get(rootPath) ?? userId + ':' + rootPath };
  },
  // The context-source route imports the workspace bridge, which resolves this
  // adapter at module load even though this route test never executes SSH.
  executeSshWorkspace: async () => ({ ok: true, exitCode: 0 }),
  agentConnectionService: { list: () => [], upsert: () => assert.fail('probe cannot register Agent'), remove: () => assert.fail('probe cannot remove Agent') },
  agentRelayBroker: { poll: () => assert.fail('probe cannot poll Agent'), settle: () => assert.fail('probe cannot settle Agent'), invalidate() {} },
  listSshConnections: async () => [],
} });
const { initializeDatabase, closeConnection, projectsDb, sessionsDb, sshProjectTargetsDb, getConnection } = await import('@/modules/database/index.js');
const { default: router } = await import('../projects.routes.js');
const { createSshWorkspacesRouter } = await import('@/modules/workspaces/index.js');

await test('project API preserves cloud defaults and scopes SSH metadata to its authenticated owner', async () => {
  await initializeDatabase();
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    const owner = request.headers['x-test-owner'];
    (request as typeof request & { user?: { userId: string } }).user = { userId: typeof owner === 'string' ? owner : '' };
    next();
  });
  app.use('/ssh-workspaces', createSshWorkspacesRouter());
  app.use(router);
  app.use((error: Error & { statusCode?: number; code?: string }, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    response.status(error.statusCode ?? 500).json({ error: error.message, code: error.code });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = async (endpoint: string, owner = 'owner-1', method = 'GET', body?: unknown) => {
    const response = await fetch(base + endpoint, { method, headers: { 'Content-Type': 'application/json', 'x-test-owner': owner }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  try {
    const cloud = await request('/create-project', 'owner-1', 'POST', { path: path.join(fixtureRoot, 'cloud') });
    assert.equal(cloud.status, 200);
    assert.equal(cloud.body.project.sourceMode, undefined);
    assert.equal(cloud.body.project.displayPath, undefined);
    assert.equal(probes, 0);
    const local = await request('/create-project', 'owner-1', 'POST', { sourceMode: 'ssh', connectionId: 'laptop', rootPath: 'C:\\开发\\Local App' });
    assert.equal(local.status, 200);
    assert.equal(local.body.project.sourceMode, 'ssh');
    assert.equal(local.body.project.displayPath, 'C:\\开发\\Local App');
    const projectId = local.body.project.projectId as string;
    const anchor = local.body.project.path as string;
    assert.equal(path.dirname(anchor), path.join(fixtureRoot, '.chisa-ssh-projects'));
    assert.equal(path.basename(anchor), projectId);
    assert.equal(probes, 1);
    sessionsDb.createAppSession('ssh-session', 'claude', anchor);
    // A fake package at the metadata anchor must not become the project source/name.
    await writeFile(path.join(anchor, 'package.json'), '{"name":"WRONG ANCHOR PACKAGE"}');
    getConnection().prepare('UPDATE projects SET custom_project_name = NULL WHERE project_id = ?').run(projectId);
    const makeProgressClient = (owner: string) => ({ owner, readyState: 1, frames: [] as Array<Record<string, unknown>>,
      send(value: string) { this.frames.push(JSON.parse(value) as Record<string, unknown>); } });
    const ownerProgress = makeProgressClient('owner-1');
    const foreignProgress = makeProgressClient('other-owner');
    progressClients.add(ownerProgress);
    progressClients.add(foreignProgress);
    const ownerList = await request('/?skipSynchronization=1');
    assert.ok(ownerProgress.frames.some(frame => frame.currentProject === 'C:\\开发\\Local App'));
    assert.equal(foreignProgress.frames.some(frame => frame.currentProject === 'C:\\开发\\Local App'), false);
    assert.equal(foreignProgress.frames.some(frame => frame.currentProject === cloud.body.project.path), false, 'loading progress is scoped to the requesting account');
    const listed = (ownerList.body as unknown as Array<Record<string, unknown>>).find(item => item.projectId === projectId)!;
    assert.equal(listed.displayName, 'Local App');
    assert.equal(listed.sshConnectionId, 'laptop');
    assert.equal(listed.displayPath, 'C:\\开发\\Local App');
    const otherList = await request('/?skipSynchronization=1', 'other-owner');
    assert.equal((otherList.body as unknown as Array<Record<string, unknown>>).some(item => item.projectId === projectId), false);
    assert.equal((otherList.body as unknown as Array<Record<string, unknown>>).some(item => item.projectId === cloud.body.project.projectId), true);
    assert.equal((await request(`/${projectId}/sessions`, 'other-owner')).status, 404);
    const duplicate = await request('/create-project', 'owner-1', 'POST', { sourceMode: 'ssh', connectionId: 'laptop', rootPath: 'C:\\开发\\Local App', customName: 'Do not rename' });
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.outcome, 'existing');
    assert.equal(duplicate.body.project.projectId, projectId);
    assert.equal(duplicate.body.project.displayName, 'Local App');
    assert.equal(sessionsDb.getSessionById('ssh-session')?.project_path, anchor);
    const page = await request(`/${projectId}/sessions`);
    assert.equal(page.body.sourceMode, 'ssh');
    assert.equal(page.body.sessions[0].id, 'ssh-session');
    assert.equal((await request(`/${projectId}`, 'other-owner', 'DELETE')).status, 404);
    sshProjectTargetsDb.beginRun(projectId, 'active-run');
    assert.equal((await request(`/${projectId}?force=true`, 'owner-1', 'DELETE')).status, 409);
    assert.equal(sshProjectTargetsDb.getByProjectId(projectId)?.activeRunId, 'active-run');
    sshProjectTargetsDb.finishRun(projectId, 'active-run', { uncertain: true, pendingJobId: 'pending-remote' });
    assert.equal((await request(`/${projectId}`, 'owner-1', 'DELETE')).status, 409);
    sshProjectTargetsDb.recoverRun(projectId, 'active-run');
    assert.equal((await request(`/${projectId}`, 'owner-1', 'DELETE')).status, 200);
    assert.equal(projectsDb.getProjectById(projectId)?.isArchived, 1);
    rootAliases.set('D:\\目录别名', 'owner-1:C:\\开发\\Local App');
    const beforeProbe = sshProjectTargetsDb.getByProjectId(projectId);
    const identified = await request('/ssh-workspaces/probe', 'owner-1', 'POST', { connectionId: 'alias-laptop', rootPath: 'D:\\目录别名' });
    assert.equal(identified.status, 200);
    assert.equal(identified.body.existingProject.projectId, projectId);
    assert.equal(identified.body.existingProject.sshConnectionId, 'laptop');
    assert.equal(identified.body.existingProject.displayPath, 'C:\\开发\\Local App');
    assert.equal(identified.body.existingProject.isArchived, true);
    assert.equal(projectsDb.getProjectById(projectId)?.isArchived, 1, 'probe is read-only even when the project is archived');
    assert.deepEqual(sshProjectTargetsDb.getByProjectId(projectId), beforeProbe);
    const foreignProbe = await request('/ssh-workspaces/probe', 'other-owner', 'POST', { connectionId: 'alias-laptop', rootPath: 'D:\\目录别名' });
    assert.equal(foreignProbe.status, 200);
    assert.equal(foreignProbe.body.existingProject, undefined);
    const archived = await request('/archived');
    assert.equal(archived.body.data.projects.find((item: Record<string, unknown>) => item.projectId === projectId)?.displayPath, 'C:\\开发\\Local App');
    assert.equal((await request('/archived', 'other-owner')).body.data.projects.length, 0);
    assert.equal((await request(`/${projectId}/restore`, 'other-owner', 'POST')).status, 404);
    const archivedTarget = sshProjectTargetsDb.getByProjectId(projectId);
    const restored = await request('/create-project', 'owner-1', 'POST', { sourceMode: 'ssh', connectionId: 'laptop', rootPath: 'C:\\开发\\Local App' });
    assert.equal(restored.status, 200);
    assert.equal(restored.body.outcome, 'reactivated_archived');
    assert.equal(restored.body.project.projectId, projectId);
    assert.equal(restored.body.project.isArchived, false);
    assert.deepEqual(sshProjectTargetsDb.getByProjectId(projectId), archivedTarget);
    assert.equal((await request(`/${projectId}/restore`, 'owner-1', 'POST')).status, 200);

    const raceRoot = 'D:\\并发\\Same Directory';
    const anchorsBeforeRace = await readdir(path.join(fixtureRoot, '.chisa-ssh-projects'));
    const [racerA, racerB] = await Promise.all([1, 2].map(() => request('/create-project', 'owner-1', 'POST', {
      sourceMode: 'ssh', connectionId: 'laptop', rootPath: raceRoot,
    })));
    assert.equal(racerA.status, 200);
    assert.equal(racerB.status, 200);
    assert.equal(racerA.body.project.projectId, racerB.body.project.projectId);
    assert.deepEqual([racerA.body.outcome, racerB.body.outcome].sort(), ['created', 'existing']);
    const anchorsAfterRace = await readdir(path.join(fixtureRoot, '.chisa-ssh-projects'));
    assert.equal(anchorsAfterRace.length, anchorsBeforeRace.length + 1, 'losing concurrent create removes only its new empty anchor');
    assert.equal((await request(`/${racerA.body.project.projectId}?force=true`, 'owner-1', 'DELETE')).status, 200);

    const cloudId = cloud.body.project.projectId as string;
    assert.deepEqual((await request(`/${cloudId}/actions`)).body.data.actions, []);
    const createdAction = await request(`/${cloudId}/actions`, 'owner-1', 'POST', {
      name: 'Build',
      command: 'npm run build',
      kind: 'build',
      cwd: 'app',
      sortOrder: 0,
    });
    assert.equal(createdAction.status, 201);
    const actionId = createdAction.body.data.action.id as string;
    assert.equal(createdAction.body.data.action.cwd, 'app');
    const updatedAction = await request(`/${cloudId}/actions/${actionId}`, 'owner-1', 'PUT', {
      name: 'Test',
      command: 'npm test',
      kind: 'test',
      cwd: null,
      sortOrder: 1,
    });
    assert.equal(updatedAction.body.data.action.kind, 'test');
    assert.equal((await request(`/${cloudId}/actions/${actionId}`, 'owner-1', 'DELETE')).status, 200);
    assert.deepEqual((await request(`/${cloudId}/actions`)).body.data.actions, []);

    const cloudDefaults = await request(`/${cloudId}/settings`);
    assert.equal(cloudDefaults.status, 200);
    assert.equal(cloudDefaults.body.data.settings.provider, null);
    const savedCloudDefaults = await request(`/${cloudId}/settings`, 'owner-1', 'PUT', {
      provider: 'codex',
      model: 'gpt-5.4',
      permissionMode: 'acceptEdits',
      workspaceMode: 'shared',
    });
    assert.equal(savedCloudDefaults.body.data.settings.provider, 'codex');
    assert.equal(savedCloudDefaults.body.data.settings.workspaceMode, 'shared');
    const clearedCloudDefaults = await request(`/${cloudId}/settings`, 'owner-1', 'DELETE');
    assert.equal(clearedCloudDefaults.body.data.settings.provider, null);

    assert.equal((await request(`/${projectId}/settings`, 'other-owner')).status, 404);
    const isolatedSshDefault = await request(`/${projectId}/settings`, 'owner-1', 'PUT', { workspaceMode: 'isolated' });
    assert.equal(isolatedSshDefault.status, 409);
    assert.equal(isolatedSshDefault.body.code, 'WORKSPACE_MODE_UNSUPPORTED');
    const unsupportedSshProvider = await request(`/${projectId}/settings`, 'owner-1', 'PUT', { provider: 'codex' });
    assert.equal(unsupportedSshProvider.status, 409);
    assert.equal(unsupportedSshProvider.body.code, 'WORKSPACE_PROVIDER_UNSUPPORTED');
    const savedSshDefaults = await request(`/${projectId}/settings`, 'owner-1', 'PUT', { model: 'claude-sonnet-4-5' });
    assert.equal(savedSshDefaults.status, 200);
    assert.equal(savedSshDefaults.body.data.sourceMode, 'ssh');
    assert.equal(savedSshDefaults.body.data.settings.model, 'claude-sonnet-4-5');
    assert.deepEqual(savedSshDefaults.body.data.constraints, { providers: ['claude'], workspaceMode: 'shared' });

    assert.equal((await request(`/${projectId}?force=true`, 'owner-1', 'DELETE')).status, 200);
    assert.equal(sshProjectTargetsDb.getByProjectId(projectId), null);
    assert.equal(sshProjectTargetsDb.getSessionTarget('ssh-session'), null);
    assert.equal(await readFile(path.join(anchor, 'package.json'), 'utf8'), '{"name":"WRONG ANCHOR PACKAGE"}');
    assert.equal(probes, 7, 'only create/open and explicit probe POSTs verify Windows; list/archive/delete remain local');
    const readded = await request('/create-project', 'owner-1', 'POST', { sourceMode: 'ssh', connectionId: 'laptop', rootPath: 'C:\\开发\\Local App' });
    assert.equal(readded.status, 200);
    assert.equal(readded.body.outcome, 'created');
    assert.notEqual(readded.body.project.projectId, projectId);
    assert.equal(sshProjectTargetsDb.findByOwnerRootIdentity('owner-1', 'owner-1:C:\\开发\\Local App')?.projectId, readded.body.project.projectId);
    assert.equal(sessionsDb.getSessionById('ssh-session'), null);
    assert.equal((await request(`/${readded.body.project.projectId}?force=true`, 'owner-1', 'DELETE')).status, 200);
    assert.equal((await request('/create-project', 'owner-1', 'POST', { workspaceType: 'local', sourceMode: 'ssh' })).body.code, 'LEGACY_WORKSPACE_TYPE_UNSUPPORTED');
    assert.equal((await request('/create-project', 'owner-1', 'POST', { path: path.join(fixtureRoot, '.chisa-ssh-projects', 'fake-cloud') })).body.code, 'SSH_ANCHOR_RESERVED');
  } finally {
    progressClients.clear();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    closeConnection();
    if (previousDatabase === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previousDatabase;
    if (previousRoot === undefined) delete process.env.WORKSPACES_ROOT; else process.env.WORKSPACES_ROOT = previousRoot;
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
