import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import { closeConnection, initializeDatabase, projectsDb, sessionsDb, sshProjectTargetsDb } from '@/modules/database/index.js';
import type { SshProjectTarget } from '@/shared/index.js';

const inFlight = new Set<string>();
const broadcast = mock.fn();
// Keep this metadata regression independent of provider startup and real chat runs.
mock.module('@/modules/websocket/index.js', { namedExports: {
  broadcastSessionUpserted: broadcast,
  chatRunRegistry: {},
  isChatRunInFlight: (sessionId: string) => inFlight.has(sessionId),
} });
mock.module('../provider.registry.js', { namedExports: { providerRegistry: {} } });
const { sessionsService } = await import('../services/sessions.service.js');

type Phase = SshProjectTarget['phase'];
type ActiveConversation = 'target' | 'sibling' | 'unrelated';

async function withFixture(
  phase: Phase,
  active: ActiveConversation,
  run: (fixture: Awaited<ReturnType<typeof createFixture>>) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ssh-session-archive-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'fixture.db');
  inFlight.clear();
  broadcast.mock.resetCalls();
  try {
    // An existing empty file prevents importing any legacy host database.
    await writeFile(process.env.DATABASE_PATH, '');
    await initializeDatabase();
    const fixture = await createFixture(directory, phase, active);
    await run(fixture);
    assert.equal(broadcast.mock.callCount(), 0);
  } finally {
    inFlight.clear();
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    assert.equal(path.dirname(directory), os.tmpdir());
    await rm(directory, { recursive: true, force: true });
  }
}

async function createFixture(directory: string, phase: Phase, active: ActiveConversation) {
  const target = sshProjectTargetsDb.createWithProject({
    projectId: 'ssh-project', ownerId: 'owner', connectionId: 'laptop', connectionLabel: 'Laptop',
    rootPath: 'C:\\Code\\App', rootIdentity: 'volume:file-app',
    anchorPath: path.join(directory, 'anchor'), displayName: 'SSH App',
  });
  const unrelated = sshProjectTargetsDb.createWithProject({
    projectId: 'unrelated-project', ownerId: 'owner', connectionId: 'laptop', connectionLabel: 'Laptop',
    rootPath: 'C:\\Code\\Other', rootIdentity: 'volume:file-other',
    anchorPath: path.join(directory, 'other-anchor'), displayName: 'Other SSH App',
  });
  const currentPath = path.join(directory, 'current.jsonl');
  const oldPath = path.join(directory, 'superseded.jsonl');
  const currentContents = '{"type":"user","message":"current conversation"}\n';
  const oldContents = '{"type":"user","message":"before message edit"}\n';
  await writeFile(currentPath, currentContents);
  await writeFile(oldPath, oldContents);
  sessionsDb.createSession('target', 'claude', target.anchorPath, 'Keep this title',
    '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', currentPath);
  sshProjectTargetsDb.pinSession('target', target);
  sessionsDb.markProviderSessionSuperseded({
    sessionId: 'target', provider: 'claude', providerSessionId: 'old-native-id', jsonlPath: oldPath,
  });
  sessionsDb.createAppSession('sibling', 'claude', target.anchorPath, 'Same project conversation');
  sessionsDb.createAppSession('unrelated', 'claude', unrelated.anchorPath, 'Unrelated conversation');
  inFlight.add(active);
  if (phase !== 'idle') {
    const runId = `run-for-${active}`;
    sshProjectTargetsDb.beginRun(target.projectId, runId);
    sshProjectTargetsDb.setPendingJob(target.projectId, runId, 'remote-job');
    if (phase === 'recovery') sshProjectTargetsDb.finishRun(target.projectId, runId, { uncertain: true });
  }

  const before = sessionsDb.getSessionById('target');
  assert.ok(before);
  const siblingBefore = sessionsDb.getSessionById('sibling');
  const unrelatedBefore = sessionsDb.getSessionById('unrelated');
  const projectBefore = projectsDb.getProjectById(target.projectId);
  const targetBefore = sshProjectTargetsDb.getByProjectId(target.projectId);
  const unrelatedTargetBefore = sshProjectTargetsDb.getByProjectId(unrelated.projectId);
  const pinBefore = sshProjectTargetsDb.getSessionTarget('target');
  const oldPathsBefore = sessionsDb.getSupersededTranscriptPaths('target');

  async function assertUntouchedState(): Promise<void> {
    assert.equal(await readFile(currentPath, 'utf8'), currentContents);
    assert.equal(await readFile(oldPath, 'utf8'), oldContents);
    assert.deepEqual(sessionsDb.getSupersededTranscriptPaths('target'), oldPathsBefore);
    assert.equal(sessionsDb.isProviderSessionSuperseded('old-native-id', 'claude'), true);
    assert.deepEqual(sshProjectTargetsDb.getSessionTarget('target'), pinBefore);
    assert.deepEqual(sessionsDb.getSessionById('sibling'), siblingBefore);
    assert.deepEqual(sessionsDb.getSessionById('unrelated'), unrelatedBefore);
    assert.deepEqual(projectsDb.getProjectById(target.projectId), projectBefore);
    assert.deepEqual(sshProjectTargetsDb.getByProjectId(target.projectId), targetBefore);
    assert.deepEqual(sshProjectTargetsDb.getByProjectId(unrelated.projectId), unrelatedTargetBefore);
    assert.deepEqual([...inFlight], [active]);
  }

  return { before, currentPath, oldPath, assertUntouchedState, targetBefore, unrelatedTargetBefore };
}

for (const phase of ['running', 'recovery', 'idle'] as const) {
  const activeConversations: ActiveConversation[] = phase === 'idle' ? ['target', 'unrelated'] : ['target', 'sibling'];
  for (const active of activeConversations) {
    test(`soft archive and restore only change metadata: SSH ${phase}, ${active} in flight`, { concurrency: false }, async () => {
      await withFixture(phase, active, async (fixture) => {
        // Even an explicit disk flag must be ignored unless force is requested.
        const options = active === 'target' ? undefined : { deletedFromDisk: true };
        assert.deepEqual(await sessionsService.deleteOrArchiveSessionById('target', options), {
          sessionId: 'target', action: 'archived', deletedFromDisk: false,
        });
        assert.deepEqual(sessionsDb.getSessionById('target'), { ...fixture.before, isArchived: 1 });
        await fixture.assertUntouchedState();

        assert.deepEqual(sessionsService.restoreSessionById('target'), { sessionId: 'target', isArchived: false });
        assert.deepEqual(sessionsDb.getSessionById('target'), fixture.before);
        await fixture.assertUntouchedState();
      });
    });
  }
}

for (const [phase, active] of [
  ['running', 'target'], ['running', 'sibling'],
  ['recovery', 'target'], ['recovery', 'sibling'],
  ['idle', 'target'],
] as const) {
  test(`force deletion retains busy guard: SSH ${phase}, ${active} in flight`, { concurrency: false }, async () => {
    await withFixture(phase, active, async (fixture) => {
      await assert.rejects(
        sessionsService.deleteOrArchiveSessionById('target', { force: true, deletedFromDisk: true }),
        { code: 'WORKSPACE_BUSY', statusCode: 409 },
      );
      assert.deepEqual(sessionsDb.getSessionById('target'), fixture.before);
      await fixture.assertUntouchedState();
    });
  });
}

test('idle SSH force deletion removes current and superseded transcripts despite an unrelated run', { concurrency: false }, async () => {
  await withFixture('idle', 'unrelated', async (fixture) => {
    const unrelatedBefore = sessionsDb.getSessionById('unrelated');
    const siblingBefore = sessionsDb.getSessionById('sibling');
    assert.deepEqual(await sessionsService.deleteOrArchiveSessionById('target', { force: true, deletedFromDisk: true }), {
      sessionId: 'target', action: 'deleted', deletedFromDisk: true,
    });
    assert.equal(sessionsDb.getSessionById('target'), null);
    assert.equal(sshProjectTargetsDb.getSessionTarget('target'), null);
    assert.equal(sessionsDb.isProviderSessionSuperseded('old-native-id', 'claude'), false);
    assert.deepEqual(sessionsDb.getSupersededTranscriptPaths('target'), []);
    await assert.rejects(readFile(fixture.currentPath), { code: 'ENOENT' });
    await assert.rejects(readFile(fixture.oldPath), { code: 'ENOENT' });
    assert.deepEqual(sessionsDb.getSessionById('unrelated'), unrelatedBefore);
    assert.deepEqual(sessionsDb.getSessionById('sibling'), siblingBefore);
    assert.deepEqual(sshProjectTargetsDb.getByProjectId('ssh-project'), fixture.targetBefore);
    assert.deepEqual(sshProjectTargetsDb.getByProjectId('unrelated-project'), fixture.unrelatedTargetBefore);
    assert.deepEqual([...inFlight], ['unrelated']);
  });
});
