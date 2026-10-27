import { AsyncLocalStorage } from 'node:async_hooks';

import type { Request, RequestHandler } from 'express';

import { AppError } from '@/shared/index.js';
import type { WorkspaceSelector } from '@/shared/index.js';

type SelectionFields = { workspaceId?: string; generation?: string; sessionId?: string };
type SelectionScope = { readSelector(): WorkspaceSelector | null; userId: string | number | null };

const scopes = new AsyncLocalStorage<SelectionScope>();

function invalidSelector(message: string): AppError {
  return new AppError(message, { code: 'INVALID_WORKSPACE_SELECTOR', statusCode: 400 });
}

function readFields(input: unknown): SelectionFields {
  const record = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {};
  const fields: SelectionFields = {};
  for (const key of ['workspaceId', 'generation', 'sessionId'] as const) {
    if (record[key] === undefined) continue;
    const value = record[key];
    if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
      throw invalidSelector(`${key} must be a nonempty string`);
    }
    fields[key] = value;
  }
  return fields;
}

function combineFields(query: SelectionFields, body: SelectionFields, sessionLookup = false): WorkspaceSelector | null {
  for (const key of ['workspaceId', 'generation', 'sessionId'] as const) {
    if (query[key] !== undefined && body[key] !== undefined && query[key] !== body[key]) {
      throw invalidSelector(`The query and body disagree on ${key}`);
    }
  }
  const fields = { ...query, ...body };
  // Catalog resolution looks up a session before its workspace identity exists.
  if (fields.workspaceId === undefined && fields.generation === undefined && (fields.sessionId === undefined || sessionLookup)) return null;
  if (!fields.workspaceId || !fields.generation) {
    throw invalidSelector('workspaceId and generation must be supplied together');
  }
  return { workspaceId: fields.workspaceId, generation: fields.generation, ...(fields.sessionId ? { sessionId: fields.sessionId } : {}) };
}

function selectorFromRequest(request: Request, query: SelectionFields, initialBody: SelectionFields, sessionLookup: boolean): WorkspaceSelector | null {
  const body = readFields(request.body);
  // Multer parses a multipart body after router middleware. Check those fields
  // at path resolution too, without allowing middleware to retarget a request.
  for (const key of ['workspaceId', 'generation', 'sessionId'] as const) {
    if (initialBody[key] !== undefined && body[key] !== initialBody[key]) {
      throw invalidSelector(`The request changed its ${key} after admission`);
    }
  }
  return combineFields(query, body, sessionLookup);
}

function captureSelection(sessionLookup: boolean): RequestHandler {
  return (request, _response, next) => {
    try {
      const query = readFields(request.query);
      const initialBody = readFields(request.body);
      combineFields(query, initialBody, sessionLookup);
      const user = (request as Request & { user?: { id?: string | number; userId?: string | number } }).user;
      scopes.run({ readSelector: () => selectorFromRequest(request, query, initialBody, sessionLookup), userId: user?.id ?? user?.userId ?? null }, next);
    } catch (error) {
      next(error);
    }
  };
}

/** Production File Tree, Git and Worktrees routers capture strict selectors before path parameters are populated. */
export const workspaceSelectionScope = captureSelection(false);

/** Only the workspace catalog's GET /resolve accepts session lookup without a pre-existing workspace selector; owner identity remains scoped. */
export const workspaceResolutionScope = captureSelection(true);

/** Workspaces production gateways read only the selector belonging to their current request. */
export function currentWorkspaceSelector(): WorkspaceSelector | null {
  return scopes.getStore()?.readSelector() ?? null;
}

/** Workspaces enforces saved SSH ownership using authenticated transport identity, never request JSON. */
export function currentWorkspaceUserId(): string | number | null { return scopes.getStore()?.userId ?? null; }
