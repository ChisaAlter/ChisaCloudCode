import { AsyncLocalStorage } from 'node:async_hooks';

import { scheduledMessagesDb, sessionDraftsDb } from '@/modules/database/index.js';
import type { QueuedSessionMessageRecord, ScheduledMessageRow } from '@/modules/database/index.js';
import { chatRunRegistry, runDetachedChatTurn } from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';

/**
 * How often due messages are looked for.
 *
 * A minute is the granularity the composer offers, and a claim is indexed on
 * `(status, scheduled_for)`, so the poll is one cheap query. Anything finer
 * would buy precision nobody asked for.
 */
const POLL_INTERVAL_MS = 30_000;

let pollTimer: ReturnType<typeof setInterval> | null = null;
let dispatchInFlight = false;
let dispatcherRuntime: ProviderRuntimeGateway | null = null;
let dispatcherScope: ReturnType<typeof AsyncLocalStorage.snapshot> | null = null;

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
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const content = typeof record.content === 'string' ? record.content : '';
  const attachments = Array.isArray(record.attachments)
    ? record.attachments
    : Array.isArray(record.images)
      ? record.images
      : [];
  if (!content.trim() && attachments.length === 0) {
    return null;
  }
  const options = record.options && typeof record.options === 'object' && !Array.isArray(record.options)
    ? record.options as Record<string, unknown>
    : {};
  return { content, options, attachments, autoSend: record.autoSend !== false };
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
  if (!result.started && result.reason === 'busy') {
    sessionDraftsDb.restoreQueuedMessage(candidate);
    return;
  }
  if (!result.started || result.error) {
    sessionDraftsDb.pauseClaimedQueuedMessage(candidate);
    return;
  }
  sessionDraftsDb.completeQueuedMessage(candidate);
  // A wake while this session was running could not claim its next turn.
  // Read the fresh envelope only after the current owner has settled.
  const next = sessionDraftsDb.listQueuedMessages().find(row => row.userId === candidate.userId && row.sessionId === candidate.sessionId);
  if (next) await dispatchQueuedCandidate(next, runtime);
}

async function dispatchQueuedCandidate(candidate: QueuedSessionMessageRecord, runtime: ProviderRuntimeGateway): Promise<boolean> {
  if (readQueuedMessage(candidate.queuedMessage)?.autoSend === false || chatRunRegistry.isProcessing(candidate.sessionId)) return false;
  if (!sessionDraftsDb.claimQueuedMessage(candidate)) return false;
  await sendClaimedQueuedMessage(candidate, runtime);
  return true;
}

/** Sends every persisted queued turn whose session is currently idle. */
export async function dispatchQueuedMessages(runtime: ProviderRuntimeGateway): Promise<number> {
  const candidates = sessionDraftsDb.listQueuedMessages();
  const results = await Promise.all(candidates.map(candidate => dispatchQueuedCandidate(candidate, runtime)));
  return results.filter(Boolean).length;
}

async function sendClaimedMessage(
  row: ScheduledMessageRow,
  runtime: ProviderRuntimeGateway,
): Promise<void> {
  try {
    const result = await runDetachedChatTurn(
      {
        sessionId: row.session_id,
        userId: row.user_id,
        content: row.content,
        options: readOptions(row.options),
        // The user picked this time on purpose; a run that happens to be going
        // is aborted so the scheduled message lands when it was due, instead
        // of being recorded as "not sent — session was busy".
        interruptActiveRun: true,
      },
      { runtime },
    );

    // Recorded rather than retried, and recorded whether the run never started
    // (deleted session, unavailable provider) or started and then failed.
    // Silently dropping a message the user scheduled is worse than telling
    // them it did not go.
    if (!result.started || result.error) {
      scheduledMessagesDb.markFailed(row.id, result.error ?? 'The session was unavailable when this was due.');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    scheduledMessagesDb.markFailed(row.id, message);
  }
}

/**
 * Sends every message whose time has come.
 *
 * Exported so a test can drive one pass without waiting on the timer.
 */
export async function dispatchDueScheduledMessages(
  runtime: ProviderRuntimeGateway,
  now: Date = new Date(),
): Promise<number> {
  // Claimed before any of them runs, so a long turn cannot let the next poll
  // pick the same message up again.
  const due = scheduledMessagesDb.claimDue(now);
  if (due.length === 0) {
    return 0;
  }

  // Sequentially: a session can only have one run at a time, and two due
  // messages for the same session must not race each other into it.
  for (const row of due) {
    await sendClaimedMessage(row, runtime);
  }

  return due.length;
}

function startDispatchPass(runtime: ProviderRuntimeGateway): void {
  if (dispatchInFlight) return;
  dispatchInFlight = true;
  void dispatchDueScheduledMessages(runtime)
    .then(() => dispatchQueuedMessages(runtime))
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ScheduledMessages] Dispatch pass failed', { error: message });
    })
    .finally(() => {
      dispatchInFlight = false;
    });
}

/** The User draft-save adapter wakes persisted queued sends without waiting for a model turn. */
export function wakeQueuedMessageDispatcher(): void {
  if (dispatcherRuntime && dispatcherScope) {
    const runtime = dispatcherRuntime;
    // Draft-save is an HTTP operation; the queued turn keeps the startup
    // background scope instead of inheriting that request's cancellation.
    // DB claims and the run registry serialize each session. An explicit
    // send in another idle session must not wait for a long-running turn.
    dispatcherScope(() => {
      void dispatchQueuedMessages(runtime).catch((error: unknown) => {
        console.error('[ScheduledMessages] Queued dispatch failed', { error: error instanceof Error ? error.message : String(error) });
      });
    });
  }
}

/**
 * Starts the poll that sends scheduled messages.
 *
 * The schedule lives in the database, so a message stays scheduled across a
 * restart and one that came due while the server was down is sent on the first
 * poll after it comes back, rather than being skipped.
 */
export function initializeScheduledMessageDispatcher(runtime: ProviderRuntimeGateway): void {
  if (pollTimer) {
    return;
  }

  dispatcherRuntime = runtime;
  dispatcherScope = AsyncLocalStorage.snapshot();
  const poll = () => dispatcherScope?.(() => startDispatchPass(runtime));

  pollTimer = setInterval(poll, POLL_INTERVAL_MS);
  // Never keep the process alive just to poll for scheduled messages.
  pollTimer.unref?.();

  // Catch up on anything that came due while the server was not running.
  poll();
}

export function closeScheduledMessageDispatcher(): void {
  dispatcherRuntime = null;
  dispatcherScope = null;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
