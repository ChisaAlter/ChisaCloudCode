import { agentWorkspaceConnectionsDb } from '@/modules/database/index.js';
import type { AgentWorkspaceConnectionRow } from '@/modules/database/index.js';
import { AppError } from '@/shared/index.js';

const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const TOKEN = /^[a-f0-9]{64}$/;
const PORT_MIN = 1024;

function readOwner(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new AppError('Authenticated owner is required for Agent connections', { code: 'UNAUTHORIZED', statusCode: 401 });
  }
  return value;
}

function readId(value: unknown): string {
  if (typeof value !== 'string' || !ID.test(value)) {
    throw new AppError('Agent connection id is invalid', { code: 'INVALID_AGENT_CONNECTION', statusCode: 400 });
  }
  return value;
}

function readName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 160 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new AppError('Agent connection name is invalid', { code: 'INVALID_AGENT_CONNECTION', statusCode: 400 });
  }
  return value.trim();
}

function readToken(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 64 || !TOKEN.test(value)) {
    throw new AppError('Agent request token is invalid', { code: 'INVALID_AGENT_CONNECTION', statusCode: 400 });
  }
  return value;
}

function readDelivery(value: unknown): 'direct' | 'relay' {
  if (value === undefined || value === 'direct') return 'direct';
  if (value === 'relay') return 'relay';
  throw new AppError('Agent delivery is invalid', { code: 'INVALID_AGENT_CONNECTION', statusCode: 400 });
}

function readPort(value: unknown): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < PORT_MIN || port > 65535) {
    throw new AppError(`Agent port must be an integer between ${PORT_MIN} and 65535`, {
      code: 'INVALID_AGENT_CONNECTION',
      statusCode: 400,
    });
  }
  return port;
}

/** Registers the loopback agent endpoint only; the desktop owns the process, token and project roots. */
export const agentConnectionService = {
  list(ownerId: string): AgentWorkspaceConnectionRow[] {
    return agentWorkspaceConnectionsDb.list(readOwner(ownerId));
  },

  upsert(ownerId: string, body: unknown): AgentWorkspaceConnectionRow {
    const owner = readOwner(ownerId);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new AppError('Agent connection payload is invalid', { code: 'INVALID_AGENT_CONNECTION', statusCode: 400 });
    }
    const input = body as Record<string, unknown>;
    const token = readToken(input.token);
    const id = readId(input.id);
    const name = readName(input.name);
    if (id.toLowerCase().includes(token) || name.toLowerCase().includes(token)) {
      throw new AppError('Agent public metadata cannot contain its private credential', { code: 'INVALID_AGENT_CONNECTION', statusCode: 400 });
    }
    return agentWorkspaceConnectionsDb.upsert(owner, id, name, readPort(input.port), token, readDelivery(input.delivery));
  },

  remove(ownerId: string, id: string): boolean {
    const removed = agentWorkspaceConnectionsDb.remove(readOwner(ownerId), readId(id));
    if (!removed) {
      throw new AppError('Agent connection not found', { code: 'AGENT_CONNECTION_NOT_FOUND', statusCode: 404 });
    }
    return true;
  },
};
