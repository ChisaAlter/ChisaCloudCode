import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { promisify } from 'node:util';

import { AppError } from '@/shared/index.js';

import { createWorkspaceRuntimeService, getWorkspaceRuntimeIdentity } from './workspace-runtime.service.js';

const execute = promisify(execFile);
const grants = new Map<string, { userId: string; id: string; root: string; epoch: string; port: number; network: string; connections: Set<() => void> }>();
const previewTokens = new Map<string, string>();

/** The preview service issues an unguessable, process-local browser capability before Docker starts. */
export function createWorkspaceRuntimePreviewAccess(userId: string, id: string, root: string, epoch: string, port: number, network: string) {
  const token = randomBytes(32).toString('hex');
  grants.set(token, { userId, id, root, epoch, port, network, connections: new Set() });
  previewTokens.set(id, token);
  return '/api/workspace-runtime/preview/' + token + '/';
}

/** Status RPCs expose only the capability for the exact currently retained preview. */
export function getWorkspaceRuntimePreviewUrl(id: string) {
  const token = previewTokens.get(id);
  return token ? '/api/workspace-runtime/preview/' + token + '/' : undefined;
}

/** Stop and session cleanup revoke new browser access and tear down existing streams before removing Docker. */
export function revokeWorkspaceRuntimePreviewAccess(id: string) {
  const token = previewTokens.get(id);
  if (!token) return;
  previewTokens.delete(id);
  const grant = grants.get(token);
  grants.delete(token);
  for (const close of grant?.connections ?? []) close();
}

/** The proxy tracks streams so a revoked preview cannot keep an existing connection alive. */
export function retainWorkspaceRuntimePreviewConnection(token: string, close: () => void) {
  const grant = grants.get(token);
  if (!grant) throw new AppError('Preview is no longer available', { code: 'PREVIEW_NOT_FOUND', statusCode: 404 });
  grant.connections.add(close);
  return () => { grant.connections.delete(close); };
}

/** Each HTTP/WS request revalidates the exact live container and owned network; a token never selects an arbitrary host. */
export async function resolveWorkspaceRuntimePreviewAccess(token: string) {
  const grant = /^[a-f0-9]{64}$/.test(token) ? grants.get(token) : undefined;
  const unavailable = () => new AppError('Preview is no longer available', { code: 'PREVIEW_NOT_FOUND', statusCode: 404 });
  if (!grant) throw unavailable();
  const identity = getWorkspaceRuntimeIdentity(grant.root);
  if (!identity || identity.userId !== grant.userId || identity.network !== grant.network) throw unavailable();
  const restored = await createWorkspaceRuntimeService().restore(grant.userId);
  if (restored.root !== identity.root || restored.owner !== identity.owner || restored.network !== grant.network) throw unavailable();
  const result = await execute('docker', ['inspect', grant.id], { timeout: 10_000, maxBuffer: 1024 * 1024 });
  const containers = JSON.parse(result.stdout) as Array<{
    Name: string; State: { Running: boolean }; Config: { Labels: Record<string, string> };
    Mounts: Array<{ Source: string; Destination: string; Type: string; RW: boolean }>;
    NetworkSettings: { Networks: Record<string, { IPAddress: string }> };
  }>;
  const container = Array.isArray(containers) && containers.length === 1 ? containers[0] : undefined;
  const labels = container?.Config?.Labels;
  const host = container?.NetworkSettings?.Networks?.[grant.network]?.IPAddress;
  const owner = /^chisa-account-preview-([a-f0-9]{20})-[a-f0-9]{16}$/.exec(grant.id)?.[1];
  if (!container || container.Name !== '/' + grant.id || container.State?.Running !== true || !owner || labels?.['chisa.sync-preview.owner'] !== owner ||
    labels['chisa.sync-preview.epoch'] !== grant.epoch || labels['chisa.sync-preview.port'] !== String(grant.port) ||
    labels['chisa.workspace-root'] !== createHash('sha256').update(grant.root).digest('hex') ||
    !container.Mounts?.some(mount => mount.Source === grant.root && mount.Destination === '/workspace' && mount.Type === 'bind' && mount.RW === true) ||
    !host || isIP(host) !== 4 || !/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(host) || grants.get(token) !== grant) throw unavailable();
  return { host, port: grant.port, base: '/api/workspace-runtime/preview/' + token + '/' };
}
