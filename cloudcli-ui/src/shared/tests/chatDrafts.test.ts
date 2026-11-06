import assert from 'node:assert/strict';

import { afterEach, beforeEach, test, vi } from 'vitest';

import type * as Api from '@/shared/api';
import type * as AuthToken from '@/shared/authToken';
import type * as ChatDraftsModule from '@/shared/chatDrafts';

/**
 * Drafts moved out of the browser and into auth.db so a message half-typed on
 * one device can be finished on another — the case the composer could not serve
 * at all before, because a draft only existed on the machine it was typed on.
 *
 * Each test loads a fresh module copy, because the store reads its localStorage
 * mirror once at module scope.
 */

type SavedDraft = { scope: string; text: string; queuedMessage?: unknown };

const savedDrafts: SavedDraft[] = [];
const appendRequests: Array<{ scope: string; queuedMessage: unknown }> = [];
const clearedScopes: string[] = [];
let serverDrafts: unknown[] = [];
let draftsRequestFailed = false;
// Lets a test hold the drafts response, to land it after a later queue change.
let draftsResponseGate: Promise<void> | null = null;
// What the server answers to an append; by default it queues the message alone.
let appendResponse: ((queuedMessage: unknown) => Response) | null = null;
// Lets a test hold an append's answer, to make a queue change while it is in flight.
let appendResponseGate: Promise<void> | null = null;
// What the server answers to a clear.
let clearStatus = 200;

const loadedStores: Array<typeof ChatDraftsModule> = [];
const requests = vi.hoisted(() => ({ drafts: vi.fn(), saveDraft: vi.fn(), appendQueuedMessage: vi.fn(), clearQueuedMessage: vi.fn() }));

vi.mock('@/shared/api', async (importOriginal) => ({
  ...(await importOriginal<typeof Api>()),
  api: { user: requests },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

async function replaceIdentity(auth: typeof AuthToken): Promise<void> {
  const encode = (value: unknown) => btoa(JSON.stringify(value)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const token = `${encode({ alg: 'HS256' })}.${encode({ userId: 'new-account', iat: 1_700_000_000, exp: 4_102_444_800 })}.signature`;
  const next = await auth.startAuthSession(token, auth.getAuthSessionSnapshot());
  assert.ok(next, 'the fixture must commit the replacement identity before sending its drafts');
  auth.acknowledgeAuthSession(next);
}

const loadStore = async (): Promise<typeof ChatDraftsModule> => {
  vi.resetModules();
  const auth = await import('@/shared/authToken');
  await auth.initializeAuthSession();
  const store = await import('@/shared/chatDrafts');
  loadedStores.push(store);
  return store;
};

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  savedDrafts.length = 0;
  appendRequests.length = 0;
  clearedScopes.length = 0;
  serverDrafts = [];
  draftsRequestFailed = false;
  draftsResponseGate = null;
  appendResponse = null;
  appendResponseGate = null;
  clearStatus = 200;
  vi.resetAllMocks();
  requests.drafts.mockImplementation(async () => {
    if (draftsRequestFailed) throw new Error('offline');
    const snapshot = serverDrafts;
    await draftsResponseGate;
    return json({ success: true, drafts: snapshot });
  });
  requests.saveDraft.mockImplementation(async (scope: string, draft: { text: string; queuedMessage?: unknown }) => {
    savedDrafts.push({ scope, ...draft });
    return json({ success: true });
  });
  requests.appendQueuedMessage.mockImplementation(async (scope: string, queuedMessage: unknown) => {
    appendRequests.push({ scope, queuedMessage });
    await appendResponseGate;
    return appendResponse ? appendResponse(queuedMessage) : json({ success: true, queuedMessage, appended: false });
  });
  requests.clearQueuedMessage.mockImplementation(async (scope: string) => {
    clearedScopes.push(scope);
    return json({}, clearStatus);
  });
  vi.useFakeTimers();
});

afterEach(() => {
  for (const store of loadedStores) store.resetChatDrafts();
  loadedStores.length = 0;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test('a draft is readable synchronously and reaches the server after the debounce', async () => {
  const store = await loadStore();

  store.writeDraftText('session-a', 'half a thought');

  assert.equal(store.readDraftText('session-a'), 'half a thought');
  assert.deepEqual(savedDrafts, [], 'the request must not fire on every keystroke');

  await vi.advanceTimersByTimeAsync(1_500);
  assert.deepEqual(savedDrafts, [
    { scope: 'session-a', text: 'half a thought' },
  ]);
});

test('each session keeps its own draft', async () => {
  const store = await loadStore();

  store.writeDraftText('session-a', 'for A');
  store.writeDraftText('session-b', 'for B');

  assert.equal(store.readDraftText('session-a'), 'for A');
  assert.equal(store.readDraftText('session-b'), 'for B');
});

test('a chat with no session yet is scoped to its project', async () => {
  const store = await loadStore();

  store.writeDraftText('project:p1', 'unsent');

  assert.equal(store.readDraftText('project:p1'), 'unsent');
  assert.equal(store.readDraftText('session-a'), '');
});

test('clearing a draft saves the empty text and leaves dropping the row to the server', async () => {
  // Deleting the row from here would also delete a message queued for the
  // scope from another tab; the server drops the row only when nothing is left.
  const store = await loadStore();
  store.writeDraftText('session-a', 'typed');
  await vi.advanceTimersByTimeAsync(1_500);
  savedDrafts.length = 0;

  store.writeDraftText('session-a', '');
  await vi.advanceTimersByTimeAsync(1_500);

  assert.deepEqual(savedDrafts, [{ scope: 'session-a', text: '' }]);
});

test('a draft written in one page load is readable synchronously in the next', async () => {
  const first = await loadStore();
  first.writeDraftText('session-a', 'survives a reload');

  // No hydrate: this is the first paint of the next load, before any request
  // could have resolved.
  const second = await loadStore();
  assert.equal(second.readDraftText('session-a'), 'survives a reload');
});

test('hydrate brings in a draft typed on another device', async () => {
  serverDrafts = [{ scope: 'session-a', text: 'typed on the laptop', queuedMessage: null }];

  const store = await loadStore();
  await store.hydrateChatDrafts();

  assert.equal(store.readDraftText('session-a'), 'typed on the laptop');
});

test('hydrate removes a mirrored queue after the server claims it', async () => {
  const store = await loadStore();
  await store.appendQueuedMessage('session-a', { content: 'server-owned queue' });
  assert.equal(store.readQueuedMessage('session-a')?.content, 'server-owned queue');

  serverDrafts = [];
  await store.hydrateChatDrafts();

  assert.equal(store.readQueuedMessage('session-a'), null);
});

test('hydrate does not overwrite a scope the user is typing into right now', async () => {
  serverDrafts = [{ scope: 'session-a', text: 'stale server copy', queuedMessage: null }];

  const store = await loadStore();
  store.writeDraftText('session-a', 'what I am writing');
  await store.hydrateChatDrafts();

  assert.equal(store.readDraftText('session-a'), 'what I am writing');
});

test('a failed hydrate keeps the mirrored draft rather than blanking the composer', async () => {
  const store = await loadStore();
  store.writeDraftText('session-a', 'local work');
  await vi.advanceTimersByTimeAsync(1_500);

  draftsRequestFailed = true;
  await store.hydrateChatDrafts();

  assert.equal(store.readDraftText('session-a'), 'local work');
});

test('queueing goes to the server at once and keeps what it says is now queued', async () => {
  // The server appended this to a message another tab had queued.
  appendResponse = () => json({
    success: true,
    queuedMessage: { content: 'from the laptop\n\nsend this next', attachments: [] },
    appended: true,
  });
  const store = await loadStore();
  store.writeDraftText('session-a', 'still editing');

  const result = await store.appendQueuedMessage('session-a', { content: 'send this next', attachments: [] });

  assert.deepEqual(appendRequests, [{
    scope: 'session-a',
    queuedMessage: { content: 'send this next', attachments: [] },
  }], 'queue actions persist without waiting for the draft debounce');
  assert.deepEqual(result, {
    queuedMessage: { content: 'from the laptop\n\nsend this next', attachments: [] },
    appended: true,
  });
  assert.equal(store.readQueuedMessage('session-a')?.content, 'from the laptop\n\nsend this next');
  assert.equal(store.readDraftText('session-a'), 'still editing');
});

test('a text save never carries the queued message, so it cannot bring back one already sent', async () => {
  const store = await loadStore();
  await store.appendQueuedMessage('session-a', { content: 'queued A', attachments: [] });

  // The dispatcher sends "queued A" while the user types the next follow-up.
  store.writeDraftText('session-a', 'typing the next one');
  await vi.advanceTimersByTimeAsync(1_500);

  assert.deepEqual(savedDrafts, [{ scope: 'session-a', text: 'typing the next one' }]);
});

test('hydrate takes the server\'s queued message even for a scope being typed into', async () => {
  const store = await loadStore();
  await store.appendQueuedMessage('session-a', { content: 'queued A', attachments: [] });
  store.writeDraftText('session-a', 'typing');

  // Claimed and sent; the server still has the older text.
  serverDrafts = [{ scope: 'session-a', text: 'typ', queuedMessage: null }];
  await store.hydrateChatDrafts();

  assert.equal(store.readQueuedMessage('session-a'), null, 'the sent message leaves the card');
  assert.equal(store.readDraftText('session-a'), 'typing', 'the text being typed stays');
});

test('a hydrate already in flight when a message is queued does not put back the older queue', async () => {
  const store = await loadStore();
  await store.appendQueuedMessage('session-a', { content: 'A', attachments: [] });

  serverDrafts = [{ scope: 'session-a', text: '', queuedMessage: { content: 'A', attachments: [] } }];
  let releaseDrafts!: () => void;
  draftsResponseGate = new Promise((resolve) => { releaseDrafts = resolve; });
  const hydrating = store.hydrateChatDrafts();

  appendResponse = () => json({ success: true, queuedMessage: { content: 'A\n\nB', attachments: [] }, appended: true });
  await store.appendQueuedMessage('session-a', { content: 'B', attachments: [] });
  releaseDrafts();
  await hydrating;

  assert.equal(store.readQueuedMessage('session-a')?.content, 'A\n\nB');
});

test('a hydrate already in flight when the queued message is cleared does not bring it back', async () => {
  const store = await loadStore();
  await store.appendQueuedMessage('session-a', { content: 'A', attachments: [] });

  serverDrafts = [{ scope: 'session-a', text: '', queuedMessage: { content: 'A', attachments: [] } }];
  let releaseDrafts!: () => void;
  draftsResponseGate = new Promise((resolve) => { releaseDrafts = resolve; });
  const hydrating = store.hydrateChatDrafts();

  store.clearQueuedMessage('session-a');
  releaseDrafts();
  await hydrating;

  assert.equal(store.readQueuedMessage('session-a'), null);
});

test('a hydrate takes the server\'s text for a scope whose queue changed but which nobody typed into', async () => {
  const store = await loadStore();
  store.writeDraftText('session-a', 'older text');
  await vi.advanceTimersByTimeAsync(1_500);

  serverDrafts = [{ scope: 'session-a', text: 'typed on the phone', queuedMessage: null }];
  let releaseDrafts!: () => void;
  draftsResponseGate = new Promise((resolve) => { releaseDrafts = resolve; });
  const hydrating = store.hydrateChatDrafts();
  await store.appendQueuedMessage('session-a', { content: 'B', attachments: [] });
  releaseDrafts();
  await hydrating;

  assert.equal(store.readDraftText('session-a'), 'typed on the phone');
  assert.equal(store.readQueuedMessage('session-a')?.content, 'B');
});

test('a clear made while an append is being answered is sent after it, and the message queued again', async () => {
  appendResponse = (queuedMessage) => json({ success: true, queuedMessage, appended: false });
  const store = await loadStore();
  let releaseAppend!: () => void;
  appendResponseGate = new Promise((resolve) => { releaseAppend = resolve; });

  const appending = store.appendQueuedMessage('session-a', { content: 'B', attachments: [] });
  await vi.advanceTimersByTimeAsync(0);
  store.clearQueuedMessage('session-a');
  assert.deepEqual(clearedScopes, [], 'the clear waits for the append to be answered');
  releaseAppend();
  const result = await appending;

  assert.deepEqual(clearedScopes, ['session-a']);
  assert.equal(appendRequests.length, 2, 'the clear removed B on the server too, so B is queued again');
  assert.equal(result.queuedMessage.content, 'B');
  assert.equal(store.readQueuedMessage('session-a')?.content, 'B');
});

test('a clear that fails while an append is being answered does not queue the message twice', async () => {
  appendResponse = () => json({ success: true, queuedMessage: { content: 'A\n\nB', attachments: [] }, appended: true });
  clearStatus = 503;
  const store = await loadStore();
  let releaseAppend!: () => void;
  appendResponseGate = new Promise((resolve) => { releaseAppend = resolve; });

  const appending = store.appendQueuedMessage('session-a', { content: 'B', attachments: [] });
  await vi.advanceTimersByTimeAsync(0);
  store.clearQueuedMessage('session-a');
  releaseAppend();
  const result = await appending;

  assert.equal(appendRequests.length, 1);
  assert.equal(result.queuedMessage.content, 'A\n\nB', 'the server still holds both, so that is what is shown');
  assert.equal(store.readQueuedMessage('session-a')?.content, 'A\n\nB');
});

test('a queue the server refuses rejects and changes nothing here', async () => {
  appendResponse = () => json({ success: false, error: { message: 'A queued message needs text or attachments' } }, 400);
  const store = await loadStore();

  await assert.rejects(
    store.appendQueuedMessage('session-a', { content: 'B', attachments: [] }),
    /needs text or attachments/,
  );
  assert.equal(store.readQueuedMessage('session-a'), null);
});

test('a refused queue carries the server\'s error code, so the composer can say why in the user\'s language', async () => {
  appendResponse = () => json({
    success: false,
    error: { code: 'QUEUED_MESSAGE_NOT_COMBINABLE', message: 'A slash command runs as a turn of its own' },
  }, 409);
  const store = await loadStore();

  await assert.rejects(
    store.appendQueuedMessage('session-a', { content: '/compact', attachments: [] }),
    { code: 'QUEUED_MESSAGE_NOT_COMBINABLE', status: 409, message: 'A slash command runs as a turn of its own' },
  );
});

test('a queued message with neither text nor attachments reads as absent', async () => {
  localStorage.setItem('chat-drafts', JSON.stringify({
    'session-a': { text: '', queuedMessage: { content: '   ', attachments: [] } },
  }));
  const store = await loadStore();

  assert.equal(store.readQueuedMessage('session-a'), null);
});

test('legacy image-only descriptors are still readable as attachments', async () => {
  localStorage.setItem('chat-drafts', JSON.stringify({
    'session-a': { text: '', queuedMessage: { content: '', images: [{ name: 'shot.png' }] } },
  }));
  const store = await loadStore();

  assert.deepEqual(store.readQueuedMessage('session-a')?.attachments, [{ name: 'shot.png' }]);
});

test('clearing the queued message tells the server at once and leaves the draft text alone', async () => {
  const store = await loadStore();
  store.writeDraftText('session-a', 'keep me');
  await store.appendQueuedMessage('session-a', { content: 'queued' });

  await store.clearQueuedMessage('session-a');

  assert.equal(store.readQueuedMessage('session-a'), null);
  assert.equal(store.readDraftText('session-a'), 'keep me');
  assert.deepEqual(clearedScopes, ['session-a']);
});

test('subscribers are notified on a write', async () => {
  const store = await loadStore();
  const listener = vi.fn();
  const unsubscribe = store.subscribeToChatDrafts(listener);

  store.writeDraftText('session-a', 'typed');
  assert.equal(listener.mock.calls.length, 1);

  // Writing the same text again changes nothing, so nobody is woken.
  store.writeDraftText('session-a', 'typed');
  assert.equal(listener.mock.calls.length, 1);

  unsubscribe();
  store.writeDraftText('session-a', 'more');
  assert.equal(listener.mock.calls.length, 1);
});

test('reset clears the drafts so the next user does not see them', async () => {
  const store = await loadStore();
  store.writeDraftText('session-a', 'private');

  store.resetChatDrafts();

  assert.equal(store.readDraftText('session-a'), '');
  assert.equal(localStorage.getItem('chat-drafts'), null);
});

test('a successful stale hydrate cannot replace an in-flight text write', async () => {
  const response = deferred<Response>();
  requests.saveDraft.mockReturnValueOnce(response.promise);
  serverDrafts = [{ scope: 'session-a', text: 'stale' }];
  const store = await loadStore();
  store.writeDraftText('session-a', 'local in flight');
  await vi.advanceTimersByTimeAsync(1_000);

  await store.hydrateChatDrafts();
  assert.equal(store.readDraftText('session-a'), 'local in flight');
  assert.equal(store.isChatDraftPending('session-a'), true);

  response.resolve(json({ success: true }));
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(store.isChatDraftPending('session-a'), false);
});

test('an HTTP-failed text write stays pending through hydrate and is not retried by a timer', async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  requests.saveDraft.mockResolvedValueOnce(json({ error: 'write rejected' }, 500));
  serverDrafts = [{ scope: 'session-a', text: 'stale' }];
  const store = await loadStore();
  store.writeDraftText('session-a', 'local after failure');
  await vi.advanceTimersByTimeAsync(1_000);

  assert.equal(errors.mock.calls.length, 1);
  assert.equal(store.isChatDraftPending('session-a'), true);
  await store.hydrateChatDrafts();
  assert.equal(store.readDraftText('session-a'), 'local after failure');
  assert.equal(store.isChatDraftPending('session-a'), true);
  await vi.advanceTimersByTimeAsync(10_000);
  assert.equal(requests.saveDraft.mock.calls.length, 1);
});

test.each(['new local text', ''])('GET started before an acknowledged local change cannot restore old text: %j', async (newText) => {
  const store = await loadStore();
  store.writeDraftText('session-a', 'old text');
  await vi.advanceTimersByTimeAsync(1_000);
  const snapshot = deferred<Response>();
  requests.drafts.mockReturnValueOnce(snapshot.promise);
  const hydration = store.hydrateChatDrafts();

  store.writeDraftText('session-a', newText);
  await vi.advanceTimersByTimeAsync(1_000);
  assert.equal(store.isChatDraftPending('session-a'), false);
  snapshot.resolve(json({ drafts: [{ scope: 'session-a', text: 'old text' }] }));
  await hydration;

  assert.equal(store.readDraftText('session-a'), newText);
  const mirror = JSON.parse(localStorage.getItem('chat-drafts') || '{}');
  if (newText) assert.equal(mirror['session-a'].text, newText);
  else assert.equal(Object.prototype.hasOwnProperty.call(mirror, 'session-a'), false, 'a local deletion must not be resurrected');
});

test('same-scope writes wait for acknowledgement and an old acknowledgement cannot clear newer pending text', async () => {
  const older = deferred<Response>();
  const newer = deferred<Response>();
  requests.saveDraft.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
  const store = await loadStore();
  store.writeDraftText('session-a', 'older');
  await vi.advanceTimersByTimeAsync(1_000);
  store.writeDraftText('session-a', 'newer');
  await vi.advanceTimersByTimeAsync(1_000);

  assert.equal(requests.saveDraft.mock.calls.length, 1, 'the second write cannot race the first');
  older.resolve(json({ success: true }));
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(requests.saveDraft.mock.calls.length, 2);
  assert.equal(requests.saveDraft.mock.calls[0][1].text, 'older');
  assert.equal(requests.saveDraft.mock.calls[1][1].text, 'newer');
  assert.equal(store.isChatDraftPending('session-a'), true);
  newer.resolve(json({ success: true }));
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(store.isChatDraftPending('session-a'), false);
});

test('a refused append preserves the mirrored queue and never retries on a timer', async () => {
  const store = await loadStore();
  await store.appendQueuedMessage('session-a', { content: 'existing' });
  const response = deferred<Response>();
  requests.appendQueuedMessage.mockReturnValueOnce(response.promise);
  const saving = store.appendQueuedMessage('session-a', { content: 'new follow-up' });
  const rejected = assert.rejects(saving, /not confirmed/);
  response.resolve(json({ error: { message: 'not confirmed' } }, 500));
  await rejected;
  assert.equal(store.readQueuedMessage('session-a')?.content, 'existing');
  assert.equal(store.isChatDraftPending('session-a'), false);
  await vi.advanceTimersByTimeAsync(10_000);
  assert.equal(requests.appendQueuedMessage.mock.calls.length, 2);
});

test('a rejected queue cancellation stays pending and survives a stale hydrate', async () => {
  const store = await loadStore();
  await store.appendQueuedMessage('session-a', { content: 'first' });
  const deleted = deferred<Response>();
  requests.clearQueuedMessage.mockReturnValueOnce(deleted.promise);
  const cancellation = store.clearQueuedMessage('session-a');
  const rejected = assert.rejects(cancellation, /cannot cancel/);
  assert.equal(store.isChatDraftPending('session-a'), true);
  deleted.resolve(json({ error: { message: 'cannot cancel' } }, 409));
  await rejected;
  serverDrafts = [{ scope: 'session-a', text: '', queuedMessage: { content: 'first' } }];
  await store.hydrateChatDrafts();
  assert.equal(store.readQueuedMessage('session-a'), null);
  assert.equal(store.isChatDraftPending('session-a'), true, 'local null is not a confirmed dispatcher claim');
});

test('typing after queue acknowledgement does not resend a queue already claimed by the dispatcher', async () => {
  const store = await loadStore();
  await store.appendQueuedMessage('session-a', { content: 'already queued' });
  store.writeDraftText('session-a', 'next thought');
  await vi.advanceTimersByTimeAsync(1_000);
  const payload = requests.saveDraft.mock.calls[0][1];
  assert.deepEqual(payload, { text: 'next thought' });
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'queuedMessage'), false);
  serverDrafts = [{ scope: 'session-a', text: 'next thought', queuedMessage: null }];
  await store.hydrateChatDrafts();
  assert.equal(store.readDraftText('session-a'), 'next thought');
  assert.equal(store.readQueuedMessage('session-a'), null);
});

test('a late hydrate cannot restore drafts after logout reset', async () => {
  const response = deferred<Response>();
  requests.drafts.mockReturnValueOnce(response.promise);
  const store = await loadStore();
  const hydration = store.hydrateChatDrafts();
  store.resetChatDrafts();
  response.resolve(json({ drafts: [{ scope: 'session-a', text: 'old private draft' }] }));
  await hydration;
  assert.equal(store.readDraftText('session-a'), '');
  assert.equal(localStorage.getItem('chat-drafts'), null);
});

test('an identity replacement invalidates a hydrate even before reset reaches the store', async () => {
  const response = deferred<Response>();
  requests.drafts.mockReturnValueOnce(response.promise);
  const store = await loadStore();
  const auth = await import('@/shared/authToken');
  const hydration = store.hydrateChatDrafts();
  await replaceIdentity(auth);
  response.resolve(json({ drafts: [{ scope: 'session-a', text: 'old identity' }] }));
  await hydration;
  assert.equal(store.readDraftText('session-a'), '');
  assert.equal(localStorage.getItem('chat-drafts'), null);
});

test.each(['reset', 'identity'])('%s invalidation cancels old waiters and never sends an old successor as the next user', async (mode) => {
  const oldResponse = deferred<Response>();
  requests.appendQueuedMessage.mockReturnValueOnce(oldResponse.promise);
  const store = await loadStore();
  const auth = await import('@/shared/authToken');
  const older = store.appendQueuedMessage('session-a', { content: 'old first' });
  const successor = store.appendQueuedMessage('session-a', { content: 'old second' });
  const canceledOlder = assert.rejects(older, { name: 'AbortError' });
  const canceledSuccessor = assert.rejects(successor, { name: 'AbortError' });
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(requests.appendQueuedMessage.mock.calls.length, 1);
  if (mode === 'reset') {
    await auth.clearAuthToken(auth.getAuthSessionSnapshot());
    store.resetChatDrafts();
  }
  await replaceIdentity(auth);
  await store.appendQueuedMessage('session-a', { content: 'new identity queue' });
  await Promise.all([canceledOlder, canceledSuccessor]);
  oldResponse.resolve(json({ success: true, queuedMessage: { content: 'old first' }, appended: false }));
  await vi.advanceTimersByTimeAsync(0);
  assert.deepEqual(requests.appendQueuedMessage.mock.calls.map(([, message]) => message.content), ['old first', 'new identity queue']);
  assert.equal(store.readQueuedMessage('session-a')?.content, 'new identity queue');
  assert.equal(store.isChatDraftPending('session-a'), false);
});

test('a debounced write from the old identity is not replayed after login', async () => {
  const store = await loadStore();
  const auth = await import('@/shared/authToken');
  store.writeDraftText('session-a', 'old identity draft');
  await replaceIdentity(auth);
  await vi.advanceTimersByTimeAsync(1_000);
  assert.equal(requests.saveDraft.mock.calls.length, 0);
  assert.equal(store.readDraftText('session-a'), '');
  store.writeDraftText('session-a', 'new identity draft');
  await vi.advanceTimersByTimeAsync(1_000);
  assert.deepEqual(requests.saveDraft.mock.calls.map(([, draft]) => draft.text), ['new identity draft']);
});

test('an older hydrate cannot replace a newer accepted server snapshot', async () => {
  const older = deferred<Response>();
  const newer = deferred<Response>();
  requests.drafts.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
  const store = await loadStore();
  const first = store.hydrateChatDrafts();
  const second = store.hydrateChatDrafts();
  newer.resolve(json({ drafts: [{ scope: 'session-a', text: 'new snapshot' }] }));
  await second;
  older.resolve(json({ drafts: [{ scope: 'session-a', text: 'stale snapshot' }] }));
  await first;
  assert.equal(store.readDraftText('session-a'), 'new snapshot');
});
