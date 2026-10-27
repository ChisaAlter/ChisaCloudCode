import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import { useSessionProtection } from '@/shared/hooks/useSessionProtection';
import type { LLMProvider, ProjectSession, ServerEvent } from '@/shared/types';

vi.mock('@/shared/utils', () => ({
  playChatCompletionSound: vi.fn(),
  playNotificationSound: vi.fn(),
}));
vi.mock('@/modules/chat/utils/pageTitleNotification', () => ({
  showCompletionTitleIndicator: vi.fn(),
}));

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const renderHandlers = () => {
  let listener: ((event: ServerEvent) => void) | null = null;
  const subscribe = (next: (event: ServerEvent) => void) => {
    listener = next;
    return () => { listener = null; };
  };
  const idle = vi.fn();
  const requestLatestMessages = vi.fn(async () => {});
  const onWebSocketReconnect = vi.fn();
  const statusCheckSentAt = new Map<string, number>();

  const view = renderHook(({ sessionId }) => {
    const sessionStore = useSessionStore();
    const sessionProtection = useSessionProtection();
    const lastSeqRef = useRef(new Map<string, number>());
    const cursorRunIdRef = useRef(new Map<string, string>());
    const statusCheckSentAtRef = useRef(statusCheckSentAt);
    sessionStore.setActiveSession(sessionId);
    useChatRealtimeHandlers({
      isActive: true,
      subscribe,
      provider: 'claude',
      selectedSession: { id: sessionId } as ProjectSession,
      currentSessionId: sessionId,
      setTokenBudget: () => {},
      pendingPermissionRequests: [],
      setPendingPermissionRequests: () => {},
      lastSeqRef,
      cursorRunIdRef,
      statusCheckSentAtRef,
      onSessionProcessing: sessionProtection.markSessionProcessing,
      onSessionIdle: (id, options) => {
        idle(id, options);
        sessionProtection.markSessionIdle(id, options);
      },
      onWebSocketReconnect,
      requestLatestMessages,
      sessionStore,
    });
    return { ...sessionStore, ...sessionProtection, lastSeq: lastSeqRef.current, cursorRunId: cursorRunIdRef.current };
  }, { initialProps: { sessionId: 'viewed-session' } });

  const dispatch = (event: ServerEvent) => act(() => listener?.(event));
  const contents = (sessionId: string) => view.result.current.getMessages(sessionId).map((message) => message.content);
  const reconnect = (sessionId: string) => {
    statusCheckSentAt.set(sessionId, Date.now());
    dispatch({ kind: 'websocket_reconnected' });
  };
  return { ...view, dispatch, contents, idle, requestLatestMessages, reconnect, onWebSocketReconnect };
};

const delta = (sessionId: string, content: string, provider: LLMProvider = 'claude'): ServerEvent => ({
  kind: 'stream_delta', sessionId, content, provider,
});

test('interleaved sessions keep their streamed text in separate accumulated rows', () => {
  const view = renderHandlers();
  view.dispatch(delta('viewed-session', 'Visible reply'));
  view.dispatch(delta('background-session', '{"tool_input":'));
  view.dispatch(delta('background-session', '"background"}'));
  act(() => vi.advanceTimersByTime(100));

  assert.deepEqual(view.contents('viewed-session'), ['Visible reply']);
  assert.deepEqual(view.contents('background-session'), ['{"tool_input":"background"}']);
});

for (const kind of ['stream_end', 'complete']) {
  test(`a background ${kind} cannot clear or finalize the viewed stream`, () => {
    const view = renderHandlers();
    view.dispatch(delta('viewed-session', 'Hello '));
    view.dispatch(delta('background-session', 'Background reply'));
    view.dispatch({ kind, sessionId: 'background-session', success: true });
    view.dispatch(delta('viewed-session', 'world'));
    view.dispatch({ kind: 'stream_end', sessionId: 'viewed-session' });
    act(() => vi.advanceTimersByTime(100));

    assert.deepEqual(view.contents('viewed-session'), ['Hello world']);
    assert.deepEqual(view.contents('background-session'), ['Background reply']);
    assert.ok(view.result.current.getMessages('viewed-session').every((message) => message.kind === 'text'));
    assert.ok(view.result.current.getMessages('background-session').every((message) => message.kind === 'text'));
  });
}

test('background completion leaves the scheduled viewed-stream update running', () => {
  const view = renderHandlers();
  view.dispatch(delta('viewed-session', 'Visible reply'));
  view.dispatch(delta('background-session', 'Background reply'));
  view.dispatch({ kind: 'complete', sessionId: 'background-session', success: true });
  act(() => vi.advanceTimersByTime(100));

  assert.deepEqual(view.contents('viewed-session'), ['Visible reply']);
  assert.equal(view.result.current.getMessages('viewed-session')[0].kind, 'stream_delta');
  assert.deepEqual(view.contents('background-session'), ['Background reply']);
});

test('switching the viewed session preserves each in-flight accumulated reply', () => {
  const view = renderHandlers();
  view.dispatch(delta('viewed-session', 'First '));
  view.rerender({ sessionId: 'background-session' });
  view.dispatch(delta('background-session', 'Second reply'));
  view.dispatch(delta('viewed-session', 'reply'));
  view.dispatch({ kind: 'stream_end', sessionId: 'viewed-session' });
  view.dispatch({ kind: 'stream_end', sessionId: 'background-session' });
  act(() => vi.advanceTimersByTime(100));

  assert.deepEqual(view.contents('viewed-session'), ['First reply']);
  assert.deepEqual(view.contents('background-session'), ['Second reply']);
});

for (const flushBeforeDisconnect of [false, true]) {
  test(`idle reconnect starts the next reply without ${flushBeforeDisconnect ? 'flushed' : 'pending'} text from the offline-completed run`, () => {
    const view = renderHandlers();
    view.dispatch({ kind: 'status', sessionId: 'viewed-session', text: 'working' });
    view.dispatch(delta('viewed-session', 'Before disconnect', 'codex'));
    act(() => vi.advanceTimersByTime(flushBeforeDisconnect ? 100 : 1));

    // The run completes offline, so reconnect gets no replayed terminal event.
    view.reconnect('viewed-session');
    view.dispatch({ kind: 'chat_subscribed', sessionId: 'viewed-session', isProcessing: false, pendingPermissions: [] });
    assert.equal(view.onWebSocketReconnect.mock.calls.length, 1);
    assert.equal(view.result.current.isSessionProcessing('viewed-session'), false);

    view.dispatch(delta('viewed-session', 'Next reply'));
    act(() => vi.advanceTimersByTime(100));

    assert.deepEqual(view.contents('viewed-session'), ['Before disconnect', 'Next reply']);
    assert.deepEqual(view.result.current.getMessages('viewed-session').map((message) => message.kind), ['text', 'stream_delta']);
    assert.deepEqual(view.result.current.getMessages('viewed-session').map((message) => message.provider), ['codex', 'claude']);
  });
}

test('idle reconnect flushes its own reply while another active session keeps its scheduled update', () => {
  const view = renderHandlers();
  view.dispatch({ kind: 'status', sessionId: 'viewed-session', text: 'working' });
  view.dispatch({ kind: 'status', sessionId: 'background-session', text: 'working' });
  view.dispatch(delta('viewed-session', 'Offline reply', 'codex'));
  view.dispatch(delta('background-session', 'Active '));
  act(() => vi.advanceTimersByTime(1));
  view.reconnect('viewed-session');
  view.dispatch({ kind: 'chat_subscribed', sessionId: 'viewed-session', isProcessing: false });
  act(() => vi.advanceTimersByTime(99));

  assert.equal(view.result.current.isSessionProcessing('viewed-session'), false);
  assert.equal(view.result.current.isSessionProcessing('background-session'), true);
  assert.deepEqual(view.contents('background-session'), ['Active ']);
  assert.equal(view.result.current.getMessages('background-session')[0].kind, 'stream_delta');
  assert.deepEqual(view.contents('viewed-session'), ['Offline reply']);
  assert.equal(view.result.current.getMessages('viewed-session')[0].kind, 'text');
  assert.equal(view.result.current.getMessages('viewed-session')[0].provider, 'codex');

  view.dispatch(delta('background-session', 'reply'));
  view.dispatch({ kind: 'stream_end', sessionId: 'background-session' });
  assert.deepEqual(view.contents('background-session'), ['Active reply']);
  assert.equal(view.result.current.getMessages('background-session')[0].provider, 'claude');
});

test('a processing reconnect acknowledgement preserves its accumulated reply', () => {
  const view = renderHandlers();
  view.dispatch(delta('viewed-session', 'Running '));
  act(() => vi.advanceTimersByTime(1));
  view.reconnect('viewed-session');
  view.dispatch({ kind: 'chat_subscribed', sessionId: 'viewed-session', isProcessing: true });
  view.dispatch(delta('viewed-session', 'reply'));
  act(() => vi.advanceTimersByTime(100));

  assert.deepEqual(view.contents('viewed-session'), ['Running reply']);
  assert.equal(view.result.current.getMessages('viewed-session')[0].kind, 'stream_delta');
  assert.equal(view.result.current.isSessionProcessing('viewed-session'), true);
});

test('a stale idle acknowledgement preserves a newer run cursor before its first delta', () => {
  const view = renderHandlers();
  view.reconnect('viewed-session');
  act(() => vi.advanceTimersByTime(1));
  view.dispatch({ kind: 'chat_run_status', sessionId: 'viewed-session', runId: 'new-run', phase: 'running' });
  view.dispatch({ kind: 'status', sessionId: 'viewed-session', runId: 'new-run', text: 'working', seq: 1 });
  view.dispatch({ kind: 'chat_subscribed', sessionId: 'viewed-session', runId: 'old-run', isProcessing: false });

  assert.equal(view.result.current.isSessionProcessing('viewed-session'), true);
  assert.equal(view.result.current.lastSeq.get('viewed-session'), 1);
  assert.equal(view.result.current.cursorRunId.get('viewed-session'), 'new-run');
});

test('a stale idle acknowledgement preserves a newer active stream', () => {
  const view = renderHandlers();
  view.reconnect('viewed-session');
  act(() => vi.advanceTimersByTime(1));
  view.dispatch({ kind: 'status', sessionId: 'viewed-session', runId: 'new-run', text: 'working', seq: 1 });
  view.dispatch({ ...delta('viewed-session', 'New '), runId: 'new-run', seq: 2 });
  view.dispatch({ kind: 'chat_subscribed', sessionId: 'viewed-session', runId: 'old-run', isProcessing: false });
  assert.equal(view.result.current.lastSeq.get('viewed-session'), 2);
  assert.equal(view.result.current.cursorRunId.get('viewed-session'), 'new-run');
  view.dispatch(delta('viewed-session', 'reply'));
  act(() => vi.advanceTimersByTime(100));

  assert.equal(view.result.current.isSessionProcessing('viewed-session'), true);
  assert.deepEqual(view.contents('viewed-session'), ['New reply']);
  assert.equal(view.result.current.getMessages('viewed-session')[0].kind, 'stream_delta');
});

for (const terminal of [{ kind: 'complete', success: false }, { kind: 'complete', aborted: true }]) {
  test(`a ${terminal.aborted ? 'cancelled' : 'failed'} reply is finalized before the next reply starts`, () => {
    const view = renderHandlers();
    view.dispatch(delta('viewed-session', 'First reply'));
    act(() => vi.advanceTimersByTime(100));
    view.dispatch({ ...terminal, sessionId: 'viewed-session' });
    view.dispatch(delta('viewed-session', 'Second reply'));
    act(() => vi.advanceTimersByTime(100));

    assert.deepEqual(view.contents('viewed-session'), ['First reply', 'Second reply']);
    assert.deepEqual(view.result.current.getMessages('viewed-session').map((message) => message.kind), ['text', 'stream_delta']);
    assert.equal(view.idle.mock.calls.length, 1);
    assert.equal(view.idle.mock.calls[0][0], 'viewed-session');
  });
}

for (const kind of ['chat_run_status', 'chat_subscribed']) {
  test(`a new run announced by ${kind} resets only that session's replay cursor`, () => {
    const view = renderHandlers();
    view.dispatch({ kind: 'chat_run_status', sessionId: 'viewed-session', runId: 'old-run', phase: 'running' });
    view.dispatch({ kind: 'complete', sessionId: 'viewed-session', seq: 100, success: true });
    view.dispatch({ ...delta('background-session', 'Other reply'), seq: 42 });
    view.dispatch({ kind, sessionId: 'viewed-session', runId: 'next-run', phase: 'running', isProcessing: true, lastSeq: 5 });

    // Only actually observed provider frames count; server lastSeq is not a cursor.
    assert.equal(view.result.current.lastSeq.get('viewed-session'), 0);
    assert.equal(view.result.current.lastSeq.get('background-session'), 42);
    view.dispatch({ ...delta('viewed-session', 'Next reply'), seq: 1 });
    view.reconnect('viewed-session');
    assert.equal(view.result.current.lastSeq.get('viewed-session'), 1);
  });
}

test('a changed run on reconnect retires the missing terminal buffer before its first replay', () => {
  const view = renderHandlers();
  view.dispatch({ kind: 'chat_run_status', sessionId: 'viewed-session', runId: 'offline-run', phase: 'running' });
  view.dispatch({ ...delta('viewed-session', 'Previous reply', 'codex'), seq: 100 });
  view.dispatch({ ...delta('background-session', 'Other reply'), seq: 42 });
  view.reconnect('viewed-session');
  view.dispatch({ kind: 'chat_subscribed', sessionId: 'viewed-session', runId: 'next-run', isProcessing: true, lastSeq: 5 });
  assert.equal(view.result.current.lastSeq.get('viewed-session'), 0);
  assert.equal(view.result.current.cursorRunId.get('viewed-session'), 'next-run');
  view.dispatch({ ...delta('viewed-session', 'Next reply'), seq: 1 });
  act(() => vi.advanceTimersByTime(100));

  assert.equal(view.result.current.lastSeq.get('viewed-session'), 1);
  assert.equal(view.result.current.lastSeq.get('background-session'), 42);
  assert.deepEqual(view.contents('viewed-session'), ['Previous reply', 'Next reply']);
  assert.deepEqual(view.contents('background-session'), ['Other reply']);
});

test('provider events with runId can establish a new run when lifecycle frames were missed', () => {
  const view = renderHandlers();
  view.dispatch({ ...delta('viewed-session', 'Previous reply'), seq: 100, runId: 'previous-run' });
  view.dispatch({ ...delta('viewed-session', 'Next reply'), seq: 1, runId: 'next-run' });
  act(() => vi.advanceTimersByTime(100));

  assert.equal(view.result.current.lastSeq.get('viewed-session'), 1);
  assert.equal(view.result.current.cursorRunId.get('viewed-session'), 'next-run');
  assert.deepEqual(view.contents('viewed-session'), ['Previous reply', 'Next reply']);
});

test('a same-run reconnect snapshot keeps observed replay progress and ignores server lastSeq', () => {
  const view = renderHandlers();
  view.dispatch({ kind: 'chat_run_status', sessionId: 'viewed-session', runId: 'active-run', phase: 'running' });
  view.dispatch({ ...delta('viewed-session', 'Running '), seq: 4 });
  view.reconnect('viewed-session');
  view.dispatch({ kind: 'chat_subscribed', sessionId: 'viewed-session', runId: 'active-run', isProcessing: true, lastSeq: 10 });
  view.dispatch({ kind: 'chat_run_status', sessionId: 'viewed-session', runId: 'active-run', phase: 'running', lastSeq: 10 });
  view.dispatch({ ...delta('viewed-session', 'reply'), seq: 5 });

  assert.equal(view.result.current.lastSeq.get('viewed-session'), 5);
  act(() => vi.advanceTimersByTime(100));
  assert.deepEqual(view.contents('viewed-session'), ['Running reply']);
});

for (const acknowledgedRunId of ['old-run', 'another-offline-run']) {
  test(`an idle acknowledgement for ${acknowledgedRunId} retires the previous run cursor and buffer`, () => {
    const view = renderHandlers();
    view.dispatch({ kind: 'chat_run_status', sessionId: 'viewed-session', runId: 'old-run', phase: 'running' });
    view.dispatch({ ...delta('viewed-session', 'Offline reply'), seq: 100 });
    act(() => vi.advanceTimersByTime(1));
    view.reconnect('viewed-session');
    view.dispatch({ kind: 'chat_subscribed', sessionId: 'viewed-session', runId: acknowledgedRunId, isProcessing: false, lastSeq: 105 });

    assert.equal(view.result.current.lastSeq.get('viewed-session') ?? 0, 0);
    assert.equal(view.result.current.cursorRunId.has('viewed-session'), false);
    view.dispatch({ ...delta('viewed-session', 'Next reply'), seq: 1 });
    act(() => vi.advanceTimersByTime(100));
    assert.deepEqual(view.contents('viewed-session'), ['Offline reply', 'Next reply']);
  });
}

test('legacy sequenced events without runId start fresh after completion without resetting on replay', () => {
  const view = renderHandlers();
  view.dispatch({ kind: 'complete', sessionId: 'viewed-session', seq: 100, success: true });
  view.dispatch({ ...delta('viewed-session', 'Next reply'), seq: 1 });
  assert.equal(view.result.current.lastSeq.get('viewed-session'), 1);
  view.dispatch({ ...delta('viewed-session', '!'), seq: 4 });
  view.dispatch({ kind: 'status', sessionId: 'viewed-session', text: 'working', seq: 2 });
  assert.equal(view.result.current.lastSeq.get('viewed-session'), 4);
});

test('learning an active runId after anonymous events retains its existing replay cursor', () => {
  const view = renderHandlers();
  view.dispatch({ ...delta('viewed-session', 'Running reply'), seq: 4 });
  view.dispatch({ kind: 'chat_subscribed', sessionId: 'viewed-session', runId: 'active-run', isProcessing: true, lastSeq: 10 });
  assert.equal(view.result.current.lastSeq.get('viewed-session'), 4);
});

for (const code of ['RUN_IN_PROGRESS', 'CHAT_ABORT_FAILED']) {
  for (const statusText of ['working', 'workspace_finalizing']) {
    test(`${code} preserves ${statusText} activity and only appends an error row`, () => {
      const view = renderHandlers();
      view.dispatch({ kind: 'status', sessionId: 'viewed-session', text: statusText, canInterrupt: statusText !== 'workspace_finalizing' });
      view.dispatch(delta('viewed-session', 'Running '));
      const activity = view.result.current.processingSessions.get('viewed-session');
      view.dispatch({ kind: 'protocol_error', sessionId: 'viewed-session', code, error: 'Still running' });

      assert.equal(view.result.current.isSessionProcessing('viewed-session'), true);
      assert.deepEqual(view.result.current.processingSessions.get('viewed-session'), activity);
      assert.equal(view.idle.mock.calls.length, 0);
      assert.ok(view.result.current.getMessages('viewed-session').some((message) => message.kind === 'error' && message.content === 'Still running'));
      view.dispatch(delta('viewed-session', 'reply'));
      act(() => vi.advanceTimersByTime(100));
      assert.ok(view.contents('viewed-session').includes('Running reply'));
    });
  }
}

test('a rejected run still clears its own optimistic activity', () => {
  const view = renderHandlers();
  view.dispatch({ kind: 'status', sessionId: 'viewed-session', text: 'working' });
  view.dispatch({ kind: 'status', sessionId: 'background-session', text: 'working' });
  view.dispatch({ kind: 'protocol_error', sessionId: 'viewed-session', code: 'UNSUPPORTED_PROVIDER', error: 'Unavailable provider' });
  assert.equal(view.result.current.isSessionProcessing('viewed-session'), false);
  assert.equal(view.result.current.isSessionProcessing('background-session'), true);
  assert.deepEqual(view.contents('viewed-session'), ['Unavailable provider']);
});

test('each stream keeps its event provider while another provider is viewed', () => {
  const view = renderHandlers();
  view.dispatch(delta('background-session', 'Codex reply', 'codex'));
  view.dispatch(delta('viewed-session', 'Claude reply'));
  act(() => vi.advanceTimersByTime(100));
  view.dispatch({ kind: 'stream_end', sessionId: 'background-session' });

  assert.equal(view.result.current.getMessages('background-session')[0].provider, 'codex');
  assert.equal(view.result.current.getMessages('viewed-session')[0].provider, 'claude');
});
