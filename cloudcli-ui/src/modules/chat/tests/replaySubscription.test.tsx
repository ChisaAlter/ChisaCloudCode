import assert from 'node:assert/strict';

import { act, render, renderHook } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import ChatInterface from '@/modules/chat/ChatInterface';
import type { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import type { useChatSessionState } from '@/modules/chat/hooks/useChatSessionState';
import type { Project, ProjectSession } from '@/shared/types';

type RealtimeArgs = Parameters<typeof useChatRealtimeHandlers>[0];

const state = vi.hoisted(() => ({
  realtime: null as RealtimeArgs | null,
  requestLatestMessages: vi.fn(async () => {}),
}));

vi.mock('@/modules/task-master', () => ({ useTasksSettings: () => ({}) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/shared/ui', () => ({ ActionMenu: () => null }));
vi.mock('@/shared/chisa', () => ({ isDesktop: () => false }));
vi.mock('@/shared/api', () => ({
  api: { providers: { sessionTokenUsage: () => Promise.resolve({ ok: false }) } },
}));
vi.mock('@/shared/context/WebSocketContext', () => ({ useWebSocket: () => ({ subscribe: () => () => {} }) }));
vi.mock('@/shared/context/SessionProtectionContext', () => ({
  useProcessingSessions: () => new Map(),
  useSessionProtectionActions: () => ({}),
}));
vi.mock('@/modules/chat/hooks/useChatProviderState', () => ({
  useChatProviderState: () => ({ provider: 'claude', pendingPermissionRequests: [] }),
}));
vi.mock('@/modules/chat/hooks/useChatSessionState', () => ({
  useChatSessionState: ({ selectedSession }: { selectedSession: ProjectSession }) => ({
    chatMessages: [],
    visibleMessages: [],
    currentSessionId: selectedSession.id,
    requestLatestMessages: state.requestLatestMessages,
  }),
}));
vi.mock('@/modules/chat/hooks/useChatComposerState', () => ({
  useChatComposerState: () => ({ input: '', attachedFiles: [] }),
}));
vi.mock('@/modules/chat/hooks/useChatRealtimeHandlers', () => ({
  useChatRealtimeHandlers: (args: RealtimeArgs) => { state.realtime = args; },
}));
vi.mock('@/modules/chat/hooks/useSessionStore', () => ({ useSessionStore: () => ({}) }));
vi.mock('@/modules/chat/composer/useScheduledMessages', () => ({ useScheduledMessages: () => ({ scheduledMessages: [] }) }));
vi.mock('@/modules/chat/transcript/ChatMessagesPane', () => ({ default: () => null }));
vi.mock('@/modules/chat/composer/ChatComposer', () => ({ default: () => null }));
vi.mock('@/modules/chat/modals/CommandResultModal', () => ({ default: () => null }));

const project: Project = { projectId: 'project-a', displayName: 'Project A', fullPath: '/repo' };

beforeEach(() => {
  vi.clearAllMocks();
  state.realtime = null;
});

test('reconnect sends the viewed session cursor together with its run identity, or explicit null when unknown', async () => {
  const sendMessage = vi.fn();
  const props = { isActive: true, selectedProject: project, selectedSession: { id: 'session-a' }, ws: null, sendMessage };
  const view = render(<ChatInterface {...props} />);
  assert.ok(state.realtime);
  state.realtime.lastSeqRef.current.set('session-a', 100);
  state.realtime.cursorRunIdRef.current.set('session-a', 'old-run');
  state.realtime.lastSeqRef.current.set('session-b', 4);
  state.realtime.cursorRunIdRef.current.set('session-b', 'other-run');

  await act(async () => { await state.realtime?.onWebSocketReconnect?.(); });
  assert.deepEqual(sendMessage.mock.calls[0][0], {
    type: 'chat.subscribe', sessions: [{ sessionId: 'session-a', lastSeq: 100, runId: 'old-run' }],
  });
  assert.deepEqual(state.requestLatestMessages.mock.calls[0], ['session-a', true]);

  view.rerender(<ChatInterface {...props} selectedSession={{ id: 'session-c' }} />);
  await act(async () => { await state.realtime?.onWebSocketReconnect?.(); });
  assert.deepEqual(sendMessage.mock.calls[1][0], {
    type: 'chat.subscribe', sessions: [{ sessionId: 'session-c', lastSeq: 0, runId: null }],
  });
});

test('opening a session sends its own run cursor before replay is acknowledged', async () => {
  const { useChatSessionState: useActualSessionState } = await vi.importActual<{ useChatSessionState: typeof useChatSessionState }>(
    '@/modules/chat/hooks/useChatSessionState',
  );
  const sendMessage = vi.fn();
  const store = {
    setActiveSession: vi.fn(),
    getMessages: () => [],
    getSessionSlot: () => ({ fetchedAt: 1, status: 'idle', total: 0, hasMore: false, offset: 0 }),
    isStale: () => false,
  };
  const lastSeqRef = { current: new Map([['session-a', 4], ['session-b', 99]]) };
  const cursorRunIdRef = { current: new Map([['session-a', 'active-run'], ['session-b', 'other-run']]) };
  const statusCheckSentAtRef = { current: new Map<string, number>() };
  const ws = {} as WebSocket;
  const view = renderHook(({ sessionId }) => useActualSessionState({
    isActive: false,
    selectedProject: project,
    selectedSession: { id: sessionId },
    ws,
    sendMessage,
    lastSeqRef,
    cursorRunIdRef,
    statusCheckSentAtRef,
    sessionStore: store as unknown as Parameters<typeof useChatSessionState>[0]['sessionStore'],
  }), { initialProps: { sessionId: 'session-a' } });

  assert.deepEqual(sendMessage.mock.calls[0][0], {
    type: 'chat.subscribe', sessions: [{ sessionId: 'session-a', lastSeq: 4, runId: 'active-run' }],
  });
  assert.ok(statusCheckSentAtRef.current.has('session-a'));
  view.rerender({ sessionId: 'session-c' });
  assert.deepEqual(sendMessage.mock.calls[1][0], {
    type: 'chat.subscribe', sessions: [{ sessionId: 'session-c', lastSeq: 0, runId: null }],
  });
});
