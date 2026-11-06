import { createHash, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import path from 'node:path';

import { recoverStoppedWorkspacePreview } from '@/modules/workspace-bridge/index.js';
import { AppError, WORKSPACES_ROOT, getWorkspaceSyncNetwork, type WorkspaceRuntimePreviewReservation } from '@/shared/index.js';

import { createWorkspaceRuntimeService, getWorkspaceRuntimeIdentity } from './workspace-runtime.service.js';
import { getWorkspaceBrokerAdmission } from './workspace-runtime-broker.service.js';
import { createWorkspaceRuntimePreviewAccess, getWorkspaceRuntimePreviewUrl, resolveWorkspaceRuntimePreviewAccess, revokeWorkspaceRuntimePreviewAccess } from './workspace-runtime-preview-access.service.js';
import { listWorkspaceRuntimePreviewWitnesses, persistWorkspaceRuntimePreviewWitness, readWorkspaceRuntimePreviewWitness, removeWorkspaceRuntimePreviewWitness } from './workspace-runtime-preview-witness.service.js';
import { createWorkspacePreviewInventory } from './workspace-runtime-preview-inventory.repository.js';

const activePreviews = new Map<string, { userId: string; reservation: WorkspaceRuntimePreviewReservation; startupFinished: boolean; finishPending: boolean; containerAbsent: boolean; cleanupConfirmed: boolean;
  output: { stdout: string; stderr: string }; drain?: Promise<void> }>();
const previewCleanups = new Map<string, Promise<void>>();
const privateAddress = (value: string) => isIP(value) === 4 && /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(value);
const cleanupFailed = () => new AppError('Preview cleanup has not been independently confirmed', { code: 'PREVIEW_CLEANUP_FAILED',statusCode: 503 });
const recoveryRequired = () => new AppError('Preview requires its exact private native recovery witness', { code: 'PREVIEW_RECOVERY_REQUIRED',statusCode: 503 });
type PreviewEntry = NonNullable<Awaited<ReturnType<Awaited<ReturnType<typeof createWorkspacePreviewInventory>>['read']>>>;
type PreviewWitness = NonNullable<Awaited<ReturnType<typeof readWorkspaceRuntimePreviewWitness>>>;
function matchRecoveryWitness(entry: PreviewEntry | undefined,witness: PreviewWitness) {
  if (entry && (entry.userId !== witness.userId || entry.accountRoot !== witness.accountRoot || entry.root !== witness.root || entry.previewId !== witness.previewId || entry.bindingEpoch !== witness.lease.epoch ||
    (entry.legacyReservationId ?? entry.leaseId) !== witness.lease.id || (entry.legacyReservationId !== undefined && entry.leaseId !== witness.lease.brokerLeaseId) ||
    (witness.lease.brokerLeaseId !== undefined && entry.leaseId !== witness.lease.brokerLeaseId) || (entry.sessionId !== undefined && entry.sessionId !== witness.lease.brokerSessionId) ||
    (witness.lease.brokerSessionId !== undefined && entry.sessionId !== witness.lease.brokerSessionId) || entry.profileId !== witness.lease.brokerPreviewProfileId)) throw recoveryRequired();
}

/** Preview lifecycle uses signed semantic broker calls and keeps legacy reservations
 * until exact daemon cleanup; operation inventory replaces API Docker ps/inspect. */
export function createWorkspaceRuntimePreviewService() {
  const owned = async (userId: string,id: string) => {
    const inventory = await createWorkspacePreviewInventory(userId);
    const entry = await inventory.read(id);
    if (!entry) throw new AppError('Preview is unavailable', { code: 'PREVIEW_NOT_FOUND',statusCode: 404 });
    const admission = await getWorkspaceBrokerAdmission({ userId,root: entry.root,leaseId: entry.legacyReservationId ?? entry.leaseId,brokerLeaseId: entry.legacyReservationId ? entry.leaseId : undefined,sessionId: entry.sessionId,bindingEpoch: entry.bindingEpoch });
    if (admission.workspaceId !== entry.workspaceId || admission.generation !== entry.generation) throw cleanupFailed();
    return { inventory,entry,admission };
  };
  const discard = async (userId: string,id: string) => {
    const key = userId + '\0' + id;
    const current = previewCleanups.get(key); if (current) return current;
    const cleanup = (async () => {
      const active = activePreviews.get(id); revokeWorkspaceRuntimePreviewAccess(id);
      if (active && active.userId !== userId) throw recoveryRequired();
      if (!active) {
        const witness = await readWorkspaceRuntimePreviewWitness(userId,id);
        if (!witness) throw recoveryRequired();
        const inventory = await createWorkspacePreviewInventory(userId);const entry = await inventory.read(id);
        matchRecoveryWitness(entry,witness);
        // A restarted API cannot authenticate as the admitted old peer. The
        // native helper reads root stop evidence and closes the exact authority
        // mapping under both original guards; no lookup/cancel/close is assumed.
        await recoverStoppedWorkspacePreview({ userId,accountRoot: witness.accountRoot,root: witness.root,previewId: id });
        // Keep the native witness last so an interrupted inventory deletion can
        // retry through the same independently verified already-closed mapping.
        await inventory.remove(id);await removeWorkspaceRuntimePreviewWitness(userId,id,witness.root);
        return;
      }
      const { inventory,entry,admission } = await owned(userId,id);
      if (entry.base) await admission.closePreviewGateway(id,entry.base);
      try {
        const result = await admission.client.cancel(await admission.proof('cancel',entry.profileId),id);
        if (result.operationId !== id || result.workspaceId !== entry.workspaceId || result.generation !== entry.generation || result.leaseId !== entry.leaseId || !result.cleanupConfirmed) throw cleanupFailed();
      } catch (error) {
        if (active?.userId === userId) await active.reservation.release(id,false);
        throw error;
      }
      active.containerAbsent = true;
      await active.reservation.release(id,true); active.cleanupConfirmed = true;
      if (active.startupFinished) {
        if (active.finishPending) { await active.reservation.finish(true); active.finishPending = false; }
        await removeWorkspaceRuntimePreviewWitness(userId,id,entry.root); await inventory.remove(id);
        if (activePreviews.get(id) === active) activePreviews.delete(id);
      }
    })();
    previewCleanups.set(key,cleanup);
    try { await cleanup; } finally { if (previewCleanups.get(key) === cleanup) previewCleanups.delete(key); }
  };
  return {
    discard,
    async start(userId: string,bindingEpoch: string,command: string,cwd: string,port: number,reservation: WorkspaceRuntimePreviewReservation,signal?: AbortSignal) {
      const root = reservation.root;
      const owner = createHash('sha256').update(path.resolve(WORKSPACES_ROOT) + '\0' + userId).digest('hex').slice(0,20);
      const id = 'chisa-account-preview-' + owner + '-' + randomBytes(8).toString('hex');
      let requested = false;
      let preparedInventory: Awaited<ReturnType<typeof createWorkspacePreviewInventory>> | undefined;
      const finishStartup = async (confirmed = true) => {
        const active = activePreviews.get(id);
        try { await reservation.finish(confirmed,confirmed ? undefined : id); }
        finally { if (active?.reservation === reservation) active.startupFinished = true; }
        if (active?.reservation === reservation) {
          active.finishPending = false;
          if (active.cleanupConfirmed) {
            await removeWorkspaceRuntimePreviewWitness(userId,id,root); await (await createWorkspacePreviewInventory(userId)).remove(id);
            if (activePreviews.get(id) === active) activePreviews.delete(id);
          }
        }
      };
      try {
        if (typeof reservation.assertAuthActive !== 'function') throw new AppError('Preview requires a captured login session', { code: 'PREVIEW_AUTH_REQUIRED',statusCode: 403 });
        reservation.assertAuthActive();
        const network = getWorkspaceSyncNetwork(root);
        if (!network) throw new AppError('Workspace runtime network is unavailable', { code: 'WORKSPACE_SYNC_UNAVAILABLE',statusCode: 503 });
        const broker = reservation.broker;
        if (!broker) throw new AppError('An independent preview reservation is required', { code: 'PREVIEW_RECOVERY_REQUIRED',statusCode: 503 });
        const admission = await getWorkspaceBrokerAdmission({ userId,root,leaseId: broker.legacyReservationId,brokerLeaseId: broker.leaseId,sessionId: broker.sessionId,bindingEpoch });
        const profileId = admission.previewProfileId;
        if (!profileId || profileId !== broker.profileId || admission.leaseId !== broker.leaseId || admission.legacyReservationId !== broker.legacyReservationId || admission.sessionId !== broker.sessionId) throw new AppError('An independently enrolled preview profile is required', { code: 'PREVIEW_PROFILE_REQUIRED',statusCode: 503 });
        const inventory = await createWorkspacePreviewInventory(userId);preparedInventory = inventory;
        signal?.throwIfAborted();
        await persistWorkspaceRuntimePreviewWitness(userId,id,reservation);
        const url = createWorkspaceRuntimePreviewAccess(userId,id,root,bindingEpoch,port,network,reservation.assertAuthActive,base => admission.closePreviewGateway(id,base));
        await inventory.put({ version: 1,userId,accountRoot: admission.accountRoot,root,previewId: id,bindingEpoch,port,base: url,
          workspaceId: admission.workspaceId,generation: admission.generation,leaseId: admission.leaseId,legacyReservationId: admission.legacyReservationId,sessionId: admission.sessionId,profileId });
        const runProof = await admission.proof('run',profileId);
        reservation.assertAuthActive();signal?.throwIfAborted();
        reservation.retain(id,() => discard(userId,id));
        const active = { userId,reservation,startupFinished: false,finishPending: true,containerAbsent: false,cleanupConfirmed: false,output: { stdout: '',stderr: '' } };
        activePreviews.set(id,active);requested = true;
        const result = await admission.client.run(runProof,{ operationId: id,workspaceId: admission.workspaceId,generation: admission.generation,leaseId: admission.leaseId,
          profileId,command: ['bash','-c',command],cwd: cwd === '/workspace' ? '' : cwd.slice('/workspace/'.length),environment: { CHISA_PREVIEW_BASE: url },previewPort: port },{ signal });
        reservation.assertAuthActive();signal?.throwIfAborted();
        if (result.state !== 'running' || result.cleanupConfirmed || result.operationId !== id || result.leaseId !== admission.leaseId) throw cleanupFailed();
        const target = await resolveWorkspaceRuntimePreviewAccess(url.split('/').at(-2)!);
        if (!privateAddress(target.host) || !Number.isInteger(target.port)) throw new Error('Invalid preview gateway');
        const stream = await admission.client.stream(await admission.proof('stream',profileId),id);
        const lifetime = activePreviews.get(id)!;
        lifetime.drain = (async () => {
          try { for await (const frame of stream) { const key = frame.channel; lifetime.output[key] = (lifetime.output[key] + frame.data.toString('utf8')).slice(-65536); } }
          catch { /* Broker status/cancel, never stream loss, decides cleanup. */ }
          finally { revokeWorkspaceRuntimePreviewAccess(id); }
        })();
        signal?.throwIfAborted();
        let delivery: Promise<void> | undefined;
        const finishDelivery = async (accepted: boolean): Promise<void> => {
          if (!accepted) { await discard(userId,id); if (!activePreviews.get(id)?.startupFinished) await finishStartup(); return; }
          delivery ??= finishStartup();
          await delivery;
        };
        return { id,remoteHost: target.host,remotePort: target.port,url,finishDelivery };
      } catch (error) {
        try {
          if (requested) await discard(userId,id);
          else { revokeWorkspaceRuntimePreviewAccess(id);await preparedInventory?.remove(id);await removeWorkspaceRuntimePreviewWitness(userId,id,root); }
        }
        catch (cleanupError) { await finishStartup(activePreviews.get(id)?.containerAbsent === true); throw Object.assign(cleanupFailed(),{ cause: error,cleanupError }); }
        await finishStartup(); throw error;
      }
    },
    async list(userId: string) {
      const inventory = await createWorkspacePreviewInventory(userId);
      const witnesses = new Map((await listWorkspaceRuntimePreviewWitnesses(userId)).map(witness => [witness.previewId,witness]));
      const previews = [];
      for (const entry of await inventory.list()) {
        const active = activePreviews.get(entry.previewId);
        if (active && active.userId !== userId) throw recoveryRequired();
        if (!active) {
          const witness = witnesses.get(entry.previewId);if (!witness) throw recoveryRequired();matchRecoveryWitness(entry,witness);
          previews.push({ id: entry.previewId,serverPath: entry.root,bindingEpoch: entry.bindingEpoch,remoteHost: '',remotePort: 0,recoveryRequired: true,status: 'recovery-required' as const });continue;
        }
        const { admission } = await owned(userId,entry.previewId);
        const status = await admission.client.status(await admission.proof('status',entry.profileId),entry.previewId);
        let host = '';let port = 0;
        const base = getWorkspaceRuntimePreviewUrl(entry.previewId);
        if (status.state === 'running' && base) { const token = base.split('/').at(-2)!;const target = await resolveWorkspaceRuntimePreviewAccess(token);if (privateAddress(target.host)) { host = target.host;port = target.port; } }
        previews.push({ id: entry.previewId,serverPath: entry.root,bindingEpoch: entry.bindingEpoch,remoteHost: host,remotePort: port });
      }
      for (const witness of witnesses.values()) if (!previews.some(entry => entry.id === witness.previewId)) previews.push({ id: witness.previewId,serverPath: witness.root,bindingEpoch: witness.lease.epoch,remoteHost: '',remotePort: 0,recoveryRequired: true,status: 'recovery-required' as const });
      return { previews };
    },
    async inspect(userId: string,id: string) {
      const { entry,admission } = await owned(userId,id);
      const status = await admission.client.status(await admission.proof('status',entry.profileId),id);
      return { Running: status.state === 'running',ExitCode: status.exitCode,cleanupConfirmed: status.cleanupConfirmed };
    },
    async logs(userId: string,id: string) {
      const active = activePreviews.get(id);
      if (active?.userId === userId) return { ...active.output };
      const { entry,admission } = await owned(userId,id);
      const status = await admission.client.status(await admission.proof('status',entry.profileId),id);
      if (status.cleanupConfirmed) return { stdout: '',stderr: '' };
      const result = await admission.client.logs(await admission.proof('logs',entry.profileId),id);
      let offset = 0; let stdout = ''; let stderr = '';
      while (offset+8 <= result.multiplexed.length) {
        const channel = result.multiplexed[offset]; const bytes = result.multiplexed.readUInt32BE(offset+4);
        if (![1,2].includes(channel) || offset+8+bytes > result.multiplexed.length || bytes > 1024*1024) throw cleanupFailed();
        const text = result.multiplexed.subarray(offset+8,offset+8+bytes).toString('utf8'); if (channel === 1) stdout += text; else stderr += text;
        offset += 8+bytes;
      }
      if (offset !== result.multiplexed.length) throw cleanupFailed();
      return { stdout: stdout.slice(-65536),stderr: stderr.slice(-65536) };
    },
    async remove(userId: string,id: string) { await discard(userId,id); return { ok: true }; },
  };
}

/** Bridge preview RPCs use the verified account and existing exact startup reservation. */
export async function executeWorkspaceRuntimePreview(root: string,bindingEpoch: string,request: Record<string,unknown>,reservation?: WorkspaceRuntimePreviewReservation,signal?: AbortSignal) {
  const identity = getWorkspaceRuntimeIdentity(root); const service = createWorkspaceRuntimePreviewService();
  if (request.op === 'preview_start') {
    const cwd = request.path === undefined ? '/workspace' : request.path;
    try {
      if (!identity || path.resolve(root) === identity.root) throw new AppError('Workspace runtime is unavailable', { code: 'WORKSPACE_RUNTIME_UNAVAILABLE',statusCode: 503 });
      if (!reservation || reservation.root !== root || typeof request.command !== 'string' || !request.command.trim() || request.command.length > 64000 || typeof cwd !== 'string' ||
        (cwd !== '/workspace' && !cwd.startsWith('/workspace/')) || cwd.includes('\0') || cwd.split('/').includes('..') || !Number.isInteger(request.port) || Number(request.port) < 1024 || Number(request.port) > 65535) throw new AppError('Invalid preview request', { code: 'INVALID_REQUEST',statusCode: 400 });
      signal?.throwIfAborted(); await createWorkspaceRuntimeService().restore(identity.userId); signal?.throwIfAborted();
    } catch (error) { await reservation?.finish(true); throw error; }
    const started = await service.start(identity!.userId,bindingEpoch,request.command as string,cwd as string,Number(request.port),reservation!,signal);
    try { signal?.throwIfAborted(); await started.finishDelivery(true); return { ok: true,previewId: started.id,status: 'starting',url: started.url,basePath: started.url }; }
    catch (error) { await started.finishDelivery(false); throw error; }
  }
  if (!identity || path.resolve(root) === identity.root) throw new AppError('Workspace runtime is unavailable', { code: 'WORKSPACE_RUNTIME_UNAVAILABLE',statusCode: 503 });
  if (!['preview_stop','preview_status'].includes(String(request.op)) || typeof request.previewId !== 'string') throw new AppError('Invalid preview request', { code: 'INVALID_REQUEST',statusCode: 400 });
  const preview = (await service.list(identity.userId)).previews.find(item => item.id === request.previewId && item.serverPath === root && item.bindingEpoch === bindingEpoch);
  if (!preview) throw new AppError('Preview is unavailable', { code: 'PREVIEW_NOT_FOUND',statusCode: 404 });
  if (request.op === 'preview_stop') { await service.remove(identity.userId,preview.id); return { ok: true,status: 'stopped' }; }
  if (preview.recoveryRequired) return { ok: true,running: false,ready: false,status: 'recovery-required',recoveryRequired: true,stdout: '',stderr: '' };
  const state = await service.inspect(identity.userId,preview.id); const logs = await service.logs(identity.userId,preview.id); const url = getWorkspaceRuntimePreviewUrl(preview.id);
  let ready = false;
  if (state.Running && url && preview.remoteHost && preview.remotePort >= 1024) {
    try { const target = await resolveWorkspaceRuntimePreviewAccess(url.split('/').at(-2)!);const response = await fetch('http://' + target.host + ':' + target.port + url,{ headers: { 'X-Chisa-Preview-Ticket': target.ticket },redirect: 'manual',signal: signal ? AbortSignal.any([signal,AbortSignal.timeout(2000)]) : AbortSignal.timeout(2000) }); ready = response.status >= 200 && response.status < 400; await response.body?.cancel(); }
    catch (error) { if (signal?.aborted) throw error; }
  }
  return { ok: true,running: state.Running,ready,exitCode: state.ExitCode,url:getWorkspaceRuntimePreviewUrl(preview.id),...logs };
}
