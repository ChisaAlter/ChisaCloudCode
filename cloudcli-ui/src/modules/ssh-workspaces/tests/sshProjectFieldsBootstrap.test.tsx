import { StrictMode, useEffect, useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { SshAgentProvider, SshProjectFields, useSshAgent } from '@/modules/ssh-workspaces';
import { api } from '@/shared/api';
import { clearAuthToken, startAuthSession } from '@/shared/authToken';
import { FrontendBridge } from '@/shared/chisa';
import type { SshAgentController, SshAgentEnsureResult, SshTunnelProfile, SshTunnelStatus } from '@/shared/types';

const account = vi.hoisted(() => ({ user: { id: 1, username: 'account-a' } as { id: number; username: string } | null }));
vi.mock('@/modules/auth', () => ({ useAuth: () => ({ user: account.user }) }));
const profile: SshTunnelProfile = {
  id: 'agent-profile', accountBinding: 'binding', serviceUrl: 'https://vps.invalid', agentTransport: 'relay',
  mode: 'agent', name: 'VPS Agent', sshHost: '', sshPort: 0, sshUser: '', keyPath: '', knownHostsPath: '', remotePort: 0, localPort: 0,
};
const stopped: SshTunnelStatus = { profileId: profile.id, state: 'stopped', generation: 1, outerConnected: false, verified: false, registrationState: 'unregistered' };
const forwarding: SshTunnelStatus = { ...stopped, state: 'forwarding', outerConnected: true, registrationState: 'registered' };
const connection = { id: profile.id, name: profile.name, transport: 'agent', platform: 'win32' };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
let controller: SshAgentController | null;
function Capture() { const agent = useSshAgent(); useEffect(() => { controller = agent; }, [agent]); return null; }
function Fields() { return <SshProjectFields connectionId={profile.id} rootPath="" verified={null} onConnectionChange={vi.fn()} onRootPathChange={vi.fn()} onVerified={vi.fn()} />; }
function Page({ show = true }: { show?: boolean }) { return <SshAgentProvider accountId={account.user ? String(account.user.id) : null}><Capture />{show && <Fields />}</SshAgentProvider>; }

beforeEach(() => {
  vi.stubGlobal('mygo', {});
  account.user = { id: 1, username: 'account-a' };
  startAuthSession('accounta.payload.signature');
  vi.spyOn(FrontendBridge, 'getSshTunnelProfiles').mockResolvedValue({ ok: true, profiles: [profile], statuses: [stopped] });
  vi.spyOn(api.sshWorkspaces, 'connections').mockImplementation(async () => Response.json({ configured: true, connections: [connection] }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

test('pure cloud provider mount does not list, create or start native SSH capabilities', () => {
  const ensure = vi.spyOn(FrontendBridge, 'ensureSshAgent');
  render(<Page show={false} />);
  expect(FrontendBridge.getSshTunnelProfiles).not.toHaveBeenCalled();
  expect(ensure).not.toHaveBeenCalled();
});

test('populated registry restores the exact stopped native Agent once across strict mode and panel remount', async () => {
  const pending = deferred<SshAgentEnsureResult>();
  const ensure = vi.spyOn(FrontendBridge, 'ensureSshAgent').mockReturnValue(pending.promise);
  const view = render(<StrictMode><Page /></StrictMode>);
  await waitFor(() => expect(ensure).toHaveBeenCalledExactlyOnceWith(profile.id));
  view.rerender(<StrictMode><Page show={false} /></StrictMode>);
  view.rerender(<StrictMode><Page /></StrictMode>);
  vi.mocked(FrontendBridge.getSshTunnelProfiles).mockResolvedValue({ ok: true, profiles: [profile], statuses: [forwarding] });
  await act(async () => { pending.resolve({ ok: true, profile, status: forwarding }); });
  await screen.findByText(/账号已连接/);
  expect(ensure).toHaveBeenCalledTimes(1);
  expect(api.sshWorkspaces.connections).toHaveBeenCalled();
});

test('registration failure stays visible with populated catalog and retry is native-only', async () => {
  const ensure = vi.spyOn(FrontendBridge, 'ensureSshAgent').mockResolvedValueOnce({ ok: false, profile, status: { ...forwarding, registrationState: 'error', registrationError: 'registration denied' }, error: 'registration denied' }).mockResolvedValueOnce({ ok: true, profile, status: forwarding });
  render(<Page />);
  await screen.findByRole('alert', { name: '' });
  expect(screen.getByText('registration denied')).toBeDefined();
  expect(screen.getByRole('option', { name: profile.name })).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: '重试本机项目连接' }));
  await screen.findByText(/账号已连接/);
  expect(ensure).toHaveBeenCalledTimes(2);
  expect(screen.queryByText('registration denied')).toBeNull();
});

test('forwarding deadline or incomplete starting reply never claims readiness', async () => {
  vi.spyOn(FrontendBridge, 'ensureSshAgent').mockResolvedValue({ ok: true, profile, status: { ...stopped, state: 'starting' } });
  render(<Page />);
  await screen.findByText('尚未确认本机项目连接和账号登记，请检查状态后重试。');
  expect(screen.queryByText(/账号已连接/)).toBeNull();
});

test('account switch discards a pending ensure without publishing old identity or starting a foreign profile', async () => {
  const pending = deferred<SshAgentEnsureResult>();
  const ensure = vi.spyOn(FrontendBridge, 'ensureSshAgent').mockReturnValue(pending.promise);
  const view = render(<Page />);
  await waitFor(() => expect(ensure).toHaveBeenCalledTimes(1));
  vi.mocked(FrontendBridge.getSshTunnelProfiles).mockResolvedValue({ ok: true, profiles: [], statuses: [] });
  act(() => { clearAuthToken(); startAuthSession('accountb.payload.signature'); account.user = { id: 2, username: 'account-b' }; });
  view.rerender(<Page />);
  await act(async () => { pending.resolve({ ok: true, profile, status: forwarding }); });
  expect(controller?.profiles).toEqual([]);
  expect(controller?.statuses).toEqual({});
  expect(ensure).toHaveBeenCalledTimes(1);
  expect(screen.queryByText(/账号已连接/)).toBeNull();
});

test('empty catalog requests native default relay with no JavaScript profile creation or token flow', async () => {
  vi.mocked(FrontendBridge.getSshTunnelProfiles).mockResolvedValue({ ok: true, profiles: [], statuses: [] });
  vi.mocked(api.sshWorkspaces.connections).mockImplementation(async () => Response.json({ configured: true, connections: [] }));
  const ensure = vi.spyOn(FrontendBridge, 'ensureSshAgent').mockResolvedValue({ ok: true, profile, status: forwarding });
  render(<SshAgentProvider accountId={account.user ? String(account.user.id) : null}><SshProjectFields connectionId="" rootPath="" verified={null} onConnectionChange={vi.fn()} onRootPathChange={vi.fn()} onVerified={vi.fn()} /></SshAgentProvider>);
  await waitFor(() => expect(ensure).toHaveBeenCalledExactlyOnceWith(''));
});

test('default activation prefers a saved HTTPS relay over legacy SSH while explicit selection remains exact', async () => {
  const legacy = { ...profile, id: 'a-legacy', agentTransport: 'ssh' as const };
  const relay = { ...profile, id: 'z-relay' };
  vi.mocked(FrontendBridge.getSshTunnelProfiles).mockResolvedValue({ ok: true, profiles: [legacy, relay], statuses: [] });
  const ensure = vi.spyOn(FrontendBridge, 'ensureSshAgent').mockResolvedValue({ ok: true, profile: relay, status: { ...forwarding, profileId: relay.id } });
  render(<Page show={false} />);
  await act(async () => { await controller?.activate(''); });
  expect(ensure).toHaveBeenCalledExactlyOnceWith(relay.id);
});

test('a populated foreign catalog with no native profile can explicitly connect and select this computer', async () => {
  const foreign = { ...connection, id: 'old-desktop', name: 'Other computer' };
  vi.mocked(FrontendBridge.getSshTunnelProfiles).mockResolvedValue({ ok: true, profiles: [], statuses: [] });
  vi.mocked(api.sshWorkspaces.connections).mockImplementation(async () => Response.json({ configured: true, connections: [foreign] }));
  const ensured = deferred<SshAgentEnsureResult>();
  const ensure = vi.spyOn(FrontendBridge, 'ensureSshAgent').mockReturnValue(ensured.promise);
  const selected = vi.fn();
  function Selection() {
    const [id, setId] = useState(foreign.id);
    return <SshProjectFields connectionId={id} rootPath="" verified={null} onConnectionChange={value => { selected(value); setId(value); }} onRootPathChange={vi.fn()} onVerified={vi.fn()} />;
  }
  render(<SshAgentProvider accountId="one"><Selection /></SshAgentProvider>);
  await waitFor(() => expect((screen.getByRole('button', { name: '连接这台电脑' }) as HTMLButtonElement).disabled).toBe(false));
  expect(ensure).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '连接这台电脑' }));
  expect(ensure).toHaveBeenCalledExactlyOnceWith('');
  vi.mocked(FrontendBridge.getSshTunnelProfiles).mockResolvedValue({ ok: true, profiles: [profile], statuses: [forwarding] });
  vi.mocked(api.sshWorkspaces.connections).mockImplementation(async () => Response.json({ configured: true, connections: [foreign, connection] }));
  await act(async () => { ensured.resolve({ ok: true, profile, status: forwarding }); });
  await waitFor(() => expect(selected).toHaveBeenCalledWith(profile.id));
  await waitFor(() => expect((screen.getByLabelText('本地连接') as HTMLSelectElement).value).toBe(profile.id));
  expect(ensure).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('button', { name: '连接这台电脑' })).toBeNull();
});

test('closing the wizard during explicit computer setup cannot change its selected connection later', async () => {
  vi.mocked(FrontendBridge.getSshTunnelProfiles).mockResolvedValue({ ok: true, profiles: [], statuses: [] });
  const pending = deferred<SshAgentEnsureResult>();
  vi.spyOn(FrontendBridge, 'ensureSshAgent').mockReturnValue(pending.promise);
  const selected = vi.fn();
  const view = render(<SshAgentProvider accountId="one"><SshProjectFields connectionId="old-desktop" rootPath="" verified={null} onConnectionChange={selected} onRootPathChange={vi.fn()} onVerified={vi.fn()} /></SshAgentProvider>);
  await waitFor(() => expect((screen.getByRole('button', { name: '连接这台电脑' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: '连接这台电脑' }));
  view.unmount();
  await act(async () => { pending.resolve({ ok: true, profile, status: forwarding }); });
  expect(selected).not.toHaveBeenCalled();
});

test('a remote registered connection never starts a different native Agent', async () => {
  const ensure = vi.spyOn(FrontendBridge, 'ensureSshAgent');
  render(<SshAgentProvider accountId={account.user ? String(account.user.id) : null}><SshProjectFields connectionId="other-desktop" rootPath="" verified={null} onConnectionChange={vi.fn()} onRootPathChange={vi.fn()} onVerified={vi.fn()} /></SshAgentProvider>);
  await waitFor(() => expect(FrontendBridge.getSshTunnelProfiles).toHaveBeenCalled());
  expect(ensure).not.toHaveBeenCalled();
});

test('built-in connection explains cloud Claude, presents the local project label and preserves protocol identity', async () => {
  const builtin = { ...profile, name: '本机 Agent' };
  vi.mocked(FrontendBridge.getSshTunnelProfiles).mockResolvedValue({ ok: true, profiles: [builtin], statuses: [{ ...forwarding, message: '账号 Agent 中继已连接；项目目录仍需独立验证' }] });
  vi.spyOn(FrontendBridge, 'ensureSshAgent').mockResolvedValue({ ok: true, profile: builtin, status: forwarding });
  vi.mocked(api.sshWorkspaces.connections).mockImplementation(async () => Response.json({ configured: true, connections: [{ ...connection, name: builtin.name, username: 'desktop-agent' }] }));
  const probe = { ok: true, protocol: 1, platform: 'win32', rootPath: 'C:\\work\\app', rootIdentity: 'root-one' };
  const check = vi.spyOn(api.sshWorkspaces, 'probe').mockResolvedValue(Response.json(probe));
  const verified = vi.fn();
  render(<SshAgentProvider accountId="one"><SshProjectFields connectionId={builtin.id} rootPath={probe.rootPath} verified={null} onConnectionChange={vi.fn()} onRootPathChange={vi.fn()} onVerified={verified} /></SshAgentProvider>);
  const option = await screen.findByRole<HTMLOptionElement>('option', { name: '本机项目连接' });
  expect(option.value).toBe(builtin.id);
  expect(screen.getByText(/Claude Code 在 VPS 运行，本机无需安装 Claude Code/)).toBeDefined();
  expect(screen.getByText(/只负责访问 Windows 项目文件/)).toBeDefined();
  expect(screen.queryByText(/账号 Agent 中继/)).toBeNull();
  expect(screen.queryByText(/desktop-agent/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '验证连接和目录' }));
  await waitFor(() => expect(verified).toHaveBeenCalledWith(probe, '本机项目连接'));
  expect(check.mock.calls[0][0]).toEqual({ connectionId: builtin.id, rootPath: probe.rootPath });
  expect(builtin.name).toBe('本机 Agent');
});

test('manual SSH keeps user-supplied names and usernames even when they match built-in words', async () => {
  const manual = { id: 'manual', name: '本机 Agent', username: 'desktop-agent', transport: 'ssh' };
  vi.mocked(api.sshWorkspaces.connections).mockImplementation(async () => Response.json({ configured: true, connections: [manual] }));
  render(<SshProjectFields connectionId={manual.id} rootPath="C:\\work\\app" verified={null} onConnectionChange={vi.fn()} onRootPathChange={vi.fn()} onVerified={vi.fn()} />);
  expect(await screen.findByRole('option', { name: '本机 Agent · desktop-agent' })).toBeDefined();
  expect(screen.getByRole('button', { name: '验证 SSH 连接和目录' })).toBeDefined();
});

test('custom built-in connection names and unrecognized diagnostics remain visible verbatim', async () => {
  const custom = { ...profile, name: 'My Agent workstation' };
  vi.mocked(FrontendBridge.getSshTunnelProfiles).mockResolvedValue({ ok: true, profiles: [custom], statuses: [{ ...forwarding, message: 'Custom Agent diagnostic: keep this detail' }] });
  vi.mocked(api.sshWorkspaces.connections).mockImplementation(async () => Response.json({ configured: true, connections: [{ ...connection, name: custom.name, username: 'developer' }] }));
  render(<Page />);
  expect(await screen.findByRole('option', { name: 'My Agent workstation · developer' })).toBeDefined();
  expect(await screen.findByText(/Custom Agent diagnostic: keep this detail/)).toBeDefined();
});
