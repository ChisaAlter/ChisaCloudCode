import path from 'node:path';

import { projectActionsDb, projectsDb } from '@/modules/database/index.js';
import type { ProjectActionKind, ProjectActionRow } from '@/modules/database/index.js';
import { AppError } from '@/shared/index.js';

export type ProjectActionInput = {
  name: string;
  command: string;
  kind: ProjectActionKind;
  cwd: string | null;
  sortOrder: number;
};

const KINDS = new Set<ProjectActionKind>(['run', 'test', 'build', 'custom']);
const MAX_ACTIONS = 50;

function requireProject(projectId: string): void {
  if (!projectId || !projectsDb.getProjectById(projectId)) {
    throw new AppError('Project not found', { code: 'PROJECT_NOT_FOUND', statusCode: 404 });
  }
}

function readText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string') {
    throw new AppError(`${field} must be a string`, { code: 'INVALID_PROJECT_ACTION', statusCode: 400 });
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(trimmed)) {
    throw new AppError(`${field} is invalid`, { code: 'INVALID_PROJECT_ACTION', statusCode: 400 });
  }
  return trimmed;
}

function readCwd(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new AppError('cwd must be a string or null', { code: 'INVALID_PROJECT_ACTION', statusCode: 400 });
  }
  const normalized = value.trim().replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (!normalized) {
    return null;
  }
  if (normalized.length > 200 || path.posix.isAbsolute(normalized) || /^[a-zA-Z]:\//.test(normalized)
    || normalized.split('/').some((segment) => segment === '..' || segment === '' || segment === '.')
    || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new AppError('cwd must be a relative directory inside the project', {
      code: 'INVALID_PROJECT_ACTION',
      statusCode: 400,
    });
  }
  return normalized;
}

function readInput(body: unknown): ProjectActionInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError('Project action payload is invalid', { code: 'INVALID_PROJECT_ACTION', statusCode: 400 });
  }
  const input = body as Record<string, unknown>;
  if (input.kind !== undefined && (typeof input.kind !== 'string' || !KINDS.has(input.kind as ProjectActionKind))) {
    throw new AppError('kind is invalid', { code: 'INVALID_PROJECT_ACTION', statusCode: 400 });
  }
  const kind = (input.kind as ProjectActionKind | undefined) ?? 'custom';
  const sortOrder = input.sortOrder === undefined ? 0 : Number(input.sortOrder);
  if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 10_000) {
    throw new AppError('sortOrder must be an integer between 0 and 10000', {
      code: 'INVALID_PROJECT_ACTION',
      statusCode: 400,
    });
  }
  return {
    name: readText(input.name, 'name', 80),
    command: readText(input.command, 'command', 2_000),
    kind,
    cwd: readCwd(input.cwd),
    sortOrder,
  };
}

/** CRUD for the explicit commands a project can run directly. Execution lives in the workspace layer. */
export const projectActionsService = {
  list(projectId: string): ProjectActionRow[] {
    requireProject(projectId);
    return projectActionsDb.list(projectId);
  },

  get(projectId: string, actionId: string): ProjectActionRow {
    requireProject(projectId);
    const action = projectActionsDb.get(projectId, actionId);
    if (!action) {
      throw new AppError('Project action not found', { code: 'PROJECT_ACTION_NOT_FOUND', statusCode: 404 });
    }
    return action;
  },

  create(projectId: string, body: unknown): ProjectActionRow {
    requireProject(projectId);
    if (projectActionsDb.list(projectId).length >= MAX_ACTIONS) {
      throw new AppError(`A project can have at most ${MAX_ACTIONS} actions`, {
        code: 'PROJECT_ACTION_LIMIT_REACHED',
        statusCode: 409,
      });
    }
    return projectActionsDb.create(projectId, readInput(body));
  },

  update(projectId: string, actionId: string, body: unknown): ProjectActionRow {
    requireProject(projectId);
    const updated = projectActionsDb.update(projectId, actionId, readInput(body));
    if (!updated) {
      throw new AppError('Project action not found', { code: 'PROJECT_ACTION_NOT_FOUND', statusCode: 404 });
    }
    return updated;
  },

  remove(projectId: string, actionId: string): void {
    requireProject(projectId);
    if (!projectActionsDb.remove(projectId, actionId)) {
      throw new AppError('Project action not found', { code: 'PROJECT_ACTION_NOT_FOUND', statusCode: 404 });
    }
  },
};
