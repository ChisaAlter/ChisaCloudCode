import assert from 'node:assert/strict';

import { afterEach, beforeEach, test, vi } from 'vitest';

import type { BridgeResponse, WorkspaceDescriptor } from '@/shared/types';

const native = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('mygo-runtime', () => ({ call: native.call }));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const reply: BridgeResponse = { status: 200, headers: { 'Content-Type': 'application/json' }, bodyB64: btoa('{}') };
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
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

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

test('switching service during GetApiConnection cannot reserve or forward an old Authorization header', async () => {
  const lookup = deferred<{ configured: boolean; version: number; webSocketUrl: string }>();
  native.call.mockImplementation((method: string) => method === 'FrontendBridge.GetApiConnection' ? lookup.promise : Promise.resolve({ ok: true }));
  const { authenticatedFetch } = await import('@/shared/api');
  const { FrontendBridge, desktopWebSocketUrl } = await import('@/shared/chisa');
  localStorage.setItem('auth-token', 'old.payload.signature');
  const request = authenticatedFetch('/api/projects');
  await vi.waitFor(() => assert.ok(native.call.mock.calls.some(([method]) => method === 'FrontendBridge.GetApiConnection')));
  await FrontendBridge.connectServer('https://new.example');
  lookup.resolve({ configured: true, version: 1, webSocketUrl: 'ws://127.0.0.1/old-account' });
  await assert.rejects(request, { name: 'AbortError' });
  assert.ok(!native.call.mock.calls.some(([method]) => method === 'FrontendBridge.BeginServerRequest'));
  assert.ok(!native.call.mock.calls.some(([method]) => method === 'FrontendBridge.ServerRequest'));
  assert.throws(() => desktopWebSocketUrl('/ws', 'new.payload.signature'), /尚未初始化/);
});

test('a deadline releases a hung native connection lookup before any ticket can be reserved', async () => {
  const lookup = deferred<{ configured: boolean; webSocketUrl: string }>();
  native.call.mockReturnValue(lookup.promise);
  const { authenticatedFetch } = await import('@/shared/api');
  const controller = new AbortController();
  const request = authenticatedFetch('/api/auth/user', { signal: controller.signal });
  const rejected = assert.rejects(request, { name: 'TimeoutError' });
  controller.abort(new DOMException('Timed out', 'TimeoutError'));
  await rejected;
  assert.ok(!native.call.mock.calls.some(([method]) => method === 'FrontendBridge.BeginServerRequest'));
  lookup.resolve({ configured: true, webSocketUrl: 'ws://127.0.0.1/current' });
});

test('a canceled hanging reservation releases its caller and cancels the eventual ticket', async () => {
  const reserved = deferred<string>();
  mockNative((method: string) => method === 'FrontendBridge.BeginServerRequest' ? reserved.promise : Promise.resolve());
  const { authenticatedFetch } = await import('@/shared/api');
  const controller = new AbortController();
  const request = authenticatedFetch('/api/auth/user', { signal: controller.signal });
  await vi.waitFor(() => assert.ok(native.call.mock.calls.some(([method]) => method === 'FrontendBridge.BeginServerRequest')));
  controller.abort(new DOMException('Timed out', 'TimeoutError'));
  await assert.rejects(request, { name: 'TimeoutError' });
  reserved.resolve('late-ticket'); await Promise.resolve(); await Promise.resolve();
  assert.ok(native.call.mock.calls.some(([method, id]) => method === 'FrontendBridge.CancelServerRequest' && id === 'late-ticket'));
  assert.ok(!native.call.mock.calls.some(([method]) => method === 'FrontendBridge.ServerRequest'));
});

test('an older connection lookup cannot overwrite the current WebSocket cache', async () => {
  const lookup = deferred<{ configured: boolean; version: number; webSocketUrl: string }>();
  let calls = 0;
  native.call.mockImplementation((method: string) => method === 'FrontendBridge.GetApiConnection'
    ? ++calls === 1 ? lookup.promise : Promise.resolve({ configured: true, version: 2, webSocketUrl: 'ws://127.0.0.1/new-account' })
    : Promise.resolve({ ok: true }));
  const { FrontendBridge, desktopWebSocketUrl } = await import('@/shared/chisa');
  const pending = FrontendBridge.getApiConnection();
  await FrontendBridge.connectServer('https://new.example');
  await FrontendBridge.getApiConnection();
  lookup.resolve({ configured: true, version: 1, webSocketUrl: 'ws://127.0.0.1/old-account' });
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(desktopWebSocketUrl('/ws', 'new.payload.signature'), 'ws://127.0.0.1/new-account/ws?token=new.payload.signature');
});

test('account change during reservation cancels the ticket before forwarding', async () => {
  const reserved = deferred<string>();
  mockNative((method: string) => method === 'FrontendBridge.BeginServerRequest' ? reserved.promise : Promise.resolve());
  const { authenticatedFetch } = await import('@/shared/api');
  const { startAuthSession, clearAuthToken } = await import('@/shared/authToken');
  startAuthSession('old.payload.signature');
  const request = authenticatedFetch('/api/projects');
  await vi.waitFor(() => assert.ok(native.call.mock.calls.some(([method]) => method === 'FrontendBridge.BeginServerRequest')));
  clearAuthToken(); startAuthSession('new.payload.signature'); reserved.resolve('old-ticket');
  await assert.rejects(request, { name: 'AbortError' });
  assert.ok(native.call.mock.calls.some(([method, id]) => method === 'FrontendBridge.CancelServerRequest' && id === 'old-ticket'));
  assert.ok(!native.call.mock.calls.some(([method]) => method === 'FrontendBridge.ServerRequest'));
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

test('desktop files and Git use only the cloud HTTP proxy and preserve workspace identity', async () => {
  mockNative((method: string) => Promise.resolve(method === 'FrontendBridge.BeginServerRequest' ? 'request-id' : reply));
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
  assert.deepEqual(methods, new Set(['FrontendBridge.GetApiConnection', 'FrontendBridge.BeginServerRequest', 'FrontendBridge.ServerRequest']));
  const requests = native.call.mock.calls.filter(([method]) => method === 'FrontendBridge.ServerRequest');
  assert.equal(requests.length, 3);
  for (const request of requests) {
    const url = new URL(request[3], 'https://cloud.example');
    assert.equal(url.searchParams.get('workspaceId'), workspace.workspaceId);
    assert.equal(url.searchParams.get('generation'), workspace.generation);
  }
  assert.equal(JSON.parse(atob(requests[1][5])).content, 'cloud edit');
  assert.equal(api.uploadFilesUrl(workspace.projectId).startsWith('http://127.0.0.1:18792/channel/test/api/file-tree/'), true);
});

test.each(['user', 'status', 'onboardingStatus'] as const)('safe auth %s GET cancels a hung native response at its deadline', async method => {
  const signals: AbortSignal[] = [];
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), 15000);
    signals.push(controller.signal);
    return controller.signal;
  });
  const upstream = deferred<typeof reply>();
  mockNative((name: string) => name === 'FrontendBridge.BeginServerRequest' ? Promise.resolve('deadline-ticket') : name === 'FrontendBridge.ServerRequest' ? upstream.promise : Promise.resolve());
  const { api } = await import('@/shared/api');
  vi.useFakeTimers();
  const request = method === 'onboardingStatus' ? api.user.onboardingStatus() : api.auth[method]();
  const rejected = assert.rejects(request, { name: 'TimeoutError' });
  await vi.advanceTimersByTimeAsync(15000);
  await rejected;
  assert.equal(signals[0].aborted, true);
  assert.ok(native.call.mock.calls.some(([name, id]) => name === 'FrontendBridge.CancelServerRequest' && id === 'deadline-ticket'));
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
