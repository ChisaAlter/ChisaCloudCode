import assert from 'node:assert/strict';

import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ChangeEventHandler, RefObject } from 'react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import ChatInterface from '@/modules/chat/ChatInterface';
import { clearAuthToken } from '@/shared/authToken';
import { readQueuedMessage, resetChatDrafts, writeDraftText, writeQueuedMessage } from '@/shared/chatDrafts';
import type { ComposerDraftAttachment, PermissionMode, ProjectSession } from '@/shared/types';

const selectors = vi.hoisted(() => ({
  model: vi.fn(), hydratedModel: vi.fn(), effort: vi.fn(), permission: vi.fn(), message: vi.fn(),
}));
const transport = vi.hoisted(() => ({ drafts: vi.fn(), saveDraft: vi.fn(), deleteDraft: vi.fn() }));
// Readiness and selector identity change independently while a pause acknowledgement is pending.
const providerState = vi.hoisted(() => ({ ready: true, hydrated: false, connectionVersion: 0 }));
const json = (body: unknown = {}) => new Response(JSON.stringify(body), { status: 200 });

// Migrated from the frozen queued-turn fixture. ChatInterface and the composer
// hook remain real; only unrelated provider/network services and rendering are stubbed.
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/modules/task-master', () => ({ useTasksSettings: () => ({}) }));
vi.mock('@/modules/local-agent', () => ({ PiAgentPanel: () => null }));
vi.mock('@/shared/ui', () => ({ ActionMenu: () => null }));
vi.mock('@/shared/chisa', () => ({
  isDesktop: () => false, getServerConnectionVersion: () => providerState.connectionVersion,
  FrontendBridge: {}, onWorkspaceSyncStateChanged: () => () => {},
}));
vi.mock('@/shared/context/WebSocketContext', () => ({ useWebSocket: () => ({ subscribe: () => () => {} }) }));
vi.mock('@/shared/context/SessionProtectionContext', () => ({
  useProcessingSessions: () => new Map(), useSessionProtectionActions: () => ({}),
}));
vi.mock('@/shared/api', () => ({ api: {
  user: { ...transport, preferences: async () => ({ ok: true, json: async () => ({ preferences: {} }) }) },
  commands: { list: async () => ({ ok: true, json: async () => ({ success: true, commands: [] }) }) },
  providers: { skills: async () => ({ ok: true, json: async () => ({ success: true, data: { skills: [] } }) }) },
  files: { search: async () => ({ ok: true, json: async () => ({ success: true, files: [] }) }) },
} }));
vi.mock('@/modules/chat/hooks/useChatProviderState', () => ({ useChatProviderState: () => ({
  provider: 'claude', permissionMode: 'default', pendingPermissionRequests: [],
  availablePermissionModes: ['default', 'plan'], currentProviderModel: 'visible-model', currentProviderEffort: 'medium',
  sessionOptionsReady: providerState.ready,
  sessionOptionsError: providerState.ready ? null : 'Session options are not ready',
  selectProviderModel: providerState.hydrated ? selectors.hydratedModel : selectors.model,
  selectProviderEffort: selectors.effort, selectPermissionMode: selectors.permission,
  resolvePermissionModeForProvider: (_provider: string, mode: PermissionMode) => mode,
}) }));
vi.mock('@/modules/chat/hooks/useChatSessionState', () => ({
  useChatSessionState: ({ selectedSession }: { selectedSession: ProjectSession }) => ({
    chatMessages: [], visibleMessages: [], currentSessionId: selectedSession.id, isProcessing: false,
    addMessage: selectors.message,
  }),
}));
vi.mock('@/modules/chat/hooks/useChatRealtimeHandlers', () => ({ useChatRealtimeHandlers: () => {} }));
vi.mock('@/modules/chat/hooks/useSessionStore', () => ({ useSessionStore: () => ({}) }));
vi.mock('@/modules/chat/composer/useScheduledMessages', () => ({ useScheduledMessages: () => ({ scheduledMessages: [] }) }));
vi.mock('@/modules/chat/transcript/ChatMessagesPane', () => ({ default: () => null }));
vi.mock('@/modules/chat/modals/CommandResultModal', () => ({ default: ({ onSelectProviderModel, currentSessionId }: {
  onSelectProviderModel: (provider: string, model: string, sessionId: string) => Promise<unknown>;
  currentSessionId: string;
}) => <button type="button" onClick={() => { void onSelectProviderModel('claude', 'modal-model', currentSessionId); }}>Modal model</button> }));
vi.mock('@/modules/chat/composer/ChatComposer', () => ({ default: ({
  onEditQueuedDraft, input, onInputChange, textareaRef, onSelectModel, onSelectEffort,
  onSelectPermissionMode, draftAttachments, effort,
}: {
  onEditQueuedDraft: () => void;
  input: string;
  onInputChange: ChangeEventHandler<HTMLTextAreaElement>;
  textareaRef: RefObject<HTMLTextAreaElement>;
  onSelectModel: (model: string) => Promise<void>;
  onSelectEffort: (effort: string) => Promise<void>;
  onSelectPermissionMode: (permission: PermissionMode) => void;
  draftAttachments: ComposerDraftAttachment[];
  effort: string;
}) => <>
  <button type="button" onClick={onEditQueuedDraft}>Edit queued message</button>
  <button type="button" onClick={() => { void onSelectModel('model-1'); }}>Model 1</button>
  <button type="button" onClick={() => { void onSelectModel('model-2'); }}>Model 2</button>
  <button type="button" onClick={() => { void onSelectEffort('low'); }}>Effort 1</button>
  <button type="button" onClick={() => { void onSelectEffort('xhigh'); }}>Effort 2</button>
  <button type="button" onClick={() => onSelectPermissionMode('default')}>Permission default</button>
  <textarea aria-label="Draft" ref={textareaRef} value={input} onChange={onInputChange} />
  <output data-testid="effort">{effort}</output>
  <output data-testid="attachments">{JSON.stringify(draftAttachments.map(item => item.uploaded?.path ?? item.file?.name))}</output>
</> }));

const props = (sessionId = 'session-a') => ({
  isActive: true,
  selectedProject: { projectId: 'project-a', displayName: 'Project A', fullPath: '/srv/project-a' },
  selectedSession: { id: sessionId }, ws: null, sendMessage: () => {},
});
const savedOptions = { model: 'saved-model', effort: 'high', permissionMode: 'plan' };
const savedAttachments = [{ path: '/asset/saved.txt', name: 'saved.txt', mimeType: 'text/plain' }];
const draft = () => screen.getByRole('textbox', { name: 'Draft' }) as HTMLTextAreaElement;
const click = async (name: string) => { await act(async () => { fireEvent.click(screen.getByRole('button', { name })); }); };

function restorationGuard(calls: unknown[][], value: string): () => boolean {
  assert.equal(calls.length, 1);
  const isCurrent = calls[0][3];
  assert.equal(typeof isCurrent, 'function');
  assert.deepEqual(calls, [['claude', value, 'session-a', isCurrent]]);
  const guard = isCurrent as () => boolean;
  assert.equal(guard(), true);
  return guard;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(async () => {
  localStorage.clear();
  resetChatDrafts();
  vi.resetAllMocks();
  providerState.ready = true;
  providerState.hydrated = false;
  providerState.connectionVersion = 0;
  transport.saveDraft.mockImplementation(async () => json());
  transport.drafts.mockImplementation(async () => json({ drafts: [] }));
  selectors.model.mockImplementation(async (_provider: string, model: string) => ({ scope: 'session', model }));
  selectors.hydratedModel.mockImplementation(async (_provider: string, model: string) => ({ scope: 'session', model }));
  selectors.effort.mockImplementation(async (_provider: string, effort: string) => ({ scope: 'session', effort }));
  await writeQueuedMessage('session-a', { content: 'saved task', options: savedOptions,
    attachments: savedAttachments, autoSend: false });
  transport.saveDraft.mockClear();
});
afterEach(resetChatDrafts);

for (const pendingStage of ['model', 'effort'] as const) {
  test.each(['session', 'identity', 'connection'] as const)(`a ${pendingStage} restore cannot continue after a %s change`, async (change) => {
    writeDraftText('session-b', 'session B draft');
    const pending = deferred<{ model?: string; effort?: string }>();
    selectors[pendingStage].mockReturnValue(pending.promise);
    const view = render(<ChatInterface {...props()} />);
    await click('Edit queued message');
    assert.equal(selectors[pendingStage].mock.calls.length, 1);
    const isCurrent = restorationGuard(selectors[pendingStage].mock.calls,
      pendingStage === 'model' ? 'saved-model' : 'high');
    assert.equal(draft().value, 'saved task');
    assert.equal(screen.getByTestId('attachments').textContent, JSON.stringify(['/asset/saved.txt']));
    await act(async () => {
      if (change === 'session') view.rerender(<ChatInterface {...props('session-b')} />);
      else if (change === 'identity') clearAuthToken();
      else { providerState.connectionVersion++; view.rerender(<ChatInterface {...props()} />); }
    });
    assert.equal(isCurrent(), false);
    const textAfterChange = draft().value;
    const attachmentsAfterChange = screen.getByTestId('attachments').textContent;
    if (change === 'session') {
      assert.equal(textAfterChange, 'session B draft');
      assert.equal(attachmentsAfterChange, '[]');
    } else if (change === 'identity') {
      assert.equal(textAfterChange, 'saved task');
      assert.equal(attachmentsAfterChange, JSON.stringify(['/asset/saved.txt']));
    } else {
      assert.equal(attachmentsAfterChange, '[]');
    }
    await act(async () => { pending.resolve({ model: 'saved-model', effort: 'high' }); });
    assert.equal(isCurrent(), false);
    assert.equal(selectors.model.mock.calls.length, 1);
    assert.equal(selectors.effort.mock.calls.length, pendingStage === 'effort' ? 1 : 0);
    assert.equal(selectors.permission.mock.calls.length, 0);
    // Canonical text is restored before controls; an invalid continuation must not change it again.
    assert.equal(draft().value, textAfterChange);
    assert.equal(screen.getByTestId('attachments').textContent, attachmentsAfterChange);
  });
}

test('an unchanged scope restores the complete draft and its model, effort and permission choices', async () => {
  render(<ChatInterface {...props()} />);
  await click('Edit queued message');
  const isCurrent = restorationGuard(selectors.model.mock.calls, 'saved-model');
  assert.equal(restorationGuard(selectors.effort.mock.calls, 'high'), isCurrent);
  assert.deepEqual(selectors.permission.mock.calls, [['plan']]);
  assert.equal(draft().value, 'saved task');
  assert.equal(screen.getByTestId('attachments').textContent, JSON.stringify(['/asset/saved.txt']));
  assert.equal(readQueuedMessage('session-a')?.autoSend, false);
  assert.deepEqual(readQueuedMessage('session-a')?.options, savedOptions);
});

test.each(['model', 'effort'] as const)('a slow earlier %s choice cannot replace the latest queued option', async field => {
  render(<ChatInterface {...props()} />);
  await click('Edit queued message');
  const pending = deferred<{ model?: string; effort?: string }>();
  const first = field === 'model' ? 'model-1' : 'low';
  const second = field === 'model' ? 'model-2' : 'xhigh';
  selectors[field].mockImplementation(async (_provider: string, value: string) => (
    value === first ? pending.promise : { [field]: value }
  ));
  await click(field === 'model' ? 'Model 1' : 'Effort 1');
  await click(field === 'model' ? 'Model 2' : 'Effort 2');
  assert.equal(readQueuedMessage('session-a')?.options?.[field], second);
  await act(async () => { pending.resolve({ [field]: first }); });
  assert.deepEqual(readQueuedMessage('session-a')?.options, { ...savedOptions, [field]: second });
});

test('a delayed model mutation cannot patch a reopened A editor after A to B to A', async () => {
  const view = render(<ChatInterface {...props()} />);
  await click('Edit queued message');
  const restoreIsCurrent = restorationGuard(selectors.model.mock.calls, 'saved-model');
  const pending = deferred<{ model: string }>();
  selectors.model.mockReturnValue(pending.promise);
  await click('Model 1');
  assert.equal(restoreIsCurrent(), false);
  await act(async () => { view.rerender(<ChatInterface {...props('session-b')} />); });
  assert.equal(restoreIsCurrent(), false);
  await act(async () => { view.rerender(<ChatInterface {...props()} />); });
  assert.equal(restoreIsCurrent(), false);
  assert.equal(draft().value, 'saved task');
  await act(async () => { pending.resolve({ model: 'model-1' }); });
  assert.deepEqual(readQueuedMessage('session-a')?.options, savedOptions);
});

for (const pendingStage of ['pause acknowledgement', 'model restore'] as const) {
  test.each(['draft', 'model', 'effort', 'permission'] as const)(`a user %s change during ${pendingStage} cancels remaining saved-option restoration`, async change => {
    const pendingPause = deferred<Response>();
    const pendingModel = deferred<{ model: string }>();
    if (pendingStage === 'pause acknowledgement') transport.saveDraft.mockReturnValueOnce(pendingPause.promise);
    else selectors.model.mockImplementation(async (_provider: string, model: string) => (
      model === 'saved-model' ? pendingModel.promise : { model }
    ));
    render(<ChatInterface {...props()} />);
    await click('Edit queued message');
    const isCurrent = pendingStage === 'model restore'
      ? restorationGuard(selectors.model.mock.calls, 'saved-model') : null;
    if (pendingStage === 'pause acknowledgement') assert.equal(selectors.model.mock.calls.length, 0);
    if (change === 'draft') await act(async () => { fireEvent.change(draft(), { target: { value: 'newer user draft' } }); });
    else await click(change === 'model' ? 'Model 1' : change === 'effort' ? 'Effort 1' : 'Permission default');
    if (isCurrent) assert.equal(isCurrent(), false);
    await act(async () => {
      if (pendingStage === 'pause acknowledgement') pendingPause.resolve(json());
      else pendingModel.resolve({ model: 'saved-model' });
    });
    if (isCurrent) assert.equal(isCurrent(), false);
    assert.equal(selectors.effort.mock.calls.some(([, effort]) => effort === 'high'), false);
    assert.equal(selectors.permission.mock.calls.some(([permission]) => permission === 'plan'), false);
    if (pendingStage === 'pause acknowledgement') {
      assert.equal(selectors.model.mock.calls.some(([, model]) => model === 'saved-model'), false);
    }
    if (change === 'draft') assert.equal(draft().value, 'newer user draft');
    if (change === 'model') assert.equal(selectors.model.mock.calls.some(([, model]) => model === 'model-1'), true);
    if (change === 'effort') assert.equal(selectors.effort.mock.calls.some(([, effort]) => effort === 'low'), true);
    if (change === 'permission') assert.equal(selectors.permission.mock.calls.some(([permission]) => permission === 'default'), true);
    assert.equal(readQueuedMessage('session-a')?.autoSend, false);
    assert.deepEqual(readQueuedMessage('session-a')?.attachments, savedAttachments);
  });
}

test('hydration before the pause acknowledgement uses the latest ready restoration callback', async () => {
  providerState.ready = false;
  const pendingPause = deferred<Response>();
  transport.saveDraft.mockReturnValueOnce(pendingPause.promise);
  const view = render(<ChatInterface {...props()} />);
  await click('Edit queued message');
  assert.equal(selectors.model.mock.calls.length, 0);
  await act(async () => {
    providerState.ready = true;
    providerState.hydrated = true;
    view.rerender(<ChatInterface {...props()} />);
  });
  await act(async () => { pendingPause.resolve(json()); });
  assert.equal(selectors.model.mock.calls.length, 0);
  const isCurrent = restorationGuard(selectors.hydratedModel.mock.calls, 'saved-model');
  assert.equal(restorationGuard(selectors.effort.mock.calls, 'high'), isCurrent);
  assert.deepEqual(selectors.permission.mock.calls, [['plan']]);
  assert.equal(draft().value, 'saved task');
  assert.equal(selectors.message.mock.calls.length, 0);
});

test('unready F18 options preserve the complete paused editor instead of bypassing the gate', async () => {
  providerState.ready = false;
  render(<ChatInterface {...props()} />);
  await click('Edit queued message');
  assert.equal(selectors.model.mock.calls.length, 0);
  assert.equal(selectors.effort.mock.calls.length, 0);
  assert.equal(selectors.permission.mock.calls.length, 0);
  assert.equal(draft().value, 'saved task');
  assert.equal(screen.getByTestId('attachments').textContent, JSON.stringify(['/asset/saved.txt']));
  assert.deepEqual(readQueuedMessage('session-a'), {
    content: 'saved task', options: savedOptions, attachments: savedAttachments, autoSend: false,
  });
  assert.equal(selectors.message.mock.calls.length, 1);
  assert.match(selectors.message.mock.calls[0][0].content, /Session options are not ready/);
});

test.each(['missing', 'null', 'no options'] as const)('a queue with %s effort shows default without persisting an extra override', async shape => {
  const options = shape === 'no options' ? undefined
    : { model: 'saved-model', ...(shape === 'null' ? { effort: null } : {}), customOption: 'retained' };
  await writeQueuedMessage('session-a', { content: 'default effort task', options, autoSend: false, attachments: savedAttachments });
  render(<ChatInterface {...props()} />);
  await click('Edit queued message');
  assert.equal(selectors.effort.mock.calls.length, 0);
  assert.equal(screen.getByTestId('effort').textContent, 'default');
  assert.deepEqual(readQueuedMessage('session-a')?.options, options);
});

test('the models modal uses the same explicit queued-model update as the composer', async () => {
  render(<ChatInterface {...props()} />);
  await click('Edit queued message');
  await click('Modal model');
  assert.deepEqual(readQueuedMessage('session-a')?.options, { ...savedOptions, model: 'modal-model' });
});
