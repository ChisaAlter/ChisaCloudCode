import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, projectsDb, sshProjectTargetsDb } from '@/modules/database/index.js';
import { projectSettingsService } from '@/modules/projects/services/project-settings.service.js';
import { AppError } from '@/shared/index.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'project-settings-service-'));
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

function isAppError(code: string): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, code);
    return true;
  };
}

test('cloud project settings validate values, save overrides, and clear back to inheritance', async () => {
  await withIsolatedDatabase(() => {
    const created = projectsDb.createProjectPath('/workspace/settings-service');
    const projectId = created.project!.project_id;

    const initial = projectSettingsService.get(projectId);
    assert.equal(initial.sourceMode, 'cloud');
    assert.deepEqual(initial.settings, {
      provider: null,
      model: null,
      effort: null,
      permissionMode: null,
      workspaceMode: null,
    });

    assert.throws(
      () => projectSettingsService.save(projectId, { provider: 'unknown-provider' }),
      isAppError('INVALID_PROJECT_SETTING'),
    );
    assert.throws(
      () => projectSettingsService.save(projectId, { workspaceMode: 'detached' }),
      isAppError('INVALID_PROJECT_SETTING'),
    );

    const saved = projectSettingsService.save(projectId, {
      provider: 'codex',
      model: 'gpt-5.4',
      permissionMode: 'acceptEdits',
      workspaceMode: 'shared',
    });
    assert.equal(saved.settings.provider, 'codex');
    assert.equal(saved.settings.model, 'gpt-5.4');
    assert.equal(saved.settings.permissionMode, 'acceptEdits');
    assert.equal(saved.settings.workspaceMode, 'shared');

    const inherited = projectSettingsService.clear(projectId);
    assert.equal(inherited.settings.provider, null);
    assert.equal(inherited.settings.model, null);
    assert.equal(inherited.updatedAt, null);
  });
});

test('SSH projects reject a non-Claude provider and isolated workspaces', async () => {
  await withIsolatedDatabase(() => {
    const target = sshProjectTargetsDb.createWithProject({
      ownerId: '1',
      connectionId: 'windows-dev',
      connectionLabel: 'Windows',
      rootPath: 'C:\\work\\project',
      rootIdentity: 'root-identity',
      anchorPath: '/workspace/ssh-anchor',
      displayName: 'Windows project',
    });

    const view = projectSettingsService.get(target.projectId);
    assert.equal(view.sourceMode, 'ssh');
    assert.deepEqual(view.constraints, { providers: ['claude'], workspaceMode: 'shared' });

    assert.throws(
      () => projectSettingsService.save(target.projectId, { provider: 'codex' }),
      isAppError('WORKSPACE_PROVIDER_UNSUPPORTED'),
    );
    assert.throws(
      () => projectSettingsService.save(target.projectId, { workspaceMode: 'isolated' }),
      isAppError('WORKSPACE_MODE_UNSUPPORTED'),
    );

    const saved = projectSettingsService.save(target.projectId, {
      model: 'claude-sonnet-4-5',
      permissionMode: 'plan',
    });
    assert.equal(saved.settings.model, 'claude-sonnet-4-5');
    assert.equal(saved.settings.permissionMode, 'plan');
  });
});
