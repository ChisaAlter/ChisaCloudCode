import assert from 'node:assert/strict';

import { act, render } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import ChatInterface from '@/modules/chat/ChatInterface';
import type { ChatMessage, Project, ProjectSession } from '@/shared/types';

const state = vi.hoisted(() => ({
  loadFullTranscript: vi.fn<() => Promise<ChatMessage[]>>(),
  slotStatus: 'idle' as 'idle' | 'error',
  readContext: null as (() => Promise<string>) | null,
  sendMessage: vi.fn(),
}));

// Exercise the real ChatInterface callback; unrelated chat rendering and
// networking are not part of this one-way transcript contract.
vi.mock('@/modules/task-master', () => ({ useTasksSettings: () => ({}) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/shared/ui', () => ({ ActionMenu: () => null }));
vi.mock('@/shared/chisa', () => ({ isDesktop: () => true }));
vi.mock('@/shared/api', () => ({ api: {} }));
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
    // Only the latest page is on screen. Context must use the full loader.
    chatMessages: [{ type: 'assistant', content: 'latest visible reply', timestamp: 3 }],
    visibleMessages: [],
    currentSessionId: selectedSession.id,
    loadFullTranscript: state.loadFullTranscript,
  }),
}));
vi.mock('@/modules/chat/hooks/useChatComposerState', () => ({
  useChatComposerState: () => ({ input: 'UNSENT_CLAUDE_DRAFT', attachedFiles: [] }),
}));
vi.mock('@/modules/chat/hooks/useChatRealtimeHandlers', () => ({ useChatRealtimeHandlers: () => {} }));
vi.mock('@/modules/chat/hooks/useSessionStore', () => ({
  useSessionStore: () => ({ getSessionSlot: () => ({ status: state.slotStatus }) }),
}));
vi.mock('@/modules/chat/composer/useScheduledMessages', () => ({
  useScheduledMessages: () => ({ scheduledMessages: [] }),
}));
vi.mock('@/modules/chat/transcript/ChatMessagesPane', () => ({ default: () => null }));
vi.mock('@/modules/chat/composer/ChatComposer', () => ({ default: () => null }));
vi.mock('@/modules/chat/modals/CommandResultModal', () => ({ default: () => null }));
vi.mock('@/modules/local-agent', () => ({
  PiAgentPanel: ({ getClaudeContext }: { getClaudeContext: () => Promise<string> }) => {
    state.readContext = getClaudeContext;
    return null;
  },
}));

const project: Project = { projectId: 'project-a', displayName: 'Project A', fullPath: '/srv/project-a' };
const props = (sessionId: string) => ({
  isActive: true,
  selectedProject: project,
  selectedSession: { id: sessionId },
  ws: null,
  sendMessage: state.sendMessage,
});

beforeEach(() => {
  vi.clearAllMocks();
  state.slotStatus = 'idle';
  state.readContext = null;
  state.loadFullTranscript.mockResolvedValue([]);
});

test('Pi reads full Claude history and actual tool results only when requested, without a cloud send', async () => {
  state.loadFullTranscript.mockResolvedValue([
    { type: 'user', content: 'older paginated request', timestamp: 1 },
    { type: 'assistant', content: 'older paginated reply', timestamp: 2 },
    { type: 'assistant', isThinking: true, content: 'PRIVATE_THINKING', timestamp: 2 },
    { type: 'assistant', isToolUse: true, toolName: 'read_file', toolInput: { path: '/workspace/package.json' }, toolResult: { content: 'actual file content', isError: false }, timestamp: 2 },
    { type: 'assistant', isToolUse: true, toolName: 'run_command', toolInput: 'npm start', toolResult: { content: 'actual GUI error', isError: true }, timestamp: 2 },
    { type: 'assistant', content: 'latest visible reply', timestamp: 3 },
  ]);
  render(<ChatInterface {...props('session-a')} />);

  assert.equal(state.loadFullTranscript.mock.calls.length, 0);
  assert.ok(state.readContext);
  const context = await state.readContext();
  assert.equal(state.loadFullTranscript.mock.calls.length, 1);
  assert.match(context, /用户：\nolder paginated request/);
  assert.match(context, /Claude：\nolder paginated reply/);
  assert.match(context, /Claude 工具：read_file\n参数：\{"path":"\/workspace\/package\.json"\}\n结果：actual file content/);
  assert.match(context, /Claude 工具：run_command\n参数：npm start\n失败：actual GUI error/);
  assert.match(context, /latest visible reply/);
  assert.doesNotMatch(context, /PRIVATE_THINKING|UNSENT_CLAUDE_DRAFT|\[object Object\]/);
  assert.equal(state.sendMessage.mock.calls.length, 0);
});

test('failed full-history loading cannot silently use stale cached context or send to Claude', async () => {
  state.slotStatus = 'error';
  state.loadFullTranscript.mockResolvedValue([{ type: 'assistant', content: 'stale cached reply', timestamp: 1 }]);
  render(<ChatInterface {...props('session-a')} />);

  assert.ok(state.readContext);
  await assert.rejects(state.readContext(), /读取 Claude 上下文失败/);
  assert.equal(state.sendMessage.mock.calls.length, 0);
});

test('switching Claude sessions while history loads rejects the former context without a cloud send', async () => {
  let resolve!: (messages: ChatMessage[]) => void;
  state.loadFullTranscript.mockReturnValueOnce(new Promise<ChatMessage[]>((done) => { resolve = done; }));
  const view = render(<ChatInterface {...props('session-a')} />);
  assert.ok(state.readContext);
  const readPreviousContext = state.readContext;
  const rejected = assert.rejects(readPreviousContext(), /当前 Claude 会话已切换/);

  view.rerender(<ChatInterface {...props('session-b')} />);
  await act(async () => {
    resolve([{ type: 'user', content: 'session-a only', timestamp: 1 }]);
    await rejected;
  });

  await assert.rejects(readPreviousContext(), /当前 Claude 会话已切换/);
  assert.equal(state.loadFullTranscript.mock.calls.length, 1);
  assert.equal(state.sendMessage.mock.calls.length, 0);
});
