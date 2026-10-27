import { api } from '@/shared/api';
import { getAuthSessionVersion } from '@/shared/authToken';
import type { QueuedSendOptions } from '@/shared/types';

/**
 * Unsent composer text and queued messages, stored in `auth.db` rather than in
 * the browser.
 *
 * This is what lets a message half-typed on a laptop be finished on a phone —
 * the case the composer previously could not serve at all, because a draft only
 * existed on the machine it was typed on. As with the preference store, a
 * localStorage mirror is kept purely so a reload shows the draft on the first
 * paint instead of a blank composer that fills in a moment later.
 *
 * A scope is a session id, or `project:<projectId>` for a chat that has not
 * been sent yet and so has no session. Drafts used to be keyed by project
 * alone, which meant every session in a project shared one draft.
 */

/** A queued message as it is stored: text plus the send options it was composed under. */
export type StoredQueuedMessage = {
  content: string;
  options?: QueuedSendOptions;
  /** Legacy image-only descriptors retained for queued draft compatibility. */
  images?: unknown[];
  /**
   * JSON-safe descriptors returned by POST /api/assets/files. Unlike browser
   * File objects, they can follow a queued message across session switches.
   */
  attachments?: unknown[];
};

type DraftRecord = {
  text: string;
  queuedMessage: StoredQueuedMessage | null;
};

/** Fired after any draft changes, from a local write or from a hydrate. */
export const CHAT_DRAFTS_CHANGED_EVENT = 'chat-drafts:changed';

const MIRROR_STORAGE_KEY = 'chat-drafts';

/**
 * Longer than the preference debounce: this fires on every keystroke, and a
 * draft is only ever read back on a reload or a device switch, so trading a
 * little latency for far fewer requests is the right side of the trade.
 */
const SERVER_WRITE_DEBOUNCE_MS = 1_000;

const EMPTY_DRAFT: DraftRecord = { text: '', queuedMessage: null };

const listeners = new Set<() => void>();

let drafts = new Map<string, DraftRecord>();
// Hydration compares these local revisions with the snapshot at GET start.
const scopeVersions = new Map<string, number>();
// Text and queue acknowledgements are independent: typing must not retry a queue action.
const pendingTextVersions = new Map<string, number>();
const pendingQueueVersions = new Map<string, number>();
// Only new text edits schedule a debounce; a failure alone never schedules a retry.
const scheduledScopes = new Set<string>();
// Each scope's next HTTP write waits for its predecessor, including failed writes.
const writers = new Map<string, Promise<void>>();
// Identical queue calls share their acknowledgement instead of enqueueing twice.
const queuedWrites = new Map<string, Promise<void>>();
// Logout invalidates delayed work even if its HTTP response arrives later.
let storeGeneration = 0;
// Identity replacement invalidates work; ordinary token refresh does not.
let draftSessionVersion = getAuthSessionVersion();
// Explicit resets also reject acknowledgement waiters whose HTTP call is still pending.
let writerController = new AbortController();
// Only the newest server snapshot can replace the cache.
let hydrateGeneration = 0;
let serverWriteTimer: ReturnType<typeof setTimeout> | null = null;

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const isEmptyDraft = (draft: DraftRecord): boolean => (
  draft.text === '' && draft.queuedMessage === null
);

const sameQueuedMessage = (left: StoredQueuedMessage | null, right: StoredQueuedMessage | null): boolean => (
  left === right || JSON.stringify(left) === JSON.stringify(right)
);

function readMirror(): Map<string, DraftRecord> {
  try {
    const raw = localStorage.getItem(MIRROR_STORAGE_KEY);
    if (!raw) {
      return new Map();
    }

    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return new Map();
    }

    const restored = new Map<string, DraftRecord>();
    for (const [scope, value] of Object.entries(parsed)) {
      if (!isRecord(value)) {
        continue;
      }
      restored.set(scope, {
        text: typeof value.text === 'string' ? value.text : '',
        queuedMessage: isRecord(value.queuedMessage)
          ? (value.queuedMessage as StoredQueuedMessage)
          : null,
      });
    }
    return restored;
  } catch {
    return new Map();
  }
}

function writeMirror(): void {
  try {
    localStorage.setItem(MIRROR_STORAGE_KEY, JSON.stringify(Object.fromEntries(drafts)));
  } catch {
    // A full localStorage costs the first-paint restore, not the draft: the
    // server copy is authoritative and arrives on hydrate.
  }
}

function notifyListeners(): void {
  for (const listener of listeners) {
    listener();
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(CHAT_DRAFTS_CHANGED_EVENT));
  }
}

function ensureDraftSession(): void {
  if (draftSessionVersion !== getAuthSessionVersion()) {
    resetChatDrafts();
  }
}

function persistDraft(scope: string, draft: DraftRecord, textVersion: number, queueVersion?: number): Promise<void> {
  const generation = storeGeneration;
  const sessionVersion = draftSessionVersion;
  const signal = writerController.signal;
  const assertCurrent = () => {
    if (signal.aborted || generation !== storeGeneration || sessionVersion !== getAuthSessionVersion()) {
      throw new DOMException('Chat draft session changed', 'AbortError');
    }
  };
  const predecessor = writers.get(scope) ?? Promise.resolve();
  const writing = predecessor.catch(() => undefined).then(async () => {
    assertCurrent();
    const response = queueVersion !== undefined && isEmptyDraft(draft)
      ? await api.user.deleteDraft(scope)
      : await api.user.saveDraft(scope, {
        text: draft.text,
        // A text-only save must not restore a queue the dispatcher already claimed.
        ...(queueVersion === undefined ? {} : { queuedMessage: draft.queuedMessage }),
      });
    assertCurrent();
    if (!response.ok) {
      let message = `Chat draft write was not confirmed (${response.status})`;
      try {
        const payload = await response.json();
        const detail = payload?.error;
        message = (typeof detail === 'string' ? detail : detail?.message) || payload?.message || message;
      } catch {
        // Keep the HTTP status when the server did not return a JSON error.
      }
      throw new Error(message);
    }

    // An older acknowledgement cannot mark a later local edit as persisted.
    if (pendingTextVersions.get(scope) === textVersion) pendingTextVersions.delete(scope);
    if (queueVersion !== undefined && pendingQueueVersions.get(scope) === queueVersion) pendingQueueVersions.delete(scope);
  });
  writers.set(scope, writing);

  // Cancellation rejects callers promptly; the underlying write still owns its
  // place in the old session's chain until it settles and cannot update the cache.
  return new Promise<void>((resolve, reject) => {
    const cancel = () => reject(new DOMException('Chat draft session changed', 'AbortError'));
    signal.addEventListener('abort', cancel, { once: true });
    const finish = () => {
      signal.removeEventListener('abort', cancel);
      if (writers.get(scope) === writing) writers.delete(scope);
    };
    void writing.then(() => {
      finish();
      resolve();
    }, (error: unknown) => {
      finish();
      reject(error);
    });
  });
}

function flushServerWrites(): void {
  serverWriteTimer = null;
  if (draftSessionVersion !== getAuthSessionVersion()) {
    resetChatDrafts();
    return;
  }
  const scopes = [...scheduledScopes];
  scheduledScopes.clear();
  for (const scope of scopes) {
    const version = pendingTextVersions.get(scope);
    if (version === undefined) continue;
    const generation = storeGeneration;
    void persistDraft(scope, drafts.get(scope) ?? EMPTY_DRAFT, version).catch((error: unknown) => {
      if (generation === storeGeneration) console.error('Chat draft write was not confirmed:', error);
    });
  }
}

function queueServerWrite(scope: string): void {
  scheduledScopes.add(scope);
  if (serverWriteTimer !== null) clearTimeout(serverWriteTimer);
  serverWriteTimer = setTimeout(flushServerWrites, SERVER_WRITE_DEBOUNCE_MS);
}

function updateDraft(scope: string, update: Partial<DraftRecord>, queueAction = false): DraftRecord {
  ensureDraftSession();
  const current = drafts.get(scope) ?? EMPTY_DRAFT;
  const next: DraftRecord = { ...current, ...update };
  const textChanged = next.text !== current.text;
  const queueChanged = !sameQueuedMessage(next.queuedMessage, current.queuedMessage);

  if (!textChanged && !queueChanged && !queueAction) {
    return current;
  }

  const version = (scopeVersions.get(scope) ?? 0) + 1;
  scopeVersions.set(scope, version);
  if (textChanged) pendingTextVersions.set(scope, version);
  if (queueChanged || queueAction) pendingQueueVersions.set(scope, version);
  const nextDrafts = new Map(drafts);
  if (isEmptyDraft(next)) {
    nextDrafts.delete(scope);
  } else {
    nextDrafts.set(scope, next);
  }
  drafts = nextDrafts;

  writeMirror();
  if (textChanged) queueServerWrite(scope);
  notifyListeners();
  return next;
}

function persistQueuedMessage(scope: string, queuedMessage: StoredQueuedMessage | null): Promise<void> {
  ensureDraftSession();
  if (sameQueuedMessage(drafts.get(scope)?.queuedMessage ?? null, queuedMessage)) {
    const existing = queuedWrites.get(scope);
    if (existing) return existing;
  }
  const draft = updateDraft(scope, { queuedMessage }, true);
  const promise = persistDraft(scope, draft, pendingTextVersions.get(scope) ?? 0, pendingQueueVersions.get(scope));
  queuedWrites.set(scope, promise);
  // Only concurrent identical actions share a ticket; a later explicit action
  // needs its own acknowledgement, even if its contents match an earlier queue.
  const clearTicket = () => {
    if (queuedWrites.get(scope) === promise) queuedWrites.delete(scope);
  };
  void promise.then(clearTicket, clearTicket);
  return promise;
}

/** Reads one scope's composer text, synchronously, for the first render. */
export function readDraftText(scope: string): string {
  return drafts.get(scope)?.text ?? '';
}

export function writeDraftText(scope: string, text: string): void {
  updateDraft(scope, { text });
}

export function readQueuedMessage(scope: string): StoredQueuedMessage | null {
  const queued = drafts.get(scope)?.queuedMessage ?? null;
  if (!queued) {
    return null;
  }

  const attachments = Array.isArray(queued.attachments)
    ? queued.attachments
    : Array.isArray(queued.images)
      ? queued.images
      : [];

  // A queued message with neither text nor attachments has nothing to send.
  return queued.content.trim() || attachments.length > 0
    ? { ...queued, attachments }
    : null;
}

/** Queueing callers await the server acknowledgement before clearing the composer. */
export function writeQueuedMessage(scope: string, message: StoredQueuedMessage): Promise<void> {
  return persistQueuedMessage(scope, message);
}

/** Editing/cancelling callers await persistence before removing the queued card. */
export function clearQueuedMessage(scope: string): Promise<void> {
  return persistQueuedMessage(scope, null);
}

/** Composer reconciliation must not mistake an unconfirmed local clear for a server claim. */
export function isChatDraftPending(scope: string): boolean {
  return pendingTextVersions.has(scope) || pendingQueueVersions.has(scope) || writers.has(scope);
}

/** Subscribes to any draft change; returns the unsubscribe function. */
export function subscribeToChatDrafts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Loads the server's drafts and adopts them as the source of truth.
 *
 * Unconfirmed writes and changes made after GET started win over its snapshot,
 * even when those newer changes have already been acknowledged by the server.
 */
export async function hydrateChatDrafts(): Promise<void> {
  ensureDraftSession();
  const generation = storeGeneration;
  const sessionVersion = draftSessionVersion;
  const hydration = ++hydrateGeneration;
  const versionsAtStart = new Map(scopeVersions);
  const protectedScopes = new Set([...pendingTextVersions.keys(), ...pendingQueueVersions.keys(), ...writers.keys()]);
  const current = () => generation === storeGeneration && sessionVersion === getAuthSessionVersion() && hydration === hydrateGeneration;
  let serverDrafts: Array<{ scope?: unknown; text?: unknown; queuedMessage?: unknown }> = [];

  try {
    const response = await api.user.drafts();
    if (!response.ok) {
      return;
    }

    const payload = (await response.json()) as { drafts?: unknown };
    if (!Array.isArray(payload.drafts)) {
      return;
    }
    serverDrafts = payload.drafts as typeof serverDrafts;
  } catch (error) {
    // Keep the mirror: an offline load must still show what was typed here.
    if (current()) console.error('Failed to load chat drafts:', error);
    return;
  }
  if (!current()) return;

  for (const scope of [...pendingTextVersions.keys(), ...pendingQueueVersions.keys(), ...writers.keys()]) protectedScopes.add(scope);
  for (const [scope, version] of scopeVersions) {
    if (version !== versionsAtStart.get(scope)) protectedScopes.add(scope);
  }

  const merged = new Map<string, DraftRecord>();
  for (const draft of serverDrafts) {
    const scope = typeof draft.scope === 'string' ? draft.scope : '';
    if (!scope || protectedScopes.has(scope)) {
      continue;
    }

    merged.set(scope, {
      text: typeof draft.text === 'string' ? draft.text : '',
      queuedMessage: isRecord(draft.queuedMessage)
        ? (draft.queuedMessage as StoredQueuedMessage)
        : null,
    });
  }

  // Missing protected records are local deletions and must not be resurrected.
  for (const scope of protectedScopes) {
    const pending = drafts.get(scope);
    if (pending) {
      merged.set(scope, pending);
    }
  }
  drafts = merged;
  writeMirror();
  notifyListeners();
}

/** Drops every cached draft on sign-out, so the next user sees none of them. */
export function resetChatDrafts(): void {
  storeGeneration += 1;
  hydrateGeneration += 1;
  draftSessionVersion = getAuthSessionVersion();
  writerController.abort();
  writerController = new AbortController();
  drafts = new Map();
  scopeVersions.clear();
  pendingTextVersions.clear();
  pendingQueueVersions.clear();
  scheduledScopes.clear();
  writers.clear();
  queuedWrites.clear();
  if (serverWriteTimer !== null) {
    clearTimeout(serverWriteTimer);
    serverWriteTimer = null;
  }
  try {
    localStorage.removeItem(MIRROR_STORAGE_KEY);
  } catch {
    // The in-memory copy is already cleared, which is what readers use.
  }
  notifyListeners();
}

// Read at module load rather than on first use, because the composer's initial
// input value is a `useState` initializer that runs before any effect.
if (typeof localStorage !== 'undefined') {
  drafts = readMirror();
}
