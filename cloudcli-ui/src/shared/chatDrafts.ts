import { api, ApiRequestError, readApiErrorMessage } from '@/shared/api';
import { getAuthSessionVersion } from '@/shared/authToken';
import type { QueuedSendOptions } from '@/shared/types';

/** Unsent text is mirrored locally; queued turns are appended and claimed atomically by the server. */
type StoredQueuedMessage = {
  content: string;
  options?: QueuedSendOptions;
  images?: unknown[];
  attachments?: unknown[];
};

type DraftRecord = {
  text: string;
  queuedMessage: StoredQueuedMessage | null;
};

/** Notifies the composer and sidebar when local edits or server hydration change drafts. */
export const CHAT_DRAFTS_CHANGED_EVENT = 'chat-drafts:changed';
const MIRROR_STORAGE_KEY = 'chat-drafts';
const SERVER_WRITE_DEBOUNCE_MS = 1_000;
const EMPTY_DRAFT: DraftRecord = { text: '', queuedMessage: null };
const listeners = new Set<() => void>();

// The account-scoped mirror supplies synchronous first-paint composer text and queued cards.
let drafts = new Map<string, DraftRecord>();
// Text revisions protect edits made after a hydrate started, including acknowledged deletions.
const textRevisions = new Map<string, number>();
// Failed or in-flight text writes remain protected until a later explicit edit is acknowledged.
const pendingTextVersions = new Map<string, number>();
const scheduledScopes = new Set<string>();
const textWriters = new Map<string, Promise<void>>();
// Queue mutations have their own revisions: typing must still learn when the dispatcher claims a queue.
const queueRevisions = new Map<string, number>();
const pendingQueueVersions = new Map<string, number>();
const queueRequests = new Map<string, Promise<void>>();
const queueClears = new Map<string, Promise<boolean>>();
// A reset or account replacement invalidates queued successors and any late HTTP acknowledgement.
let storeGeneration = 0;
let draftSessionVersion = getAuthSessionVersion();
let writerController = new AbortController();
let hydrateGeneration = 0;
let serverWriteTimer: ReturnType<typeof setTimeout> | null = null;

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);
const isEmptyDraft = (draft: DraftRecord): boolean => draft.text === '' && draft.queuedMessage === null;

function readMirror(): Map<string, DraftRecord> {
  try {
    const raw = localStorage.getItem(MIRROR_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!isRecord(parsed)) return new Map();
    const restored = new Map<string, DraftRecord>();
    for (const [scope, value] of Object.entries(parsed)) {
      if (!isRecord(value)) continue;
      restored.set(scope, {
        text: typeof value.text === 'string' ? value.text : '',
        queuedMessage: isRecord(value.queuedMessage) ? value.queuedMessage as StoredQueuedMessage : null,
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
    // Losing the first-paint mirror must not discard the in-memory or server draft.
  }
}

function notifyListeners(): void {
  for (const listener of listeners) listener();
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CHAT_DRAFTS_CHANGED_EVENT));
}

function ensureDraftSession(): void {
  if (draftSessionVersion !== getAuthSessionVersion()) resetChatDrafts();
}

function captureWriter() {
  const generation = storeGeneration;
  const sessionVersion = draftSessionVersion;
  const signal = writerController.signal;
  const assertCurrent = () => {
    if (signal.aborted || generation !== storeGeneration || sessionVersion !== getAuthSessionVersion()) {
      throw new DOMException('Chat draft session changed', 'AbortError');
    }
  };
  return { assertCurrent, signal };
}

function awaitWriter<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(new DOMException('Chat draft session changed', 'AbortError'));
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    void operation.then(value => {
      signal.removeEventListener('abort', cancel);
      resolve(value);
    }, error => {
      signal.removeEventListener('abort', cancel);
      reject(error);
    });
  });
}

function setLocalDraft(scope: string, update: Partial<DraftRecord>): boolean {
  const current = drafts.get(scope) ?? EMPTY_DRAFT;
  const next = { ...current, ...update };
  if (next.text === current.text && JSON.stringify(next.queuedMessage) === JSON.stringify(current.queuedMessage)) return false;
  const updated = new Map(drafts);
  if (isEmptyDraft(next)) updated.delete(scope);
  else updated.set(scope, next);
  drafts = updated;
  writeMirror();
  notifyListeners();
  return true;
}

function persistText(scope: string, text: string, version: number): Promise<void> {
  const { assertCurrent, signal } = captureWriter();
  const previous = textWriters.get(scope) ?? Promise.resolve();
  const writing = previous.catch(() => undefined).then(async () => {
    assertCurrent();
    // Never send the cached queue or delete the row: another page may have queued a turn.
    const response = await api.user.saveDraft(scope, { text });
    assertCurrent();
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      throw new Error(readApiErrorMessage(body) ?? `Chat draft write was not confirmed (${response.status})`);
    }
    if (pendingTextVersions.get(scope) === version) pendingTextVersions.delete(scope);
  });
  textWriters.set(scope, writing);
  const finish = () => { if (textWriters.get(scope) === writing) textWriters.delete(scope); };
  void writing.then(finish, finish);
  return awaitWriter(writing, signal);
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
    void persistText(scope, drafts.get(scope)?.text ?? '', version).catch((error: unknown) => {
      if (generation === storeGeneration) console.error('Chat draft write was not confirmed:', error);
    });
  }
}

/** Reads the account's current draft synchronously for the composer's first render. */
export function readDraftText(scope: string): string {
  ensureDraftSession();
  return drafts.get(scope)?.text ?? '';
}

/** Debounces text-only persistence without changing the server-owned queued turn. */
export function writeDraftText(scope: string, text: string): void {
  ensureDraftSession();
  if ((drafts.get(scope)?.text ?? '') === text) return;
  const revision = (textRevisions.get(scope) ?? 0) + 1;
  textRevisions.set(scope, revision);
  pendingTextVersions.set(scope, revision);
  setLocalDraft(scope, { text });
  scheduledScopes.add(scope);
  if (serverWriteTimer !== null) clearTimeout(serverWriteTimer);
  serverWriteTimer = setTimeout(flushServerWrites, SERVER_WRITE_DEBOUNCE_MS);
}

function normalizeQueuedMessage(queued: StoredQueuedMessage | null): StoredQueuedMessage | null {
  if (!queued || typeof queued.content !== 'string') return null;
  const attachments = Array.isArray(queued.attachments) ? queued.attachments : Array.isArray(queued.images) ? queued.images : [];
  return queued.content.trim() || attachments.length ? { ...queued, attachments } : null;
}

/** Reads durable attachment descriptors; legacy image-only drafts remain compatible. */
export function readQueuedMessage(scope: string): StoredQueuedMessage | null {
  ensureDraftSession();
  return normalizeQueuedMessage(drafts.get(scope)?.queuedMessage ?? null);
}

function noteQueueChanged(scope: string): number {
  const revision = (queueRevisions.get(scope) ?? 0) + 1;
  queueRevisions.set(scope, revision);
  return revision;
}

function sendQueueRequest<T>(scope: string, send: () => Promise<T>): Promise<T> {
  const { assertCurrent, signal } = captureWriter();
  const sendCurrent = async () => {
    assertCurrent();
    const result = await send();
    assertCurrent();
    return result;
  };
  const previous = queueRequests.get(scope);
  const request = previous ? previous.then(sendCurrent) : sendCurrent();
  const settled = request.then(() => undefined, () => undefined);
  queueRequests.set(scope, settled);
  void settled.then(() => { if (queueRequests.get(scope) === settled) queueRequests.delete(scope); });
  return awaitWriter(request, signal);
}

/** Appends against the server's current queue so follow-ups cannot overwrite another tab or replay a claimed turn. */
export async function appendQueuedMessage(scope: string, message: StoredQueuedMessage): Promise<{ queuedMessage: StoredQueuedMessage; appended: boolean }> {
  ensureDraftSession();
  const { assertCurrent } = captureWriter();
  for (;;) {
    const result = await sendQueueRequest(scope, async () => {
      const revisionAtRequest = queueRevisions.get(scope) ?? 0;
      const response = await api.user.appendQueuedMessage(scope, message);
      assertCurrent();
      const payload: unknown = await response.json().catch(() => null);
      assertCurrent();
      const body = isRecord(payload) ? payload : null;
      if (!response.ok) {
        const code = isRecord(body?.error) ? body.error.code : undefined;
        throw new ApiRequestError(readApiErrorMessage(body) ?? `HTTP ${response.status}`, {
          code: typeof code === 'string' ? code : undefined,
          status: response.status,
        });
      }
      const queuedMessage = normalizeQueuedMessage(isRecord(body?.queuedMessage) ? body.queuedMessage as StoredQueuedMessage : null);
      if (!queuedMessage) throw new Error('The server returned no queued message');
      return { queuedMessage, appended: body?.appended === true, clearedMeanwhile: (queueRevisions.get(scope) ?? 0) !== revisionAtRequest };
    });
    assertCurrent();
    // A successful clear after this append also removed its new text; retry behind that clear.
    if (result.clearedMeanwhile && await queueClears.get(scope)) {
      assertCurrent();
      continue;
    }
    assertCurrent();
    noteQueueChanged(scope);
    pendingQueueVersions.delete(scope);
    setLocalDraft(scope, { queuedMessage: result.queuedMessage });
    return { queuedMessage: result.queuedMessage, appended: result.appended };
  }
}

/** Clears only the queued turn; callers await acknowledgement before editing or dismissing its card. */
export function clearQueuedMessage(scope: string): Promise<void> {
  ensureDraftSession();
  const { assertCurrent } = captureWriter();
  const revision = noteQueueChanged(scope);
  pendingQueueVersions.set(scope, revision);
  setLocalDraft(scope, { queuedMessage: null });
  const request = sendQueueRequest(scope, async () => {
    const response = await api.user.clearQueuedMessage(scope);
    assertCurrent();
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      assertCurrent();
      throw new Error(readApiErrorMessage(body) ?? `Queue cancellation was not confirmed (${response.status})`);
    }
    if (pendingQueueVersions.get(scope) === revision) pendingQueueVersions.delete(scope);
  });
  // Also serve fire-and-forget callers without an unhandled rejection, while preserving rejection for awaiters.
  queueClears.set(scope, request.then(() => true, (error: unknown) => {
    if (!(error instanceof DOMException && error.name === 'AbortError')) console.error('Failed to clear queued chat message:', error);
    return false;
  }));
  return request;
}

/** Prevents composer reconciliation from treating an unconfirmed local change as a dispatcher claim. */
export function isChatDraftPending(scope: string): boolean {
  ensureDraftSession();
  return pendingTextVersions.has(scope) || pendingQueueVersions.has(scope) || textWriters.has(scope) || queueRequests.has(scope);
}

/** Subscribes the composer and sidebar to account-scoped draft changes. */
export function subscribeToChatDrafts(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Adopts the latest server snapshot, protecting newer local text and queue mutations independently. */
export async function hydrateChatDrafts(): Promise<void> {
  ensureDraftSession();
  const generation = storeGeneration;
  const sessionVersion = draftSessionVersion;
  const hydration = ++hydrateGeneration;
  const textAtStart = new Map(textRevisions);
  const queuesAtStart = new Map(queueRevisions);
  const protectedText = new Set([...pendingTextVersions.keys(), ...textWriters.keys()]);
  const protectedQueues = new Set([...pendingQueueVersions.keys(), ...queueRequests.keys()]);
  const current = () => generation === storeGeneration && sessionVersion === getAuthSessionVersion() && hydration === hydrateGeneration;
  let serverDrafts: unknown[];
  try {
    const response = await api.user.drafts();
    if (!response.ok) return;
    const payload = await response.json();
    if (!Array.isArray(payload.drafts)) return;
    serverDrafts = payload.drafts;
  } catch (error) {
    if (current()) console.error('Failed to load chat drafts:', error);
    return;
  }
  if (!current()) return;
  for (const scope of [...pendingTextVersions.keys(), ...textWriters.keys()]) protectedText.add(scope);
  for (const [scope, revision] of textRevisions) if (revision !== textAtStart.get(scope)) protectedText.add(scope);
  for (const scope of [...pendingQueueVersions.keys(), ...queueRequests.keys()]) protectedQueues.add(scope);
  for (const [scope, revision] of queueRevisions) if (revision !== queuesAtStart.get(scope)) protectedQueues.add(scope);
  const merged = new Map<string, DraftRecord>();
  for (const draft of serverDrafts) {
    if (!isRecord(draft) || typeof draft.scope !== 'string' || !draft.scope) continue;
    merged.set(draft.scope, {
      text: typeof draft.text === 'string' ? draft.text : '',
      queuedMessage: isRecord(draft.queuedMessage) ? draft.queuedMessage as StoredQueuedMessage : null,
    });
  }
  for (const scope of new Set([...protectedText, ...protectedQueues])) {
    const local = drafts.get(scope) ?? EMPTY_DRAFT;
    const server = merged.get(scope) ?? EMPTY_DRAFT;
    const next = {
      text: protectedText.has(scope) ? local.text : server.text,
      queuedMessage: protectedQueues.has(scope) ? local.queuedMessage : server.queuedMessage,
    };
    if (isEmptyDraft(next)) merged.delete(scope);
    else merged.set(scope, next);
  }
  drafts = merged;
  writeMirror();
  notifyListeners();
}

/** Invalidates old account requests, timers and mirrored drafts when signing out or replacing identity. */
export function resetChatDrafts(): void {
  storeGeneration++;
  hydrateGeneration++;
  draftSessionVersion = getAuthSessionVersion();
  writerController.abort();
  writerController = new AbortController();
  drafts = new Map();
  textRevisions.clear();
  pendingTextVersions.clear();
  scheduledScopes.clear();
  textWriters.clear();
  queueRevisions.clear();
  pendingQueueVersions.clear();
  queueRequests.clear();
  queueClears.clear();
  if (serverWriteTimer !== null) {
    clearTimeout(serverWriteTimer);
    serverWriteTimer = null;
  }
  try { localStorage.removeItem(MIRROR_STORAGE_KEY); } catch { /* The memory mirror is already empty. */ }
  notifyListeners();
}

if (typeof localStorage !== 'undefined') drafts = readMirror();
