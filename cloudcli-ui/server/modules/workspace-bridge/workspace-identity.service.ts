import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import type { Stats } from 'node:fs';
import path from 'node:path';

import type { SessionWorkspaceMode } from '@/shared/index.js';
import { AppError } from '@/shared/index.js';

type ReplicaIdentity = { version: 1; workspaceId: string; generation: string; repositoryId: string; root: string; rootStamp: string; gitStamp: string | null; bindingEpoch: string };
type SessionIdentity = { version: 1; workspaceId: string; generation: string; sessionId: string; root: string; rootStamp: string; gitStamp: string | null; sourceRoot: string; sourceReplicaId: string; sourceRepositoryId: string; sourceGeneration: string; requestedMode: SessionWorkspaceMode; effectiveMode: SessionWorkspaceMode; baselineId?: string; publicationState: 'unpublished' | 'integrated' | 'conflicted' };
type StateRead = { value: Record<string, unknown>; raw: string };
type Storage = { root: string; rootStamp: string; directory: string; directoryStamp: string };

function invalid(message: string): never { throw new AppError(message, { code: 'WORKSPACE_IDENTITY_CHANGED', statusCode: 409 }); }
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
function inspect(file: string): Stats | null {
  try { return lstatSync(file); }
  catch (error) { if (missing(error)) return null; throw error; }
}
function identity(value: Stats): string { return `${value.dev}:${value.ino}:${value.birthtimeMs}`; }
function stamp(root: string): string {
  const value = inspect(root);
  if (!value || !value.isDirectory() || value.isSymbolicLink() || realpathSync(root) !== path.resolve(root)) invalid('Workspace directory identity is missing or not canonical');
  return identity(value);
}
function privateFile(value: Stats): boolean {
  return value.isFile() && !value.isSymbolicLink() && value.nlink === 1 && (process.platform === 'win32' || (value.mode & 0o022) === 0);
}
function readRegular(file: string): string | null {
  const before = inspect(file);
  if (!before) return null;
  if (!privateFile(before) || before.size > 65_536) invalid('Workspace identity metadata must be a private, unlinked regular file');
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    if (!privateFile(opened) || identity(before) !== identity(opened) || opened.size > 65_536) invalid('Workspace identity storage was replaced');
    const buffer = Buffer.alloc(65_537);
    let size = 0;
    while (size < buffer.length) {
      const count = readSync(fd, buffer, size, buffer.length - size, null);
      if (count === 0) break;
      size += count;
    }
    const after = fstatSync(fd);
    const named = inspect(file);
    if (size > 65_536 || !named || identity(after) !== identity(named) || !privateFile(named) || opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs) invalid('Workspace identity metadata changed while reading it');
    return buffer.toString('utf8', 0, size);
  } finally { closeSync(fd); }
}
function readState(file: string): StateRead | null {
  const raw = readRegular(file);
  if (raw === null) return null;
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { invalid('Workspace identity state is damaged; recover it before continuing'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Workspace identity state must be an object');
  return { value: value as Record<string, unknown>, raw };
}
function gitStamp(root: string): string | null {
  const file = path.join(root, '.git');
  const value = inspect(file);
  if (!value) return null;
  if (value.isSymbolicLink()) invalid('Workspace Git identity is not canonical');
  if (value.isDirectory()) return stamp(file);
  const raw = readRegular(file);
  const match = raw?.match(/^gitdir: ([^\r\n\0]+)\r?\n?$/);
  if (!match) invalid('Workspace Git directory pointer is invalid');
  const gitDirectory = path.resolve(root, match[1]);
  const targetStamp = stamp(gitDirectory);
  const common = readRegular(path.join(gitDirectory, 'commondir'));
  const commonRoot = common === null ? gitDirectory : path.resolve(gitDirectory, common.trim());
  if (common !== null && (!common.trim() || /[\r\n\0]/.test(common.trim()))) invalid('Workspace Git common directory pointer is invalid');
  return `${identity(value)}:${createHash('sha256').update(raw!).digest('hex')}:${targetStamp}:${stamp(commonRoot)}`;
}
function storage(root: string, create: boolean): Storage | null {
  const rootStamp = stamp(root);
  const directory = root + '.chisa-state';
  if (!inspect(directory)) {
    if (!create) return null;
    try { mkdirSync(directory, { mode: 0o700 }); flushDirectory(path.dirname(directory)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  const directoryStamp = stamp(directory);
  const value = lstatSync(directory);
  if (process.platform !== 'win32' && value.mode & 0o022) invalid('Workspace identity storage permissions are not private');
  return { root, rootStamp, directory, directoryStamp };
}
function checkStorage(value: Storage): void {
  if (stamp(value.root) !== value.rootStamp || stamp(value.directory) !== value.directoryStamp) invalid('Workspace identity directory changed during admission');
}
function flushDirectory(directory: string): void {
  if (process.platform === 'win32') return;
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

// All four callers serialize metadata updates across server processes. Exclusive
// creation is nonblocking; a crashed owner's marker deliberately requires
// recovery, never a PID guess or automatic deletion of somebody else's lock.
function locked<T>(stores: Storage[], operation: () => T): T {
  const ordered = [...new Map(stores.map(value => [value.directory, value])).values()].sort((a, b) => a.directory.localeCompare(b.directory));
  const held: Array<{ file: string; fd: number; stamp: string; storage: Storage }> = [];
  let result!: T;
  let failed = false;
  let failure: unknown;
  try {
    for (const value of ordered) {
      checkStorage(value);
      const file = path.join(value.directory, 'identity.lock');
      let fd: number;
      try { fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new AppError('Workspace identity is busy or has an unconfirmed previous update', { code: 'WORKSPACE_BUSY', statusCode: 409 });
        throw error;
      }
      held.push({ file, fd, stamp: identity(fstatSync(fd)), storage: value });
      writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce: randomUUID() }));
      fsyncSync(fd);
      flushDirectory(value.directory);
      checkStorage(value);
    }
    result = operation();
    for (const value of ordered) checkStorage(value);
  } catch (error) { failed = true; failure = error; }
  for (const value of held.reverse()) {
    try {
      checkStorage(value.storage);
      const current = inspect(value.file);
      if (!current || !privateFile(current) || identity(current) !== value.stamp) invalid('Workspace identity lock changed; preserve it for recovery');
      unlinkSync(value.file);
      flushDirectory(value.storage.directory);
    } catch (error) { if (!failed) { failed = true; failure = error; } }
    finally { closeSync(value.fd); }
  }
  if (failed) throw failure;
  return result;
}
function persist(store: Storage, name: string, value: unknown, expected: StateRead | null, assertCurrent: () => void): void {
  checkStorage(store);
  const file = path.join(store.directory, name);
  const current = readState(file);
  if (current?.raw !== expected?.raw) invalid('Workspace identity changed before its metadata commit');
  const temporary = file + '.' + randomUUID() + '.tmp';
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); }
  finally { closeSync(fd); }
  try {
    checkStorage(store);
    if (readState(file)?.raw !== expected?.raw) invalid('Workspace identity changed before publication');
    assertCurrent();
    if (expected === null) linkSync(temporary, file); else renameSync(temporary, file);
    assertCurrent();
  } finally {
    // Only this operation's unguessable temporary may be retired. Never remove
    // the destination after an uncertain or partially completed publication.
    if (inspect(temporary)) unlinkSync(temporary);
  }
  flushDirectory(store.directory);
}
function uuid(value: unknown): value is string { return typeof value === 'string' && /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(value); }
function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\0\r\n]/.test(value); }
function publication(value: unknown): value is SessionIdentity['publicationState'] { return value === 'unpublished' || value === 'integrated' || value === 'conflicted'; }
function mode(value: unknown): value is SessionWorkspaceMode { return value === 'isolated' || value === 'shared'; }
function checkBinding(root: string, epoch: string): void {
  if (!text(epoch)) invalid('Workspace binding epoch is invalid');
  const binding = readState(path.join(root, '.chisa-bridge.json'));
  if (binding === null && epoch === 'unbound') return;
  if (!binding || epoch === 'unbound' || !text(binding.value.bindingEpoch) || binding.value.bindingEpoch !== epoch) invalid('Workspace binding changed before its identity update');
}
function replicaIdentity(store: Storage, bindingEpoch: string): ReplicaIdentity {
  checkStorage(store);
  checkBinding(store.root, bindingEpoch);
  const file = path.join(store.directory, 'replica.json');
  const previous = readState(file);
  const repositoryStamp = gitStamp(store.root);
  if (!previous) {
    if (readdirSync(store.directory).some(name => name === 'replica.json' || name.startsWith('replica.json.') || /^session-[\da-f]{64}\.json(?:\.|$)/.test(name))) invalid('Replica identity is missing from existing identity storage; recover it before continuing');
    const next: ReplicaIdentity = { version: 1, workspaceId: randomUUID(), generation: randomUUID(), repositoryId: randomUUID(), root: store.root, rootStamp: store.rootStamp, gitStamp: repositoryStamp, bindingEpoch };
    checkBinding(store.root, bindingEpoch);
    persist(store, 'replica.json', next, null, () => {
      checkBinding(store.root, bindingEpoch);
      if (gitStamp(store.root) !== repositoryStamp) invalid('Workspace repository changed during identity publication');
    });
    return next;
  }
  const value = previous.value;
  if (value.version !== 1 || !uuid(value.workspaceId) || !uuid(value.generation) || !uuid(value.repositoryId) || !text(value.bindingEpoch) || value.root !== store.root || value.rootStamp !== store.rootStamp || !(value.gitStamp === null || text(value.gitStamp))) invalid('The workspace identity is damaged or its directory was replaced');
  let state = value as ReplicaIdentity;
  if (state.gitStamp !== repositoryStamp && !(state.gitStamp === null && repositoryStamp !== null)) invalid('The repository was replaced or removed; recover its identity before continuing');
  if (state.bindingEpoch !== bindingEpoch || state.gitStamp !== repositoryStamp) {
    // Only first repository initialization is adoptable. It and a real rebind
    // rotate the generation so every previously recorded session remains stale.
    state = { ...state, bindingEpoch, gitStamp: repositoryStamp, generation: randomUUID(), ...(state.gitStamp === null && repositoryStamp !== null ? { repositoryId: randomUUID() } : {}) };
    checkBinding(store.root, bindingEpoch);
    persist(store, 'replica.json', state, previous, () => {
      checkBinding(store.root, bindingEpoch);
      if (gitStamp(store.root) !== repositoryStamp) invalid('Workspace repository changed during identity publication');
    });
  }
  return state;
}

/** Bridge admission and the workspace catalog share a persistent replica identity, fenced by the current desktop binding. */
export function ensureReplicaIdentity(candidate: string, bindingEpoch: string): ReplicaIdentity {
  const store = storage(path.resolve(candidate), true)!;
  return locked([store], () => replicaIdentity(store, bindingEpoch));
}
function sessionFilename(sessionId: string): string {
  if (!text(sessionId)) invalid('Session identity requires a nonempty stable session ID');
  return 'session-' + createHash('sha256').update(sessionId).digest('hex') + '.json';
}
function validateSession(value: Record<string, unknown> | undefined, sessionId: string, store: Storage, replica: ReplicaIdentity): SessionIdentity {
  if (!value || value.version !== 1 || !uuid(value.workspaceId) || !uuid(value.generation) || value.sessionId !== sessionId || value.root !== store.root || value.rootStamp !== store.rootStamp || value.gitStamp !== gitStamp(store.root) || value.sourceRoot !== replica.root || value.sourceReplicaId !== replica.workspaceId || value.sourceRepositoryId !== replica.repositoryId || value.sourceGeneration !== replica.generation || !mode(value.requestedMode) || !mode(value.effectiveMode) || !publication(value.publicationState) || ('baselineId' in value && !text(value.baselineId))) invalid('The session workspace belongs to a different replica generation or has damaged metadata');
  if ((value.effectiveMode === 'shared') !== (store.root === replica.root) || (value.requestedMode === 'shared' && value.effectiveMode !== 'shared')) invalid('Session execution mode does not match its recorded directory');
  return value as SessionIdentity;
}

/** Bridge admission records the verified execution directory and optional baseline; existing session generations are never relabeled. */
export function recordSessionIdentity(input: { sourceRoot: string; executionRoot: string; sessionId: string; bindingEpoch: string; requestedMode: SessionWorkspaceMode; effectiveMode: SessionWorkspaceMode; baselineId?: string }): SessionIdentity {
  const name = sessionFilename(input.sessionId);
  if (!mode(input.requestedMode) || !mode(input.effectiveMode) || (input.baselineId !== undefined && !text(input.baselineId))) invalid('Session admission identity is invalid');
  const source = storage(path.resolve(input.sourceRoot), true)!;
  const execution = storage(path.resolve(input.executionRoot), true)!;
  return locked([source, execution], () => {
    const replica = replicaIdentity(source, input.bindingEpoch);
    const previous = readState(path.join(execution.directory, name));
    if (previous) {
      const existing = validateSession(previous.value, input.sessionId, execution, replica);
      if (existing.requestedMode !== input.requestedMode || existing.effectiveMode !== input.effectiveMode || (input.baselineId !== undefined && existing.baselineId !== input.baselineId)) invalid('Recorded session mode or baseline changed before admission');
      return existing;
    }
    const next: SessionIdentity = { version: 1, workspaceId: randomUUID(), generation: randomUUID(), sessionId: input.sessionId, root: execution.root, rootStamp: execution.rootStamp, gitStamp: gitStamp(execution.root), sourceRoot: replica.root, sourceReplicaId: replica.workspaceId, sourceRepositoryId: replica.repositoryId, sourceGeneration: replica.generation, requestedMode: input.requestedMode, effectiveMode: input.effectiveMode, ...(input.baselineId !== undefined ? { baselineId: input.baselineId } : {}), publicationState: 'unpublished' };
    validateSession(next, input.sessionId, execution, replica);
    checkBinding(source.root, input.bindingEpoch);
    persist(execution, name, next, null, () => {
      checkBinding(source.root, input.bindingEpoch);
      validateSession(next, input.sessionId, execution, replicaIdentity(source, input.bindingEpoch));
    });
    return next;
  });
}
function sessionStores(sourceRoot: string, executionRoot: string, sessionId: string): { source: Storage; execution: Storage; name: string } | null {
  const name = sessionFilename(sessionId);
  const root = path.resolve(executionRoot);
  if (!inspect(root)) return null;
  const execution = storage(root, false);
  if (!execution || !inspect(path.join(execution.directory, name))) return null;
  const source = storage(path.resolve(sourceRoot), false);
  if (!source) invalid('Recorded session source identity is missing');
  return { source, execution, name };
}

/** The workspace catalog resolves only recorded sessions and verifies their pinned source and execution repository on each request. */
export function readSessionIdentity(sourceRoot: string, executionRoot: string, sessionId: string, bindingEpoch: string): SessionIdentity | null {
  const stores = sessionStores(sourceRoot, executionRoot, sessionId);
  if (!stores) return null;
  const { source, execution, name } = stores;
  return locked([source, execution], () => validateSession(readState(path.join(execution.directory, name))?.value, sessionId, execution, replicaIdentity(source, bindingEpoch)));
}

/** Integration publishes only the exact persisted session generation after its journal settles, with source binding and disk CAS rechecked. */
export function setSessionPublication(sourceRoot: string, executionRoot: string, sessionId: string, bindingEpoch: string, generation: string, publicationState: SessionIdentity['publicationState']): void {
  if (!uuid(generation) || !publication(publicationState)) invalid('Session publication identity is invalid');
  const stores = sessionStores(sourceRoot, executionRoot, sessionId);
  if (!stores) invalid('Session identity changed before publication');
  const { source, execution, name } = stores;
  locked([source, execution], () => {
    const replica = replicaIdentity(source, bindingEpoch);
    const previous = readState(path.join(execution.directory, name));
    const state = validateSession(previous?.value, sessionId, execution, replica);
    if (state.generation !== generation) invalid('Session identity changed before publication');
    if (state.publicationState === publicationState) return;
    if (state.publicationState === 'integrated') invalid('An integrated session cannot be relabeled by an older publication');
    checkBinding(source.root, bindingEpoch);
    persist(execution, name, { ...state, publicationState }, previous, () => {
      checkBinding(source.root, bindingEpoch);
      validateSession(state, sessionId, execution, replicaIdentity(source, bindingEpoch));
    });
  });
}
