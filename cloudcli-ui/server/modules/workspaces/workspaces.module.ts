import express from 'express';

import { projectsDb, sessionsDb, userDb } from '@/modules/database/index.js';
import {
  assertWorkspaceDescriptor,
  assertSshProjectOwner,
  resolveSshProjectTarget,
  describeWorkspaceSelection,
  integrateWorkspaceSession,
  isWorkspaceBound,
  workspaceRequestScope,
} from '@/modules/workspace-bridge/index.js';
import { assertCloudWorkspaceOwner, createWorkspaceRuntimeService } from '@/modules/workspace-runtime/index.js';
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

/** Shell passes its trusted handshake identity explicitly at every resolution and revalidation, without HTTP async-local state. */
export function resolveSelectedWorkspaceForUser(projectId: string, userId: string | number, selector?: WorkspaceSelector): WorkspaceDescriptor {
  if (!((typeof userId === 'string' && userId.trim() && !/[\r\n\0]/.test(userId))
    || (typeof userId === 'number' && Number.isFinite(userId)))) {
    throw new AppError('Authentication is required', { code: 'UNAUTHORIZED', statusCode: 401 });
  }
  const sourceRoot = projectsDb.getProjectPathById(projectId);
  const ssh = sourceRoot ? resolveSshProjectTarget(sourceRoot) : null;
  if (ssh) assertSshProjectOwner(ssh, userId);
  else if (sourceRoot) assertCloudWorkspaceOwner(sourceRoot, userId, userDb.getActiveUserIds());
  return catalog.resolveSelectedWorkspace(projectId, selector);
}

/** File Tree, Git and Worktrees resolve within HTTP identity scope; trusted internal callers retain their existing scope-free behavior. */
export function resolveSelectedWorkspace(projectId: string, selector?: WorkspaceSelector): WorkspaceDescriptor {
  const userId = currentWorkspaceUserId();
  const selected = selector ?? currentWorkspaceSelector() ?? undefined;
  if (userId !== null) return resolveSelectedWorkspaceForUser(projectId, userId, selected);
  const sourceRoot = projectsDb.getProjectPathById(projectId);
  if (sourceRoot && !resolveSshProjectTarget(sourceRoot)) assertCloudWorkspaceOwner(sourceRoot, null);
  return catalog.resolveSelectedWorkspace(projectId, selected);
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
      // Authorize the same project field consumed by the mounted route.
      const projectId = request.method === 'GET' ? request.query.projectId : request.body?.projectId;
      const root = typeof projectId === 'string' ? projectsDb.getProjectPathById(projectId) : null;
      const ssh = root ? resolveSshProjectTarget(root) : null;
      const userId = currentWorkspaceUserId();
      if (ssh) { assertSshProjectOwner(ssh, userId); next(); return; }
      // /resolve and integration call the catalog directly, so reject a foreign
      // known project before runtime restoration or descriptor materialization.
      if (root) assertCloudWorkspaceOwner(root, userId, userDb.getActiveUserIds());
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
