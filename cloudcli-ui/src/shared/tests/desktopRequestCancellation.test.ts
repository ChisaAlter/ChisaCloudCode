import assert from 'node:assert/strict';
import { afterEach, beforeEach, test, vi } from 'vitest';
import type { BridgeResponse, ChisaApiConnection } from '@/shared/types';

const native = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('mygo-runtime', () => ({ call: native.call }));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const reply: BridgeResponse = { status: 200, headers: { 'Content-Type': 'application/json' }, bodyB64: btoa('{}') };
const oldConnection: ChisaApiConnection = { configured: true, version: 1, webSocketUrl: 'ws://127.0.0.1:18792/channel/old' };
const newConnection: ChisaApiConnection = { configured: true, version: 2, webSocketUrl: 'ws://127.0.0.1:18793/channel/new' };
function mockNative(implementation: (method: string) => unknown) {
  native.call.mockImplementation((method: string) => method === 'FrontendBridge.GetApiConnection'
    ? Promise.resolve({ configured: true, version: 1, webSocketUrl: 'ws://127.0.0.1:18792/channel/test' })
    : implementation(method));
}
beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.stubGlobal('mygo', {});
  localStorage.clear();
  mockNative((method: string) => Promise.resolve(method === 'FrontendBridge.BeginServerRequest' ? 'request-id' : undefined));
});
afterEach(() => vi.unstubAllGlobals());

test('business URL builders reject a cached new destination during switching and before the old identity signs out', async () => {
  const connecting = deferred<Record<string, unknown>>();
  let nativeConnection = oldConnection;
  native.call.mockImplementation((method: string) => {
    if (method === 'FrontendBridge.GetApiConnection') return Promise.resolve(nativeConnection);
    if (method === 'FrontendBridge.ConnectServer') return connecting.promise;
    return Promise.resolve();
  });
  const { desktopHttpUrl, desktopWebSocketUrl, FrontendBridge } = await import('@/shared/chisa');
  const { clearAuthToken, startAuthSession } = await import('@/shared/authToken');
  startAuthSession('oldaccount.payload.signature');
  await FrontendBridge.getApiConnection();
  const switching = FrontendBridge.connectServer('https://new-service.example');

  // Native can publish B before its ConnectServer reply reaches the caller.
  // Metadata discovery must not turn this cache into an authorized business URL.
  nativeConnection = newConnection;
  await FrontendBridge.getApiConnection();
  const websocket = () => desktopWebSocketUrl('/plugin-ws/example', 'oldaccount.payload.signature');
  const http = () => desktopHttpUrl('/api/projects/search?token=oldaccount.payload.signature');
  assert.throws(websocket, { name: 'AbortError' });
  assert.throws(http, { name: 'AbortError' });

  connecting.resolve({ ok: true, changed: true });
  await switching;
  assert.equal(localStorage.getItem('auth-token'), 'oldaccount.payload.signature');
  assert.throws(websocket, { name: 'AbortError' });
  assert.throws(http, { name: 'AbortError' });

  clearAuthToken();
  startAuthSession('newaccount.payload.signature');
  assert.equal(desktopWebSocketUrl('/plugin-ws/example', 'newaccount.payload.signature'), newConnection.webSocketUrl + '/plugin-ws/example?token=newaccount.payload.signature');
  assert.equal(desktopHttpUrl('/api/projects/search?token=newaccount.payload.signature'), newConnection.webSocketUrl.replace(/^ws:/, 'http:') + '/api/projects/search?token=newaccount.payload.signature');
  assert.ok(!native.call.mock.calls.some(([method]) => method === 'FrontendBridge.BeginServerRequest' || method === 'FrontendBridge.ServerRequest'));
});

test('an already aborted desktop request never enters the native bridge', async () => {
  const { authenticatedFetch } = await import('@/shared/api');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(authenticatedFetch('/api/projects', { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(native.call.mock.calls.length, 0);
});

test('abort during reservation cancels the ticket without forwarding HTTP', async () => {
  const reserved = deferred<string>();
  mockNative((method: string) => method === 'FrontendBridge.BeginServerRequest' ? reserved.promise : Promise.resolve());
  const { authenticatedFetch } = await import('@/shared/api');
  const controller = new AbortController();
  const request = authenticatedFetch('/api/projects', { signal: controller.signal });
  await vi.waitFor(() => assert.ok(native.call.mock.calls.some(([method]) => method === 'FrontendBridge.BeginServerRequest')));
  controller.abort(); reserved.resolve('request-id');
  await assert.rejects(request, { name: 'AbortError' });
  assert.ok(native.call.mock.calls.some(([method]) => method === 'FrontendBridge.CancelServerRequest'));
  assert.ok(!native.call.mock.calls.some(([method]) => method === 'FrontendBridge.ServerRequest'));
});

test('in-flight abort rejects immediately and late auth headers cannot change the session', async () => {
  const upstream = deferred<typeof reply>();
  mockNative((method: string) => method === 'FrontendBridge.BeginServerRequest' ? Promise.resolve('request-id') : method === 'FrontendBridge.ServerRequest' ? upstream.promise : Promise.resolve());
  const { authenticatedFetch } = await import('@/shared/api');
  localStorage.setItem('auth-token', 'original.payload.signature');
  const controller = new AbortController();
  const request = authenticatedFetch('/api/projects', { signal: controller.signal });
  await vi.waitFor(() => assert.ok(native.call.mock.calls.some(([method]) => method === 'FrontendBridge.ServerRequest')));
  controller.abort();
  await assert.rejects(request, { name: 'AbortError' });
  upstream.resolve({ ...reply, headers: { 'X-Refreshed-Token': 'rotated.payload.signature', 'X-Auth-Error': 'expired' } });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(localStorage.getItem('auth-token'), 'original.payload.signature');
  assert.ok(native.call.mock.calls.some(([method, id]) => method === 'FrontendBridge.CancelServerRequest' && id === 'request-id'));
});

test('a replaced connection discards its old reply before processing auth headers', async () => {
  const upstream = deferred<typeof reply>();
  mockNative((method: string) => method === 'FrontendBridge.BeginServerRequest' ? Promise.resolve('request-id') : method === 'FrontendBridge.ServerRequest' ? upstream.promise : Promise.resolve({ ok: true }));
  const { authenticatedFetch } = await import('@/shared/api');
  const { FrontendBridge } = await import('@/shared/chisa');
  localStorage.setItem('auth-token', 'current.payload.signature');
  const request = authenticatedFetch('/api/projects');
  await vi.waitFor(() => assert.ok(native.call.mock.calls.some(([method]) => method === 'FrontendBridge.ServerRequest')));
  await FrontendBridge.connectServer('http://other.test:8791');
  upstream.resolve({ ...reply, headers: { 'X-Refreshed-Token': 'old.payload.signature' } });
  await assert.rejects(request, { name: 'AbortError' });
  assert.equal(localStorage.getItem('auth-token'), 'current.payload.signature');
});

test.each([
  ['old', oldConnection],
  ['new', newConnection],
] as const)('a request waiting for %s metadata cannot reserve or forward after the service changes', async (_label, metadata) => {
  const pendingMetadata = deferred<ChisaApiConnection>();
  native.call.mockImplementation((method: string) => method === 'FrontendBridge.GetApiConnection'
    ? pendingMetadata.promise : Promise.resolve({ ok: true }));
  const { authenticatedFetch } = await import('@/shared/api');
  const { desktopWebSocketUrl, FrontendBridge } = await import('@/shared/chisa');
  localStorage.setItem('auth-token', 'oldaccount.payload.signature');
  const request = authenticatedFetch('/api/projects', { method: 'POST', body: '{"name":"old-account-project"}' });
  const rejected = assert.rejects(request, { name: 'AbortError' });
  assert.equal(native.call.mock.calls.filter(([method]) => method === 'FrontendBridge.GetApiConnection').length, 1);

  await FrontendBridge.connectServer('https://new-service.example');
  pendingMetadata.resolve(metadata);
  await rejected;

  assert.ok(!native.call.mock.calls.some(([method]) => method === 'FrontendBridge.BeginServerRequest'));
  assert.ok(!native.call.mock.calls.some(([method]) => method === 'FrontendBridge.ServerRequest'));
  assert.equal(localStorage.getItem('auth-token'), 'oldaccount.payload.signature');
  assert.throws(() => desktopWebSocketUrl('/ws', null), /账号服务尚未初始化/);
});

test('a new business request started during a native service switch never reads metadata or forwards HTTP', async () => {
  const connecting = deferred<Record<string, unknown>>();
  native.call.mockImplementation((method: string) => {
    if (method === 'FrontendBridge.ConnectServer') return connecting.promise;
    if (method === 'FrontendBridge.GetApiConnection') return Promise.resolve(newConnection);
    if (method === 'FrontendBridge.BeginServerRequest') return Promise.resolve('must-not-reserve');
    return Promise.resolve(reply);
  });
  const { authenticatedFetch } = await import('@/shared/api');
  const { FrontendBridge } = await import('@/shared/chisa');
  localStorage.setItem('auth-token', 'oldaccount.payload.signature');
  const switching = FrontendBridge.connectServer('https://new-service.example');
  assert.ok(native.call.mock.calls.some(([method]) => method === 'FrontendBridge.ConnectServer'));

  await assert.rejects(authenticatedFetch('/api/projects', { method: 'POST', body: '{"name":"old-account-project"}' }), { name: 'AbortError' });

  assert.ok(!native.call.mock.calls.some(([method]) => method === 'FrontendBridge.GetApiConnection'));
  assert.ok(!native.call.mock.calls.some(([method]) => method === 'FrontendBridge.BeginServerRequest'));
  assert.ok(!native.call.mock.calls.some(([method]) => method === 'FrontendBridge.ServerRequest'));
  connecting.resolve({ ok: true, changed: true });
  await switching;
});

test('a completed replacement blocks the old account until identity changes while anonymous login omits its token', async () => {
  const loginPayload = { token: 'newaccount.payload.signature', user: { id: 2, username: 'new-account' } };
  native.call.mockImplementation((method: string, _requestId: string, _verb: string, path: string) => {
    if (method === 'FrontendBridge.ConnectServer') return Promise.resolve({ ok: true, changed: true });
    if (method === 'FrontendBridge.GetApiConnection') return Promise.resolve(newConnection);
    if (method === 'FrontendBridge.BeginServerRequest') return Promise.resolve('current-request');
    if (method === 'FrontendBridge.ServerRequest') return Promise.resolve({
      ...reply, bodyB64: btoa(JSON.stringify(path === '/api/auth/login' ? loginPayload : {})),
    });
    return Promise.resolve();
  });
  const { api, authenticatedFetch } = await import('@/shared/api');
  const { FrontendBridge } = await import('@/shared/chisa');
  const { clearAuthToken, startAuthSession } = await import('@/shared/authToken');
  localStorage.setItem('auth-token', 'oldaccount.payload.signature');
  await FrontendBridge.connectServer('https://new-service.example');

  await assert.rejects(authenticatedFetch('/api/projects'), { name: 'AbortError' });
  assert.ok(!native.call.mock.calls.some(([method]) => method === 'FrontendBridge.GetApiConnection'));
  assert.ok(!native.call.mock.calls.some(([method]) => method === 'FrontendBridge.BeginServerRequest'));
  assert.ok(!native.call.mock.calls.some(([method]) => method === 'FrontendBridge.ServerRequest'));
  assert.equal(localStorage.getItem('auth-token'), 'oldaccount.payload.signature');

  const login = await api.auth.login('new-account', 'test-only-password');
  assert.equal(login.status, 200);
  assert.deepEqual(await login.json(), loginPayload);
  assert.equal((await api.auth.status()).status, 200);
  const anonymousRequests = native.call.mock.calls.filter(([method]) => method === 'FrontendBridge.ServerRequest');
  assert.deepEqual(anonymousRequests.map(([, , , path]) => path), ['/api/auth/login', '/api/auth/status']);
  for (const [, , , , headers] of anonymousRequests) {
    assert.ok(!Object.keys(headers).some(name => name.toLowerCase() === 'authorization'));
  }
  await assert.rejects(authenticatedFetch('/api/projects'), { name: 'AbortError' });
  assert.equal(native.call.mock.calls.filter(([method]) => method === 'FrontendBridge.ServerRequest').length, 2);

  clearAuthToken();
  startAuthSession(loginPayload.token);
  const response = await authenticatedFetch('/api/projects', { method: 'POST', body: '{"name":"new-account-project"}' });
  assert.equal(response.status, 200);
  const businessRequests = native.call.mock.calls.filter(([method, , , path]) => method === 'FrontendBridge.ServerRequest' && path === '/api/projects');
  assert.equal(businessRequests.length, 1);
  assert.equal(businessRequests[0][4].Authorization, 'Bearer newaccount.payload.signature');
  assert.deepEqual(JSON.parse(atob(businessRequests[0][5])), { name: 'new-account-project' });
});

test.each([
  ['failed', { ok: false, error: 'Service is unavailable' }],
  ['unchanged', { ok: true, changed: false }],
] as const)('a %s connection attempt releases its barrier and preserves the original account', async (_label, result) => {
  const connecting = deferred<Record<string, unknown>>();
  native.call.mockImplementation((method: string) => {
    if (method === 'FrontendBridge.ConnectServer') return connecting.promise;
    if (method === 'FrontendBridge.GetApiConnection') return Promise.resolve(oldConnection);
    if (method === 'FrontendBridge.BeginServerRequest') return Promise.resolve('original-request');
    if (method === 'FrontendBridge.ServerRequest') return Promise.resolve(reply);
    return Promise.resolve();
  });
  const { authenticatedFetch } = await import('@/shared/api');
  const { FrontendBridge } = await import('@/shared/chisa');
  localStorage.setItem('auth-token', 'originalaccount.payload.signature');
  const switching = FrontendBridge.connectServer('https://original-service.example');
  await assert.rejects(authenticatedFetch('/api/projects'), { name: 'AbortError' });
  assert.ok(!native.call.mock.calls.some(([method]) => method === 'FrontendBridge.BeginServerRequest'));
  assert.ok(!native.call.mock.calls.some(([method]) => method === 'FrontendBridge.ServerRequest'));

  connecting.resolve(result);
  assert.deepEqual(await switching, result);
  assert.equal((await authenticatedFetch('/api/projects')).status, 200);
  const forwarded = native.call.mock.calls.filter(([method]) => method === 'FrontendBridge.ServerRequest');
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0][4].Authorization, 'Bearer originalaccount.payload.signature');
  assert.equal(localStorage.getItem('auth-token'), 'originalaccount.payload.signature');
});

test('late metadata from before a service change cannot overwrite the new connection cache', async () => {
  const pendingMetadata = deferred<ChisaApiConnection>();
  native.call.mockImplementationOnce(() => pendingMetadata.promise);
  const { desktopWebSocketUrl, FrontendBridge, getServerConnectionVersion } = await import('@/shared/chisa');
  const pending = FrontendBridge.getApiConnection();
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  native.call.mockImplementation((method: string) => Promise.resolve(method === 'FrontendBridge.GetApiConnection'
    ? newConnection : { ok: true }));
  await FrontendBridge.connectServer('https://new-service.example');
  await FrontendBridge.getApiConnection();
  const version = getServerConnectionVersion();

  pendingMetadata.resolve(oldConnection);
  await rejected;

  assert.equal(desktopWebSocketUrl('/ws', null), newConnection.webSocketUrl + '/ws');
  assert.equal(getServerConnectionVersion(), version);
});

test('metadata that discovers a replaced native connection aborts the request before reserving a ticket', async () => {
  native.call.mockImplementationOnce(() => Promise.resolve(oldConnection))
    .mockImplementationOnce(() => Promise.resolve(newConnection));
  const { authenticatedFetch } = await import('@/shared/api');
  const { FrontendBridge } = await import('@/shared/chisa');
  await FrontendBridge.getApiConnection();
  localStorage.setItem('auth-token', 'oldaccount.payload.signature');

  await assert.rejects(authenticatedFetch('/api/projects', { method: 'POST', body: '{"name":"old-account-project"}' }), { name: 'AbortError' });

  assert.ok(!native.call.mock.calls.some(([method]) => method === 'FrontendBridge.BeginServerRequest'));
  assert.ok(!native.call.mock.calls.some(([method]) => method === 'FrontendBridge.ServerRequest'));
});

test('an older concurrent native snapshot cannot replace a newer cached connection', async () => {
  const pendingMetadata = deferred<ChisaApiConnection>();
  native.call.mockImplementationOnce(() => pendingMetadata.promise)
    .mockImplementationOnce(() => Promise.resolve(newConnection));
  const { desktopWebSocketUrl, FrontendBridge, getServerConnectionVersion } = await import('@/shared/chisa');
  const pending = FrontendBridge.getApiConnection();
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await FrontendBridge.getApiConnection();
  const version = getServerConnectionVersion();

  pendingMetadata.resolve(oldConnection);
  await rejected;

  assert.equal(desktopWebSocketUrl('/ws', null), newConnection.webSocketUrl + '/ws');
  assert.equal(getServerConnectionVersion(), version);
});

test('a normal request forwards its body and accepts a refreshed token', async () => {
  mockNative((method: string) => Promise.resolve(method === 'FrontendBridge.BeginServerRequest' ? 'request-id' : { ...reply, headers: { 'X-Refreshed-Token': 'new.payload.signature' } }));
  const { authenticatedFetch } = await import('@/shared/api');
  const response = await authenticatedFetch('/api/projects', { method: 'POST', body: '{"name":"demo"}' });
  assert.equal(response.status, 200);
  const sent = native.call.mock.calls.find(([method]) => method === 'FrontendBridge.ServerRequest')!;
  assert.deepEqual(sent.slice(1, 4), ['request-id', 'POST', '/api/projects']);
  assert.equal(atob(sent[5]), '{"name":"demo"}');
  assert.equal(localStorage.getItem('auth-token'), 'new.payload.signature');
});

test('logout invalidates an already forwarded native reply before its auth headers', async () => {
  const upstream = deferred<typeof reply>();
  mockNative((method: string) => method === 'FrontendBridge.BeginServerRequest' ? Promise.resolve('request-id') : method === 'FrontendBridge.ServerRequest' ? upstream.promise : Promise.resolve());
  const { authenticatedFetch } = await import('@/shared/api');
  const { startAuthSession, clearAuthToken } = await import('@/shared/authToken');
  startAuthSession('old.payload.signature');
  const pending = authenticatedFetch('/api/projects');
  await vi.waitFor(() => assert.ok(native.call.mock.calls.some(([method]) => method === 'FrontendBridge.ServerRequest')));
  clearAuthToken();
  startAuthSession('newaccount.payload.signature');
  upstream.resolve({ ...reply, headers: { 'X-Refreshed-Token': 'oldrotated.payload.signature', 'X-Auth-Error': 'expired' } });
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(localStorage.getItem('auth-token'), 'newaccount.payload.signature');
});

test('the first login waits for pending native logout and uses the new connection without retrying', async () => {
  const ending = deferred<void>();
  let loggedOut = false;
  const loginPayload = { token: 'nextaccount.payload.signature', user: { id: 2, username: 'next-account' } };
  native.call.mockImplementation((method: string) => {
    if (method === 'FrontendBridge.GetApiConnection') return Promise.resolve(loggedOut ? newConnection : oldConnection);
    if (method === 'FrontendBridge.EndServerSession') return ending.promise.then(() => { loggedOut = true; });
    if (method === 'FrontendBridge.BeginServerRequest') return Promise.resolve('login-request');
    if (method === 'FrontendBridge.ServerRequest') return Promise.resolve({ ...reply, bodyB64: btoa(JSON.stringify(loginPayload)) });
    return Promise.resolve();
  });
  const { api } = await import('@/shared/api');
  const { desktopWebSocketUrl, FrontendBridge } = await import('@/shared/chisa');
  const { clearAuthToken } = await import('@/shared/authToken');
  localStorage.setItem('auth-token', 'oldaccount.payload.signature');
  await FrontendBridge.getApiConnection();
  clearAuthToken();
  const logout = FrontendBridge.endServerSession();
  const login = api.auth.login('next-account', 'test-only-password');
  await Promise.resolve();

  assert.equal(native.call.mock.calls.filter(([method]) => method === 'FrontendBridge.GetApiConnection').length, 1);
  assert.ok(!native.call.mock.calls.some(([method]) => method === 'FrontendBridge.BeginServerRequest'));
  assert.ok(!native.call.mock.calls.some(([method]) => method === 'FrontendBridge.ServerRequest'));
  assert.throws(() => desktopWebSocketUrl('/ws', null), /账号服务尚未初始化/);

  ending.resolve();
  await logout;
  const response = await login;
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), loginPayload);
  const forwarded = native.call.mock.calls.filter(([method]) => method === 'FrontendBridge.ServerRequest');
  assert.equal(forwarded.length, 1);
  assert.deepEqual(forwarded[0].slice(1, 4), ['login-request', 'POST', '/api/auth/login']);
  assert.equal(forwarded[0][4].Authorization, undefined);
  assert.deepEqual(JSON.parse(atob(forwarded[0][5])), { username: 'next-account', password: 'test-only-password' });
  assert.equal(desktopWebSocketUrl('/ws', null), newConnection.webSocketUrl + '/ws');
});
