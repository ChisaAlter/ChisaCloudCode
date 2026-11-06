import { act, cleanup, render, waitFor } from '@testing-library/react';
import { useLayoutEffect } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { ChisaApiConnection } from '@/shared/types';

const account = vi.hoisted(() => ({ value: { user: { id: 1, username: 'a' } as { id: number; username: string } | null, token: 'accounta.payload.signature' as string | null, isLoading: false } }));
const native = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('@/modules/auth', () => ({ useAuth: () => account.value }));
vi.mock('mygo-runtime', () => native);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function connection(accountName = 'a', generation = 1): ChisaApiConnection {
  return {
    protocolVersion: 2, configured: true, sessionHandle: `session-${accountName}-${generation}`,
    serverKey: `server-${accountName}`, generation, version: generation, tokenRevision: 1,
    authenticated: true, accessToken: `account${accountName}.payload.signature`, restorationToken: '', switching: false,
    loginUrl: `https://${accountName}.example`, apiUrl: `https://${accountName}.example`,
    httpProxyUrl: `http://127.0.0.1:18792/channel/cap-${accountName}-${generation}`,
    webSocketUrl: `ws://127.0.0.1:18792/channel/cap-${accountName}-${generation}`,
  };
}

class MockSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: MockSocket[] = [];
  readyState = MockSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn(() => { this.readyState = MockSocket.CLOSED; this.onclose?.(); });
  send = vi.fn();
  constructor(readonly url: string) { MockSocket.instances.push(this); }
  serverOpens() { this.readyState = MockSocket.OPEN; this.onopen?.(); }
  serverDrops() { this.readyState = MockSocket.CLOSED; this.onclose?.(); }
}

function mockNative() {
  const state = {
    current: connection(),
    lookup: null as null | (() => Promise<ChisaApiConnection>),
    switchResult: null as null | (() => Promise<{ ok: boolean; changed?: boolean; error?: string; connection: ChisaApiConnection }>),
  };
  native.call.mockImplementation((method: string) => {
    if (method === 'FrontendBridge.GetApiConnection') return state.lookup ? state.lookup() : Promise.resolve({ ...state.current });
    if (method === 'FrontendBridge.ConnectServer' && state.switchResult) return state.switchResult();
    throw new Error(`Unexpected native method: ${method}`);
  });
  return state;
}

async function initializedProvider() {
  const auth = await import('@/shared/authToken');
  await auth.initializeAuthSession();
  const chisa = await import('@/shared/chisa');
  await chisa.FrontendBridge.getApiConnection();
  auth.acknowledgeAuthSession(auth.getAuthSessionSnapshot());
  const context = await import('@/shared/context/WebSocketContext');
  return { auth, ...chisa, ...context };
}

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  localStorage.clear(); sessionStorage.clear();
  MockSocket.instances = [];
  vi.stubGlobal('mygo', {}); vi.stubGlobal('WebSocket', MockSocket);
  account.value = { user: { id: 1, username: 'a' }, token: 'accounta.payload.signature', isLoading: false };
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

test('desktop websocket acquires the account capability after login and never puts JWT in its URL', async () => {
  const state = mockNative();
  const { WebSocketProvider } = await initializedProvider();
  native.call.mockClear();
  render(<WebSocketProvider><p>workspace</p></WebSocketProvider>);
  await waitFor(() => expect(MockSocket.instances.map(socket => socket.url)).toEqual([`${state.current.webSocketUrl}/ws`]));
  expect(native.call).toHaveBeenCalledWith('FrontendBridge.GetApiConnection');
  expect(new URL(MockSocket.instances[0].url).search).toBe('');
  expect(MockSocket.instances[0].url).not.toContain(account.value.token);
});

test('account switch during pending capability lookup cannot open a stale authenticated websocket', async () => {
  const state = mockNative();
  const predecessor = { ...state.current };
  const { auth, FrontendBridge, WebSocketProvider } = await initializedProvider();
  const old = deferred<ChisaApiConnection>();
  state.lookup = () => old.promise;
  native.call.mockClear();
  const view = render(<WebSocketProvider><p>workspace</p></WebSocketProvider>);
  await waitFor(() => expect(native.call).toHaveBeenCalledTimes(1));
  await act(async () => {
    state.current = connection('b', 2);
    state.lookup = null;
    await FrontendBridge.getApiConnection();
    account.value = { user: { id: 2, username: 'b' }, token: state.current.accessToken, isLoading: false };
    auth.acknowledgeAuthSession(auth.getAuthSessionSnapshot());
  });
  view.rerender(<WebSocketProvider><p>workspace</p></WebSocketProvider>);
  await waitFor(() => expect(MockSocket.instances).toHaveLength(1));
  await act(async () => { old.resolve(predecessor); });
  expect(MockSocket.instances.map(socket => socket.url)).toEqual([`${state.current.webSocketUrl}/ws`]);
  expect(MockSocket.instances[0].url).not.toContain(predecessor.accessToken);
});

test('unmount while native capability is pending never creates a socket or schedules reconnect', async () => {
  const state = mockNative();
  const { WebSocketProvider } = await initializedProvider();
  const old = deferred<ChisaApiConnection>();
  state.lookup = () => old.promise;
  const view = render(<WebSocketProvider><p>workspace</p></WebSocketProvider>);
  await waitFor(() => expect(native.call.mock.calls.filter(([method]) => method === 'FrontendBridge.GetApiConnection')).toHaveLength(2));
  view.unmount();
  await act(async () => { old.resolve(state.current); });
  expect(MockSocket.instances).toEqual([]);
});

test.each(['same', 'failed'] as const)('%s server probe explicitly resumes one live websocket with the original capability', async outcome => {
  const state = mockNative();
  const { FrontendBridge, WebSocketProvider, useWebSocket } = await initializedProvider();
  let value!: ReturnType<typeof useWebSocket>;
  function Consumer() {
    const context = useWebSocket();
    useLayoutEffect(() => { value = context; }, [context]);
    return null;
  }
  render(<WebSocketProvider><Consumer /></WebSocketProvider>);
  await waitFor(() => expect(MockSocket.instances).toHaveLength(1));
  act(() => MockSocket.instances[0].serverOpens());
  const old = MockSocket.instances[0];
  const oldClose = old.onclose;
  const result = deferred<{ ok: boolean; changed?: boolean; error?: string; connection: ChisaApiConnection }>();
  state.switchResult = () => result.promise;
  let switching!: Promise<unknown>;
  act(() => { switching = FrontendBridge.connectServer('https://a.example'); });
  expect(() => value.sendMessage({ type: 'test.during-probe' })).toThrow(/断开|切换/);
  expect(old.send).not.toHaveBeenCalled();
  await act(async () => {
    result.resolve({ ok: outcome === 'same', changed: false,
      ...(outcome === 'failed' ? { error: 'probe failed' } : {}), connection: { ...state.current, switching: false } });
    await switching;
  });
  await waitFor(() => expect(MockSocket.instances).toHaveLength(2));
  const resumed = MockSocket.instances[1];
  expect(resumed.url).toBe(old.url);
  expect(resumed.url).not.toContain('token=');
  expect(old.readyState).toBe(MockSocket.CLOSED);
  act(() => { resumed.serverOpens(); oldClose?.(); });
  expect(value.isConnected).toBe(true);
  act(() => value.sendMessage({ type: 'test.after-resume' }));
  expect(resumed.send).toHaveBeenCalledWith(JSON.stringify({ type: 'test.after-resume' }));
  expect(old.send).not.toHaveBeenCalled();
  vi.useFakeTimers();
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(MockSocket.instances).toHaveLength(2);
});

test('send is fenced synchronously before React can consume an identity-change notification', async () => {
  const state = mockNative();
  const { auth, WebSocketProvider, useWebSocket } = await initializedProvider();
  let value!: ReturnType<typeof useWebSocket>;
  function Consumer() {
    const context = useWebSocket();
    useLayoutEffect(() => { value = context; }, [context]);
    return null;
  }
  render(<WebSocketProvider><Consumer /></WebSocketProvider>);
  await waitFor(() => expect(MockSocket.instances).toHaveLength(1));
  act(() => MockSocket.instances[0].serverOpens());
  const old = MockSocket.instances[0];
  act(() => {
    const replacement = connection('b', 2);
    state.current = replacement;
    auth.observeNativeAuthSession({ sessionInstanceId: replacement.sessionHandle, nativeHandle: replacement.sessionHandle,
      nativeGeneration: replacement.generation, serverKey: replacement.serverKey, userId: '2', token: replacement.accessToken,
      tokenRevision: replacement.tokenRevision, phase: 'ready', storageMode: 'window' });
    expect(() => value.sendMessage({ type: 'chat.abort', sessionId: 'a-chat' })).toThrow(/断开|切换/);
  });
  expect(old.send).not.toHaveBeenCalled();
});

test('an old-account pending stop is never subscribed on the replacement account socket', async () => {
  const state = mockNative();
  const { auth, FrontendBridge, WebSocketProvider, useWebSocket } = await initializedProvider();
  let value!: ReturnType<typeof useWebSocket>;
  function Consumer() {
    const context = useWebSocket();
    useLayoutEffect(() => { value = context; }, [context]);
    return null;
  }
  const view = render(<WebSocketProvider><Consumer /></WebSocketProvider>);
  await waitFor(() => expect(MockSocket.instances).toHaveLength(1));
  act(() => MockSocket.instances[0].serverOpens());
  act(() => value.sendMessage({ type: 'chat.abort', sessionId: 'account-a-chat' }));
  expect(MockSocket.instances[0].send).toHaveBeenCalledWith(JSON.stringify({ type: 'chat.abort', sessionId: 'account-a-chat' }));
  await act(async () => {
    state.current = connection('b', 2);
    await FrontendBridge.getApiConnection();
    account.value = { user: { id: 2, username: 'b' }, token: state.current.accessToken, isLoading: false };
    auth.acknowledgeAuthSession(auth.getAuthSessionSnapshot());
    view.rerender(<WebSocketProvider><Consumer /></WebSocketProvider>);
  });
  await waitFor(() => expect(MockSocket.instances).toHaveLength(2));
  act(() => MockSocket.instances[1].serverOpens());
  expect(MockSocket.instances[1].send).not.toHaveBeenCalled();
  expect(value.isConnected).toBe(true);
});

test('a CONNECTING socket is closed on identity replacement and cannot process late open/message/close callbacks', async () => {
  const state = mockNative();
  const { auth, FrontendBridge, WebSocketProvider, useWebSocket } = await initializedProvider();
  const received = vi.fn();
  let value!: ReturnType<typeof useWebSocket>;
  function Consumer() {
    const context = useWebSocket();
    useLayoutEffect(() => { value = context; }, [context]);
    return null;
  }
  render(<WebSocketProvider><Consumer /></WebSocketProvider>);
  await waitFor(() => expect(MockSocket.instances).toHaveLength(1));
  const old = MockSocket.instances[0];
  const late = { open: old.onopen, message: old.onmessage, close: old.onclose };
  const unsubscribe = value.subscribe(received);
  await act(async () => {
    state.current = connection('b', 2);
    await FrontendBridge.getApiConnection();
    account.value = { user: { id: 2, username: 'b' }, token: state.current.accessToken, isLoading: false };
    auth.acknowledgeAuthSession(auth.getAuthSessionSnapshot());
  });
  await waitFor(() => expect(MockSocket.instances).toHaveLength(2));
  expect(old.readyState).toBe(MockSocket.CLOSED);
  act(() => { late.open?.(); late.message?.({ data: JSON.stringify({ kind: 'old-account-frame' }) }); late.close?.(); });
  expect(received).not.toHaveBeenCalled();
  expect(value.isConnected).toBe(false);
  act(() => MockSocket.instances[1].serverOpens());
  expect(value.isConnected).toBe(true);
  unsubscribe();
});
