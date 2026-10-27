import { useEffect, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import type { ServerEvent,MarkSessionIdle,MarkSessionProcessing,PendingPermissionRequest,ProjectSession,LLMProvider,NormalizedMessage } from '@/shared/types';
import { showCompletionTitleIndicator } from '@/modules/chat/utils/pageTitleNotification';
import { playChatCompletionSound, playNotificationSound } from '@/shared/utils';
import type { SessionStore } from '@/modules/chat/hooks/useSessionStore';

const isActionablePermissionRequest = (request: { toolName?: unknown } | null | undefined): boolean => {
  return request?.toolName !== 'ExitPlanMode' && request?.toolName !== 'exit_plan_mode';
};

const hasActionablePermissionRequests = (requests: Array<{ toolName?: unknown }> | null | undefined): boolean => {
  return Array.isArray(requests) && requests.some((request) => isActionablePermissionRequest(request));
};

type UseChatRealtimeHandlersArgs = {
  isActive: boolean;
  subscribe: (listener: (event: ServerEvent) => void) => () => void;
  provider: LLMProvider;
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  setTokenBudget: (budget: Record<string, unknown> | null) => void;
  pendingPermissionRequests: PendingPermissionRequest[];
  setPendingPermissionRequests: Dispatch<SetStateAction<PendingPermissionRequest[]>>;
  /**
   * Highest live `seq` observed for each session's current run. Subscribe sends
   * this with its run id so a subsequent run cannot inherit an old cursor.
   */
  lastSeqRef: MutableRefObject<Map<string, number>>;
  cursorRunIdRef: MutableRefObject<Map<string, string>>;
  /** When each session's `chat.subscribe` was last sent; guards stale idle acks. */
  statusCheckSentAtRef: MutableRefObject<Map<string, number>>;
  onSessionProcessing?: MarkSessionProcessing;
  onSessionIdle?: MarkSessionIdle;
  onWebSocketReconnect?: () => void;
  requestLatestMessages: (sessionId: string, allowNetwork?: boolean) => Promise<void>;
  sessionStore: SessionStore;
};

/* ------------------------------------------------------------------ */
/*  Hook                                                              */
/* ------------------------------------------------------------------ */

/**
 * Routes server events into the session store and processing-state map.
 *
 * This is intentionally a thin reducer over the unified `kind`-based
 * protocol: every frame is keyed by the stable app session id, so there is
 * no session-id handoff, no provider branching, and no navigation here.
 * Sidebar events (`session_upserted`, `loading_progress`) are handled by
 * `useProjectsState`, not in this hook.
 */
export function useChatRealtimeHandlers({
  isActive,
  subscribe,
  provider,
  selectedSession,
  currentSessionId,
  setTokenBudget,
  pendingPermissionRequests,
  setPendingPermissionRequests,
  lastSeqRef,
  cursorRunIdRef,
  statusCheckSentAtRef,
  onSessionProcessing,
  onSessionIdle,
  onWebSocketReconnect,
  requestLatestMessages,
  sessionStore,
}: UseChatRealtimeHandlersArgs) {
  // Session switches can send `chat.subscribe` before this effect has a chance
  // to rebind the websocket listener. Read the visible session id from a ref
  // so a fast `chat_subscribed` ack is matched against the current view, not
  // the previous render's closed-over selection.
  const activeViewSessionIdRef = useRef<string | null>(selectedSession?.id || currentSessionId || null);
  activeViewSessionIdRef.current = selectedSession?.id || currentSessionId || null;
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;

  // Keep the latest pending-permission snapshot available to the websocket
  // listener so back-to-back permission events can dedupe and re-arm the
  // notification sound before React finishes a rerender.
  const pendingPermissionRequestsRef = useRef(pendingPermissionRequests);

  useEffect(() => {
    pendingPermissionRequestsRef.current = pendingPermissionRequests;
  }, [pendingPermissionRequests]);

  // A socket can deliver several sessions at once. Each reply retains its own
  // text/provider; its start time guards against an older idle subscribe ack.
  const streamsRef = useRef(new Map<string, { content: string; provider: LLMProvider; dirty: boolean; startedAt: number }>());
  // A run can announce itself before its first text; protect its cursor from
  // an idle acknowledgement for a subscribe sent before that announcement.
  const runStartedAtRef = useRef(new Map<string, number>());
  // One timer batches updates for all dirty sessions without coupling their text.
  const streamTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (streamTimerRef.current !== null) {
      clearTimeout(streamTimerRef.current);
      streamTimerRef.current = null;
    }
    streamsRef.current.clear();
    runStartedAtRef.current.clear();
  }, []);

  useEffect(() => {
    const finalizeStream = (sessionId: string) => {
      const stream = streamsRef.current.get(sessionId);
      if (stream?.content) {
        sessionStore.updateStreaming(sessionId, stream.content, stream.provider);
      }
      sessionStore.finalizeStreaming(sessionId);
      streamsRef.current.delete(sessionId);
    };

    const handleEvent = (msg: ServerEvent) => {
      if (!msg.kind) {
        return;
      }

      const activeViewSessionId = activeViewSessionIdRef.current;
      const sid = (typeof msg.sessionId === 'string' && msg.sessionId) || activeViewSessionId;

      const runId = typeof msg.runId === 'string' && msg.runId ? msg.runId : null;
      const isRunSnapshot = msg.kind === 'chat_subscribed' || msg.kind === 'chat_run_status';
      const isActiveSnapshot = msg.kind === 'chat_subscribed'
        ? msg.isProcessing === true
        : msg.phase !== 'completed' && msg.status !== 'completed';
      if (sid && runId && (!isRunSnapshot || isActiveSnapshot)) {
        const previousRunId = cursorRunIdRef.current.get(sid);
        if (previousRunId && previousRunId !== runId) {
          finalizeStream(sid);
          lastSeqRef.current.set(sid, 0);
        }
        // The first identified snapshot may follow anonymous events from this
        // same run. Keep those observed events when learning its identity.
        cursorRunIdRef.current.set(sid, runId);
        if (previousRunId !== runId) {
          // An ack describes the subscribe already in flight. Only a live
          // announcement can establish a newer run after that request.
          if (msg.kind === 'chat_subscribed') runStartedAtRef.current.delete(sid);
          else runStartedAtRef.current.set(sid, Date.now());
        }
      }

      // Snapshot lastSeq describes frames on the server, not frames we received.
      if (sid && typeof msg.seq === 'number') {
        const known = lastSeqRef.current.get(sid) ?? 0;
        if (msg.seq > known) {
          lastSeqRef.current.set(sid, msg.seq);
        }
      }

      switch (msg.kind) {
        case 'websocket_reconnected':
          onWebSocketReconnect?.();
          return;

        case 'history_truncated': {
          // An already-sent message was replaced. Every client watching this
          // session drops the superseded turns before the replacement streams
          // in, so a second tab does not end up showing the question twice.
          if (sid && typeof msg.anchorId === 'string') {
            sessionStore.truncateAt(sid, msg.anchorId);
          }
          return;
        }

        case 'chat_subscribed': {
          // Ack for chat.subscribe: authoritative processing state plus any
          // pending tool-permission prompts for the run.
          if (!sid) return;

          if (msg.isProcessing) {
            onSessionProcessing?.(sid);
          } else {
            const subscribedAt = statusCheckSentAtRef.current.get(sid);
            const stream = streamsRef.current.get(sid);
            const runStartedAt = runStartedAtRef.current.get(sid);
            const newerRun = runStartedAt !== undefined && subscribedAt !== undefined && runStartedAt >= subscribedAt;
            const newerStream = stream && subscribedAt !== undefined && stream.startedAt >= subscribedAt;
            // Completed runs are not replayed after reconnect. Retire their
            // buffer/cursor, preserving a run started after this subscribe.
            if (!newerRun && !newerStream) {
              if (stream) finalizeStream(sid);
              lastSeqRef.current.set(sid, 0);
              cursorRunIdRef.current.delete(sid);
              runStartedAtRef.current.delete(sid);
            }
            // Idle ack: ignore it if a newer request started after the
            // subscribe was sent — the ack describes the older state.
            onSessionIdle?.(sid, {
              ifStartedBefore: subscribedAt,
            });
          }

          const isViewedSession = sid === activeViewSessionId;
          if (isViewedSession && Array.isArray(msg.pendingPermissions)) {
            const nextPendingPermissionRequests = msg.pendingPermissions as PendingPermissionRequest[];
            const hadActionablePermissionRequests = hasActionablePermissionRequests(pendingPermissionRequestsRef.current);
            const hasPendingActionablePermissionRequests = hasActionablePermissionRequests(nextPendingPermissionRequests);

            pendingPermissionRequestsRef.current = nextPendingPermissionRequests;
            setPendingPermissionRequests(nextPendingPermissionRequests);

            if (hasPendingActionablePermissionRequests && !hadActionablePermissionRequests) {
              void playNotificationSound();
            }
          }
          return;
        }

        case 'chat_run_status':
          // Lifecycle snapshots establish the replay run, not transcript rows.
          // `complete` remains the terminal event for processing/activity.
          return;

        case 'protocol_error': {
          console.error('[Chat] Protocol error:', msg.code, msg.error);
          if (sid) {
            // Rejected sends can end optimistic activity; these errors instead
            // confirm an existing run is still running or handing files back.
            if (msg.code !== 'RUN_IN_PROGRESS' && msg.code !== 'CHAT_ABORT_FAILED') {
              onSessionIdle?.(sid);
            }
            sessionStore.appendRealtime(sid, {
              id: `protocol_error_${Date.now()}`,
              sessionId: sid,
              timestamp: new Date().toISOString(),
              provider,
              kind: 'error',
              content: String(msg.error || 'Request failed'),
            } as NormalizedMessage);
          }
          return;
        }

        // Sidebar/global events — owned by useProjectsState.
        case 'session_upserted':
        case 'loading_progress':
          return;

        default:
          break;
      }

      /* -------------------------------------------------------------- */
      /*  Provider NormalizedMessage handling                            */
      /* -------------------------------------------------------------- */

      // --- Streaming: buffer for performance ---
      if (msg.kind === 'stream_delta') {
        const text = (msg.content as string) || '';
        if (!sid || !text) return;
        const stream = streamsRef.current.get(sid) ?? {
          content: '',
          provider: (msg.provider as LLMProvider) || provider,
          dirty: false,
          startedAt: Date.now(),
        };
        stream.content += text;
        stream.dirty = true;
        streamsRef.current.set(sid, stream);
        if (streamTimerRef.current === null) {
          streamTimerRef.current = window.setTimeout(() => {
            streamTimerRef.current = null;
            for (const [sessionId, pendingStream] of streamsRef.current) {
              if (!pendingStream.dirty) continue;
              pendingStream.dirty = false;
              sessionStore.updateStreaming(sessionId, pendingStream.content, pendingStream.provider);
            }
          }, 100);
        }
        return;
      }

      if (msg.kind === 'stream_end') {
        if (sid) finalizeStream(sid);
        return;
      }

      // --- All other messages: route to store ---
      const shouldPersist =
        msg.kind !== 'complete'
        && msg.kind !== 'status'
        && msg.kind !== 'permission_request'
        && msg.kind !== 'permission_resolved'
        && msg.kind !== 'permission_cancelled';

      if (sid && shouldPersist) {
        sessionStore.appendRealtime(sid, msg as unknown as NormalizedMessage);
      }

      // --- UI side effects for specific kinds ---
      switch (msg.kind) {
        case 'complete': {
          // A terminal event only owns the matching session's stream.
          if (sid) {
            finalizeStream(sid);
            lastSeqRef.current.set(sid, 0);
            cursorRunIdRef.current.delete(sid);
            runStartedAtRef.current.delete(sid);
          }

          // `complete` is the unified terminal event — every provider run ends
          // with exactly one, regardless of success, failure, or abort. The
          // indicator derives from the processing map, so deleting the entry
          // hides it immediately and atomically.
          onSessionIdle?.(sid);
          if (sid === activeViewSessionId) {
            pendingPermissionRequestsRef.current = [];
            setPendingPermissionRequests([]);
          }

          if (msg.aborted) {
            // Abort was requested — the complete event confirms it. No
            // further UI action is needed beyond clearing the entry above.
            break;
          }

          // Celebrate only successful runs (failed runs end with success: false).
          if (msg.success !== false) {
            showCompletionTitleIndicator();
            void playChatCompletionSound();
          }

          // The session id is stable for the whole conversation (allocated
          // before the first send), so the only follow-up is syncing the
          // viewed conversation with the now-persisted transcript.
          if (sid && sid === activeViewSessionId) {
            void requestLatestMessages(sid, isActiveRef.current);
          }

          break;
        }

        // 'error' is an informational message row, not a terminal event —
        // providers emit it for mid-run stderr output too. Run teardown is
        // always signalled by the unified 'complete' that follows.

        case 'permission_request': {
          if (!msg.requestId) break;
          if (isActionablePermissionRequest({ toolName: msg.toolName })) {
            void playNotificationSound();
          }

          if (sid === activeViewSessionId) {
            const previousPendingPermissionRequests = pendingPermissionRequestsRef.current;
            if (!previousPendingPermissionRequests.some((request) => request.requestId === msg.requestId)) {
              const nextPendingPermissionRequests = [...previousPendingPermissionRequests, {
                requestId: msg.requestId as string,
                toolName: (msg.toolName as string) || 'UnknownTool',
                input: msg.input,
                context: msg.context,
                sessionId: sid || null,
                receivedAt: new Date(),
              }];

              pendingPermissionRequestsRef.current = nextPendingPermissionRequests;
              setPendingPermissionRequests(nextPendingPermissionRequests);
            }
          }
          if (sid) {
            onSessionProcessing?.(sid);
          }
          break;
        }

        // `permission_resolved` arrives when any client answers the prompt: it
        // retracts a replayed `permission_request` after a mid-run refresh and
        // clears the prompt in other tabs watching the same run.
        case 'permission_resolved':
        case 'permission_cancelled': {
          if (msg.requestId && sid === activeViewSessionId) {
            const nextPendingPermissionRequests = pendingPermissionRequestsRef.current.filter(
              (request: PendingPermissionRequest) => request.requestId !== msg.requestId,
            );

            pendingPermissionRequestsRef.current = nextPendingPermissionRequests;
            setPendingPermissionRequests(nextPendingPermissionRequests);
          }
          break;
        }

        case 'status': {
          // Model metadata is consumed by useChatProviderState, not a processing-state transition.
          if (msg.text === 'model_resolved') break;
          if (msg.text === 'token_budget' && msg.tokenBudget) {
            // The counter shows the viewed session's context; budgets from
            // other concurrently running sessions must not overwrite it.
            if (sid === activeViewSessionId) {
              setTokenBudget(msg.tokenBudget as Record<string, unknown>);
            }
          } else if (msg.text && sid) {
            onSessionProcessing?.(sid, {
              statusText: msg.text as string,
              canInterrupt: msg.canInterrupt !== false,
            });
          }
          break;
        }

        // text, tool_use, tool_result, thinking, task_notification
        // → already routed to store above, no UI side effects needed
        default:
          break;
      }
    };

    return subscribe(handleEvent);
  }, [
    subscribe,
    provider,
    selectedSession,
    currentSessionId,
    setTokenBudget,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    lastSeqRef,
    cursorRunIdRef,
    statusCheckSentAtRef,
    onSessionProcessing,
    onSessionIdle,
    onWebSocketReconnect,
    requestLatestMessages,
    sessionStore,
  ]);
}
