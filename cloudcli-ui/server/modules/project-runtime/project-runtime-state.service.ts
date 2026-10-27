import { createHash } from 'node:crypto';

import * as database from '@/modules/database/index.js';
import { AppError } from '@/shared/index.js';
import type { ProjectRuntimeManifest } from '@/shared/index.js';

const MAX_BYTES = 64 * 1024;
const DEFAULT_ACCOUNT = 'app';
const immutableFields = ['runId', 'sessionId', 'projectId', 'workspaceId', 'generation', 'at'] as const;
const mutableFields = ['configRevision', 'status', 'files', 'skills', 'mcp', 'warnings', 'error'] as const;

type ManifestSelection = { workspaceId?: string; generation?: string; accountKey?: string };

function invalid(message: string): never {
  throw new AppError(message, { code: 'PROJECT_RUNTIME_STATE_INVALID', statusCode: 400 });
}

function plain(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid('Runtime metadata must be a plain object.');
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string, max = 1024, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
    || Buffer.from(value, 'utf8').toString('utf8') !== value) invalid(`Invalid runtime metadata field: ${field}.`);
  return value;
}

function identity(value: unknown, field: string): string {
  const result = text(value, field);
  if (result !== result.trim() || /[\r\n\t]/.test(result)) invalid(`${field} must be a stable nonempty identifier.`);
  return result;
}

function choice<T extends string>(value: unknown, values: readonly T[], field: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) invalid(`Invalid runtime metadata field: ${field}.`);
  return value as T;
}

function items<T>(value: unknown, field: string, max: number, sanitize: (item: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > max) invalid(`Runtime metadata field ${field} exceeds its item limit.`);
  return Array.from(value, sanitize);
}

function optionalText(row: Record<string, unknown>, field: string): { reason?: string } {
  return row[field] === undefined ? {} : { reason: text(row[field], field, 4096, true) };
}

function boundedManifest(manifest: ProjectRuntimeManifest): ProjectRuntimeManifest {
  if (Buffer.byteLength(JSON.stringify(manifest), 'utf8') > MAX_BYTES) {
    throw new AppError('Runtime metadata exceeds 64 KiB.', { code: 'PROJECT_RUNTIME_MANIFEST_TOO_LARGE', statusCode: 413 });
  }
  return manifest;
}

/** Only diagnostic provenance is persisted; unknown properties (including raw config, headers and credentials) are never serialized. Callers must supply sanitized diagnostic text rather than source contents. */
function sanitizeManifest(input: unknown): ProjectRuntimeManifest {
  const value = plain(input);
  const at = text(value.at, 'at', 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(at)
    || !Number.isFinite(Date.parse(at))) invalid('Runtime manifest at must be an ISO start timestamp.');
  return boundedManifest({
    runId: identity(value.runId, 'runId'),
    ...(value.sessionId === undefined ? {} : { sessionId: identity(value.sessionId, 'sessionId') }),
    projectId: identity(value.projectId, 'projectId'),
    workspaceId: identity(value.workspaceId, 'workspaceId'),
    generation: identity(value.generation, 'generation'),
    at,
    configRevision: text(value.configRevision, 'configRevision', 1024, true),
    status: choice(value.status, ['loading', 'loaded', 'failed', 'completed'], 'status'),
    files: items(value.files, 'files', 256, item => {
      const row = plain(item);
      return { path: text(row.path, 'files.path'), hash: identity(row.hash, 'files.hash'),
        kind: choice(row.kind, ['instruction', 'rule', 'settings', 'skill', 'mcp'], 'files.kind') };
    }),
    skills: items(value.skills, 'skills', 256, item => {
      const row = plain(item);
      return { name: text(row.name, 'skills.name', 256), path: text(row.path, 'skills.path'),
        status: choice(row.status, ['available', 'activated', 'unsupported'], 'skills.status'), ...optionalText(row, 'reason') };
    }),
    mcp: items(value.mcp, 'mcp', 128, item => {
      const row = plain(item);
      return { name: text(row.name, 'mcp.name', 256), transport: choice(row.transport, ['http', 'sse', 'stdio', 'unknown'], 'mcp.transport'),
        location: choice(row.location, ['cloud', 'local'], 'mcp.location'),
        status: choice(row.status, ['selected', 'connected', 'failed', 'disabled', 'unsupported'], 'mcp.status'), ...optionalText(row, 'reason') };
    }),
    warnings: items(value.warnings, 'warnings', 200, item => text(item, 'warnings', 4096, true)),
    ...(value.error === undefined ? {} : { error: text(value.error, 'error', 4096, true) }),
  });
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function storageKey(kind: 'manifest' | 'memory', userId: string, projectId: string, accountKey?: string): string {
  const tuple = [identity(userId, 'userId'), identity(projectId, 'projectId')];
  if (kind === 'manifest') tuple.push(identity(accountKey ?? DEFAULT_ACCOUNT, 'accountKey'));
  return `project-runtime:${kind}:v1:${digest(JSON.stringify(tuple))}`;
}

function readValue(key: string): string | null {
  // appConfigDb.get intentionally swallows database errors for bootstrap; runtime state must surface them.
  const row = database.getConnection().prepare('SELECT value FROM app_config WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function writeValue(key: string, value: string): void {
  database.getConnection().prepare('INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

function readManifest(key: string): ProjectRuntimeManifest | null {
  const raw = readValue(key);
  if (raw === null) return null;
  try {
    if (Buffer.byteLength(raw, 'utf8') > MAX_BYTES) throw new Error('Oversized stored manifest');
    return sanitizeManifest(JSON.parse(raw));
  } catch {
    throw new AppError('Stored runtime metadata is invalid.', { code: 'PROJECT_RUNTIME_STATE_CORRUPT', statusCode: 500 });
  }
}

/** Project-runtime launch persists the current run's provenance after the caller authorizes the project. A duplicate start cannot erase later updates; an older start cannot replace a newer run. Account keys separate Claude logins within an app user. */
export function saveProjectRuntimeManifest(userId: string, manifest: ProjectRuntimeManifest, accountKey?: string): void {
  const safe = sanitizeManifest(manifest);
  const key = storageKey('manifest', userId, safe.projectId, accountKey);
  database.getConnection().transaction(() => {
    const previous = readManifest(key);
    if (previous && (previous.runId === safe.runId || Date.parse(previous.at) > Date.parse(safe.at))) return;
    writeValue(key, JSON.stringify(safe));
  }).immediate();
}

/** Context APIs read only this app user's selected Claude account and optional exact workspace/generation. Callers authorize project ownership before lookup; missing or stale records return null while database failures propagate. */
export function getProjectRuntimeManifest(userId: string, projectId: string, options: ManifestSelection = {}): ProjectRuntimeManifest | null {
  const key = storageKey('manifest', userId, projectId, options.accountKey);
  if (options.workspaceId !== undefined) identity(options.workspaceId, 'workspaceId');
  if (options.generation !== undefined) identity(options.generation, 'generation');
  const manifest = readManifest(key);
  if (!manifest || manifest.projectId !== projectId
    || (options.workspaceId !== undefined && manifest.workspaceId !== options.workspaceId)
    || (options.generation !== undefined && manifest.generation !== options.generation)) return null;
  return manifest;
}

/** Run completion and tool activation update only the exact current run in one SQLite transaction. Stale runs return null; immutable source identity and start time cannot be changed by a patch. Callers authorize project ownership. */
export function updateProjectRuntimeManifest(userId: string, projectId: string, runId: string, patch: Partial<ProjectRuntimeManifest>, accountKey?: string): ProjectRuntimeManifest | null {
  const key = storageKey('manifest', userId, projectId, accountKey);
  identity(runId, 'runId');
  return database.getConnection().transaction(() => {
    const current = readManifest(key);
    if (!current || current.runId !== runId || current.projectId !== projectId) return null;
    const input = plain(patch);
    for (const field of immutableFields) {
      if (Object.hasOwn(input, field) && input[field] !== current[field]) invalid(`Runtime manifest ${field} cannot change during a run.`);
    }
    const changes = Object.fromEntries(mutableFields.filter(field => Object.hasOwn(input, field)).map(field => [field, input[field]]));
    const next = sanitizeManifest({ ...current, ...changes });
    writeValue(key, JSON.stringify(next));
    return next;
  }).immediate();
}

function memoryText(content: unknown): string {
  if (typeof content !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(content)
    || Buffer.from(content, 'utf8').toString('utf8') !== content) {
    throw new AppError('Project memory must be UTF-8 text without binary control characters.', { code: 'PROJECT_MEMORY_INVALID', statusCode: 400 });
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) {
    throw new AppError('Project memory exceeds 64 KiB.', { code: 'PROJECT_MEMORY_TOO_LARGE', statusCode: 413 });
  }
  return content;
}

/** Project context/memory tools read explicitly saved cloud memory for an authorized app user/project. It is independent of the selected Claude account and never reads a source directory or provider auth HOME. */
export function readProjectMemory(userId: string, projectId: string): { content: string; hash: string } {
  const key = storageKey('memory', userId, projectId);
  const content = memoryText(readValue(key) ?? '');
  return { content, hash: digest(content) };
}

/** Project memory API/tools persist only caller-supplied text using the exact hash last read. Ownership is checked by the caller; SQLite immediate transactions prevent lost updates across connections and restarts. */
export function writeProjectMemory(userId: string, projectId: string, content: string, expectedHash: string): { content: string; hash: string } {
  const key = storageKey('memory', userId, projectId);
  const safe = memoryText(content);
  if (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash)) {
    throw new AppError('Read project memory again before saving.', { code: 'PROJECT_MEMORY_CONFLICT', statusCode: 409 });
  }
  return database.getConnection().transaction(() => {
    const current = memoryText(readValue(key) ?? '');
    if (digest(current) !== expectedHash) {
      throw new AppError('Project memory changed; read it again before saving.', { code: 'PROJECT_MEMORY_CONFLICT', statusCode: 409 });
    }
    writeValue(key, safe);
    return { content: safe, hash: digest(safe) };
  }).immediate();
}
