import { useCallback, useRef, useState } from 'react';

import type { IsSessionProcessing, MarkSessionIdle, MarkSessionProcessing, SessionActivity, SessionActivityMap, SessionActivitySnapshot, SyncProcessingSessions } from '@/shared/types';




const LOCAL_ACTIVITY_GRACE_MS = 10_000;

const sessionActivityMapsMatch = (
  left: ReadonlyMap<string, SessionActivity>,
  right: ReadonlyMap<string, SessionActivity>,
): boolean => {
  if (left.size !== right.size) {
    return false;
  }

  for (const [sessionId, leftActivity] of left) {
    const rightActivity = right.get(sessionId);
    if (
      !rightActivity
      || leftActivity.statusText !== rightActivity.statusText
      || leftActivity.canInterrupt !== rightActivity.canInterrupt
      || leftActivity.startedAt !== rightActivity.startedAt
      || leftActivity.runId !== rightActivity.runId
      || leftActivity.modelStopped !== rightActivity.modelStopped
    ) {
      return false;
    }
  }

  return true;
};

/**
 * Single source of truth for which sessions are actively processing a
 * request. Everything the chat UI shows (activity indicator, abort
 * availability, status text) is derived from this map; terminal events
 * (`complete`, abort, an authoritative idle subscribe ack) delete the entry
 * atomically. Session ids are always concrete (allocated before the first
 * send), so entries are keyed by real session ids only.
 */
export function useSessionProtection() {
  const [processingSessions, setProcessingSessions] = useState<Map<string, SessionActivity>>(
    new Map(),
  );
  const processingSessionsRef = useRef<SessionActivityMap>(processingSessions);
  processingSessionsRef.current = processingSessions;
  // HTTP snapshots requested before any newer local/socket activity cannot replace it.
  const activityRevisionRef = useRef(0);
  const getActivityRevision = useCallback(() => activityRevisionRef.current, []);

  const markSessionProcessing = useCallback<MarkSessionProcessing>((sessionId, activity) => {
    if (!sessionId) {
      return;
    }
    activityRevisionRef.current += 1;

    setProcessingSessions((prev) => {
      const existing = prev.get(sessionId);
      const newRun = Boolean(existing && activity?.runId && existing.runId !== activity.runId);
      const statusText = activity?.statusText !== undefined ? activity.statusText : newRun ? null : existing?.statusText ?? null;
      // Process exit is monotonic within a run, even when an older subscribe/poll reply arrives late.
      const modelStopped = newRun ? activity?.modelStopped ?? false
        : existing?.modelStopped === true || activity?.modelStopped === true;
      const next: SessionActivity = {
        statusText,
        runId: activity?.runId ?? existing?.runId,
        modelStopped,
        // File handback must finish before the run becomes idle; another abort cannot cancel it.
        canInterrupt: !modelStopped && statusText !== 'workspace_finalizing'
          && (activity?.canInterrupt ?? (newRun ? true : existing?.canInterrupt ?? true)),
        startedAt: newRun ? Date.now() : existing?.startedAt ?? Date.now(),
      };

      if (
        existing
        && existing.statusText === next.statusText
        && existing.canInterrupt === next.canInterrupt
        && existing.runId === next.runId
        && existing.modelStopped === next.modelStopped
      ) {
        return prev;
      }

      const updated = new Map(prev);
      updated.set(sessionId, next);
      return updated;
    });
  }, []);

  const markSessionIdle = useCallback<MarkSessionIdle>((sessionId, opts) => {
    if (!sessionId) {
      return;
    }
    activityRevisionRef.current += 1;

    setProcessingSessions((prev) => {
      const existing = prev.get(sessionId);
      if (!existing) {
        return prev;
      }
      if (opts?.runId && existing.runId && opts.runId !== existing.runId) {
        return prev;
      }

      // Guard against stale `chat_subscribed` idle acks: if a new request
      // started after the subscribe was sent, the idle ack describes the
      // older request and must not clear the newer one.
      if (opts?.ifStartedBefore !== undefined && existing.startedAt >= opts.ifStartedBefore) {
        return prev;
      }

      const updated = new Map(prev);
      updated.delete(sessionId);
      return updated;
    });
  }, []);

  const syncProcessingSessions = useCallback<SyncProcessingSessions>((sessions) => {
    const now = Date.now();

    setProcessingSessions((prev) => {
      const incoming = new Map<string, SessionActivitySnapshot>();
      for (const session of sessions) {
        if (!session.sessionId) {
          continue;
        }
        incoming.set(session.sessionId, session);
      }

      const updated = new Map<string, SessionActivity>();

      for (const [sessionId, snapshot] of incoming) {
        const existing = prev.get(sessionId);
        const snapshotStartedAt =
          typeof snapshot.startedAt === 'number' && Number.isFinite(snapshot.startedAt) && snapshot.startedAt > 0
            ? snapshot.startedAt
            : undefined;

        const newRun = Boolean(existing && snapshot.runId && existing.runId !== snapshot.runId);
        const statusText = snapshot.statusText !== undefined ? snapshot.statusText : newRun ? null : existing?.statusText ?? null;
        const modelStopped = newRun ? snapshot.modelStopped ?? false
          : existing?.modelStopped === true || snapshot.modelStopped === true;
        updated.set(sessionId, {
          statusText,
          runId: snapshot.runId ?? existing?.runId,
          modelStopped,
          canInterrupt: !modelStopped && statusText !== 'workspace_finalizing'
            && (snapshot.canInterrupt ?? (newRun ? true : existing?.canInterrupt ?? true)),
          startedAt: snapshotStartedAt ?? (newRun ? now : existing?.startedAt ?? now),
        });
      }

      for (const [sessionId, activity] of prev) {
        if (!incoming.has(sessionId) && now - activity.startedAt < LOCAL_ACTIVITY_GRACE_MS) {
          updated.set(sessionId, activity);
        }
      }

      return sessionActivityMapsMatch(prev, updated) ? prev : updated;
    });
  }, []);

  const isSessionProcessing = useCallback<IsSessionProcessing>(
    (sessionId) => Boolean(sessionId && processingSessionsRef.current.has(sessionId)),
    [],
  );

  return {
    processingSessions,
    markSessionProcessing,
    markSessionIdle,
    syncProcessingSessions,
    isSessionProcessing,
    getActivityRevision,
  };
}
