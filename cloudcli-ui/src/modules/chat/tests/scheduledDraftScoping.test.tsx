import assert from 'node:assert/strict';

import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ChangeEventHandler } from 'react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import ChatInterface from '@/modules/chat/ChatInterface';
import { readDraftText, resetChatDrafts } from '@/shared/chatDrafts';
import type { Project, ProjectSession } from '@/shared/types';

const state = vi.hoisted(() => ({
  createScheduled: vi.fn(),
  listScheduled: vi.fn(),
  sendMessage: vi.fn(),
  sessionOptionsReady: true,
  scheduling: null as Promise<void> | null,
}));

// Keep the real ChatInterface scheduling callback, composer state and scheduler;
// only unrelated transcript/provider UI and HTTP transport are replaced.
vi.mock('@/modules/task-master', () => ({ useTasksSettings: () => ({}) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/shared/ui', () => ({ ActionMenu: () => null }));
vi.mock('@/shared/chisa', () => ({ isDesktop: () => false, getServerConnectionVersion: () => 0 }));
vi.mock('@/shared/api', () => ({
  api: {
    user: {
      preferences: async () => ({ ok: true, json: async () => ({ success: true, preferences: {} }) }),
      saveDraft: async () => ({ ok: true }),
    },
    commands: { list: async () => ({ ok: true, json: async () => ({ commands: [] }) }) },
    providers: { skills: async () => ({ ok: true, json: async () => ({ data: { skills: [] } }) }) },
    scheduledMessages: { create: state.createScheduled, list: state.listScheduled },
  },
}));
vi.mock('@/shared/context/WebSocketContext', () => ({ useWebSocket: () => ({ subscribe: () => () => {} }) }));
vi.mock('@/shared/context/SessionProtectionContext', () => ({
  useProcessingSessions: () => new Map(),
  useSessionProtectionActions: () => ({}),
}));
vi.mock('@/modules/chat/hooks/useChatProviderState', () => ({
  useChatProviderState: () => ({
    provider: 'claude', pendingPermissionRequests: [], permissionMode: 'default',
    currentProviderModel: 'session-model', currentProviderEffort: 'medium',
    sessionOptionsReady: state.sessionOptionsReady,
    resolvePermissionModeForProvider: () => 'default',
  }),
}));
vi.mock('@/modules/chat/hooks/useChatSessionState', () => ({
  useChatSessionState: ({ selectedSession }: { selectedSession: ProjectSession }) => ({
    chatMessages: [], visibleMessages: [], currentSessionId: selectedSession.id,
  }),
}));
vi.mock('@/modules/chat/hooks/useChatRealtimeHandlers', () => ({ useChatRealtimeHandlers: () => {} }));
vi.mock('@/modules/chat/hooks/useSessionStore', () => ({ useSessionStore: () => ({}) }));
vi.mock('@/modules/chat/transcript/ChatMessagesPane', () => ({ default: () => null }));
vi.mock('@/modules/chat/modals/CommandResultModal', () => ({ default: () => null }));
vi.mock('@/modules/local-agent', () => ({ PiAgentPanel: () => null }));
vi.mock('@/modules/chat/composer/ChatComposer', () => ({
  default: ({ input, onInputChange, onScheduleMessage }: {
    input: string;
    onInputChange: ChangeEventHandler<HTMLTextAreaElement>;
    onScheduleMessage: (date: Date) => Promise<void>;
  }) => (
    <div>
      <textarea aria-label="Draft" value={input} onChange={onInputChange} />
      <button type="button" onClick={() => { state.scheduling = onScheduleMessage(new Date('2026-10-17T08:00:00Z')); }}>Schedule</button>
    </div>
  ),
}));

const PROJECT: Project = { projectId: 'project-a', displayName: 'Project A', fullPath: '/srv/project-a' };
const props = (sessionId: string) => ({
  isActive: true, selectedProject: PROJECT, selectedSession: { id: sessionId }, ws: null, sendMessage: state.sendMessage,
});
const okJson = (data: unknown = {}) => new Response(JSON.stringify(data), { status: 200 });

function pendingResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  localStorage.clear();
  resetChatDrafts();
  vi.resetAllMocks();
  state.sessionOptionsReady = true;
  state.scheduling = null;
  state.listScheduled.mockImplementation(async () => okJson({ data: [] }));
});
afterEach(() => resetChatDrafts());

for (const transition of ['unchanged', 'same-session-edit', 'session-switch'] as const) {
  test(`a scheduled send clears only its unchanged original draft after ${transition}`, async () => {
    const response = pendingResponse();
    state.createScheduled.mockReturnValue(response.promise);
    const view = render(<ChatInterface {...props('session-a')} />);
    await act(async () => { fireEvent.change(screen.getByRole('textbox', { name: 'Draft' }), { target: { value: 'A scheduled message' } }); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Schedule' })); });
    assert.equal(state.createScheduled.mock.calls.length, 1);
    assert.deepEqual(state.createScheduled.mock.calls[0][0], {
      sessionId: 'session-a', content: 'A scheduled message', scheduledFor: '2026-10-17T08:00:00.000Z',
      options: { model: 'session-model', effort: 'medium', permissionMode: 'default' },
    });
    if (transition === 'session-switch') {
      await act(async () => { view.rerender(<ChatInterface {...props('session-b')} />); });
    }
    if (transition !== 'unchanged') {
      await act(async () => { fireEvent.change(screen.getByRole('textbox', { name: 'Draft' }), { target: { value: 'new unsent draft' } }); });
    }
    await act(async () => {
      response.resolve(okJson({ success: true }));
      await state.scheduling;
    });
    assert.equal((screen.getByRole('textbox', { name: 'Draft' }) as HTMLTextAreaElement).value,
      transition === 'unchanged' ? '' : 'new unsent draft');
    assert.equal(readDraftText('session-a'), transition === 'unchanged' ? ''
      : transition === 'session-switch' ? 'A scheduled message' : 'new unsent draft');
    if (transition === 'session-switch') assert.equal(readDraftText('session-b'), 'new unsent draft');
    assert.equal(state.sendMessage.mock.calls.length, 0);
  });
}

test('the actual scheduling caller waits for session send options and preserves the draft', async () => {
  state.sessionOptionsReady = false;
  render(<ChatInterface {...props('session-a')} />);
  await act(async () => { fireEvent.change(screen.getByRole('textbox', { name: 'Draft' }), { target: { value: 'keep until options load' } }); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Schedule' })); await state.scheduling; });
  assert.equal(state.createScheduled.mock.calls.length, 0);
  assert.equal(readDraftText('session-a'), 'keep until options load');
  assert.equal((screen.getByRole('textbox', { name: 'Draft' }) as HTMLTextAreaElement).value, 'keep until options load');
});
