import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import ChisaSettingsTab from '@/modules/settings/tabs/chisa-settings/ChisaSettingsTab';

const native = vi.hoisted(() => ({ call: vi.fn(), on: vi.fn() }));
vi.mock('mygo-runtime', () => native);
vi.mock('@/modules/auth/context/AuthContext', () => ({ useAuth: () => ({ user: { username: 'alice' }, logout: vi.fn() }) }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('mygo', {});
  // Older apps may return stale sync, Pi and preview metadata; none is a current UI capability.
  native.call.mockResolvedValue({
    serverUrl: 'https://cloud.example', tunnel: false, workspaceConnecting: true,
    mappings: [{ serverPath: '/cloud/project', localPath: 'C:\\work\\project' }],
    sync: { '/cloud/project': { status: 'blocked', taskOwner: 'pi', gitRecoveryRequired: true } },
    previews: [{ id: 'legacy-preview', serverPath: '/cloud/project', localUrl: 'http://localhost:1234' }],
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test('desktop settings shows only the account connection even when native state contains old synchronization metadata', async () => {
  render(<ChisaSettingsTab />);
  await waitFor(() => expect((screen.getByLabelText('服务器地址') as HTMLInputElement).value).toBe('https://cloud.example'));
  expect(screen.getByRole('button', { name: '连接服务器' })).toBeDefined();
  expect(screen.queryByText(/项目同步|文件同步|本地目录|Pi|运行预览|VPS|C:\\work/)).toBeNull();
  expect(screen.queryByText('http://localhost:1234')).toBeNull();
  window.dispatchEvent(new CustomEvent('chisa:workspace-sync-state', { detail: { status: 'syncing' } }));
  expect(native.on).not.toHaveBeenCalled();
  expect(native.call).toHaveBeenCalledExactlyOnceWith('FrontendBridge.GetState');
});

test('account reconnection stays available without initializing a workspace tunnel', async () => {
  native.call.mockResolvedValueOnce({ serverUrl: 'https://cloud.example' }).mockResolvedValueOnce({ ok: true, serverUrl: 'https://cloud.example' });
  render(<ChisaSettingsTab />);
  await waitFor(() => expect((screen.getByLabelText('服务器地址') as HTMLInputElement).value).toBe('https://cloud.example'));
  fireEvent.click(screen.getByRole('button', { name: '连接服务器' }));
  await screen.findByText('已连接，可以登录');
  expect(native.call.mock.calls.map(([method]) => method)).toEqual(['FrontendBridge.GetState', 'FrontendBridge.ConnectServer']);
});

test('the browser settings explains that native account configuration belongs to the desktop', () => {
  vi.stubGlobal('mygo', undefined);
  render(<ChisaSettingsTab />);
  expect(screen.getByText('未检测到桌面环境。')).toBeDefined();
  expect(native.call).not.toHaveBeenCalled();
});
