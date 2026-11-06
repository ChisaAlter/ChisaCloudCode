import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import PluginSettingsTab from '@/modules/plugins/PluginSettingsTab';
import { api } from '@/shared/api';

const identity = vi.hoisted(() => ({ sessionInstanceId: 'approval-login', serverKey: 'https://fixture.test', userId: '1', phase: 'ready' }));
const catalog = vi.hoisted(() => ({ plugins: [] as unknown[], loading: false, pluginsError: null, togglePlugin: vi.fn() }));
vi.mock('@/modules/auth-session', () => ({ getAuthSessionSnapshot: () => identity, isCurrentAuthSession: (session: typeof identity) => session.sessionInstanceId === identity.sessionInstanceId, subscribeToAuthSession: () => () => {} }));
vi.mock('@/modules/plugins/context/PluginsContext', () => ({ usePlugins: () => catalog }));
vi.mock('@/modules/plugins/PluginIcon', () => ({ default: () => null }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key.endsWith('.enable') ? 'Enable' : key.endsWith('.disable') ? 'Disable' : key }) }));
vi.mock('@/shared/api', () => ({ readApiErrorMessage: (data: { error?: string }) => data.error, api: { plugins: { review: vi.fn() } } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

test('community source, version, digest and permissions are visible before explicit consent grants execution', async () => {
  const plugin = { name: 'community', displayName: 'Community example', version: '2.0', description: 'example', enabled: false, icon: '',
    security: { model: 'trusted-only', digest: `sha256:${'a'.repeat(64)}`, source: { kind: 'local', location: 'local:community', version: '2.0' }, permissions: ['backend:process', 'host:rpc'], trusted: false, permitted: false } };
  catalog.plugins = [plugin];
  vi.mocked(api.plugins.review).mockResolvedValue(Response.json(plugin));
  catalog.togglePlugin.mockResolvedValue({ success: true, error: null });
  render(<PluginSettingsTab />);
  fireEvent.click(screen.getByRole('switch', { name: 'Community example · Enable' }));
  await screen.findByRole('region', { name: 'Plugin trust review' });
  expect(screen.getAllByText(/local:community/).length).toBeGreaterThan(0);
  expect(screen.getByText(plugin.security.digest)).toBeTruthy(); expect(screen.getByText('backend:process')).toBeTruthy();
  const approve = screen.getByRole<HTMLButtonElement>('button', { name: 'Trust and enable this version' });
  expect(approve.disabled).toBe(true); expect(catalog.togglePlugin).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('checkbox', { name: /I trust this exact source/ })); fireEvent.click(approve);
  expect(catalog.togglePlugin).toHaveBeenCalledWith('community', true, { confirmed: true, expectedDigest: plugin.security.digest, grantedPermissions: plugin.security.permissions });
});
