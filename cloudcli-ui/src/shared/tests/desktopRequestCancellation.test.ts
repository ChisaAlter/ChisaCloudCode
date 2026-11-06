import assert from 'node:assert/strict';

import { afterEach, beforeEach, test, vi } from 'vitest';

import type { BridgeResponse, ChisaApiConnection, ChisaRequestReservation, WorkspaceDescriptor } from '@/shared/types';

const native = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('mygo-runtime', () => ({ call: native.call }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

const reply: BridgeResponse = { status: 200, headers: { 'Content-Type': 'application/json' }, bodyB64: btoa('{}') };
function connection(account = 'a', generation = 1): ChisaApiConnection {
  return {
    protocolVersion: 2, configured: true, sessionHandle: `session-${account}-${generation}`,
    serverKey: `server-${account}`, generation, version: generation, tokenRevision: 1,
    authenticated: true, accessToken: `account${account}.payload.signature`, restorationToken: '', switching: false,
    loginUrl: `https://${account}.example`, apiUrl: `https://${account}.example`,
    httpProxyUrl: `http://127.0.0.1:18792/channel/cap-${account}-${generation}`,
    webSocketUrl: `ws://127.0.0.1:18792/channel/cap-${account}-${generation}`,
  };
}

type Ticket = { connection: ChisaApiConnection; token: string; purpose: string };

// This is an identity-enforcing v2 peer, not an unconditional successful reservation stub.
function mockNative(initial = connection()) {
  const tickets = new Map<string, Ticket>();
  const state = {
    current: initial,
    lookup: null as null | (() => Promise<ChisaApiConnection>),
    reservation: null as null | ((result: ChisaRequestReservation) => Promise<ChisaRequestReservation>),
    response: null as null | ((ticket: Ticket) => Promise<BridgeResponse>),
    forwarded: [] as Array<{ target: string; token: string; purpose: string; path: string }>,
  };
  let nextRequest = 0;
  native.call.mockImplementation(async (method: string, ...args: unknown[]) => {
    if (method === 'FrontendBridge.GetApiConnection') return state.lookup ? state.lookup() : { ...state.current };
    if (method === 'FrontendBridge.BeginServerRequest') throw new Error('Legacy zero-argument reservation is forbidden');
    if (method === 'FrontendBridge.BeginServerRequestV2') {
      const [handle, token, revision, purpose, serverKey] = args;
      assert.equal(args.length, 5, 'v2 must pass the complete immutable reservation binding');
      if (state.current.switching) return { ok: false, code: 'SERVER_SWITCH_IN_PROGRESS' };
      if (handle !== state.current.sessionHandle || revision !== state.current.tokenRevision || serverKey !== state.current.serverKey) {
        return { ok: false, code: 'STALE_SERVER_SESSION' };
      }
      if (purpose === 'api' && (!state.current.authenticated || token !== state.current.accessToken)) {
        return { ok: false, code: 'SESSION_NOT_AUTHENTICATED' };
      }
      if (purpose === 'public-status' && token !== '') return { ok: false, code: 'INVALID_REQUEST_PURPOSE' };
      if (!['api', 'public-status'].includes(String(purpose))) return { ok: false, code: 'INVALID_REQUEST_PURPOSE' };
      const requestId = `request-${++nextRequest}`;
      tickets.set(requestId, { connection: { ...state.current }, token: String(token), purpose: String(purpose) });
      const result = { ok: true, requestId };
      return state.reservation ? state.reservation(result) : result;
    }
    if (method === 'FrontendBridge.CancelServerRequest') { tickets.delete(String(args[0])); return; }
    if (method === 'FrontendBridge.ServerRequest') {
      const [requestId, verb, path] = args;
      const ticket = tickets.get(String(requestId));
      tickets.delete(String(requestId));
      if (!ticket || ticket.connection.sessionHandle !== state.current.sessionHandle
        || ticket.connection.tokenRevision !== state.current.tokenRevision || state.current.switching) {
        throw new DOMException('Native reservation no longer owns this connection', 'AbortError');
      }
      if (ticket.purpose === 'public-status') assert.deepEqual([verb, path], ['GET', '/api/auth/status']);
      state.forwarded.push({ target: ticket.connection.serverKey, token: ticket.token, purpose: ticket.purpose, path: String(path) });
      return state.response ? state.response(ticket) : reply;
    }
    if (method === 'FrontendBridge.ConnectServer') {
      tickets.clear();
      state.current = { ...connection('b', state.current.generation + 1), authenticated: false, accessToken: '' };
      return { ok: true, changed: true, connection: { ...state.current } };
    }
    throw new Error(`Unexpected native method: ${method}`);
  });
  return state;
}

async function initializeNative() {
  const auth = await import('@/shared/authToken');
  await auth.initializeAuthSession();
  const { FrontendBridge } = await import('@/shared/chisa');
  await FrontendBridge.getApiConnection();
  // These transport tests model the already verified/rendered AuthProvider boundary.
  auth.acknowledgeAuthSession(auth.getAuthSessionSnapshot());
  return { auth, FrontendBridge };
}

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.stubGlobal('mygo', {});
  localStorage.clear();
  sessionStorage.clear();
  mockNative();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

test('an already aborted desktop request never enters the native bridge', async () => {
  const { authenticatedFetch } = await import('@/shared/api');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(authenticatedFetch('/api/projects', { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(native.call.mock.calls.length, 0);
});

test('abort during reservation cancels the v2 ticket without forwarding HTTP', async () => {
  const state = mockNative();
  const reserved = deferred<ChisaRequestReservation>();
  state.reservation = () => reserved.promise;
  await initializeNative();
  const { authenticatedFetch } = await import('@/shared/api');
  const controller = new AbortController();
  const request = authenticatedFetch('/api/projects', { signal: controller.signal });
  await vi.waitFor(() => assert.ok(native.call.mock.calls.some(([method]) => method === 'FrontendBridge.BeginServerRequestV2')));
  assert.deepEqual(native.call.mock.calls.find(([method]) => method === 'FrontendBridge.BeginServerRequestV2'),
    ['FrontendBridge.BeginServerRequestV2', state.current.sessionHandle, state.current.accessToken, 1, 'api', state.current.serverKey]);
  controller.abort(); reserved.resolve({ ok: true, requestId: 'request-1' });
  await assert.rejects(request, { name: 'AbortError' });
  await vi.waitFor(() => assert.ok(native.call.mock.calls.some(([method, id]) => method === 'FrontendBridge.CancelServerRequest' && id === 'request-1')));
  assert.equal(state.forwarded.length, 0);
});

test('in-flight abort rejects immediately and late auth headers cannot change the session', async () => {
  const state = mockNative();
  const upstream = deferred<BridgeResponse>();
  state.response = () => upstream.promise;
  const { auth } = await initializeNative();
  const { authenticatedFetch } = await import('@/shared/api');
  const before = auth.getAuthSessionSnapshot();
  const controller = new AbortController();
  const request = authenticatedFetch('/api/projects', { signal: controller.signal });
  await vi.waitFor(() => assert.equal(state.forwarded.length, 1));
  controller.abort();
  await assert.rejects(request, { name: 'AbortError' });
  upstream.resolve({ ...reply, headers: { 'X-Refreshed-Token': 'rotated.payload.signature', 'X-Auth-Error': 'expired' },
    sessionTransition: { previousSessionHandle: state.current.sessionHandle, previousTokenRevision: 1,
      connection: { ...state.current, accessToken: 'rotated.payload.signature', tokenRevision: 2 } } });
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(auth.getAuthSessionSnapshot(), before);
  assert.ok(native.call.mock.calls.some(([method, id]) => method === 'FrontendBridge.CancelServerRequest' && id === 'request-1'));
});

test('a replaced connection discards its old reply before processing auth headers or handoff', async () => {
  const state = mockNative();
  const predecessor = state.current;
  const upstream = deferred<BridgeResponse>();
  state.response = () => upstream.promise;
  const { auth, FrontendBridge } = await initializeNative();
  const { authenticatedFetch } = await import('@/shared/api');
  const request = authenticatedFetch('/api/projects');
  await vi.waitFor(() => assert.equal(state.forwarded.length, 1));
  await FrontendBridge.connectServer('https://b.example');
  state.current = connection('b', 3);
  await FrontendBridge.getApiConnection();
  auth.acknowledgeAuthSession(auth.getAuthSessionSnapshot());
  upstream.resolve({ ...reply, headers: { 'X-Refreshed-Token': 'old.payload.signature' },
    sessionTransition: { previousSessionHandle: predecessor.sessionHandle, previousTokenRevision: 1,
      connection: { ...predecessor, accessToken: 'old.payload.signature', tokenRevision: 2 } } });
  await assert.rejects(request, { name: 'AbortError' });
  assert.equal(auth.getAuthSessionSnapshot().token, state.current.accessToken);
  assert.equal(auth.getAuthSessionSnapshot().serverKey, 'server-b');
});

test('switching service during GetApiConnection cannot reserve or send A bearer to B', async () => {
  const state = mockNative();
  const { FrontendBridge } = await initializeNative();
  const previous = { ...state.current };
  const lookup = deferred<ChisaApiConnection>();
  state.lookup = () => lookup.promise;
  native.call.mockClear();
  const { authenticatedFetch } = await import('@/shared/api');
  const request = authenticatedFetch('/api/projects');
  await vi.waitFor(() => assert.ok(native.call.mock.calls.some(([method]) => method === 'FrontendBridge.GetApiConnection')));
  await FrontendBridge.connectServer('https://b.example');
  lookup.resolve(previous);
  await assert.rejects(request, { name: 'AbortError' });
  assert.ok(!native.call.mock.calls.some(([method]) => method === 'FrontendBridge.BeginServerRequestV2'));
  assert.equal(state.forwarded.length, 0);
  const { desktopWebSocketUrl } = await import('@/shared/chisa');
  assert.throws(() => desktopWebSocketUrl('/ws', previous.accessToken), /尚未初始化|会话已改变/);
});

test('a deadline releases a hung native connection lookup before a ticket can be reserved', async () => {
  const state = mockNative();
  await initializeNative();
  const lookup = deferred<ChisaApiConnection>();
  state.lookup = () => lookup.promise;
  native.call.mockClear();
  const { authenticatedFetch } = await import('@/shared/api');
  const controller = new AbortController();
  const request = authenticatedFetch('/api/auth/user', { signal: controller.signal });
  const rejected = assert.rejects(request, { name: 'TimeoutError' });
  await vi.waitFor(() => assert.ok(native.call.mock.calls.some(([method]) => method === 'FrontendBridge.GetApiConnection')));
  controller.abort(new DOMException('Timed out', 'TimeoutError'));
  await rejected;
  assert.ok(!native.call.mock.calls.some(([method]) => method === 'FrontendBridge.BeginServerRequestV2'));
  lookup.resolve(state.current);
});

test('a canceled hanging reservation releases its caller and cancels the eventual v2 ticket', async () => {
  const state = mockNative();
  const reserved = deferred<ChisaRequestReservation>();
  state.reservation = () => reserved.promise;
  await initializeNative();
  const { authenticatedFetch } = await import('@/shared/api');
  const controller = new AbortController();
  const request = authenticatedFetch('/api/auth/user', { signal: controller.signal });
  await vi.waitFor(() => assert.ok(native.call.mock.calls.some(([method]) => method === 'FrontendBridge.BeginServerRequestV2')));
  controller.abort(new DOMException('Timed out', 'TimeoutError'));
  await assert.rejects(request, { name: 'TimeoutError' });
  reserved.resolve({ ok: true, requestId: 'request-1' });
  await vi.waitFor(() => assert.ok(native.call.mock.calls.some(([method, id]) => method === 'FrontendBridge.CancelServerRequest' && id === 'request-1')));
  assert.equal(state.forwarded.length, 0);
});

test('an older native connection lookup cannot overwrite the current WebSocket capability', async () => {
  const state = mockNative();
  const previous = { ...state.current };
  const old = deferred<ChisaApiConnection>();
  state.lookup = () => old.promise;
  const { FrontendBridge, desktopWebSocketUrl } = await import('@/shared/chisa');
  const pending = FrontendBridge.getApiConnection();
  await FrontendBridge.connectServer('https://b.example');
  state.current = connection('b', 3);
  state.lookup = null;
  await FrontendBridge.getApiConnection();
  old.resolve(previous);
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(desktopWebSocketUrl('/ws', state.current.accessToken), `${state.current.webSocketUrl}/ws`);
  assert.equal(new URL(desktopWebSocketUrl('/ws', state.current.accessToken)).searchParams.has('token'), false);
});

test('account change during reservation cancels the ticket before forwarding', async () => {
  const state = mockNative();
  const reserved = deferred<ChisaRequestReservation>();
  state.reservation = () => reserved.promise;
  const { auth, FrontendBridge } = await initializeNative();
  const { authenticatedFetch } = await import('@/shared/api');
  const request = authenticatedFetch('/api/projects');
  await vi.waitFor(() => assert.ok(native.call.mock.calls.some(([method]) => method === 'FrontendBridge.BeginServerRequestV2')));
  state.current = connection('b', 2);
  await FrontendBridge.getApiConnection();
  auth.acknowledgeAuthSession(auth.getAuthSessionSnapshot());
  reserved.resolve({ ok: true, requestId: 'request-1' });
  await assert.rejects(request, { name: 'AbortError' });
  await vi.waitFor(() => assert.ok(native.call.mock.calls.some(([method, id]) => method === 'FrontendBridge.CancelServerRequest' && id === 'request-1')));
  assert.equal(state.forwarded.length, 0);
});

test('a normal request forwards UTF-8 body and accepts only its native refreshed-token transition', async () => {
  const state = mockNative();
  const predecessor = { ...state.current };
  state.response = async () => {
    state.current = { ...state.current, accessToken: 'new.payload.signature', tokenRevision: 2 };
    return { ...reply, headers: { 'X-Refreshed-Token': state.current.accessToken }, sessionTransition: {
      previousSessionHandle: predecessor.sessionHandle, previousTokenRevision: predecessor.tokenRevision, connection: state.current,
    } };
  };
  const { auth } = await initializeNative();
  const { authenticatedFetch } = await import('@/shared/api');
  const response = await authenticatedFetch('/api/projects', { method: 'POST', body: '{"name":"测试"}', headers: { Authorization: 'Bearer arbitrary.payload.signature' } });
  assert.equal(response.status, 200);
  const sent = native.call.mock.calls.find(([method]) => method === 'FrontendBridge.ServerRequest')!;
  assert.deepEqual(sent.slice(1, 4), ['request-1', 'POST', '/api/projects']);
  assert.equal(new TextDecoder().decode(Uint8Array.from(atob(sent[5]), char => char.charCodeAt(0))), '{"name":"测试"}');
  assert.equal(Object.keys(sent[4]).some(key => key.toLowerCase() === 'authorization'), false);
  assert.deepEqual(state.forwarded.map(({ target, token }) => ({ target, token })), [{ target: 'server-a', token: predecessor.accessToken }]);
  assert.equal(auth.getAuthSessionSnapshot().token, 'new.payload.signature');
  assert.equal(auth.getAuthSessionSnapshot().tokenRevision, 2);
});

test('body encoding interrupted by a target change cannot reserve or send A credentials to B', async () => {
  const state = mockNative();
  const { FrontendBridge } = await initializeNative();
  const bytes = deferred<ArrayBuffer>();
  const body = new Blob([], { type: 'application/octet-stream' });
  const encode = vi.fn(() => bytes.promise);
  Object.defineProperty(body, 'arrayBuffer', { value: encode });
  const { authenticatedFetch } = await import('@/shared/api');
  const request = authenticatedFetch('/api/assets/files', { method: 'POST', body });
  await vi.waitFor(() => assert.equal(encode.mock.calls.length, 1));
  await FrontendBridge.connectServer('https://b.example');
  bytes.resolve(new Uint8Array([1, 2, 3]).buffer);
  await assert.rejects(request, { name: 'AbortError' });
  assert.ok(!native.call.mock.calls.some(([method]) => method === 'FrontendBridge.BeginServerRequestV2'));
  assert.equal(state.forwarded.length, 0);
});

test('abort during body encoding releases the caller without reserving or dispatching', async () => {
  const state = mockNative();
  await initializeNative();
  const bytes = deferred<ArrayBuffer>();
  const body = new Blob([], { type: 'application/octet-stream' });
  const encode = vi.fn(() => bytes.promise);
  Object.defineProperty(body, 'arrayBuffer', { value: encode });
  const controller = new AbortController();
  const { authenticatedFetch } = await import('@/shared/api');
  const request = authenticatedFetch('/api/assets/files', { method: 'POST', body, signal: controller.signal });
  await vi.waitFor(() => assert.equal(encode.mock.calls.length, 1));
  controller.abort();
  await assert.rejects(request, { name: 'AbortError' });
  bytes.resolve(new Uint8Array([1, 2, 3]).buffer);
  await Promise.resolve(); await Promise.resolve();
  assert.ok(!native.call.mock.calls.some(([method]) => method === 'FrontendBridge.BeginServerRequestV2'));
  assert.equal(state.forwarded.length, 0);
});

test('desktop files and Git use only the bound cloud HTTP capability and preserve workspace identity', async () => {
  const state = mockNative();
  await initializeNative();
  const { createWorkspaceApi } = await import('@/shared/api');
  const workspace: WorkspaceDescriptor = {
    projectId: 'cloud-project', workspaceId: 'session:cloud-session', generation: 'cloud-generation', kind: 'session', sessionId: 'cloud-session',
    rootPath: '/cloud/session', sourceRoot: '/cloud/project', requestedMode: 'isolated', effectiveMode: 'isolated', phase: 'idle', publicationState: 'unpublished',
    capabilities: { read: true, write: true, git: true, shell: true, preview: true, integrate: true, cloudExecutionIndependentOfDesktop: true },
  };
  const api = createWorkspaceApi(workspace);
  await api.getFiles(workspace.projectId);
  await api.saveFile(workspace.projectId, 'main.ts', 'cloud edit', 'hash');
  await api.git.status(workspace.projectId);
  const methods = new Set(native.call.mock.calls.map(([method]) => method));
  assert.deepEqual(methods, new Set(['FrontendBridge.GetApiConnection', 'FrontendBridge.BeginServerRequestV2', 'FrontendBridge.ServerRequest']));
  const requests = native.call.mock.calls.filter(([method]) => method === 'FrontendBridge.ServerRequest');
  assert.equal(requests.length, 3);
  for (const request of requests) {
    const url = new URL(request[3], 'https://cloud.example');
    assert.equal(url.searchParams.get('workspaceId'), workspace.workspaceId);
    assert.equal(url.searchParams.get('generation'), workspace.generation);
  }
  const reservations = native.call.mock.calls.filter(([method]) => method === 'FrontendBridge.BeginServerRequestV2');
  for (const reservation of reservations) assert.deepEqual(reservation.slice(1), [state.current.sessionHandle, state.current.accessToken, 1, 'api', state.current.serverKey]);
  assert.equal(JSON.parse(atob(requests[1][5])).content, 'cloud edit');
  assert.equal(api.uploadFilesUrl(workspace.projectId).startsWith(`${state.current.httpProxyUrl}/api/file-tree/`), true);
});

test.each(['user', 'status', 'onboardingStatus'] as const)('safe auth %s GET cancels a hung native response at its deadline', async method => {
  const state = mockNative();
  await initializeNative();
  const signals: AbortSignal[] = [];
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), 15000);
    signals.push(controller.signal);
    return controller.signal;
  });
  const upstream = deferred<BridgeResponse>();
  state.response = () => upstream.promise;
  const { api } = await import('@/shared/api');
  vi.useFakeTimers();
  const request = method === 'onboardingStatus' ? api.user.onboardingStatus() : api.auth[method]();
  const rejected = assert.rejects(request, { name: 'TimeoutError' });
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(state.forwarded.length, 1);
  await vi.advanceTimersByTimeAsync(15000);
  await rejected;
  assert.equal(signals[0].aborted, true);
  assert.ok(native.call.mock.calls.some(([name, id]) => name === 'FrontendBridge.CancelServerRequest' && id === 'request-1'));
});

test('logout invalidates a forwarded native reply before its late headers can overwrite another login', async () => {
  const state = mockNative();
  const upstream = deferred<BridgeResponse>();
  state.response = () => upstream.promise;
  const { auth, FrontendBridge } = await initializeNative();
  const { authenticatedFetch } = await import('@/shared/api');
  const pending = authenticatedFetch('/api/projects');
  await vi.waitFor(() => assert.equal(state.forwarded.length, 1));
  // The native peer has already completed logout plus a fresh login; renderer observes that exact authority.
  state.current = connection('b', 3);
  await FrontendBridge.getApiConnection();
  auth.acknowledgeAuthSession(auth.getAuthSessionSnapshot());
  upstream.resolve({ ...reply, headers: { 'X-Refreshed-Token': 'oldrotated.payload.signature', 'X-Auth-Error': 'expired' } });
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(auth.getAuthSessionSnapshot().token, 'accountb.payload.signature');
  assert.equal(state.forwarded.filter(entry => entry.target === 'server-b' && entry.token === 'accounta.payload.signature').length, 0);
});
