import assert from 'node:assert/strict';

import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { createInstance } from 'i18next';
import { createElement } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, test, vi } from 'vitest';

import ChatComposer from '@/modules/chat/composer/ChatComposer';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { hydrateChatDrafts, readDraftText, readQueuedMessage, resetChatDrafts, writeDraftText, writeQueuedMessage } from '@/shared/chatDrafts';
import { clearAuthToken } from '@/shared/authToken';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import type { ChisaSyncInfo, PendingPermissionRequest, PermissionMode, Project, ProjectSession, QueuedSendOptions } from '@/shared/types';

/**
 * Drafts used to be keyed by project, so every session in a project shared one
 * draft and switching sessions carried the previous one's half-typed message
 * across. They are keyed by session now (and by project only for a chat that
 * has not been sent yet), which is what lets a draft be picked up on another
 * device against the session it belongs to.
 *
 * These tests drive the real hook, so the effect ordering that decides which
 * scope a keystroke lands in is exercised rather than described.
 */

const PROJECT: Project = {
  projectId: 'project-1',
  displayName: 'Project One',
  fullPath: '/tmp/project-one',
};

// The composer only ever reaches the network through these; stubbing them keeps
// the test about draft scoping rather than about fetch behaviour in jsdom.
const transport = vi.hoisted(() => ({ createSession: vi.fn(), uploadFiles: vi.fn(), drafts: vi.fn(), saveDraft: vi.fn(), deleteDraft: vi.fn(), listCommands: vi.fn(), executeCommand: vi.fn() }));
const native = vi.hoisted(() => ({
  desktop: false,
  connectionVersion: 0,
  getProjectSync: vi.fn(),
  listeners: new Set<(info: ChisaSyncInfo) => void>(),
}));
vi.mock('@/shared/chisa', () => ({
  isDesktop: () => native.desktop,
  getServerConnectionVersion: () => native.connectionVersion,
  FrontendBridge: { getProjectSync: native.getProjectSync },
  onWorkspaceSyncStateChanged: (listener: (info: ChisaSyncInfo) => void) => {
    native.listeners.add(listener);
    return () => { native.listeners.delete(listener); };
  },
}));
const okJson = (data: unknown = {}): Response => new Response(JSON.stringify(data), { status: 200 });
vi.mock('@/shared/api', () => {
  const ok = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });
  return {
    api: {
      user: {
        drafts: transport.drafts,
        saveDraft: transport.saveDraft,
        deleteDraft: transport.deleteDraft,
        preferences: () => ok({ success: true, preferences: {} }),
        savePreferences: () => ok({ success: true, preferences: {} }),
      },
      commands: { list: transport.listCommands, execute: transport.executeCommand },
      providers: { skills: () => ok({ success: true, data: { skills: [] } }), createSession: transport.createSession },
      files: { search: () => ok({ success: true, files: [] }) },
      assets: { uploadFiles: transport.uploadFiles },
    },
  };
});

const cloudSend = vi.fn();
const userEcho = vi.fn();
const markProcessing = vi.fn();
const established = vi.fn();
const permissions = vi.fn();

const renderComposer = (selectedSession: ProjectSession | null, options: { busy?: boolean; canSubmitCloud?: () => boolean; abortable?: boolean; model?: string; sessionOptionsReady?: boolean; onRestoreQueuedOptions?: (options: QueuedSendOptions, isCurrent: () => boolean) => void | Promise<void> } = {}) => renderHook(
  ({ session, project }: { session: ProjectSession | null; project: Project }) => useChatComposerState({
    isActive: true,
    selectedProject: project,
    selectedSession: session,
    currentSessionId: session?.id ?? null,
    provider: 'claude',
    permissionMode: 'default',
    cyclePermissionMode: () => undefined,
    resolvePermissionModeForProvider: () => 'default' as PermissionMode,
    currentProviderModel: options.model ?? 'test-model',
    currentProviderEffort: 'medium',
    sessionOptionsReady: options.sessionOptionsReady,
    onRestoreQueuedOptions: options.onRestoreQueuedOptions,
    isLoading: options.busy ?? false,
    canAbortSession: options.abortable ?? false,
    tokenBudget: null,
    sendMessage: cloudSend,
    canSubmitCloud: options.canSubmitCloud,
    onSessionProcessing: markProcessing,
    onSessionEstablished: established,
    scrollToBottom: () => undefined,
    addMessage: userEcho,
    setIsUserScrolledUp: () => undefined,
    setPendingPermissionRequests: permissions,
  }),
  { initialProps: { session: selectedSession, project: PROJECT } },
);

beforeEach(() => {
  localStorage.clear();
  // The drafts store is a module-level singleton, so its in-memory copy
  // outlives localStorage.clear() and would leak one test's drafts into the next.
  resetChatDrafts();
  vi.resetAllMocks();
  native.desktop = false;
  native.connectionVersion = 0;
  native.listeners.clear();
  native.getProjectSync.mockResolvedValue(syncInfo('ready', 1));
  transport.saveDraft.mockResolvedValue(okJson({ success: true }));
  transport.deleteDraft.mockResolvedValue(okJson({ success: true }));
  transport.drafts.mockResolvedValue(okJson({ drafts: [] }));
  transport.createSession.mockResolvedValue(okJson({ data: { sessionId: 'created-session' } }));
  transport.uploadFiles.mockResolvedValue(okJson({ attachments: [{ name: 'image.png', path: '/asset/image.png', mimeType: 'image/png' }] }));
  transport.listCommands.mockImplementation(async () => okJson({ success: true, commands: [] }));
});
afterEach(() => resetChatDrafts());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const submitEvent = () => ({ preventDefault() {} }) as never;

function syncInfo(status: string, sequence: number, overrides: Partial<ChisaSyncInfo> = {}): ChisaSyncInfo {
  return { status, sequence, bindingEpoch: 'binding-a', checkedAt: '2026-10-06T10:24:00Z', serverPath: PROJECT.fullPath!, ...overrides };
}

function emitWorkspace(info: ChisaSyncInfo) {
  native.getProjectSync.mockResolvedValue(info);
  for (const listener of native.listeners) listener(info);
}

function desktopWorkspace(status = 'syncing') {
  native.desktop = true;
  native.getProjectSync.mockResolvedValue(syncInfo(status, 1));
}

// Render the real composer around this hook so restored attachment controls use the public draft items.
async function createComposerRenderInput(hook: ReturnType<typeof renderComposer>, options: { sendOptionsReady?: boolean; model?: string; busy?: boolean } = {}) {
  const i18n = createInstance();
  await i18n.init({ lng: 'en', resources: { en: { chat: { input: { send: 'Send' } } } } });
  const noop = () => undefined;
  return () => {
    const state = hook.result.current;
    return createElement(I18nextProvider, { i18n }, createElement(UiPreferencesProvider, null,
      createElement(ChatComposer, {
        pendingPermissionRequests: [], activity: null, isLoading: options.busy ?? false,
        handlePermissionDecision: state.handlePermissionDecision,
        handleGrantToolPermission: state.handleGrantToolPermission,
        onAbortSession: state.handleAbortSession,
        permissionMode: 'default', availablePermissionModes: ['default'], onSelectPermissionMode: noop,
        providerLabel: 'Claude', effort: 'medium', availableEffortOptions: [], onSelectEffort: noop,
        model: options.model ?? 'test-model', availableModelOptions: [], onSelectModel: noop, modelsLoading: false,
        sendOptionsReady: options.sendOptionsReady ?? true,
        canSubmitWithoutModelOptions: state.canSubmitWithoutModelOptions,
        onToggleCommandMenu: state.handleToggleCommandMenu,
        hasInput: Boolean(state.input.trim()), onClearInput: state.handleClearInput, onSubmit: state.handleSubmit,
        isDragActive: state.isDragActive, queuedDraft: state.queuedDraft,
        workspacePendingDraft: state.workspacePendingDraft, workspacePendingNotice: state.workspacePendingNotice,
        isWaitingForWorkspace: state.isWaitingForWorkspace,
        onCancelWorkspaceSend: state.cancelWorkspaceSend, onEditWorkspaceSend: state.editWorkspaceSend,
        isEditingSentMessage: Boolean(state.editingAnchorId), onCancelEditMessage: state.cancelEditMessage,
        scheduledMessages: [], onScheduleMessage: noop, onCancelScheduledMessage: noop,
        onEditQueuedDraft: state.editQueuedDraft, onDeleteQueuedDraft: state.deleteQueuedDraft,
        attachedFiles: state.attachedFiles, draftAttachments: state.draftAttachments,
        onRemoveAttachment: state.removeDraftAttachment,
        fileErrors: state.fileErrors, showFileDropdown: state.showFileDropdown,
        filteredFiles: state.filteredFiles, selectedFileIndex: state.selectedFileIndex, onSelectFile: state.selectFile,
        filteredCommands: state.filteredCommands, selectedCommandIndex: state.selectedCommandIndex,
        onCommandSelect: state.handleCommandSelect, onCloseCommandMenu: state.resetCommandMenuState,
        isCommandMenuOpen: state.showCommandMenu, frequentCommands: state.frequentCommands,
        getRootProps: state.getRootProps as (...args: unknown[]) => Record<string, unknown>,
        getInputProps: state.getInputProps as (...args: unknown[]) => Record<string, unknown>,
        openAttachmentPicker: state.openAttachmentPicker, inputHighlightRef: state.inputHighlightRef,
        renderInputWithMentions: state.renderInputWithMentions, textareaRef: state.textareaRef, input: state.input,
        onInputChange: state.handleInputChange, onTextareaClick: state.handleTextareaClick,
        onTextareaKeyDown: state.handleKeyDown, onTextareaPaste: state.handlePaste,
        onTextareaScrollSync: state.syncInputOverlayScroll, onTextareaInput: state.handleTextareaInput,
        placeholder: 'Message draft', isTextareaExpanded: state.isTextareaExpanded,
      })));
  };
}

test('a draft is stored under the open session, not the project', async () => {
  const view = renderComposer({ id: 'session-a' });

  await act(async () => {
    view.result.current.setInput('for session A');
  });

  assert.equal(readDraftText('session-a'), 'for session A');
  assert.equal(readDraftText(`project:${PROJECT.projectId}`), '');
});

test('a chat with no session yet is stored under its project', async () => {
  const view = renderComposer(null);

  await act(async () => {
    view.result.current.setInput('not sent yet');
  });

  assert.equal(readDraftText(`project:${PROJECT.projectId}`), 'not sent yet');
});

test('switching sessions swaps the draft instead of carrying it across', async () => {
  writeDraftText('session-b', 'for session B');
  const view = renderComposer({ id: 'session-a' });

  await act(async () => {
    view.result.current.setInput('for session A');
  });

  await act(async () => {
    view.rerender({ session: { id: 'session-b' }, project: PROJECT });
  });

  assert.equal(view.result.current.input, 'for session B');
  assert.equal(
    readDraftText('session-a'),
    'for session A',
    "the previous session's draft must survive the switch",
  );
  assert.equal(
    readDraftText('session-b'),
    'for session B',
    "the new session's draft must not be overwritten by the previous one's text",
  );
});

test('switching back restores the draft that was left behind', async () => {
  const view = renderComposer({ id: 'session-a' });

  await act(async () => {
    view.result.current.setInput('for session A');
  });
  await act(async () => {
    view.rerender({ session: { id: 'session-b' }, project: PROJECT });
  });
  await act(async () => {
    view.rerender({ session: { id: 'session-a' }, project: PROJECT });
  });

  assert.equal(view.result.current.input, 'for session A');
});

test('unsent files belong to their session and survive sending from another session', async () => {
  const fileA = new File(['private A attachment'], 'session-a.txt', { type: 'text/plain' });
  const view = renderComposer({ id: 'session-a' });
  await act(async () => {
    view.result.current.setInput('A draft');
    view.result.current.setAttachedFiles([fileA]);
  });
  await act(async () => { view.rerender({ session: { id: 'session-b' }, project: PROJECT }); });
  const draftAttachmentsInB = view.result.current.draftAttachments;
  const attachedFilesInB = view.result.current.attachedFiles;
  assert.deepEqual(draftAttachmentsInB, []);
  assert.deepEqual(attachedFilesInB, []);
  await act(async () => { view.result.current.setInput('B message'); });
  await act(async () => { await view.result.current.handleSubmit(submitEvent()); });

  assert.equal(transport.uploadFiles.mock.calls.length, 0);
  assert.equal(cloudSend.mock.calls.length, 1);
  assert.equal(cloudSend.mock.calls[0][0].sessionId, 'session-b');
  assert.deepEqual(cloudSend.mock.calls[0][0].options.attachments, []);

  await act(async () => { view.rerender({ session: { id: 'session-a' }, project: PROJECT }); });
  assert.equal(view.result.current.input, 'A draft');
  assert.equal(view.result.current.attachedFiles[0], fileA);
  assert.equal(view.result.current.draftAttachments[0].file, fileA);
});

test('a draft written on another device is picked up while the session is open', async () => {
  const view = renderComposer({ id: 'session-a' });

  await act(async () => {
    // Stands in for a hydrate delivering what was typed elsewhere.
    writeDraftText('session-a', 'typed on the phone');
  });

  assert.equal(view.result.current.input, 'typed on the phone');
});

test('clearing the composer clears that session\'s stored draft', async () => {
  const view = renderComposer({ id: 'session-a' });

  await act(async () => {
    view.result.current.setInput('typed');
  });
  assert.equal(readDraftText('session-a'), 'typed');

  await act(async () => {
    view.result.current.setInput('');
  });

  assert.equal(readDraftText('session-a'), '');
});

test('a local project lock blocks sends without creating a cloud queue or losing the editable draft',async()=>{
  const view=renderComposer({id:'session-a'},{canSubmitCloud:()=>false});
  await act(async()=>{view.result.current.setInput('keep this draft');await view.result.current.handleSubmit({preventDefault(){}} as never);});
  assert.equal(cloudSend.mock.calls.length,0);
  assert.equal(userEcho.mock.calls.length,0);
  assert.equal(readQueuedMessage('session-a'),null);
  assert.equal(view.result.current.input,'keep this draft');
});

for (const busy of [false, true]) {
  test(`unready session send options block ${busy ? 'queueing' : 'sending'} without consuming the draft`, async () => {
    const options = { busy, sessionOptionsReady: false };
    const view = renderComposer({ id: 'session-a' }, options);
    const attachment = new File(['keep'], 'keep.txt', { type: 'text/plain' });
    await act(async () => {
      view.result.current.setInput('wait for this session options');
      view.result.current.setAttachedFiles([attachment]);
    });
    await act(async () => { await view.result.current.handleSubmit(submitEvent()); });
    assert.equal(cloudSend.mock.calls.length, 0);
    assert.equal(transport.uploadFiles.mock.calls.length, 0);
    assert.equal(transport.createSession.mock.calls.length, 0);
    assert.equal(readQueuedMessage('session-a'), null);
    assert.equal(view.result.current.input, 'wait for this session options');
    assert.equal(readDraftText('session-a'), 'wait for this session options');
    assert.equal(view.result.current.draftAttachments[0].file, attachment);

    options.sessionOptionsReady = true;
    await act(async () => { view.rerender({ session: { id: 'session-a' }, project: PROJECT }); });
    await act(async () => { await view.result.current.handleSubmit(submitEvent()); });
    assert.equal(transport.uploadFiles.mock.calls.length, 1);
    if (busy) {
      assert.equal(cloudSend.mock.calls.length, 0);
      assert.equal(readQueuedMessage('session-a')?.content, 'wait for this session options');
      assert.equal(view.result.current.queuedDraft?.uploadedAttachments?.length, 1);
    } else {
      assert.equal(cloudSend.mock.calls.length, 1);
      assert.equal(cloudSend.mock.calls[0][0].content, 'wait for this session options');
      assert.equal(cloudSend.mock.calls[0][0].options.attachments.length, 1);
    }
    assert.equal(view.result.current.input, '');
    assert.deepEqual(view.result.current.draftAttachments, []);
  });
}

for (const input of ['/help', 'help', '/status', 'ordinary model request']) {
  test(`Enter ${input.startsWith('/') || input === 'help' ? 'executes ' + input : 'preserves ordinary text'} while session model options are unavailable`, async () => {
    // Help is deliberately absent so both spellings exercise the existing help fallback.
    transport.listCommands.mockImplementation(async () => okJson({ builtIn: [{ name: '/status', namespace: 'builtin' }], custom: [] }));
    const kind = input === '/status' ? 'status' : 'help';
    const result = { message: `${kind} command result` };
    transport.executeCommand.mockResolvedValue(okJson({ type: 'builtin', action: kind, data: result }));
    const hook = renderComposer({ id: 'session-a' }, { sessionOptionsReady: false, model: '' });
    await act(async () => { hook.result.current.setInput(input); });
    const renderInput = await createComposerRenderInput(hook, { sendOptionsReady: false, model: '' });
    const composer = render(renderInput());

    await act(async () => { fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', code: 'Enter' }); });
    composer.rerender(renderInput());
    if (input === 'ordinary model request') {
      assert.equal(transport.executeCommand.mock.calls.length, 0);
      assert.equal(hook.result.current.input, input);
      assert.equal(readDraftText('session-a'), input);
      assert.equal(hook.result.current.commandModalPayload, null);
    } else {
      assert.equal(transport.executeCommand.mock.calls.length, 1);
      assert.deepEqual(transport.executeCommand.mock.calls[0][0], {
        commandName: kind === 'status' ? '/status' : '/help', commandPath: undefined, args: [],
        context: { projectPath: PROJECT.fullPath, projectId: PROJECT.projectId, sessionId: 'session-a', provider: 'claude', model: '', tokenUsage: null },
      });
      assert.deepEqual(hook.result.current.commandModalPayload, { kind, data: result });
      assert.equal(hook.result.current.input, '');
      assert.equal(readDraftText('session-a'), '');
    }
    assert.equal(cloudSend.mock.calls.length, 0);
    assert.equal(readQueuedMessage('session-a'), null);
    assert.equal(transport.uploadFiles.mock.calls.length, 0);
    assert.equal(transport.createSession.mock.calls.length, 0);
    assert.equal(markProcessing.mock.calls.length, 0);
    assert.equal(userEcho.mock.calls.length, 0);
  });
}

test('Enter on a busy builtin still waits for restored model options rather than executing or queueing it', async () => {
  transport.listCommands.mockImplementation(async () => okJson({ builtIn: [{ name: '/status', namespace: 'builtin' }], custom: [] }));
  const hook = renderComposer({ id: 'session-a' }, { busy: true, sessionOptionsReady: false, model: '' });
  await act(async () => { hook.result.current.setInput('/status'); });
  const renderInput = await createComposerRenderInput(hook, { sendOptionsReady: false, model: '', busy: true });
  render(renderInput());
  const submitButton = screen.getByRole('button', { name: '正在恢复会话模型设置' }) as HTMLButtonElement;
  assert.equal(submitButton.disabled, true);
  await act(async () => { fireEvent.click(submitButton); });
  await act(async () => { fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', code: 'Enter' }); });
  assert.equal(hook.result.current.input, '/status');
  assert.equal(readDraftText('session-a'), '/status');
  assert.equal(transport.executeCommand.mock.calls.length, 0);
  assert.equal(cloudSend.mock.calls.length, 0);
  assert.equal(readQueuedMessage('session-a'), null);
  assert.equal(transport.uploadFiles.mock.calls.length, 0);
  assert.equal(transport.createSession.mock.calls.length, 0);
  assert.equal(markProcessing.mock.calls.length, 0);
});

for (const input of ['/help', 'help', '/status', 'ordinary model request']) {
  test(`the real submit button ${input === 'ordinary model request' ? 'blocks ordinary text' : 'runs ' + input} without restored model options, while scheduling stays blocked`, async () => {
    transport.listCommands.mockImplementation(async () => okJson({ builtIn: [{ name: '/status', namespace: 'builtin' }], custom: [] }));
    const kind = input === '/status' ? 'status' : 'help';
    const result = { message: `${kind} click result` };
    transport.executeCommand.mockResolvedValue(okJson({ type: 'builtin', action: kind, data: result }));
    const hook = renderComposer({ id: 'session-a' }, { sessionOptionsReady: false, model: '' });
    await act(async () => { hook.result.current.setInput(input); });
    const renderInput = await createComposerRenderInput(hook, { sendOptionsReady: false, model: '' });
    const composer = render(renderInput());
    const scheduleButton = screen.getByRole('button', { name: 'schedule.trigger' }) as HTMLButtonElement;
    assert.equal(scheduleButton.disabled, true, 'builtin submit eligibility must not enable scheduling');
    await act(async () => { fireEvent.click(scheduleButton); });
    assert.equal(scheduleButton.getAttribute('aria-expanded'), 'false');
    const ordinary = input === 'ordinary model request';
    const submitButton = screen.getByRole('button', { name: ordinary ? '正在恢复会话模型设置' : 'Send' }) as HTMLButtonElement;
    assert.equal(submitButton.disabled, ordinary);
    assert.equal(Boolean(submitButton.querySelector('.animate-spin')), ordinary);

    await act(async () => { fireEvent.click(submitButton); });
    composer.rerender(renderInput());
    if (ordinary) {
      assert.equal(transport.executeCommand.mock.calls.length, 0);
      assert.equal(hook.result.current.input, input);
      assert.equal(readDraftText('session-a'), input);
      assert.equal(hook.result.current.commandModalPayload, null);
    } else {
      assert.equal(transport.executeCommand.mock.calls.length, 1);
      assert.equal(transport.executeCommand.mock.calls[0][0].commandName, kind === 'status' ? '/status' : '/help');
      assert.deepEqual(hook.result.current.commandModalPayload, { kind, data: result });
      assert.equal(hook.result.current.input, '');
      assert.equal(readDraftText('session-a'), '');
    }
    assert.equal(cloudSend.mock.calls.length, 0);
    assert.equal(readQueuedMessage('session-a'), null);
    assert.equal(transport.uploadFiles.mock.calls.length, 0);
    assert.equal(transport.createSession.mock.calls.length, 0);
    assert.equal(markProcessing.mock.calls.length, 0);
  });
}

test('a disconnected send keeps text, attachments and the editing anchor without a user echo or processing state', async () => {
  cloudSend.mockImplementation(() => { throw new Error('connection closed'); });
  const view = renderComposer({ id: 'session-a' });
  await act(async () => {
    view.result.current.beginEditMessage({ type: 'user', content: 'replace this', transcriptAnchorId: 'anchor-a', timestamp: new Date() });
    view.result.current.setAttachedFiles([new File(['png'], 'image.png', { type: 'image/png' })]);
  });
  await act(async () => { await view.result.current.handleSubmit(submitEvent()); });
  assert.equal(view.result.current.input, 'replace this');
  assert.equal(readDraftText('session-a'), 'replace this');
  assert.equal(view.result.current.attachedFiles.length, 1);
  assert.equal(view.result.current.editingAnchorId, 'anchor-a');
  assert.equal(markProcessing.mock.calls.length, 0);
  assert.equal(userEcho.mock.calls.filter(([message]) => message.type === 'user').length, 0);
  assert.match(userEcho.mock.calls.at(-1)?.[0].content, /connection closed/);
});

test('stop and permission transport failures are visible and do not consume the existing task or permission state', async () => {
  cloudSend.mockImplementation(() => { throw new Error('connection closed'); });
  const view = renderComposer({ id: 'session-a' }, { abortable: true });
  await act(async () => {
    view.result.current.handleAbortSession();
    view.result.current.handlePermissionDecision('permission-a', { allow: true, rememberEntry: 'Bash(git:*)' });
  });
  assert.equal(permissions.mock.calls.length, 0);
  assert.equal(markProcessing.mock.calls.length, 0);
  assert.equal(userEcho.mock.calls.length, 2);
  assert.match(userEcho.mock.calls[0]?.[0].content, /停止请求未发送/);
  assert.match(userEcho.mock.calls[1]?.[0].content, /权限回复未全部发送/);
});

test('only permission frames accepted by the socket are removed after a partial batch failure', async () => {
  cloudSend.mockImplementationOnce(() => undefined).mockImplementationOnce(() => { throw new Error('second frame closed'); });
  const view = renderComposer({ id: 'session-a' });
  await act(async () => { view.result.current.handlePermissionDecision(['permission-a', 'permission-b'], { allow: false }); });
  const update = permissions.mock.calls[0]?.[0] as (previous: PendingPermissionRequest[]) => PendingPermissionRequest[];
  assert.deepEqual(update([{ requestId: 'permission-a' }, { requestId: 'permission-b' }] as PendingPermissionRequest[]).map((item) => item.requestId), ['permission-b']);
});

test('an attachment upload finishing after a session switch cannot dispatch the old message or clear the new draft', async () => {
  const upload = deferred<Response>();
  transport.uploadFiles.mockReturnValue(upload.promise);
  const view = renderComposer({ id: 'session-a' });
  await act(async () => {
    view.result.current.setInput('A task');
    view.result.current.setAttachedFiles([new File(['png'], 'image.png', { type: 'image/png' })]);
  });
  let submitting!: Promise<void>;
  await act(async () => { submitting = view.result.current.handleSubmit(submitEvent()); });
  await act(async () => { view.rerender({ session: { id: 'session-b' }, project: PROJECT }); });
  await act(async () => { view.result.current.setInput('B draft'); });
  await act(async () => { upload.resolve(okJson({ attachments: [{ name: 'image.png' }] })); await submitting; });
  assert.equal(cloudSend.mock.calls.length, 0);
  assert.equal(established.mock.calls.length, 0);
  assert.equal(view.result.current.input, 'B draft');
  assert.equal(readDraftText('session-a'), 'A task');
  assert.equal(readDraftText('session-b'), 'B draft');
});

test('editing or adding an attachment during upload invalidates the old submission while retaining the newer draft', async () => {
  const upload = deferred<Response>();
  transport.uploadFiles.mockReturnValue(upload.promise);
  const view = renderComposer({ id: 'session-a' });
  await act(async () => {
    view.result.current.setInput('old task');
    view.result.current.setAttachedFiles([new File(['png'], 'image.png', { type: 'image/png' })]);
  });
  let submitting!: Promise<void>;
  await act(async () => { submitting = view.result.current.handleSubmit(submitEvent()); });
  await act(async () => {
    view.result.current.setInput('new task');
    view.result.current.setAttachedFiles((files) => [...files, new File(['two'], 'new.txt')]);
  });
  await act(async () => { upload.resolve(okJson({ attachments: [{ name: 'image.png' }] })); await submitting; });
  assert.equal(cloudSend.mock.calls.length, 0);
  assert.equal(view.result.current.input, 'new task');
  assert.equal(view.result.current.attachedFiles.length, 2);
});

for (const transition of ['project-switch', 'logout'] as const) {
  test(`a delayed new-session reply after ${transition} does not navigate or send`, async () => {
    const created = deferred<Response>();
    transport.createSession.mockReturnValue(created.promise);
    const view = renderComposer(null);
    await act(async () => { view.result.current.setInput('old project task'); });
    let submitting!: Promise<void>;
    await act(async () => { submitting = view.result.current.handleSubmit(submitEvent()); });
    await act(async () => {
      if (transition === 'project-switch') {
        view.rerender({ session: null, project: { ...PROJECT, projectId: 'project-2', fullPath: '/tmp/project-two' } });
      } else {
        clearAuthToken();
        resetChatDrafts();
      }
    });
    await act(async () => { view.result.current.setInput('new draft'); });
    await act(async () => { created.resolve(okJson({ data: { sessionId: 'late-session' } })); await submitting; });
    assert.equal(established.mock.calls.length, 0);
    assert.equal(cloudSend.mock.calls.length, 0);
    assert.equal(view.result.current.input, 'new draft');
  });
}

test('repeated submits during new-session allocation create and send only one request', async () => {
  const created = deferred<Response>();
  transport.createSession.mockReturnValue(created.promise);
  const view = renderComposer(null);
  await act(async () => { view.result.current.setInput('one task'); });
  let submitting!: Promise<void>;
  await act(async () => {
    submitting = view.result.current.handleSubmit(submitEvent());
    await view.result.current.handleSubmit(submitEvent());
  });
  assert.equal(transport.createSession.mock.calls.length, 1);
  await act(async () => { created.resolve(okJson({ data: { sessionId: 'new-session' } })); await submitting; });
  assert.equal(cloudSend.mock.calls.length, 1);
  assert.equal(established.mock.calls.length, 1);
  assert.equal(userEcho.mock.calls.filter(([message]) => message.type === 'user').length, 1);
  assert.equal(view.result.current.input, '');
});

test('a failed queue acknowledgement keeps editable text and does not claim the message was sent', async () => {
  transport.saveDraft.mockResolvedValue(new Response(JSON.stringify({ error: 'storage failed' }), { status: 500 }));
  const view = renderComposer({ id: 'session-a' }, { busy: true });
  await act(async () => { view.result.current.setInput('queued task'); });
  await act(async () => { await view.result.current.handleSubmit(submitEvent()); });
  assert.equal(view.result.current.input, 'queued task');
  assert.equal(readDraftText('session-a'), 'queued task');
  assert.equal(cloudSend.mock.calls.length, 0);
  assert.equal(view.result.current.queuedDraft, null);
  assert.match(userEcho.mock.calls.at(-1)?.[0].content, /排队消息未确认/);
});

test('a failed queue cancellation remains visible instead of being treated as a dispatcher claim', async () => {
  await writeQueuedMessage('session-a', { content: 'queued task' });
  const view = renderComposer({ id: 'session-a' });
  transport.deleteDraft.mockResolvedValue(new Response(JSON.stringify({ error: 'delete failed' }), { status: 500 }));
  await act(async () => { view.result.current.deleteQueuedDraft(); });
  await act(async () => { await hydrateChatDrafts(); });
  assert.equal(view.result.current.queuedDraft?.content, 'queued task');
  assert.match(userEcho.mock.calls.at(-1)?.[0].content, /未确认取消排队消息/);
  assert.equal(cloudSend.mock.calls.length, 0);
});

test('restoring a queued card does not rewrite a message the server may have claimed already', async () => {
  await writeQueuedMessage('session-a', { content: 'queued task' });
  transport.saveDraft.mockClear();
  const view = renderComposer({ id: 'session-a' });
  await act(async () => { view.rerender({ session: { id: 'session-b' }, project: PROJECT }); });
  await act(async () => { view.rerender({ session: { id: 'session-a' }, project: PROJECT }); });
  assert.equal(view.result.current.queuedDraft?.content, 'queued task');
  assert.equal(transport.saveDraft.mock.calls.length, 0);
});

for (const content of ['edit this queued text', '']) {
  test(`a restored ${content ? 'text and file' : 'file-only'} queue stays visible, removable and sendable after editing`, async () => {
    const kept = { name: 'keep.txt', path: '/assets/keep.txt', mimeType: 'text/plain', size: 4 };
    const removed = { name: 'remove.txt', path: '/assets/remove.txt', mimeType: 'text/plain', size: 6 };
    await writeQueuedMessage('session-a', { content, attachments: [kept, removed] });
    const hook = renderComposer({ id: 'session-b' });
    await act(async () => { hook.rerender({ session: { id: 'session-a' }, project: PROJECT }); });
    assert.deepEqual(hook.result.current.queuedDraft?.attachments, []);
    assert.deepEqual(hook.result.current.queuedDraft?.uploadedAttachments, [kept, removed]);
    const renderInput = await createComposerRenderInput(hook);
    const composer = render(renderInput());
    assert.match(screen.getByRole('status').textContent ?? '', /2 files attached/);

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Edit queued message' })); });
    composer.rerender(renderInput());
    assert.deepEqual(readQueuedMessage('session-a'), { content, attachments: [kept, removed], options: undefined, autoSend: false });
    assert.match(screen.getByRole('status').textContent ?? '', /发送已暂停/);
    assert.equal(hook.result.current.input, content);
    assert.deepEqual(hook.result.current.draftAttachments, [{ uploaded: kept }, { uploaded: removed }]);
    assert.equal(screen.getByText('keep.txt').textContent, 'keep.txt');
    assert.equal(screen.getByText('remove.txt').textContent, 'remove.txt');
    assert.equal((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled, false);

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Remove remove.txt' })); });
    composer.rerender(renderInput());
    assert.equal(screen.queryByText('remove.txt'), null);
    assert.deepEqual(hook.result.current.draftAttachments, [{ uploaded: kept }]);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });
    composer.rerender(renderInput());
    assert.equal(transport.uploadFiles.mock.calls.length, 0, 'restored descriptors must not be reuploaded');
    assert.equal(cloudSend.mock.calls.length, 0, 'only the server dispatcher may send the resumed queue');
    const submitted = transport.saveDraft.mock.calls.find(([, value]) => value.queuedMessage?.autoSend === true)?.[1].queuedMessage;
    assert.deepEqual(submitted, { content, options: undefined, autoSend: true, attachments: [kept] });
    assert.deepEqual(hook.result.current.draftAttachments, []);
    assert.equal(screen.queryByText('keep.txt'), null);
  });
}

test('switching conversations invalidates an edit anchor so the next message is not a replacement in the wrong session', async () => {
  const view = renderComposer({ id: 'session-a' });
  await act(async () => { view.result.current.beginEditMessage({ type: 'user', content: 'replace A', transcriptAnchorId: 'anchor-a', timestamp: new Date() }); });
  await act(async () => { view.rerender({ session: { id: 'session-b' }, project: PROJECT }); });
  await act(async () => { view.result.current.setInput('new B message'); });
  assert.equal(view.result.current.editingAnchorId, null);
  await act(async () => { await view.result.current.handleSubmit(submitEvent()); });
  assert.equal(cloudSend.mock.calls[0]?.[0].type, 'chat.send');
  assert.equal(cloudSend.mock.calls[0]?.[0].sessionId, 'session-b');
  assert.equal(cloudSend.mock.calls[0]?.[0].anchorId, undefined);
});

test('a synchronization wait retains text and files until the released workspace sends exactly once with frozen options', async () => {
  desktopWorkspace();
  const options = { model: 'original-model' };
  const view = renderComposer(null, options);
  const image = new File(['png'], 'image.png', { type: 'image/png' });
  await act(async () => {
    view.result.current.setInput('send after synchronization');
    view.result.current.setAttachedFiles([image]);
  });
  await act(async () => { await view.result.current.handleSubmit(submitEvent()); });
  assert.equal(view.result.current.isWaitingForWorkspace, true);
  assert.match(view.result.current.workspacePendingNotice ?? '', /同步完成.*自动发送/);
  assert.equal(view.result.current.input, 'send after synchronization');
  assert.equal(view.result.current.attachedFiles[0], image);
  assert.equal(transport.uploadFiles.mock.calls.length, 0);
  assert.equal(transport.createSession.mock.calls.length, 0);
  assert.equal(cloudSend.mock.calls.length, 0);
  assert.equal(userEcho.mock.calls.length, 0);
  assert.equal(readQueuedMessage(`project:${PROJECT.projectId}`), null);

  await act(async () => {
    await view.result.current.handleSubmit(submitEvent());
    emitWorkspace(syncInfo('reserved', 2));
    emitWorkspace(syncInfo('ready', 1));
    emitWorkspace(syncInfo('ready', 3, { serverPath: '/another-project' }));
    options.model = 'later-model';
    view.rerender({ session: null, project: PROJECT });
  });
  assert.equal(cloudSend.mock.calls.length, 0);
  assert.equal(view.result.current.isWaitingForWorkspace, true);
  await act(async () => {
    emitWorkspace(syncInfo('ready', 4));
    emitWorkspace(syncInfo('ready', 4));
  });
  assert.equal(transport.createSession.mock.calls.length, 1);
  assert.equal(transport.uploadFiles.mock.calls.length, 1);
  assert.equal(cloudSend.mock.calls.length, 1);
  assert.equal(cloudSend.mock.calls[0][0].sessionId, 'created-session');
  assert.equal(cloudSend.mock.calls[0][0].options.model, 'original-model');
  assert.equal(cloudSend.mock.calls[0][0].options.attachments[0].path, '/asset/image.png');
  assert.equal(userEcho.mock.calls.filter(([message]) => message.type === 'user').length, 1);
  assert.equal(view.result.current.workspacePendingDraft, null);
  assert.equal(view.result.current.input, '');
});

for (const action of ['cancel', 'edit-text', 'edit-files'] as const) {
  test(`${action} cancels automatic sending without losing the editable synchronization draft`, async () => {
    desktopWorkspace();
    const view = renderComposer({ id: 'session-a' });
    await act(async () => {
      view.result.current.setInput('keep this draft');
      view.result.current.setAttachedFiles([new File(['png'], 'image.png', { type: 'image/png' })]);
    });
    await act(async () => { await view.result.current.handleSubmit(submitEvent()); });
    await act(async () => {
      if (action === 'cancel') view.result.current.cancelWorkspaceSend();
      else if (action === 'edit-text') view.result.current.setInput('edited draft');
      else view.result.current.setAttachedFiles((files) => [...files, new File(['new'], 'new.txt')]);
      emitWorkspace(syncInfo('ready', 2));
    });
    assert.equal(view.result.current.workspacePendingDraft, null);
    assert.equal(cloudSend.mock.calls.length, 0);
    assert.equal(view.result.current.input, action === 'edit-text' ? 'edited draft' : 'keep this draft');
    assert.equal(view.result.current.attachedFiles.length, action === 'edit-files' ? 2 : 1);
  });
}

for (const transition of ['session', 'logout', 'server', 'binding'] as const) {
  test(`a pending synchronization draft cannot auto-send after a ${transition} change`, async () => {
    desktopWorkspace();
    const view = renderComposer({ id: 'session-a' });
    await act(async () => { view.result.current.setInput('original draft'); });
    await act(async () => { await view.result.current.handleSubmit(submitEvent()); });
    await act(async () => {
      if (transition === 'session') view.rerender({ session: { id: 'session-b' }, project: PROJECT });
      if (transition === 'logout') clearAuthToken();
      if (transition === 'server') {
        native.connectionVersion++;
        view.rerender({ session: { id: 'session-a' }, project: PROJECT });
      }
    });
    // Native progress arrives after React has committed the new target scope.
    await act(async () => {
      emitWorkspace(syncInfo('ready', 2, transition === 'binding' ? { bindingEpoch: 'binding-b' } : {}));
    });
    assert.equal(cloudSend.mock.calls.length, 0);
    assert.equal(readDraftText('session-a'), 'original draft');
    assert.equal(view.result.current.isWaitingForWorkspace, false);
  });
}

test('a blocked workspace pauses automatic sending even if a later ready event arrives', async () => {
  desktopWorkspace();
  const view = renderComposer({ id: 'session-a' });
  await act(async () => { view.result.current.setInput('keep until resolved'); });
  await act(async () => { await view.result.current.handleSubmit(submitEvent()); });
  await act(async () => {
    emitWorkspace(syncInfo('blocked', 2, { detail: 'resolve synchronization conflict' }));
    emitWorkspace(syncInfo('ready', 3));
  });
  assert.equal(view.result.current.isWaitingForWorkspace, false);
  assert.equal(view.result.current.workspacePendingDraft?.content, 'keep until resolved');
  assert.match(view.result.current.workspacePendingNotice ?? '', /暂停/);
  assert.equal(cloudSend.mock.calls.length, 0);
  assert.equal(view.result.current.input, 'keep until resolved');
});

test('a failed initial native observation pauses the draft rather than treating connectivity as ready', async () => {
  desktopWorkspace();
  const observed = deferred<ChisaSyncInfo>();
  native.getProjectSync.mockReturnValue(observed.promise);
  const view = renderComposer({ id: 'session-a' });
  await act(async () => { view.result.current.setInput('connection draft'); });
  await act(async () => { await view.result.current.handleSubmit(submitEvent()); });
  await act(async () => { observed.reject(new Error('connection closed')); });
  await act(async () => { emitWorkspace(syncInfo('ready', 3)); });
  assert.equal(view.result.current.isWaitingForWorkspace, false);
  assert.equal(view.result.current.workspacePendingDraft?.content, 'connection draft');
  assert.equal(cloudSend.mock.calls.length, 0);
});

test('synchronization beginning during session allocation retains the allocated id and uploaded files across repeated Enter', async () => {
  desktopWorkspace('ready');
  const created = deferred<Response>();
  transport.createSession.mockReturnValue(created.promise);
  const view = renderComposer(null);
  await act(async () => {
    view.result.current.setInput('one allocated task');
    view.result.current.setAttachedFiles([new File(['png'], 'image.png', { type: 'image/png' })]);
  });
  let submitting!: Promise<void>;
  await act(async () => { submitting = view.result.current.handleSubmit(submitEvent()); });
  assert.equal(transport.createSession.mock.calls.length, 1);
  await act(async () => {
    emitWorkspace(syncInfo('syncing', 2));
    created.resolve(okJson({ data: { sessionId: 'allocated-before-wait' } }));
    await submitting;
  });
  assert.equal(view.result.current.isWaitingForWorkspace, true);
  assert.equal(cloudSend.mock.calls.length, 0);
  await act(async () => {
    await view.result.current.handleSubmit(submitEvent());
    emitWorkspace(syncInfo('ready', 3));
    emitWorkspace(syncInfo('ready', 3));
  });
  assert.equal(transport.createSession.mock.calls.length, 1);
  assert.equal(transport.uploadFiles.mock.calls.length, 1);
  assert.equal(cloudSend.mock.calls.length, 1);
  assert.equal(cloudSend.mock.calls[0][0].sessionId, 'allocated-before-wait');
  assert.equal(established.mock.calls.length, 1);
});

test('a binding change during attachment upload pauses the draft before socket dispatch', async () => {
  desktopWorkspace('ready');
  const upload = deferred<Response>();
  transport.uploadFiles.mockReturnValue(upload.promise);
  const view = renderComposer({ id: 'session-a' });
  await act(async () => {
    view.result.current.setInput('bound task');
    view.result.current.setAttachedFiles([new File(['png'], 'image.png', { type: 'image/png' })]);
  });
  let submitting!: Promise<void>;
  await act(async () => { submitting = view.result.current.handleSubmit(submitEvent()); });
  await act(async () => {
    emitWorkspace(syncInfo('ready', 2, { bindingEpoch: 'binding-b' }));
    upload.resolve(okJson({ attachments: [{ name: 'image.png', path: '/asset/image.png' }] }));
    await submitting;
  });
  assert.equal(cloudSend.mock.calls.length, 0);
  assert.equal(view.result.current.isWaitingForWorkspace, false);
  assert.match(view.result.current.workspacePendingNotice ?? '', /绑定已改变/);
  assert.equal(view.result.current.input, 'bound task');
  assert.equal(view.result.current.attachedFiles.length, 1);
});

test('an executing model keeps the existing durable server queue instead of the local synchronization wait', async () => {
  desktopWorkspace('reserved');
  const view = renderComposer({ id: 'session-a' }, { busy: true });
  await act(async () => { view.result.current.setInput('next model turn'); });
  await act(async () => { await view.result.current.handleSubmit(submitEvent()); });
  assert.equal(view.result.current.workspacePendingDraft, null);
  assert.equal(view.result.current.queuedDraft?.content, 'next model turn');
  assert.equal(readQueuedMessage('session-a')?.content, 'next model turn');
  assert.equal(view.result.current.input, '');
  assert.equal(cloudSend.mock.calls.length, 0);
});

test('model-stopped finalization permits editing and server queueing but no new model before workspace release', async () => {
  const options = { busy: true, abortable: false };
  const view = renderComposer({ id: 'session-a' }, options);
  await act(async () => { view.result.current.setInput('run after the stopped turn releases its workspace'); });
  await act(async () => { await view.result.current.handleSubmit(submitEvent()); });
  assert.equal(readQueuedMessage('session-a')?.content, 'run after the stopped turn releases its workspace');
  assert.equal(view.result.current.queuedDraft?.content, 'run after the stopped turn releases its workspace');
  assert.equal(view.result.current.workspacePendingDraft, null);
  assert.equal(view.result.current.input, '');
  assert.equal(cloudSend.mock.calls.length, 0);
  assert.equal(markProcessing.mock.calls.length, 0);
  assert.equal(established.mock.calls.length, 0);
  assert.equal(transport.createSession.mock.calls.length, 0);

  await act(async () => { view.result.current.setInput('a separate editable draft during finalization'); });
  assert.equal(view.result.current.input, 'a separate editable draft during finalization');
  assert.equal(readDraftText('session-a'), 'a separate editable draft during finalization');
  await act(async () => { view.result.current.handleAbortSession(); });
  assert.equal(cloudSend.mock.calls.length, 0, 'the stopped/finalizing turn cannot be interrupted or restarted');

  options.busy = false;
  await act(async () => { view.rerender({ session: { id: 'session-a' }, project: PROJECT }); });
  assert.equal(cloudSend.mock.calls.length, 0, 'the client must not dispatch the server-owned queue on release');
  assert.equal(readQueuedMessage('session-a')?.content, 'run after the stopped turn releases its workspace');
  await act(async () => { await view.result.current.handleSubmit(submitEvent()); });
  assert.equal(cloudSend.mock.calls.length, 1);
  assert.equal(cloudSend.mock.calls[0][0].type, 'chat.send');
  assert.equal(cloudSend.mock.calls[0][0].sessionId, 'session-a');
  assert.equal(cloudSend.mock.calls[0][0].content, 'a separate editable draft during finalization');
  assert.equal(markProcessing.mock.calls.length, 1);
});

test('the real composer wires synchronization waiting and both card actions without losing its draft', async () => {
  desktopWorkspace();
  const hook = renderComposer({ id: 'session-a' });
  const attachment = new File(['local attachment'], 'local.txt', { type: 'text/plain' });
  await act(async () => {
    hook.result.current.setInput('editable synchronization draft');
    hook.result.current.setAttachedFiles([attachment]);
  });
  const renderInput = await createComposerRenderInput(hook);
  const composer = render(renderInput());
  let sequence = 1;
  for (const action of ['edit', 'cancel'] as const) {
    await act(async () => { emitWorkspace(syncInfo('syncing', ++sequence)); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });
    composer.rerender(renderInput());
    const card = screen.getByRole('status');
    assert.match(card.textContent ?? '', /待发送/);
    assert.match(card.textContent ?? '', /同步完成.*自动发送/);
    assert.match(card.textContent ?? '', /1 file attached/);
    assert.equal((screen.getByRole('button', { name: '待发送：同步完成后自动发送' }) as HTMLButtonElement).disabled, true);
    assert.equal(cloudSend.mock.calls.length, 0);
    assert.equal(transport.uploadFiles.mock.calls.length, 0);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', {
        name: action === 'edit' ? '编辑消息并取消自动发送' : '取消自动发送，保留草稿',
      }));
    });
    composer.rerender(renderInput());
    assert.equal(screen.queryByRole('status'), null);
    assert.equal((screen.getByRole('textbox') as HTMLTextAreaElement).value, 'editable synchronization draft');
    assert.equal(hook.result.current.attachedFiles[0], attachment);
    assert.equal(screen.getByText('local.txt').textContent, 'local.txt');
    assert.equal((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled, false);

    await act(async () => { emitWorkspace(syncInfo('ready', ++sequence)); });
    composer.rerender(renderInput());
    assert.equal(cloudSend.mock.calls.length, 0);
    assert.equal(userEcho.mock.calls.length, 0);
    assert.equal(readDraftText('session-a'), 'editable synchronization draft');
    assert.equal(hook.result.current.attachedFiles[0], attachment);
  }
});

test('editing a restored queue retains uploaded files across remount and sends its complete snapshot only through the queue API', async () => {
  const attachments = [{ name: 'first.txt', path: '/asset/first.txt' }, { name: 'second.txt', path: '/asset/second.txt' }];
  await writeQueuedMessage('session-a', { content: 'saved turn', attachments,
    options: { model: 'saved-model', effort: 'high', customOption: 'retained' } });
  const initial = renderComposer({ id: 'session-a' }, { model: 'visible-model' });
  await act(async () => { initial.result.current.editQueuedDraft(); });
  assert.equal(readQueuedMessage('session-a')?.autoSend, false);
  assert.equal(initial.result.current.input, 'saved turn');
  assert.deepEqual(initial.result.current.draftAttachments.flatMap(item => item.uploaded ? [item.uploaded] : []), attachments);
  assert.equal(initial.result.current.attachedFiles.length, 0);
  initial.unmount();
  const restored = renderComposer({ id: 'session-a' }, { model: 'visible-model' });
  assert.deepEqual(restored.result.current.queuedDraft?.uploadedAttachments, attachments);
  await act(async () => { restored.result.current.editQueuedDraft(); });
  assert.deepEqual(restored.result.current.draftAttachments.flatMap(item => item.uploaded ? [item.uploaded] : []), attachments);
  await act(async () => { restored.result.current.removeDraftAttachment(0); });
  await act(async () => { restored.result.current.setInput('edited turn'); });
  assert.deepEqual(restored.result.current.draftAttachments.flatMap(item => item.uploaded ? [item.uploaded] : []), [attachments[1]]);
  transport.saveDraft.mockClear();
  await act(async () => { await restored.result.current.handleSubmit(submitEvent()); });
  const submitted = transport.saveDraft.mock.calls.find(([, value]) => value.queuedMessage?.autoSend === true)?.[1].queuedMessage;
  assert.deepEqual(submitted, { content: 'edited turn', autoSend: true, attachments: [attachments[1]],
    options: { model: 'saved-model', effort: 'high', customOption: 'retained' } });
  assert.equal(transport.uploadFiles.mock.calls.length, 0);
  assert.equal(cloudSend.mock.calls.length, 0);
  assert.equal(restored.result.current.input, '');
});

test('direct Send preserves a paused queue snapshot even when current composer defaults differ', async () => {
  const snapshot = { content: 'retained task', autoSend: false, attachments: [{ path: '/asset/retained.txt', name: 'retained.txt' }],
    options: { model: 'original-model', effort: 'high', permissionMode: 'plan', customOption: 'unchanged' } };
  await writeQueuedMessage('session-a', snapshot);
  const view = renderComposer({ id: 'session-a' }, { model: 'different-default' });
  assert.equal(view.result.current.input, '');
  transport.saveDraft.mockClear();
  await act(async () => { await view.result.current.handleSubmit(submitEvent()); });
  const sent = transport.saveDraft.mock.calls.find(([, body]) => body.queuedMessage?.autoSend === true)?.[1].queuedMessage;
  assert.deepEqual(sent, { ...snapshot, autoSend: true });
  assert.equal(cloudSend.mock.calls.length, 0);
  assert.equal(transport.uploadFiles.mock.calls.length, 0);
});

test('Edit restores the original control choices and only an explicit control selection changes its saved option', async () => {
  const original = { model: 'saved-model', effort: 'high', permissionMode: 'plan', customOption: 'unchanged' };
  await writeQueuedMessage('session-a', { content: 'edit task', autoSend: false, options: original, attachments: [] });
  const restore = vi.fn();
  const view = renderComposer({ id: 'session-a' }, { model: 'different-default', onRestoreQueuedOptions: restore });
  await act(async () => { view.result.current.editQueuedDraft(); });
  assert.equal(restore.mock.calls.length, 1);
  assert.deepEqual(restore.mock.calls[0][0], original);
  assert.equal(restore.mock.calls[0][1](), true);
  assert.deepEqual(readQueuedMessage('session-a')?.options, original);
  await act(async () => { view.result.current.updateManualQueuedOptions({ model: 'explicit-choice' }); });
  assert.deepEqual(readQueuedMessage('session-a')?.options, { ...original, model: 'explicit-choice' });
  transport.saveDraft.mockClear();
  await act(async () => { await view.result.current.handleSubmit(submitEvent()); });
  const sent = transport.saveDraft.mock.calls.find(([, body]) => body.queuedMessage?.autoSend === true)?.[1].queuedMessage;
  assert.deepEqual(sent.options, { ...original, model: 'explicit-choice' });
});

test.each([false, true])('a fresh attachment-only send joins the paused attachment-only snapshot only after explicit Edit: %s', async edit => {
  const oldAttachment = { name: 'old.txt', path: '/asset/old.txt' };
  const snapshot = { content: '', autoSend: false, attachments: [oldAttachment], options: { model: 'old-model', customOption: 'unchanged' } };
  await writeQueuedMessage('session-a', snapshot);
  const view = renderComposer({ id: 'session-a' });
  if (edit) await act(async () => { view.result.current.editQueuedDraft(); });
  const freshAttachment = { name: 'new.txt', path: '/asset/new.txt', mimeType: 'text/plain' };
  transport.uploadFiles.mockResolvedValue(okJson({ attachments: [freshAttachment] }));
  await act(async () => { view.result.current.setAttachedFiles([new File(['new contents'], 'new.txt', { type: 'text/plain' })]); });
  assert.equal(view.result.current.draftAttachments.flatMap(item => item.uploaded ? [item.uploaded] : []).length, edit ? 1 : 0);
  transport.saveDraft.mockClear();
  await act(async () => { await view.result.current.handleSubmit(submitEvent()); });
  if (edit) {
    const sent = transport.saveDraft.mock.calls.find(([, body]) => body.queuedMessage?.autoSend === true)?.[1].queuedMessage;
    assert.deepEqual(sent.attachments, [oldAttachment, freshAttachment]);
    assert.deepEqual(sent.options, snapshot.options);
    assert.equal(cloudSend.mock.calls.length, 0);
  } else {
    assert.deepEqual(readQueuedMessage('session-a'), snapshot);
    assert.equal(cloudSend.mock.calls.length, 1);
    assert.equal(cloudSend.mock.calls[0][0].content, '');
    assert.deepEqual(cloudSend.mock.calls[0][0].options.attachments, [freshAttachment]);
    assert.equal(transport.saveDraft.mock.calls.some(([, body]) => body.queuedMessage?.autoSend === true), false);
  }
});

test('an unconfirmed manual send keeps the full draft and cannot dispatch the same intent again through the socket', async () => {
  const attachments = [{ name: 'retained.txt', path: '/asset/retained.txt' }];
  await writeQueuedMessage('session-a', { content: 'keep until confirmed', autoSend: false, attachments, options: { customOption: 'retained' } });
  writeDraftText('session-a', 'keep until confirmed');
  const view = renderComposer({ id: 'session-a' });
  await act(async () => { view.result.current.editQueuedDraft(); });
  transport.saveDraft.mockClear();
  transport.saveDraft.mockResolvedValue(new Response(JSON.stringify({ error: 'acknowledgement unavailable' }), { status: 500 }));
  await act(async () => { await view.result.current.handleSubmit(submitEvent()); });
  assert.equal(view.result.current.input, 'keep until confirmed');
  assert.deepEqual(view.result.current.draftAttachments.flatMap(item => item.uploaded ? [item.uploaded] : []), attachments);
  assert.equal(view.result.current.queuedDraft?.autoSend, false);
  assert.match(userEcho.mock.calls.at(-1)?.[0].content, /排队消息未确认/);
  await act(async () => { await view.result.current.handleSubmit(submitEvent()); });
  assert.equal(transport.saveDraft.mock.calls.length, 1);
  assert.equal(cloudSend.mock.calls.length, 0);
  assert.equal(transport.uploadFiles.mock.calls.length, 0);
});

test.each([false, true])('ordinary text matching a paused queue does not implicitly claim it while busy: %s', async (busy) => {
  const snapshot = { content: 'same words', autoSend: false, attachments: [{ name: 'saved.txt', path: '/asset/saved.txt' }],
    options: { model: 'saved-model', customOption: 'retained' } };
  await writeQueuedMessage('session-a', snapshot);
  const view = renderComposer({ id: 'session-a' }, { busy });
  await act(async () => { view.result.current.setInput(snapshot.content); });
  transport.saveDraft.mockClear();
  await act(async () => { await view.result.current.handleSubmit(submitEvent()); });
  assert.deepEqual(readQueuedMessage('session-a'), snapshot);
  assert.equal(transport.saveDraft.mock.calls.some(([, body]) => body.queuedMessage?.autoSend === true), false);
  assert.equal(cloudSend.mock.calls.length, busy ? 0 : 1);
  if (busy) assert.equal(view.result.current.input, snapshot.content);
  else assert.deepEqual(cloudSend.mock.calls[0][0].options.attachments, []);
});

test('an active claimed turn is not mistaken for a paused queue when queueing a successor', async () => {
  await writeQueuedMessage('session-a', { content: 'in flight', autoSend: false, claimRevision: 'run-a' });
  const view = renderComposer({ id: 'session-a' }, { busy: true });
  await act(async () => { view.result.current.setInput('next turn'); });
  await act(async () => { await view.result.current.handleSubmit(submitEvent()); });
  assert.equal(readQueuedMessage('session-a')?.content, 'next turn');
  assert.equal(readQueuedMessage('session-a')?.autoSend, true);
  assert.equal(readQueuedMessage('session-a')?.claimRevision, undefined);
  assert.equal(view.result.current.input, '');
  assert.equal(cloudSend.mock.calls.length, 0);
});

test.each(['attachment', 'options'] as const)('editing queued %s during upload invalidates the older submit', async (change) => {
  const attachment = { name: 'saved.txt', path: '/asset/saved.txt' };
  await writeQueuedMessage('session-a', { content: 'saved task', autoSend: false, attachments: [attachment],
    options: { model: 'saved-model', customOption: 'retained' } });
  const view = renderComposer({ id: 'session-a' });
  await act(async () => { view.result.current.editQueuedDraft(); });
  await act(async () => { view.result.current.setAttachedFiles([new File(['new'], 'new.txt', { type: 'text/plain' })]); });
  const upload = deferred<Response>();
  transport.uploadFiles.mockReturnValue(upload.promise);
  let submitting!: Promise<void>;
  await act(async () => { submitting = view.result.current.handleSubmit(submitEvent()); });
  await act(async () => {
    if (change === 'attachment') view.result.current.removeDraftAttachment(0);
    else view.result.current.updateManualQueuedOptions({ model: 'explicit-new-model' });
  });
  await act(async () => { upload.resolve(okJson({ attachments: [{ name: 'new.txt', path: '/asset/new.txt' }] })); await submitting; });
  assert.equal(readQueuedMessage('session-a')?.autoSend, false);
  assert.equal(readQueuedMessage('session-a')?.options?.model, change === 'options' ? 'explicit-new-model' : 'saved-model');
  assert.deepEqual(readQueuedMessage('session-a')?.attachments, change === 'attachment' ? [] : [attachment]);
  assert.equal(view.result.current.input, 'saved task');
  assert.equal(view.result.current.attachedFiles.length, 1);
  assert.equal(cloudSend.mock.calls.length, 0);
});

test('the five-second reconciliation adopts claim, pause and successful removal snapshots', async () => {
  const snapshot = { content: 'queued task', attachments: [{ name: 'saved.txt', path: '/asset/saved.txt' }],
    options: { model: 'saved-model', effort: 'high' } };
  await writeQueuedMessage('session-a', snapshot);
  vi.useFakeTimers();
  try {
    const view = renderComposer({ id: 'session-a' }, { busy: true });
    let queued: typeof snapshot & { autoSend?: boolean; claimRevision?: string } | null = {
      ...snapshot, autoSend: false, claimRevision: 'claimed-run',
    };
    transport.drafts.mockImplementation(async () => okJson({ drafts: [{ scope: 'session-a', text: '', queuedMessage: queued }] }));
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    assert.equal(view.result.current.queuedDraft?.claimRevision, 'claimed-run');
    assert.equal(view.result.current.queuedDraft?.autoSend, false);
    queued = { ...snapshot, autoSend: false };
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    assert.equal(view.result.current.queuedDraft?.claimRevision, undefined);
    assert.deepEqual(view.result.current.queuedDraft?.uploadedAttachments, snapshot.attachments);
    assert.deepEqual(view.result.current.queuedDraft?.options, snapshot.options);
    queued = null;
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    assert.equal(view.result.current.queuedDraft, null);
    view.unmount();
  } finally {
    vi.useRealTimers();
  }
});

test('a claimed card is hidden only while running and an idle claim can explicitly resend its full snapshot', async () => {
  const snapshot = { content: 'recover after restart', autoSend: false, claimRevision: 'stale-run',
    attachments: [{ name: 'saved.txt', path: '/asset/saved.txt' }], options: { model: 'saved-model', effort: 'high' } };
  await writeQueuedMessage('session-a', snapshot);
  const options = { busy: true };
  const hook = renderComposer({ id: 'session-a' }, options);
  const renderInput = await createComposerRenderInput(hook, options);
  const composer = render(renderInput());
  assert.equal(screen.queryByRole('status'), null);
  await act(async () => { options.busy = false; hook.rerender({ session: { id: 'session-a' }, project: PROJECT }); });
  composer.rerender(renderInput());
  const card = screen.getByRole('status');
  assert.match(card.textContent ?? '', /发送已暂停/);
  assert.doesNotMatch(card.textContent ?? '', /Will send when this finishes/);
  assert.match(card.textContent ?? '', /1 file attached/);
  const send = screen.getByRole('button', { name: '发送保留的排队消息' });
  assert.equal((send as HTMLButtonElement).disabled, false);
  transport.saveDraft.mockClear();
  await act(async () => { fireEvent.click(send); });
  const sent = transport.saveDraft.mock.calls.find(([, body]) => body.queuedMessage?.autoSend === true)?.[1].queuedMessage;
  assert.deepEqual(sent, { content: snapshot.content, autoSend: true, attachments: snapshot.attachments, options: snapshot.options });
  assert.equal(cloudSend.mock.calls.length, 0);
  assert.equal(transport.uploadFiles.mock.calls.length, 0);
});

test('a manual queue editor retains new File identity across A to B to A, and rejects an older option callback', async () => {
  const uploaded = { name: 'old.txt', path: '/asset/old.txt', mimeType: 'text/plain' };
  const options = { model: 'saved-model', customOption: 'retained' };
  await writeQueuedMessage('session-a', { content: 'saved A task', attachments: [uploaded], options, autoSend: false });
  const view = renderComposer({ id: 'session-a' });
  await act(async () => { view.result.current.editQueuedDraft(); });
  const oldOptionCallback = view.result.current.updateManualQueuedOptions;
  const newFile = new File(['new contents'], 'new.txt', { type: 'text/plain' });
  await act(async () => {
    view.result.current.setInput('edited A task');
    view.result.current.setAttachedFiles([newFile]);
  });
  assert.equal(transport.uploadFiles.mock.calls.length, 0);
  assert.deepEqual(readQueuedMessage('session-a')?.attachments, [uploaded]);
  await act(async () => { view.rerender({ session: { id: 'session-b' }, project: PROJECT }); });
  assert.equal(view.result.current.draftAttachments.length, 0);
  await act(async () => { view.result.current.setInput('independent B text'); });
  await act(async () => { view.rerender({ session: { id: 'session-a' }, project: PROJECT }); });
  assert.equal(view.result.current.input, 'edited A task');
  assert.equal(view.result.current.draftAttachments[1].file, newFile);
  assert.equal(view.result.current.attachedFiles[0], newFile);
  await act(async () => { oldOptionCallback({ model: 'late obsolete choice' }); });
  assert.deepEqual(readQueuedMessage('session-a')?.options, options);
  await act(async () => { view.result.current.removeDraftAttachment(0); });
  assert.deepEqual(readQueuedMessage('session-a')?.attachments, []);
  assert.equal(view.result.current.draftAttachments[0].file, newFile);
  assert.equal(transport.uploadFiles.mock.calls.length, 0, 'editing persists only descriptors, never uploads a new File');

  const uploadedNew = { name: 'new.txt', path: '/asset/new.txt', mimeType: 'text/plain' };
  transport.uploadFiles.mockResolvedValue(okJson({ attachments: [uploadedNew] }));
  transport.saveDraft.mockClear();
  await act(async () => { await view.result.current.handleSubmit(submitEvent()); });
  const submitted = transport.saveDraft.mock.calls.find(([, body]) => body.queuedMessage?.autoSend === true)?.[1].queuedMessage;
  assert.deepEqual(submitted, { content: 'edited A task', attachments: [uploadedNew], options, autoSend: true });
  assert.equal(Object.prototype.hasOwnProperty.call(submitted.options, 'effort'), false, 'missing raw effort stays a no-override snapshot');
  assert.equal(transport.uploadFiles.mock.calls.length, 1);
  assert.equal(cloudSend.mock.calls.length, 0);
  assert.equal(readDraftText('session-b'), 'independent B text');
});

test('beginning an explicit option change invalidates a pending queued-control restore before its response', async () => {
  const options = { model: 'saved-model', effort: 'high', customOption: 'retained' };
  await writeQueuedMessage('session-a', { content: 'queued task', autoSend: false, attachments: [], options });
  const completion = deferred<void>();
  const restore = vi.fn((_options: QueuedSendOptions, _isCurrent: () => boolean) => completion.promise);
  const view = renderComposer({ id: 'session-a' }, { onRestoreQueuedOptions: restore });
  await act(async () => { view.result.current.editQueuedDraft(); });
  assert.equal(restore.mock.calls.length, 1);
  const isCurrent = restore.mock.calls[0][1];
  assert.equal(isCurrent(), true);
  await act(async () => { view.result.current.beginQueuedOptionsChange(); });
  assert.equal(isCurrent(), false, 'the old restore is invalidated at selection time, not after its HTTP reply');
  await act(async () => { view.result.current.updateManualQueuedOptions({ model: 'explicit-choice' }); });
  await act(async () => { completion.resolve(); });
  assert.deepEqual(readQueuedMessage('session-a')?.options, { ...options, model: 'explicit-choice' });
  assert.equal(readQueuedMessage('session-a')?.autoSend, false);
  assert.equal(view.result.current.input, 'queued task');
  assert.equal(cloudSend.mock.calls.length, 0);
});
