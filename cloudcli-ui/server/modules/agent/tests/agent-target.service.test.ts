import assert from 'node:assert/strict';
import path from 'node:path';
import test, { mock } from 'node:test';

import { sshProjectTargetsDb, userDb } from '@/modules/database/index.js';
import { WORKSPACES_ROOT } from '@/shared/index.js';
import type { SshProjectTarget } from '@/shared/index.js';

import { resolveAgentProjectTarget } from '../agent-target.service.js';

const anchor = path.join(WORKSPACES_ROOT, '.chisa-ssh-projects', 'agent-owner-fixture');
const target: SshProjectTarget = {
  projectId: 'project', ownerId: '42', connectionId: 'windows', connectionLabel: 'Fixture',
  rootPath: 'D:\\Code\\App', rootIdentity: 'physical-root', generation: 'generation', workspaceId: 'workspace',
  anchorPath: anchor, phase: 'idle', activeRunId: null, pendingJobId: null,
};
const input = { projectPath: anchor, provider: 'claude', userId: 42, cloneRepository: false, manageGit: false };
test.beforeEach(() => {
  mock.method(userDb, 'getActiveUserIds', () => []);
  mock.method(sshProjectTargetsDb, 'getByPath', (candidate: string) => path.resolve(candidate) === anchor ? target : null);
});
test.afterEach(() => { mock.restoreAll(); });

test('Agent target prevalidation requires the saved SSH owner even for clone requests', () => {
  for (const userId of [undefined, null, 'foreign']) {
    for (const cloneRepository of [false, true]) {
      assert.throws(() => resolveAgentProjectTarget({ ...input, userId, cloneRepository }), { code: 'SSH_WORKSPACE_FORBIDDEN', statusCode: 403 });
    }
  }
});

test('Agent target prevalidation allows Claude but rejects host checkout operations on SSH anchors', () => {
  assert.deepEqual(resolveAgentProjectTarget(input), { projectPath: anchor, sourceMode: 'ssh' });
  for (const provider of ['codex', 'cursor', 'opencode']) {
    assert.throws(() => resolveAgentProjectTarget({ ...input, provider }), { code: 'WORKSPACE_PROVIDER_UNSUPPORTED', statusCode: 409 });
  }
  assert.throws(() => resolveAgentProjectTarget({ ...input, cloneRepository: true }), { code: 'SSH_WORKSPACE_UNSUPPORTED', statusCode: 409 });
  assert.throws(() => resolveAgentProjectTarget({ ...input, manageGit: true }), { code: 'SSH_WORKSPACE_UNSUPPORTED', statusCode: 409 });
});

test('Agent target prevalidation fails closed for unknown reserved anchors and invalid paths', () => {
  assert.throws(() => resolveAgentProjectTarget({ ...input, projectPath: path.join(WORKSPACES_ROOT, '.chisa-ssh-projects', 'unknown') }), { code: 'SSH_WORKSPACE_NOT_FOUND', statusCode: 404 });
  for (const projectPath of ['', '   ', null, 42, {}]) {
    assert.throws(() => resolveAgentProjectTarget({ ...input, projectPath }), { code: 'INVALID_PROJECT_PATH', statusCode: 400 });
  }
});

test('Agent target prevalidation retains legacy cloud path normalization and clone behavior', () => {
  const projectPath = path.join(WORKSPACES_ROOT, 'cloud-agent-fixture');
  const result = resolveAgentProjectTarget({ ...input, projectPath: path.join(projectPath, '..', 'cloud-agent-fixture'), provider: 'codex', userId: null, cloneRepository: true, manageGit: true });
  assert.equal(result.sourceMode, 'cloud');
  assert.equal(path.resolve(result.projectPath), path.resolve(projectPath));
});
