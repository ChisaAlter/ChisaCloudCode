import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import path from 'node:path';

import { createWorkspaceBrokerClient } from '@/modules/workspace-broker/index.js';
import { AppError,type WorkspaceBrokerLeaseReceipt } from '@/shared/index.js';

type ClientCatalog = {
  version: 1; brokerSocketPath: string; issuerSocketPath?: string; authoritySocketPath?: string;
  accounts: Array<{ userId: string; accountRoot: string; maintenanceWorkspaceId: string;
    workspaces: Array<{ root: string; workspaceId: string; generation: string; profileId: string; previewProfileId?: string; ticket: string }> }>;
};
const unavailable = () => new AppError('Independent workspace authority is unavailable', { code: 'WORKSPACE_BROKER_UNAVAILABLE', statusCode: 503 });
const denied = () => new AppError('Workspace authority does not match the requested identity', { code: 'WORKSPACE_FORBIDDEN', statusCode: 403 });

async function protectedAuthorityPath(filename: string,kind: 'file' | 'socket') {
  if (process.platform === 'win32') return;
  if (!path.isAbsolute(filename) || path.resolve(filename) !== filename || await realpath(filename) !== filename) throw unavailable();
  const leaf = await lstat(filename);
  if (leaf.isSymbolicLink() || leaf.uid !== 0 || (kind === 'file' ? !leaf.isFile() || leaf.nlink !== 1 || (leaf.mode & 0o022) !== 0 : !leaf.isSocket())) throw unavailable();
  for (let current = path.dirname(filename);;current = path.dirname(current)) {
    const metadata = await lstat(current);const sticky = metadata.uid === 0 && (metadata.mode & 0o1000) !== 0;
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== 0 || ((metadata.mode & 0o022) !== 0 && !sticky)) throw unavailable();
    if (path.dirname(current) === current) break;
  }
}

async function catalog() {
  const filename = process.env.CHISA_WORKSPACE_BROKER_CLIENT_CONFIG;
  if (!filename || !path.isAbsolute(filename) || path.resolve(filename) !== filename || await realpath(filename) !== filename) throw unavailable();
  await protectedAuthorityPath(filename,'file');
  const handle = await open(filename,constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > 1024 * 1024 || (process.platform !== 'win32' && (metadata.mode & 0o022) !== 0)) throw unavailable();
    const value = JSON.parse(await handle.readFile('utf8')) as ClientCatalog;
    const after = await handle.stat();const named = await lstat(filename);
    if (after.size !== metadata.size || after.mtimeMs !== metadata.mtimeMs || after.ctimeMs !== metadata.ctimeMs || named.dev !== metadata.dev || named.ino !== metadata.ino || value.version !== 1 || !Array.isArray(value.accounts) || typeof value.brokerSocketPath !== 'string' || (typeof value.issuerSocketPath !== 'string' && typeof value.authoritySocketPath !== 'string')) throw unavailable();
    return value;
  } catch (error) { if (error instanceof AppError) throw error; throw unavailable(); }
  finally { await handle.close(); }
}
async function requestGrant(socketPath: string, body: Record<string,unknown>) {
  await protectedAuthorityPath(socketPath,'socket');
  return new Promise<{ proof: string; expiresAt: number; workspaceId: string; generation: string; leaseId: string; sessionId: string; bindingEpoch: string; profileId: string }>((resolve,reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const request = httpRequest({ socketPath,method: 'POST',path: '/v1/grant',headers: { 'Content-Type': 'application/json','Content-Length': data.length } },response => {
      const chunks: Buffer[] = []; let bytes = 0;
      response.on('data',(chunk: Buffer) => { bytes += chunk.length; if (bytes > 16384) response.destroy(unavailable()); else chunks.push(chunk); });
      response.once('error',() => reject(unavailable()));
      response.once('end',() => {
        if (response.statusCode !== 200) { reject(denied()); return; }
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (typeof value.proof !== 'string' || value.proof.length > 8192 || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now() || value.expiresAt > Date.now()+300000) throw unavailable();
          resolve(value);
        } catch { reject(unavailable()); }
      });
    });
    const timer = setTimeout(() => request.destroy(unavailable()),5000); timer.unref();
    request.once('error',() => reject(unavailable())); request.once('close',() => clearTimeout(timer)); request.end(data);
  });
}

async function requestAuthority<T = { ownerId: string; leaseId: string; legacyReservationId: string; slotId?: string; profileId: string; workspaceId: string; generation: string; sessionId: string; bindingEpoch: string; proof?: string; expiresAt?: number; state?: string }>(socketPath: string,route: string,body: Record<string,unknown>) {
  await protectedAuthorityPath(socketPath,'socket');
  return new Promise<T>((resolve,reject) => {
    const bytes = Buffer.from(JSON.stringify(body));
    if (bytes.length > 16384) { reject(unavailable());return; }
    const request = httpRequest({ socketPath,method: 'POST',path: route,headers: { 'Content-Type': 'application/json','Content-Length': bytes.length } },response => {
      const chunks: Buffer[] = []; let length = 0;
      response.on('data',(chunk: Buffer) => { length += chunk.length; if (length > 1024 * 1024) response.destroy(unavailable()); else chunks.push(chunk); });
      response.once('error',reject);response.once('end',() => { try { if (response.statusCode !== 200) throw denied();resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (error) { reject(error); } });
    });
    const timer = setTimeout(() => request.destroy(unavailable()),25000);timer.unref();request.once('error',reject);request.once('close',() => clearTimeout(timer));request.end(bytes);
  });
}

/** Workspace-bridge/providers and runtime use this independently granted admission.
 * User/root/lease are selectors only: the issuer checks its private enrollment and
 * trusted supervisor witness. The API has no signing key or registration endpoint. */
export async function getWorkspaceBrokerAdmission(input: { userId: string; root: string; leaseId?: string; bindingEpoch?: string; sessionId?: string; brokerLeaseId?: string }) {
  if (!input.userId || !path.isAbsolute(input.root) || path.resolve(input.root) !== input.root || await realpath(input.root) !== input.root) throw denied();
  const configuration = await catalog();
  const accounts = configuration.accounts.filter(entry => entry.userId === input.userId && (entry.accountRoot === input.root || entry.workspaces.some(workspace => workspace.root === input.root)));
  if (accounts.length !== 1) throw denied();
  const account = accounts[0];
  if (!account || await realpath(account.accountRoot) !== account.accountRoot) throw denied();
  const candidates = input.root === account.accountRoot ? account.workspaces.filter(entry => entry.workspaceId === account.maintenanceWorkspaceId) : account.workspaces.filter(entry => entry.root === input.root);
  if (candidates.length !== 1) throw denied();
  const workspace = candidates[0];
  if (!workspace || await realpath(workspace.root) !== workspace.root || !workspace.root.startsWith(account.accountRoot + path.sep) || !/^[a-f0-9]{64,128}$/.test(workspace.ticket)) throw denied();
  const client = createWorkspaceBrokerClient({ socketPath: configuration.brokerSocketPath });
  const authority = configuration.authoritySocketPath;
  if (workspace.previewProfileId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(workspace.previewProfileId)) throw denied();
  let authorityMapping: { ownerId: string; leaseId: string; legacyReservationId: string; slotId?: string; profileId: string; sessionId: string; bindingEpoch: string } | undefined;
  const authorityIdentity = { ticket: workspace.ticket,userId: input.userId,root: workspace.root,workspaceId: workspace.workspaceId,generation: workspace.generation,bindingEpoch: input.bindingEpoch,sessionId: input.sessionId };
  if (authority) {
    const result = await requestAuthority(authority,input.brokerLeaseId ? '/v1/lookup' : '/v1/begin',{ ...authorityIdentity,legacyReservationId: input.leaseId,leaseId: input.brokerLeaseId });
    if (!result || ![result.ownerId,result.leaseId,result.legacyReservationId,result.profileId,result.sessionId,result.bindingEpoch].every(value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) || (result.slotId !== undefined && (typeof result.slotId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(result.slotId))) || !['active','stopping','closed'].includes(result.state ?? '') || (input.brokerLeaseId !== undefined && result.leaseId !== input.brokerLeaseId)) throw denied();
    if (result.workspaceId !== workspace.workspaceId || result.generation !== workspace.generation || !result.ownerId || !result.leaseId || !result.profileId || !result.sessionId || !result.bindingEpoch ||
      (input.leaseId !== undefined && result.legacyReservationId !== input.leaseId) || (input.bindingEpoch !== undefined && result.bindingEpoch !== input.bindingEpoch) || (input.sessionId !== undefined && result.sessionId !== input.sessionId)) throw denied();
    authorityMapping = result;
  }
  const obtain = async (permission: string, profileId = authorityMapping?.profileId ?? workspace.profileId) => {
    if (authorityMapping && authority) {
      const result = await requestAuthority(authority,'/v1/grant',{ ...authorityIdentity,leaseId: authorityMapping.leaseId,legacyReservationId: authorityMapping.legacyReservationId,slotId: authorityMapping.slotId,profileId,permission });
      if (!result || result.ownerId !== authorityMapping.ownerId || result.workspaceId !== workspace.workspaceId || result.generation !== workspace.generation || result.sessionId !== authorityMapping.sessionId || result.bindingEpoch !== authorityMapping.bindingEpoch || result.slotId !== authorityMapping.slotId || result.leaseId !== authorityMapping.leaseId || result.legacyReservationId !== authorityMapping.legacyReservationId || result.profileId !== profileId || typeof result.proof !== 'string' || result.proof.length > 8192 || !Number.isSafeInteger(result.expiresAt) || result.expiresAt! <= Date.now() || result.expiresAt! > Date.now()+300000) throw denied();
      return { ...result,proof: result.proof,expiresAt: result.expiresAt! };
    }
    if (!configuration.issuerSocketPath) throw unavailable();
    const result = await requestGrant(configuration.issuerSocketPath,{ ticket: workspace.ticket,userId: input.userId,root: workspace.root,workspaceId: workspace.workspaceId,generation: workspace.generation,
      leaseId: input.leaseId,bindingEpoch: input.bindingEpoch,sessionId: input.sessionId,permission,profileId });
    if (result.workspaceId !== workspace.workspaceId || result.generation !== workspace.generation || result.profileId !== profileId || !result.leaseId || !result.bindingEpoch || !result.sessionId ||
      (input.leaseId !== undefined && result.leaseId !== input.leaseId) || (input.bindingEpoch !== undefined && result.bindingEpoch !== input.bindingEpoch) || (input.sessionId !== undefined && result.sessionId !== input.sessionId)) throw denied();
    return result;
  };
  const initial = await obtain(input.root === account.accountRoot ? 'network' : 'status');
  const finishAuthority = async () => {
    if (!authority || !authorityMapping) return undefined;
    const result = await requestAuthority<WorkspaceBrokerLeaseReceipt>(authority,'/v1/end',{ ...authorityIdentity,leaseId: authorityMapping.leaseId,legacyReservationId: authorityMapping.legacyReservationId,slotId: authorityMapping.slotId });
    const token = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
    if (!result || result.state !== 'closed' || result.leaseId !== authorityMapping.leaseId || result.legacyReservationId !== authorityMapping.legacyReservationId || result.slotId !== authorityMapping.slotId || result.profileId !== authorityMapping.profileId || result.root !== workspace.root || result.userId !== input.userId || !token(result.ownerId) || result.ownerId !== authorityMapping.ownerId || result.workspaceId !== workspace.workspaceId || result.generation !== workspace.generation || result.bindingEpoch !== authorityMapping.bindingEpoch || result.sessionId !== authorityMapping.sessionId || result.quiescent !== true || result.cleanupConfirmed !== true || result.resourceInventoryComplete !== true || !Number.isSafeInteger(result.closedAt) || !Number.isSafeInteger(result.confirmedAt) || result.closedAt <= 0 || result.confirmedAt < result.closedAt || result.confirmedAt > Date.now()+1000 || !token(result.brokerInstanceId) || !Array.isArray(result.resources) || result.resources.some(resource => !resource || !token(resource.operationId) || !/^[a-f0-9]{64}$/.test(resource.resourceId)) || new Set(result.resources.map(resource => resource.operationId)).size !== result.resources.length) throw unavailable();
    return result;
  };
  return {
    client,ownerId: authorityMapping?.ownerId,previewProfileId: workspace.previewProfileId,workspaceId: workspace.workspaceId,generation: workspace.generation,leaseId: initial.leaseId,profileId: authorityMapping?.profileId ?? workspace.profileId,
    legacyReservationId: authorityMapping?.legacyReservationId ?? input.leaseId ?? initial.leaseId,slotId: authorityMapping?.slotId,
    bindingEpoch: initial.bindingEpoch,sessionId: initial.sessionId,accountRoot: account.accountRoot,root: workspace.root,
    // Every control action renews from the independent authority. This avoids a
    // long-lived API proof cache retaining a revoked witness or ticket scope.
    async proof(permission: string, profileId = authorityMapping?.profileId ?? workspace.profileId) { return (await obtain(permission,profileId)).proof; },
    async network() { return client.network(await this.proof('network'),workspace.workspaceId); },
    async retireLegacy() { return client.retireLegacy(await this.proof('retire'),workspace.workspaceId); },
    close: finishAuthority,
    async previewGateway(operationId: string,base: string) {
      if (!authority || !authorityMapping) throw unavailable();
      const result = await requestAuthority<{ version: number; ticket: string; issuedAt: number; expiresAt: number; gateway: { accountId: string; host: string; port: number }; workspaceId: string; generation: string; leaseId: string; operationId: string; resourceId: string; base: string }>(authority,'/v1/preview-ticket',{ ...authorityIdentity,bindingEpoch: authorityMapping.bindingEpoch,sessionId: authorityMapping.sessionId,legacyReservationId: authorityMapping.legacyReservationId,leaseId: authorityMapping.leaseId,operationId,base });
      if (!result || result.version !== 1 || result.workspaceId !== workspace.workspaceId || result.generation !== workspace.generation || result.leaseId !== authorityMapping.leaseId || result.operationId !== operationId || result.base !== base || !/^[a-f0-9]{64}$/.test(result.resourceId) || typeof result.ticket !== 'string' || result.ticket.length > 16384 || !Number.isSafeInteger(result.expiresAt) || result.expiresAt <= Date.now() || result.expiresAt > Date.now()+60000 || !result.gateway || result.gateway.accountId !== authorityMapping.ownerId || !/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(result.gateway.host) || !Number.isSafeInteger(result.gateway.port) || result.gateway.port < 1024 || result.gateway.port > 65535) throw unavailable();
      return { host: result.gateway.host,port: result.gateway.port,ticket: result.ticket,resourceId: result.resourceId,base };
    },
    async closePreviewGateway(operationId: string,base: string) {
      if (!authority || !authorityMapping) throw unavailable();
      const result = await requestAuthority<{ closed: boolean; operationId: string; base: string }>(authority,'/v1/preview-close',{ ...authorityIdentity,bindingEpoch: authorityMapping.bindingEpoch,sessionId: authorityMapping.sessionId,legacyReservationId: authorityMapping.legacyReservationId,leaseId: authorityMapping.leaseId,operationId,base });
      if (result.closed !== true || result.operationId !== operationId || result.base !== base) throw unavailable();
    },
  };
}

/** Bridge finalization closes only the independently mapped broker lease. The
 * original legacy guard still performs its exact birth/CAS release separately. */
export async function closeWorkspaceBrokerLease(input: { userId: string; root: string; leaseId: string; bindingEpoch: string; sessionId?: string; brokerLeaseId?: string }) {
  const admission = await getWorkspaceBrokerAdmission(input);
  return admission.close();
}
