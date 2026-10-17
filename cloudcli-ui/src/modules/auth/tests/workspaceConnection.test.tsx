import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { WorkspaceConnectionForm } from '@/modules/auth/WorkspaceConnectionForm';
import { FrontendBridge } from '@/shared/chisa';
import type { ChisaState } from '@/shared/types';

const connectionListeners = vi.hoisted(() => new Set<() => void>());

vi.mock('@/shared/chisa', () => ({
  FrontendBridge: {
    getState: vi.fn(), connectAccountWorkspace: vi.fn(), connectWorkspace: vi.fn(), selectWorkspaceKey: vi.fn(),
  },
  onWorkspaceConnectionChanged: (listener: () => void) => {
    connectionListeners.add(listener);
    return () => connectionListeners.delete(listener);
  },
}));

const idleState: ChisaState = { tunnel: false, serverUrl: 'https://server.example', mappings: [] };

beforeEach(() => {
  vi.resetAllMocks();
  connectionListeners.clear();
  vi.mocked(FrontendBridge.getState).mockResolvedValue(idleState);
  vi.mocked(FrontendBridge.connectAccountWorkspace).mockResolvedValue({ ok: true });
});
afterEach(cleanup);

test('a fresh account shows automatic sync without another configuration form', async () => {
  const view = render(<WorkspaceConnectionForm />);
  await screen.findByRole('button', { name: '重试连接' });
  expect(screen.getByRole('status').textContent).toBe('文件同步尚未连接');
  expect(screen.getByText(/无需另行配置/)).toBeDefined();
  expect(view.container.querySelector('input')).toBeNull();
  expect(screen.queryByText(/SSH|管理员|同步服务地址/)).toBeNull();
  expect(screen.queryByRole('button', { name: '选择文件' })).toBeNull();
  expect(FrontendBridge.connectAccountWorkspace).not.toHaveBeenCalled();
  expect(FrontendBridge.connectWorkspace).not.toHaveBeenCalled();
  expect(FrontendBridge.selectWorkspaceKey).not.toHaveBeenCalled();
});

test('settings join account setup and show its final connected state', async () => {
  let finish!: (result: Record<string, unknown>) => void;
  vi.mocked(FrontendBridge.getState)
    .mockResolvedValueOnce({ ...idleState, workspaceConnecting: true })
    .mockResolvedValue({ ...idleState, tunnel: true });
  vi.mocked(FrontendBridge.connectAccountWorkspace).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  render(<WorkspaceConnectionForm />);
  const button = await screen.findByRole('button', { name: '连接中…' });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole('status').textContent).toBe('正在连接文件同步…');
  expect(FrontendBridge.connectAccountWorkspace).toHaveBeenCalledTimes(1);
  await act(async () => { finish({ ok: true }); });
  expect(screen.getByRole('status').textContent).toBe('文件同步已连接，可以打开本机目录');
  expect((screen.getByRole('button', { name: '重新连接' }) as HTMLButtonElement).disabled).toBe(false);
  expect(FrontendBridge.connectWorkspace).not.toHaveBeenCalled();
});

test('server setup failure stays beside the controls and account retry clears it after connecting', async () => {
  vi.mocked(FrontendBridge.getState).mockResolvedValueOnce({ ...idleState, workspaceError: '服务器尚未启用文件同步' });
  render(<WorkspaceConnectionForm />);
  expect((await screen.findByRole('alert')).textContent).toBe('服务器尚未启用文件同步');
  vi.mocked(FrontendBridge.getState).mockResolvedValue({ ...idleState, tunnel: true });
  fireEvent.click(screen.getByRole('button', { name: '重试连接' }));
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('文件同步已连接，可以打开本机目录'));
  expect(screen.queryByRole('alert')).toBeNull();
  expect(FrontendBridge.connectAccountWorkspace).toHaveBeenCalledTimes(1);
  expect(FrontendBridge.connectWorkspace).not.toHaveBeenCalled();
});

test('a connected SSH tunnel is not ready when workspace preparation failed', async () => {
  vi.mocked(FrontendBridge.getState).mockResolvedValue({
    ...idleState, tunnel: true, workspaceError: '文件同步组件初始化失败',
  });
  render(<WorkspaceConnectionForm />);
  expect((await screen.findByRole('alert')).textContent).toBe('文件同步组件初始化失败');
  expect(screen.getByRole('status').textContent).toBe('文件同步尚未连接');
  expect(screen.queryByRole('button', { name: '重新连接' })).toBeNull();
  expect((screen.getByRole('button', { name: '重试连接' }) as HTMLButtonElement).disabled).toBe(false);
  expect(FrontendBridge.connectAccountWorkspace).not.toHaveBeenCalled();
});

test('an unsuccessful account retry restores its action and reports the supplied reason', async () => {
  vi.mocked(FrontendBridge.connectAccountWorkspace).mockResolvedValue({ ok: false, error: '当前账号没有同步权限' });
  render(<WorkspaceConnectionForm />);
  fireEvent.click(await screen.findByRole('button', { name: '重试连接' }));
  expect((await screen.findByRole('alert')).textContent).toBe('当前账号没有同步权限');
  expect((screen.getByRole('button', { name: '重试连接' }) as HTMLButtonElement).disabled).toBe(false);
  expect(FrontendBridge.connectWorkspace).not.toHaveBeenCalled();
});

test('a failed joined setup exposes retry instead of leaving a permanent loading state', async () => {
  vi.mocked(FrontendBridge.getState).mockResolvedValue({ ...idleState, workspaceConnecting: true });
  vi.mocked(FrontendBridge.connectAccountWorkspace).mockRejectedValue(new Error('文件同步连接超时'));
  render(<WorkspaceConnectionForm />);
  expect((await screen.findByRole('alert')).textContent).toBe('文件同步连接超时');
  expect((screen.getByRole('button', { name: '重试连接' }) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.getByRole('status').textContent).toBe('文件同步尚未连接');
});

test('an account switch elsewhere refreshes the connection controls without a manual retry', async () => {
  vi.mocked(FrontendBridge.getState).mockResolvedValueOnce({ ...idleState, workspaceError: '旧账号绑定阻止连接' });
  const view = render(<WorkspaceConnectionForm />);
  expect((await screen.findByRole('alert')).textContent).toBe('旧账号绑定阻止连接');
  vi.mocked(FrontendBridge.getState).mockResolvedValue({ ...idleState, tunnel: true });

  await act(async () => connectionListeners.forEach(listener => listener()));

  expect(screen.getByRole('status').textContent).toBe('文件同步已连接，可以打开本机目录');
  expect(screen.queryByRole('alert')).toBeNull();
  expect((screen.getByRole('button', { name: '重新连接' }) as HTMLButtonElement).disabled).toBe(false);
  expect(FrontendBridge.getState).toHaveBeenCalledTimes(2);
  expect(FrontendBridge.connectAccountWorkspace).not.toHaveBeenCalled();
  expect(FrontendBridge.connectWorkspace).not.toHaveBeenCalled();
  view.unmount();
  connectionListeners.forEach(listener => listener());
  expect(FrontendBridge.getState).toHaveBeenCalledTimes(2);
});
