import assert from 'node:assert/strict';
import test from 'node:test';

import { AppError } from '@/shared/index.js';
import type { WorktreeServices } from '@/shared/index.js';

import { createWorktreeManagementServices } from '../services/worktree-management.service.js';

const unexpected = async (): Promise<never> => { throw new Error('Private worktree reached a management service'); };

function fakeServices(overrides: Partial<WorktreeServices> = {}): WorktreeServices {
  return {
    resolveProjectPath: () => '/repo', list: unexpected, create: unexpected, createAndOpen: unexpected,
    open: unexpected, merge: unexpected, remove: unexpected, ...overrides,
  };
}

const privateError = (error: unknown) => error instanceof AppError && error.code === 'WORKSPACE_PRIVATE_SESSION';

test('ordinary worktree management rejects marked session roots before open, merge or forced removal', async () => {
  const services = createWorktreeManagementServices(fakeServices(), async root => root === '/ordinary-name');
  await assert.rejects(services.open({ projectPath: '/repo', worktreePath: '/ordinary-name' }), privateError);
  await assert.rejects(services.merge({ projectPath: '/repo', worktreePath: '/ordinary-name' }), privateError);
  await assert.rejects(services.remove({ projectPath: '/repo', worktreePath: '/ordinary-name', force: true }), privateError);
  await assert.rejects(services.create({ projectPath: '/ordinary-name', branch: 'branch' }), privateError);
  await assert.rejects(services.createAndOpen({ projectPath: '/ordinary-name', branch: 'branch' }), privateError);
  await assert.rejects(services.list({ projectPath: '/ordinary-name' }), privateError);
});

test('worktree listing hides exact marked roots and keeps ordinary roots regardless of their names', async () => {
  const paths = ['/repo', '/ordinary-name', '/chisa-looking-name'];
  const services = createWorktreeManagementServices(fakeServices({
    async list() {
      return { repositoryRoot: '/repo', baseBranch: 'main', worktrees: paths.map((worktreePath, index) => ({
        path: worktreePath, branch: `branch-${index}`, headSha: 'head', isMain: index === 0, isCurrent: index === 0,
        isLocked: false, isDetached: false, changedFileCount: 0, ahead: 0, behind: 0,
        lastCommitSubject: null, lastCommitDate: null, linkedProjectId: null, linkedProjectArchived: false,
      })) };
    },
  }), async root => root === '/ordinary-name');
  const result = await services.list({ projectPath: '/repo' });
  assert.deepEqual(result.worktrees.map(worktree => worktree.path), ['/repo', '/chisa-looking-name']);
});

test('marker lookup errors fail closed and cannot be mistaken for an ordinary worktree', async () => {
  const services = createWorktreeManagementServices(fakeServices(), async () => { throw new Error('metadata inaccessible'); });
  await assert.rejects(services.remove({ projectPath: '/repo', worktreePath: '/public', force: true }), /metadata inaccessible/);
});
