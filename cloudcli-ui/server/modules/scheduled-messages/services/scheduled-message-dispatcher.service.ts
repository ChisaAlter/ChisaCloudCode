import { AsyncLocalStorage } from 'node:async_hooks';

import { scheduledMessagesDb, sessionDraftsDb } from '@/modules/database/index.js';
import type { QueuedSessionMessageRecord, ScheduledMessageRow } from '@/modules/database/index.js';
import { isChatRunInFlight, onChatRunSettled, runDetachedChatTurn } from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';

// Completion wakes the queue immediately; polling also catches persisted edits
// and workspace changes that did not come from a chat run in this process.
const POLL_INTERVAL_MS = 30_000;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let wakeTimer: ReturnType<typeof setImmediate> | null = null;
let removeSettledListener: (() => void) | null = null;
let dispatchInFlight = false;
let dispatchRequested = false;
const sessionDispatches = new Map<string, Promise<void>>();
// Due schedules may interrupt an active queued turn, but remain ordered against other schedules.
const scheduledDispatches = new Map<string, Promise<void>>();
let dispatcherRuntime: ProviderRuntimeGateway | null = null;
let dispatcherScope: ReturnType<typeof AsyncLocalStorage.snapshot> | null = null;
let wakeDispatcher: (() => void) | null = null;

type StoredQueuedMessage = {
  content: string;
  options: Record<string, unknown>;
  attachments: unknown[];
  autoSend: boolean;
};

function readOptions(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function readQueuedMessage(value: unknown): StoredQueuedMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const content = typeof record.content === 'string' ? record.content : '';
  const attachments = Array.isArray(record.attachments)
    ? record.attachments
    : Array.isArray(record.images) ? record.images : [];
  if (!content.trim() && attachments.length === 0) return null;
  const options = record.options && typeof record.options === 'object' && !Array.isArray(record.options)
    ? record.options as Record<string, unknown>
    : {};
  return { content, options, attachments, autoSend: record.autoSend !== false };
}

function reportDispatchError(error: unknown): void {
  console.error('[ScheduledMessages] Dispatch failed', {
    error: error instanceof Error ? error.message : String(error),
  });
}

function enqueueSessionDispatch(sessionId: string, operation: () => Promise<void>, scheduled = false): Promise<void> {
  // Only this session waits for its preceding dispatch. A different session's
  // admission never depends on a provider stream or workspace handback here.
  const dispatches = scheduled ? scheduledDispatches : sessionDispatches;
  const previous = dispatches.get(sessionId);
  const task = previous ? previous.catch(() => {}).then(operation) : Promise.resolve().then(operation);
  dispatches.set(sessionId, task);
  const forget = () => { if (dispatches.get(sessionId) === task) dispatches.delete(sessionId); };
  void task.then(forget, (error: unknown) => { forget(); reportDispatchError(error); });
  return task;
}

async function sendClaimedQueuedMessage(
  candidate: QueuedSessionMessageRecord,
  runtime: ProviderRuntimeGateway,
): Promise<void> {
  const message = readQueuedMessage(candidate.queuedMessage);
  if (!message) {
    sessionDraftsDb.completeQueuedMessage(candidate);
    return;
  }

  let result: Awaited<ReturnType<typeof runDetachedChatTurn>>;
  try {
    result = await runDetachedChatTurn(
      {
        sessionId: candidate.sessionId,
        userId: candidate.userId,
        content: message.content,
        options: { ...message.options, attachments: message.attachments },
      },
      { runtime },
    );
  } catch (error) {
    sessionDraftsDb.pauseClaimedQueuedMessage(candidate);
    throw error;
  }

  // The registry check and run reservation are separate operations. If a run
  // wins that tiny race, put the turn back so the next poll tries again.
  if (!result.started && (result.retryable || result.reason === 'busy')) {
    sessionDraftsDb.restoreQueuedMessage(candidate);
    return;
  }
  if (!result.started || result.error) {
    sessionDraftsDb.pauseClaimedQueuedMessage(candidate);
    return;
  }
  sessionDraftsDb.completeQueuedMessage(candidate);
  const next = sessionDraftsDb.listQueuedMessages().find(row => row.userId === candidate.userId && row.sessionId === candidate.sessionId);
  if (next && readQueuedMessage(next.queuedMessage)?.autoSend !== false && !isChatRunInFlight(next.sessionId) && sessionDraftsDb.claimQueuedMessage(next)) {
    await sendClaimedQueuedMessage(next, runtime);
  }
}

/** Scheduled dispatcher and tests claim idle-session queued turns once; tests may await completion. */
export async function dispatchQueuedMessages(runtime: ProviderRuntimeGateway, waitForCompletion = true): Promise<number> {
  const tasks: Promise<void>[] = [];
  for (const candidate of sessionDraftsDb.listQueuedMessages()) {
    if (readQueuedMessage(candidate.queuedMessage)?.autoSend === false || sessionDispatches.has(candidate.sessionId) || scheduledDispatches.has(candidate.sessionId) || isChatRunInFlight(candidate.sessionId)) continue;
    if (!sessionDraftsDb.claimQueuedMessage(candidate)) continue;
    tasks.push(enqueueSessionDispatch(candidate.sessionId, () => sendClaimedQueuedMessage(candidate, runtime)));
  }
  if (waitForCompletion) await Promise.all(tasks);
  return tasks.length;
}

async function sendClaimedMessage(row: ScheduledMessageRow, runtime: ProviderRuntimeGateway): Promise<void> {
  try {
    const result = await runDetachedChatTurn(
      {
        sessionId: row.session_id,
        userId: row.user_id,
        content: row.content,
        options: readOptions(row.options),
        // A schedule deliberately interrupts the current run. Other due turns
        // for this same session still wait in order behind this dispatch.
        interruptActiveRun: true,
      },
      { runtime },
    );
    if (!result.started || result.error) {
      scheduledMessagesDb.markFailed(row.id, result.error ?? 'The session was unavailable when this was due.');
    }
  } catch (error) {
    scheduledMessagesDb.markFailed(row.id, error instanceof Error ? error.message : String(error));
  }
}

/** Scheduled dispatcher and tests claim due messages atomically and serialize only within each session. */
export async function dispatchDueScheduledMessages(
  runtime: ProviderRuntimeGateway,
  now: Date = new Date(),
  waitForCompletion = true,
): Promise<number> {
  const due = scheduledMessagesDb.claimDue(now);
  const tasks = due.map(row => enqueueSessionDispatch(row.session_id, () => sendClaimedMessage(row, runtime), true));
  if (waitForCompletion) await Promise.all(tasks);
  return due.length;
}

/** Server startup catches up persisted schedules; completion events wake queues after actual handback. */
export function initializeScheduledMessageDispatcher(runtime: ProviderRuntimeGateway): void {
  if (pollTimer) return;
  dispatcherRuntime = runtime;
  dispatcherScope = AsyncLocalStorage.snapshot();
  const wake = () => {
    if (!pollTimer || wakeTimer) return;
    // Defer until detached dispatch bookkeeping has released its session entry.
    wakeTimer = setImmediate(() => {
      wakeTimer = null;
      dispatcherScope?.(() => { void dispatchQueuedMessages(runtime, false).catch(reportDispatchError); });
    });
    wakeTimer.unref?.();
  };
  const poll = () => {
    if (dispatchInFlight) { dispatchRequested = true; return; }
    dispatchInFlight = true;
    // This gate covers admission only, never a provider run. Due messages are
    // enqueued first, preserving their priority over a queued composer turn.
    void dispatchDueScheduledMessages(runtime, new Date(), false)
      .then(() => dispatchQueuedMessages(runtime, false))
      .catch(reportDispatchError)
      .finally(() => {
        dispatchInFlight = false;
        if (dispatchRequested) { dispatchRequested = false; wake(); }
      });
  };
  wakeDispatcher = wake;
  removeSettledListener = onChatRunSettled(wake);
  pollTimer = setInterval(() => dispatcherScope?.(poll), POLL_INTERVAL_MS);
  pollTimer.unref?.();
  poll();
}

/** Server shutdown removes polling and completion listeners without cancelling already admitted turns. */
export function closeScheduledMessageDispatcher(): void {
  dispatcherRuntime = null;
  dispatcherScope = null;
  wakeDispatcher = null;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  if (wakeTimer) clearImmediate(wakeTimer);
  wakeTimer = null;
  removeSettledListener?.();
  removeSettledListener = null;
  dispatchRequested = false;
}

/** User draft-save wakes admission in the dispatcher startup scope, detached from HTTP cancellation. */
export function wakeQueuedMessageDispatcher(): void {
  if (dispatcherRuntime && dispatcherScope) dispatcherScope(() => wakeDispatcher?.());
}
