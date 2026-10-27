import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'agent-operation-recovery-'));
const previousDatabase = process.env.DATABASE_PATH;
const previousWorkspaces = process.env.WORKSPACES_ROOT;
process.env.DATABASE_PATH = path.join(fixtureRoot, 'fixture.db');
process.env.WORKSPACES_ROOT = fixtureRoot;
await writeFile(process.env.DATABASE_PATH, '');
const db = await import('@/modules/database/index.js');
const { createSshWorkspaceTransport } = await import('../ssh-workspace.service.js');
const rootIdentity = 'native-physical-root';
const rootPath = 'D:\\测试\\Project';
const requests: Array<{ operationId?: string; request: Record<string, unknown> }> = [];
let complete = false;
let refusal = false;
let wrongReceipt = false;
const transport = createSshWorkspaceTransport({ env: {},
  agentConnections: async () => [{ id: 'desktop', name: 'Desktop', port: 18765, token: 'c'.repeat(64) }],
  agentFetch: async (_url, init) => {
    const envelope = JSON.parse(String(init.body));
    requests.push(envelope);
    const base = { ok: true, protocol: 1, platform: 'win32', rootIdentity, rootPath };
    if (envelope.request.op === 'probe') return Response.json({ ...base, username: 'user', helperVersion: '1.0.1', capabilities: { files: true, exec: true, terminal: false } });
    if (envelope.request.op === 'operation_status' || envelope.request.op === 'operation_cancel') return Response.json({ ...base,
      operationId: wrongReceipt ? '00000000-0000-4000-8000-000000000000' : envelope.request.operationId,
      generation: envelope.generation, state: complete ? 'completed' : 'running', cleanupConfirmed: complete,
    });
    assert.equal(envelope.request.op, 'write');
    if (refusal) return Response.json({ ok: false, protocol: 1, platform: 'win32', code: 'AGENT_UNAUTHORIZED', error: 'Invalid credential' }, { status: 401 });
    // The native helper may still be writing after the HTTP response disappears.
    throw new TypeError('fetch failed after native dispatch');
  },
});
mock.module('@/modules/ssh-workspaces/index.js', { namedExports: {
  executeSshWorkspace: transport.executeSshWorkspace, probeSshWorkspace: transport.probeSshWorkspace,
} });
const bridge = await import('@/modules/workspace-bridge/index.js');

test('real SQLite writer fence survives response loss and reopen until exact native receipt confirms cleanup', async () => {
  try {
    await db.initializeDatabase();
    const anchor = path.join(fixtureRoot, '.chisa-ssh-projects', 'project');
    await mkdir(anchor, { recursive: true });
    const target = db.sshProjectTargetsDb.createWithProject({ projectId: 'project', ownerId: 'owner', connectionId: 'desktop',
      connectionLabel: 'Desktop', rootPath, rootIdentity, anchorPath: anchor, displayName: 'Project' });
    const files = bridge.bridgeFileSystem({} as never);
    const mutate = () => files.writeTextSnapshot!(path.join(anchor, 'file.txt'), 'a', null);
    await assert.rejects(mutate(), { code: 'SSH_OPERATION_UNCONFIRMED' });
    const fenced = db.sshProjectTargetsDb.getByProjectId('project')!;
    assert.equal(fenced.phase, 'recovery');
    assert.match(fenced.pendingJobId!, /^operation:[a-f0-9-]{36}$/);
    assert.equal(fenced.pendingJobId, `operation:${requests.find(item => item.request.op === 'write')!.operationId}`);
    assert.ok(fenced.activeRunId);

    db.closeConnection();
    await db.initializeDatabase();
    assert.deepEqual(db.sshProjectTargetsDb.getByProjectId('project'), fenced, 'unknown mutation fence must survive backend DB reopen');
    await assert.rejects(mutate(), { code: 'WORKSPACE_BUSY' });
    assert.equal(requests.filter(item => item.request.op === 'write').length, 1);
    assert.deepEqual(await bridge.recoverSshWorkspace(target), { status: 'running', jobId: fenced.pendingJobId });
    assert.deepEqual(db.sshProjectTargetsDb.getByProjectId('project'), fenced);

    complete = true;
    wrongReceipt = true;
    await assert.rejects(bridge.recoverSshWorkspace(target), { code: 'SSH_WORKSPACE_PROTOCOL_INVALID' });
    assert.equal(db.sshProjectTargetsDb.getByProjectId('project')!.phase, 'recovery');
    wrongReceipt = false;
    assert.deepEqual(await bridge.recoverSshWorkspace(target, true), { status: 'idle', inspectChanges: true });
    const recovered = db.sshProjectTargetsDb.getByProjectId('project')!;
    assert.equal(recovered.phase, 'idle');
    assert.equal(recovered.pendingJobId, null);
    assert.equal(recovered.activeRunId, null);
    assert.equal(requests.filter(item => item.request.op === 'write').length, 1, 'status/cancel recovery must never replay the original write');

    refusal = true;
    await assert.rejects(mutate(), { code: 'AGENT_UNAUTHORIZED', statusCode: 401 });
    assert.equal(db.sshProjectTargetsDb.getByProjectId('project')!.phase, 'idle');
    assert.equal(db.sshProjectTargetsDb.getByProjectId('project')!.pendingJobId, null);
    assert.equal(bridge.describeWorkspaceSelection({ projectId: target.projectId, sourceRoot: anchor }).cloudReplica.connectionState, 'offline');
    assert.equal(bridge.describeWorkspaceSelection({ projectId: target.projectId, sourceRoot: anchor }).cloudReplica.capabilities.write, true);
  } finally {
    db.closeConnection();
    if (previousDatabase === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabase;
    if (previousWorkspaces === undefined) delete process.env.WORKSPACES_ROOT;
    else process.env.WORKSPACES_ROOT = previousWorkspaces;
    assert.equal(path.dirname(fixtureRoot), tmpdir());
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
