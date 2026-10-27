import { randomBytes, randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { AppError } from '@/shared/index.js';

import { getWorkspaceRuntimeIdentity } from './workspace-runtime.service.js';
import { excludeCloudWorkspaceMetadata, prepareCloudProjectOwnership } from './workspace-runtime-project.service.js';

function metadata(file: string): Record<string, unknown> | null {
  let stats;
  try { stats = lstatSync(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || stats.size > 65_536 || (process.platform !== 'win32' && (stats.mode & 0o022) !== 0)) {
    throw new AppError('云端工作区元数据不安全，请检查项目状态', { code: 'WORKSPACE_RUNTIME_MISMATCH', statusCode: 503 });
  }
  const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('云端工作区元数据无效', { code: 'WORKSPACE_RUNTIME_MISMATCH', statusCode: 503 });
  return value as Record<string, unknown>;
}

function createExclusive(file: string, value: string): void {
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); }
}

function initializeWriter(root: string, epoch: string, legacy: boolean): void {
  const capability = root + '.chisa-writer-capability.json';
  const generationPath = root + '.chisa-generation.json';
  const guard = root + '.chisa-writer.guard';
  const existing = metadata(capability);
  if (existing) {
    if (existing.version !== 1 || existing.root !== root || existing.bindingEpoch !== epoch
      || !['chisa-writer-gate-v1', 'chisa-cloud-writer-v1'].includes(String(existing.protocol))) {
      throw new AppError('云端写入身份与项目不一致', { code: 'WORKSPACE_RUNTIME_MISMATCH', statusCode: 503 });
    }
    const generation = metadata(generationPath);
    const guardMetadata = existsSync(guard) ? lstatSync(guard) : null;
    if (!generation || generation.version !== 1 || generation.root !== root || !['dirty', 'complete'].includes(String(generation.state))
      || !['mutagen', 'cloud'].includes(String(generation.writer)) || typeof generation.generation !== 'string' || !/^[a-f0-9]{32,}$/.test(generation.generation)
      || (generation.bindingEpoch !== undefined && generation.bindingEpoch !== epoch) || typeof generation.updatedAt !== 'string' || !Number.isFinite(Date.parse(generation.updatedAt))
      || !guardMetadata?.isFile() || guardMetadata.isSymbolicLink() || guardMetadata.nlink !== 1 || (process.platform !== 'win32' && (guardMetadata.mode & 0o022) !== 0)) {
      throw new AppError('云端写入状态不完整或身份已改变，请恢复项目', { code: 'WORKSPACE_RECOVERY_REQUIRED', statusCode: 409 });
    }
    return;
  }
  if (existsSync(generationPath) || existsSync(guard)) throw new AppError('云端写入身份缺失，请保留现有状态并恢复项目', { code: 'WORKSPACE_RECOVERY_REQUIRED', statusCode: 409 });
  if (existsSync(root + '.chisa-lease') || existsSync(root + '.chisa-integration.json')) throw new AppError('项目仍有未完成的工作区操作', { code: 'WORKSPACE_RECOVERY_REQUIRED', statusCode: 409 });
  try {
    createExclusive(guard, '');
    createExclusive(generationPath, JSON.stringify({ version: 1, root, generation: randomBytes(32).toString('hex'), state: 'complete', writer: 'cloud', bindingEpoch: epoch, updatedAt: new Date().toISOString() }));
    createExclusive(capability, JSON.stringify({ version: 1, root, bindingEpoch: epoch, protocol: 'chisa-cloud-writer-v1' }));
  } catch (error) {
    // Partial initialization stays visible for recovery; another caller must not
    // mistake it for an unenrolled workspace and bypass its persistent guard.
    throw new AppError(legacy ? '旧项目的云端写入接管尚未完成，请恢复项目' : '云端写入初始化尚未完成，请恢复项目', { code: 'WORKSPACE_RECOVERY_REQUIRED', statusCode: 409, details: { cause: (error as NodeJS.ErrnoException).code } });
  }
  if (process.platform !== 'win32') {
    const fd = openSync(path.dirname(root), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
}

/** The workspace bridge creates server-owned markers only beneath a verified cloud account root; legacy epochs stay stable. */
export function ensureCloudWorkspaceBinding(candidate: string): void {
  const root = path.resolve(candidate);
  const runtime = getWorkspaceRuntimeIdentity(root);
  if (!runtime) {
    if (process.platform === 'linux' && process.env.WORKSPACES_ROOT) throw new AppError('云端账号运行环境尚未就绪，请检查服务器状态后重试', { code: 'WORKSPACE_RUNTIME_UNAVAILABLE', statusCode: 503 });
    return;
  }
  if (root === runtime.root || !root.startsWith(runtime.root + path.sep) || realpathSync(root) !== root) {
    throw new AppError('云端项目必须位于当前账号的独立工作目录内', { code: 'WORKSPACE_RUNTIME_MISMATCH', statusCode: 503 });
  }
  const file = path.join(root, '.chisa-bridge.json');
  const previous = metadata(file);
  if (!previous) {
    let ancestor = path.dirname(root);
    while (ancestor !== runtime.root && ancestor.startsWith(runtime.root + path.sep)) {
      if (existsSync(path.join(ancestor, '.chisa-bridge.json'))) return;
      ancestor = path.dirname(ancestor);
    }
  }
  if (previous?.protocol === 3) {
    if (previous.owner !== runtime.owner || previous.root !== root || typeof previous.bindingEpoch !== 'string' || !previous.bindingEpoch) {
      throw new AppError('云端工作区身份与当前账号不一致', { code: 'WORKSPACE_RUNTIME_MISMATCH', statusCode: 503 });
    }
    if (previous.execution !== 'isolated-worktree') { initializeWriter(root, previous.bindingEpoch, false); excludeCloudWorkspaceMetadata(root); }
    return;
  }
  if (previous && (previous.protocol !== 2 || typeof previous.bindingEpoch !== 'string' || !previous.bindingEpoch)) {
    throw new AppError('此项目仍使用已移除的本地文件桥，请在云端导入项目目录', { code: 'LOCAL_WORKSPACE_REMOVED', statusCode: 409 });
  }
  if (existsSync(root + '.chisa-lease') || existsSync(root + '.chisa-integration.json')) {
    throw new AppError('项目仍有未完成的工作区操作，请先恢复该操作再接管云端目录', { code: 'WORKSPACE_RECOVERY_REQUIRED', statusCode: 409 });
  }
  const generation = metadata(root + '.chisa-generation.json');
  if (generation && (generation.state !== 'complete' || generation.root !== root || (generation.bindingEpoch !== undefined && generation.bindingEpoch !== previous?.bindingEpoch))) {
    throw new AppError('旧同步尚未确认完整文件版本，请先核对并恢复云端目录', { code: 'WORKSPACE_RECOVERY_REQUIRED', statusCode: 409 });
  }
  const value = {
    protocol: 3, root, owner: runtime.owner, bindingEpoch: previous?.bindingEpoch ?? randomUUID(),
    ...(previous?.execution === 'isolated-worktree' ? { execution: previous.execution, sessionId: previous.sessionId } : {}),
  };
  if (!previous) prepareCloudProjectOwnership(root);
  if (value.execution !== 'isolated-worktree') excludeCloudWorkspaceMetadata(root);
  if (value.execution !== 'isolated-worktree') initializeWriter(root, value.bindingEpoch as string, Boolean(previous));
  if (!previous) {
    try {
      const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const current = metadata(file);
      if (current?.protocol !== 3 || current.owner !== runtime.owner || current.root !== root) throw error;
    }
    return;
  }
  // The account runtime has already stopped its exact SSH sync container. Preserve
  // the old epoch so retained sessions and their integration baselines remain valid.
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    const current = metadata(file);
    if (JSON.stringify(current) !== JSON.stringify(previous) || existsSync(root + '.chisa-lease') || existsSync(root + '.chisa-integration.json')) {
      throw new AppError('工作区接管期间身份或运行状态已改变，请重试', { code: 'WORKSPACE_BUSY', statusCode: 409 });
    }
    renameSync(temporary, file);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
