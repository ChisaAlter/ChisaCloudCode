import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type * as AuthTokenModule from '@/shared/authToken';
import type { createAuthenticatedEventSource } from '@/shared/authenticatedEventSource';
import type { ChisaApiConnection } from '@/shared/types';

const native = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('mygo-runtime', () => native);

let auth: typeof AuthTokenModule;
const sources: Array<{ close: () => void }> = [];
const encoder = new TextEncoder();
const path = '/api/providers/search/sessions?q=test&limit=50';

function token(userId = 'alice', signature = 'signature') {
  return `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({ userId, exp: Math.floor(Date.now() / 1000) + 600 })).toString('base64url')}.${signature}`;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function flush() { for (let i = 0; i < 35; i++) await Promise.resolve(); }
function wire() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel });
  return { response: new Response(body, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } }), cancel,
    write: (text: string) => controller.enqueue(encoder.encode(text)), bytes: (value: Uint8Array) => controller.enqueue(value),
    end: () => controller.close(), disconnect: () => controller.error(new Error('upstream broke')) };
}
async function browser() {
  auth = await import('@/shared/authToken');
  await auth.initializeAuthSession();
  const snapshot = await auth.startAuthSession(token());
  expect(snapshot).not.toBeNull();
  auth.acknowledgeAuthSession(snapshot!);
  return snapshot!;
}
function connection(account = 'alice', generation = 1): ChisaApiConnection {
  return { protocolVersion: 2, configured: true, sessionHandle: `handle-${account}-${generation}`, generation, version: generation,
    tokenRevision: 1, authenticated: true, serverKey: `server-${account}`, accessToken: token(account), restorationToken: '', switching: false,
    httpProxyUrl: `http://127.0.0.1:18792/channel/cap-${account}-${generation}`, webSocketUrl: `ws://127.0.0.1:18792/channel/cap-${account}-${generation}` };
}
async function desktop() {
  vi.stubGlobal('mygo', {});
  let current = connection();
  native.call.mockImplementation(async (method: string) => {
    if (method !== 'FrontendBridge.GetApiConnection') throw new Error('SSE must never use the buffered native request bridge');
    return { ...current };
  });
  auth = await import('@/shared/authToken');
  await auth.initializeAuthSession();
  const chisa = await import('@/shared/chisa');
  await chisa.FrontendBridge.getApiConnection();
  const expected = auth.getAuthSessionSnapshot();
  auth.acknowledgeAuthSession(expected);
  return { expected, chisa, get current() { return current; }, replace(next: ChisaApiConnection) { current = next; } };
}
async function open(options: Parameters<typeof createAuthenticatedEventSource>[1] = {}, url = path) {
  const { createAuthenticatedEventSource } = await import('@/shared/authenticatedEventSource');
  const source = createAuthenticatedEventSource(url, options);
  sources.push(source);
  const events: Array<{ type: string; data: string; id: string }> = [];
  for (const type of ['message', 'title-results', 'result', 'progress', 'done', 'error']) {
    source.addEventListener(type, event => events.push({ type: event.type, data: event.data, id: event.lastEventId }));
  }
  return { source, events };
}

beforeEach(() => {
  vi.resetModules(); native.call.mockReset(); vi.useRealTimers();
  Reflect.deleteProperty(globalThis, 'mygo');
  localStorage.clear(); sessionStorage.clear();
});
afterEach(() => {
  for (const source of sources.splice(0)) source.close();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

test('normal 200 sends browser Bearer header and streams a result before EOF', async () => {
  const expected = await browser();
  const stream = wire();
  const fetcher = vi.fn(async () => stream.response); vi.stubGlobal('fetch', fetcher);
  const { source, events } = await open({ expectedSession: expected });
  expect(source.addEventListener).toBeTypeOf('function');
  expect(source.close).toBeTypeOf('function');
  await flush();
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe(path); expect(url).not.toContain(expected.token);
  expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${expected.token}`);
  expect(new Headers(init.headers).get('Accept')).toBe('text/event-stream');
  stream.write('event: result\ndata: {"hit":1}\n\n'); await flush();
  expect(events).toEqual([{ type: 'result', data: '{"hit":1}', id: '' }]);
  expect(stream.cancel).not.toHaveBeenCalled();
  stream.write('event: done\ndata: {}\n\nevent: result\ndata: late\n\n'); await flush();
  expect(events.map(event => event.type)).toEqual(['result', 'done']);
  expect(stream.cancel).toHaveBeenCalledTimes(1);
  expect(init.signal?.aborted).toBe(true);
});

test('chunked UTF-8, split CRLF, comments, multiline data, id reset and named events retain SSE semantics', async () => {
  await browser(); const stream = wire(); vi.stubGlobal('fetch', vi.fn(async () => stream.response));
  const { events } = await open(); await flush();
  const text = '\ufeff: keepalive\r\nid: first\r\nevent: title-results\r\ndata: {"title":\r\ndata: "猫"}\r\n\r\n'
    + 'retry: 10\rid: ignored\0value\revent: result\rdata: value:with:colons\r\r'
    + 'id\nunknown: safe\ndata\n\nid:\n\nevent: progress\ndata: {}\n\nevent: done\ndata: {}\n\n';
  for (const byte of encoder.encode(text)) { stream.bytes(new Uint8Array([byte])); await flush(); }
  expect(events).toEqual([
    { type: 'title-results', data: '{"title":\n"猫"}', id: 'first' },
    { type: 'result', data: 'value:with:colons', id: 'first' },
    { type: 'message', data: '', id: '' },
    { type: 'progress', data: '{}', id: '' },
    { type: 'done', data: '{}', id: '' },
  ]);
});

test('transport disconnect, incomplete EOF and malformed UTF-8 fail once without replay', async () => {
  await browser();
  for (const mode of ['disconnect', 'truncated', 'invalid-utf8'] as const) {
    const stream = wire(); const fetcher = vi.fn(async () => stream.response); vi.stubGlobal('fetch', fetcher);
    const { events } = await open(); await flush();
    stream.write('event: result\ndata: valid\n\n'); await flush();
    if (mode === 'disconnect') stream.disconnect();
    else if (mode === 'truncated') { stream.write('event: result\ndata: never-dispatched'); stream.end(); }
    else stream.bytes(new Uint8Array([0xc3, 0x28]));
    await flush();
    expect(events.map(event => event.type)).toEqual(['result', 'error']);
    expect(fetcher).toHaveBeenCalledTimes(1);
  }
});

test.each([
  ['line', () => 'data: ' + 'a'.repeat(64 * 1024), 'SSE_LINE_LIMIT'],
  ['event', () => 'data: ' + 'a'.repeat(60 * 1024) + '\n' + ('data: ' + 'a'.repeat(60 * 1024) + '\n').repeat(17), 'SSE_EVENT_LIMIT'],
  ['lines', () => ': comment\n'.repeat(4097), 'SSE_EVENT_LIMIT'],
  ['events', () => 'data: x\n\n'.repeat(10_001), 'SSE_EVENT_COUNT_LIMIT'],
] as const)('parser %s budget fails closed and releases the reader', async (_name, payload, code) => {
  await browser(); const stream = wire(); vi.stubGlobal('fetch', vi.fn(async () => stream.response));
  const { events } = await open(); await flush(); stream.write(payload()); await flush();
  expect(JSON.parse(events.at(-1)!.data).error).toBe(code);
  expect(events.filter(event => event.type === 'error')).toHaveLength(1);
  expect(stream.cancel).toHaveBeenCalledTimes(1);
});

test('total byte budget also bounds comment-only streams across blank frames', async () => {
  await browser(); const stream = wire(); vi.stubGlobal('fetch', vi.fn(async () => stream.response));
  const { events } = await open(); await flush();
  stream.write(':\n\n'.repeat(Math.ceil((16 * 1024 * 1024 + 1) / 3))); await flush();
  expect(JSON.parse(events[0].data).error).toBe('SSE_STREAM_LIMIT'); expect(stream.cancel).toHaveBeenCalledTimes(1);
});

test.each([401, 403, 500])('HTTP %s emits one terminal error and cancels its response body', async status => {
  await browser(); const stream = wire();
  const fetcher = vi.fn(async () => new Response(stream.response.body, { status, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetcher); const { events } = await open(); await flush();
  expect(events.map(event => event.type)).toEqual(['error']);
  expect(JSON.parse(events[0].data)).toEqual({ error: 'SSE_HTTP_ERROR', status });
  expect(stream.cancel).toHaveBeenCalledTimes(1); expect(fetcher).toHaveBeenCalledTimes(1);
});

test('401 with X-Auth-Error expires only the captured account and emits no stale result', async () => {
  const expected = await browser(); const stream = wire();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(stream.response.body, { status: 401, headers: { 'X-Auth-Error': 'session-expired' } })));
  const { events } = await open(); await flush();
  expect(auth.getAuthSessionSnapshot().phase).toBe('signedOut');
  expect(auth.getAuthSessionSnapshot().sessionInstanceId).not.toBe(expected.sessionInstanceId);
  expect(events).toEqual([]); expect(stream.cancel).toHaveBeenCalledTimes(1);
});

test.each(['application/json', null])('normal 200 with %s content type is rejected before parsing', async contentType => {
  await browser(); const stream = wire();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(stream.response.body, { headers: contentType ? { 'Content-Type': contentType } : {} })));
  const { events } = await open(); await flush();
  expect(JSON.parse(events[0].data).error).toBe('SSE_CONTENT_TYPE'); expect(stream.cancel).toHaveBeenCalledTimes(1);
});

test('explicit close, abort and close-before-start are silent and idempotent', async () => {
  await browser();
  for (const mode of ['close', 'abort', 'before-start'] as const) {
    const stream = wire(); const fetcher = vi.fn(async () => stream.response); vi.stubGlobal('fetch', fetcher);
    const { createAuthenticatedEventSource } = await import('@/shared/authenticatedEventSource');
    const controller = new AbortController(); const source = createAuthenticatedEventSource(path, { signal: controller.signal }); sources.push(source);
    const receive = vi.fn(); source.addEventListener('error', receive); source.addEventListener('result', receive);
    if (mode === 'before-start') source.close();
    await flush();
    if (mode === 'abort') controller.abort(); else source.close();
    source.close(); await flush();
    expect(receive).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(mode === 'before-start' ? 0 : 1);
    expect(stream.cancel).toHaveBeenCalledTimes(mode === 'before-start' ? 0 : 1);
  }
});

test('removed listeners and listener-triggered close do not leak further frames from the same chunk', async () => {
  await browser(); const stream = wire(); vi.stubGlobal('fetch', vi.fn(async () => stream.response));
  const { source, events } = await open(); const removed = vi.fn();
  source.addEventListener('result', removed); source.removeEventListener('result', removed);
  source.addEventListener('result', () => source.close()); await flush();
  stream.write('event: result\ndata: first\n\nevent: result\ndata: stale\n\n'); await flush();
  expect(events).toHaveLength(1); expect(removed).not.toHaveBeenCalled(); expect(stream.cancel).toHaveBeenCalledTimes(1);
});

test('body inactivity timeout starts after headers, resets on chunks and cancels without waiting for EOF', async () => {
  await browser(); vi.useFakeTimers(); const stream = wire(); vi.stubGlobal('fetch', vi.fn(async () => stream.response));
  const { events } = await open({ bodyTimeoutMs: 40 }); await flush();
  await vi.advanceTimersByTimeAsync(30); stream.write(': heartbeat\n\n'); await flush();
  await vi.advanceTimersByTimeAsync(30); expect(events).toEqual([]);
  await vi.advanceTimersByTimeAsync(11);
  expect(JSON.parse(events[0].data).error).toBe('SSE_BODY_TIMEOUT'); expect(stream.cancel).toHaveBeenCalledTimes(1);
});

test('connect timeout aborts a pending header fetch and disposes its late response', async () => {
  await browser(); vi.useFakeTimers(); const pending = deferred<Response>(); const stream = wire();
  const fetcher = vi.fn(() => pending.promise); vi.stubGlobal('fetch', fetcher);
  const { events } = await open({ connectTimeoutMs: 25 }); await flush();
  await vi.advanceTimersByTimeAsync(26);
  expect(JSON.parse(events[0].data).error).toBe('SSE_CONNECT_TIMEOUT');
  expect((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].signal?.aborted).toBe(true);
  pending.resolve(stream.response); await flush(); expect(stream.cancel).toHaveBeenCalledTimes(1);
});

test('account ABA while browser headers are pending cannot dispatch a result or retain the late body', async () => {
  const expected = await browser(); const pending = deferred<Response>(); const stream = wire();
  const fetcher = vi.fn(() => pending.promise); vi.stubGlobal('fetch', fetcher); const { events } = await open(); await flush();
  await auth.startAuthSession(token('bob')); await auth.startAuthSession(token());
  expect(auth.getAuthSessionSnapshot().sessionInstanceId).not.toBe(expected.sessionInstanceId);
  pending.resolve(stream.response); await flush();
  expect(events).toEqual([]); expect(stream.cancel).toHaveBeenCalledTimes(1); expect(fetcher).toHaveBeenCalledTimes(1);
});

test('account switch from one listener prevents the next listener and subsequent event from observing old data', async () => {
  await browser(); const stream = wire(); vi.stubGlobal('fetch', vi.fn(async () => stream.response));
  const { source, events } = await open(); const later = vi.fn();
  source.addEventListener('result', () => { void auth.clearAuthToken(); }); source.addEventListener('result', later); await flush();
  stream.write('event: result\ndata: first\n\nevent: result\ndata: forbidden\n\n'); await flush();
  expect(later).not.toHaveBeenCalled(); expect(events.map(event => event.data)).toEqual(['first']); expect(stream.cancel).toHaveBeenCalledTimes(1);
});

test('same-incarnation browser token refresh preserves the active stream', async () => {
  const expected = await browser(); const stream = wire(); vi.stubGlobal('fetch', vi.fn(async () => stream.response));
  const { events } = await open(); await flush(); await auth.storeAuthToken(token('alice', 'rotated'), expected);
  stream.write('event: result\ndata: current\n\nevent: done\ndata: {}\n\n'); await flush();
  expect(events.map(event => event.type)).toEqual(['result', 'done']);
});

test('desktop uses the bound loopback capability with real chunks and no buffered native bridge or renderer Bearer', async () => {
  const state = await desktop(); const stream = wire(); const fetcher = vi.fn(async () => stream.response); vi.stubGlobal('fetch', fetcher);
  const { events } = await open({ expectedSession: state.expected }); await flush();
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe(state.current.httpProxyUrl + path); expect(url).not.toContain(state.expected.token);
  expect(new Headers(init.headers).has('Authorization')).toBe(false); expect(init.credentials).toBe('omit'); expect(init.redirect).toBe('error');
  stream.write('event: progress\ndata: {"scannedProjects":1}\n\n'); await flush(); expect(events[0].type).toBe('progress');
  expect(stream.cancel).not.toHaveBeenCalled();
  stream.write('event: done\ndata: {}\n\n'); await flush(); expect(events.map(event => event.type)).toEqual(['progress', 'done']);
  expect(native.call.mock.calls.every(([method]) => method === 'FrontendBridge.GetApiConnection')).toBe(true);
});

test('desktop pending capability lookup rejects replacement native handle and sends nothing to the new account', async () => {
  const state = await desktop(); const lookup = deferred<ChisaApiConnection>();
  native.call.mockImplementation(() => lookup.promise); const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  const { events } = await open(); await flush(); state.replace(connection('bob', 2)); lookup.resolve(state.current); await flush();
  expect(fetcher).not.toHaveBeenCalled(); expect(events).toEqual([]);
});

test('desktop close during capability lookup never dispatches when the lookup arrives late', async () => {
  const state = await desktop(); const lookup = deferred<ChisaApiConnection>(); native.call.mockImplementation(() => lookup.promise);
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher); const { source, events } = await open(); await flush();
  source.close(); lookup.resolve(state.current); await flush(); expect(fetcher).not.toHaveBeenCalled(); expect(events).toEqual([]);
});

test('desktop connection lookup is bounded even if native never resolves', async () => {
  await desktop(); vi.useFakeTimers(); native.call.mockImplementation(() => new Promise(() => {}));
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher); const { events } = await open({ connectTimeoutMs: 10 }); await flush();
  await vi.advanceTimersByTimeAsync(11); expect(JSON.parse(events[0].data).error).toBe('SSE_CONNECT_TIMEOUT'); expect(fetcher).not.toHaveBeenCalled();
});

test('desktop transport revision change during lookup cannot silently adopt the newer capability revision', async () => {
  const state = await desktop(); const lookup = deferred<ChisaApiConnection>(); native.call.mockImplementation(() => lookup.promise);
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher); const { events } = await open(); await flush();
  lookup.resolve({ ...state.current, tokenRevision: 2, accessToken: token('alice', 'rotated') }); await flush();
  expect(fetcher).not.toHaveBeenCalled(); expect(events).toEqual([]);
});

test('desktop rechecks native handle/transport after synchronous desktopHttpUrl lookup', async () => {
  const state = await desktop(); const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  vi.spyOn(state.chisa, 'desktopHttpUrl').mockImplementation(() => {
    auth.observeNativeAuthSession({ ...state.expected, sessionInstanceId: 'replacement-handle', nativeHandle: 'replacement-handle' });
    return state.current.httpProxyUrl + path;
  });
  const { events } = await open(); await flush(); expect(fetcher).not.toHaveBeenCalled(); expect(events).toEqual([]);
});

test('desktop account replacement aborts a live reader and ignores pending/late response chunks', async () => {
  const state = await desktop(); const stream = wire(); const fetcher = vi.fn(async () => stream.response); vi.stubGlobal('fetch', fetcher);
  const { events } = await open(); await flush(); stream.write('event: result\ndata: first\n\n'); await flush();
  state.replace(connection('bob', 2)); await state.chisa.FrontendBridge.getApiConnection(); await flush();
  expect(events.map(event => event.data)).toEqual(['first']); expect(stream.cancel).toHaveBeenCalledTimes(1); expect(fetcher).toHaveBeenCalledTimes(1);
});

test('desktop transport changes after capability resolution but before dispatch never send the old URL', async () => {
  const state = await desktop(); const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  const dispatch = auth.dispatchWithAuthSession;
  vi.spyOn(auth, 'dispatchWithAuthSession').mockImplementation(async (expected, operation, allowUnrendered) => {
    const switching = auth.beginAuthServerSwitch();
    await auth.finishAuthServerSwitch(switching, false);
    return dispatch(expected, operation, allowUnrendered);
  });
  const { events } = await open(); await flush();
  expect(fetcher).not.toHaveBeenCalled(); expect(events).toEqual([]);
  expect(auth.getAuthSessionSnapshot().nativeHandle).toBe(state.expected.nativeHandle);
});

test('desktop pending response is canceled after account switch without exposing the replacement target', async () => {
  const state = await desktop(); const pending = deferred<Response>(); const stream = wire();
  const admittedUrl = state.current.httpProxyUrl + path;
  const fetcher = vi.fn((_url: string, _init: RequestInit) => pending.promise); vi.stubGlobal('fetch', fetcher);
  const { events } = await open(); await flush();
  state.replace(connection('bob', 2)); await state.chisa.FrontendBridge.getApiConnection();
  pending.resolve(stream.response); await flush();
  expect(events).toEqual([]); expect(stream.cancel).toHaveBeenCalledTimes(1);
  expect(fetcher).toHaveBeenCalledTimes(1); expect(fetcher.mock.calls[0][0]).toBe(admittedUrl);
});

test('desktop cancellation after headers but before dispatch admission returns still owns and cancels the body', async () => {
  await desktop(); const stream = wire(); const fetcher = vi.fn(async () => stream.response); vi.stubGlobal('fetch', fetcher);
  const dispatch = auth.dispatchWithAuthSession;
  const admitted = deferred<void>(); const resume = deferred<void>();
  vi.spyOn(auth, 'dispatchWithAuthSession').mockImplementation(async (expected, operation, allowUnrendered) => {
    const value = await dispatch(expected, operation, allowUnrendered);
    await value.operation;
    admitted.resolve();
    await resume.promise;
    return value;
  });
  const { source, events } = await open(); await admitted.promise; await flush();
  source.close(); await flush();
  expect(stream.cancel).toHaveBeenCalledTimes(1); expect(events).toEqual([]);
  resume.resolve(); await flush(); expect(stream.cancel).toHaveBeenCalledTimes(1);
});

test('an abort-ignoring reader cannot publish a chunk that resolves after close', async () => {
  await browser(); const read = deferred<ReadableStreamReadResult<Uint8Array>>();
  const cancel = vi.fn(async () => {}); const releaseLock = vi.fn();
  const reader = { read: vi.fn(() => read.promise), cancel, releaseLock };
  const response = { ok: true, headers: new Headers({ 'Content-Type': 'text/event-stream' }), body: { getReader: () => reader } } as unknown as Response;
  vi.stubGlobal('fetch', vi.fn(async () => response));
  const { source, events } = await open(); await flush(); source.close(); await flush();
  read.resolve({ done: false, value: encoder.encode('event: result\ndata: forbidden\n\n') }); await flush();
  expect(events).toEqual([]); expect(cancel).toHaveBeenCalledTimes(1); expect(releaseLock).toHaveBeenCalledTimes(1);
});

test('API builders return encoded token-free relative paths in browser and desktop', async () => {
  await browser(); let { api } = await import('@/shared/api');
  expect(api.searchConversationsUrl('a b&token=literal', 10)).toBe('/api/providers/search/sessions?q=a+b%26token%3Dliteral&limit=10');
  expect(api.cloneProjectProgressUrl({ cloneId: 'clone/id?value' })).toBe('/api/projects/clone-progress?cloneId=clone%2Fid%3Fvalue');
  vi.stubGlobal('mygo', {});
  ({ api } = await import('@/shared/api'));
  expect(api.searchConversationsUrl('desktop')).toBe('/api/providers/search/sessions?q=desktop&limit=50');
  expect(api.cloneProjectProgressUrl({ cloneId: 'clone-a' })).toBe('/api/projects/clone-progress?cloneId=clone-a');
});

test.each(['?token=forbidden', '?access_token=forbidden', '?AUTHORIZATION=forbidden'])('URL credentials %s are rejected without network dispatch', async query => {
  await browser(); const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher); const { events } = await open({}, '/api/search' + query); await flush();
  expect(fetcher).not.toHaveBeenCalled(); expect(JSON.parse(events[0].data).error).toBe('SSE_INVALID_API_PATH');
});
