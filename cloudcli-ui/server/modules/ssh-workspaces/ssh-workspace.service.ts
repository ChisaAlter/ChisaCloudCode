import { spawn as systemSpawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';

import { agentWorkspaceConnectionsDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/index.js';
import type { SshWorkspaceConnection, SshWorkspaceRpcResult, SshWorkspaceProbeResult } from '@/shared/index.js';

import { agentRelayBroker } from './agent-relay.service.js';

/** Windows helper requests use virtual project paths; exec deliberately grants the SSH user's command permissions. */
export type SshWorkspaceRequest = {
  op: string; path?: string; destination?: string; b64?: string; expectedHash?: string | null;
  requests?: SshWorkspaceRequest[]; recursive?: boolean; includeStats?: boolean;
  query?: string; command?: string; argv?: string[]; readOnly?: boolean; timeoutSeconds?: number;
  jobId?: string; operationId?: string;
};

/** The bridge pins the physical root identity after probe; a changed identity is never silently adopted. */
export type SshWorkspaceTarget = {
  connectionId: string; rootPath: string; userId: string; generation?: string;
  expectedRootIdentity?: string; signal?: AbortSignal;
};

/** Typed SSH failures let callers retain recovery state when remote execution teardown is unknown. */
export class SshWorkspaceError extends AppError {
  declare readonly details?: Record<string, unknown>;
  constructor(code: string, message: string, statusCode = 503, details?: Record<string, unknown>) {
    super(message, { code, statusCode, details });
    this.name = 'SshWorkspaceError';
  }
}

type SshCatalogRecord = SshWorkspaceConnection & { transport: 'ssh'; identityFile: string; knownHostsFile: string; hostKeyAlias?: string; helperPath: string; ownerId: string };
type AgentCatalogRecord = SshWorkspaceConnection & { transport: 'agent'; ownerId: string; token: string; delivery: 'direct' | 'relay' };
type CatalogRecord = SshCatalogRecord | AgentCatalogRecord;
type AgentConnectionReference = { id: string; name: string; port: number; token: string; delivery?: 'direct' | 'relay' };
type TransportDependencies = {
  spawn?: (command: string, args: string[], options: { stdio: ['pipe', 'pipe', 'pipe']; windowsHide: boolean; env: NodeJS.ProcessEnv }) => ChildProcessWithoutNullStreams;
  env?: NodeJS.ProcessEnv;
  readCatalog?: (file: string) => Promise<string>;
  agentConnections?: (ownerId: string) => Promise<AgentConnectionReference[]>;
  agentFetch?: (url: string, init: RequestInit) => Promise<Response>;
  agentRelayCall?: typeof agentRelayBroker.call;
  requestTimeoutMs?: number;
  cleanupTimeoutMs?: number;
};

async function defaultAgentConnections(ownerId: string): Promise<AgentConnectionReference[]> {
  try {
    return agentWorkspaceConnectionsDb.list(ownerId)
      .filter((row) => typeof row.token === 'string' && row.token.length > 0)
      .map((row) => ({ id: row.id, name: row.name, port: row.port, token: row.token!, delivery: row.delivery }));
  } catch {
    // Unit fixtures and partially initialized CLI paths may not have a database;
    // the SSH file catalog remains usable in that case.
    return [];
  }
}
const PROTOCOL = 1;
const MAX_INPUT_BYTES = 12 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const OPS = new Set(['probe', 'stat', 'lstat', 'list', 'batch', 'realpath', 'read', 'write', 'mkdir', 'rename', 'copy', 'remove', 'search', 'grep', 'exec', 'job_status', 'job_cancel', 'operation_status', 'operation_cancel']);
const FILE_MUTATIONS = new Set(['write', 'mkdir', 'rename', 'copy', 'remove']);
const AGENT_REFUSALS = new Map([['AGENT_UNAUTHORIZED', 401], ['AGENT_REQUEST_TOO_LARGE', 413], ['AGENT_REQUEST_INVALID', 400], ['AGENT_ROOT_INVALID', 400], ['AGENT_BUSY', 503]]);
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function redactAgentText(value: string, token: string): string {
  return value.replaceAll(token, '[redacted]').replace(/[a-f0-9]{64}/gi, '[redacted]');
}

async function boundedAgentResponse(response: Response): Promise<Buffer> {
  const declared = response.headers.get('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw failure('SSH_WORKSPACE_RESPONSE_TOO_LARGE', 'Desktop agent response exceeds the allowed size', 502);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, bytes);
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw failure('SSH_WORKSPACE_RESPONSE_TOO_LARGE', 'Desktop agent response exceeds the allowed size', 502);
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function failure(code: string, message: string, status = 503, details?: Record<string, unknown>): SshWorkspaceError {
  return new SshWorkspaceError(code, message, status, details);
}
function requiredString(value: unknown, name: string, maximum = 4096): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) throw failure('SSH_CONNECTION_CONFIG_INVALID', `Invalid SSH connection ${name}`, 500);
  return value;
}
function safeUser(userId: string): string {
  if (typeof userId !== 'string' || !userId.trim() || userId.length > 256 || /[\u0000-\u001f\u007f]/.test(userId)) throw failure('UNAUTHORIZED', 'Authenticated owner is required for SSH workspaces', 401);
  return userId;
}
function ensureRoot(root: string): void {
  if (typeof root !== 'string' || root.length > 1024 || !/^[a-zA-Z]:[\\/]/.test(root) || /[\u0000-\u001f\u007f]/.test(root) || root.slice(2).includes(':') || /^\w:[\\/]?$/.test(root)) throw failure('SSH_WORKSPACE_ROOT_INVALID', 'Select an absolute Windows project subdirectory', 400);
}
function validateRequest(request: SshWorkspaceRequest, nested = false): void {
  if (!request || typeof request !== 'object' || Array.isArray(request) || !OPS.has(request.op) || (nested && ['batch', 'exec', 'job_status', 'job_cancel', 'operation_status', 'operation_cancel', 'probe'].includes(request.op))) throw failure('SSH_WORKSPACE_REQUEST_INVALID', 'Unsupported SSH workspace operation', 400);
  for (const key of ['path', 'destination'] as const) {
    const value = request[key];
    if (value !== undefined && (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u001f\u007f]/.test(value))) throw failure('SSH_WORKSPACE_PATH_INVALID', 'Invalid project path', 400);
  }
  if (request.op === 'batch') {
    if (!Array.isArray(request.requests) || !request.requests.length || request.requests.length > 64) throw failure('SSH_WORKSPACE_REQUEST_INVALID', 'A batch needs 1 to 64 file operations', 400);
    request.requests.forEach(value => {
      validateRequest(value, true);
      if (!['stat', 'lstat', 'list', 'realpath', 'read', 'search', 'grep'].includes(value.op)) throw failure('SSH_WORKSPACE_REQUEST_INVALID', 'Batch supports file inspection only', 400);
    });
  }
  if (request.op === 'exec') {
    if (request.readOnly === true) throw failure('SSH_READ_ONLY_COMMAND_UNSUPPORTED', 'SSH cannot enforce a read-only command; use file inspection tools in plan mode', 409);
    const hasCommand = typeof request.command === 'string' && Boolean(request.command.trim());
    const hasArgv = Array.isArray(request.argv) && request.argv.length > 0 && request.argv.every(arg => typeof arg === 'string' && !arg.includes('\0'));
    if (hasCommand === hasArgv || (request.command?.length ?? 0) > 128 * 1024 || (request.argv?.length ?? 0) > 256) throw failure('SSH_WORKSPACE_REQUEST_INVALID', 'Supply one Windows command or argument vector', 400);
    if (request.timeoutSeconds !== undefined && (!Number.isInteger(request.timeoutSeconds) || request.timeoutSeconds < 1 || request.timeoutSeconds > 600)) throw failure('SSH_WORKSPACE_REQUEST_INVALID', 'Command timeout must be 1 to 600 seconds', 400);
  }
  if (['job_status', 'job_cancel'].includes(request.op) && (!request.jobId || !JOB_ID.test(request.jobId))) throw failure('SSH_WORKSPACE_REQUEST_INVALID', 'A valid job ID is required', 400);
  if (['operation_status', 'operation_cancel'].includes(request.op) && (!request.operationId || !JOB_ID.test(request.operationId))) throw failure('SSH_WORKSPACE_REQUEST_INVALID', 'A valid file operation ID is required', 400);
}

async function readProtectedCatalog(file: string): Promise<string> {
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 1024 * 1024 || (process.platform !== 'win32' && (metadata.mode & 0o022) !== 0)) throw failure('SSH_CONNECTION_CONFIG_INVALID', 'SSH catalog must be a protected regular file', 500);
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const actual = await handle.stat();
    if (!actual.isFile() || actual.size > 1024 * 1024 || actual.ino !== metadata.ino || actual.dev !== metadata.dev) throw failure('SSH_CONNECTION_CONFIG_INVALID', 'SSH catalog changed while reading', 500);
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}

function parseCatalog(text: string, env: NodeJS.ProcessEnv): SshCatalogRecord[] {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw failure('SSH_CONNECTION_CONFIG_INVALID', 'SSH connection catalog is not valid JSON', 500); }
  const rows = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && 'connections' in raw ? (raw as { connections: unknown }).connections : null;
  if (!Array.isArray(rows) || rows.length > 256) throw failure('SSH_CONNECTION_CONFIG_INVALID', 'SSH connection catalog needs a connections array', 500);
  const seen = new Set<string>();
  return rows.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw failure('SSH_CONNECTION_CONFIG_INVALID', 'Invalid SSH connection record', 500);
    const item = row as Record<string, unknown>;
    const id = requiredString(item.id, 'id', 128);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id) || seen.has(id)) throw failure('SSH_CONNECTION_CONFIG_INVALID', 'SSH connection IDs must be unique safe identifiers', 500);
    seen.add(id);
    const host = requiredString(item.host, 'host', 253);
    const username = requiredString(item.username, 'username', 128);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9.:[\]_-]*$/.test(host) || !/^[a-zA-Z0-9_][a-zA-Z0-9_.@\\-]*$/.test(username)) throw failure('SSH_CONNECTION_CONFIG_INVALID', 'Invalid SSH host or username', 500);
    if (!Number.isInteger(item.port) || Number(item.port) < 1 || Number(item.port) > 65535) throw failure('SSH_CONNECTION_CONFIG_INVALID', 'Invalid SSH port', 500);
    const ownerId = requiredString(item.ownerId, 'ownerId', 256);
    if (ownerId === '*' && (env.CHISA_SSH_ALLOW_SHARED_CONNECTIONS !== '1' || env.VITE_IS_PLATFORM === 'true')) throw failure('SSH_CONNECTION_CONFIG_INVALID', 'Shared SSH connections are disabled', 500);
    const identityFile = requiredString(item.identityFile, 'identityFile');
    const knownHostsFile = requiredString(item.knownHostsFile, 'knownHostsFile');
    if (!path.isAbsolute(identityFile) || !path.isAbsolute(knownHostsFile) || /[\r\n]/.test(identityFile + knownHostsFile)) throw failure('SSH_CONNECTION_CONFIG_INVALID', 'SSH credential references must be absolute server paths', 500);
    const helperPath = requiredString(item.helperPath, 'helperPath', 1024);
    if (!/^[a-zA-Z]:[\\/]/.test(helperPath) || helperPath.slice(2).includes(':') || !/\.ps1$/i.test(helperPath)) throw failure('SSH_CONNECTION_CONFIG_INVALID', 'Helper must be an absolute Windows PowerShell script path', 500);
    const hostKeyAlias = item.hostKeyAlias === undefined ? undefined : requiredString(item.hostKeyAlias, 'hostKeyAlias', 253);
    if (hostKeyAlias && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(hostKeyAlias)) throw failure('SSH_CONNECTION_CONFIG_INVALID', 'Invalid SSH host key alias', 500);
    return { id, name: requiredString(item.name, 'name', 160), host, port: Number(item.port), username, identityFile, knownHostsFile, helperPath, ownerId, hostKeyAlias, platform: 'win32', transport: 'ssh' };
  });
}

function bootstrap(helperPath: string): string {
  const encodedPath = Buffer.from(helperPath, 'utf8').toString('base64');
  const script = `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::InputEncoding=New-Object System.Text.UTF8Encoding($false);[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false);$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'));try{& $p}catch{[Console]::Out.Write('{"ok":false,"code":"SSH_HELPER_UNAVAILABLE","error":"Windows workspace helper could not start"}');exit 1}`;
  return Buffer.from(script, 'utf16le').toString('base64');
}

function sshArguments(record: SshCatalogRecord): string[] {
  const nullConfig = process.platform === 'win32' ? 'NUL' : '/dev/null';
  return ['-F', nullConfig, '-T', '-p', String(record.port), '-l', record.username, '-i', record.identityFile,
    '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none', '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile="${record.knownHostsFile.replaceAll('\\', '/').replaceAll('"', '\\"')}"`, '-o', `GlobalKnownHostsFile=${nullConfig}`,
    '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes', '-o', 'ConnectionAttempts=1', '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2', '-o', 'LogLevel=ERROR',
    ...(record.hostKeyAlias ? ['-o', `HostKeyAlias=${record.hostKeyAlias}`] : []),
    record.host, 'powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', bootstrap(record.helperPath)];
}

/** Tests inject process/catalog access; production consumers use the singleton functions below. No connection is made until an operation is requested. */
export function createSshWorkspaceTransport(dependencies: TransportDependencies = {}) {
  const env = dependencies.env ?? process.env;
  const spawn = dependencies.spawn ?? ((command, args, options) => systemSpawn(command, args, options));
  async function catalog(userId: string): Promise<CatalogRecord[]> {
    const owner = safeUser(userId);
    const file = env.CHISA_SSH_CONNECTIONS_FILE;
    let sshRecords: SshCatalogRecord[] = [];
    if (file) {
      if (!path.isAbsolute(file)) throw failure('SSH_CONNECTION_CONFIG_INVALID', 'CHISA_SSH_CONNECTIONS_FILE must be an absolute path', 500);
      let contents: string;
      try { contents = await (dependencies.readCatalog ?? readProtectedCatalog)(file); }
      catch (error) { if (error instanceof SshWorkspaceError) throw error; throw failure('SSH_CONNECTION_CONFIG_UNAVAILABLE', 'SSH connection catalog is unavailable', 503); }
      sshRecords = parseCatalog(contents, env).filter(record => record.ownerId === owner || record.ownerId === '*');
    }
    const agentRows = await (dependencies.agentConnections ?? defaultAgentConnections)(owner);
    const agentRecords: AgentCatalogRecord[] = agentRows.map((row) => {
      if (!row || typeof row.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(row.id)
        || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 160 || /[\u0000-\u001f\u007f]/.test(row.name)
        || !Number.isInteger(row.port) || row.port < 1024 || row.port > 65535
        || typeof row.token !== 'string' || row.token.length !== 64 || !/^[a-f0-9]{64}$/.test(row.token)
        || row.id.toLowerCase().includes(row.token) || row.name.toLowerCase().includes(row.token)
        || (row.delivery !== undefined && row.delivery !== 'direct' && row.delivery !== 'relay')) {
        throw failure('SSH_CONNECTION_CONFIG_INVALID', 'Agent connection registry contains an invalid endpoint', 500);
      }
      return {
        id: row.id, name: row.name, host: '127.0.0.1', port: row.port, username: 'desktop-agent',
        platform: 'win32', transport: 'agent', ownerId: owner, token: row.token, delivery: row.delivery ?? 'direct',
      };
    });
    const seen = new Set(sshRecords.map(record => record.id));
    for (const record of agentRecords) {
      if (seen.has(record.id)) throw failure('SSH_CONNECTION_CONFIG_INVALID', 'SSH and agent connection ids must not collide', 500);
      seen.add(record.id);
    }
    return [...sshRecords, ...agentRecords];
  }
  async function connection(input: SshWorkspaceTarget): Promise<CatalogRecord> {
    input.signal?.throwIfAborted();
    ensureRoot(input.rootPath);
    const record = (await catalog(input.userId)).find(item => item.id === input.connectionId);
    if (!record) throw failure('SSH_CONNECTION_NOT_FOUND', 'SSH connection is not available to this account', 404);
    return record;
  }
  async function callAgent(record: AgentCatalogRecord, target: SshWorkspaceTarget & { operationId?: string }, request: SshWorkspaceRequest, signal = target.signal, timeoutMs = dependencies.requestTimeoutMs ?? ((request.timeoutSeconds ?? 60) * 1000 + 25_000)): Promise<SshWorkspaceRpcResult> {
    if (signal?.aborted) throw failure('SSH_WORKSPACE_INTERRUPTED', 'Workspace operation interrupted before dispatch', 499, { requestDispatched: false });
    // Validate immediately before header construction, even for injected registries.
    if (record.token.length !== 64 || !/^[a-f0-9]{64}$/.test(record.token)) throw failure('SSH_CONNECTION_CONFIG_INVALID', 'Agent connection registry contains an invalid credential', 500);
    const payload = JSON.stringify({ protocol: PROTOCOL, rootPath: target.rootPath, expectedRootIdentity: target.expectedRootIdentity, generation: target.generation, operationId: target.operationId, request });
    if (Buffer.byteLength(payload) > MAX_INPUT_BYTES) throw failure('SSH_WORKSPACE_REQUEST_TOO_LARGE', 'Workspace request exceeds 12 MiB', 413);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    let dispatched = false;
    try {
      signal?.throwIfAborted();
      let response: Response;
      if (record.delivery === 'relay') {
        // The broker knows whether native delivery happened. Offline/queued
        // cancellation must retain its false flag instead of creating a fence.
        const reply = await (dependencies.agentRelayCall ?? agentRelayBroker.call)(record.ownerId, record.id, record.token,
          JSON.parse(payload) as Record<string, unknown>, controller.signal);
        dispatched = true;
        response = new Response(reply.body, { status: reply.status });
      } else {
        dispatched = true;
        // Redirects must never forward the Agent credential to another endpoint.
        response = await (dependencies.agentFetch ?? fetch)(`http://127.0.0.1:${record.port}/v1/workspace`, {
          method: 'POST', redirect: 'error', credentials: 'omit',
          headers: { 'content-type': 'application/json', accept: 'application/json', 'X-Chisa-Agent-Token': record.token },
          body: payload, signal: controller.signal,
        });
      }
      const raw = await boundedAgentResponse(response);
      let value: unknown;
      try { value = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, '')); }
      catch { throw failure('SSH_WORKSPACE_UNAVAILABLE', 'The desktop agent did not return a valid workspace response', 502); }
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('SSH_WORKSPACE_PROTOCOL_INVALID', 'Invalid desktop agent response', 502);
      const result = value as Record<string, unknown>;
      if (result.ok !== true) {
        const helperCode = typeof result.code === 'string' && /^[A-Z][A-Z0-9_]{1,80}$/.test(result.code)
          && !/[a-f0-9]{64}/i.test(result.code) ? result.code : 'SSH_WORKSPACE_OPERATION_FAILED';
        const message = typeof result.error === 'string' ? redactAgentText(result.error, record.token).slice(0, 2048) : 'Windows workspace operation failed';
        const typed = result.ok === false && result.protocol === PROTOCOL && result.platform === 'win32'
          && helperCode === result.code && typeof result.error === 'string' && result.error.length > 0;
        const preDispatchRefusal = typed && AGENT_REFUSALS.get(helperCode) === response.status;
        const confirmed = typed && response.ok && !helperCode.startsWith('AGENT_')
          && !['SSH_WORKSPACE_CHANGED', 'SSH_WORKSPACE_PROTOCOL_INVALID', 'SSH_HELPER_UNAVAILABLE'].includes(helperCode)
          && typeof result.rootIdentity === 'string' && result.rootIdentity.length > 0
          && (!target.expectedRootIdentity || result.rootIdentity === target.expectedRootIdentity);
        const status = preDispatchRefusal ? response.status
          : response.status === 401 ? 401 : response.status === 403 ? 403
            : ['CONTENT_CONFLICT', 'SSH_WORKSPACE_CHANGED', 'SSH_WORKSPACE_BUSY', 'SSH_JOB_EXISTS', 'AGENT_OPERATION_DUPLICATE'].includes(helperCode) ? 409
              : helperCode === 'ENOENT' ? 404 : helperCode === 'EACCES' ? 403 : response.ok ? 400 : 502;
        const details: Record<string, unknown> = { requestDispatched: !preDispatchRefusal };
        if (confirmed) details.transportConfirmed = true;
        if (confirmed && typeof result.jobId === 'string' && JOB_ID.test(result.jobId)) {
          details.jobId = result.jobId; details.cleanupConfirmed = result.cleanupConfirmed === true;
        }
        throw failure(helperCode, message, status, details);
      }
      if (!response.ok || result.protocol !== PROTOCOL || result.platform !== 'win32'
        || typeof result.rootIdentity !== 'string' || !result.rootIdentity
        || (target.expectedRootIdentity && result.rootIdentity !== target.expectedRootIdentity)) {
        throw failure(target.expectedRootIdentity && result.rootIdentity !== target.expectedRootIdentity ? 'SSH_WORKSPACE_CHANGED' : 'SSH_WORKSPACE_PROTOCOL_INVALID', 'Desktop agent identity or protocol changed', 409);
      }
      // The native Agent never needs the credential in a response. Fail closed
      // rather than publishing an echoed secret from an unexpected listener.
      if (JSON.stringify(result).toLowerCase().includes(record.token)) throw failure('SSH_WORKSPACE_PROTOCOL_INVALID', 'Desktop agent returned an unsafe workspace response', 502);
      return result as SshWorkspaceRpcResult;
    } catch (error) {
      const errorDetails = error instanceof AppError && error.details && typeof error.details === 'object'
        ? error.details as Record<string, unknown> : undefined;
      const requestDispatched = typeof errorDetails?.requestDispatched === 'boolean' ? errorDetails.requestDispatched : dispatched;
      if (controller.signal.aborted) {
        throw failure(signal?.aborted ? 'SSH_WORKSPACE_INTERRUPTED' : 'SSH_WORKSPACE_TIMEOUT',
          signal?.aborted ? 'Workspace operation interrupted; check its recovery status before retrying' : 'Desktop agent operation timed out',
          signal?.aborted ? 499 : 504, { requestDispatched });
      }
      if (error instanceof SshWorkspaceError) throw failure(error.code, redactAgentText(error.message, record.token), error.statusCode,
        { requestDispatched, ...error.details });
      if (record.delivery === 'relay' && error instanceof AppError) throw failure(error.code, redactAgentText(error.message, record.token), error.statusCode, { requestDispatched });
      throw failure('SSH_WORKSPACE_UNAVAILABLE', 'The desktop workspace agent is unavailable', 503, { requestDispatched });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  async function call(record: CatalogRecord, target: SshWorkspaceTarget & { operationId?: string }, request: SshWorkspaceRequest, signal = target.signal, timeoutMs = dependencies.requestTimeoutMs ?? ((request.timeoutSeconds ?? 60) * 1000 + 25_000)): Promise<SshWorkspaceRpcResult> {
    if (record.transport === 'agent') return callAgent(record, target, request, signal, timeoutMs);
    if (['operation_status', 'operation_cancel'].includes(request.op)) throw failure('SSH_OPERATION_RECOVERY_UNSUPPORTED', 'This connection cannot verify file operation receipts', 409);
    if (signal?.aborted) throw failure('SSH_WORKSPACE_INTERRUPTED', 'Workspace operation interrupted before dispatch', 499, { requestDispatched: false });
    const payload = JSON.stringify({ protocol: PROTOCOL, rootPath: target.rootPath, expectedRootIdentity: target.expectedRootIdentity, generation: target.generation, request });
    if (Buffer.byteLength(payload) > MAX_INPUT_BYTES) throw failure('SSH_WORKSPACE_REQUEST_TOO_LARGE', 'SSH workspace request exceeds 12 MiB', 413);
    return new Promise<SshWorkspaceRpcResult>((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      let finished = false;
      let stdoutBytes = 0;
      let stderr = '';
      let dispatched = false;
      const chunks: Buffer[] = [];
      const finish = (error?: unknown, value?: SshWorkspaceRpcResult) => {
        if (finished) return;
        finished = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (error instanceof SshWorkspaceError) reject(failure(error.code, error.message, error.statusCode, { requestDispatched: dispatched, ...error.details }));
        else if (error) reject(error); else resolve(value!);
      };
      const stop = (error: unknown) => { if (!finished) { child?.kill(); finish(error); } };
      const abort = () => stop(failure('SSH_WORKSPACE_INTERRUPTED', 'SSH operation interrupted; confirm any remote command before retrying', 499));
      const timer = setTimeout(() => stop(failure('SSH_WORKSPACE_TIMEOUT', 'SSH operation timed out; confirm any remote command before retrying', 504)), timeoutMs);
      timer.unref();
      try {
        // The worker receives only Windows' SSH environment. VPS cloud/provider credentials are not sent over stdin or SSH SendEnv.
        child = spawn('ssh', sshArguments(record), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...env, SSH_ASKPASS_REQUIRE: 'never', SSH_ASKPASS: '' } });
      } catch { finish(failure('SSH_WORKSPACE_UNAVAILABLE', 'Unable to start the system SSH client')); return; }
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      child.once('error', () => finish(failure('SSH_WORKSPACE_UNAVAILABLE', 'Unable to start the system SSH client')));
      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_RESPONSE_BYTES) { stop(failure('SSH_WORKSPACE_RESPONSE_TOO_LARGE', 'Windows helper response exceeds the allowed size', 502)); return; }
        chunks.push(Buffer.from(chunk));
      });
      child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 16_384) stderr += chunk.toString('utf8').slice(0, 16_384 - stderr.length); });
      child.stdin.on('error', () => { /* The close/error event reports failed delivery; never replay a possibly sent request. */ });
      child.once('close', (code) => {
        if (finished) return;
        let value: unknown;
        try { value = JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '')); }
        catch {
          const diagnostic = /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed|No .*host key is known/i.test(stderr)
            ? failure('SSH_HOST_KEY_MISMATCH', 'Windows SSH host identity is not trusted; verify the device fingerprint')
            : /Permission denied|Authentication failed|Too many authentication failures/i.test(stderr)
              ? failure('SSH_AUTHENTICATION_FAILED', 'Windows SSH authentication failed')
              : failure('SSH_WORKSPACE_UNAVAILABLE', 'SSH did not return a valid Windows workspace response');
          finish(diagnostic); return;
        }
        if (!value || typeof value !== 'object' || Array.isArray(value)) { finish(failure('SSH_WORKSPACE_PROTOCOL_INVALID', 'Invalid Windows workspace response', 502)); return; }
        const result = value as Record<string, unknown>;
        if (result.ok !== true) {
          const helperCode = typeof result.code === 'string' && /^[A-Z][A-Z0-9_]{1,80}$/.test(result.code) ? result.code : 'SSH_WORKSPACE_OPERATION_FAILED';
          // Messages are helper-controlled, bounded and never include SSH stderr/credential paths.
          const message = typeof result.error === 'string' ? result.error.slice(0, 2048) : 'Windows workspace operation failed';
          const status = ['CONTENT_CONFLICT', 'SSH_WORKSPACE_CHANGED', 'SSH_WORKSPACE_BUSY', 'SSH_JOB_EXISTS'].includes(helperCode) ? 409 : ['ENOENT'].includes(helperCode) ? 404 : ['EACCES'].includes(helperCode) ? 403 : 400;
          const details: Record<string, unknown> = {};
          // A valid helper refusal proves connectivity even when the file operation failed.
          // Bootstrap fallbacks, SSH exits and identity/protocol failures do not prove a usable target.
          if (code === 1 && result.ok === false && result.protocol === PROTOCOL && result.platform === 'win32'
            && helperCode === result.code && typeof result.error === 'string' && result.error.length > 0
            && !['SSH_WORKSPACE_CHANGED', 'SSH_WORKSPACE_PROTOCOL_INVALID', 'SSH_HELPER_UNAVAILABLE'].includes(helperCode)
            && typeof result.rootIdentity === 'string' && result.rootIdentity.length > 0
            && (!target.expectedRootIdentity || result.rootIdentity === target.expectedRootIdentity)) details.transportConfirmed = true;
          if (details.transportConfirmed === true && typeof result.jobId === 'string' && JOB_ID.test(result.jobId)) {
            details.jobId = result.jobId; details.cleanupConfirmed = result.cleanupConfirmed === true;
          }
          finish(failure(helperCode, message, status, Object.keys(details).length ? details : undefined)); return;
        }
        if (code !== 0 || result.protocol !== PROTOCOL || result.platform !== 'win32' || typeof result.rootIdentity !== 'string' || !result.rootIdentity || (target.expectedRootIdentity && result.rootIdentity !== target.expectedRootIdentity)) {
          finish(failure(target.expectedRootIdentity && result.rootIdentity !== target.expectedRootIdentity ? 'SSH_WORKSPACE_CHANGED' : 'SSH_WORKSPACE_PROTOCOL_INVALID', 'Windows workspace identity or helper protocol changed', 409)); return;
        }
        finish(undefined, result as SshWorkspaceRpcResult);
      });
      dispatched = true;
      child.stdin.end(payload, 'utf8');
    });
  }
  return {
    async listSshConnections(userId: string): Promise<SshWorkspaceConnection[]> {
      return (await catalog(userId)).map(record => {
        const { id, name, host, port, username, platform, transport } = record;
        return { id, name, host, port, username, platform, transport, ...(record.transport === 'agent' && record.delivery === 'relay' ? { delivery: 'relay' as const } : {}) };
      });
    },
    async probeSshWorkspace(input: SshWorkspaceTarget): Promise<SshWorkspaceProbeResult> {
      const record = await connection(input);
      const result = await call(record, input, { op: 'probe' });
      if (typeof result.rootPath !== 'string' || !result.rootPath || typeof result.username !== 'string' || typeof result.helperVersion !== 'string' || !result.capabilities || result.capabilities.files !== true || result.capabilities.exec !== true) throw failure('SSH_WORKSPACE_PROTOCOL_INVALID', 'Windows helper returned an incomplete probe', 502);
      return { ...result, protocol: 1, platform: 'win32', rootPath: result.rootPath, rootIdentity: result.rootIdentity!, username: result.username, helperVersion: result.helperVersion, capabilities: result.capabilities, connectionId: record.id, connectionLabel: record.name };
    },
    async executeSshWorkspace(input: SshWorkspaceTarget & { request: SshWorkspaceRequest | Record<string, unknown>; onJobCreated?: (jobId: string) => void }): Promise<SshWorkspaceRpcResult> {
      const supplied = input.request as SshWorkspaceRequest;
      validateRequest(supplied);
      const record = await connection(input);
      // Catalog access is asynchronous. A disconnect during lookup must not
      // create a durable job that was never transmitted and cannot be queried.
      input.signal?.throwIfAborted();
      const request = supplied.op === 'exec' ? { ...supplied, jobId: randomUUID(), timeoutSeconds: supplied.timeoutSeconds ?? 60 } : supplied;
      const operationId = record.transport === 'agent' && FILE_MUTATIONS.has(request.op) ? randomUUID() : undefined;
      // The same private writer reference stores either a command job UUID or an
      // explicitly tagged Agent receipt. Both are committed before transmission.
      if (request.op === 'exec') input.onJobCreated?.(request.jobId!);
      else if (operationId) input.onJobCreated?.(`operation:${operationId}`);
      const callTarget = { ...input, operationId };
      try {
        const result = await call(record, callTarget, request);
        if (request.op === 'exec' && (result.jobId !== request.jobId || result.cleanupConfirmed !== true)) throw failure('SSH_EXECUTION_UNCONFIRMED', 'Windows command cleanup was not confirmed', 503, { jobId: request.jobId, cleanupConfirmed: false });
        if (['job_status', 'job_cancel'].includes(request.op) && result.jobId !== request.jobId) throw failure('SSH_WORKSPACE_PROTOCOL_INVALID', 'Windows helper returned a different command receipt', 502);
        if (['operation_status', 'operation_cancel'].includes(request.op)) {
          if (result.operationId !== request.operationId || result.generation !== input.generation
            || result.rootPath !== input.rootPath || !['running', 'completed', 'cancelled', 'unknown', 'not_found'].includes(String(result.state))
            || typeof result.cleanupConfirmed !== 'boolean'
            || (result.cleanupConfirmed === true && !['completed', 'cancelled'].includes(String(result.state)))) {
            throw failure('SSH_WORKSPACE_PROTOCOL_INVALID', 'Desktop agent returned an invalid file operation receipt', 502);
          }
        }
        return result;
      } catch (error) {
        if (request.op !== 'exec') {
          if (FILE_MUTATIONS.has(request.op) && error instanceof SshWorkspaceError
            && error.details?.requestDispatched === true && error.details?.transportConfirmed !== true) {
            throw failure('SSH_OPERATION_UNCONFIRMED', 'Windows file operation state is unknown; recover the original operation before starting another writer', 503,
              { originalCode: error.code, cleanupConfirmed: false, ...(operationId ? { operationId, jobId: `operation:${operationId}` } : {}) });
          }
          throw error;
        }
        // A second independent channel verifies teardown. Transport loss is never proof of remote exit.
        const cleanupInput = { ...input, signal: undefined };
        let confirmed = error instanceof SshWorkspaceError && ((error.details?.jobId === request.jobId && error.details?.cleanupConfirmed === true) || error.details?.requestDispatched === false);
        if (!confirmed) {
          try {
            const cleanup = await call(record, cleanupInput, { op: 'job_cancel', jobId: request.jobId }, undefined, dependencies.cleanupTimeoutMs ?? 10_000);
            confirmed = cleanup.jobId === request.jobId && cleanup.cleanupConfirmed === true;
          }
          catch { /* Caller keeps its writer barrier until an explicit job status/cancel succeeds. */ }
        }
        if (!confirmed) throw failure('SSH_EXECUTION_UNCONFIRMED', 'Windows command state is unknown; inspect or stop the original job before starting another writer', 503, { jobId: request.jobId, cleanupConfirmed: false, originalCode: error instanceof SshWorkspaceError ? error.code : 'SSH_WORKSPACE_OPERATION_FAILED' });
        if (error instanceof SshWorkspaceError) throw failure(error.code, error.message, error.statusCode, { ...error.details, jobId: request.jobId, cleanupConfirmed: true });
        throw failure('SSH_WORKSPACE_OPERATION_FAILED', 'Windows command failed after confirmed cleanup', 503, { jobId: request.jobId, cleanupConfirmed: true });
      }
    },
  };
}
const defaultTransport = createSshWorkspaceTransport();

/** Project settings use the account-filtered safe connection catalog. */
export const listSshConnections = defaultTransport.listSshConnections;
/** Project registration verifies the actual Windows helper and physical root before persisting a binding. */
export const probeSshWorkspace = defaultTransport.probeSshWorkspace;
/** Workspace/file/Git integrations call the explicit SSH transport; failures never fall back to server files or commands. */
export const executeSshWorkspace = defaultTransport.executeSshWorkspace;
