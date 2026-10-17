import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { ClaudeUsageContent } from '@/modules/plugins/ClaudeUsageContent';
import '@/modules/i18n';
import { api } from '@/shared/api';

const state = vi.hoisted(() => ({ dark: false, user: { id: 1, username: 'first' } }));
vi.mock('@/modules/auth', () => ({ useAuth: () => ({ user: state.user }) }));
vi.mock('@/shared/context/ThemeContext', () => ({ useTheme: () => ({ isDarkMode: state.dark }) }));
vi.mock('@/modules/plugins/context/PluginsContext', () => ({
  usePlugins: () => ({ plugins: [{ name: 'claude-usage', enabled: true }], loading: false, pluginsError: null }),
}));

const live = {
  plan: 'max', tier: 'default_claude_max_5x', limits: [
    { kind: 'session', label: 'Session (5h)', percent: 100, severity: 'critical', resetsAt: '2026-10-16T05:29:59.733Z', model: null },
    { kind: 'weekly_all', label: 'Weekly (all models)', percent: 9, severity: 'normal', resetsAt: null, model: null },
  ],
};
const tokens = { input: 100, output: 200, cacheCreate: 300, cacheRead: 400 };
const history = {
  daily: [{ date: '2026-10-16', tokens, cost: 1.25 }],
  byModel: [{ model: 'claude-sonnet', tokens, cost: 1.25 }],
  byProject: [{ project: 'usage-example', tokens, cost: 1.25 }],
  totals: { tokens, cost: 1.25, sessions: 2, messages: 3 },
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => { vi.restoreAllMocks(); state.dark = false; state.user = { id: 1, username: 'first' }; });

test('the real account usage entry renders before its server replies without a remote module or iframe', async () => {
  const liveReply = deferred<Response>();
  const historyReply = deferred<Response>();
  const asset = vi.spyOn(api.plugins, 'asset');
  const rpc = vi.spyOn(api.plugins, 'rpc').mockImplementation((_plugin, _method, path) =>
    path === 'live' ? liveReply.promise : historyReply.promise);
  const view = render(<ClaudeUsageContent />);

  expect(screen.getByText('Claude Usage')).toBeTruthy();
  expect(screen.getByRole('button', { name: /refresh/ })).toBeTruthy();
  expect(screen.getByText('Loading…')).toBeTruthy();
  expect(view.container.querySelector('iframe')).toBeNull();
  expect(asset).not.toHaveBeenCalled();
  expect(rpc.mock.calls).toEqual([
    ['claude-usage', 'GET', 'live', undefined],
    ['claude-usage', 'GET', 'history?days=30', undefined],
  ]);

  await act(async () => { liveReply.resolve(Response.json(live)); historyReply.resolve(Response.json(history)); });
  expect(screen.getByText('Session (5h)')).toBeTruthy();
  expect(screen.getByText('Weekly (all models)')).toBeTruthy();
  expect(screen.getByText(/100%/)).toBeTruthy();
  expect(screen.getByText(/9%/)).toBeTruthy();
  expect(screen.getByText('claude-sonnet')).toBeTruthy();
  expect(screen.getByText('usage-example')).toBeTruthy();
  expect(screen.getByText('daily tokens (30 days)')).toBeTruthy();
});

test('refresh shows VPS errors beside independent history and can load the next successful result', async () => {
  let unavailable = true;
  const rpc = vi.spyOn(api.plugins, 'rpc').mockImplementation(async (_plugin, _method, path) => {
    if (path !== 'live') return Response.json(history);
    return unavailable
      ? Response.json({ error: { code: 'UNAVAILABLE', message: 'Server usage temporarily unavailable' } }, { status: 503 })
      : Response.json(live);
  });
  render(<ClaudeUsageContent />);
  expect(await screen.findByText('⚠ Server usage temporarily unavailable')).toBeTruthy();
  expect(screen.getByText('usage-example')).toBeTruthy();
  unavailable = false;
  fireEvent.click(screen.getByRole('button', { name: /refresh/ }));
  expect(await screen.findByText('Session (5h)')).toBeTruthy();
  expect(screen.queryByText('⚠ Server usage temporarily unavailable')).toBeNull();
  expect(rpc).toHaveBeenCalledTimes(4);
});

test('theme changes keep the mounted data while a new account cannot inherit the old pending result', async () => {
  const oldLive = deferred<Response>();
  const oldHistory = deferred<Response>();
  const newLive = deferred<Response>();
  const newHistory = deferred<Response>();
  const rpc = vi.spyOn(api.plugins, 'rpc')
    .mockReturnValueOnce(oldLive.promise).mockReturnValueOnce(oldHistory.promise)
    .mockReturnValueOnce(newLive.promise).mockReturnValueOnce(newHistory.promise);
  const view = render(<ClaudeUsageContent />);
  const originalRoot = screen.getByText('Claude Usage').parentElement?.parentElement;
  state.dark = true;
  view.rerender(<ClaudeUsageContent />);
  expect(screen.getByText('Claude Usage').parentElement?.parentElement).toBe(originalRoot);
  expect(originalRoot?.style.background).toBe('rgb(8, 8, 15)');
  expect(rpc).toHaveBeenCalledTimes(2);

  state.user = { id: 2, username: 'second' };
  view.rerender(<ClaudeUsageContent />);
  expect(screen.getByText('Claude Usage').parentElement?.parentElement).not.toBe(originalRoot);
  await act(async () => { oldLive.resolve(Response.json(live)); oldHistory.resolve(Response.json(history)); });
  expect(screen.queryByText('Session (5h)')).toBeNull();
  expect(screen.queryByText('usage-example')).toBeNull();

  await act(async () => {
    newLive.resolve(Response.json({ plan: null, tier: null, limits: [] }));
    newHistory.resolve(Response.json({ ...history, totals: { ...history.totals, messages: 0 } }));
  });
  await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull());
  expect(screen.getByText('No limit data available.')).toBeTruthy();
  expect(screen.getByText('No Claude Code activity found in the last 30 days.')).toBeTruthy();
});
