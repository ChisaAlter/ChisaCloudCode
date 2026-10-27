import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { WebSocketProvider } from '@/shared/context/WebSocketContext';
import { clearAuthToken, startAuthSession } from '@/shared/authToken';

const account = vi.hoisted(() => ({ value: { user: { id: 1, username: 'a' } as { id: number; username: string } | null, token: 'accounta.payload.signature', isLoading: false } }));
const native = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('@/modules/auth', () => ({ useAuth: () => account.value }));
vi.mock('mygo-runtime', () => native);
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const constructed: string[] = [];
class MockSocket {
  static OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: unknown) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
  send = vi.fn();
  constructor(url: string) { constructed.push(url); }
}
beforeEach(() => {
  constructed.length = 0;
  vi.resetAllMocks();
  vi.stubGlobal('mygo', {}); vi.stubGlobal('WebSocket', MockSocket);
  account.value = { user: { id: 1, username: 'a' }, token: 'accounta.payload.signature', isLoading: false };
  startAuthSession(account.value.token);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test('desktop websocket acquires the account URL after login instead of using an earlier cache', async () => {
  native.call.mockResolvedValue({ configured: true, version: 1, webSocketUrl: 'ws://127.0.0.1/account-a' });
  render(<WebSocketProvider><p>workspace</p></WebSocketProvider>);
  await waitFor(() => expect(constructed).toEqual(['ws://127.0.0.1/account-a/ws?token=accounta.payload.signature']));
  expect(native.call).toHaveBeenCalledWith('FrontendBridge.GetApiConnection');
});

test('account switch during pending URL lookup cannot open a stale authenticated websocket', async () => {
  const old = deferred<{ configured: boolean; version: number; webSocketUrl: string }>();
  native.call.mockReturnValueOnce(old.promise).mockResolvedValue({ configured: true, version: 2, webSocketUrl: 'ws://127.0.0.1/account-b' });
  const view = render(<WebSocketProvider><p>workspace</p></WebSocketProvider>);
  await waitFor(() => expect(native.call).toHaveBeenCalledTimes(1));
  act(() => { clearAuthToken(); startAuthSession('accountb.payload.signature'); account.value = { user: { id: 2, username: 'b' }, token: 'accountb.payload.signature', isLoading: false }; });
  view.rerender(<WebSocketProvider><p>workspace</p></WebSocketProvider>);
  await waitFor(() => expect(constructed).toHaveLength(1));
  await act(async () => { old.resolve({ configured: true, version: 1, webSocketUrl: 'ws://127.0.0.1/account-a' }); });
  expect(constructed).toEqual(['ws://127.0.0.1/account-b/ws?token=accountb.payload.signature']);
});

test('unmount while native URL is pending never creates a socket or schedules reconnect', async () => {
  const old = deferred<{ configured: boolean; webSocketUrl: string }>();
  native.call.mockReturnValue(old.promise);
  const view = render(<WebSocketProvider><p>workspace</p></WebSocketProvider>);
  view.unmount();
  await act(async () => { old.resolve({ configured: true, webSocketUrl: 'ws://127.0.0.1/late' }); });
  expect(constructed).toEqual([]);
});
