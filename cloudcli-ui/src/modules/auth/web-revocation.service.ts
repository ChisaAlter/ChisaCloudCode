import { api } from '@/shared/api';
import { endAuthSessionWithRevocation } from '@/shared/authToken';
import type { AuthSessionSnapshot } from '@/shared/types';

type PendingRevocation = {
  key: string;
  format: 1;
  serverKey: string;
  incarnation: string;
  revision: number;
  sessionId: string | null;
  userId: string | null;
  token: string;
  expiresAt: number;
};
type Receipt = { incarnation: string; serverKey: string; remoteStatus: 'revoked' | 'pending' | 'expired' | 'rejected' };
type QueueAdapter = {
  reserve(item: PendingRevocation, now: number): Promise<void>;
  list(serverKey: string): Promise<PendingRevocation[]>;
  removeExact(item: PendingRevocation): Promise<void>;
};
type Dependencies = {
  end: typeof endAuthSessionWithRevocation;
  request: (token: string, serverKey: string) => Promise<Response>;
  queue: QueueAdapter;
  serverKey: () => string;
  now?: () => number;
  locks?: LockManager;
};

function claims(token: string): { exp?: unknown; sid?: unknown } {
  try {
    const value = token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const decoded: unknown = JSON.parse(atob(value.padEnd(Math.ceil(value.length / 4) * 4, '=')));
    return decoded && typeof decoded === 'object' ? decoded as { exp?: unknown; sid?: unknown } : {};
  } catch { return {}; }
}
function valid(item: PendingRevocation, server: string): boolean {
  if (!item || item.format !== 1 || item.serverKey !== server || typeof item.incarnation !== 'string'
    || item.incarnation.length > 256 || !Number.isSafeInteger(item.revision) || item.revision < 0
    || typeof item.token !== 'string' || item.token.length > 8192 || !Number.isSafeInteger(item.expiresAt)
    || (item.sessionId !== null && typeof item.sessionId !== 'string') || (item.userId !== null && typeof item.userId !== 'string')) return false;
  const decoded = claims(item.token);
  return decoded.exp === item.expiresAt && (typeof decoded.sid === 'string' ? decoded.sid : null) === item.sessionId;
}
function queueKey(item: Pick<PendingRevocation, 'serverKey' | 'incarnation' | 'revision'>): string {
  return encodeURIComponent(item.serverKey) + ':' + encodeURIComponent(item.incarnation) + ':' + item.revision;
}

function indexedQueue(factory?: IDBFactory): QueueAdapter {
  let opened: Promise<IDBDatabase> | null = null;
  function database(): Promise<IDBDatabase> {
    if (opened) return opened;
    opened = new Promise<IDBDatabase>((resolve, reject) => {
      const source = factory ?? (typeof indexedDB === 'undefined' ? undefined : indexedDB);
      if (!source) { reject(new Error('Persistent logout storage is unavailable')); return; }
      const request = source.open('chisa-web-revocations:v1', 1);
      const timeout = setTimeout(() => reject(new Error('Persistent logout storage is blocked')), 3000);
      request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('pending')) request.result.createObjectStore('pending', { keyPath: 'key' }); };
      request.onerror = () => { clearTimeout(timeout); reject(request.error ?? new Error('Persistent logout storage failed')); };
      request.onblocked = () => { clearTimeout(timeout); reject(new Error('Persistent logout storage is blocked')); };
      request.onsuccess = () => {
        clearTimeout(timeout); const connection = request.result;
        connection.onversionchange = () => { connection.close(); opened = null; };
        resolve(connection);
      };
    }).catch(error => { opened = null; throw error; });
    return opened;
  }
  async function mutate(work: (store: IDBObjectStore, abort: (error: Error) => void) => void): Promise<void> {
    const connection = await database();
    await new Promise<void>((resolve, reject) => {
      const transaction = connection.transaction('pending', 'readwrite', { durability: 'strict' });
      let failure: Error | null = null;
      const abort = (error: Error) => { failure = error; transaction.abort(); };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => { /* onabort owns the failure after all requests settle */ };
      transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('Persistent logout transaction failed'));
      try { work(transaction.objectStore('pending'), abort); } catch (error) { abort(error instanceof Error ? error : new Error('Persistent logout write failed')); }
    });
  }
  return {
    async reserve(item, now) {
      await mutate((store, abort) => {
        const all = store.getAll();
        all.onsuccess = () => {
          const entries = all.result as PendingRevocation[];
          let live = 0;
          let existing: PendingRevocation | undefined;
          for (const entry of entries) {
            if (typeof entry.expiresAt === 'number' && entry.expiresAt <= now) { store.delete(entry.key); continue; }
            live++;
            if (entry.key === item.key) existing = entry;
          }
          if (existing) {
            if (JSON.stringify(existing) !== JSON.stringify(item)) abort(new Error('Conflicting pending logout'));
            return;
          }
          if (live >= 32) { abort(new Error('Pending logout capacity reached')); return; }
          store.add(item);
        };
      });
    },
    async list(serverKey) {
      const connection = await database();
      return new Promise<PendingRevocation[]>((resolve, reject) => {
        const transaction = connection.transaction('pending', 'readonly');
        const request = transaction.objectStore('pending').getAll();
        let result: PendingRevocation[] = [];
        request.onsuccess = () => { result = (request.result as PendingRevocation[]).filter(item => valid(item, serverKey) && queueKey(item) === item.key); };
        transaction.oncomplete = () => resolve(result);
        transaction.onabort = () => reject(transaction.error ?? new Error('Pending logout read failed'));
      });
    },
    async removeExact(item) {
      await mutate(store => {
        const existing = store.get(item.key);
        existing.onsuccess = () => { if (JSON.stringify(existing.result) === JSON.stringify(item)) store.delete(item.key); };
      });
    },
  };
}

/** Auth service composition and its tests share a transactional adapter; browsers use their persistent origin-scoped IndexedDB. */
export function createWebRevocationQueue(factory?: IDBFactory): QueueAdapter {
  return indexedQueue(factory);
}

/** AuthProvider owns explicit logout; tests combine real session authorities with isolated transactional queue adapters. */
export function createWebRevocationService(dependencies: Dependencies) {
  const now = dependencies.now ?? (() => Math.floor(Date.now() / 1000));
  const inFlight = new Map<string, Promise<Receipt>>();
  const receipt = (item: PendingRevocation, remoteStatus: Receipt['remoteStatus']): Receipt => ({ incarnation: item.incarnation, serverKey: item.serverKey, remoteStatus });
  async function settle(item: PendingRevocation, response: Promise<Response>): Promise<Receipt> {
    try {
      const result = await response;
      let acknowledged = false;
      if (result.ok && !result.redirected) {
        try { const data = await result.json() as { success?: unknown }; acknowledged = data.success === true; } catch { /* keep pending */ }
      } else { void result.body?.cancel().catch(() => {}); }
      if (acknowledged) { await dependencies.queue.removeExact(item); return receipt(item, 'revoked'); }
      if (item.expiresAt <= now()) { await dependencies.queue.removeExact(item); return receipt(item, 'expired'); }
      return receipt(item, result.status === 401 || result.status === 403 ? 'rejected' : 'pending');
    } catch { return receipt(item, 'pending'); }
  }
  function dispatch(item: PendingRevocation): Promise<Receipt> {
    const existing = inFlight.get(item.key);
    if (existing) return existing;
    let response: Promise<Response>;
    try { response = dependencies.request(item.token, item.serverKey); } catch { response = Promise.reject(new Error('Revocation transport unavailable')); }
    const operation = settle(item, response).finally(() => { if (inFlight.get(item.key) === operation) inFlight.delete(item.key); });
    inFlight.set(item.key, operation);
    return operation;
  }
  async function prepare(snapshot: AuthSessionSnapshot): Promise<{ operation: Promise<Receipt> }> {
    if (snapshot.phase !== 'ready' || !snapshot.token || snapshot.serverKey !== dependencies.serverKey()) throw new Error('Logout session changed');
    const decoded = claims(snapshot.token);
    if (typeof decoded.exp !== 'number' || !Number.isSafeInteger(decoded.exp) || decoded.exp <= 0) throw new Error('Cannot persist logout without a bounded session lifetime');
    const proof = { format: 1 as const, serverKey: snapshot.serverKey, incarnation: snapshot.sessionInstanceId,
      revision: snapshot.tokenRevision, sessionId: typeof decoded.sid === 'string' ? decoded.sid : null,
      userId: snapshot.userId, token: snapshot.token, expiresAt: decoded.exp };
    const item: PendingRevocation = { ...proof, key: queueKey(proof) };
    // IDB readwrite transactions serialize across windows even where Web Locks is absent, enforcing one durable global cap.
    await dependencies.queue.reserve(item, now());
    if (item.expiresAt <= now()) { await dependencies.queue.removeExact(item); return { operation: Promise.resolve(receipt(item, 'expired')) }; }
    // Durable transaction has committed before this captured Bearer is sent. Never await network under auth authority.
    return { operation: dispatch(item) };
  }
  return {
    logout(expected: AuthSessionSnapshot) { return dependencies.end(expected, prepare); },
    async pending(): Promise<Receipt[]> {
      return (await dependencies.queue.list(dependencies.serverKey())).map(item => receipt(item, item.expiresAt <= now() ? 'expired' : 'pending'));
    },
    async retry(): Promise<Receipt[]> {
      const results: Receipt[] = [];
      for (const item of await dependencies.queue.list(dependencies.serverKey())) {
        const attempt = async () => {
          const stored = await dependencies.queue.list(item.serverKey);
          if (!stored.some(current => JSON.stringify(current) === JSON.stringify(item))) return null;
          if (item.expiresAt <= now()) { await dependencies.queue.removeExact(item); return { operation: Promise.resolve(receipt(item, 'expired')) }; }
          return { operation: dispatch(item) };
        };
        const admitted = dependencies.locks
          ? await dependencies.locks.request(item.key, { ifAvailable: true }, lock => lock ? attempt() : null)
          : await attempt();
        const result = await admitted?.operation;
        if (result) results.push(result);
      }
      return results;
    },
  };
}

const revocations = createWebRevocationService({
  end: endAuthSessionWithRevocation,
  request: (token, serverKey) => api.auth.revokeCapturedWebSession(token, serverKey),
  queue: createWebRevocationQueue(),
  serverKey: () => location.origin + (location.pathname.match(/^\/instances\/[a-zA-Z0-9_-]+(?=\/|$)/)?.[0] ?? ''),
  locks: typeof navigator === 'undefined' ? undefined : navigator.locks,
});
/** AuthProvider freezes and clears only the captured web identity after its revocation is durably recorded and dispatched. */
export const logoutWebSession = revocations.logout;
/** AuthProvider restores a credential-free pending notice without importing any outbox credential into the active login. */
export const pendingWebRevocations = revocations.pending;
/** AuthProvider retries the original durable credentials across tab closure; replacement logins never donate their token. */
export const retryWebRevocations = revocations.retry;
