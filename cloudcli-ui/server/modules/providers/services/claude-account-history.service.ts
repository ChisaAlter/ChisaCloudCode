import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rmdir, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { claudeAccountsDb, getDatabasePath, sessionsDb, userDb } from '@/modules/database/index.js';
import { assertSshSessionAccess } from '@/modules/providers/services/ssh-session-access.service.js';
import type { ClaudeAccountLaunchSnapshot } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

const HISTORY_DIRECTORIES = ['projects', 'file-history', 'shell-snapshots', 'todos', 'tasks', 'plans', 'session-env', 'paste-cache', 'transcripts'] as const;
const OWNER_MARKER = '.chisa-history-owner.json';
const RUNTIME_MARKER = '.chisa-runtime-owner.json';
const SESSION_ID = /^[a-zA-Z0-9_-]{1,200}$/;
const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_COPY_FILES = 1_024;
const MAX_COPY_BYTES = 256 * 1024 * 1024;
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const rootListeners = new Set<(home: string, userId: number) => void>();
const preparations = new Map<string, Promise<void>>();

type ResumeOptions = { sessionId?: string | null; providerSessionId?: string | null; cwd?: string };
type Artifact = { filePath: string; home: string; userId: number | null };
type CopyFile = { source: string; relative: string; size: number };

function conflict(message: string, code = 'CLAUDE_HISTORY_CONFLICT'): never {
  throw new AppError(message, { code, statusCode: 409 });
}
function missingResume(): never {
  return conflict('The Claude conversation transcript is unavailable in this account. Restore its history before resuming.', 'CLAUDE_RESUME_HISTORY_MISSING');
}
function samePath(left: string, right: string): boolean {
  const normalized = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalized(left) === normalized(right);
}
function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function userRoot(userId: number): string {
  if (!Number.isSafeInteger(userId) || userId <= 0 || !userDb.getUserById(userId)) {
    conflict('The Claude history account is unavailable.', 'CLAUDE_HISTORY_OWNER_INVALID');
  }
  return path.join(path.dirname(getDatabasePath()), 'claude-accounts', 'users', String(userId));
}
function defaultHome(): string {
  return path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
}
async function statOrNull(target: string) {
  try { return await lstat(target); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

// Walk parent-first, never mkdir through a symlink/junction or silently accept a canonical alias.
async function plainDirectory(target: string, create = false): Promise<boolean> {
  const absolute = path.resolve(target);
  const root = path.parse(absolute).root;
  let current = root;
  for (const component of path.relative(root, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let metadata = await statOrNull(current);
    if (!metadata) {
      if (!create) return false;
      try { await mkdir(current, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      metadata = await lstat(current);
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || !samePath(await realpath(current), current)) {
      conflict('Claude history contains an unexpected linked or non-directory path.', 'CLAUDE_HISTORY_PATH_INVALID');
    }
  }
  return true;
}
async function readRegular(file: string, maximum = MAX_FILE_BYTES): Promise<Buffer> {
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximum) {
    conflict('Claude history contains an unsafe or oversized file.', 'CLAUDE_HISTORY_PATH_INVALID');
  }
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > maximum || before.ino !== opened.ino || before.dev !== opened.dev) {
      conflict('Claude history changed while it was being read.', 'CLAUDE_HISTORY_PATH_INVALID');
    }
    const contents = await handle.readFile();
    const after = await handle.stat();
    if (contents.length > maximum) conflict('Claude history exceeded the transfer limit.', 'CLAUDE_HISTORY_COPY_LIMIT');
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || contents.length !== opened.size) {
      conflict('Claude history changed while it was being read. Retry after the conversation is idle.', 'CLAUDE_HISTORY_DESTINATION_EXISTS');
    }
    return contents;
  } finally { await handle.close(); }
}
async function readOwner(file: string): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse((await readRegular(file, 4_096)).toString('utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch (error) { if (error instanceof AppError) throw error; }
  return conflict('Claude history ownership could not be verified.', 'CLAUDE_HISTORY_OWNER_INVALID');
}
async function ownedDirectory(home: string, userId: number, kind: 'history' | 'runtime', create: boolean): Promise<boolean> {
  if (!(await plainDirectory(home, create))) return false;
  const marker = path.join(home, kind === 'history' ? OWNER_MARKER : RUNTIME_MARKER);
  if (!(await statOrNull(marker))) {
    if (!create) return false;
    if ((await readdir(home)).length !== 0) conflict('Existing Claude history has no matching account ownership marker.', 'CLAUDE_HISTORY_OWNER_INVALID');
    try {
      const handle = await open(marker, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify({ version: 1, userId, kind }) + '\n'); }
      finally { await handle.close(); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  const owner = await readOwner(marker);
  if (owner.version !== 1 || owner.userId !== userId || owner.kind !== kind) {
    conflict('Claude history belongs to a different account.', 'CLAUDE_HISTORY_OWNER_INVALID');
  }
  return true;
}
async function managedProfile(userId: number, accountId: string, configDir: string): Promise<void> {
  if (!ACCOUNT_ID.test(accountId) || !claudeAccountsDb.get(userId, accountId)) {
    conflict('The Claude account profile is not registered for this user.', 'CLAUDE_HISTORY_OWNER_INVALID');
  }
  const expected = path.join(userRoot(userId), 'profiles', accountId, 'home');
  if (!samePath(configDir, expected) || !(await plainDirectory(expected))) {
    conflict('The Claude account profile path does not match its owner.', 'CLAUDE_HISTORY_PATH_INVALID');
  }
  const owner = await readOwner(path.join(path.dirname(expected), 'owner.json'));
  if (owner.version !== 1 || owner.userId !== userId || owner.accountId !== accountId) {
    conflict('The Claude account profile belongs to a different user.', 'CLAUDE_HISTORY_OWNER_INVALID');
  }
}
async function linkHistory(home: string, history: string): Promise<void> {
  // Preflight every destination before replacing even an empty directory.
  for (const name of HISTORY_DIRECTORIES) {
    const target = path.join(home, name);
    const metadata = await statOrNull(target);
    if (!metadata) continue;
    if (metadata.isSymbolicLink()) {
      if (!samePath(await realpath(target), path.join(history, name))) {
        conflict('This Claude profile links history belonging to another account.', 'CLAUDE_HISTORY_OWNER_INVALID');
      }
    } else if (!metadata.isDirectory() || (await readdir(target)).length !== 0) {
      conflict('This Claude profile already contains history. Its existing data was preserved; move the authorized conversation explicitly before switching.');
    }
  }
  for (const name of HISTORY_DIRECTORIES) {
    const shared = path.join(history, name);
    await plainDirectory(shared, true);
    const target = path.join(home, name);
    const metadata = await statOrNull(target);
    if (metadata?.isSymbolicLink()) continue;
    if (metadata) await rmdir(target); // Only the already verified empty directory, never user content.
    try { await symlink(shared, target, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !samePath(await realpath(target), shared)) throw error;
    }
  }
}
async function prepareHome(userId: number, home: string, kind: 'profile' | 'runtime', accountId?: string): Promise<string> {
  const history = path.join(userRoot(userId), 'history');
  // Different account profiles of one user can initialize concurrently; serialize their shared marker/link setup.
  const key = userRoot(userId);
  const previous = preparations.get(key) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    await ownedDirectory(history, userId, 'history', true);
    if (kind === 'profile') await managedProfile(userId, accountId!, home);
    else await ownedDirectory(home, userId, 'runtime', true);
    await linkHistory(home, history);
    for (const listener of rootListeners) listener(history, userId);
  });
  preparations.set(key, operation);
  try { await operation; }
  finally { if (preparations.get(key) === operation) preparations.delete(key); }
  return history;
}

/** Claude synchronizers/watchers enumerate only DB-known users' verified central histories, including API-only users. */
export async function claudeHistoryRoots(): Promise<Array<{ userId: number; home: string }>> {
  const roots: Array<{ userId: number; home: string }> = [];
  for (const id of userDb.getActiveUserIds()) {
    const userId = Number(id);
    const home = path.join(userRoot(userId), 'history');
    try { if (await ownedDirectory(home, userId, 'history', false)) roots.push({ userId, home }); }
    catch { /* A foreign/tampered root is never scanned or watched. */ }
  }
  return roots;
}

/** Session watchers observe newly prepared canonical histories without following managed-profile aliases. */
export function onClaudeHistoryRoot(listener: (home: string, userId: number) => void): () => void {
  rootListeners.add(listener);
  return () => { rootListeners.delete(listener); };
}

/** Claude's scanner resolves trusted profile aliases to central files so deleting a profile cannot invalidate the session index. */
export async function resolveClaudeHistoryArtifact(file: string): Promise<Artifact | null> {
  const absolute = path.resolve(file);
  const activeUsers = new Set(userDb.getActiveUserIds());
  const accountNamespace = path.join(path.dirname(getDatabasePath()), 'claude-accounts', 'users');
  const configuredDefault = defaultHome();
  const homes: Array<{ home: string; userId: number | null; accountId?: string }> = [
    ...(await claudeHistoryRoots()),
    ...claudeAccountsDb.listAll().filter((account) => activeUsers.has(String(account.userId)) && ACCOUNT_ID.test(account.id))
      .map((account) => ({ userId: account.userId, accountId: account.id, home: path.join(userRoot(account.userId), 'profiles', account.id, 'home') })),
    // A forged global config pointing into managed storage cannot erase that path's user ownership.
    ...(!samePath(configuredDefault, accountNamespace) && !isInside(accountNamespace, configuredDefault) ? [{ home: configuredDefault, userId: null }] : []),
  ];
  for (const candidate of homes) {
    const projects = path.join(candidate.home, 'projects');
    if (!isInside(projects, absolute)) continue;
    const relative = path.relative(projects, absolute);
    if (relative.split(path.sep).length !== 2 || !relative.endsWith('.jsonl')) return null;
    try {
      if (candidate.accountId) await managedProfile(candidate.userId!, candidate.accountId, candidate.home);
      let canonicalProjects = projects;
      const metadata = await statOrNull(projects);
      if (metadata?.isSymbolicLink() && candidate.userId !== null) {
        const historyHome = path.join(userRoot(candidate.userId), 'history');
        if (!(await ownedDirectory(historyHome, candidate.userId, 'history', false))) return null;
        canonicalProjects = path.join(historyHome, 'projects');
        if (!samePath(await realpath(projects), canonicalProjects)) return null;
      }
      if (!(await plainDirectory(path.dirname(path.join(canonicalProjects, relative))))) return null;
      const canonical = path.join(canonicalProjects, relative);
      const stat = await lstat(canonical);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !samePath(await realpath(absolute), canonical)) return null;
      return { filePath: canonical, home: candidate.accountId && !samePath(canonicalProjects, projects) ? path.dirname(canonicalProjects) : candidate.home, userId: candidate.userId };
    } catch { return null; }
  }
  return null;
}
async function transcriptIdentity(file: string, providerSessionId: string, cwd?: string): Promise<void> {
  const text = (await readRegular(file)).toString('utf8');
  let matched = false;
  let observedCwd: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry: unknown;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.sessionId === 'string' && record.sessionId !== providerSessionId) {
      conflict('The Claude transcript does not match the requested conversation.', 'CLAUDE_HISTORY_SESSION_MISMATCH');
    }
    matched ||= record.sessionId === providerSessionId;
    if (typeof record.cwd === 'string') observedCwd ??= record.cwd;
    if (matched && observedCwd) break;
  }
  if (!matched) conflict('The Claude transcript identity could not be verified.', 'CLAUDE_HISTORY_SESSION_MISMATCH');
  if (cwd && observedCwd && !samePath(cwd, observedCwd)) {
    conflict('The Claude conversation was recorded in a different working directory. Resume it from its original workspace.', 'CLAUDE_HISTORY_CWD_MISMATCH');
  }
}
async function planTransfer(source: string, providerSessionId: string): Promise<CopyFile[]> {
  const files: CopyFile[] = [];
  let bytes = 0;
  const add = async (file: string, relative: string) => {
    const metadata = await lstat(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) conflict('A Claude conversation attachment is linked or unsafe.', 'CLAUDE_HISTORY_PATH_INVALID');
    bytes += metadata.size;
    if (metadata.size > MAX_FILE_BYTES || bytes > MAX_COPY_BYTES || files.length >= MAX_COPY_FILES) {
      conflict('This Claude conversation exceeds the bounded history transfer limit.', 'CLAUDE_HISTORY_COPY_LIMIT');
    }
    files.push({ source: file, relative, size: metadata.size });
  };
  await add(source, `${providerSessionId}.jsonl`);
  let directories = 0;
  const visit = async (directory: string, relative: string, depth: number): Promise<void> => {
    if (depth > 6 || ++directories > 128 || !(await plainDirectory(directory))) conflict('The Claude conversation subtree is too deep or unavailable.', 'CLAUDE_HISTORY_COPY_LIMIT');
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.length > MAX_COPY_FILES) conflict('The Claude conversation has too many attachments.', 'CLAUDE_HISTORY_COPY_LIMIT');
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) conflict('Linked Claude conversation attachments cannot be transferred.', 'CLAUDE_HISTORY_PATH_INVALID');
      if (entry.isDirectory()) await visit(file, path.join(relative, entry.name), depth + 1);
      else await add(file, path.join(relative, entry.name));
    }
  };
  const subtree = path.join(path.dirname(source), providerSessionId);
  if (await statOrNull(subtree)) await visit(subtree, providerSessionId, 0);
  return files;
}
function continuation(target: Buffer, source: Buffer, appendOnly: boolean): 'same' | 'append' | 'ahead' {
  if (target.equals(source)) return 'same';
  if (appendOnly && source.length > target.length && source.subarray(0, target.length).equals(target)) return 'append';
  if (appendOnly && target.length > source.length && target.subarray(0, source.length).equals(source)) return 'ahead';
  return conflict('The Claude conversation has diverged between accounts. Both copies were preserved.', 'CLAUDE_HISTORY_DESTINATION_EXISTS');
}
async function syncExistingTranscript(source: string, target: string, expected: Buffer, appendOnly: boolean): Promise<void> {
  await plainDirectory(path.dirname(target));
  const before = await lstat(target);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_FILE_BYTES) {
    conflict('The existing Claude transcript is unsafe.', 'CLAUDE_HISTORY_PATH_INVALID');
  }
  // O_APPEND never truncates or rewrites the destination. The fd identity and byte snapshot must still match before writing.
  const handle = await open(target, constants.O_RDWR | constants.O_APPEND | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.size !== before.size || opened.ino !== before.ino || opened.dev !== before.dev) {
      conflict('Claude history changed before synchronization. Retry when idle.', 'CLAUDE_HISTORY_DESTINATION_EXISTS');
    }
    const current = await handle.readFile();
    const checked = await handle.stat();
    const atPath = await lstat(target);
    const sourceNow = await readRegular(source);
    if (!expected.equals(sourceNow) || current.length !== opened.size || checked.size !== opened.size || checked.mtimeMs !== opened.mtimeMs || checked.ctimeMs !== opened.ctimeMs || atPath.isSymbolicLink() || atPath.ino !== opened.ino || atPath.dev !== opened.dev || atPath.nlink !== 1 || !samePath(await realpath(target), target)) {
      conflict('Claude history changed during synchronization. Retry when idle.', 'CLAUDE_HISTORY_DESTINATION_EXISTS');
    }
    if (continuation(current, expected, appendOnly) !== 'append') return;
    const suffix = expected.subarray(current.length);
    const written = await handle.write(suffix, 0, suffix.length, null);
    if (written.bytesWritten !== suffix.length) conflict('Claude history synchronization did not finish. Retry after the conversation is idle.', 'CLAUDE_HISTORY_DESTINATION_EXISTS');
    await handle.sync();
    const final = await handle.stat();
    const finalPath = await lstat(target);
    if (final.size !== expected.length || final.nlink !== 1 || finalPath.isSymbolicLink() || finalPath.ino !== final.ino || finalPath.dev !== final.dev) {
      conflict('Claude history changed while the continuation was appended. Both copies were preserved.', 'CLAUDE_HISTORY_DESTINATION_EXISTS');
    }
  } finally { await handle.close(); }
}
async function transferConversation(source: string, destination: string, providerSessionId: string): Promise<void> {
  if (samePath(source, destination)) return;
  const files = await planTransfer(source, providerSessionId);
  const destinationDirectory = path.dirname(destination);
  await plainDirectory(destinationDirectory, true);
  for (const file of files) {
    const target = path.join(destinationDirectory, file.relative);
    const metadata = await statOrNull(target);
    if (!metadata) continue;
    await plainDirectory(path.dirname(target));
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) conflict('The existing Claude history file is unsafe.', 'CLAUDE_HISTORY_PATH_INVALID');
    continuation(await readRegular(target), await readRegular(file.source), file.relative.endsWith('.jsonl'));
  }
  // Publish the main JSONL last; rejected subtrees never become resumable half-imports.
  for (const file of [...files.slice(1), files[0]!]) {
    const target = path.join(destinationDirectory, file.relative);
    await plainDirectory(path.dirname(target), true);
    const content = await readRegular(file.source, file.size);
    if (await statOrNull(target)) {
      await syncExistingTranscript(file.source, target, content, file.relative.endsWith('.jsonl'));
      continue;
    }
    try {
      const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
      try { await handle.writeFile(content); } finally { await handle.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await syncExistingTranscript(file.source, target, content, file.relative.endsWith('.jsonl'));
    }
  }
}
async function prepareResume(userId: number, targetHome: string, options: ResumeOptions): Promise<void> {
  const providerSessionId = options.providerSessionId;
  if (providerSessionId === null || providerSessionId === undefined) return;
  if (!SESSION_ID.test(providerSessionId) || !options.sessionId) missingResume();
  const row = sessionsDb.getSessionById(options.sessionId) ?? sessionsDb.getSessionByProviderSessionId(options.sessionId);
  if (!row || row.provider !== 'claude' || (row.provider_session_id ?? row.session_id) !== providerSessionId || !row.jsonl_path) missingResume();
  assertSshSessionAccess(row.session_id, userId);
  const artifact = await resolveClaudeHistoryArtifact(row.jsonl_path);
  if (!artifact) missingResume();
  if (artifact.userId !== null && artifact.userId !== userId) {
    conflict('This Claude conversation history belongs to another Chisa user.', 'CLAUDE_HISTORY_OWNER_INVALID');
  }
  if (path.basename(artifact.filePath) !== `${providerSessionId}.jsonl`) {
    conflict('The indexed Claude transcript filename does not match this conversation.', 'CLAUDE_HISTORY_SESSION_MISMATCH');
  }
  await transcriptIdentity(artifact.filePath, providerSessionId, options.cwd);
  if (options.cwd && path.basename(path.dirname(artifact.filePath)) !== options.cwd.replace(/[^a-zA-Z0-9-]/g, '-')) {
    conflict('The Claude conversation is stored under a different workspace path. Its history was preserved.', 'CLAUDE_HISTORY_CWD_MISMATCH');
  }
  const relative = path.relative(path.join(artifact.home, 'projects'), artifact.filePath);
  if (relative.split(path.sep).length !== 2) missingResume();
  const target = path.join(targetHome, 'projects', relative);
  await transferConversation(artifact.filePath, target, providerSessionId);
  // Index the actual destination so later CLI appends are visible. Managed targets are always canonical central paths;
  // the explicitly chosen legacy default is stable and never a removable profile alias.
  const canonicalTarget = await realpath(target);
  sessionsDb.createSession(providerSessionId, 'claude', row.project_path!, row.custom_name ?? undefined, row.created_at, row.updated_at, canonicalTarget);
}

/** Claude runtime prepares a captured account without sharing auth/settings/process registries; only an authorized single conversation may migrate. */
export async function prepareClaudeAccountHistory(snapshot: ClaudeAccountLaunchSnapshot, options: ResumeOptions = {}): Promise<void> {
  userRoot(snapshot.userId);
  if (snapshot.accountId === 'default') {
    const users = userDb.getActiveUserIds();
    if (users.length !== 1 || users[0] !== String(snapshot.userId) || !samePath(snapshot.configDir, defaultHome())) {
      conflict('The shared default Claude history is unavailable for this Chisa account.', 'CLAUDE_HISTORY_OWNER_INVALID');
    }
    await plainDirectory(snapshot.configDir);
    await prepareResume(snapshot.userId, snapshot.configDir, options);
    return;
  }
  const history = await prepareHome(snapshot.userId, snapshot.configDir, 'profile', snapshot.accountId);
  await prepareResume(snapshot.userId, history, options);
}

/** API/HiRoute runs use a per-user config home with private shared history, never the default Claude auth/config directory. */
export async function prepareClaudeUserHistory(userId: number, options: ResumeOptions = {}): Promise<string> {
  const home = path.join(userRoot(userId), 'runtime-home');
  const history = await prepareHome(userId, home, 'runtime');
  await prepareResume(userId, history, options);
  return home;
}
