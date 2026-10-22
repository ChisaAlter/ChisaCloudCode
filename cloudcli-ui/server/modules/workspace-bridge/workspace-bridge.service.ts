import { chownSync, existsSync, lstatSync, realpathSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { request as httpRequest } from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

import { createSdkMcpServer, query as sdkQuery, tool } from '@anthropic-ai/claude-agent-sdk';
import type { SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { RequestHandler } from 'express';

import type { FileTreeFileSystem, SessionWorkspaceMode, WorkspaceGitFileSystem } from '@/shared/index.js';
import { AppError, WORKSPACES_ROOT, getWorkspaceSyncNetwork, isWorkspaceSyncControlHost, isWorkspaceSyncRecoveryOnly } from '@/shared/index.js';

import { copyPinnedSessionSnapshot, isolatedSessionGitRuntime } from './session-snapshot.service.js';
import { spawnWorkspaceProcess } from './workspace-process.service.js';
import { sharedSessionGitRuntime } from './session-objects.service.js';

type Binding = { root: string; host: string; port: number; token: string; bindingEpoch: string; readBatch: boolean; localGitRead: boolean; vps: boolean; isolated: boolean; sessionId?: string };
type RpcStats = { size: number; mtime: number; mode: number; dir: boolean; symlink: boolean };
type RpcResult = Partial<RpcStats> & { ok?: boolean; error?: string; code?: string; localGitRead?: boolean; gitBranch?: boolean; snapshotPinned?: boolean; releasedRunId?: string; bindingEpoch?: string; b64?: string; hash?: string; path?: string; entries?: Array<{ name: string; dir: boolean; stats?: RpcStats }>; results?: RpcResult[]; stdout?: string; stderr?: string; exitCode?: number; truncated?: boolean };
type FileTreeReadRequest = { op: 'stat' | 'lstat' | 'list'; path: string; includeStats?: boolean };
type PendingFileTreeRead = { request: FileTreeReadRequest; resolve(result: RpcResult): void; reject(error: unknown): void };
type WorkspaceRequestScope = { signal: AbortSignal; deadline: number; id: string };

const requestScopes = new AsyncLocalStorage<WorkspaceRequestScope>();
const CONTROL_BUDGET_MS = 620_000;
const REQUEST_BUDGET_MS = 2_000_000;

/** Used by File Tree and Git routes to bind queued work to the requesting HTTP operation. */
export const workspaceRequestScope: RequestHandler = (request, response, next) => {
  const supplied = Number(request.headers['x-chisa-deadline-ms']);
  const deadline = Math.min(Number.isFinite(supplied) && supplied > 0 ? supplied : Infinity, Date.now() + REQUEST_BUDGET_MS);
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort(new AppError('Workspace request cancelled; check its result before repeating it', { code: 'WORKSPACE_REQUEST_CANCELLED', statusCode: 499 }));
  const timer = setTimeout(cancel, Math.max(0, deadline - Date.now()));
  timer.unref();
  const finish = () => {
    clearTimeout(timer);
    request.off('aborted', cancel);
    response.off('close', disconnected);
  };
  const disconnected = () => { if (!response.writableFinished) cancel(); finish(); };
  request.once('aborted', cancel);
  response.once('close', disconnected);
  response.once('finish', finish);
  if (request.aborted || deadline <= Date.now()) cancel();
  requestScopes.run({ signal: cancellation.signal, deadline, id: randomUUID() }, next);
};

function operationSignal(signal?: AbortSignal): AbortSignal | undefined {
  const scoped = requestScopes.getStore()?.signal;
  return signal && scoped ? AbortSignal.any([signal, scoped]) : signal ?? scoped;
}

/** Git routes use the HTTP operation's cancellation for local Git and provider subprocesses. */
export function workspaceRequestSignal(): AbortSignal | undefined {
  const signal = requestScopes.getStore()?.signal;
  signal?.throwIfAborted();
  return signal;
}

function controlScope(signal?: AbortSignal, cleanup = false) {
  const controlDeadline = Date.now() + CONTROL_BUDGET_MS;
  const deadline = Math.min(controlDeadline, cleanup ? Infinity : requestScopes.getStore()?.deadline ?? Infinity);
  // The request scope owns its deadline and cancellation reason. A duplicate
  // timer at that deadline can race it and misreport cancellation as downtime.
  const timeout = AbortSignal.timeout(Math.max(0, controlDeadline - Date.now()));
  const cancellation = cleanup ? undefined : operationSignal(signal);
  return { deadline, signal: cancellation ? AbortSignal.any([timeout, cancellation]) : timeout };
}

function refreshedBinding(binding: Binding, candidate = binding.root, pinnedRead = false): Binding {
  const current = resolveWorkspaceBinding(candidate);
  if (!current || current.root !== binding.root || current.token !== binding.token || current.host !== binding.host || current.bindingEpoch !== binding.bindingEpoch || current.vps !== binding.vps || current.isolated !== binding.isolated || current.sessionId !== binding.sessionId || (pinnedRead && (current.port !== binding.port || current.readBatch !== binding.readBatch || current.localGitRead !== binding.localGitRead))) {
    throw new AppError('Workspace binding changed; synchronize the selected project before continuing', { code: 'STALE_BINDING', statusCode: 409 });
  }
  return current;
}

function combinedError(primary: unknown, cleanup: unknown): AppError {
  const error = primary instanceof Error ? primary : new Error(String(primary));
  const cleanupError = cleanup instanceof Error ? cleanup : new Error(String(cleanup));
  return Object.assign(new AppError(`${error.message}. Workspace cleanup was not confirmed; synchronize before starting another task.`, {
    code: primary instanceof AppError ? primary.code : 'code' in error && typeof error.code === 'string' ? error.code : 'WORKSPACE_OPERATION_FAILED',
    statusCode: primary instanceof AppError ? primary.statusCode : 503,
    details: { primaryName: error.name, primaryCode: 'code' in error ? error.code : undefined, cleanupName: cleanupError.name, cleanupCode: 'code' in cleanupError ? cleanupError.code : undefined },
  }), { cause: error, cleanupError, workspaceCleanupError: true });
}

async function completeWithCleanup<T>(operation: () => Promise<T>, cleanup: () => Promise<void>, signal?: AbortSignal): Promise<T> {
  let result: T | undefined;
  let failure: unknown;
  let failed = false;
  try { result = await operation(); } catch (error) { failure = error; failed = true; }
  try { await cleanup(); } catch (error) {
    if (failed) throw combinedError(failure, error);
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { workspaceCleanupError: true });
  }
  operationSignal(signal)?.throwIfAborted();
  if (failed) throw failure;
  return result as T;
}

function fileStatsFromRpc(result: Partial<RpcStats>) {
  return { size: result.size!, mtime: new Date(result.mtime! * 1000), mode: result.mode!, isDirectory: () => Boolean(result.dir), isSymbolicLink: () => Boolean(result.symlink) };
}

/** Used by workspace adapters; capability metadata is never passed to Claude. */
function resolveWorkspaceBinding(candidate: string): Binding | null {
  let root = path.resolve(candidate);
  const boundary = path.resolve(WORKSPACES_ROOT);
  if (root !== boundary && !root.startsWith(boundary + path.sep)) return null;
  while (root !== boundary) {
    const marker = path.join(root, '.chisa-bridge.json');
    if (existsSync(marker)) {
      let value: Record<string, unknown>;
      try {
        value = JSON.parse(readFileSync(marker, 'utf8')) as Record<string, unknown>;
      } catch {
        throw new AppError('This workspace binding has damaged metadata; recover it before starting again', { code: 'WORKSPACE_WORKTREE_CONFLICT', statusCode: 409 });
      }
      if ((value.protocol !== 1 && value.protocol !== 2) || !Number.isInteger(value.port) || Number(value.port) < 1024 || Number(value.port) > 65535 || typeof value.token !== 'string' || typeof value.bindingEpoch !== 'string') throw new AppError('Invalid workspace binding metadata', { code: 'WORKSPACE_WORKTREE_CONFLICT', statusCode: 409 });
      const host = value.controlHost === undefined ? '127.0.0.1' : value.controlHost;
      if (typeof host !== 'string' || !isWorkspaceSyncControlHost(host)) throw new AppError('Invalid workspace transport address', { code: 'WORKSPACE_UNAVAILABLE', statusCode: 503 });
      return { root, host, port: Number(value.port), token: value.token, bindingEpoch: value.bindingEpoch, readBatch: value.readBatch === true, localGitRead: value.localGitRead === true, vps: value.protocol === 2, isolated: value.execution === 'isolated-worktree', sessionId: typeof value.sessionId === 'string' ? value.sessionId : undefined };
    }
    root = path.dirname(root);
  }
  return null;
}

/** Worktrees checks this before removing a directory: an independently bound root must be unbound first so its return-synchronization callback stays available. */
export function isWorkspaceBindingRoot(candidate: string): boolean {
  return resolveWorkspaceBinding(candidate)?.root === path.resolve(candidate);
}

type GitProcessResult = { code: number | null; stdout: string; stderr: string };

function runGit(args: string[], cwd: string, signal?: AbortSignal): Promise<GitProcessResult> {
  return new Promise((resolve, reject) => {
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
    const env = { ...inherited, LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' };
    const child = spawn('git', ['-c', 'safe.directory=' + path.resolve(cwd), '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], signal, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let failure: Error | undefined;
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    // An abort error is delivered before close. Keep the reservation until the
    // actual Git process and its stdio have exited, including rollback paths.
    child.once('error', error => { failure = error; });
    child.once('close', code => failure ? reject(failure) : resolve({ code, stdout, stderr }));
  });
}

function sessionWorktreeName(sessionId: string): string {
  const readable = sessionId.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'session';
  // Keep the directory recognizable while making sanitized ids collision-resistant
  // (`a/b` and `a-b` must never share a retained worktree).
  const suffix = createHash('sha256').update(sessionId).digest('hex').slice(0, 12);
  return `${readable}-${suffix}`;
}

/**
 * Creates or reuses a per-session Git worktree. The worktree is deliberately
 * retained after the run so the user can inspect and merge it manually. A
 * non-Git synchronized directory returns null and remains on the shared-write
 * path rather than pretending that a copy is mergeable.
 */
async function createSessionWorktree(binding: Binding, sessionId: string, assertPinned: () => void, signal?: AbortSignal): Promise<Binding | null> {
  if (!binding.vps || binding.isolated) return binding;
  const parent = binding.root + '.chisa-worktrees';
  const worktreeRoot = path.join(parent, sessionWorktreeName(sessionId));
  const metadataPath = path.join(worktreeRoot, '.chisa-session.json');
  const markerPath = path.join(worktreeRoot, '.chisa-bridge.json');
  const existingMarker = existsSync(markerPath) && existsSync(metadataPath);
  if (existingMarker) {
    let metadata: { sessionId?: string; bindingEpoch?: string; sourceRoot?: string; branch?: string };
    try {
      metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as typeof metadata;
    } catch {
      throw new AppError('This session worktree has damaged metadata; recover it from Worktrees before starting again', { code: 'WORKSPACE_WORKTREE_CONFLICT', statusCode: 409 });
    }
    const existing = resolveWorkspaceBinding(worktreeRoot);
    if (
      metadata.sessionId !== sessionId
      || metadata.bindingEpoch !== binding.bindingEpoch
      || metadata.sourceRoot !== binding.root
      || !metadata.branch
      || !existing?.isolated
      || existing.sessionId !== sessionId
      || existing.bindingEpoch !== binding.bindingEpoch
    ) {
      throw new AppError('This session worktree belongs to a different project binding; recover it from Worktrees before starting again', { code: 'WORKSPACE_WORKTREE_CONFLICT', statusCode: 409 });
    }
    return existing;
  }
  if (existsSync(worktreeRoot)) throw new AppError('Session worktree path already exists; recover it from Worktrees before starting again', { code: 'WORKSPACE_WORKTREE_CONFLICT', statusCode: 409 });

  const repository = await runGit(['rev-parse', '--show-toplevel'], binding.root, signal);
  if (repository.code !== 0 || !repository.stdout.trim()) {
    if (repository.code !== 0 && /fatal: not a git repository(?: \(or any of the parent directories\))?:/i.test(repository.stderr)) return null;
    throw new AppError('Could not inspect the Git repository for an isolated session', {
      code: 'WORKSPACE_WORKTREE_CREATE_FAILED', statusCode: 503, details: repository.stderr.trim(),
    });
  }
  // A marker on a repository subdirectory would make the sibling worktree
  // path ambiguous. Keep that case on the shared-write path until a
  // repository-root-aware worktree mapping is available.
  if (path.resolve(repository.stdout.trim()) !== path.resolve(binding.root)) return null;
  const sourceGit = path.join(binding.root, '.git');
  const sourceGitStats = lstatSync(sourceGit);
  if (sourceGitStats.isSymbolicLink() || realpathSync(sourceGit) !== sourceGit) throw new AppError('The source Git directory is not canonical; recover the binding before creating an isolated workspace', { code: 'WORKSPACE_WORKTREE_CONFLICT', statusCode: 409 });
  // Linked/separate gitdirs need a repository-aware mapping before isolation;
  // they keep the explicit shared fallback rather than copy external Git state.
  if (!sourceGitStats.isDirectory()) return null;
  const branch = `chisa/session-private/${sessionWorktreeName(sessionId)}/work`;
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (!lstatSync(parent).isDirectory() || realpathSync(parent) !== parent) throw new AppError('The session worktree directory is not canonical', { code: 'WORKSPACE_WORKTREE_CONFLICT', statusCode: 409 });
  if (process.platform !== 'win32' && process.getuid?.() === 0) chownSync(parent, 1000, 1000);
  assertPinned();
  const created = await runGit(['worktree', 'add', '--no-checkout', '-b', branch, worktreeRoot, 'HEAD'], binding.root, signal);
  if (created.code !== 0) throw new AppError('Could not create the isolated session worktree', { code: 'WORKSPACE_WORKTREE_CREATE_FAILED', statusCode: 503, details: created.stderr.trim() });
  try {
    await copyPinnedSessionSnapshot(binding.root, worktreeRoot, runGit, assertPinned, signal);
    signal?.throwIfAborted();
    assertPinned();
    const marker = JSON.parse(readFileSync(path.join(binding.root, '.chisa-bridge.json'), 'utf8')) as Record<string, unknown>;
    writeFileSync(markerPath, JSON.stringify({ ...marker, execution: 'isolated-worktree', sessionId }), { mode: 0o600 });
    writeFileSync(metadataPath, JSON.stringify({ sessionId, bindingEpoch: binding.bindingEpoch, sourceRoot: binding.root, branch, createdAt: new Date().toISOString() }), { mode: 0o600 });
    const isolated = resolveWorkspaceBinding(worktreeRoot);
    if (!isolated) throw new AppError('Isolated session worktree was created without a valid workspace marker', { code: 'WORKSPACE_WORKTREE_CREATE_FAILED', statusCode: 503 });
    return isolated;
  } catch (error) {
    let rollbackError: unknown;
    const removed = await runGit(['worktree', 'remove', '--force', worktreeRoot], binding.root);
    if (removed.code !== 0) rollbackError = new Error(removed.stderr.trim() || `git worktree remove exited ${removed.code}`);
    // The branch was created together with this worktree. Remove it as part
    // of rollback so a failed snapshot does not strand the session id.
    const deleted = await runGit(['branch', '-D', branch], binding.root);
    if (deleted.code !== 0) rollbackError ??= new Error(deleted.stderr.trim() || `git branch delete exited ${deleted.code}`);
    if (rollbackError) {
      throw new AppError('Isolated session worktree creation failed and cleanup was not confirmed; recover it from Worktrees before retrying', {
        code: 'WORKSPACE_WORKTREE_ROLLBACK_FAILED',
        statusCode: 503,
        details: {
          creationError: error instanceof Error ? error.message : String(error),
          cleanupError: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        },
      });
    }
    throw error;
  }
}

function virtualPath(binding: Binding, candidate: string): string {
  if (candidate === '/workspace' || candidate.startsWith('/workspace/')) return candidate;
  const absolute = path.resolve(binding.root, candidate);
  const relative = path.relative(binding.root, absolute);
  if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) throw new Error('Path is outside the workspace');
  return '/workspace' + (relative ? '/' + relative.split(path.sep).join('/') : '');
}

function checkRpcResult(result: RpcResult, statusCode?: number): RpcResult {
  if (statusCode !== undefined || result.error) {
    const code = result.code || 'WORKSPACE_OPERATION_FAILED';
    // Filesystem existence errors remain errno errors for existing callers.
    if (code === 'ENOENT') throw Object.assign(new Error(result.error), { code });
    throw new AppError(result.error || 'Workspace operation failed', { code, statusCode: statusCode ?? (['CONTENT_CONFLICT', 'WORKSPACE_BUSY', 'WORKSPACE_GIT_UNSUPPORTED', 'WORKSPACE_GIT_CHANGED', 'WORKSPACE_GIT_OPERATION_IN_PROGRESS', 'WORKSPACE_GIT_CONFLICT', 'WORKSPACE_GIT_OPERATION', 'WORKSPACE_GIT_DIRTY', 'WORKSPACE_GIT_BRANCH_EXISTS', 'WORKSPACE_GIT_BRANCH_MISSING', 'WORKSPACE_GIT_REJECTED', 'SYNC_BLOCKED', 'SYNC_PAUSE_UNCONFIRMED', 'WORKSPACE_RELEASE_FAILED'].includes(code) ? 409 : code === 'WORKSPACE_UNAVAILABLE' ? 503 : 400) });
  }
  return result;
}

async function desktopControl(binding: Binding, request: Record<string, unknown>, cancellation?: AbortSignal, cleanup = false): Promise<RpcResult> {
  binding = scopedGitReadBinding(binding.root) ?? refreshedBinding(binding, binding.root, request.op === 'git_read');
  // The Go bridge expects the path's UTF-8 wire bytes in this header.
  const workspaceHeader = Buffer.from(binding.root, 'utf8').toString('latin1');
  const { signal, deadline } = controlScope(cancellation, cleanup);
  signal.throwIfAborted();
  const started = Date.now();
  const operation = String(request.op);
  // Built-in fetch has a separate 300-second headers timeout. Sync can legitimately
  // take longer, so this loopback RPC uses one deadline for headers and body.
  const response = await new Promise<{ result: RpcResult; statusCode: number }>((resolve, reject) => {
    const payload = JSON.stringify(request);
    const outgoing = httpRequest({
      hostname: binding.host, port: binding.port, path: '/workspace/rpc', method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'X-Bridge-Token': binding.token, 'X-Cwd': workspaceHeader, 'X-Binding-Epoch': binding.bindingEpoch, 'X-Chisa-Deadline-Ms': String(deadline) },
    }, incoming => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
      incoming.on('error', reject);
      incoming.on('end', () => {
        try { resolve({ result: JSON.parse(Buffer.concat(chunks).toString('utf8')) as RpcResult, statusCode: incoming.statusCode ?? 502 }); }
        catch (error) { reject(error); }
      });
    });
    outgoing.on('error', reject);
    // A Buffer keeps Node from re-encoding the Latin-1 header bytes with the JSON body.
    outgoing.end(Buffer.from(payload, 'utf8'));
  }).catch((error: unknown) => {
    const failure = error as NodeJS.ErrnoException;
    const timedOut = signal.aborted && signal.reason?.name === 'TimeoutError';
    const details = { operation, timedOut, transportCode: failure?.code, errorName: failure?.name, elapsedMs: Date.now() - started };
    // Never log the request, capability headers, project path or command payload.
    console.error('[workspace-control]', details);
    if (signal.aborted && !timedOut) throw signal.reason;
    const message = operation === 'sync_end'
      ? 'Workspace synchronization confirmation was not received. Do not resend completed work; use Sync now in the client to recover the workspace.'
      : operation === 'sync_begin' ? 'Workspace connection unavailable before task start. Reconnect the desktop client and synchronize the project.'
        : 'Workspace connection unavailable';
    throw new AppError(message, { code: 'WORKSPACE_UNAVAILABLE', statusCode: 503, details });
  });
  const result = response.result;
  if (binding.vps && String(request.op).startsWith('sync_') && result.error) {
    result.error = 'Project synchronization is blocked. Check synchronization details in the client settings.';
  }
  return checkRpcResult(result, response.statusCode >= 200 && response.statusCode < 300 ? undefined : response.statusCode);
}

type WorkspaceLease = { owner: 'claude' | 'sync-needed' | 'pi' | 'sync'; id: string; epoch: string; pid?: number; processStartTime?: string; bootId?: string; mayWrite?: boolean; cleanupPending?: string[] };

const activeWorkspaceLeases = new Map<string, WorkspaceLease>();

function requireWorkspaceAdmission(binding: Binding): void {
  if (isWorkspaceSyncRecoveryOnly(binding.root)) throw new AppError('Restore the pending workspace synchronization before starting new work', { code: 'WORKSPACE_RECOVERY_REQUIRED', statusCode: 409 });
}

/** The recovery service uses this exact in-process claim identity for legacy leases without a Linux birth identity. */
export function isActiveWorkspaceLease(candidate: string, leaseId: string, epoch: string): boolean {
  const active = activeWorkspaceLeases.get(path.resolve(candidate));
  return active?.id === leaseId && active.epoch === epoch;
}

function leaseDirectory(binding: Binding): string { return binding.root + '.chisa-lease'; }
function readLease(binding: Binding): WorkspaceLease | null {
  const directory = leaseDirectory(binding);
  if (!existsSync(directory)) return null;
  const statePath = path.join(directory, 'state.json');
  let raw: string;
  try {
    raw = readFileSync(statePath, 'utf8');
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    throw new AppError('Workspace reservation state could not be read; check the project permissions and synchronization state.', {
      code: 'WORKSPACE_LEASE_UNAVAILABLE',
      statusCode: 503,
      details: { statePath, errorName: failure.name, transportCode: failure.code },
    });
  }
  try {
    const parsed = JSON.parse(raw) as Partial<WorkspaceLease>;
    if (
      (parsed.owner !== 'claude' && parsed.owner !== 'sync-needed' && parsed.owner !== 'pi' && parsed.owner !== 'sync')
      || typeof parsed.id !== 'string'
      || typeof parsed.epoch !== 'string'
    ) throw new Error('invalid lease fields');
    return parsed as WorkspaceLease;
  } catch (error) {
    throw new AppError('Workspace reservation state is damaged; synchronize the project to recover it.', {
      code: 'WORKSPACE_LEASE_CORRUPT',
      statusCode: 503,
      details: { statePath, errorName: error instanceof Error ? error.name : 'Error' },
    });
  }
}
function saveLease(binding: Binding, lease: WorkspaceLease): void {
  const file = path.join(leaseDirectory(binding), 'state.json');
  writeFileSync(file + '.tmp', JSON.stringify(lease), { mode: 0o600 });
  renameSync(file + '.tmp', file);
}
function claimWorkspace(binding: Binding): WorkspaceLease {
  requireWorkspaceAdmission(binding);
  const processStat = process.platform === 'linux' ? readFileSync('/proc/self/stat', 'utf8') : '';
  const identity = process.platform === 'linux' ? { processStartTime: processStat.slice(processStat.lastIndexOf(')') + 2).trim().split(/\s+/)[19], bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() } : {};
  try {
    mkdirSync(leaseDirectory(binding), { mode: 0o700 });
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    if (failure.code === 'EEXIST') {
      // Preserve an unreadable/damaged lease diagnosis instead of turning it
      // into a generic busy state that gives the user no recovery direction.
      readLease(binding);
      throw new AppError('Workspace is reserved or waiting for synchronization. Finish the current task or synchronize it in desktop settings.', { code: 'WORKSPACE_BUSY', statusCode: 409 });
    }
    throw new AppError('Workspace reservation could not be created; check the project permissions and synchronization state.', {
      code: 'WORKSPACE_LEASE_UNAVAILABLE',
      statusCode: 503,
      details: { errorName: failure.name, transportCode: failure.code },
    });
  }
  const lease: WorkspaceLease = { owner: 'claude', id: randomUUID(), epoch: binding.bindingEpoch, pid: process.pid, ...identity, mayWrite: false };
  try {
    saveLease(binding, lease);
  } catch (error) {
    try { rmSync(leaseDirectory(binding), { recursive: true, force: true }); } catch { /* preserve the write error */ }
    throw new AppError('Workspace reservation could not be persisted; synchronize the project before retrying.', {
      code: 'WORKSPACE_LEASE_UNAVAILABLE',
      statusCode: 503,
      details: { errorName: error instanceof Error ? error.name : 'Error' },
    });
  }
  activeWorkspaceLeases.set(binding.root, lease);
  return lease;
}
async function releaseWorkspace(binding: Binding, lease: WorkspaceLease, prepared: boolean): Promise<void> {
  // Retain the barrier after disconnection; desktop recovery checks that the run ended.
  const latest = readLease(binding);
  const mayWrite = !prepared || (latest?.id === lease.id ? latest.mayWrite !== false : true);
  if (!latest || latest.id !== lease.id || latest.epoch !== lease.epoch) throw new AppError('Workspace reservation changed before cleanup', { code: 'WORKSPACE_BUSY', statusCode: 409 });
  if (binding.isolated) {
    if (latest.cleanupPending?.length) throw new AppError('Workspace container cleanup failed; remove the retained session worktree before continuing', { code: 'WORKSPACE_CLEANUP_FAILED', statusCode: 503 });
    const jobMarker = path.join(leaseDirectory(binding), 'sync-job.json');
    if (existsSync(jobMarker)) throw new AppError('A remote synchronization command has not confirmed exit; remove the retained session worktree before continuing', { code: 'WORKSPACE_CLEANUP_FAILED', statusCode: 503 });
    rmSync(leaseDirectory(binding), { recursive: true });
    if (activeWorkspaceLeases.get(binding.root)?.id === lease.id) activeWorkspaceLeases.delete(binding.root);
    return;
  }
  saveLease(binding, { ...latest, mayWrite, owner: 'sync-needed' });
  if (activeWorkspaceLeases.get(binding.root)?.id === lease.id) activeWorkspaceLeases.delete(binding.root);
  if (latest.cleanupPending?.length) throw new AppError('Workspace container cleanup failed; use Sync now to stop it safely before continuing', { code: 'WORKSPACE_CLEANUP_FAILED', statusCode: 503 });
  const jobMarker = path.join(leaseDirectory(binding), 'sync-job.json');
  if (existsSync(jobMarker)) throw new AppError('A remote synchronization command has not confirmed exit; use Sync now before continuing', { code: 'WORKSPACE_CLEANUP_FAILED', statusCode: 503 });
  const receipt = await desktopControl(binding, { op: 'sync_end', runId: lease.id, changed: mayWrite }, undefined, true);
  if (receipt.releasedRunId !== lease.id || receipt.bindingEpoch !== lease.epoch) {
    throw new AppError('Update the desktop client to confirm the exact workspace release; synchronize before starting another task', { code: 'WORKSPACE_CLEANUP_FAILED', statusCode: 503 });
  }
  // Native removes the exact lease atomically with sync-job admission and clears
  // its matching reservation before acknowledging. A new owner may already have
  // claimed the directory: never inspect, delete or notify on that owner's behalf.
  if (activeWorkspaceLeases.get(binding.root)?.id === lease.id) activeWorkspaceLeases.delete(binding.root);
}

function assertCurrentWorkspaceLease(binding: Binding, expected: WorkspaceLease | null): WorkspaceLease {
  const lease = readLease(binding);
  if (!expected || !lease || lease.id !== expected.id || lease.epoch !== expected.epoch || lease.owner !== expected.owner) throw new AppError('Workspace reservation changed during execution', { code: 'WORKSPACE_CLEANUP_FAILED', statusCode: 409 });
  return lease;
}

function recordContainer(binding: Binding, name: string, pending: boolean, expected: WorkspaceLease | null): void {
  if (!expected) return;
  const lease = assertCurrentWorkspaceLease(binding, expected);
  const names = new Set(lease.cleanupPending ?? []);
  if (pending) names.add(name); else names.delete(name);
  saveLease(binding, { ...lease, cleanupPending: [...names] });
}

function checkWorkspaceRequest(): void {
  requestScopes.getStore()?.signal.throwIfAborted();
}

async function removeWorkspaceContainer(name: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  const signal = AbortSignal.timeout(10_000);
  const run = (args: string[]) => new Promise<{ code: number | null; output: string; diagnostic: string }>((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'], signal, killSignal: 'SIGKILL' });
    let output = '';
    let diagnostic = '';
    let failure: Error | undefined;
    child.stdout.on('data', (chunk: Buffer) => { if (output.length < 65_536) output += chunk.toString().slice(0, 65_536 - output.length); });
    child.stderr.on('data', (chunk: Buffer) => { if (diagnostic.length < 2048) diagnostic += chunk.toString().slice(0, 2048 - diagnostic.length); });
    child.on('error', error => { failure = error; });
    child.on('close', code => { if (failure) reject(failure); else resolve({ code, output, diagnostic }); });
  });
  for (;;) {
    const removed = await run(['rm', '--force', name]);
    if (removed.code === 0) return;
    // Docker --rm may already be removing this exact container. A successful
    // daemon query must prove absence; transient presence is retried only within
    // this cleanup's original budget, while its durable lease remains held.
    const remaining = await run(['ps', '--all', '--filter', `name=^/${name}$`, '--format', '{{.Names}}']);
    const present = remaining.output.trim();
    if (remaining.code === 0 && !present) return;
    if (remaining.code === 0 && present === name && !signal.aborted && deadline - Date.now() > 100) {
      await delay(100, undefined, { signal });
      continue;
    }
    const diagnostic = removed.diagnostic + '\n' + remaining.diagnostic;
    const reason = /permission denied|access is denied/i.test(diagnostic) ? 'permission-denied' : /cannot connect|connection refused|daemon is not running|error during connect/i.test(diagnostic) ? 'daemon-unavailable' : present ? 'container-still-present' : 'daemon-query-failed';
    throw new AppError('Workspace container cleanup was not confirmed', { code: 'WORKSPACE_CLEANUP_FAILED', statusCode: 503, details: { removeExitCode: removed.code, queryExitCode: remaining.code, reason } });
  }
}

const preparedWorkspaceWorkers = new Map<string, Promise<RpcResult>>();
const preparedPreviewStartups = new Map<string, Set<Promise<void>>>();
const preparedWorkspaceReservations = new Map<string, string>();

async function waitPreparedPreviewStartups(root: string): Promise<void> {
  const startups = preparedPreviewStartups.get(root);
  if (startups) await Promise.all(startups);
}

function admittedWorkspaceLease(binding: Binding): WorkspaceLease | null {
  requireWorkspaceAdmission(binding);
  requireExecutionAccess(binding);
  const current = readLease(binding);
  if (current && (current.epoch !== binding.bindingEpoch || current.owner !== 'claude')) {
    throw new AppError('Workspace is reserved or waiting for synchronization', { code: 'WORKSPACE_BUSY', statusCode: 409 });
  }
  if (current?.cleanupPending?.length) {
    throw new AppError('Workspace container cleanup is not confirmed', { code: 'WORKSPACE_CLEANUP_FAILED', statusCode: 503 });
  }
  return current;
}

function workspaceRequestReadOnly(request: Record<string, unknown>): boolean {
  return ['stat', 'lstat', 'list', 'batch', 'realpath', 'read', 'search', 'grep', 'preview_status'].includes(String(request.op))
    || (request.op === 'exec' && request.readOnly === true);
}

function rejectBorrowedPreparedReservation(binding: Binding, lease: WorkspaceLease | null): void {
  if (lease && preparedWorkspaceReservations.get(binding.root) === lease.id) {
    throw new AppError('Workspace is reserved by another prepared operation', { code: 'WORKSPACE_BUSY', statusCode: 409 });
  }
}

function releasePreparedWorkerLease(binding: Binding, lease: WorkspaceLease): void {
  binding = refreshedBinding(binding);
  const current = readLease(binding);
  if (!current || current.id !== lease.id || current.epoch !== lease.epoch || current.owner !== 'claude'
    || current.cleanupPending?.length || existsSync(path.join(leaseDirectory(binding), 'sync-job.json'))) {
    throw new AppError('Workspace cleanup was not confirmed after execution', { code: 'WORKSPACE_CLEANUP_FAILED', statusCode: 503 });
  }
  rmSync(leaseDirectory(binding), { recursive: true });
  if (activeWorkspaceLeases.get(binding.root)?.id === lease.id) activeWorkspaceLeases.delete(binding.root);
}

async function vpsWorker(binding: Binding, request: Record<string, unknown>, signal?: AbortSignal): Promise<RpcResult> {
  signal = operationSignal(signal);
  signal?.throwIfAborted();
  // Queue only prepared execution: native callers already hold their Go lock,
  // so waiting behind sync_begin's desktop callback would invert those locks.
  const previous = preparedWorkspaceWorkers.get(binding.root) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    signal?.throwIfAborted();
    binding = refreshedBinding(binding);
    rejectExclusiveWorkspaceWrite(binding);
    const current = admittedWorkspaceLease(binding);
    rejectBorrowedPreparedReservation(binding, current);
    const readOnly = workspaceRequestReadOnly(request);
    // Idle snapshot reads do not transfer ownership. A prepared native write
    // claims synchronously before Docker can yield to a new model run.
    const lease = current ?? (readOnly ? null : claimWorkspace(binding));
    if (lease && !readOnly && lease.mayWrite !== true) saveLease(binding, { ...lease, mayWrite: true });
    if (!current && lease) preparedWorkspaceReservations.set(binding.root, lease.id);
    try {
      return await completeWithCleanup(() => runVPSWorker(binding, request, lease, signal), async () => {
        // Native execution is already prepared; its later explicit sync handles
        // handback. Calling sync_begin/sync_end here would recurse into its lock.
        if (!current && lease) releasePreparedWorkerLease(binding, lease);
      }, signal);
    } finally {
      if (!current && lease && preparedWorkspaceReservations.get(binding.root) === lease.id) preparedWorkspaceReservations.delete(binding.root);
    }
  });
  preparedWorkspaceWorkers.set(binding.root, operation);
  try { return await operation; }
  finally { if (preparedWorkspaceWorkers.get(binding.root) === operation) preparedWorkspaceWorkers.delete(binding.root); }
}

async function runVPSWorker(binding: Binding, request: Record<string, unknown>, lease: WorkspaceLease | null, signal?: AbortSignal): Promise<RpcResult> {
  // The kernel enforces read-only commands; command text is never used to guess writes.
  const readOnly = workspaceRequestReadOnly(request);
  const name = 'chisa-rpc-' + randomUUID();
  let gitRuntime: ReturnType<typeof isolatedSessionGitRuntime> | undefined;
  if (binding.isolated) {
    const metadata = JSON.parse(readFileSync(path.join(binding.root, '.chisa-session.json'), 'utf8')) as { sourceRoot: string; branch: string };
    gitRuntime = isolatedSessionGitRuntime(binding.root, metadata.sourceRoot, metadata.branch, readOnly);
  } else if (lease) gitRuntime = sharedSessionGitRuntime(binding.root, leaseDirectory(binding), readOnly, true);
  recordContainer(binding, name, true, lease);
  const args = ['run', '--rm', '--interactive', '--name', name,
    '--network=' + (getWorkspaceSyncNetwork(binding.root) ?? 'bridge'),
    '--label', 'chisa.workspace-root=' + createHash('sha256').update(binding.root).digest('hex'),
    '--user=1000:1000', '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '--pids-limit=256', '--memory=2g', '--hostname=workspace', '--workdir=/workspace', '--read-only',
    '--tmpfs=/tmp:rw,size=512m', '--tmpfs=/home/chisa:rw,size=512m',
    '--volume', binding.root + (readOnly ? ':/workspace:ro' : ':/workspace:rw'),
    ...(gitRuntime?.mounts ?? []),
    ...Object.entries(gitRuntime?.environment ?? {}).map(([key, value]) => `--env=${key}=${value}`),
    '--mount', 'type=bind,src=/dev/null,dst=/workspace/.chisa-bridge.json,readonly',
    ...(binding.isolated ? ['--mount', 'type=bind,src=/dev/null,dst=/workspace/.chisa-session.json,readonly', '--mount', `type=bind,src=${path.join(binding.root, '.git')},dst=/workspace/.git,readonly`] : []),
    '--env=HOME=/home/chisa', '--env=TZ=UTC',
    'localhost/chisa-workspace:3', 'python3', '/opt/chisa/workspace.py'];
  return completeWithCleanup(() => new Promise<RpcResult>((resolve, reject) => {
      const deadline = Math.min(Date.now() + 650_000, requestScopes.getStore()?.deadline ?? Infinity);
      const timeout = AbortSignal.timeout(Math.max(0, deadline - Date.now()));
      const cancellation = operationSignal(signal);
      const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'], killSignal: 'SIGKILL', signal: cancellation ? AbortSignal.any([cancellation, timeout]) : timeout });
      const chunks: Buffer[] = []; let length = 0; let diagnostic = '';
      let processError: Error | undefined;
      child.stdout.on('data', (chunk: Buffer) => {
        length += chunk.length;
        if (length > 24 * 1024 * 1024) { processError = new Error('Workspace response exceeds its limit'); child.kill('SIGKILL'); }
        else chunks.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => { if (diagnostic.length < 4096) diagnostic += chunk.toString(); });
      // Wait for the Docker client to exit before removing its container.
      child.on('error', error => { processError = error; });
      child.on('close', code => {
        if (processError) { reject(processError); return; }
        if (code !== 0) { console.error('[workspace-vps]', diagnostic); reject(new AppError('VPS workspace could not start', { code: 'WORKSPACE_UNAVAILABLE', statusCode: 503 })); return; }
        try { resolve(checkRpcResult(JSON.parse(Buffer.concat(chunks).toString()) as RpcResult)); }
        catch (error) { reject(error); }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(request));
    }), async () => {
      try { await removeWorkspaceContainer(name); if (!readOnly && gitRuntime) { const current = assertCurrentWorkspaceLease(binding, lease); if (!current.cleanupPending?.includes(name)) throw new AppError('Workspace container reservation changed before object publication', { code: 'WORKSPACE_CLEANUP_FAILED', statusCode: 409 }); await gitRuntime.publish(); } recordContainer(binding, name, false, lease); }
      catch (error) {
        let current = readLease(binding);
        const absent = !current;
        if (!current) current = claimWorkspace(binding);
        if (absent || (lease && current.id === lease.id && current.epoch === lease.epoch && current.owner === lease.owner)) saveLease(binding, {
          ...current, owner: 'sync-needed', cleanupPending: [...new Set([...(current.cleanupPending ?? []), name])],
        });
        throw new AppError('Workspace container cleanup failed; synchronize before starting another task', {
          code: 'WORKSPACE_CLEANUP_FAILED', statusCode: 503,
          details: { errorName: error instanceof Error ? error.name : 'Error', transportCode: error && typeof error === 'object' && 'code' in error ? error.code : undefined },
        });
      }
    });
}

function syncTransportBinding(candidate: string, bindingEpoch: string): Binding {
  const root = realpathSync(candidate);
  const boundary = realpathSync(WORKSPACES_ROOT);
  if (root === boundary || !root.startsWith(boundary + path.sep)) {
    throw new AppError('工作目录不属于当前实例', { code: 'WORKSPACE_UNAVAILABLE', statusCode: 403 });
  }
  const marker = lstatSync(path.join(root, '.chisa-bridge.json'));
  if (!marker.isFile() || marker.isSymbolicLink()) {
    throw new AppError('工作区绑定已失效', { code: 'STALE_BINDING', statusCode: 409 });
  }
  const binding = resolveWorkspaceBinding(root);
  if (!binding || !binding.vps || binding.root !== root || binding.bindingEpoch !== bindingEpoch) {
    throw new AppError('工作区绑定已失效', { code: 'STALE_BINDING', statusCode: 409 });
  }
  return binding;
}

/** Managed preview startup synchronously reserves its current binding; its consumer confirms container cleanup before releasing only this temporary lease. */
export function prepareSyncTransportPreview(candidate: string, bindingEpoch: string) {
  const binding = syncTransportBinding(candidate, bindingEpoch);
  const current = admittedWorkspaceLease(binding);
  rejectBorrowedPreparedReservation(binding, current);
  const lease = current ?? claimWorkspace(binding);
  if (lease.mayWrite !== true) saveLease(binding, { ...lease, mayWrite: true });
  let settled!: () => void;
  const startup = new Promise<void>(resolve => { settled = resolve; });
  const startups = preparedPreviewStartups.get(binding.root) ?? new Set<Promise<void>>();
  startups.add(startup);
  preparedPreviewStartups.set(binding.root, startups);
  if (!current) preparedWorkspaceReservations.set(binding.root, lease.id);
  const finishStartup = () => {
    settled();
    startups.delete(startup);
    if (startups.size === 0) preparedPreviewStartups.delete(binding.root);
    if (!current && preparedWorkspaceReservations.get(binding.root) === lease.id) preparedWorkspaceReservations.delete(binding.root);
  };
  return {
    root: binding.root,
    async finish(cleanupConfirmed: boolean, containerId?: string) {
      if (!cleanupConfirmed) {
        try {
          const latest = readLease(binding);
          if (containerId && latest?.id === lease.id && latest.epoch === lease.epoch && latest.owner === lease.owner) {
            saveLease(binding, {
              ...latest, owner: current ? latest.owner : 'sync-needed',
              cleanupPending: [...new Set([...(latest.cleanupPending ?? []), containerId])],
            });
          }
        } finally { finishStartup(); }
        return;
      }
      try {
        await preparedWorkspaceWorkers.get(binding.root)?.catch(() => {});
        if (!current) releasePreparedWorkerLease(binding, lease);
        else {
          const latest = admittedWorkspaceLease(refreshedBinding(binding));
          if (latest?.id !== lease.id) throw new AppError('Workspace reservation changed during preview startup', { code: 'WORKSPACE_BUSY', statusCode: 409 });
        }
      } finally { finishStartup(); }
    },
  };
}

/** Account sync transport uses the existing sandbox worker after the desktop has prepared its current binding. */
export async function executeSyncTransportWorker(candidate: string, bindingEpoch: string, request: Record<string, unknown>, signal?: AbortSignal): Promise<RpcResult> {
  signal?.throwIfAborted();
  const binding = syncTransportBinding(candidate, bindingEpoch);
  if (!['stat', 'lstat', 'list', 'batch', 'realpath', 'read', 'write', 'mkdir', 'rename', 'copy', 'remove', 'search', 'grep', 'exec'].includes(String(request.op))) {
    throw new AppError('无效的工作区操作', { code: 'INVALID_REQUEST', statusCode: 400 });
  }
  return vpsWorker(binding, request, signal);
}

const workspaceOperations = new Map<string, Promise<unknown>>();
async function enqueueWorkspaceOperation<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const previous = workspaceOperations.get(root) ?? Promise.resolve();
  const queued = previous.catch(() => {}).then(operation);
  workspaceOperations.set(root, queued);
  try { return await queued; }
  finally { if (workspaceOperations.get(root) === queued) workspaceOperations.delete(root); }
}

/** Worktrees protects every affected repository/worktree binding for one host Git transaction. Roots are deduplicated and acquired in fixed order; unbound paths retain their existing execution path. The operation must not re-enter workspace RPCs. */
export async function withWorkspaceMutation<T>(candidate: string | string[], operation: () => Promise<T>): Promise<T> {
  checkWorkspaceRequest();
  const bindings = new Map<string, Binding>();
  for (const path of typeof candidate === 'string' ? [candidate] : candidate) {
    const binding = resolveWorkspaceBinding(path);
    if (binding) {
      // Recovery can clear an ended execution before this transaction installs
      // its own queue entry; that entry must not hide native's exact release.
      discardRecoveredExecution(binding);
      bindings.set(binding.root, binding);
    }
  }
  const orderedBindings = [...bindings.values()].sort((left, right) => left.root.localeCompare(right.root));
  if (orderedBindings.length === 0) return operation();
  if (orderedBindings.some(binding => !binding.vps)) throw new AppError('Worktree mutations require a server-backed workspace', { code: 'WORKSPACE_OPERATION_UNSUPPORTED', statusCode: 409 });
  const signal = operationSignal();
  const enqueueRoots = (index: number): Promise<T> => index < orderedBindings.length
    ? enqueueWorkspaceOperation(orderedBindings[index].root, () => enqueueRoots(index + 1))
    : execute();
  const execute = () => {
    const claims: Array<{ binding: Binding; lease: WorkspaceLease; prepared: boolean }> = [];
    return completeWithCleanup(async () => {
      signal?.throwIfAborted();
      for (const initial of orderedBindings) {
        const binding = refreshedBinding(initial);
        requireWorkspaceAdmission(binding);
        discardRecoveredExecution(binding);
        rejectExclusiveWorkspaceWrite(binding);
        if (executionReservations.has(binding.root) || sharedWorkspaceExecutions.has(binding.root) || preparedWorkspaceWorkers.has(binding.root) || preparedPreviewStartups.has(binding.root)) throw new AppError("Workspace is in use by a task", { code: "WORKSPACE_BUSY", statusCode: 409 });
        claims.push({ binding, lease: claimWorkspace(binding), prepared: false });
      }
      for (const claim of claims) {
        if (!claim.binding.isolated) {
          await desktopControl(claim.binding, { op: 'sync_begin', runId: claim.lease.id }, signal);
          claim.prepared = true;
        }
        signal?.throwIfAborted();
        claim.binding = refreshedBinding(claim.binding);
        saveLease(claim.binding, { ...claim.lease, mayWrite: true });
      }
      return operation();
    }, async () => {
      const failures: unknown[] = [];
      for (const claim of [...claims].reverse()) {
        try {
          await preparedWorkspaceWorkers.get(claim.binding.root)?.catch(() => {});
          await waitPreparedPreviewStartups(claim.binding.root);
          await releaseWorkspace(claim.binding, claim.lease, claim.prepared);
        } catch (error) { failures.push(error); }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, 'Workspace transaction cleanup was not confirmed');
    });
  };
  return enqueueRoots(0);
}

type GitReadScope = { binding: Binding; cwd: string; native: boolean };
type WorkspaceWriteScope = { binding: Binding; lease: WorkspaceLease | null; active: boolean; parent?: WorkspaceWriteScope };
const gitReadScopes = new AsyncLocalStorage<GitReadScope>();
const writeScopes = new AsyncLocalStorage<WorkspaceWriteScope>();
const exclusiveWorkspaceWrites = new Map<string, WorkspaceWriteScope>();

function scopedGitReadBinding(candidate: string): Binding | undefined {
  const scope = gitReadScopes.getStore();
  if (!scope) return undefined;
  // Re-resolve both the selected project and each read path against the pinned
  // identity. A removed or nested replacement marker must never select a fallback.
  refreshedBinding(scope.binding, scope.cwd, true);
  refreshedBinding(scope.binding, candidate, true);
  return scope.binding;
}

/** Branch routes mutate the desktop's complete refs through its account-bound protocol. */
export async function runWorkspaceGitBranchOperation(cwd: string, action: 'checkout' | 'create' | 'delete', branch: string, force?: boolean): Promise<RpcResult | null> {
  checkWorkspaceRequest();
  const binding = resolveWorkspaceBinding(cwd);
  if (!binding || binding.isolated) return null;
  requireWorkspaceAdmission(binding);
  if (readLease(binding) || exclusiveWorkspaceWrites.has(binding.root) || workspaceOperations.has(binding.root) || sharedWorkspaceExecutions.has(binding.root)) {
    throw new AppError('Workspace is in use by a task or synchronization', { code: 'WORKSPACE_BUSY', statusCode: 409 });
  }
  const capability = binding.localGitRead ? await desktopControl(binding, { op: 'git_read', action: 'prepare' }) : null;
  if (!capability?.gitBranch) throw new AppError('Update the desktop client before changing workspace branches', { code: 'WORKSPACE_GIT_UNSUPPORTED', statusCode: 409 });
  return desktopControl(binding, { op: 'git_branch', action, branch, ...(action === 'delete' ? { force: force === true } : {}) });
}

/** Git routes select one source for the whole read, including file-content reads. */
export async function withWorkspaceGitReadOperation<T>(cwd: string, operation: () => Promise<T>): Promise<T> {
  checkWorkspaceRequest();
  const binding = resolveWorkspaceBinding(cwd);
  if (!binding) return operation();
  let native = false;
  // Native Git reads inspect the owning repository, including refs/remotes that
  // are deliberately absent from the synchronized execution replica.
  if (binding.localGitRead && !binding.isolated && !readLease(binding) && !exclusiveWorkspaceWrites.has(binding.root)) {
    try { native = (await desktopControl(binding, { op: 'git_read', action: 'prepare' })).localGitRead === true; }
    catch (error) {
      // A task can claim ownership between this observation and native admission.
      // Select the replica once; never switch sources halfway through a response.
      if (!(error instanceof AppError) || error.code !== 'WORKSPACE_BUSY') throw error;
    }
  }
  // Admission itself is asynchronous: do not enter with a replaced capability.
  refreshedBinding(binding, cwd, true);
  return gitReadScopes.run({ binding, cwd, native }, async () => {
    const result = await operation();
    // Routes buffer their JSON until this scope returns. Discard a response if
    // rebinding happened during the final request or was caught by its handler.
    checkWorkspaceRequest();
    refreshedBinding(binding, cwd, true);
    return result;
  });
}

/** Git mutations hold one exclusive reservation through preflight, writes and handback. */
export async function withWorkspaceWriteOperation<T>(cwd: string, operation: () => Promise<T>): Promise<T> {
  checkWorkspaceRequest();
  const binding = resolveWorkspaceBinding(cwd);
  if (!binding) return operation();
  requireWorkspaceAdmission(binding);
  discardRecoveredExecution(binding);
  if (scopedWriteLease(binding)) return operation();
  if (readLease(binding) || exclusiveWorkspaceWrites.has(binding.root) || workspaceOperations.has(binding.root) || preparedWorkspaceWorkers.has(binding.root) || sharedWorkspaceExecutions.has(binding.root) || executionReservations.has(binding.root)) {
    throw new AppError('Workspace is in use by a task or synchronization; wait for it to finish before changing Git.', { code: 'WORKSPACE_BUSY', statusCode: 409 });
  }
  const scope: WorkspaceWriteScope = { binding, lease: binding.vps ? claimWorkspace(binding) : null, active: true, parent: writeScopes.getStore() };
  exclusiveWorkspaceWrites.set(binding.root, scope);
  let prepared = false;
  try {
    return await completeWithCleanup(async () => {
      if (binding.vps && !binding.isolated) {
        await desktopControl(binding, { op: 'sync_begin', runId: scope.lease!.id });
        prepared = true;
      }
      checkWorkspaceRequest();
      refreshedBinding(binding);
      // Worktrees performs host Git mutations inside this scope as well as RPC
      // commands. Treat admission to a mutation scope as write-capable up front.
      if (scope.lease) saveLease(binding, { ...readLease(binding)!, mayWrite: true });
      return writeScopes.run(scope, operation);
    }, async () => {
      scope.active = false;
      if (scope.lease) {
        await preparedWorkspaceWorkers.get(binding.root)?.catch(() => {});
        await waitPreparedPreviewStartups(binding.root);
        await releaseWorkspace(binding, scope.lease, prepared);
      }
    });
  } finally {
    if (exclusiveWorkspaceWrites.get(binding.root) === scope) exclusiveWorkspaceWrites.delete(binding.root);
  }
}

function scopedWriteLease(binding: Binding): WorkspaceWriteScope | undefined {
  let scope = writeScopes.getStore();
  while (scope && scope.binding.root !== binding.root) scope = scope.parent;
  if (!scope) return undefined;
  if (!scope.active || exclusiveWorkspaceWrites.get(binding.root) !== scope) throw new AppError('Git operation reservation has ended', { code: 'WORKSPACE_BUSY', statusCode: 409 });
  if (scope.lease) {
    const lease = readLease(binding);
    if (!lease || lease.id !== scope.lease.id || lease.epoch !== scope.lease.epoch || lease.owner !== 'claude') throw new AppError('Git operation reservation changed', { code: 'WORKSPACE_BUSY', statusCode: 409 });
  }
  return scope;
}

function rejectExclusiveWorkspaceWrite(binding: Binding): void {
  if (exclusiveWorkspaceWrites.has(binding.root) && !scopedWriteLease(binding)) {
    throw new AppError('Workspace is reserved by another Git operation', { code: 'WORKSPACE_BUSY', statusCode: 409 });
  }
}

/**
 * Local bridge bindings do not have the VPS sync lease protocol. Keep a
 * process-local project execution barrier for the shared-root fallback so two
 * sessions cannot mutate the same non-Git workspace concurrently. Git sessions
 * leave this barrier by switching to their retained session worktree first.
 */
const sharedWorkspaceExecutions = new Map<string, Promise<void>>();
type ExecutionReservation = { binding: Binding; lease: WorkspaceLease | null; active: boolean; readOnly: boolean; operations: Set<Promise<unknown>>; teardownConfirmed: boolean };
const executionReservations = new Map<string, ExecutionReservation>();
const executionScopes = new AsyncLocalStorage<ExecutionReservation>();

function discardRecoveredExecution(binding: Binding): void {
  const reservation = executionReservations.get(binding.root);
  if (reservation && !reservation.active && reservation.teardownConfirmed && reservation.operations.size === 0 && !preparedWorkspaceWorkers.has(binding.root) && !preparedPreviewStartups.has(binding.root) && !workspaceOperations.has(binding.root) && !readLease(binding)) {
    // Native recovery has atomically released the old durable barrier. No task
    // process/tools remain, so the in-process reservation must not require restart.
    executionReservations.delete(binding.root);
  }
}

function requireExecutionAccess(binding: Binding): void {
  discardRecoveredExecution(binding);
  const reservation = executionReservations.get(binding.root);
  const scope = executionScopes.getStore();
  if (reservation && (scope !== reservation || !reservation.active)) throw new AppError('Workspace is reserved by another running task', { code: 'WORKSPACE_BUSY', statusCode: 409 });
  if (scope?.binding.root === binding.root && (!scope.active || reservation !== scope)) throw new AppError('The task workspace reservation has ended', { code: 'WORKSPACE_BUSY', statusCode: 409 });
}

function abortableBarrier(signal?: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

async function acquireSharedWorkspaceExecution(root: string, signal?: AbortSignal): Promise<() => void> {
  const previous = sharedWorkspaceExecutions.get(root) ?? Promise.resolve();
  let release!: () => void;
  let cancelled = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  const current = previous.catch(() => {}).then(async () => {
    if (cancelled) return;
    await held;
  });
  sharedWorkspaceExecutions.set(root, current);
  try {
    await Promise.race([previous, abortableBarrier(signal)]);
    signal?.throwIfAborted();
    return () => {
      release();
      if (sharedWorkspaceExecutions.get(root) === current) sharedWorkspaceExecutions.delete(root);
    };
  } catch (error) {
    cancelled = true;
    // Leave the queue entry until the preceding owner has finished. This lets
    // the next waiter pass through without making a cancelled waiter reorder
    // project execution.
    current.finally(() => {
      if (sharedWorkspaceExecutions.get(root) === current) sharedWorkspaceExecutions.delete(root);
    }).catch(() => {});
    throw error;
  }
}

async function rpc(binding: Binding, request: Record<string, unknown>, signal?: AbortSignal): Promise<RpcResult> {
  const scope = executionScopes.getStore();
  if (!scope || scope.binding.root !== binding.root) return executeRpc(binding, request, signal);
  assertExactExecution(scope);
  if (scope.readOnly && workspaceRequestWrites(request)) throw new AppError('This task is read-only', { code: 'WORKSPACE_READ_ONLY', statusCode: 409 });
  const operation = executeRpc(binding, request, signal);
  scope.operations.add(operation);
  try { return await operation; }
  finally { scope.operations.delete(operation); }
}

async function executeRpc(binding: Binding, request: Record<string, unknown>, signal?: AbortSignal): Promise<RpcResult> {
  signal = operationSignal(signal);
  signal?.throwIfAborted();
  binding = scopedGitReadBinding(binding.root) ?? refreshedBinding(binding);
  const gitRead = gitReadScopes.getStore();
  if (gitRead?.native && !workspaceRequestWrites(request)) {
    if (!['stat', 'lstat', 'read', 'realpath'].includes(String(request.op))) {
      throw new AppError('This read is not supported by the selected native Git source', { code: 'WORKSPACE_GIT_UNSUPPORTED', statusCode: 409 });
    }
    const result = await desktopControl(binding, { op: 'git_read', action: request.op, path: request.path }, signal);
    scopedGitReadBinding(binding.root);
    return result;
  }
  const writes = workspaceRequestWrites(request);
  if (writes) { rejectExclusiveWorkspaceWrite(binding); requireExecutionAccess(binding); }
  if (!binding.vps) return desktopControl(binding, request, signal);
  // Snapshot reads remain available during a task or failed synchronization.
  // The kernel mounts the replica read-only; no ownership is borrowed.
  if (!writes) return runVPSWorker(binding, request, null, signal);
  requireWorkspaceAdmission(binding);
  requireExecutionAccess(binding);
  const scope = scopedWriteLease(binding);
  if (scope?.lease) {
    const current = readLease(binding)!;
    if (current.mayWrite !== true) saveLease(binding, { ...current, mayWrite: true });
    return String(request.op).startsWith('preview_') ? desktopControl(binding, request, signal) : runVPSWorker(binding, request, scope.lease, signal);
  }
  // File Tree and model tools retain their existing per-command serialization.
  const previous = workspaceOperations.get(binding.root) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    signal?.throwIfAborted();
    binding = refreshedBinding(binding);
    const current = admittedWorkspaceLease(binding);
    rejectBorrowedPreparedReservation(binding, current);
    // Browsing a server snapshot does not transfer execution ownership.
    if (!current && ['stat', 'lstat', 'list', 'batch', 'realpath', 'read', 'search', 'grep'].includes(String(request.op))) {
      return vpsWorker(binding, request, signal);
    }
    const lease = current ?? claimWorkspace(binding);
    let prepared = Boolean(current);
    return completeWithCleanup(async () => {
      if (!current && !binding.isolated) {
        await desktopControl(binding, { op: 'sync_begin', runId: lease.id }, signal);
        prepared = true;
      }
      signal?.throwIfAborted();
      binding = refreshedBinding(binding);
      const readOnly = ['stat', 'lstat', 'list', 'batch', 'realpath', 'read', 'search', 'grep', 'preview_status'].includes(String(request.op))
        || (request.op === 'exec' && request.readOnly === true);
      // Mark before execution so cancellation or a failed write still follows full recovery.
      if (!readOnly && lease.mayWrite !== true) saveLease(binding, { ...readLease(binding)!, mayWrite: true });
      return String(request.op).startsWith('preview_') ? await desktopControl(binding, request, signal) : await vpsWorker(binding, request, signal);
    }, async () => {
      if (!current) {
        await preparedWorkspaceWorkers.get(binding.root)?.catch(() => {});
        await waitPreparedPreviewStartups(binding.root);
        await releaseWorkspace(binding, lease, prepared);
      }
    });
  });
  workspaceOperations.set(binding.root, operation);
  try { return await operation; }
  finally { if (workspaceOperations.get(binding.root) === operation) workspaceOperations.delete(binding.root); }
}

async function fileCall(candidate: string, op: string, extra: Record<string, unknown> = {}): Promise<RpcResult | null> {
  checkWorkspaceRequest();
  const binding = scopedGitReadBinding(candidate) ?? resolveWorkspaceBinding(candidate);
  if (!binding) return null;
  const result = await rpc(binding, { op, path: virtualPath(binding, candidate), ...extra });
  scopedGitReadBinding(candidate);
  return result;
}

/** Git routes explicitly mark reads; mapped desktop reads use the selected owner capability. */
export async function runWorkspaceCommand(cwd: string, command: string, args: string[], options: { readOnly?: boolean } = {}): Promise<RpcResult | null> {
  checkWorkspaceRequest();
  const binding = scopedGitReadBinding(cwd) ?? resolveWorkspaceBinding(cwd);
  if (!binding) return null;
  const workspaceArgs = args.map(arg => arg === binding.root || arg.startsWith(binding.root + path.sep) ? virtualPath(binding, arg) : arg);
  const gitRead = gitReadScopes.getStore();
  if (options.readOnly && gitRead?.native && command !== 'git') {
    throw new AppError('This command is not supported by the selected native Git source', { code: 'WORKSPACE_GIT_UNSUPPORTED', statusCode: 409 });
  }
  const result = options.readOnly && command === 'git' && gitRead?.native
    ? await desktopControl(binding, { op: 'git_read', action: 'command', path: virtualPath(binding, cwd), argv: ['git', '--no-optional-locks', ...workspaceArgs] })
    : await rpc(binding, { op: 'exec', path: virtualPath(binding, cwd), argv: [command, ...(command === 'git' ? ['--literal-pathspecs', ...(options.readOnly ? ['--no-optional-locks'] : [])] : []), ...workspaceArgs], timeoutSeconds: 60, readOnly: options.readOnly === true });
  scopedGitReadBinding(cwd);
  // Git's repository-root response is a path consumed by server routing.
  if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--show-toplevel' && result.exitCode === 0) {
    const root = result.stdout?.trim();
    if (root === '/workspace' || root?.startsWith('/workspace/')) result.stdout = path.join(binding.root, path.relative('/workspace', root)) + '\n';
  }
  return result;
}

/** Used by File Tree composition; normal server projects keep their existing adapter. */
export function bridgeFileSystem(base: FileTreeFileSystem): FileTreeFileSystem {
  const pendingReads = new Map<string, PendingFileTreeRead[]>();

  async function sendReadBatch(binding: Binding, pending: PendingFileTreeRead[]): Promise<void> {
    try {
      const results = pending.length === 1
        ? [await rpc(binding, pending[0]!.request)]
        : (await rpc(binding, { op: 'batch', requests: pending.map(item => item.request) })).results!;
      for (let index = 0; index < pending.length; index += 1) {
        const item = pending[index]!;
        try { item.resolve(checkRpcResult(results[index]!)); }
        catch (error) { item.reject(error); }
      }
    } catch (error) {
      for (const item of pending) item.reject(error);
    }
  }

  async function drainReadQueue(binding: Binding, key: string, pending: PendingFileTreeRead[]): Promise<void> {
    try {
      while (pending.length > 0) {
        await sendReadBatch(binding, pending.splice(0, 64));
      }
    } finally {
      pendingReads.delete(key);
    }
  }

  async function readCall(candidate: string, op: FileTreeReadRequest['op'], includeStats = false): Promise<RpcResult | null> {
    checkWorkspaceRequest();
    const binding = scopedGitReadBinding(candidate) ?? resolveWorkspaceBinding(candidate);
    if (!binding) return null;
    const request: FileTreeReadRequest = { op, path: virtualPath(binding, candidate), ...(includeStats ? { includeStats: true } : {}) };
    if (!binding.readBatch || gitReadScopes.getStore()?.native) {
      const result = await rpc(binding, request);
      scopedGitReadBinding(candidate);
      return result;
    }
    const key = JSON.stringify([binding.root, binding.bindingEpoch, binding.port, binding.token, requestScopes.getStore()?.id]);
    const result = await new Promise<RpcResult>((resolve, reject) => {
      let pending = pendingReads.get(key);
      if (!pending) {
        pending = [];
        pendingReads.set(key, pending);
        const queued = pending;
        // Keep one batch in flight so traversal reads arriving meanwhile accumulate together.
        queueMicrotask(() => {
          void drainReadQueue(binding, key, queued);
        });
      }
      pending.push({ request, resolve, reject });
    });
    scopedGitReadBinding(candidate);
    return result;
  }

  async function stats(candidate: string, op: 'stat' | 'lstat') {
    const result = await readCall(candidate, op);
    return result ? fileStatsFromRpc(result) : base[op](candidate);
  }
  return {
    async readTextSnapshot(p) {
      const r = await fileCall(p, 'read');
      return r ? { content: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(r.b64!, 'base64')), hash: r.hash } : { content: await base.readTextFile(p) };
    },
    async writeTextSnapshot(p, content, expectedHash) {
      checkWorkspaceRequest();
      const binding = resolveWorkspaceBinding(p);
      if (!binding) { await base.writeTextFile(p, content); return {}; }
      if (expectedHash === undefined) throw new AppError('Read the workspace file again before saving', { code: 'CONTENT_CONFLICT', statusCode: 409 });
      const r = await rpc(binding, { op: 'write', path: virtualPath(binding, p), b64: Buffer.from(content).toString('base64'), expectedHash });
      return { hash: r.hash };
    },
    async access(p) { if (!(await readCall(p, 'stat'))) await base.access(p); },
    stat: p => stats(p, 'stat'), lstat: p => stats(p, 'lstat'),
    async *openDirectory(p) {
      const result = await readCall(p, 'list', true);
      if (!result) { yield* base.openDirectory(p); return; }
      for (const entry of result.entries!) yield { name: entry.name, isDirectory: () => entry.dir, stats: entry.stats ? fileStatsFromRpc(entry.stats) : undefined };
    },
    async realpath(p) {
      checkWorkspaceRequest();
      const binding = scopedGitReadBinding(p) ?? resolveWorkspaceBinding(p);
      if (!binding) return base.realpath(p);
      const result = await rpc(binding, { op: 'realpath', path: virtualPath(binding, p) });
      scopedGitReadBinding(p);
      return path.join(binding.root, path.relative('/workspace', result.path!));
    },
    async readTextFile(p) { const result = await fileCall(p, 'read'); return result ? Buffer.from(result.b64!, 'base64').toString('utf8') : base.readTextFile(p); },
    async writeTextFile(p, content) {
      checkWorkspaceRequest();
      const binding = resolveWorkspaceBinding(p);
      if (!binding) return base.writeTextFile(p, content);
      // File Tree uses this method only to create files; an intervening local
      // creation must conflict rather than becoming a new overwrite baseline.
      await rpc(binding, { op: 'write', path: virtualPath(binding, p), expectedHash: null, b64: Buffer.from(content).toString('base64') });
    },
    async makeDirectory(p, recursive) { if (!(await fileCall(p, 'mkdir', { recursive }))) await base.makeDirectory(p, recursive); },
    async rename(p, destination) {
      checkWorkspaceRequest();
      const binding = resolveWorkspaceBinding(p);
      if (!binding) return base.rename(p, destination);
      await rpc(binding, { op: 'rename', path: virtualPath(binding, p), destination: virtualPath(binding, destination) });
    },
    async removeDirectory(p) { if (!(await fileCall(p, 'remove'))) await base.removeDirectory(p); },
    async unlink(p) { if (!(await fileCall(p, 'remove'))) await base.unlink(p); },
    async copyFile(p, destination) {
      checkWorkspaceRequest();
      const binding = resolveWorkspaceBinding(p);
      const target = resolveWorkspaceBinding(destination);
      if (!binding && !target) return base.copyFile(p, destination);
      if (!binding && target) {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of base.createReadStream(p)) {
          const bytes = Buffer.from(chunk); size += bytes.length;
          if (size > 8 * 1024 * 1024) throw new AppError('Workspace uploads are limited to 8 MiB', { statusCode: 413, code: 'FILE_TOO_LARGE' });
          chunks.push(bytes);
        }
        await rpc(target, { op: 'write', path: virtualPath(target, destination), expectedHash: null, b64: Buffer.concat(chunks).toString('base64') });
        return;
      }
      if (!binding || target?.root !== binding.root) throw new AppError('Copy must stay inside one workspace', { statusCode: 400, code: 'CROSS_WORKSPACE_COPY' });
      await rpc(binding, { op: 'copy', path: virtualPath(binding, p), destination: virtualPath(binding, destination) });
    },
    createReadStream(p) {
      checkWorkspaceRequest();
      const binding = scopedGitReadBinding(p) ?? resolveWorkspaceBinding(p);
      if (!binding) return base.createReadStream(p);
      return Readable.from((async function* () {
        const result = await rpc(binding, { op: 'read', path: virtualPath(binding, p) });
        scopedGitReadBinding(p);
        yield Buffer.from(result.b64!, 'base64');
      })());
    },
  };
}

/** Used by Git composition for its file-content and untracked-file operations. */
export function bridgeGitFileSystem(base: WorkspaceGitFileSystem): WorkspaceGitFileSystem {
  return {
    async access(p) { if (!(await fileCall(p, 'stat'))) await base.access(p); },
    async stat(p) {
      const r = await fileCall(p, 'stat');
      return r ? { size: r.size!, mtime: new Date(r.mtime! * 1000), mode: r.mode!, isDirectory: () => Boolean(r.dir), isSymbolicLink: () => Boolean(r.symlink) } : base.stat(p);
    },
    async readFile(p, encoding) {
      const r = await fileCall(p, 'read');
      return r ? new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(r.b64!, 'base64')) : base.readFile(p, encoding);
    },
    async rm(p, options) { if (!(await fileCall(p, 'remove'))) await base.rm(p, options); },
    async unlink(p) { if (!(await fileCall(p, 'remove'))) await base.unlink(p); },
  };
}

const READ_ONLY_WORKSPACE_OPS = new Set(['stat', 'lstat', 'list', 'batch', 'realpath', 'read', 'search', 'grep', 'preview_status']);

function workspaceRequestWrites(request: Record<string, unknown>): boolean {
  if (request.op === 'exec') return request.readOnly !== true;
  return !READ_ONLY_WORKSPACE_OPS.has(String(request.op));
}

function workspaceTools(binding: Binding, signal?: AbortSignal, readOnlySession = false) {
  const reservation = executionReservations.get(binding.root);
  const call = (request: Record<string, unknown>) => reservation ? executionScopes.run(reservation, () => rpc(binding, request, signal)) : rpc(binding, request, signal);
  async function result(request: Record<string, unknown>) {
    if (readOnlySession && workspaceRequestWrites(request)) {
      return { isError: true, content: [{ type: 'text' as const, text: '当前会话是只读检查模式，不能修改项目文件、运行写入命令或控制预览。' }] };
    }
    try { return { content: [{ type: 'text' as const, text: JSON.stringify(await call(request)) }] }; }
    catch (error) { return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'Workspace operation failed' }] }; }
  }
  return createSdkMcpServer({ name: 'workspace', version: '1.0.0', tools: [
    tool('list_files', 'List files in the project workspace.', { path: z.string().default('/workspace') }, a => result({ op: 'list', ...a })),
    tool('read_file', 'Read a file and its SHA256 hash. Select base64 for binary files. Use this hash when writing.', { path: z.string(), encoding: z.enum(['utf8', 'base64']).default('utf8') }, async a => {
      try {
        const r = await call({ op: 'read', ...a });
        const content = a.encoding === 'base64' ? r.b64 : new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(r.b64!, 'base64'));
        return { content: [{ type: 'text' as const, text: JSON.stringify({ content, encoding: a.encoding, hash: r.hash }) }] };
      } catch (e) { return { isError: true, content: [{ type: 'text' as const, text: e instanceof Error ? e.message : 'Read failed' }] }; }
    }),
    tool('write_file', 'Write a UTF-8 file. Existing files require the hash from read_file; new files require null.', { path: z.string(), content: z.string(), expectedHash: z.string().nullable() }, a => result({ op: 'write', path: a.path, b64: Buffer.from(a.content).toString('base64'), expectedHash: a.expectedHash })),
    tool('search_files', 'Search filenames or text in the project.', { path: z.string().default('/workspace'), query: z.string(), content: z.boolean().default(false) }, a => result({ op: a.content ? 'grep' : 'search', path: a.path, query: a.query })),
    tool('run_command', 'Execute a Linux command. Set readOnly=true for code review, inspection and other commands that do not write project files; the workspace is mounted read-only. Use readOnly=false for builds, installs, edits and Git changes. Output and exit code are returned unchanged.', { command: z.string(), path: z.string().default('/workspace'), readOnly: z.boolean().default(false), timeoutSeconds: z.number().int().min(1).max(600).default(60) }, a => result({ op: 'exec', ...a })),
    tool('start_preview', 'Start a persistent web preview. The service must bind 0.0.0.0 at the supplied port. Preview links are shown in the client.', { command: z.string(), path: z.string().default('/workspace'), port: z.number().int().min(1024).max(65535) }, a => result({ op: 'preview_start', ...a })),
    tool('preview_status', 'Read preview process state, readiness and recent logs.', { previewId: z.string() }, a => result({ op: 'preview_status', ...a })),
    tool('stop_preview', 'Stop a preview and release its container and port.', { previewId: z.string() }, a => result({ op: 'preview_stop', ...a })),
  ] });
}

type WorkspaceExecutionOptions = { cwd: string; sessionId?: string | null; workspaceMode?: SessionWorkspaceMode; readOnly?: boolean; signal?: AbortSignal; directExecution?: boolean };

function checkExecutionRoot(candidate: string): void {
  const actual = existsSync(candidate) ? realpathSync(candidate) : path.resolve(candidate);
  const boundary = existsSync(WORKSPACES_ROOT) ? realpathSync(WORKSPACES_ROOT) : path.resolve(WORKSPACES_ROOT);
  if (actual === boundary) throw new AppError('Select a project before starting a task; the workspace root contains all projects', { code: 'WORKSPACE_PROJECT_REQUIRED', statusCode: 400 });
}

function assertExactExecution(reservation: ExecutionReservation): void {
  requireWorkspaceAdmission(reservation.binding);
  refreshedBinding(reservation.binding);
  if (!reservation.active || executionReservations.get(reservation.binding.root) !== reservation) throw new AppError('Workspace execution reservation changed', { code: 'WORKSPACE_BUSY', statusCode: 409 });
  if (reservation.lease) {
    const current = readLease(reservation.binding);
    if (!current || current.id !== reservation.lease.id || current.epoch !== reservation.lease.epoch || current.owner !== 'claude' || current.cleanupPending?.length) throw new AppError('Workspace execution lease changed', { code: 'WORKSPACE_BUSY', statusCode: 409 });
  }
}

async function migrateSessionBranch(binding: Binding, sessionId: string, signal?: AbortSignal): Promise<void> {
  const file = path.join(binding.root, '.chisa-session.json');
  const metadata = JSON.parse(readFileSync(file, 'utf8')) as { sourceRoot: string; branch: string; [key: string]: unknown };
  const branch = `chisa/session-private/${sessionWorktreeName(sessionId)}/work`;
  if (metadata.branch === branch) return;
  const old = metadata.branch;
  if (old !== `chisa/session/${sessionWorktreeName(sessionId)}`) throw new AppError('The retained session branch identity changed', { code: 'WORKSPACE_WORKTREE_CONFLICT', statusCode: 409 });
  const result = await runGit(['symbolic-ref', '--short', 'HEAD'], binding.root, signal);
  if (result.code !== 0 || result.stdout.trim() !== old) throw new AppError('The retained session branch was changed manually; recover it before continuing', { code: 'WORKSPACE_WORKTREE_CONFLICT', statusCode: 409 });
  const tip = await runGit(['rev-parse', 'HEAD'], binding.root, signal);
  if (tip.code !== 0) throw new AppError('The retained session commit cannot be read', { code: 'WORKSPACE_WORKTREE_CONFLICT', statusCode: 409 });
  // Keep the old ref as a recovery backup. update-ref's empty old value is CAS:
  // never replace another ref merely because a previous migration was stopped.
  const created = await runGit(['update-ref', `refs/heads/${branch}`, tip.stdout.trim(), ''], binding.root, signal);
  if (created.code !== 0) {
    const existing = await runGit(['rev-parse', `refs/heads/${branch}`], binding.root, signal);
    if (existing.code !== 0 || existing.stdout.trim() !== tip.stdout.trim()) throw new AppError('A conflicting private session branch already exists', { code: 'WORKSPACE_WORKTREE_CONFLICT', statusCode: 409 });
  }
  const moved = await runGit(['symbolic-ref', 'HEAD', `refs/heads/${branch}`], binding.root, signal);
  if (moved.code !== 0) throw new AppError('The session branch migration was not confirmed', { code: 'WORKSPACE_WORKTREE_CONFLICT', statusCode: 409 });
  writeFileSync(file + '.tmp', JSON.stringify({ ...metadata, branch }), { mode: 0o600 });
  renameSync(file + '.tmp', file);
}

/** Providers use this admission before launch and await close after actual process/tool teardown. */
export async function admitWorkspaceExecution(input: WorkspaceExecutionOptions) {
  const signal = operationSignal(input.signal);
  signal?.throwIfAborted();
  checkExecutionRoot(input.cwd);
  let binding = resolveWorkspaceBinding(input.cwd);
  const readOnly = input.readOnly === true;
  const sourceCwd = input.cwd;
  const workspaceMode = input.workspaceMode === 'shared' ? 'shared' : 'isolated';
  let sourceRoot = binding?.root ?? input.cwd;
  if (binding?.isolated) {
    const metadata = JSON.parse(readFileSync(path.join(binding.root, '.chisa-session.json'), 'utf8')) as { sourceRoot: string; sessionId: string; bindingEpoch: string };
    const source = resolveWorkspaceBinding(metadata.sourceRoot);
    if (!source || source.isolated || source.root !== metadata.sourceRoot || source.bindingEpoch !== metadata.bindingEpoch || source.bindingEpoch !== binding.bindingEpoch || metadata.sessionId !== binding.sessionId || (input.sessionId && input.sessionId !== metadata.sessionId)) throw new AppError('The retained session belongs to a different workspace binding', { code: 'WORKSPACE_WORKTREE_CONFLICT', statusCode: 409 });
    sourceRoot = source.root;
  }
  if (binding && input.directExecution && !binding.vps) throw new AppError('This provider needs a runnable VPS workspace; the local bridge requires workspace tools', { code: 'WORKSPACE_PROVIDER_UNSUPPORTED', statusCode: 409 });
  if (binding) {
    checkExecutionRoot(binding.root);
    const actual = realpathSync(binding.root);
    const boundary = realpathSync(WORKSPACES_ROOT);
    if (actual !== path.resolve(binding.root) || !actual.startsWith(boundary + path.sep)) throw new AppError('Workspace binding resolves outside its canonical project directory', { code: 'STALE_BINDING', statusCode: 409 });
    requireWorkspaceAdmission(binding);
  }
  let reservation: ExecutionReservation | undefined;
  let sourceReservation: ExecutionReservation | undefined;
  let releaseLocal: (() => void) | undefined;
  let prepared = false;
  const reserve = (selected: Binding) => {
    discardRecoveredExecution(selected);
    rejectExclusiveWorkspaceWrite(selected);
    if (executionReservations.has(selected.root) || workspaceOperations.has(selected.root) || preparedWorkspaceWorkers.has(selected.root) || preparedPreviewStartups.has(selected.root)) throw new AppError('Workspace is in use by a task or operation', { code: 'WORKSPACE_BUSY', statusCode: 409 });
    const next: ExecutionReservation = { binding: selected, lease: selected.vps ? claimWorkspace(selected) : null, active: true, readOnly, operations: new Set(), teardownConfirmed: false };
    executionReservations.set(selected.root, next);
    return next;
  };
  const finish = async (owned: ExecutionReservation, synced: boolean) => {
    // Revoke new tools first, then wait every already admitted process/container.
    owned.active = false;
    await Promise.allSettled([...owned.operations]);
    await workspaceOperations.get(owned.binding.root)?.catch(() => {});
    await preparedWorkspaceWorkers.get(owned.binding.root)?.catch(() => {});
    await waitPreparedPreviewStartups(owned.binding.root);
    owned.teardownConfirmed = true;
    if (owned.lease) await releaseWorkspace(owned.binding, owned.lease, synced);
    if (executionReservations.get(owned.binding.root) === owned) executionReservations.delete(owned.binding.root);
  };
  let closePromise: Promise<void> | undefined;
  try {
    if (binding?.vps && !binding.isolated && workspaceMode === 'isolated' && input.sessionId) {
      const root = path.join(binding.root + '.chisa-worktrees', sessionWorktreeName(input.sessionId));
      if (existsSync(path.join(root, '.chisa-session.json')) && existsSync(path.join(root, '.chisa-bridge.json'))) {
        binding = (await createSessionWorktree(binding, input.sessionId, () => {}, signal))!;
      } else {
        sourceReservation = reserve(binding);
        // Even a lost/failed acknowledgement follows sync_end below; prepared
        // stays false until success so recovery treats the snapshot as possibly dirty.
        const result = await desktopControl(binding, { op: 'sync_begin', runId: sourceReservation.lease!.id, snapshot: true }, signal);
        prepared = true;
        if (result.snapshotPinned !== true || result.bindingEpoch !== binding.bindingEpoch) throw new AppError('Update the desktop client before creating an isolated workspace snapshot', { code: 'WORKSPACE_SNAPSHOT_UNSUPPORTED', statusCode: 409 });
        const source = sourceReservation;
        const isolated = await createSessionWorktree(binding, input.sessionId, () => assertExactExecution(source), signal);
        if (isolated) {
          const previous = sourceReservation;
          binding = isolated;
          reservation = reserve(binding);
          await finish(previous, true);
          sourceReservation = undefined;
          prepared = false;
        } else {
          reservation = sourceReservation;
          sourceReservation = undefined;
        }
      }
    }
    signal?.throwIfAborted();
    if (binding && !reservation) {
      if (!binding.vps) releaseLocal = await acquireSharedWorkspaceExecution(binding.root, signal);
      reservation = reserve(binding);
      if (binding.vps && !binding.isolated) {
        await desktopControl(binding, { op: 'sync_begin', runId: reservation.lease!.id, ...(readOnly ? { readOnly: true } : {}) }, signal);
        prepared = true;
      }
    }
    if (binding?.isolated && reservation) {
      await migrateSessionBranch(binding, binding.sessionId!, signal);
      const metadata = JSON.parse(readFileSync(path.join(binding.root, '.chisa-session.json'), 'utf8')) as { sourceRoot: string; branch: string };
      isolatedSessionGitRuntime(binding.root, metadata.sourceRoot, metadata.branch, true);
    }
    if (reservation) {
      assertExactExecution(reservation);
      if (input.directExecution && !readOnly && reservation.lease) saveLease(binding!, { ...readLease(binding!)!, mayWrite: true });
    }
    signal?.throwIfAborted();
    const owned = reservation;
    const cwd = binding?.isolated ? path.join(binding.root, path.relative(resolveWorkspaceBinding(input.cwd)!.root, input.cwd)) : input.cwd;
    return {
      sourceCwd: binding?.isolated ? path.join(sourceRoot, path.relative(binding.root, cwd)) : sourceCwd,
      cwd, sourceRoot, executionRoot: binding?.root ?? input.cwd,
      bound: binding !== null, isolated: binding?.isolated === true, readOnly,
      bindingKind: !binding ? 'none' as const : binding.vps ? 'vps' as const : 'local' as const,
      async execute(request: Record<string, unknown>, cancellation?: AbortSignal) {
        if (!owned) throw new AppError('Workspace commands require an admitted project binding', { code: 'WORKSPACE_PROVIDER_UNSUPPORTED', statusCode: 409 });
        if (!['stat', 'lstat', 'list', 'batch', 'realpath', 'read', 'write', 'mkdir', 'rename', 'copy', 'remove', 'search', 'grep', 'exec', 'preview_start', 'preview_status', 'preview_stop'].includes(String(request.op))) throw new AppError('Invalid admitted workspace operation', { code: 'INVALID_REQUEST', statusCode: 400 });
        const combined = signal && cancellation ? AbortSignal.any([signal, cancellation]) : signal ?? cancellation;
        return executionScopes.run(owned, () => rpc(owned.binding, request, combined));
      },
      async spawnProcess(processInput: Parameters<typeof spawnWorkspaceProcess>[0]) {
        if (!owned || !owned.binding.vps || !owned.lease) throw new AppError('Provider processes require an admitted VPS workspace', { code: 'WORKSPACE_PROVIDER_UNSUPPORTED', statusCode: 409 });
        assertExactExecution(owned);
        const combined = signal && processInput.signal ? AbortSignal.any([signal, processInput.signal]) : signal ?? processInput.signal;
        const selected = owned.binding;
        const name = 'chisa-rpc-' + randomUUID();
        let gitRuntime: ReturnType<typeof isolatedSessionGitRuntime> | undefined;
        if (selected.isolated) {
          const metadata = JSON.parse(readFileSync(path.join(selected.root, '.chisa-session.json'), 'utf8')) as { sourceRoot: string; branch: string };
          gitRuntime = isolatedSessionGitRuntime(selected.root, metadata.sourceRoot, metadata.branch, readOnly);
        } else gitRuntime = sharedSessionGitRuntime(selected.root, leaseDirectory(selected), readOnly);
        if (!readOnly) saveLease(selected, { ...readLease(selected)!, mayWrite: true });
        const child = spawnWorkspaceProcess({ ...processInput, env: { ...processInput.env, ...gitRuntime?.environment }, signal: combined }, {
          root: selected.root, sourceRoot, workspacesRoot: realpathSync(WORKSPACES_ROOT), readOnly,
          network: getWorkspaceSyncNetwork(selected.root) ?? 'bridge', name, gitMounts: gitRuntime?.mounts ?? [], isolated: selected.isolated,
          record: pending => recordContainer(selected, name, pending, owned.lease),
          async remove() { await removeWorkspaceContainer(name); if (!readOnly && gitRuntime) { const current = assertCurrentWorkspaceLease(selected, owned.lease); if (!current.cleanupPending?.includes(name)) throw new AppError('Workspace container reservation changed before object publication', { code: 'WORKSPACE_CLEANUP_FAILED', statusCode: 409 }); await gitRuntime.publish(); } },
        });
        owned.operations.add(child.completion);
        void child.completion.finally(() => owned.operations.delete(child.completion)).catch(() => {});
        return child;
      },
      revoke() { if (owned) owned.active = false; },
      close() {
        return closePromise ??= (async () => {
          try { if (owned) await finish(owned, prepared); }
          catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { workspaceCleanupError: true }); }
          finally { releaseLocal?.(); }
        })();
      },
    };
  } catch (error) {
    let cleanup: unknown;
    try { if (reservation) await finish(reservation, prepared); } catch (failure) { cleanup = failure; }
    try { if (sourceReservation) await finish(sourceReservation, prepared); } catch (failure) { cleanup ??= failure; }
    releaseLocal?.();
    if (cleanup) throw combinedError(error, cleanup);
    if (error instanceof Error && 'code' in error && error.code === 'WORKSPACE_BUSY') Object.assign(error, { workspaceAdmissionRejected: true });
    throw error;
  }
}

type LinuxProcessIdentity = { pid: number; parentPid: number; startTime: string; state: string };

function readLinuxProcess(pid: number): LinuxProcessIdentity | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    return { pid, parentPid: Number(fields[1]), startTime: fields[19], state: fields[0] };
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
    throw error;
  }
}

function ownClaudeDescendants(child: ChildProcess, owner: Buffer) {
  const descendants = new Map<number, LinuxProcessIdentity>();
  let root: LinuxProcessIdentity | undefined;
  let failure: unknown;
  let stopped = false;
  try { root = child.pid ? readLinuxProcess(child.pid) : undefined; }
  catch (error) { failure = error; }
  const alive = (identity: LinuxProcessIdentity) => {
    const current = readLinuxProcess(identity.pid);
    return current?.startTime === identity.startTime && current.state !== 'Z';
  };
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      try {
        // One stop snapshot includes both current ancestry and tools whose
        // shell parent already exited. The private inherited marker belongs
        // only to this locally spawned CLI; never signal a process group.
        const byParent = new Map<number, LinuxProcessIdentity[]>();
        for (const entry of readdirSync('/proc')) {
          if (!/^\d+$/.test(entry)) continue;
          const identity = readLinuxProcess(Number(entry));
          if (!identity) continue;
          const siblings = byParent.get(identity.parentPid) ?? [];
          siblings.push(identity);
          byParent.set(identity.parentPid, siblings);
          try {
            if (lstatSync(`/proc/${identity.pid}`).uid !== process.getuid!()) continue;
            const environment = readFileSync(`/proc/${identity.pid}/environ`);
            const offset = environment.indexOf(owner);
            if (offset >= 0 && (offset === 0 || environment[offset - 1] === 0) && identity.pid !== root?.pid) descendants.set(identity.pid, identity);
          } catch (error) {
            if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
          }
        }
        if (root && alive(root)) {
          const parents = [root.pid];
          for (const pid of parents) {
            for (const identity of byParent.get(pid) ?? []) {
              descendants.set(identity.pid, identity);
              parents.push(identity.pid);
            }
          }
          // Stop the owner before its tools: otherwise a failed Bash result
          // can make the CLI launch a replacement during the SDK's grace.
          if (alive(root)) {
            try { process.kill(root.pid, 'SIGKILL'); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
          }
        }
        for (const identity of descendants.values()) {
          if (!alive(identity)) continue;
          try { process.kill(identity.pid, 'SIGKILL'); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
        }
      } catch (error) { failure = error; }
    },
    async wait() {
      const deadline = Date.now() + 2000;
      while (!failure && ((root && alive(root)) || [...descendants.values()].some(alive))) {
        if (Date.now() >= deadline) { failure = new Error('Claude descendants are still running'); break; }
        await new Promise<void>(resolve => setTimeout(resolve, 20));
      }
      if (failure) throw Object.assign(new AppError('Claude subprocess cleanup could not be confirmed', { code: 'CLAUDE_PROCESS_CLEANUP_FAILED', statusCode: 503 }), { cause: failure });
    },
  };
}

/** Used by Claude runtime; bound workspaces expose only their project tools. */
export function workspaceQuery(input: Parameters<typeof sdkQuery>[0], onProcessExit?: () => void): ReturnType<typeof sdkQuery> {
  if (input.options?.cwd) checkExecutionRoot(input.options.cwd);
  let binding = input.options?.cwd ? resolveWorkspaceBinding(input.options.cwd) : null;
  const options = input.options ?? {};
  const sessionOptions = options as typeof options & { chisaSessionId?: unknown; sessionId?: unknown; workspaceMode?: unknown };
  const sessionId = typeof sessionOptions.chisaSessionId === 'string' ? sessionOptions.chisaSessionId : typeof sessionOptions.sessionId === 'string' ? sessionOptions.sessionId : null;
  const workspaceMode: SessionWorkspaceMode = sessionOptions.workspaceMode === 'shared' ? 'shared' : 'isolated';
  if ('chisaSessionId' in sessionOptions) delete sessionOptions.chisaSessionId;
  if ('workspaceMode' in sessionOptions) delete sessionOptions.workspaceMode;
  const readOnlySession = binding !== null && options.permissionMode === 'plan';
  const cancellation = new AbortController();
  const externalSignal = options.abortController?.signal;
  let stopOwnedDescendants = () => {};
  let waitOwnedDescendants = async () => {};
  const cancelFromCaller = () => { stopOwnedDescendants(); cancellation.abort(externalSignal?.reason); };
  externalSignal?.addEventListener('abort', cancelFromCaller, { once: true });
  if (externalSignal?.aborted) cancelFromCaller();
  if (binding) {
    options.tools = ['AskUserQuestion', 'ExitPlanMode', 'TodoWrite'];
    options.mcpServers = { workspace: workspaceTools(binding, cancellation.signal, readOnlySession) };
    options.strictMcpConfig = true;
    // Workspace permissions remain governed by the runtime policy callback.
    options.allowedTools = (options.allowedTools ?? []).filter(entry => !entry.startsWith('mcp__workspace'));
    options.settingSources = [];
    options.env = { ...options.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };
    const instruction = (binding.vps ? `Claude Code and the project tools execute on this VPS. The tools run in an isolated Linux container on this server. ${readOnlySession ? 'This is a read-only inspection session: inspect files and run commands with readOnly=true; writes and preview control are rejected after workspace freshness is confirmed. ' : 'Use run_command with readOnly=true for code review and inspection commands. This prohibits project writes and avoids unnecessary return synchronization. '}` : '') + 'Project files and commands are available only through the workspace tools under /workspace. Read /workspace/CLAUDE.md if present for project instructions. Report actual command results; do not infer runtime success from a successful tool request.';
    const previous = options.systemPrompt && typeof options.systemPrompt === 'object' && !Array.isArray(options.systemPrompt) && options.systemPrompt.type === 'preset' ? options.systemPrompt.append || '' : '';
    options.systemPrompt = { type: 'preset', preset: 'claude_code', append: previous + '\n' + instruction };
  }
  const spawnProcess = options.spawnClaudeCodeProcess;
  let processExit: Promise<void> | undefined;
  let exitReported = false;
  const reportProcessExit = () => { if (!exitReported) { exitReported = true; onProcessExit?.(); } };
  options.spawnClaudeCodeProcess = spawnOptions => {
    if (spawnProcess) {
      // Custom transports own their process/container teardown. Their PID
      // need not identify a host process, so never signal a host tree here.
      const child: SpawnedProcess = spawnProcess(spawnOptions);
      processExit = new Promise<void>((resolve, reject) => {
        if (child.exitCode !== null) { reportProcessExit(); resolve(); return; }
        child.once('exit', () => { reportProcessExit(); resolve(); });
        child.once('error', reject);
      });
      void processExit.catch(() => {});
      return child;
    }
    const captureStderr = Boolean(spawnOptions.env.DEBUG_CLAUDE_AGENT_SDK) || Boolean(options.stderr);
    const processOwner = process.platform === 'linux' ? randomUUID() : undefined;
    const child = spawn(spawnOptions.command, spawnOptions.args, {
      cwd: spawnOptions.cwd, env: processOwner ? { ...spawnOptions.env, CHISA_CLAUDE_PROCESS_OWNER: processOwner } : spawnOptions.env, signal: spawnOptions.signal,
      stdio: ['pipe', 'pipe', captureStderr ? 'pipe' : 'ignore'], windowsHide: true,
    });
    if (process.platform === 'linux') {
      const descendants = ownClaudeDescendants(child, Buffer.from(`CHISA_CLAUDE_PROCESS_OWNER=${processOwner}\0`));
      stopOwnedDescendants = () => descendants.stop();
      waitOwnedDescendants = () => descendants.wait();
    }
    if (captureStderr) child.stderr?.on('data', (chunk: Buffer) => { options.stderr?.(chunk.toString()); });
    // Query.close() ends its iterator before the CLI actually exits. The public
    // SDK spawn hook lets the lease outlive that real process, without a sleep.
    processExit = new Promise<void>(resolve => { child.once('close', () => { reportProcessExit(); resolve(); }); });
    return child as unknown as SpawnedProcess;
  };
  let active: ReturnType<typeof sdkQuery> | undefined;
  let sdkStarted = false;
  let cancelled = false;
  let cleanup: Promise<void> | undefined;
  const stream = (async function* () {
    let execution: Awaited<ReturnType<typeof admitWorkspaceExecution>> | undefined;
    let primary: unknown;
    let failed = false;
    let cleanupFailure: unknown;
    let cleanupFailed = false;
    try {
      cancellation.signal.throwIfAborted();
      if (options.cwd) {
        execution = await admitWorkspaceExecution({ cwd: options.cwd, sessionId, workspaceMode, readOnly: readOnlySession, signal: cancellation.signal });
        options.cwd = execution.cwd;
        binding = resolveWorkspaceBinding(execution.cwd);
        if (binding) options.mcpServers = { workspace: workspaceTools(binding, cancellation.signal, readOnlySession) };
      }
      if (cancelled) return;
      cancellation.signal.throwIfAborted();
      sdkStarted = true;
      active = sdkQuery({ ...input, options });
      yield* active;
    } catch (error) {
      primary = error;
      failed = true;
    } finally {
      cleanup = (async () => {
        if (cancelled || cancellation.signal.aborted || failed) stopOwnedDescendants();
        active?.close();
        await processExit;
        await waitOwnedDescendants();
        await execution?.close();
      })().catch((error: unknown) => {
        if (failed) throw combinedError(primary, error);
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), { workspaceCleanupError: true });
      });
      try { await cleanup; }
      catch (error) { cleanupFailure = error; cleanupFailed = true; }
      finally { externalSignal?.removeEventListener('abort', cancelFromCaller); }
    }
    if (cleanupFailed) throw cleanupFailure;
    // Queue retries are safe only when workspace admission failed before the
    // SDK started, and the attempted reservation was successfully cleaned up.
    if (failed && !sdkStarted && primary instanceof Error && 'code' in primary && primary.code === 'WORKSPACE_BUSY' && !('workspaceCleanupError' in primary) && !('cleanupError' in primary)) {
      Object.assign(primary, { workspaceAdmissionRejected: true });
    }
    if (failed) throw primary;
  })();
  const wrapped: typeof stream = new Proxy(stream, {
    get(target, property) {
      if (property === Symbol.asyncIterator) return () => wrapped;
      if (property === 'next' || property === 'return') return async () => {
        const result = property === 'next' ? await target.next() : await target.return(undefined);
        // An externally requested return skips code after finally. Every
        // iterator consumer must still observe the same cleanup confirmation.
        if (result.done) await cleanup;
        return result;
      };
      if (property === 'interrupt') return async () => {
        cancelled = true;
        stopOwnedDescendants();
        cancellation.abort();
        active?.close();
        // chat.abort may admit another turn only after sync_end removes the lease.
        await target.return(undefined);
        // A pending next() can receive the cleanup error before return() settles.
        await cleanup;
      };
      if (property === 'close') return () => {
        cancelled = true;
        stopOwnedDescendants();
        cancellation.abort();
        active?.close();
        void target.return(undefined).catch(() => {});
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return wrapped as unknown as ReturnType<typeof sdkQuery>;
}
