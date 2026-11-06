import { AsyncResource } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { userDb } from '@/modules/database/index.js';
import { assertCloudWorkspaceOwner } from '@/modules/workspace-runtime/index.js';
import { AppError } from '@/shared/index.js';

import { startCloneProject } from './project-clone.service.js';

type Snapshot = {
  jobId: string;
  status: 'running' | 'complete' | 'error' | 'cancelled';
  message: string;
  project?: Record<string, unknown>;
  code?: string;
  targetPath?: string;
};
type RecordEntry = { ownerId: string; requestId: string; snapshot: Snapshot };
type JobInput = Omit<Parameters<typeof startCloneProject>[0], 'signal'> & { requestId: string };
type Dependencies = {
  directory?: string;
  maxRecords?: number;
  startClone?: typeof startCloneProject;
  assertOwner?: (candidate: string, ownerId: string) => void;
};

// Constructed at server module initialization, outside HTTP AsyncLocalStorage scopes.
// Detached work must not inherit a poller's abort signal or workspace capability.
const executionScope = new AsyncResource('project-clone-jobs');
const MAX_MESSAGE = 4096;
const MAX_PROJECT_BYTES = 16_384;

function safeText(value: string, secret?: string | null): string {
  let result = value;
  if (secret) for (const form of [secret, encodeURIComponent(secret), Buffer.from(`x-access-token:${secret}`).toString('base64')]) result = result.split(form).join('[redacted]');
  return result.replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, '$1[redacted]@')
    .replace(/(authorization\s*[:=]\s*)(?:basic|bearer)\s+\S+/gi, '$1[redacted]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, MAX_MESSAGE);
}

function safeProject(project: Record<string, unknown>, secret?: string | null): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  // Persist only public project identity, never provider settings, credentials or unbounded metadata.
  for (const key of ['projectId', 'path', 'fullPath', 'displayName', 'customName']) {
    if (typeof project[key] === 'string') result[key] = safeText(project[key], secret);
    else if (project[key] === null) result[key] = null;
  }
  for (const key of ['isArchived', 'isStarred']) if (typeof project[key] === 'boolean') result[key] = project[key];
  if (JSON.stringify(result).length > MAX_PROJECT_BYTES) delete result.customName;
  return result;
}

function ownerIdentity(value: number | string): string {
  const owner = String(value);
  if (!/^\d+$/.test(owner) || !Number.isSafeInteger(Number(owner)) || Number(owner) <= 0) throw new AppError('Authenticated user is required', { code: 'AUTHENTICATION_REQUIRED', statusCode: 401 });
  return owner;
}

/** Projects job routes and lifecycle tests create an owner-scoped, durable clone execution registry. */
export function createProjectCloneJobsService(dependencies: Dependencies = {}) {
  const directory = dependencies.directory ?? path.join(os.homedir(), '.chisa-clone-jobs');
  const storagePath = path.join(directory, 'jobs.json');
  const maxRecords = Math.max(1, Math.min(1024, dependencies.maxRecords ?? 256));
  const startClone = dependencies.startClone ?? startCloneProject;
  const assertOwner = dependencies.assertOwner ?? ((candidate: string, ownerId: string) => assertCloudWorkspaceOwner(candidate, ownerId, userDb.getActiveUserIds()));
  const records = new Map<string, RecordEntry>();
  const executions = new Map<string, { cancellation: AbortController; operation?: Awaited<ReturnType<typeof startCloneProject>>; done: Promise<void> }>();
  let loaded = false;

  function persist(): void {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(directory, `${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, JSON.stringify({ version: 1, records: [...records.values()] }), { mode: 0o600, flag: 'wx' });
      renameSync(temporary, storagePath);
    } catch (error) {
      // Preserve the write/rename failure rather than replacing it with cleanup failure.
      try { unlinkSync(temporary); } catch { /* A leftover private temp file is harmless. */ }
      throw error;
    }
  }

  function load(): void {
    if (loaded) return;
    let saved: unknown;
    try {
      // Bound startup allocation even if the snapshot file is damaged or externally replaced.
      if (statSync(storagePath).size > 32 * 1024 * 1024) throw new Error('Clone job store exceeds its size limit');
      saved = JSON.parse(readFileSync(storagePath, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { loaded = true; return; }
      throw new AppError('Clone job history cannot be read. Restore the private clone job store before retrying.', { code: 'CLONE_JOB_STORE_UNAVAILABLE', statusCode: 503 });
    }
    const document = saved as { version?: number; records?: unknown[] };
    if (document?.version !== 1 || !Array.isArray(document.records) || document.records.length > maxRecords) throw new AppError('Clone job history is invalid', { code: 'CLONE_JOB_STORE_UNAVAILABLE', statusCode: 503 });
    for (const raw of document.records) {
      const entry = raw as RecordEntry;
      if (!entry || typeof entry.ownerId !== 'string' || !/^\d+$/.test(entry.ownerId) || typeof entry.requestId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(entry.requestId)
        || !entry.snapshot || !/^[a-zA-Z0-9-]{1,128}$/.test(entry.snapshot.jobId) || !['running', 'complete', 'error', 'cancelled'].includes(entry.snapshot.status) || typeof entry.snapshot.message !== 'string') {
        throw new AppError('Clone job history is invalid', { code: 'CLONE_JOB_STORE_UNAVAILABLE', statusCode: 503 });
      }
      const snapshot: Snapshot = { jobId: entry.snapshot.jobId, status: entry.snapshot.status, message: safeText(entry.snapshot.message) };
      if (typeof entry.snapshot.targetPath === 'string') snapshot.targetPath = safeText(entry.snapshot.targetPath);
      if (typeof entry.snapshot.code === 'string') snapshot.code = safeText(entry.snapshot.code);
      if (entry.snapshot.project && typeof entry.snapshot.project === 'object') snapshot.project = safeProject(entry.snapshot.project);
      if (snapshot.status === 'running') Object.assign(snapshot, { status: 'error', code: 'CLONE_INTERRUPTED', message: 'Clone interrupted by server restart. Inspect the target directory and register a completed clone, or remove a partial directory before starting a new request.' });
      records.set(snapshot.jobId, { ownerId: entry.ownerId, requestId: entry.requestId, snapshot });
    }
    // Persist restart recovery before serving observations; never resume a clone implicitly.
    persist();
    loaded = true;
  }

  function ownedRecord(jobId: string, userId: string | number): RecordEntry {
    const ownerId = ownerIdentity(userId);
    load();
    const record = records.get(jobId);
    if (!record || record.ownerId !== ownerId) throw new AppError('Clone job not found', { code: 'CLONE_JOB_NOT_FOUND', statusCode: 404 });
    return record;
  }

  function observe(record: RecordEntry): Snapshot {
    return structuredClone(record.snapshot);
  }

  let lastProgressWrite = 0;
  function update(record: RecordEntry, changes: Partial<Snapshot>): void {
    Object.assign(record.snapshot, changes);
    // Polls read live memory; coalesce Git's hundreds of CR progress lines.
    if (!changes.status && !changes.targetPath && Date.now() - lastProgressWrite < 1000) return;
    persist();
    lastProgressWrite = Date.now();
  }

  return {
    async create(input: JobInput): Promise<Snapshot> {
      const ownerId = ownerIdentity(input.userId);
      if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(input.requestId)) throw new AppError('requestId must be an opaque identifier of 1–128 letters, digits, dot, underscore, colon or dash', { code: 'INVALID_CLONE_REQUEST_ID', statusCode: 400 });
      load();
      const existing = [...records.values()].find(record => record.ownerId === ownerId && record.requestId === input.requestId);
      if (existing) return observe(existing);
      assertOwner(input.workspacePath, ownerId);
      // Do not evict request ids: eviction would silently turn a retry into a second clone.
      // An installation at capacity fails closed and retains its idempotency history.
      if (records.size >= maxRecords) throw new AppError('Clone job history is full. Archive the private job history during server maintenance before creating more jobs.', { code: 'CLONE_JOB_CAPACITY_REACHED', statusCode: 503 });
      const record: RecordEntry = { ownerId, requestId: input.requestId, snapshot: { jobId: randomUUID(), status: 'running', message: 'Preparing repository clone' } };
      records.set(record.snapshot.jobId, record);
      try { persist(); } catch (error) { records.delete(record.snapshot.jobId); throw error; }
      const execution = { cancellation: new AbortController(), done: Promise.resolve() } as { cancellation: AbortController; operation?: Awaited<ReturnType<typeof startCloneProject>>; done: Promise<void> };
      executions.set(record.snapshot.jobId, execution);
      // runInAsyncScope creates all subsequent promises outside the initiating request context.
      execution.done = executionScope.runInAsyncScope(async () => {
        const secret = input.newGithubToken?.trim();
        try {
          execution.operation = await startClone({ ...input, signal: execution.cancellation.signal }, {
            onTarget: targetPath => update(record, { targetPath: safeText(targetPath, secret) }),
            onProgress: message => {
              if (execution.cancellation.signal.aborted) return;
              try { update(record, { message: safeText(message, secret) }); }
              catch {
                // A stream callback must not throw into EventEmitter and crash the server.
                execution.cancellation.abort();
                execution.operation?.cancel();
              }
            },
            onComplete: ({ project, message }) => update(record, { status: 'complete', message: safeText(message, secret), project: safeProject(project, secret) }),
          });
          if (execution.cancellation.signal.aborted) execution.operation.cancel();
          await execution.operation.waitForCompletion;
          if (record.snapshot.status === 'running') update(record, execution.cancellation.signal.aborted ? { status: 'cancelled', message: 'Repository clone cancelled', code: 'CLONE_CANCELLED' } : { status: 'error', message: 'Clone ended without a registered project', code: 'CLONE_RESULT_MISSING' });
        } catch (error) {
          const registrationFailed = error instanceof AppError && error.code === 'CLONE_PROJECT_REGISTRATION_FAILED';
          const cancelled = !registrationFailed && (execution.cancellation.signal.aborted || (error instanceof AppError && error.code === 'CLONE_CANCELLED'));
          update(record, { status: cancelled ? 'cancelled' : 'error', message: cancelled ? 'Repository clone cancelled' : safeText(error instanceof Error ? error.message : 'Repository clone failed', secret), code: cancelled ? 'CLONE_CANCELLED' : error instanceof AppError ? safeText(error.code, secret) : 'GIT_CLONE_FAILED' });
        } finally { executions.delete(record.snapshot.jobId); }
      });
      // Persistence failures must not turn detached execution into an unhandled rejection.
      void execution.done.catch(() => { record.snapshot = { ...record.snapshot, status: 'error', code: 'CLONE_JOB_STORE_UNAVAILABLE', message: 'Clone job state could not be persisted. Inspect the target directory before retrying.' }; });
      return observe(record);
    },
    async cancelRequest(requestId: string, userId: string | number): Promise<Snapshot> {
      const ownerId = ownerIdentity(userId);
      if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(requestId)) throw new AppError('Invalid clone request id', { code: 'INVALID_CLONE_REQUEST_ID', statusCode: 400 });
      load();
      const existing = [...records.values()].find(record => record.ownerId === ownerId && record.requestId === requestId);
      if (existing) return this.cancel(existing.snapshot.jobId, userId);
      if (records.size >= maxRecords) throw new AppError('Clone job history is full', { code: 'CLONE_JOB_CAPACITY_REACHED', statusCode: 503 });
      // A durable tombstone also cancels a POST that arrives after its response was lost.
      const record: RecordEntry = { ownerId, requestId, snapshot: { jobId: randomUUID(), status: 'cancelled', code: 'CLONE_CANCELLED', message: 'Repository clone cancelled' } };
      records.set(record.snapshot.jobId, record);
      try { persist(); } catch (error) { records.delete(record.snapshot.jobId); throw error; }
      return observe(record);
    },
    get(jobId: string, userId: string | number): Snapshot { return observe(ownedRecord(jobId, userId)); },
    async cancel(jobId: string, userId: string | number): Promise<Snapshot> {
      const record = ownedRecord(jobId, userId);
      const execution = executions.get(jobId);
      if (record.snapshot.status === 'running' && execution) {
        execution.cancellation.abort();
        execution.operation?.cancel();
        // Do not publish terminal cancellation until Git has closed and owned cleanup has settled.
        await execution.done;
      }
      return observe(record);
    },
  };
}

/** The Projects HTTP job gateway shares this process registry across create, poll and cancel requests. */
export const projectCloneJobsService = createProjectCloneJobsService();
