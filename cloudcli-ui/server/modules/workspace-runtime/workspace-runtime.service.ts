import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { AppError, registerWorkspaceRuntimeNetwork } from '@/shared/index.js';

import { retireWorkspaceSyncTransport } from './workspace-runtime-retirement.service.js';
import { getWorkspaceBrokerAdmission } from './workspace-runtime-broker.service.js';
// Coalesce concurrent requests across router/service instances, but re-inspect
// the network for later admissions rather than caching mutable Docker state.
const restorations = new Map<string, Promise<{ root: string; owner: string; network: string }>>();
const runtimeIdentities = new Map<string, { userId: string; root: string; owner: string; network: string }>();

/** Returns only an identity registered after persistent ownership and broker verification. */
export function getWorkspaceRuntimeIdentity(candidate: string) {
  let root = path.resolve(candidate);
  for (;;) {
    const identity = runtimeIdentities.get(root);
    if (identity) return { ...identity };
    const parent = path.dirname(root);
    if (parent === root) return undefined;
    root = parent;
  }
}

function mismatch(message: string) {
  return new AppError(message, { code: 'WORKSPACE_RUNTIME_MISMATCH', statusCode: 503 });
}

async function runtimeIdentity(userId: string) {
  const configuredRoot = process.env.WORKSPACES_ROOT;
  if (!userId || /[\r\n\0]/.test(userId) || !configuredRoot || !path.isAbsolute(configuredRoot)) {
    throw new AppError('服务器尚未配置独立工作目录', { code: 'WORKSPACE_RUNTIME_UNAVAILABLE', statusCode: 503 });
  }
  const root = await realpath(configuredRoot);
  const home = await realpath(os.homedir());
  if (root === path.parse(root).root || root === home || !(await stat(root)).isDirectory() || /[,\r\n\0]/.test(root) || (process.platform === 'linux' && root.includes(':'))) {
    throw new AppError('云端运行目录必须是独立工作目录', { code: 'WORKSPACE_RUNTIME_UNAVAILABLE', statusCode: 503 });
  }
  const owner = createHash('sha256').update(root + '\0' + userId).digest('hex').slice(0, 24);
  const stateDirectory = path.join(home, '.chisa-workspace-runtime');
  if (stateDirectory === root || stateDirectory.startsWith(root + path.sep)) {
    throw new AppError('云端运行身份不能存放在工作目录内', { code: 'WORKSPACE_RUNTIME_UNAVAILABLE', statusCode: 503 });
  }
  const statePath = path.join(stateDirectory, createHash('sha256').update(root).digest('hex').slice(0, 24) + '.json');
  return { root, owner, stateDirectory, statePath };
}

async function requireRootOwner(root: string, userId: string, owner: string, stateDirectory: string, statePath: string) {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const directory = await lstat(stateDirectory);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (process.platform !== 'win32' && (directory.mode & 0o077) !== 0) ||
    (typeof process.getuid === 'function' && directory.uid !== process.getuid())) {
    throw mismatch('云端运行身份目录不安全');
  }
  const expected = { version: 1, root, userId, owner };
  try {
    const created = await open(statePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await created.writeFile(JSON.stringify(expected) + '\n', 'utf8'); await created.sync(); }
    finally { await created.close(); }
    if (process.platform === 'linux') {
      const parent = await open(stateDirectory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await parent.sync(); } finally { await parent.close(); }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  // O_NOFOLLOW protects the identity file, including against a replacement
  // between checking the directory and reading the account claim.
  const saved = await open(statePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await saved.stat();
    if (!metadata.isFile() || metadata.nlink !== 1 || (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) || metadata.size > 16_384 ||
      (typeof process.getuid === 'function' && metadata.uid !== process.getuid())) throw mismatch('云端运行身份文件不安全');
    let value: Record<string, unknown>;
    try { value = JSON.parse(await saved.readFile('utf8')) as Record<string, unknown>; }
    catch { throw mismatch('云端运行身份文件无效'); }
    if (!value || value.version !== 1 || value.root !== root || value.userId !== userId || value.owner !== owner) {
      throw mismatch('工作目录已绑定到其他账号或身份已改变');
    }
  } finally { await saved.close(); }
}

/** Account execution owns its network even when no file-sync transport exists. */
export function createWorkspaceRuntimeService() {
  return {
    async restore(userId: string) {
      const identity = await runtimeIdentity(userId);
      const key = identity.root + '\0' + userId;
      const current = restorations.get(key);
      if (current) return current;
      const restoration = (async () => {
        const admission = await getWorkspaceBrokerAdmission({ userId, root: identity.root });
        await requireRootOwner(identity.root, userId, identity.owner, identity.stateDirectory, identity.statePath);
        await retireWorkspaceSyncTransport(identity.root, identity.owner, userId);
        const { networkId: network } = await admission.network();
        registerWorkspaceRuntimeNetwork(identity.root, network, identity.owner);
        const registered = { root: identity.root, owner: identity.owner, network };
        runtimeIdentities.set(identity.root, { ...registered, userId });
        return registered;
      })();
      restorations.set(key, restoration);
      try { return await restoration; }
      catch (error) {
        // Keep existing admitted operations usable while inspection is pending;
        // only a failed revalidation revokes the previously verified identity.
        if (runtimeIdentities.get(identity.root)?.userId === userId) runtimeIdentities.delete(identity.root);
        throw error;
      } finally { if (restorations.get(key) === restoration) restorations.delete(key); }
    },
  };
}
