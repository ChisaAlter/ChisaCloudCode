import type { AuthSessionPredecessor, AuthSessionSnapshot } from '@/shared/types';

const SESSION_STORAGE_KEY = 'chisa-auth-session:v2';
const WINDOW_STORAGE_KEY = 'chisa-auth-window-session:v2';
const SESSION_LOCK = 'chisa-auth-session:v2';
const SESSION_CHANGED_EVENT = 'chisa-auth-session-changed';
const LEGACY_TOKEN_KEY = 'auth-token';

/** Shared token consumers retain a small clock allowance; the server remains the signature/expiry authority. */
export const TOKEN_EXPIRY_SKEW_MS = 60_000;

/** Auth and API reject malformed response headers before they can become persisted credentials. */
export const isValidRefreshedToken = (token: unknown): token is string => typeof token === 'string'
  && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);

function claims(token: unknown): { iat?: number; exp?: number; userId?: number | string; username?: string } | null {
  if (!isValidRefreshedToken(token)) return null;
  try {
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const decoded: unknown = JSON.parse(atob(payload.padEnd(payload.length + (4 - payload.length % 4) % 4, '=')));
    return decoded && typeof decoded === 'object' ? decoded : null;
  } catch { return null; }
}

/** Auth, sockets and initial restoration discard only tokens whose readable expiry is beyond clock tolerance. */
export function isAuthTokenExpired(token: unknown): boolean {
  const payload = claims(token);
  return typeof payload?.exp === 'number' && Number.isFinite(payload.exp)
    ? Date.now() >= payload.exp * 1000 + TOKEN_EXPIRY_SKEW_MS : false;
}

/** Auth schedules refresh halfway through a readable lifetime without treating malformed claims as a timer. */
export function getAuthTokenRefreshDelay(token: unknown): number | null {
  const payload = claims(token);
  if (typeof payload?.iat !== 'number' || typeof payload.exp !== 'number'
    || !Number.isFinite(payload.iat) || !Number.isFinite(payload.exp) || payload.exp <= payload.iat) return null;
  return Math.max(0, (payload.iat + (payload.exp - payload.iat) / 2) * 1000 - Date.now());
}

function newId(): string { return crypto.randomUUID(); }
function interrupted(message = 'Account session changed'): DOMException { return new DOMException(message, 'AbortError'); }
function sameIdentity(a: AuthSessionPredecessor, b: AuthSessionPredecessor): boolean {
  return a.sessionInstanceId === b.sessionInstanceId && a.serverKey === b.serverKey;
}
function sameRevision(a: AuthSessionPredecessor, b: AuthSessionPredecessor): boolean {
  return sameIdentity(a, b) && a.tokenRevision === b.tokenRevision;
}
function webServerKey(): string {
  if (typeof location === 'undefined') return 'unavailable';
  const instance = location.pathname.match(/^\/instances\/[a-zA-Z0-9_-]+(?=\/|$)/)?.[0] ?? '';
  return location.origin + instance;
}
function tokenUser(token: string): string | null {
  const payload = claims(token);
  return payload?.userId == null ? payload?.username ?? null : String(payload.userId);
}

// The factory is also exercised by independent realm/lock fixtures; production creates exactly one store per renderer.
/** Auth owns this authority; API/sockets use its public barrel and tests supply isolated storage/lock hosts. */
export function createAuthSessionStore(host: {
  serverKey?: string;
  desktop?: boolean;
  sharedStorage?: Storage;
  windowStorage?: Storage;
  locks?: LockManager;
  notify?: () => void;
} = {}) {
  const desktop = host.desktop ?? (typeof globalThis !== 'undefined' && 'mygo' in globalThis);
  const locks = host.locks ?? (typeof navigator === 'undefined' ? undefined : navigator.locks);
  const shared = !desktop && Boolean(locks);
  const storage = shared ? host.sharedStorage ?? globalThis.localStorage : host.windowStorage ?? globalThis.sessionStorage;
  const serverKey = host.serverKey ?? webServerKey();
  const storageKey = `${shared ? SESSION_STORAGE_KEY : WINDOW_STORAGE_KEY}:${encodeURIComponent(serverKey)}`;
  const listeners = new Set<() => void>();
  // Synchronous readers see only this renderer's observed identity; network dispatch still verifies the authority under its lock.
  let snapshot: AuthSessionSnapshot = Object.freeze({ sessionInstanceId: newId(), serverKey, userId: null, token: null,
    tokenRevision: 0, phase: 'signedOut', nativeGeneration: null, nativeHandle: null, storageMode: shared ? 'shared' : 'window' });
  // Identity revisions preserve existing async result fences without changing them on ordinary token rotation.
  let identityVersion = 0;
  // A remotely replaced identity cannot be used by the previous UI until AuthProvider has verified/rendered its replacement.
  let uiSessionId: string | null = null;
  let initialized: Promise<AuthSessionSnapshot> | null = null;
  let localTransition: string | null = null;
  let transitionPredecessor: AuthSessionSnapshot | null = null;
  // Explicit remote revocation that could not finish durable local clear cannot be reopened by refresh/login commits.
  let revocationClosing = false;
  let queue: Promise<unknown> = Promise.resolve();

  function canonical(next: AuthSessionSnapshot): AuthSessionSnapshot {
    if (next.phase === 'closing' && next.revocationClosing) return next;
    const value = { ...next };
    delete value.revocationClosing;
    return value;
  }
  function publish(next: AuthSessionSnapshot): AuthSessionSnapshot {
    const value = canonical(next);
    if (JSON.stringify(snapshot) === JSON.stringify(value)) return snapshot;
    const identityChanged = !sameIdentity(snapshot, value);
    if (identityChanged) { identityVersion++; uiSessionId = null; }
    snapshot = Object.freeze(value);
    for (const listener of listeners) listener();
    return snapshot;
  }
  function parse(raw: string | null): AuthSessionSnapshot | null {
    if (!raw) return null;
    try {
      const value = JSON.parse(raw) as AuthSessionSnapshot;
      if (value.serverKey !== serverKey || typeof value.sessionInstanceId !== 'string' || value.sessionInstanceId.length < 16
        || !Number.isSafeInteger(value.tokenRevision) || value.tokenRevision < 0 || !['ready', 'signedOut', 'closing'].includes(value.phase)
        || (value.token !== null && !isValidRefreshedToken(value.token))) return null;
      if (value.phase === 'closing' && (!value.token || value.revocationClosing?.version !== 1
        || value.revocationClosing.reason !== 'explicit-logout' || value.revocationClosing.sessionInstanceId !== value.sessionInstanceId
        || value.revocationClosing.tokenRevision !== value.tokenRevision)) return null;
      return Object.freeze({ ...value, nativeHandle: null, nativeGeneration: null, storageMode: shared ? 'shared' : 'window' });
    } catch { return null; }
  }
  function read(): AuthSessionSnapshot {
    if (desktop) return snapshot;
    return parse(storage.getItem(storageKey)) ?? { ...snapshot, sessionInstanceId: `missing:${serverKey}`,
      token: null, userId: null, tokenRevision: 0, phase: 'signedOut', nativeHandle: null, nativeGeneration: null };
  }
  function persist(next: AuthSessionSnapshot): AuthSessionSnapshot {
    const normalized = canonical(next);
    if (!desktop) storage.setItem(storageKey, JSON.stringify(normalized));
    const value = publish(normalized);
    host.notify?.();
    return value;
  }
  async function transaction<T>(mode: 'exclusive' | 'shared', work: () => T): Promise<T> {
    if (shared && locks) return locks.request(SESSION_LOCK, { mode }, work);
    const operation = queue.catch(() => undefined).then(work);
    queue = operation.then(() => undefined, () => undefined);
    return operation;
  }
  async function initialize(): Promise<AuthSessionSnapshot> {
    if (!initialized) initialized = transaction('exclusive', () => {
      if (desktop) return snapshot;
      const saved = parse(storage.getItem(storageKey));
      if (saved) {
        revocationClosing = saved.phase === 'closing';
        if (saved.token && isAuthTokenExpired(saved.token)) {
          revocationClosing = false;
          return persist({ ...saved, sessionInstanceId: newId(), token: null, userId: null, tokenRevision: 0, phase: 'signedOut', revocationClosing: undefined });
        }
        return publish(saved);
      }
      // Legacy shared credentials migrate only under a real cross-window lock. Isolated fallback windows require their own login.
      const legacy = shared ? host.sharedStorage?.getItem(LEGACY_TOKEN_KEY) ?? globalThis.localStorage?.getItem(LEGACY_TOKEN_KEY) : null;
      const token = isValidRefreshedToken(legacy) && !isAuthTokenExpired(legacy) ? legacy : null;
      const next: AuthSessionSnapshot = { ...snapshot, token, userId: token ? tokenUser(token) : null, phase: token ? 'ready' : 'signedOut' };
      persist(next);
      if (shared) (host.sharedStorage ?? globalThis.localStorage)?.removeItem(LEGACY_TOKEN_KEY);
      return snapshot;
    }).catch(error => { initialized = null; throw error; });
    await initialized;
    return snapshot;
  }
  async function synchronize(): Promise<AuthSessionSnapshot> {
    await initialize();
    return transaction('shared', () => {
      if (localTransition) return snapshot;
      const current = read();
      revocationClosing = current.phase === 'closing';
      return publish(current);
    });
  }
  async function commit(expected: AuthSessionPredecessor, mutate: (current: AuthSessionSnapshot) => AuthSessionSnapshot): Promise<AuthSessionSnapshot | null> {
    await initialize();
    return transaction('exclusive', () => {
      if (revocationClosing) return null;
      const current = read();
      if (current.phase === 'closing') { revocationClosing = true; publish(current); return null; }
      if (!sameRevision(expected, current)) { publish(current); return null; }
      return persist(mutate(current));
    });
  }
  async function start(token: string, expected: AuthSessionPredecessor = snapshot): Promise<AuthSessionSnapshot | null> {
    if (!isValidRefreshedToken(token) || isAuthTokenExpired(token)) return null;
    return commit(expected, current => ({ ...current, sessionInstanceId: newId(), token, userId: tokenUser(token), tokenRevision: 0, phase: 'ready', revocationClosing: undefined }));
  }
  async function refresh(token: unknown, expected: AuthSessionPredecessor = snapshot): Promise<boolean> {
    if (!isValidRefreshedToken(token) || isAuthTokenExpired(token)) return false;
    const next = await commit(expected, current => {
      if (!current.token || (current.userId !== null && tokenUser(token) !== current.userId)) return current;
      return { ...current, token, tokenRevision: current.tokenRevision + 1 };
    });
    return next !== null && next.tokenRevision === expected.tokenRevision + 1 && next.token === token;
  }
  async function end(expected: AuthSessionPredecessor = snapshot): Promise<boolean> {
    if (revocationClosing) return false;
    if (!sameRevision(expected, snapshot)) return false;
    const transition = newId();
    localTransition = transition;
    // Freeze this renderer before awaiting the authority; an old UI cannot dispatch while logout is queued.
    identityVersion++;
    publish({ ...snapshot, phase: 'closing' });
    try {
      return Boolean(await commit(expected, current => ({ ...current, sessionInstanceId: newId(), token: null,
        userId: null, tokenRevision: 0, phase: 'signedOut', nativeHandle: null, nativeGeneration: null })));
    } finally {
      if (localTransition === transition) {
        localTransition = null;
        if (desktop && snapshot.phase === 'closing') publish({ ...snapshot, phase: snapshot.token ? 'ready' : 'signedOut' });
        await synchronize();
      }
    }
  }
  async function endWithRevocation<T>(expected: AuthSessionPredecessor, prepare: (current: AuthSessionSnapshot) => { operation: Promise<T> } | Promise<{ operation: Promise<T> }>): Promise<{ operation: Promise<T>; snapshot: AuthSessionSnapshot } | null> {
    if (desktop || !sameRevision(expected, snapshot) || !snapshot.token || !['ready', 'closing'].includes(snapshot.phase)) return null;
    if (localTransition && snapshot.phase !== 'closing') throw interrupted('Another account transition is pending');
    const transition = newId();
    localTransition = transition;
    revocationClosing = true;
    identityVersion++;
    // Freeze this renderer synchronously, then serialize durable intent/dispatch/end with all shared identity writers.
    publish({ ...snapshot, phase: 'closing' });
    let completed = false;
    try {
      await initialize();
      return await transaction('exclusive', async () => {
        const current = read();
        if (!sameRevision(expected, current) || !current.token || !['ready', 'closing'].includes(current.phase)) {
          completed = true;
          publish(current);
          return null;
        }
        // Persist the fence before IDB/network work so a crash or page reload cannot restore this login as usable.
        if (current.phase !== 'closing') persist({ ...current, phase: 'closing', revocationClosing: {
          version: 1, reason: 'explicit-logout', sessionInstanceId: current.sessionInstanceId, tokenRevision: current.tokenRevision,
        } });
        const prepared = await prepare({ ...current, phase: 'ready' });
        // Only a short local durable transaction is awaited. The network promise remains boxed and never holds the session lock.
        const ended = persist({ ...current, sessionInstanceId: newId(), token: null, userId: null, tokenRevision: 0,
          phase: 'signedOut', nativeHandle: null, nativeGeneration: null, revocationClosing: undefined });
        completed = true;
        return { operation: prepared.operation, snapshot: ended };
      });
    } finally {
      if (localTransition === transition && completed) {
        localTransition = null;
        revocationClosing = false;
        await synchronize();
      }
      // A failed durable write stays closing and retryable. Restoring ready would expose a possibly revoked token as usable.
    }
  }
  async function dispatch<T>(expected: AuthSessionPredecessor, operation: (current: AuthSessionSnapshot) => Promise<T>, allowUnrendered = false): Promise<{ operation: Promise<T>; snapshot: AuthSessionSnapshot }> {
    await initialize();
    return transaction('shared', () => {
      const current = read();
      if (localTransition || !sameIdentity(expected, current) || (current.phase !== 'ready' && current.phase !== 'signedOut')
        || (!allowUnrendered && current.token && uiSessionId !== current.sessionInstanceId)) throw interrupted();
      if (current.token && isAuthTokenExpired(current.token)) {
        void end(current).catch(() => { /* Auth surfaces a storage failure; never send an expired bearer. */ });
        throw interrupted('Account session expired');
      }
      publish(current);
      // Return a box: do not hold a cross-window lock until the network response completes. Dispatch itself occurs under the lock.
      return { operation: operation(current), snapshot: current };
    });
  }
  function beginSwitch(): string {
    if (localTransition) throw interrupted('Another account transition is pending');
    const attempt = newId();
    localTransition = attempt;
    transitionPredecessor = snapshot;
    publish({ ...snapshot, phase: 'switching' });
    return attempt;
  }
  async function finishSwitch(attempt: string, changed: boolean): Promise<void> {
    if (localTransition !== attempt) throw interrupted();
    try {
      if (changed) await commit(snapshot, current => ({ ...current, sessionInstanceId: newId(), token: null,
        tokenRevision: 0, userId: null, phase: 'signedOut', nativeHandle: null, nativeGeneration: null }));
    } finally {
      if (localTransition === attempt) {
        localTransition = null;
        if (desktop && snapshot.phase === 'switching' && transitionPredecessor) publish(transitionPredecessor);
        transitionPredecessor = null;
        await synchronize();
      }
    }
  }
  function observeNative(next: AuthSessionSnapshot): AuthSessionSnapshot {
    if (!desktop) throw new Error('Native identity is unavailable in this browser');
    return publish({ ...next, userId: next.userId ?? (next.token ? tokenUser(next.token) : null), storageMode: 'window' });
  }
  function acknowledge(expected: AuthSessionPredecessor): void {
    if (sameIdentity(expected, snapshot)) uiSessionId = snapshot.sessionInstanceId;
  }
  return { initialize, synchronize, start, refresh, end, endWithRevocation, dispatch, beginSwitch, finishSwitch, observeNative, acknowledge,
    getSnapshot: () => snapshot, getIdentityVersion: () => identityVersion,
    isCurrent: (expected: AuthSessionPredecessor, includeTokenRevision = false) => !localTransition
      && (includeTokenRevision ? sameRevision(expected, snapshot) : sameIdentity(expected, snapshot)),
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
}

const authority = createAuthSessionStore();

/** Auth bootstraps the shared authority before checking the current account; APIs can await the same idempotent operation. */
export const initializeAuthSession = authority.initialize;
/** Storage notifications only wake observers; authority is reread under the same lock used by writers. */
export const synchronizeAuthSession = authority.synchronize;
/** React auth and transports subscribe to a stable immutable snapshot, including explicit transition phases. */
export const getAuthSessionSnapshot = authority.getSnapshot;
/** Existing async feature work uses this incarnation counter to reject old responses. */
export const getAuthSessionVersion = authority.getIdentityVersion;
/** API and auth compare an operation's captured identity before applying results. */
export const isCurrentAuthSession = authority.isCurrent;
/** Auth and sockets react to every committed state/transport transition. Notifications never carry credentials. */
export const subscribeToAuthSession = authority.subscribe;
/** Successful explicit login conditionally creates an ABA-safe new incarnation. */
export const startAuthSession = authority.start;
/** Only a matching request's response may rotate this account's credential. */
export const storeAuthToken = authority.refresh;
/** Logout/expiry conditionally revokes the captured identity, never whichever account happens to be current later. */
export const clearAuthToken = authority.end;
/** Explicit web logout persists a revocation intent and dispatches its exact predecessor before clearing local authority. */
export const endAuthSessionWithRevocation = authority.endWithRevocation;
/** HTTP dispatch checks the renderer's captured identity against authority before reading its token. */
export const dispatchWithAuthSession = authority.dispatch;
/** Native target probes freeze renderer authentication before awaiting a bridge call. */
export const beginAuthServerSwitch = authority.beginSwitch;
/** Failed/no-op probes explicitly resume transport; changed targets clear the previous session. */
export const finishAuthServerSwitch = authority.finishSwitch;
/** The desktop bridge mirrors its authoritative, capability-bound identity into auth's reactive store. */
export const observeNativeAuthSession = authority.observeNative;
/** AuthProvider acknowledges a verified/rendered account before ordinary UI requests may use it. */
export const acknowledgeAuthSession = authority.acknowledge;
/** Synchronous UI/URL readers use their observed token; transport must still use dispatchWithAuthSession. */
export function getStoredAuthToken(): string | null {
  const current = authority.getSnapshot();
  return current.phase === 'ready' && current.token && !isAuthTokenExpired(current.token) ? current.token : null;
}
/** Expiry is a conditional logout; callers await completion before publishing session-expired UI. */
export const expireAuthSession = authority.end;

if (typeof window !== 'undefined') {
  const refreshObservation = () => { void authority.synchronize().catch(() => { /* Auth bootstrap exposes storage failures to its retry UI. */ }); };
  window.addEventListener('storage', event => { if (event.key?.startsWith(SESSION_STORAGE_KEY + ':') || event.key === null) refreshObservation(); });
  window.addEventListener(SESSION_CHANGED_EVENT, refreshObservation);
}
