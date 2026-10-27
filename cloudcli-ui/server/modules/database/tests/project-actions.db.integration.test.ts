import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { projectActionsDb } from '@/modules/database/repositories/project-actions.db.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'project-actions-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;

  try {
    await writeFile(databasePath, '');
    await initializeDatabase();
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('project actions persist ordered commands and update/remove them', async () => {
  await withIsolatedDatabase(() => {
    const project = projectsDb.createProjectPath('/workspace/actions-project').project!;
    const build = projectActionsDb.create(project.project_id, {
      name: 'Build',
      command: 'npm run build',
      kind: 'build',
      cwd: null,
      sortOrder: 2,
    });
    const testAction = projectActionsDb.create(project.project_id, {
      name: 'Test',
      command: 'npm test',
      kind: 'test',
      cwd: 'packages/app',
      sortOrder: 1,
    });

    assert.deepEqual(
      projectActionsDb.list(project.project_id).map((action) => action.name),
      ['Test', 'Build'],
    );
    assert.equal(projectActionsDb.get(project.project_id, testAction.id)?.cwd, 'packages/app');

    const updated = projectActionsDb.update(project.project_id, build.id, {
      name: 'Build production',
      command: 'npm run build:prod',
      kind: 'build',
      cwd: 'app',
      sortOrder: 0,
    });
    assert.equal(updated?.name, 'Build production');
    assert.equal(updated?.cwd, 'app');
    assert.equal(projectActionsDb.list(project.project_id)[0]?.id, build.id);

    assert.equal(projectActionsDb.remove(project.project_id, testAction.id), true);
    assert.equal(projectActionsDb.get(project.project_id, testAction.id), null);
    assert.equal(projectActionsDb.remove(project.project_id, 'missing'), false);
  });
});
