import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { acknowledgeAuthSession, getAuthSessionSnapshot, initializeAuthSession, startAuthSession } from '@/shared/authToken';
import { useShellConnection } from '@/modules/shell/hooks/useShellConnection';
import { sendSocketMessage } from '@/modules/shell/utils/socket';
import type { Project } from '@/shared/types';

const admission = vi.hoisted(() => ({ url: vi.fn() }));
vi.mock('@/shared/webSocketAdmission', () => ({ resolveWebSocketAdmissionUrl: admission.url }));

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => { this.readyState = 3; this.onclose?.(); });
  constructor(readonly url: string) { Socket.instances.push(this); }
}
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value) }; }
function mount() {
  const wsRef = { current: null as WebSocket | null };
  const view = renderHook(() => useShellConnection({
    wsRef, terminalRef: { current: null }, fitAddonRef: { current: null }, selectedProjectRef: { current: {} as Project },
    selectedSessionRef: { current: null }, initialCommandRef: { current: null }, isPlainShellRef: { current: false },
    bypassPermissionsRef: { current: false }, isDarkModeRef: { current: false }, onProcessCompleteRef: { current: null },
    isInitialized: true, autoConnect: false, closeSocket: () => { wsRef.current?.close(); wsRef.current = null; }, clearTerminalScreen: () => {},
  }));
  return { ...view, wsRef };
}
beforeEach(async () => {
  vi.resetAllMocks(); Socket.instances = []; vi.stubGlobal('WebSocket', Socket);
  await initializeAuthSession(); await startAuthSession('shell.one.signature'); acknowledgeAuthSession(getAuthSessionSnapshot());
  admission.url.mockResolvedValue('ws://localhost/shell?ticket=opaque');
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test('shell waits for its ticket and account replacement discards a late admission', async () => {
  const pending = deferred<string>(); admission.url.mockReturnValue(pending.promise); const view = mount();
  act(() => view.result.current.connectToShell()); expect(Socket.instances).toHaveLength(0);
  await act(async () => { await startAuthSession('shell.two.signature'); acknowledgeAuthSession(getAuthSessionSnapshot()); });
  await act(async () => pending.resolve('ws://localhost/shell?ticket=old'));
  expect(Socket.instances).toHaveLength(0); expect(view.result.current.isConnecting).toBe(false);
});

test('disconnect and unmount invalidate pending admissions before socket creation', async () => {
  for (const stop of ['disconnect', 'unmount']) {
    const pending = deferred<string>(); admission.url.mockReturnValue(pending.promise); const view = mount();
    act(() => view.result.current.connectToShell());
    if (stop === 'disconnect') act(() => view.result.current.disconnectFromShell({ suppressAutoConnect: true })); else view.unmount();
    await act(async () => pending.resolve('ws://localhost/shell?ticket=old'));
    expect(Socket.instances).toHaveLength(0); view.unmount();
  }
});

test('a connecting shell closes on identity replacement and direct input cannot cross that boundary', async () => {
  const view = mount(); await act(async () => view.result.current.connectToShell());
  const socket = Socket.instances[0]; expect(socket.url).not.toContain('shell.one.signature');
  socket.readyState = Socket.OPEN; act(() => socket.onopen?.());
  sendSocketMessage(socket as unknown as WebSocket, { type: 'input', data: 'before' }); expect(socket.send).toHaveBeenCalledTimes(1);
  await act(async () => { await startAuthSession('shell.two.signature'); acknowledgeAuthSession(getAuthSessionSnapshot()); });
  expect(socket.close).toHaveBeenCalled();
  sendSocketMessage(socket as unknown as WebSocket, { type: 'input', data: 'after' }); expect(socket.send).toHaveBeenCalledTimes(1);
  expect(view.wsRef.current).toBeNull(); expect(view.result.current.isConnected).toBe(false);
});
