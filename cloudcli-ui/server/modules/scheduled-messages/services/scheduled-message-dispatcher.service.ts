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

type StoredQueuedMessage = {
  content: string;
  options: Record<string, unknown>;
  attachments: unknown[];
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
  return { content, options, attachments };
}

function reportDispatchError(error: unknown): void {
  console.error('[ScheduledMessages] Dispatch failed', {
    error: error instanceof Error ? error.message : String(error),
  });
}

function enqueueSessionDispatch(sessionId: string, operation: () => Promise<void>): Promise<void> {
  // Only this session waits for its preceding dispatch. A different session's
  // admission never depends on a provider stream or workspace handback here.
  const previous = sessionDispatches.get(sessionId);
  const task = previous ? previous.catch(() => {}).then(operation) : Promise.resolve().then(operation);
  sessionDispatches.set(sessionId, task);
  const forget = () => { if (sessionDispatches.get(sessionId) === task) sessionDispatches.delete(sessionId); };
  void task.then(forget, (error: unknown) => { forget(); reportDispatchError(error); });
  return task;
}

async function sendClaimedQueuedMessage(
  candidate: QueuedSessionMessageRecord,
  runtime: ProviderRuntimeGateway,
): Promise<void> {
  const message = readQueuedMessage(candidate.queuedMessage);
  if (!message) {
    sessionDraftsDb.deleteEmptyDraft(candidate.userId, candidate.sessionId);
    return;
  }

  const result = await runDetachedChatTurn(
    {
      sessionId: candidate.sessionId,
      userId: candidate.userId,
      content: message.content,
      options: { ...message.options, attachments: message.attachments },
    },
    { runtime },
  );

  // Retrying is safe only when no provider turn was admitted. Workspace query
  // marks this before launching the SDK; cleanup or post-send errors never do.
  if (!result.started && result.retryable) {
    sessionDraftsDb.restoreQueuedMessage(candidate);
    return;
  }
  sessionDraftsDb.deleteEmptyDraft(candidate.userId, candidate.sessionId);
  if (result.error) throw Object.assign(new Error(result.error), { code: result.code });
}

/** Scheduled dispatcher and tests claim idle-session queued turns once; tests may await completion. */
export async function dispatchQueuedMessages(runtime: ProviderRuntimeGateway, waitForCompletion = true): Promise<number> {
  const tasks: Promise<void>[] = [];
  for (const candidate of sessionDraftsDb.listQueuedMessages()) {
    if (sessionDispatches.has(candidate.sessionId) || isChatRunInFlight(candidate.sessionId)) continue;
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
  const tasks = due.map(row => enqueueSessionDispatch(row.session_id, () => sendClaimedMessage(row, runtime)));
  if (waitForCompletion) await Promise.all(tasks);
  return due.length;
}

/** Server startup catches up persisted schedules; completion events wake queues after actual handback. */
export function initializeScheduledMessageDispatcher(runtime: ProviderRuntimeGateway): void {
  if (pollTimer) return;
  const wake = () => {
    if (!pollTimer || wakeTimer) return;
    // Defer until detached dispatch bookkeeping has released its session entry.
    wakeTimer = setImmediate(() => { wakeTimer = null; poll(); });
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
  removeSettledListener = onChatRunSettled(wake);
  pollTimer = setInterval(poll, POLL_INTERVAL_MS);
  pollTimer.unref?.();
  poll();
}

/** Server shutdown removes polling and completion listeners without cancelling already admitted turns. */
export function closeScheduledMessageDispatcher(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  if (wakeTimer) clearImmediate(wakeTimer);
  wakeTimer = null;
  removeSettledListener?.();
  removeSettledListener = null;
  dispatchRequested = false;
}
