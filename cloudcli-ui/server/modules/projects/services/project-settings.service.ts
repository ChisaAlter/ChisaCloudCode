import { projectSettingsDb, projectsDb, sshProjectTargetsDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/index.js';

export type ProjectDefaultSettings = {
  provider: string | null;
  model: string | null;
  effort: string | null;
  permissionMode: string | null;
  workspaceMode: string | null;
};

export type ProjectSettingsView = {
  projectId: string;
  sourceMode: 'cloud' | 'ssh';
  settings: ProjectDefaultSettings;
  /** Values this project cannot override because its execution mode fixes them. */
  constraints: {
    providers: string[] | null;
    workspaceMode: 'shared' | null;
  };
  updatedAt: string | null;
};

const PROVIDERS = new Set(['claude', 'cursor', 'codex', 'opencode']);
const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'auto', 'bypassPermissions', 'plan']);
const WORKSPACE_MODES = new Set(['isolated', 'shared']);
const MAX_TEXT_LENGTH = 200;

const EMPTY_SETTINGS: ProjectDefaultSettings = {
  provider: null,
  model: null,
  effort: null,
  permissionMode: null,
  workspaceMode: null,
};

function requireProject(projectId: string): void {
  if (!projectId || !projectsDb.getProjectById(projectId)) {
    throw new AppError('Project not found', { code: 'PROJECT_NOT_FOUND', statusCode: 404 });
  }
}

function readText(value: unknown, field: string): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new AppError(`${field} must be a string or null`, {
      code: 'INVALID_PROJECT_SETTING',
      statusCode: 400,
    });
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.length > MAX_TEXT_LENGTH || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new AppError(`${field} is invalid`, { code: 'INVALID_PROJECT_SETTING', statusCode: 400 });
  }
  return trimmed;
}

function readEnum(value: unknown, field: string, allowed: Set<string>): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw new AppError(`${field} is invalid`, { code: 'INVALID_PROJECT_SETTING', statusCode: 400 });
  }
  return value;
}

function readPatch(body: unknown): {
  provider?: string | null;
  model?: string | null;
  effort?: string | null;
  permissionMode?: string | null;
  workspaceMode?: string | null;
} {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError('Project settings payload is invalid', {
      code: 'INVALID_PROJECT_SETTING',
      statusCode: 400,
    });
  }
  const input = body as Record<string, unknown>;
  const patch: ReturnType<typeof readPatch> = {};
  if (Object.prototype.hasOwnProperty.call(input, 'provider')) {
    patch.provider = readEnum(input.provider, 'provider', PROVIDERS);
  }
  if (Object.prototype.hasOwnProperty.call(input, 'model')) {
    patch.model = readText(input.model, 'model');
  }
  if (Object.prototype.hasOwnProperty.call(input, 'effort')) {
    patch.effort = readText(input.effort, 'effort');
  }
  if (Object.prototype.hasOwnProperty.call(input, 'permissionMode')) {
    patch.permissionMode = readEnum(input.permissionMode, 'permissionMode', PERMISSION_MODES);
  }
  if (Object.prototype.hasOwnProperty.call(input, 'workspaceMode')) {
    patch.workspaceMode = readEnum(input.workspaceMode, 'workspaceMode', WORKSPACE_MODES);
  }
  return patch;
}

function toView(projectId: string): ProjectSettingsView {
  const target = sshProjectTargetsDb.getByProjectId(projectId);
  const row = projectSettingsDb.get(projectId);
  return {
    projectId,
    sourceMode: target ? 'ssh' : 'cloud',
    settings: row
      ? {
        provider: row.provider,
        model: row.model,
        effort: row.effort,
        permissionMode: row.permissionMode,
        workspaceMode: row.workspaceMode,
      }
      : { ...EMPTY_SETTINGS },
    constraints: target
      ? { providers: ['claude'], workspaceMode: 'shared' }
      : { providers: null, workspaceMode: null },
    updatedAt: row?.updatedAt ?? null,
  };
}

/**
 * Owns explicit project defaults and the fixed execution constraints that a
 * project cannot override. Account-level and built-in defaults stay in their
 * existing stores; this service never copies them into the project row.
 */
export const projectSettingsService = {
  get(projectId: string): ProjectSettingsView {
    requireProject(projectId);
    return toView(projectId);
  },

  save(projectId: string, body: unknown): ProjectSettingsView {
    requireProject(projectId);
    const target = sshProjectTargetsDb.getByProjectId(projectId);
    const patch = readPatch(body);

    if (target) {
      if (patch.provider && patch.provider !== 'claude') {
        throw new AppError('SSH 本地项目目前仅支持 VPS Claude Code。', {
          code: 'WORKSPACE_PROVIDER_UNSUPPORTED',
          statusCode: 409,
        });
      }
      if (patch.workspaceMode === 'isolated') {
        throw new AppError('SSH 本地项目使用 Windows 共享目录，不能选择隔离工作区。', {
          code: 'WORKSPACE_MODE_UNSUPPORTED',
          statusCode: 409,
        });
      }
    }

    projectSettingsDb.save(projectId, patch);
    return toView(projectId);
  },

  clear(projectId: string): ProjectSettingsView {
    requireProject(projectId);
    projectSettingsDb.clear(projectId);
    return toView(projectId);
  },
};
