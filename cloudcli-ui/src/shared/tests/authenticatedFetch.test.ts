import assert from 'node:assert/strict';

import { afterEach, beforeEach, test, vi } from 'vitest';

import type * as AuthTokenModule from '@/shared/authToken';
import type { AuthSessionSnapshot } from '@/shared/types';

// Each test loads one fresh auth authority and API module, independent of local .env.
let auth: typeof AuthTokenModule;
// The transport capture belongs only to the current case and is reset before every request fixture.
let lastInit: RequestInit | undefined;
// Case-local subscriptions are removed even when a contract assertion fails.
let cleanups: Array<() => void> = [];

const loadFetch = async (isPlatform = false) => {
  vi.stubEnv('VITE_IS_PLATFORM', isPlatform ? 'true' : 'false');
  return (await import('@/shared/api')).authenticatedFetch;
};

const makeToken = (payload: Record<string, unknown>) => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.signature`;
};

const liveToken = (userId = 'alice', signature = 'signature') => {
  const now = Math.floor(Date.now() / 1000);
  return makeToken({ userId, iat: now, exp: now + 600 }).replace('signature', signature);
};

const expiredToken = () => {
  const now = Math.floor(Date.now() / 1000);
  return makeToken({ userId: 'alice', iat: now - 7200, exp: now - 3600 });
};

const startSession = async (token = liveToken()) => {
  const started = await auth.startAuthSession(token, auth.getAuthSessionSnapshot());
  assert.ok(started, 'the explicit login must commit before a request can use its credential');
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

// A cached response replays its stored headers and status, so the status must be
// considered before applying either refresh or expiry to the captured request.
const respondWith = (headers: Record<string, string> = {}, status = 200) => {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    lastInit = init;
    return new Response('{}', { status, headers });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

const deferResponse = () => {
  let resolve!: (response: Response) => void;
  let markDispatched!: () => void;
  const response = new Promise<Response>(done => { resolve = done; });
  const dispatched = new Promise<void>(done => { markDispatched = done; });
  const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
    lastInit = init;
    markDispatched();
    return response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return { resolve, dispatched, fetchMock };
};

const sentHeaders = () => new Headers(lastInit?.headers);

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv('VITE_IS_PLATFORM', 'false');
  localStorage.clear();
  sessionStorage.clear();
  lastInit = undefined;
  cleanups = [];
  auth = await import('@/shared/authToken');
  const initial = await auth.initializeAuthSession();
  assert.equal(initial.storageMode, 'window', 'jsdom has no Web Locks; shared legacy credentials are not a login fixture');
  assert.equal(initial.phase, 'signedOut');
});

afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

test('a live token is sent as a bearer credential', async () => {
  const before = await startSession();
  respondWith();

  await (await loadFetch())('/api/projects');

  assert.equal(sentHeaders().get('Authorization'), `Bearer ${before.token}`);
  assert.deepEqual(auth.getAuthSessionSnapshot(), before);
});

test('platform builds send no bearer token, because the session is a cookie', async () => {
  const before = await startSession();
  respondWith();

  await (await loadFetch(true))('/api/projects');

  assert.equal(sentHeaders().has('Authorization'), false);
  assert.deepEqual(auth.getAuthSessionSnapshot(), before);
});

test('an expired token is never put on the wire', async () => {
  const before = await startSession();
  const authenticatedFetch = await loadFetch();
  // Login was valid when committed; only a later dispatch observes its expiry.
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3_600_000);
  const observed = observeSession();
  const fetchMock = respondWith();

  const failure = await authenticatedFetch('/api/projects').then(() => null, error => error);

  for (const [, init] of fetchMock.mock.calls) {
    assert.equal(new Headers(init?.headers).has('Authorization'), false, 'an expired bearer must never reach fetch');
  }
  if (failure !== null) assert.equal(failure.name, 'AbortError', 'expiry may cancel dispatch instead of sending anonymously');
  const after = auth.getAuthSessionSnapshot();
  assert.equal(after.phase, 'signedOut');
  assert.equal(after.token, null);
  assert.equal(after.userId, null);
  assert.notEqual(after.sessionInstanceId, before.sessionInstanceId);
  assert.equal(after.tokenRevision, 0);
  assert.equal(observed.snapshots.filter(snapshot => snapshot.phase === 'signedOut').length, 1);
  assert.ok(observed.notifications.every(args => args.length === 0));
});

test('no token means no Authorization header at all', async () => {
  respondWith();

  await (await loadFetch())('/api/projects');

  assert.equal(sentHeaders().has('Authorization'), false);
  assert.equal(auth.getAuthSessionSnapshot().phase, 'signedOut');
});

test('a JSON body is labelled as JSON', async () => {
  respondWith();

  await (await loadFetch())('/api/projects', { method: 'POST', body: '{"a":1}' });

  assert.equal(sentHeaders().get('Content-Type'), 'application/json');
});

test('a FormData body is left for the browser to label', async () => {
  respondWith();

  await (await loadFetch())('/api/upload', { method: 'POST', body: new FormData() });

  assert.equal(sentHeaders().has('Content-Type'), false, 'a manual multipart header would omit the browser boundary');
});

test('a caller Content-Type header wins over the default', async () => {
  respondWith();

  await (await loadFetch())('/api/projects', {
    method: 'POST',
    body: 'raw',
    headers: { 'Content-Type': 'text/plain' },
  });

  assert.equal(sentHeaders().get('Content-Type'), 'text/plain');
});

test('caller Authorization overrides are stripped and only the authority credential is sent', async () => {
  const before = await startSession();
  respondWith();

  await (await loadFetch())('/api/projects', {
    headers: { Authorization: 'Bearer caller-one', authorization: 'Bearer caller-two', aUtHoRiZaTiOn: 'Bearer caller-three', 'X-Caller': 'preserved' },
  });

  assert.equal(sentHeaders().get('Authorization'), `Bearer ${before.token}`);
  assert.equal(sentHeaders().get('X-Caller'), 'preserved');
  assert.equal(Object.keys(lastInit?.headers ?? {}).filter(key => key.toLowerCase() === 'authorization').length, 1);
  assert.deepEqual(auth.getAuthSessionSnapshot(), before);
});

test('caller Authorization cannot introduce a credential while signed out', async () => {
  respondWith();

  await (await loadFetch())('/api/projects', { headers: { authorization: 'Bearer caller' } });

  assert.equal(sentHeaders().has('Authorization'), false);
  assert.equal(auth.getAuthSessionSnapshot().phase, 'signedOut');
});

test('platform builds also strip caller Authorization overrides', async () => {
  const before = await startSession();
  respondWith();

  await (await loadFetch(true))('/api/projects', { headers: { AUTHORIZATION: 'Bearer caller' } });

  assert.equal(sentHeaders().has('Authorization'), false);
  assert.deepEqual(auth.getAuthSessionSnapshot(), before);
});

test('a refreshed token on the response replaces the credential within the same identity', async () => {
  const before = await startSession();
  const rotated = liveToken('alice', 'rotated');
  const observed = observeSession();
  respondWith({ 'X-Refreshed-Token': rotated });

  await (await loadFetch())('/api/projects');

  const after = auth.getAuthSessionSnapshot();
  assert.equal(after.token, rotated);
  assert.equal(after.userId, before.userId);
  assert.equal(after.phase, 'ready');
  assert.equal(after.sessionInstanceId, before.sessionInstanceId);
  assert.equal(after.serverKey, before.serverKey);
  assert.equal(after.tokenRevision, before.tokenRevision + 1);
  assert.deepEqual(observed.snapshots, [after]);
  assert.deepEqual(observed.notifications, [[]], 'the notification must not broadcast a token');
  assert.equal(localStorage.getItem('auth-token'), null);
});

test('an auth error on the response ends the captured session', async () => {
  const before = await startSession();
  const observed = observeSession();
  respondWith({ 'X-Auth-Error': 'invalid' }, 401);

  const response = await (await loadFetch())('/api/projects');

  const after = auth.getAuthSessionSnapshot();
  assert.equal(response.status, 401);
  assert.equal(after.phase, 'signedOut');
  assert.equal(after.token, null);
  assert.equal(after.userId, null);
  assert.notEqual(after.sessionInstanceId, before.sessionInstanceId);
  assert.equal(after.serverKey, before.serverKey);
  assert.equal(after.tokenRevision, 0);
  assert.equal(observed.snapshots.filter(snapshot => snapshot.phase === 'signedOut').length, 1);
  assert.ok(observed.notifications.every(args => args.length === 0));
});

test('an auth error replayed by a cached response does not end the session', async () => {
  const before = await startSession();
  const observed = observeSession();
  respondWith({ 'X-Auth-Error': 'invalid' }, 200);

  await (await loadFetch())('/api/projects');

  assert.deepEqual(auth.getAuthSessionSnapshot(), before);
  assert.deepEqual(observed.snapshots, []);
});

test('an expired refreshed token does not replace the stored one', async () => {
  const before = await startSession();
  const observed = observeSession();
  respondWith({ 'X-Refreshed-Token': expiredToken() });

  await (await loadFetch())('/api/projects');

  assert.deepEqual(auth.getAuthSessionSnapshot(), before);
  assert.deepEqual(observed.snapshots, []);
});

test('requests bypass the HTTP cache', async () => {
  await startSession();
  respondWith();

  await (await loadFetch())('/api/projects', { cache: 'force-cache' });

  assert.equal(lastInit?.cache, 'no-store', 'a caller must not re-enable replay of cached authentication headers');
});

test('an ordinary response leaves the stored token alone', async () => {
  const before = await startSession();
  const observed = observeSession();
  respondWith();

  await (await loadFetch())('/api/projects');

  assert.deepEqual(auth.getAuthSessionSnapshot(), before);
  assert.deepEqual(observed.snapshots, []);
});

test('a reply from before logout cannot restore a token or expire a newer account', async () => {
  const before = await startSession();
  const authenticatedFetch = await loadFetch();
  const deferred = deferResponse();
  const pending = authenticatedFetch('/api/projects');
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await deferred.dispatched;
  assert.equal(sentHeaders().get('Authorization'), `Bearer ${before.token}`);
  assert.equal(await auth.clearAuthToken(before), true);
  const next = await startSession(liveToken('bob', 'nextaccount'));
  const observed = observeSession();

  deferred.resolve(new Response('{}', { status: 401, headers: { 'X-Refreshed-Token': liveToken('alice', 'stale'), 'X-Auth-Error': 'expired' } }));
  await rejected;

  assert.deepEqual(auth.getAuthSessionSnapshot(), next);
  assert.equal(next.userId, 'bob');
  assert.notEqual(next.sessionInstanceId, before.sessionInstanceId);
  assert.equal(next.tokenRevision, 0);
  assert.deepEqual(observed.snapshots, []);
});

test('a successful response from before a new login cannot refresh the newer account', async () => {
  const before = await startSession();
  const authenticatedFetch = await loadFetch();
  const deferred = deferResponse();
  const pending = authenticatedFetch('/api/projects');
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await deferred.dispatched;
  // Same-user login still creates a new incarnation, preventing an ABA refresh.
  const next = await startSession(liveToken('alice', 'newlogin'));
  const observed = observeSession();

  deferred.resolve(new Response('{}', { headers: { 'X-Refreshed-Token': liveToken('alice', 'stalerefresh') } }));
  await rejected;

  assert.notEqual(next.sessionInstanceId, before.sessionInstanceId);
  assert.equal(next.userId, before.userId);
  assert.equal(next.tokenRevision, 0);
  assert.deepEqual(auth.getAuthSessionSnapshot(), next);
  assert.deepEqual(observed.snapshots, []);
});

test('a stale 401 arriving after the same session refresh cannot end the refreshed session', async () => {
  const before = await startSession();
  const authenticatedFetch = await loadFetch();
  const deferred = deferResponse();
  const pending = authenticatedFetch('/api/projects');
  await deferred.dispatched;
  const rotated = liveToken('alice', 'rotated');
  deferred.fetchMock.mockResolvedValueOnce(new Response('{}', { headers: { 'X-Refreshed-Token': rotated } }));
  await authenticatedFetch('/api/auth/refresh');
  const refreshed = auth.getAuthSessionSnapshot();
  assert.equal(refreshed.sessionInstanceId, before.sessionInstanceId);
  assert.equal(refreshed.token, rotated);
  assert.equal(refreshed.tokenRevision, before.tokenRevision + 1);
  const observed = observeSession();

  deferred.resolve(new Response('{}', { status: 401, headers: { 'X-Auth-Error': 'expired' } }));
  const response = await pending;

  assert.equal(response.status, 401);
  assert.deepEqual(auth.getAuthSessionSnapshot(), refreshed);
  assert.equal(auth.getAuthSessionSnapshot().phase, 'ready');
  assert.deepEqual(observed.snapshots, []);
});

test('a response discarded after account replacement cancels its unread body', async () => {
  await startSession();
  const authenticatedFetch = await loadFetch();
  const deferred = deferResponse();
  const canceled = vi.fn();
  const pending = authenticatedFetch('/api/projects');
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await deferred.dispatched;
  await startSession(liveToken('bob'));
  deferred.resolve(new Response(new ReadableStream({ cancel: canceled })));
  await rejected;
  assert.equal(canceled.mock.calls.length, 1);
});

test('a response arriving after caller cancellation cancels its unread body even when fetch ignores abort', async () => {
  await startSession();
  const authenticatedFetch = await loadFetch();
  const deferred = deferResponse();
  const canceled = vi.fn();
  const controller = new AbortController();
  const pending = authenticatedFetch('/api/projects', { signal: controller.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await deferred.dispatched;
  controller.abort();
  deferred.resolve(new Response(new ReadableStream({ cancel: canceled })));
  await rejected;
  assert.equal(canceled.mock.calls.length, 1);
});

test('committed expiry preserves status while canceling the rejected account body', async () => {
  await startSession();
  const authenticatedFetch = await loadFetch();
  const canceled = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ cancel: canceled }), {
    status: 401, headers: { 'X-Auth-Error': 'expired' },
  })));
  const response = await authenticatedFetch('/api/projects');
  assert.equal(response.status, 401);
  assert.equal(response.body, null);
  assert.equal(canceled.mock.calls.length, 1);
  assert.equal(auth.getAuthSessionSnapshot().phase, 'signedOut');
});

test('a pre-aborted signal rejects the returned promise without dispatching or changing the session', async () => {
  const before = await startSession();
  const authenticatedFetch = await loadFetch();
  const fetchMock = respondWith();
  const controller = new AbortController();
  controller.abort();
  let pending!: Promise<Response>;

  assert.doesNotThrow(() => { pending = authenticatedFetch('/api/projects', { signal: controller.signal }); });
  assert.equal(typeof pending.then, 'function');
  await assert.rejects(pending, { name: 'AbortError' });

  assert.equal(fetchMock.mock.calls.length, 0);
  assert.deepEqual(auth.getAuthSessionSnapshot(), before);
});
