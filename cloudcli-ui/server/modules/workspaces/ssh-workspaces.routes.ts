import express from 'express';

import { agentConnectionService, agentRelayBroker, listSshConnections } from '@/modules/ssh-workspaces/index.js';
import { probeSshProjectDirectory } from '@/modules/projects/index.js';
import { assertSshProjectOwner, recoverSshWorkspace, resolveSshProjectTarget } from '@/modules/workspace-bridge/index.js';
import { projectsDb } from '@/modules/database/index.js';
import { AppError, asyncHandler } from '@/shared/index.js';

function owner(request: express.Request): string {
  const user = (request as express.Request & { user?: { id?: string | number; userId?: string | number } }).user;
  const id = user?.id ?? user?.userId;
  if (id === undefined || id === null) throw new AppError('Authentication is required.', { code: 'UNAUTHORIZED', statusCode: 401 });
  return String(id);
}
function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048 || value.includes('\0')) throw new AppError(`${field} is required.`, { code: 'INVALID_REQUEST', statusCode: 400 });
  return value;
}

/** Server entrypoint mounts this authenticated SSH catalog/probe/recovery API without exposing private connection credentials. */
export function createSshWorkspacesRouter(): express.Router {
  const router = express.Router();
  router.get('/connections', asyncHandler(async (request, response) => {
    const connections = await listSshConnections(owner(request));
    response.json({ connections, configured: connections.length > 0 });
  }));
  router.post('/agent/connections', asyncHandler(async (request, response) => {
    const account = owner(request);
    const previous = agentConnectionService.list(account).find(item => item.id === request.body?.id);
    const connection = agentConnectionService.upsert(account, request.body);
    if (previous && (previous.token !== connection.token || previous.delivery !== connection.delivery)) agentRelayBroker.invalidate(account, connection.id);
    response.json({ ok: true, connection: {
      id: connection.id, name: connection.name, port: connection.port,
      createdAt: connection.createdAt, updatedAt: connection.updatedAt, transport: 'agent', delivery: connection.delivery,
    } });
  }));
  router.delete('/agent/connections/:connectionId', asyncHandler(async (request, response) => {
    const account = owner(request), id = String(request.params.connectionId ?? '');
    agentConnectionService.remove(account, id);
    agentRelayBroker.invalidate(account, id);
    response.json({ ok: true });
  }));
  router.get('/agent/relay/poll', asyncHandler(async (request, response) => {
    const controller = new AbortController();
    const cancel = () => { if (!response.writableEnded) controller.abort(); };
    response.once('close', cancel);
    try {
      const result = await agentRelayBroker.poll(owner(request), text(request.query.connectionId, 'connectionId'),
        request.get('X-Chisa-Agent-Token') ?? '', controller.signal, request.query.wait === '0' ? 0 : 25_000);
      if (!response.destroyed) response.set('Cache-Control', 'no-store').json(result);
    } finally { response.removeListener('close', cancel); }
  }));
  router.post('/agent/relay/result', asyncHandler(async (request, response) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    response.set('Cache-Control', 'no-store').json(agentRelayBroker.settle(owner(request), text(body.connectionId, 'connectionId'),
      request.get('X-Chisa-Agent-Token') ?? '', body.requestId, body.response));
  }));
  router.post('/probe', asyncHandler(async (request, response) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const result = await probeSshProjectDirectory({ connectionId: text(body.connectionId, 'connectionId'), rootPath: text(body.rootPath, 'rootPath'), ownerId: owner(request) });
    response.json(result);
  }));
  router.post('/recover', asyncHandler(async (request, response) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const root = projectsDb.getProjectPathById(text(body.projectId, 'projectId'));
    const target = root ? resolveSshProjectTarget(root) : null;
    if (!target) throw new AppError('SSH project was not found.', { code: 'SSH_WORKSPACE_NOT_FOUND', statusCode: 404 });
    assertSshProjectOwner(target, owner(request));
    if (body.generation !== target.generation) throw new AppError('SSH workspace changed.', { code: 'WORKSPACE_GENERATION_CHANGED', statusCode: 409 });
    response.json(await recoverSshWorkspace(target, body.cancel === true));
  }));
  return router;
}
