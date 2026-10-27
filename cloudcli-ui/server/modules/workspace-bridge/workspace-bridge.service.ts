import { chownSync, existsSync, lstatSync, realpathSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

import { createSdkMcpServer, query as sdkQuery, tool } from '@anthropic-ai/claude-agent-sdk';
import type { SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { RequestHandler } from 'express';

import type { FileTreeFileSystem, ProjectRuntimeLaunchContext, SessionWorkspaceMode, WorkspaceDescriptor, WorkspaceResolution, WorkspaceGitFileSystem, WorkspaceRuntimePreviewReservation } from '@/shared/index.js';
import { prepareProjectRuntime, matchesProjectExtensionPermission as projectPermissionMatches } from '@/modules/project-runtime/index.js';
import { createWorkspaceChangesService } from '@/modules/workspace-changes/index.js';
import { ensureCloudWorkspaceBinding, excludeCloudWorkspaceMetadata, executeWorkspaceRuntimePreview, getWorkspaceRuntimeIdentity } from '@/modules/workspace-runtime/index.js';
import { AppError, WORKSPACES_ROOT, getWorkspaceSyncNetwork, isWorkspaceSyncRecoveryOnly } from '@/shared/index.js';

import { ensureReplicaIdentity, readSessionIdentity, recordSessionIdentity, setSessionPublication } from './workspace-identity.service.js';
import { cloudWriterGateAvailable, claimCloudWriterLease, releaseCloudWriterLease } from './workspace-writer-gate.service.js';
import { readWorkspaceIntegration, beginWorkspaceIntegration, recoverWorkspaceIntegrationLease, clearWorkspaceIntegration } from './workspace-integration-guard.service.js';
import { copyPinnedSessionSnapshot, isolatedSessionGitRuntime } from './session-snapshot.service.js';
import { spawnWorkspaceProcess } from './workspace-process.service.js';
import { sharedSessionGitRuntime } from './session-objects.service.js';
import { admitSshWorkspace, assertSshProjectOwner, describeSshWorkspace, resolveSshProjectTarget, runSshWorkspaceOperation, verifySshProject, withSshWorkspaceGitRead, withSshWorkspaceWrite } from './ssh-workspace-execution.service.js';
import { sshWorkspaceQuery } from './ssh-workspace-query.service.js';

type Binding = { root: string; host: string; port: number; token: string; bindingEpoch: string; readBatch: boolean; localGitRead: boolean; vps: boolean; cloud: boolean; isolated: boolean; sessionId?: string; ssh?: true };
type RpcStats = { size: number; mtime: number; mode: number; dir: boolean; symlink: boolean };
type RpcResult = Partial<RpcStats> & { ok?: boolean; error?: string; code?: string; localGitRead?: boolean; gitBranch?: boolean; snapshotPinned?: boolean; releasedRunId?: string; bindingEpoch?: string; b64?: string; hash?: string; path?: string; entries?: Array<{ name: string; dir: boolean; stats?: RpcStats }>; results?: RpcResult[]; stdout?: string; stderr?: string; exitCode?: number; truncated?: boolean };
type FileTreeReadRequest = { op: 'stat' | 'lstat' | 'list' | 'realpath'; path: string; includeStats?: boolean };
type PendingFileTreeRead = { request: FileTreeReadRequest; resolve(result: RpcResult): void; reject(error: unknown): void };
type WorkspaceRequestScope = { signal: AbortSignal; deadline: number; id: string; userId: string | number | null };

const requestScopes = new AsyncLocalStorage<WorkspaceRequestScope>();
const workspaceChanges = createWorkspaceChangesService();
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
  const user = (request as typeof request & { user?: { id?: string | number; userId?: string | number } }).user;
  requestScopes.run({ signal: cancellation.signal, deadline, id: randomUUID(), userId: user?.id ?? user?.userId ?? null }, next);
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


function refreshedBinding(binding: Binding, candidate = binding.root, pinnedRead = false): Binding {
  const current = resolveWorkspaceBinding(candidate);
  if (!current || current.root !== binding.root || current.token !== binding.token || current.host !== binding.host || current.bindingEpoch !== binding.bindingEpoch || current.vps !== binding.vps || current.cloud !== binding.cloud || current.isolated !== binding.isolated || current.sessionId !== binding.sessionId || (pinnedRead && (current.port !== binding.port || current.readBatch !== binding.readBatch || current.localGitRead !== binding.localGitRead))) {
    throw new AppError('Workspace identity changed; refresh the selected cloud project before continuing', { code: 'STALE_BINDING', statusCode: 409 });
  }
  return current;
}

function combinedError(primary: unknown, cleanup: unknown): AppError {
  const error = primary instanceof Error ? primary : new Error(String(primary));
  const cleanupError = cleanup instanceof Error ? cleanup : new Error(String(cleanup));
  return Object.assign(new AppError(`${error.message}. Workspace cleanup was not confirmed; recover the cloud workspace before starting another task.`, {
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
  const ssh = resolveSshProjectTarget(candidate);
  if (ssh) {
    const request = requestScopes.getStore();
    if (request) assertSshProjectOwner(ssh, request.userId);
    return { root: ssh.anchorPath, host: '', port: 0, token: '', bindingEpoch: ssh.generation, readBatch: true, localGitRead: false, vps: false, cloud: false, isolated: false, ssh: true };
  }
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
      if (value.protocol === 2 && getWorkspaceRuntimeIdentity(root)) {
        ensureCloudWorkspaceBinding(root);
        return resolveWorkspaceBinding(candidate);
      }
      if (value.protocol === 3) {
        ensureCloudWorkspaceBinding(root);
        if (typeof value.bindingEpoch !== 'string' || !value.bindingEpoch || value.root !== root) throw new AppError('Invalid cloud workspace identity', { code: 'WORKSPACE_WORKTREE_CONFLICT', statusCode: 409 });
        return { root, host: '', port: 0, token: '', bindingEpoch: value.bindingEpoch, readBatch: false, localGitRead: false, vps: true, cloud: true, isolated: value.execution === 'isolated-worktree', sessionId: typeof value.sessionId === 'string' ? value.sessionId : undefined };
      }
      if ((value.protocol !== 1 && value.protocol !== 2) || !Number.isInteger(value.port) || Number(value.port) < 1024 || Number(value.port) > 65535 || typeof value.token !== 'string' || typeof value.bindingEpoch !== 'string') throw new AppError('Invalid workspace binding metadata', { code: 'WORKSPACE_WORKTREE_CONFLICT', statusCode: 409 });
      const host = value.controlHost === undefined ? '127.0.0.1' : value.controlHost;
      if (typeof host !== 'string' || isIP(host) !== 4 || (host !== '127.0.0.1' && !/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(host))) throw new AppError('Invalid workspace transport address', { code: 'WORKSPACE_UNAVAILABLE', statusCode: 503 });
      return { root, host, port: Number(value.port), token: value.token, bindingEpoch: value.bindingEpoch, readBatch: value.readBatch === true, localGitRead: value.localGitRead === true, vps: value.protocol === 2, cloud: false, isolated: value.execution === 'isolated-worktree', sessionId: typeof value.sessionId === 'string' ? value.sessionId : undefined };
    }
    root = path.dirname(root);
  }
  return null;
}

/** The workspace catalog requires explicit selectors for bound project replicas. */
export function isWorkspaceBound(sourceRoot: string): boolean { return resolveWorkspaceBinding(sourceRoot) !== null; }

function workspacePhase(root: string, binding: Binding | null): WorkspaceDescriptor['phase'] {
  if (workspaceIntegrationIntent(root)) return 'recovery';
  if (binding && isWorkspaceSyncRecoveryOnly(root)) return 'recovery';
  const lease = binding ? readLease(binding) : null;
  if (lease?.cleanupPending?.length || lease?.owner === 'sync-needed') return 'recovery';
  if (lease) return lease.owner === 'sync' || activeWorkspaceLeases.get(root)?.id === lease.id ? 'running' : 'recovery';
  if (binding?.vps && !binding.isolated && cloudWriterGateAvailable(root, binding.bindingEpoch)) {
    const generation = JSON.parse(readFileSync(root + '.chisa-generation.json', 'utf8')) as { state: string; writer: string };
    if (generation.state === 'dirty') return generation.writer === 'mutagen' ? 'running' : 'recovery';
  }
  return 'idle';
}

/** Resolves durable identities only. Reading the catalog never creates a session snapshot or assigns legacy changes a fabricated baseline. */
export function describeWorkspaceSelection(input: { projectId: string; sourceRoot: string; sessionId?: string; requestedMode?: SessionWorkspaceMode }): WorkspaceResolution {
  const sourceRoot = path.resolve(input.sourceRoot);
  const ssh = resolveSshProjectTarget(sourceRoot);
  if (ssh) {
    if (ssh.projectId !== input.projectId || ssh.anchorPath !== sourceRoot) throw new AppError('SSH 项目身份不匹配。', { code: 'WORKSPACE_SELECTION_MISMATCH', statusCode: 409 });
    return describeSshWorkspace(ssh, input.sessionId);
  }
  ensureCloudWorkspaceBinding(sourceRoot);
  const binding = resolveWorkspaceBinding(sourceRoot);
  if (binding && (binding.isolated || binding.root !== sourceRoot)) throw new AppError('The project must identify its exact source replica', { code: 'WORKSPACE_SELECTION_MISMATCH', statusCode: 409 });
  const epoch = binding?.bindingEpoch ?? 'unbound';
  const identity = ensureReplicaIdentity(sourceRoot, epoch);
  const independent = Boolean(!binding || (binding.vps && getWorkspaceSyncNetwork(sourceRoot) && (binding.cloud || cloudWriterGateAvailable(sourceRoot, epoch))));
  const phase = workspacePhase(sourceRoot, binding);
  const cloudReplica: WorkspaceDescriptor = {
    workspaceId: identity.workspaceId, generation: identity.generation, projectId: input.projectId, kind: 'cloudReplica',
    rootPath: sourceRoot, sourceRoot, requestedMode: 'shared', effectiveMode: 'shared', phase, publicationState: 'integrated',
    capabilities: { read: true, write: phase === 'idle', git: existsSync(path.join(sourceRoot, '.git')), shell: !binding || binding.vps, preview: Boolean(binding?.vps), integrate: false, cloudExecutionIndependentOfDesktop: independent },
  };
  if (!input.sessionId) return { cloudReplica, session: null };
  const isolatedRoot = path.join(sourceRoot + '.chisa-worktrees', sessionWorktreeName(input.sessionId));
  const isolated = readSessionIdentity(sourceRoot, isolatedRoot, input.sessionId, epoch);
  const state = isolated ?? readSessionIdentity(sourceRoot, sourceRoot, input.sessionId, epoch);
  if (!state) return { cloudReplica, session: null };
  ensureCloudWorkspaceBinding(state.root);
  const selectedBinding = resolveWorkspaceBinding(state.root);
  if (state.effectiveMode === 'isolated' && (!selectedBinding?.isolated || selectedBinding.sessionId !== input.sessionId || selectedBinding.bindingEpoch !== epoch)) throw new AppError('Session execution binding changed', { code: 'WORKSPACE_SELECTION_MISMATCH', statusCode: 409 });
  const sessionPhase = workspacePhase(state.root, selectedBinding);
  return { cloudReplica, session: {
    workspaceId: state.workspaceId, generation: state.generation, projectId: input.projectId, kind: 'session', sessionId: input.sessionId,
    rootPath: state.root, sourceRoot, requestedMode: state.requestedMode, effectiveMode: state.effectiveMode,
    ...(state.baselineId ? { baseRevision: state.baselineId } : {}), phase: sessionPhase, publicationState: state.publicationState,
    capabilities: { read: true, write: sessionPhase === 'idle', git: existsSync(path.join(state.root, '.git')), shell: !selectedBinding || selectedBinding.vps, preview: Boolean(selectedBinding?.vps), integrate: state.effectiveMode === 'isolated' && Boolean(state.baselineId) && sessionPhase === 'idle', cloudExecutionIndependentOfDesktop: state.effectiveMode === 'isolated' ? Boolean(getWorkspaceSyncNetwork(state.root)) : independent },
  } };
}

/** File, Git and terminal entry points pin the same server-resolved execution root and generation. */
export function assertWorkspaceDescriptor(expected: WorkspaceDescriptor): void {
  const resolved = describeWorkspaceSelection({ projectId: expected.projectId, sourceRoot: expected.sourceRoot, sessionId: expected.sessionId, requestedMode: expected.requestedMode });
  const current = expected.kind === 'session' ? resolved.session : resolved.cloudReplica;
  if (!current || current.workspaceId !== expected.workspaceId || current.kind !== expected.kind || current.rootPath !== expected.rootPath || current.sourceRoot !== expected.sourceRoot || current.sessionId !== expected.sessionId || current.effectiveMode !== expected.effectiveMode) throw new AppError('Workspace selection changed; resolve it again', { code: 'WORKSPACE_SELECTION_MISMATCH', statusCode: 409 });
  if (current.generation !== expected.generation) throw new AppError('Workspace generation changed; resolve it again', { code: 'WORKSPACE_GENERATION_CHANGED', statusCode: 409 });
}

/** Integration locks both the retained session and the current cloud target, then applies only the reviewed B→A delta against T. */
export async function integrateWorkspaceSession(input: { descriptor: WorkspaceDescriptor; action: 'preview' | 'apply' | 'recover'; previewId?: string; expectedSourceRevision?: string; expectedTargetRevision?: string; operationId?: string }) {
  const descriptor = input.descriptor;
  assertWorkspaceDescriptor(descriptor);
  if (descriptor.sourceMode === 'ssh') throw new AppError('SSH 本地目录为共享执行，不支持云端会话集成。', { code: 'SSH_WORKSPACE_UNSUPPORTED', statusCode: 409 });
  if (descriptor.kind !== 'session' || !descriptor.sessionId || descriptor.effectiveMode !== 'isolated' || !descriptor.baseRevision || descriptor.rootPath === descriptor.sourceRoot) throw new AppError('This session has no isolated integration baseline', { code: 'WORKSPACE_BASELINE_UNAVAILABLE', statusCode: 409 });
  const sourceBinding = resolveWorkspaceBinding(descriptor.sourceRoot);
  if (!sourceBinding?.vps || sourceBinding.isolated) throw new AppError('Integration requires the source cloud replica', { code: 'WORKSPACE_SELECTION_MISMATCH', statusCode: 409 });
  const sessionBinding = resolveWorkspaceBinding(descriptor.rootPath);
  if (!sessionBinding?.isolated || sessionBinding.sessionId !== descriptor.sessionId) throw new AppError('Integration requires the exact session workspace', { code: 'WORKSPACE_SELECTION_MISMATCH', statusCode: 409 });
  const roots = [descriptor.sourceRoot, descriptor.rootPath].sort();
  const identity = {
    workspaceId: descriptor.workspaceId, generation: descriptor.generation, baseRevision: descriptor.baseRevision,
    sourceRoot: descriptor.sourceRoot, executionRoot: descriptor.rootPath, sessionId: descriptor.sessionId, bindingEpoch: sourceBinding.bindingEpoch,
  };
  const pending = workspaceIntegrationIntent(descriptor.sourceRoot) ?? workspaceIntegrationIntent(descriptor.rootPath);
  if (pending && (Object.entries(identity).some(([key, value]) => pending[key as keyof typeof pending] !== value) || input.action === 'preview' || (input.operationId && input.operationId !== pending.operationId))) throw new AppError('Recover the exact pending session integration first', { code: 'WORKSPACE_RECOVERY_REQUIRED', statusCode: 409 });
  let intent = pending;
  if (input.action === 'apply') {
    if (!input.previewId || !input.expectedSourceRevision || !input.expectedTargetRevision || !input.operationId) throw new AppError('Apply requires the reviewed preview, revisions and operation ID', { code: 'INVALID_WORKSPACE_REQUEST', statusCode: 400 });
    const requested = { ...identity, previewId: input.previewId, expectedSourceRevision: input.expectedSourceRevision, expectedTargetRevision: input.expectedTargetRevision, operationId: input.operationId };
    if (pending && !sameIntegration(pending, requested)) throw new AppError('Apply does not match the pending integration', { code: 'WORKSPACE_SELECTION_MISMATCH', statusCode: 409 });
    intent = requested;
  } else if (input.action === 'recover' && !intent) {
    const state = workspaceChanges.inspectIntegration({ ...identity, targetRoot: descriptor.sourceRoot, assertPinned: () => assertWorkspaceDescriptor(descriptor), operationId: input.operationId });
    if (state.status !== 'idle') intent = { ...identity, operationId: state.operationId, previewId: state.previewId, expectedSourceRevision: state.sourceRevision, expectedTargetRevision: state.targetRevision };
  }
  const selectedIntent = intent;
  const integration: IntegrationScope | undefined = selectedIntent ? { intent: selectedIntent, adopted: new Map() } : undefined;
  if (integration) {
    for (const root of roots) {
      if (integrationReservations.has(root) || exclusiveWorkspaceWrites.has(root) || workspaceOperations.has(root) || preparedWorkspaceWorkers.has(root) || preparedPreviewStartups.has(root) || preparedWorkspaceReservations.has(root) || retainedWorkspacePreviews.has(root) || sharedWorkspaceExecutions.has(root) || executionReservations.has(root)) throw new AppError('Workspace is still in use; integration recovery must wait for exact teardown', { code: 'WORKSPACE_BUSY', statusCode: 409 });
    }
    for (const root of roots) integrationReservations.set(root, integration);
  }
  const execute = () => withWorkspaceWriteOperation(roots[0], () => withWorkspaceWriteOperation(roots[1], async () => {
    const assertIdentity = () => {
      assertWorkspaceDescriptor(descriptor); refreshedBinding(sourceBinding); refreshedBinding(sessionBinding);
      if (!scopedWriteLease(sourceBinding)?.lease || !scopedWriteLease(sessionBinding)?.lease) throw new AppError('Integration lost its workspace reservations', { code: 'WORKSPACE_BUSY', statusCode: 409 });
    };
    const assertPinned = () => { assertIdentity(); checkWorkspaceRequest(); };
    assertPinned();
    const options = {
      sessionId: descriptor.sessionId!, sourceRoot: descriptor.sourceRoot, executionRoot: descriptor.rootPath, targetRoot: descriptor.sourceRoot,
      assertPinned, signal: workspaceRequestSignal(), withLock: <T>(operation: () => Promise<T>) => operation(),
    };
    // Inspect exact state even if the HTTP request was cancelled. This read-only
    // proof may release an untouched target, but never resumes a cancelled write.
    const inspect = () => workspaceChanges.inspectIntegration({ ...options, assertPinned: assertIdentity, signal: undefined, operationId: selectedIntent?.operationId ?? input.operationId });
    if (selectedIntent) beginWorkspaceIntegration(selectedIntent, {
      [sourceBinding.root]: scopedWriteLease(sourceBinding)!.lease!, [sessionBinding.root]: scopedWriteLease(sessionBinding)!.lease!,
    });
    try {
      let result;
      if (input.action === 'preview') result = await workspaceChanges.preview(options);
      else if (input.action === 'recover') {
        const state = inspect();
        // The barrier is persisted before the delta journal. A crash in that
        // interval resumes the saved reviewed tuple, never invents a new preview.
        result = selectedIntent && state.status === 'idle'
          ? await workspaceChanges.apply({ ...options, ...selectedIntent })
          : await workspaceChanges.recover({ ...options, operationId: selectedIntent?.operationId ?? input.operationId });
      } else result = await workspaceChanges.apply({ ...options, ...selectedIntent! });
      assertPinned();
      if ('status' in result && (result.status === 'applied' || result.status === 'conflict')) {
        const current = readSessionIdentity(descriptor.sourceRoot, descriptor.rootPath, descriptor.sessionId!, sourceBinding.bindingEpoch);
        if (result.status === 'applied' || current?.publicationState !== 'integrated') setSessionPublication(descriptor.sourceRoot, descriptor.rootPath, descriptor.sessionId!, sourceBinding.bindingEpoch, descriptor.generation, result.status === 'applied' ? 'integrated' : 'conflicted');
      }
      if (selectedIntent) {
        const state = inspect();
        if (state.status === 'idle' || (state.status === 'committed' && 'status' in result && result.status === 'applied')) clearWorkspaceIntegration(selectedIntent);
      }
      return result;
    } catch (error) {
      if (selectedIntent && inspect().status === 'idle') clearWorkspaceIntegration(selectedIntent);
      throw error;
    }
  }));
  try {
    if (!integration) return await execute();
    return await integrationScopes.run(integration, async () => {
      if (pending) for (const root of roots) {
        const active = activeWorkspaceLeases.get(root);
        // The helper may have committed adoption before its acknowledgement was
        // lost. All local execution maps were proved quiet above; its durable
        // witness still verifies the exact run and process birth on this retry.
        const inactiveLeaseId = active?.id ?? readLease(root === sourceBinding.root ? sourceBinding : sessionBinding)?.id;
        const adopted = recoverWorkspaceIntegrationLease(root, pending, { inactiveLeaseId });
        if (adopted) {
          if (adopted.owner !== 'claude') throw new AppError('Integration reservation owner changed', { code: 'WORKSPACE_BUSY', statusCode: 409 });
          const lease: WorkspaceLease = { ...adopted, owner: 'claude' };
          integration.adopted.set(root, lease); activeWorkspaceLeases.set(root, lease);
        }
      }
      return execute();
    });
  } finally {
    if (integration) for (const root of roots) if (integrationReservations.get(root) === integration) integrationReservations.delete(root);
  }
}

type GitProcessResult = { code: number | null; stdout: string; stderr: string };

function runGit(args: string[], cwd: string, signal?: AbortSignal): Promise<GitProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-c', 'safe.directory=' + path.resolve(cwd), ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'], signal, windowsHide: true });
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
    // A retained legacy workspace can still be edited, but cannot acquire a
    // fabricated baseline from its already-modified files.
    const identity = readSessionIdentity(binding.root, worktreeRoot, sessionId, binding.bindingEpoch);
    if (!identity) recordSessionIdentity({ sourceRoot: binding.root, executionRoot: worktreeRoot, sessionId, bindingEpoch: binding.bindingEpoch, requestedMode: 'isolated', effectiveMode: 'isolated' });
    else if (identity.effectiveMode !== 'isolated') throw new AppError('Session execution mode changed', { code: 'WORKSPACE_SELECTION_MISMATCH', statusCode: 409 });
    assertPinned();
    return existing;
  }
  if (existsSync(worktreeRoot)) throw new AppError('Session worktree path already exists; recover it from Worktrees before starting again', { code: 'WORKSPACE_WORKTREE_CONFLICT', statusCode: 409 });

  const repository = await runGit(['rev-parse', '--show-toplevel'], binding.root, signal);
  if (repository.code !== 0 || !repository.stdout.trim()) return null;
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
  const head = await runGit(['rev-parse', '--verify', 'HEAD'], binding.root, signal);
  // A newly initialized cloud repository has no committed baseline yet. Keep
  // its actual shared mode until the user creates the first commit.
  if (head.code !== 0) return null;
  const branch = `chisa/session-private/${sessionWorktreeName(sessionId)}/work`;
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32' && process.getuid?.() === 0) chownSync(parent, 1000, 1000);
  assertPinned();
  const created = await runGit(['worktree', 'add', '--no-checkout', '-b', branch, worktreeRoot, 'HEAD'], binding.root, signal);
  if (created.code !== 0) throw new AppError('Could not create the isolated session worktree', { code: 'WORKSPACE_WORKTREE_CREATE_FAILED', statusCode: 503, details: created.stderr.trim() });
  try {
    await copyPinnedSessionSnapshot(binding.root, worktreeRoot, runGit, assertPinned, signal);
    const baseline = await workspaceChanges.captureBaseline({ sessionId, sourceRoot: binding.root, executionRoot: worktreeRoot, verifiedSnapshot: true, assertPinned, withLock: operation => operation(), signal });
    recordSessionIdentity({ sourceRoot: binding.root, executionRoot: worktreeRoot, sessionId, bindingEpoch: binding.bindingEpoch, requestedMode: 'isolated', effectiveMode: 'isolated', baselineId: baseline.baselineId });
    signal?.throwIfAborted();
    assertPinned();
    const marker = JSON.parse(readFileSync(path.join(binding.root, '.chisa-bridge.json'), 'utf8')) as Record<string, unknown>;
    writeFileSync(markerPath, JSON.stringify({ ...marker, ...(binding.cloud ? { root: worktreeRoot } : {}), execution: 'isolated-worktree', sessionId }), { mode: 0o600 });
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

async function desktopControl(_binding: Binding, _request: Record<string, unknown>, _cancellation?: AbortSignal, _cleanup = false): Promise<RpcResult> {
  throw new AppError('Local workspace synchronization has been removed. Open the project through its cloud account workspace.', { code: 'LOCAL_WORKSPACE_REMOVED', statusCode: 409 });
}

type WorkspaceLease = { owner: 'claude' | 'sync-needed' | 'pi' | 'sync'; id: string; epoch: string; pid?: number; processStartTime?: string; bootId?: string; mayWrite?: boolean; cleanupPending?: string[]; previews?: string[]; writerGate?: boolean; integrationOperation?: string };

type IntegrationScope = { intent: NonNullable<ReturnType<typeof readWorkspaceIntegration>>; adopted: Map<string, WorkspaceLease> };
const integrationScopes = new AsyncLocalStorage<IntegrationScope>();
const integrationReservations = new Map<string, IntegrationScope>();
const activeWorkspaceLeases = new Map<string, WorkspaceLease>();

function workspaceIntegrationIntent(root: string): ReturnType<typeof readWorkspaceIntegration> {
  const own = readWorkspaceIntegration(root);
  if (own) return own;
  const binding = resolveWorkspaceBinding(root);
  if (!binding?.isolated) return null;
  // The source marker is durable first and removed last. It therefore also
  // fences its session across a crash while creating/removing the mirror.
  const metadata = JSON.parse(readFileSync(path.join(root, '.chisa-session.json'), 'utf8')) as { sourceRoot?: string };
  if (!metadata.sourceRoot || !path.isAbsolute(metadata.sourceRoot)) throw new AppError('Session source identity is damaged', { code: 'WORKSPACE_RECOVERY_REQUIRED', statusCode: 409 });
  const source = readWorkspaceIntegration(metadata.sourceRoot);
  return source?.executionRoot === root ? source : null;
}

function sameIntegration(a: IntegrationScope['intent'], b: IntegrationScope['intent']): boolean {
  return (Object.keys(a) as Array<keyof IntegrationScope['intent']>).every(key => a[key] === b[key]);
}

function requireWorkspaceAdmission(binding: Binding): void {
  const scope = integrationScopes.getStore();
  const reserved = integrationReservations.get(binding.root);
  if (reserved && reserved !== scope) throw new AppError('Workspace integration is in progress', { code: 'WORKSPACE_BUSY', statusCode: 409 });
  const pending = workspaceIntegrationIntent(binding.root);
  if (pending && (!scope || !sameIntegration(pending, scope.intent))) throw new AppError('Recover the pending session integration before starting new work', { code: 'WORKSPACE_RECOVERY_REQUIRED', statusCode: 409 });
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
    throw new AppError('Workspace reservation state could not be read; check the project permissions and cloud workspace state.', {
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
    throw new AppError('Workspace reservation state is damaged; recover the pending cloud operation before continuing.', {
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
  const lease: WorkspaceLease = { owner: 'claude', id: randomUUID(), epoch: binding.bindingEpoch, pid: process.pid, ...identity, mayWrite: false };
  if (!binding.isolated && cloudWriterGateAvailable(binding.root, binding.bindingEpoch)) {
    lease.writerGate = true;
    if (!claimCloudWriterLease(binding.root, lease)) throw new AppError('The installed workspace writer gate disappeared', { code: 'WORKSPACE_RECOVERY_REQUIRED', statusCode: 409 });
    activeWorkspaceLeases.set(binding.root, lease);
    return lease;
  }
  try {
    mkdirSync(leaseDirectory(binding), { mode: 0o700 });
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    if (failure.code === 'EEXIST') {
      // Preserve an unreadable/damaged lease diagnosis instead of turning it
      // into a generic busy state that gives the user no recovery direction.
      readLease(binding);
      throw new AppError('Workspace is reserved or waiting for recovery. Finish the current cloud task or recover its pending operation.', { code: 'WORKSPACE_BUSY', statusCode: 409 });
    }
    throw new AppError('Workspace reservation could not be created; check the project permissions and cloud workspace state.', {
      code: 'WORKSPACE_LEASE_UNAVAILABLE',
      statusCode: 503,
      details: { errorName: failure.name, transportCode: failure.code },
    });
  }
  try {
    saveLease(binding, lease);
  } catch (error) {
    try { rmSync(leaseDirectory(binding), { recursive: true, force: true }); } catch { /* preserve the write error */ }
    throw new AppError('Workspace reservation could not be persisted; check the cloud project state before retrying.', {
      code: 'WORKSPACE_LEASE_UNAVAILABLE',
      statusCode: 503,
      details: { errorName: error instanceof Error ? error.name : 'Error' },
    });
  }
  activeWorkspaceLeases.set(binding.root, lease);
  return lease;
}
async function releaseWorkspace(binding: Binding, lease: WorkspaceLease, prepared: boolean): Promise<void> {
  if (workspaceIntegrationIntent(binding.root)) throw new AppError('Session integration has not been confirmed; recover the exact pending operation before resuming synchronization', { code: 'WORKSPACE_RECOVERY_REQUIRED', statusCode: 409 });
  // Retain the barrier after disconnection; desktop recovery checks that the run ended.
  const latest = readLease(binding);
  const mayWrite = !prepared || (latest?.id === lease.id ? latest.mayWrite !== false : true);
  if (!latest || latest.id !== lease.id || latest.epoch !== lease.epoch || latest.owner !== lease.owner || latest.pid !== lease.pid || latest.processStartTime !== lease.processStartTime || latest.bootId !== lease.bootId) throw new AppError('Workspace reservation changed before cleanup', { code: 'WORKSPACE_BUSY', statusCode: 409 });
  if (latest.previews?.length) throw new AppError('A workspace preview is still running', { code: 'WORKSPACE_BUSY', statusCode: 409 });
  if (lease.writerGate) {
    releaseCloudWriterLease(binding.root, lease);
    if (activeWorkspaceLeases.get(binding.root)?.id === lease.id) activeWorkspaceLeases.delete(binding.root);
    return;
  }
  if (binding.isolated || (binding.cloud && !lease.writerGate)) {
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
const retainedWorkspacePreviews = new Map<string, Map<string, { leaseId: string; cleanup: () => Promise<void> }>>();

async function stopOwnedPreviews(binding: Binding, lease: WorkspaceLease): Promise<void> {
  const previews = retainedWorkspacePreviews.get(binding.root);
  for (const preview of [...(previews?.values() ?? [])]) {
    if (preview.leaseId === lease.id) await preview.cleanup();
  }
  if (assertCurrentWorkspaceLease(binding, lease).previews?.length) throw new AppError('Preview cleanup could not be confirmed', { code: 'WORKSPACE_CLEANUP_FAILED', statusCode: 503 });
}

function workspaceNetwork(root: string): string {
  const network = getWorkspaceSyncNetwork(root);
  if (!network) throw new AppError('The account workspace network is unavailable', { code: 'WORKSPACE_RUNTIME_UNAVAILABLE', statusCode: 503 });
  return network;
}

async function waitPreparedPreviewStartups(root: string): Promise<void> {
  const startups = preparedPreviewStartups.get(root);
  if (startups) await Promise.all(startups);
}

function admittedWorkspaceLease(binding: Binding): WorkspaceLease | null {
  requireWorkspaceAdmission(binding);
  requireExecutionAccess(binding);
  const current = readLease(binding);
  if (current && (current.epoch !== binding.bindingEpoch || current.owner !== 'claude')) {
    throw new AppError('Workspace is reserved or waiting for recovery', { code: 'WORKSPACE_BUSY', statusCode: 409 });
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
  if (current.previews?.length) throw new AppError('Workspace preview is still active', { code: 'WORKSPACE_BUSY', statusCode: 409 });
  if (lease.writerGate) releaseCloudWriterLease(binding.root, lease);
  else rmSync(leaseDirectory(binding), { recursive: true });
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
    '--network=' + (workspaceNetwork(binding.root)),
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
        throw new AppError('Workspace container cleanup failed; recover the cloud runtime before starting another task', {
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

/** Startup completion and preview lifetime are separate: only confirmed container removal releases its writer. */
export function prepareSyncTransportPreview(candidate: string, bindingEpoch: string): WorkspaceRuntimePreviewReservation {
  const binding = syncTransportBinding(candidate, bindingEpoch);
  const current = admittedWorkspaceLease(binding);
  rejectBorrowedPreparedReservation(binding, current);
  const lease = current ?? claimWorkspace(binding);
  if (lease.mayWrite !== true) saveLease(binding, { ...lease, mayWrite: true });
  let settled!: () => void;
  let startupFinished = false;
  let released = false;
  // A confirmed container removal and releasing its last writer are separate
  // commits. Retain the exact callback if writer release fails so it can retry.
  const removals = new Map<string, 'recorded' | 'released'>();
  const startup = new Promise<void>(resolve => { settled = resolve; });
  const startups = preparedPreviewStartups.get(binding.root) ?? new Set<Promise<void>>();
  startups.add(startup);
  preparedPreviewStartups.set(binding.root, startups);
  if (!current) preparedWorkspaceReservations.set(binding.root, lease.id);
  const finishStartup = () => {
    startupFinished = true;
    settled();
    startups.delete(startup);
    if (startups.size === 0) preparedPreviewStartups.delete(binding.root);
  };
  const releaseIdle = () => {
    if (current || released || !startupFinished) return;
    const latest = assertCurrentWorkspaceLease(binding, lease);
    if (latest.previews?.length || latest.cleanupPending?.length) return;
    releasePreparedWorkerLease(binding, lease);
    released = true;
    if (preparedWorkspaceReservations.get(binding.root) === lease.id) preparedWorkspaceReservations.delete(binding.root);
  };
  return {
    root: binding.root,
    ...(lease.writerGate === true && lease.owner === 'claude' && Number.isInteger(lease.pid) && lease.pid! > 0 && lease.processStartTime && lease.bootId
      ? { lease: Object.freeze({ owner: 'claude' as const, id: lease.id, epoch: lease.epoch, pid: lease.pid!, processStartTime: lease.processStartTime, bootId: lease.bootId, writerGate: true as const }) } : {}),
    retain(containerId, cleanup) {
      if (startupFinished || released) throw new AppError('Preview startup reservation ended', { code: 'WORKSPACE_BUSY', statusCode: 409 });
      refreshedBinding(binding);
      const latest = assertCurrentWorkspaceLease(binding, lease);
      const previews = retainedWorkspacePreviews.get(binding.root) ?? new Map();
      if (previews.has(containerId)) throw new AppError('Preview identity is already reserved', { code: 'WORKSPACE_BUSY', statusCode: 409 });
      saveLease(binding, { ...latest, previews: [...new Set([...(latest.previews ?? []), containerId])] });
      previews.set(containerId, { leaseId: lease.id, cleanup });
      retainedWorkspacePreviews.set(binding.root, previews);
    },
    async release(containerId, cleanupConfirmed) {
      if (released || removals.get(containerId) === 'released') return;
      refreshedBinding(binding);
      const latest = assertCurrentWorkspaceLease(binding, lease);
      if (removals.get(containerId) === 'recorded') {
        if (!cleanupConfirmed || latest.previews?.includes(containerId) || latest.cleanupPending?.includes(containerId)) throw new AppError('Preview cleanup changed before writer release', { code: 'WORKSPACE_CLEANUP_FAILED', statusCode: 409 });
      } else {
        if (!latest.previews?.includes(containerId)) throw new AppError('Preview reservation changed', { code: 'WORKSPACE_CLEANUP_FAILED', statusCode: 409 });
        const pending = new Set(latest.cleanupPending ?? []);
        if (!cleanupConfirmed) {
          pending.add(containerId);
          saveLease(binding, { ...latest, cleanupPending: [...pending] });
          return;
        }
        pending.delete(containerId);
        saveLease(binding, { ...latest, previews: latest.previews.filter(id => id !== containerId), cleanupPending: [...pending] });
        removals.set(containerId, 'recorded');
      }
      releaseIdle();
      removals.set(containerId, 'released');
      const previews = retainedWorkspacePreviews.get(binding.root);
      previews?.delete(containerId);
      if (!previews?.size) retainedWorkspacePreviews.delete(binding.root);
    },
    async finish(cleanupConfirmed, containerId) {
      if (released) return;
      try {
        // Delivery callbacks run outside execution ALS; validate the captured exact lease.
        refreshedBinding(binding);
        const latest = assertCurrentWorkspaceLease(binding, lease);
        if (!cleanupConfirmed) saveLease(binding, { ...latest, cleanupPending: [...new Set([...(latest.cleanupPending ?? []), containerId ?? 'preview-startup-unconfirmed'])] });
      } finally { finishStartup(); }
      if (cleanupConfirmed) releaseIdle();
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
  if (binding?.ssh) {
    const target = resolveSshProjectTarget(cwd)!;
    const argv = action === 'checkout' ? ['git', 'checkout', ...(force ? ['--force'] : []), branch]
      : action === 'create' ? ['git', 'checkout', '-b', branch] : ['git', 'branch', force ? '-D' : '-d', branch];
    return runSshWorkspaceOperation(target, { op: 'exec', path: virtualPath(binding, cwd), argv, timeoutSeconds: 60 }, workspaceRequestSignal());
  }
  if (binding && !binding.vps) throw new AppError('Local Git execution has been removed. Use the cloud project.', { code: 'LOCAL_WORKSPACE_REMOVED', statusCode: 409 });
  if (!binding || binding.cloud || binding.isolated || (binding.vps && cloudWriterGateAvailable(binding.root, binding.bindingEpoch))) return null;
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
  const ssh = resolveSshProjectTarget(cwd);
  if (ssh) return withSshWorkspaceGitRead(ssh, operation, workspaceRequestSignal());
  const binding = resolveWorkspaceBinding(cwd);
  if (!binding) return operation();
  let native = false;
  // Native Git reads inspect the owning repository, including refs/remotes that
  // are deliberately absent from the synchronized execution replica.
  if (binding.localGitRead && !binding.isolated && !(binding.vps && cloudWriterGateAvailable(binding.root, binding.bindingEpoch)) && !readLease(binding) && !exclusiveWorkspaceWrites.has(binding.root)) {
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
  const ssh = resolveSshProjectTarget(cwd);
  if (ssh) return withSshWorkspaceWrite(ssh, operation, false, workspaceRequestSignal());
  const binding = resolveWorkspaceBinding(cwd);
  if (!binding) return operation();
  requireWorkspaceAdmission(binding);
  discardRecoveredExecution(binding);
  if (scopedWriteLease(binding)) return operation();
  const adopted = integrationScopes.getStore()?.adopted.get(binding.root);
  const currentLease = readLease(binding);
  if ((currentLease && (!adopted || currentLease.id !== adopted.id || currentLease.epoch !== adopted.epoch || currentLease.owner !== 'claude' || currentLease.pid !== process.pid)) || exclusiveWorkspaceWrites.has(binding.root) || workspaceOperations.has(binding.root) || preparedWorkspaceWorkers.has(binding.root) || sharedWorkspaceExecutions.has(binding.root) || executionReservations.has(binding.root)) {
    throw new AppError('Workspace is in use by a cloud task; wait for it to finish before changing Git.', { code: 'WORKSPACE_BUSY', statusCode: 409 });
  }
  const scope: WorkspaceWriteScope = { binding, lease: binding.vps ? adopted ?? claimWorkspace(binding) : null, active: true, parent: writeScopes.getStore() };
  exclusiveWorkspaceWrites.set(binding.root, scope);
  // A recovered integration keeps the original desktop run ID. Its original
  // sync_begin still owns that reservation; do not open a second run.
  let prepared = Boolean(adopted && !binding.isolated && !adopted.writerGate);
  try {
    return await completeWithCleanup(async () => {
      if (binding.vps && !binding.cloud && !binding.isolated && !scope.lease?.writerGate && !adopted) {
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
        await stopOwnedPreviews(binding, scope.lease);
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
type ExecutionReservation = { binding: Binding; lease: WorkspaceLease | null; active: boolean; readOnly: boolean; operations: Set<Promise<unknown>>; teardownConfirmed: boolean; assertSelection?: () => void };
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
  if (binding.ssh) return runSshWorkspaceOperation(resolveSshProjectTarget(binding.root)!, request, signal);
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
  if (String(request.op).startsWith('preview_')) {
    if (binding.cloud || binding.isolated || cloudWriterGateAvailable(binding.root, binding.bindingEpoch)) {
      const reservation = request.op === 'preview_start' ? prepareSyncTransportPreview(binding.root, binding.bindingEpoch) : undefined;
      return executeWorkspaceRuntimePreview(binding.root, binding.bindingEpoch, request, reservation, signal);
    }
    if (request.op === 'preview_status') return desktopControl(binding, request, signal);
  }
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
      if (!current && !binding.cloud && !binding.isolated && !lease.writerGate) {
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
export async function runWorkspaceCommand(cwd: string, command: string, args: string[], options: { readOnly?: boolean; timeoutSeconds?: number } = {}): Promise<RpcResult | null> {
  checkWorkspaceRequest();
  const binding = scopedGitReadBinding(cwd) ?? resolveWorkspaceBinding(cwd);
  if (!binding) return null;
  if (binding.ssh) {
    const target = resolveSshProjectTarget(cwd)!;
    const argv = [command, ...(command === 'git' ? ['--literal-pathspecs', ...(options.readOnly ? ['--no-optional-locks'] : [])] : []),
      ...args.map(arg => arg === binding.root || arg.startsWith(binding.root + path.sep) ? virtualPath(binding, arg) : arg)];
    const result = await runSshWorkspaceOperation(target, { op: 'exec', path: virtualPath(binding, cwd), argv, timeoutSeconds: options.timeoutSeconds ?? 60 }, workspaceRequestSignal());
    if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--show-toplevel' && result.exitCode === 0) {
      const root = result.stdout?.trim().replace(/\\/g, '/').replace(/\/$/, '');
      const expected = target.rootPath.replace(/\\/g, '/').replace(/\/$/, '');
      if (root?.toLowerCase() !== expected.toLowerCase()) throw new AppError('本地仓库根目录与已绑定项目不同。', { code: 'SSH_WORKSPACE_ROOT_MISMATCH', statusCode: 409 });
      result.stdout = binding.root + '\n';
    }
    return result;
  }
  if (binding.cloud && command === 'git' && !binding.isolated) excludeCloudWorkspaceMetadata(binding.root);
  const workspaceArgs = args.map(arg => arg === binding.root || arg.startsWith(binding.root + path.sep) ? virtualPath(binding, arg) : arg);
  const gitRead = gitReadScopes.getStore();
  if (options.readOnly && gitRead?.native && command !== 'git') {
    throw new AppError('This command is not supported by the selected native Git source', { code: 'WORKSPACE_GIT_UNSUPPORTED', statusCode: 409 });
  }
  const result = options.readOnly && command === 'git' && gitRead?.native
    ? await desktopControl(binding, { op: 'git_read', action: 'command', path: virtualPath(binding, cwd), argv: ['git', '--no-optional-locks', ...workspaceArgs] })
    : await rpc(binding, { op: 'exec', path: virtualPath(binding, cwd), argv: [command, ...(command === 'git' ? ['--literal-pathspecs', ...(options.readOnly ? ['--no-optional-locks'] : [])] : []), ...workspaceArgs], timeoutSeconds: options.timeoutSeconds ?? 60, readOnly: options.readOnly === true });
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
      const result = await readCall(p, 'realpath');
      scopedGitReadBinding(p);
      return path.join(binding.root, path.relative('/workspace', result!.path!));
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
    async removeDirectory(p) { if (!(await fileCall(p, 'remove', { recursive: true }))) await base.removeDirectory(p); },
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
    async rm(p, options) { if (!(await fileCall(p, 'remove', { recursive: options?.recursive === true }))) await base.rm(p, options); },
    async unlink(p) { if (!(await fileCall(p, 'remove'))) await base.unlink(p); },
  };
}

const READ_ONLY_WORKSPACE_OPS = new Set(['stat', 'lstat', 'list', 'batch', 'realpath', 'read', 'search', 'grep', 'preview_status']);

function workspaceRequestWrites(request: Record<string, unknown>): boolean {
  if (request.op === 'exec') return request.readOnly !== true;
  return !READ_ONLY_WORKSPACE_OPS.has(String(request.op));
}

function workspaceTools(binding: Binding, signal?: AbortSignal, readOnlySession = false, context?: Awaited<ReturnType<typeof prepareProjectRuntime>>) {
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
        return { content: [{ type: 'text' as const, text: JSON.stringify({ content, encoding: a.encoding, hash: r.hash, ...(context ? { projectRules: await context.rulesForPath(a.path) } : {}) }) }] };
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

type WorkspaceExecutionOptions = { cwd: string; sessionId?: string | null; workspaceMode?: SessionWorkspaceMode; readOnly?: boolean; signal?: AbortSignal; directExecution?: boolean; expectedWorkspace?: WorkspaceDescriptor };

function checkExecutionRoot(candidate: string): void {
  const actual = existsSync(candidate) ? realpathSync(candidate) : path.resolve(candidate);
  const boundary = existsSync(WORKSPACES_ROOT) ? realpathSync(WORKSPACES_ROOT) : path.resolve(WORKSPACES_ROOT);
  if (actual === boundary) throw new AppError('Select a project before starting a task; the workspace root contains all projects', { code: 'WORKSPACE_PROJECT_REQUIRED', statusCode: 400 });
}

function assertExactExecution(reservation: ExecutionReservation): void {
  reservation.assertSelection?.();
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
  const ssh = resolveSshProjectTarget(input.cwd);
  if (ssh) {
    if (input.directExecution) throw new AppError('SSH 项目只支持 VPS Claude 与 Windows 命令，不支持本地 AI 提供商。', { code: 'WORKSPACE_PROVIDER_UNSUPPORTED', statusCode: 409 });
    if (input.expectedWorkspace) {
      assertWorkspaceDescriptor(input.expectedWorkspace);
      if (input.expectedWorkspace.sourceMode !== 'ssh' || input.expectedWorkspace.sourceRoot !== ssh.anchorPath || input.expectedWorkspace.projectId !== ssh.projectId || input.expectedWorkspace.generation !== ssh.generation) throw new AppError('SSH 目标与所选工作区不匹配。', { code: 'WORKSPACE_SELECTION_MISMATCH', statusCode: 409 });
    }
    if (input.sessionId) describeSshWorkspace(ssh, input.sessionId);
    const admission = await admitSshWorkspace(ssh, input.readOnly === true, signal);
    try {
      // Reserve before the probe so background Git cannot occupy the helper or
      // writer between verification and the first Claude turn.
      await verifySshProject(ssh, signal);
      if (input.expectedWorkspace) assertWorkspaceDescriptor(input.expectedWorkspace);
      if (input.sessionId) describeSshWorkspace(ssh, input.sessionId);
      signal?.throwIfAborted();
      admission.assertCurrent();
    } catch (error) { await admission.close(); throw error; }
    return { ...admission, sourceCwd: ssh.anchorPath, cwd: ssh.anchorPath, sourceRoot: ssh.anchorPath, executionRoot: ssh.anchorPath,
      bound: true, isolated: false, readOnly: input.readOnly === true, bindingKind: 'ssh' as const,
      execute: (request: Record<string, unknown>, cancellation?: AbortSignal) => admission.run(() => runSshWorkspaceOperation(ssh, request, operationSignal(cancellation ?? signal))),
      async spawnProcess(_processInput: Parameters<typeof spawnWorkspaceProcess>[0]): Promise<Awaited<ReturnType<typeof spawnWorkspaceProcess>>> { throw new AppError('SSH 项目不支持此提供商进程。', { code: 'WORKSPACE_PROVIDER_UNSUPPORTED', statusCode: 409 }); },
      revoke() {},
    };
  }
  ensureCloudWorkspaceBinding(input.cwd);
  let binding = resolveWorkspaceBinding(input.cwd);
  const readOnly = input.readOnly === true;
  const sourceCwd = input.cwd;
  const expected = input.expectedWorkspace;
  // A retained session keeps its materialized mode even when a later caller
  // changes a default. Bootstrap alone chooses isolated versus shared mode.
  const workspaceMode = expected?.kind === 'session' ? expected.effectiveMode : input.workspaceMode === 'shared' ? 'shared' : 'isolated';
  let sourceRoot = binding?.root ?? input.cwd;
  if (binding?.isolated) {
    const metadata = JSON.parse(readFileSync(path.join(binding.root, '.chisa-session.json'), 'utf8')) as { sourceRoot: string; sessionId: string; bindingEpoch: string };
    const source = resolveWorkspaceBinding(metadata.sourceRoot);
    if (!source || source.isolated || source.root !== metadata.sourceRoot || source.bindingEpoch !== metadata.bindingEpoch || source.bindingEpoch !== binding.bindingEpoch || metadata.sessionId !== binding.sessionId || (input.sessionId && input.sessionId !== metadata.sessionId)) throw new AppError('The retained session belongs to a different workspace binding', { code: 'WORKSPACE_WORKTREE_CONFLICT', statusCode: 409 });
    sourceRoot = source.root;
  }
  const selectionMismatch = () => new AppError('The selected workspace no longer matches this execution; resolve it again', { code: 'WORKSPACE_SELECTION_MISMATCH', statusCode: 409 });
  const assertSelection = () => {
    if (!expected) return;
    assertWorkspaceDescriptor(expected);
    if (path.resolve(sourceRoot) !== expected.sourceRoot || (path.resolve(input.cwd) !== expected.sourceRoot && path.resolve(input.cwd) !== expected.rootPath)
      || (expected.kind === 'session' && expected.sessionId !== input.sessionId)) throw selectionMismatch();
  };
  const assertBootstrap = () => {
    assertSelection();
    if (expected?.kind === 'cloudReplica' && input.sessionId && describeWorkspaceSelection({ projectId: expected.projectId, sourceRoot, sessionId: input.sessionId }).session) throw selectionMismatch();
  };
  assertBootstrap();
  if (binding && input.directExecution && !binding.vps) throw new AppError('Local workspace execution has been removed. Open the cloud project directory.', { code: 'LOCAL_WORKSPACE_REMOVED', statusCode: 409 });
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
    if (owned.lease) await stopOwnedPreviews(owned.binding, owned.lease);
    owned.teardownConfirmed = true;
    if (owned.lease) await releaseWorkspace(owned.binding, owned.lease, synced);
    if (executionReservations.get(owned.binding.root) === owned) executionReservations.delete(owned.binding.root);
  };
  let closePromise: Promise<void> | undefined;
  try {
    if (binding?.vps && !binding.isolated && workspaceMode === 'isolated' && input.sessionId) {
      const root = path.join(binding.root + '.chisa-worktrees', sessionWorktreeName(input.sessionId));
      if (existsSync(path.join(root, '.chisa-session.json')) && existsSync(path.join(root, '.chisa-bridge.json'))) {
        binding = (await createSessionWorktree(binding, input.sessionId, assertSelection, signal))!;
      } else {
        sourceReservation = reserve(binding);
        // Even a lost/failed acknowledgement follows sync_end below; prepared
        // stays false until success so recovery treats the snapshot as possibly dirty.
        if (!binding.cloud && !sourceReservation.lease?.writerGate) {
          const result = await desktopControl(binding, { op: 'sync_begin', runId: sourceReservation.lease!.id, snapshot: true }, signal);
          if (result.snapshotPinned !== true || result.bindingEpoch !== binding.bindingEpoch) throw new AppError('Update the desktop client before creating an isolated workspace snapshot', { code: 'WORKSPACE_SNAPSHOT_UNSUPPORTED', statusCode: 409 });
        }
        prepared = true;
        const source = sourceReservation;
        assertBootstrap();
        const isolated = await createSessionWorktree(binding, input.sessionId, () => { assertSelection(); assertExactExecution(source); }, signal);
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
      if (binding.vps && !binding.cloud && !binding.isolated && !reservation.lease?.writerGate) {
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
    assertSelection();
    if (expected?.kind === 'session' && (binding?.root ?? path.resolve(input.cwd)) !== expected.rootPath) throw selectionMismatch();
    const materializedSessionId = binding?.sessionId ?? input.sessionId;
    if (materializedSessionId) {
      const executionRoot = binding?.root ?? input.cwd;
      const epoch = binding?.bindingEpoch ?? 'unbound';
      const identity = readSessionIdentity(sourceRoot, executionRoot, materializedSessionId, epoch);
      if (binding?.isolated) {
        // Existing workspaces without an original snapshot remain non-integrable.
        // Recording their identity only makes their actual execution selectable.
        if (!identity) recordSessionIdentity({ sourceRoot, executionRoot, sessionId: materializedSessionId, bindingEpoch: epoch, requestedMode: 'isolated', effectiveMode: 'isolated' });
        else if (identity.effectiveMode !== 'isolated') throw new AppError('Session execution mode changed', { code: 'WORKSPACE_SELECTION_MISMATCH', statusCode: 409 });
      } else {
        recordSessionIdentity({ sourceRoot, executionRoot, sessionId: materializedSessionId, bindingEpoch: epoch, requestedMode: expected?.kind === 'session' ? expected.requestedMode : workspaceMode, effectiveMode: 'shared' });
      }
    }
    signal?.throwIfAborted();
    const owned = reservation;
    const cwd = binding?.isolated ? path.join(binding.root, path.relative(resolveWorkspaceBinding(input.cwd)!.root, input.cwd)) : input.cwd;
    const admittedDescriptor = expected && materializedSessionId
      ? describeWorkspaceSelection({ projectId: expected.projectId, sourceRoot, sessionId: materializedSessionId }).session
      : expected;
    if (expected && materializedSessionId && !admittedDescriptor) throw selectionMismatch();
    const assertAdmittedSelection = () => {
      assertSelection();
      if (admittedDescriptor) assertWorkspaceDescriptor(admittedDescriptor);
    };
    if (owned) owned.assertSelection = assertAdmittedSelection;
    const assertExecutionSelection = () => {
      assertAdmittedSelection();
      if (owned) assertExactExecution(owned);
    };
    assertExecutionSelection();
    return {
      assertCurrent: assertExecutionSelection,
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
          network: workspaceNetwork(selected.root), name, gitMounts: gitRuntime?.mounts ?? [], isolated: selected.isolated,
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

/** Used by Claude runtime; bound workspaces expose only their project tools. */
export function workspaceQuery(input: Parameters<typeof sdkQuery>[0]): ReturnType<typeof sdkQuery> {
  const ssh = input.options?.cwd ? resolveSshProjectTarget(input.options.cwd) : null;
  if (ssh) return sshWorkspaceQuery(input, ssh, admitWorkspaceExecution);
  if (input.options?.cwd) {
    checkExecutionRoot(input.options.cwd);
    ensureCloudWorkspaceBinding(input.options.cwd);
  }
  let binding = input.options?.cwd ? resolveWorkspaceBinding(input.options.cwd) : null;
  const options = input.options ?? {};
  const sessionOptions = options as typeof options & { chisaSessionId?: unknown; sessionId?: unknown; workspaceMode?: unknown; chisaWorkspaceDescriptor?: WorkspaceDescriptor; chisaPrepareLaunch?: (cwd: string) => Promise<void>; chisaProjectRuntime?: ProjectRuntimeLaunchContext };
  const launch = sessionOptions.chisaProjectRuntime;
  delete sessionOptions.chisaProjectRuntime;
  // Provider-only preparation runs after admission has selected the real execution cwd, never inside the SDK.
  const prepareLaunch = sessionOptions.chisaPrepareLaunch;
  delete sessionOptions.chisaPrepareLaunch;
  const expectedWorkspace = sessionOptions.chisaWorkspaceDescriptor;
  if ('chisaWorkspaceDescriptor' in sessionOptions) delete sessionOptions.chisaWorkspaceDescriptor;
  const sessionId = typeof sessionOptions.chisaSessionId === 'string' ? sessionOptions.chisaSessionId : typeof sessionOptions.sessionId === 'string' ? sessionOptions.sessionId : null;
  const workspaceMode: SessionWorkspaceMode = sessionOptions.workspaceMode === 'shared' ? 'shared' : 'isolated';
  if ('chisaSessionId' in sessionOptions) delete sessionOptions.chisaSessionId;
  if ('workspaceMode' in sessionOptions) delete sessionOptions.workspaceMode;
  const initialAllowedTools = [...(options.allowedTools ?? [])];
  let readOnlySession = binding !== null && options.permissionMode === 'plan';
  let projectContext: Awaited<ReturnType<typeof prepareProjectRuntime>> | undefined;
  const cancellation = new AbortController();
  const externalSignal = options.abortController?.signal;
  const cancelFromCaller = () => cancellation.abort(externalSignal?.reason);
  externalSignal?.addEventListener('abort', cancelFromCaller, { once: true });
  if (externalSignal?.aborted) cancelFromCaller();
  if (binding) {
    options.tools = ['AskUserQuestion', 'ExitPlanMode', 'TodoWrite'];
    options.mcpServers = { workspace: workspaceTools(binding, cancellation.signal, readOnlySession) };
    options.strictMcpConfig = true;
    options.allowedTools = ['list_files', 'read_file', 'write_file', 'search_files', 'run_command', 'start_preview', 'preview_status', 'stop_preview'].map(name => `mcp__workspace__${name}`);
    options.settingSources = [];
    options.env = { ...options.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };
    const instruction = (binding.vps ? `Claude Code and the project tools execute on this VPS. The tools run in an isolated Linux container on this server. ${readOnlySession ? 'This is a read-only inspection session: inspect files and run commands with readOnly=true; writes and preview control are rejected after workspace freshness is confirmed. ' : 'Use run_command with readOnly=true for code review and inspection commands. This prohibits project writes and avoids unnecessary write reservations. '}` : '') + 'Project files and commands are available only through the workspace tools under /workspace. Read /workspace/CLAUDE.md if present for project instructions. Report actual command results; do not infer runtime success from a successful tool request.';
    const previousSystemPrompt = options.systemPrompt;
    const previous = typeof previousSystemPrompt === 'string' ? previousSystemPrompt : Array.isArray(previousSystemPrompt) ? previousSystemPrompt.join('\n') : previousSystemPrompt && typeof previousSystemPrompt === 'object' && 'append' in previousSystemPrompt ? previousSystemPrompt.append || '' : '';
    options.systemPrompt = { type: 'preset', preset: 'claude_code', append: previous + '\n' + instruction };
  }
  const spawnProcess = options.spawnClaudeCodeProcess;
  let processExit: Promise<void> | undefined;
  let execution: Awaited<ReturnType<typeof admitWorkspaceExecution>> | undefined;
  options.spawnClaudeCodeProcess = spawnOptions => {
    cancellation.signal.throwIfAborted();
    execution?.assertCurrent();
    if (spawnProcess) {
      const child: SpawnedProcess = spawnProcess(spawnOptions);
      processExit = new Promise<void>((resolve, reject) => {
        if (child.exitCode !== null) { resolve(); return; }
        child.once('exit', () => resolve());
        child.once('error', reject);
      });
      void processExit.catch(() => {});
      return child;
    }
    const captureStderr = Boolean(spawnOptions.env.DEBUG_CLAUDE_AGENT_SDK) || Boolean(options.stderr);
    const child = spawn(spawnOptions.command, spawnOptions.args, {
      cwd: spawnOptions.cwd, env: spawnOptions.env, signal: spawnOptions.signal,
      stdio: ['pipe', 'pipe', captureStderr ? 'pipe' : 'ignore'], windowsHide: true,
    });
    if (captureStderr) child.stderr?.on('data', (chunk: Buffer) => { options.stderr?.(chunk.toString()); });
    // Query.close() ends its iterator before the CLI actually exits. The public
    // SDK spawn hook lets the lease outlive that real process, without a sleep.
    processExit = new Promise<void>(resolve => { child.once('close', () => resolve()); });
    return child as unknown as SpawnedProcess;
  };
  let active: ReturnType<typeof sdkQuery> | undefined;
  let sdkStarted = false;
  let cancelled = false;
  let cleanup: Promise<void> | undefined;
  const stream = (async function* () {
    let primary: unknown;
    let failed = false;
    let cleanupFailure: unknown;
    let cleanupFailed = false;
    try {
      cancellation.signal.throwIfAborted();
      if (options.cwd) {
        execution = await admitWorkspaceExecution({ cwd: options.cwd, sessionId, workspaceMode, readOnly: readOnlySession, signal: cancellation.signal, expectedWorkspace });
        options.cwd = execution.cwd;
        binding = resolveWorkspaceBinding(execution.cwd);
        if (binding) {
          if (launch && execution && expectedWorkspace) {
            const descriptor = sessionId ? describeWorkspaceSelection({ projectId: expectedWorkspace.projectId, sourceRoot: execution.sourceRoot, sessionId }).session ?? expectedWorkspace : expectedWorkspace;
            projectContext = await prepareProjectRuntime({ launch, descriptor, execute: execution.execute,
              assertCurrent: execution.assertCurrent, signal: cancellation.signal, options });
            readOnlySession = options.permissionMode === 'plan';
          }
          options.mcpServers = { ...projectContext?.mcpServers, ...(projectContext ? { project_context: projectContext.server } : {}), workspace: workspaceTools(binding, cancellation.signal, readOnlySession, projectContext) };
          if (projectContext) {
            if (options.permissionMode === 'dontAsk') {
              const safeInspection = new Set(['mcp__workspace__list_files', 'mcp__workspace__read_file', 'mcp__workspace__search_files', 'mcp__workspace__preview_status']);
              const explicit = [...initialAllowedTools, ...projectContext.configuredAllowedTools];
              options.allowedTools = options.allowedTools?.filter(name => !name.startsWith('mcp__workspace__') || safeInspection.has(name) || explicit.some(rule => projectPermissionMatches(rule, name)));
            }
            options.allowedTools = options.allowedTools?.filter(name => !projectContext?.askTools.some(rule => projectPermissionMatches(rule, name)) && !options.disallowedTools?.some(rule => projectPermissionMatches(rule, name)));
          }
        }
      }
      if (cancelled) return;
      cancellation.signal.throwIfAborted();
      execution?.assertCurrent();
      if (prepareLaunch && options.cwd) await prepareLaunch(options.cwd);
      if (cancelled) return;
      cancellation.signal.throwIfAborted();
      execution?.assertCurrent();
      sdkStarted = true;
      active = sdkQuery({ ...input, options });
      for await (const event of active) { projectContext?.observe(event); yield event; }
    } catch (error) {
      primary = error;
      failed = true;
    } finally {
      cleanup = (async () => {
        active?.close();
        await processExit;
        try { await execution?.close(); }
        finally { projectContext?.close(failed || cancellation.signal.aborted); }
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
        cancellation.abort();
        active?.close();
        // chat.abort may admit another turn only after sync_end removes the lease.
        await target.return(undefined);
        // A pending next() can receive the cleanup error before return() settles.
        await cleanup;
      };
      if (property === 'close') return () => {
        cancelled = true;
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
