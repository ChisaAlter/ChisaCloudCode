import path from 'node:path';

import type { WebSocket } from 'ws';

import { projectsDb, sessionsDb, userDb } from '@/modules/database/index.js';
import { providerModelsService, sessionsService } from '@/modules/providers/index.js';
import { assertCloudWorkspaceOwner } from '@/modules/workspace-runtime/index.js';
import { assertWorkspaceDescriptor, assertSshProjectOwner, resolveSshProjectTarget, isWorkspaceBound } from '@/modules/workspace-bridge/index.js';
import { resolveSelectedWorkspace } from '@/modules/workspaces/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients, setConnectedClientUserId, WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
import {
  AppError,
  getGlobalImageAssetsDir,
  isImageAttachmentDescriptor,
  normalizeAttachmentDescriptors,
  parseIncomingJsonObject,
} from '@/shared/index.js';
import type {
  AnyRecord,
  AuthenticatedWebSocketRequest,
  ChatAttachmentDescriptor,
  LLMProvider,
  ProviderPermissionDecision,
  ProviderRuntimeWriter,
  WorkspaceDescriptor,
} from '@/shared/index.js';

/**
 * Trust boundary for client-supplied image attachments: chat.send options come
 * straight from the browser, and the provider runtimes read the referenced
 * files off disk (Claude base64-encodes them into the prompt). Only images
 * that live directly inside the global upload store (`~/.cloudcli/assets`,
 * where POST /api/assets/images puts them) are allowed through — anything
 * else (absolute paths elsewhere, traversal, subdirectories) is dropped.
 *
 * Exported for tests; `assetsRootOverride` exists only for them.
 */
export function filterAttachmentsToUploadStore(
  attachments: unknown,
  assetsRootOverride?: string,
): ChatAttachmentDescriptor[] {
  const assetsRoot = path.resolve(assetsRootOverride ?? getGlobalImageAssetsDir());

  return normalizeAttachmentDescriptors(attachments).filter((descriptor) => {
    // Relative paths are anchored in the store; absolute ones must already be in it.
    const resolved = path.resolve(assetsRoot, descriptor.path);
    const relative = path.relative(assetsRoot, resolved);
    const isDirectChild =
      relative.length > 0 &&
      !relative.startsWith('..') &&
      !path.isAbsolute(relative) &&
      !relative.includes(path.sep) &&
      !relative.includes('/');

    if (!isDirectChild) {
      console.warn(`[Chat] Dropping attachment outside the upload store: ${descriptor.path}`);
    }
    return isDirectChild;
  });
}

/** Backward-compatible image filter consumed by existing websocket tests. */
export function filterImagesToUploadStore(
  images: unknown,
  assetsRootOverride?: string,
): ChatAttachmentDescriptor[] {
  return filterAttachmentsToUploadStore(images, assetsRootOverride);
}

/** Application boundary for dispatching provider runs and approvals. */
export type ProviderRuntimeGateway = {
  hasRuntime(provider: string): boolean;
  run(
    provider: LLMProvider,
    command: string,
    options: AnyRecord,
    writer: ProviderRuntimeWriter,
  ): Promise<unknown>;
  abort(provider: LLMProvider, sessionId: string): Promise<boolean>;
  resolveToolApproval(requestId: string, payload: ProviderPermissionDecision): void;
  getPendingApprovalsForSession(sessionId: string): unknown[];
};

type ChatWebSocketDependencies = {
  /** Central dispatcher for every provider SDK/CLI runtime. */
  runtime: ProviderRuntimeGateway;
};

// A cancelled runtime can settle before abort finishes releasing its workspace.
// Its dispatch fallback must leave completion to the abort handler until then.
const stoppingRuns = new WeakSet<NonNullable<ReturnType<typeof chatRunRegistry.getRun>>>();
const runCancellations = new WeakMap<NonNullable<ReturnType<typeof chatRunRegistry.getRun>>, AbortController>();
const settledRuns = new WeakSet<NonNullable<ReturnType<typeof chatRunRegistry.getRun>>>();
const notifiedRuns = new WeakSet<NonNullable<ReturnType<typeof chatRunRegistry.getRun>>>();
const admissionRejectedRuns = new WeakSet<NonNullable<ReturnType<typeof chatRunRegistry.getRun>>>();
const unsettledRuns = new Map<string, Set<NonNullable<ReturnType<typeof chatRunRegistry.getRun>>>>();
const runSettledListeners = new Set<() => void>();

/** Scheduled messages wait for runtime teardown and abort handback, even after a terminal frame. */
export function isChatRunInFlight(sessionId: string): boolean {
  return chatRunRegistry.isProcessing(sessionId) || unsettledRuns.has(sessionId);
}

/** Scheduled messages use this wakeup after an interactive or detached run has fully released its workspace. */
export function onChatRunSettled(listener: () => void): () => void {
  runSettledListeners.add(listener);
  return () => { runSettledListeners.delete(listener); };
}

function finishSettledRun(run: NonNullable<ReturnType<typeof chatRunRegistry.getRun>>): void {
  if (!settledRuns.has(run) || stoppingRuns.has(run) || notifiedRuns.has(run)) return;
  notifiedRuns.add(run);
  const pending = unsettledRuns.get(run.appSessionId);
  pending?.delete(run);
  if (pending?.size === 0) unsettledRuns.delete(run.appSessionId);
  // A rejected admission did not release another task's workspace. Waking for
  // it would repeatedly retry the same busy queue without waiting for progress.
  if (admissionRejectedRuns.has(run)) return;
  for (const listener of runSettledListeners) {
    try { listener(); }
    catch (error) { console.error('[Chat] Run-settled listener failed', error); }
  }
}

/**
 * Extracts the authenticated request user id in the formats currently produced
 * by platform and OSS auth code paths.
 */
function readRequestUserId(
  request: AuthenticatedWebSocketRequest | undefined
): string | number | null {
  const user = request?.user;
  if (!user) {
    return null;
  }

  if (typeof user.id === 'string' || typeof user.id === 'number') {
    return user.id;
  }

  if (typeof user.userId === 'string' || typeof user.userId === 'number') {
    return user.userId;
  }

  return null;
}

/** Replay, cancellation, approvals and new turns share the same persisted cloud/SSH account check. */
function assertSshSessionOwner(sessionId: string, userId: string | number | null) {
  const session = sessionsDb.getSessionById(sessionId);
  const target = session?.project_path ? resolveSshProjectTarget(session.project_path) : null;
  if (target) assertSshProjectOwner(target, userId);
  else if (session) assertCloudWorkspaceOwner(session.project_path, userId, userDb.getActiveUserIds());
  return target;
}

function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WS_OPEN_STATE) {
    ws.send(JSON.stringify(payload));
  }
}

/**
 * Reports a protocol-level failure to the requesting client.
 *
 * Protocol errors deliberately use their own `kind` (instead of the provider
 * `error` message kind) so the frontend can distinguish "your request was
 * invalid" from "the model run produced an error" without inspecting text.
 */
function sendProtocolError(
  ws: WebSocket,
  code: string,
  error: string,
  sessionId?: string
): void {
  sendJson(ws, {
    kind: 'protocol_error',
    code,
    error,
    sessionId: sessionId ?? null,
    timestamp: new Date().toISOString(),
  });
}

function readRequiredSessionId(data: AnyRecord): string | null {
  const sessionId = typeof data.sessionId === 'string' ? data.sessionId.trim() : '';
  return sessionId.length > 0 ? sessionId : null;
}

/**
 * Handles `chat.send`: resolves the session row (provider, project path, and
 * provider-native id all come from the database — never from the client),
 * registers the run, and dispatches to the provider runtime.
 */
async function handleChatSend(
  ws: WebSocket,
  userId: string | number | null,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): Promise<void> {
  const resolved = resolveSendTarget(ws, userId, data, dependencies, 'chat.send');
  if (!resolved) {
    return;
  }

  await dispatchRun(ws, userId, resolved.sessionId, resolved.session, data, dependencies);
}

type ResolvedSendTarget = {
  sessionId: string;
  session: NonNullable<ReturnType<typeof sessionsDb.getSessionById>>;
  provider: LLMProvider;
};

/** Chat selects the persisted app session, even when the file browser selects another workspace. */
function resolveChatWorkspace(
  sessionId: string,
  session: ResolvedSendTarget['session'],
  data: AnyRecord,
): WorkspaceDescriptor | undefined {
  const current = sessionsDb.getSessionById(sessionId);
  if (!current || current.project_path !== session.project_path || current.provider !== session.provider
    || current.workspace_mode !== session.workspace_mode) {
    throw new AppError('The session workspace changed before this turn could start.', { code: 'WORKSPACE_SELECTION_MISMATCH', statusCode: 409 });
  }

  const hasSelector = ['projectId', 'workspaceId', 'generation'].some(key => Object.hasOwn(data, key));
  if (!hasSelector) {
    if (session.project_path && isWorkspaceBound(session.project_path)) {
      throw new AppError('projectId, workspaceId and generation are required for a bound chat session.', { code: 'WORKSPACE_SELECTOR_REQUIRED', statusCode: 400 });
    }
    // Existing standalone clients have no workspace catalog. An explicit but
    // malformed selector never takes this compatibility path.
    return undefined;
  }
  if (typeof data.projectId !== 'string' || !data.projectId.trim()
    || typeof data.workspaceId !== 'string' || !data.workspaceId.trim()
    || typeof data.generation !== 'string' || !data.generation.trim()) {
    throw new AppError('Chat requires a complete projectId, workspaceId and generation selector.', { code: 'INVALID_WORKSPACE_SELECTOR', statusCode: 400 });
  }
  const projectId = data.projectId.trim();
  const project = session.project_path ? projectsDb.getProjectPath(session.project_path) : null;
  if (!project || project.project_id !== projectId) {
    throw new AppError('The selected project does not own this chat session.', { code: 'WORKSPACE_SELECTION_MISMATCH', statusCode: 409 });
  }
  const selector = { workspaceId: data.workspaceId.trim(), generation: data.generation.trim() };
  try {
    return resolveSelectedWorkspace(projectId, { ...selector, sessionId });
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== 'WORKSPACE_SESSION_NOT_READY') throw error;
    // Admission creates a first session workspace. Until then only this
    // project's exact source generation may authorize that materialization.
    const descriptor = resolveSelectedWorkspace(projectId, selector);
    if (descriptor.kind !== 'cloudReplica') {
      throw new AppError('A new session must select its project replica.', { code: 'WORKSPACE_SELECTION_MISMATCH', statusCode: 409 });
    }
    return descriptor;
  }
}

function workspaceRejection(ws: WebSocket | null, error: unknown, sessionId: string) {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof AppError ? error.code : 'INTERNAL_ERROR';
  if (ws) sendProtocolError(ws, code, message, sessionId);
  return { started: false, error: message, code };
}

/**
 * Shared front half of `chat.send` and `chat.edit-send`: the session row and
 * provider come from the database, never from the client.
 */
function resolveSendTarget(
  ws: WebSocket,
  userId: string | number | null,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies,
  frameName: string,
): ResolvedSendTarget | null {
  const sessionId = readRequiredSessionId(data);
  if (!sessionId) {
    sendProtocolError(ws, 'SESSION_ID_REQUIRED', `${frameName} requires a sessionId.`);
    return null;
  }

  const session = sessionsDb.getSessionById(sessionId);
  if (!session) {
    sendProtocolError(
      ws,
      'SESSION_NOT_FOUND',
      `Session "${sessionId}" was not found. Create it via POST /api/providers/sessions first.`,
      sessionId
    );
    return null;
  }

  const provider = session.provider as LLMProvider;
  if (!dependencies.runtime.hasRuntime(provider)) {
    sendProtocolError(ws, 'UNSUPPORTED_PROVIDER', `Provider "${provider}" is not available.`, sessionId);
    return null;
  }

  try {
    assertSshSessionOwner(sessionId, userId);
    resolveChatWorkspace(sessionId, session, data);
  } catch (error) {
    workspaceRejection(ws, error, sessionId);
    return null;
  }
  return { sessionId, session, provider };
}

/**
 * Registers the run and hands the turn to the provider runtime.
 *
 * `extraRuntimeOptions` is how an edited message asks the provider to resume
 * partway instead of continuing from the tip; a normal send passes nothing.
 */
async function dispatchRun(
  ws: WebSocket | null,
  userId: string | number | null,
  sessionId: string,
  session: NonNullable<ReturnType<typeof sessionsDb.getSessionById>>,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies,
  extraRuntimeOptions: AnyRecord = {},
  beforeRun?: (run: NonNullable<ReturnType<typeof chatRunRegistry.startRun>>) => void | Promise<void>,
): Promise<{ started: boolean; error: string | null; code?: string; retryable?: boolean }> {
  const provider = session.provider as LLMProvider;
  const clientOptions = (data.options ?? {}) as AnyRecord;
  const command = typeof data.content === 'string' ? data.content : '';
  let workspaceDescriptor: WorkspaceDescriptor | undefined;
  try {
    // Edit anchor lookup and scheduled cancellation can yield between the
    // first validation and here. Recheck before history/model changes.
    assertSshSessionOwner(sessionId, userId);
    workspaceDescriptor = resolveChatWorkspace(sessionId, session, data);
    const ssh = session.project_path ? resolveSshProjectTarget(session.project_path) : null;
    if (ssh) {
      assertSshProjectOwner(ssh, userId);
      if (provider !== 'claude') throw new AppError('SSH 本地项目目前仅支持 VPS Claude Code。', { code: 'WORKSPACE_PROVIDER_UNSUPPORTED', statusCode: 409 });
    }
  } catch (error) {
    return workspaceRejection(ws, error, sessionId);
  }

  const run = chatRunRegistry.startRun({
    appSessionId: sessionId,
    provider,
    providerSessionId: session.provider_session_id,
    connection: ws,
    userId,
  });

  if (!run) {
    if (ws) {
      sendProtocolError(
        ws,
        'RUN_IN_PROGRESS',
        `Session "${sessionId}" already has a run in progress.`,
        sessionId
      );
    }
    return { started: false, error: 'A run is already in progress for this session.', code: 'RUN_IN_PROGRESS', retryable: true };
  }
  const pending = unsettledRuns.get(sessionId) ?? new Set();
  pending.add(run);
  unsettledRuns.set(sessionId, pending);
  const cancellation = new AbortController();
  runCancellations.set(run, cancellation);
  chatRunRegistry.setPhase(run, 'queued');

  // Record what this turn runs with so reopening the session later restores the
  // same model and reasoning effort, and so the resume path has a
  // session-scoped model answer to use.
  if (typeof clientOptions.model === 'string' && clientOptions.model.trim()) {
    providerModelsService.setSessionModel(provider, sessionId, clientOptions.model);
  }
  if (typeof clientOptions.effort === 'string' && clientOptions.effort.trim()) {
    providerModelsService.setSessionEffort(provider, sessionId, clientOptions.effort);
  }

  const attachmentCandidates = [
    ...normalizeAttachmentDescriptors(clientOptions.images),
    ...normalizeAttachmentDescriptors(clientOptions.files),
    ...normalizeAttachmentDescriptors(clientOptions.attachments),
  ];
  const verifiedAttachments = filterAttachmentsToUploadStore(attachmentCandidates);
  const uniqueAttachments = verifiedAttachments.filter(
    (descriptor, index, all) => all.findIndex((candidate) => candidate.path === descriptor.path) === index,
  );

  // The provider runtimes receive the stable app session id. When their
  // CLI/SDK needs the provider-native id for resume, they resolve it from the
  // session row themselves (sessionsService.resolveProviderSessionId).
  // Brand-new sessions have no provider id yet, so the runtime starts fresh
  // and announces one, which the gateway writer captures and maps back to the
  // app session id.
  const runtimeOptions: AnyRecord = {
    ...clientOptions,
    ...extraRuntimeOptions,
    // Attachments are re-validated server-side: only direct children of the
    // global upload store may reach provider runtimes or their file tools.
    attachments: uniqueAttachments,
    images: uniqueAttachments.filter(isImageAttachmentDescriptor),
    files: uniqueAttachments.filter((descriptor) => !isImageAttachmentDescriptor(descriptor)),
    sessionId,
    // The session row is the sole workspace identity for a run. A client may
    // keep a stale cwd after switching projects, so accepting it here would
    // split provider cwd, workspace tools, and synchronization ownership.
    cwd: session.project_path ?? undefined,
    projectPath: session.project_path ?? undefined,
    workspaceMode: session.workspace_mode,
    // Only the catalog-validated value reaches provider admission. Neither a
    // client descriptor object nor a queue's selector may replace it.
    workspaceDescriptor,
    workspace: undefined,
    abortSignal: cancellation.signal,
  };

  let failure: string | null = null;
  let code: string | undefined;
  let retryable = false;
  try {
    // Runs only now that the session is reserved, because an edit rewinds the
    // conversation here and a rewind for a run that was never admitted cannot
    // be taken back. Inside the try so a rewind that throws still releases the
    // run instead of leaving the session processing forever.
    await beforeRun?.(run);
    cancellation.signal.throwIfAborted();
    try {
      resolveChatWorkspace(sessionId, session, data);
      if (workspaceDescriptor) assertWorkspaceDescriptor(workspaceDescriptor);
    } catch (error) {
      workspaceRejection(ws, error, sessionId);
      throw error;
    }
    chatRunRegistry.setPhase(run, 'running');
    await dependencies.runtime.run(provider, command, runtimeOptions, run.writer);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    const runtimeError = error as { code?: unknown; workspaceAdmissionRejected?: unknown; workspaceCleanupError?: unknown; cleanupError?: unknown } | null;
    code = typeof runtimeError?.code === 'string' ? runtimeError.code : undefined;
    retryable = !runtimeError?.workspaceCleanupError && !runtimeError?.cleanupError && (
      code === 'RUN_IN_PROGRESS' || runtimeError?.workspaceAdmissionRejected === true
    );
    if (retryable) admissionRejectedRuns.add(run);
    console.error(`[Chat] Provider runtime "${provider}" failed`, { sessionId, error: failure, code });
  } finally {
    // Safety net: a runtime that crashed (or resolved) without emitting its
    // terminal `complete` would otherwise leave the session stuck in
    // "processing" forever on every connected client. Scoped to THIS run —
    // a queued message can start the session's next run before this promise
    // settles, and the session-keyed completeRun would kill that new run.
    settledRuns.add(run);
    if (!stoppingRuns.has(run)) chatRunRegistry.completeRunIfCurrent(run, { exitCode: 1 });
    runCancellations.delete(run);
    finishSettledRun(run);
  }

  return { started: !retryable, error: failure, ...(code ? { code } : {}), ...(retryable ? { retryable } : {}) };
}

/**
 * Handles `chat.edit-send`: replaces an already-sent message and everything
 * after it with a new turn.
 *
 * Nothing is deleted. The provider resumes the conversation partway and
 * appends the replacement, so the abandoned attempt stays in the transcript
 * file and is simply no longer part of the live conversation — the same shape
 * Claude Code's rewind and Codex's fork-with-cut-point produce.
 */
async function handleChatEditSend(
  ws: WebSocket,
  userId: string | number | null,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): Promise<void> {
  const resolved = resolveSendTarget(ws, userId, data, dependencies, 'chat.edit-send');
  if (!resolved) {
    return;
  }

  const { sessionId, session, provider } = resolved;
  const anchorId = typeof data.anchorId === 'string' ? data.anchorId.trim() : '';
  if (!anchorId) {
    sendProtocolError(ws, 'ANCHOR_REQUIRED', 'chat.edit-send requires the anchorId of the message being replaced.', sessionId);
    return;
  }

  let resumeThroughId: string | null;
  try {
    const anchor = await sessionsService.resolveEditAnchor(sessionId, anchorId);
    if (!anchor) {
      sendProtocolError(
        ws,
        'EDIT_NOT_SUPPORTED',
        `Provider "${provider}" cannot replace an already-sent message.`,
        sessionId
      );
      return;
    }
    if (!anchor.found) {
      sendProtocolError(ws, 'ANCHOR_NOT_FOUND', 'That message is no longer in the transcript.', sessionId);
      return;
    }
    resumeThroughId = anchor.resumeThroughId;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendProtocolError(ws, 'ANCHOR_LOOKUP_FAILED', `Could not read the transcript: ${message}`, sessionId);
    return;
  }

  // Providers split here on what their runtime can do. Claude resumes its
  // transcript partway, so the anchor rides along as a run option. Codex
  // cannot — a thread only grows — so the conversation is rewound on disk and
  // the run that follows is an ordinary resume of whatever the session then
  // points at. Which of the two applies is decided here; the rewind itself
  // waits until the run has actually been admitted.
  const rewinds = sessionsService.providerRewindsForEdit(sessionId);

  await dispatchRun(
    ws,
    userId,
    sessionId,
    session,
    data,
    dependencies,
    // `null` is meaningful: the edited turn was the first prompt, so the
    // conversation starts over instead of resuming.
    rewinds
      ? {}
      : { resumeAnchorId: resumeThroughId ?? undefined, resumeFromScratch: resumeThroughId === null },
    async (run) => {
      // Emitted through the run's writer so it is sequenced and replayed like
      // any other event — a second tab watching this session has to truncate
      // too.
      //
      // Before the rewind, not after it. A rewind that has to branch spawns a
      // process and waits on a JSON-RPC round trip, and holding the frame
      // until that came back left the message the user had just edited away
      // sitting on screen for about a second — the very flicker this feature
      // exists to avoid. Announcing first is safe because a rewind that fails
      // still ends the run, and the terminal `complete` makes every client
      // re-read the transcript, which puts back anything that turned out not
      // to have been replaced after all.
      run.writer.send({
        kind: 'history_truncated',
        provider,
        sessionId,
        anchorId,
      });

      if (rewinds) {
        try {
          await sessionsService.rewindSessionForEdit(sessionId, resumeThroughId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendProtocolError(ws, 'EDIT_REWIND_FAILED', `Could not rewind the conversation: ${message}`, sessionId);
          // Ends the run before the provider is asked to continue a
          // conversation that was not rewound after all.
          throw error;
        }
      }
    },
  );
}

/**
 * Handles `chat.abort`: cancels the run for one app session and emits the
 * terminal `complete` on its behalf (runtimes skip their own complete for
 * aborted runs, and the registry drops any duplicate).
 */
async function handleChatAbort(
  ws: WebSocket,
  userId: string | number | null,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): Promise<void> {
  const sessionId = readRequiredSessionId(data);
  if (!sessionId) {
    sendProtocolError(ws, 'SESSION_ID_REQUIRED', 'chat.abort requires a sessionId.');
    return;
  }

  assertSshSessionOwner(sessionId, userId);
  const run = chatRunRegistry.getRun(sessionId);
  if (!run || run.status !== 'running') {
    sendProtocolError(ws, 'NO_ACTIVE_RUN', `Session "${sessionId}" has no active run.`, sessionId);
    return;
  }

  let success = false;
  stoppingRuns.add(run);
  runCancellations.get(run)?.abort();
  try {
    success = await dependencies.runtime.abort(run.provider, sessionId);
    if (!success) sendProtocolError(ws, 'CHAT_ABORT_FAILED', 'The task has not confirmed cancellation; it is still running or finalizing.', sessionId);
  } catch (error) {
    sendProtocolError(ws, 'CHAT_ABORT_FAILED', error instanceof Error ? error.message : String(error), sessionId);
  } finally {
    // Aborting a provider can outlive its run; never complete a subsequent run.
    if (success) chatRunRegistry.completeRunIfCurrent(run, { exitCode: 0, aborted: true });
    stoppingRuns.delete(run);
    if (!success && settledRuns.has(run)) chatRunRegistry.completeRunIfCurrent(run, { exitCode: 1 });
    finishSettledRun(run);
  }
}

/**
 * Handles `chat.subscribe`: for each requested session, reports whether a run
 * is processing, re-attaches the live stream to this socket, replays missed
 * events (seq > lastSeq), and includes pending permission requests.
 *
 * This single message replaces the old `check-session-status`,
 * `get-pending-permissions`, and Claude-only writer reconnect flows.
 */
function handleChatSubscribe(
  ws: WebSocket,
  userId: string | number | null,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): void {
  const targets = Array.isArray(data.sessions) ? data.sessions : [];

  for (const target of targets) {
    if (!target || typeof target !== 'object') {
      continue;
    }

    const sessionId = typeof (target as AnyRecord).sessionId === 'string'
      ? ((target as AnyRecord).sessionId as string).trim()
      : '';
    if (!sessionId) {
      continue;
    }

    try { assertSshSessionOwner(sessionId, userId); }
    catch (error) { workspaceRejection(ws, error, sessionId); continue; }

    const lastSeqRaw = (target as AnyRecord).lastSeq;
    const lastSeq = typeof lastSeqRaw === 'number' && Number.isFinite(lastSeqRaw)
      ? Math.max(0, Math.floor(lastSeqRaw))
      : 0;

    const run = chatRunRegistry.getRun(sessionId);
    const isProcessing = chatRunRegistry.isProcessing(sessionId);
    // Sequence numbers restart for each run. Older clients omit runId and keep
    // their previous cursor semantics; null explicitly means no known run.
    const cursorRunId = (target as AnyRecord).runId;
    const replayAfter = cursorRunId !== undefined && cursorRunId !== run?.runId ? 0 : lastSeq;

    // Future live events for this run should land on the socket that asked —
    // this is what makes mid-stream page refreshes work for all providers.
    if (run && run.status === 'running') {
      chatRunRegistry.attachConnection(sessionId, ws);
    }

    // Pending approvals are tracked under the app session id inside the
    // Claude runtime, so they can be looked up directly.
    const pendingPermissions = dependencies.runtime.getPendingApprovalsForSession(sessionId);

    sendJson(ws, {
      kind: 'chat_subscribed',
      sessionId,
      isProcessing,
      runId: run?.runId ?? null,
      runPhase: run?.phase ?? null,
      lastSeq: run?.lastSeq ?? 0,
      pendingPermissions,
      timestamp: new Date().toISOString(),
    });
    const lifecycle = chatRunRegistry.lifecycleSnapshot(sessionId);
    if (lifecycle) sendJson(ws, lifecycle);

    // Replay only for RUNNING runs, strictly after the ack. Completed runs
    // are fully persisted to the provider transcript and served over REST —
    // replaying them (e.g. after a page reload where the client's lastSeq is
    // 0) would duplicate messages the history fetch already returned.
    if (isProcessing) {
      for (const event of chatRunRegistry.replayEvents(sessionId, replayAfter)) {
        sendJson(ws, event);
      }
    }
  }
}

/**
 * Handles `chat.permission-response`: forwards a tool-approval decision to the
 * pending approval resolver (Claude is the only provider with interactive
 * approvals today, but the message is intentionally provider-neutral).
 */
function handlePermissionResponse(ws: WebSocket, userId: string | number | null, data: AnyRecord, dependencies: ChatWebSocketDependencies): void {
  if (typeof data.requestId !== 'string' || data.requestId.length === 0) {
    return;
  }

  // Never trust a client-supplied session id for a global approval resolver.
  // Only an actual pending request in an owned registered run may be resolved.
  const matches = chatRunRegistry.listRunningRuns().filter(run => dependencies.runtime.getPendingApprovalsForSession(run.sessionId)
    .some(value => value !== null && typeof value === 'object' && (value as AnyRecord).requestId === data.requestId));
  if (matches.length !== 1) {
    sendProtocolError(ws, 'PERMISSION_REQUEST_NOT_FOUND', 'The permission request is no longer pending.');
    return;
  }
  assertSshSessionOwner(matches[0]!.sessionId, userId);
  dependencies.runtime.resolveToolApproval(data.requestId, {
    allow: Boolean(data.allow),
    updatedInput: data.updatedInput,
    message: typeof data.message === 'string' ? data.message : undefined,
    rememberEntry: data.rememberEntry,
  });
}

/**
 * Handles authenticated chat websocket messages used by the main chat panel.
 *
 * Inbound protocol (client to server):
 * - `chat.send`                { sessionId, projectId?, workspaceId?, generation?, content, options? }
 * - `chat.edit-send`           { sessionId, projectId?, workspaceId?, generation?, anchorId, content, options? }
 *   Bound sessions require all three workspace selector fields.
 * - `chat.abort`               { sessionId }
 * - `chat.subscribe`           { sessions: [{ sessionId, lastSeq? }] }
 * - `chat.permission-response` { requestId, allow, updatedInput?, message?, rememberEntry? }
 *
 * Outbound protocol (server to client): every frame is `kind`-based — either
 * a provider `NormalizedMessage` (with `seq`) or a gateway event
 * (`chat_subscribed`, `session_upserted`, `loading_progress`,
 * `protocol_error`).
 */
/**
 * Runs a turn for a session with no client attached.
 *
 * Used by scheduled messages, which fire from a timer: there is no socket to
 * report errors to and no audience to stream to. The run is registered exactly
 * like an interactive one, so anyone who opens the session while it is going
 * subscribes and replays it from the start, and the session shows as busy
 * everywhere in the meantime.
 *
 * Resolves when the provider run settles. Returns false when the session has
 * gone away or is busy without `interruptActiveRun`, which the caller reports
 * on the schedule.
 */
export async function runDetachedChatTurn(
  input: {
    sessionId: string;
    userId: string | number | null;
    content: string;
    options?: AnyRecord;
    /**
     * Aborts a run already in progress instead of refusing to start. A
     * scheduled message sets this: the user picked the time knowing it might
     * land mid-run, so the timer outranks whatever is running.
     */
    interruptActiveRun?: boolean;
  },
  dependencies: ChatWebSocketDependencies,
): Promise<{ started: boolean; error: string | null; code?: string; retryable?: boolean }> {
  const session = sessionsDb.getSessionById(input.sessionId);
  if (!session) {
    return { started: false, error: 'The session no longer exists.' };
  }

  const provider = session.provider as LLMProvider;
  if (!dependencies.runtime.hasRuntime(provider)) {
    return { started: false, error: `Provider "${provider}" is not available.` };
  }

  const data: AnyRecord = { sessionId: input.sessionId, content: input.content, options: input.options ?? {} };
  try {
    // Persisted queues/schedules retain their enqueue-time selector. Never
    // silently resolve a newer generation when their stored choice is stale.
    const selector: unknown = input.options?.workspace;
    if (selector !== undefined) {
      if (!selector || typeof selector !== 'object' || Array.isArray(selector)) {
        throw new AppError('The queued workspace selector is invalid.', { code: 'INVALID_WORKSPACE_SELECTOR', statusCode: 400 });
      }
      const snapshot = selector as AnyRecord;
      Object.assign(data, { projectId: snapshot.projectId, workspaceId: snapshot.workspaceId, generation: snapshot.generation });
    }
    const ssh = assertSshSessionOwner(input.sessionId, input.userId);
    if (ssh && provider !== 'claude') throw new AppError('SSH 本地项目目前仅支持 VPS Claude Code。', { code: 'WORKSPACE_PROVIDER_UNSUPPORTED', statusCode: 409 });
    resolveChatWorkspace(input.sessionId, session, data);
  } catch (error) {
    // A stale scheduled message must not cancel a current, valid run.
    return workspaceRejection(null, error, input.sessionId);
  }

  const activeRun = chatRunRegistry.getRun(input.sessionId);
  if (!input.interruptActiveRun && isChatRunInFlight(input.sessionId)) {
    return { started: false, error: 'A run was already in progress for this session.', code: 'RUN_IN_PROGRESS', retryable: true };
  }
  if (activeRun && activeRun.status === 'running') {
    // Same shape as `chat.abort`: cancel the provider run and emit the
    // terminal `complete` on its behalf, so every watching client sees the
    // interrupted run end before this turn's stream begins. The interrupted
    // run's own dispatch settles later through completeRunIfCurrent, which is
    // scoped to that run and cannot touch the one started here.
    stoppingRuns.add(activeRun);
    let aborted = false;
    runCancellations.get(activeRun)?.abort();
    try {
      aborted = await dependencies.runtime.abort(activeRun.provider, input.sessionId);
    } catch (error) {
      return { started: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      if (aborted) chatRunRegistry.completeRunIfCurrent(activeRun, { exitCode: 0, aborted: true });
      stoppingRuns.delete(activeRun);
      if (!aborted && settledRuns.has(activeRun)) chatRunRegistry.completeRunIfCurrent(activeRun, { exitCode: 1 });
      finishSettledRun(activeRun);
    }
    if (!aborted) return { started: false, error: 'The previous task has not confirmed cancellation; the replacement was not started.' };
  }

  return dispatchRun(
    null,
    input.userId,
    input.sessionId,
    session,
    data,
    dependencies,
  );
}

export function handleChatConnection(
  ws: WebSocket,
  request: AuthenticatedWebSocketRequest,
  dependencies: ChatWebSocketDependencies
): void {
  console.log('[INFO] Chat WebSocket connected');
  connectedClients.add(ws);

  const userId = readRequestUserId(request);
  setConnectedClientUserId(ws, userId);

  ws.on('message', async (rawMessage) => {
    try {
      const parsed = parseIncomingJsonObject(rawMessage);
      if (!parsed) {
        throw new Error('Invalid websocket payload');
      }

      const data = parsed as AnyRecord;
      const messageType = typeof data.type === 'string' ? data.type : '';

      switch (messageType) {
        case 'chat.edit-send':
          await handleChatEditSend(ws, userId, data, dependencies);
          return;
        case 'chat.send':
          await handleChatSend(ws, userId, data, dependencies);
          return;
        case 'chat.abort':
          await handleChatAbort(ws, userId, data, dependencies);
          return;
        case 'chat.subscribe':
          handleChatSubscribe(ws, userId, data, dependencies);
          return;
        case 'chat.permission-response':
          handlePermissionResponse(ws, userId, data, dependencies);
          return;
        default:
          sendProtocolError(ws, 'UNKNOWN_MESSAGE_TYPE', `Unknown message type "${messageType}".`);
          return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ERROR] Chat WebSocket error:', message);
      sendProtocolError(ws, error instanceof AppError ? error.code : 'INTERNAL_ERROR', message);
    }
  });

  ws.on('close', () => {
    console.log('[INFO] Chat client disconnected');
    connectedClients.delete(ws);
    setConnectedClientUserId(ws, null);
  });
}
