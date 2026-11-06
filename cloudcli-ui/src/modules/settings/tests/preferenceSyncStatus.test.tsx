import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type * as AuthToken from '@/shared/authToken';
import type { NotificationPreferencesState, UserPreferenceTransaction } from '@/shared/types';
import type * as UserSettings from '@/shared/userSettings';

type Store = typeof UserSettings;
type Auth = typeof AuthToken;
type HttpResult = Response | Promise<Response>;

// These tabs do not participate in the outbox contract. Keep the real Settings, controller and preference store.
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/modules/provider-auth', () => {
  const state = {
    providerAuthStatus: {},
    checkProviderAuthStatus: async () => ({ authenticated: false }),
    refreshProviderAuthStatuses: async () => undefined,
  };
  return { ProviderLoginModal: () => null, useProviderAuthStatus: () => state };
});
vi.mock('@/shared/context/ThemeContext', () => {
  const state = { isDarkMode: false, toggleDarkMode: () => undefined };
  return { useTheme: () => state };
});
vi.mock('@/modules/settings/hooks/useWebPush', () => ({ useWebPush: () => ({
  permission: 'default', isSubscribed: false, isLoading: false,
  subscribe: async () => undefined, unsubscribe: async () => undefined,
}) }));
vi.mock('@/modules/settings/SettingsSidebar', () => ({
  default: ({ onChange }: { onChange: (tab: 'appearance' | 'notifications') => void }) => (
    <button onClick={() => onChange('notifications')}>Open notifications</button>
  ),
}));
vi.mock('@/modules/settings/tabs/agents-settings/AgentsSettingsTab', () => ({ default: () => null }));
vi.mock('@/modules/settings/tabs/models-settings/ModelsSettingsTab', () => ({ default: () => null }));
vi.mock('@/modules/settings/tabs/api-settings/CredentialsSettingsTab', () => ({ default: () => null }));
vi.mock('@/modules/settings/tabs/VoiceSettingsTab', () => ({ default: () => null }));
vi.mock('@/modules/settings/tabs/git-settings/GitSettingsTab', () => ({ default: () => null }));
vi.mock('@/modules/settings/tabs/browser-use-settings/BrowserUseSettingsTab', () => ({ default: () => null }));
vi.mock('@/modules/settings/tabs/NotificationsSettingsTab', () => ({
  default: ({ notificationPreferences, onNotificationPreferencesChange }: {
    notificationPreferences: NotificationPreferencesState;
    onNotificationPreferencesChange: (value: NotificationPreferencesState) => void;
  }) => (
    <button onClick={() => onNotificationPreferencesChange({
      ...notificationPreferences,
      channels: { ...notificationPreferences.channels, sound: !notificationPreferences.channels.sound },
    })}>Edit notification sound</button>
  ),
}));
vi.mock('@/modules/settings/tabs/tasks-settings/TasksSettingsTab', () => ({ default: () => null }));
vi.mock('@/modules/plugins', () => ({ PluginSettingsTab: () => null }));
vi.mock('@/modules/settings/tabs/AboutTab', () => ({ default: () => null }));
vi.mock('@/modules/settings/tabs/chisa-settings/ChisaSettingsTab', () => ({ default: () => null }));
vi.mock('@/modules/settings/tabs/AppearanceSettingsTab', () => ({
  default: ({ onCodeEditorFontSizeChange, onProjectSortOrderChange }: {
    onCodeEditorFontSizeChange: (value: string) => void;
    onProjectSortOrderChange: (value: 'name' | 'date') => void;
  }) => (
    <div>
      <button onClick={() => onCodeEditorFontSizeChange('18')}>Edit editor font</button>
      <button onClick={() => onProjectSortOrderChange('date')}>Edit project sort</button>
    </div>
  ),
}));

const USER_ID = 'sync-status-owner';
// Mutable fixtures control only the remote HTTP result; public status is always derived by the actual store.
let auth: Auth;
let store: Store;
let saveResults: HttpResult[];
let loadResults: HttpResult[];
let patches: Array<Record<string, unknown>>;
let transactions: UserPreferenceTransaction[];
let serverPreferences: Record<string, unknown>;
let serverRevisions: Record<string, number>;
let notificationWrites: number;
let notificationResults: HttpResult[];
let notificationLoads: HttpResult[];
let notificationBodies: NotificationPreferencesState[];

function token(rotation = 'initial'): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256' })}.${encode({ userId: USER_ID, jti: rotation, iat: 1_700_000_000, exp: 4_102_444_800 })}.signature`;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function loadedPreferences(preferences: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ success: true, preferences, revisions: { ...serverRevisions } }), { status: 200 });
}

function acknowledge(index: number): Response {
  const input = transactions[index]!;
  for (const key of Object.keys(input.updates)) {
    assert.equal(input.expectedRevisions[key], serverRevisions[key] ?? 0);
    serverRevisions[key] = (serverRevisions[key] ?? 0) + 1;
  }
  serverPreferences = { ...serverPreferences, ...input.updates };
  return new Response(JSON.stringify({ success: true, operationId: input.operationId, replayed: false, preferences: input.updates,
    revisions: Object.fromEntries(Object.keys(input.updates).map(key => [key, serverRevisions[key]])) }), { status: 200 });
}

async function advance(milliseconds = 0): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); });
}

async function openSettings(): Promise<void> {
  const { Settings } = await import('@/modules/settings');
  render(<Settings isOpen onClose={() => undefined} initialTab="appearance" />);
  await advance();
}

function assertNoSuccess(): void {
  assert.equal(screen.queryByText('saveStatus.success'), null,
    'an unconfirmed or failed preference must never show the Settings success message');
}

beforeEach(async () => {
  vi.resetModules();
  localStorage.clear();
  sessionStorage.clear();
  vi.useFakeTimers();
  saveResults = [];
  loadResults = [];
  patches = [];
  transactions = [];
  serverPreferences = {};
  serverRevisions = {};
  notificationWrites = 0;
  notificationResults = [];
  notificationLoads = [];
  notificationBodies = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit = {}) => {
    if (String(url).includes('/api/settings/notification-preferences')) {
      if (options.method && options.method !== 'GET') {
        notificationWrites++;
        notificationBodies.push(JSON.parse(String(options.body)) as NotificationPreferencesState);
        const result = notificationResults.shift();
        if (result) return result;
      } else {
        const result = notificationLoads.shift();
        if (result) return result;
      }
      return new Response(JSON.stringify({ success: true, preferences: {
        channels: { inApp: true, webPush: false, desktop: false, sound: true },
        events: { actionRequired: true, stop: true, error: true },
      } }), { status: 200 });
    }
    if (options.method === 'PATCH') {
      const bearer = new Headers(options.headers).get('Authorization');
      assert.equal(bearer, `Bearer ${auth.getAuthSessionSnapshot().token}`);
      assert.equal(url, '/api/user/preferences/transactions');
      const input = JSON.parse(String(options.body)) as UserPreferenceTransaction;
      patches.push(input.updates);
      transactions.push(input);
      return saveResults.shift() ?? acknowledge(transactions.length - 1);
    }
    return loadResults.shift() ?? loadedPreferences(serverPreferences);
  }));
  auth = await import('@/shared/authToken');
  await auth.initializeAuthSession();
  const session = await auth.startAuthSession(token());
  assert.ok(session);
  assert.equal(session.userId, USER_ID);
  auth.acknowledgeAuthSession(session);
  store = await import('@/shared/userSettings');
});

afterEach(() => {
  cleanup();
  store?.resetUserPreferences();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('an editor edit displays unsaved then saving and cannot display saved before its acknowledgment', async () => {
  const response = deferred<Response>();
  saveResults.push(response.promise);
  await openSettings();
  fireEvent.click(screen.getByRole('button', { name: 'Edit editor font' }));

  assert.equal(store.getPreferenceSyncStatus().status, 'unsaved');
  assert.ok(screen.getByText('设置尚未保存'));
  assertNoSuccess();
  await advance(400);
  assert.equal(store.getPreferenceSyncStatus().status, 'saving');
  assert.ok(screen.getByText('正在保存设置'));
  assertNoSuccess();
  assert.equal(patches.length, 1);

  await act(async () => { response.resolve(acknowledge(transactions.length - 1)); });
  await advance();
  assert.equal(store.getPreferenceSyncStatus().status, 'saved');
  assert.equal(screen.queryByText('设置尚未保存'), null);
  assert.equal(screen.queryByText('正在保存设置'), null);
  assert.ok(screen.getByText('saveStatus.success'), 'the editor acknowledgment must be visible without an unrelated save');
});

test('a failed dirty field cannot show success even if a separate notification save succeeds; retry waits for 2xx', async () => {
  saveResults.push(new Response('{}', { status: 422 }));
  await openSettings();
  fireEvent.click(screen.getByRole('button', { name: 'Edit editor font' }));
  await advance(400);
  assert.equal(store.getPreferenceSyncStatus().status, 'failed');
  fireEvent.click(screen.getByRole('button', { name: 'Open notifications' }));
  fireEvent.click(screen.getByRole('button', { name: 'Edit notification sound' }));
  await advance(1000);
  assert.equal(notificationWrites, 1, 'a real independent notification save has succeeded');
  assert.equal(patches.length, 1, 'an independent notification save must not rewrite untouched user preferences');

  assert.equal(store.getPreferenceSyncStatus().status, 'failed');
  assert.ok(store.getPreferenceSyncStatus().pendingKeys.includes('codeEditorSettings'));
  assert.ok(screen.getByText('设置未保存，请重试'));
  assertNoSuccess();

  const response = deferred<Response>();
  saveResults.push(response.promise);
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  await advance();
  assert.equal(store.getPreferenceSyncStatus().status, 'saving');
  assert.ok(screen.getByText('正在保存设置'));
  assertNoSuccess();
  assert.equal(patches.length, 2);
  assert.deepEqual(Object.keys(patches[1]), ['codeEditorSettings'], 'retry must send only the retained failed field');
  await act(async () => { response.resolve(acknowledge(transactions.length - 1)); });
  await advance();
  assert.equal(store.getPreferenceSyncStatus().status, 'saved');
  assert.ok(screen.getByText('saveStatus.success'));
  assert.equal(screen.queryByText('设置未保存，请重试'), null);
  assert.equal(screen.queryByRole('button', { name: '重试' }), null);
});

test('notification failure remains visible across renders until an explicit successful retry', async () => {
  notificationResults.push(new Response('{}', { status: 503 }));
  await openSettings();
  fireEvent.click(screen.getByRole('button', { name: 'Open notifications' }));
  fireEvent.click(screen.getByRole('button', { name: 'Edit notification sound' }));
  assert.ok(screen.getByText('正在保存设置'));
  assertNoSuccess();
  await advance(500);
  assert.equal(notificationWrites, 1);
  assert.ok(screen.getByText('通知设置未保存，请重试'));
  assertNoSuccess();
  await advance(2500);
  assert.ok(screen.getByText('通知设置未保存，请重试'));
  const retry = deferred<Response>();
  notificationResults.push(retry.promise);
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  await advance();
  assert.equal(notificationWrites, 2);
  assert.ok(screen.getByText('正在保存设置'));
  assertNoSuccess();
  await act(async () => { retry.resolve(new Response('{"success":true}')); });
  await advance();
  assert.ok(screen.getByText('saveStatus.success'));
  assert.equal(screen.queryByText('通知设置未保存，请重试'), null);
});

test('notification writes are serialized and an older acknowledgment cannot confirm a newer edit', async () => {
  const first = deferred<Response>();
  const second = deferred<Response>();
  notificationResults.push(first.promise, second.promise);
  await openSettings();
  fireEvent.click(screen.getByRole('button', { name: 'Open notifications' }));
  fireEvent.click(screen.getByRole('button', { name: 'Edit notification sound' }));
  await advance(500);
  assert.equal(notificationWrites, 1);
  assert.equal(notificationBodies[0].channels.sound, false);
  fireEvent.click(screen.getByRole('button', { name: 'Edit notification sound' }));
  await advance(500);
  assert.equal(notificationWrites, 1, 'the newer value must wait until the old request settles');
  await act(async () => { first.resolve(new Response('{"success":true}')); });
  await advance();
  assert.equal(notificationWrites, 2);
  assert.equal(notificationBodies[1].channels.sound, true);
  assert.ok(screen.getByText('正在保存设置'));
  assertNoSuccess();
  await act(async () => { second.resolve(new Response('{"success":true}')); });
  await advance();
  assert.ok(screen.getByText('saveStatus.success'));
});

test('notification hydration JSON cannot overwrite a user edit that already saved', async () => {
  const body = deferred<unknown>();
  const response = new Response('{}');
  vi.spyOn(response, 'json').mockImplementation(() => body.promise);
  notificationLoads.push(response);
  await openSettings();
  fireEvent.click(screen.getByRole('button', { name: 'Open notifications' }));
  fireEvent.click(screen.getByRole('button', { name: 'Edit notification sound' }));
  await advance(500);
  assert.equal(notificationBodies[0].channels.sound, false);
  await act(async () => { body.resolve({ success: true, preferences: { channels: { sound: true } } }); });
  fireEvent.click(screen.getByRole('button', { name: 'Edit notification sound' }));
  await advance(500);
  assert.equal(notificationBodies[1].channels.sound, true, 'the edited false value must survive the late load');
});

test('notification response body and late controls cannot write a replacement account', async () => {
  const body = deferred<unknown>();
  const response = new Response('{}');
  vi.spyOn(response, 'json').mockImplementation(() => body.promise);
  notificationResults.push(response);
  await openSettings();
  fireEvent.click(screen.getByRole('button', { name: 'Open notifications' }));
  fireEvent.click(screen.getByRole('button', { name: 'Edit notification sound' }));
  await advance(500);
  await act(async () => {
    const next = await auth.startAuthSession(token('replacement'));
    assert.ok(next);
    auth.acknowledgeAuthSession(next);
    body.resolve({ success: true });
  });
  fireEvent.click(screen.getByRole('button', { name: 'Edit notification sound' }));
  await advance(1000);
  assert.equal(notificationWrites, 1);
  assertNoSuccess();
});

test('an HTTP failure shows automatic retry progress instead of a dirty success state', async () => {
  const second = deferred<Response>();
  saveResults.push(new Response('{}', { status: 503 }), second.promise);
  await openSettings();
  fireEvent.click(screen.getByRole('button', { name: 'Edit editor font' }));
  await advance(400);

  assert.equal(store.getPreferenceSyncStatus().status, 'retrying');
  assert.ok(screen.getByText('保存失败，等待重试'));
  assert.ok(screen.getByRole('button', { name: '重试' }));
  assertNoSuccess();
  await advance(999);
  assert.equal(patches.length, 1);
  await advance(1);
  assert.equal(patches.length, 2);
  assert.equal(store.getPreferenceSyncStatus().status, 'saving');
  assert.ok(screen.getByText('正在保存设置'));
  assertNoSuccess();
  await act(async () => { second.resolve(acknowledge(transactions.length - 1)); });
  await advance();
  assert.equal(store.getPreferenceSyncStatus().status, 'saved');
});

test('a failed hydration remains visible, retains the local editor mirror and retries the GET', async () => {
  act(() => { store.writeUserPreference('codeEditorSettings', { fontSize: '16' }); });
  await advance(400);
  assert.equal(store.getPreferenceSyncStatus().status, 'saved');
  loadResults.push(new Response('{}', { status: 503 }));
  await act(async () => { await store.hydrateUserPreferences(); });
  await openSettings();

  assert.equal(store.getPreferenceSyncStatus().status, 'failed');
  assert.ok(store.getPreferenceSyncStatus().hydrationError);
  assert.deepEqual(store.readUserPreference('codeEditorSettings', null), { fontSize: '16' });
  assert.ok(screen.getByText('设置恢复失败，本机编辑已保留'));
  assertNoSuccess();
  loadResults.push(loadedPreferences({ codeEditorSettings: { fontSize: '16' } }));
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  await advance();

  assert.equal(store.getPreferenceSyncStatus().hydrationError, null);
  assert.equal(store.getPreferenceSyncStatus().status, 'saved');
  assert.equal(screen.queryByText('设置恢复失败，本机编辑已保留'), null);
});

test('401 pauses saving, does not retry the rejected identity and resumes only after a credential revision', async () => {
  saveResults.push(new Response('{}', { status: 401 }));
  await openSettings();
  fireEvent.click(screen.getByRole('button', { name: 'Edit editor font' }));
  await advance(400);

  assert.equal(store.getPreferenceSyncStatus().status, 'paused');
  assert.ok(screen.getByText('登录恢复后继续保存'));
  assertNoSuccess();
  act(() => { store.retryUserPreferences(); });
  await advance(1000);
  assert.equal(patches.length, 1, 'manual retry must not loop with the rejected credential');
  assert.equal(store.getPreferenceSyncStatus().status, 'paused');

  const response = deferred<Response>();
  saveResults.push(response.promise);
  await act(async () => {
    assert.equal(await auth.storeAuthToken(token('refreshed'), auth.getAuthSessionSnapshot()), true);
  });
  await advance(400);
  assert.equal(patches.length, 2);
  assert.equal(store.getPreferenceSyncStatus().status, 'saving');
  assert.ok(screen.getByText('正在保存设置'));
  assertNoSuccess();
  await act(async () => { response.resolve(acknowledge(transactions.length - 1)); });
  await advance();
  assert.equal(store.getPreferenceSyncStatus().status, 'saved');
  assert.equal(screen.queryByText('登录恢复后继续保存'), null);
});
