import assert from 'node:assert/strict';

import { afterEach, beforeEach, test, vi } from 'vitest';

import type * as AuthTokenModule from '@/shared/authToken';
import type { AuthSessionSnapshot } from '@/shared/types';

// Every case observes a fresh authority backed by this jsdom window's sessionStorage.
let auth: typeof AuthTokenModule;
// Disposers keep subscriptions and compatibility-event observers local to their case.
let cleanups: Array<() => void> = [];

// Expiry only decodes claims; these JWT-shaped fixtures do not need a signing key.
const makeToken = (payload: Record<string, unknown>) => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.signature`;
};

const liveToken = (userId = 'alice', signature = 'signature') => {
  const now = Math.floor(Date.now() / 1000);
  return makeToken({ userId, iat: now, exp: now + 600 }).replace('signature', signature);
};

const startSession = async (token = liveToken()) => {
  const started = await auth.startAuthSession(token, auth.getAuthSessionSnapshot());
  assert.ok(started, 'the explicit login must commit before the fixture can use its credential');
  await auth.acknowledgeAuthSession(started);
  return started;
};

const observeSession = () => {
  const snapshots: AuthSessionSnapshot[] = [];
  const notifications: unknown[][] = [];
  cleanups.push(auth.subscribeToAuthSession((...args: unknown[]) => {
    notifications.push(args);
    snapshots.push(auth.getAuthSessionSnapshot());
  }));
  return { snapshots, notifications };
};

beforeEach(async () => {
  vi.resetModules();
  localStorage.clear();
  sessionStorage.clear();
  cleanups = [];
  auth = await import('@/shared/authToken');
  const initial = await auth.initializeAuthSession();
  assert.equal(initial.storageMode, 'window', 'jsdom has no Web Locks, so this fixture must be window-scoped');
  assert.equal(initial.phase, 'signedOut');
});

afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  vi.restoreAllMocks();
});

test('isAuthTokenExpired: a token well before its exp is not expired', () => {
  const now = Math.floor(Date.now() / 1000);
  const token = makeToken({ iat: now - 60, exp: now + 600 });
  assert.equal(auth.isAuthTokenExpired(token), false);
});

test('isAuthTokenExpired: a token expired within the clock-skew tolerance is not treated as expired', () => {
  const now = Math.floor(Date.now() / 1000);
  const skewSeconds = auth.TOKEN_EXPIRY_SKEW_MS / 1000;
  const token = makeToken({ iat: now - 600, exp: now - Math.floor(skewSeconds / 2) });
  assert.equal(auth.isAuthTokenExpired(token), false);
});

test('isAuthTokenExpired: a token expired just past the clock-skew tolerance is expired', () => {
  const now = Math.floor(Date.now() / 1000);
  const skewSeconds = auth.TOKEN_EXPIRY_SKEW_MS / 1000;
  const token = makeToken({ iat: now - 600, exp: now - skewSeconds - 5 });
  assert.equal(auth.isAuthTokenExpired(token), true);
});

test('isAuthTokenExpired: a token expired well past the skew tolerance is expired', () => {
  const now = Math.floor(Date.now() / 1000);
  const token = makeToken({ iat: now - 600, exp: now - 600 });
  assert.equal(auth.isAuthTokenExpired(token), true);
});

test('isAuthTokenExpired: a malformed/unreadable token is unaffected by the skew change', () => {
  assert.equal(auth.isAuthTokenExpired('not-a-jwt'), false);
  assert.equal(auth.isAuthTokenExpired('only.two-segments'), false);
  assert.equal(auth.isAuthTokenExpired(null), false);
});

test('storeAuthToken: a valid refresh is persisted and announced through a credential-free subscription', async () => {
  const before = await startSession();
  const token = liveToken('alice', 'rotated');
  const observed = observeSession();

  const stored = await auth.storeAuthToken(token, before);

  const after = auth.getAuthSessionSnapshot();
  assert.equal(stored, true);
  assert.equal(after.token, token);
  assert.equal(after.userId, 'alice');
  assert.equal(after.phase, 'ready');
  assert.equal(after.sessionInstanceId, before.sessionInstanceId);
  assert.equal(after.serverKey, before.serverKey);
  assert.equal(after.tokenRevision, before.tokenRevision + 1);
  assert.equal(auth.getStoredAuthToken(), token);
  assert.deepEqual(observed.snapshots, [after]);
  assert.deepEqual(observed.notifications, [[]], 'subscribers reread authority; the notification itself carries no credential');
  assert.equal(localStorage.getItem('auth-token'), null);
});

test('storeAuthToken: a non-token value is rejected and does not overwrite the session', async () => {
  const before = await startSession();
  const observed = observeSession();

  assert.equal(await auth.storeAuthToken(undefined, before), false);
  assert.equal(await auth.storeAuthToken('', before), false);
  assert.equal(await auth.storeAuthToken({ token: 'x' }, before), false);
  assert.deepEqual(auth.getAuthSessionSnapshot(), before);
  assert.deepEqual(observed.snapshots, []);
});

test('storeAuthToken: a refresh cannot create an account while signed out', async () => {
  const before = auth.getAuthSessionSnapshot();
  const observed = observeSession();

  assert.equal(await auth.storeAuthToken(liveToken(), before), false);
  assert.deepEqual(auth.getAuthSessionSnapshot(), before);
  assert.equal(auth.getStoredAuthToken(), null);
  assert.deepEqual(observed.snapshots, []);
});

test('storeAuthToken: a refresh for a different user cannot replace the current identity', async () => {
  const before = await startSession();

  assert.equal(await auth.storeAuthToken(liveToken('bob'), before), false);
  assert.deepEqual(auth.getAuthSessionSnapshot(), before);
});

test('getStoredAuthToken: an expired token is withheld and conditional expiry is announced once', async () => {
  const before = await startSession();
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3_600_000);
  const observed = observeSession();

  assert.equal(auth.getStoredAuthToken(), null, 'an expired token must not be handed to a request');
  assert.equal(await auth.expireAuthSession(before), true);

  const after = auth.getAuthSessionSnapshot();
  assert.equal(after.token, null);
  assert.equal(after.userId, null);
  assert.equal(after.phase, 'signedOut');
  assert.notEqual(after.sessionInstanceId, before.sessionInstanceId);
  assert.equal(after.serverKey, before.serverKey);
  assert.equal(after.tokenRevision, 0);
  assert.equal(await auth.expireAuthSession(before), false, 'the same expired predecessor cannot end another session');
  assert.equal(observed.snapshots.filter(snapshot => snapshot.phase === 'signedOut').length, 1);
  assert.ok(observed.notifications.every(args => args.length === 0));
});

test('getStoredAuthToken: a live token is returned and left in the authority', async () => {
  const before = await startSession();

  assert.equal(auth.getStoredAuthToken(), before.token);
  assert.deepEqual(auth.getAuthSessionSnapshot(), before);
});

test('legacy auth event names remain available without publishing credentials', async () => {
  assert.equal(auth.AUTH_TOKEN_REFRESHED_EVENT, 'auth-token-refreshed');
  assert.equal(auth.AUTH_SESSION_EXPIRED_EVENT, 'auth-session-expired');
  const details: unknown[] = [];
  const onLegacyEvent = (event: Event) => details.push((event as CustomEvent<unknown>).detail);
  for (const name of [auth.AUTH_TOKEN_REFRESHED_EVENT, auth.AUTH_SESSION_EXPIRED_EVENT]) {
    window.addEventListener(name, onLegacyEvent);
    cleanups.push(() => window.removeEventListener(name, onLegacyEvent));
  }
  const before = await startSession();
  const token = liveToken('alice', 'rotated');

  assert.equal(await auth.storeAuthToken(token, before), true);
  assert.equal(await auth.expireAuthSession(auth.getAuthSessionSnapshot()), true);

  // Compatibility events may be omitted, but any that remain must not carry bearer credentials.
  for (const detail of details) {
    const serialized = JSON.stringify(detail) ?? '';
    assert.equal(serialized.includes(before.token!), false);
    assert.equal(serialized.includes(token), false);
  }
});

test('getAuthTokenRefreshDelay: refresh is scheduled at the halfway point of the lifetime', () => {
  const now = Math.floor(Date.now() / 1000);
  const token = makeToken({ iat: now, exp: now + 600 });

  const delay = auth.getAuthTokenRefreshDelay(token);
  assert.ok(delay !== null);
  assert.ok(Math.abs(delay - 300_000) < 2_000, `expected ~300000ms, got ${delay}`);
});

test('getAuthTokenRefreshDelay: an already-past refresh point schedules immediately, never negative', () => {
  const now = Math.floor(Date.now() / 1000);
  assert.equal(auth.getAuthTokenRefreshDelay(makeToken({ iat: now - 600, exp: now - 300 })), 0);
});

test('getAuthTokenRefreshDelay: an unreadable token schedules nothing', () => {
  assert.equal(auth.getAuthTokenRefreshDelay('not-a-jwt'), null);
  assert.equal(auth.getAuthTokenRefreshDelay(null), null);
});
