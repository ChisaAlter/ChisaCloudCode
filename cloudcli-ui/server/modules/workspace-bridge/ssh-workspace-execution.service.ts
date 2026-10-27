import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { sshProjectTargetsDb, sessionsDb } from '@/modules/database/index.js';
import { executeSshWorkspace, probeSshWorkspace } from '@/modules/ssh-workspaces/index.js';
import { AppError, WORKSPACES_ROOT } from '@/shared/index.js';
import type { SshProjectTarget, SshWorkspaceRpcResult, WorkspaceDescriptor, WorkspaceResolution } from '@/shared/index.js';

type SshRunScope = { target: SshProjectTarget; runId: string; readOnly: boolean; uncertain: boolean; pendingJobId?: string; operations: Set<Promise<unknown>>; active: boolean; mutationActive?: boolean; gitInspection?: boolean };
type SshAdmissionTicket = { start(): void; fail(error: unknown): void };
type SshInspectionLane = { target: SshProjectTarget; inspecting: boolean; foregroundActive?: boolean; reads: SshAdmissionTicket[]; foreground?: SshAdmissionTicket };
const runs = new AsyncLocalStorage<SshRunScope>();
const activeRuns = new Map<string, SshRunScope>();
const inspectionLanes = new Map<string, SshInspectionLane>();
const ADMISSION_WAIT_MS = 120_000;
const MAX_QUEUED_INSPECTIONS = 32;
const connectionStates = new Map<string, 'online' | 'offline'>();

function reservedPath(candidate: string): boolean {
  const boundary = path.resolve(WORKSPACES_ROOT, '.chisa-ssh-projects');
  const absolute = path.resolve(candidate);
  return absolute === boundary || absolute.startsWith(boundary + path.sep);
}

/** Bridge adapters recognize the reserved metadata namespace before touching cloud bindings; an unknown SSH anchor always fails closed. */
export function resolveSshProjectTarget(candidate: string): SshProjectTarget | null {
  if (!reservedPath(candidate)) return null;
  const target = sshProjectTargetsDb.getByPath(candidate);
  if (!target) throw new AppError('SSH 项目绑定不存在，请重新打开项目。', { code: 'SSH_WORKSPACE_NOT_FOUND', statusCode: 404 });
  return target;
}

function fresh(target: SshProjectTarget): SshProjectTarget {
  const current = sshProjectTargetsDb.getByProjectId(target.projectId);
  if (!current || current.generation !== target.generation || current.rootIdentity !== target.rootIdentity
    || current.connectionId !== target.connectionId || current.anchorPath !== target.anchorPath
    || current.ownerId !== target.ownerId || current.rootPath !== target.rootPath || current.workspaceId !== target.workspaceId) {
    throw new AppError('SSH 项目目标已改变，请重新打开项目。', { code: 'WORKSPACE_GENERATION_CHANGED', statusCode: 409 });
  }
  return current;
}

/** Catalog/chat callers authorize the account before selecting a saved local target; keys and endpoint settings never come from the browser. */
export function assertSshProjectOwner(target: SshProjectTarget, userId: string | number | null | undefined): void {
  if (userId === null || userId === undefined || String(userId) !== target.ownerId) {
    throw new AppError('该 SSH 项目不属于当前账号。', { code: 'SSH_WORKSPACE_FORBIDDEN', statusCode: 403 });
  }
}

/** A metadata-only catalog response never treats the VPS anchor as a source checkout. */
export function describeSshWorkspace(target: SshProjectTarget, sessionId?: string): WorkspaceResolution {
  target = fresh(target);
  const phase = target.phase;
  const descriptor: WorkspaceDescriptor = {
    workspaceId: target.workspaceId, projectId: target.projectId, kind: 'cloudReplica', generation: target.generation,
    rootPath: target.anchorPath, sourceRoot: target.anchorPath, sourceMode: 'ssh', displayPath: target.rootPath,
    connectionState: phase === 'recovery' || (phase === 'running' && !activeRuns.has(target.projectId)) ? 'recovery' : connectionStates.get(target.projectId) ?? 'offline',
    requestedMode: 'shared', effectiveMode: 'shared', phase: phase === 'running' && !activeRuns.has(target.projectId) ? 'recovery' : phase, publicationState: 'integrated',
    capabilities: { read: true, write: phase === 'idle', git: true, shell: true, preview: false, integrate: false, cloudExecutionIndependentOfDesktop: false },
  };
  if (!sessionId) return { cloudReplica: descriptor, session: null };
  const row = sessionsDb.getSessionById(sessionId);
  if (!row || row.project_path !== target.anchorPath) throw new AppError('会话与 SSH 项目不匹配。', { code: 'WORKSPACE_SELECTION_MISMATCH', statusCode: 409 });
  sshProjectTargetsDb.pinSession(sessionId, target);
  return { cloudReplica: descriptor, session: { ...descriptor, kind: 'session', sessionId, workspaceId: `${target.workspaceId}:session:${sessionId}` } };
}

/** Admission proves inner SSH authentication and root identity, not merely the presence of an outer tunnel. */
export async function verifySshProject(target: SshProjectTarget, signal?: AbortSignal): Promise<void> {
  fresh(target);
  try {
    const result = await probeSshWorkspace({ connectionId: target.connectionId, rootPath: target.rootPath, userId: target.ownerId, signal });
    if (result.rootIdentity !== target.rootIdentity || result.rootPath.toLowerCase() !== target.rootPath.toLowerCase()) {
      throw new AppError('本地目录身份已改变，请重新绑定项目。', { code: 'SSH_WORKSPACE_CHANGED', statusCode: 409 });
    }
    fresh(target);
    connectionStates.set(target.projectId, 'online');
  } catch (error) { connectionStates.set(target.projectId, 'offline'); throw error; }
}

function failureJob(error: unknown): string | undefined {
  const value = error as { jobId?: unknown; details?: { jobId?: unknown } } | null;
  const job = value?.jobId ?? value?.details?.jobId;
  return typeof job === 'string' ? job : undefined;
}

function uncertain(error: unknown): boolean {
  const value = error as { code?: unknown; workspaceCleanupError?: unknown } | null;
  return value?.workspaceCleanupError === true || value?.code === 'SSH_WORKSPACE_CLEANUP_UNCONFIRMED'
    || value?.code === 'SSH_EXECUTION_UNCONFIRMED' || value?.code === 'SSH_OPERATION_UNCONFIRMED';
}

function writeOperation(request: Record<string, unknown>): boolean {
  return !['stat', 'lstat', 'list', 'batch', 'realpath', 'read', 'search', 'grep', 'job_status', 'operation_status'].includes(String(request.op));
}

function busy(): AppError {
  return new AppError('SSH 项目正由任务占用，请等待当前任务结束。', { code: 'WORKSPACE_BUSY', statusCode: 409 });
}

function laneKey(target: SshProjectTarget): string { return JSON.stringify([target.projectId, target.generation]); }

function drainInspections(key: string, lane: SshInspectionLane): void {
  if (lane.inspecting || lane.foregroundActive) return;
  // A foreground caller takes ownership synchronously inside start(), before
  // queued background polls can acquire the durable writer again.
  const foreground = lane.foreground;
  if (foreground) {
    lane.foreground = undefined;
    foreground.start();
    const scope = activeRuns.get(lane.target.projectId);
    if (scope && scope.target.generation === lane.target.generation && !scope.gitInspection) {
      lane.foregroundActive = true;
      return;
    }
  }
  if (lane.reads.length) {
    const next = lane.reads.shift()!;
    lane.inspecting = true;
    next.start();
  } else if (!lane.foreground && !lane.inspecting && inspectionLanes.get(key) === lane) inspectionLanes.delete(key);
}

function afterInspection<T>(target: SshProjectTarget, operation: () => T, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  target = fresh(target);
  const scope = activeRuns.get(target.projectId);
  const key = laneKey(target);
  const lane = inspectionLanes.get(key);
  // Wait only for a positively classified live inspection, never for a task,
  // command, stale persisted run or another foreground caller.
  if (lane?.foreground || lane?.foregroundActive) return Promise.reject(busy());
  if (!scope?.gitInspection || scope.target.generation !== target.generation || !lane?.inspecting) {
    if (target.phase !== 'idle') return Promise.reject(busy());
    try { return Promise.resolve(operation()); } catch (error) { return Promise.reject(error); }
  }
  const admitted = AsyncResource.bind(operation);
  const deadline = Date.now() + ADMISSION_WAIT_MS;
  const timeout = () => new AppError('等待 Git 检查结束超时，操作尚未开始。', { code: 'WORKSPACE_ADMISSION_TIMEOUT', statusCode: 409 });
  return new Promise<T>((resolve, reject) => {
    let waiting = true;
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); };
    const cancel = () => ticket.fail(signal?.reason ?? busy());
    const ticket: SshAdmissionTicket = {
      fail(error) {
        if (!waiting) return;
        waiting = false; finish();
        if (lane.foreground === ticket) lane.foreground = undefined;
        reject(error);
      },
      start() {
        if (!waiting) return;
        waiting = false; finish();
        try {
          signal?.throwIfAborted();
          if (Date.now() >= deadline) throw timeout();
          const current = fresh(target);
          if (current.phase !== 'idle') throw busy();
          // No await between the final check and beginRun in operation().
          resolve(admitted());
        } catch (error) { reject(error); }
      },
    };
    const timer = setTimeout(() => ticket.fail(timeout()), ADMISSION_WAIT_MS);
    timer.unref();
    lane.foreground = ticket;
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}

function resumeInspections(target: SshProjectTarget): void {
  const key = laneKey(target), lane = inspectionLanes.get(key);
  if (!lane || !lane.foregroundActive) return;
  lane.foregroundActive = false;
  drainInspections(key, lane);
}

async function withWriter<T>(target: SshProjectTarget, operation: () => Promise<T>, readOnly: boolean, gitInspection = false): Promise<T> {
  target = fresh(target);
  const nested = runs.getStore();
  if (nested?.target.projectId === target.projectId) {
    if (!nested.active || nested.uncertain || nested.target.generation !== target.generation) throw busy();
    if (nested.readOnly && !readOnly) throw new AppError('当前会话只允许文件检查。', { code: 'WORKSPACE_READ_ONLY', statusCode: 409 });
    return operation();
  }
  const runId = randomUUID();
  sshProjectTargetsDb.beginRun(target.projectId, runId);
  const scope: SshRunScope = { target, runId, readOnly, gitInspection, uncertain: false, operations: new Set(), active: true };
  activeRuns.set(target.projectId, scope);
  try { return await runs.run(scope, operation); }
  catch (error) { if (uncertain(error)) { scope.uncertain = true; scope.pendingJobId = failureJob(error); } throw error; }
  finally {
    scope.active = false;
    await Promise.allSettled([...scope.operations]);
    if (activeRuns.get(target.projectId) === scope) activeRuns.delete(target.projectId);
    try { sshProjectTargetsDb.finishRun(target.projectId, runId, { uncertain: scope.uncertain, pendingJobId: scope.pendingJobId }); }
    finally { if (!gitInspection) resumeInspections(target); }
  }
}

/** Git/UI/file/console callers may await one active inspection before their single durable writer admission; live foreground tasks still reject immediately. */
export async function withSshWorkspaceWrite<T>(target: SshProjectTarget, operation: () => Promise<T>, readOnly = false, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  if (runs.getStore()?.target.projectId === target.projectId) return withWriter(target, operation, readOnly);
  return afterInspection(target, () => withWriter(target, operation, readOnly), signal);
}

/** Classified inspections remain FIFO, while one foreground admission has priority over every inspection that has not started. */
export async function withSshWorkspaceGitRead<T>(target: SshProjectTarget, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  target = fresh(target);
  const run = async () => {
    signal?.throwIfAborted();
    const current = fresh(target);
    if (current.phase === 'recovery') throw new AppError('SSH 项目有未确认的任务，请先恢复。', { code: 'SSH_WORKSPACE_RECOVERY_REQUIRED', statusCode: 409 });
    const result = await withWriter(target, operation, false, true);
    signal?.throwIfAborted();
    fresh(target);
    return result;
  };
  if (runs.getStore()?.target.projectId === target.projectId) return run();
  const active = activeRuns.get(target.projectId);
  if (active && !active.gitInspection) throw busy();
  const key = laneKey(target);
  let lane = inspectionLanes.get(key);
  if (!lane) { lane = { target, inspecting: false, reads: [] }; inspectionLanes.set(key, lane); }
  if (lane.reads.length >= MAX_QUEUED_INSPECTIONS) throw busy();
  const selected = lane;
  // Drain runs in the previous request's async context. Bind each admitted
  // callback to its own HTTP owner/signal and outer reservation context.
  const boundRun = AsyncResource.bind(run);
  return new Promise<T>((resolve, reject) => {
    let waiting = true;
    const cancel = () => ticket.fail(signal?.reason ?? busy());
    const ticket: SshAdmissionTicket = {
      fail(error) {
        if (!waiting) return;
        waiting = false; signal?.removeEventListener('abort', cancel);
        selected.reads = selected.reads.filter(item => item !== ticket);
        reject(error);
      },
      start() {
        if (!waiting) { selected.inspecting = false; drainInspections(key, selected); return; }
        waiting = false; signal?.removeEventListener('abort', cancel);
        // Admitted cancellation waits for the existing transport cleanup and
        // durable finishRun; queue cancellation never releases its predecessor.
        const scheduled = boundRun();
        scheduled.then(resolve, reject).finally(() => {
          selected.inspecting = false;
          drainInspections(key, selected);
        });
      },
    };
    selected.reads.push(ticket);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    drainInspections(key, selected);
  });
}

function createAdmission(target: SshProjectTarget, readOnly: boolean) {
  target = fresh(target);
  const runId = randomUUID();
  sshProjectTargetsDb.beginRun(target.projectId, runId);
  const scope: SshRunScope = { target, runId, readOnly, uncertain: false, operations: new Set(), active: true };
  activeRuns.set(target.projectId, scope);
  let closePromise: Promise<void> | undefined;
  return {
    assertCurrent() {
      const current = fresh(target);
      if (!scope.active || current.activeRunId !== runId) throw new AppError('SSH 任务已结束或绑定被替换。', { code: 'WORKSPACE_BUSY', statusCode: 409 });
    },
    run<T>(operation: () => T): T { return runs.run(scope, operation); },
    close() {
      if (closePromise) return closePromise;
      scope.active = false;
      closePromise = (async () => {
        await Promise.allSettled([...scope.operations]);
        if (activeRuns.get(target.projectId) === scope) activeRuns.delete(target.projectId);
        try { sshProjectTargetsDb.finishRun(target.projectId, runId, { uncertain: scope.uncertain, pendingJobId: scope.pendingJobId }); }
        finally { resumeInspections(target); }
        if (scope.uncertain) throw Object.assign(new AppError('远端任务结束尚未确认，请检查并停止原任务后恢复。', { code: 'SSH_WORKSPACE_RECOVERY_REQUIRED', statusCode: 409 }), { workspaceCleanupError: true });
      })();
      return closePromise;
    },
  };
}

/** Claude admission waits only for a classified inspection, then retains its writer through SDK/process teardown. */
export async function admitSshWorkspace(target: SshProjectTarget, readOnly: boolean, signal?: AbortSignal) {
  return afterInspection(target, () => createAdmission(target, readOnly), signal);
}

/** All bridge RPC adapters use this transport; SSH failures are errors and can never select the host/cloud fallback. */
export async function runSshWorkspaceOperation(target: SshProjectTarget, request: Record<string, unknown>, signal?: AbortSignal): Promise<SshWorkspaceRpcResult> {
  target = fresh(target);
  const scoped = runs.getStore();
  if (scoped) {
    if (!scoped.active || scoped.target.projectId !== target.projectId || scoped.target.generation !== target.generation || target.activeRunId !== scoped.runId) {
      throw new AppError('SSH 任务已结束或不再拥有项目。', { code: 'WORKSPACE_BUSY', statusCode: 409 });
    }
    if (scoped.uncertain) throw new AppError('远端任务尚未确认结束，不能开始新操作。', { code: 'SSH_WORKSPACE_RECOVERY_REQUIRED', statusCode: 409 });
  }
  if (scoped?.target.projectId === target.projectId && scoped.readOnly && writeOperation(request)) {
    throw new AppError('SSH 计划会话仅允许读取文件，不能执行命令或写入。', { code: 'WORKSPACE_READ_ONLY', statusCode: 409 });
  }
  if (writeOperation(request) && scoped?.target.projectId !== target.projectId) {
    return withSshWorkspaceWrite(target, () => runSshWorkspaceOperation(target, request, signal), false, signal);
  }
  if (target.phase === 'recovery' && !['job_status', 'job_cancel', 'operation_status', 'operation_cancel'].includes(String(request.op))) {
    throw new AppError('SSH 项目有未确认的任务，请先恢复。', { code: 'SSH_WORKSPACE_RECOVERY_REQUIRED', statusCode: 409 });
  }
  const mutation = writeOperation(request);
  if (mutation && scoped?.mutationActive) throw new AppError('当前 SSH 写入命令仍在执行，请等待它结束。', { code: 'WORKSPACE_BUSY', statusCode: 409 });
  if (mutation && scoped) scoped.mutationActive = true;
  const operation = executeSshWorkspace({ connectionId: target.connectionId, rootPath: target.rootPath, userId: target.ownerId,
    generation: target.generation, expectedRootIdentity: target.rootIdentity, request, signal,
    onJobCreated: jobId => {
      if (!scoped || !scoped.active || scoped.target.projectId !== target.projectId) throw new AppError('操作缺少有效的 SSH 任务身份。', { code: 'WORKSPACE_BUSY', statusCode: 409 });
      sshProjectTargetsDb.setPendingJob(target.projectId, scoped.runId, jobId);
      scoped.pendingJobId = jobId;
    },
  });
  scoped?.operations.add(operation);
  try {
    const result = await operation;
    if (scoped?.pendingJobId && (request.op === 'exec' ? result.cleanupConfirmed === true
      : ['write', 'mkdir', 'rename', 'copy', 'remove'].includes(String(request.op)) && scoped.pendingJobId.startsWith('operation:'))) {
      sshProjectTargetsDb.setPendingJob(target.projectId, scoped.runId, null);
      scoped.pendingJobId = undefined;
    }
    connectionStates.set(target.projectId, 'online');
    fresh(target);
    return result;
  } catch (error) {
    const confirmed = (error as { details?: { transportConfirmed?: boolean } }).details?.transportConfirmed === true;
    connectionStates.set(target.projectId, confirmed ? 'online' : 'offline');
    if (scoped && uncertain(error)) { scoped.uncertain = true; scoped.pendingJobId = failureJob(error) ?? scoped.pendingJobId; }
    else if (scoped?.pendingJobId && (request.op === 'exec'
      ? (error as { details?: { cleanupConfirmed?: boolean } }).details?.cleanupConfirmed === true
      : scoped.pendingJobId.startsWith('operation:') && (confirmed || (error as { details?: { requestDispatched?: boolean } }).details?.requestDispatched === false))) {
      sshProjectTargetsDb.setPendingJob(target.projectId, scoped.runId, null);
      scoped.pendingJobId = undefined;
    }
    if (error instanceof AppError) throw error;
    const failure = error as { code?: string; statusCode?: number; details?: unknown };
    throw Object.assign(new AppError(error instanceof Error ? error.message : 'SSH 项目操作失败。', {
      code: typeof failure.code === 'string' ? failure.code : 'SSH_WORKSPACE_UNAVAILABLE',
      statusCode: typeof failure.statusCode === 'number' ? failure.statusCode : 503, details: failure.details,
    }), uncertain(error) ? { workspaceCleanupError: true } : {});
  } finally {
    scoped?.operations.delete(operation);
    if (mutation && scoped) scoped.mutationActive = false;
  }
}

/** The Windows command console uses the same target and writer lifecycle as CC, without launching a local coding-agent CLI. */
export async function runSshWorkspaceCommand(descriptor: WorkspaceDescriptor, command: string, signal?: AbortSignal) {
  const target = resolveSshProjectTarget(descriptor.sourceRoot);
  if (!target || descriptor.sourceMode !== 'ssh' || descriptor.generation !== target.generation || descriptor.projectId !== target.projectId) throw new AppError('SSH 工作区身份不匹配。', { code: 'WORKSPACE_GENERATION_CHANGED', statusCode: 409 });
  return runSshWorkspaceOperation(target, { op: 'exec', path: '/workspace', command, timeoutSeconds: 600 }, signal);
}

/** Explicit recovery checks/cancels only the persisted job; a disconnected SSH process is never proof that Windows stopped. */
export async function recoverSshWorkspace(target: SshProjectTarget, cancel = false) {
  target = fresh(target);
  if (activeRuns.has(target.projectId)) throw new AppError('任务仍由当前服务管理，请先停止任务。', { code: 'WORKSPACE_BUSY', statusCode: 409 });
  await verifySshProject(target);
  if (!target.activeRunId) return { status: 'idle' as const };
  if (!target.pendingJobId) {
    // Legacy file operations have no receipt. A fresh probe and HTTP abort do
    // not prove that their helper stopped; automatic recovery must fail closed.
    throw new AppError('旧文件操作没有可验证的完成记录；请先在本机确认原操作已停止并检查改动，不能自动解除恢复锁。', {
      code: 'SSH_OPERATION_RECOVERY_UNCONFIRMED', statusCode: 409,
    });
  }
  const operationId = target.pendingJobId.startsWith('operation:') ? target.pendingJobId.slice('operation:'.length) : undefined;
  const result = await executeSshWorkspace({ connectionId: target.connectionId, rootPath: target.rootPath, userId: target.ownerId,
    expectedRootIdentity: target.rootIdentity, generation: target.generation,
    request: operationId ? { op: cancel ? 'operation_cancel' : 'operation_status', operationId }
      : { op: cancel ? 'job_cancel' : 'job_status', jobId: target.pendingJobId } });
  if (result.cleanupConfirmed !== true) return { status: 'running' as const, jobId: target.pendingJobId };
  const current = fresh(target);
  if (current.activeRunId !== target.activeRunId || current.pendingJobId !== target.pendingJobId) throw new AppError('恢复目标已改变，请重新检查。', { code: 'WORKSPACE_GENERATION_CHANGED', statusCode: 409 });
  sshProjectTargetsDb.recoverRun(target.projectId, target.activeRunId);
  return operationId ? { status: 'idle' as const, inspectChanges: true } : { status: 'idle' as const };
}
