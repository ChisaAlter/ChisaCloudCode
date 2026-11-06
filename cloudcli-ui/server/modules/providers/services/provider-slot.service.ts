import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import path from 'node:path';

import { readStoredAttachmentAsset } from '@/modules/assets/index.js';
import { getWorkspaceBrokerAdmission } from '@/modules/workspace-runtime/index.js';
import { AppError, getGlobalImageAssetsDir, normalizeAttachmentDescriptors } from '@/shared/index.js';
import type { LLMProvider, ProviderTrustedSlot } from '@/shared/index.js';

const fields = ['slotId','provider','userId','ownerId','sessionId','root','workspaceId','generation','leaseId','bindingEpoch','profileId'] as const;
const unavailable = () => new AppError('An independently enrolled provider slot is required', { code: 'WORKSPACE_PROVIDER_SLOT_UNAVAILABLE',statusCode: 503 });
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
type SlotCatalog = { version: 1; socketPath: string; slots: Array<Omit<ProviderTrustedSlot,'finish'|'assets'> & { ticket: string }> };
const operations = new WeakMap<ProviderTrustedSlot,{ operationId?: string }>();
function canonical(filename: string, writable = false) {
  if (!path.isAbsolute(filename) || path.resolve(filename) !== filename || realpathSync(filename) !== filename) throw unavailable();
  const metadata = lstatSync(filename);
  if (metadata.isSymbolicLink() || (!metadata.isDirectory() && (!metadata.isFile() || metadata.nlink !== 1))) throw unavailable();
  if (process.platform !== 'win32') {
    if (!writable && (metadata.uid !== 0 || (metadata.mode & 0o022) !== 0)) throw unavailable();
    for (let current = path.dirname(filename);; current = path.dirname(current)) {
      const stats = lstatSync(current); const sticky = stats.uid === 0 && (stats.mode & 0o1000) !== 0;
      if (stats.uid !== 0 || (!sticky && (stats.mode & 0o022) !== 0) || stats.isSymbolicLink() || !stats.isDirectory()) throw unavailable();
      if (path.dirname(current) === current) break;
    }
  }
  return metadata;
}
function catalog(): SlotCatalog {
  try {
    const filename = process.env.CHISA_PROVIDER_SLOT_CLIENT_CONFIG;
    if (!filename) throw unavailable(); canonical(filename);
    const descriptor = openSync(filename,constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = fstatSync(descriptor);
      if (!before.isFile() || before.nlink !== 1 || before.size > 1024 * 1024) throw unavailable();
      const value = JSON.parse(readFileSync(descriptor,'utf8')) as SlotCatalog;
      const after = fstatSync(descriptor); const named = lstatSync(filename);
      if (before.dev !== named.dev || before.ino !== named.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
        value.version !== 1 || typeof value.socketPath !== 'string' || !Array.isArray(value.slots) || value.slots.length > 1024) throw unavailable();
      return value;
    } finally { closeSync(descriptor); }
  } catch (error) { if (error instanceof AppError) throw error; throw unavailable(); }
}
function selectedSlot(provider: Exclude<LLMProvider,'claude'>, sessionId: string, selector?: { userId: string; root: string; leaseId: string; workspaceId: string; generation: string; bindingEpoch: string; slotId?: string }): { configuration: SlotCatalog; slot: SlotCatalog['slots'][number] } {
  const configuration = catalog();
  const matches = configuration.slots.filter(slot => slot.provider === provider && slot.sessionId === sessionId && (!selector || (selector.slotId ? slot.slotId === selector.slotId && ['userId','root','workspaceId','generation','bindingEpoch'].every(field => slot[field as keyof typeof selector] === selector[field as keyof typeof selector]) : ['userId','root','leaseId','workspaceId','generation','bindingEpoch'].every(field => slot[field as keyof typeof selector] === selector[field as keyof typeof selector]))));
  if (!matches.length || (selector && matches.length !== 1)) throw unavailable();
  if (!selector && matches.some(slot => ['home','ownerId','userId','root','workspaceId'].some(field => slot[field as 'home'] !== matches[0][field as 'home']))) throw unavailable();
  const slot = matches[0];
  if (!fields.filter(field => !['provider','root',...(selector?.slotId || slot.leaseId === '' ? ['leaseId'] : [])].includes(field)).every(field => identifier(slot[field])) || !/^[a-f0-9]{64,128}$/.test(slot.ticket) ||
    slot.command !== '/runtime/provider-code/node' || slot.args?.[0] !== '/runtime/provider-code/app/provider-process.worker.js' || slot.environment?.HOME !== '/runtime/provider-state/home' || !Array.isArray(slot.mounts)) throw unavailable();
  canonical(slot.root,true); canonical(slot.home,true);
  const targets = new Set<string>();
  for (const mount of slot.mounts) {
    if (!mount || typeof mount.writable !== 'boolean' || !path.posix.isAbsolute(mount.target) || path.posix.resolve(mount.target) !== mount.target || /[\0\r\n,]/.test(mount.source + mount.target) || targets.has(mount.target)) throw unavailable();
    targets.add(mount.target);canonical(mount.source,mount.writable);
  }
  if (!slot.mounts.some(mount => mount.source === slot.home && mount.target === slot.environment.HOME && mount.writable)) throw unavailable();
  return { configuration,slot };
}
async function call(socketPath: string,route: string,body: unknown,signal?: AbortSignal) {
  return new Promise<Record<string,unknown>>((resolve,reject) => {
    const data = Buffer.from(JSON.stringify(body)); if (data.length > 46 * 1024 * 1024) { reject(unavailable());return; }
    const request = httpRequest({ socketPath,method: 'POST',path: route,signal,headers: { 'Content-Type': 'application/json','Content-Length': data.length } },response => {
      const chunks: Buffer[] = []; let size = 0;
      response.on('data',(chunk: Buffer) => { size += chunk.length; if (size > 65536) response.destroy(unavailable()); else chunks.push(chunk); });
      response.once('error',() => reject(unavailable()));response.once('end',() => { try { if (response.statusCode !== 200) throw unavailable(); resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(unavailable()); } });
    });
    const timer = setTimeout(() => request.destroy(unavailable()),15000);timer.unref();request.once('error',reject);request.once('close',() => clearTimeout(timer));request.end(data);
  });
}

/** Provider-state selects only the root-owned configured slot HOME. Without slot
 * configuration native host history retains its existing deterministic HOME. */
export function resolveProviderSlotHome(provider: Exclude<LLMProvider,'claude'>,sessionId: string): string | undefined {
  if (!process.env.CHISA_PROVIDER_SLOT_CLIENT_CONFIG) return undefined;
  return selectedSlot(provider,sessionId).slot.home;
}

/** Container composition sends verified W02 byte snapshots to an independent
 * supervisor. Every source in the result is an exact operator profile selector;
 * neither this function nor its HTTP request can register a host source path. */
export async function prepareProviderSlot(input: { provider: Exclude<LLMProvider,'claude'>; sessionId: string; userId: string; root: string; attachments: unknown; signal?: AbortSignal; assertActive?: () => void }): Promise<ProviderTrustedSlot> {
  input.signal?.throwIfAborted();input.assertActive?.();
  if (!input.userId || !input.sessionId) throw unavailable();
  const admission = await getWorkspaceBrokerAdmission({ userId: input.userId,root: input.root,sessionId: input.sessionId });
  input.signal?.throwIfAborted();input.assertActive?.();
  const { configuration,slot } = selectedSlot(input.provider,input.sessionId,{ userId: input.userId,root: admission.root,workspaceId: admission.workspaceId,generation: admission.generation,leaseId: admission.leaseId,bindingEpoch: admission.bindingEpoch,slotId: admission.slotId });
  if (admission.sessionId !== input.sessionId || slot.profileId !== admission.profileId) throw unavailable();
  const assets: Array<{ originalPath: string; sha256: string; bytes: string }> = [];
  const assetRoot = path.resolve(getGlobalImageAssetsDir());
  const unique = normalizeAttachmentDescriptors(input.attachments).filter((item,index,all) => all.findIndex(other => other.path === item.path) === index);
  for (const item of unique) {
    input.signal?.throwIfAborted();input.assertActive?.();
    const originalPath = path.resolve(item.path);
    if (path.dirname(originalPath) !== assetRoot) throw unavailable();
    // Re-read through the public ownership/digest-verified store at the final
    // consumer boundary. The original mutable path is never a mount source.
    const verified = await readStoredAttachmentAsset(path.basename(originalPath),input.userId,'files');
    input.signal?.throwIfAborted();input.assertActive?.();
    assets.push({ originalPath,sha256: createHash('sha256').update(verified.bytes).digest('hex'),bytes: verified.bytes.toString('base64') });
  }
  const identity = { ...Object.fromEntries(fields.map(field => [field,slot[field]])),leaseId: admission.leaseId };
  const result = await call(configuration.socketPath,'/v1/prepare',{ ticket: slot.ticket,...identity,assets },input.signal);
  input.signal?.throwIfAborted();input.assertActive?.();
  if (result.version !== 1 || result.slotId !== slot.slotId || result.profileId !== slot.profileId || result.prepared !== true || !Array.isArray(result.assets) || result.assets.length !== assets.length) throw unavailable();
  const prepared = result.assets as ProviderTrustedSlot['assets'];
  for (const [index,asset] of prepared.entries()) if (asset.originalPath !== assets[index].originalPath || asset.sha256 !== assets[index].sha256 || asset.target !== `/runtime/provider-assets/attachment-${index}` || !slot.mounts.some(mount => mount.target === asset.target && !mount.writable)) throw unavailable();
  // Re-authorize after all yielding preparation; the issuer now sees the
  // independently published prepared witness and can grant only this profile.
  await admission.proof('run',slot.profileId);input.signal?.throwIfAborted();input.assertActive?.();
  const operation: { operationId?: string } = {};
  const preparedSlot: ProviderTrustedSlot = { ...slot,leaseId: admission.leaseId,assets: prepared,
    async finish(mode) {
      const result = await call(configuration.socketPath,'/v1/finish',{ ticket: slot.ticket,...identity,mode,operationId: operation.operationId });
      if (result.sealed !== true) throw unavailable();
    },
  };
  operations.set(preparedSlot,operation);
  return preparedSlot;
}

/** Container composition records only the operation returned by the admitted
 * launcher. The supervisor verifies its immutable broker receipt independently. */
export function bindProviderSlotOperation(slot: ProviderTrustedSlot,operationId: string | undefined): void {
  const operation = operations.get(slot);
  if (!operation || !identifier(operationId) || (operation.operationId !== undefined && operation.operationId !== operationId)) throw unavailable();
  operation.operationId = operationId;
}
