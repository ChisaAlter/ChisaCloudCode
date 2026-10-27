import { access, lstat } from 'node:fs/promises';
import path from 'node:path';

import { projectsDb } from '@/modules/database/index.js';
import { withWorkspaceWriteOperation } from '@/modules/workspace-bridge/index.js';
import { resolveSelectedWorkspace, workspaceSelectionScope } from '@/modules/workspaces/index.js';
import {
  createProject,
  deleteOrArchiveProject,
  restoreArchivedProject,
} from '@/modules/projects/index.js';
import type {
  WorktreeFileSystem,
  WorktreeProjectGateway,
  WorktreeServices,
} from '@/shared/index.js';
import { AppError } from '@/shared/index.js';
import { createWorktree } from '@/modules/worktrees/services/worktree-create.service.js';
import { createAndOpenWorktree } from '@/modules/worktrees/services/worktree-create-and-open.service.js';
import { listWorktrees } from '@/modules/worktrees/services/worktree-list.service.js';
import { mergeWorktree } from '@/modules/worktrees/services/worktree-merge.service.js';
import { openWorktreeAsProject } from '@/modules/worktrees/services/worktree-open.service.js';
import { removeWorktree } from '@/modules/worktrees/services/worktree-remove.service.js';
import { createWorktreesRouter } from '@/modules/worktrees/worktrees.routes.js';

import { listWorktreePorcelainEntries, runGitCommand } from './services/worktree-git.service.js';
import { createWorktreeManagementServices } from './services/worktree-management.service.js';

/**
 * Real filesystem adapter used only by Worktrees production composition.
 *
 * Services depend on the shared capability type and therefore cannot touch a
 * developer's filesystem unless this adapter is explicitly supplied.
 */
const worktreeFileSystem: WorktreeFileSystem = {
  async pathExists(candidatePath: string): Promise<boolean> {
    try {
      await access(candidatePath);
      return true;
    } catch {
      return false;
    }
  },
};

/**
 * Projects boundary for Worktrees production workflows.
 *
 * Imports are deliberately restricted to the Database and Projects barrel
 * files. No Worktrees service knows which repository or project service backs
 * these operations.
 */
const worktreeProjects: WorktreeProjectGateway = {
  getProjectPathById: (projectId) => projectsDb.getProjectPathById(projectId),
  getProjectByPath: (projectPath) => projectsDb.getProjectPath(projectPath),
  createProject: (input) => createProject(input),
  restoreProject: (projectId) => restoreArchivedProject(projectId),
  archiveProject: (projectId) => deleteOrArchiveProject(projectId, false),
};

async function withRepositoryWrite<T>(projectPath: string, operation: () => Promise<T>): Promise<T> {
  const entries = await listWorktreePorcelainEntries(projectPath, runGitCommand);
  const repositoryRoot = entries[0]?.path;
  if (!repositoryRoot) throw new AppError('The main worktree could not be resolved', { code: 'WORKTREE_LIST_EMPTY', statusCode: 409 });
  // A retained project can be selected in the sidebar while merge writes the
  // main worktree. Reserve that actual destination, then the selected root.
  return withWorkspaceWriteOperation(repositoryRoot, () => withWorkspaceWriteOperation(projectPath, async () => {
    const current = await listWorktreePorcelainEntries(projectPath, runGitCommand);
    if (current[0]?.path !== repositoryRoot) throw new AppError('The worktree repository changed before admission', { code: 'WORKSPACE_WORKTREE_CONFLICT', statusCode: 409 });
    return operation();
  }));
}

const remove: WorktreeServices['remove'] = (input) => withRepositoryWrite(input.projectPath, () => withWorkspaceWriteOperation(input.worktreePath, () => removeWorktree(input, {
  runGit: runGitCommand,
  projects: worktreeProjects,
})));

const create: WorktreeServices['create'] = (input) => withRepositoryWrite(input.projectPath, () => createWorktree(input, {
  runGit: runGitCommand,
  fileSystem: worktreeFileSystem,
}));

const open: WorktreeServices['open'] = (input) => openWorktreeAsProject(input, {
  runGit: runGitCommand,
  projects: worktreeProjects,
});

/**
 * Production Worktrees application-service surface.
 *
 * This is the module's composition root: it is the only location that combines
 * concrete adapters with the independently testable workflow functions.
 */
const worktreeServices: WorktreeServices = {
  resolveProjectPath(projectId) {
    const descriptor = resolveSelectedWorkspace(projectId);
    if (descriptor.sourceMode === 'ssh') throw new AppError('SSH 本地项目暂不支持会话 worktree 管理。', { code: 'SSH_WORKSPACE_UNSUPPORTED', statusCode: 409 });
    if (descriptor.kind !== 'cloudReplica') {
      throw new AppError('Worktree management requires the project replica; integrate session changes through the workspace API', {
        code: 'WORKSPACE_REPLICA_REQUIRED',
        statusCode: 409,
      });
    }
    return descriptor.rootPath;
  },
  list: (input) => listWorktrees(input, {
    runGit: runGitCommand,
    getProjectByPath: worktreeProjects.getProjectByPath,
  }),
  create,
  createAndOpen: (input) => createAndOpenWorktree(input, {
    createWorktree: create,
    openWorktree: open,
    removeWorktree: remove,
  }),
  open,
  merge: (input) => withRepositoryWrite(input.projectPath, () => withWorkspaceWriteOperation(input.worktreePath, () => mergeWorktree(input, {
    runGit: runGitCommand,
    removeWorktree: remove,
  }))),
  remove,
};

/**
 * Worktrees router mounted by the server entrypoint at `/api/worktrees`.
 *
 * It is assembled here so other modules consume only the Worktrees barrel and
 * cannot depend on route or service implementation files.
 */
export const worktreesRoutes = createWorktreesRouter(createWorktreeManagementServices(worktreeServices, async rootPath => {
  try {
    // Presence is sufficient, including damaged metadata and dangling symlinks:
    // an ordinary worktree route cannot authorize recovery of a private root.
    await lstat(path.join(rootPath, '.chisa-session.json'));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}), workspaceSelectionScope);
