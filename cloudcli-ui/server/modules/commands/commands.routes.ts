import express from 'express';
import type { RequestHandler, Response } from 'express';

import { AppError } from '@/shared/index.js';

import type { createCommandsService } from './commands.service.js';

function object(value: unknown, name: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError(`${name} must be an object`, { code: 'INVALID_COMMAND_REQUEST', statusCode: 400 });
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, name: string): string | undefined {
  if (value === undefined || (name === 'sessionId' && value === null)) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new AppError(`${name} must be a nonempty string`, { code: 'INVALID_COMMAND_REQUEST', statusCode: 400 });
  }
  return value;
}

function contextFields(body: Record<string, unknown>, query: Record<string, unknown>) {
  const fields: { projectId?: string; projectPath?: string; workspaceId?: string; generation?: string; sessionId?: string } = {};
  for (const key of ['projectId', 'projectPath', 'workspaceId', 'generation', 'sessionId'] as const) {
    const bodyValue = string(body[key], key);
    const queryValue = string(query[key], key);
    if (bodyValue !== undefined && queryValue !== undefined && bodyValue !== queryValue) {
      throw new AppError(`The query and body disagree on ${key}`, { code: 'INVALID_WORKSPACE_SELECTOR', statusCode: 400 });
    }
    fields[key] = bodyValue ?? queryValue;
  }
  return { ...fields, provider: body.provider, model: body.model, tokenUsage: body.tokenUsage };
}

function failure(response: Response, error: unknown): void {
  if (response.destroyed) return;
  if (error instanceof AppError) {
    response.status(error.statusCode).json({ error: error.message, message: error.message, code: error.code });
    return;
  }
  if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
    response.status(404).json({ error: 'Command not found', message: 'The selected command file does not exist', code: 'COMMAND_NOT_FOUND' });
    return;
  }
  console.error('Commands API error:', error);
  response.status(500).json({ error: 'Command operation failed', message: error instanceof Error ? error.message : String(error) });
}

/** Commands composition and route tests inject the application service and request cancellation scope. */
export function createCommandsRouter(services: ReturnType<typeof createCommandsService>, requestScope?: RequestHandler): express.Router {
  const router = express.Router();
  if (requestScope) router.use(requestScope);
  router.post('/list', async (request, response) => {
    try {
      response.json(await services.list(contextFields(object(request.body, 'body'), request.query)));
    } catch (error) { failure(response, error); }
  });
  router.post('/execute', async (request, response) => {
    try {
      const body = object(request.body, 'body');
      const commandName = string(body.commandName, 'commandName');
      if (!commandName) throw new AppError('Command name is required', { code: 'COMMAND_NAME_REQUIRED', statusCode: 400 });
      const commandPath = string(body.commandPath, 'commandPath');
      const args: unknown = body.args ?? [];
      if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) {
        throw new AppError('args must be an array of strings', { code: 'INVALID_COMMAND_ARGUMENTS', statusCode: 400 });
      }
      response.json(await services.execute({ commandName, commandPath, args, context: contextFields(object(body.context, 'context'), request.query) }));
    } catch (error) { failure(response, error); }
  });
  return router;
}
