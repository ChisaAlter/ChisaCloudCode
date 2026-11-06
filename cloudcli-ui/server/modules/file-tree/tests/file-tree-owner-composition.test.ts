import assert from 'node:assert/strict';
import path from 'node:path';
import test, { mock } from 'node:test';

import { AppError } from '@/shared/index.js';
import type { FileTreeServices } from '@/shared/types.js';

const actualUtils = await import('@/shared/utils.js');
let userId: string | null = 'foreign';
let validations = 0;
let filesystemCalls = 0;
let services: FileTreeServices;
const checked: Array<{ candidate: string; user: unknown; accounts: unknown }> = [];
mock.module('@/shared/utils.js', { namedExports: {
  ...actualUtils,
  validateWorkspacePath: async (candidate: string) => { validations += 1; return { valid: true, resolvedPath: candidate }; },
} });
mock.module('@/modules/database/index.js', { namedExports: { userDb: { getActiveUserIds: () => ['owner', 'foreign'] } } });
mock.module('@/modules/workspace-runtime/index.js', { namedExports: {
  assertCloudWorkspaceOwner: (candidate: string, user: unknown, accounts: unknown) => {
    checked.push({ candidate, user, accounts });
    if (user !== 'owner') throw new AppError('Foreign cloud account', { code: 'WORKSPACE_FORBIDDEN', statusCode: 403 });
  },
} });
mock.module('@/modules/workspaces/index.js', { namedExports: {
  currentWorkspaceUserId: () => userId,
  resolveSelectedProjectPath: () => { throw new Error('Unexpected project resolution'); },
  workspaceSelectionScope: () => {},
} });
mock.module('@/modules/workspace-bridge/index.js', { namedExports: {
  bridgeFileSystem: () => ({
    realpath: async (candidate: string) => candidate,
    access: async () => { filesystemCalls += 1; },
    stat: async () => { filesystemCalls += 1; return { isDirectory: () => true }; },
    openDirectory: async function* () { filesystemCalls += 1; yield* []; },
  }),
} });
mock.module('@/modules/file-tree/file-tree.routes.js', { namedExports: {
  createFileTreeRouter: (input: FileTreeServices) => { services = input; return {}; },
} });
await import('@/modules/file-tree/file-tree.module.js');

test('production cloud chooser rejects foreign accounts before path validation and directory access', async () => {
  for (const action of [() => services.browseWorkspace('~'), () => services.createWorkspaceFolder('~/new')]) {
    await assert.rejects(action(), { code: 'WORKSPACE_FORBIDDEN', statusCode: 403 });
  }
  assert.equal(validations, 0);
  assert.equal(filesystemCalls, 0);
  assert.equal(checked.length, 2);
  assert.ok(checked.every(item => item.user === 'foreign'));
  assert.deepEqual(checked[0]!.accounts, ['owner', 'foreign']);
});

test('production cloud chooser validates both requested and resolved paths for the owning account', async () => {
  userId = 'owner';
  checked.length = 0;
  const result = await services.browseWorkspace('~');
  assert.deepEqual(result, { path: path.resolve(actualUtils.WORKSPACES_ROOT), suggestions: [] });
  assert.equal(validations, 1);
  assert.equal(checked.length, 2);
  assert.ok(checked.every(item => item.user === 'owner' && item.candidate === path.resolve(actualUtils.WORKSPACES_ROOT)));
  assert.equal(filesystemCalls, 3);
});
