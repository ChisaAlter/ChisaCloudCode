import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { ProjectCreationWizard } from '@/modules/project-creation-wizard';
import { api } from '@/shared/api';
import { FrontendBridge } from '@/shared/chisa';
import { clearAuthToken, startAuthSession } from '@/shared/authToken';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const probe = { ok: true, protocol: 1, platform: 'win32', rootPath: 'C:\\work\\项目', rootIdentity: 'root-one', username: 'cc-worker', helperVersion: '1', capabilities: { files: true, exec: true, terminal: false } };
beforeEach(() => { vi.stubGlobal('mygo', undefined); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function selectSsh() {
  fireEvent.click(screen.getByRole('radio', { name: '本机项目（云端 Claude）' }));
  await screen.findByRole('option', { name: /My laptop/ });
  fireEvent.change(screen.getByLabelText('本地连接'), { target: { value: 'laptop' } });
  fireEvent.change(screen.getByLabelText('Windows 项目目录'), { target: { value: 'C:\\work\\项目' } });
}
function catalog() { return vi.spyOn(api.sshWorkspaces, 'connections').mockResolvedValue(Response.json({ configured: true, connections: [{ id: 'laptop', name: 'My laptop', platform: 'win32' }] })); }

test('cloud is default and does not initialize SSH catalog or native folder selection', () => {
  const connections = catalog();
  const picker = vi.spyOn(FrontendBridge, 'selectSshLocalFolder');
  render(<ProjectCreationWizard onClose={vi.fn()} />);
  expect((screen.getByRole('radio', { name: '云端 VPS' }) as HTMLInputElement).checked).toBe(true);
  expect(screen.getByRole('radio', { name: '本机项目（云端 Claude）' })).toBeDefined();
  expect(screen.getByText('项目文件位置')).toBeDefined();
  expect(screen.getByText(/两种方式都由 VPS 运行 Claude Code，本机无需安装 Claude Code/)).toBeDefined();
  expect(screen.queryByRole('radio', { name: 'SSH 本地' })).toBeNull();
  expect(screen.getByPlaceholderText('https://github.com/username/repository')).toBeDefined();
  expect(connections).not.toHaveBeenCalled();
  expect(picker).not.toHaveBeenCalled();
});

test('SSH requires a current directory probe and submits only the canonical local target', async () => {
  catalog();
  const check = vi.spyOn(api.sshWorkspaces, 'probe').mockResolvedValue(Response.json(probe));
  const created = { projectId: 'local', fullPath: '/meta/local', displayPath: probe.rootPath, sourceMode: 'ssh' };
  const create = vi.spyOn(api, 'createProject').mockResolvedValue(Response.json({ project: created }));
  const opened = vi.fn();
  render(<ProjectCreationWizard onClose={vi.fn()} onProjectCreated={opened} />);
  await selectSsh();
  expect(screen.queryByPlaceholderText('https://github.com/username/repository')).toBeNull();
  expect(screen.queryByRole('button', { name: '选择 Windows 项目目录' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'projectWizard.buttons.next' }));
  await screen.findByText('请先验证项目连接和 Windows 项目目录。');
  fireEvent.click(screen.getByRole('button', { name: '验证 SSH 连接和目录' }));
  await screen.findByText(/已验证：/);
  expect(check.mock.calls[0][0]).toEqual({ connectionId: 'laptop', rootPath: probe.rootPath });
  fireEvent.click(screen.getByRole('button', { name: 'projectWizard.buttons.next' }));
  expect(screen.getByText('本机项目（云端 Claude）')).toBeDefined();
  expect(screen.getByText('Claude Code：云端 VPS；项目文件、Git、构建和测试：Windows')).toBeDefined();
  expect(screen.getByText(/本机无需安装 Claude Code/)).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'projectWizard.buttons.createProject' }));
  await waitFor(() => expect(opened).toHaveBeenCalledWith(created));
  expect(create).toHaveBeenCalledExactlyOnceWith({ sourceMode: 'ssh', connectionId: 'laptop', rootPath: probe.rootPath });
});

test('changing the root invalidates a probe and a delayed old result cannot authorize it', async () => {
  catalog();
  let finish!: (response: Response) => void;
  vi.spyOn(api.sshWorkspaces, 'probe').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  render(<ProjectCreationWizard onClose={vi.fn()} />);
  await selectSsh();
  fireEvent.click(screen.getByRole('button', { name: '验证 SSH 连接和目录' }));
  fireEvent.change(screen.getByLabelText('Windows 项目目录'), { target: { value: 'C:\\other' } });
  await act(async () => { finish(Response.json(probe)); });
  expect(screen.queryByText(/已验证：/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'projectWizard.buttons.next' }));
  await screen.findByText('请先验证项目连接和 Windows 项目目录。');
});

const existingProject = { projectId: 'original-local', path: '/meta/original', fullPath: '/meta/original', displayPath: probe.rootPath, displayName: 'Seelen UI', sourceMode: 'ssh', sshConnectionId: 'original-connection', connectionLabel: 'Original computer', isArchived: false, isStarred: true, sessions: [], sessionMeta: { total: 0, hasMore: false } };

test.each([false, true])('verified existing directory opens the original project only after explicit action; archived=%s', async isArchived => {
  catalog();
  const existing = { ...existingProject, isArchived };
  vi.spyOn(api.sshWorkspaces, 'probe').mockResolvedValue(Response.json({ ...probe, existingProject: existing }));
  const returned = { ...existing, isArchived: false };
  const create = vi.spyOn(api, 'createProject').mockResolvedValue(Response.json({ outcome: isArchived ? 'reactivated_archived' : 'existing', project: returned }));
  const opened = vi.fn();
  const close = vi.fn();
  render(<ProjectCreationWizard onClose={close} onProjectCreated={opened} />);
  await selectSsh();
  fireEvent.click(screen.getByRole('button', { name: '验证 SSH 连接和目录' }));
  await screen.findByText(/此目录已在当前账号中登记为「Seelen UI」。/);
  expect(create).not.toHaveBeenCalled();
  expect(opened).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'projectWizard.buttons.next' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: isArchived ? '恢复并打开项目' : '打开已有项目' }));
  await waitFor(() => expect(opened).toHaveBeenCalledExactlyOnceWith(returned));
  expect(create).toHaveBeenCalledExactlyOnceWith({ sourceMode: 'ssh', connectionId: 'laptop', rootPath: probe.rootPath });
  expect(close).toHaveBeenCalledOnce();
});

test('changing the verified root removes the existing-project action and requires a new probe', async () => {
  catalog();
  vi.spyOn(api.sshWorkspaces, 'probe').mockResolvedValue(Response.json({ ...probe, existingProject }));
  const create = vi.spyOn(api, 'createProject');
  render(<ProjectCreationWizard onClose={vi.fn()} />);
  await selectSsh();
  fireEvent.click(screen.getByRole('button', { name: '验证 SSH 连接和目录' }));
  await screen.findByRole('button', { name: '打开已有项目' });
  fireEvent.change(screen.getByLabelText('Windows 项目目录'), { target: { value: 'C:\\other' } });
  expect(screen.queryByRole('button', { name: '打开已有项目' })).toBeNull();
  expect(screen.queryByText(/此目录已在当前账号中登记/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'projectWizard.buttons.next' }));
  await screen.findByText('请先验证项目连接和 Windows 项目目录。');
  expect(create).not.toHaveBeenCalled();
});

test('an existing project discovered between probe and submit opens the server-returned original id', async () => {
  catalog();
  vi.spyOn(api.sshWorkspaces, 'probe').mockResolvedValue(Response.json(probe));
  vi.spyOn(api, 'createProject').mockResolvedValue(Response.json({ outcome: 'existing', project: existingProject }));
  const opened = vi.fn();
  render(<ProjectCreationWizard onClose={vi.fn()} onProjectCreated={opened} />);
  await selectSsh();
  fireEvent.click(screen.getByRole('button', { name: '验证 SSH 连接和目录' }));
  await screen.findByText(/已验证：/);
  fireEvent.click(screen.getByRole('button', { name: 'projectWizard.buttons.next' }));
  fireEvent.click(screen.getByRole('button', { name: 'projectWizard.buttons.createProject' }));
  await waitFor(() => expect(opened).toHaveBeenCalledExactlyOnceWith(existingProject));
});

test.each(['unmount', 'account'] as const)('a delayed existing-project response cannot navigate after %s', async transition => {
  catalog();
  vi.spyOn(api.sshWorkspaces, 'probe').mockResolvedValue(Response.json({ ...probe, existingProject }));
  let finish!: (response: Response) => void;
  vi.spyOn(api, 'createProject').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const opened = vi.fn();
  const close = vi.fn();
  const view = render(<ProjectCreationWizard onClose={close} onProjectCreated={opened} />);
  await selectSsh();
  fireEvent.click(screen.getByRole('button', { name: '验证 SSH 连接和目录' }));
  fireEvent.click(await screen.findByRole('button', { name: '打开已有项目' }));
  if (transition === 'unmount') view.unmount();
  else { clearAuthToken(); startAuthSession('newaccount.payload.signature'); }
  await act(async () => { finish(Response.json({ outcome: 'existing', project: existingProject })); });
  expect(opened).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
});

test('legacy duplicate-directory conflict gives a readable action without claiming success', async () => {
  catalog();
  vi.spyOn(api.sshWorkspaces, 'probe').mockResolvedValue(Response.json(probe));
  vi.spyOn(api, 'createProject').mockResolvedValue(Response.json({ error: { code: 'SSH_PROJECT_ALREADY_EXISTS', message: 'This physical directory identity is already registered for this account' } }, { status: 409 }));
  const opened = vi.fn();
  render(<ProjectCreationWizard onClose={vi.fn()} onProjectCreated={opened} />);
  await selectSsh();
  fireEvent.click(screen.getByRole('button', { name: '验证 SSH 连接和目录' }));
  await screen.findByText(/已验证：/);
  fireEvent.click(screen.getByRole('button', { name: 'projectWizard.buttons.next' }));
  fireEvent.click(screen.getByRole('button', { name: 'projectWizard.buttons.createProject' }));
  await screen.findByText(/请在项目列表打开已有项目/);
  expect(opened).not.toHaveBeenCalled();
  expect(screen.queryByText(/This physical directory identity/)).toBeNull();
});

test('a server probe failure is visible and never becomes success', async () => {
  catalog();
  vi.spyOn(api.sshWorkspaces, 'probe').mockResolvedValue(Response.json({ error: { message: 'Windows host key changed' } }, { status: 409 }));
  render(<ProjectCreationWizard onClose={vi.fn()} />);
  await selectSsh();
  fireEvent.click(screen.getByRole('button', { name: '验证 SSH 连接和目录' }));
  await screen.findByText('Windows host key changed');
  expect(screen.queryByText(/已验证：/)).toBeNull();
});
