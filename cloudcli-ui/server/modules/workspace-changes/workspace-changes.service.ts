import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync, closeSync, constants, existsSync, fchmodSync, fstatSync, fsyncSync, linkSync,
  lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync,
  renameSync, symlinkSync, unlinkSync, writeFileSync, type Stats,
} from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// These contracts are private to this self-contained component. Consumers infer
// method inputs/results through the factory; no bridge/shared definitions move here.
type Gate = {
  assertPinned: () => void;
  withLock: <T>(operation: () => Promise<T>) => Promise<T>;
  signal?: AbortSignal;
};
type IdentityInput = Gate & { sessionId: string; executionRoot: string; sourceRoot: string; stateRoot?: string };
type TargetInput = IdentityInput & { targetRoot: string };
type InspectionInput = Omit<TargetInput, 'withLock'> & { operationId?: string };
type GitRunner = (args: string[], cwd: string, signal?: AbortSignal, input?: Buffer) => Promise<{
  code: number | null; stdout: Buffer; stderr: Buffer | string;
}>;
type Limits = { maxEntries: number; maxFileBytes: number; maxSnapshotBytes: number; maxMetadataBytes: number; gitTimeoutMs: number };
type RootIdentity = { path: string; device: string; inode: string; birthtime: number };
type Entry = { type: 'file' | 'symlink' | 'directory'; mode: number; blob?: string };
type GitEntry = { path: string; mode: string; oid: string; stage: number; blob?: string };
type GitState = {
  directory: string; head: string | null; headRef: string | null; index: string | null;
  sharedIndexes: { name: string; blob: string }[]; stages: GitEntry[]; headEntries: GitEntry[];
  operations: string[];
};
type Snapshot = { version: 1; revision: string; root: RootIdentity; entries: Record<string, Entry>; opaque: string[]; git: GitState | null };
type Context = {
  input: Omit<IdentityInput, 'withLock'>; execution: RootIdentity; source: RootIdentity; state: string; limits: Limits;
  pin: () => void;
};
type Baseline = {
  version: 1; baselineId: string; sessionId: string; execution: RootIdentity; source: RootIdentity;
  snapshotRevision: string; createdAt: string;
};
type Conflict = { path: string; reason: string; base: Entry | null; source: Entry | null; target: Entry | null; mergedBlob?: string };
type Change = { path: string; kind: 'add' | 'modify' | 'delete' | 'type'; before: Entry | null; after: Entry | null };
type Checkpoint = { version: 1; revision: string; baselineId: string; target: RootIdentity; sourceRevision: string; lastOperationId: string | null };
type Preview = {
  version: 1; previewId: string; baselineId: string; sessionId: string; execution: RootIdentity; target: RootIdentity;
  baseRevision: string; sourceRevision: string; targetRevision: string; checkpointRevision: string;
  changes: Change[]; conflicts: Conflict[]; createdAt: string;
};
type Receipt = {
  version: 1; operationId: string; previewId: string; baselineId: string; target: RootIdentity;
  sourceRevision: string; originalTargetRevision: string; targetRevision: string; checkpointRevision: string;
  changedPaths: string[]; committedAt: string;
};
type Journal = {
  version: 1; operationId: string; preview: Preview; phase: 'prepared' | 'applying' | 'applied' | 'committed';
  completed: string[]; scratch: string; receipt?: Receipt;
};

class ChangesError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details?: unknown;
  constructor(code: string, message: string, details?: unknown, statusCode = 409) {
    super(message); this.name = 'WorkspaceChangesError'; this.code = code; this.statusCode = statusCode; this.details = details;
  }
}

const defaults: Limits = { maxEntries: 100_000, maxFileBytes: 64 * 1024 * 1024, maxSnapshotBytes: 512 * 1024 * 1024, maxMetadataBytes: 32 * 1024 * 1024, gitTimeoutMs: 30_000 };
const reserved = new Set(['.git', '.chisa-bridge.json', '.chisa-session.json', '.chisa-lease', '.chisa-worktrees', '.chisa-state']);
const dependencies = new Set(['node_modules', '.venv', 'venv', '__pycache__']);
const generated = new Set(['dist', 'build', 'out', '.next', 'coverage', '.cache', 'cache', '.tmp', '.dev', '.nodetmp']);
const gitOperations = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer'];
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const encoded = (value: unknown) => JSON.stringify(value);
const same = (a: unknown, b: unknown) => encoded(a) === encoded(b);
const entryAt = (snapshot: Snapshot, name: string): Entry | null => Object.hasOwn(snapshot.entries, name) ? snapshot.entries[name]! : null;
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const within = (root: string, candidate: string) => candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
const targetKey = (target: RootIdentity) => hash(encoded(target));
const fail = (code: string, message: string, details?: unknown): never => { throw new ChangesError(code, message, details); };

function rootIdentity(root: string): RootIdentity {
  if (!path.isAbsolute(root)) fail('WORKSPACE_CHANGES_PATH', 'Workspace roots must be absolute');
  const resolved = path.resolve(root);
  const stats = lstatSync(resolved);
  if (!stats.isDirectory() || stats.isSymbolicLink() || realpathSync(resolved) !== resolved) {
    fail('WORKSPACE_CHANGES_PATH', 'Workspace root is not a canonical directory');
  }
  return { path: resolved, device: String(stats.dev), inode: String(stats.ino), birthtime: stats.birthtimeMs };
}

function safeRelative(name: string): string {
  if (!name || name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[a-z]:/i.test(name) || name.split('/').some(part => !part || part === '.' || part === '..')) {
    fail('WORKSPACE_CHANGES_PATH', 'Unsafe workspace-relative path', { path: name });
  }
  // Case-insensitive filesystem aliases and NTFS alternate data streams must
  // never turn a project path into a metadata path or a different file.
  if (name.split('/').some(part => part.includes(':') || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    fail('WORKSPACE_CHANGES_PATH', 'Non-portable workspace path cannot be integrated safely', { path: name });
  }
  return name;
}

function privateDirectory(directory: string): void {
  const absolute = path.resolve(directory);
  const missing: string[] = [];
  let cursor = absolute;
  while (!existsSync(cursor)) {
    missing.push(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) fail('WORKSPACE_CHANGES_PATH', 'State directory has no existing parent');
    cursor = parent;
  }
  const existing = lstatSync(cursor);
  if (!existing.isDirectory() || existing.isSymbolicLink() || realpathSync(cursor) !== cursor) fail('WORKSPACE_CHANGES_PATH', 'State directory must not traverse symbolic links');
  for (const item of missing.reverse()) {
    try { mkdirSync(item, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const stats = lstatSync(item);
    if (!stats.isDirectory() || stats.isSymbolicLink() || realpathSync(item) !== item) fail('WORKSPACE_CHANGES_PATH', 'State directory identity changed');
  }
}

function syncDirectory(directory: string): void {
  if (process.platform === 'win32') return;
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function readBytes(filename: string, limit: number): Buffer {
  const before = lstatSync(filename);
  if (!before.isFile() || before.isSymbolicLink() || before.size > limit) fail('WORKSPACE_CHANGES_UNSAFE_FILE', 'Unsafe or oversized regular file', { path: filename });
  const fd = openSync(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const actual = fstatSync(fd);
    if (!actual.isFile() || actual.dev !== before.dev || actual.ino !== before.ino || actual.size > limit) fail('WORKSPACE_SNAPSHOT_CHANGED', 'A file changed identity during capture');
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    if (bytes.length > limit || actual.size !== after.size || actual.mtimeMs !== after.mtimeMs || actual.ctimeMs !== after.ctimeMs) fail('WORKSPACE_SNAPSHOT_CHANGED', 'A file changed while its contents were read');
    return bytes;
  } finally { closeSync(fd); }
}

function stateFingerprint(stats: Stats): string {
  if (!stats.isFile() || stats.isSymbolicLink()) fail('WORKSPACE_CHANGES_STATE_CORRUPT', 'State file is not regular');
  return encoded([stats.dev, stats.ino, stats.birthtimeMs, stats.size, stats.mtimeMs, stats.ctimeMs, stats.mode, stats.nlink]);
}

function stateFileFingerprint(filename: string): string | null {
  try { return stateFingerprint(lstatSync(filename)); }
  catch (error) { if (absent(error)) return null; throw error; }
}

function createTemporary(directory: string, data: Buffer | string) {
  const parent = rootIdentity(directory);
  const filename = path.join(directory, '.write-' + randomUUID());
  const fd = openSync(filename, 'wx', 0o600);
  let identity: Stats | undefined; let closed = false;
  const discard = () => {
    // Cleanup must neither hide the original failure nor delete a replacement
    // file reached through the same temporary name or a replaced parent.
    try {
      if (!identity || !same(existingDirectory(directory), parent)) return;
      const current = lstatSync(filename);
      if (current.isFile() && !current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino && current.birthtimeMs === identity.birthtimeMs) unlinkSync(filename);
    } catch { /* An unremovable private temporary is safe to leave for diagnosis. */ }
  };
  try {
    identity = fstatSync(fd);
    writeFileSync(fd, data); fsyncSync(fd);
    try { closeSync(fd); } finally { closed = true; }
    const prepared = lstatSync(filename);
    if (!same(existingDirectory(directory), parent) || prepared.dev !== identity.dev || prepared.ino !== identity.ino || prepared.birthtimeMs !== identity.birthtimeMs || prepared.size !== Buffer.byteLength(data) || prepared.nlink !== 1) fail('WORKSPACE_CHANGES_STATE_CORRUPT', 'Prepared state file changed before publication');
    return { filename, fingerprint: stateFingerprint(prepared), discard };
  } catch (error) {
    if (!closed) { try { closeSync(fd); } catch { /* Preserve the write/fsync failure. */ } }
    discard(); throw error;
  }
}

function durableWrite(filename: string, data: Buffer | string, immutable = false): void {
  privateDirectory(path.dirname(filename));
  if (existsSync(filename) && immutable) {
    const current = readBytes(filename, Math.max(Buffer.byteLength(data), defaults.maxMetadataBytes));
    if (!current.equals(Buffer.isBuffer(data) ? data : Buffer.from(data))) fail('WORKSPACE_CHANGES_STATE_CORRUPT', 'Immutable state content does not match its name');
    return;
  }
  if (existsSync(filename) && !lstatSync(filename).isFile()) fail('WORKSPACE_CHANGES_STATE_CORRUPT', 'State file is not regular');
  const temporary = createTemporary(path.dirname(filename), data);
  try {
    if (immutable) {
      try { linkSync(temporary.filename, filename); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const bytes = readBytes(filename, Math.max(Buffer.byteLength(data), defaults.maxMetadataBytes));
        if (!bytes.equals(Buffer.isBuffer(data) ? data : Buffer.from(data))) fail('WORKSPACE_CHANGES_STATE_CORRUPT', 'Concurrent immutable state collision');
      }
      unlinkSync(temporary.filename);
    } else renameSync(temporary.filename, filename);
    syncDirectory(path.dirname(filename));
  } catch (error) { temporary.discard(); throw error; }
}

// Keep one closed, fsynced temporary across Windows replacement failures rather
// than creating a new file for each retry. The first rename remains synchronous.
function replaceState(context: Context, target: RootIdentity, filename: string, data: string): void | Promise<void> {
  const directory = path.dirname(filename);
  const parent = rootIdentity(directory);
  const expected = stateFileFingerprint(filename);
  const temporary = createTemporary(directory, data);
  const retryable = (error: unknown) => {
    const failure = error as NodeJS.ErrnoException & { path?: string; dest?: string };
    return process.platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes(failure.code ?? '') && failure.syscall === 'rename' && failure.dest === filename && failure.path === temporary.filename;
  };
  try { renameSync(temporary.filename, filename); }
  catch (error) {
    if (!retryable(error)) { temporary.discard(); throw error; }
    return (async () => {
      let failure = error; let renamed = false;
      try {
        for (const milliseconds of [10, 25, 50, 100, 200, 400, 800, 1000]) {
          await delay(milliseconds, undefined, { signal: context.input.signal });
          requireTarget(context, target);
          if (!same(existingDirectory(directory), parent) || stateFileFingerprint(filename) !== expected || stateFileFingerprint(temporary.filename) !== temporary.fingerprint) fail('WORKSPACE_CHANGES_STATE_CORRUPT', 'Integration state changed while its atomic replacement was waiting');
          try { renameSync(temporary.filename, filename); }
          catch (next) { if (!retryable(next)) throw next; failure = next; continue; }
          renamed = true; syncDirectory(directory); return;
        }
        throw failure;
      } catch (error) { if (!renamed) temporary.discard(); throw error; }
    })();
  }
  syncDirectory(directory);
}

function readJson<T>(filename: string, limit: number): T {
  try { return JSON.parse(readBytes(filename, limit).toString('utf8')) as T; }
  catch (error) {
    if (absent(error) || error instanceof ChangesError) throw error;
    return fail('WORKSPACE_CHANGES_STATE_CORRUPT', 'Persistent workspace change state is invalid', { path: filename });
  }
}

function putBlob(context: Context, bytes: Buffer): string {
  if (bytes.length > context.limits.maxFileBytes) fail('WORKSPACE_CHANGES_LIMIT', 'A file exceeds the configured snapshot size limit');
  const digest = hash(bytes);
  durableWrite(path.join(context.state, 'objects', digest), bytes, true);
  return digest;
}

function getBlob(context: Context, digest: string): Buffer {
  if (!/^[a-f0-9]{64}$/.test(digest)) fail('WORKSPACE_CHANGES_STATE_CORRUPT', 'Invalid stored content identifier');
  const bytes = readBytes(path.join(context.state, 'objects', digest), context.limits.maxFileBytes);
  if (hash(bytes) !== digest) fail('WORKSPACE_CHANGES_STATE_CORRUPT', 'Stored snapshot content failed verification');
  return bytes;
}

function snapshotPath(context: Context, revision: string): string {
  if (!/^[a-f0-9]{64}$/.test(revision)) fail('WORKSPACE_CHANGES_STATE_CORRUPT', 'Invalid snapshot revision');
  return path.join(context.state, 'snapshots', revision + '.json');
}

function loadSnapshot(context: Context, revision: string): Snapshot {
  const value = readJson<Snapshot>(snapshotPath(context, revision), context.limits.maxMetadataBytes);
  const { revision: stored, ...body } = value;
  if (stored !== revision || hash(encoded(body)) !== revision || value.version !== 1) fail('WORKSPACE_CHANGES_STATE_CORRUPT', 'Stored snapshot manifest failed verification');
  for (const [name, entry] of Object.entries(value.entries)) {
    safeRelative(name);
    if (!['file', 'symlink', 'directory'].includes(entry.type)) fail('WORKSPACE_CHANGES_STATE_CORRUPT', 'Unknown snapshot entry type');
  }
  return value;
}

function existingDirectory(directory: string): RootIdentity | null {
  const absolute = path.resolve(directory);
  let cursor = absolute;
  while (true) {
    try {
      const identity = rootIdentity(cursor);
      return cursor === absolute ? identity : null;
    } catch (error) {
      if (!absent(error)) throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      cursor = parent;
    }
  }
}

function makeContext(input: Omit<IdentityInput, 'withLock'>, limits: Limits, createState = true): Context {
  if (!input.sessionId || input.sessionId.length > 256 || input.sessionId.includes('\0') || typeof input.assertPinned !== 'function' || (createState && (!('withLock' in input) || typeof input.withLock !== 'function'))) fail('WORKSPACE_CHANGES_INPUT', 'Session identity and caller-owned writer gate are required');
  input.signal?.throwIfAborted(); input.assertPinned();
  const execution = rootIdentity(input.executionRoot);
  const source = rootIdentity(input.sourceRoot);
  const state = path.resolve(input.stateRoot ?? execution.path + '.chisa-state/changes');
  if (within(execution.path, state) || within(source.path, state) || within(state, execution.path) || within(state, source.path)) fail('WORKSPACE_CHANGES_PATH', 'Snapshot storage must be outside execution and source roots');
  if (createState) privateDirectory(state);
  const stateIdentity = existingDirectory(state);
  const context: Context = { input, execution, source, state, limits, pin: () => {
    input.signal?.throwIfAborted(); input.assertPinned();
    if (!same(rootIdentity(execution.path), execution) || !same(rootIdentity(source.path), source)) fail('WORKSPACE_CHANGES_IDENTITY', 'Workspace root identity changed');
    if (!same(existingDirectory(state), stateIdentity)) fail('WORKSPACE_CHANGES_IDENTITY', 'Snapshot storage identity changed');
  } };
  context.pin();
  return context;
}

function targetIdentity(context: Context, root: string): RootIdentity {
  const target = rootIdentity(root);
  if (within(context.execution.path, target.path) || within(target.path, context.execution.path) || within(target.path, context.state) || within(context.state, target.path)) fail('WORKSPACE_CHANGES_PATH', 'Target and execution/state roots must be disjoint');
  return target;
}

function requireTarget(context: Context, target: RootIdentity): void {
  context.pin();
  if (!same(rootIdentity(target.path), target)) fail('WORKSPACE_CHANGES_IDENTITY', 'Integration target identity changed');
}

function baseline(context: Context): Baseline | null {
  const filename = path.join(context.state, 'baseline.json');
  if (!existsSync(filename)) return null;
  const value = readJson<Baseline>(filename, context.limits.maxMetadataBytes);
  if (value.version !== 1 || value.sessionId !== context.input.sessionId || !same(value.execution, context.execution) || !same(value.source, context.source)) fail('WORKSPACE_CHANGES_IDENTITY', 'Baseline belongs to a different session or source');
  if (value.baselineId !== hash(encoded([value.sessionId, value.execution, value.source, value.snapshotRevision]))) fail('WORKSPACE_CHANGES_STATE_CORRUPT', 'Baseline identity failed verification');
  loadSnapshot(context, value.snapshotRevision);
  return value;
}

function requireBaseline(context: Context): Baseline {
  return baseline(context) ?? fail('WORKSPACE_BASELINE_UNAVAILABLE', 'This session has no verified initial baseline; its current result cannot be used to invent one');
}

function targetDirectory(context: Context, target: RootIdentity): string {
  const directory = path.join(context.state, 'targets', targetKey(target));
  privateDirectory(directory);
  return directory;
}

function checkpoint(context: Context, base: Baseline, target: RootIdentity): Checkpoint {
  const filename = path.join(targetDirectory(context, target), 'checkpoint.json');
  if (existsSync(filename)) {
    const value = readJson<Checkpoint>(filename, context.limits.maxMetadataBytes);
    const { revision, ...body } = value;
    if (value.version !== 1 || revision !== hash(encoded(body)) || value.baselineId !== base.baselineId || !same(value.target, target)) fail('WORKSPACE_CHANGES_STATE_CORRUPT', 'Invalid integration checkpoint');
    return value;
  }
  const body = { version: 1 as const, baselineId: base.baselineId, target, sourceRevision: base.snapshotRevision, lastOperationId: null };
  return { revision: hash(encoded(body)), ...body };
}

function defaultGit(limits: Limits): GitRunner {
  return (args, cwd, signal, input) => new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const environment = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1' };
    // A server process may itself have been started from a Git hook/worktree.
    // Its inherited repository selectors must not override the pinned cwd.
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete (environment as Record<string, string | undefined>)[key];
    const child = spawn('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args], {
      cwd, windowsHide: true, signal, env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = []; const stderr: Buffer[] = [];
    let bytes = 0; let error: Error | undefined;
    const timer = setTimeout(() => { error = new ChangesError('WORKSPACE_CHANGES_GIT_TIMEOUT', 'Git snapshot command timed out'); child.kill(); }, limits.gitTimeoutMs);
    timer.unref();
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > limits.maxSnapshotBytes + limits.maxMetadataBytes) { error = new ChangesError('WORKSPACE_CHANGES_LIMIT', 'Git output exceeds the snapshot budget'); child.kill(); }
      else stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.reduce((sum, item) => sum + item.length, 0) < 64 * 1024) stderr.push(chunk); });
    child.on('error', cause => { error = cause; });
    child.on('close', code => { clearTimeout(timer); if (error) reject(error); else resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }); });
    child.stdin.on('error', () => { /* Early process exit is handled by close. */ });
    child.stdin.end(input);
  });
}

function gitRecords(output: Buffer, staged: boolean): GitEntry[] {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(output);
  return text.split('\0').filter(Boolean).map(record => {
    const match = staged ? /^(\d{6}) ([a-f0-9]{40,64}) ([0-3])\t([\s\S]+)$/.exec(record) : /^(\d{6}) (?:blob|commit) ([a-f0-9]{40,64})\t([\s\S]+)$/.exec(record);
    if (!match) return fail('WORKSPACE_CHANGES_GIT', 'Unexpected Git index/tree entry');
    return { path: safeRelative(match[staged ? 4 : 3]!), mode: match[1]!, oid: match[2]!, stage: staged ? Number(match[3]) : 0 };
  }).sort((a, b) => a.path.localeCompare(b.path, 'en') || a.stage - b.stage);
}

async function captureGit(context: Context, root: RootIdentity, runner: GitRunner, includeObjects: boolean): Promise<GitState | null> {
  const git = async (args: string[], allowed = [0], input?: Buffer) => {
    context.pin();
    const result = await runner(args, root.path, context.input.signal, input);
    if (!Buffer.isBuffer(result.stdout)) fail('WORKSPACE_CHANGES_GIT', 'Git runner must preserve binary stdout as Buffer');
    context.pin();
    if (!allowed.includes(result.code ?? -1)) fail('WORKSPACE_CHANGES_GIT', 'Git state could not be captured', { command: args[0], error: result.stderr.toString().slice(0, 2048) });
    return result;
  };
  const repository = await git(['rev-parse', '--show-toplevel'], [0, 128]);
  if (repository.code !== 0) {
    if (existsSync(path.join(root.path, '.git'))) fail('WORKSPACE_CHANGES_GIT', 'Workspace contains an unreadable Git repository');
    return null;
  }
  if (path.resolve(repository.stdout.toString().trim()) !== root.path) fail('WORKSPACE_CHANGES_GIT', 'Snapshot root must be a complete repository root');
  const gitMarker = lstatSync(path.join(root.path, '.git'));
  if (gitMarker.isSymbolicLink()) fail('WORKSPACE_CHANGES_PATH', 'Git marker must not be a symbolic link');
  const directory = path.resolve(root.path, (await git(['rev-parse', '--absolute-git-dir'])).stdout.toString().trim());
  rootIdentity(directory);
  const locks = ['index.lock', 'HEAD.lock', 'packed-refs.lock'];
  if (locks.some(name => existsSync(path.join(directory, name)))) fail('WORKSPACE_GIT_OPERATION_IN_PROGRESS', 'Git metadata is being changed');
  const headOutput = await git(['rev-parse', '--verify', 'HEAD'], [0, 128, 1]);
  const head = headOutput.code === 0 ? headOutput.stdout.toString().trim() : null;
  const ref = await git(['symbolic-ref', '--quiet', 'HEAD'], [0, 1]);
  const indexPath = path.resolve(root.path, (await git(['rev-parse', '--git-path', 'index'])).stdout.toString().trim());
  const index = existsSync(indexPath) ? putBlob(context, readBytes(indexPath, context.limits.maxFileBytes)) : null;
  if (existsSync(indexPath + '.lock')) fail('WORKSPACE_GIT_OPERATION_IN_PROGRESS', 'Git index is being changed');
  const sharedPath = (await git(['rev-parse', '--shared-index-path'])).stdout.toString().trim();
  const sharedIndexes: GitState['sharedIndexes'] = [];
  if (sharedPath) {
    const filename = path.resolve(root.path, sharedPath);
    if (!/^sharedindex\.[a-f0-9]{40,64}$/.test(path.basename(filename))) fail('WORKSPACE_CHANGES_GIT', 'Invalid split index path');
    sharedIndexes.push({ name: path.basename(filename), blob: putBlob(context, readBytes(filename, context.limits.maxFileBytes)) });
  }
  const stages = gitRecords((await git(['ls-files', '--stage', '-z', '--full-name'])).stdout, true);
  const headEntries = head ? gitRecords((await git(['ls-tree', '-r', '-z', '--full-tree', head])).stdout, false) : [];
  if (stages.length + headEntries.length > context.limits.maxEntries * 4) fail('WORKSPACE_CHANGES_LIMIT', 'Git index/tree exceeds the snapshot entry budget');
  if (includeObjects) {
    const oids = [...new Set([...stages, ...headEntries].filter(entry => entry.mode !== '160000').map(entry => entry.oid))];
    const content = new Map<string, string>();
    if (oids.length) {
      const result = await git(['cat-file', '--batch'], [0], Buffer.from(oids.join('\n') + '\n'));
      let offset = 0;
      for (const oid of oids) {
        const end = result.stdout.indexOf(10, offset);
        if (end < 0) fail('WORKSPACE_CHANGES_GIT', 'Truncated Git object stream');
        const header = result.stdout.subarray(offset, end).toString('ascii');
        const match = /^([a-f0-9]{40,64}) blob (\d+)$/.exec(header);
        if (!match || match[1] !== oid) fail('WORKSPACE_CHANGES_GIT', 'Unexpected object in Git snapshot stream');
        const size = Number(match![2]); offset = end + 1;
        if (!Number.isSafeInteger(size) || size > context.limits.maxFileBytes || offset + size >= result.stdout.length || result.stdout[offset + size] !== 10) fail('WORKSPACE_CHANGES_LIMIT', 'Invalid or oversized Git blob');
        content.set(oid, putBlob(context, result.stdout.subarray(offset, offset + size))); offset += size + 1;
      }
      if (offset !== result.stdout.length) fail('WORKSPACE_CHANGES_GIT', 'Unexpected trailing Git object data');
    }
    for (const entry of [...stages, ...headEntries]) if (entry.mode !== '160000') entry.blob = content.get(entry.oid)!;
  }
  const operations = gitOperations.filter(name => existsSync(path.join(directory, name)));
  if (locks.some(name => existsSync(path.join(directory, name)))) fail('WORKSPACE_GIT_OPERATION_IN_PROGRESS', 'Git metadata changed during snapshot');
  return { directory, head, headRef: ref.code === 0 ? ref.stdout.toString().trim() : null, index, sharedIndexes, stages, headEntries, operations };
}

function gitRevision(git: GitState | null): string {
  if (!git) return hash('null');
  const { stages, headEntries, ...rest } = git;
  return hash(encoded({ ...rest, stages: stages.map(({ blob: _blob, ...entry }) => entry), headEntries: headEntries.map(({ blob: _blob, ...entry }) => entry) }));
}

function scanFiles(context: Context, root: RootIdentity, git: GitState | null): { entries: Record<string, Entry>; opaque: string[] } {
  const entries: Record<string, Entry> = Object.create(null) as Record<string, Entry>;
  const opaque: string[] = [];
  const trackedPrefixes = new Set<string>();
  for (const entry of git?.stages ?? []) {
    const parts = entry.path.split('/');
    for (let length = 1; length <= parts.length; length++) trackedPrefixes.add(parts.slice(0, length).join('/'));
  }
  const submodules = new Set((git?.stages ?? []).filter(entry => entry.mode === '160000').map(entry => entry.path));
  let count = 0; let bytes = 0;
  const visit = (relative: string) => {
    context.pin();
    safeRelative(relative);
    const parts = relative.split('/'); const name = parts.at(-1)!;
    const excluded = parts.some(part => reserved.has(part.toLowerCase()) || part.endsWith('.chisa-state') || dependencies.has(part) || ((part === '.env' || part.startsWith('.env.')) && part !== '.env.example' && part !== '.env.sample')) || (generated.has(parts[0]!) && !trackedPrefixes.has(relative)) || submodules.has(relative);
    if (excluded) { opaque.push(relative); return; }
    if (++count > context.limits.maxEntries) fail('WORKSPACE_CHANGES_LIMIT', 'Workspace exceeds the snapshot entry budget');
    const filename = path.join(root.path, ...parts);
    checkedAncestors(root, relative);
    const stats = lstatSync(filename);
    const mode = stats.mode & 0o777;
    if (stats.isSymbolicLink()) {
      const value = Buffer.from(readlinkSync(filename)); bytes += value.length;
      entries[relative] = { type: 'symlink', mode, blob: putBlob(context, value) };
    } else if (stats.isDirectory()) {
      if (realpathSync(filename) !== filename) fail('WORKSPACE_SNAPSHOT_CHANGED', 'Directory changed into a symbolic link during capture');
      entries[relative] = { type: 'directory', mode };
      for (const child of readdirSync(filename).sort()) visit(relative + '/' + child);
    } else if (stats.isFile()) {
      const value = readBytes(filename, context.limits.maxFileBytes); bytes += value.length;
      entries[relative] = { type: 'file', mode, blob: putBlob(context, value) };
    } else fail('WORKSPACE_CHANGES_UNSAFE_FILE', 'Sockets, devices and special files cannot form a reconstructible baseline', { path: relative });
    if (bytes > context.limits.maxSnapshotBytes) fail('WORKSPACE_CHANGES_LIMIT', 'Workspace exceeds the snapshot byte budget');
    // Directory names are validated above even when empty, so aliases cannot
    // later make an apparently disjoint path overwrite another entry.
    if (!name) fail('WORKSPACE_CHANGES_PATH', 'Empty path component');
  };
  for (const name of readdirSync(root.path).sort()) visit(name);
  return { entries, opaque: opaque.sort() };
}

async function stableSnapshot(context: Context, root: RootIdentity, runner: GitRunner): Promise<Snapshot> {
  requireTarget(context, root);
  const git = await captureGit(context, root, runner, true);
  const first = scanFiles(context, root, git);
  const gitAfter = await captureGit(context, root, runner, false);
  const second = scanFiles(context, root, gitAfter);
  requireTarget(context, root);
  if (gitRevision(git) !== gitRevision(gitAfter) || !same(first, second)) fail('WORKSPACE_SNAPSHOT_CHANGED', 'Workspace changed while its snapshot was being captured');
  const body = { version: 1 as const, root, entries: first.entries, opaque: first.opaque, git };
  const snapshot = { revision: hash(encoded(body)), ...body };
  const data = encoded(snapshot);
  if (Buffer.byteLength(data) > context.limits.maxMetadataBytes) fail('WORKSPACE_CHANGES_LIMIT', 'Snapshot manifest exceeds the metadata budget');
  durableWrite(snapshotPath(context, snapshot.revision), data, true);
  return snapshot;
}

function safeLink(relative: string, bytes: Buffer): boolean {
  const value = bytes.toString('utf8');
  if (!value || !Buffer.from(value).equals(bytes) || value.includes('\0') || value.includes('\\') || path.posix.isAbsolute(value) || /^[a-z]:/i.test(value)) return false;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relative), value));
  return resolved !== '..' && !resolved.startsWith('../') && !resolved.split('/').some(part => reserved.has(part.toLowerCase()) || part.endsWith('.chisa-state'));
}

function mergeValue<T>(base: T, source: T, target: T): T | undefined {
  if (source === base) return target;
  if (target === base || target === source) return source;
  return undefined;
}

async function planChanges(context: Context, base: Snapshot, source: Snapshot, target: Snapshot, runner: GitRunner): Promise<{ changes: Change[]; conflicts: Conflict[] }> {
  const changes: Change[] = []; const conflicts: Conflict[] = [];
  const conflict = (name: string, reason: string, mergedBlob?: string) => conflicts.push({ path: name, reason, base: entryAt(base, name), source: entryAt(source, name), target: entryAt(target, name), ...(mergedBlob ? { mergedBlob } : {}) });
  for (const name of [...new Set([...Object.keys(base.entries), ...Object.keys(source.entries)])].sort()) {
    context.pin();
    const b = entryAt(base, name); const a = entryAt(source, name); const t = entryAt(target, name);
    if (same(b, a) || same(a, t)) continue;
    let desired: Entry | null | undefined;
    if (same(b, t)) desired = a;
    else if (!b) { conflict(name, 'add/add'); continue; }
    else if (!a || !t) { conflict(name, !a ? 'delete/modify' : 'modify/delete'); continue; }
    else if (b.type !== a.type || b.type !== t.type) { conflict(name, 'type'); continue; }
    else {
      const mode = mergeValue(b.mode, a.mode, t.mode);
      if (mode === undefined) { conflict(name, 'mode'); continue; }
      if (a.type === 'directory') desired = { type: 'directory', mode };
      else {
        let blob = mergeValue(b.blob, a.blob, t.blob);
        if (blob === undefined) {
          if (a.type === 'symlink') { conflict(name, 'symlink'); continue; }
          const buffers = [t.blob!, b.blob!, a.blob!].map(digest => getBlob(context, digest));
          let text = buffers.every(bytes => !bytes.includes(0));
          try { for (const bytes of buffers) new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { text = false; }
          if (!text) { conflict(name, 'binary'); continue; }
          const result = await runner(['merge-file', '--stdout', '--diff3', '-L', 'target', '-L', 'baseline', '-L', 'session', ...[t.blob!, b.blob!, a.blob!].map(digest => path.join(context.state, 'objects', digest))], context.state, context.input.signal);
          context.pin();
          if (!Buffer.isBuffer(result.stdout)) fail('WORKSPACE_CHANGES_GIT', 'Git merge runner must return binary-safe stdout');
          if (result.code === null || result.code < 0 || result.code >= 128) fail('WORKSPACE_CHANGES_GIT', 'Three-way text merge failed', result.stderr.toString().slice(0, 2048));
          blob = putBlob(context, result.stdout);
          if (result.code !== 0) { conflict(name, 'text', blob); continue; }
        }
        desired = { type: a.type, mode, blob };
      }
    }
    if (desired?.type === 'symlink' && !safeLink(name, getBlob(context, desired.blob!))) { conflict(name, 'unsafe-symlink'); continue; }
    if (!same(t, desired)) changes.push({ path: name, kind: !desired ? 'delete' : !t ? 'add' : t.type !== desired.type ? 'type' : 'modify', before: t, after: desired ?? null });
  }
  const finalEntries: Record<string, Entry> = Object.assign(Object.create(null), target.entries) as Record<string, Entry>;
  for (const change of changes) { if (change.after) finalEntries[change.path] = change.after; else delete finalEntries[change.path]; }
  for (const change of changes) {
    const parts = change.path.split('/');
    for (let length = 1; change.after && length < parts.length; length++) {
      const parent = parts.slice(0, length).join('/');
      if (finalEntries[parent]?.type !== 'directory') { conflict(change.path, 'unsafe-parent'); break; }
    }
    if (change.before?.type === 'directory' && change.after?.type !== 'directory') {
      if (Object.keys(finalEntries).some(name => name.startsWith(change.path + '/')) || target.opaque.some(name => name === change.path || name.startsWith(change.path + '/'))) conflict(change.path, 'directory-not-empty');
    }
    if (target.opaque.some(name => change.path === name || change.path.startsWith(name + '/'))) conflict(change.path, 'protected-path');
    if (change.after?.type === 'symlink') {
      let resolved = path.posix.normalize(path.posix.join(path.posix.dirname(change.path), getBlob(context, change.after.blob!).toString('utf8')));
      const seen = new Set<string>([change.path]);
      for (let hop = 0; hop <= 40; hop++) {
        const components = resolved.split('/');
        let followed = false;
        for (let length = 1; length <= components.length; length++) {
          const prefix = components.slice(0, length).join('/');
          const linked = Object.hasOwn(finalEntries, prefix) ? finalEntries[prefix] : null;
          if (linked?.type !== 'symlink') continue;
          const content = getBlob(context, linked.blob!);
          if (seen.has(prefix) || !safeLink(prefix, content) || hop === 40) { conflict(change.path, 'unsafe-symlink-chain'); followed = false; hop = 41; break; }
          seen.add(prefix);
          resolved = path.posix.normalize(path.posix.join(path.posix.dirname(prefix), content.toString('utf8'), ...components.slice(length)));
          followed = true; break;
        }
        if (!followed) break;
      }
    }
  }
  changes.sort((a, b) => {
    const phase = (change: Change) => !change.after ? 0 : change.after.type === 'directory' ? 1 : 2;
    return phase(a) - phase(b) || (phase(a) === 0 ? b.path.split('/').length - a.path.split('/').length : a.path.split('/').length - b.path.split('/').length) || a.path.localeCompare(b.path, 'en');
  });
  return { changes, conflicts: conflicts.filter((item, index) => conflicts.findIndex(other => other.path === item.path && other.reason === item.reason) === index) };
}

function previewPath(context: Context, id: string): string {
  if (!/^[a-f0-9-]{36}$/.test(id)) fail('WORKSPACE_CHANGES_INPUT', 'Invalid preview identifier');
  return path.join(context.state, 'previews', id + '.json');
}

function journalPath(context: Context, operationId: string): string {
  if (!operationId || operationId.length > 256 || operationId.includes('\0')) fail('WORKSPACE_CHANGES_INPUT', 'A bounded idempotency operation identifier is required');
  return path.join(context.state, 'operations', hash(operationId) + '.json');
}

function receiptPath(context: Context, operationId: string): string {
  journalPath(context, operationId);
  return path.join(context.state, 'receipts', hash(operationId) + '.json');
}

function activePath(context: Context, target: RootIdentity): string { return path.join(targetDirectory(context, target), 'active.json'); }

function assertNoPending(context: Context, target: RootIdentity): void {
  if (existsSync(activePath(context, target))) fail('WORKSPACE_CHANGES_RECOVERY_REQUIRED', 'An interrupted integration must be recovered before creating another preview');
}

function inspectIntegrationState(context: Context, target: RootIdentity, requestedOperation?: string) {
  const directories = new Map<string, RootIdentity | null>();
  const files = new Map<string, string | null>();
  const fingerprint = (filename: string) => {
    try {
      const stats = lstatSync(filename);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || stats.size > context.limits.maxMetadataBytes) fail('WORKSPACE_CHANGES_STATE_CORRUPT', 'Integration metadata must be a private regular file');
      return encoded([stats.dev, stats.ino, stats.birthtimeMs, stats.size, stats.mtimeMs, stats.ctimeMs]);
    } catch (error) { if (absent(error)) return null; throw error; }
  };
  const read = <T>(filename: string): T | null => {
    const directory = path.dirname(filename);
    directories.set(directory, existingDirectory(directory));
    const before = fingerprint(filename);
    files.set(filename, before);
    if (before === null) return null;
    const value = readJson<T>(filename, context.limits.maxMetadataBytes);
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('WORKSPACE_CHANGES_STATE_CORRUPT', 'Integration metadata must be an object');
    return value;
  };
  const finish = <T>(result: T): T => {
    requireTarget(context, target);
    for (const [directory, identity] of directories) if (!same(existingDirectory(directory), identity)) fail('WORKSPACE_CHANGES_IDENTITY', 'Integration metadata directory changed during inspection');
    for (const [filename, before] of files) if (fingerprint(filename) !== before) fail('WORKSPACE_CHANGES_IDENTITY', 'Integration metadata changed during inspection');
    return result;
  };
  // Do not call targetDirectory or scratchPath here: admission/catalog inspection
  // must never create a state store, target directory, or apply scratch area.
  const targetState = path.join(context.state, 'targets', targetKey(target));
  const active = read<{ operationId: string }>(path.join(targetState, 'active.json'));
  if (active && (typeof active.operationId !== 'string' || !active.operationId)) fail('WORKSPACE_CHANGES_STATE_CORRUPT', 'Invalid active integration pointer');
  if (active && requestedOperation !== undefined && active.operationId !== requestedOperation) fail('WORKSPACE_CHANGES_RECOVERY_REQUIRED', 'Another integration operation owns the target');
  const operationId = requestedOperation ?? active?.operationId;
  if (operationId === undefined) return finish({ status: 'idle' as const });
  const journal = read<Journal>(journalPath(context, operationId));
  const receipt = read<Receipt>(receiptPath(context, operationId));
  if (!journal) {
    if (active || receipt) fail('WORKSPACE_CHANGES_STATE_CORRUPT', 'An integration pointer or receipt has no journal');
    return finish({ status: 'idle' as const });
  }
  const base = read<Baseline>(path.join(context.state, 'baseline.json'));
  if (!base || base.version !== 1 || base.sessionId !== context.input.sessionId || !same(base.execution, context.execution) || !same(base.source, context.source)) fail('WORKSPACE_CHANGES_IDENTITY', 'Integration baseline belongs to a different session or source');
  const verifiedBase = base!;
  if (verifiedBase.baselineId !== hash(encoded([verifiedBase.sessionId, verifiedBase.execution, verifiedBase.source, verifiedBase.snapshotRevision]))) fail('WORKSPACE_CHANGES_STATE_CORRUPT', 'Integration baseline identity failed verification');
  const plan = journal.preview;
  if (journal.version !== 1 || journal.operationId !== operationId || !plan || plan.version !== 1 || plan.baselineId !== verifiedBase.baselineId || plan.sessionId !== context.input.sessionId || !same(plan.execution, context.execution) || !same(plan.target, target)) fail('WORKSPACE_CHANGES_IDENTITY', 'Integration journal belongs to a different operation, session or target');
  const storedPlan = read<Preview>(previewPath(context, plan.previewId));
  if (!same(storedPlan, plan) || !['prepared', 'applying', 'applied', 'committed'].includes(journal.phase) || !Array.isArray(journal.completed) || journal.scratch !== path.join(target.path + '.chisa-state', 'changes-apply', hash(context.input.sessionId), hash(operationId))) fail('WORKSPACE_CHANGES_STATE_CORRUPT', 'Integration journal does not match its reviewed preview');
  const metadata = { operationId, previewId: plan.previewId, baselineId: plan.baselineId, sourceRevision: plan.sourceRevision, targetRevision: plan.targetRevision, phase: journal.phase, sessionId: context.input.sessionId, executionRoot: context.execution.path, sourceRoot: context.source.path, targetRoot: target.path };
  if (receipt) {
    const cp = read<Checkpoint>(path.join(targetState, 'checkpoint.json'));
    if (!cp) fail('WORKSPACE_CHANGES_STATE_CORRUPT', 'Committed integration has no checkpoint');
    const { revision, ...body } = cp!;
    if (receipt.version !== 1 || receipt.operationId !== operationId || receipt.previewId !== plan.previewId || receipt.baselineId !== verifiedBase.baselineId || !same(receipt.target, target) || receipt.sourceRevision !== plan.sourceRevision || receipt.originalTargetRevision !== plan.targetRevision || !same(receipt.changedPaths, plan.changes.map(change => change.path)) || !same(journal.receipt, receipt) || !['applied', 'committed'].includes(journal.phase) || cp!.version !== 1 || revision !== hash(encoded(body)) || cp!.baselineId !== verifiedBase.baselineId || !same(cp!.target, target)) fail('WORKSPACE_CHANGES_STATE_CORRUPT', 'Integration receipt or checkpoint failed verification');
    // A later integration may have advanced the checkpoint after this receipt.
    // With an active pointer this operation still owns that checkpoint exactly.
    if ((active || cp!.lastOperationId === operationId) && (cp!.lastOperationId !== operationId || cp!.revision !== receipt.checkpointRevision || cp!.sourceRevision !== plan.sourceRevision)) fail('WORKSPACE_CHANGES_STATE_CORRUPT', 'Integration receipt does not match the current checkpoint');
    return finish({ ...metadata, status: active ? 'pending' as const : 'committed' as const, active: Boolean(active), receipt: publicReceipt(receipt, true) });
  }
  if (journal.phase === 'committed' || (!active && journal.phase !== 'prepared')) fail('WORKSPACE_CHANGES_STATE_CORRUPT', 'Uncommitted integration lost its recovery pointer');
  return finish({ ...metadata, status: 'pending' as const, active: Boolean(active), receipt: null });
}

function checkedAncestors(target: RootIdentity, relative: string): void {
  const parts = safeRelative(relative).split('/');
  for (let length = 1; length < parts.length; length++) {
    const parent = path.join(target.path, ...parts.slice(0, length));
    const stats = lstatSync(parent);
    if (!stats.isDirectory() || stats.isSymbolicLink()) fail('WORKSPACE_CHANGES_CONFLICT', 'Target parent is not a real directory', { path: parts.slice(0, length).join('/') });
  }
}

function observeEntry(context: Context, filename: string): Entry | null {
  let stats;
  try { stats = lstatSync(filename); } catch (error) { if (absent(error)) return null; throw error; }
  const mode = stats.mode & 0o777;
  if (stats.isSymbolicLink()) return { type: 'symlink', mode, blob: putBlob(context, Buffer.from(readlinkSync(filename))) };
  if (stats.isDirectory()) return { type: 'directory', mode };
  if (stats.isFile()) return { type: 'file', mode, blob: putBlob(context, readBytes(filename, context.limits.maxFileBytes)) };
  return fail('WORKSPACE_CHANGES_UNSAFE_FILE', 'Target contains an unsupported special file');
}

function scratchPath(context: Context, target: RootIdentity, operationId: string): string {
  const scratch = path.join(target.path + '.chisa-state', 'changes-apply', hash(context.input.sessionId), hash(operationId));
  if (within(context.execution.path, scratch) || within(target.path, scratch)) fail('WORKSPACE_CHANGES_PATH', 'Apply scratch must be outside execution roots');
  privateDirectory(scratch);
  return scratch;
}

function backupPath(journal: Journal, change: Change): string { return path.join(journal.scratch, hash(change.path) + '.before'); }

function writeEntry(context: Context, journal: Journal, change: Change): void {
  const target = journal.preview.target;
  requireTarget(context, target);
  checkedAncestors(target, change.path);
  const filename = path.join(target.path, ...change.path.split('/'));
  let current = observeEntry(context, filename);
  if (same(current, change.after)) return;
  const backup = backupPath(journal, change);
  const saved = observeEntry(context, backup);
  if (!same(current, change.before) && !(current === null && change.before !== null && same(saved, change.before))) fail('WORKSPACE_CHANGES_CONFLICT', 'Target changed immediately before applying a file', { path: change.path });
  if (current?.type === 'directory' && change.after?.type === 'directory') {
    const fd = openSync(filename, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
    try {
      const actual = fstatSync(fd);
      if (!actual.isDirectory()) fail('WORKSPACE_CHANGES_CONFLICT', 'Target directory changed type');
      if (process.platform !== 'win32') fchmodSync(fd, change.after.mode);
    } finally { closeSync(fd); }
    return;
  }
  if (current) {
    // Retain even empty directories so a crash between displacement and install
    // has a durable before-image. Never remove an ignored/new child recursively.
    if (current.type === 'directory' && readdirSync(filename).length) fail('WORKSPACE_CHANGES_CONFLICT', 'Directory acquired a child before replacement', { path: change.path });
    if (saved) fail('WORKSPACE_CHANGES_CONFLICT', 'A previous target backup already exists', { path: change.path });
    renameSync(filename, backup);
    syncDirectory(path.dirname(filename)); syncDirectory(journal.scratch);
    const displaced = observeEntry(context, backup);
    if (!same(displaced, change.before) || (displaced?.type === 'directory' && readdirSync(backup).length)) fail('WORKSPACE_CHANGES_CONFLICT', 'A concurrent edit was preserved in the integration backup', { path: change.path, backup });
    current = null;
  }
  context.pin();
  if (!change.after) { syncDirectory(path.dirname(filename)); return; }
  checkedAncestors(target, change.path);
  if (change.after.type === 'directory') {
    mkdirSync(filename, { mode: change.after.mode });
    if (process.platform !== 'win32') chmodSync(filename, change.after.mode);
  } else if (change.after.type === 'symlink') {
    const bytes = getBlob(context, change.after.blob!);
    if (!safeLink(change.path, bytes)) fail('WORKSPACE_CHANGES_CONFLICT', 'Unsafe symbolic link target');
    symlinkSync(bytes.toString('utf8'), filename);
  } else {
    const temporary = path.join(journal.scratch, hash(change.path) + '.after');
    const content = getBlob(context, change.after.blob!);
    if (!existsSync(temporary)) {
      const fd = openSync(temporary, 'wx', change.after.mode);
      try { writeFileSync(fd, content); if (process.platform !== 'win32') fchmodSync(fd, change.after.mode); fsyncSync(fd); } finally { closeSync(fd); }
    } else if (!readBytes(temporary, context.limits.maxFileBytes).equals(content)) fail('WORKSPACE_CHANGES_STATE_CORRUPT', 'Prepared integration file is damaged');
    // link is a no-replace install: an external writer that creates the path in
    // the displacement gap wins, and its contents are never overwritten.
    linkSync(temporary, filename);
    unlinkSync(temporary);
  }
  syncDirectory(path.dirname(filename)); syncDirectory(journal.scratch);
  if (!same(observeEntry(context, filename), change.after)) fail('WORKSPACE_CHANGES_CONFLICT', 'Target changed during file installation', { path: change.path });
}

function publicBaseline(value: Baseline, snapshot: Snapshot) {
  return { available: true as const, baselineId: value.baselineId, sourceRevision: value.snapshotRevision, head: snapshot.git?.head ?? null, indexRevision: snapshot.git?.index ?? null, stageEntries: snapshot.git?.stages.length ?? 0, createdAt: value.createdAt };
}

function publicPreview(value: Preview) {
  return { baselineId: value.baselineId, previewId: value.previewId, sourceRevision: value.sourceRevision, targetRevision: value.targetRevision, checkpointRevision: value.checkpointRevision, changes: value.changes, conflicts: value.conflicts, canApply: value.conflicts.length === 0 };
}

function publicReceipt(receipt: Receipt, replayed = false) {
  return { operationId: receipt.operationId, status: 'applied' as const, replayed, baselineId: receipt.baselineId, sourceRevision: receipt.sourceRevision, targetRevision: receipt.targetRevision, checkpointRevision: receipt.checkpointRevision, changedPaths: receipt.changedPaths, conflicts: [] as Conflict[] };
}

/**
 * Workspace bridge calls this factory after a verified isolated snapshot and
 * supplies its exact identity/fencing checks plus a writer gate for every call.
 * The gate must cover execution reads and target writes, including synchronization
 * engine writes; an identity function is valid only while the caller already
 * owns those gates. No method changes Git objects, refs or the user's index.
 *
 * All baseline bytes, stage blobs, HEAD tree blobs, preview manifests, checkpoints
 * and journals live outside execution roots. Caller-selected stateRoot is private
 * trusted configuration, never an HTTP path argument. Capturing an existing legacy
 * result is not recovery: captureBaseline requires verifiedSnapshot:true from the
 * successful initial-copy path. inspectBaseline reports unavailable otherwise.
 */
export function createWorkspaceChangesService(options: { runGit?: GitRunner; limits?: Partial<Limits> } = {}) {
  const limits = { ...defaults, ...options.limits };
  for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value <= 0) fail('WORKSPACE_CHANGES_INPUT', 'Snapshot limits must be positive integers');
  const runner = options.runGit ?? defaultGit(limits);

  const finish = async (context: Context, base: Baseline, journal: Journal) => {
    const target = journal.preview.target;
    const before = loadSnapshot(context, journal.preview.targetRevision);
    const expected: Record<string, Entry> = Object.assign(Object.create(null), before.entries) as Record<string, Entry>;
    for (const change of journal.preview.changes) { if (change.after) expected[change.path] = change.after; else delete expected[change.path]; }
    const actual = await stableSnapshot(context, target, runner);
    const normalized = (entries: Record<string, Entry>) => Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b, 'en')));
    if (!same(normalized(actual.entries), normalized(expected)) || gitRevision(actual.git) !== gitRevision(before.git) || !same(actual.opaque, before.opaque)) fail('WORKSPACE_CHANGES_RECOVERY_REQUIRED', 'Target changed before integration could be committed');
    const cpBody = { version: 1 as const, baselineId: base.baselineId, target, sourceRevision: journal.preview.sourceRevision, lastOperationId: journal.operationId };
    const next: Checkpoint = { revision: hash(encoded(cpBody)), ...cpBody };
    const receipt: Receipt = journal.receipt ?? { version: 1, operationId: journal.operationId, previewId: journal.preview.previewId, baselineId: base.baselineId, target, sourceRevision: journal.preview.sourceRevision, originalTargetRevision: journal.preview.targetRevision, targetRevision: actual.revision, checkpointRevision: next.revision, changedPaths: journal.preview.changes.map(change => change.path), committedAt: new Date().toISOString() };
    journal.phase = 'applied'; journal.receipt = receipt;
    let pending = replaceState(context, target, journalPath(context, journal.operationId), encoded(journal)); if (pending) await pending;
    pending = replaceState(context, target, path.join(targetDirectory(context, target), 'checkpoint.json'), encoded(next)); if (pending) await pending;
    durableWrite(receiptPath(context, journal.operationId), encoded(receipt), true);
    journal.phase = 'committed'; pending = replaceState(context, target, journalPath(context, journal.operationId), encoded(journal)); if (pending) await pending;
    const active = activePath(context, target);
    if (existsSync(active)) {
      const marker = readJson<{ operationId: string }>(active, limits.maxMetadataBytes);
      if (marker.operationId !== journal.operationId) fail('WORKSPACE_CHANGES_STATE_CORRUPT', 'Active integration owner changed');
      unlinkSync(active); syncDirectory(path.dirname(active));
    }
    return publicReceipt(receipt);
  };

  const recoverLocked = async (context: Context, target: RootIdentity, operationId?: string) => {
    const base = requireBaseline(context);
    const state = inspectIntegrationState(context, target, operationId);
    if (state.status === 'idle') return { status: 'idle' as const, conflicts: [] as Conflict[] };
    if (state.status === 'committed') return state.receipt!;
    const active = activePath(context, target);
    const journal = readJson<Journal>(journalPath(context, state.operationId), limits.maxMetadataBytes);
    if (state.receipt) {
      // The receipt is durable before the active pointer is removed. Finish that
      // metadata transition before bridge code may lift its outer recovery guard.
      journal.phase = 'committed'; const pending = replaceState(context, target, journalPath(context, journal.operationId), encoded(journal)); if (pending) await pending;
      requireTarget(context, target);
      unlinkSync(active); syncDirectory(path.dirname(active));
      return state.receipt;
    }
    if (!state.active) {
      if (checkpoint(context, base, target).revision !== journal.preview.checkpointRevision) fail('WORKSPACE_CHANGES_STALE', 'Prepared operation checkpoint is no longer current');
      durableWrite(active, encoded({ operationId: journal.operationId }), true);
    }
    if (journal.scratch !== scratchPath(context, target, journal.operationId)) fail('WORKSPACE_CHANGES_IDENTITY', 'Interrupted integration scratch changed');
    const current = await stableSnapshot(context, target, runner);
    const before = loadSnapshot(context, journal.preview.targetRevision);
    const byPath = new Map(journal.preview.changes.map(change => [change.path, change]));
    const conflicts: Conflict[] = [];
    if (gitRevision(current.git) !== gitRevision(before.git)) conflicts.push({ path: '.git', reason: 'target-git-changed', base: null, source: null, target: null });
    if (!same(current.opaque, before.opaque)) conflicts.push({ path: '.', reason: 'protected-paths-changed', base: null, source: null, target: null });
    for (const name of [...new Set([...Object.keys(current.entries), ...Object.keys(before.entries), ...byPath.keys()])]) {
      const change = byPath.get(name); const actual = entryAt(current, name); const original = entryAt(before, name);
      if (!change) { if (!same(actual, original)) conflicts.push({ path: name, reason: 'target-changed', base: original, source: original, target: actual }); continue; }
      const interrupted = actual === null && change.before !== null && same(observeEntry(context, backupPath(journal, change)), change.before);
      if (!same(actual, change.before) && !same(actual, change.after) && !interrupted) conflicts.push({ path: name, reason: 'target-changed', base: change.before, source: change.after, target: actual });
    }
    if (conflicts.length) return { status: 'blocked' as const, operationId: journal.operationId, conflicts };
    const cp = checkpoint(context, base, target);
    if (cp.revision !== journal.preview.checkpointRevision && cp.lastOperationId !== journal.operationId) fail('WORKSPACE_CHANGES_STATE_CORRUPT', 'Checkpoint advanced past interrupted integration');
    for (const change of journal.preview.changes) {
      // A completed delete may now live below a parent converted into a file;
      // inspect the full captured tree instead of traversing that obsolete path.
      if (!same(entryAt(current, change.path), change.after)) writeEntry(context, journal, change);
      if (!journal.completed.includes(change.path)) journal.completed.push(change.path);
      journal.phase = 'applying'; const pending = replaceState(context, target, journalPath(context, journal.operationId), encoded(journal)); if (pending) await pending;
    }
    return finish(context, base, journal);
  };

  return {
    /** Bridge initial-copy completion calls this exactly after snapshot verification. */
    captureBaseline(input: IdentityInput & { verifiedSnapshot: true }) {
      return input.withLock(async () => {
        if (input.verifiedSnapshot !== true) fail('WORKSPACE_BASELINE_UNVERIFIED', 'Baseline capture requires a verified initial snapshot');
        const context = makeContext(input, limits);
        const existing = baseline(context);
        if (existing) return publicBaseline(existing, loadSnapshot(context, existing.snapshotRevision));
        const snapshot = await stableSnapshot(context, context.execution, runner);
        context.pin();
        const value: Baseline = { version: 1, baselineId: hash(encoded([input.sessionId, context.execution, context.source, snapshot.revision])), sessionId: input.sessionId, execution: context.execution, source: context.source, snapshotRevision: snapshot.revision, createdAt: new Date().toISOString() };
        durableWrite(path.join(context.state, 'baseline.json'), encoded(value), true);
        return publicBaseline(value, snapshot);
      });
    },
    /** Bridge session descriptors use this without inventing a legacy baseline. */
    inspectBaseline(input: IdentityInput) {
      return input.withLock(async () => {
        const context = makeContext(input, limits); const value = baseline(context);
        return value ? publicBaseline(value, loadSnapshot(context, value.snapshotRevision)) : { available: false as const, reason: 'BASELINE_UNAVAILABLE' as const };
      });
    },
    /** Bridge admission and recovery inspect exact durable state without Git, locks or filesystem creation. */
    inspectIntegration(input: InspectionInput) {
      const context = makeContext(input, limits, false); const target = targetIdentity(context, input.targetRoot);
      return inspectIntegrationState(context, target, input.operationId);
    },
    /** Changes routes preview the incremental B→A delta against a pinned target T. */
    preview(input: TargetInput) {
      return input.withLock(async () => {
        const context = makeContext(input, limits); const base = requireBaseline(context); const target = targetIdentity(context, input.targetRoot);
        assertNoPending(context, target);
        const cp = checkpoint(context, base, target);
        const source = await stableSnapshot(context, context.execution, runner);
        const current = await stableSnapshot(context, target, runner);
        if (current.git?.operations.length) fail('WORKSPACE_GIT_OPERATION_IN_PROGRESS', 'Finish the target Git operation before integrating session changes');
        const plan = await planChanges(context, loadSnapshot(context, cp.sourceRevision), source, current, runner);
        requireTarget(context, target);
        const value: Preview = { version: 1, previewId: randomUUID(), baselineId: base.baselineId, sessionId: input.sessionId, execution: context.execution, target, baseRevision: cp.sourceRevision, sourceRevision: source.revision, targetRevision: current.revision, checkpointRevision: cp.revision, ...plan, createdAt: new Date().toISOString() };
        durableWrite(previewPath(context, value.previewId), encoded(value), true);
        return publicPreview(value);
      });
    },
    /** Changes routes apply a previously inspected preview under the caller's gate. */
    apply(input: TargetInput & { previewId: string; expectedSourceRevision: string; expectedTargetRevision: string; operationId: string }) {
      return input.withLock(async () => {
        const context = makeContext(input, limits); const base = requireBaseline(context); const target = targetIdentity(context, input.targetRoot);
        const preview = readJson<Preview>(previewPath(context, input.previewId), limits.maxMetadataBytes);
        if (preview.version !== 1 || preview.previewId !== input.previewId || preview.baselineId !== base.baselineId || preview.sessionId !== input.sessionId || !same(preview.target, target) || !same(preview.execution, context.execution)) fail('WORKSPACE_CHANGES_IDENTITY', 'Preview belongs to a different session or target');
        if (preview.sourceRevision !== input.expectedSourceRevision || preview.targetRevision !== input.expectedTargetRevision) fail('WORKSPACE_CHANGES_STALE', 'Expected revisions do not match the reviewed preview');
        const receiptFile = receiptPath(context, input.operationId);
        if (existsSync(receiptFile)) {
          const receipt = readJson<Receipt>(receiptFile, limits.maxMetadataBytes);
          if (receipt.operationId !== input.operationId || receipt.previewId !== input.previewId || !same(receipt.target, target)) fail('WORKSPACE_CHANGES_OPERATION_REUSED', 'Idempotency key already belongs to another integration');
          return recoverLocked(context, target, input.operationId);
        }
        const journalFile = journalPath(context, input.operationId);
        if (existsSync(journalFile)) {
          const previous = readJson<Journal>(journalFile, limits.maxMetadataBytes);
          if (previous.operationId !== input.operationId || previous.preview.previewId !== input.previewId || !same(previous.preview.target, target)) fail('WORKSPACE_CHANGES_OPERATION_REUSED', 'Idempotency key already belongs to another integration');
          // Exact recovery validates an orphan prepared journal before rebinding
          // its active pointer; later phases without that pointer fail closed.
          return recoverLocked(context, target, input.operationId);
        }
        assertNoPending(context, target);
        if (checkpoint(context, base, target).revision !== preview.checkpointRevision) fail('WORKSPACE_CHANGES_STALE', 'Session integration checkpoint changed after preview');
        const source = await stableSnapshot(context, context.execution, runner);
        const current = await stableSnapshot(context, target, runner);
        // Target capture can yield to external work; revalidate A after that
        // await so a session edit during target scanning cannot be published.
        const sourceAfter = await stableSnapshot(context, context.execution, runner);
        if (source.revision !== input.expectedSourceRevision || sourceAfter.revision !== input.expectedSourceRevision || current.revision !== input.expectedTargetRevision) fail('WORKSPACE_CHANGES_STALE', 'Session or target changed after preview');
        if (preview.conflicts.length) return { operationId: input.operationId, status: 'conflict' as const, sourceRevision: source.revision, targetRevision: current.revision, changedPaths: [] as string[], conflicts: preview.conflicts };
        const journal: Journal = { version: 1, operationId: input.operationId, preview, phase: 'prepared', completed: [], scratch: scratchPath(context, target, input.operationId) };
        durableWrite(journalFile, encoded(journal), true);
        durableWrite(activePath(context, target), encoded({ operationId: input.operationId }), true);
        for (const change of preview.changes) {
          writeEntry(context, journal, change);
          journal.completed.push(change.path); journal.phase = 'applying'; const pending = replaceState(context, target, journalFile, encoded(journal)); if (pending) await pending;
        }
        return finish(context, base, journal);
      });
    },
    /** Bridge recovery resumes only the exact durable target journal; never guesses. */
    recover(input: TargetInput & { operationId?: string }) {
      return input.withLock(async () => {
        const context = makeContext(input, limits); const target = targetIdentity(context, input.targetRoot);
        return recoverLocked(context, target, input.operationId);
      });
    },
  };
}
