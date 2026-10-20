import { randomUUID } from 'node:crypto';

import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { claudeConnectionsDb } from '@/modules/database/index.js';
import { applyClaudeEndpointOptions } from '@/modules/providers/services/claude-endpoint-options.service.js';
import type { ClaudeModelConnectionInput, ClaudeModelConnections, ClaudeModelConnectionSecret } from '@/shared/types.js';
import { AppError, normalizeClaudeEndpointUrl, normalizeConnectionUserId, requireConnectionUserId } from '@/shared/utils.js';

const inputSchema = z.object({
  name: z.string().trim().min(1).max(128).refine(value => !/[\x00-\x1f\x7f]/.test(value)),
  baseUrl: z.string().trim().min(1).max(2048),
  model: z.string().trim().min(1).max(256).refine(value => !/[\s\x00-\x1f\x7f]/.test(value)),
  authType: z.enum(['api_key', 'auth_token']).optional(),
  apiKey: z.string().trim().max(16384).refine(value => !/[\x00-\x20\x7f]/.test(value)).optional(),
}).strict();
const idSchema = z.string().uuid();
const activeSchema = z.object({ id: idSchema.nullable() }).strict();

function requireConnection(userId: number, id: string): ClaudeModelConnectionSecret {
  const connection = claudeConnectionsDb.get(userId, id);
  if (!connection) throw new AppError('Model connection not found.', { code: 'MODEL_CONNECTION_NOT_FOUND', statusCode: 404 });
  return connection;
}

/** Providers routes, auth status and Claude runtime use private connections without exposing API keys. */
export const claudeConnectionsService = {
  parseInput(value: unknown): ClaudeModelConnectionInput {
    const parsed = inputSchema.safeParse(value);
    if (!parsed.success) throw new AppError('Invalid model connection.', { code: 'INVALID_MODEL_CONNECTION', statusCode: 400 });
    return { ...parsed.data, baseUrl: normalizeClaudeEndpointUrl(parsed.data.baseUrl) };
  },
  parseId(value: unknown): string {
    const parsed = idSchema.safeParse(value);
    if (!parsed.success) throw new AppError('Invalid connection id.', { code: 'INVALID_MODEL_CONNECTION', statusCode: 400 });
    return parsed.data;
  },
  parseActiveInput(value: unknown): string | null {
    const parsed = activeSchema.safeParse(value);
    if (!parsed.success) throw new AppError('Invalid active connection.', { code: 'INVALID_MODEL_CONNECTION', statusCode: 400 });
    return parsed.data.id;
  },
  getSettings(userId: unknown): ClaudeModelConnections {
    const id = requireConnectionUserId(userId);
    return {
      activeId: claudeConnectionsDb.activeId(id),
      connections: claudeConnectionsDb.list(id).map(({ apiKey, ...connection }) => ({ ...connection, hasApiKey: Boolean(apiKey) })),
    };
  },
  create(userId: unknown, input: ClaudeModelConnectionInput): ClaudeModelConnections {
    const id = requireConnectionUserId(userId);
    const parsed = this.parseInput(input);
    if (!parsed.apiKey) throw new AppError('An API key is required.', { code: 'MODEL_CONNECTION_KEY_REQUIRED', statusCode: 400 });
    claudeConnectionsDb.save(id, { ...parsed, id: randomUUID(), authType: parsed.authType ?? 'api_key', apiKey: parsed.apiKey });
    return this.getSettings(id);
  },
  update(userId: unknown, connectionId: string, input: ClaudeModelConnectionInput): ClaudeModelConnections {
    const id = requireConnectionUserId(userId);
    const parsed = this.parseInput(input);
    const previous = requireConnection(id, this.parseId(connectionId));
    if ((parsed.baseUrl !== previous.baseUrl || (parsed.authType ?? previous.authType) !== previous.authType) && !parsed.apiKey) {
      throw new AppError('Re-enter the API key when changing the endpoint or authentication.', { code: 'MODEL_CONNECTION_KEY_REQUIRED', statusCode: 400 });
    }
    claudeConnectionsDb.save(id, { ...parsed, id: previous.id, authType: parsed.authType ?? previous.authType, apiKey: parsed.apiKey || previous.apiKey });
    return this.getSettings(id);
  },
  delete(userId: unknown, connectionId: string): ClaudeModelConnections {
    const id = requireConnectionUserId(userId);
    const connection = requireConnection(id, this.parseId(connectionId));
    claudeConnectionsDb.delete(id, connection.id);
    return this.getSettings(id);
  },
  activate(userId: unknown, connectionId: string | null): ClaudeModelConnections {
    const id = requireConnectionUserId(userId);
    const validatedId = this.parseActiveInput({ id: connectionId });
    if (validatedId !== null) requireConnection(id, validatedId);
    claudeConnectionsDb.activate(id, validatedId);
    return this.getSettings(id);
  },
  getActiveConnection(userId: unknown): ClaudeModelConnectionSecret | null {
    const id = normalizeConnectionUserId(userId);
    if (!id) return null;
    const activeId = claudeConnectionsDb.activeId(id);
    return activeId === null ? null : requireConnection(id, activeId);
  },
  applyToOptions(options: Options, connection: ClaudeModelConnectionSecret | null): void {
    if (!connection) return;
    applyClaudeEndpointOptions(options, { baseUrl: connection.baseUrl, model: connection.model, auth: { type: connection.authType, value: connection.apiKey } });
  },
  /** Ordinary Claude runs use only the authenticated writer's active saved connection. */
  applyActiveToOptions(options: Options, userId: unknown): void {
    this.applyToOptions(options, this.getActiveConnection(userId));
  },
};
