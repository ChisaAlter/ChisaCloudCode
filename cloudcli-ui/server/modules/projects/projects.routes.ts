import express from 'express';

import { userDb } from '@/modules/database/index.js';
import { assertCloudWorkspaceOwner } from '@/modules/workspace-runtime/index.js';
import { createProject, updateProjectDisplayName } from '@/modules/projects/services/project-management.service.js';
import { createSshProject } from '@/modules/projects/services/ssh-project-management.service.js';
import { assertProjectSshAccess } from '@/modules/projects/services/project-ssh-access.service.js';
import { registerExistingProjectPaths } from '@/modules/projects/services/legacy-project-registration.service.js';
import { startCloneProject } from '@/modules/projects/services/project-clone.service.js';
import { getProjectTaskMaster } from '@/modules/projects/services/projects-has-taskmaster.service.js';
import { projectSettingsService } from '@/modules/projects/services/project-settings.service.js';
import { projectContextService } from '@/modules/projects/services/project-context.service.js';
import { getCurrentProjectRuntimeManifest, getCurrentProjectMemory, saveCurrentProjectMemory } from '@/modules/projects/services/project-runtime-context.service.js';
import { projectActionsService } from '@/modules/projects/services/project-actions.service.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';
import { getArchivedProjectsWithSessions, getProjectSessionsPage, getProjectsWithSessions } from '@/modules/projects/services/projects-with-sessions-fetch.service.js';
import { deleteOrArchiveProject, restoreArchivedProject } from '@/modules/projects/services/project-delete.service.js';
import { applyLegacyStarredProjectIds, toggleProjectStar } from '@/modules/projects/services/project-star.service.js';

const router = express.Router();

type AuthenticatedUser = {
  id?: number | string;
  userId?: number | string;
};

function authenticatedOwner(request: express.Request): string {
  const user = (request as express.Request & { user?: AuthenticatedUser }).user;
  const id = user?.id ?? user?.userId;
  return id === undefined || id === null ? '' : String(id);
}

function readQueryStringValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value) && typeof value[0] === 'string') {
    return value[0];
  }

  return '';
}

function readOptionalNumericQueryValue(value: unknown): number | null {
  const rawValue = readQueryStringValue(value).trim();
  if (!rawValue) {
    return null;
  }

  const parsedValue = Number.parseInt(rawValue, 10);
  return Number.isNaN(parsedValue) ? null : parsedValue;
}

function parseNonNegativeIntQuery(value: unknown, name: string, fallback: number): number {
  const rawValue = readQueryStringValue(value).trim();
  if (!rawValue) {
    return fallback;
  }

  const parsedValue = Number.parseInt(rawValue, 10);
  if (Number.isNaN(parsedValue) || parsedValue < 0) {
    throw new AppError(`${name} must be a non-negative integer`, {
      code: 'INVALID_QUERY_PARAMETER',
      statusCode: 400,
    });
  }

  return parsedValue;
}

function resolveRouteErrorMessage(error: unknown): string {
  if (error instanceof AppError) {
    return error.message;
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return 'Failed to clone repository';
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const skipSynchronization =
      readQueryStringValue(req.query.skipSynchronization).trim() === '1' ||
      readQueryStringValue(req.query.skipSync).trim() === '1';
    const sessionsLimit = readOptionalNumericQueryValue(req.query.sessionsLimit) ?? undefined;
    const sessionsOffset = readOptionalNumericQueryValue(req.query.sessionsOffset) ?? undefined;
    const projects = await getProjectsWithSessions({
      userId: authenticatedOwner(req),
      skipSynchronization,
      sessionsLimit,
      sessionsOffset,
    });
    res.json(projects);
  }),
);

router.get(
  '/archived',
  asyncHandler(async (req, res) => {
    const projects = await getArchivedProjectsWithSessions({ userId: authenticatedOwner(req) });
    res.json(createApiSuccessResponse({ projects }));
  }),
);

router.get(
  '/:projectId/sessions',
  asyncHandler(async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    const limit = parseNonNegativeIntQuery(req.query.limit, 'limit', 20);
    const offset = parseNonNegativeIntQuery(req.query.offset, 'offset', 0);
    const sessionsPage = await getProjectSessionsPage(projectId, { limit, offset, userId: authenticatedOwner(req) });
    res.json(sessionsPage);
  }),
);

router.post(
  '/create-project',
  asyncHandler(async (req, res) => {
    const requestBody = req.body as Record<string, unknown>;
    const projectPath = typeof requestBody.path === 'string' ? requestBody.path : '';
    const customName = typeof requestBody.customName === 'string' ? requestBody.customName : null;

    if (requestBody.workspaceType !== undefined) {
      throw new AppError('workspaceType is no longer supported. Use the single create-project flow.', {
        code: 'LEGACY_WORKSPACE_TYPE_UNSUPPORTED',
        statusCode: 400,
      });
    }

    if (requestBody.githubUrl || requestBody.githubTokenId || requestBody.newGithubToken) {
      throw new AppError('Repository cloning is not supported on create-project', {
        code: 'CLONE_NOT_SUPPORTED_ON_CREATE_PROJECT',
        statusCode: 400,
        details: 'Use /api/projects/clone-progress for cloning workflows',
      });
    }

    if (requestBody.sourceMode !== undefined && requestBody.sourceMode !== 'cloud' && requestBody.sourceMode !== 'ssh') {
      throw new AppError('sourceMode must be cloud or ssh', { code: 'INVALID_PROJECT_SOURCE_MODE', statusCode: 400 });
    }
    if (requestBody.sourceMode !== 'ssh') assertCloudWorkspaceOwner(projectPath, authenticatedOwner(req), userDb.getActiveUserIds());
    const projectCreationResult = requestBody.sourceMode === 'ssh'
      ? await createSshProject({
        ownerId: authenticatedOwner(req),
        connectionId: typeof requestBody.connectionId === 'string' ? requestBody.connectionId : '',
        rootPath: typeof requestBody.rootPath === 'string' ? requestBody.rootPath : '',
        customName,
      })
      : await createProject({ projectPath, customName });

    res.json({
      success: true,
      project: projectCreationResult.project,
      ...(requestBody.sourceMode === 'ssh' ? { outcome: projectCreationResult.outcome } : {}),
      message:
        projectCreationResult.outcome === 'reactivated_archived'
          ? 'Archived project path reused successfully'
          : projectCreationResult.outcome === 'existing' ? 'Existing project opened successfully' : 'Project created successfully',
    });
  }),
);

/**
 * Idempotent migration for synchronization-era projects: register workspace paths
 * that already exist on the account volume so the old serverPath keeps its entry
 * and its session history (sessions are stored per project path). It never
 * creates a directory, clones a repository or uploads files, and an absent path
 * is reported as rejected instead of being materialized.
 */
router.post(
  '/register-existing',
  asyncHandler(async (req, res) => {
    const requestBody = req.body as Record<string, unknown>;
    const { results } = await registerExistingProjectPaths(requestBody?.paths);
    res.json({ success: true, results });
  }),
);

/**
 * One-time (or idempotent) migration: apply legacy `localStorage` starred projectIds to the DB, then clear client storage.
 */
router.post(
  '/migrate-legacy-stars',
  asyncHandler(async (req, res) => {
    const projectIds = Array.isArray((req.body as { projectIds?: unknown })?.projectIds)
      ? ((req.body as { projectIds: unknown[] }).projectIds as unknown[]).map((x) => String(x))
      : [];
    const { updated } = applyLegacyStarredProjectIds(projectIds);
    res.json({ success: true, updated });
  }),
);

router.get('/clone-progress', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendEvent = (type: string, data: Record<string, unknown>) => {
    if (res.writableEnded) {
      return;
    }

    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  let cloneOperation: Awaited<ReturnType<typeof startCloneProject>> | null = null;
  const closeListener = () => {
    cloneOperation?.cancel();
  };
  req.on('close', closeListener);

  try {
    const queryParams = req.query as Record<string, unknown>;
    const workspacePath = readQueryStringValue(queryParams.path);
    const githubUrl = readQueryStringValue(queryParams.githubUrl);
    const githubTokenId = readOptionalNumericQueryValue(queryParams.githubTokenId);
    const newGithubToken = readQueryStringValue(queryParams.newGithubToken) || null;

    const authenticatedUser = (req as typeof req & { user?: AuthenticatedUser }).user;
    const userId = authenticatedUser?.id;
    if (userId === undefined || userId === null) {
      throw new AppError('Authenticated user is required', {
        code: 'AUTHENTICATION_REQUIRED',
        statusCode: 401,
      });
    }

    cloneOperation = await startCloneProject(
      {
        workspacePath,
        githubUrl,
        githubTokenId,
        newGithubToken,
        userId,
      },
      {
        onProgress: (message) => {
          sendEvent('progress', { message });
        },
        onComplete: ({ project, message }) => {
          sendEvent('complete', { project, message });
        },
      },
    );

    await cloneOperation.waitForCompletion;
  } catch (error) {
    sendEvent('error', { message: resolveRouteErrorMessage(error) });
  } finally {
    req.off('close', closeListener);
    if (!res.writableEnded) {
      res.end();
    }
  }
});

router.get(
  '/:projectId/taskmaster',
  asyncHandler(async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    assertProjectSshAccess(projectId, authenticatedOwner(req));
    const taskMasterDetails = await getProjectTaskMaster(projectId);
    res.json(taskMasterDetails);
  }),
);

router.get(
  '/:projectId/actions',
  asyncHandler(async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    assertProjectSshAccess(projectId, authenticatedOwner(req));
    res.json(createApiSuccessResponse({ actions: projectActionsService.list(projectId) }));
  }),
);

router.post(
  '/:projectId/actions',
  asyncHandler(async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    assertProjectSshAccess(projectId, authenticatedOwner(req));
    res.status(201).json(createApiSuccessResponse({ action: projectActionsService.create(projectId, req.body) }));
  }),
);

router.put(
  '/:projectId/actions/:actionId',
  asyncHandler(async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    const actionId = typeof req.params.actionId === 'string' ? req.params.actionId : '';
    assertProjectSshAccess(projectId, authenticatedOwner(req));
    res.json(createApiSuccessResponse({ action: projectActionsService.update(projectId, actionId, req.body) }));
  }),
);

router.delete(
  '/:projectId/actions/:actionId',
  asyncHandler(async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    const actionId = typeof req.params.actionId === 'string' ? req.params.actionId : '';
    assertProjectSshAccess(projectId, authenticatedOwner(req));
    projectActionsService.remove(projectId, actionId);
    res.json(createApiSuccessResponse({ removed: true }));
  }),
);

router.get(
  '/:projectId/context',
  asyncHandler(async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    assertProjectSshAccess(projectId, authenticatedOwner(req));
    res.json(createApiSuccessResponse({ ...projectContextService.get(projectId), runtimeManifest: getCurrentProjectRuntimeManifest(authenticatedOwner(req), projectId) }));
  }),
);

router.get(
  '/:projectId/memory',
  asyncHandler(async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    res.json(createApiSuccessResponse(getCurrentProjectMemory(authenticatedOwner(req), projectId)));
  }),
);

router.put(
  '/:projectId/memory',
  asyncHandler(async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    const body = req.body as { content?: unknown; expectedHash?: unknown };
    if (typeof body.content !== 'string' || typeof body.expectedHash !== 'string') {
      throw new AppError('Memory content and its last-read hash are required.', { code: 'PROJECT_MEMORY_INVALID', statusCode: 400 });
    }
    res.json(createApiSuccessResponse(saveCurrentProjectMemory(authenticatedOwner(req), projectId, body.content, body.expectedHash)));
  }),
);

router.get(
  '/:projectId/settings',
  asyncHandler(async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    assertProjectSshAccess(projectId, authenticatedOwner(req));
    res.json(createApiSuccessResponse(projectSettingsService.get(projectId)));
  }),
);

router.put(
  '/:projectId/settings',
  asyncHandler(async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    assertProjectSshAccess(projectId, authenticatedOwner(req));
    res.json(createApiSuccessResponse(projectSettingsService.save(projectId, req.body)));
  }),
);

router.delete(
  '/:projectId/settings',
  asyncHandler(async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    assertProjectSshAccess(projectId, authenticatedOwner(req));
    res.json(createApiSuccessResponse(projectSettingsService.clear(projectId)));
  }),
);

router.put('/:projectId/rename', (req, res) => {
  try {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    const { displayName } = req.body as { displayName?: unknown };
    assertProjectSshAccess(projectId, authenticatedOwner(req));
    updateProjectDisplayName(projectId, displayName);
    res.json({ success: true });
  } catch (error) {
    res.status(error instanceof AppError ? error.statusCode : 500).json({ error: error instanceof Error ? error.message : 'Failed to rename project' });
  }
});

router.post(
  '/:projectId/toggle-star',
  asyncHandler(async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    assertProjectSshAccess(projectId, authenticatedOwner(req));
    const { isStarred } = toggleProjectStar(projectId);
    res.json({ success: true, isStarred });
  }),
);

router.post(
  '/:projectId/restore',
  asyncHandler(async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    assertProjectSshAccess(projectId, authenticatedOwner(req));
    restoreArchivedProject(projectId);
    res.json(createApiSuccessResponse({ projectId, isArchived: false }));
  }),
);

/**
 * - `force` not set / false: archive project in DB only (`isArchived` = 1; hidden from active list).
 * - `force=true`: remove DB row, delete session rows for that path, remove all `*.jsonl` under the Claude project dir.
 */
router.delete(
  '/:projectId',
  asyncHandler(async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    const force = req.query.force === 'true';
    assertProjectSshAccess(projectId, authenticatedOwner(req));
    await deleteOrArchiveProject(projectId, force);
    res.json({ success: true });
  }),
);

export default router;
