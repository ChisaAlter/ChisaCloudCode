import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { SshAgentProvider, SshConnectionSettings } from '@/modules/ssh-workspaces';
import { startAuthSession } from '@/shared/authToken';
import { FrontendBridge } from '@/shared/chisa';

const native = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('mygo-runtime', () => native);
beforeEach(() => { vi.stubGlobal('mygo', {}); native.call.mockReset(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const profile = { id: 'one', name: 'Laptop', sshHost: 'vps.example', sshPort: 22, sshUser: 'forward', keyPath: 'C:\\keys\\tunnel', knownHostsPath: 'C:\\keys\\hosts', remotePort: 18765, localPort: 22, accountBinding: 'opaque', serviceUrl: 'https://cloud.example' };
const status = { profileId: 'one', state: 'forwarding', generation: 2, outerConnected: true, verified: false };

async function openPanel() {
  fireEvent.click(screen.getByText('本机项目连接'));
  await screen.findByRole('option', { name: 'Laptop' });
}

test('native SSH setup is lazy and unavailable in a browser without making RPCs', () => {
  const view = render(<SshConnectionSettings />);
  expect(native.call).not.toHaveBeenCalled();
  view.unmount();
  vi.stubGlobal('mygo', undefined);
  render(<SshConnectionSettings />);
  expect(screen.getByText(/浏览器可以使用服务器已登记/)).toBeDefined();
  expect(screen.queryByRole('button', { name: '启动隧道' })).toBeNull();
  expect(native.call).not.toHaveBeenCalled();
});

test('forwarding status explicitly does not claim directory readiness and never auto-starts', async () => {
  native.call.mockImplementation(async (method: string) => method === 'FrontendBridge.GetSshTunnelProfiles' ? { ok: true, profiles: [profile], statuses: [status] } : { ok: true, status });
  render(<SshConnectionSettings />);
  await openPanel();
  fireEvent.change(screen.getByLabelText('隧道配置'), { target: { value: 'one' } });
  await screen.findByText('转发已建立，目录尚未验证');
  expect(native.call.mock.calls.some(([method]) => method === 'FrontendBridge.StartSshTunnel')).toBe(false);
  expect((screen.getByRole('button', { name: '停止隧道' }) as HTMLButtonElement).disabled).toBe(false);
});

test('failed preflight shows actual missing prerequisites without claiming success', async () => {
  native.call.mockImplementation(async (method: string) => method === 'FrontendBridge.GetSshTunnelProfiles' ? { ok: true, profiles: [], statuses: [] } : { ok: false, sshAvailable: true, sshdAvailable: false, issues: [{ code: 'MISSING', message: '请安装 Windows OpenSSH Server。' }] });
  render(<SshConnectionSettings />);
  fireEvent.click(screen.getByText('本机项目连接'));
  await waitFor(() => expect(native.call).toHaveBeenCalledWith('FrontendBridge.GetSshTunnelProfiles'));
  await waitFor(() => expect((screen.getByRole('button', { name: '检查本机环境' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: '检查本机环境' }));
  await screen.findByText('请安装 Windows OpenSSH Server。');
  expect(screen.queryByText('本机 SSH 前提已满足，仍需验证服务器连接和项目目录。')).toBeNull();
});

test('fresh HTTPS Agent hides all SSH key and port requirements and delegates default preparation natively', async () => {
  const relay = { ...profile, mode: 'agent', agentTransport: 'relay' };
  startAuthSession('current.payload.signature');
  let prepared = false;
  const registered = { ...status, registrationState: 'registered' };
  // Native Ensure persists its returned profile; later polling must observe that same saved state.
  native.call.mockImplementation(async (method: string) => {
    if (method === 'FrontendBridge.GetSshTunnelProfiles') return { ok: true, profiles: prepared ? [relay] : [], statuses: prepared ? [registered] : [] };
    if (method === 'FrontendBridge.EnsureSshAgent') { prepared = true; return { ok: true, profile: relay, status: registered }; }
    return { ok: true };
  });
  render(<SshAgentProvider accountId="one"><SshConnectionSettings /></SshAgentProvider>);
  fireEvent.click(screen.getByText('本机项目连接'));
  await screen.findByRole('option', { name: '本机项目连接（默认）' });
  expect(screen.queryByLabelText('VPS SSH 地址')).toBeNull();
  expect(screen.queryByLabelText('隧道私钥文件路径')).toBeNull();
  expect(screen.queryByLabelText('本机项目连接端口')).toBeNull();
  await waitFor(() => expect((screen.getByRole('button', { name: '准备本机项目连接' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: '准备本机项目连接' }));
  await screen.findByText(/账号已连接/, {}, { timeout: 5000 });
  expect(native.call).toHaveBeenCalledWith('FrontendBridge.EnsureSshAgent', '');
  expect(native.call.mock.calls.some(([method]) => /StartSshTunnel|GetSshDefaults|InstallSshWorkspaceHelper/.test(method))).toBe(false);
});

test('closing settings while native Ensure is pending preserves registration in the shared lifecycle', async () => {
  const relay = { ...profile, mode: 'agent', agentTransport: 'relay' };
  let finish!: (result: unknown) => void;
  const pending = new Promise(resolve => { finish = resolve; });
  startAuthSession('current.payload.signature');
  native.call.mockImplementation(async (method: string) => method === 'FrontendBridge.GetSshTunnelProfiles' ? { ok: true, profiles: [relay], statuses: [{ ...status, state: 'stopped' }] } : method === 'FrontendBridge.EnsureSshAgent' ? pending : { ok: true });
  const view = render(<SshAgentProvider accountId="one"><SshConnectionSettings /></SshAgentProvider>);
  await openPanel();
  await waitFor(() => expect((screen.getByRole('button', { name: '连接项目' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: '连接项目' }));
  await waitFor(() => expect(native.call).toHaveBeenCalledWith('FrontendBridge.EnsureSshAgent', profile.id));
  view.rerender(<SshAgentProvider accountId="one"><p>closed</p></SshAgentProvider>);
  await act(async () => { finish({ ok: true, profile: relay, status: { ...status, registrationState: 'registered' } }); });
  native.call.mockImplementation(async (method: string) => method === 'FrontendBridge.GetSshTunnelProfiles' ? { ok: true, profiles: [relay], statuses: [{ ...status, registrationState: 'registered' }] } : { ok: true });
  view.rerender(<SshAgentProvider accountId="one"><SshConnectionSettings /></SshAgentProvider>);
  await openPanel();
  await screen.findByText(/账号已连接/);
  expect(native.call.mock.calls.filter(([method]) => method === 'FrontendBridge.EnsureSshAgent')).toHaveLength(1);
});

test('default connector name is presentation-only and saving retains its persisted name', async () => {
  const builtin = { ...profile, mode: 'agent', agentTransport: 'relay', name: '本机 Agent' };
  native.call.mockImplementation(async (method: string) => method === 'FrontendBridge.GetSshTunnelProfiles' ? { ok: true, profiles: [builtin], statuses: [] } : method === 'FrontendBridge.SaveSshTunnelProfile' ? { ok: true, profile: builtin } : { ok: true });
  render(<SshConnectionSettings />);
  fireEvent.click(screen.getByText('本机项目连接'));
  await screen.findByRole('option', { name: '本机项目连接' });
  expect((screen.getByLabelText('配置名称') as HTMLInputElement).value).toBe('本机项目连接');
  expect(screen.getByText(/Claude Code 在 VPS 运行，本机无需安装 Claude Code/)).toBeDefined();
  expect(screen.getByRole('option', { name: '高级：系统 SSH 服务（兼容）' })).toBeDefined();
  expect(screen.queryByLabelText('VPS SSH 地址')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
  await waitFor(() => expect(native.call).toHaveBeenCalledWith('FrontendBridge.SaveSshTunnelProfile', expect.objectContaining({ id: builtin.id, name: '本机 Agent', mode: 'agent', agentTransport: 'relay' })));
  expect(builtin.name).toBe('本机 Agent');
});

test('manual SSH keeps connection names and its accurate advanced controls', async () => {
  const manual = { ...profile, mode: 'ssh', name: '本机 Agent' };
  native.call.mockImplementation(async (method: string) => method === 'FrontendBridge.GetSshTunnelProfiles' ? { ok: true, profiles: [manual], statuses: [] } : { ok: true });
  render(<SshConnectionSettings />);
  fireEvent.click(screen.getByText('本机项目连接'));
  expect(await screen.findByRole('option', { name: '本机 Agent' })).toBeDefined();
  expect((screen.getByLabelText('配置名称') as HTMLInputElement).value).toBe('本机 Agent');
  expect(screen.getByLabelText('VPS SSH 地址')).toBeDefined();
  expect(screen.getByLabelText('本机 SSH 端口')).toBeDefined();
  expect(screen.getByRole('button', { name: '启动隧道' })).toBeDefined();
});

test('bridge wrappers pass only profile references and the requested lifecycle id', async () => {
  native.call.mockResolvedValue({ ok: true });
  await FrontendBridge.saveSshTunnelProfile(profile);
  await FrontendBridge.startSshTunnel('one');
  expect(native.call.mock.calls).toEqual([['FrontendBridge.SaveSshTunnelProfile', profile], ['FrontendBridge.StartSshTunnel', 'one']]);
});
