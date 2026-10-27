import express from 'express';
import type { RequestHandler } from 'express';

import type { integrateWorkspaceSession } from '@/modules/workspace-bridge/index.js';
import { AppError } from '@/shared/index.js';
import type { WorkspaceSelector } from '@/shared/index.js';

import type { createWorkspaceCatalog } from './workspace-catalog.service.js';

type WorkspacesRouteDependencies = {
  catalog: ReturnType<typeof createWorkspaceCatalog>;
  integrate(input: Parameters<typeof integrateWorkspaceSession>[0]): Promise<unknown>;
  runProjectAction(projectId: string, actionId: string): Promise<unknown>;
};

function readString(value: unknown, field: string, required = false): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new AppError(`${field} must be a nonempty string`, { code: 'INVALID_WORKSPACE_REQUEST', statusCode: 400 });
  }
  return value;
}

function route(operation: RequestHandler): RequestHandler {
  return (request, response, next) => {
    void Promise.resolve().then(() => operation(request, response, next)).catch(next);
  };
}

/** Workspaces composition and transport tests use a router with an injected durable catalog and integration service. */
export function createWorkspacesRoutes(dependencies: WorkspacesRouteDependencies): express.Router {
  const router = express.Router();
  router.get('/resolve', route((request, response) => {
    const projectId = readString(request.query.projectId, 'projectId', true)!;
    const sessionId = readString(request.query.sessionId, 'sessionId');
    response.json(dependencies.catalog.resolve(projectId, sessionId));
  }));

  router.post('/actions/run', route(async (request, response) => {
    const body = request.body as Record<string, unknown> | undefined;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new AppError('A project action request body is required', { code: 'INVALID_PROJECT_ACTION', statusCode: 400 });
    }
    const projectId = readString(body.projectId, 'projectId', true)!;
    const actionId = readString(body.actionId, 'actionId', true)!;
    response.json(await dependencies.runProjectAction(projectId, actionId));
  }));

  for (const action of ['preview', 'apply', 'recover'] as const) {
    router.post(`/integration/${action}`, route(async (request, response) => {
      const body = request.body as Record<string, unknown> | undefined;
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new AppError('An integration request body is required', { code: 'INVALID_WORKSPACE_REQUEST', statusCode: 400 });
      }
      if (['descriptor', 'rootPath', 'sourceRoot', 'targetRoot', 'executionRoot', 'stateRoot'].some(key => body[key] !== undefined)) {
        throw new AppError('Workspace paths and descriptors are resolved by the server', { code: 'INVALID_WORKSPACE_REQUEST', statusCode: 400 });
      }
      const projectId = readString(body.projectId, 'projectId', true)!;
      const selector: WorkspaceSelector = {
        workspaceId: readString(body.workspaceId, 'workspaceId', true)!,
        generation: readString(body.generation, 'generation', true)!,
        ...(body.sessionId === undefined ? {} : { sessionId: readString(body.sessionId, 'sessionId', true)! }),
      };
      for (const key of ['workspaceId', 'generation', 'sessionId'] as const) {
        const queryValue = readString(request.query[key], key);
        if (queryValue !== undefined && queryValue !== selector[key]) {
          throw new AppError(`The query and body disagree on ${key}`, { code: 'INVALID_WORKSPACE_SELECTOR', statusCode: 400 });
        }
      }
      const previewId = readString(body.previewId, 'previewId', action === 'apply');
      const expectedSourceRevision = readString(body.expectedSourceRevision, 'expectedSourceRevision', action === 'apply');
      const expectedTargetRevision = readString(body.expectedTargetRevision, 'expectedTargetRevision', action === 'apply');
      const operationId = readString(body.operationId, 'operationId', action === 'apply');
      if (operationId && operationId.length > 256) {
        throw new AppError('operationId must not exceed 256 characters', { code: 'INVALID_WORKSPACE_REQUEST', statusCode: 400 });
      }
      const descriptor = dependencies.catalog.resolveSelectedWorkspace(projectId, selector);
      if (descriptor.kind !== 'session' || !descriptor.sessionId) {
        throw new AppError('Integration requires a materialized session workspace', { code: 'WORKSPACE_SESSION_REQUIRED', statusCode: 409 });
      }
      response.json(await dependencies.integrate({
        descriptor, action,
        ...(previewId === undefined ? {} : { previewId }),
        ...(expectedSourceRevision === undefined ? {} : { expectedSourceRevision }),
        ...(expectedTargetRevision === undefined ? {} : { expectedTargetRevision }),
        ...(operationId === undefined ? {} : { operationId }),
      }));
    }));
  }
  return router;
}
