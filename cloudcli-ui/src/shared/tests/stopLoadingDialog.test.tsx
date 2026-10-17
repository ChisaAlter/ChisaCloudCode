import React, { useRef, useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { WebSocketProvider, useWebSocket } from '@/shared/context/WebSocketContext';
import { BlockingOperationDialog } from '@/shared/ui/BlockingOperationDialog';
import { SessionProtectionProvider, useProcessingSessions, useSessionProtectionActions } from '@/shared/context/SessionProtectionContext';
import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';

const auth = vi.hoisted(() => ({ token: 'fixture', user: { id: 1 }, isLoading: false }));
const runningSessions = vi.hoisted(() => vi.fn());
vi.mock('@/shared/api', () => ({ api: { runningSessions } }));
vi.mock('@/modules/auth', () => ({ useAuth: () => auth }));
vi.mock('@/shared/authToken', () => ({ AUTH_IDENTITY_CHANGED_EVENT: 'auth-identity-changed', expireAuthSession: vi.fn(), isAuthTokenExpired: () => false }));
vi.mock('@/shared/chisa', () => ({ subscribeWorkspaceSynchronization: () => () => {} }));

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

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); FixtureSocket.instances = []; runningSessions.mockReset(); auth.token = 'fixture'; auth.user = { id: 1 }; });

test('changing account identity clears pending stops and old socket callbacks before the new account connects', () => {
  vi.stubGlobal('WebSocket', FixtureSocket);
  const content = <WebSocketProvider><Controls /><BlockingOperationDialog /></WebSocketProvider>;
  const view = render(content);
  const previous = FixtureSocket.instances[0]!;
  act(() => previous.onopen?.());
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
  expect(screen.getByRole('status').textContent).toContain('正在停止任务');
  act(() => window.dispatchEvent(new Event('auth-identity-changed')));
  expect(screen.queryByRole('status')).toBeNull();
  expect(previous.close).toHaveBeenCalledOnce();
  expect(previous.onmessage).toBeNull();
  expect(previous.onclose).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
  expect(screen.getByRole('alert').textContent).toContain('聊天连接已断开');
  auth.user = { id: 2 };
  auth.token = 'second-account';
  view.rerender(<WebSocketProvider><Controls /><BlockingOperationDialog /></WebSocketProvider>);
  const next = FixtureSocket.instances.at(-1)!;
  expect(next).not.toBe(previous);
  act(() => next.onopen?.());
  expect(next.send).not.toHaveBeenCalled();
  expect(screen.queryByRole('status')).toBeNull();
});

test('ordinary token rotation reconnects with the same pending stop until its terminal acknowledgement', () => {
  vi.stubGlobal('WebSocket', FixtureSocket);
  const view = render(<WebSocketProvider><Controls /><BlockingOperationDialog /></WebSocketProvider>);
  const previous = FixtureSocket.instances[0]!;
  act(() => previous.onopen?.());
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
  auth.token = 'rotated-token';
  view.rerender(<WebSocketProvider><Controls /><BlockingOperationDialog /></WebSocketProvider>);
  const next = FixtureSocket.instances.at(-1)!;
  expect(next).not.toBe(previous);
  act(() => next.onopen?.());
  expect(next.send).toHaveBeenCalledWith(JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId: 'active' }] }));
  expect(screen.getByRole('status').textContent).toContain('正在停止任务');
  act(() => next.onmessage?.({ data: JSON.stringify({ kind: 'complete', sessionId: 'active', aborted: true }) }));
  expect(screen.queryByRole('status')).toBeNull();
});

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
    <p data-testid="activity" data-model-stopped={activity?.modelStopped} data-run-id={activity?.runId}>{activity ? `${activity.statusText}:${activity.canInterrupt}` : 'idle'}</p></>;
}

function RuntimeEvents() {
  const { subscribe } = useWebSocket();
  const { markSessionProcessing, markSessionIdle } = useSessionProtectionActions();
  const streams = useRef(new Map());
  const cursors = useRef(new Map());
  const store = useSessionStore();
  useChatRealtimeHandlers({
    isActive: true, provider: 'claude', selectedSession: { id: 'active' }, currentSessionId: 'active', subscribe,
    setTokenBudget: () => {}, pendingPermissionRequests: [], setPendingPermissionRequests: () => {},
    streamBuffersRef: streams, replayCursorsRef: cursors, statusCheckSentAtRef: useRef(new Map()),
    onSessionProcessing: markSessionProcessing, onSessionIdle: markSessionIdle,
    requestLatestMessages: async () => {}, sessionStore: store,
  });
  return null;
}

function mountPolledStop() {
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', FixtureSocket);
  render(<WebSocketProvider><SessionProtectionProvider><Controls /><RuntimeEvents /><ProcessingProbe /><BlockingOperationDialog /></SessionProtectionProvider></WebSocketProvider>);
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

test.each(['status', 'chat_subscribed'])('%s confirms model stop without unlocking file handback or the composer', async kind => {
  const running = { sessionId: 'active', runId: 'run-a', statusText: 'workspace_finalizing', modelStopped: true, canInterrupt: false };
  runningSessions.mockImplementation(async () => Response.json({ data: { sessions: [running] } }));
  mountPolledStop();
  const socket = FixtureSocket.instances[0]!;
  act(() => socket.onmessage?.({ data: JSON.stringify({
    kind, sessionId: 'active', runId: 'run-a', text: 'model_stopped', modelStopped: true, isProcessing: true, canInterrupt: false,
  }) }));
  expect(screen.queryByRole('status')).toBeNull();
  act(() => socket.onmessage?.({ data: JSON.stringify({ kind: 'status', sessionId: 'active', runId: 'run-a', seq: 2, text: 'workspace_finalizing', canInterrupt: false }) }));
  const input = screen.getByRole('textbox') as HTMLInputElement;
  fireEvent.change(input, { target: { value: 'next draft during handback' } });
  expect(input.value).toBe('next draft during handback');
  expect(input.disabled).toBe(false);
  expect(screen.getByTestId('activity').textContent).toBe('workspace_finalizing:false');
  expect(screen.getByTestId('activity').getAttribute('data-model-stopped')).toBe('true');
  expect(socket.send.mock.calls.map(([frame]) => JSON.parse(frame).type)).toEqual(['chat.abort']);
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(screen.getByTestId('activity').textContent).toBe('workspace_finalizing:false');
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('a stopped running snapshot settles a lost stop acknowledgement while retaining handback protection', async () => {
  runningSessions.mockResolvedValueOnce(Response.json({ data: { sessions: [{ sessionId: 'active', runId: 'run-a', statusText: 'workspace_finalizing' }] } }))
    .mockImplementation(async () => Response.json({ data: { sessions: [{ sessionId: 'active', runId: 'run-a', statusText: 'workspace_finalizing', modelStopped: true }] } }));
  mountPolledStop();
  expect(screen.getByRole('status').textContent).toContain('正在停止任务');
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.getByTestId('activity').textContent).toBe('workspace_finalizing:false');
  expect(screen.getByTestId('activity').getAttribute('data-model-stopped')).toBe('true');
});

test.each(['running', 'completed'] as const)('a delayed previous-run HTTP snapshot cannot replace a newer %s socket run', async phase => {
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', FixtureSocket);
  let finishOldSnapshot!: (response: Response) => void;
  runningSessions.mockImplementationOnce(() => new Promise<Response>(resolve => { finishOldSnapshot = resolve; }))
    .mockImplementation(async () => Response.json({ data: { sessions: [{
      sessionId: 'active', runId: 'run-c', statusText: 'Thinking', canInterrupt: true, modelStopped: false,
    }] } }));
  render(<WebSocketProvider><SessionProtectionProvider><Controls /><RuntimeEvents /><ProcessingProbe /><BlockingOperationDialog /></SessionProtectionProvider></WebSocketProvider>);
  const socket = FixtureSocket.instances[0]!;
  act(() => socket.onopen?.());
  act(() => socket.onmessage?.({ data: JSON.stringify({
    kind: 'status', sessionId: 'active', runId: 'run-b', seq: 1, text: 'Thinking', canInterrupt: true,
  }) }));
  if (phase === 'completed') {
    act(() => socket.onmessage?.({ data: JSON.stringify({ kind: 'complete', sessionId: 'active', runId: 'run-b', seq: 2, aborted: true }) }));
  }
  await act(async () => { finishOldSnapshot(Response.json({ data: { sessions: [{
    sessionId: 'active', runId: 'run-a', statusText: 'workspace_finalizing', modelStopped: true, canInterrupt: false,
  }] } })); });
  expect(screen.getByTestId('activity').textContent).toBe(phase === 'running' ? 'Thinking:true' : 'idle');
  expect(screen.getByTestId('activity').getAttribute('data-run-id')).toBe(phase === 'running' ? 'run-b' : null);
  if (phase === 'running') {
    // B's real terminal frame must still match the activity after the old A response.
    act(() => socket.onmessage?.({ data: JSON.stringify({ kind: 'complete', sessionId: 'active', runId: 'run-b', seq: 2, aborted: true }) }));
    expect(screen.getByTestId('activity').textContent).toBe('idle');
  }
  // A later request that started after those socket events may discover a genuinely new run.
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(screen.getByTestId('activity').textContent).toBe('Thinking:true');
  expect(screen.getByTestId('activity').getAttribute('data-run-id')).toBe('run-c');
  act(() => socket.onmessage?.({ data: JSON.stringify({
    kind: 'chat_subscribed', sessionId: 'active', runId: 'run-c', isProcessing: true, modelStopped: false,
  }) }));
  act(() => socket.onmessage?.({ data: JSON.stringify({ kind: 'status', sessionId: 'active', runId: 'run-c', seq: 3, text: 'model_stopped', canInterrupt: false }) }));
  // An older same-run reply cannot undo process exit, even when it says the model is running.
  act(() => socket.onmessage?.({ data: JSON.stringify({
    kind: 'chat_subscribed', sessionId: 'active', runId: 'run-c', isProcessing: true, modelStopped: false,
  }) }));
  expect(screen.getByTestId('activity').getAttribute('data-model-stopped')).toBe('true');
  expect(screen.getByTestId('activity').textContent).toBe('model_stopped:false');
  act(() => socket.onmessage?.({ data: JSON.stringify({ kind: 'complete', sessionId: 'active', runId: 'run-c', seq: 4, aborted: true }) }));
  expect(screen.getByTestId('activity').textContent).toBe('idle');
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
