import { useEffect, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import type { ChatReplayCursor, ChatStreamBuffer, ServerEvent,MarkSessionIdle,MarkSessionProcessing,PendingPermissionRequest,ProjectSession,LLMProvider,NormalizedMessage } from '@/shared/types';
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
  streamBuffersRef: MutableRefObject<Map<string, ChatStreamBuffer>>;
  /**
   * Highest consumed seq in the session's channel. Only a new replay epoch resets
   * the watermark; a later run continues the same channel's monotonic sequence.
   */
  replayCursorsRef: MutableRefObject<Map<string, ChatReplayCursor>>;
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
  streamBuffersRef,
  replayCursorsRef,
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

  useEffect(() => {
    const finishStream = (sessionId: string) => {
      const buffer = streamBuffersRef.current.get(sessionId);
      if (buffer?.timer !== null && buffer?.timer !== undefined) clearTimeout(buffer.timer);
      if (buffer?.text) sessionStore.updateStreaming(sessionId, buffer.text, buffer.provider);
      sessionStore.finalizeStreaming(sessionId);
      streamBuffersRef.current.delete(sessionId);
    };
    const handleEvent = (msg: ServerEvent) => {
      if (!msg.kind) {
        return;
      }

      const activeViewSessionId = activeViewSessionIdRef.current;
      const sid = (typeof msg.sessionId === 'string' && msg.sessionId) || activeViewSessionId;

      if (sid && typeof msg.replayEpoch === 'string'
        && replayCursorsRef.current.get(sid)?.replayEpoch !== msg.replayEpoch) {
        const previous = replayCursorsRef.current.get(sid);
        if (previous?.replayEpoch) finishStream(sid);
        replayCursorsRef.current.set(sid, { replayEpoch: msg.replayEpoch, runId: previous?.runId, seq: 0 });
      }
      if (sid && typeof msg.seq === 'number') {
        const cursor = replayCursorsRef.current.get(sid);
        // Deduplicate before touching stream ownership: an old-run duplicate cannot flush a new run.
        if (msg.seq <= (cursor?.seq ?? 0)) return;
      }
      if (sid && msg.runId && replayCursorsRef.current.get(sid)?.runId !== msg.runId) {
        const cursor = replayCursorsRef.current.get(sid);
        // First metadata attaches to an existing partial paragraph; a known run change finalizes it.
        if (cursor?.runId || (streamBuffersRef.current.get(sid)?.runId
          && streamBuffersRef.current.get(sid)?.runId !== msg.runId)) finishStream(sid);
        replayCursorsRef.current.set(sid, { ...cursor, runId: msg.runId, seq: cursor?.seq ?? 0 });
      }
      if (sid && typeof msg.seq === 'number') {
        const cursor = replayCursorsRef.current.get(sid);
        replayCursorsRef.current.set(sid, {
          replayEpoch: msg.replayEpoch ?? cursor?.replayEpoch,
          runId: msg.runId ?? cursor?.runId,
          seq: Math.max(cursor?.seq ?? 0, msg.seq),
        });
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
            onSessionProcessing?.(sid, {
              runId: msg.runId,
              modelStopped: msg.modelStopped,
              ...(typeof msg.statusText === 'string' ? { statusText: msg.statusText } : {}),
            });
          } else {
            // Idle ack: ignore it if a newer request started after the subscribe was sent.
            onSessionIdle?.(sid, {
              ifStartedBefore: statusCheckSentAtRef.current.get(sid),
            });
            finishStream(sid);
            if (sid === activeViewSessionId && replayCursorsRef.current.has(sid)) {
              void requestLatestMessages(sid, isActiveRef.current);
            }
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

        case 'protocol_error': {
          console.error('[Chat] Protocol error:', msg.code, msg.error);
          if (sid) {
            // These rejections leave the existing run or its file handback live.
            // Only a terminal event or an authoritative idle snapshot can unlock it.
            if (msg.code !== 'CHAT_ABORT_FAILED' && msg.code !== 'RUN_IN_PROGRESS') {
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
        if (!text || !sid) return;
        let buffer = streamBuffersRef.current.get(sid);
        if (!buffer) {
          const current = sessionStore.getMessages(sid).find(row => row.id === `__streaming_${sid}`);
          buffer = { runId: msg.runId, provider: (msg.provider as LLMProvider) || provider, text: current?.content ?? '', timer: null };
          streamBuffersRef.current.set(sid, buffer);
        }
        buffer.text += text;
        if (buffer.timer === null) {
          const pendingBuffer = buffer;
          buffer.timer = window.setTimeout(() => {
            pendingBuffer.timer = null;
            sessionStore.updateStreaming(sid, pendingBuffer.text, pendingBuffer.provider);
          }, 100);
        }
        return;
      }

      if (msg.kind === 'stream_end') {
        if (sid) finishStream(sid);
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
          if (sid) finishStream(sid);

          // `complete` is the unified terminal event — every provider run ends
          // with exactly one, regardless of success, failure, or abort. The
          // indicator derives from the processing map, so deleting the entry
          // hides it immediately and atomically.
          onSessionIdle?.(sid, { runId: msg.runId });
          if (sid === activeViewSessionId) {
            pendingPermissionRequestsRef.current = [];
            setPendingPermissionRequests([]);
          }

          // Celebrate only successful runs (failed runs end with success: false).
          if (!msg.aborted && msg.success !== false) {
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
              runId: msg.runId,
              modelStopped: msg.text === 'model_stopped' ? true : msg.modelStopped,
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
    streamBuffersRef,
    replayCursorsRef,
    statusCheckSentAtRef,
    onSessionProcessing,
    onSessionIdle,
    onWebSocketReconnect,
    requestLatestMessages,
    sessionStore,
  ]);
}
