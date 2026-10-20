import { AsyncLocalStorage } from 'node:async_hooks';

import type { Request, Response, RequestHandler } from 'express';

import { withWorkspaceGitReadOperation, withWorkspaceWriteOperation } from '@/modules/workspace-bridge/index.js';
import { AppError } from '@/shared/index.js';

const readScopes = new AsyncLocalStorage<boolean>();

/** Git command adapter uses the route's explicit inspection/mutation classification. */
export function gitOperationReadOnly(): boolean { return readScopes.getStore() === true; }

/** Git routes keep responses pending until the operation's synchronization and cleanup finish. */
export function createGitOperationHandlers(resolveProjectPath: (projectId: string) => Promise<string>) {
  function wrap(readOnly: boolean, handler: RequestHandler, nativeBranch = false): RequestHandler {
    return async (request: Request, response: Response, next) => {
      let status = 200;
      let body: unknown;
      let replied = false;
      const buffered = new Proxy(response, {
        get(target, key) {
          if (key === 'status') return (value: number) => { status = value; return buffered; };
          if (key === 'json') return (value: unknown) => { body = value; replied = true; return buffered; };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      try {
        const project = readOnly && request.method === 'GET' ? request.query.project : request.body?.project;
        const run = async () => { await readScopes.run(readOnly, () => handler(request, buffered, next)); };
        if (!nativeBranch && typeof project === 'string' && project) {
          const cwd = await resolveProjectPath(project);
          await (readOnly ? withWorkspaceGitReadOperation(cwd, run) : withWorkspaceWriteOperation(cwd, run));
        } else await run();
        if (replied && !response.destroyed) response.status(status).json(body);
      } catch (error) {
        if (response.destroyed) return;
        const failure = error as Error & { stderr?: string; code?: string | number; details?: unknown };
        const message = failure.stderr?.trim() || failure.message || 'Git operation failed';
        response.status(error instanceof AppError ? error.statusCode : 500).json({
          success: false,
          error: message,
          code: typeof failure.code === 'string' ? failure.code : 'GIT_OPERATION_FAILED',
          ...(failure.details !== undefined ? { details: failure.details } : failure.message !== message ? { details: failure.message } : {}),
          ...(error instanceof AppError && error.code === 'NOT_A_GIT_REPOSITORY' ? { notGitRepository: true } : {}),
        });
      }
    };
  }
  return {
    read: (handler: RequestHandler) => wrap(true, handler),
    write: (handler: RequestHandler) => wrap(false, handler),
    branch: (handler: RequestHandler) => wrap(false, handler, true),
  };
}
