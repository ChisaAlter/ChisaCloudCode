import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import type { SessionStore } from '@/modules/chat/hooks/useSessionStore';
import type { ChatReplayCursor, ChatStreamBuffer, ProjectSession, ServerEvent } from '@/shared/types';

afterEach(cleanup);

function mountHandlers() {
  let listener: ((event: ServerEvent) => void) | null = null;
  const idle = vi.fn();
  const append = vi.fn();
  const cursors = { current: new Map<string, ChatReplayCursor>() };
  renderHook(() => useChatRealtimeHandlers({
    isActive: true,
    subscribe: callback => { listener = callback; return () => { listener = null; }; },
    provider: 'claude',
    selectedSession: { id: 'viewed-session' } as ProjectSession,
    currentSessionId: 'viewed-session',
    setTokenBudget: vi.fn(),
    pendingPermissionRequests: [],
    setPendingPermissionRequests: vi.fn(),
    streamBuffersRef: { current: new Map() },
    replayCursorsRef: cursors,
    statusCheckSentAtRef: { current: new Map([['viewed-session', 10]]) },
    onSessionIdle: idle,
    requestLatestMessages: async () => {},
    sessionStore: { appendRealtime: append, finalizeStreaming: vi.fn() } as unknown as SessionStore,
  }));
  return {
    idle, append, cursors,
    dispatch: (event: ServerEvent) => { act(() => { listener?.(event); }); },
  };
}

test.each(['CHAT_ABORT_FAILED', 'RUN_IN_PROGRESS'])('%s shows the request failure without unlocking the existing run', code => {
  const { idle, append, dispatch } = mountHandlers();
  dispatch({ kind: 'protocol_error', sessionId: 'viewed-session', code, error: 'Task still running or finalizing' });
  expect(idle).not.toHaveBeenCalled();
  expect(append).toHaveBeenCalledWith('viewed-session', expect.objectContaining({
    kind: 'error', content: 'Task still running or finalizing',
  }));
  dispatch({ kind: 'complete', sessionId: 'viewed-session', aborted: true });
  expect(idle).toHaveBeenCalledExactlyOnceWith('viewed-session', { runId: undefined });
});

test('a later authoritative idle acknowledgement can settle an unsuccessful stop', () => {
  const { idle, dispatch } = mountHandlers();
  dispatch({ kind: 'protocol_error', sessionId: 'viewed-session', code: 'CHAT_ABORT_FAILED', error: 'Task still finalizing' });
  dispatch({ kind: 'chat_subscribed', sessionId: 'viewed-session', isProcessing: false, pendingPermissions: [] });
  expect(idle).toHaveBeenCalledExactlyOnceWith('viewed-session', { ifStartedBefore: 10 });
});

test('a rejected new request without a live run still settles the local pending state', () => {
  const { idle, dispatch } = mountHandlers();
  dispatch({ kind: 'protocol_error', sessionId: 'viewed-session', code: 'UNSUPPORTED_PROVIDER', error: 'Provider unavailable' });
  expect(idle).toHaveBeenCalledExactlyOnceWith('viewed-session');
});

test('a subscription to a restarted server resets the cursor used by the next reconnect', () => {
  const { dispatch, cursors } = mountHandlers();
  cursors.current.set('viewed-session', { replayEpoch: 'old-server', runId: 'old-run', seq: 200 });
  dispatch({ kind: 'chat_subscribed', sessionId: 'viewed-session', replayEpoch: 'new-server', runId: 'new-run', isProcessing: true, lastSeq: 2, pendingPermissions: [] });
  expect(cursors.current.get('viewed-session')).toEqual({ replayEpoch: 'new-server', runId: 'new-run', seq: 0 });
  dispatch({ kind: 'text', sessionId: 'viewed-session', replayEpoch: 'new-server', runId: 'new-run', seq: 3, content: 'new server reply' });
  expect(cursors.current.get('viewed-session')?.seq).toBe(3);
});

test('subscription acknowledgements do not pre-consume a replay interrupted by another disconnect', () => {
  const { dispatch, cursors } = mountHandlers();
  cursors.current.set('viewed-session', { replayEpoch: 'same-server', runId: 'run', seq: 90 });
  dispatch({ kind: 'chat_subscribed', sessionId: 'viewed-session', replayEpoch: 'same-server', runId: 'run', isProcessing: true, lastSeq: 100 });
  expect(cursors.current.get('viewed-session')?.seq).toBe(90);
  for (let seq = 91; seq <= 95; seq++) dispatch({ kind: 'text', sessionId: 'viewed-session', replayEpoch: 'same-server', runId: 'run', seq });
  expect(cursors.current.get('viewed-session')?.seq).toBe(95);
});

test('a different server epoch invalidates an equal numeric cursor before replay', () => {
  const { dispatch, cursors } = mountHandlers();
  cursors.current.set('viewed-session', { replayEpoch: 'old-server', runId: 'old-run', seq: 2 });
  dispatch({ kind: 'chat_subscribed', sessionId: 'viewed-session', replayEpoch: 'new-server', runId: 'new-run', isProcessing: true, lastSeq: 2 });
  expect(cursors.current.get('viewed-session')?.seq).toBe(0);
  dispatch({ kind: 'text', sessionId: 'viewed-session', replayEpoch: 'new-server', runId: 'new-run', seq: 1, role: 'user', content: 'queued input' });
  expect(cursors.current.get('viewed-session')?.seq).toBe(1);
});

test('a background queued turn cannot mix text into or clear the viewed stream', () => {
  let listener: ((event: ServerEvent) => void) | null = null;
  const streams = { current: new Map<string, ChatStreamBuffer>() };
  const cursors = { current: new Map<string, ChatReplayCursor>() };
  const { result } = renderHook(() => {
    const sessionStore = useSessionStore();
    useChatRealtimeHandlers({
      isActive: true, subscribe: callback => { listener = callback; return () => { listener = null; }; },
      provider: 'claude', selectedSession: { id: 'viewed-session' } as ProjectSession, currentSessionId: 'viewed-session',
      setTokenBudget: vi.fn(), pendingPermissionRequests: [], setPendingPermissionRequests: vi.fn(),
      streamBuffersRef: streams, replayCursorsRef: cursors,
      statusCheckSentAtRef: { current: new Map() }, requestLatestMessages: async () => {}, sessionStore,
    });
    return sessionStore;
  });
  act(() => {
    listener?.({ kind: 'stream_delta', sessionId: 'background-session', provider: 'codex', content: 'background' });
    listener?.({ kind: 'stream_delta', sessionId: 'viewed-session', content: 'viewed' });
    listener?.({ kind: 'complete', sessionId: 'background-session', aborted: true });
    listener?.({ kind: 'stream_end', sessionId: 'viewed-session' });
  });
  expect(result.current.getMessages('background-session').map(row => row.content)).toEqual(['background']);
  expect(result.current.getMessages('background-session')[0]?.provider).toBe('codex');
  expect(result.current.getMessages('viewed-session').map(row => row.content)).toEqual(['viewed']);
  expect(streams.current.size).toBe(0);
});
