import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { WorkspaceExecutionContext } from '@/shared/context/WorkspaceScopeContext';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { hydrateChatDrafts, readDraftText, readQueuedMessage, resetChatDrafts, writeDraftText, writeQueuedMessage } from '@/shared/chatDrafts';
import { clearAuthToken } from '@/shared/authToken';
import type { PendingPermissionRequest, PermissionMode, Project, ProjectSession, WorkspaceDescriptor } from '@/shared/types';

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
const transport = vi.hoisted(() => ({ createSession: vi.fn(), uploadFiles: vi.fn(), drafts: vi.fn(), saveDraft: vi.fn(), deleteDraft: vi.fn(), resolveWorkspace: vi.fn(), executeCommand: vi.fn(), connectionVersion: 0 }));
vi.mock('@/shared/chisa', () => ({
  getServerConnectionVersion: () => transport.connectionVersion,
}));
const okJson = (data: unknown = {}): Response => new Response(JSON.stringify(data), { status: 200 });
vi.mock('@/shared/api', () => {
  const ok = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });
  return {
    readApiJson: async (response: Response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    },
    api: {
      workspaces: { resolve: transport.resolveWorkspace },
      user: {
        drafts: transport.drafts,
        saveDraft: transport.saveDraft,
        deleteDraft: transport.deleteDraft,
        preferences: () => ok({ success: true, preferences: {} }),
        savePreferences: () => ok({ success: true, preferences: {} }),
      },
      commands: { list: () => ok({ success: true, commands: [] }), execute: transport.executeCommand },
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

const renderComposer = (selectedSession: ProjectSession | null, options: { busy?: boolean; abortable?: boolean; model?: string; workspace?: WorkspaceDescriptor | null } = {}) => renderHook(
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
    isLoading: options.busy ?? false,
    canAbortSession: options.abortable ?? false,
    tokenBudget: null,
    sendMessage: cloudSend,
    onSessionProcessing: markProcessing,
    onSessionEstablished: established,
    scrollToBottom: () => undefined,
    addMessage: userEcho,
    setIsUserScrolledUp: () => undefined,
    setPendingPermissionRequests: permissions,
  }),
  { initialProps: { session: selectedSession, project: PROJECT }, wrapper: ({ children }: PropsWithChildren) => <WorkspaceExecutionContext.Provider value={options.workspace}>{children}</WorkspaceExecutionContext.Provider> },
);

const REPLICA: WorkspaceDescriptor = {
  projectId: PROJECT.projectId, workspaceId: 'replica:project-1', generation: 'replica-one', kind: 'cloudReplica',
  rootPath: PROJECT.fullPath!, sourceRoot: PROJECT.fullPath!, requestedMode: 'isolated', effectiveMode: 'shared',
  phase: 'idle', publicationState: 'integrated',
  capabilities: { read: true, write: true, git: true, shell: true, preview: true, integrate: false, cloudExecutionIndependentOfDesktop: false },
};
const SESSION: WorkspaceDescriptor = {
  ...REPLICA, workspaceId: 'session:session-a', generation: 'session-one', kind: 'session', sessionId: 'session-a',
  rootPath: '/isolated/session-a', effectiveMode: 'isolated', publicationState: 'unpublished',
};
const selector = (workspace: WorkspaceDescriptor) => ({ projectId: workspace.projectId, workspaceId: workspace.workspaceId, generation: workspace.generation });

beforeEach(() => {
  localStorage.clear();
  // The drafts store is a module-level singleton, so its in-memory copy
  // outlives localStorage.clear() and would leak one test's drafts into the next.
  resetChatDrafts();
  vi.resetAllMocks();
  transport.connectionVersion = 0;
  transport.saveDraft.mockResolvedValue(okJson({ success: true }));
  transport.deleteDraft.mockResolvedValue(okJson({ success: true }));
  transport.drafts.mockResolvedValue(okJson({ drafts: [] }));
  transport.createSession.mockResolvedValue(okJson({ data: { sessionId: 'created-session' } }));
  transport.uploadFiles.mockResolvedValue(okJson({ attachments: [{ name: 'image.png', path: '/asset/image.png', mimeType: 'image/png' }] }));
});
afterEach(() => resetChatDrafts());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const submitEvent = () => ({ preventDefault() {} }) as never;

test('the first scoped message uses the replica and a rapid next send resolves its new session workspace', async () => {
  transport.resolveWorkspace.mockImplementation(async () => okJson({ cloudReplica: REPLICA, session: null }));
  const view = renderComposer(null, { workspace: REPLICA });
  await act(async () => { view.result.current.setInput('first message'); });
  await act(async () => { await view.result.current.handleSubmit(submitEvent()); });
  assert.equal(cloudSend.mock.calls.length, 1);
  assert.deepEqual(transport.resolveWorkspace.mock.calls[0], [PROJECT.projectId, 'created-session']);
  assert.equal(cloudSend.mock.calls[0][0].workspaceId, REPLICA.workspaceId);
  assert.equal(cloudSend.mock.calls[0][0].content, 'first message');
  assert.equal(established.mock.calls[0][0], 'created-session');
  await act(async () => { view.rerender({ session: { id: 'created-session' }, project: PROJECT }); });
  transport.resolveWorkspace.mockImplementation(async () => okJson({ cloudReplica: REPLICA, session: { ...SESSION, sessionId: 'created-session' } }));
  await act(async () => { view.result.current.setInput('next message before poll'); });
  await act(async () => { await view.result.current.handleSubmit(submitEvent()); });
  assert.equal(cloudSend.mock.calls.length, 2);
  assert.deepEqual({ projectId: cloudSend.mock.calls[1][0].projectId, workspaceId: cloudSend.mock.calls[1][0].workspaceId, generation: cloudSend.mock.calls[1][0].generation }, selector(SESSION));
});

test('editing and durable queues carry the exact resolved selector', async () => {
  transport.resolveWorkspace.mockImplementation(async () => okJson({ cloudReplica: REPLICA, session: SESSION }));
  const view = renderComposer({ id: 'session-a' }, { workspace: SESSION });
  await act(async () => { view.result.current.beginEditMessage({ type: 'user', content: 'replace this', transcriptAnchorId: 'anchor-a', timestamp: new Date() }); });
  await act(async () => { await view.result.current.handleSubmit(submitEvent()); });
  assert.equal(cloudSend.mock.calls[0][0].type, 'chat.edit-send');
  assert.equal(cloudSend.mock.calls[0][0].anchorId, 'anchor-a');
  assert.equal(cloudSend.mock.calls[0][0].generation, SESSION.generation);
  view.unmount();
  const queued = renderComposer({ id: 'session-a' }, { workspace: SESSION, busy: true });
  await act(async () => { queued.result.current.setInput('queued with scope'); });
  await act(async () => { await queued.result.current.handleSubmit(submitEvent()); });
  assert.deepEqual(readQueuedMessage('session-a')?.options?.workspace, selector(SESSION));
});

for (const failure of ['generation', 'unavailable', 'network'] as const) {
  test(`a ${failure} workspace retains the draft and never dispatches`, async () => {
    transport.resolveWorkspace.mockImplementation(async () => {
      if (failure === 'network') throw new Error('offline');
      return okJson({ cloudReplica: REPLICA, session: { ...SESSION, generation: 'replaced' } });
    });
    const view = renderComposer({ id: 'session-a' }, { workspace: failure === 'unavailable' ? null : SESSION });
    await act(async () => { view.result.current.setInput('keep this scoped draft'); });
    await act(async () => { await view.result.current.handleSubmit(submitEvent()); });
    assert.equal(cloudSend.mock.calls.length, 0);
    assert.equal(view.result.current.input, 'keep this scoped draft');
    assert.equal(userEcho.mock.calls.filter(([message]) => message.type === 'user').length, 0);
  });
}

test('a late workspace reply after a generation change or session switch cannot send', async () => {
  const reply = deferred<Response>();
  transport.resolveWorkspace.mockReturnValue(reply.promise);
  const options: { workspace: WorkspaceDescriptor } = { workspace: SESSION };
  const view = renderComposer({ id: 'session-a' }, options);
  await act(async () => { view.result.current.setInput('old incarnation'); });
  let submitting!: Promise<void>;
  await act(async () => { submitting = view.result.current.handleSubmit(submitEvent()); });
  options.workspace = { ...SESSION, generation: 'new-generation' };
  await act(async () => { view.rerender({ session: { id: 'session-a' }, project: PROJECT }); });
  await act(async () => { reply.resolve(okJson({ cloudReplica: REPLICA, session: SESSION })); await submitting; });
  assert.equal(cloudSend.mock.calls.length, 0);
  assert.equal(view.result.current.input, 'old incarnation');
});

test('retrying an old queued selector does not silently rebind after reload', async () => {
  transport.resolveWorkspace.mockImplementation(async () => okJson({ cloudReplica: REPLICA, session: SESSION }));
  const view = renderComposer({ id: 'session-a' }, { workspace: SESSION });
  await act(async () => { view.result.current.setInput('current draft'); });
  await act(async () => { await view.result.current.handleSubmit(submitEvent(), { content: 'old queued draft', attachments: [], options: { workspace: { ...selector(SESSION), generation: 'old-generation' } } }); });
  assert.equal(cloudSend.mock.calls.length, 0);
  assert.equal(view.result.current.input, 'current draft');
  assert.match(userEcho.mock.calls.at(-1)?.[0].content, /排队消息的工作区已变化/);
});

test('a scoped builtin command requires an exact response workspace before consuming the draft', async () => {
  transport.resolveWorkspace.mockImplementation(async () => okJson({ cloudReplica: REPLICA, session: SESSION }));
  transport.executeCommand.mockImplementation(async () => okJson({ type: 'builtin', action: 'help', data: {}, workspace: selector(SESSION) }));
  const view = renderComposer({ id: 'session-a' }, { workspace: SESSION });
  await act(async () => { view.result.current.setInput('/help'); });
  await act(async () => { await view.result.current.handleSubmit(submitEvent()); });
  const context = transport.executeCommand.mock.calls[0][0].context;
  assert.deepEqual({ projectId: context.projectId, workspaceId: context.workspaceId, generation: context.generation, sessionId: context.sessionId }, { ...selector(SESSION), sessionId: SESSION.sessionId });
  assert.equal(view.result.current.commandModalPayload?.kind, 'help');
  assert.equal(view.result.current.input, '');
  await act(async () => { view.result.current.closeCommandModal(); view.result.current.setInput('/help'); });
  transport.executeCommand.mockImplementation(async () => okJson({ type: 'builtin', action: 'help', data: {}, workspace: { ...selector(SESSION), generation: 'old' } }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await act(async () => { await view.result.current.handleSubmit(submitEvent()); });
  assert.equal(view.result.current.commandModalPayload, null);
  assert.equal(view.result.current.input, '/help');
  vi.restoreAllMocks();
});

test('a late command response after switching server never changes the new draft or modal', async () => {
  transport.resolveWorkspace.mockImplementation(async () => okJson({ cloudReplica: REPLICA, session: SESSION }));
  const response = deferred<Response>();
  transport.executeCommand.mockReturnValue(response.promise);
  const view = renderComposer({ id: 'session-a' }, { workspace: SESSION });
  await act(async () => { view.result.current.setInput('/help'); });
  let submitting!: Promise<void>;
  await act(async () => { submitting = view.result.current.handleSubmit(submitEvent()); });
  transport.connectionVersion++;
  await act(async () => { response.resolve(okJson({ type: 'builtin', action: 'help', data: {}, workspace: selector(SESSION) })); await submitting; });
  assert.equal(view.result.current.commandModalPayload, null);
  assert.equal(view.result.current.input, '/help');
});

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
  assert.equal(view.result.current.isPreparingSend, true);
  await act(async () => { view.rerender({ session: { id: 'session-b' }, project: PROJECT }); });
  assert.equal(view.result.current.isPreparingSend, false);
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
  assert.equal(view.result.current.isPreparingSend, true);
  await act(async () => { created.resolve(okJson({ data: { sessionId: 'new-session' } })); await submitting; });
  assert.equal(view.result.current.isPreparingSend, false);
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

test('a desktop Claude send is accepted while synchronization is active', async () => {
  const view = renderComposer(null, { model: 'original-model' });
  const image = new File(['png'], 'image.png', { type: 'image/png' });
  await act(async () => {
    view.result.current.setInput('send during synchronization');
  });
  await act(async () => {
    view.result.current.setAttachedFiles([image]);
  });
  await act(async () => {
    await view.result.current.handleSubmit(submitEvent());
  });
  assert.equal(transport.createSession.mock.calls.length, 1);
  assert.equal(transport.uploadFiles.mock.calls.length, 1);
  assert.equal(cloudSend.mock.calls.length, 1);
  assert.equal(cloudSend.mock.calls[0][0].sessionId, 'created-session');
  assert.equal(cloudSend.mock.calls[0][0].options.attachments[0].path, '/asset/image.png');
  assert.equal(view.result.current.input, '');
});

test('cloud session allocation dispatches the accepted draft once', async () => {
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
    created.resolve(okJson({ data: { sessionId: 'allocated-before-wait' } }));
    await submitting;
  });
  assert.equal(transport.createSession.mock.calls.length, 1);
  assert.equal(transport.uploadFiles.mock.calls.length, 1);
  assert.equal(cloudSend.mock.calls.length, 1);
  assert.equal(cloudSend.mock.calls[0][0].sessionId, 'allocated-before-wait');
  assert.equal(established.mock.calls.length, 1);
});

test('an executing cloud model retains the durable server queue', async () => {
  const view = renderComposer({ id: 'session-a' }, { busy: true });
  await act(async () => { view.result.current.setInput('next model turn'); });
  await act(async () => { await view.result.current.handleSubmit(submitEvent()); });
  assert.equal(view.result.current.queuedDraft?.content, 'next model turn');
  assert.equal(readQueuedMessage('session-a')?.content, 'next model turn');
  assert.equal(view.result.current.input, '');
  assert.equal(cloudSend.mock.calls.length, 0);
});
