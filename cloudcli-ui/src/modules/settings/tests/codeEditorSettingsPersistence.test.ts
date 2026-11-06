import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';

import { afterEach, beforeEach, test, vi } from 'vitest';

import { CODE_EDITOR_DEFAULTS, CODE_EDITOR_STORAGE_KEYS } from '@/shared/constants';
import type * as CodeEditorSettings from '@/shared/codeEditorSettings';
import type * as UserSettings from '@/shared/userSettings';
import type { UserPreferenceTransaction } from '@/shared/types';

type Store = typeof UserSettings;
type EditorSettings = typeof CodeEditorSettings;

const ACCOUNT_SERVER = window.location.origin;
const USER_ID = 'settings-editor-owner';
const PARTITION_KEY = 'user-preferences:v2:' + encodeURIComponent(JSON.stringify([ACCOUNT_SERVER, USER_ID]));
const LEGACY_OWNER_KEY = 'user-preferences:legacy-owner:v2';
// Each case uses the same real authority/store graph; reload cases retain its durable partition.
let store: Store;
let editor: EditorSettings;
let loadedStores: Store[];
// The actual API transport receives acknowledgments from this isolated server fixture.
let serverPreferences: Record<string, unknown>;
let serverRevisions: Record<string, number>;
let patches: Array<Record<string, unknown>>;

function token(): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256' })}.${encode({ userId: USER_ID, iat: 1_700_000_000, exp: 4_102_444_800 })}.signature`;
}

async function loadAccount(): Promise<void> {
  const auth = await import('@/shared/authToken');
  const restored = await auth.initializeAuthSession();
  const session = restored.phase === 'ready' ? restored : await auth.startAuthSession(token());
  assert.ok(session, 'the fixture must authenticate before consuming account preferences');
  assert.equal(session.userId, USER_ID);
  auth.acknowledgeAuthSession(session);
  store = await import('@/shared/userSettings');
  loadedStores.push(store);
  editor = await import('@/shared/codeEditorSettings');
}

function partition() {
  const raw = (navigator.locks ? localStorage : sessionStorage).getItem(PARTITION_KEY);
  assert.ok(raw, 'an authenticated mirror must have an explicit server/user partition');
  return JSON.parse(raw) as {
    preferences: Record<string, unknown>;
    pending: Record<string, { value: unknown }>;
    inFlight: Record<string, { value: unknown }>;
  };
}

beforeEach(async () => {
  vi.resetModules();
  localStorage.clear();
  sessionStorage.clear();
  vi.useFakeTimers();
  loadedStores = [];
  serverPreferences = {};
  serverRevisions = {};
  patches = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit = {}) => {
    if (options.method === 'PATCH') {
      assert.equal(url, '/api/user/preferences/transactions');
      const input = JSON.parse(String(options.body)) as UserPreferenceTransaction;
      const { updates } = input;
      patches.push(updates);
      assert.equal(new Headers(options.headers).get('Authorization'), `Bearer ${token()}`);
      for (const key of Object.keys(updates)) {
        assert.equal(input.expectedRevisions[key], serverRevisions[key] ?? 0);
        serverRevisions[key] = (serverRevisions[key] ?? 0) + 1;
      }
      serverPreferences = { ...serverPreferences, ...updates };
      return new Response(JSON.stringify({ success: true, operationId: input.operationId, replayed: false, preferences: updates,
        revisions: Object.fromEntries(Object.keys(updates).map(key => [key, serverRevisions[key]])) }), { status: 200 });
    }
    return new Response(JSON.stringify({ success: true, preferences: serverPreferences, revisions: serverRevisions }), { status: 200 });
  }));
  await loadAccount();
});

afterEach(() => {
  for (const loaded of loadedStores) loaded.resetUserPreferences();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('both modules resolve the same settings from one authenticated preference', () => {
  const expected = { wordWrap: true, showMinimap: false, lineNumbers: false, fontSize: '18' };
  editor.writeCodeEditorSettings(expected);

  assert.deepEqual(store.readUserPreference('codeEditorSettings', null), expected);
  assert.deepEqual(editor.readCodeEditorSettings(), expected);
  assert.deepEqual(partition().preferences.codeEditorSettings, expected);
  assert.equal(localStorage.getItem('user-preferences'), null, 'new edits must not recreate the unscoped legacy mirror');
  for (const key of Object.values(CODE_EDITOR_STORAGE_KEYS)) {
    assert.equal(localStorage.getItem(key), null, `${key} is a legacy key and must no longer be written`);
  }
});

test('the legacy per-setting keys stay declared for explicit-owner migration', () => {
  assert.deepEqual(CODE_EDITOR_STORAGE_KEYS, {
    wordWrap: 'codeEditorWordWrap', showMinimap: 'codeEditorShowMinimap',
    lineNumbers: 'codeEditorLineNumbers', fontSize: 'codeEditorFontSize',
  });
});

test('the shared font-size default matches the editor default, not the old settings default', () => {
  assert.equal(CODE_EDITOR_DEFAULTS.fontSize, '12');
});

test('a fresh authenticated user gets the shared defaults', () => {
  assert.deepEqual(editor.readCodeEditorSettings(), CODE_EDITOR_DEFAULTS);
  assert.equal(store.readUserPreference('codeEditorSettings', null), null);
});

test('an explicit edit persists every setting, notifies once and survives an acknowledged page reload', async () => {
  const notify = vi.fn();
  const unsubscribe = store.subscribeToUserPreferences(notify);
  const expected = { wordWrap: true, showMinimap: false, lineNumbers: false, fontSize: '18' };
  editor.writeCodeEditorSettings(expected);
  unsubscribe();

  assert.deepEqual(partition().preferences.codeEditorSettings, expected);
  assert.deepEqual(partition().pending.codeEditorSettings.value, expected);
  assert.equal(notify.mock.calls.length, 1);
  assert.equal(store.getPreferenceSyncStatus().status, 'unsaved');
  await vi.advanceTimersByTimeAsync(400);
  assert.deepEqual(patches, [{ codeEditorSettings: expected }]);
  assert.equal(store.getPreferenceSyncStatus().status, 'saved');
  assert.deepEqual(partition().pending, {});
  assert.deepEqual(partition().inFlight, {});

  store.resetUserPreferences();
  vi.resetModules();
  await loadAccount();
  assert.deepEqual(editor.readCodeEditorSettings(), expected);
  assert.equal(store.hasHydratedUserPreferences(), false, 'the partition is available before the next GET');
});

test('a font size the user already chose survives a settings read', () => {
  store.writeUserPreference('codeEditorSettings', { fontSize: '16' });
  assert.equal(editor.readCodeEditorSettings().fontSize, '16');
});

test('reading writes nothing, so opening the dialog cannot materialize defaults', async () => {
  const before = (navigator.locks ? localStorage : sessionStorage).getItem(PARTITION_KEY);
  editor.readCodeEditorSettings();
  await vi.advanceTimersByTimeAsync(1000);

  assert.equal((navigator.locks ? localStorage : sessionStorage).getItem(PARTITION_KEY), before, 'reading must not change an initialized account partition');
  assert.equal(partition().preferences.codeEditorSettings, undefined);
  assert.deepEqual(partition().pending, {});
  assert.equal(store.readUserPreference('codeEditorSettings', null), null);
  assert.deepEqual(patches, []);
});

test('the editor and the dialog decode a stored value the same way', () => {
  const expected = { wordWrap: true, showMinimap: false, lineNumbers: true, fontSize: '20' };
  editor.writeCodeEditorSettings(expected);
  assert.deepEqual(editor.readCodeEditorSettings(), expected);
});

test('explicit owner attribution migrates the legacy editor settings and acknowledges one patch', async () => {
  localStorage.setItem(LEGACY_OWNER_KEY, JSON.stringify({ serverKey: ACCOUNT_SERVER, userId: USER_ID }));
  localStorage.setItem(CODE_EDITOR_STORAGE_KEYS.wordWrap, 'true');
  localStorage.setItem(CODE_EDITOR_STORAGE_KEYS.showMinimap, 'false');
  localStorage.setItem(CODE_EDITOR_STORAGE_KEYS.fontSize, '16');
  await store.hydrateUserPreferences();

  assert.deepEqual(editor.readCodeEditorSettings(), {
    wordWrap: true, showMinimap: false, lineNumbers: CODE_EDITOR_DEFAULTS.lineNumbers, fontSize: '16',
  });
  await vi.advanceTimersByTimeAsync(400);
  assert.deepEqual(patches, [{ codeEditorSettings: { wordWrap: true, showMinimap: false, fontSize: '16' } }]);
  assert.equal(store.getPreferenceSyncStatus().status, 'saved');
});

test('signed-out persistence is limited to local appearance and never seeds the next editor account', async () => {
  const auth = await import('@/shared/authToken');
  assert.equal(await auth.clearAuthToken(), true);
  store.writeUserPreference('theme', 'dark');
  store.writeUserPreference('userLanguage', 'ja');
  editor.writeCodeEditorSettings({ ...CODE_EDITOR_DEFAULTS, fontSize: '22' });
  await vi.advanceTimersByTimeAsync(1000);

  assert.equal(store.getPreferenceSyncStatus().status, 'local');
  assert.deepEqual(JSON.parse(localStorage.getItem('user-preferences:appearance:v2')!), { theme: 'dark', userLanguage: 'ja' });
  assert.equal(partition().preferences.codeEditorSettings, undefined);
  assert.deepEqual(patches, []);
  const next = await auth.startAuthSession(token());
  assert.ok(next);
  auth.acknowledgeAuthSession(next);
  assert.deepEqual(editor.readCodeEditorSettings(), CODE_EDITOR_DEFAULTS);
  await store.hydrateUserPreferences();
  await vi.advanceTimersByTimeAsync(1000);
  assert.deepEqual(patches, []);
});

test.each([
  { serverKey: ACCOUNT_SERVER, userId: 'another-user' },
  { serverKey: ACCOUNT_SERVER + '/instances/other', userId: USER_ID },
])('a legacy marker for another identity never authorizes editor migration (%s)', async owner => {
  localStorage.setItem(LEGACY_OWNER_KEY, JSON.stringify(owner));
  localStorage.setItem('user-preferences', JSON.stringify({ codeEditorSettings: { fontSize: '22' } }));
  await store.hydrateUserPreferences();
  await vi.advanceTimersByTimeAsync(1000);

  assert.deepEqual(editor.readCodeEditorSettings(), CODE_EDITOR_DEFAULTS);
  assert.equal(partition().preferences.codeEditorSettings, undefined);
  assert.deepEqual(patches, []);
});

test('unattributed legacy editor settings are never claimed by the first authenticated reader', async () => {
  localStorage.setItem('user-preferences', JSON.stringify({ codeEditorSettings: { fontSize: '22' } }));
  localStorage.setItem(CODE_EDITOR_STORAGE_KEYS.fontSize, '20');
  await store.hydrateUserPreferences();
  await vi.advanceTimersByTimeAsync(1000);

  assert.deepEqual(editor.readCodeEditorSettings(), CODE_EDITOR_DEFAULTS);
  assert.equal(partition().preferences.codeEditorSettings, undefined);
  assert.equal(localStorage.getItem(LEGACY_OWNER_KEY), null);
  assert.deepEqual(patches, []);
});
