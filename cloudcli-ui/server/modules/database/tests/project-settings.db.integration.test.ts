import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { projectSettingsDb } from '@/modules/database/repositories/project-settings.db.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'project-settings-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;

  try {
    await writeFile(databasePath, '');
    await initializeDatabase();
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('project settings persist explicit overrides and inherit cleared fields', async () => {
  await withIsolatedDatabase(() => {
    const project = projectsDb.createProjectPath('/workspace/defaults-project');
    assert.equal(project.outcome, 'created');
    const projectId = project.project!.project_id;

    assert.equal(projectSettingsDb.get(projectId), null);

    projectSettingsDb.save(projectId, {
      provider: 'claude',
      model: 'claude-sonnet-4-5',
      effort: 'high',
      permissionMode: 'plan',
      workspaceMode: 'isolated',
    });

    const saved = projectSettingsDb.get(projectId);
    assert.equal(saved?.provider, 'claude');
    assert.equal(saved?.model, 'claude-sonnet-4-5');
    assert.equal(saved?.effort, 'high');
    assert.equal(saved?.permissionMode, 'plan');
    assert.equal(saved?.workspaceMode, 'isolated');

    // A later patch only changes what it names; clearing the model restores
    // inheritance for that field without disturbing the others.
    projectSettingsDb.save(projectId, { model: null });
    const patched = projectSettingsDb.get(projectId);
    assert.equal(patched?.model, null);
    assert.equal(patched?.permissionMode, 'plan');

    projectSettingsDb.clear(projectId);
    assert.equal(projectSettingsDb.get(projectId), null);
  });
});

test('pinned session lookup is independent of the recent page and hides archived rows', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('session-pinned-old', 'claude', '/workspace/pins', 'Old pin', '2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z');
    sessionsDb.createSession('session-recent', 'claude', '/workspace/pins', 'Recent', '2026-02-01T00:00:00.000Z', '2026-02-01T01:00:00.000Z');
    sessionsDb.createSession('session-pinned-archived', 'claude', '/workspace/pins', 'Archived pin', '2026-01-02T00:00:00.000Z', '2026-01-02T01:00:00.000Z');
    sessionsDb.updateSessionIsArchived('session-pinned-archived', true);

    const pinned = sessionsDb.getSessionsByIds([
      'session-pinned-old',
      'session-recent',
      'session-pinned-archived',
      'session-missing',
    ]);

    assert.deepEqual(
      pinned.map((session) => session.session_id),
      ['session-recent', 'session-pinned-old'],
    );
  });
});
