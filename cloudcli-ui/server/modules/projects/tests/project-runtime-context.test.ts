import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import { AppError } from '@/shared/index.js';
import type { ProjectRuntimeManifest, WorkspaceDescriptor, WorkspaceResolution } from '@/shared/index.js';

const owners = new Map<string, string>();
const resolutions = new Map<string, WorkspaceResolution>();
let describeCalls = 0;
let descriptorError: Error | null = null;
mock.module('@/modules/workspace-runtime/index.js', { namedExports: {
  assertCloudWorkspaceOwner(sourceRoot: string, userId: string) {
    if (owners.get(sourceRoot) !== userId) throw new AppError('Foreign project', { code: 'WORKSPACE_FORBIDDEN', statusCode: 403 });
  },
} });
mock.module('@/modules/workspace-bridge/index.js', { namedExports: {
  describeWorkspaceSelection(input: { projectId: string; sourceRoot: string; sessionId?: string }) {
    describeCalls += 1;
    const found = resolutions.get(JSON.stringify([input.projectId, input.sessionId ?? null]));
    if (!found) throw new AppError('Stale workspace', { code: 'WORKSPACE_GENERATION_CHANGED', statusCode: 409 });
    return found;
  },
  assertWorkspaceDescriptor() { if (descriptorError) throw descriptorError; },
} });
const state = await import('@/modules/project-runtime/index.js');
const { initializeDatabase, closeConnection, getConnection, projectsDb, sessionsDb, sshProjectTargetsDb, claudeAccountsDb, claudeConnectionsDb, userDb } = await import('@/modules/database/index.js');
const { getCurrentProjectMemory, saveCurrentProjectMemory, getCurrentProjectRuntimeManifest } = await import('../services/project-runtime-context.service.js');

async function fixture(run: (context: { root: string; projectId: string; userId: string }) => void | Promise<void>) {
  const previousDatabase = process.env.DATABASE_PATH;
  const root = await mkdtemp(path.join(tmpdir(), 'project-runtime-context-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'fixture.db');
  await writeFile(process.env.DATABASE_PATH, '', { flag: 'wx' });
  owners.clear(); resolutions.clear(); describeCalls = 0; descriptorError = null;
  try {
    await initializeDatabase();
    const userId = String(userDb.createUser('owner', 'unused-password-hash').id);
    const sourceRoot = path.join(root, 'cloud-project');
    const projectId = projectsDb.createProjectPath(sourceRoot).project!.project_id;
    owners.set(sourceRoot, userId);
    const cloudReplica = descriptor(projectId, sourceRoot);
    resolutions.set(JSON.stringify([projectId, null]), { cloudReplica, session: null });
    await run({ root, projectId, userId });
  } finally {
    closeConnection();
    if (previousDatabase === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previousDatabase;
    await rm(root, { recursive: true, force: true });
  }
}

function descriptor(projectId: string, sourceRoot: string, sessionId?: string): WorkspaceDescriptor {
  return { projectId, sourceRoot, rootPath: sessionId ? sourceRoot + '.session' : sourceRoot, workspaceId: sessionId ? 'session-workspace' : 'cloud-workspace',
    generation: sessionId ? 'session-generation' : 'cloud-generation', kind: sessionId ? 'session' : 'cloudReplica', ...(sessionId ? { sessionId } : {}),
    requestedMode: 'isolated', effectiveMode: 'isolated', phase: 'idle', publicationState: 'unpublished',
    capabilities: { read: true, write: true, git: true, shell: true, preview: false, integrate: false, cloudExecutionIndependentOfDesktop: true } };
}

function manifest(projectId: string, selection: Partial<ProjectRuntimeManifest> = {}): ProjectRuntimeManifest {
  return { projectId, runId: 'run', workspaceId: 'cloud-workspace', generation: 'cloud-generation', at: '2026-10-26T16:00:00.000Z',
    configRevision: 'revision', status: 'loaded', files: [], skills: [], mcp: [], warnings: [], ...selection };
}

function subscription(userId: string, id: string) {
  claudeAccountsDb.save(Number(userId), { id, name: id, email: null, organizationUuid: null, organizationName: null, plan: null,
    createdAt: Date.parse('2026-10-26T16:00:00.000Z'), updatedAt: Date.parse('2026-10-26T16:00:00.000Z') });
  claudeAccountsDb.activate(Number(userId), id);
}

function endpoint(userId: string, id: string) {
  claudeConnectionsDb.save(Number(userId), { id, name: id, baseUrl: 'https://example.invalid', model: 'test-model', apiKey: 'test-only-key', authType: 'api_key' });
  claudeConnectionsDb.activate(Number(userId), id);
}

test('single-account context reads the exact default subscription manifest and never falls back to another namespace', async () => fixture(({ userId, projectId }) => {
  state.saveProjectRuntimeManifest(userId, manifest(projectId, { runId: 'app-run' }), 'app');
  state.saveProjectRuntimeManifest(userId, manifest(projectId, { runId: 'hiroute-run' }), 'hiroute');
  assert.equal(getCurrentProjectRuntimeManifest(userId, projectId), null);
  assert.equal(describeCalls, 0);
  const expected = manifest(projectId, { runId: 'default-run' });
  state.saveProjectRuntimeManifest(userId, expected, 'subscription:default');
  assert.deepEqual(getCurrentProjectRuntimeManifest(userId, projectId), expected);
}));

test('selected subscription and API connection isolate account manifests, with active API taking precedence', async () => fixture(({ userId, projectId }) => {
  subscription(userId, 'account-a');
  state.saveProjectRuntimeManifest(userId, manifest(projectId, { runId: 'subscription-a' }), 'subscription:account-a');
  state.saveProjectRuntimeManifest(userId, manifest(projectId, { runId: 'subscription-b' }), 'subscription:account-b');
  assert.equal(getCurrentProjectRuntimeManifest(userId, projectId)?.runId, 'subscription-a');
  endpoint(userId, 'api-a');
  assert.equal(getCurrentProjectRuntimeManifest(userId, projectId), null);
  state.saveProjectRuntimeManifest(userId, manifest(projectId, { runId: 'api-run' }), 'api:api-a');
  assert.equal(getCurrentProjectRuntimeManifest(userId, projectId)?.runId, 'api-run');
  claudeConnectionsDb.activate(Number(userId), null);
  assert.equal(getCurrentProjectRuntimeManifest(userId, projectId)?.runId, 'subscription-a');
  subscription(userId, 'account-b');
  assert.equal(getCurrentProjectRuntimeManifest(userId, projectId)?.runId, 'subscription-b');
}));

test('multiple app users select their own app namespace and cannot read foreign project context or memory', async () => fixture(({ userId, projectId }) => {
  const foreign = String(userDb.createUser('foreign', 'unused-hash').id);
  state.saveProjectRuntimeManifest(userId, manifest(projectId, { runId: 'default' }), 'subscription:default');
  state.saveProjectRuntimeManifest(userId, manifest(projectId, { runId: 'app-owner' }), 'app');
  assert.equal(getCurrentProjectRuntimeManifest(userId, projectId)?.runId, 'app-owner');
  for (const operation of [() => getCurrentProjectRuntimeManifest(foreign, projectId), () => getCurrentProjectMemory(foreign, projectId),
    () => saveCurrentProjectMemory(foreign, projectId, 'foreign write', state.readProjectMemory(foreign, projectId).hash)]) {
    assert.throws(operation, { code: 'WORKSPACE_FORBIDDEN', statusCode: 403 });
  }
  assert.equal(state.readProjectMemory(userId, projectId).content, '');
}));

test('memory requires an existing owned project and keeps exact CAS versions across selected Claude account changes', async () => fixture(({ userId, projectId }) => {
  assert.throws(() => getCurrentProjectMemory(userId, 'missing'), { code: 'PROJECT_NOT_FOUND', statusCode: 404 });
  assert.throws(() => saveCurrentProjectMemory(userId, 'missing', 'no project', '0'.repeat(64)), { code: 'PROJECT_NOT_FOUND', statusCode: 404 });
  assert.equal(getCurrentProjectRuntimeManifest(userId, 'missing'), null);
  const empty = getCurrentProjectMemory(userId, projectId);
  const saved = saveCurrentProjectMemory(userId, projectId, 'Explicit note.', empty.hash);
  subscription(userId, 'chosen-subscription');
  endpoint(userId, 'chosen-api');
  assert.deepEqual(getCurrentProjectMemory(userId, projectId), saved);
  assert.throws(() => saveCurrentProjectMemory(userId, projectId, 'stale note', empty.hash), { code: 'PROJECT_MEMORY_CONFLICT', statusCode: 409 });
  assert.equal(saveCurrentProjectMemory(userId, projectId, '', saved.hash).content, '');
}));

test('cloud session manifests resolve their own generation rather than the cloud replica and reject missing or foreign durable sessions', async () => fixture(({ userId, projectId }) => {
  const sourceRoot = projectsDb.getProjectPathById(projectId)!;
  const cloudReplica = descriptor(projectId, sourceRoot);
  const sessionId = 'cloud-session';
  sessionsDb.createAppSession(sessionId, 'claude', sourceRoot);
  const selected = descriptor(projectId, sourceRoot, sessionId);
  resolutions.set(JSON.stringify([projectId, sessionId]), { cloudReplica, session: selected });
  const expected = manifest(projectId, { sessionId, workspaceId: selected.workspaceId, generation: selected.generation });
  state.saveProjectRuntimeManifest(userId, expected, 'subscription:default');
  assert.deepEqual(getCurrentProjectRuntimeManifest(userId, projectId), expected);
  const foreignProject = projectsDb.createProjectPath(path.join(path.dirname(sourceRoot), 'foreign-project')).project!;
  getConnection().prepare('UPDATE sessions SET project_path = ? WHERE session_id = ?').run(foreignProject.project_path, sessionId);
  assert.equal(getCurrentProjectRuntimeManifest(userId, projectId), null);
  assert.equal(describeCalls, 1, 'foreign session must reject before workspace resolution');
  getConnection().prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionId);
  assert.equal(getCurrentProjectRuntimeManifest(userId, projectId), null);
}));

test('stale cloud workspace, generation or descriptor identity returns no manifest while unexpected runtime failures propagate', async () => fixture(({ userId, projectId }) => {
  const sourceRoot = projectsDb.getProjectPathById(projectId)!;
  const cloudReplica = descriptor(projectId, sourceRoot);
  state.saveProjectRuntimeManifest(userId, manifest(projectId), 'subscription:default');
  for (const change of [{ workspaceId: 'replaced-workspace' }, { generation: 'replaced-generation' }, { projectId: 'foreign-project' }, { sourceRoot: '/foreign/source' }]) {
    resolutions.set(JSON.stringify([projectId, null]), { cloudReplica: { ...cloudReplica, ...change }, session: null });
    assert.equal(getCurrentProjectRuntimeManifest(userId, projectId), null);
  }
  resolutions.set(JSON.stringify([projectId, null]), { cloudReplica, session: null });
  descriptorError = new AppError('Changed identity', { code: 'WORKSPACE_GENERATION_CHANGED', statusCode: 409 });
  assert.equal(getCurrentProjectRuntimeManifest(userId, projectId), null);
  descriptorError = new Error('unexpected disk failure');
  assert.throws(() => getCurrentProjectRuntimeManifest(userId, projectId), /unexpected disk failure/);
}));

test('SSH context and memory enforce saved target ownership and exact session workspace provenance', async () => fixture(({ root, userId }) => {
  const target = sshProjectTargetsDb.createWithProject({ projectId: 'ssh-project', ownerId: userId, connectionId: 'laptop', connectionLabel: 'Laptop',
    rootPath: 'C:\\work\\App', rootIdentity: 'volume:file', anchorPath: path.join(root, 'ssh-anchor'), displayName: 'Local App' });
  const sessionId = 'ssh-session';
  sessionsDb.createAppSession(sessionId, 'claude', target.anchorPath);
  const cloudReplica = { ...descriptor(target.projectId, target.anchorPath), sourceMode: 'ssh' as const, generation: target.generation };
  const session = { ...descriptor(target.projectId, target.anchorPath, sessionId), sourceMode: 'ssh' as const, generation: target.generation };
  resolutions.set(JSON.stringify([target.projectId, sessionId]), { cloudReplica, session });
  const expected = manifest(target.projectId, { sessionId, workspaceId: session.workspaceId, generation: session.generation });
  state.saveProjectRuntimeManifest(userId, expected, 'subscription:default');
  assert.deepEqual(getCurrentProjectRuntimeManifest(userId, target.projectId), expected);
  for (const operation of [() => getCurrentProjectRuntimeManifest('foreign', target.projectId), () => getCurrentProjectMemory('foreign', target.projectId),
    () => saveCurrentProjectMemory('foreign', target.projectId, 'foreign write', '0'.repeat(64))]) {
    assert.throws(operation, { code: 'PROJECT_NOT_FOUND', statusCode: 404 });
  }
  resolutions.set(JSON.stringify([target.projectId, sessionId]), { cloudReplica, session: { ...session, workspaceId: 'wrong-session-workspace' } });
  assert.equal(getCurrentProjectRuntimeManifest(userId, target.projectId), null);
}));

test('context reports reflect persisted state after reopen without leaking another project or account', async () => fixture(async ({ userId, projectId }) => {
  const expected = manifest(projectId);
  state.saveProjectRuntimeManifest(userId, expected, 'subscription:default');
  const saved = saveCurrentProjectMemory(userId, projectId, 'Persisted note.', getCurrentProjectMemory(userId, projectId).hash);
  closeConnection();
  await initializeDatabase();
  assert.deepEqual(getCurrentProjectRuntimeManifest(userId, projectId), expected);
  assert.deepEqual(getCurrentProjectMemory(userId, projectId), saved);
  const other = projectsDb.createProjectPath('/other/project').project!;
  owners.set(other.project_path, userId);
  assert.equal(getCurrentProjectRuntimeManifest(userId, other.project_id), null);
  assert.equal(getCurrentProjectMemory(userId, other.project_id).content, '');
}));
