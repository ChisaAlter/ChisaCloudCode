import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, mock } from 'node:test';

const root = await mkdtemp(path.join(tmpdir(), 'session-ssh-broadcast-'));
const previousDatabase = process.env.DATABASE_PATH;
process.env.DATABASE_PATH = path.join(root, 'fixture.db');
await writeFile(process.env.DATABASE_PATH, '');
let generatedNames = 0;
mock.module('@/modules/projects/index.js', { namedExports: {
  generateDisplayName: async () => { generatedNames += 1; return 'Cloud App'; },
  probeSshProjectDirectory: async () => { assert.fail('broadcast fixture must not probe a project'); },
} });
const { initializeDatabase, closeConnection, sessionsDb, projectsDb, sshProjectTargetsDb, getConnection } = await import('@/modules/database/index.js');
const { broadcastSessionUpserted, broadcastSessionUpsertedBatch } = await import('../services/session-upsert-broadcast.service.js');
const { connectedClients, setConnectedClientUserId } = await import('../services/websocket-state.service.js');
await initializeDatabase();
sshProjectTargetsDb.createWithProject({ projectId: 'local-project', ownerId: 'local-owner', connectionId: 'laptop', connectionLabel: 'Laptop',
  rootPath: 'C:\\开发\\Local App', rootIdentity: 'local-volume:directory', anchorPath: path.join(root, 'local-anchor'), displayName: 'Local App' });
getConnection().prepare('UPDATE projects SET custom_project_name = NULL WHERE project_id = ?').run('local-project');
sessionsDb.createAppSession('local-session', 'claude', path.join(root, 'local-anchor'));
sessionsDb.assignProviderSessionId('local-session', 'native-local');
projectsDb.createProjectPath('/workspace/cloud');
sessionsDb.createAppSession('cloud-session', 'claude', '/workspace/cloud');

after(async () => {
  connectedClients.clear();
  closeConnection();
  if (previousDatabase === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previousDatabase;
  await rm(root, { recursive: true, force: true });
});

function client(owner: string | null) {
  const value = { readyState: 1, frames: [] as Array<Record<string, unknown>>, send(data: string) { this.frames.push(JSON.parse(data) as Record<string, unknown>); } };
  connectedClients.add(value);
  setConnectedClientUserId(value, owner);
  return value;
}

test('SSH upsert is sent only to its authenticated owner with safe Windows display metadata', async () => {
  connectedClients.clear();
  const owner = client('local-owner');
  const foreign = client('foreign-owner');
  const unidentified = client(null);
  generatedNames = 0;
  await broadcastSessionUpserted('local-session');
  assert.equal(owner.frames.length, 1);
  assert.deepEqual(foreign.frames, []);
  assert.deepEqual(unidentified.frames, []);
  const project = owner.frames[0]!.project as Record<string, unknown>;
  assert.equal(project.displayName, 'Local App');
  assert.equal(project.displayPath, 'C:\\开发\\Local App');
  assert.equal(project.sourceMode, 'ssh');
  assert.equal(project.connectionLabel, 'Laptop');
  assert.equal(project.sshConnectionId, 'laptop');
  assert.equal(owner.frames[0]!.providerSessionId, 'native-local');
  assert.equal(generatedNames, 0, 'SSH display must not scan the VPS metadata anchor');
});

test('mixed watcher batch filters SSH deltas while preserving public cloud broadcasts', async () => {
  connectedClients.clear();
  const owner = client('local-owner');
  const foreign = client('foreign-owner');
  const unidentified = client(null);
  await broadcastSessionUpsertedBatch(['native-local', 'cloud-session']);
  assert.deepEqual(owner.frames.map(frame => frame.sessionId), ['local-session', 'cloud-session']);
  assert.deepEqual(foreign.frames.map(frame => frame.sessionId), ['cloud-session']);
  assert.deepEqual(unidentified.frames.map(frame => frame.sessionId), ['cloud-session']);
});
