import { access } from 'node:fs/promises';

import { projectsDb } from '@/modules/database/index.js';
import { isWorkspaceBindingRoot, withWorkspaceMutation } from '@/modules/workspace-bridge/index.js';
import {
  createProject,
  deleteOrArchiveProject,
  restoreArchivedProject,
} from '@/modules/projects/index.js';
import type {
  WorktreeFileSystem,
  WorktreeProjectGateway,
  WorktreeServices,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';
import { createWorktree } from '@/modules/worktrees/services/worktree-create.service.js';
import { createAndOpenWorktree } from '@/modules/worktrees/services/worktree-create-and-open.service.js';
import { listWorktreePorcelainEntries, runGitCommand } from '@/modules/worktrees/services/worktree-git.service.js';
import { listWorktrees } from '@/modules/worktrees/services/worktree-list.service.js';
import { mergeWorktree } from '@/modules/worktrees/services/worktree-merge.service.js';
import { openWorktreeAsProject } from '@/modules/worktrees/services/worktree-open.service.js';
import { removeWorktree } from '@/modules/worktrees/services/worktree-remove.service.js';
import { createWorktreesRouter } from '@/modules/worktrees/worktrees.routes.js';

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

const remove: WorktreeServices['remove'] = (input) => removeWorktree(input, {
  runGit: runGitCommand,
  projects: worktreeProjects,
});

const create: WorktreeServices['create'] = (input) => createWorktree(input, {
  runGit: runGitCommand,
  fileSystem: worktreeFileSystem,
});

const open: WorktreeServices['open'] = (input) => openWorktreeAsProject(input, {
  runGit: runGitCommand,
  projects: worktreeProjects,
});

// Git metadata belongs to the main worktree even when the selected project is
// a linked worktree. A merge/removal must also reserve its source directory.
async function mutateWorktree<T>(input: { projectPath: string; worktreePath?: string }, operation: () => Promise<T>, removesSource = false): Promise<T> {
  const entries = await listWorktreePorcelainEntries(input.projectPath, runGitCommand);
  const roots = [entries[0].path, input.projectPath, ...(input.worktreePath ? [input.worktreePath] : [])];
  return withWorkspaceMutation(roots, () => {
    // Removing an independently synchronized root would destroy its capability
    // before handback. Unbind it explicitly; ordinary linked worktrees keep the
    // existing removal path, and a merge without removal remains available.
    if (removesSource && input.worktreePath && isWorkspaceBindingRoot(input.worktreePath)) {
      throw new AppError('此 worktree 仍有独立工作区绑定，请先解除绑定再删除；也可以仅合并并保留 worktree。', {
        code: 'WORKTREE_BINDING_ACTIVE', statusCode: 409,
      });
    }
    return operation();
  });
}

/**
 * Production Worktrees application-service surface.
 *
 * This is the module's composition root: it is the only location that combines
 * concrete adapters with the independently testable workflow functions.
 */
const worktreeServices: WorktreeServices = {
  resolveProjectPath(projectId) {
    const projectPath = worktreeProjects.getProjectPathById(projectId);
    if (!projectPath) {
      throw new AppError(`Unable to resolve project path for "${projectId}"`, {
        code: 'PROJECT_NOT_FOUND',
        statusCode: 404,
      });
    }

    return projectPath;
  },
  list: (input) => listWorktrees(input, {
    runGit: runGitCommand,
    getProjectByPath: worktreeProjects.getProjectByPath,
  }),
  create: (input) => mutateWorktree(input, () => create(input)),
  createAndOpen: (input) => mutateWorktree(input, () => createAndOpenWorktree(input, {
    createWorktree: create,
    openWorktree: open,
    removeWorktree: remove,
  })),
  open,
  merge: (input) => mutateWorktree(input, () => mergeWorktree(input, {
    runGit: runGitCommand,
    removeWorktree: remove,
  }), Boolean(input.removeAfterMerge)),
  remove: (input) => mutateWorktree(input, () => remove(input), true),
};

/**
 * Worktrees router mounted by the server entrypoint at `/api/worktrees`.
 *
 * It is assembled here so other modules consume only the Worktrees barrel and
 * cannot depend on route or service implementation files.
 */
export const worktreesRoutes = createWorktreesRouter(worktreeServices);
