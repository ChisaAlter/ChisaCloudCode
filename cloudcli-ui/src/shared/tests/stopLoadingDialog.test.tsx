import React, { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { WebSocketProvider, useWebSocket } from '@/shared/context/WebSocketContext';
import { BlockingOperationDialog } from '@/shared/ui/BlockingOperationDialog';
import { SessionProtectionProvider, useProcessingSessions, useSessionProtectionActions } from '@/shared/context/SessionProtectionContext';

const auth = vi.hoisted(() => ({ token: 'fixture', user: { id: 1 }, isLoading: false }));
const runningSessions = vi.hoisted(() => vi.fn());
vi.mock('@/shared/api', () => ({ api: { runningSessions } }));
vi.mock('@/modules/auth', () => ({ useAuth: () => auth }));
vi.mock('@/shared/authToken', () => ({ expireAuthSession: vi.fn(), getAuthSessionVersion: () => 0, isAuthTokenExpired: () => false }));

class FixtureSocket {
  static OPEN = 1;
  static instances: FixtureSocket[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror = null;
  send = vi.fn();
  close = vi.fn();
  constructor() { FixtureSocket.instances.push(this); }
}

function Controls() {
  const { sendMessage } = useWebSocket();
  const [error, setError] = useState('');
  return <><button onClick={() => {
    try { sendMessage({ type: 'chat.abort', sessionId: 'active' }); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
  }}>Stop</button><input aria-label="Next message" />{error && <p role="alert">{error}</p>}</>;
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); FixtureSocket.instances = []; runningSessions.mockReset(); });

test('stop stays nonblocking until the matching session is confirmed stopped', () => {
  vi.stubEnv('VITE_IS_PLATFORM', 'true');
  vi.stubGlobal('WebSocket', FixtureSocket);
  render(<WebSocketProvider><Controls /><BlockingOperationDialog /></WebSocketProvider>);
  const socket = FixtureSocket.instances[0]!;
  act(() => socket.onopen?.());
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByRole('status').textContent).toContain('正在停止任务');
  const input = screen.getByRole('textbox');
  input.focus();
  fireEvent.change(input, { target: { value: 'Draft while stopping' } });
  expect((input as HTMLInputElement).value).toBe('Draft while stopping');
  expect(input.closest<HTMLElement>('body > div')?.inert).toBeFalsy();
  act(() => socket.onmessage?.({ data: JSON.stringify({ kind: 'complete', sessionId: 'other' }) }));
  expect(screen.getByRole('status')).toBeDefined();
  act(() => socket.onmessage?.({ data: JSON.stringify({ kind: 'complete', sessionId: 'active', aborted: true }) }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryByRole('status')).toBeNull();
});

test('a stop protocol failure releases loading so the existing error UI can be used', () => {
  vi.stubEnv('VITE_IS_PLATFORM', 'true');
  vi.stubGlobal('WebSocket', FixtureSocket);
  render(<WebSocketProvider><Controls /><BlockingOperationDialog /></WebSocketProvider>);
  const socket = FixtureSocket.instances[0]!;
  act(() => socket.onopen?.());
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
  act(() => socket.onmessage?.({ data: JSON.stringify({ kind: 'protocol_error', sessionId: 'active', code: 'CHAT_ABORT_FAILED' }) }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryByRole('status')).toBeNull();
});

test('a closed socket rejects stop visibly without creating a false pending-stop notice', () => {
  vi.stubGlobal('WebSocket', FixtureSocket);
  render(<WebSocketProvider><Controls /><BlockingOperationDialog /></WebSocketProvider>);
  const socket = FixtureSocket.instances[0]!;
  socket.readyState = 3;
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
  expect(socket.send).not.toHaveBeenCalled();
  expect(screen.getByRole('alert').textContent).toContain('聊天连接已断开');
  expect(screen.queryByRole('status')).toBeNull();
});

test('a failed stop retry does not erase an earlier stop still awaiting acknowledgement', () => {
  vi.stubGlobal('WebSocket', FixtureSocket);
  render(<WebSocketProvider><Controls /><BlockingOperationDialog /></WebSocketProvider>);
  const socket = FixtureSocket.instances[0]!;
  act(() => socket.onopen?.());
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
  socket.send.mockImplementationOnce(() => { throw new Error('socket write failed'); });
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
  expect(screen.getByRole('status').textContent).toContain('正在停止任务');
  expect(screen.getByRole('alert').textContent).toContain('socket write failed');
  act(() => socket.onmessage?.({ data: JSON.stringify({ kind: 'complete', sessionId: 'active', aborted: true }) }));
  expect(screen.queryByRole('status')).toBeNull();
});

function ProcessingProbe() {
  const activities = useProcessingSessions();
  const { markSessionProcessing } = useSessionProtectionActions();
  const activity = activities.get('active');
  return <><button onClick={() => markSessionProcessing('active', { statusText: 'workspace_finalizing' })}>Hand back files</button>
    <p data-testid="activity">{activity ? `${activity.statusText}:${activity.canInterrupt}` : 'idle'}</p></>;
}

function mountPolledStop() {
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', FixtureSocket);
  render(<WebSocketProvider><SessionProtectionProvider><Controls /><ProcessingProbe /><BlockingOperationDialog /></SessionProtectionProvider></WebSocketProvider>);
  act(() => FixtureSocket.instances[0]!.onopen?.());
  fireEvent.click(screen.getByRole('button', { name: 'Hand back files' }));
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
}

test('file handback stays busy until a successful idle snapshot settles a lost terminal frame', async () => {
  runningSessions.mockResolvedValueOnce(Response.json({ data: { sessions: [{ sessionId: 'active', statusText: 'workspace_finalizing' }] } }))
    .mockResolvedValueOnce(Response.json({ data: { sessions: [{ sessionId: 'active', statusText: 'workspace_finalizing' }] } }))
    .mockResolvedValue(Response.json({ data: { sessions: [] } }));
  mountPolledStop();
  const input = screen.getByRole('textbox') as HTMLInputElement;
  fireEvent.change(input, { target: { value: 'saved draft while stopping' } });
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(screen.getByRole('status').textContent).toContain('正在停止任务');
  expect(screen.getByTestId('activity').textContent).toBe('workspace_finalizing:false');
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.getByTestId('activity').textContent).toBe('idle');
  expect(screen.getByRole('textbox')).toBe(input);
  expect(input.value).toBe('saved draft while stopping');
});

test.each([{}, { sessions: [{}] }, { sessions: [{ sessionId: 123 }] }, { sessions: [{ sessionId: ' ' }] }, { sessions: [null] }])('failed or malformed running snapshot %j cannot acknowledge a pending stop', async (data) => {
  runningSessions.mockResolvedValueOnce(Response.json({ data: { sessions: [{ sessionId: 'active' }] } }))
    .mockResolvedValueOnce(new Response('', { status: 499 }))
    .mockResolvedValue(Response.json({ data }));
  mountPolledStop();
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(screen.getByRole('status').textContent).toContain('正在停止任务');
  expect(screen.getByTestId('activity').textContent).toBe('workspace_finalizing:false');
});

test('an idle snapshot requested before stop cannot settle it when its response arrives late', async () => {
  let finishOldSnapshot!: (response: Response) => void;
  runningSessions.mockImplementationOnce(() => new Promise<Response>(resolve => { finishOldSnapshot = resolve; }))
    .mockResolvedValue(Response.json({ data: { sessions: [] } }));
  mountPolledStop();
  vi.setSystemTime(Date.now() + 12000);
  await act(async () => { finishOldSnapshot(Response.json({ data: { sessions: [] } })); });
  expect(screen.getByRole('status').textContent).toContain('正在停止任务');
  expect(screen.getByTestId('activity').textContent).toBe('workspace_finalizing:false');
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(screen.queryByRole('status')).toBeNull();
});

test('an older running snapshot cannot revive a stop that a newer idle snapshot already settled', async () => {
  let finishOldSnapshot!: (response: Response) => void;
  runningSessions.mockImplementationOnce(() => new Promise<Response>(resolve => { finishOldSnapshot = resolve; }))
    .mockResolvedValue(Response.json({ data: { sessions: [] } }));
  mountPolledStop();
  vi.setSystemTime(Date.now() + 12000);
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.getByTestId('activity').textContent).toBe('idle');
  await act(async () => { finishOldSnapshot(Response.json({ data: { sessions: [{ sessionId: 'active', statusText: 'workspace_finalizing' }] } })); });
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.getByTestId('activity').textContent).toBe('idle');
});
