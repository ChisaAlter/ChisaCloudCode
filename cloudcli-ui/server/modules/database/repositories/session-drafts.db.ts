import { randomUUID } from 'node:crypto';

import { getConnection } from '@/modules/database/connection.js';

/**
 * One chat scope's unsent state: the text still in the composer, plus the
 * message queued behind an in-flight turn. Both are optional — a scope can
 * hold only a draft, only a queued message, or both.
 */
export type SessionDraftRecord = {
  scope: string;
  text: string;
  queuedMessage: unknown | null;
  updatedAt: string;
};

type DraftRow = {
  draft_scope: string;
  draft_text: string;
  queued_message: string | null;
  updated_at: string;
};

/** A server-owned queued turn together with the exact stored value used to claim it once. */
export type QueuedSessionMessageRecord = {
  userId: number;
  sessionId: string;
  queuedMessage: unknown;
  claimToken: string;
  /** Row revision observed when the dispatcher listed this queued turn. */
  revision?: string;
  /** Exact persisted envelope owned by this claim, set only after admission. */
  claimedToken?: string;
};

type QueuedMessageRow = {
  user_id: number;
  draft_scope: string;
  queued_message: string;
  updated_at: string;
};

/** A queued message that no longer parses is treated as absent, not fatal. */
function parseQueuedMessage(raw: string | null): unknown | null {
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function toRecord(row: DraftRow): SessionDraftRecord {
  return {
    scope: row.draft_scope,
    text: row.draft_text,
    queuedMessage: parseQueuedMessage(row.queued_message),
    updatedAt: row.updated_at,
  };
}

let lastDraftTimestampMs = 0;

function nextDraftTimestamp(previous?: string): string {
  // Preserve distinct revisions when a user clears and recreates a queue in
  // the same millisecond. Legacy SQLite timestamps are UTC without a suffix.
  const previousMs = previous ? Date.parse(previous.includes('T') ? previous : `${previous.replace(' ', 'T')}Z`) : 0;
  lastDraftTimestampMs = Math.max(Date.now(), lastDraftTimestampMs + 1, Number.isFinite(previousMs) ? previousMs + 1 : 0);
  return new Date(lastDraftTimestampMs).toISOString();
}

/** User, Scheduled Messages and WebSocket share persisted drafts and atomic queue ownership. */
export const sessionDraftsDb = {
  /**
   * Returns every draft the user has, newest first.
   *
   * The client pulls the whole set once per load: drafts are short strings, and
   * having them all up front means switching sessions restores a draft written
   * on another device without a round trip.
   */
  getDrafts(userId: number): SessionDraftRecord[] {
    const db = getConnection();
    const rows = db
      .prepare(
        `SELECT draft_scope, draft_text, queued_message, updated_at
         FROM session_drafts
         WHERE user_id = ?
         ORDER BY datetime(updated_at) DESC`
      )
      .all(userId) as DraftRow[];

    return rows.map(toRecord);
  },

  /** Lists persisted queued turns whose scopes are real chat sessions. */
  listQueuedMessages(): QueuedSessionMessageRecord[] {
    const rows = getConnection()
      .prepare(
        `SELECT drafts.user_id, drafts.draft_scope, drafts.queued_message, drafts.updated_at
         FROM session_drafts AS drafts
         INNER JOIN sessions ON sessions.session_id = drafts.draft_scope
         WHERE drafts.queued_message IS NOT NULL`
      )
      .all() as QueuedMessageRow[];

    return rows.map((row) => ({
      userId: row.user_id,
      sessionId: row.draft_scope,
      queuedMessage: parseQueuedMessage(row.queued_message),
      claimToken: row.queued_message,
      revision: row.updated_at,
    }));
  },

  /** Scheduled Messages reserves a queue without deleting its recoverable content, attachments or options. */
  claimQueuedMessage(candidate: QueuedSessionMessageRecord): boolean {
    const queuedMessage = parseQueuedMessage(candidate.claimToken);
    if (!queuedMessage || typeof queuedMessage !== 'object' || Array.isArray(queuedMessage)
      || (queuedMessage as Record<string, unknown>).autoSend === false) return false;
    const db = getConnection();
    return db.transaction(() => {
      const row = db.prepare(
        `SELECT updated_at FROM session_drafts
         WHERE user_id = ? AND draft_scope = ? AND queued_message = ?
           AND (? IS NULL OR updated_at = ?)`
      ).get(candidate.userId, candidate.sessionId, candidate.claimToken, candidate.revision ?? null, candidate.revision ?? null) as { updated_at: string } | undefined;
      if (!row) return false;
      // A crashed/failed owner leaves this envelope paused instead of losing
      // it or automatically repeating a turn the provider may have received.
      const claimedToken = JSON.stringify({ ...queuedMessage, autoSend: false, claimRevision: randomUUID() });
      const result = db.prepare(
        `UPDATE session_drafts
         SET queued_message = ?, updated_at = ?
         WHERE user_id = ? AND draft_scope = ? AND queued_message = ?`
      )
        .run(claimedToken, nextDraftTimestamp(row.updated_at), candidate.userId, candidate.sessionId, candidate.claimToken);
      if (result.changes > 0) candidate.claimedToken = claimedToken;
      return result.changes > 0;
    })();
  },

  /** Scheduled Messages releases a busy claim without overwriting later queue edits or clears. */
  restoreQueuedMessage(candidate: QueuedSessionMessageRecord): void {
    if (!candidate.claimedToken) return;
    getConnection()
      .prepare(
        `UPDATE session_drafts
         SET queued_message = ?, updated_at = ?
         WHERE user_id = ? AND draft_scope = ? AND queued_message = ?`
      )
      .run(candidate.claimToken, nextDraftTimestamp(), candidate.userId, candidate.sessionId, candidate.claimedToken);
  },

  /** Scheduled Messages clears a successful claim, preserving subsequent composer text or queues. */
  completeQueuedMessage(candidate: QueuedSessionMessageRecord): void {
    if (!candidate.claimedToken) return;
    getConnection().prepare(
      `UPDATE session_drafts SET queued_message = NULL, updated_at = ?
       WHERE user_id = ? AND draft_scope = ? AND queued_message = ?`
    ).run(nextDraftTimestamp(), candidate.userId, candidate.sessionId, candidate.claimedToken);
    this.deleteEmptyDraft(candidate.userId, candidate.sessionId);
  },

  /** The dispatcher releases a failed claim as the same payload, paused for manual sending. */
  pauseClaimedQueuedMessage(candidate: QueuedSessionMessageRecord): void {
    if (!candidate.claimedToken || !candidate.queuedMessage || typeof candidate.queuedMessage !== 'object'
      || Array.isArray(candidate.queuedMessage)) return;
    const pausedMessage: Record<string, unknown> = { ...candidate.queuedMessage as Record<string, unknown>, autoSend: false };
    delete pausedMessage.claimRevision;
    getConnection().prepare(
      `UPDATE session_drafts SET queued_message = ?, updated_at = ?
       WHERE user_id = ? AND draft_scope = ? AND queued_message = ?`
    ).run(JSON.stringify(pausedMessage), nextDraftTimestamp(), candidate.userId, candidate.sessionId, candidate.claimedToken);
  },

  /** WebSocket failures and stops preserve a following queue for an explicit manual send. */
  pauseQueuedMessage(userId: number, scope: string): void {
    const db = getConnection();
    db.transaction(() => {
      const row = db.prepare(
        'SELECT queued_message, updated_at FROM session_drafts WHERE user_id = ? AND draft_scope = ?'
      ).get(userId, scope) as { queued_message: string | null; updated_at: string } | undefined;
      const queuedMessage = parseQueuedMessage(row?.queued_message ?? null);
      if (!queuedMessage || typeof queuedMessage !== 'object' || Array.isArray(queuedMessage)) return;
      const pausedMessage: Record<string, unknown> = { ...queuedMessage as Record<string, unknown>, autoSend: false };
      delete pausedMessage.claimRevision;
      if (JSON.stringify(pausedMessage) === row!.queued_message) return;
      db.prepare(
        `UPDATE session_drafts SET queued_message = ?, updated_at = ?
         WHERE user_id = ? AND draft_scope = ? AND queued_message = ?`
      ).run(JSON.stringify(pausedMessage), nextDraftTimestamp(row!.updated_at), userId, scope, row!.queued_message);
    })();
  },

  /** Removes a draft only after both its composer text and queued turn are gone. */
  deleteEmptyDraft(userId: number, scope: string): void {
    getConnection()
      .prepare(
        `DELETE FROM session_drafts
         WHERE user_id = ? AND draft_scope = ? AND draft_text = '' AND queued_message IS NULL`
      )
      .run(userId, scope);
  },

  /**
   * Writes one scope's draft, or deletes the row when nothing is left to keep.
   *
   * Deleting on empty is what stops the table growing a permanent row for every
   * session the user ever opened and typed a character into.
   */
  saveDraft(
    userId: number,
    scope: string,
    draft: { text: string; queuedMessage?: unknown | null }
  ): void {
    const db = getConnection();
    const updatesQueue = Object.prototype.hasOwnProperty.call(draft, 'queuedMessage');
    db.transaction(() => {
      const row = db.prepare(
        'SELECT updated_at FROM session_drafts WHERE user_id = ? AND draft_scope = ?'
      ).get(userId, scope) as { updated_at: string } | undefined;
      db.prepare(
        `INSERT INTO session_drafts (user_id, draft_scope, draft_text, queued_message, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, draft_scope) DO UPDATE SET
           draft_text = excluded.draft_text,
           queued_message = CASE WHEN ? THEN excluded.queued_message ELSE session_drafts.queued_message END,
           updated_at = excluded.updated_at`
      ).run(
        userId,
        scope,
        draft.text,
        draft.queuedMessage == null ? null : JSON.stringify(draft.queuedMessage),
        nextDraftTimestamp(row?.updated_at),
        updatesQueue ? 1 : 0,
      );
      this.deleteEmptyDraft(userId, scope);
    })();
  },

  deleteDraft(userId: number, scope: string): void {
    const db = getConnection();
    db.prepare('DELETE FROM session_drafts WHERE user_id = ? AND draft_scope = ?')
      .run(userId, scope);
  },
};
