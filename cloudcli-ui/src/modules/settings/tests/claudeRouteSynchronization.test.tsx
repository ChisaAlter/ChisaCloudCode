import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import { ClaudeAccountsPanel, ClaudeAccountsProvider, ClaudeUsageTrigger } from '@/modules/claude-accounts';
import { ModelConnectionsSection } from '@/modules/settings/tabs/models-settings/ModelConnectionsSection';
import { api, readApiJson } from '@/shared/api';
import type { ClaudeAccountsState } from '@/shared/types';

function response<T>(data: T) { return Response.json({ success: true, data }); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
let current: ClaudeAccountsState;
let activeConnection: string | null;
const connections = () => ({ activeId: activeConnection, connections: [{ id: 'gateway', name: 'Private API', baseUrl: 'https://gateway.example.test', model: 'model', hasApiKey: true }] });

beforeEach(async () => {
  await i18n.changeLanguage('zh-CN');
  activeConnection = null;
  current = { runtime: { id: 'server', label: '当前服务器' }, activeId: 'a', route: { kind: 'subscription', label: 'Work', accountId: 'a' }, defaultAccount: null,
    accounts: ['a', 'b'].map((id, index) => ({ id, name: index ? 'Personal' : 'Work', email: `${id}@example.test`, organizationName: null, plan: 'Max', needsSignIn: false,
      createdAt: Date.now(), updatedAt: Date.now(), usage: { status: 'ok', windows: [], updatedAt: Date.now(), checkedAt: Date.now(), error: null, stale: false } })) };
  vi.spyOn(api.user, 'savePreferences').mockResolvedValue(response({}));
  vi.spyOn(api.providers.claudeAccounts, 'state').mockImplementation(async () => response(current));
  vi.spyOn(api.providers.claudeAccounts, 'refresh').mockImplementation(async () => response(current));
});
afterEach(() => vi.restoreAllMocks());

test('real API mutations update the sidebar route and subscription selection clears the model connection settings', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
    const url = String(input);
    if (url === '/api/providers/claude/connections' && !options?.method) return response(connections());
    if (url === '/api/providers/claude/connections/active') {
      activeConnection = JSON.parse(String(options?.body)).id;
      current = { ...current, route: { kind: 'api', label: 'Private API', accountId: null } };
      return response(connections());
    }
    if (url === '/api/providers/claude/accounts/active') {
      const id = JSON.parse(String(options?.body)).id;
      activeConnection = null;
      current = { ...current, activeId: id, route: { kind: 'subscription', label: 'Work', accountId: id } };
      return response(current);
    }
    throw new Error(`Unexpected request ${url}`);
  });
  render(<ClaudeAccountsProvider><ClaudeUsageTrigger /><ModelConnectionsSection /></ClaudeAccountsProvider>);
  await screen.findByText('Private API');
  const trigger = screen.getByRole('button', { name: '打开 Claude 账号与额度' });
  expect(trigger.textContent).toContain('Work');
  fireEvent.click(screen.getByRole('button', { name: '启用' }));
  await waitFor(() => expect(trigger.textContent).toContain('Private API'));
  expect(screen.getByText('使用中')).toBeTruthy();
  fireEvent.click(trigger);
  const dialog = await screen.findByRole('dialog', { name: 'Claude 账号与额度' });
  fireEvent.click(within(dialog).getByRole('button', { name: '切换到 Work' }));
  await waitFor(() => expect(trigger.textContent).toContain('Work'));
  await waitFor(() => expect(screen.queryByText('使用中')).toBeNull());
  expect(activeConnection).toBeNull();
});

test('a connection change during an account mutation is reread after the mutation settles', async () => {
  const selection = deferred<Response>();
  const initialRead = vi.mocked(api.providers.claudeAccounts.state);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
    if (String(input) === '/api/providers/claude/accounts/active') {
      const id = JSON.parse(String(options?.body)).id;
      current = { ...current, activeId: id, route: { kind: 'subscription', label: 'Personal', accountId: id } };
      return selection.promise;
    }
    if (String(input) === '/api/providers/claude/connections/active') {
      current = { ...current, route: { kind: 'api', label: 'Private API', accountId: null } };
      return response(connections());
    }
    throw new Error(`Unexpected request ${String(input)}`);
  });
  render(<ClaudeAccountsProvider><ClaudeUsageTrigger /><ClaudeAccountsPanel /></ClaudeAccountsProvider>);
  fireEvent.click(await screen.findByRole('button', { name: '切换到 Personal' }));
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: '切换到 Personal' }).disabled).toBe(true));
  const beforeMutation = { ...current };
  const readsBeforeEvent = initialRead.mock.calls.length;
  await act(async () => { await readApiJson(await api.providers.connections.activate('gateway')); });
  expect(initialRead.mock.calls.length).toBe(readsBeforeEvent);
  await act(async () => { selection.resolve(response(beforeMutation)); });
  await waitFor(() => expect(screen.getByRole('button', { name: '打开 Claude 账号与额度' }).textContent).toContain('Private API'));
  expect(initialRead.mock.calls.length).toBeGreaterThan(readsBeforeEvent);
});
