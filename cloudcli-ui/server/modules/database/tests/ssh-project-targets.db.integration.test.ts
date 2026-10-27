import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
import { sshProjectTargetsDb } from '@/modules/database/repositories/ssh-project-targets.db.js';

async function fixture(run: () => void | Promise<void>) {
  const previous = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(tmpdir(), 'ssh-project-targets-'));
  const database = path.join(directory, 'fixture.db');
  closeConnection();
  process.env.DATABASE_PATH = database;
  await writeFile(database, '');
  try { await initializeDatabase(); await run(); }
  finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

function createTarget(overrides: Partial<Parameters<typeof sshProjectTargetsDb.createWithProject>[0]> = {}) {
  return sshProjectTargetsDb.createWithProject({ projectId: 'project-ssh', ownerId: 'owner-1', connectionId: 'laptop', connectionLabel: 'Laptop',
    rootPath: 'C:\\源代码\\App', rootIdentity: 'volume-1:file-5', anchorPath: path.resolve('/workspace/.chisa-ssh-projects/project-ssh'), displayName: 'Local App', ...overrides });
}

test('SSH target migration is additive, idempotent and leaves cloud identities untouched', async () => fixture(async () => {
  const cloud = projectsDb.createProjectPath('/workspace/cloud');
  sessionsDb.createAppSession('cloud-session', 'claude', '/workspace/cloud');
  await initializeDatabase();
  assert.deepEqual(projectsDb.getProjectById(cloud.project!.project_id), cloud.project);
  assert.equal(sshProjectTargetsDb.getByAnchor('/workspace/cloud'), null);
  assert.equal(sshProjectTargetsDb.getSessionTarget('cloud-session'), null);
  assert.equal(sessionsDb.getSessionById('cloud-session')?.workspace_mode, 'isolated');
}));

test('project and SSH target commit together, deduplicate physical root and resolve anchored descendants', async () => fixture(() => {
  const target = createTarget();
  assert.equal(projectsDb.getProjectById(target.projectId)?.project_path, target.anchorPath);
  assert.deepEqual(sshProjectTargetsDb.getByAnchor(target.anchorPath), target);
  assert.deepEqual(sshProjectTargetsDb.getByPath(path.join(target.anchorPath, 'src', 'file.ts')), target);
  assert.equal(sshProjectTargetsDb.getByPath(target.anchorPath + '-other'), null);
  assert.throws(() => createTarget({ projectId: 'duplicate', anchorPath: path.resolve('/workspace/.chisa-ssh-projects/duplicate') }), { code: 'SSH_PROJECT_ALREADY_EXISTS' });
  assert.equal(projectsDb.getProjectById('duplicate'), null);
  assert.throws(() => createTarget({ projectId: 'alias', connectionId: 'same-device-alias', anchorPath: path.resolve('/workspace/.chisa-ssh-projects/alias') }), { code: 'SSH_PROJECT_ALREADY_EXISTS' });
  assert.equal(projectsDb.getProjectById('alias'), null);
  assert.equal((getConnection().prepare('SELECT COUNT(*) AS n FROM ssh_project_targets').get() as { n: number }).n, 1);
  assert.equal(projectsDb.getProjectPaths().length, 1);
  const anotherOwner = createTarget({ projectId: 'other-owner', ownerId: 'owner-2', anchorPath: path.resolve('/workspace/.chisa-ssh-projects/other-owner') });
  assert.equal(anotherOwner.ownerId, 'owner-2');
  assert.deepEqual(sshProjectTargetsDb.findByOwnerRootIdentity('owner-1', target.rootIdentity), target);
  assert.deepEqual(sshProjectTargetsDb.findByOwnerRootIdentity('owner-2', target.rootIdentity), anotherOwner);
  assert.equal(sshProjectTargetsDb.findByOwnerRootIdentity('foreign', target.rootIdentity), null);
  assert.equal(sshProjectTargetsDb.findByOwnerRootIdentity('owner-1', 'other-root'), null);
  assert.throws(() => createTarget({ projectId: target.projectId, rootIdentity: 'different-root', anchorPath: path.resolve('/workspace/.chisa-ssh-projects/id-conflict') }), { code: 'SSH_PROJECT_CONFLICT' });
  assert.throws(() => createTarget({ projectId: 'anchor-conflict', rootIdentity: 'different-root', anchorPath: target.anchorPath }), { code: 'SSH_PROJECT_CONFLICT' });
  assert.equal(projectsDb.getProjectById('anchor-conflict'), null);
}));

test('sessions pin to exact target generation, forks retain pin and cascading deletes clean metadata', async () => fixture(() => {
  const target = createTarget();
  sessionsDb.createAppSession('local-session', 'claude', target.anchorPath);
  const pin = { sessionId: 'local-session', projectId: target.projectId, generation: target.generation };
  assert.deepEqual(sshProjectTargetsDb.getSessionTarget('local-session'), pin);
  assert.deepEqual(sshProjectTargetsDb.pinSession('local-session', target), pin);
  assert.equal(sessionsDb.getSessionById('local-session')?.workspace_mode, 'shared');
  sessionsDb.createAppSession('other-session', 'claude', '/workspace/cloud');
  assert.throws(() => sshProjectTargetsDb.pinSession('other-session', target), { code: 'WORKSPACE_SELECTION_MISMATCH' });
  assert.throws(() => sshProjectTargetsDb.pinSession('local-session', { ...target, generation: 'rebound' }), { code: 'WORKSPACE_GENERATION_CHANGED' });
  sessionsDb.createForkedSession({ sessionId: 'local-fork', provider: 'claude', projectPath: target.anchorPath, customName: null,
    providerSessionId: 'native-fork', jsonlPath: '/transcripts/fork.jsonl', forkedFromSessionId: 'local-session', model: null, effort: null });
  assert.equal(sshProjectTargetsDb.getSessionTarget('local-fork')?.generation, target.generation);
  getConnection().prepare('UPDATE ssh_project_targets SET generation = ? WHERE project_id = ?').run('changed-generation', target.projectId);
  assert.throws(() => sshProjectTargetsDb.pinSession('local-session', sshProjectTargetsDb.getByProjectId(target.projectId)!), { code: 'WORKSPACE_GENERATION_CHANGED' });
  assert.throws(() => sessionsDb.createForkedSession({ sessionId: 'stale-fork', provider: 'claude', projectPath: target.anchorPath, customName: null,
    providerSessionId: 'native-stale', jsonlPath: '/transcripts/stale.jsonl', forkedFromSessionId: 'local-session', model: null, effort: null }), { code: 'WORKSPACE_GENERATION_CHANGED' });
  assert.equal(sessionsDb.getSessionById('stale-fork'), null);
  projectsDb.deleteProjectById(target.projectId);
  assert.equal(sshProjectTargetsDb.getByProjectId(target.projectId), null);
  assert.equal(sshProjectTargetsDb.getSessionTarget('local-session'), null);
}));

test('writer admission and recovery preserve exact run ownership across connection reopen', async () => fixture(async () => {
  const target = createTarget();
  assert.deepEqual(sshProjectTargetsDb.getRun(target.projectId), { phase: 'idle', runId: null, pendingJobId: null });
  assert.equal(sshProjectTargetsDb.beginRun(target.projectId, 'run-1').phase, 'running');
  assert.throws(() => sshProjectTargetsDb.beginRun(target.projectId, 'run-2'), { code: 'WORKSPACE_BUSY' });
  assert.throws(() => sshProjectTargetsDb.finishRun(target.projectId, 'wrong-run'), { code: 'WORKSPACE_SELECTION_MISMATCH' });
  sshProjectTargetsDb.setPendingJob(target.projectId, 'run-1', 'remote-job-1');
  assert.throws(() => sshProjectTargetsDb.setPendingJob(target.projectId, 'wrong-run', 'other-job'), { code: 'WORKSPACE_SELECTION_MISMATCH' });
  sshProjectTargetsDb.finishRun(target.projectId, 'run-1', { uncertain: true });
  closeConnection();
  await initializeDatabase();
  assert.deepEqual(sshProjectTargetsDb.getRun(target.projectId), { phase: 'recovery', runId: 'run-1', pendingJobId: 'remote-job-1' });
  assert.throws(() => sshProjectTargetsDb.beginRun(target.projectId, 'run-2'), { code: 'WORKSPACE_BUSY' });
  assert.throws(() => sshProjectTargetsDb.recoverRun(target.projectId, 'run-2'), { code: 'WORKSPACE_SELECTION_MISMATCH' });
  assert.equal(sshProjectTargetsDb.recoverRun(target.projectId, 'run-1').phase, 'idle');
  assert.equal(sshProjectTargetsDb.beginRun(target.projectId, 'run-2').activeRunId, 'run-2');
  sshProjectTargetsDb.finishRun(target.projectId, 'run-2');
  assert.equal(sshProjectTargetsDb.getByProjectId(target.projectId)?.activeRunId, null);
}));
