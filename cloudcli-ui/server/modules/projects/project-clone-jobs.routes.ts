import express from 'express';

import { userDb } from '@/modules/database/index.js';
import { assertCloudWorkspaceOwner } from '@/modules/workspace-runtime/index.js';
import { AppError } from '@/shared/index.js';

import { projectCloneJobsService } from './services/project-clone-jobs.service.js';

const router = express.Router();

function owner(request: express.Request): string {
  const user = (request as express.Request & { user?: { id?: unknown; userId?: unknown } }).user;
  const id = user?.id ?? user?.userId;
  if ((typeof id !== 'string' && typeof id !== 'number') || !/^\d+$/.test(String(id)) || !Number.isSafeInteger(Number(id)) || Number(id) <= 0) {
    throw new AppError('Authenticated user is required', { code: 'AUTHENTICATION_REQUIRED', statusCode: 401 });
  }
  return String(id);
}

function respondError(response: express.Response, error: unknown): void {
  const known = error instanceof AppError;
  response.status(known ? error.statusCode : 500).json({ error: known ? error.message : 'Clone job request failed', code: known ? error.code : 'CLONE_JOB_REQUEST_FAILED' });
}

router.post('/clone-jobs', async (request, response) => {
  try {
    const userId = owner(request);
    const body = request.body as Record<string, unknown> | undefined;
    const workspacePath = typeof body?.path === 'string' ? body.path.trim() : '';
    const githubUrl = typeof body?.githubUrl === 'string' ? body.githubUrl.trim() : '';
    const requestId = typeof body?.requestId === 'string' ? body.requestId : '';
    if (!workspacePath || workspacePath.length > 4096 || !githubUrl || githubUrl.length > 4096) throw new AppError('path and githubUrl are required and must be at most 4096 characters', { code: 'INVALID_CLONE_INPUT', statusCode: 400 });
    const rawTokenId = body?.githubTokenId;
    if (rawTokenId != null && ((typeof rawTokenId !== 'number' && typeof rawTokenId !== 'string') || !/^\d+$/.test(String(rawTokenId)) || !Number.isSafeInteger(Number(rawTokenId)) || Number(rawTokenId) <= 0)) throw new AppError('githubTokenId must be a positive integer', { code: 'INVALID_GITHUB_TOKEN_ID', statusCode: 400 });
    if (body?.newGithubToken != null && (typeof body.newGithubToken !== 'string' || body.newGithubToken.length > 4096)) throw new AppError('newGithubToken must be a string of at most 4096 characters', { code: 'INVALID_GITHUB_TOKEN', statusCode: 400 });
    // Check the raw requested parent before any job is accepted; the service also
    // rechecks raw/canonical parent and child at mutation and registration boundaries.
    assertCloudWorkspaceOwner(workspacePath, userId, userDb.getActiveUserIds());
    const snapshot = await projectCloneJobsService.create({ workspacePath, githubUrl, requestId, userId, githubTokenId: rawTokenId == null ? null : Number(rawTokenId), newGithubToken: typeof body?.newGithubToken === 'string' ? body.newGithubToken : null });
    response.status(snapshot.status === 'running' ? 202 : 200).json(snapshot);
  } catch (error) { respondError(response, error); }
});

router.get('/clone-jobs/:id', (request, response) => {
  try { response.json(projectCloneJobsService.get(String(request.params.id), owner(request))); }
  catch (error) { respondError(response, error); }
});

router.delete('/clone-jobs/by-request/:requestId', async (request, response) => {
  try { response.json(await projectCloneJobsService.cancelRequest(String(request.params.requestId), owner(request))); }
  catch (error) { respondError(response, error); }
});

router.delete('/clone-jobs/:id', async (request, response) => {
  try { response.json(await projectCloneJobsService.cancel(String(request.params.id), owner(request))); }
  catch (error) { respondError(response, error); }
});

// Server composition mounts this Projects gateway at /api/projects; observation never owns execution.
export default router;
