import assert from 'node:assert/strict';

import { act, cleanup, render } from '@testing-library/react';
import { useLayoutEffect } from 'react';
import { afterEach, beforeEach, test, vi } from 'vitest';

/** Connection status must distinguish an outage from initial, intentional refresh and signed-out handshakes. */
type FakeAuth = { user: { id: number } | null; token: string | null; isLoading: boolean };
const AUTH = vi.hoisted(() => {
  const user = { id: 1 };
  return { user, current: { user, token: 'token1.payload.signature', isLoading: false } as FakeAuth };
});
vi.mock('@/modules/auth', () => ({ useAuth: () => AUTH.current }));
vi.mock('@/shared/api', () => ({
  api: { auth: { webSocketTicket: vi.fn(async () => new Response(JSON.stringify({ ticket: 'a'.repeat(43), expiresAt: Math.floor(Date.now() / 1000) + 30 }), { status: 200 })) } },
  readApiJson: async (response: Response) => response.json(),
}));

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;
  constructor(readonly url: string) { FakeWebSocket.instances.push(this); }
  send = vi.fn();
  close() { this.readyState = FakeWebSocket.CLOSED; this.onclose?.(); }
  serverOpens() { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
  serverDrops() { this.readyState = FakeWebSocket.CLOSED; this.onclose?.(); }
}

let seen: string[] = [];
let isConnected: boolean | null = null;
const socket = (index: number) => FakeWebSocket.instances[index] as FakeWebSocket;
const lastStatus = () => seen[seen.length - 1];

async function setupProvider(signedIn = true) {
  const auth = await import('@/shared/authToken');
  await auth.initializeAuthSession();
  if (signedIn) {
    await auth.startAuthSession(AUTH.current.token!);
    auth.acknowledgeAuthSession(auth.getAuthSessionSnapshot());
  }
  const { WebSocketProvider, useWebSocket } = await import('@/shared/context/WebSocketContext');
  let context!: ReturnType<typeof useWebSocket>;
  function RecordStatus() {
    const value = useWebSocket();
    useLayoutEffect(() => {
      context = value;
      seen.push(value.connectionStatus);
      isConnected = value.isConnected;
    });
    return null;
  }
  const element = () => <WebSocketProvider><RecordStatus /></WebSocketProvider>;
  let view!: ReturnType<typeof render>;
  await act(async () => { view = render(element()); });
  return { auth, view, element, getContext: () => context };
}

beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks();
  localStorage.clear(); sessionStorage.clear();
  vi.stubEnv('VITE_IS_PLATFORM', 'false');
  vi.stubGlobal('mygo', undefined);
  // The auth-session desktop detector deliberately checks property existence.
  Reflect.deleteProperty(globalThis, 'mygo');
  FakeWebSocket.instances = []; seen = []; isConnected = null;
  AUTH.current = { user: AUTH.user, token: 'token1.payload.signature', isLoading: false };
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

test('the first handshake reads as connecting, never as a lost connection', async () => {
  await setupProvider();
  assert.equal(FakeWebSocket.instances.length, 1);
  assert.equal(lastStatus(), 'connecting');
  assert.equal(isConnected, false);
  act(() => socket(0).serverOpens());
  assert.equal(lastStatus(), 'connected');
  assert.equal(isConnected, true);
  assert.ok(!seen.includes('disconnected'), `statuses seen: ${seen.join(', ')}`);
});

test('a dropped socket reads as disconnected through every failed retry, until one opens', async () => {
  await setupProvider();
  vi.useFakeTimers();
  act(() => socket(0).serverOpens());
  act(() => socket(0).serverDrops());
  assert.equal(lastStatus(), 'disconnected');
  assert.equal(isConnected, false);
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  assert.equal(FakeWebSocket.instances.length, 2);
  assert.equal(lastStatus(), 'disconnected');
  act(() => socket(1).serverDrops());
  assert.equal(lastStatus(), 'disconnected');
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  assert.equal(FakeWebSocket.instances.length, 3);
  act(() => socket(2).serverOpens());
  assert.equal(lastStatus(), 'connected');
  assert.equal(isConnected, true);
});

test('a first attempt that fails reads as disconnected', async () => {
  await setupProvider();
  vi.useFakeTimers();
  act(() => socket(0).serverDrops());
  assert.equal(lastStatus(), 'disconnected');
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  act(() => socket(1).serverOpens());
  assert.equal(lastStatus(), 'connected');
});

test('a Web token refresh swaps the socket without ever reading as a lost connection', async () => {
  const { auth, view, element } = await setupProvider();
  vi.useFakeTimers();
  act(() => socket(0).serverOpens());
  await act(async () => {
    assert.equal(await auth.storeAuthToken('token2.payload.signature', auth.getAuthSessionSnapshot()), true);
    AUTH.current = { ...AUTH.current, token: 'token2.payload.signature' };
    view.rerender(element());
  });
  assert.equal(FakeWebSocket.instances.length, 2, 'the refreshed Web token opened a new socket');
  assert.equal(socket(0).readyState, FakeWebSocket.CLOSED, 'the old-token socket was closed');
  assert.equal(new URL(socket(1).url).searchParams.has('token'), false);
  assert.equal(new URL(socket(1).url).searchParams.get('ticket'), 'a'.repeat(43));
  assert.equal(lastStatus(), 'connecting');
  assert.equal(isConnected, false);
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  assert.equal(FakeWebSocket.instances.length, 2);
  act(() => socket(1).serverOpens());
  assert.equal(lastStatus(), 'connected');
  assert.ok(!seen.includes('disconnected'), `statuses seen: ${seen.join(', ')}`);
});

test('signing out while the socket is down does not carry the drop into the next sign-in', async () => {
  const { auth, view, element } = await setupProvider();
  vi.useFakeTimers();
  act(() => socket(0).serverOpens());
  act(() => socket(0).serverDrops());
  assert.equal(lastStatus(), 'disconnected');
  await act(async () => {
    await auth.clearAuthToken(auth.getAuthSessionSnapshot());
    AUTH.current = { user: null, token: null, isLoading: false };
    view.rerender(element());
  });
  assert.equal(lastStatus(), 'connecting', 'no connection is lost while nobody is signed in');
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  assert.equal(FakeWebSocket.instances.length, 1, 'no reconnect while signed out');
  seen = [];
  await act(async () => {
    await auth.startAuthSession('token2.payload.signature');
    auth.acknowledgeAuthSession(auth.getAuthSessionSnapshot());
    AUTH.current = { user: AUTH.user, token: 'token2.payload.signature', isLoading: false };
    view.rerender(element());
  });
  assert.equal(FakeWebSocket.instances.length, 2);
  assert.ok(!seen.includes('disconnected'), `statuses seen after sign-in: ${seen.join(', ')}`);
  assert.equal(lastStatus(), 'connecting');
  act(() => socket(1).serverOpens());
  assert.equal(lastStatus(), 'connected');
});

test('signing out while connected stops reporting a live connection', async () => {
  const { auth, view, element } = await setupProvider();
  act(() => socket(0).serverOpens());
  assert.equal(isConnected, true);
  await act(async () => {
    await auth.clearAuthToken(auth.getAuthSessionSnapshot());
    AUTH.current = { user: null, token: null, isLoading: false };
    view.rerender(element());
  });
  assert.equal(socket(0).readyState, FakeWebSocket.CLOSED, 'the socket was closed on sign-out');
  assert.equal(lastStatus(), 'connecting');
  assert.equal(isConnected, false, 'the closed socket is no longer reported as live');
});

test('platform mode fails closed without a revocable authenticated session', async () => {
  vi.stubEnv('VITE_IS_PLATFORM', 'true');
  AUTH.current = { user: AUTH.user, token: null, isLoading: false };
  const { auth, getContext } = await setupProvider(false);
  assert.equal(auth.getAuthSessionSnapshot().phase, 'signedOut');
  assert.equal(FakeWebSocket.instances.length, 0);
  assert.equal(isConnected, false);
  assert.throws(() => getContext().sendMessage({ type: 'platform.test' }), /连接已断开/);
});
