import express from 'express';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import {
  assertWorkspaceDescriptor,
  assertSshProjectOwner,
  resolveSshProjectTarget,
  describeWorkspaceSelection,
  integrateWorkspaceSession,
  isWorkspaceBound,
  workspaceRequestScope,
} from '@/modules/workspace-bridge/index.js';
import { createWorkspaceRuntimeService } from '@/modules/workspace-runtime/index.js';
import { AppError } from '@/shared/index.js';
import type { WorkspaceDescriptor, WorkspaceSelector } from '@/shared/index.js';

import { createWorkspaceCatalog } from './workspace-catalog.service.js';
import { currentWorkspaceSelector, currentWorkspaceUserId, workspaceResolutionScope, workspaceSelectionScope } from './workspace-selection-scope.js';
import { createWorkspacesRoutes } from './workspaces.routes.js';

const catalog = createWorkspaceCatalog({
  getProjectPathById: projectId => projectsDb.getProjectPathById(projectId),
  getSessionById: sessionId => sessionsDb.getSessionById(sessionId),
  getSessionsByProjectPath: projectPath => sessionsDb.getSessionsByProjectPathIncludingArchived(projectPath),
  describeWorkspaceSelection,
  assertWorkspaceDescriptor,
  isWorkspaceBound,
});

/** File Tree, Git, Worktrees and Shell resolve a durable workspace and revalidate its generation before using its root. */
export function resolveSelectedWorkspace(projectId: string, selector?: WorkspaceSelector): WorkspaceDescriptor {
  const sourceRoot = projectsDb.getProjectPathById(projectId);
  const ssh = sourceRoot ? resolveSshProjectTarget(sourceRoot) : null;
  const userId = currentWorkspaceUserId();
  if (ssh && userId !== null) assertSshProjectOwner(ssh, userId);
  return catalog.resolveSelectedWorkspace(projectId, selector ?? currentWorkspaceSelector());
}

/** File Tree and Git production gateways resolve paths only through their request's validated workspace selector. */
export function resolveSelectedProjectPath(projectId: string): string {
  return resolveSelectedWorkspace(projectId).rootPath;
}

/** The server entrypoint mounts this authenticated workspace catalog and integration API under /api/workspaces. */
export function createWorkspacesRouter() {
  const runtime = createWorkspaceRuntimeService();
  return express.Router().use(workspaceRequestScope, (request, response, next) => {
    const scope = request.method === 'GET' && request.path === '/resolve' ? workspaceResolutionScope : workspaceSelectionScope;
    scope(request, response, next);
  }, (request, _response, next) => {
    try {
      const projectId = typeof request.query.projectId === 'string' ? request.query.projectId : request.body?.projectId;
      const root = typeof projectId === 'string' ? projectsDb.getProjectPathById(projectId) : null;
      const ssh = root ? resolveSshProjectTarget(root) : null;
      if (ssh) { assertSshProjectOwner(ssh, currentWorkspaceUserId()); next(); return; }
    } catch (error) { next(error); return; }
    if (process.platform !== 'linux' || !process.env.WORKSPACES_ROOT) { next(); return; }
    const user = (request as express.Request & { user?: { id?: number | string } }).user;
    if (!user?.id) { next(new AppError('Authentication is required', { code: 'UNAUTHORIZED', statusCode: 401 })); return; }
    // Resolution is the cloud entry point and retries a failed startup restore.
    // No caller may fall back to a host workspace while account isolation is unavailable.
    void runtime.restore(String(user.id)).then(() => next(), next);
  }, createWorkspacesRoutes({
    catalog,
    integrate: integrateWorkspaceSession,
    runProjectAction: async (projectId, actionId) => {
      // Load the execution adapter only when an action actually runs; this
      // keeps ordinary workspace resolution free of provider/SSH execution
      // imports and lets composition tests replace the database module.
      const { executeProjectAction, projectActionsService } = await import('@/modules/projects/index.js');
      // Resolution pins the exact project generation; execution never falls
      // back to the metadata anchor or another workspace.
      const descriptor = resolveSelectedWorkspace(projectId);
      const action = projectActionsService.get(projectId, actionId);
      return executeProjectAction(descriptor, action);
    },
  }));
}
