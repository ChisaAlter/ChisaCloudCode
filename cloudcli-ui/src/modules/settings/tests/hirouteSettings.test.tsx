import { act, fireEvent, render as renderComponent, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import { ClaudeAccountsProvider } from '@/modules/claude-accounts';
import { api } from '@/shared/api';
import { acknowledgeAuthSession, clearAuthToken, getAuthSessionSnapshot, initializeAuthSession, startAuthSession, synchronizeAuthSession } from '@/shared/authToken';
import type { ClaudeAccountsState } from '@/shared/types';
import AccountContent from '@/modules/settings/tabs/agents-settings/sections/content/AccountContent';
import { HiRouteSettingsSection } from '@/modules/settings/tabs/agents-settings/sections/content/HiRouteSettingsSection';

const STORED_SETTINGS = { enabled: true, baseUrl: 'https://router.example.com', routeModel: 'route-default', hasAuthToken: true };
const fetchMock = vi.fn<typeof fetch>();
// Reuse real translations without triggering account preference writes on language changes.
const testI18n = i18n.cloneInstance({ lng: 'en' });

function render(component: ReactElement) {
  return renderComponent(component, { wrapper: ({ children }) => <I18nextProvider i18n={testI18n}>{children}</I18nextProvider> });
}

function settingsResponse(overrides: Partial<typeof STORED_SETTINGS> = {}) {
  return new Response(JSON.stringify({ success: true, data: { ...STORED_SETTINGS, ...overrides } }), { status: 200 });
}

function saveButton() {
  return screen.getByRole<HTMLButtonElement>('button', { name: 'Save HiRoute settings' });
}

function tokenInput() {
  return screen.getByLabelText<HTMLInputElement>('HiRoute auth token', { exact: false });
}

beforeEach(async () => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  localStorage.clear();
  sessionStorage.clear();
  await initializeAuthSession();
  await synchronizeAuthSession();
  const payload = btoa(JSON.stringify({ userId: 'hiroute-owner', exp: Math.floor(Date.now() / 1000) + 600 })).replace(/=/g, '');
  const session = await startAuthSession(`header.${payload}.signature`, getAuthSessionSnapshot());
  expect(session).toMatchObject({ phase: 'ready', userId: 'hiroute-owner', storageMode: 'window' });
  acknowledgeAuthSession(session!);
  expect(localStorage.getItem('auth-token')).toBeNull();
});

afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await clearAuthToken(); });

test('loads only token presence through the authenticated helper and retains it on an empty-token save', async () => {
  let resolve!: (response: Response) => void;
  fetchMock.mockReturnValueOnce(new Promise<Response>(done => { resolve = done; }));
  render(<HiRouteSettingsSection />);
  expect(screen.getByRole('status').textContent).toBe('Loading HiRoute settings…');
  expect(screen.queryByRole('button', { name: 'Save HiRoute settings' })).toBeNull();
  await act(async () => { resolve(settingsResponse()); });
  expect(tokenInput().value).toBe('');
  expect(tokenInput().type).toBe('password');
  expect(screen.getByText('A token is saved. Its value is never returned to this form.')).toBeTruthy();
  expect(fetchMock.mock.calls[0][0]).toBe('/api/providers/claude/hiroute');
  expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('Authorization')).toBe(`Bearer ${getAuthSessionSnapshot().token}`);
  fetchMock.mockResolvedValueOnce(settingsResponse({ routeModel: 'route-next' }));
  fireEvent.change(screen.getByLabelText('HiRoute route model'), { target: { value: ' route-next ' } });
  fireEvent.click(saveButton());
  await screen.findByText(/HiRoute settings saved/);
  expect(fetchMock.mock.calls[1][0]).toBe('/api/providers/claude/hiroute');
  expect(fetchMock.mock.calls[1][1]?.method).toBe('PUT');
  expect(JSON.parse(fetchMock.mock.calls[1][1]?.body as string)).toEqual({
    enabled: true, baseUrl: STORED_SETTINGS.baseUrl, routeModel: 'route-next',
  });
  expect(tokenInput().value).toBe('');
  expect(screen.getByText(/next Claude turn uses HiRoute/)).toBeTruthy();
  expect(screen.getByText(/does not activate automatically when quota runs out/)).toBeTruthy();
});

test('saves a replacement secret without a token in the response, clears the field, and never persists it in browser storage', async () => {
  fetchMock.mockResolvedValueOnce(settingsResponse({ enabled: false, hasAuthToken: false }));
  render(<HiRouteSettingsSection />);
  await screen.findByText('No token is saved.');
  const persist = vi.spyOn(Storage.prototype, 'setItem');
  fireEvent.change(tokenInput(), { target: { value: 'new-private-token' } });
  fireEvent.click(screen.getByLabelText('Use HiRoute for Claude'));
  let resolve!: (response: Response) => void;
  fetchMock.mockReturnValueOnce(new Promise<Response>(done => { resolve = done; }));
  fireEvent.click(saveButton());
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Saving HiRoute settings…' }).closest('fieldset')?.disabled).toBe(true);
  await act(async () => { resolve(settingsResponse()); });
  await screen.findByText(/HiRoute settings saved/);
  expect(JSON.parse(fetchMock.mock.calls[1][1]?.body as string).authToken).toBe('new-private-token');
  expect(tokenInput().value).toBe('');
  expect(persist).not.toHaveBeenCalled();
  expect(localStorage.getItem('auth-token')).toBeNull();
  expect(getAuthSessionSnapshot()).toMatchObject({ phase: 'ready', userId: 'hiroute-owner' });
  expect(JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } })).not.toContain('new-private-token');
  expect(document.body.textContent).not.toContain('new-private-token');
});

test('clears a saved token only by explicit choice while disabled', async () => {
  fetchMock.mockResolvedValueOnce(settingsResponse());
  render(<HiRouteSettingsSection />);
  await screen.findByText(/A token is saved/);
  fireEvent.click(screen.getByLabelText('Clear the saved token on save (disable HiRoute first)'));
  fireEvent.click(saveButton());
  expect(screen.getByRole('alert').textContent).toContain('Disable HiRoute before clearing its token');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByLabelText('Use HiRoute for Claude'));
  fetchMock.mockResolvedValueOnce(settingsResponse({ enabled: false, hasAuthToken: false }));
  fireEvent.click(saveButton());
  await screen.findByText('No token is saved.');
  expect(JSON.parse(fetchMock.mock.calls[1][1]?.body as string)).toMatchObject({ enabled: false, authToken: null });
});

test('requires complete enabled settings and rejects non-HTTP or message-endpoint URLs', async () => {
  fetchMock.mockResolvedValueOnce(settingsResponse({ hasAuthToken: false }));
  render(<HiRouteSettingsSection />);
  await screen.findByText('No token is saved.');
  fireEvent.click(saveButton());
  expect(screen.getByRole('alert').textContent).toContain('To enable HiRoute');
  fireEvent.change(tokenInput(), { target: { value: 'private-token' } });
  for (const baseUrl of ['file:///tmp/router', 'https://router.example.com/v1/messages', 'not-a-url']) {
    fireEvent.change(screen.getByLabelText('HiRoute base URL', { exact: false }), { target: { value: baseUrl } });
    fireEvent.click(saveButton());
    expect(screen.getByRole('alert').textContent).toContain('Enter a valid HTTP or HTTPS base URL');
  }
  expect(fetchMock.mock.calls.filter(call => String(call[0]).includes('/hiroute'))).toHaveLength(1);
});

test('failed initial loading prevents saves and supports an explicit retry', async () => {
  fetchMock.mockRejectedValueOnce(new Error('offline'));
  render(<HiRouteSettingsSection />);
  await screen.findByRole('alert');
  expect(screen.queryByRole('button', { name: 'Save HiRoute settings' })).toBeNull();
  fetchMock.mockResolvedValueOnce(settingsResponse());
  fireEvent.click(screen.getByRole('button', { name: 'Retry loading HiRoute settings' }));
  await screen.findByText(/A token is saved/);
  expect(saveButton()).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test.each(['http', 'envelope', 'network'])('a %s save failure preserves edits and shows no success or raw server secret', async failure => {
  fetchMock.mockResolvedValueOnce(settingsResponse());
  render(<HiRouteSettingsSection />);
  await screen.findByText(/A token is saved/);
  fireEvent.change(tokenInput(), { target: { value: 'retry-private-token' } });
  if (failure === 'network') fetchMock.mockRejectedValueOnce(new Error('retry-private-token'));
  else fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ success: false, error: 'retry-private-token' }), { status: failure === 'http' ? 500 : 200 }));
  fireEvent.click(saveButton());
  await screen.findByRole('alert');
  expect(screen.getByRole('alert').textContent).toBe('Could not save HiRoute settings. Check your connection and try again.');
  expect(tokenInput().value).toBe('retry-private-token');
  expect(screen.queryByText(/HiRoute settings saved/)).toBeNull();
  expect(document.body.textContent).not.toContain('retry-private-token');
  await waitFor(() => expect(saveButton().closest('fieldset')?.disabled).toBe(false));
});

test('the account section loads HiRoute only for Claude', async () => {
  const authStatus = { authenticated: true, loading: false, email: null, method: null, error: null };
  const { rerender } = render(<AccountContent agent="codex" authStatus={authStatus} onLogin={vi.fn()} />);
  expect(screen.queryByRole('region', { name: 'HiRoute for Claude' })).toBeNull();
  expect(fetchMock.mock.calls.map(call => String(call[0])).every(url => url.includes('/cli'))).toBe(true);
  fetchMock.mockClear();
  // App owns this provider; keep its real account panel mounted beside HiRoute with separate endpoint fixtures.
  const accounts: ClaudeAccountsState = { runtime: { id: 'test', label: 'Test runtime' }, activeId: null, defaultAccount: null, accounts: [], route: { kind: 'default', label: 'Default Claude', accountId: null } };
  vi.spyOn(api.providers.claudeAccounts, 'state').mockImplementation(async () => Response.json({ success: true, data: accounts }));
  vi.spyOn(api.providers.claudeAccounts, 'refresh').mockImplementation(async () => Response.json({ success: true, data: accounts }));
  fetchMock.mockImplementation(async url => String(url).includes('/hiroute') ? settingsResponse() : Response.json({ success: true, data: { installed: false } }));
  rerender(<ClaudeAccountsProvider><AccountContent agent="claude" authStatus={authStatus} onLogin={vi.fn()} /></ClaudeAccountsProvider>);
  await screen.findByText(/A token is saved/);
  expect(screen.getByRole('region', { name: 'Claude accounts and quota' })).toBeTruthy();
  expect(fetchMock.mock.calls.filter(call => String(call[0]).includes('/hiroute'))).toHaveLength(1);
});
