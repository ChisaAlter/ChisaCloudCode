import { closeSync, constants, existsSync, fchownSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, writeSync } from 'node:fs';
import path from 'node:path';

import { AppError } from '@/shared/index.js';

/** Binding admission prepares only the verified project tree for its fixed sandbox user; symlink targets and sibling state stay untouched. */
export function prepareCloudProjectOwnership(root: string): void {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) return;
  const entries: Array<{ filename: string; directory: boolean; dev: number; ino: number }> = [];
  const pending = [root];
  while (pending.length) {
    const filename = pending.pop()!;
    const stats = lstatSync(filename);
    if (stats.isSymbolicLink()) continue;
    if (realpathSync(filename) !== filename || (!stats.isDirectory() && (!stats.isFile() || stats.nlink !== 1))) {
      throw new AppError('云端项目含不可安全交给运行环境的文件，请检查硬链接或特殊文件', { code: 'WORKSPACE_PROJECT_UNSAFE', statusCode: 409 });
    }
    entries.push({ filename, directory: stats.isDirectory(), dev: stats.dev, ino: stats.ino });
    if (entries.length > 200_000) throw new AppError('云端项目超过首次运行权限准备的条目上限', { code: 'WORKSPACE_PROJECT_TOO_LARGE', statusCode: 409 });
    if (stats.isDirectory()) {
      for (const name of readdirSync(filename)) {
        if (name === '.chisa-bridge.json' || name === '.chisa-session.json') continue;
        pending.push(path.join(filename, name));
      }
    }
  }
  // Ownership is changed after the entire tree has passed validation. No recursive
  // chown command can follow a project symlink into another directory.
  for (const original of entries) {
    if (realpathSync(original.filename) !== original.filename) throw new AppError('云端项目在权限准备期间已变化，请重试', { code: 'WORKSPACE_BUSY', statusCode: 409 });
    const fd = openSync(original.filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (original.directory ? constants.O_DIRECTORY : 0));
    try {
      const current = fstatSync(fd);
      if (current.dev !== original.dev || current.ino !== original.ino || (!original.directory && current.nlink !== 1)) throw new AppError('云端项目在权限准备期间已变化，请重试', { code: 'WORKSPACE_BUSY', statusCode: 409 });
      fchownSync(fd, 1000, 1000);
    } finally { closeSync(fd); }
  }
}

/** Cloud Git inspection and binding setup keep internal identity markers out of a repository's own excludes. */
export function excludeCloudWorkspaceMetadata(root: string): void {
  const git = path.join(root, '.git');
  if (!existsSync(git)) return;
  const gitStats = lstatSync(git);
  // Linked worktrees share the source repository's excludes, initialized before
  // their snapshot. Do not follow a task-controlled gitdir pointer on the host.
  if (!gitStats.isDirectory() || gitStats.isSymbolicLink() || realpathSync(git) !== git) return;
  const info = path.join(git, 'info');
  mkdirSync(info, { recursive: true });
  if (!lstatSync(info).isDirectory() || lstatSync(info).isSymbolicLink() || realpathSync(info) !== info) {
    throw new AppError('云端 Git 排除目录身份无效', { code: 'WORKSPACE_GIT_UNSUPPORTED', statusCode: 409 });
  }
  const parentStats = lstatSync(info);
  const parentFd = process.platform === 'linux' ? openSync(info, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW) : null;
  if (parentFd !== null) {
    const current = fstatSync(parentFd);
    if (current.dev !== parentStats.dev || current.ino !== parentStats.ino || realpathSync(info) !== info) {
      closeSync(parentFd);
      throw new AppError('云端 Git 排除目录在打开时已变化', { code: 'WORKSPACE_BUSY', statusCode: 409 });
    }
  }
  // Anchor Linux access to the verified directory inode. Replacing .git/info
  // after validation cannot redirect the append or ownership change outside it.
  const file = parentFd === null ? path.join(info, 'exclude') : `/proc/self/fd/${parentFd}/exclude`;
  let fd: number;
  try { fd = openSync(file, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600); }
  catch (error) { if (parentFd !== null) closeSync(parentFd); throw error; }
  try {
    const opened = fstatSync(fd);
    const current = lstatSync(file);
    if (!opened.isFile() || opened.nlink !== 1 || current.isSymbolicLink() || opened.dev !== current.dev || opened.ino !== current.ino || opened.size > 1024 * 1024) {
      throw new AppError('云端 Git 排除文件身份无效', { code: 'WORKSPACE_GIT_UNSUPPORTED', statusCode: 409 });
    }
    const lines = readFileSync(fd, 'utf8').split(/\r?\n/);
    const missing = ['/.chisa-bridge.json', '/.chisa-session.json'].filter(rule => !lines.includes(rule));
    if (missing.length) { writeSync(fd, '\n' + missing.join('\n') + '\n'); fsyncSync(fd); }
    if (process.platform === 'linux' && process.getuid?.() === 0) fchownSync(fd, 1000, 1000);
    if (parentFd !== null && process.getuid?.() === 0) fchownSync(parentFd, 1000, 1000);
  } finally { closeSync(fd); if (parentFd !== null) closeSync(parentFd); }
}
