import { api } from '@/shared/api';
import { getAuthSessionSnapshot, initializeAuthSession, subscribeToAuthSession } from '@/shared/authToken';
import { CODE_EDITOR_STORAGE_KEYS } from '@/shared/constants';
import type { AuthSessionSnapshot, UserPreferenceSnapshot, UserPreferenceTransaction, UserPreferenceTransactionResult } from '@/shared/types';

/** Every setting the server stores for a user. */
export type UserPreferences = {
  theme: 'light' | 'dark';
  userLanguage: string;
  tasksEnabled: boolean;
  projectSortOrder: 'name' | 'date';
  claudePermissions: unknown;
  cursorPermissions: unknown;
  codexPermissions: unknown;
  opencodePermissions: unknown;
  codeEditorSettings: unknown;
  uiPreferences: unknown;
  selectedProvider: string;
};

export type UserPreferenceKey = keyof UserPreferences;

/** Fired after a local edit, hydration or account change, for existing preference consumers. */
export const USER_PREFERENCES_CHANGED_EVENT = 'user-preferences:changed';

const PARTITION_STORAGE_PREFIX = 'user-preferences:v2:';
const APPEARANCE_STORAGE_KEY = 'user-preferences:appearance:v2';
const LEGACY_OWNER_STORAGE_KEY = 'user-preferences:legacy-owner:v2';
const LEGACY_MIRROR_STORAGE_KEY = 'user-preferences';
const SERVER_WRITE_DEBOUNCE_MS = 400;
const REQUEST_TIMEOUT_MS = 10_000;
const DISPATCH_LEASE_MS = 15_000;
const MAX_AUTOMATIC_RETRIES = 3;
const MAX_BACKOFF_MS = 30_000;
const MAX_TIMER_MS = 2_147_483_647;
const LOCAL_APPEARANCE_KEYS: UserPreferenceKey[] = ['theme', 'userLanguage'];
const LEGACY_STORAGE_KEYS: Record<UserPreferenceKey, string> = {
  theme: 'theme',
  userLanguage: 'userLanguage',
  tasksEnabled: 'tasks-enabled',
  projectSortOrder: 'claude-settings',
  claudePermissions: 'claude-settings',
  cursorPermissions: 'cursor-tools-settings',
  codexPermissions: 'codex-settings',
  opencodePermissions: 'opencode-settings',
  codeEditorSettings: '',
  uiPreferences: 'uiPreferences',
  selectedProvider: 'selected-provider',
};
const PREFERENCE_KEYS = Object.keys(LEGACY_STORAGE_KEYS) as UserPreferenceKey[];

type PreferenceRecord = Partial<Record<UserPreferenceKey, unknown>>;
type PreferenceIdentity = { serverKey: string; userId: string };
type FieldWrite = { revision: number; value: unknown; notBefore?: number; rebases?: number };
type PendingOperation = {
  transaction: UserPreferenceTransaction;
  entries: FieldWrites;
  // Terminal journal refusals cannot be refreshed into a new operation by an automatic/manual retry.
  terminal?: 'PREFERENCE_OPERATION_EXPIRED' | 'PREFERENCE_OPERATION_MISMATCH';
};
type FieldWrites = Partial<Record<UserPreferenceKey, FieldWrite>>;
type FieldFailure = {
  kind: 'network' | 'server' | 'rate-limit' | 'validation' | 'auth' | 'session';
  status: number | null;
  message: string;
  attempts: number;
  retryAt: number | null;
};
type AuthPause = { sessionInstanceId: string; tokenRevision: number };
type DispatchLease = { id: string; owner: string; expiresAt: number };
type DurablePartition = {
  version: 3;
  identity: PreferenceIdentity;
  preferences: PreferenceRecord;
  // Local field clocks fence edits/hydration; these are never sent as server preconditions.
  revisions: Partial<Record<UserPreferenceKey, number>>;
  serverRevisions: Partial<Record<UserPreferenceKey, number>>;
  serverPreferences: PreferenceRecord;
  versionsAvailable: boolean;
  operations: PendingOperation[];
  pending: FieldWrites;
  inFlight: FieldWrites;
  failures: Partial<Record<UserPreferenceKey, FieldFailure>>;
  authPause: AuthPause | null;
  retryNotBefore: number | null;
  legacyMigrationComplete: boolean;
  lease: DispatchLease | null;
};
type Flight = {
  controller: AbortController;
  lease: DispatchLease;
  timeout: ReturnType<typeof setTimeout> | null;
};
type Partition = {
  data: DurablePartition;
  // Uncommitted synchronous edits overlay the shared mirror until their short transaction assigns revisions.
  drafts: Partial<Record<UserPreferenceKey, { sequence: number; value: unknown }>>;
  persistenceError: string | null;
  // After storage denial, retain this renderer's memory rather than rereading a stale blob over dirty work.
  memoryOnly: boolean;
  hydrationError: string | null;
  hasHydrated: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  flight: Flight | null;
  hydration: { controller: AbortController; promise: Promise<void> } | null;
  hydrationRevision: number;
  observedSessionId: string | null;
};
type PreferenceSyncStatus = {
  status: 'local' | 'saved' | 'unsaved' | 'saving' | 'retrying' | 'paused' | 'failed';
  identity: PreferenceIdentity | null;
  pendingKeys: UserPreferenceKey[];
  inFlightKeys: UserPreferenceKey[];
  failures: Array<FieldFailure & { key: UserPreferenceKey }>;
  retryAt: number | null;
  hydrationError: string | null;
  persistenceError: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function keys(value: object): UserPreferenceKey[] {
  return PREFERENCE_KEYS.filter(key => Object.prototype.hasOwnProperty.call(value, key));
}

function preferenceRecord(value: unknown): PreferenceRecord {
  if (!isRecord(value)) return {};
  return Object.fromEntries(keys(value).map(key => [key, value[key]]));
}

function identityKey(identity: PreferenceIdentity): string {
  return PARTITION_STORAGE_PREFIX + encodeURIComponent(JSON.stringify([identity.serverKey, identity.userId]));
}

function identityOf(session: AuthSessionSnapshot): PreferenceIdentity | null {
  return session.phase === 'ready' && session.token && session.userId !== null && session.serverKey
    ? { serverKey: session.serverKey, userId: session.userId } : null;
}

function sameIdentity(a: PreferenceIdentity, b: PreferenceIdentity): boolean {
  return a.serverKey === b.serverKey && a.userId === b.userId;
}

function emptyPartition(identity: PreferenceIdentity): DurablePartition {
  return { version: 3, identity, preferences: {}, revisions: {}, serverRevisions: {}, serverPreferences: {}, versionsAvailable: false,
    operations: [], pending: {}, inFlight: {}, failures: {},
    authPause: null, retryNotBefore: null, legacyMigrationComplete: false, lease: null };
}

function parsePartition(raw: string | null, identity: PreferenceIdentity): DurablePartition {
  const partition = emptyPartition(identity);
  let stored: unknown;
  try { stored = raw ? JSON.parse(raw) : null; } catch { return partition; }
  if (!isRecord(stored) || ![2, 3].includes(Number(stored.version)) || !isRecord(stored.identity)
    || stored.identity.serverKey !== identity.serverKey || stored.identity.userId !== identity.userId) return partition;
  partition.preferences = preferenceRecord(stored.preferences);
  for (const key of PREFERENCE_KEYS) {
    const revision = isRecord(stored.revisions) ? stored.revisions[key] : undefined;
    if (typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0) partition.revisions[key] = revision;
    for (const queue of ['inFlight', 'pending'] as const) {
      const entry = isRecord(stored[queue]) ? stored[queue][key] : undefined;
      // An older dispatched revision may coexist with a newer pending edit, but can never become the mirror.
      if (isRecord(entry) && Number.isSafeInteger(entry.revision) && (entry.revision as number) > 0
        && (queue === 'pending' ? entry.revision === partition.revisions[key] : (entry.revision as number) <= (partition.revisions[key] ?? 0))
        && Object.prototype.hasOwnProperty.call(entry, 'value')) {
        partition[queue][key] = { revision: entry.revision as number, value: entry.value,
          ...(typeof entry.notBefore === 'number' && Number.isFinite(entry.notBefore) ? { notBefore: entry.notBefore } : {}),
          ...(Number.isSafeInteger(entry.rebases) && (entry.rebases as number) >= 0 ? { rebases: entry.rebases as number } : {}) };
        if (entry.revision === partition.revisions[key]) partition.preferences[key] = entry.value;
      }
    }
    const failure = isRecord(stored.failures) ? stored.failures[key] : undefined;
    if ((partition.pending[key] || partition.inFlight[key]) && isRecord(failure)
      && ['network', 'server', 'rate-limit', 'validation', 'auth', 'session'].includes(String(failure.kind))
      && Number.isSafeInteger(failure.attempts) && (failure.attempts as number) > 0
      && typeof failure.message === 'string' && (failure.status === null || Number.isSafeInteger(failure.status))
      && (failure.retryAt === null || (typeof failure.retryAt === 'number' && Number.isFinite(failure.retryAt)))) {
      partition.failures[key] = failure as FieldFailure;
    }
  }
  if (isRecord(stored.authPause) && typeof stored.authPause.sessionInstanceId === 'string'
    && Number.isSafeInteger(stored.authPause.tokenRevision)) partition.authPause = stored.authPause as AuthPause;
  if (typeof stored.retryNotBefore === 'number' && Number.isFinite(stored.retryNotBefore)) partition.retryNotBefore = stored.retryNotBefore;
  if (isRecord(stored.lease) && typeof stored.lease.id === 'string' && typeof stored.lease.owner === 'string'
    && typeof stored.lease.expiresAt === 'number' && Number.isFinite(stored.lease.expiresAt)) {
    // Corrupt timestamps or a backwards wall-clock jump cannot strand the queue behind an unbounded lease.
    partition.lease = { id: stored.lease.id, owner: stored.lease.owner,
      expiresAt: Math.min(stored.lease.expiresAt, Date.now() + DISPATCH_LEASE_MS) };
  }
  partition.legacyMigrationComplete = stored.legacyMigrationComplete === true;
  if (stored.version === 3 && validRevisions(stored.serverRevisions)) {
    partition.serverRevisions = preferenceRecord(stored.serverRevisions) as DurablePartition['serverRevisions'];
    partition.serverPreferences = preferenceRecord(stored.serverPreferences);
    partition.versionsAvailable = stored.versionsAvailable === true;
  }
  if (stored.version === 3 && Array.isArray(stored.operations)) {
    for (const storedOperation of stored.operations) {
      if (!isRecord(storedOperation) || !validTransaction(storedOperation.transaction) || !isRecord(storedOperation.entries)) continue;
      const transaction = storedOperation.transaction;
      const entries: FieldWrites = {};
      for (const key of keys(transaction.updates)) {
        const entry = storedOperation.entries[key];
        if (!isRecord(entry) || !Number.isSafeInteger(entry.revision) || (entry.revision as number) <= 0
          || (entry.revision as number) > (partition.revisions[key] ?? 0)
          || JSON.stringify(entry.value) !== JSON.stringify(transaction.updates[key])) continue;
        entries[key] = entry as FieldWrite;
      }
      if (keys(entries).length !== Object.keys(transaction.updates).length) continue;
      partition.operations.push({ transaction, entries,
        ...(['PREFERENCE_OPERATION_EXPIRED', 'PREFERENCE_OPERATION_MISMATCH'].includes(String(storedOperation.terminal))
          ? { terminal: storedOperation.terminal as PendingOperation['terminal'] } : {}) });
    }
  }
  return partition;
}

function validRevisions(value: unknown): value is Record<string, number> {
  return isRecord(value) && Object.values(value).every(revision => typeof revision === 'number'
    && Number.isSafeInteger(revision) && revision >= 0);
}

function validTransaction(value: unknown): value is UserPreferenceTransaction {
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'expectedRevisions,operationId,updates'
    || typeof value.operationId !== 'string' || !/^[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/.test(value.operationId)
    || !isRecord(value.updates) || !validRevisions(value.expectedRevisions)) return false;
  const touched = Object.keys(value.updates).sort();
  return touched.length > 0 && touched.length === keys(value.updates).length
    && touched.join(',') === Object.keys(value.expectedRevisions).sort().join(',');
}

function operationId(): string {
  // UUIDv7 binds the immutable replay ID to its original UTC millisecond, including after journal pruning.
  const random = crypto.getRandomValues(new Uint8Array(16));
  const timestamp = Date.now().toString(16).padStart(12, '0');
  random[6] = (random[6]! & 15) | 0x70;
  random[8] = (random[8]! & 63) | 0x80;
  const hex = Array.from(random, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function snapshotPayload(value: unknown): UserPreferenceSnapshot {
  if (!isRecord(value) || value.success !== true || !isRecord(value.preferences) || !validRevisions(value.revisions)) {
    throw new Error('The preferences service must provide valid values and server revisions. Upgrade the service and retry.');
  }
  return { preferences: value.preferences, revisions: value.revisions };
}

function transactionPayload(value: unknown, operation: UserPreferenceTransaction, status: number): UserPreferenceTransactionResult {
  const invalid = () => new Error('The preferences service returned an invalid transaction acknowledgment. Upgrade the service and retry.');
  if (!isRecord(value) || value.operationId !== operation.operationId || typeof value.replayed !== 'boolean'
    || !isRecord(value.preferences) || !validRevisions(value.revisions)) throw invalid();
  const { revisions, preferences: values } = value;
  if (Object.keys(revisions).sort().join(',') !== Object.keys(operation.updates).sort().join(',')
    || Object.keys(values).some(key => !Object.prototype.hasOwnProperty.call(operation.updates, key))
    || (status === 200 ? value.success !== true : value.success !== false
      || typeof value.code !== 'string' || !['PREFERENCE_REVISION_CONFLICT', 'PREFERENCE_OPERATION_EXPIRED', 'PREFERENCE_OPERATION_MISMATCH'].includes(value.code))
    || (status === 200 && Object.keys(operation.updates).some(key => revisions[key] !== operation.expectedRevisions[key]! + 1
      || !Object.prototype.hasOwnProperty.call(values, key)))) throw invalid();
  return value as UserPreferenceTransactionResult;
}

function discardResponse(response?: Response): void {
  try { void response?.body?.cancel().catch(() => {}); } catch { /* A locked or already consumed body has no remaining cancellation handle. */ }
}

function recoverLease(data: DurablePartition): void {
  for (const key of keys(data.inFlight)) {
    const entry = data.inFlight[key]!;
    // Replaying a crashed predecessor is safe only for the latest committed revision of each setting.
    if (data.revisions[key] === entry.revision && !data.pending[key]) data.pending[key] = entry;
  }
  data.inFlight = {};
  data.lease = null;
}

function mergeServerFields(data: DurablePartition, snapshot: UserPreferenceSnapshot, touched: UserPreferenceKey[]): void {
  for (const key of touched) {
    const revision = snapshot.revisions[key] ?? 0;
    if (revision < (data.serverRevisions[key] ?? 0)) continue;
    data.serverRevisions[key] = revision;
    if (Object.prototype.hasOwnProperty.call(snapshot.preferences, key)) data.serverPreferences[key] = snapshot.preferences[key];
    else delete data.serverPreferences[key];
  }
}

function currentOperation(data: DurablePartition, operation: PendingOperation): boolean {
  return keys(operation.entries).every(key => operation.entries[key]!.revision === data.revisions[key]);
}

function readyAt(data: DurablePartition, key: UserPreferenceKey, now: number): number | null {
  const failure = data.failures[key];
  const time = failure ? failure.retryAt : now;
  return time === null ? null : Math.max(time, data.retryNotBefore ?? 0, data.pending[key]?.notBefore ?? 0);
}

function retryAfter(response: Response): number {
  const value = response.headers.get('Retry-After');
  if (value === null || !value.trim()) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_TIMER_MS);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

function recordFailure(data: DurablePartition, key: UserPreferenceKey, response?: Response, error?: unknown): void {
  const status = response?.status ?? null;
  const interrupted = error instanceof Error && error.name === 'AbortError';
  const kind: FieldFailure['kind'] = status === 401 ? 'auth' : status === 429 ? 'rate-limit'
    : status !== null && status >= 500 ? 'server' : status !== null ? 'validation' : interrupted ? 'session' : 'network';
  const attempts = (data.failures[key]?.attempts ?? 0) + 1;
  const automatic = ['network', 'server', 'rate-limit'].includes(kind) && attempts <= MAX_AUTOMATIC_RETRIES;
  const delay = Math.min(1000 * 2 ** (attempts - 1), MAX_BACKOFF_MS);
  data.failures[key] = { kind, status, attempts,
    message: status === null ? interrupted ? 'Authentication must be verified before saving.' : 'Unable to reach the preferences service.'
      : `Preferences were not saved (HTTP ${status}).`,
    retryAt: automatic ? Date.now() + Math.max(delay, response ? retryAfter(response) : 0) : null };
}

/** Preference consumers use the singleton below; independent renderer tests supply real, isolated authorities and storage hosts. */
export function createUserPreferenceStore(host: {
  auth?: { getSnapshot: typeof getAuthSessionSnapshot; initialize: typeof initializeAuthSession; subscribe: typeof subscribeToAuthSession };
  transport?: { load: typeof api.user.preferenceSnapshot; save: typeof api.user.savePreferenceTransaction };
  sharedStorage?: Storage;
  windowStorage?: Storage;
  locks?: LockManager | null;
  events?: EventTarget;
} = {}) {
  const auth = host.auth ?? { getSnapshot: getAuthSessionSnapshot, initialize: initializeAuthSession, subscribe: subscribeToAuthSession };
  // Resolve API methods only when dispatching. Preference consumers may load
  // before API composition has finished; importing the store grants no network authority.
  const transport: NonNullable<typeof host.transport> = host.transport ?? {
    load: options => api.user.preferenceSnapshot(options),
    save: (transaction, options) => api.user.savePreferenceTransaction(transaction, options),
  };
  const locks = host.locks === null ? undefined : host.locks ?? (typeof navigator === 'undefined' ? undefined : navigator.locks);
  const shared = Boolean(locks);
  const owner = crypto.randomUUID();
  const events = host.events ?? (typeof window === 'undefined' ? undefined : window);
  const storage = () => shared ? host.sharedStorage ?? globalThis.localStorage : host.windowStorage ?? globalThis.sessionStorage;
  const appearanceStorage = () => host.sharedStorage ?? globalThis.localStorage;
  // Value subscribers update existing feature readers without depending on network progress.
  const listeners = new Set<() => void>();
  // Progress subscribers separately observe ACK, retry and storage errors for Settings feedback.
  const syncListeners = new Set<() => void>();
  // Inactive identities retain unacknowledged edits, but never borrow the next account's authority.
  const partitions = new Map<string, Partition>();
  // Signed-out paint is device local, while every authenticated view comes from its own partition plus local drafts.
  let preferences: PreferenceRecord = readLocalAppearance();
  // Anonymous feature edits remain in this renderer and are never adopted into a later account's queue.
  let localPreferences: PreferenceRecord = preferences;
  // Reset hides the account until AuthProvider explicitly hydrates a verified replacement.
  let suspendedSessionId: string | null = null;
  // Only this partition may schedule dispatch using the observed authentication authority.
  let activePartition: Partition | null = null;
  // Local sequences distinguish an edit made while an earlier commit is waiting for its short lock.
  let editSequence = 0;
  // A destroyed renderer neither schedules work nor handles late transaction/network completions.
  let disposed = false;
  // React's external-store snapshot stays referentially stable between visible transitions.
  let syncStatus: PreferenceSyncStatus = deriveSyncStatus();

  function readJson(storageKey: string): unknown {
    try {
      const raw = appearanceStorage().getItem(storageKey);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  function readLocalAppearance(): PreferenceRecord {
    const stored = preferenceRecord(readJson(APPEARANCE_STORAGE_KEY));
    for (const key of LOCAL_APPEARANCE_KEYS) {
      if (stored[key] === undefined) stored[key] = readLegacyPreference(key);
    }
    return Object.fromEntries(LOCAL_APPEARANCE_KEYS.filter(key => stored[key] !== undefined).map(key => [key, stored[key]]));
  }

  function persistenceFailed(partition: Partition): void {
    partition.memoryOnly = true;
    partition.persistenceError = 'Local storage is unavailable; unconfirmed preferences may not survive a page reload.';
  }

  function readPartition(identity: PreferenceIdentity): Partition {
    const partition: Partition = { data: emptyPartition(identity), drafts: {}, persistenceError: null, memoryOnly: false,
      hydrationError: null, hasHydrated: false, timer: null, flight: null, hydration: null, hydrationRevision: 0, observedSessionId: null };
    try { partition.data = parsePartition(storage().getItem(identityKey(identity)), identity); } catch { persistenceFailed(partition); }
    // An isolated sessionStorage partition has no other renderer capable of owning its old lease.
    if (!shared || !partition.data.lease || partition.data.lease.expiresAt <= Date.now()) recoverLease(partition.data);
    return partition;
  }

  function isActiveSession(partition: Partition, expected: AuthSessionSnapshot): boolean {
    const current = auth.getSnapshot();
    const identity = identityOf(current);
    return !disposed && activePartition === partition && identity !== null && sameIdentity(partition.data.identity, identity)
      && expected.sessionInstanceId === current.sessionInstanceId && expected.serverKey === current.serverKey;
  }

  function notifyListeners(): void {
    for (const listener of listeners) listener();
    if (events && typeof Event !== 'undefined') events.dispatchEvent(new Event(USER_PREFERENCES_CHANGED_EVENT));
  }

  function updateView(partition: Partition): void {
    if (partition !== activePartition || disposed) return;
    const next = { ...partition.data.preferences };
    for (const key of keys(partition.drafts)) next[key] = partition.drafts[key]!.value;
    const changed = JSON.stringify(preferences) !== JSON.stringify(next);
    preferences = next;
    publishSyncStatus();
    if (changed) notifyListeners();
  }

  function deriveSyncStatus(): PreferenceSyncStatus {
    const partition = activePartition;
    if (!partition) return { status: 'local', identity: null, pendingKeys: [], inFlightKeys: [], failures: [],
      retryAt: null, hydrationError: null, persistenceError: null };
    const data = partition.data;
    const pendingKeys = keys({ ...data.pending, ...partition.drafts });
    const inFlightKeys = keys(data.inFlight);
    const failures = keys(data.failures).filter(key => !partition.drafts[key]).map(key => ({ key, ...data.failures[key]! }));
    const retries = failures.flatMap(failure => failure.retryAt === null ? [] : [failure.retryAt]);
    const scheduledRetry = retries.length ? Math.min(...retries) : null;
    const retryAt = pendingKeys.length && data.retryNotBefore !== null && data.retryNotBefore > Date.now()
      ? Math.max(scheduledRetry ?? 0, data.retryNotBefore) : scheduledRetry;
    const status = data.authPause ? 'paused'
      : partition.persistenceError || partition.hydrationError || failures.some(failure => failure.retryAt === null && failure.kind !== 'session') ? 'failed'
        : failures.some(failure => failure.kind === 'session') ? 'paused'
          : inFlightKeys.length ? 'saving'
            : retryAt !== null ? 'retrying'
              : pendingKeys.length ? 'unsaved' : partition.hydrationError ? 'failed' : 'saved';
    return { status, identity: data.identity, pendingKeys, inFlightKeys, failures, retryAt,
      hydrationError: partition.hydrationError, persistenceError: partition.persistenceError };
  }

  function publishSyncStatus(): void {
    const next = deriveSyncStatus();
    if (JSON.stringify(next) === JSON.stringify(syncStatus)) return;
    syncStatus = next;
    for (const listener of syncListeners) listener();
  }

  function transaction<T>(partition: Partition, work: (data: DurablePartition) => T, recoverExpired = true): Promise<T | undefined> {
    const run = () => {
      if (disposed) return undefined;
      let data = partition.data;
      let raw: string | null = null;
      if (!partition.memoryOnly) {
        try {
          raw = storage().getItem(identityKey(data.identity));
          if (shared) data = parsePartition(raw, data.identity);
        } catch { persistenceFailed(partition); }
      }
      if (!data.lease || (recoverExpired && data.lease.expiresAt <= Date.now())) recoverLease(data);
      const result = work(data);
      if (!partition.memoryOnly) {
        try {
          const serialized = JSON.stringify(data);
          if (serialized !== raw) storage().setItem(identityKey(data.identity), serialized);
        } catch { persistenceFailed(partition); }
      }
      partition.data = data;
      updateView(partition);
      return result;
    };
    // The preference lock is never held across auth initialization, API dispatch, a fetch or JSON parsing.
    if (locks) return Promise.resolve().then(() => locks.request(identityKey(partition.data.identity), { mode: 'exclusive' }, run)).catch(() => {
      // A host that advertises but denies Web Locks must not silently write an unlocked shared blob.
      persistenceFailed(partition);
      publishSyncStatus();
      return undefined;
    });
    try { return Promise.resolve(run()); } catch {
      persistenceFailed(partition);
      publishSyncStatus();
      return Promise.resolve(undefined);
    }
  }

  function resumeAuthentication(data: DurablePartition, session: AuthSessionSnapshot): void {
    if (!data.authPause || (data.authPause.sessionInstanceId === session.sessionInstanceId
      && data.authPause.tokenRevision === session.tokenRevision)) return;
    data.authPause = null;
    for (const key of keys(data.failures)) if (data.failures[key]?.kind === 'auth') delete data.failures[key];
  }

  function stopPartition(partition: Partition, release = true): void {
    if (partition.timer !== null) clearTimeout(partition.timer);
    partition.timer = null;
    const flight = partition.flight;
    partition.flight = null;
    flight?.controller.abort();
    if (flight?.timeout !== null && flight?.timeout !== undefined) clearTimeout(flight.timeout);
    if (release && flight) void transaction(partition, data => {
      if (data.lease?.id === flight.lease.id && data.lease.owner === owner) recoverLease(data);
    });
    partition.hydration?.controller.abort();
    partition.hydration = null;
    partition.hydrationRevision++;
    partition.hasHydrated = false;
  }

  function observeIdentity(allowSuspended = false): void {
    if (disposed) return;
    const session = auth.getSnapshot();
    const identity = identityOf(session);
    const available = identity && (allowSuspended || suspendedSessionId !== session.sessionInstanceId);
    const next = available ? partitions.get(identityKey(identity)) ?? readPartition(identity) : null;
    if (next && identity) partitions.set(identityKey(identity), next);
    const changed = next !== activePartition;
    if (changed && activePartition) stopPartition(activePartition);
    activePartition = next;
    if (allowSuspended) suspendedSessionId = null;
    if (next) {
      const sessionChanged = next.observedSessionId !== session.sessionInstanceId;
      // A relogin resumes an existing queue immediately; newly created edits still carry their committed debounce deadline.
      const resuming = sessionChanged && next.observedSessionId !== null;
      if (sessionChanged) {
        stopPartition(next);
        next.observedSessionId = session.sessionInstanceId;
      }
      if (changed || sessionChanged || next.data.authPause) void transaction(next, data => {
        if (isActiveSession(next, session)) {
          const paused = data.authPause !== null;
          resumeAuthentication(data, session);
          if (paused && !data.authPause && !data.versionsAvailable) next.hydrationError = null;
        }
      }).then(() => scheduleWrites(next, resuming ? 0 : SERVER_WRITE_DEBOUNCE_MS));
      updateView(next);
    } else {
      preferences = localPreferences;
      publishSyncStatus();
    }
    if (changed) notifyListeners();
  }

  function scheduleWrites(partition: Partition, debounce = 0): void {
    if (partition.timer !== null) clearTimeout(partition.timer);
    partition.timer = null;
    if (disposed || partition !== activePartition || partition.flight || partition.data.authPause || !identityOf(auth.getSnapshot())) return;
    const now = Date.now();
    const data = partition.data;
    if (!data.versionsAvailable) {
      // Version-2 mirrors remain readable, but queued values acquire a validated base automatically before their first CAS.
      if ((keys(data.pending).length || keys(data.inFlight).length) && !partition.hydration && !partition.hydrationError) void hydratePartition(partition);
      return;
    }
    // A foreign dispatcher may die without sending a storage event. Every observer wakes at its bounded lease expiry.
    const times = data.lease ? [data.lease.expiresAt] : keys(data.pending).flatMap(key => {
      if (data.operations.some(operation => operation.terminal && operation.entries[key]?.revision === data.revisions[key])) return [];
      const time = readyAt(data, key, now + debounce);
      return time === null ? [] : [time];
    });
    if (!times.length) return;
    const delay = Math.max(0, Math.min(...times) - now);
    partition.timer = setTimeout(() => { void flushServerWrites(partition); }, Math.min(delay, MAX_TIMER_MS));
  }

  async function flushServerWrites(partition: Partition): Promise<void> {
    partition.timer = null;
    const session = auth.getSnapshot();
    if (!isActiveSession(partition, session) || partition.flight) return;
    const claimed = await transaction(partition, data => {
      resumeAuthentication(data, session);
      if (!isActiveSession(partition, session) || data.lease || data.authPause || !data.versionsAvailable) return null;
      // A superseded operation is never rebased. Its still-current fields remain pending as their own latest intent.
      data.operations = data.operations.filter(operation => operation.terminal
        ? keys(operation.entries).some(key => operation.entries[key]!.revision === data.revisions[key]) : currentOperation(data, operation));
      let operation = data.operations.find(candidate => !candidate.terminal && keys(candidate.entries).every(key => {
        const time = readyAt(data, key, Date.now());
        return data.pending[key] && time !== null && time <= Date.now();
      }));
      if (!operation) {
        const entries: FieldWrites = {};
        for (const key of keys(data.pending)) {
          if (data.operations.some(candidate => candidate.entries[key]?.revision === data.revisions[key])) continue;
          const time = readyAt(data, key, Date.now());
          const entry = data.pending[key]!;
          if (time !== null && time <= Date.now() && entry.revision === data.revisions[key]) entries[key] = { ...entry };
        }
        if (!keys(entries).length) return null;
        // Detach the durable operation from the optimistic cache: readers can retain nested preference objects.
        operation = JSON.parse(JSON.stringify({ entries, transaction: { operationId: operationId(),
          updates: Object.fromEntries(keys(entries).map(key => [key, entries[key]!.value])),
          expectedRevisions: Object.fromEntries(keys(entries).map(key => [key, data.serverRevisions[key] ?? 0])) } })) as PendingOperation;
        data.operations.push(operation);
      }
      const lease = { id: crypto.randomUUID(), owner, expiresAt: Date.now() + DISPATCH_LEASE_MS };
      data.lease = lease;
      data.inFlight = operation.entries;
      for (const key of keys(operation.entries)) delete data.pending[key];
      // This detached snapshot cannot be changed by storage recovery or a caller mutating transport arguments.
      return { operation: JSON.parse(JSON.stringify(operation)) as PendingOperation, lease };
    });
    if (!claimed) { scheduleWrites(partition); return; }
    const { operation, lease } = claimed;
    const { entries } = operation;
    const controller = new AbortController();
    const flight: Flight = { controller, lease, timeout: null };
    partition.flight = flight;
    type Outcome = { response?: Response; payload?: unknown; error?: unknown };
    // The bound includes response JSON, and late/discarded bodies are canceled even when a transport ignores AbortSignal.
    const outcome = await new Promise<Outcome>(resolve => {
      let complete = false;
      let received: Response | undefined;
      const finish = (result: Outcome) => {
        if (complete) { discardResponse(result.response); return; }
        complete = true;
        controller.signal.removeEventListener('abort', aborted);
        resolve(result);
      };
      const aborted = () => { discardResponse(received); finish({ error: controller.signal.reason ?? new DOMException('Request canceled', 'AbortError') }); };
      controller.signal.addEventListener('abort', aborted, { once: true });
      flight.timeout = setTimeout(() => { controller.abort(new Error('Preferences request timed out.')); }, REQUEST_TIMEOUT_MS);
      void Promise.resolve().then(() => {
        if (!isActiveSession(partition, session)) throw new DOMException('Account session changed', 'AbortError');
        return transport.save(operation.transaction, { signal: controller.signal, expectedSession: session });
      }).then(async response => {
        received = response;
        if (complete || !isActiveSession(partition, session)) { discardResponse(response); finish({}); return; }
        if (response.status !== 200 && response.status !== 409) { discardResponse(response); finish({ response }); return; }
        try { finish({ response, payload: await response.json() }); }
        catch (error) { finish({ response, error }); }
      }, error => finish({ error })).catch(error => finish({ error }));
    });
    if (flight.timeout !== null) clearTimeout(flight.timeout);
    if (partition.flight === flight) partition.flight = null;
    if (disposed) { discardResponse(outcome.response); return; }
    let ack: UserPreferenceTransactionResult | undefined;
    let protocolError: unknown = outcome.error;
    let terminal: PendingOperation['terminal'];
    if (outcome.response && [200, 409].includes(outcome.response.status) && !protocolError) {
      try {
        const result = transactionPayload(outcome.payload, operation.transaction, outcome.response.status);
        // Even a permanent refusal must acknowledge this exact operation and its touched fields.
        if (!result.success && (result.code === 'PREFERENCE_OPERATION_EXPIRED' || result.code === 'PREFERENCE_OPERATION_MISMATCH')) terminal = result.code;
        else ack = result;
      } catch (error) { protocolError = error; }
    }
    await transaction(partition, data => {
      if (data.lease?.id !== lease.id || data.lease.owner !== owner) return;
      const current = !controller.signal.aborted && isActiveSession(partition, session);
      const { response } = outcome;
      const storedOperation = data.operations.find(candidate => candidate.transaction.operationId === operation.transaction.operationId);
      if (current && response && (response.status === 429 || response.status >= 500)) {
        const delay = retryAfter(response);
        if (delay > 0) data.retryNotBefore = Date.now() + delay;
      }
      if (current && response?.status === 401) data.authPause = {
        sessionInstanceId: session.sessionInstanceId, tokenRevision: session.tokenRevision,
      };
      if (current && ack) mergeServerFields(data, ack, keys(entries));
      if (current && terminal && storedOperation) storedOperation.terminal = terminal;
      for (const key of keys(entries)) {
        const entry = entries[key]!;
        // Old replay can update the nondecreasing server base, but can neither clear nor replace a newer dirty intent.
        if (data.revisions[key] !== entry.revision) continue;
        if (current && ack?.success) {
          delete data.failures[key];
          delete data.pending[key];
          if (!partition.drafts[key]) {
            if (Object.prototype.hasOwnProperty.call(data.serverPreferences, key)) data.preferences[key] = data.serverPreferences[key];
            else delete data.preferences[key];
          }
        } else {
          data.pending[key] = entry;
          if (current && ack && !ack.success) {
            const rebases = (entry.rebases ?? 0) + 1;
            data.pending[key] = { ...entry, rebases };
            if (rebases <= MAX_AUTOMATIC_RETRIES) delete data.failures[key];
            else {
              recordFailure(data, key, response);
              data.failures[key]!.message = 'Preference conflicts exceeded the automatic retry budget; retry after concurrent edits settle.';
            }
          } else if (current || (isActiveSession(partition, session) && protocolError instanceof Error && protocolError.name !== 'AbortError')) {
            recordFailure(data, key, response, protocolError);
            if (terminal || protocolError || response?.status === 404 || response?.ok) {
              data.failures[key]!.message = terminal ? `Preference operation was rejected (${terminal}); review the current intent before editing again.`
                : protocolError instanceof Error ? protocolError.message : 'The preferences service does not support durable transaction acknowledgments. Upgrade the service and retry.';
            }
          }
        }
      }
      if (current && ack) data.operations = data.operations.filter(candidate => candidate.transaction.operationId !== operation.transaction.operationId);
      // A definitive non-journal validation/auth rejection cannot have committed; later edits may safely batch against the same base.
      if (current && response && [400, 401, 403, 404, 413, 422].includes(response.status)) {
        data.operations = data.operations.filter(candidate => candidate.transaction.operationId !== operation.transaction.operationId);
      }
      data.inFlight = {};
      data.lease = null;
      if (isActiveSession(partition, session)) resumeAuthentication(data, auth.getSnapshot());
    }, false);
    if (terminal === 'PREFERENCE_OPERATION_EXPIRED' && isActiveSession(partition, session)) await hydratePartition(partition);
    scheduleWrites(partition);
  }

  function readUserPreference<T>(key: UserPreferenceKey, fallback: T): T {
    const value = preferences[key];
    return value === undefined || value === null ? fallback : value as T;
  }

  function writeUserPreference(key: UserPreferenceKey, value: unknown): void { writeUserPreferences({ [key]: value }); }

  function writeUserPreferences(updates: PreferenceRecord): void {
    observeIdentity();
    if (disposed) return;
    const partition = activePartition;
    const edits: Partition['drafts'] = {};
    let changed = false;
    for (const key of keys(updates)) {
      const serialized = JSON.stringify(updates[key]);
      if (serialized === undefined) continue;
      const value: unknown = JSON.parse(serialized);
      const sameValue = JSON.stringify(preferences[key]) === serialized;
      if (sameValue && (!partition || !shared)
        && !partition?.data.pending[key] && !partition?.data.inFlight[key] && !partition?.drafts[key]) continue;
      if (!sameValue) { preferences[key] = value; changed = true; }
      if (partition) {
        edits[key] = { sequence: ++editSequence, value };
        partition.drafts[key] = edits[key];
      }
    }
    if (partition && keys(edits).length) {
      publishSyncStatus();
      if (changed) notifyListeners();
      void transaction(partition, data => {
        for (const key of keys(edits)) {
          if (JSON.stringify(data.preferences[key]) === JSON.stringify(edits[key]!.value) && !data.pending[key] && !data.inFlight[key]) {
            if (partition.drafts[key]?.sequence === edits[key]!.sequence) delete partition.drafts[key];
            continue;
          }
          const revision = (data.revisions[key] ?? 0) + 1;
          data.revisions[key] = revision;
          data.preferences[key] = edits[key]!.value;
          data.pending[key] = { revision, value: edits[key]!.value, notBefore: shared ? Date.now() + SERVER_WRITE_DEBOUNCE_MS : 0 };
          delete data.failures[key];
          if (partition.drafts[key]?.sequence === edits[key]!.sequence) delete partition.drafts[key];
        }
      }).then(() => scheduleWrites(partition, SERVER_WRITE_DEBOUNCE_MS));
      return;
    }
    if (!partition && changed) {
      localPreferences = preferences;
      try {
        appearanceStorage().setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(Object.fromEntries(
          LOCAL_APPEARANCE_KEYS.filter(key => preferences[key] !== undefined).map(key => [key, preferences[key]]),
        )));
      } catch { /* Anonymous appearance is best effort and never enters an account outbox. */ }
    }
    publishSyncStatus();
    if (changed) notifyListeners();
  }

  function retryUserPreferences(): void {
    observeIdentity();
    const partition = activePartition;
    if (!partition) return;
    void transaction(partition, data => {
      if (!data.authPause) {
        for (const key of keys(data.failures)) {
          if (!data.operations.some(operation => operation.terminal && operation.entries[key]?.revision === data.revisions[key])) delete data.failures[key];
        }
      }
    }).then(() => {
      if (!partition.data.versionsAvailable && !partition.data.authPause) void hydratePartition(partition);
      else scheduleWrites(partition);
    });
  }

  function readLegacyPreference(key: UserPreferenceKey): unknown {
    let raw: string | null;
    try { raw = appearanceStorage().getItem(LEGACY_STORAGE_KEYS[key]); } catch { return undefined; }
    if (raw === null) return undefined;
    if (key === 'theme' || key === 'userLanguage' || key === 'selectedProvider') return raw;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return undefined; }
    if (key === 'projectSortOrder') return isRecord(parsed) ? parsed.projectSortOrder : undefined;
    if (key === 'claudePermissions') {
      if (!isRecord(parsed)) return undefined;
      const { allowedTools, disallowedTools, skipPermissions } = parsed;
      return { allowedTools, disallowedTools, skipPermissions };
    }
    return parsed;
  }

  function readLegacyCodeEditorSettings(): unknown {
    try {
      const wordWrap = appearanceStorage().getItem(CODE_EDITOR_STORAGE_KEYS.wordWrap);
      const showMinimap = appearanceStorage().getItem(CODE_EDITOR_STORAGE_KEYS.showMinimap);
      const lineNumbers = appearanceStorage().getItem(CODE_EDITOR_STORAGE_KEYS.lineNumbers);
      const fontSize = appearanceStorage().getItem(CODE_EDITOR_STORAGE_KEYS.fontSize);
      if (wordWrap === null && showMinimap === null && lineNumbers === null && fontSize === null) return undefined;
      const settings: Record<string, unknown> = {};
      if (wordWrap !== null) settings.wordWrap = wordWrap !== 'false';
      if (showMinimap !== null) settings.showMinimap = showMinimap !== 'false';
      if (lineNumbers !== null) settings.lineNumbers = lineNumbers !== 'false';
      if (fontSize !== null) settings.fontSize = fontSize;
      return settings;
    } catch { return undefined; }
  }

  function ownsLegacyPreferences(data: DurablePartition): boolean {
    const legacyOwner = readJson(LEGACY_OWNER_STORAGE_KEY);
    return isRecord(legacyOwner) && legacyOwner.serverKey === data.identity.serverKey && legacyOwner.userId === data.identity.userId;
  }

  function legacyPreferences(data: DurablePartition): PreferenceRecord {
    if (data.legacyMigrationComplete || !ownsLegacyPreferences(data)) return {};
    const legacy = preferenceRecord(readJson(LEGACY_MIRROR_STORAGE_KEY));
    for (const key of PREFERENCE_KEYS) {
      if (legacy[key] === undefined) legacy[key] = key === 'codeEditorSettings' ? readLegacyCodeEditorSettings() : readLegacyPreference(key);
    }
    return legacy;
  }

  function hydratePartition(partition: Partition, replace = false): Promise<void> {
    if (partition.hydration && !replace) return partition.hydration.promise;
    const session = auth.getSnapshot();
    if (!isActiveSession(partition, session)) return Promise.resolve();
    partition.hydration?.controller.abort();
    const controller = new AbortController();
    const revision = ++partition.hydrationRevision;
    partition.hasHydrated = false;
    const current = () => !controller.signal.aborted && partition.hydrationRevision === revision && isActiveSession(partition, session);
    // Capture clocks/dirty state before either fetch or its potentially slow JSON parsing can yield.
    const promise = (async () => {
      const before = await transaction(partition, data => ({ revisions: { ...data.revisions },
        serverRevisions: { ...data.serverRevisions },
        dirty: new Set([...keys(data.pending), ...keys(data.inFlight), ...keys(partition.drafts)]) }));
      if (!before || !current()) return;
      let response: Response | undefined;
      const timeout = setTimeout(() => controller.abort(new Error('Preferences snapshot timed out.')), REQUEST_TIMEOUT_MS);
      try {
        const snapshot = await new Promise<UserPreferenceSnapshot>((resolve, reject) => {
          const abort = () => { discardResponse(response); reject(controller.signal.reason ?? new DOMException('Request canceled', 'AbortError')); };
          controller.signal.addEventListener('abort', abort, { once: true });
          void Promise.resolve().then(() => {
            if (!current()) throw new DOMException('Account session changed', 'AbortError');
            return transport.load({ signal: controller.signal, expectedSession: session });
          }).then(async received => {
            response = received;
            if (!current()) { discardResponse(received); throw new DOMException('Account session changed', 'AbortError'); }
            if (!received.ok) { discardResponse(received); throw new Error(`Unable to load versioned preferences (HTTP ${received.status}). Upgrade the service if necessary and retry.`); }
            const payload: unknown = await received.json();
            if (!current()) { discardResponse(received); throw new DOMException('Account session changed', 'AbortError'); }
            return snapshotPayload(payload);
          }).then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', abort)).catch(() => {});
        });
        await transaction(partition, data => {
          if (!current()) return;
          const legacy = legacyPreferences(data);
          for (const key of PREFERENCE_KEYS) {
            const serverRevision = snapshot.revisions[key] ?? 0;
            if (serverRevision < (data.serverRevisions[key] ?? 0)) continue;
            // Equal-version snapshots that crossed a newer local commit/hydrate cannot change that field's base.
            const unchanged = data.revisions[key] === before.revisions[key]
              && data.serverRevisions[key] === before.serverRevisions[key];
            if (unchanged || serverRevision > (data.serverRevisions[key] ?? 0)) mergeServerFields(data, snapshot, [key]);
            if (!unchanged || before.dirty.has(key) || data.pending[key] || data.inFlight[key] || partition.drafts[key]) continue;
            const fieldRevision = (data.revisions[key] ?? 0) + 1;
            data.revisions[key] = fieldRevision;
            if (Object.prototype.hasOwnProperty.call(snapshot.preferences, key)) data.preferences[key] = snapshot.preferences[key];
            else if (legacy[key] !== undefined && serverRevision === 0) {
              data.preferences[key] = legacy[key];
              data.pending[key] = { revision: fieldRevision, value: legacy[key], notBefore: shared ? Date.now() + SERVER_WRITE_DEBOUNCE_MS : 0 };
            } else delete data.preferences[key];
          }
          data.versionsAvailable = true;
          if (ownsLegacyPreferences(data)) data.legacyMigrationComplete = true;
          partition.hasHydrated = true;
          partition.hydrationError = null;
          for (const key of keys(data.failures)) if (data.failures[key]?.kind === 'session') delete data.failures[key];
        });
      } catch (error) {
        if (partition.hydrationRevision !== revision || !isActiveSession(partition, session)) return;
        partition.hydrationError = error instanceof Error ? error.message : 'Unable to load versioned preferences.';
        if (response?.status === 401) await transaction(partition, data => {
          data.authPause = { sessionInstanceId: session.sessionInstanceId, tokenRevision: session.tokenRevision };
        });
      } finally {
        clearTimeout(timeout);
        if (partition.hydrationRevision === revision && isActiveSession(partition, session)) {
          partition.hydration = null;
          await transaction(partition, data => resumeAuthentication(data, auth.getSnapshot()));
          publishSyncStatus();
          scheduleWrites(partition, SERVER_WRITE_DEBOUNCE_MS);
        }
      }
    })();
    partition.hydration = { controller, promise };
    return promise;
  }

  async function hydrateUserPreferences(): Promise<void> {
    await auth.initialize();
    observeIdentity(true);
    if (activePartition) await hydratePartition(activePartition, true);
  }

  function resetUserPreferences(): void {
    suspendedSessionId = auth.getSnapshot().sessionInstanceId;
    if (activePartition) stopPartition(activePartition);
    activePartition = null;
    localPreferences = {};
    preferences = localPreferences;
    try { appearanceStorage().removeItem(APPEARANCE_STORAGE_KEY); } catch { /* The in-memory copy is already hidden. */ }
    publishSyncStatus();
    notifyListeners();
  }

  function wake(event: Event): void {
    if (!shared || disposed || !activePartition) return;
    const key = (event as StorageEvent).key;
    const partition = activePartition;
    if (key !== null && key !== identityKey(partition.data.identity)) return;
    // Event payloads are hints only. Never adopt newValue or write a cached renderer blob back to storage.
    void transaction(partition, () => {}).then(() => scheduleWrites(partition));
  }

  const unsubscribeAuth = auth.subscribe(() => observeIdentity());
  events?.addEventListener('storage', wake);
  observeIdentity();
  return {
    readUserPreference, writeUserPreference, writeUserPreferences, retryUserPreferences, hydrateUserPreferences, resetUserPreferences,
    hasHydratedUserPreferences: () => activePartition?.hasHydrated ?? false,
    getPreferenceSyncStatus: () => syncStatus,
    subscribeToUserPreferences: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    subscribeToPreferenceSyncStatus: (listener: () => void) => { syncListeners.add(listener); return () => { syncListeners.delete(listener); }; },
    // Disposal models renderer termination: abandon the durable lease so another observer recovers after its bounded expiry.
    dispose: () => {
      disposed = true;
      unsubscribeAuth();
      events?.removeEventListener('storage', wake);
      for (const partition of partitions.values()) stopPartition(partition, false);
      listeners.clear();
      syncListeners.clear();
    },
  };
}

const store = createUserPreferenceStore();

/** Theme, language and feature readers see only the active account or explicitly local signed-out values. */
export const readUserPreference = store.readUserPreference;
/** Settings and preference hooks commit one field; an unchanged dirty value explicitly retries it. */
export const writeUserPreference = store.writeUserPreference;
/** Settings commits fields together; the shared transaction defines same-field last-committed ordering. */
export const writeUserPreferences = store.writeUserPreferences;
/** Feature readers subscribe to values independently of network progress. */
export const subscribeToUserPreferences = store.subscribeToUserPreferences;
/** Settings distinguishes confirmed, pending, failed and local-only edits through a stable snapshot. */
export const getPreferenceSyncStatus = store.getPreferenceSyncStatus;
/** Settings renders ACK/failure changes even when the preference value stays unchanged. */
export const subscribeToPreferenceSyncStatus = store.subscribeToPreferenceSyncStatus;
/** Settings retries failed fields; rejected credentials must first change through the auth authority. */
export const retryUserPreferences = store.retryUserPreferences;
/** Auth hydrates clean fields without replacing edits or ACKs committed after its GET began. */
export const hydrateUserPreferences = store.hydrateUserPreferences;
/** Auth and features distinguish a completed hydrate from offline or rejected responses. */
export const hasHydratedUserPreferences = store.hasHydratedUserPreferences;
/** Auth hides the old account immediately while retaining its unacknowledged, identity-scoped outbox. */
export const resetUserPreferences = store.resetUserPreferences;
