import express, { type Request, type Response } from 'express';

import { providerAuthService } from '@/modules/providers/services/provider-auth.service.js';
import { providerCapabilitiesService } from '@/modules/providers/services/provider-capabilities.service.js';
import { providerMcpService } from '@/modules/providers/services/mcp.service.js';
import { providerModelsService } from '@/modules/providers/services/provider-models.service.js';
import { providerTokenUsageService } from '@/modules/providers/services/provider-token-usage.service.js';
import { providerSkillsService } from '@/modules/providers/services/skills.service.js';
import { sessionConversationsSearchService } from '@/modules/providers/services/session-conversations-search.service.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import { assertSshSessionAccess, canReadSshSession } from '@/modules/providers/services/ssh-session-access.service.js';
import type {
  CustomProviderModelInput,
  LLMProvider,
  McpScope,
  McpTransport,
  ProviderSkillCreateFile,
  ProviderSkillCreateInput,
  UpsertProviderMcpServerInput,
} from '@/shared/index.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/index.js';
import { assertSshProjectOwner, resolveSshProjectTarget, workspaceRequestScope } from '@/modules/workspace-bridge/index.js';
import { hirouteService } from '@/modules/providers/services/hiroute.service.js';
import { claudeConnectionsService } from '@/modules/providers/services/claude-connections.service.js';
import { createClaudeAccountsRouter } from '@/modules/providers/claude-accounts.routes.js';
import { userDb, userPreferencesDb } from '@/modules/database/index.js';
import { assertCloudWorkspaceOwner } from '@/modules/workspace-runtime/index.js';

const router = express.Router();
// Fixed account paths precede the provider/session wildcards below.
router.use('/claude/accounts', createClaudeAccountsRouter());
const authenticatedUserId = (request: Request): string | number | null => {
  const user = (request as Request & { user?: { id?: string | number; userId?: string | number } }).user;
  return user?.id ?? user?.userId ?? null;
};

/**
 * Reads the caller's pinned session ids so the recent feed can resolve every
 * pin before pagination. A missing or malformed preference is an unpinned feed,
 * never a request failure.
 */
const readPinnedSessionIds = (request: Request): string[] => {
  const rawUserId = authenticatedUserId(request);
  const userId = typeof rawUserId === 'number' ? rawUserId : Number(rawUserId);
  if (!Number.isInteger(userId) || userId <= 0) {
    return [];
  }
  const uiPreferences = userPreferencesDb.getPreferences(userId).uiPreferences;
  if (!uiPreferences || typeof uiPreferences !== 'object' || Array.isArray(uiPreferences)) {
    return [];
  }
  const pinned = (uiPreferences as Record<string, unknown>).pinnedSessionIds;
  return Array.isArray(pinned)
    ? pinned.filter((sessionId): sessionId is string => typeof sessionId === 'string' && sessionId.trim().length > 0)
    : [];
};
router.param('sessionId', (request, _response, next, value) => {
  try { assertSshSessionAccess(parseSessionId(value), authenticatedUserId(request)); next(); }
  catch (error) { next(error); }
});

router.get('/claude/connections', asyncHandler(async (req: Request, res: Response) => {
  res.json(createApiSuccessResponse(claudeConnectionsService.getSettings((req as Request & { user?: { id?: number | string } }).user?.id)));
}));

router.post('/claude/connections', asyncHandler(async (req: Request, res: Response) => {
  const input = claudeConnectionsService.parseInput(req.body);
  res.status(201).json(createApiSuccessResponse(claudeConnectionsService.create((req as Request & { user?: { id?: number | string } }).user?.id, input)));
}));

// Register the fixed active path before /:id.
router.put('/claude/connections/active', asyncHandler(async (req: Request, res: Response) => {
  const id = claudeConnectionsService.parseActiveInput(req.body);
  res.json(createApiSuccessResponse(claudeConnectionsService.activate((req as Request & { user?: { id?: number | string } }).user?.id, id)));
}));

router.put('/claude/connections/:id', asyncHandler(async (req: Request, res: Response) => {
  const id = claudeConnectionsService.parseId(req.params.id);
  const input = claudeConnectionsService.parseInput(req.body);
  res.json(createApiSuccessResponse(claudeConnectionsService.update((req as Request & { user?: { id?: number | string } }).user?.id, id, input)));
}));

router.delete('/claude/connections/:id', asyncHandler(async (req: Request, res: Response) => {
  const id = claudeConnectionsService.parseId(req.params.id);
  res.json(createApiSuccessResponse(claudeConnectionsService.delete((req as Request & { user?: { id?: number | string } }).user?.id, id)));
}));

// Authentication middleware supplies this identity; never read a user id from request data.
router.get('/claude/hiroute', asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as Request & { user?: { id?: number | string } }).user?.id;
  res.json(createApiSuccessResponse(hirouteService.getSettings(userId)));
}));

router.put('/claude/hiroute', asyncHandler(async (req: Request, res: Response) => {
  const input = hirouteService.parseInput(req.body);
  const userId = (req as Request & { user?: { id?: number | string } }).user?.id;
  res.json(createApiSuccessResponse(hirouteService.saveSettings(userId, input)));
}));

const readPathParam = (value: unknown, name: string): string => {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value) && typeof value[0] === 'string') {
    return value[0];
  }

  throw new AppError(`${name} path parameter is invalid.`, {
    code: 'INVALID_PATH_PARAMETER',
    statusCode: 400,
  });
};

const normalizeProviderParam = (value: unknown): string =>
  readPathParam(value, 'provider').trim().toLowerCase();

const SESSION_ID_PATTERN = /^[a-zA-Z0-9._-]{1,120}$/;

const parseSessionId = (value: unknown): string => {
  const sessionId = readPathParam(value, 'sessionId').trim();
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new AppError('Invalid sessionId.', {
      code: 'INVALID_SESSION_ID',
      statusCode: 400,
    });
  }

  return sessionId;
};

const readOptionalQueryString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
};

const parseOptionalBooleanQuery = (value: unknown, name: string): boolean | undefined => {
  if (value === undefined) {
    return undefined;
  }

  const normalized = readOptionalQueryString(value);
  if (!normalized) {
    return undefined;
  }

  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }

  throw new AppError(`${name} must be "true" or "false".`, {
    code: 'INVALID_QUERY_PARAMETER',
    statusCode: 400,
  });
};

const parseMcpScope = (value: unknown): McpScope | undefined => {
  if (value === undefined) {
    return undefined;
  }

  const normalized = readOptionalQueryString(value);
  if (!normalized) {
    return undefined;
  }

  if (normalized === 'user' || normalized === 'local' || normalized === 'project') {
    return normalized;
  }

  throw new AppError(`Unsupported MCP scope "${normalized}".`, {
    code: 'INVALID_MCP_SCOPE',
    statusCode: 400,
  });
};

const parseMcpTransport = (value: unknown): McpTransport => {
  const normalized = readOptionalQueryString(value);
  if (!normalized) {
    throw new AppError('transport is required.', {
      code: 'MCP_TRANSPORT_REQUIRED',
      statusCode: 400,
    });
  }

  if (normalized === 'stdio' || normalized === 'http' || normalized === 'sse') {
    return normalized;
  }

  throw new AppError(`Unsupported MCP transport "${normalized}".`, {
    code: 'INVALID_MCP_TRANSPORT',
    statusCode: 400,
  });
};

const parseMcpUpsertPayload = (payload: unknown): UpsertProviderMcpServerInput => {
  if (!payload || typeof payload !== 'object') {
    throw new AppError('Request body must be an object.', {
      code: 'INVALID_REQUEST_BODY',
      statusCode: 400,
    });
  }

  const body = payload as Record<string, unknown>;
  const name = readOptionalQueryString(body.name);
  if (!name) {
    throw new AppError('name is required.', {
      code: 'MCP_NAME_REQUIRED',
      statusCode: 400,
    });
  }

  const transport = parseMcpTransport(body.transport);
  const scope = parseMcpScope(body.scope);
  const workspacePath = readOptionalQueryString(body.workspacePath);

  return {
    name,
    transport,
    scope,
    workspacePath,
    command: readOptionalQueryString(body.command),
    args: Array.isArray(body.args) ? body.args.filter((entry): entry is string => typeof entry === 'string') : undefined,
    env: typeof body.env === 'object' && body.env !== null
      ? Object.fromEntries(
        Object.entries(body.env as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      )
      : undefined,
    cwd: readOptionalQueryString(body.cwd),
    url: readOptionalQueryString(body.url),
    headers: typeof body.headers === 'object' && body.headers !== null
      ? Object.fromEntries(
        Object.entries(body.headers as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      )
      : undefined,
    envVars: Array.isArray(body.envVars)
      ? body.envVars.filter((entry): entry is string => typeof entry === 'string')
      : undefined,
    bearerTokenEnvVar: readOptionalQueryString(body.bearerTokenEnvVar),
    envHttpHeaders: typeof body.envHttpHeaders === 'object' && body.envHttpHeaders !== null
      ? Object.fromEntries(
        Object.entries(body.envHttpHeaders as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      )
      : undefined,
  };
};

const parseProviderSkillCreatePayload = (payload: unknown): ProviderSkillCreateInput => {
  if (!payload || typeof payload !== 'object') {
    throw new AppError('Request body must be an object.', {
      code: 'INVALID_REQUEST_BODY',
      statusCode: 400,
    });
  }

  const body = payload as Record<string, unknown>;
  const rawEntries = Array.isArray(body.entries)
    ? body.entries
    : typeof body.content === 'string'
      ? [{
          content: body.content,
          directoryName: body.directoryName,
          fileName: body.fileName,
          files: body.files,
        }]
      : null;

  if (!rawEntries || rawEntries.length === 0) {
    throw new AppError('At least one skill entry is required.', {
      code: 'PROVIDER_SKILLS_REQUIRED',
      statusCode: 400,
    });
  }

  const entries = rawEntries.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new AppError(`Skill entry ${index + 1} must be an object.`, {
        code: 'INVALID_REQUEST_BODY',
        statusCode: 400,
      });
    }

    const record = entry as Record<string, unknown>;
    const content = typeof record.content === 'string' ? record.content : '';
    const directoryName = readOptionalQueryString(record.directoryName);
    const fileName = readOptionalQueryString(record.fileName);
    const rawFiles = record.files;

    if (!content.trim()) {
      throw new AppError(`Skill entry ${index + 1} must include markdown content.`, {
        code: 'PROVIDER_SKILL_CONTENT_REQUIRED',
        statusCode: 400,
      });
    }

    if (rawFiles !== undefined && !Array.isArray(rawFiles)) {
      throw new AppError(`Skill entry ${index + 1} files must be an array.`, {
        code: 'INVALID_REQUEST_BODY',
        statusCode: 400,
      });
    }

    const files: ProviderSkillCreateFile[] | undefined = rawFiles?.map((file, fileIndex) => {
      if (!file || typeof file !== 'object') {
        throw new AppError(`Skill entry ${index + 1} file ${fileIndex + 1} must be an object.`, {
          code: 'INVALID_REQUEST_BODY',
          statusCode: 400,
        });
      }

      const fileRecord = file as Record<string, unknown>;
      const relativePath = readOptionalQueryString(fileRecord.relativePath);
      const fileContent = typeof fileRecord.content === 'string' ? fileRecord.content : null;
      const encoding = fileRecord.encoding === 'utf8' || fileRecord.encoding === 'base64'
        ? fileRecord.encoding
        : null;

      if (!relativePath || fileContent === null || !encoding) {
        throw new AppError(
          `Skill entry ${index + 1} file ${fileIndex + 1} requires relativePath, content, and encoding.`,
          {
            code: 'INVALID_REQUEST_BODY',
            statusCode: 400,
          },
        );
      }

      return {
        relativePath,
        content: fileContent,
        encoding,
      };
    });

    return {
      content,
      directoryName,
      fileName,
      files,
    };
  });

  return { entries };
};

const parseProvider = (value: unknown): LLMProvider => {
  const normalized = normalizeProviderParam(value);
  if (
    normalized === 'claude'
    || normalized === 'codex'
    || normalized === 'cursor'
    || normalized === 'opencode'
  ) {
    return normalized;
  }

  throw new AppError(`Unsupported provider "${normalized}".`, {
    code: 'UNSUPPORTED_PROVIDER',
    statusCode: 400,
  });
};

/** Both fields are optional: an empty body forks the whole conversation. */
const parseSessionForkPayload = (payload: unknown): { upToAnchorId?: string; title?: string } => {
  if (payload === undefined || payload === null) {
    return {};
  }
  if (typeof payload !== 'object') {
    throw new AppError('Request body must be an object.', {
      code: 'INVALID_REQUEST_BODY',
      statusCode: 400,
    });
  }

  const body = payload as Record<string, unknown>;
  const upToAnchorId = typeof body.upToAnchorId === 'string' ? body.upToAnchorId.trim() : '';
  const title = typeof body.title === 'string' ? body.title.trim() : '';

  return {
    ...(upToAnchorId ? { upToAnchorId } : {}),
    ...(title ? { title } : {}),
  };
};

const parseSessionRenameSummary = (payload: unknown): string => {
  if (!payload || typeof payload !== 'object') {
    throw new AppError('Request body must be an object.', {
      code: 'INVALID_REQUEST_BODY',
      statusCode: 400,
    });
  }

  const body = payload as Record<string, unknown>;
  const summary = typeof body.summary === 'string' ? body.summary.trim() : '';
  if (!summary) {
    throw new AppError('Summary is required.', {
      code: 'INVALID_SESSION_SUMMARY',
      statusCode: 400,
    });
  }

  if (summary.length > 500) {
    throw new AppError('Summary must not exceed 500 characters.', {
      code: 'INVALID_SESSION_SUMMARY',
      statusCode: 400,
    });
  }

  return summary;
};

const parseSessionSearchQuery = (value: unknown): string => {
  const query = readOptionalQueryString(value) ?? '';
  if (query.length < 2) {
    throw new AppError('Query must be at least 2 characters', {
      code: 'INVALID_SEARCH_QUERY',
      statusCode: 400,
    });
  }

  return query;
};

const parseSessionSearchLimit = (value: unknown): number => {
  const raw = readOptionalQueryString(value);
  if (!raw) {
    return 50;
  }

  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new AppError('limit must be a valid integer.', {
      code: 'INVALID_QUERY_PARAMETER',
      statusCode: 400,
    });
  }

  return Math.max(1, Math.min(parsed, 100));
};

const parseBoundedIntegerQuery = <T extends number | null>(
  value: unknown,
  name: string,
  fallback: T,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number | T => {
  const raw = readOptionalQueryString(value);
  if (raw === undefined) {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new AppError(`${name} must be an integer between ${minimum} and ${maximum}.`, {
      code: 'INVALID_QUERY_PARAMETER',
      statusCode: 400,
    });
  }

  return parsed;
};

const parseSessionModelPayload = (payload: unknown): string => {
  if (!payload || typeof payload !== 'object') {
    throw new AppError('Request body must be an object.', {
      code: 'INVALID_REQUEST_BODY',
      statusCode: 400,
    });
  }

  const body = payload as Record<string, unknown>;
  const model = readOptionalQueryString(body.model);
  if (!model) {
    throw new AppError('model is required.', {
      code: 'MODEL_REQUIRED',
      statusCode: 400,
    });
  }

  return model;
};

const parseSessionEffortPayload = (payload: unknown): string => {
  if (!payload || typeof payload !== 'object') {
    throw new AppError('Request body must be an object.', {
      code: 'INVALID_REQUEST_BODY',
      statusCode: 400,
    });
  }

  const body = payload as Record<string, unknown>;
  const effort = readOptionalQueryString(body.effort);
  if (!effort) {
    throw new AppError('effort is required.', {
      code: 'EFFORT_REQUIRED',
      statusCode: 400,
    });
  }

  if (effort.length > 32) {
    throw new AppError('effort must be 32 characters or fewer.', {
      code: 'INVALID_EFFORT',
      statusCode: 400,
    });
  }

  return effort;
};

const parseModelRecordId = (value: unknown): number => {
  const rawRecordId = readPathParam(value, 'recordId').trim();
  if (!/^\d+$/.test(rawRecordId)) {
    throw new AppError('recordId must be a positive integer.', {
      code: 'INVALID_MODEL_RECORD_ID',
      statusCode: 400,
    });
  }

  const recordId = Number.parseInt(rawRecordId, 10);
  if (!Number.isSafeInteger(recordId) || recordId < 1) {
    throw new AppError('recordId must be a positive integer.', {
      code: 'INVALID_MODEL_RECORD_ID',
      statusCode: 400,
    });
  }

  return recordId;
};

const parseCustomProviderModelPayload = (payload: unknown): CustomProviderModelInput => {
  if (!payload || typeof payload !== 'object') {
    throw new AppError('Request body must be an object.', {
      code: 'INVALID_REQUEST_BODY',
      statusCode: 400,
    });
  }

  const body = payload as Record<string, unknown>;
  const model = readOptionalQueryString(body.model);
  const id = readOptionalQueryString(body.id);
  if (!model) {
    throw new AppError('model is required.', {
      code: 'MODEL_NAME_REQUIRED',
      statusCode: 400,
    });
  }
  if (!id) {
    throw new AppError('id is required.', {
      code: 'MODEL_ID_REQUIRED',
      statusCode: 400,
    });
  }
  if (model.length > 80) {
    throw new AppError('model must be 80 characters or fewer.', {
      code: 'MODEL_NAME_TOO_LONG',
      statusCode: 400,
    });
  }
  if (id.length > 200 || /\s/.test(id)) {
    throw new AppError('id must be 200 characters or fewer and cannot contain whitespace.', {
      code: 'INVALID_MODEL_ID',
      statusCode: 400,
    });
  }

  return { model, id };
};

router.get(
  '/:provider/auth/status',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const userId = (req as Request & { user?: { id?: number | string } }).user?.id;
    const status = await providerAuthService.getProviderAuthStatus(provider, userId);
    res.json(createApiSuccessResponse(status));
  }),
);

router.get(
  '/:provider/models',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const models = await providerModelsService.getProviderModels(provider);
    res.json(createApiSuccessResponse({ provider, models }));
  }),
);

router.post(
  '/:provider/models',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const input = parseCustomProviderModelPayload(req.body);
    const result = await providerModelsService.createCustomModel(provider, input);
    res.status(201).json(createApiSuccessResponse({ provider, ...result }));
  }),
);

router.patch(
  '/:provider/models/:recordId',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const recordId = parseModelRecordId(req.params.recordId);
    const input = parseCustomProviderModelPayload(req.body);
    const result = await providerModelsService.updateCustomModel(provider, recordId, input);
    res.json(createApiSuccessResponse({ provider, ...result }));
  }),
);

router.delete(
  '/:provider/models/:recordId',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const recordId = parseModelRecordId(req.params.recordId);
    const result = await providerModelsService.deleteCustomModel(provider, recordId);
    res.json(createApiSuccessResponse({ provider, ...result }));
  }),
);

/**
 * Reports which model one session is using. `requestedModel` lets the client
 * pass the default it would otherwise send, so a session that has not been
 * sent on yet resolves to that instead of the catalog default.
 */
router.get(
  '/:provider/sessions/:sessionId/active-model',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const sessionId = parseSessionId(req.params.sessionId);
    const requestedModel = readOptionalQueryString(req.query.requestedModel);
    const result = await providerModelsService.resolveSessionModel(provider, {
      sessionId,
      requestedModel,
    });
    res.json(createApiSuccessResponse(result));
  }),
);

router.post(
  '/:provider/sessions/:sessionId/active-model',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const sessionId = parseSessionId(req.params.sessionId);
    const model = parseSessionModelPayload(req.body);
    const stored = providerModelsService.setSessionModel(provider, sessionId, model);
    // A session row only exists once the gateway has allocated one. Report the
    // selection back either way so the client can hold it until the first send.
    res.json(createApiSuccessResponse(
      stored ?? { provider, sessionId, model, effort: null, source: 'session' as const },
    ));
  }),
);

/** Records the reasoning-effort choice for one app session. */
router.post(
  '/:provider/sessions/:sessionId/active-effort',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const sessionId = parseSessionId(req.params.sessionId);
    const effort = parseSessionEffortPayload(req.body);
    const stored = providerModelsService.setSessionEffort(provider, sessionId, effort);
    // Mirror active-model behavior for a composer that picked an effort just
    // before the session gateway created its row.
    res.json(createApiSuccessResponse(
      stored ?? { provider, sessionId, effort, source: 'session' as const },
    ));
  }),
);

// ----------------- Skills routes -----------------
function parseSkillsContext(query: Request['query']): Parameters<typeof providerSkillsService.listProviderSkills>[1] {
  const context: NonNullable<Parameters<typeof providerSkillsService.listProviderSkills>[1]> = {};
  for (const key of ['workspacePath', 'projectId', 'workspaceId', 'generation', 'sessionId'] as const) {
    const value = query[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
      throw new AppError(`${key} must be a nonempty string.`, { code: 'INVALID_WORKSPACE_SELECTOR', statusCode: 400 });
    }
    context[key] = value.trim();
  }
  return context;
}

router.get(
  '/:provider/skills',
  workspaceRequestScope,
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const skills = await providerSkillsService.listProviderSkills(provider, { ...parseSkillsContext(req.query), userId: authenticatedUserId(req) });
    res.json(createApiSuccessResponse({ provider, skills }));
  }),
);

router.post(
  '/:provider/skills',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const input = parseProviderSkillCreatePayload(req.body);
    const skills = await providerSkillsService.addProviderSkills(provider, input, { userId: authenticatedUserId(req) });
    res.json(createApiSuccessResponse({ provider, skills }));
  }),
);

router.delete(
  '/:provider/skills/:directoryName',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const result = await providerSkillsService.removeProviderSkill(provider, {
      directoryName: readPathParam(req.params.directoryName, 'directoryName'),
    }, { userId: authenticatedUserId(req) });
    res.json(createApiSuccessResponse(result));
  }),
);

// ----------------- MCP routes -----------------
router.get(
  '/:provider/mcp/servers',
  workspaceRequestScope,
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const context = { ...parseSkillsContext(req.query), userId: authenticatedUserId(req) };
    const scope = parseMcpScope(req.query.scope);

    if (scope) {
      const servers = await providerMcpService.listProviderMcpServersForScope(provider, scope, context);
      res.json(createApiSuccessResponse({ provider, scope, servers }));
      return;
    }

    const groupedServers = await providerMcpService.listProviderMcpServers(provider, context);
    res.json(createApiSuccessResponse({ provider, scopes: groupedServers }));
  }),
);

router.post(
  '/:provider/mcp/servers',
  workspaceRequestScope,
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const payload = parseMcpUpsertPayload(req.body);
    const server = await providerMcpService.upsertProviderMcpServer(provider, payload, { ...parseSkillsContext(req.body), userId: authenticatedUserId(req) });
    res.status(201).json(createApiSuccessResponse({ server }));
  }),
);

router.delete(
  '/:provider/mcp/servers/:name',
  workspaceRequestScope,
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const scope = parseMcpScope(req.query.scope);
    const workspacePath = readOptionalQueryString(req.query.workspacePath);
    const result = await providerMcpService.removeProviderMcpServer(provider, {
      name: readPathParam(req.params.name, 'name'),
      scope,
      workspacePath,
    }, { ...parseSkillsContext(req.query), userId: authenticatedUserId(req) });
    res.json(createApiSuccessResponse(result));
  }),
);

router.post(
  '/mcp/servers/global',
  workspaceRequestScope,
  asyncHandler(async (req: Request, res: Response) => {
    const payload = parseMcpUpsertPayload(req.body);
    if (payload.scope === 'local') {
      throw new AppError('Global MCP add supports only "user" or "project" scopes.', {
        code: 'INVALID_GLOBAL_MCP_SCOPE',
        statusCode: 400,
      });
    }

    const results = await providerMcpService.addMcpServerToAllProviders({
      ...payload,
      scope: payload.scope === 'user' ? 'user' : 'project',
    }, { ...parseSkillsContext(req.body), userId: authenticatedUserId(req) });
    res.status(201).json(createApiSuccessResponse({ results }));
  }),
);

router.get(
  '/capabilities',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(createApiSuccessResponse({
      providers: providerCapabilitiesService.listAllProviderCapabilities(),
    }));
  }),
);

router.get(
  '/:provider/capabilities',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    res.json(createApiSuccessResponse(
      providerCapabilitiesService.getProviderCapabilities(provider),
    ));
  }),
);

// ----------------- Session routes -----------------
/**
 * Session gateway entry point: allocates the stable app-facing session id for
 * a brand-new chat. The frontend must call this before the first `chat.send`
 * so the session id in the URL, the store, and the websocket all agree from
 * the very first message — there is no client-visible session-id handoff.
 */
router.post(
  '/sessions',
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const provider = parseProvider(body.provider);
    const projectPath = typeof body.projectPath === 'string' ? body.projectPath : '';
    const initialMessage = typeof body.initialMessage === 'string' ? body.initialMessage : '';
    const ssh = projectPath ? resolveSshProjectTarget(projectPath) : null;
    if (ssh) {
      const user = (req as Request & { user?: { id?: string | number; userId?: string | number } }).user;
      assertSshProjectOwner(ssh, user?.id ?? user?.userId);
      if (provider !== 'claude') throw new AppError('SSH 本地项目目前仅支持 VPS Claude Code。', { code: 'WORKSPACE_PROVIDER_UNSUPPORTED', statusCode: 409 });
    }
    if (!ssh) assertCloudWorkspaceOwner(projectPath, authenticatedUserId(req), userDb.getActiveUserIds());
    const workspaceMode = ssh || body.workspaceMode === 'shared' ? 'shared' : 'isolated';
    const result = sessionsService.createAppSession(provider, projectPath, initialMessage, workspaceMode);
    res.status(201).json(createApiSuccessResponse(result));
  }),
);

router.get(
  '/sessions/running',
  asyncHandler(async (req: Request, res: Response) => {
    const sessions = sessionsService.listRunningSessions().filter(session => canReadSshSession(session.sessionId, authenticatedUserId(req)));
    res.json(createApiSuccessResponse({ sessions }));
  }),
);

router.get(
  '/sessions/recent',
  asyncHandler(async (req: Request, res: Response) => {
    const limit = parseBoundedIntegerQuery(req.query.limit, 'limit', 40, 1, 100);
    const offset = parseBoundedIntegerQuery(req.query.offset, 'offset', 0, 0);
    const page = sessionsService.listRecentSessions(
      limit,
      offset,
      sessionId => canReadSshSession(sessionId, authenticatedUserId(req)),
      readPinnedSessionIds(req),
    );
    res.json(createApiSuccessResponse(page));
  }),
);

router.get(
  '/sessions/archived',
  asyncHandler(async (req: Request, res: Response) => {
    const sessions = sessionsService.listArchivedSessions().filter(session => canReadSshSession(session.sessionId, authenticatedUserId(req)));
    res.json(createApiSuccessResponse({ sessions }));
  }),
);

router.get(
  '/sessions/:sessionId/provider-id',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    const providerSessionId = sessionsService.getProviderSessionId(sessionId);
    res.json(createApiSuccessResponse({ sessionId: providerSessionId }));
  }),
);

router.get(
  '/sessions/:sessionId/token-usage',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    const result = await providerTokenUsageService.getSessionTokenUsage(sessionId);
    res.json(createApiSuccessResponse(result));
  }),
);

// Must stay registered after the static and session-specific routes so their
// literals never match the generic `:sessionId` parameter.
router.get(
  '/sessions/:sessionId',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    const result = sessionsService.getSessionDetailsById(sessionId);
    res.json(createApiSuccessResponse(result));
  }),
);

router.delete(
  '/sessions/:sessionId',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    const force = parseOptionalBooleanQuery(req.query.force, 'force') ?? false;
    const deletedFromDisk = parseOptionalBooleanQuery(req.query.deletedFromDisk, 'deletedFromDisk') ?? force;
    const result = await sessionsService.deleteOrArchiveSessionById(sessionId, {
      force,
      deletedFromDisk,
    });
    res.json(createApiSuccessResponse(result));
  }),
);

router.post(
  '/sessions/:sessionId/restore',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    const result = sessionsService.restoreSessionById(sessionId);
    res.json(createApiSuccessResponse(result));
  }),
);

router.post(
  '/sessions/:sessionId/fork',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    const result = await sessionsService.forkSessionById(sessionId, parseSessionForkPayload(req.body));
    res.status(201).json(createApiSuccessResponse(result));
  }),
);

router.put(
  '/sessions/:sessionId',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    const summary = parseSessionRenameSummary(req.body);
    const result = sessionsService.renameSessionById(sessionId, summary);
    res.json(createApiSuccessResponse(result));
  }),
);

router.get(
  '/sessions/:sessionId/messages',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    const limit = parseBoundedIntegerQuery(req.query.limit, 'limit', null, 0);
    const offset = parseBoundedIntegerQuery(req.query.offset, 'offset', 0, 0);

    const result = await sessionsService.fetchHistory(sessionId, {
      limit,
      offset,
    });
    res.json(createApiSuccessResponse(result));
  }),
);

router.get('/search/sessions', asyncHandler(async (req: Request, res: Response) => {
  const query = parseSessionSearchQuery(req.query.q);
  const limit = parseSessionSearchLimit(req.query.limit);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  let closed = false;
  const abortController = new AbortController();
  req.on('close', () => {
    closed = true;
    abortController.abort();
  });

  try {
    await sessionConversationsSearchService.search({
      query,
      limit,
      signal: abortController.signal,
      canReadSession: sessionId => canReadSshSession(sessionId, authenticatedUserId(req)),
      onTitleResults: (titleResults) => {
        if (!closed) {
          res.write(`event: title-results\ndata: ${JSON.stringify({ titleResults })}\n\n`);
        }
      },
      onProgress: ({ projectResult, totalMatches, scannedProjects, totalProjects }) => {
        if (closed) {
          return;
        }

        if (projectResult) {
          res.write(`event: result\ndata: ${JSON.stringify({ projectResult, totalMatches, scannedProjects, totalProjects })}\n\n`);
          return;
        }

        res.write(`event: progress\ndata: ${JSON.stringify({ totalMatches, scannedProjects, totalProjects })}\n\n`);
      },
    });

    if (!closed) {
      res.write('event: done\ndata: {}\n\n');
    }
  } catch (error) {
    console.error('Error searching conversations:', error);
    if (!closed) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: 'Search failed' })}\n\n`);
    }
  } finally {
    if (!closed) {
      res.end();
    }
  }
}));

export default router;
