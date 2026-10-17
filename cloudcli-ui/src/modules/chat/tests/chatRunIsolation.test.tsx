import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import { useChatSessionState } from '@/modules/chat/hooks/useChatSessionState';
import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import { useSessionProtection } from '@/shared/hooks/useSessionProtection';
import type { ChatReplayCursor, ChatStreamBuffer, Project, ProjectSession, ServerEvent } from '@/shared/types';

vi.mock('@/shared/api', () => ({ api: { providers: {
  sessionMessages: async () => Response.json({ data: { messages: [], total: 0, hasMore: false } }),
  sessionTokenUsage: async () => Response.json({ data: null }),
} } }));
vi.mock('@/shared/utils', () => ({ playChatCompletionSound: vi.fn(), playNotificationSound: vi.fn() }));
vi.mock('@/modules/chat/utils/pageTitleNotification', () => ({ showCompletionTitleIndicator: vi.fn() }));

afterEach(() => { cleanup(); vi.useRealTimers(); });

const project = (projectId: string): Project => ({ projectId, path: `/${projectId}`, fullPath: `/${projectId}` } as Project);
const session = (id: string): ProjectSession => ({ id, __provider: 'claude' } as ProjectSession);

function mountRuntime() {
  let listener: ((event: ServerEvent) => void) | null = null;
  const streams = { current: new Map<string, ChatStreamBuffer>() };
  const cursors = { current: new Map<string, ChatReplayCursor>() };
  const requestLatestMessages = vi.fn(async () => {});
  const subscribe = (callback: (event: ServerEvent) => void) => {
    listener = callback;
    return () => { if (listener === callback) listener = null; };
  };
  const view = renderHook(() => {
    const store = useSessionStore();
    store.setActiveSession('B');
    const protection = useSessionProtection();
    useChatRealtimeHandlers({
      isActive: true, subscribe, provider: 'claude', selectedSession: session('B'), currentSessionId: 'B',
      setTokenBudget: vi.fn(), pendingPermissionRequests: [], setPendingPermissionRequests: vi.fn(),
      streamBuffersRef: streams, replayCursorsRef: cursors, statusCheckSentAtRef: { current: new Map() },
      onSessionProcessing: protection.markSessionProcessing, onSessionIdle: protection.markSessionIdle,
      requestLatestMessages, sessionStore: store,
    });
    return { store, protection };
  });
  return { ...view, streams, cursors, requestLatestMessages, dispatch: (event: ServerEvent) => act(() => listener?.(event)) };
}

test('parallel conversations retain independent paragraphs and completion cannot clear the other stream', () => {
  vi.useFakeTimers();
  const runtime = mountRuntime();
  runtime.dispatch({ kind: 'stream_delta', sessionId: 'A', runId: 'run-a', seq: 1, content: 'A-private' });
  runtime.dispatch({ kind: 'stream_delta', sessionId: 'B', runId: 'run-b', seq: 1, content: 'B-private' });
  act(() => { vi.advanceTimersByTime(100); });
  expect(runtime.result.current.store.getMessages('A').map(row => row.content)).toEqual(['A-private']);
  expect(runtime.result.current.store.getMessages('B').map(row => row.content)).toEqual(['B-private']);

  runtime.dispatch({ kind: 'stream_delta', sessionId: 'B', runId: 'run-b', seq: 2, content: '-tail' });
  runtime.dispatch({ kind: 'complete', sessionId: 'A', runId: 'run-a', seq: 2, aborted: true });
  act(() => { vi.advanceTimersByTime(100); });
  expect(runtime.result.current.store.getMessages('A').map(row => row.content)).toEqual(['A-private']);
  expect(runtime.result.current.store.getMessages('B').map(row => row.content)).toEqual(['B-private-tail']);
  expect(runtime.streams.current.has('A')).toBe(false);
  expect(runtime.streams.current.has('B')).toBe(true);
});

test('a new run retains channel progress and overlapping subscriptions do not duplicate its deltas', () => {
  vi.useFakeTimers();
  const runtime = mountRuntime();
  runtime.dispatch({ kind: 'stream_delta', sessionId: 'B', runId: 'old-run', seq: 100, content: 'Old turn' });
  runtime.dispatch({ kind: 'complete', sessionId: 'B', runId: 'old-run', seq: 101, aborted: true });
  runtime.dispatch({ kind: 'chat_subscribed', sessionId: 'B', runId: 'new-run', isProcessing: true, lastSeq: 150 });
  expect(runtime.cursors.current.get('B')).toMatchObject({ runId: 'new-run', seq: 101 });
  runtime.dispatch({ kind: 'stream_delta', sessionId: 'B', runId: 'new-run', seq: 102, content: 'New turn' });
  runtime.dispatch({ kind: 'stream_delta', sessionId: 'B', runId: 'new-run', seq: 102, content: 'New turn' });
  act(() => { vi.advanceTimersByTime(100); });
  expect(runtime.result.current.store.getMessages('B').map(row => row.content)).toEqual(['Old turn', 'New turn']);
  expect(runtime.cursors.current.get('B')).toMatchObject({ runId: 'new-run', seq: 102 });
});

test('an old-run duplicate cannot finalize the newer paragraph, but a channel epoch restart accepts seq one', () => {
  vi.useFakeTimers();
  const runtime = mountRuntime();
  runtime.dispatch({ kind: 'stream_delta', sessionId: 'B', replayEpoch: 'channel-one', runId: 'old-run', seq: 100, content: 'Old turn' });
  runtime.dispatch({ kind: 'complete', sessionId: 'B', replayEpoch: 'channel-one', runId: 'old-run', seq: 101, aborted: true });
  runtime.dispatch({ kind: 'stream_delta', sessionId: 'B', replayEpoch: 'channel-one', runId: 'new-run', seq: 102, content: 'New' });
  runtime.dispatch({ kind: 'stream_delta', sessionId: 'B', replayEpoch: 'channel-one', runId: 'old-run', seq: 100, content: 'Old turn' });
  expect(runtime.streams.current.get('B')?.runId).toBe('new-run');
  runtime.dispatch({ kind: 'stream_delta', sessionId: 'B', replayEpoch: 'channel-one', runId: 'new-run', seq: 103, content: ' turn' });
  runtime.dispatch({ kind: 'stream_end', sessionId: 'B', replayEpoch: 'channel-one', runId: 'new-run', seq: 104 });
  expect(runtime.result.current.store.getMessages('B').map(row => row.content)).toEqual(['Old turn', 'New turn']);
  runtime.dispatch({ kind: 'chat_subscribed', sessionId: 'B', replayEpoch: 'channel-two', runId: 'restarted-run', isProcessing: true, lastSeq: 2 });
  expect(runtime.cursors.current.get('B')).toEqual({ replayEpoch: 'channel-two', runId: 'restarted-run', seq: 0 });
  runtime.dispatch({ kind: 'stream_delta', sessionId: 'B', replayEpoch: 'channel-two', runId: 'restarted-run', seq: 1, content: 'Restarted' });
  runtime.dispatch({ kind: 'stream_end', sessionId: 'B', replayEpoch: 'channel-two', runId: 'restarted-run', seq: 2 });
  expect(runtime.result.current.store.getMessages('B').map(row => row.content)).toEqual(['Old turn', 'New turn', 'Restarted']);
});

test('partial replay continues its session-owned cached prefix after the first channel metadata', () => {
  const runtime = mountRuntime();
  act(() => runtime.result.current.store.updateStreaming('B', 'Already streamed ', 'codex'));
  runtime.dispatch({ kind: 'chat_subscribed', sessionId: 'B', replayEpoch: 'channel', runId: 'run-b', isProcessing: true, lastSeq: 5 });
  runtime.dispatch({ kind: 'stream_delta', sessionId: 'B', replayEpoch: 'channel', runId: 'run-b', seq: 5, provider: 'codex', content: 'tail' });
  runtime.dispatch({ kind: 'stream_end', sessionId: 'B', replayEpoch: 'channel', runId: 'run-b', seq: 6 });
  expect(runtime.result.current.store.getMessages('B').map(row => row.content)).toEqual(['Already streamed tail']);
  expect(runtime.result.current.store.getMessages('B')[0]?.provider).toBe('codex');
});

test('confirmed model stop remains busy through handback and aborted completion refreshes persisted history', () => {
  const runtime = mountRuntime();
  runtime.dispatch({ kind: 'status', sessionId: 'B', runId: 'run-b', seq: 1, text: 'model_stopped', canInterrupt: false });
  expect(runtime.result.current.protection.processingSessions.get('B')).toMatchObject({ modelStopped: true, canInterrupt: false });
  runtime.dispatch({ kind: 'status', sessionId: 'B', runId: 'run-b', seq: 2, text: 'workspace_finalizing', canInterrupt: false });
  expect(runtime.result.current.protection.processingSessions.get('B')).toMatchObject({
    statusText: 'workspace_finalizing', modelStopped: true, canInterrupt: false, runId: 'run-b',
  });
  expect(runtime.result.current.protection.isSessionProcessing('B')).toBe(true);
  expect(runtime.requestLatestMessages).not.toHaveBeenCalled();
  runtime.dispatch({ kind: 'complete', sessionId: 'B', runId: 'run-b', seq: 3, aborted: true });
  expect(runtime.result.current.protection.isSessionProcessing('B')).toBe(false);
  expect(runtime.requestLatestMessages).toHaveBeenCalledExactlyOnceWith('B', true);
});

test('an older same-run snapshot cannot undo a confirmed process exit but a new run resets it', () => {
  const runtime = mountRuntime();
  runtime.dispatch({ kind: 'status', sessionId: 'B', runId: 'run-b', seq: 1, text: 'model_stopped', canInterrupt: false });
  act(() => runtime.result.current.protection.syncProcessingSessions([
    { sessionId: 'B', runId: 'run-b', statusText: 'workspace_finalizing', modelStopped: false, canInterrupt: true },
  ]));
  expect(runtime.result.current.protection.processingSessions.get('B')).toMatchObject({ modelStopped: true, canInterrupt: false });
  act(() => runtime.result.current.protection.syncProcessingSessions([
    { sessionId: 'B', runId: 'next-run', statusText: 'Thinking', modelStopped: false, canInterrupt: true },
  ]));
  expect(runtime.result.current.protection.processingSessions.get('B')).toMatchObject({ modelStopped: false, canInterrupt: true });
});

test('project selection detaches a previous busy session without stopping its background work', async () => {
  const running = new Map([['A', { statusText: 'Thinking', canInterrupt: true, startedAt: Date.now() }]]);
  const cursors = { current: new Map<string, ChatReplayCursor>() };
  const view = renderHook(({ selectedProject, selectedSession }: { selectedProject: Project; selectedSession: ProjectSession | null }) => {
    const store = useSessionStore();
    return useChatSessionState({
      isActive: true, selectedProject, selectedSession, ws: null, sendMessage: vi.fn(),
      processingSessions: running, statusCheckSentAtRef: { current: new Map() }, replayCursorsRef: cursors, sessionStore: store,
    });
  }, { initialProps: { selectedProject: project('project-a'), selectedSession: session('A') as ProjectSession | null } });
  await waitFor(() => expect(view.result.current.currentSessionId).toBe('A'));
  view.rerender({ selectedProject: project('project-b'), selectedSession: null });
  expect(view.result.current.currentSessionId).toBeNull();
  expect(view.result.current.sessionActivity).toBeNull();
  expect(view.result.current.canAbortSession).toBe(false);
  expect(view.result.current.chatMessages).toEqual([]);
  expect(running.has('A')).toBe(true);
});

test('subscriptions carry the run identity together with its sequence watermark', async () => {
  const sendMessage = vi.fn();
  const cursors = { current: new Map<string, ChatReplayCursor>([['A', { replayEpoch: 'channel-a', runId: 'run-a', seq: 100 }]]) };
  const selectedProject = project('project-a');
  const selectedSession = session('A');
  const ws = {} as WebSocket;
  const view = renderHook(() => {
    const store = useSessionStore();
    return useChatSessionState({
      isActive: true, selectedProject, selectedSession, ws, sendMessage,
      statusCheckSentAtRef: { current: new Map() }, replayCursorsRef: cursors, sessionStore: store,
    });
  });
  await waitFor(() => expect(view.result.current.isLoadingSessionMessages).toBe(false));
  expect(sendMessage).toHaveBeenCalledWith({ type: 'chat.subscribe', sessions: [{ sessionId: 'A', lastSeq: 100, replayEpoch: 'channel-a', runId: 'run-a' }] });
});
