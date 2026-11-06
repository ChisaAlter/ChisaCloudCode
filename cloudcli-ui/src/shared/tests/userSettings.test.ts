import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type * as AuthToken from '@/shared/authToken';
import type { AuthSessionSnapshot, UserPreferenceTransaction } from '@/shared/types';
import type * as UserSettings from '@/shared/userSettings';

type Store = typeof UserSettings;
type Auth = typeof AuthToken;
type SavedRequest = UserPreferenceTransaction & { bearer: string | null; signal: AbortSignal | null | undefined };
type SaveResult = Response | Error | Promise<Response> | ((input: UserPreferenceTransaction) => Response);

const PARTITION_PREFIX = 'user-preferences:v2:';
const OWNER_KEY = 'user-preferences:legacy-owner:v2';
const ACCOUNT_SERVER = window.location.origin;
const saved: SavedRequest[] = [];
const saveResults: SaveResult[] = [];
// Real API dispatch reads these fixtures through fetch, including its auth authority and response checks.
let serverPreferences: Record<string, unknown> = {};
// Serialized CAS state records durable historical acknowledgments independently of response delivery.
let serverRevisions: Record<string, number> = {};
let journal = new Map<string, { payload: string; result: Record<string, unknown>; status: number }>();
let applied = 0;
// Each test controls the actual GET response instead of replacing the preference-store contract.
let loadResult: Response | Error | Promise<Response> | null = null;
// Retain stores to cancel their timers before resetting the auth module for a page-reload fixture.
let loadedStores: Store[] = [];
// The request callback observes persisted separation before any simulated server response completes.
let onSave: ((request: SavedRequest) => void) | null = null;

function token(userId: string, rotation = 'initial'): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256' })}.${encode({ userId, jti: rotation, iat: 1_700_000_000, exp: 4_102_444_800 })}.signature`;
}

function jsonResponse(preferences: Record<string, unknown>, revisions = Object.fromEntries(Object.keys(preferences).map(key => [key, serverRevisions[key] ?? 0]))): Response {
  return new Response(JSON.stringify({ success: true, preferences, revisions }), { status: 200 });
}

function terminalResponse(request: UserPreferenceTransaction, code = 'PREFERENCE_OPERATION_MISMATCH'): Response {
  const touched = Object.keys(request.updates);
  return new Response(JSON.stringify({ success: false, operationId: request.operationId, replayed: false, code,
    preferences: Object.fromEntries(touched.filter(key => Object.prototype.hasOwnProperty.call(serverPreferences, key)).map(key => [key, serverPreferences[key]])),
    revisions: Object.fromEntries(touched.map(key => [key, serverRevisions[key] ?? 0])) }), { status: 409 });
}

function commit(request: UserPreferenceTransaction): Response {
  const payload = JSON.stringify({ operationId: request.operationId, updates: request.updates, expectedRevisions: request.expectedRevisions });
  const previous = journal.get(request.operationId);
  if (previous) {
    assert.equal(previous.payload, payload, 'every operation ID must retain its exact immutable payload');
    return new Response(JSON.stringify({ ...previous.result, replayed: true }), { status: previous.status });
  }
  const created = Number.parseInt(request.operationId.replace(/-/g, '').slice(0, 12), 16);
  if (Date.now() - created >= 86_400_000) return terminalResponse(request, 'PREFERENCE_OPERATION_EXPIRED');
  const touched = Object.keys(request.updates);
  const conflict = touched.some(key => request.expectedRevisions[key] !== (serverRevisions[key] ?? 0));
  if (!conflict) {
    for (const key of touched) { serverPreferences[key] = request.updates[key]; serverRevisions[key] = (serverRevisions[key] ?? 0) + 1; }
    applied++;
  }
  const result = { success: !conflict, operationId: request.operationId, replayed: false,
    ...(conflict ? { code: 'PREFERENCE_REVISION_CONFLICT' } : {}),
    preferences: Object.fromEntries(touched.filter(key => Object.prototype.hasOwnProperty.call(serverPreferences, key)).map(key => [key, serverPreferences[key]])),
    revisions: Object.fromEntries(touched.map(key => [key, serverRevisions[key] ?? 0])) };
  journal.set(request.operationId, { payload, result, status: conflict ? 409 : 200 });
  return new Response(JSON.stringify(result), { status: conflict ? 409 : 200 });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function settled(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

async function login(auth: Auth, userId = 'A'): Promise<AuthSessionSnapshot> {
  await auth.initializeAuthSession();
  const session = await auth.startAuthSession(token(userId));
  assert.ok(session, 'the fixture must establish a real authenticated identity');
  auth.acknowledgeAuthSession(session);
  return session;
}

async function loadStore(userId: string | null = 'A'): Promise<{ store: Store; auth: Auth }> {
  vi.resetModules();
  const auth = await import('@/shared/authToken');
  const restored = await auth.initializeAuthSession();
  if (userId !== null) {
    if (restored.phase === 'ready' && restored.userId === userId) auth.acknowledgeAuthSession(restored);
    else await login(auth, userId);
  }
  const store = await import('@/shared/userSettings');
  loadedStores.push(store);
  return { store, auth };
}

function persistedPartition(userId = 'A', serverKey = ACCOUNT_SERVER) {
  const storageKey = PARTITION_PREFIX + encodeURIComponent(JSON.stringify([serverKey, userId]));
  const raw = (navigator.locks ? localStorage : sessionStorage).getItem(storageKey);
  assert.ok(raw, 'an authenticated partition must be persisted');
  return JSON.parse(raw) as {
    version: number;
    preferences: Record<string, unknown>;
    serverRevisions: Record<string, number>;
    operations: Array<{ transaction: UserPreferenceTransaction; entries: Record<string, { revision: number; value: unknown }> }>;
    pending: Record<string, { revision: number; value: unknown }>;
    inFlight: Record<string, { revision: number; value: unknown }>;
    failures: Record<string, unknown>;
    legacyMigrationComplete: boolean;
  };
}

function attributeLegacy(userId = 'A'): void {
  localStorage.setItem(OWNER_KEY, JSON.stringify({ serverKey: ACCOUNT_SERVER, userId }));
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  saved.length = 0;
  saveResults.length = 0;
  serverPreferences = {};
  serverRevisions = {};
  journal = new Map();
  applied = 0;
  loadResult = null;
  loadedStores = [];
  onSave = null;
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit = {}) => {
    if (options.method === 'PATCH') {
      assert.equal(url, '/api/user/preferences/transactions', 'production defaults must never fall back to plain PATCH');
      const transaction = JSON.parse(String(options.body)) as UserPreferenceTransaction;
      assert.deepEqual(Object.keys(transaction).sort(), ['expectedRevisions', 'operationId', 'updates']);
      const request = { ...transaction, bearer: new Headers(options.headers).get('Authorization'), signal: options.signal };
      saved.push(request);
      onSave?.(request);
      const result = saveResults.shift();
      if (result instanceof Error) throw result;
      const response = typeof result === 'function' ? result(transaction) : result ? await result : null;
      return response ?? commit(transaction);
    }
    if (loadResult instanceof Error) throw loadResult;
    return loadResult ? await loadResult : jsonResponse(serverPreferences);
  }));
});

afterEach(() => {
  for (const store of loadedStores) store.resetUserPreferences();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('an authenticated edit is synchronous, debounced and acknowledged only after a successful response', async () => {
  const { store } = await loadStore();
  const response = deferred<Response>();
  saveResults.push(response.promise);
  store.writeUserPreference('theme', 'dark');
  assert.equal(store.readUserPreference('theme', 'light'), 'dark');
  assert.equal(store.getPreferenceSyncStatus().status, 'unsaved');
  expect(saved).toEqual([]);
  await vi.advanceTimersByTimeAsync(400);
  assert.deepEqual(saved.map(request => request.updates), [{ theme: 'dark' }]);
  assert.equal(saved[0].bearer, `Bearer ${token('A')}`);
  assert.equal(store.getPreferenceSyncStatus().status, 'saving');
  assert.deepEqual(persistedPartition().pending, {});
  assert.equal(persistedPartition().inFlight.theme.value, 'dark');
  response.resolve(commit(saved[0]!));
  await settled();
  assert.equal(store.getPreferenceSyncStatus().status, 'saved');
  assert.deepEqual(persistedPartition().inFlight, {});
  assert.equal(serverPreferences.theme, 'dark');
});

test('a burst of authenticated writes collapses into one merge patch carrying every change', async () => {
  const { store } = await loadStore();
  store.writeUserPreference('theme', 'dark');
  store.writeUserPreference('userLanguage', 'de');
  store.writeUserPreference('tasksEnabled', true);
  await vi.advanceTimersByTimeAsync(400);
  assert.deepEqual(saved.map(request => request.updates), [{ theme: 'dark', userLanguage: 'de', tasksEnabled: true }]);
  assert.equal(store.getPreferenceSyncStatus().status, 'saved');
});

test('an acknowledged same-value write sends nothing and notifies no value subscribers', async () => {
  const { store } = await loadStore();
  store.writeUserPreference('theme', 'dark');
  await vi.advanceTimersByTimeAsync(400);
  saved.length = 0;
  const listener = vi.fn();
  store.subscribeToUserPreferences(listener);
  store.writeUserPreference('theme', 'dark');
  await vi.advanceTimersByTimeAsync(1000);
  expect(saved).toEqual([]);
  expect(listener).not.toHaveBeenCalled();
});

test('signed-out appearance is local and is not sent or adopted when a user logs in', async () => {
  const { store, auth } = await loadStore(null);
  store.writeUserPreference('theme', 'dark');
  store.writeUserPreference('tasksEnabled', true);
  assert.equal(store.readUserPreference('theme', 'light'), 'dark');
  assert.equal(store.getPreferenceSyncStatus().status, 'local');
  await store.hydrateUserPreferences();
  await vi.advanceTimersByTimeAsync(1000);
  expect(fetch).not.toHaveBeenCalled();
  await login(auth);
  assert.equal(store.readUserPreference('theme', 'light'), 'light');
  assert.equal(store.readUserPreference('tasksEnabled', false), false);
  await store.hydrateUserPreferences();
  await vi.advanceTimersByTimeAsync(1000);
  expect(saved).toEqual([]);
});

test('a confirmed account mirror is restored synchronously after awaiting auth initialization on a new page', async () => {
  const { store: first } = await loadStore();
  first.writeUserPreference('theme', 'dark');
  await vi.advanceTimersByTimeAsync(400);
  first.resetUserPreferences();
  const { store: second } = await loadStore();
  assert.equal(second.readUserPreference('theme', 'light'), 'dark');
  assert.equal(second.hasHydratedUserPreferences(), false);
  assert.equal(second.getPreferenceSyncStatus().status, 'saved');
});

test('dirty edits survive a page reload and a successful hydrate cannot erase their replay', async () => {
  const { store: first } = await loadStore();
  first.writeUserPreference('theme', 'dark');
  assert.equal(persistedPartition().pending.theme.value, 'dark');
  first.resetUserPreferences();
  serverPreferences = { theme: 'light' };
  const { store: second } = await loadStore();
  assert.equal(second.readUserPreference('theme', null), 'dark');
  await second.hydrateUserPreferences();
  assert.equal(second.readUserPreference('theme', null), 'dark');
  await vi.advanceTimersByTimeAsync(400);
  assert.equal(serverPreferences.theme, 'dark');
  assert.equal(second.getPreferenceSyncStatus().status, 'saved');
});

test('a reloaded in-flight batch is recovered as pending without losing its revision', async () => {
  const { store: first } = await loadStore();
  const response = deferred<Response>();
  saveResults.push(response.promise);
  first.writeUserPreference('theme', 'dark');
  await vi.advanceTimersByTimeAsync(400);
  const revision = persistedPartition().inFlight.theme.revision;
  first.resetUserPreferences();
  const { store: second } = await loadStore();
  assert.equal(persistedPartition().pending.theme.revision, revision);
  await vi.advanceTimersByTimeAsync(400);
  assert.equal(second.getPreferenceSyncStatus().status, 'saved');
  response.resolve(commit(saved[0]!));
  await settled();
});

test('hydrate adopts the server copy over an acknowledged local mirror', async () => {
  const { store } = await loadStore();
  store.writeUserPreference('theme', 'dark');
  await vi.advanceTimersByTimeAsync(400);
  serverPreferences = { theme: 'light' };
  await store.hydrateUserPreferences();
  assert.equal(store.readUserPreference('theme', 'dark'), 'light');
  assert.equal(store.hasHydratedUserPreferences(), true);
});

test('explicitly attributed legacy settings migrate once and are acknowledged in one patch', async () => {
  attributeLegacy();
  localStorage.setItem('theme', 'dark');
  localStorage.setItem('tasks-enabled', 'true');
  localStorage.setItem('selected-provider', 'codex');
  localStorage.setItem('uiPreferences', JSON.stringify({ showThinking: false }));
  const { store } = await loadStore();
  await store.hydrateUserPreferences();
  assert.equal(store.readUserPreference('theme', 'light'), 'dark');
  assert.equal(store.readUserPreference('tasksEnabled', false), true);
  assert.equal(store.readUserPreference('selectedProvider', 'claude'), 'codex');
  assert.deepEqual(store.readUserPreference('uiPreferences', {}), { showThinking: false });
  await vi.advanceTimersByTimeAsync(400);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].updates.theme, 'dark');
  assert.equal(persistedPartition().legacyMigrationComplete, true);
  serverPreferences = {};
  await store.hydrateUserPreferences();
  await vi.advanceTimersByTimeAsync(400);
  assert.equal(saved.length, 1, 'a server reset must not re-adopt the old legacy values');
});

test('an attributed legacy claude-settings blob splits into permissions and sort order', async () => {
  attributeLegacy();
  localStorage.setItem('claude-settings', JSON.stringify({ allowedTools: ['Read'], disallowedTools: ['Bash'],
    skipPermissions: true, projectSortOrder: 'date', lastUpdated: '2026-01-01T00:00:00.000Z' }));
  const { store } = await loadStore();
  await store.hydrateUserPreferences();
  assert.deepEqual(store.readUserPreference('claudePermissions', null), {
    allowedTools: ['Read'], disallowedTools: ['Bash'], skipPermissions: true,
  });
  assert.equal(store.readUserPreference('projectSortOrder', 'name'), 'date');
  await vi.advanceTimersByTimeAsync(400);
  assert.deepEqual(serverPreferences.claudePermissions, { allowedTools: ['Read'], disallowedTools: ['Bash'], skipPermissions: true });
});

test('attributed legacy code-editor keys reassemble into one acknowledged preference', async () => {
  attributeLegacy();
  localStorage.setItem('codeEditorWordWrap', 'true');
  localStorage.setItem('codeEditorShowMinimap', 'false');
  localStorage.setItem('codeEditorFontSize', '16');
  const { store } = await loadStore();
  await store.hydrateUserPreferences();
  assert.deepEqual(store.readUserPreference('codeEditorSettings', null), { wordWrap: true, showMinimap: false, fontSize: '16' });
  await vi.advanceTimersByTimeAsync(400);
  assert.deepEqual(serverPreferences.codeEditorSettings, { wordWrap: true, showMinimap: false, fontSize: '16' });
});

test('legacy values never replace a server value or enter another account mirror', async () => {
  attributeLegacy();
  localStorage.setItem('theme', 'dark');
  localStorage.setItem('selected-provider', 'codex');
  serverPreferences = { theme: 'light', selectedProvider: 'claude' };
  const { store, auth } = await loadStore();
  await store.hydrateUserPreferences();
  assert.equal(store.readUserPreference('theme', null), 'light');
  assert.equal(store.readUserPreference('selectedProvider', null), 'claude');
  await vi.advanceTimersByTimeAsync(400);
  expect(saved).toEqual([]);
  await auth.clearAuthToken();
  await login(auth, 'B');
  serverPreferences = {};
  await store.hydrateUserPreferences();
  await vi.advanceTimersByTimeAsync(400);
  assert.equal(store.readUserPreference('selectedProvider', 'claude'), 'claude');
  expect(saved).toEqual([]);
  const other = persistedPartition('B');
  assert.equal(JSON.stringify([other.preferences, other.pending, other.inFlight]).includes('codex'), false);
});

test('unattributed legacy mirrors never seed authenticated users', async () => {
  localStorage.setItem('user-preferences', JSON.stringify({ theme: 'dark', codexPermissions: { allowAll: true } }));
  localStorage.setItem('theme', 'dark');
  localStorage.setItem('selected-provider', 'codex');
  const { store } = await loadStore();
  await store.hydrateUserPreferences();
  await vi.advanceTimersByTimeAsync(1000);
  assert.equal(store.readUserPreference('theme', null), null);
  assert.equal(store.readUserPreference('codexPermissions', null), null);
  expect(saved).toEqual([]);
  assert.equal(localStorage.getItem(OWNER_KEY), null);
  assert.equal(persistedPartition().legacyMigrationComplete, false, 'unattributed data stays available for a later explicit attribution');
});

test.each([new Error('offline'), new Response('{}', { status: 500 }), new Response('{}', { status: 403 })])(
  'failed hydrate retains the acknowledged mirror, dirty fields and incomplete hydration (%s)', async response => {
    const { store } = await loadStore();
    store.writeUserPreference('theme', 'dark');
    await vi.advanceTimersByTimeAsync(400);
    store.writeUserPreference('userLanguage', 'de');
    loadResult = response;
    await store.hydrateUserPreferences();
    assert.equal(store.readUserPreference('theme', 'light'), 'dark');
    assert.equal(store.readUserPreference('userLanguage', 'en'), 'de');
    assert.equal(store.hasHydratedUserPreferences(), false);
    assert.equal(persistedPartition().pending.userLanguage.value, 'de');
    assert.ok(store.getPreferenceSyncStatus().hydrationError);
  },
);

test('hydrate preserves explicit pre-hydrate dirty fields while applying clean fields from the server', async () => {
  serverPreferences = { theme: 'dark', userLanguage: 'ja' };
  const { store } = await loadStore();
  store.writeUserPreference('theme', 'light');
  await store.hydrateUserPreferences();
  assert.equal(store.readUserPreference('theme', null), 'light');
  assert.equal(store.readUserPreference('userLanguage', null), 'ja');
  await vi.advanceTimersByTimeAsync(400);
  assert.deepEqual(saved.map(request => request.updates), [{ theme: 'light' }]);
});

test('late hydrate preserves fields edited and acknowledged during the request, and updates other fields', async () => {
  const { store } = await loadStore();
  await store.hydrateUserPreferences();
  const response = deferred<Response>();
  loadResult = response.promise;
  const hydration = store.hydrateUserPreferences();
  await settled();
  store.writeUserPreference('theme', 'dark');
  await vi.advanceTimersByTimeAsync(400);
  assert.equal(store.getPreferenceSyncStatus().status, 'saved');
  response.resolve(jsonResponse({ theme: 'light', userLanguage: 'de' }));
  await hydration;
  assert.equal(store.readUserPreference('theme', null), 'dark');
  assert.equal(store.readUserPreference('userLanguage', null), 'de');
});

test('a network failure retains the batch and a newer edit wins before automatic retry', async () => {
  const { store } = await loadStore();
  saveResults.push(new Error('offline'));
  store.writeUserPreference('theme', 'dark');
  await vi.advanceTimersByTimeAsync(400);
  assert.equal(store.getPreferenceSyncStatus().status, 'retrying');
  assert.equal(persistedPartition().pending.theme.value, 'dark');
  store.writeUserPreference('theme', 'light');
  await vi.advanceTimersByTimeAsync(400);
  assert.deepEqual(saved.map(request => request.updates), [{ theme: 'dark' }, { theme: 'light' }]);
  assert.equal(serverPreferences.theme, 'light');
  assert.equal(store.getPreferenceSyncStatus().status, 'saved');
});

test.each([500, 429])('HTTP %s obeys Retry-After and only acknowledges the eventual 2xx', async status => {
  const { store } = await loadStore();
  saveResults.push(new Response('{}', { status, headers: { 'Retry-After': '3' } }));
  store.writeUserPreference('theme', 'dark');
  await vi.advanceTimersByTimeAsync(400);
  assert.equal(store.getPreferenceSyncStatus().status, 'retrying');
  assert.equal(store.getPreferenceSyncStatus().failures[0].status, status);
  await vi.advanceTimersByTimeAsync(2999);
  assert.equal(saved.length, 1);
  await vi.advanceTimersByTimeAsync(1);
  assert.equal(saved.length, 2);
  assert.equal(store.getPreferenceSyncStatus().status, 'saved');
});

test('Retry-After applies to newer edits and explicit retry after a page reload', async () => {
  const { store: first } = await loadStore();
  saveResults.push(new Response('{}', { status: 429, headers: { 'Retry-After': '5' } }));
  first.writeUserPreference('theme', 'dark');
  await vi.advanceTimersByTimeAsync(400);
  first.resetUserPreferences();
  const { store } = await loadStore();
  store.writeUserPreferences({ theme: 'light', userLanguage: 'de' });
  store.retryUserPreferences();
  assert.equal(store.getPreferenceSyncStatus().status, 'retrying');
  await vi.advanceTimersByTimeAsync(4999);
  assert.equal(saved.length, 1);
  await vi.advanceTimersByTimeAsync(1);
  assert.equal(saved.length, 2);
  assert.deepEqual(saved[1].updates, { theme: 'light', userLanguage: 'de' });
  assert.equal(store.getPreferenceSyncStatus().status, 'saved');
});

test('an HTTP-date Retry-After is honored', async () => {
  vi.setSystemTime(new Date('2026-10-31T12:00:00Z'));
  const { store } = await loadStore();
  saveResults.push(new Response('{}', { status: 429, headers: { 'Retry-After': 'Sat, 31 Oct 2026 12:00:05 GMT' } }));
  store.writeUserPreference('theme', 'dark');
  await vi.advanceTimersByTimeAsync(400);
  await vi.advanceTimersByTimeAsync(4599);
  assert.equal(saved.length, 1);
  await vi.advanceTimersByTimeAsync(1);
  assert.equal(saved.length, 2);
});

test.each(['network', 'server'])('automatic %s retries stop after the finite budget and retain visible failure', async kind => {
  const { store } = await loadStore();
  for (let index = 0; index < 8; index++) saveResults.push(kind === 'network' ? new Error('offline') : new Response('{}', { status: 503 }));
  store.writeUserPreference('theme', 'dark');
  await vi.advanceTimersByTimeAsync(400 + 1000 + 2000 + 4000);
  assert.equal(saved.length, 4);
  assert.equal(store.getPreferenceSyncStatus().status, 'failed');
  assert.equal(store.getPreferenceSyncStatus().failures[0].attempts, 4);
  assert.equal(persistedPartition().pending.theme.value, 'dark');
  await vi.advanceTimersByTimeAsync(3_600_000);
  assert.equal(saved.length, 4);
});

test('a rejected 400 remains dirty across reload, and the same value explicitly retries it', async () => {
  const { store: first } = await loadStore();
  saveResults.push(new Response('{}', { status: 400 }));
  first.writeUserPreference('theme', 'dark');
  await vi.advanceTimersByTimeAsync(400);
  assert.equal(first.getPreferenceSyncStatus().status, 'failed');
  first.resetUserPreferences();
  const { store } = await loadStore();
  await vi.advanceTimersByTimeAsync(1000);
  assert.equal(saved.length, 1);
  assert.equal(store.getPreferenceSyncStatus().failures[0].status, 400);
  const values = vi.fn();
  const statuses = vi.fn();
  store.subscribeToUserPreferences(values);
  store.subscribeToPreferenceSyncStatus(statuses);
  store.writeUserPreference('theme', 'dark');
  await vi.advanceTimersByTimeAsync(400);
  assert.equal(saved.length, 2);
  assert.equal(store.getPreferenceSyncStatus().status, 'saved');
  expect(values).not.toHaveBeenCalled();
  expect(statuses).toHaveBeenCalled();
});

test('a failed field does not block saving another field and explicit retry saves the retained failure', async () => {
  const { store } = await loadStore();
  saveResults.push(new Response('{}', { status: 422 }));
  store.writeUserPreference('theme', 'dark');
  await vi.advanceTimersByTimeAsync(400);
  store.writeUserPreference('userLanguage', 'de');
  await vi.advanceTimersByTimeAsync(400);
  assert.deepEqual(saved.map(request => request.updates), [{ theme: 'dark' }, { userLanguage: 'de' }]);
  assert.equal(store.getPreferenceSyncStatus().status, 'failed');
  store.retryUserPreferences();
  await settled();
  assert.deepEqual(saved[2].updates, { theme: 'dark' });
  assert.equal(store.getPreferenceSyncStatus().status, 'saved');
});

test('401 pauses all sends until that identity receives a refreshed credential', async () => {
  const { store, auth } = await loadStore();
  saveResults.push(new Response('{}', { status: 401 }));
  store.writeUserPreference('theme', 'dark');
  await vi.advanceTimersByTimeAsync(400);
  assert.equal(store.getPreferenceSyncStatus().status, 'paused');
  store.writeUserPreference('userLanguage', 'de');
  store.retryUserPreferences();
  await vi.advanceTimersByTimeAsync(60_000);
  assert.equal(saved.length, 1);
  assert.equal(await auth.storeAuthToken(token('A', 'refreshed'), auth.getAuthSessionSnapshot()), true);
  await vi.advanceTimersByTimeAsync(400);
  assert.equal(saved.length, 2);
  assert.equal(saved[1].bearer, `Bearer ${token('A', 'refreshed')}`);
  assert.deepEqual(saved[1].updates, { theme: 'dark', userLanguage: 'de' });
  assert.equal(store.getPreferenceSyncStatus().status, 'saved');
});

test('a stale 401 cannot pause an already refreshed credential or strand its dirty fields', async () => {
  const { store, auth } = await loadStore();
  const response = deferred<Response>();
  saveResults.push(response.promise);
  store.writeUserPreference('theme', 'dark');
  await vi.advanceTimersByTimeAsync(400);
  assert.equal(await auth.storeAuthToken(token('A', 'refreshed'), auth.getAuthSessionSnapshot()), true);
  response.resolve(new Response('{}', { status: 401 }));
  await settled();
  assert.equal(saved.length, 2);
  assert.equal(saved[1].bearer, `Bearer ${token('A', 'refreshed')}`);
  assert.equal(store.getPreferenceSyncStatus().status, 'saved');
});

test('a stale hydrate 401 cannot pause edits made with an already refreshed credential', async () => {
  const { store, auth } = await loadStore();
  await store.hydrateUserPreferences();
  const response = deferred<Response>();
  loadResult = response.promise;
  const hydration = store.hydrateUserPreferences();
  await settled();
  store.writeUserPreference('theme', 'dark');
  assert.equal(await auth.storeAuthToken(token('A', 'refreshed'), auth.getAuthSessionSnapshot()), true);
  response.resolve(new Response('{}', { status: 401 }));
  await hydration;
  await vi.advanceTimersByTimeAsync(400);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].bearer, `Bearer ${token('A', 'refreshed')}`);
  assert.deepEqual(store.getPreferenceSyncStatus().pendingKeys, []);
  assert.notEqual(store.getPreferenceSyncStatus().status, 'paused');
});

test('v1 in flight and a v2 edit are serial; stale 2xx does not acknowledge v2 or another field', async () => {
  const { store } = await loadStore();
  const firstResponse = deferred<Response>();
  const secondResponse = deferred<Response>();
  saveResults.push(firstResponse.promise, secondResponse.promise);
  store.writeUserPreference('theme', 'dark');
  await vi.advanceTimersByTimeAsync(400);
  store.writeUserPreferences({ theme: 'light', userLanguage: 'de' });
  await vi.advanceTimersByTimeAsync(1000);
  assert.equal(saved.length, 1, 'the second patch cannot start while v1 is in flight');
  assert.equal(persistedPartition().inFlight.theme.value, 'dark');
  assert.equal(persistedPartition().pending.theme.value, 'light');
  onSave = () => { assert.equal(store.getPreferenceSyncStatus().status, 'saving'); };
  firstResponse.resolve(commit(saved[0]!));
  await settled();
  assert.equal(saved.length, 2);
  assert.deepEqual(saved[1].updates, { theme: 'light', userLanguage: 'de' });
  assert.equal(store.getPreferenceSyncStatus().status, 'saving');
  assert.equal(persistedPartition().inFlight.theme.value, 'light');
  secondResponse.resolve(commit(saved[1]!));
  await settled();
  assert.equal(serverPreferences.theme, 'light');
  assert.equal(store.getPreferenceSyncStatus().status, 'saved');
});

test('a failed old batch cannot replace or back off a newer pending value', async () => {
  const { store } = await loadStore();
  const response = deferred<Response>();
  saveResults.push(response.promise);
  store.writeUserPreference('theme', 'dark');
  await vi.advanceTimersByTimeAsync(400);
  store.writeUserPreference('theme', 'light');
  response.resolve(new Response('{}', { status: 500 }));
  await settled();
  assert.equal(saved.length, 2);
  assert.deepEqual(saved[1].updates, { theme: 'light' });
  assert.equal(store.getPreferenceSyncStatus().status, 'saved');
});

test('a caller cannot mutate the object retained for an acknowledged field revision', async () => {
  const { store } = await loadStore();
  const value = { allowedTools: ['Read'] };
  store.writeUserPreference('codexPermissions', value);
  value.allowedTools.push('Bash');
  await vi.advanceTimersByTimeAsync(400);
  assert.deepEqual(saved[0].updates.codexPermissions, { allowedTools: ['Read'] });
  assert.deepEqual(store.readUserPreference('codexPermissions', null), { allowedTools: ['Read'] });
});

test('logout cancels a queued A write; B never receives A data, and A resumes on its own login', async () => {
  const { store, auth } = await loadStore();
  store.writeUserPreference('theme', 'dark');
  await auth.clearAuthToken();
  await login(auth, 'B');
  assert.equal(store.readUserPreference('theme', 'light'), 'light');
  store.writeUserPreference('userLanguage', 'de');
  await vi.advanceTimersByTimeAsync(400);
  assert.deepEqual(saved.map(request => [request.updates, request.bearer]), [[{ userLanguage: 'de' }, `Bearer ${token('B')}`]]);
  assert.equal(persistedPartition('A').pending.theme.value, 'dark');
  await auth.clearAuthToken();
  await login(auth, 'A');
  await vi.advanceTimersByTimeAsync(400);
  assert.deepEqual(saved[1].updates, { theme: 'dark' });
  assert.equal(saved[1].bearer, `Bearer ${token('A')}`);
});

test('logout aborts an A request; its late response cannot confirm or populate B, including an A to B to A transition', async () => {
  const { store, auth } = await loadStore();
  const response = deferred<Response>();
  saveResults.push(response.promise);
  store.writeUserPreference('theme', 'dark');
  await vi.advanceTimersByTimeAsync(400);
  const signal = saved[0].signal;
  await auth.clearAuthToken();
  assert.equal(signal?.aborted, true);
  await login(auth, 'B');
  store.writeUserPreference('selectedProvider', 'codex');
  await vi.advanceTimersByTimeAsync(400);
  assert.equal(saved[1].bearer, `Bearer ${token('B')}`);
  assert.deepEqual(saved[1].updates, { selectedProvider: 'codex' });
  await auth.clearAuthToken();
  await login(auth, 'A');
  response.resolve(commit(saved[0]!));
  await settled();
  assert.equal(saved.length, 3);
  assert.equal(saved[2].bearer, `Bearer ${token('A')}`);
  assert.deepEqual(saved[2].updates, { theme: 'dark' });
  assert.equal(persistedPartition('B').preferences.theme, undefined);
});

test('late preference JSON after logout cannot restore another account mirror', async () => {
  const { store, auth } = await loadStore();
  const body = deferred<unknown>();
  const response = new Response('{}', { status: 200 });
  vi.spyOn(response, 'json').mockReturnValue(body.promise);
  loadResult = response;
  const hydration = store.hydrateUserPreferences();
  await settled();
  await auth.clearAuthToken();
  store.resetUserPreferences();
  await login(auth, 'B');
  body.resolve({ preferences: { theme: 'dark' } });
  await hydration;
  assert.equal(store.readUserPreference('theme', 'light'), 'light');
  assert.equal(store.hasHydratedUserPreferences(), false);
  assert.equal(persistedPartition('B').preferences.theme, undefined);
});

test('server and instance identity partitions isolate the same user without sending the old queue', async () => {
  vi.stubGlobal('mygo', {});
  vi.resetModules();
  const auth = await import('@/shared/authToken');
  const initial = await auth.initializeAuthSession();
  // Desktop server changes arrive through the same public native observation that the real bridge publishes.
  const original = auth.observeNativeAuthSession({ ...initial, serverKey: ACCOUNT_SERVER, userId: 'A', token: token('A'),
    sessionInstanceId: 'primary-server-session', phase: 'ready', nativeHandle: 'primary-handle', nativeGeneration: 1 });
  auth.acknowledgeAuthSession(original);
  const store = await import('@/shared/userSettings');
  loadedStores.push(store);
  store.writeUserPreference('theme', 'dark');
  const otherServer = ACCOUNT_SERVER + '/instances/secondary';
  const otherKey = PARTITION_PREFIX + encodeURIComponent(JSON.stringify([otherServer, 'A']));
  (navigator.locks ? localStorage : sessionStorage).setItem(otherKey, JSON.stringify({ version: 2, identity: { serverKey: otherServer, userId: 'A' },
    preferences: { theme: 'light' }, revisions: {}, pending: {}, inFlight: {}, failures: {}, authPause: null,
    legacyMigrationComplete: true }));
  const switched = auth.observeNativeAuthSession({ ...original, serverKey: otherServer,
    sessionInstanceId: 'secondary-server-session', nativeHandle: 'secondary-handle', nativeGeneration: 2 });
  auth.acknowledgeAuthSession(switched);
  assert.equal(store.readUserPreference('theme', null), 'light');
  assert.equal(store.getPreferenceSyncStatus().identity?.serverKey, otherServer);
  await vi.advanceTimersByTimeAsync(1000);
  expect(saved).toEqual([]);
  expect(fetch).not.toHaveBeenCalled();
  assert.equal(persistedPartition('A').pending.theme.value, 'dark');
});

test('reset hides the account immediately but preserves its unconfirmed partition for its next verified hydrate', async () => {
  const { store } = await loadStore();
  store.writeUserPreference('theme', 'dark');
  store.resetUserPreferences();
  assert.equal(store.readUserPreference('theme', 'light'), 'light');
  assert.equal(store.getPreferenceSyncStatus().status, 'local');
  await vi.advanceTimersByTimeAsync(1000);
  expect(saved).toEqual([]);
  assert.equal(persistedPartition().pending.theme.value, 'dark');
  await store.hydrateUserPreferences();
  assert.equal(store.readUserPreference('theme', null), 'dark');
  await vi.advanceTimersByTimeAsync(400);
  assert.equal(store.getPreferenceSyncStatus().status, 'saved');
});

test('sync snapshots are stable until a visible transition and unsubscribe stops progress notifications', async () => {
  const { store } = await loadStore();
  assert.equal(store.getPreferenceSyncStatus(), store.getPreferenceSyncStatus());
  const listener = vi.fn();
  const unsubscribe = store.subscribeToPreferenceSyncStatus(listener);
  store.writeUserPreference('theme', 'dark');
  assert.equal(listener.mock.calls.length, 1);
  unsubscribe();
  await vi.advanceTimersByTimeAsync(400);
  assert.equal(listener.mock.calls.length, 1);
  assert.equal(store.getPreferenceSyncStatus().status, 'saved');
});

test('a persistence failure stays visible even after a server acknowledgment', async () => {
  const { store } = await loadStore();
  const original = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
    if (key.startsWith(PARTITION_PREFIX)) throw new DOMException('Quota exceeded', 'QuotaExceededError');
    original.call(this, key, value);
  });
  store.writeUserPreference('theme', 'dark');
  assert.ok(store.getPreferenceSyncStatus().persistenceError);
  await vi.advanceTimersByTimeAsync(400);
  assert.equal(serverPreferences.theme, 'dark');
  assert.equal(store.getPreferenceSyncStatus().status, 'failed');
});

test('the production singleton automatically hydrates version-2 dirty data and sends only the strict CAS envelope', async () => {
  const storageKey = PARTITION_PREFIX + encodeURIComponent(JSON.stringify([ACCOUNT_SERVER, 'A']));
  sessionStorage.setItem(storageKey, JSON.stringify({ version: 2, identity: { serverKey: ACCOUNT_SERVER, userId: 'A' },
    preferences: { theme: 'dark' }, revisions: { theme: 7 }, pending: { theme: { revision: 7, value: 'dark' } }, inFlight: {}, failures: {} }));
  serverPreferences = { theme: 'light' };
  serverRevisions = { theme: 12 };
  const { store } = await loadStore();
  assert.equal(store.readUserPreference('theme', null), 'dark');
  await vi.advanceTimersByTimeAsync(400);
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0]!.expectedRevisions, { theme: 12 });
  assert.equal(persistedPartition().version, 3);
  assert.equal(persistedPartition().serverRevisions.theme, 13);
  assert.equal(store.getPreferenceSyncStatus().status, 'saved');
});

test('timeout and page reload replay the exact persisted UUIDv7 payload after an unknown server commit', async () => {
  const { store: first } = await loadStore();
  const lost = deferred<Response>();
  saveResults.push(lost.promise);
  first.writeUserPreferences({ theme: 'dark', userLanguage: 'de' });
  await vi.advanceTimersByTimeAsync(400);
  const original = persistedPartition().operations[0]!.transaction;
  assert.match(original.operationId, /^[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
  assert.equal(Number.parseInt(original.operationId.replace(/-/g, '').slice(0, 12), 16), Date.now());
  const originalPayload = JSON.stringify(original);
  commit(original); // Server committed, but the renderer receives no ACK before termination.
  first.resetUserPreferences();
  const { store: reopened } = await loadStore();
  await vi.advanceTimersByTimeAsync(400);
  assert.equal(saved.length, 2);
  assert.equal(JSON.stringify({ operationId: saved[1]!.operationId, updates: saved[1]!.updates, expectedRevisions: saved[1]!.expectedRevisions }), originalPayload);
  assert.equal(applied, 1, 'journal replay must not write or increment any version again');
  assert.equal(reopened.getPreferenceSyncStatus().status, 'saved');
  lost.resolve(commit(original));
  await settled();
  assert.equal(applied, 1);
});

test('an automatic timeout retry retains the same operation ID and payload even after its network may have committed', async () => {
  const { store } = await loadStore();
  const lost = deferred<Response>();
  saveResults.push(lost.promise);
  store.writeUserPreference('theme', 'dark');
  await vi.advanceTimersByTimeAsync(400);
  const original = persistedPartition().operations[0]!.transaction;
  commit(original);
  await vi.advanceTimersByTimeAsync(11_000);
  assert.equal(saved.length, 2);
  assert.equal(saved[1]!.operationId, original.operationId);
  assert.deepEqual(saved[1]!.updates, original.updates);
  assert.deepEqual(saved[1]!.expectedRevisions, original.expectedRevisions);
  assert.equal(applied, 1);
  assert.equal(store.getPreferenceSyncStatus().status, 'saved');
  lost.resolve(commit(original));
  await settled();
});

test('a memory-only retry retains immutable transaction values even if an optimistic reader mutates its object', async () => {
  const { store } = await loadStore();
  const originalSetItem = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    if (key.startsWith(PARTITION_PREFIX)) throw new DOMException('Storage denied', 'SecurityError');
    originalSetItem.call(this, key, value);
  });
  saveResults.push(new Error('connection lost'));
  store.writeUserPreference('codeEditorSettings', { fontSize: '16' });
  await vi.advanceTimersByTimeAsync(400);
  store.readUserPreference('codeEditorSettings', { fontSize: '12' }).fontSize = '22';
  await vi.advanceTimersByTimeAsync(1000);
  assert.equal(saved.length, 2);
  assert.equal(saved[0]!.operationId, saved[1]!.operationId);
  assert.deepEqual(saved[1]!.updates, { codeEditorSettings: { fontSize: '16' } });
  assert.deepEqual(serverPreferences.codeEditorSettings, { fontSize: '16' });
  assert.equal(store.getPreferenceSyncStatus().status, 'failed', 'storage denial must remain visible after the valid server ACK');
});

test('a touched-only historical replay cannot regress a newer server snapshot or erase another preference', async () => {
  const { store } = await loadStore();
  const lost = deferred<Response>();
  saveResults.push(lost.promise);
  store.writeUserPreference('theme', 'dark');
  await vi.advanceTimersByTimeAsync(400);
  const original = persistedPartition().operations[0]!.transaction;
  commit(original);
  serverPreferences = { theme: 'light', userLanguage: 'ja' };
  serverRevisions = { theme: 2, userLanguage: 8 };
  await store.hydrateUserPreferences();
  lost.resolve(commit(original));
  await settled();
  assert.equal(store.readUserPreference('theme', null), 'light');
  assert.equal(store.readUserPreference('userLanguage', null), 'ja');
  assert.equal(persistedPartition().serverRevisions.theme, 2);
  assert.equal(persistedPartition().serverRevisions.userLanguage, 8);
  assert.equal(store.getPreferenceSyncStatus().status, 'saved');
});

test.each([
  { success: true, preferences: {} },
  { success: true, preferences: {}, revisions: { theme: -1 } },
  { success: true, preferences: {}, revisions: { theme: 1.5 } },
  { success: true, preferences: {}, revisions: { theme: '0' } },
])('missing or invalid snapshot revisions fail visibly and never authorize a PATCH (%j)', async payload => {
  loadResult = new Response(JSON.stringify(payload));
  const { store } = await loadStore();
  store.writeUserPreference('theme', 'dark');
  await vi.advanceTimersByTimeAsync(400);
  assert.equal(saved.length, 0);
  assert.equal(store.getPreferenceSyncStatus().status, 'failed');
  assert.match(store.getPreferenceSyncStatus().hydrationError!, /server revisions/);
  assert.equal(persistedPartition().pending.theme.value, 'dark');
});

test.each(['204', 'missing-revisions', 'invalid-revisions', 'wrong-operation', 'untouched-fields', '404'])('invalid transaction acknowledgment fails closed without a plain PATCH fallback (%s)', async failure => {
  const { store } = await loadStore();
  const gate = deferred<Response>();
  saveResults.push(gate.promise);
  store.writeUserPreference('theme', 'dark');
  await vi.advanceTimersByTimeAsync(400);
  const input = saved[0]!;
  const payload: Record<string, unknown> = { success: true, operationId: input.operationId, replayed: false, preferences: { theme: 'dark' }, revisions: { theme: 1 } };
  if (failure === 'missing-revisions') delete payload.revisions;
  if (failure === 'invalid-revisions') payload.revisions = { theme: -1 };
  if (failure === 'wrong-operation') payload.operationId = crypto.randomUUID();
  if (failure === 'untouched-fields') payload.preferences = { theme: 'dark', userLanguage: 'ja' };
  gate.resolve(failure === '204' ? new Response(null, { status: 204 }) : failure === '404' ? new Response('{}', { status: 404 }) : new Response(JSON.stringify(payload)));
  await settled();
  assert.equal(store.getPreferenceSyncStatus().status, 'failed');
  assert.equal(persistedPartition().pending.theme.value, 'dark');
  await vi.advanceTimersByTimeAsync(60_000);
  assert.equal(saved.length, 1);
  assert.equal(applied, 0);
});

test('a 409 rebases only the newest still-dirty intent with a fresh UUIDv7 and returned server revision', async () => {
  const { store } = await loadStore();
  const delayed = deferred<Response>();
  saveResults.push(delayed.promise);
  store.writeUserPreference('theme', 'dark');
  await vi.advanceTimersByTimeAsync(400);
  store.writeUserPreference('theme', 'light');
  serverPreferences = { theme: 'remote' };
  serverRevisions = { theme: 9 };
  delayed.resolve(commit(saved[0]!));
  await settled();
  assert.equal(saved.length, 2);
  assert.deepEqual(saved[1]!.updates, { theme: 'light' });
  assert.deepEqual(saved[1]!.expectedRevisions, { theme: 9 });
  assert.notEqual(saved[1]!.operationId, saved[0]!.operationId);
  assert.equal(serverPreferences.theme, 'light');
  assert.equal(applied, 1);
});

test('repeated concurrent conflicts stop at a finite rebase budget without reviving the rejected old value', async () => {
  const { store } = await loadStore();
  onSave = () => { serverPreferences.theme = 'remote'; serverRevisions.theme = (serverRevisions.theme ?? 0) + 1; };
  store.writeUserPreference('theme', 'dark');
  await vi.advanceTimersByTimeAsync(400);
  await vi.advanceTimersByTimeAsync(10);
  assert.equal(saved.length, 4);
  assert.equal(new Set(saved.map(request => request.operationId)).size, 4);
  assert.equal(store.getPreferenceSyncStatus().status, 'failed');
  assert.equal(persistedPartition().pending.theme.value, 'dark');
  await vi.advanceTimersByTimeAsync(86_400_000);
  assert.equal(saved.length, 4);
  assert.equal(applied, 0);
});

test('slow hydration JSON cannot regress an ACK or an edit that completed while parsing the response', async () => {
  const { store } = await loadStore();
  await store.hydrateUserPreferences();
  const body = deferred<unknown>();
  const response = new Response('{}');
  vi.spyOn(response, 'json').mockReturnValue(body.promise);
  loadResult = response;
  const loading = store.hydrateUserPreferences();
  await settled();
  store.writeUserPreference('theme', 'dark');
  await vi.advanceTimersByTimeAsync(400);
  assert.equal(store.getPreferenceSyncStatus().status, 'saved');
  body.resolve({ success: true, preferences: { theme: 'light', userLanguage: 'ja' }, revisions: { theme: 0, userLanguage: 3 } });
  await loading;
  assert.equal(store.readUserPreference('theme', null), 'dark');
  assert.equal(store.readUserPreference('userLanguage', null), 'ja');
  assert.equal(persistedPartition().serverRevisions.theme, 1);
});

test('a still-current conflict creates a new operation using the returned tombstone revision', async () => {
  const { store } = await loadStore();
  const pending = deferred<Response>();
  saveResults.push(pending.promise);
  store.writeUserPreference('theme', 'dark');
  await vi.advanceTimersByTimeAsync(400);
  serverRevisions.theme = 7; // A deleted server value retains a version even while absent from preferences.
  pending.resolve(commit(saved[0]!));
  await vi.advanceTimersByTimeAsync(10);
  assert.equal(saved.length, 2);
  assert.notEqual(saved[0]!.operationId, saved[1]!.operationId);
  assert.deepEqual(saved[1]!.expectedRevisions, { theme: 7 });
  assert.equal(serverPreferences.theme, 'dark');
  assert.equal(serverRevisions.theme, 8);
  assert.equal(store.getPreferenceSyncStatus().status, 'saved');
});

test('initial snapshot 401 keeps the queue paused until a real credential rotation enables version hydration', async () => {
  loadResult = new Response('{}', { status: 401 });
  const { store, auth } = await loadStore();
  store.writeUserPreference('theme', 'dark');
  await vi.advanceTimersByTimeAsync(400);
  assert.equal(store.getPreferenceSyncStatus().status, 'paused');
  assert.equal(saved.length, 0);
  loadResult = null;
  assert.equal(await auth.storeAuthToken(token('A', 'rotated'), auth.getAuthSessionSnapshot()), true);
  await vi.advanceTimersByTimeAsync(400);
  assert.equal(saved.length, 1);
  assert.equal(saved[0]!.bearer, `Bearer ${token('A', 'rotated')}`);
  assert.equal(store.getPreferenceSyncStatus().status, 'saved');
});

test('a terminal multi-field operation cannot revive its remaining field when only another field is explicitly edited', async () => {
  const { store } = await loadStore();
  saveResults.push(request => terminalResponse(request));
  store.writeUserPreferences({ theme: 'dark', userLanguage: 'de' });
  await vi.advanceTimersByTimeAsync(400);
  store.writeUserPreference('theme', 'light');
  await vi.advanceTimersByTimeAsync(400);
  assert.equal(saved.length, 2);
  assert.deepEqual(saved[1]!.updates, { theme: 'light' });
  assert.equal(serverPreferences.theme, 'light');
  assert.equal(serverPreferences.userLanguage, undefined);
  assert.equal(persistedPartition().pending.userLanguage.value, 'de');
  assert.equal(store.getPreferenceSyncStatus().status, 'failed');
  store.retryUserPreferences();
  await vi.advanceTimersByTimeAsync(60_000);
  assert.equal(saved.length, 2);
});

test('a journal mismatch is terminal and manual retry cannot refresh or mutate that operation', async () => {
  const { store } = await loadStore();
  saveResults.push(request => terminalResponse(request));
  store.writeUserPreference('theme', 'dark');
  await vi.advanceTimersByTimeAsync(400);
  const original = persistedPartition().operations[0]!.transaction;
  assert.equal(store.getPreferenceSyncStatus().status, 'failed');
  store.retryUserPreferences();
  await vi.advanceTimersByTimeAsync(60_000);
  assert.equal(saved.length, 1);
  assert.deepEqual(persistedPartition().operations[0]!.transaction, original);
});

test.each(['wrong operation', 'missing envelope', 'wrong success', 'missing replay flag', 'missing touched revision'])('an invalid terminal refusal (%s) cannot permanently seal the current intent', async mode => {
  const { store } = await loadStore();
  saveResults.push(request => {
    const envelope: Record<string, unknown> = { success: false, operationId: request.operationId, replayed: false,
      code: 'PREFERENCE_OPERATION_MISMATCH', preferences: {}, revisions: { theme: 0 } };
    if (mode === 'wrong operation') envelope.operationId = '019a0000-0000-7000-8000-000000000001';
    if (mode === 'wrong success') envelope.success = true;
    if (mode === 'missing replay flag') delete envelope.replayed;
    if (mode === 'missing touched revision') envelope.revisions = {};
    return new Response(JSON.stringify(mode === 'missing envelope' ? { code: envelope.code } : envelope), { status: 409 });
  });
  store.writeUserPreference('theme', 'dark');
  await vi.advanceTimersByTimeAsync(400);
  const original = persistedPartition().operations[0]!.transaction;
  assert.equal(store.getPreferenceSyncStatus().status, 'failed');
  assert.match(store.getPreferenceSyncStatus().failures[0]!.message, /invalid transaction acknowledgment/);
  store.retryUserPreferences();
  await vi.advanceTimersByTimeAsync(400);
  assert.equal(saved.length, 2);
  assert.deepEqual({ operationId: saved[1]!.operationId, updates: saved[1]!.updates, expectedRevisions: saved[1]!.expectedRevisions }, original);
  assert.equal(serverPreferences.theme, 'dark');
  assert.equal(store.getPreferenceSyncStatus().status, 'saved');
});

test('a discarded late response cancels its body and does not confirm another account', async () => {
  const { store, auth } = await loadStore();
  const pending = deferred<Response>();
  saveResults.push(pending.promise);
  store.writeUserPreference('theme', 'dark');
  await vi.advanceTimersByTimeAsync(400);
  await auth.clearAuthToken();
  await login(auth, 'B');
  const response = new Response(JSON.stringify({ success: true }));
  const cancel = vi.spyOn(response.body!, 'cancel');
  pending.resolve(response);
  await settled();
  assert.ok(cancel.mock.calls.length >= 1);
  assert.equal(persistedPartition('B').preferences.theme, undefined);
  assert.equal(persistedPartition('A').pending.theme.value, 'dark');
});

test('a late rejecting transaction JSON body is contained after reset and same-user replacement', async () => {
  const { store, auth } = await loadStore();
  const body = deferred<unknown>();
  const response = new Response('{}');
  vi.spyOn(response, 'json').mockReturnValue(body.promise);
  saveResults.push(response);
  store.writeUserPreference('theme', 'dark');
  await vi.advanceTimersByTimeAsync(400);
  const previous = auth.getAuthSessionSnapshot();
  await auth.clearAuthToken();
  store.resetUserPreferences();
  const replacementAck = deferred<Response>();
  saveResults.push(replacementAck.promise);
  await login(auth, 'A');
  assert.notEqual(auth.getAuthSessionSnapshot().sessionInstanceId, previous.sessionInstanceId);
  body.reject(new Error('late unreadable body'));
  await settled();
  assert.equal(store.readUserPreference('theme', null), 'dark');
  assert.equal(persistedPartition().inFlight.theme.value, 'dark');
  assert.equal(store.getPreferenceSyncStatus().status, 'saving', 'the old rejecting JSON cannot settle the replacement dispatcher');
  replacementAck.resolve(commit(saved[1]!));
  await settled();
  assert.equal(store.getPreferenceSyncStatus().status, 'saved');
});

test('a timed-out GET settles and cancels its late response without uncaught cancellation errors', async () => {
  const { store } = await loadStore();
  const pending = deferred<Response>();
  loadResult = pending.promise;
  store.writeUserPreference('theme', 'dark');
  await vi.advanceTimersByTimeAsync(10_000);
  assert.equal(store.getPreferenceSyncStatus().status, 'failed');
  assert.match(store.getPreferenceSyncStatus().hydrationError!, /timed out/);
  const response = new Response('{}');
  const cancel = vi.spyOn(response.body!, 'cancel');
  pending.resolve(response);
  await settled();
  assert.ok(cancel.mock.calls.length >= 1);
  assert.equal(saved.length, 0);
});

test('an expired unknown operation is rejected finitely, refreshes the snapshot and cannot be regenerated by retry', async () => {
  const { store } = await loadStore();
  const gate = deferred<Response>();
  saveResults.push(gate.promise);
  store.writeUserPreference('theme', 'dark');
  await vi.advanceTimersByTimeAsync(400);
  const original = persistedPartition().operations[0]!.transaction;
  vi.setSystemTime(Date.now() + 86_400_001);
  gate.resolve(commit(original));
  await settled();
  assert.equal(store.getPreferenceSyncStatus().status, 'failed');
  assert.match(store.getPreferenceSyncStatus().failures[0]!.message, /PREFERENCE_OPERATION_EXPIRED/);
  store.retryUserPreferences();
  await vi.advanceTimersByTimeAsync(60_000);
  assert.equal(saved.length, 1);
  assert.equal(persistedPartition().operations[0]!.transaction.operationId, original.operationId);
  assert.equal(applied, 0);
});
