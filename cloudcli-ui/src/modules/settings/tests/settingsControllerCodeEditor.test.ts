import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { CODE_EDITOR_DEFAULTS } from '@/shared/constants';
import type * as UserSettings from '@/shared/userSettings';
import type { UserPreferenceTransaction } from '@/shared/types';

type Store = typeof UserSettings;

// These dependencies are unrelated to the editor and must keep stable identities between renders.
vi.mock('@/shared/context/ThemeContext', () => {
  const theme = { isDarkMode: false, toggleDarkMode: () => undefined };
  return { useTheme: () => theme };
});
vi.mock('@/modules/provider-auth', () => {
  const auth = {
    providerAuthStatus: {},
    checkProviderAuthStatus: async () => ({ authenticated: false }),
    refreshProviderAuthStatuses: async () => undefined,
  };
  return { useProviderAuthStatus: () => auth };
});

const ACCOUNT_SERVER = window.location.origin;
const USER_ID = 'settings-controller-owner';
const PARTITION_KEY = 'user-preferences:v2:' + encodeURIComponent(JSON.stringify([ACCOUNT_SERVER, USER_ID]));
// Loaded dynamically with the controller so resetModules never leaves two different preference stores.
let store: Store;
// The mock HTTP service records real API transport payloads, not calls to a fake store.
let patches: Array<Record<string, unknown>>;
let notificationWrites: number;
let serverPreferences: Record<string, unknown>;
let serverRevisions: Record<string, number>;

function token(): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256' })}.${encode({ userId: USER_ID, iat: 1_700_000_000, exp: 4_102_444_800 })}.signature`;
}

function seedPreferences(preferences: Record<string, unknown>): void {
  serverPreferences = { ...preferences };
  (navigator.locks ? localStorage : sessionStorage).setItem(PARTITION_KEY, JSON.stringify({
    version: 2, identity: { serverKey: ACCOUNT_SERVER, userId: USER_ID }, preferences,
    revisions: {}, pending: {}, inFlight: {}, failures: {}, authPause: null,
    legacyMigrationComplete: true,
  }));
}

function storedPreferences() {
  const raw = (navigator.locks ? localStorage : sessionStorage).getItem(PARTITION_KEY);
  assert.ok(raw, 'a verified account must have a partitioned mirror');
  return JSON.parse(raw) as { preferences: { codeEditorSettings?: Record<string, unknown> }; pending: Record<string, unknown> };
}

async function renderSettings() {
  const auth = await import('@/shared/authToken');
  await auth.initializeAuthSession();
  const session = await auth.startAuthSession(token());
  assert.ok(session);
  assert.equal(session.userId, USER_ID);
  auth.acknowledgeAuthSession(session);
  store = await import('@/shared/userSettings');
  const { useSettingsController } = await import('@/modules/settings/hooks/useSettingsController');
  const hook = renderHook(() => useSettingsController({ isOpen: true, initialTab: 'appearance' }));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  return hook;
}

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  sessionStorage.clear();
  vi.useFakeTimers();
  patches = [];
  notificationWrites = 0;
  serverPreferences = {};
  serverRevisions = {};
  vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit = {}) => {
    if (String(url).includes('/api/settings/notification-preferences')) {
      if (options.method && options.method !== 'GET') notificationWrites++;
      return new Response(JSON.stringify({ success: true, preferences: {
        channels: { inApp: true, webPush: false, desktop: false, sound: true },
        events: { actionRequired: true, stop: true, error: true },
      } }), { status: 200 });
    }
    if (options.method === 'PATCH') {
      assert.equal(new Headers(options.headers).get('Authorization'), `Bearer ${token()}`);
      assert.equal(url, '/api/user/preferences/transactions');
      const input = JSON.parse(String(options.body)) as UserPreferenceTransaction;
      patches.push(input.updates);
      for (const key of Object.keys(input.updates)) {
        assert.equal(input.expectedRevisions[key], serverRevisions[key] ?? 0);
        serverRevisions[key] = (serverRevisions[key] ?? 0) + 1;
      }
      serverPreferences = { ...serverPreferences, ...input.updates };
      return new Response(JSON.stringify({ success: true, operationId: input.operationId, replayed: false, preferences: input.updates,
        revisions: Object.fromEntries(Object.keys(input.updates).map(key => [key, serverRevisions[key]])) }), { status: 200 });
    }
    return new Response(JSON.stringify({ success: true, preferences: serverPreferences, revisions: serverRevisions }), { status: 200 });
  }));
});

afterEach(() => {
  cleanup();
  store?.resetUserPreferences();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('opening settings writes no code-editor preference for a user who never set one', async () => {
  const { result } = await renderSettings();
  assert.deepEqual(result.current.codeEditorSettings, CODE_EDITOR_DEFAULTS);
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });

  assert.equal(storedPreferences().preferences.codeEditorSettings, undefined,
    'merely opening the dialog must not materialize code-editor defaults');
  assert.equal(store.readUserPreference('codeEditorSettings', null), null);
  assert.equal(patches.some(patch => 'codeEditorSettings' in patch), false);
});

test('opening settings does not write any untouched preferences or notification values', async () => {
  await renderSettings();
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });

  assert.deepEqual(patches, [], 'loading a dialog is not an edit to its default permissions or sort order');
  assert.equal(notificationWrites, 0, 'loading notifications must not save them back without an edit');
});

test('opening settings does not change a font size the authenticated user already chose', async () => {
  seedPreferences({ codeEditorSettings: { fontSize: '16' } });
  const { result } = await renderSettings();
  assert.equal(result.current.codeEditorSettings.fontSize, '16');
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });

  assert.deepEqual(storedPreferences().preferences.codeEditorSettings, { fontSize: '16' },
    'opening the dialog must not rewrite the stored settings');
  assert.equal(patches.some(patch => 'codeEditorSettings' in patch), false);
});

test('changing a setting writes all four values, notifies once and is acknowledged', async () => {
  const { result } = await renderSettings();
  const notify = vi.fn();
  const unsubscribe = store.subscribeToUserPreferences(notify);
  act(() => { result.current.updateCodeEditorSetting('fontSize', '18'); });
  unsubscribe();

  const expected = { ...CODE_EDITOR_DEFAULTS, fontSize: '18' };
  assert.deepEqual(storedPreferences().preferences.codeEditorSettings, expected);
  assert.deepEqual(store.readUserPreference('codeEditorSettings', null), expected);
  assert.equal(notify.mock.calls.length, 1);
  assert.equal(result.current.codeEditorSettings.fontSize, '18');
  await act(async () => { await vi.advanceTimersByTimeAsync(400); });
  assert.deepEqual(patches.filter(patch => 'codeEditorSettings' in patch), [{ codeEditorSettings: expected }]);
  assert.equal(store.getPreferenceSyncStatus().status, 'saved');
});

test('a second change keeps the earlier one', async () => {
  const { result } = await renderSettings();
  act(() => { result.current.updateCodeEditorSetting('fontSize', '18'); });
  act(() => { result.current.updateCodeEditorSetting('wordWrap', true); });

  assert.equal(storedPreferences().preferences.codeEditorSettings?.fontSize, '18');
  assert.equal(storedPreferences().preferences.codeEditorSettings?.wordWrap, true);
  await act(async () => { await vi.advanceTimersByTimeAsync(400); });
  assert.deepEqual(patches.filter(patch => 'codeEditorSettings' in patch), [{
    codeEditorSettings: { ...CODE_EDITOR_DEFAULTS, fontSize: '18', wordWrap: true },
  }]);
});

test('two edits in one batch both survive in the mirror, rendered hook and acknowledged request', async () => {
  const { result } = await renderSettings();
  act(() => {
    result.current.updateCodeEditorSetting('fontSize', '20');
    result.current.updateCodeEditorSetting('wordWrap', true);
  });

  assert.equal(storedPreferences().preferences.codeEditorSettings?.fontSize, '20');
  assert.equal(storedPreferences().preferences.codeEditorSettings?.wordWrap, true);
  assert.equal(result.current.codeEditorSettings.fontSize, '20');
  assert.equal(result.current.codeEditorSettings.wordWrap, true);
  await act(async () => { await vi.advanceTimersByTimeAsync(400); });
  assert.deepEqual(patches.filter(patch => 'codeEditorSettings' in patch), [{
    codeEditorSettings: { ...CODE_EDITOR_DEFAULTS, fontSize: '20', wordWrap: true },
  }]);
});
