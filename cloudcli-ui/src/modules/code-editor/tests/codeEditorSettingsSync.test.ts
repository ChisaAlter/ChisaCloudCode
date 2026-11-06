import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type * as CodeEditorHook from '@/modules/code-editor/hooks/useCodeEditorSettings';
import type * as CodeEditorSettings from '@/shared/codeEditorSettings';
import type * as UserSettings from '@/shared/userSettings';
import type { UserPreferenceTransaction } from '@/shared/types';

type Store = typeof UserSettings;
type EditorSettings = typeof CodeEditorSettings;

const subscriptions: Array<{ released: boolean }> = [];

const USER_ID = 'open-editor-owner';
const PARTITION_KEY = 'user-preferences:v2:' + encodeURIComponent(JSON.stringify([window.location.origin, USER_ID]));
// Every test establishes a real ready/acknowledged auth session before importing its consumers.
let store: Store;
let editor: EditorSettings;
let useEditorSettings: (typeof CodeEditorHook)['useCodeEditorSettings'];
// Real HTTP responses deliver cross-device hydration independently of the editor's local edits.
let serverPreferences: Record<string, unknown>;
let serverRevisions: Record<string, number>;
let loadResponse: Promise<Response> | null;
let patches: Array<Record<string, unknown>>;

function token(): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256' })}.${encode({ userId: USER_ID, iat: 1_700_000_000, exp: 4_102_444_800 })}.signature`;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function jsonResponse(preferences: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ success: true, preferences, revisions: { ...serverRevisions } }), { status: 200 });
}

beforeEach(async () => {
  vi.resetModules();
  localStorage.clear();
  sessionStorage.clear();
  vi.useFakeTimers();
  serverPreferences = {};
  serverRevisions = {};
  loadResponse = null;
  patches = [];
  subscriptions.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit = {}) => {
    assert.equal(new Headers(options.headers).get('Authorization'), `Bearer ${token()}`);
    if (options.method === 'PATCH') {
      assert.equal(url, '/api/user/preferences/transactions');
      const input = JSON.parse(String(options.body)) as UserPreferenceTransaction;
      const patch = input.updates;
      patches.push(patch);
      for (const key of Object.keys(patch)) {
        assert.equal(input.expectedRevisions[key], serverRevisions[key] ?? 0);
        serverRevisions[key] = (serverRevisions[key] ?? 0) + 1;
      }
      serverPreferences = { ...serverPreferences, ...patch };
      return new Response(JSON.stringify({ success: true, operationId: input.operationId, replayed: false, preferences: patch,
        revisions: Object.fromEntries(Object.keys(patch).map(key => [key, serverRevisions[key]])) }), { status: 200 });
    }
    return loadResponse ?? jsonResponse(serverPreferences);
  }));
  const auth = await import('@/shared/authToken');
  await auth.initializeAuthSession();
  const session = await auth.startAuthSession(token());
  assert.ok(session);
  assert.equal(session.userId, USER_ID);
  auth.acknowledgeAuthSession(session);
  store = await import('@/shared/userSettings');
  // A per-graph spy observes cleanup while every callback still uses this test's real authenticated store.
  const subscribe = store.subscribeToUserPreferences;
  vi.spyOn(store, 'subscribeToUserPreferences').mockImplementation(listener => {
    const subscription = { released: false };
    subscriptions.push(subscription);
    const unsubscribe = subscribe(listener);
    return () => { subscription.released = true; unsubscribe(); };
  });
  editor = await import('@/shared/codeEditorSettings');
  ({ useCodeEditorSettings: useEditorSettings } = await import('@/modules/code-editor/hooks/useCodeEditorSettings'));
});

afterEach(() => {
  cleanup();
  store?.resetUserPreferences();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('a settings edit in the same tab reaches the open editor and is acknowledged for its account', async () => {
  const { result } = renderHook(() => useEditorSettings());
  const before = result.current.fontSize;
  const expected = { wordWrap: true, showMinimap: false, lineNumbers: false, fontSize: '20' };
  act(() => { editor.writeCodeEditorSettings(expected); });

  assert.notEqual(before, 20);
  assert.equal(result.current.fontSize, 20);
  assert.equal(result.current.wordWrap, true);
  assert.equal(result.current.minimapEnabled, false);
  assert.equal(result.current.showLineNumbers, false);
  assert.deepEqual(store.readUserPreference('codeEditorSettings', null), expected);
  await act(async () => { await vi.advanceTimersByTimeAsync(400); });
  assert.deepEqual(patches, [{ codeEditorSettings: expected }]);
  assert.equal(store.getPreferenceSyncStatus().status, 'saved');
});

test('a settings edit made on another device hydrates the editor without writing it back', async () => {
  const { result } = renderHook(() => useEditorSettings());
  const before = result.current.fontSize;
  serverPreferences = { codeEditorSettings: { wordWrap: true, showMinimap: true, lineNumbers: true, fontSize: '18' } };
  await act(async () => { await store.hydrateUserPreferences(); });

  assert.notEqual(before, 18);
  assert.equal(result.current.fontSize, 18);
  assert.equal(result.current.wordWrap, true);
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  assert.deepEqual(patches, [], 'hydration is a read and the editor must never echo it back as a user edit');
  assert.deepEqual(JSON.parse((navigator.locks ? localStorage : sessionStorage).getItem(PARTITION_KEY)!).preferences.codeEditorSettings,
    serverPreferences.codeEditorSettings);
});

test('a late hydrate cannot reverse an editor setting edited and acknowledged during its GET', async () => {
  await store.hydrateUserPreferences();
  const response = deferred<Response>();
  loadResponse = response.promise;
  const { result } = renderHook(() => useEditorSettings());
  let hydration!: Promise<void>;
  await act(async () => {
    hydration = store.hydrateUserPreferences();
    await vi.advanceTimersByTimeAsync(0);
  });
  const localEdit = { wordWrap: true, showMinimap: false, lineNumbers: false, fontSize: '20' };
  act(() => { editor.writeCodeEditorSettings(localEdit); });
  await act(async () => { await vi.advanceTimersByTimeAsync(400); });
  assert.equal(store.getPreferenceSyncStatus().status, 'saved');

  await act(async () => {
    response.resolve(jsonResponse({ codeEditorSettings: { fontSize: '14', wordWrap: false } }));
    await hydration;
  });
  assert.equal(result.current.fontSize, 20);
  assert.equal(result.current.wordWrap, true);
  assert.equal(result.current.minimapEnabled, false);
  assert.equal(result.current.showLineNumbers, false);
  assert.deepEqual(store.readUserPreference('codeEditorSettings', null), localEdit);
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  assert.deepEqual(patches, [{ codeEditorSettings: localEdit }]);
});

test('the editor reads fontSize as a number, not the stored string', () => {
  store.writeUserPreference('codeEditorSettings', { fontSize: '16' });
  const { result } = renderHook(() => useEditorSettings());
  assert.equal(result.current.fontSize, 16);
});

test('an unset minimap keeps the shared default rather than reading as off', () => {
  const { result } = renderHook(() => useEditorSettings());
  assert.equal(result.current.minimapEnabled, true);
  assert.equal(result.current.showLineNumbers, true);
  assert.equal(result.current.wordWrap, false);
});

test('the editor releases its real store subscription when it unmounts', () => {
  const { unmount } = renderHook(() => useEditorSettings());
  assert.equal(subscriptions.length, 1, 'expected the preference-store subscription');
  assert.equal(subscriptions[0].released, false);
  unmount();
  assert.equal(subscriptions[0].released, true, 'the preference-store subscription leaked');
});
