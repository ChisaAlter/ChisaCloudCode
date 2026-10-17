import assert from 'node:assert/strict';

import { afterEach, beforeEach, test, vi } from 'vitest';
import type * as ChatDraftStore from '@/shared/chatDrafts';

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
const deletedScopes: string[] = [];
let serverDrafts: unknown[] = [];
let draftsRequestFailed = false;
const requests = vi.hoisted(() => ({ drafts: vi.fn(), saveDraft: vi.fn(), deleteDraft: vi.fn() }));
const loadedStores: Array<typeof ChatDraftStore> = [];

vi.mock('@/shared/api', () => ({
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

const loadStore = async (): Promise<typeof ChatDraftStore> => {
  vi.resetModules();
  const store = await import('@/shared/chatDrafts');
  loadedStores.push(store);
  return store;
};

beforeEach(() => {
  localStorage.clear();
  savedDrafts.length = 0;
  deletedScopes.length = 0;
  serverDrafts = [];
  draftsRequestFailed = false;
  vi.resetAllMocks();
  requests.drafts.mockImplementation(async () => {
    if (draftsRequestFailed) throw new Error('offline');
    return json({ success: true, drafts: serverDrafts });
  });
  requests.saveDraft.mockImplementation(async (scope: string, draft: { text: string; queuedMessage?: unknown }) => {
    savedDrafts.push({ scope, ...draft });
    return json({ success: true });
  });
  requests.deleteDraft.mockImplementation(async (scope: string) => {
    deletedScopes.push(scope);
    return json({ success: true });
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

test('editing a manual queue persists text together with its durable attachments and options across reload', async () => {
  const store = await loadStore();
  const snapshot = { content: 'original', autoSend: false, attachments: [{ path: '/asset/report.txt', name: 'report.txt' }],
    options: { model: 'saved-model', customOption: 'retained' } };
  await store.writeQueuedMessage('session-a', snapshot);
  store.writeDraftText('session-a', 'original', true);
  store.writeDraftText('session-a', 'edited', true);
  await vi.advanceTimersByTimeAsync(1_500);
  assert.deepEqual(savedDrafts.at(-1), { scope: 'session-a', text: 'edited', queuedMessage: { ...snapshot, content: 'edited' } });
  const reloaded = await loadStore();
  assert.equal(reloaded.readDraftText('session-a'), 'edited');
  assert.deepEqual(reloaded.readQueuedMessage('session-a'), { ...snapshot, content: 'edited' });
});

test('a separate newer text draft does not replace the paused queue snapshot', async () => {
  const store = await loadStore();
  const snapshot = { content: 'paused turn', autoSend: false, attachments: [{ path: '/asset/original.txt' }], options: { effort: 'high' } };
  await store.writeQueuedMessage('session-a', snapshot);
  store.writeDraftText('session-a', 'independent newer draft');
  await vi.advanceTimersByTimeAsync(1_500);
  assert.equal(store.readDraftText('session-a'), 'independent newer draft');
  assert.deepEqual(store.readQueuedMessage('session-a'), snapshot);
  assert.deepEqual(savedDrafts.at(-1), { scope: 'session-a', text: 'independent newer draft' });
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

test('clearing draft text does not delete a queue belonging to the same scope', async () => {
  const store = await loadStore();
  store.writeDraftText('session-a', 'typed');
  await vi.advanceTimersByTimeAsync(1_500);
  savedDrafts.length = 0;

  store.writeDraftText('session-a', '');
  await vi.advanceTimersByTimeAsync(1_500);

  assert.deepEqual(savedDrafts, [{ scope: 'session-a', text: '' }]);
  assert.deepEqual(deletedScopes, []);
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
  await store.writeQueuedMessage('session-a', { content: 'server-owned queue' });
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

test('a queued message round-trips alongside the draft text', async () => {
  const store = await loadStore();

  store.writeDraftText('session-a', 'still editing');
  await store.writeQueuedMessage('session-a', { content: 'send this next', attachments: [] });

  assert.equal(store.readDraftText('session-a'), 'still editing');
  assert.deepEqual(store.readQueuedMessage('session-a'), {
    content: 'send this next',
    attachments: [],
  });
  assert.equal(savedDrafts.length, 1, 'queue actions persist without waiting for the draft debounce');
  assert.deepEqual(savedDrafts, [{
    scope: 'session-a',
    text: 'still editing',
    queuedMessage: { content: 'send this next', attachments: [] },
  }]);
});

test('an explicit paused-queue text editor debounces the complete retained snapshot', async () => {
  const store = await loadStore();
  const snapshot = {
    content: 'original task', autoSend: false, attachments: [{ name: 'saved.txt', path: '/asset/saved.txt' }],
    options: { model: 'saved-model', permissionMode: 'plan', customOption: 'retained' },
  };
  await store.writeQueuedMessage('session-a', snapshot);
  savedDrafts.length = 0;

  store.writeDraftText('session-a', 'edited task', true);
  assert.equal(store.readDraftText('session-a'), 'edited task');
  assert.deepEqual(store.readQueuedMessage('session-a'), { ...snapshot, content: 'edited task' });
  assert.deepEqual(savedDrafts, [], 'typing does not issue a queue write for every keystroke');
  await vi.advanceTimersByTimeAsync(1_000);
  assert.deepEqual(savedDrafts, [{
    scope: 'session-a', text: 'edited task', queuedMessage: { ...snapshot, content: 'edited task' },
  }]);
  assert.equal(store.isChatDraftPending('session-a'), false);
  assert.deepEqual(deletedScopes, []);
});

test('ordinary typing beside a paused queue persists only independent text', async () => {
  const store = await loadStore();
  const snapshot = {
    content: 'paused task', autoSend: false, attachments: [{ name: 'saved.txt', path: '/asset/saved.txt' }],
    options: { model: 'saved-model', customOption: 'retained' },
  };
  await store.writeQueuedMessage('session-a', snapshot);
  savedDrafts.length = 0;

  store.writeDraftText('session-a', 'an unrelated unsent thought');
  assert.deepEqual(store.readQueuedMessage('session-a'), snapshot);
  await vi.advanceTimersByTimeAsync(1_000);
  assert.deepEqual(savedDrafts, [{ scope: 'session-a', text: 'an unrelated unsent thought' }]);
  assert.equal(Object.prototype.hasOwnProperty.call(savedDrafts[0], 'queuedMessage'), false);
  assert.deepEqual(store.readQueuedMessage('session-a'), snapshot);
});

test('a queued message with neither text nor attachments reads as absent', async () => {
  const store = await loadStore();

  await store.writeQueuedMessage('session-a', { content: '   ', attachments: [] });

  assert.equal(store.readQueuedMessage('session-a'), null);
});

test('legacy image-only descriptors are still readable as attachments', async () => {
  const store = await loadStore();

  await store.writeQueuedMessage('session-a', { content: '', images: [{ name: 'shot.png' }] });

  assert.deepEqual(store.readQueuedMessage('session-a')?.attachments, [{ name: 'shot.png' }]);
});

test('clearing the queued message leaves the draft text alone', async () => {
  const store = await loadStore();
  store.writeDraftText('session-a', 'keep me');
  await store.writeQueuedMessage('session-a', { content: 'queued' });

  await store.clearQueuedMessage('session-a');

  assert.equal(store.readQueuedMessage('session-a'), null);
  assert.equal(store.readDraftText('session-a'), 'keep me');
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

test('a queue acknowledgement failure keeps the local queue pending until an explicit retry succeeds', async () => {
  const response = deferred<Response>();
  requests.saveDraft.mockReturnValueOnce(response.promise);
  const store = await loadStore();
  const queued = { content: 'pending queue' };
  const saving = store.writeQueuedMessage('session-a', queued);
  assert.equal(store.writeQueuedMessage('session-a', { ...queued }), saving, 'concurrent identical queue actions share one write');
  const rejected = assert.rejects(saving, /not confirmed \(500\)/);
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(requests.saveDraft.mock.calls.length, 1);

  response.resolve(json({}, 500));
  await rejected;
  await store.hydrateChatDrafts();
  assert.equal(store.readQueuedMessage('session-a')?.content, queued.content);
  assert.equal(store.isChatDraftPending('session-a'), true);
  await vi.advanceTimersByTimeAsync(10_000);
  assert.equal(requests.saveDraft.mock.calls.length, 1, 'failure alone must not requeue an unconfirmed action');

  await store.writeQueuedMessage('session-a', queued);
  assert.equal(requests.saveDraft.mock.calls.length, 2);
  assert.equal(store.isChatDraftPending('session-a'), false);
});

test('queue cancellation is serialized after queue creation and a rejected cancellation stays pending', async () => {
  const saved = deferred<Response>();
  const deleted = deferred<Response>();
  requests.saveDraft.mockReturnValueOnce(saved.promise);
  requests.deleteDraft.mockReturnValueOnce(deleted.promise);
  const store = await loadStore();
  const saving = store.writeQueuedMessage('session-a', { content: 'first' });
  const cancellation = store.clearQueuedMessage('session-a');
  const rejected = assert.rejects(cancellation, /cannot cancel/);
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(requests.deleteDraft.mock.calls.length, 0);

  saved.resolve(json({ success: true }));
  await saving;
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(requests.deleteDraft.mock.calls.length, 1);
  assert.equal(store.isChatDraftPending('session-a'), true, 'queue creation cannot acknowledge its cancellation');
  deleted.resolve(json({ error: { message: 'cannot cancel' } }, 409));
  await rejected;
  serverDrafts = [{ scope: 'session-a', text: '', queuedMessage: { content: 'first' } }];
  await store.hydrateChatDrafts();
  assert.equal(store.readQueuedMessage('session-a'), null);
  assert.equal(store.isChatDraftPending('session-a'), true, 'local null is not a confirmed dispatcher claim');
});

test('typing after queue acknowledgement does not resend a queue already claimed by the dispatcher', async () => {
  const store = await loadStore();
  await store.writeQueuedMessage('session-a', { content: 'already queued' });
  store.writeDraftText('session-a', 'next thought');
  await vi.advanceTimersByTimeAsync(1_000);
  const payload = requests.saveDraft.mock.calls[1][1];
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
  auth.startAuthSession('new.payload.signature');
  response.resolve(json({ drafts: [{ scope: 'session-a', text: 'old identity' }] }));
  await hydration;
  assert.equal(store.readDraftText('session-a'), '');
  assert.equal(localStorage.getItem('chat-drafts'), null);
});

test.each(['reset', 'identity'])('%s invalidation cancels old waiters and never forwards their queued successor as the next user', async (mode) => {
  const oldResponse = deferred<Response>();
  requests.saveDraft.mockReturnValueOnce(oldResponse.promise);
  const store = await loadStore();
  const auth = await import('@/shared/authToken');
  const older = store.writeQueuedMessage('session-a', { content: 'old first' });
  const successor = store.writeQueuedMessage('session-a', { content: 'old second' });
  const canceledOlder = assert.rejects(older, { name: 'AbortError' });
  const canceledSuccessor = assert.rejects(successor, { name: 'AbortError' });
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(requests.saveDraft.mock.calls.length, 1);
  if (mode === 'reset') {
    auth.clearAuthToken();
    store.resetChatDrafts();
  }
  auth.startAuthSession('new.payload.signature');
  await store.writeQueuedMessage('session-a', { content: 'new identity queue' });
  await Promise.all([canceledOlder, canceledSuccessor]);

  oldResponse.resolve(json({ success: true }));
  await vi.advanceTimersByTimeAsync(0);
  assert.deepEqual(requests.saveDraft.mock.calls.map(([, draft]) => draft.queuedMessage.content), ['old first', 'new identity queue']);
  assert.equal(store.readQueuedMessage('session-a')?.content, 'new identity queue');
  assert.equal(store.isChatDraftPending('session-a'), false);
});

test('a debounced write from the old identity is not replayed after login', async () => {
  const store = await loadStore();
  const auth = await import('@/shared/authToken');
  store.writeDraftText('session-a', 'old identity draft');
  auth.startAuthSession('new.payload.signature');
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
