import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';

import { AppError } from '@/shared/index.js';

import { createWorkspaceRuntimeService, getWorkspaceRuntimeIdentity } from './workspace-runtime.service.js';
import { getWorkspaceBrokerAdmission } from './workspace-runtime-broker.service.js';
import { createWorkspacePreviewInventory } from './workspace-runtime-preview-inventory.repository.js';

const grants = new Map<string, { userId: string; id: string; root: string; epoch: string; port: number; network: string; assertAuthActive: () => void; closeAuthority: () => Promise<void>; connections: Set<() => void> }>();
const previewTokens = new Map<string, string>();
const pendingRevocations = new Map<string,{ close: () => Promise<void>; running: boolean }>();
let sweepTimer: ReturnType<typeof setInterval> | undefined;
function scheduleSweep() {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => { void sweepWorkspaceRuntimePreviewAccess(); },1000);sweepTimer.unref();
}
function stopEmptySweep() { if (!grants.size && !pendingRevocations.size && sweepTimer) { clearInterval(sweepTimer);sweepTimer = undefined; } }
function retryRevocations() {
  for (const [id,pending] of pendingRevocations) {
    if (pending.running) continue;pending.running = true;
    void pending.close().then(() => { if (pendingRevocations.get(id) === pending) pendingRevocations.delete(id); },() => {}).finally(() => { pending.running = false;stopEmptySweep(); });
  }
}
/** Preview lifetime rechecks the captured server login proof, including retained
 * HTTP/WS streams. Database revocation, version changes and expiry revoke locally
 * first, then retry the exact independent signer close until it acknowledges. */
export async function sweepWorkspaceRuntimePreviewAccess() {
  for (const grant of [...grants.values()]) { try { grant.assertAuthActive(); } catch { revokeWorkspaceRuntimePreviewAccess(grant.id); } }
  retryRevocations();stopEmptySweep();
}

/** Preview start issues a process-local browser capability before broker dispatch. */
export function createWorkspaceRuntimePreviewAccess(userId: string, id: string, root: string, epoch: string, port: number, network: string,assertAuthActive: () => void,closeAuthority: (base: string) => Promise<void>) {
  if (typeof assertAuthActive !== 'function' || typeof closeAuthority !== 'function') throw new AppError('Preview requires a captured login session', { code: 'PREVIEW_AUTH_REQUIRED',statusCode: 403 });
  assertAuthActive();
  const token = randomBytes(32).toString('hex');
  grants.set(token, { userId, id, root, epoch, port, network,assertAuthActive,closeAuthority: () => closeAuthority('/api/workspace-runtime/preview/' + token + '/'), connections: new Set() });scheduleSweep();
  previewTokens.set(id, token);
  return '/api/workspace-runtime/preview/' + token + '/';
}

/** Preview status returns only the capability for its exact retained operation. */
export function getWorkspaceRuntimePreviewUrl(id: string) {
  const token = previewTokens.get(id);const grant = token ? grants.get(token) : undefined;
  if (!grant) return undefined;
  try { grant.assertAuthActive(); } catch { revokeWorkspaceRuntimePreviewAccess(id);return undefined; }
  return '/api/workspace-runtime/preview/' + token + '/';
}

/** Stop revokes HTTP/WS access before broker cleanup; retained connections close too. */
export function revokeWorkspaceRuntimePreviewAccess(id: string) {
  const token = previewTokens.get(id);
  if (!token) return;
  previewTokens.delete(id); const grant = grants.get(token); grants.delete(token);
  for (const close of grant?.connections ?? []) close();
  if (grant) { pendingRevocations.set(id,{close: grant.closeAuthority,running: false});scheduleSweep();retryRevocations(); }
  stopEmptySweep();
}

/** HTTP/WS proxy retains this revocable process-local browser capability. */
export function retainWorkspaceRuntimePreviewConnection(token: string, close: () => void) {
  const grant = grants.get(token);
  if (!grant) throw new AppError('Preview is no longer available', { code: 'PREVIEW_NOT_FOUND', statusCode: 404 });
  try { grant.assertAuthActive(); } catch { revokeWorkspaceRuntimePreviewAccess(grant.id);throw new AppError('Preview is no longer available', { code: 'PREVIEW_NOT_FOUND',statusCode: 404 }); }
  grant.connections.add(close);
  return () => { grant.connections.delete(close); };
}

/** HTTP/WS target lookup uses exact broker identity and independent owner/lease
 * proof; no Docker inspect or caller-selected upstream address remains in API. */
export async function resolveWorkspaceRuntimePreviewAccess(token: string) {
  const grant = /^[a-f0-9]{64}$/.test(token) ? grants.get(token) : undefined;
  const unavailable = () => new AppError('Preview is no longer available', { code: 'PREVIEW_NOT_FOUND', statusCode: 404 });
  if (!grant) throw unavailable();
  try { grant.assertAuthActive(); } catch { revokeWorkspaceRuntimePreviewAccess(grant.id);throw unavailable(); }
  const identity = getWorkspaceRuntimeIdentity(grant.root);
  if (!identity || identity.userId !== grant.userId || identity.network !== grant.network) throw unavailable();
  const restored = await createWorkspaceRuntimeService().restore(grant.userId);
  if (restored.root !== identity.root || restored.owner !== identity.owner || restored.network !== grant.network) throw unavailable();
  const entry = await (await createWorkspacePreviewInventory(grant.userId)).read(grant.id);
  if (!entry || entry.root !== grant.root || entry.bindingEpoch !== grant.epoch || entry.port !== grant.port) throw unavailable();
  const admission = await getWorkspaceBrokerAdmission({ userId: grant.userId,root: grant.root,leaseId: entry.legacyReservationId ?? entry.leaseId,brokerLeaseId: entry.legacyReservationId ? entry.leaseId : undefined,sessionId: entry.sessionId,bindingEpoch: entry.bindingEpoch });
  if (admission.workspaceId !== entry.workspaceId || admission.generation !== entry.generation) throw unavailable();
  const base = '/api/workspace-runtime/preview/' + token + '/';
  if (entry.base !== base || admission.leaseId !== entry.leaseId || admission.legacyReservationId !== entry.legacyReservationId) throw unavailable();
  const target = await admission.previewGateway(grant.id,base);
  try { grant.assertAuthActive(); } catch { revokeWorkspaceRuntimePreviewAccess(grant.id);throw unavailable(); }
  if ((entry.resourceId && target.resourceId !== entry.resourceId) || isIP(target.host) !== 4 || grants.get(token) !== grant) throw unavailable();
  return { host: target.host,port: target.port,ticket: target.ticket,base };
}
