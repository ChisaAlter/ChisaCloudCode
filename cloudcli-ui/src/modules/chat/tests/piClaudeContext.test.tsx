import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import ChatInterface from '@/modules/chat/ChatInterface';
import type { Project, ProjectSession } from '@/shared/types';

const state = vi.hoisted(() => ({
  nativeCall: vi.fn(), submit: vi.fn(), loadFullTranscript: vi.fn(), edit: vi.fn(),
  processing: false,
  composerArgs: null as Record<string, unknown> | null,
  transcriptArgs: null as Record<string, unknown> | null,
}));

vi.mock('mygo-runtime', () => ({ call: state.nativeCall }));
vi.mock('@/modules/task-master', () => ({ useTasksSettings: () => ({}) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/shared/ui', () => ({ ActionMenu: () => null }));
vi.mock('@/shared/api', () => ({ api: {} }));
vi.mock('@/shared/context/WebSocketContext', () => ({ useWebSocket: () => ({ subscribe: () => () => {} }) }));
vi.mock('@/shared/context/SessionProtectionContext', () => ({
  useProcessingSessions: () => new Map(), useSessionProtectionActions: () => ({}),
}));
vi.mock('@/modules/chat/hooks/useChatProviderState', () => ({
  useChatProviderState: () => ({ provider: 'claude', pendingPermissionRequests: [], supportsMessageEditing: true }),
}));
vi.mock('@/modules/chat/hooks/useChatSessionState', () => ({
  useChatSessionState: ({ selectedSession }: { selectedSession: ProjectSession }) => ({
    chatMessages: [{ type: 'assistant', content: 'Cloud reply', timestamp: 3 }], visibleMessages: [],
    currentSessionId: selectedSession.id, isProcessing: state.processing, loadFullTranscript: state.loadFullTranscript,
  }),
}));
vi.mock('@/modules/chat/hooks/useChatComposerState', () => ({
  useChatComposerState: (args: Record<string, unknown>) => {
    state.composerArgs = args;
    return { input: 'Cloud draft', attachedFiles: [], handleSubmit: state.submit, beginEditMessage: state.edit };
  },
}));
vi.mock('@/modules/chat/hooks/useChatRealtimeHandlers', () => ({ useChatRealtimeHandlers: () => {} }));
vi.mock('@/modules/chat/hooks/useSessionStore', () => ({ useSessionStore: () => ({}) }));
vi.mock('@/modules/chat/composer/useScheduledMessages', () => ({ useScheduledMessages: () => ({ scheduledMessages: [] }) }));
vi.mock('@/modules/chat/transcript/ChatMessagesPane', () => ({ default: (args: Record<string, unknown>) => { state.transcriptArgs = args; return <div>Cloud transcript</div>; } }));
vi.mock('@/modules/chat/composer/ChatComposer', () => ({ default: ({ onSubmit }: { onSubmit: () => void }) => <button onClick={onSubmit}>Send cloud message</button> }));
vi.mock('@/modules/chat/modals/CommandResultModal', () => ({ default: () => null }));

const project: Project = { projectId: 'project-a', displayName: 'Project A', fullPath: '/cloud/project-a' };
const props = (sessionId: string) => ({ isActive: true, selectedProject: project, selectedSession: { id: sessionId }, ws: null, sendMessage: vi.fn() });

beforeEach(() => { vi.clearAllMocks(); state.processing = false; vi.stubGlobal('mygo', {}); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test('desktop cloud chat never reads a local Pi lock and exposes no Pi pane or local execution control', () => {
  render(<ChatInterface {...props('session-a')} />);
  expect(screen.getByText('Cloud transcript')).toBeDefined();
  expect(screen.queryByText(/Pi|本地|同步/)).toBeNull();
  expect(screen.queryByRole('separator')).toBeNull();
  expect(state.nativeCall).not.toHaveBeenCalled();
  expect(state.loadFullTranscript).not.toHaveBeenCalled();
  expect(state.composerArgs).not.toHaveProperty('canSubmitCloud');
  fireEvent.click(screen.getByRole('button', { name: 'Send cloud message' }));
  expect(state.submit).toHaveBeenCalledOnce();
  expect(state.transcriptArgs?.onEditMessage).toBe(state.edit);
});

test('switching cloud sessions preserves the cloud composer and only running activity disables editing', () => {
  const view = render(<ChatInterface {...props('session-a')} />);
  view.rerender(<ChatInterface {...props('session-b')} />);
  expect(state.composerArgs?.selectedSession).toEqual({ id: 'session-b' });
  expect(state.transcriptArgs?.onEditMessage).toBe(state.edit);
  state.processing = true;
  view.rerender(<ChatInterface {...props('session-b')} />);
  expect(state.transcriptArgs?.onEditMessage).toBeUndefined();
  expect(state.nativeCall).not.toHaveBeenCalled();
});
