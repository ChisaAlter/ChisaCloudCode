import assert from 'node:assert/strict';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ChangeEventHandler, RefObject } from 'react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import ChatInterface from '@/modules/chat/ChatInterface';
import type * as ChatProviderStateModule from '@/modules/chat/hooks/useChatProviderState';
import { readQueuedMessage, resetChatDrafts, writeQueuedMessage } from '@/shared/chatDrafts';
import type { ComposerDraftAttachment, ProjectSession } from '@/shared/types';

const requests = vi.hoisted(() => ({
  model: vi.fn(), effort: vi.fn(), read: vi.fn(), catalog: vi.fn(), message: vi.fn(),
  drafts: vi.fn(), saveDraft: vi.fn(), deleteDraft: vi.fn(),
}));
// A read-only UI probe exposes the real provider state that manual queue controls can otherwise mask.
const activeProvider = vi.hoisted(() => ({ model: '', effort: '', ready: false }));
const json = (data: unknown = {}) => new Response(JSON.stringify(data), { status: 200 });
const ok = (data: unknown) => json({ success: true, data });

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/modules/task-master', () => ({ useTasksSettings: () => ({}) }));
vi.mock('@/modules/local-agent', () => ({ PiAgentPanel: () => null }));
vi.mock('@/shared/ui', () => ({ ActionMenu: () => null }));
vi.mock('@/shared/selectedProvider', () => ({ readSelectedProvider: () => 'claude', writeSelectedProvider: vi.fn() }));
vi.mock('@/shared/chisa', () => ({
  isDesktop: () => false, getServerConnectionVersion: () => 0,
  FrontendBridge: {}, onWorkspaceSyncStateChanged: () => () => {},
}));
vi.mock('@/shared/context/WebSocketContext', () => ({ useWebSocket: () => ({ subscribe: () => () => {} }) }));
vi.mock('@/shared/context/SessionProtectionContext', () => ({
  useProcessingSessions: () => new Map(), useSessionProtectionActions: () => ({}),
}));
vi.mock('@/shared/api', () => ({ api: {
  providers: {
    models: (...args: unknown[]) => requests.catalog(...args),
    capabilities: async () => ok({ providers: [{ provider: 'claude', supportsEffort: true,
      permissionModes: ['default', 'plan'], defaultPermissionMode: 'default' }] }),
    sessionActiveModel: (...args: unknown[]) => requests.read(...args),
    setSessionActiveModel: (...args: unknown[]) => requests.model(...args),
    setSessionActiveEffort: (...args: unknown[]) => requests.effort(...args),
    skills: async () => ok({ skills: [] }),
  },
  user: {
    drafts: (...args: unknown[]) => requests.drafts(...args),
    saveDraft: (...args: unknown[]) => requests.saveDraft(...args),
    deleteDraft: (...args: unknown[]) => requests.deleteDraft(...args),
    preferences: async () => json({ preferences: {} }),
  },
  commands: { list: async () => json({ success: true, commands: [] }) },
  files: { search: async () => json({ success: true, files: [] }) },
} }));
vi.mock('@/modules/chat/hooks/useChatProviderState', async importOriginal => {
  const actual = await importOriginal<typeof ChatProviderStateModule>();
  return { ...actual, useChatProviderState: (...args: Parameters<typeof actual.useChatProviderState>) => {
    // Invoke the actual hook unchanged: neither its setters, state nor asynchronous continuations are replaced.
    const state = actual.useChatProviderState(...args);
    activeProvider.model = state.currentProviderModel;
    activeProvider.effort = state.currentProviderEffort;
    activeProvider.ready = state.sessionOptionsReady;
    return state;
  } };
});
vi.mock('@/modules/chat/hooks/useChatSessionState', () => ({
  useChatSessionState: ({ selectedSession }: { selectedSession: ProjectSession }) => ({
    chatMessages: [], visibleMessages: [], currentSessionId: selectedSession.id, isProcessing: false,
    addMessage: requests.message,
  }),
}));
vi.mock('@/modules/chat/hooks/useChatRealtimeHandlers', () => ({ useChatRealtimeHandlers: () => {} }));
vi.mock('@/modules/chat/hooks/useSessionStore', () => ({ useSessionStore: () => ({}) }));
vi.mock('@/modules/chat/composer/useScheduledMessages', () => ({ useScheduledMessages: () => ({ scheduledMessages: [] }) }));
vi.mock('@/modules/chat/transcript/ChatMessagesPane', () => ({ default: () => null }));
vi.mock('@/modules/chat/modals/CommandResultModal', () => ({ default: () => null }));
vi.mock('@/modules/chat/composer/ChatComposer', () => ({ default: ({
  input, onInputChange, textareaRef, onEditQueuedDraft, onSelectModel, onSelectEffort,
  draftAttachments, getInputProps, model, permissionMode,
}: {
  input: string;
  onInputChange: ChangeEventHandler<HTMLTextAreaElement>;
  textareaRef: RefObject<HTMLTextAreaElement>;
  onEditQueuedDraft: () => void;
  onSelectModel: (model: string) => Promise<void>;
  onSelectEffort: (effort: string) => Promise<void>;
  draftAttachments: ComposerDraftAttachment[];
  getInputProps: () => Record<string, unknown>;
  model: string;
  permissionMode: string;
}) => <>
  <button type="button" onClick={onEditQueuedDraft}>Edit queue</button>
  <button type="button" onClick={() => { void onSelectModel('new-model'); }}>Choose new model</button>
  <button type="button" onClick={() => { void onSelectEffort('low'); }}>Choose new effort</button>
  <textarea aria-label="Draft" ref={textareaRef} value={input} onChange={onInputChange} />
  <input {...getInputProps()} aria-label="Attachments" />
  <output data-testid="model">{model}</output>
  <output data-testid="active-model">{activeProvider.model}</output>
  <output data-testid="active-effort">{activeProvider.effort}</output>
  <output data-testid="options-ready">{String(activeProvider.ready)}</output>
  <output data-testid="permission">{permissionMode}</output>
  <output data-testid="attachments">{JSON.stringify(draftAttachments.map(item => item.uploaded?.path ?? item.file?.name))}</output>
</> }));

const savedOptions = { model: 'saved-model', effort: 'high', permissionMode: 'plan' };
const savedAttachments = [{ path: '/asset/saved.txt', name: 'saved.txt', mimeType: 'text/plain' }];
const props = (sessionId = 'session-a') => ({
  isActive: true,
  selectedProject: { projectId: 'project-a', displayName: 'Project A', fullPath: '/srv/project-a' },
  selectedSession: { id: sessionId, __provider: 'claude' as const }, ws: null, sendMessage: () => {},
});
const ui = (id: string) => screen.getByTestId(id).textContent;
const draft = () => screen.getByRole('textbox', { name: 'Draft' }) as HTMLTextAreaElement;
const click = async (name: string) => { await act(async () => { fireEvent.click(screen.getByRole('button', { name })); }); };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function pendingSelection(field: 'model' | 'effort', stage: 'response' | 'body' = 'response') {
  const pending = deferred<unknown>();
  const readBody = vi.fn(() => pending.promise);
  requests[field].mockReturnValueOnce(stage === 'response' ? pending.promise : Promise.resolve({ ok: true, json: readBody }));
  return {
    readBody,
    finish: (value: string) => {
      const body = { success: true, data: { [field]: value, source: 'session' } };
      pending.resolve(stage === 'response' ? json(body) : body);
    },
    reject: pending.reject,
  };
}

async function readyView() {
  const view = render(<ChatInterface {...props()} />);
  await waitFor(() => assert.equal(ui('options-ready'), 'true'));
  assert.equal(ui('active-model'), 'active-model');
  assert.equal(ui('active-effort'), 'medium');
  return view;
}

async function editDraft(kind: 'text' | 'attachment') {
  if (kind === 'text') await act(async () => { fireEvent.change(draft(), { target: { value: 'newer draft' } }); });
  else {
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Attachments'), {
        target: { files: [new File(['new contents'], 'new.txt', { type: 'text/plain' })] },
      });
    });
    await waitFor(() => assert.match(ui('attachments') ?? '', /new\.txt/));
  }
}

beforeEach(async () => {
  localStorage.clear();
  resetChatDrafts();
  vi.resetAllMocks();
  const models = ['active-model', 'saved-model', 'normalized-model', 'fresh-model', 'other-model', 'new-model', 'new-model-normalized'];
  const effort = { values: ['low', 'medium', 'high', 'xhigh'].map(value => ({ value })) };
  requests.catalog.mockImplementation(async () => ok({ models: {
    DEFAULT: 'active-model', OPTIONS: models.map(value => ({ value, label: value, effort })),
  } }));
  requests.read.mockImplementation(async () => ok({ model: 'active-model', effort: 'medium', source: 'session' }));
  requests.model.mockImplementation(async (_provider: string, _sessionId: string, model: string) => ok({ model, source: 'session' }));
  requests.effort.mockImplementation(async (_provider: string, _sessionId: string, effort: string) => ok({ effort, source: 'session' }));
  requests.saveDraft.mockImplementation(async () => json());
  requests.deleteDraft.mockImplementation(async () => json());
  requests.drafts.mockImplementation(async () => json({ drafts: [] }));
  await writeQueuedMessage('session-a', {
    content: 'saved task', attachments: savedAttachments, options: savedOptions, autoSend: false,
  });
});
afterEach(resetChatDrafts);

for (const stage of ['response', 'body'] as const) {
  test.each(['text', 'attachment'] as const)(`editing same-scope %s while the model ${stage} waits prevents its real state commit`, async kind => {
    await readyView();
    const pending = pendingSelection('model', stage);
    await click('Edit queue');
    assert.deepEqual(requests.model.mock.calls, [['claude', 'session-a', 'saved-model']]);
    if (stage === 'body') assert.equal(pending.readBody.mock.calls.length, 1);
    await editDraft(kind);
    await act(async () => { pending.finish('normalized-model'); });
    assert.equal(ui('model'), 'active-model');
    assert.equal(ui('active-model'), 'active-model');
    assert.equal(ui('active-effort'), 'medium');
    assert.equal(ui('permission'), 'default');
    assert.equal(requests.effort.mock.calls.length, 0);
    assert.equal(requests.message.mock.calls.length, 0);
    assert.equal(readQueuedMessage('session-a')?.autoSend, false);
    if (kind === 'text') assert.equal(draft().value, 'newer draft');
    else assert.match(ui('attachments') ?? '', /new\.txt/);
  });
}

test.each(['text', 'attachment'] as const)('a rejected model restore does not surface its old error after a same-scope %s edit', async kind => {
  await readyView();
  const pending = pendingSelection('model');
  await click('Edit queue');
  await editDraft(kind);
  await act(async () => { pending.reject(new Error('old model request failed')); });
  assert.equal(ui('model'), 'active-model');
  assert.equal(ui('active-effort'), 'medium');
  assert.equal(requests.effort.mock.calls.length, 0);
  assert.equal(requests.message.mock.calls.length, 0);
});

test('an old model response cannot commit into the fresh A generation after A to B to A', async () => {
  const view = await readyView();
  const pending = pendingSelection('model');
  await click('Edit queue');
  requests.read.mockImplementation(async (_provider: string, sessionId: string) => ok({
    model: sessionId === 'session-a' ? 'fresh-model' : 'other-model', effort: 'low', source: 'session',
  }));
  await act(async () => { view.rerender(<ChatInterface {...props('session-b')} />); });
  await waitFor(() => assert.equal(ui('active-model'), 'other-model'));
  await act(async () => { view.rerender(<ChatInterface {...props()} />); });
  await waitFor(() => assert.equal(ui('active-model'), 'fresh-model'));
  await act(async () => { pending.finish('normalized-model'); });
  assert.equal(ui('model'), 'fresh-model');
  assert.equal(ui('active-model'), 'fresh-model');
  assert.equal(ui('active-effort'), 'low');
  assert.equal(requests.effort.mock.calls.length, 0);
  assert.equal(requests.message.mock.calls.length, 0);
});

for (const stage of ['response', 'body'] as const) {
  test.each(['text', 'attachment'] as const)(`editing same-scope %s while the effort ${stage} waits blocks a normalized real effort commit`, async kind => {
    await readyView();
    const pending = pendingSelection('effort', stage);
    await click('Edit queue');
    assert.equal(ui('active-model'), 'saved-model');
    assert.equal(ui('active-effort'), 'high');
    if (stage === 'body') assert.equal(pending.readBody.mock.calls.length, 1);
    await editDraft(kind);
    await act(async () => { pending.finish('xhigh'); });
    assert.equal(ui('active-effort'), 'high');
    assert.equal(ui('permission'), 'default');
    assert.equal(requests.message.mock.calls.length, 0);
    assert.equal(readQueuedMessage('session-a')?.autoSend, false);
  });
}

test.each(['text', 'attachment'] as const)('a rejected effort restore cannot roll back after a same-scope %s edit', async kind => {
  await readyView();
  const pending = pendingSelection('effort');
  await click('Edit queue');
  assert.equal(ui('active-effort'), 'high');
  await editDraft(kind);
  await act(async () => { pending.reject(new Error('old effort request failed')); });
  assert.equal(ui('active-effort'), 'high');
  assert.equal(ui('permission'), 'default');
  assert.equal(requests.message.mock.calls.length, 0);
});

test.each(['normalized success', 'failed rollback'] as const)('an old effort %s cannot overwrite the fresh A generation', async outcome => {
  const view = await readyView();
  const pending = pendingSelection('effort');
  await click('Edit queue');
  assert.equal(ui('active-effort'), 'high');
  requests.read.mockImplementation(async (_provider: string, sessionId: string) => ok({
    model: sessionId === 'session-a' ? 'fresh-model' : 'other-model',
    // Matching the old optimistic value makes an unguarded failure roll back to medium.
    effort: sessionId === 'session-a' ? 'high' : 'low', source: 'session',
  }));
  await act(async () => { view.rerender(<ChatInterface {...props('session-b')} />); });
  await waitFor(() => assert.equal(ui('active-effort'), 'low'));
  await act(async () => { view.rerender(<ChatInterface {...props()} />); });
  await waitFor(() => assert.equal(ui('active-model'), 'fresh-model'));
  assert.equal(ui('active-effort'), 'high');
  await act(async () => {
    if (outcome === 'normalized success') pending.finish('xhigh');
    else pending.reject(new Error('old effort request failed'));
  });
  assert.equal(ui('active-model'), 'fresh-model');
  assert.equal(ui('active-effort'), 'high');
  assert.equal(requests.message.mock.calls.length, 0);
});

test.each(['model', 'effort'] as const)('an explicit new %s selection keeps the original three-argument path and supersedes the restore', async field => {
  await readyView();
  const pending = pendingSelection(field);
  if (field === 'model') requests.model.mockImplementation(async (_provider: string, _sessionId: string, model: string) => ok({
    model: model === 'new-model' ? 'new-model-normalized' : model, source: 'session',
  }));
  else requests.effort.mockImplementation(async () => ok({ effort: 'xhigh', source: 'session' }));
  await click('Edit queue');
  await click(field === 'model' ? 'Choose new model' : 'Choose new effort');
  const accepted = field === 'model' ? 'new-model-normalized' : 'xhigh';
  assert.equal(ui(field === 'model' ? 'active-model' : 'active-effort'), accepted);
  assert.deepEqual(requests[field].mock.calls, [
    ['claude', 'session-a', field === 'model' ? 'saved-model' : 'high'],
    ['claude', 'session-a', field === 'model' ? 'new-model' : 'low'],
  ]);
  await act(async () => { pending.finish(field === 'model' ? 'normalized-model' : 'medium'); });
  assert.equal(ui(field === 'model' ? 'active-model' : 'active-effort'), accepted);
  assert.equal(readQueuedMessage('session-a')?.options?.[field], accepted);
  assert.equal(requests.message.mock.calls.length, 0);
});
