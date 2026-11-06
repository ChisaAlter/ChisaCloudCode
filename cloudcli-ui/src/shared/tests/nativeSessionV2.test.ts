import assert from 'node:assert/strict';

import { act, cleanup, render, waitFor } from '@testing-library/react';
import { createElement, useLayoutEffect } from 'react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { BridgeResponse, ChisaApiConnection, ChisaRequestReservation } from '@/shared/types';

const native = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('mygo-runtime', () => native);
const translation = vi.hoisted(() => ({ t: (key: string) => key }));
vi.mock('react-i18next', () => ({ useTranslation: () => translation }));
vi.mock('@/shared/userSettings', () => ({ hydrateUserPreferences: vi.fn(), resetUserPreferences: vi.fn() }));
vi.mock('@/shared/chatDrafts', () => ({ hydrateChatDrafts: vi.fn(), resetChatDrafts: vi.fn() }));
// Keep real AuthProvider/API/session authority while excluding unrelated UI exported by the auth barrel.
vi.mock('@/modules/plugins', () => ({ ClaudeUsageContent: () => null }));
vi.mock('@/modules/claude-accounts', () => ({ ClaudeAccountsPanel: () => null }));
vi.mock('@/modules/token-usage', () => ({ TokenUsageDialog: () => null }));
vi.mock('@/modules/onboarding', () => ({ Onboarding: () => null }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function connection(account = 'a', generation = 1, authenticated = true): ChisaApiConnection {
  return {
    protocolVersion: 2, configured: true, sessionHandle: `session-${account}-${generation}`,
    serverKey: `server-${account}`, generation, version: generation, tokenRevision: 1,
    authenticated, accessToken: authenticated ? `account${account}.payload.signature` : '', restorationToken: '', switching: false,
    loginUrl: `https://${account}.example/login`, apiUrl: `https://${account}.example/api`,
    httpProxyUrl: `http://127.0.0.1:18792/channel/cap-${account}-${generation}`,
    webSocketUrl: `ws://127.0.0.1:18792/channel/cap-${account}-${generation}`,
  };
}
function reply(payload: unknown = {}): BridgeResponse {
  return { status: 200, headers: { 'Content-Type': 'application/json' }, bodyB64: btoa(JSON.stringify(payload)) };
}
type Ticket = { connection: ChisaApiConnection; token: string; purpose: string };

// Reservations and dispatches both enforce the native contract, including immutable target ownership.
function peer(initial = connection()) {
  const tickets = new Map<string, Ticket>();
  let sequence = 0;
  const state = {
    current: initial,
    lookup: null as null | (() => Promise<ChisaApiConnection>),
    reserve: null as null | ((result: ChisaRequestReservation) => Promise<ChisaRequestReservation>),
    respond: null as null | ((ticket: Ticket, path: string) => Promise<BridgeResponse>),
    end: null as null | ((handle: string, revision: number) => Promise<unknown>),
    forwarded: [] as Array<{ target: string; token: string; path: string; purpose: string }>,
    capabilities: new Map([[initial.webSocketUrl, { ...initial }], [initial.httpProxyUrl, { ...initial }]]),
  };
  native.call.mockImplementation(async (method: string, ...args: unknown[]) => {
    if (method === 'FrontendBridge.GetApiConnection') return state.lookup ? state.lookup() : { ...state.current };
    if (method === 'FrontendBridge.BeginServerRequest' || method === 'FrontendBridge.EndServerSession') {
      throw new Error('Legacy native session operation is fail-closed');
    }
    if (method === 'FrontendBridge.BeginServerRequestV2') {
      assert.equal(args.length, 5);
      const [handle, token, revision, purpose, key] = args;
      if (state.current.switching) return { ok: false, code: 'SERVER_SWITCH_IN_PROGRESS' };
      if (!handle || handle !== state.current.sessionHandle || revision !== state.current.tokenRevision || key !== state.current.serverKey) {
        return { ok: false, code: 'STALE_SERVER_SESSION' };
      }
      const valid = purpose === 'api' ? state.current.authenticated && token === state.current.accessToken
        : purpose === 'login' ? !state.current.authenticated && token === ''
          : purpose === 'restore' ? !state.current.authenticated && token !== '' && token === state.current.restorationToken
            : purpose === 'public-status' && token === '';
      if (!valid) return { ok: false, code: 'INVALID_REQUEST_PURPOSE' };
      const requestId = `v2-request-${++sequence}`;
      tickets.set(requestId, { connection: { ...state.current }, token: String(token), purpose: String(purpose) });
      const result = { ok: true, requestId };
      return state.reserve ? state.reserve(result) : result;
    }
    if (method === 'FrontendBridge.ServerRequest') {
      const [id, methodName, path, headers] = args;
      const ticket = tickets.get(String(id)); tickets.delete(String(id));
      if (!ticket || state.current.switching || ticket.connection.sessionHandle !== state.current.sessionHandle
        || ticket.connection.tokenRevision !== state.current.tokenRevision || ticket.connection.serverKey !== state.current.serverKey) {
        throw new DOMException('Stale native reservation', 'AbortError');
      }
      if (ticket.purpose === 'login') assert.deepEqual([methodName, path], ['POST', '/api/auth/login']);
      if (ticket.purpose === 'restore') assert.deepEqual([methodName, path], ['GET', '/api/auth/user']);
      if (ticket.purpose === 'public-status') assert.deepEqual([methodName, path], ['GET', '/api/auth/status']);
      assert.equal(Object.keys(headers as object).some(name => name.toLowerCase() === 'authorization'), false);
      state.forwarded.push({ target: ticket.connection.serverKey, token: ticket.token, path: String(path), purpose: ticket.purpose });
      return state.respond ? state.respond(ticket, String(path)) : reply();
    }
    if (method === 'FrontendBridge.CancelServerRequest') { tickets.delete(String(args[0])); return; }
    if (method === 'FrontendBridge.EndServerSessionV2') {
      const [handle, revision] = args as [string, number];
      assert.ok(handle); assert.ok(revision > 0);
      if (state.end) return state.end(handle, revision);
      if (handle !== state.current.sessionHandle || revision !== state.current.tokenRevision) return { ok: false, code: 'STALE_SERVER_SESSION' };
      state.current = { ...state.current, sessionHandle: `signed-out-${state.current.generation + 1}`,
        generation: state.current.generation + 1, version: state.current.generation + 1,
        tokenRevision: 1, authenticated: false, accessToken: '', restorationToken: '' };
      return { ok: true, connection: { ...state.current } };
    }
    if (method === 'FrontendBridge.ConnectServer') {
      tickets.clear();
      state.current = connection('b', state.current.generation + 1, false);
      return { ok: true, changed: true, connection: { ...state.current } };
    }
    throw new Error(`Unexpected native method: ${method}`);
  });
  return state;
}
async function bootstrap(acknowledge = true) {
  const auth = await import('@/shared/authToken');
  await auth.initializeAuthSession();
  const chisa = await import('@/shared/chisa');
  await chisa.FrontendBridge.getApiConnection();
  if (acknowledge) auth.acknowledgeAuthSession(auth.getAuthSessionSnapshot());
  const api = await import('@/shared/api');
  return { auth, ...chisa, ...api };
}
function assertNoLegacy() {
  assert.ok(!native.call.mock.calls.some(([method]) => method === 'FrontendBridge.BeginServerRequest' || method === 'FrontendBridge.EndServerSession'));
}

beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks();
  vi.stubGlobal('mygo', {});
  localStorage.clear(); sessionStorage.clear();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

test('native authenticated token is authoritative and exact reservation arguments exclude a legacy stored token', async () => {
  const state = peer();
  localStorage.setItem('auth-token', 'legacy.payload.signature');
  const { auth, authenticatedFetch } = await bootstrap();
  await authenticatedFetch('/api/projects', { headers: { Authorization: 'Bearer legacy.payload.signature' } });
  assert.equal(auth.getAuthSessionSnapshot().token, state.current.accessToken);
  assert.deepEqual(native.call.mock.calls.find(([method]) => method === 'FrontendBridge.BeginServerRequestV2'),
    ['FrontendBridge.BeginServerRequestV2', state.current.sessionHandle, state.current.accessToken, 1, 'api', state.current.serverKey]);
  assert.deepEqual(state.forwarded, [{ target: 'server-a', token: 'accounta.payload.signature', path: '/api/projects', purpose: 'api' }]);
  assertNoLegacy();
});

test('a legacy native snapshot fails closed without zero-argument fallback', async () => {
  native.call.mockResolvedValue({ configured: true, version: 1, webSocketUrl: 'ws://127.0.0.1/legacy' });
  const { authenticatedFetch } = await import('@/shared/api');
  await assert.rejects(authenticatedFetch('/api/projects'), /协议需要升级/);
  assert.ok(!native.call.mock.calls.some(([method]) => /BeginServerRequest|ServerRequest$/.test(method)));
  assertNoLegacy();
});

test('a rejected v2 reservation never falls back to legacy or dispatches HTTP', async () => {
  const state = peer();
  state.reserve = async () => ({ ok: false, code: 'STALE_SERVER_SESSION' });
  const { authenticatedFetch } = await bootstrap();
  await assert.rejects(authenticatedFetch('/api/projects'), /会话已改变/);
  assert.equal(state.forwarded.length, 0);
  assert.ok(!native.call.mock.calls.some(([method]) => method === 'FrontendBridge.ServerRequest'));
  assertNoLegacy();
});

test('a late lookup of B cannot upgrade an already captured A operation into B', async () => {
  const state = peer();
  const { authenticatedFetch } = await bootstrap();
  const lookup = deferred<ChisaApiConnection>();
  state.lookup = () => lookup.promise;
  const pending = authenticatedFetch('/api/projects', { method: 'POST', body: '{}' });
  await vi.waitFor(() => assert.equal(native.call.mock.calls.filter(([method]) => method === 'FrontendBridge.GetApiConnection').length, 2));
  state.current = connection('b', 2);
  lookup.resolve(state.current);
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(state.forwarded.length, 0, 'B never receives A bearer or an implicit B operation from A UI');
  assert.ok(!native.call.mock.calls.some(([method]) => method === 'FrontendBridge.BeginServerRequestV2'));
});

test('native target replacement after reservation cannot rebind the old ticket or replay its write', async () => {
  const state = peer();
  const { authenticatedFetch } = await bootstrap();
  state.reserve = async result => {
    // Hold the renderer before the reservation return while native has already committed B.
    state.current = connection('b', 2);
    return result;
  };
  await assert.rejects(authenticatedFetch('/api/projects', { method: 'POST', body: '{"name":"from-a"}' }), { name: 'AbortError' });
  assert.deepEqual(native.call.mock.calls.filter(([method]) => method === 'FrontendBridge.BeginServerRequestV2').map(call => call.slice(1)),
    [['session-a-1', 'accounta.payload.signature', 1, 'api', 'server-a']]);
  assert.equal(native.call.mock.calls.filter(([method]) => method === 'FrontendBridge.ServerRequest').length, 1);
  assert.equal(state.forwarded.length, 0, 'the revoked ticket never routes A bearer to the current B target');
  assertNoLegacy();
});

test('multiple simultaneous lookups cannot roll a committed generation back', async () => {
  const state = peer();
  const { FrontendBridge, desktopWebSocketUrl, auth } = await bootstrap();
  const older = deferred<ChisaApiConnection>();
  const newer = deferred<ChisaApiConnection>();
  let calls = 0;
  state.lookup = () => ++calls === 1 ? older.promise : newer.promise;
  const first = FrontendBridge.getApiConnection();
  const second = FrontendBridge.getApiConnection();
  state.current = connection('b', 2);
  newer.resolve(state.current); await second;
  older.resolve(connection());
  await assert.rejects(first, { name: 'AbortError' });
  assert.equal(auth.getAuthSessionSnapshot().nativeHandle, state.current.sessionHandle);
  assert.equal(desktopWebSocketUrl('/ws', state.current.accessToken), `${state.current.webSocketUrl}/ws`);
});

test('multiple same-session lookups cannot roll a refreshed token revision back', async () => {
  const state = peer();
  const { FrontendBridge, auth } = await bootstrap();
  const old = deferred<ChisaApiConnection>();
  const next = deferred<ChisaApiConnection>();
  let lookups = 0;
  state.lookup = () => ++lookups === 1 ? old.promise : next.promise;
  const one = FrontendBridge.getApiConnection(); const two = FrontendBridge.getApiConnection();
  state.current = { ...state.current, tokenRevision: 2, accessToken: 'refreshed.payload.signature' };
  next.resolve(state.current); await two;
  old.resolve(connection());
  await assert.rejects(one, { name: 'AbortError' });
  assert.equal(auth.getAuthSessionSnapshot().token, state.current.accessToken);
  assert.equal(auth.getAuthSessionSnapshot().tokenRevision, 2);
});

test.each(['login', 'restore'] as const)('a normal %s accepts its exact predecessor handoff and enables the rendered replacement', async purpose => {
  const initial = connection('a', 1, false);
  if (purpose === 'restore') initial.restorationToken = 'persisted.payload.signature';
  const state = peer(initial);
  const replacement = connection('a', 2);
  state.respond = async (ticket, path) => {
    if (path === '/api/projects') return reply({ ok: true });
    assert.equal(ticket.purpose, purpose);
    state.current = replacement;
    return { ...reply({ token: replacement.accessToken, user: { id: 1, username: 'a' } }), sessionTransition: {
      previousSessionHandle: initial.sessionHandle, previousTokenRevision: 1, connection: replacement,
    } };
  };
  const { api, auth, authenticatedFetch, getResponseAuthSession } = await bootstrap(false);
  const response = purpose === 'login' ? await api.auth.login('a', 'test-password') : await api.auth.user();
  assert.equal(response.status, 200);
  assert.deepEqual(native.call.mock.calls.find(([method]) => method === 'FrontendBridge.BeginServerRequestV2')?.slice(1),
    [initial.sessionHandle, purpose === 'restore' ? initial.restorationToken : '', 1, purpose, initial.serverKey]);
  assert.equal(getResponseAuthSession(response)?.nativeHandle, replacement.sessionHandle);
  assert.equal(auth.getAuthSessionSnapshot().token, replacement.accessToken);
  await assert.rejects(authenticatedFetch('/api/projects'), { name: 'AbortError' }, 'unrendered replacement is not usable by old UI');
  auth.acknowledgeAuthSession(auth.getAuthSessionSnapshot());
  assert.equal((await authenticatedFetch('/api/projects')).status, 200);
  assert.equal(state.forwarded.at(-1)?.token, replacement.accessToken);
  assertNoLegacy();
});

test('unbound renderer legacy token is never treated as native restoration authority', async () => {
  const state = peer(connection('b', 1, false));
  localStorage.setItem('auth-token', 'accounta.payload.signature');
  const { api } = await bootstrap(false);
  await assert.rejects(api.auth.user(), /会话已改变/);
  assert.equal(state.forwarded.length, 0);
  const reserved = native.call.mock.calls.find(([method]) => method === 'FrontendBridge.BeginServerRequestV2');
  assert.deepEqual(reserved?.slice(1), [state.current.sessionHandle, '', 1, 'api', 'server-b']);
});

test('a public auth status reservation has exact identity and an empty token', async () => {
  const state = peer();
  const { api } = await bootstrap();
  await api.auth.status();
  assert.deepEqual(native.call.mock.calls.find(([method]) => method === 'FrontendBridge.BeginServerRequestV2')?.slice(1),
    [state.current.sessionHandle, '', 1, 'public-status', state.current.serverKey]);
  assert.equal(state.forwarded[0].token, '');
});

test('a handoff with a mismatched predecessor is rejected before adopting any replacement', async () => {
  const state = peer(connection('a', 1, false));
  state.respond = async () => ({ ...reply({ token: 'foreign.payload.signature' }), sessionTransition: {
    previousSessionHandle: 'unrelated-predecessor', previousTokenRevision: 1, connection: connection('b', 2),
  } });
  const { api, auth } = await bootstrap(false);
  await assert.rejects(api.auth.login('a', 'test-password'), { name: 'AbortError' });
  assert.equal(auth.getAuthSessionSnapshot().nativeHandle, state.current.sessionHandle);
  assert.equal(auth.getAuthSessionSnapshot().token, null);
});

test('a refreshed header without native transition cannot overwrite native authority', async () => {
  const state = peer();
  state.respond = async () => ({ ...reply(), headers: { 'X-Refreshed-Token': 'forged.payload.signature' } });
  const { auth, authenticatedFetch } = await bootstrap();
  await authenticatedFetch('/api/projects');
  assert.equal(auth.getAuthSessionSnapshot().token, state.current.accessToken);
  assert.equal(auth.getAuthSessionSnapshot().tokenRevision, 1);
});

test('logout uses the auth committed handle even when the chisa URL cache is empty', async () => {
  const state = peer();
  const auth = await import('@/shared/authToken');
  await auth.initializeAuthSession();
  auth.observeNativeAuthSession({ sessionInstanceId: state.current.sessionHandle, nativeHandle: state.current.sessionHandle,
    nativeGeneration: state.current.generation, tokenRevision: 1, serverKey: state.current.serverKey,
    token: state.current.accessToken, userId: '1', phase: 'ready', storageMode: 'window' });
  auth.acknowledgeAuthSession(auth.getAuthSessionSnapshot());
  const { FrontendBridge } = await import('@/shared/chisa');
  await FrontendBridge.endServerSession();
  assert.deepEqual(native.call.mock.calls[0], ['FrontendBridge.EndServerSessionV2', 'session-a-1', 1]);
  assert.equal(auth.getAuthSessionSnapshot().phase, 'signedOut');
  assert.notEqual(auth.getAuthSessionSnapshot().nativeHandle, 'session-a-1');
  assertNoLegacy();
});

test('a late old logout cannot revoke or publish over a newer login', async () => {
  const state = peer();
  const { FrontendBridge, auth } = await bootstrap();
  const end = deferred<unknown>();
  state.end = () => end.promise;
  const pending = FrontendBridge.endServerSession();
  await vi.waitFor(() => assert.ok(native.call.mock.calls.some(([method]) => method === 'FrontendBridge.EndServerSessionV2')));
  state.current = connection('b', 2);
  await assert.rejects(FrontendBridge.getApiConnection(), { name: 'AbortError' }, 'lookup cannot bypass the active logout admission gate');
  // A trusted native authority notification can report another window's completed login even while this revoke is pending.
  auth.observeNativeAuthSession({ sessionInstanceId: state.current.sessionHandle, nativeHandle: state.current.sessionHandle,
    nativeGeneration: state.current.generation, tokenRevision: state.current.tokenRevision,
    serverKey: state.current.serverKey, token: state.current.accessToken, userId: '2', phase: 'ready', storageMode: 'window' });
  end.resolve({ ok: false, code: 'STALE_SERVER_SESSION' });
  await assert.rejects(pending, /未能安全关闭/);
  assert.equal(auth.getAuthSessionSnapshot().nativeHandle, state.current.sessionHandle);
  assert.equal(auth.getAuthSessionSnapshot().token, state.current.accessToken);
  assert.equal(state.current.authenticated, true, 'the stale revoke did not end the native replacement');
  const ends = native.call.mock.calls.filter(([method]) => method === 'FrontendBridge.EndServerSessionV2');
  assert.deepEqual(ends.map(call => call.slice(1)), [['session-a-1', 1]]);
});

test('logout may retry an unsent stale revision only for the same handle', async () => {
  const state = peer();
  const { FrontendBridge } = await bootstrap();
  state.current = { ...state.current, tokenRevision: 2, accessToken: 'rotated.payload.signature' };
  await FrontendBridge.endServerSession();
  assert.deepEqual(native.call.mock.calls.filter(([method]) => method === 'FrontendBridge.EndServerSessionV2').map(call => call.slice(1)),
    [['session-a-1', 1], ['session-a-1', 2]]);
  assertNoLegacy();
});

test('concurrent token refresh keeps native capability and target while changing only revision', async () => {
  const state = peer();
  const { FrontendBridge, desktopWebSocketUrl, desktopHttpUrl, auth } = await bootstrap();
  const capability = desktopWebSocketUrl('/ws', state.current.accessToken);
  const handle = state.current.sessionHandle;
  state.current = { ...state.current, accessToken: 'rotated.payload.signature', tokenRevision: 2 };
  await FrontendBridge.getApiConnection();
  assert.equal(state.current.sessionHandle, handle);
  assert.equal(desktopWebSocketUrl('/ws', state.current.accessToken), capability);
  assert.equal(desktopHttpUrl('/api/files?token=obsolete.payload.signature&path=test'), `${state.current.httpProxyUrl}/api/files?path=test`);
  assert.throws(() => desktopWebSocketUrl('/ws', 'accounta.payload.signature'), /尚未初始化|会话已改变/);
  assert.equal(auth.getAuthSessionSnapshot().tokenRevision, 2);
});

test('a revoked native capability cannot choose a replacement target or forward an A bearer to B', async () => {
  const state = peer();
  const { FrontendBridge, desktopWebSocketUrl } = await bootstrap();
  const oldURL = desktopWebSocketUrl('/ws', state.current.accessToken);
  const oldToken = state.current.accessToken;
  await FrontendBridge.connectServer('https://b.example');
  state.current = connection('b', 3);
  await FrontendBridge.getApiConnection();
  assert.notEqual(desktopWebSocketUrl('/ws', state.current.accessToken), oldURL);
  assert.throws(() => desktopWebSocketUrl('/ws', oldToken), /尚未初始化|会话已改变/);
  // Model the proxy peer: look up immutable capability first, then check revocation; never choose global current as target.
  const admit = (url: string, callerToken: string) => {
    const bound = state.capabilities.get(url.replace(/\/ws$/, ''));
    if (!bound || bound.sessionHandle !== state.current.sessionHandle) return null;
    return { target: bound.serverKey, token: bound.accessToken, ignoredCallerToken: callerToken };
  };
  assert.equal(admit(oldURL, state.current.accessToken), null);
  assert.equal(admit(oldURL, oldToken), null);
  assert.equal(state.forwarded.filter(entry => entry.target === 'server-b' && entry.token === oldToken).length, 0);
});

test.each(['login', 'restore'] as const)('real AuthProvider verifies and renders a normal native %s handoff', async purpose => {
  const initial = connection('a', 1, false);
  if (purpose === 'restore') initial.restorationToken = 'persisted.payload.signature';
  const state = peer(initial);
  state.respond = async (ticket, path) => {
    if (ticket.purpose === purpose && (path === '/api/auth/login' || path === '/api/auth/user')) {
      const predecessor = { ...state.current };
      state.current = connection('a', 2);
      return { ...reply({ token: state.current.accessToken, user: { id: 1, username: 'a' } }), sessionTransition: {
        previousSessionHandle: predecessor.sessionHandle, previousTokenRevision: predecessor.tokenRevision, connection: { ...state.current },
      } };
    }
    if (path === '/api/auth/user') return reply({ user: { id: 1, username: 'a' } });
    if (path === '/api/user/onboarding-status') return reply({ hasCompletedOnboarding: true });
    return reply({ ok: true });
  };
  const auth = await import('@/shared/authToken');
  await auth.initializeAuthSession();
  const { AuthProvider, useAuth } = await import('@/modules/auth');
  let value!: ReturnType<typeof useAuth>;
  function Consumer() {
    const context = useAuth();
    useLayoutEffect(() => { value = context; }, [context]);
    return createElement('span', null, context.user?.username ?? 'signed-out');
  }
  const view = render(createElement(AuthProvider, null, createElement(Consumer)));
  if (purpose === 'login') {
    await waitFor(() => assert.equal(value.isLoading, false));
    await act(async () => { assert.deepEqual(await value.login('a', 'test-password'), { success: true }); });
  }
  await waitFor(() => assert.equal(view.getByText('a').textContent, 'a'));
  await waitFor(() => assert.equal(value.isLoading, false));
  assert.equal(auth.getAuthSessionSnapshot().nativeHandle, 'session-a-2');
  const { authenticatedFetch } = await import('@/shared/api');
  assert.equal((await authenticatedFetch('/api/projects')).status, 200, 'rendered AuthProvider acknowledged the new session');
  assertNoLegacy();
});
