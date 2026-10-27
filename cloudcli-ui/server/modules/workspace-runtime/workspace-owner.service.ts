import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AppError } from '@/shared/index.js';

function denied(): never {
  throw new AppError('Workspace does not belong to the current account.', { code: 'WORKSPACE_FORBIDDEN', statusCode: 403 });
}

function readPrivateMetadata(file: string): Record<string, unknown> | null {
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; denied(); }
  try {
    const stat = fstatSync(fd!);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65_536 || (process.platform !== 'win32' && (stat.mode & 0o022) !== 0)) denied();
    const value: unknown = JSON.parse(readFileSync(fd!, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) denied();
    return value as Record<string, unknown>;
  } catch { denied(); }
  finally { closeSync(fd!); }
}

/** Projects, Providers and WebSocket inspect existing account ownership without restoring Docker, creating bindings or claiming imported data. */
export function readCloudWorkspaceOwner(candidate: string): string | null {
  const root = process.env.WORKSPACES_ROOT ? path.resolve(process.env.WORKSPACES_ROOT) : null;
  const absolute = path.resolve(candidate);
  // Check every existing directory component without following links. A missing
  // clone destination may inherit its verified parent, never a symlink target.
  let component = absolute;
  for (;;) {
    try { if (lstatSync(component).isSymbolicLink() || realpathSync(component) !== component) denied(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') denied(); }
    if (path.dirname(component) === component) break;
    component = path.dirname(component);
  }
  let savedOwner: string | null = null;
  let expectedMarkerOwner: string | null = null;
  if (root && (absolute === root || absolute.startsWith(root + path.sep))) {
    const stateName = createHash('sha256').update(root).digest('hex').slice(0, 24) + '.json';
    const state = readPrivateMetadata(path.join(os.homedir(), '.chisa-workspace-runtime', stateName));
    if (state) {
      if (state.version !== 1 || state.root !== root || typeof state.userId !== 'string' || !state.userId || /[\r\n\0]/.test(state.userId)) denied();
      const owner = createHash('sha256').update(root + '\0' + state.userId).digest('hex').slice(0, 24);
      if (state.owner !== owner) denied();
      savedOwner = state.userId;
      expectedMarkerOwner = owner;
    }
  }
  let directory = absolute;
  for (;;) {
    const marker = readPrivateMetadata(path.join(directory, '.chisa-bridge.json'));
    if (marker?.protocol === 3) {
      if (!savedOwner || marker.owner !== expectedMarkerOwner || marker.root !== directory) denied();
      return savedOwner;
    }
    if ((root && directory === root) || path.dirname(directory) === directory) break;
    directory = path.dirname(directory);
  }
  return savedOwner;
}

/** HTTP/runtime gateways enforce persisted cloud ownership; unbound legacy data is visible only in an authenticated single-account installation. */
export function assertCloudWorkspaceOwner(candidate: string | null | undefined, userId: string | number | null | undefined, legacyAccountIds?: readonly string[]): void {
  const owner = candidate ? readCloudWorkspaceOwner(candidate) : null;
  if (owner !== null) {
    if (userId === null || userId === undefined || String(userId) !== owner) denied();
    return;
  }
  // Omitted account ids are reserved for trusted internal callers. No metadata
  // is written: multiple accounts never acquire imported history by reading it.
  if (legacyAccountIds && (legacyAccountIds.length > 1 || (legacyAccountIds.length === 1 && String(userId) !== legacyAccountIds[0]))) denied();
}
