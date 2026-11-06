import { once } from 'node:events';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';

import { getWorkspaceBrokerAdmission } from '@/modules/workspace-runtime/index.js';
import { AppError } from '@/shared/index.js';

import { selectWorkspaceBrokerProfile } from './workspace-broker-profile.service.js';

function cleanupError(cause?: unknown) {
  return Object.assign(new AppError('Workspace broker did not confirm exact sandbox cleanup; retain its writer reservation', {
    code: 'WORKSPACE_CLEANUP_FAILED', statusCode: 503,
  }), { cause, workspaceCleanupError: true });
}

/** The admitted bridge/provider/shell and JSON worker use this semantic launcher.
 * Every mount is selected from operator policy; stdin acknowledgements and output
 * iteration preserve backpressure. A lost run/stream reply is never relaunched. */
export async function spawnWorkspaceProcess(input: {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  runtimeMounts?: Array<{ source: string; target: string; writable: boolean }>;
  signal?: AbortSignal;
}, workspace: {
  root: string;
  readOnly: boolean;
  name: string;
  userId: string;
  leaseId?: string;
  brokerLeaseId?: string;
  bindingEpoch: string;
  sessionId?: string;
  purpose: 'provider' | 'shell' | 'worker';
  gitMounts: string[];
  assertActive?(): void;
  record(pending: boolean): void;
  publish?(): Promise<void>;
  notStarted?(): void;
}) {
  const assertActive = () => { input.signal?.throwIfAborted(); workspace.assertActive?.(); };
  assertActive();
  const cwd = realpathSync(input.cwd ?? workspace.root);
  if (cwd !== workspace.root && !cwd.startsWith(workspace.root + path.sep)) throw new AppError('Provider working directory must stay inside its admitted workspace', { code: 'WORKSPACE_PATH_INVALID', statusCode: 400 });
  if (!input.command || /[\0\r\n]/.test(input.command) || !Array.isArray(input.args) || input.args.some(value => typeof value !== 'string' || value.includes('\0'))) throw new AppError('Invalid admitted process command', { code: 'INVALID_REQUEST', statusCode: 400 });
  const environment = { ...input.env };
  if (Object.entries(environment).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes('\0'))) throw new AppError('Invalid admitted process environment', { code: 'INVALID_REQUEST', statusCode: 400 });
  let admission: Awaited<ReturnType<typeof getWorkspaceBrokerAdmission>>;
  let profile: ReturnType<typeof selectWorkspaceBrokerProfile>;
  try {
    admission = await getWorkspaceBrokerAdmission({ userId: workspace.userId, root: workspace.root, leaseId: workspace.leaseId, brokerLeaseId: workspace.brokerLeaseId, bindingEpoch: workspace.bindingEpoch, sessionId: workspace.sessionId });
    assertActive();
    if (admission.root !== workspace.root || admission.bindingEpoch !== workspace.bindingEpoch
      || (workspace.leaseId !== undefined && admission.legacyReservationId !== workspace.leaseId)
      || (workspace.brokerLeaseId !== undefined && admission.leaseId !== workspace.brokerLeaseId)
      || (workspace.sessionId !== undefined && admission.sessionId !== workspace.sessionId)) throw cleanupError();
    profile = selectWorkspaceBrokerProfile(admission,{ purpose: workspace.purpose, readOnly: workspace.readOnly, runtimeMounts: input.runtimeMounts, gitMounts: workspace.gitMounts, environment });
  } catch (error) { workspace.notStarted?.(); throw error; }
  const { client } = admission;
  const proof = (permission: string) => admission.proof(permission,profile.profileId);
  const activeProof = async (permission: string) => { assertActive(); const value = await proof(permission); assertActive(); return value; };
  let resourceId: string | undefined;
  const exact = (receipt: Awaited<ReturnType<typeof client.status>>) => {
    if (!receipt || receipt.operationId !== workspace.name || receipt.workspaceId !== admission.workspaceId || receipt.generation !== admission.generation || receipt.leaseId !== admission.leaseId || receipt.profileId !== profile.profileId || receipt.kind !== 'run'
      || (resourceId !== undefined && receipt.resourceId !== resourceId) || (receipt.resourceId !== undefined && !/^[a-f0-9]{64}$/.test(receipt.resourceId))) throw cleanupError();
    resourceId ??= receipt.resourceId;
    return receipt;
  };
  let cleanup: Promise<Awaited<ReturnType<typeof client.status>>> | undefined;
  const remove = () => cleanup ??= (async () => {
    let receipt: Awaited<ReturnType<typeof client.status>>;
    try {
      // Revocation must not prevent the independently scoped stop/reconcile path.
      try { receipt = exact(await client.cancel(await proof('cancel'),workspace.name)); }
      catch { receipt = exact(await client.reconcile(await proof('reconcile'),workspace.name)); }
      if (!receipt.cleanupConfirmed || receipt.state !== 'complete' || !resourceId) throw cleanupError();
      await workspace.publish?.();
      workspace.record(false);
      return receipt;
    } catch (error) { throw cleanupError(error); }
  })();
  assertActive();
  workspace.record(true);
  let started: Awaited<ReturnType<typeof client.run>>;
  try {
    const runProof = await activeProof('run');
    assertActive();
    started = exact(await client.run(runProof,{ operationId: workspace.name, workspaceId: admission.workspaceId, generation: admission.generation,
      leaseId: admission.leaseId, profileId: profile.profileId, command: [input.command,...input.args], cwd: path.relative(workspace.root,cwd).split(path.sep).join('/'), environment: profile.environment },{ signal: input.signal }));
    assertActive();
    if (started.state !== 'running' || started.cleanupConfirmed || !resourceId) throw new AppError('Workspace broker could not start the admitted process', { code: 'WORKSPACE_UNAVAILABLE', statusCode: 503 });
  } catch (error) {
    try { await remove(); } catch (failure) { throw Object.assign(cleanupError({ operation: error, cleanup: failure }),{ operationId: workspace.name }); }
    if (error && typeof error==='object') Object.assign(error,{ operationId: workspace.name });
    throw error;
  }
  const cancellation = new AbortController();
  const signal = input.signal ? AbortSignal.any([input.signal,cancellation.signal]) : cancellation.signal;
  const stdout = new PassThrough({ highWaterMark: 64 * 1024 });
  const stderr = new PassThrough({ highWaterMark: 64 * 1024 });
  let processFailure: unknown;
  let sequence = 0;
  let stdinEnded = false;
  const send = async (data: Buffer, end = false) => {
    signal.throwIfAborted(); assertActive();
    if (stdinEnded) throw new AppError('Admitted process stdin is closed', { code: 'WORKSPACE_STDIN_CLOSED', statusCode: 409 });
    for (let offset = 0; offset < data.length || (end && offset === data.length); offset += 64 * 1024) {
      const bytes = data.subarray(offset,Math.min(offset + 64 * 1024,data.length));
      const ending = end && offset + bytes.length >= data.length;
      const stdinProof = await activeProof('stdin');
      signal.throwIfAborted(); assertActive();
      const acknowledged = await client.writeStdin(stdinProof,workspace.name,{ sequence: ++sequence, data: bytes, ...(ending ? { end: true } : {}) });
      signal.throwIfAborted(); assertActive();
      if (acknowledged.sequence !== sequence) throw new AppError('Workspace stdin acknowledgement changed', { code: 'WORKSPACE_STDIN_UNCONFIRMED', statusCode: 503 });
      if (ending) { stdinEnded = true; break; }
      if (bytes.length === 0) break;
    }
  };
  const stdin = new Writable({ highWaterMark: 64 * 1024,
    write(chunk: Buffer | string, encoding, callback) { void send(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk,encoding)).then(() => callback(),callback); },
    final(callback) { void send(Buffer.alloc(0),true).then(() => callback(),callback); },
  });
  const fail = (error: unknown) => { processFailure ??= error; cancellation.abort(error); };
  stdin.on('error',fail);
  stdout.on('error',fail); stderr.on('error',fail);
  const completion: Promise<{ code: number | null; signal: NodeJS.Signals | null }> = (async () => {
    let terminal: Awaited<ReturnType<typeof client.status>> | undefined;
    try {
      signal.throwIfAborted();
      const streamProof = await activeProof('stream');
      signal.throwIfAborted(); assertActive();
      const output = await client.stream(streamProof,workspace.name,{ signal });
      try {
        assertActive();
        for (;;) {
          signal.throwIfAborted(); assertActive();
          const next = await output.next();
          signal.throwIfAborted(); assertActive();
          if (next.done) { if (next.value) terminal = exact(next.value); break; }
          const destination = next.value.channel === 'stdout' ? stdout : stderr;
          if (!destination.write(next.value.data)) { await once(destination,'drain',{ signal }); signal.throwIfAborted(); assertActive(); }
        }
      } finally { await output.return(); }
      if (!terminal) {
        const statusProof = await activeProof('status');
        signal.throwIfAborted(); assertActive();
        terminal = exact(await client.status(statusProof,workspace.name));
        assertActive();
      }
    } catch (error) {
      if (!cancellation.signal.aborted || input.signal?.aborted || processFailure) processFailure ??= error;
    } finally { stdout.end(); stderr.end(); }
    const removed = await remove();
    stdin.destroy();
    if (input.signal?.aborted) input.signal.throwIfAborted();
    if (processFailure) throw processFailure;
    return { code: terminal?.exitCode ?? removed.exitCode ?? null, signal: cancellation.signal.aborted ? 'SIGTERM' as const : null };
  })();
  void completion.catch(() => {});
  const operation: { operationId?: string } = { operationId: workspace.name };
  return { stdin, stdout, stderr, completion,...operation,
    async close() { cancellation.abort(); await completion; },
  };
}
