import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';

import { i18n } from '@/modules/i18n';
import { PluginsProvider, usePlugins } from '@/modules/plugins/context/PluginsContext';
import PluginSettingsTab from '@/modules/plugins/PluginSettingsTab';
import type { Plugin } from '@/shared/types';

vi.mock('@/modules/auth', () => ({ useAuth: () => ({ user: { id: 1 }, isLoading: false }) }));
const identity = vi.hoisted(() => ({ sessionInstanceId: 'plugin-api-test', serverKey: 'https://fixture.test', userId: '1', phase: 'ready', token: 'fixture' }));
vi.mock('@/modules/auth-session', () => ({ getAuthSessionSnapshot: () => identity, isCurrentAuthSession: () => true,
  subscribeToAuthSession: () => () => {}, dispatchWithAuthSession: async (_captured: unknown, operation: (snapshot: unknown) => Promise<unknown>) => ({ operation: operation(identity), snapshot: identity }),
  getAuthSessionVersion: () => 0, getStoredAuthToken: () => 'fixture', initializeAuthSession: async () => identity,
  storeAuthToken: async () => true, expireAuthSession: async () => true }));
type StubbedReply = { status: number; body: unknown };
const envelope = (code: string, message: string, details: unknown) => ({ success: false, error: { code, message, details } });
const installedPlugin: Plugin = {
  name: 'private-demo', displayName: 'Private Demo', version: '1.0.0', description: '', author: '',
  icon: '', type: 'module', slot: 'tab', entry: 'index.js', server: null,
  permissions: [], enabled: true, serverRunning: false, dirName: 'private-demo', repoUrl: null,
};
function stubPluginsApi(replies: Record<string, StubbedReply>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const reply = replies[url] ?? { status: 404, body: { error: 'Not found' } };
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'Content-Type': 'application/json' } });
  }));
}

describe('bundled plugin calls preserve structured backend diagnostics', () => {
  beforeEach(async () => { localStorage.clear(); await i18n.changeLanguage('en'); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('shows a structured toggle failure while keeping the bundled switch available', async () => {
    const message = 'Plugin server could not be stopped';
    stubPluginsApi({
      '/api/plugins': { status: 200, body: { plugins: [installedPlugin] } },
      '/api/plugins/private-demo/enable': { status: 500, body: envelope('PLUGIN_STOP_FAILED', message, { pid: 42 }) },
    });
    render(<PluginsProvider><PluginSettingsTab /></PluginsProvider>);
    fireEvent.click(await screen.findByRole('switch', { name: 'Private Demo · Disable' }));
    expect(await screen.findByText(message)).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Private Demo · Disable' })).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('exposes an unreadable catalog message as renderable text', async () => {
    const message = 'Plugins directory is not readable';
    stubPluginsApi({ '/api/plugins': { status: 500, body: envelope('PLUGINS_UNREADABLE', message, { path: 'plugins' }) } });
    const { result } = renderHook(() => usePlugins(), { wrapper: PluginsProvider });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.pluginsError).toBe(message);
  });
});
