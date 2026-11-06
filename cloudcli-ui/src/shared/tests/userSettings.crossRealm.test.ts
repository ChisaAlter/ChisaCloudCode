import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { createAuthSessionStore } from '@/modules/auth-session';
import type { ApiRequestOptions } from '@/shared/api';
import { createUserPreferenceStore } from '@/shared/userSettings';
import type { UserPreferenceTransaction } from '@/shared/types';

type Store = ReturnType<typeof createUserPreferenceStore>;
type Request = UserPreferenceTransaction & { renderer: string; bearer: string | null; options: ApiRequestOptions };

const SERVER = window.location.origin;
const PARTITION_KEY = 'user-preferences:v2:' + encodeURIComponent(JSON.stringify([SERVER, 'A']));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function token(userId = 'A', rotation = 'initial'): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256' })}.${encode({ userId, jti: rotation, iat: 1_700_000_000, exp: 4_102_444_800 })}.signature`;
}

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return { get length() { return values.size; }, clear: () => values.clear(), getItem: key => values.get(key) ?? null,
    key: index => [...values.keys()][index] ?? null, removeItem: key => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); } };
}

// Each factory receives its own session storage/event target and the same serialized cross-renderer lock authority.
class LockHost {
  readonly tails = new Map<string, Promise<unknown>>();
  readonly active = new Set<string>();
  readonly manager = { request: (name: string, _options: unknown, work: () => unknown) => {
    const previous = this.tails.get(name) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      this.active.add(name);
      try {
        const result = work();
        if (name === PARTITION_KEY) assert.equal(result instanceof Promise, false, 'preference lock callbacks must be synchronous');
        return result instanceof Promise ? await result : result;
      } finally { this.active.delete(name); }
    });
    this.tails.set(name, next);
    return next;
  } } as unknown as LockManager;

  async block(name: string): Promise<() => void> {
    const entered = deferred<void>();
    const barrier = deferred<void>();
    const previous = this.tails.get(name) ?? Promise.resolve();
    this.tails.set(name, previous.then(() => { entered.resolve(); return barrier.promise; }));
    await entered.promise;
    return () => { barrier.resolve(); };
  }
}

// Tests own all factory instances, including reopened renderers, to cancel every timer/listener at completion.
let stores: Store[];
let locks: LockHost;
let shared: Storage;
let events: Map<string, EventTarget>;
let requests: Request[];
let server: Record<string, unknown>;
let versions: Record<string, number>;
let journal: Map<string, { payload: string; result: Record<string, unknown>; status: number }>;
let commits: number;
let saveResults: Array<Promise<Response> | Response | Error>;
let loadResults: Array<Promise<Response> | Response>;
let admissions: Map<string, Promise<void>>;
// Missing storage hints must not turn a stale renderer mirror into transaction authority.
let suppressedEvents: Set<string>;

function sharedView(renderer: string): Storage {
  return { get length() { return shared.length; }, clear: () => shared.clear(), getItem: key => shared.getItem(key),
    key: index => shared.key(index), removeItem: key => shared.removeItem(key), setItem: (key, value) => {
      const changed = shared.getItem(key) !== value;
      shared.setItem(key, value);
      if (changed) for (const [other, target] of events) if (other !== renderer && !suppressedEvents.has(other)) {
        queueMicrotask(() => target.dispatchEvent(new StorageEvent('storage', { key })));
      }
    } };
}

function jsonResponse(preferences: Record<string, unknown>, revisions = { ...versions }): Response {
  return new Response(JSON.stringify({ success: true, preferences, revisions }), { status: 200 });
}

// Synchronous compare + all-field commit + historical ACK model the frozen server's serialized transaction.
function commit(input: UserPreferenceTransaction): Response {
  const payload = JSON.stringify({ operationId: input.operationId, updates: input.updates, expectedRevisions: input.expectedRevisions });
  const previous = journal.get(input.operationId);
  if (previous) {
    assert.equal(previous.payload, payload, 'a replay cannot mutate its transaction');
    return new Response(JSON.stringify({ ...previous.result, replayed: true }), { status: previous.status });
  }
  const touched = Object.keys(input.updates);
  const conflict = touched.some(key => input.expectedRevisions[key] !== (versions[key] ?? 0));
  if (!conflict) {
    for (const key of touched) { server[key] = input.updates[key]; versions[key] = (versions[key] ?? 0) + 1; }
    commits++;
  }
  const result = { success: !conflict, operationId: input.operationId, replayed: false,
    ...(conflict ? { code: 'PREFERENCE_REVISION_CONFLICT' } : {}),
    preferences: Object.fromEntries(touched.filter(key => Object.prototype.hasOwnProperty.call(server, key)).map(key => [key, server[key]])),
    revisions: Object.fromEntries(touched.map(key => [key, versions[key] ?? 0])) };
  journal.set(input.operationId, { payload, result, status: conflict ? 409 : 200 });
  return new Response(JSON.stringify(result), { status: conflict ? 409 : 200 });
}

async function renderer(name: string, options: { noLocks?: boolean; windowStorage?: Storage; sharedStorage?: Storage } = {}) {
  const eventTarget = new EventTarget();
  events.set(name, eventTarget);
  const local = options.sharedStorage ?? sharedView(name);
  const windowStorage = options.windowStorage ?? memoryStorage();
  const authority = createAuthSessionStore({ serverKey: SERVER, sharedStorage: local, windowStorage,
    locks: options.noLocks ? undefined : locks.manager });
  const restored = await authority.initialize();
  const session = restored.phase === 'ready' ? restored : await authority.start(token());
  assert.ok(session);
  authority.acknowledge(session);
  const transport = {
    save: async (input: UserPreferenceTransaction, requestOptions: ApiRequestOptions = {}) => {
      assert.ok(requestOptions.expectedSession, 'dispatch must retain the pre-transaction session');
      assert.equal(locks.active.has(PARTITION_KEY), false, 'HTTP must never run while holding the preference lock');
      const barrier = admissions.get(name);
      if (barrier) await barrier;
      const dispatched = await authority.dispatch(requestOptions.expectedSession, current => {
        requestOptions.signal?.throwIfAborted();
        requests.push({ renderer: name, ...input, bearer: current.token, options: requestOptions });
        const result = saveResults.shift();
        return Promise.resolve().then(async () => {
          if (result instanceof Error) throw result;
          const response = result ? await result : null;
          return response ?? commit(input);
        });
      });
      return dispatched.operation;
    },
    load: async (requestOptions: ApiRequestOptions = {}) => {
      assert.ok(requestOptions.expectedSession);
      const dispatched = await authority.dispatch(requestOptions.expectedSession, () =>
        Promise.resolve(loadResults.shift() ?? jsonResponse(server)));
      return dispatched.operation;
    },
  };
  const store = createUserPreferenceStore({ auth: { getSnapshot: authority.getSnapshot, initialize: authority.initialize,
    subscribe: authority.subscribe }, transport, sharedStorage: local, windowStorage, events: eventTarget,
    locks: options.noLocks ? null : locks.manager });
  stores.push(store);
  await settle();
  return { store, authority, local, windowStorage, events: eventTarget };
}

async function settle(): Promise<void> { await vi.advanceTimersByTimeAsync(0); }

function durable() {
  return JSON.parse(shared.getItem(PARTITION_KEY)!) as {
    preferences: Record<string, unknown>; revisions: Record<string, number>; serverRevisions: Record<string, number>;
    operations: Array<{ transaction: UserPreferenceTransaction }>;
    pending: Record<string, { revision: number; value: unknown }>;
    inFlight: Record<string, { revision: number; value: unknown }>;
    lease: { id: string; owner: string; expiresAt: number } | null;
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-31T12:00:00Z'));
  locks = new LockHost();
  stores = [];
  shared = memoryStorage();
  events = new Map();
  requests = [];
  server = {};
  versions = {};
  journal = new Map();
  commits = 0;
  saveResults = [];
  loadResults = [];
  admissions = new Map();
  suppressedEvents = new Set();
});

afterEach(() => {
  for (const store of stores) store.dispose();
  vi.clearAllTimers();
  vi.useRealTimers();
});

test('two independent authorities merge different-field edits behind a deterministic transaction barrier and dispatch once', async () => {
  const a = await renderer('a');
  const b = await renderer('b');
  assert.notEqual(a.authority, b.authority);
  const release = await locks.block(PARTITION_KEY);
  a.store.writeUserPreference('theme', 'dark');
  b.store.writeUserPreference('userLanguage', 'de');
  assert.equal(a.store.readUserPreference('theme', null), 'dark', 'optimistic reads remain synchronous while locked');
  assert.equal(durable().pending.theme, undefined);
  release();
  await settle();
  assert.equal(durable().pending.theme.value, 'dark');
  assert.equal(durable().pending.userLanguage.value, 'de');
  assert.equal(a.store.readUserPreference('userLanguage', null), 'de');
  assert.equal(b.store.readUserPreference('theme', null), 'dark');
  await vi.advanceTimersByTimeAsync(400);
  assert.deepEqual(requests.map(request => request.updates), [{ theme: 'dark', userLanguage: 'de' }]);
  assert.equal(a.store.getPreferenceSyncStatus().status, 'saved');
  assert.equal(b.store.getPreferenceSyncStatus().status, 'saved');
});

test('same-field last committed transaction wins; a stale 2xx cannot ACK the newer revision', async () => {
  const a = await renderer('a');
  const b = await renderer('b');
  const first = deferred<Response>();
  const second = deferred<Response>();
  saveResults.push(first.promise, second.promise);
  a.store.writeUserPreference('theme', 'dark');
  await vi.advanceTimersByTimeAsync(400);
  const oldRevision = durable().inFlight.theme.revision;
  const release = await locks.block(PARTITION_KEY);
  a.store.writeUserPreference('theme', 'dark');
  b.store.writeUserPreferences({ theme: 'light', userLanguage: 'de' });
  release();
  await settle();
  assert.ok(durable().revisions.theme > oldRevision);
  assert.equal(durable().preferences.theme, 'light');
  assert.equal(a.store.readUserPreference('theme', null), 'light');
  await vi.advanceTimersByTimeAsync(1000);
  assert.equal(requests.length, 1, 'a live foreign lease prevents duplicate or overtaking patches');
  first.resolve(commit(requests[0]!));
  await settle();
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].updates, { theme: 'light', userLanguage: 'de' });
  assert.equal(a.store.getPreferenceSyncStatus().status, 'saving');
  assert.equal(b.store.getPreferenceSyncStatus().status, 'saving');
  second.resolve(commit(requests[1]!));
  await settle();
  assert.equal(server.theme, 'light');
  assert.equal(b.store.getPreferenceSyncStatus().status, 'saved');
});

test('a delayed hydrate merges a different-field edit without overwriting an ACK or superseding dirty edit in another renderer', async () => {
  const a = await renderer('a');
  const b = await renderer('b');
  await b.store.hydrateUserPreferences();
  const hydration = deferred<Response>();
  loadResults.push(hydration.promise);
  const loading = a.store.hydrateUserPreferences();
  await settle();
  b.store.writeUserPreference('theme', 'dark');
  await vi.advanceTimersByTimeAsync(400);
  assert.equal(b.store.getPreferenceSyncStatus().status, 'saved');
  b.store.writeUserPreference('tasksEnabled', true);
  await settle();
  hydration.resolve(jsonResponse({ theme: 'light', userLanguage: 'ja', tasksEnabled: false }));
  await loading;
  await settle();
  assert.equal(durable().preferences.theme, 'dark');
  assert.equal(durable().preferences.userLanguage, 'ja');
  assert.equal(durable().pending.tasksEnabled.value, true);
  assert.equal(a.store.readUserPreference('tasksEnabled', false), true);
});

test('competing hydrates use the committed field clock so a delayed GET cannot overwrite a newer hydration', async () => {
  const a = await renderer('a');
  const b = await renderer('b');
  const slow = deferred<Response>();
  loadResults.push(slow.promise);
  const loading = a.store.hydrateUserPreferences();
  await settle();
  loadResults.push(jsonResponse({ theme: 'dark' }));
  await b.store.hydrateUserPreferences();
  slow.resolve(jsonResponse({ theme: 'light' }));
  await loading;
  assert.equal(durable().preferences.theme, 'dark');
});

test('a crashed dispatcher is recovered at lease expiry without storage events and replays only each latest revision', async () => {
  const a = await renderer('a');
  const b = await renderer('b');
  const lost = deferred<Response>();
  saveResults.push(lost.promise);
  a.store.writeUserPreferences({ theme: 'dark', userLanguage: 'de' });
  await vi.advanceTimersByTimeAsync(400);
  assert.equal(requests.length, 1);
  const expiresAt = durable().lease!.expiresAt;
  a.store.dispose();
  events.delete('a');
  b.store.writeUserPreference('theme', 'light');
  await settle();
  await vi.advanceTimersByTimeAsync(expiresAt - Date.now() - 1);
  assert.equal(requests.length, 1);
  await vi.advanceTimersByTimeAsync(1);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].updates, { theme: 'light', userLanguage: 'de' });
  assert.equal(durable().lease, null);
  assert.equal(b.store.getPreferenceSyncStatus().status, 'saved');
});

test('reopening after all renderers crash observes the live lease then resumes at expiry, retaining exact revision', async () => {
  const a = await renderer('a');
  saveResults.push(deferred<Response>().promise);
  a.store.writeUserPreference('selectedProvider', 'codex');
  await vi.advanceTimersByTimeAsync(400);
  const revision = durable().revisions.selectedProvider;
  const expiresAt = durable().lease!.expiresAt;
  a.store.dispose();
  events.delete('a');
  const reopened = await renderer('reopened', { windowStorage: a.windowStorage });
  await vi.advanceTimersByTimeAsync(400);
  assert.equal(requests.length, 1);
  await vi.advanceTimersByTimeAsync(expiresAt - Date.now());
  assert.equal(requests.length, 2);
  assert.equal(durable().revisions.selectedProvider, revision);
  assert.equal(reopened.store.getPreferenceSyncStatus().status, 'saved');
});

test('request timeout releases a live dispatcher and retries within the bounded budget without holding Web Locks', async () => {
  const a = await renderer('a');
  const b = await renderer('b');
  saveResults.push(deferred<Response>().promise);
  a.store.writeUserPreference('theme', 'dark');
  await vi.advanceTimersByTimeAsync(400);
  assert.equal(locks.active.has(PARTITION_KEY), false);
  b.store.writeUserPreference('userLanguage', 'de');
  await settle();
  assert.equal(durable().pending.userLanguage.value, 'de', 'the network wait cannot block a second renderer edit');
  await vi.advanceTimersByTimeAsync(10_000);
  assert.equal(requests[0].options.signal?.aborted, true);
  await vi.advanceTimersByTimeAsync(1000);
  assert.equal(requests.length, 3, 'the other field saves immediately, followed by the timed-out field retry');
  assert.deepEqual(server, { theme: 'dark', userLanguage: 'de' });
  assert.equal(b.store.getPreferenceSyncStatus().status, 'saved');
});

test('storage events only wake a locked reread; forged newValue cannot introduce preferences or clear dirty revisions', async () => {
  const a = await renderer('a');
  a.store.writeUserPreference('theme', 'dark');
  await settle();
  const before = JSON.stringify(durable());
  a.events.dispatchEvent(new StorageEvent('storage', { key: PARTITION_KEY,
    newValue: JSON.stringify({ preferences: { theme: 'light' }, pending: {} }) }));
  await settle();
  assert.equal(JSON.stringify(durable()), before);
  assert.equal(a.store.readUserPreference('theme', null), 'dark');
  assert.equal(a.store.getPreferenceSyncStatus().status, 'unsaved');
});

test('no Web Locks keeps two outboxes in independent sessionStorage and refuses shared partition or unattributed legacy data', async () => {
  shared.setItem(PARTITION_KEY, JSON.stringify({ version: 2, identity: { serverKey: SERVER, userId: 'A' },
    preferences: { codexPermissions: { allowAll: true } }, revisions: { codexPermissions: 1 },
    pending: { codexPermissions: { revision: 1, value: { allowAll: true } } } }));
  shared.setItem('user-preferences', JSON.stringify({ selectedProvider: 'codex' }));
  shared.setItem('theme', 'dark');
  const original = shared.getItem(PARTITION_KEY);
  const a = await renderer('a', { noLocks: true });
  const b = await renderer('b', { noLocks: true });
  await a.store.hydrateUserPreferences();
  assert.equal(a.store.readUserPreference('codexPermissions', null), null);
  assert.equal(a.store.readUserPreference('theme', null), null, 'device appearance cannot enter an authenticated queue');
  assert.equal(b.store.readUserPreference('selectedProvider', null), null);
  a.store.writeUserPreference('theme', 'dark');
  b.store.writeUserPreference('userLanguage', 'ja');
  assert.equal(b.store.readUserPreference('theme', null), null);
  assert.equal(a.store.readUserPreference('userLanguage', null), null);
  assert.equal(shared.getItem(PARTITION_KEY), original);
  assert.equal(JSON.parse(a.windowStorage.getItem(PARTITION_KEY)!).pending.theme.value, 'dark');
  assert.equal(JSON.parse(b.windowStorage.getItem(PARTITION_KEY)!).pending.theme, undefined);
  a.store.dispose();
  const reopened = await renderer('reopened', { noLocks: true, windowStorage: a.windowStorage });
  assert.equal(reopened.store.readUserPreference('theme', null), 'dark');
  await vi.advanceTimersByTimeAsync(400);
  expect(requests.map(request => request.updates)).toEqual(expect.arrayContaining([{ theme: 'dark' }, { userLanguage: 'ja' }]));
  assert.equal(requests.some(request => 'codexPermissions' in request.updates || 'selectedProvider' in request.updates), false);
});

test('denied shared storage retains renderer-local dirty edits and exposes persistence failure after ACK', async () => {
  const a = await renderer('a');
  const original = a.local.setItem;
  a.local.setItem = (key, value) => {
    if (key === PARTITION_KEY) throw new DOMException('Storage denied', 'SecurityError');
    original(key, value);
  };
  a.store.writeUserPreference('theme', 'dark');
  await settle();
  assert.ok(a.store.getPreferenceSyncStatus().persistenceError);
  assert.equal(a.store.readUserPreference('theme', null), 'dark');
  await vi.advanceTimersByTimeAsync(400);
  assert.equal(server.theme, 'dark');
  assert.equal(a.store.getPreferenceSyncStatus().status, 'failed');
});

test('denied sessionStorage never falls back to a mutable shared outbox', async () => {
  const denied = memoryStorage();
  const a = await renderer('a', { noLocks: true, windowStorage: denied });
  denied.setItem = () => { throw new DOMException('Storage denied', 'SecurityError'); };
  a.store.writeUserPreference('tasksEnabled', true);
  assert.equal(a.store.readUserPreference('tasksEnabled', false), true);
  assert.ok(a.store.getPreferenceSyncStatus().persistenceError);
  await vi.advanceTimersByTimeAsync(400);
  assert.equal(shared.getItem(PARTITION_KEY), null);
  assert.equal(server.tasksEnabled, true);
});

test('captured expectedSession fences a queued old-owner patch when auth changes before dispatch admission', async () => {
  const a = await renderer('a');
  const barrier = deferred<void>();
  admissions.set('a', barrier.promise);
  a.store.writeUserPreference('theme', 'dark');
  await vi.advanceTimersByTimeAsync(400);
  const old = a.authority.getSnapshot();
  assert.equal(requests.length, 0);
  assert.equal(await a.authority.end(old), true);
  const replacement = await a.authority.start(token('B'));
  assert.ok(replacement);
  a.authority.acknowledge(replacement);
  barrier.resolve();
  await settle();
  assert.equal(requests.length, 0, 'the real auth authority must reject the old expected session before reading B token');
  assert.equal(durable().pending.theme.value, 'dark');
  assert.equal(a.store.getPreferenceSyncStatus().identity?.userId, 'B');
});

test('a legacy lease-free inFlight record replays only its latest revision after the first locked observation', async () => {
  shared.setItem(PARTITION_KEY, JSON.stringify({ version: 2, identity: { serverKey: SERVER, userId: 'A' },
    preferences: { theme: 'dark', userLanguage: 'de' }, revisions: { theme: 2, userLanguage: 1 },
    pending: { theme: { revision: 2, value: 'light' } },
    inFlight: { theme: { revision: 1, value: 'dark' }, userLanguage: { revision: 1, value: 'de' } }, failures: {} }));
  const a = await renderer('a');
  const b = await renderer('b');
  assert.equal(a.store.readUserPreference('theme', null), 'light');
  await vi.advanceTimersByTimeAsync(400);
  assert.deepEqual(requests.map(request => request.updates), [{ theme: 'light', userLanguage: 'de' }]);
  assert.equal(b.store.getPreferenceSyncStatus().status, 'saved');
});

test('an implausible future lease cannot keep a reopened renderer waiting beyond the bounded lease interval', async () => {
  shared.setItem(PARTITION_KEY, JSON.stringify({ version: 2, identity: { serverKey: SERVER, userId: 'A' },
    preferences: { theme: 'dark' }, revisions: { theme: 1 }, pending: {},
    inFlight: { theme: { revision: 1, value: 'dark' } }, failures: {},
    lease: { id: 'crashed', owner: 'gone', expiresAt: Date.now() + 86_400_000 } }));
  const a = await renderer('a');
  await vi.advanceTimersByTimeAsync(14_999);
  assert.equal(requests.length, 0);
  await vi.advanceTimersByTimeAsync(1);
  assert.deepEqual(requests.map(request => request.updates), [{ theme: 'dark' }]);
  assert.equal(a.store.getPreferenceSyncStatus().status, 'saved');
});

test('a same-value edit in a renderer missing storage hints still commits against the latest shared field', async () => {
  const a = await renderer('a');
  const b = await renderer('b');
  a.store.writeUserPreference('theme', 'dark');
  await vi.advanceTimersByTimeAsync(400);
  suppressedEvents.add('b');
  a.store.writeUserPreference('theme', 'light');
  await vi.advanceTimersByTimeAsync(400);
  assert.equal(b.store.readUserPreference('theme', null), 'dark');
  b.store.writeUserPreference('theme', 'dark');
  await settle();
  assert.equal(durable().preferences.theme, 'dark', 'same-value optimization must use locked authority, not the stale renderer');
  await vi.advanceTimersByTimeAsync(400);
  assert.equal(server.theme, 'dark');
  const count = requests.length;
  b.store.writeUserPreference('theme', 'dark');
  await vi.advanceTimersByTimeAsync(400);
  assert.equal(requests.length, count, 'an acknowledged unchanged shared value remains a no-op');
});

test('401 pauses both renderer queues until a real credential rotation resumes the same identity', async () => {
  const a = await renderer('a');
  const b = await renderer('b');
  saveResults.push(new Response('{}', { status: 401 }));
  a.store.writeUserPreference('theme', 'dark');
  await vi.advanceTimersByTimeAsync(400);
  assert.equal(b.store.getPreferenceSyncStatus().status, 'paused');
  b.store.writeUserPreference('userLanguage', 'de');
  b.store.retryUserPreferences();
  await vi.advanceTimersByTimeAsync(60_000);
  assert.equal(requests.length, 1);
  assert.equal(await b.authority.refresh(token('A', 'rotated')), true);
  await a.authority.synchronize();
  await vi.advanceTimersByTimeAsync(400);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].bearer, token('A', 'rotated'));
  assert.deepEqual(requests[1].updates, { theme: 'dark', userLanguage: 'de' });
  assert.equal(a.store.getPreferenceSyncStatus().status, 'saved');
});

test('a stolen expired lease rejects the old completion even when the same field revision is still dirty', async () => {
  const a = await renderer('a');
  const b = await renderer('b');
  const old = deferred<Response>();
  const replay = deferred<Response>();
  saveResults.push(old.promise, replay.promise);
  a.store.writeUserPreference('theme', 'dark');
  await vi.advanceTimersByTimeAsync(400);
  const firstLease = durable().lease!.id;
  // Suspend the renderer clock without executing its local timeout, like a frozen background page.
  vi.setSystemTime(Date.now() + 15_001);
  b.events.dispatchEvent(new StorageEvent('storage', { key: PARTITION_KEY }));
  await settle();
  assert.equal(requests.length, 2);
  assert.notEqual(durable().lease!.id, firstLease);
  old.resolve(commit(requests[0]!));
  await settle();
  assert.equal(durable().inFlight.theme.value, 'dark');
  assert.equal(b.store.getPreferenceSyncStatus().status, 'saving', 'a different lease cannot ACK a replay even for the same revision');
  replay.resolve(commit(requests[1]!));
  await settle();
  assert.equal(b.store.getPreferenceSyncStatus().status, 'saved');
});

test('a delayed stale CAS after lease expiry cannot overwrite a newer committed intent and is never rebased', async () => {
  const a = await renderer('a');
  const b = await renderer('b');
  const delayed = deferred<Response>();
  saveResults.push(delayed.promise);
  a.store.writeUserPreference('theme', 'dark');
  await vi.advanceTimersByTimeAsync(400);
  const original = requests[0]!;
  b.store.writeUserPreference('theme', 'light');
  await settle();
  vi.setSystemTime(Date.now() + 15_001);
  b.events.dispatchEvent(new StorageEvent('storage', { key: PARTITION_KEY }));
  await settle();
  assert.equal(requests.length, 2);
  assert.equal(server.theme, 'light');
  assert.equal(versions.theme, 1);
  const refused = commit(original);
  assert.equal(refused.status, 409);
  delayed.resolve(refused);
  await settle();
  await vi.advanceTimersByTimeAsync(60_000);
  assert.equal(server.theme, 'light');
  assert.equal(requests.length, 2, 'an obsolete conflicting request must not manufacture a fresh ID');
  assert.equal(commits, 1);
  assert.equal(a.store.readUserPreference('theme', null), 'light');
  assert.equal(b.store.getPreferenceSyncStatus().status, 'saved');
});

test('crash after server commit replays the exact transaction and one historical ACK without a second write', async () => {
  const a = await renderer('a');
  const b = await renderer('b');
  saveResults.push(deferred<Response>().promise);
  a.store.writeUserPreferences({ theme: 'dark', userLanguage: 'de' });
  await vi.advanceTimersByTimeAsync(400);
  const original = durable().operations[0]!.transaction;
  const serialized = JSON.stringify(original);
  commit(original);
  const expiresAt = durable().lease!.expiresAt;
  a.store.dispose();
  events.delete('a');
  await vi.advanceTimersByTimeAsync(expiresAt - Date.now());
  assert.equal(requests.length, 2);
  const replay = requests[1]!;
  assert.equal(JSON.stringify({ operationId: replay.operationId, updates: replay.updates, expectedRevisions: replay.expectedRevisions }), serialized);
  assert.equal(commits, 1);
  assert.equal(durable().serverRevisions.theme, 1);
  assert.equal(durable().serverRevisions.userLanguage, 1);
  assert.equal(b.store.getPreferenceSyncStatus().status, 'saved');
});

test('a replacement same-user incarnation cannot donate its token to a queued predecessor transaction', async () => {
  const a = await renderer('a');
  const barrier = deferred<void>();
  admissions.set('a', barrier.promise);
  a.store.writeUserPreference('theme', 'dark');
  await vi.advanceTimersByTimeAsync(400);
  const old = a.authority.getSnapshot();
  assert.equal(await a.authority.end(old), true);
  const replacement = await a.authority.start(token('A', 'replacement'));
  assert.ok(replacement);
  a.authority.acknowledge(replacement);
  barrier.resolve();
  await settle();
  assert.equal(requests.some(request => request.options.expectedSession?.sessionInstanceId === old.sessionInstanceId), false);
  await vi.advanceTimersByTimeAsync(400);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.options.expectedSession?.sessionInstanceId, replacement.sessionInstanceId);
  assert.equal(requests[0]!.bearer, token('A', 'replacement'));
});

test('Retry-After and failure budget survive a dispatcher handoff instead of being reset by another renderer', async () => {
  const a = await renderer('a');
  const b = await renderer('b');
  saveResults.push(new Response('{}', { status: 429, headers: { 'Retry-After': '3' } }), new Response('{}', { status: 503 }),
    new Response('{}', { status: 503 }), new Response('{}', { status: 503 }));
  a.store.writeUserPreference('theme', 'dark');
  await vi.advanceTimersByTimeAsync(400);
  a.store.dispose();
  events.delete('a');
  await vi.advanceTimersByTimeAsync(2999);
  assert.equal(requests.length, 1);
  await vi.advanceTimersByTimeAsync(1 + 2000 + 4000);
  assert.equal(requests.length, 4);
  assert.equal(b.store.getPreferenceSyncStatus().failures[0].attempts, 4);
  assert.equal(b.store.getPreferenceSyncStatus().status, 'failed');
  await vi.advanceTimersByTimeAsync(60_000);
  assert.equal(requests.length, 4);
});
