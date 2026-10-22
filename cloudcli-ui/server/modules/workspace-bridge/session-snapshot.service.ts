import { createHash } from 'node:crypto';
import { chownSync, closeSync, existsSync, fstatSync, fsyncSync, lchownSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, writeFileSync, writeSync } from 'node:fs';
import { copyFile, cp, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { AppError } from '@/shared/index.js';

import { isolatedSessionObjects } from './session-objects.service.js';

type SnapshotGit = (args: string[], cwd: string, signal?: AbortSignal) => Promise<{ code: number | null; stdout: string; stderr: string }>;

const reserved = new Set(['.git', '.chisa-bridge.json', '.chisa-session.json', '.chisa-lease', '.chisa-worktrees']);
const dependencies = new Set(['node_modules', '.venv', 'venv', '__pycache__']);
const generated = new Set(['dist', 'build', 'out', '.next', 'coverage', '.cache', 'cache', '.tmp', '.dev', '.nodetmp']);

/** Workspace admission copies only the pinned source's project files and exact private index. */
export async function copyPinnedSessionSnapshot(source: string, target: string, runGit: SnapshotGit, assertPinned: () => void, signal?: AbortSignal): Promise<void> {
  const git = async (args: string[], cwd = source) => {
    signal?.throwIfAborted();
    assertPinned();
    const result = await runGit(args, cwd, signal);
    if (result.code !== 0) throw new AppError('The pinned Git snapshot could not be read', { code: 'WORKSPACE_GIT_CHANGED', statusCode: 409, details: result.stderr.trim() });
    return args.includes('-z') ? result.stdout : result.stdout.trim();
  };
  const sourceGit = path.resolve(source, await git(['rev-parse', '--absolute-git-dir']));
  const targetGit = path.resolve(target, await git(['rev-parse', '--absolute-git-dir'], target));
  const head = await git(['rev-parse', 'HEAD']);
  if (await git(['rev-parse', 'HEAD'], target) !== head) throw new AppError('The source HEAD changed while creating the isolated branch', { code: 'WORKSPACE_SNAPSHOT_CHANGED', statusCode: 409 });
  const indexPath = path.join(sourceGit, 'index');
  const index = existsSync(indexPath) ? readFileSync(indexPath) : null;
  if (existsSync(indexPath + '.lock') || existsSync(path.join(sourceGit, 'HEAD.lock'))) {
    throw new AppError('Git is changing the source snapshot; finish that operation before retrying', { code: 'WORKSPACE_GIT_OPERATION_IN_PROGRESS', statusCode: 409 });
  }
  // A tracked generated path is still source. Security/runtime exclusions stay
  // unconditional, matching the synchronization policy (including credentials).
  const tracked = new Set((await git(['ls-files', '-z'])).split('\0').filter(Boolean));
  const trackedPrefixes = new Set<string>();
  for (const entry of tracked) {
    const parts = entry.split('/');
    for (let end = 1; end <= parts.length; end++) trackedPrefixes.add(parts.slice(0, end).join('/'));
  }
  const include = (filename: string) => {
    const relative = path.relative(source, filename);
    if (!relative) return true;
    const parts = relative.split(path.sep);
    if (parts.some(part => reserved.has(part) || dependencies.has(part) || (part === '.env' || part.startsWith('.env.')) && part !== '.env.example' && part !== '.env.sample')) return false;
    return !generated.has(parts[0]!) || trackedPrefixes.has(parts.join('/'));
  };
  const digest = (root: string): string => {
    const hash = createHash('sha256');
    const visit = (filename: string) => {
      signal?.throwIfAborted();
      assertPinned();
      if (!include(path.join(source, path.relative(root, filename)))) return;
      const stats = lstatSync(filename);
      const relative = path.relative(root, filename);
      hash.update(JSON.stringify([relative, relative ? stats.mode & 0o777 : 0, stats.isDirectory() ? 'directory' : stats.isSymbolicLink() ? 'symlink' : 'file']));
      if (stats.isSymbolicLink()) hash.update(readlinkSync(filename));
      else if (stats.isDirectory()) for (const name of readdirSync(filename).sort()) visit(path.join(filename, name));
      else if (stats.isFile()) hash.update(readFileSync(filename));
      else throw new AppError('The source snapshot contains a special file', { code: 'WORKSPACE_WORKTREE_CONFLICT', statusCode: 409 });
    };
    visit(root);
    return hash.digest('hex');
  };
  const before = digest(source);
  for (const name of readdirSync(source)) {
    const filename = path.join(source, name);
    if (!include(filename)) continue;
    await cp(filename, path.join(target, name), { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true, filter: entry => { signal?.throwIfAborted(); assertPinned(); return include(entry); } });
  }
  // --no-checkout left the destination empty, so missing/renamed source paths
  // cannot be resurrected by HEAD checkout. Preserve staged-vs-unstaged bytes.
  if (index) {
    await writeFile(path.join(targetGit, 'index'), index, { mode: 0o600 });
    for (const name of readdirSync(sourceGit)) if (/^sharedindex\.[a-f0-9]+$/.test(name)) await copyFile(path.join(sourceGit, name), path.join(targetGit, name));
    await git(['-c', 'core.fsmonitor=false', 'update-index', '--no-split-index'], target);
  } else {
    await git(['read-tree', '--empty'], target);
  }
  assertPinned();
  const currentIndex = existsSync(indexPath) ? readFileSync(indexPath) : null;
  if (before !== digest(source) || before !== digest(target) || head !== await git(['rev-parse', 'HEAD']) || !sameBytes(index, currentIndex)
    || existsSync(indexPath + '.lock') || existsSync(path.join(sourceGit, 'HEAD.lock'))) {
    throw new AppError('The source changed while its isolated snapshot was being copied; retry after synchronization', { code: 'WORKSPACE_SNAPSHOT_CHANGED', statusCode: 409 });
  }
}

function ownSessionPath(filename: string): void {
  if (process.platform === 'win32' || process.getuid?.() !== 0) return;
  const visit = (candidate: string) => {
    const stats = lstatSync(candidate);
    if (stats.isSymbolicLink()) { lchownSync(candidate, 1000, 1000); return; }
    chownSync(candidate, 1000, 1000);
    if (stats.isDirectory()) for (const name of readdirSync(candidate)) visit(path.join(candidate, name));
  };
  visit(filename);
}

function sameBytes(left: Buffer | null, right: Buffer | null): boolean {
  return left === null ? right === null : right !== null && left.equals(right);
}

/** Workspace containers use the linked worktree's Git files without writable access to source refs or indexes. */
export function isolatedSessionGitRuntime(root: string, sourceRoot: string, branch: string, readOnly: boolean) {
  const sourceGit = path.join(sourceRoot, '.git');
  const common = realpathSync(sourceGit);
  if (common !== sourceGit || !lstatSync(common).isDirectory()) throw new AppError('The source Git directory cannot be isolated safely', { code: 'WORKSPACE_WORKTREE_CONFLICT', statusCode: 409 });
  const marker = readFileSync(path.join(root, '.git'), 'utf8').trim();
  if (!marker.startsWith('gitdir: ')) throw new AppError('The session Git pointer is invalid', { code: 'WORKSPACE_WORKTREE_CONFLICT', statusCode: 409 });
  const gitdir = realpathSync(path.resolve(root, marker.slice(8)));
  const worktreesDirectory = path.join(common, 'worktrees');
  if (realpathSync(worktreesDirectory) !== worktreesDirectory || !lstatSync(worktreesDirectory).isDirectory()) throw new AppError('The session worktree namespace is not canonical', { code: 'WORKSPACE_WORKTREE_CONFLICT', statusCode: 409 });
  if (process.platform !== 'win32' && process.getuid?.() === 0) chownSync(worktreesDirectory, 1000, 1000);
  if (path.dirname(gitdir) !== path.join(common, 'worktrees') || realpathSync(path.resolve(gitdir, readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim())) !== common
    || realpathSync(path.resolve(gitdir, readFileSync(path.join(gitdir, 'gitdir'), 'utf8').trim())) !== realpathSync(path.join(root, '.git'))) {
    throw new AppError('The session Git directory no longer belongs to this source repository', { code: 'WORKSPACE_WORKTREE_CONFLICT', statusCode: 409 });
  }
  const head = readFileSync(path.join(gitdir, 'HEAD'), 'utf8').trim();
  if (head !== `ref: refs/heads/${branch}` || !/^chisa\/session-private\/[^/]+\/work$/.test(branch)) throw new AppError('The session branch changed; recover the retained worktree before running commands', { code: 'WORKSPACE_WORKTREE_CONFLICT', statusCode: 409 });
  const refDirectory = path.join(common, 'refs', 'heads', path.dirname(branch));
  const logDirectory = path.join(common, 'logs', 'refs', 'heads', path.dirname(branch));
  // Root may create a reserved namespace before the server later runs as UID
  // 1000. Own only these exact parent directories, never siblings or all refs.
  for (const base of [path.join(common, 'refs', 'heads'), path.join(common, 'logs', 'refs', 'heads')]) {
    for (const relative of ['chisa', path.join('chisa', 'session-private')]) {
      const directory = path.join(base, relative);
      mkdirSync(directory, { recursive: true });
      if (realpathSync(directory) !== directory || !lstatSync(directory).isDirectory()) throw new AppError('The private session namespace is not canonical', { code: 'WORKSPACE_WORKTREE_CONFLICT', statusCode: 409 });
      if (process.platform !== 'win32' && process.getuid?.() === 0) chownSync(directory, 1000, 1000);
    }
  }
  for (const directory of [refDirectory, logDirectory]) {
    mkdirSync(directory, { recursive: true });
    if (realpathSync(directory) !== directory) throw new AppError('The private session ref directory is not canonical', { code: 'WORKSPACE_WORKTREE_CONFLICT', statusCode: 409 });
    ownSessionPath(directory);
  }
  const ownershipFile = path.join(root, '.chisa-session.json');
  if (process.platform !== 'win32' && process.getuid?.() === 0 && existsSync(ownershipFile)) {
    const metadata = JSON.parse(readFileSync(ownershipFile, 'utf8')) as Record<string, unknown>;
    if (metadata.containerOwnership !== 1) {
      ownSessionPath(gitdir); ownSessionPath(root);
      writeFileSync(ownershipFile + '.tmp', JSON.stringify({ ...metadata, containerOwnership: 1 }), { mode: 0o600 });
      chownSync(ownershipFile + '.tmp', 1000, 1000);
      renameSync(ownershipFile + '.tmp', ownershipFile);
    }
  }
  // Both markers are capabilities/internal identity, never user changes to
  // commit. One O_APPEND write preserves concurrent additions to info/exclude.
  const info = path.join(common, 'info');
  mkdirSync(info, { recursive: true });
  if (realpathSync(info) !== info) throw new AppError('Git ignore metadata is not canonical', { code: 'WORKSPACE_WORKTREE_CONFLICT', statusCode: 409 });
  const exclude = path.join(info, 'exclude');
  if (existsSync(exclude) && (!lstatSync(exclude).isFile() || lstatSync(exclude).isSymbolicLink() || realpathSync(exclude) !== exclude)) throw new AppError('Git ignore metadata is not a regular file', { code: 'WORKSPACE_WORKTREE_CONFLICT', statusCode: 409 });
  const descriptor = openSync(exclude, 'a+', 0o600);
  try {
    const opened = fstatSync(descriptor);
    const current = lstatSync(exclude);
    if (!opened.isFile() || current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino) throw new AppError('Git ignore metadata changed before append', { code: 'WORKSPACE_WORKTREE_CONFLICT', statusCode: 409 });
    const contents = readFileSync(descriptor, 'utf8');
    const lines = contents.split(/\r?\n/);
    if (!lines.includes('/.chisa-session.json') || !lines.includes('/.chisa-bridge.json')) {
      writeSync(descriptor, '\n/.chisa-session.json\n/.chisa-bridge.json\n');
      fsyncSync(descriptor);
    }
  } finally { closeSync(descriptor); }
  const objects = path.join(common, 'objects');
  if (realpathSync(objects) !== objects || !lstatSync(objects).isDirectory() || existsSync(path.join(objects, 'info', 'alternates'))) throw new AppError('The session object database cannot be mounted safely', { code: 'WORKSPACE_WORKTREE_CONFLICT', statusCode: 409 });
  const objectStore = isolatedSessionObjects(common, gitdir);
  const volume = (source: string, writable: boolean) => ['--volume', `${source}:${source}:${writable && !readOnly ? 'rw' : 'ro'}`];
  return {
    mounts: [...volume(common, false), ...volume(gitdir, true), ...volume(objectStore.directory, true), ...volume(refDirectory, true), ...volume(logDirectory, true)],
    environment: objectStore.environment,
    async publish() {
      // Commands may edit their private gitdir. Revalidate the reciprocal
      // identity and private branch after teardown before any host publication.
      isolatedSessionGitRuntime(root, sourceRoot, branch, readOnly);
      await objectStore.publish();
    },
  };
}

/** Snapshot fixture tests inspect mount permissions without launching a model or Docker daemon. */
export function isolatedSessionGitMounts(root: string, sourceRoot: string, branch: string, readOnly: boolean): string[] {
  return isolatedSessionGitRuntime(root, sourceRoot, branch, readOnly).mounts;
}
