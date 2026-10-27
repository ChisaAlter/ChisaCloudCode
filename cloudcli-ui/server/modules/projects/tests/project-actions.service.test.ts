import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, projectsDb } from '@/modules/database/index.js';
import { projectActionsService } from '@/modules/projects/services/project-actions.service.js';
import { AppError } from '@/shared/index.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'project-actions-service-'));
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

function isAppError(code: string): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, code);
    return true;
  };
}

test('project action service validates commands, relative cwd, and missing rows', async () => {
  await withIsolatedDatabase(() => {
    const project = projectsDb.createProjectPath('/workspace/action-service').project!;
    const action = projectActionsService.create(project.project_id, {
      name: ' Test ',
      command: ' npm test ',
      kind: 'test',
      cwd: './packages/app',
      sortOrder: 1,
    });
    assert.equal(action.name, 'Test');
    assert.equal(action.command, 'npm test');
    assert.equal(action.cwd, 'packages/app');

    assert.throws(
      () => projectActionsService.create(project.project_id, { name: '', command: 'npm test' }),
      isAppError('INVALID_PROJECT_ACTION'),
    );
    assert.throws(
      () => projectActionsService.create(project.project_id, { name: 'Unsafe', command: 'npm test', cwd: '../outside' }),
      isAppError('INVALID_PROJECT_ACTION'),
    );
    assert.throws(
      () => projectActionsService.create(project.project_id, { name: 'Absolute', command: 'npm test', cwd: 'C:\\outside' }),
      isAppError('INVALID_PROJECT_ACTION'),
    );
    assert.throws(
      () => projectActionsService.get(project.project_id, 'missing'),
      isAppError('PROJECT_ACTION_NOT_FOUND'),
    );
    assert.throws(
      () => projectActionsService.create('missing-project', { name: 'Test', command: 'npm test' }),
      isAppError('PROJECT_NOT_FOUND'),
    );

    const updated = projectActionsService.update(project.project_id, action.id, {
      name: 'Build',
      command: 'npm run build',
      kind: 'build',
      cwd: null,
      sortOrder: 2,
    });
    assert.equal(updated.kind, 'build');
    assert.equal(updated.cwd, null);
    projectActionsService.remove(project.project_id, action.id);
    assert.equal(projectActionsService.list(project.project_id).length, 0);
  });
});
