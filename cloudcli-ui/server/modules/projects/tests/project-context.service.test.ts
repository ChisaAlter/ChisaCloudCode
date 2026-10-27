import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, projectsDb, sshProjectTargetsDb } from '@/modules/database/index.js';
import { projectContextService } from '@/modules/projects/services/project-context.service.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'project-context-'));
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

test('SSH context reports workspace-tool instructions and no inherited settings sources', async () => {
  await withIsolatedDatabase(() => {
    const target = sshProjectTargetsDb.createWithProject({
      ownerId: '1',
      connectionId: 'windows-dev',
      connectionLabel: 'Windows',
      rootPath: 'C:\\work\\project',
      rootIdentity: 'root-identity',
      anchorPath: '/workspace/context-anchor',
      displayName: 'Windows project',
    });

    const view = projectContextService.get(target.projectId);
    assert.equal(view.sourceMode, 'ssh');
    assert.equal(view.displayPath, 'C:\\work\\project');
    assert.equal(view.workspace.mode, 'bridged');
    assert.equal(view.workspace.instructionPath, 'CLAUDE.md');
    assert.equal(view.instructions.access, 'workspace-tool');
    assert.deepEqual(view.runtime.settingSources, []);
    assert.equal(view.runtime.autoMemory, false);
    assert.equal(view.runtime.strictMcpConfig, true);
    assert.equal(view.runtime.workspaceToolsOnly, false);
    assert.deepEqual(view.runtime.effectiveMcpServers, ['workspace', 'project_context', '每轮按配置选择已批准的 HTTP/SSE MCP']);
    assert.equal(view.defaults.provider, null);
    assert.ok(view.notes.some((note) => note.includes('已配置')));
  });
});

test('unbound cloud context reports direct execution and points at an instruction file', async () => {
  await withIsolatedDatabase(() => {
    const project = projectsDb.createProjectPath('/workspace/cloud-context').project!;
    const view = projectContextService.get(project.project_id);
    assert.equal(view.sourceMode, 'cloud');
    assert.equal(view.execution.provider, 'claude');
    assert.equal(view.execution.location, 'local');
    assert.match(view.workspace.instructionPath, /CLAUDE\.md$/);
    assert.equal(view.defaults.model, null);
    assert.ok(view.notes.length > 0);
  });
});

test('a missing project has no context view', async () => {
  await withIsolatedDatabase(() => {
    assert.throws(() => projectContextService.get('missing-project'), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'PROJECT_NOT_FOUND');
      return true;
    });
  });
});
