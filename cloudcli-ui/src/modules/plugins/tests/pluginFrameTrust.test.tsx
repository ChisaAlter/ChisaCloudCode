import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import PluginTabContent from '@/modules/plugins/PluginTabContent';
import { api } from '@/shared/api';
import type { Plugin } from '@/shared/types';

const identity = vi.hoisted(() => ({ snapshot: { sessionInstanceId: 'trusted-login', serverKey: 'https://fixture.test', userId: '1', token: 'fixture', phase: 'ready' } }));
const catalog = vi.hoisted(() => ({ plugins: [] as unknown[] }));
vi.mock('@/modules/auth-session', () => ({ getAuthSessionSnapshot: () => identity.snapshot,
  isCurrentAuthSession: (captured: { sessionInstanceId: string }) => captured.sessionInstanceId === identity.snapshot.sessionInstanceId,
  subscribeToAuthSession: () => () => {}, dispatchWithAuthSession: async (_captured: unknown, operation: (snapshot: unknown) => Promise<unknown>) => ({ snapshot: identity.snapshot, operation: operation(identity.snapshot) }) }));
vi.mock('@/modules/plugins/context/PluginsContext', () => ({ usePlugins: () => catalog }));
vi.mock('@/shared/context/ThemeContext', () => ({ useTheme: () => ({ isDarkMode: false }) }));
vi.mock('@/shared/context/WorkspaceScopeContext', () => ({ useWorkspaceScope: () => null }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (_key: string, values: { error: string }) => values.error }) }));
vi.mock('@/shared/api', () => ({ api: { plugins: { asset: vi.fn(), rpc: vi.fn(), webSocketUrl: vi.fn() } } }));
function plugin(trusted = true): Plugin {
  return { name: 'claude-usage', displayName: 'Claude usage', entry: 'index.js', version: '1', description: '', author: '', icon: '', type: 'module', slot: 'tab',
    server: 'server.js', enabled: true, serverRunning: true, dirName: 'claude-usage', repoUrl: null, permissions: ['host:context', 'host:rpc'],
    security: { model: 'trusted-only', digest: `sha256:${'a'.repeat(64)}`, source: { kind: 'bundled', location: 'application:builtin/claude-usage', version: '1' },
      permissions: ['host:context', 'host:rpc'], trusted, permitted: trusted, reviewRequired: !trusted, releaseTrusted: true, approvedOwnerId: null } };
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

test('untrusted and unpermitted plugins do not fetch or execute a bundle', async () => {
  catalog.plugins = [plugin(false)];
  render(<PluginTabContent pluginName="claude-usage" selectedProject={null} selectedSession={null} />);
  expect((await screen.findByRole('alert')).textContent).toMatch(/not been explicitly trusted/);
  expect(document.querySelector('iframe')).toBeNull(); expect(api.plugins.asset).not.toHaveBeenCalled();
});

test('normal trusted usage mounts a bound bridge; retained bridge is revoked on logout', async () => {
  catalog.plugins = [plugin()];
  vi.mocked(api.plugins.asset).mockResolvedValue(Response.json({}));
  vi.mocked(api.plugins.rpc).mockResolvedValue(Response.json({ ok: true }));
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:fixture'), revokeObjectURL: vi.fn() }));
  const view = render(<PluginTabContent pluginName="claude-usage" selectedProject={null} selectedSession={null} />);
  const frame = document.querySelector('iframe')!;
  await act(async () => { frame.dispatchEvent(new Event('load')); });
  await waitFor(() => expect((frame.contentWindow as unknown as { chisaPluginHostApi?: unknown }).chisaPluginHostApi).toBeTruthy());
  const host = (frame.contentWindow as unknown as { chisaPluginHostApi: { context: unknown; rpc(method: string, path: string): Promise<unknown> } }).chisaPluginHostApi;
  expect(await host.rpc('GET', 'live')).toEqual({ ok: true });
  expect(host).not.toHaveProperty('token'); expect(host).not.toHaveProperty('webSocketUrl');
  view.unmount();
  expect(() => host.rpc('GET', 'live')).toThrow(/session changed|frame ended/);
  expect(api.plugins.rpc).toHaveBeenCalledTimes(1);
  vi.unstubAllGlobals();
});
