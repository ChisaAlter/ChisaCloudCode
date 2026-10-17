import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import ChisaSettingsTab from '@/modules/settings/tabs/chisa-settings/ChisaSettingsTab';
import type { ChisaState, ChisaSyncInfo, ChisaWorkspaceSwitchResult } from '@/shared/types';

const native = vi.hoisted(() => ({
  authVersion: 0,
  connectionVersion: 0,
  getState: vi.fn<() => Promise<ChisaState>>(),
  refreshPreviews: vi.fn<() => Promise<ChisaState>>(),
  stopPreview: vi.fn(),
  getProjectStorage: vi.fn(),
  syncProject: vi.fn(),
  forgetMapping: vi.fn(),
  switchAccountWorkspace: vi.fn(),
  connectAccountWorkspace: vi.fn(),
  createProject: vi.fn(),
  refreshProjects: vi.fn(),
  recordLocalSelection: vi.fn(),
  revoke: vi.fn(),
  listeners: new Set<(info: ChisaSyncInfo) => void>(),
  connectionListeners: new Set<() => void>(),
}));

vi.mock('@/modules/local-agent', () => ({ PiAgentSettings: () => null }));
vi.mock('@/modules/auth', () => ({ AccountServerConnection: () => null }));
vi.mock('@/modules/command-palette', () => ({ usePaletteOps: () => ({ refreshProjects: native.refreshProjects }) }));
vi.mock('@/shared/api', () => ({ api: { createProject: native.createProject } }));
vi.mock('@/shared/authToken', () => ({ AUTH_IDENTITY_CHANGED_EVENT: 'auth-identity-changed', getAuthSessionVersion: () => native.authVersion }));
vi.mock('@/shared/chisa', () => ({
  SERVER_CONNECTION_CHANGED_EVENT: 'server-connection-changed',
  getServerConnectionVersion: () => native.connectionVersion,
  isDesktop: () => true,
  recordLocalSelection: native.recordLocalSelection,
  FrontendBridge: { getState: native.getState, refreshPreviews: native.refreshPreviews, stopPreview: native.stopPreview, getProjectStorage: native.getProjectStorage, syncProject: native.syncProject, forgetMapping: native.forgetMapping, switchAccountWorkspace: native.switchAccountWorkspace, connectAccountWorkspace: native.connectAccountWorkspace, revoke: native.revoke },
  onWorkspaceSyncStateChanged: (listener: (info: ChisaSyncInfo) => void) => {
    native.listeners.add(listener);
    return () => native.listeners.delete(listener);
  },
  onWorkspaceConnectionChanged: (listener: () => void) => {
    native.connectionListeners.add(listener);
    return () => native.connectionListeners.delete(listener);
  },
}));

const PROJECT = '/srv/project-a';

beforeEach(() => {
  vi.resetAllMocks();
  native.authVersion = 0;
  native.connectionVersion = 0;
  vi.useFakeTimers();
  native.listeners.clear();
  native.connectionListeners.clear();
  native.getProjectStorage.mockResolvedValue({});
  native.createProject.mockResolvedValue(Response.json({}, { status: 201 }));
  native.refreshProjects.mockResolvedValue(undefined);
  native.refreshPreviews.mockReturnValue(new Promise(() => {}));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

test('a new reservation event during initial loading survives the older snapshot and stays stable without polling', async () => {
  let resolve!: (state: ChisaState) => void;
  native.getState.mockReturnValueOnce(new Promise<ChisaState>((done) => { resolve = done; }));
  const ready: ChisaSyncInfo = {
    status: 'ready', sequence: 10, bindingEpoch: 'binding-a', checkedAt: '2026-10-06T05:00:00Z',
    localPath: 'C:\\work\\project', serverPath: PROJECT,
  };
  render(<ChisaSettingsTab />);
  act(() => native.listeners.forEach(listener => listener({ ...ready, status: 'reserved', sequence: 11, taskOwner: 'claude' })));
  await act(async () => {
    resolve({
      tunnel: true, serverUrl: 'https://example.invalid',
      mappings: [{ serverPath: PROJECT, localPath: ready.localPath!, mode: 'vps' }],
      sync: { [PROJECT]: ready },
    });
  });
  expect(screen.getByRole('status').textContent).toBe('任务执行中');
  expect(screen.getByRole<HTMLButtonElement>('button', { name: /^同步$/ }).disabled).toBe(true);
  act(() => native.listeners.forEach(listener => listener(ready)));
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(screen.getByRole('status').textContent).toBe('任务执行中');
  expect(native.getState).toHaveBeenCalledTimes(1);
  expect(native.getProjectStorage).not.toHaveBeenCalled();
});

test.each(['claude', 'pi'] as const)('an unavailable engine event does not unlock the %s task in settings', async taskOwner => {
  const reserved: ChisaSyncInfo = {
    status: 'reserved', taskOwner, sequence: 10, bindingEpoch: 'binding-a', checkedAt: '2026-10-06T05:00:00Z',
    localPath: 'C:\\work\\project', serverPath: PROJECT,
  };
  native.getState.mockResolvedValueOnce({
    tunnel: true, serverUrl: 'https://example.invalid',
    mappings: [{ serverPath: PROJECT, localPath: reserved.localPath!, mode: 'vps' }],
    sync: { [PROJECT]: reserved },
  });
  render(<ChisaSettingsTab />);
  await act(async () => {});
  act(() => native.listeners.forEach(listener => listener({ ...reserved, status: 'unavailable', sequence: 11 })));
  expect(screen.getByRole('status').textContent).toBe('状态连接已中断');
  const button = screen.getByRole<HTMLButtonElement>('button', { name: /^同步$/ });
  expect(button.disabled).toBe(true);
  fireEvent.click(button);
  expect(native.syncProject).not.toHaveBeenCalled();
});

function projectState(): ChisaState {
  return {
    tunnel: true, serverUrl: 'https://example.invalid',
    mappings: Array.from({ length: 5 }, (_, index) => ({ serverPath: `/srv/project-${index}`, localPath: `C:\\work\\project-${index}`, mode: 'vps' })),
    sync: {
      '/srv/project-0': { status: 'ready', sequence: 10, bindingEpoch: 'binding-a', checkedAt: 'now', serverPath: '/srv/project-0' },
    },
  };
}

test('opening and refreshing settings do not scan projects; one explicit request measures one project', async () => {
  native.getState.mockResolvedValue(projectState());
  let finish!: (value: Record<string, unknown>) => void;
  native.getProjectStorage.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  render(<ChisaSettingsTab />);
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: '刷新状态' }));
  await act(async () => {});
  expect(native.getProjectStorage).not.toHaveBeenCalled();
  expect(screen.getAllByText('本地：未统计')).toHaveLength(5);

  fireEvent.click(screen.getByRole('button', { name: '统计空间：C:\\work\\project-0' }));
  expect(native.getProjectStorage).toHaveBeenCalledExactlyOnceWith('/srv/project-0');
  expect(screen.getAllByText('本地：统计中…')).toHaveLength(1);
  expect(screen.getAllByText('本地：未统计')).toHaveLength(4);
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '刷新状态' }).disabled).toBe(false);
  await act(async () => finish({ '/srv/project-0': { localBytes: 1024, serverBytes: 2048 } }));
  expect(screen.getByText('本地：1 KiB')).toBeDefined();
  expect(screen.getByText('服务器：2 KiB')).toBeDefined();
  expect(screen.getAllByText('本地：未统计')).toHaveLength(4);
});

test.each(['account', 'connection', 'binding'] as const)('storage replies are discarded after a %s replacement', async replacement => {
  const state = projectState();
  native.getState.mockResolvedValue(state);
  let finish!: (value: Record<string, unknown>) => void;
  native.getProjectStorage.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  render(<ChisaSettingsTab />);
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: '统计空间：C:\\work\\project-0' }));
  act(() => {
    if (replacement === 'account') {
      native.authVersion++;
      window.dispatchEvent(new Event('auth-identity-changed'));
    } else if (replacement === 'connection') {
      native.connectionVersion++;
      window.dispatchEvent(new Event('server-connection-changed'));
    } else {
      native.listeners.forEach(listener => listener({ ...state.sync!['/srv/project-0'], sequence: 11, bindingEpoch: 'replacement' }));
    }
  });
  await act(async () => finish({ '/srv/project-0': { localBytes: 1024, serverBytes: 2048 } }));
  expect(screen.queryByText('本地：1 KiB')).toBeNull();
  expect(screen.getAllByText('本地：未统计')).toHaveLength(5);
});

const OLD_MAPPING = {
  serverPath: PROJECT, localPath: 'C:\\work\\old-project', bindingEpoch: 'old-binding', mode: 'vps' as const,
};
const OTHER_OLD_MAPPING = {
  serverPath: '/srv/project-b', localPath: 'C:\\work\\other-old-project', bindingEpoch: 'other-old-binding', mode: 'vps' as const,
};
const SWITCHED_PROJECT = { localPath: OLD_MAPPING.localPath, serverPath: '/work/current-account/old-project-12ab34' };

test('old bindings offer a project-specific switch when the current account has no active mappings', async () => {
  native.getState.mockResolvedValue({
    tunnel: false, serverUrl: 'https://current.example.invalid', mappings: [], inactiveMappings: [OLD_MAPPING],
  });
  render(<ChisaSettingsTab />);
  await act(async () => {});

  expect(screen.getByRole('heading', { name: '其他账号的项目' })).toBeDefined();
  expect(screen.getByText(OLD_MAPPING.localPath)).toBeDefined();
  expect(screen.getByText(OLD_MAPPING.serverPath)).toBeDefined();
  expect(screen.getByRole<HTMLButtonElement>('button', { name: `切换此项目：${OLD_MAPPING.localPath}` }).disabled).toBe(false);
  expect(screen.queryByRole('button', { name: '切换到当前账号' })).toBeNull();
  expect(screen.queryByRole('button', { name: /解除旧绑定/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /^同步$/ })).toBeNull();
  expect(native.syncProject).not.toHaveBeenCalled();
  expect(native.revoke).not.toHaveBeenCalled();
});

test('switching one project registers only its rebound path and keeps the other old binding available', async () => {
  const currentMapping = { ...OLD_MAPPING, ...SWITCHED_PROJECT, bindingEpoch: 'current-binding' };
  const state: ChisaState = {
    tunnel: false, serverUrl: 'https://current.example.invalid', mappings: [], inactiveMappings: [OLD_MAPPING, OTHER_OLD_MAPPING],
  };
  native.getState.mockResolvedValueOnce(state).mockResolvedValue({ ...state, tunnel: true, mappings: [currentMapping], inactiveMappings: [OTHER_OLD_MAPPING] });
  let finish!: (result: ChisaWorkspaceSwitchResult) => void;
  native.switchAccountWorkspace.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  render(<ChisaSettingsTab />);
  await act(async () => {});
  expect(screen.getByText(OTHER_OLD_MAPPING.localPath)).toBeDefined();

  fireEvent.click(screen.getByRole('button', { name: `切换此项目：${OLD_MAPPING.localPath}` }));
  const pendingButton = screen.getByRole<HTMLButtonElement>('button', { name: `切换此项目：${OLD_MAPPING.localPath}` });
  expect(pendingButton.textContent).toBe('正在切换…');
  expect(pendingButton.disabled).toBe(true);
  fireEvent.click(pendingButton);
  const otherButton = screen.getByRole<HTMLButtonElement>('button', { name: `切换此项目：${OTHER_OLD_MAPPING.localPath}` });
  expect(otherButton.disabled).toBe(true);
  expect(otherButton.textContent).toBe('切换此项目');
  fireEvent.click(otherButton);
  expect(native.switchAccountWorkspace).toHaveBeenCalledExactlyOnceWith([
    { serverPath: PROJECT, bindingEpoch: OLD_MAPPING.bindingEpoch },
  ]);
  await act(async () => finish({ ok: true, projects: [SWITCHED_PROJECT] }));

  expect(screen.queryByRole('button', { name: `切换此项目：${OLD_MAPPING.localPath}` })).toBeNull();
  expect(screen.queryByText(OLD_MAPPING.serverPath)).toBeNull();
  expect(screen.getByRole<HTMLButtonElement>('button', { name: `切换此项目：${OTHER_OLD_MAPPING.localPath}` }).disabled).toBe(false);
  expect(screen.getByText(currentMapping.localPath)).toBeDefined();
  expect(screen.getByText(currentMapping.serverPath)).toBeDefined();
  expect(native.createProject).toHaveBeenCalledExactlyOnceWith({
    name: 'old-project-12ab34', path: SWITCHED_PROJECT.serverPath, customName: 'old-project',
  });
  expect(native.recordLocalSelection).toHaveBeenCalledExactlyOnceWith(SWITCHED_PROJECT);
  expect(native.refreshProjects).toHaveBeenCalledTimes(1);
  expect(screen.getByText(/^所选项目已切换到当前账号，其他项目保留原绑定/).getAttribute('role')).toBe('status');
  expect(screen.getByText('当前后端：', { exact: false }).textContent).toContain('VPS Linux');
  expect(native.syncProject).not.toHaveBeenCalled();
  expect(native.revoke).not.toHaveBeenCalled();
  expect(native.forgetMapping).not.toHaveBeenCalled();
  expect(native.connectAccountWorkspace).not.toHaveBeenCalled();
});

test('a failed project switch keeps its old binding and restores its action with the supplied reason', async () => {
  native.getState.mockResolvedValue({
    tunnel: false, serverUrl: 'https://current.example.invalid', mappings: [], inactiveMappings: [OLD_MAPPING],
  });
  native.switchAccountWorkspace.mockResolvedValue({ ok: false, error: '本机同步尚未停止，请稍后重试' });
  render(<ChisaSettingsTab />);
  await act(async () => {});

  fireEvent.click(screen.getByRole('button', { name: `切换此项目：${OLD_MAPPING.localPath}` }));
  await act(async () => {});

  expect(screen.getByRole('status').textContent).toBe('本机同步尚未停止，请稍后重试');
  expect(screen.getByText(OLD_MAPPING.localPath)).toBeDefined();
  expect(screen.getByRole<HTMLButtonElement>('button', { name: `切换此项目：${OLD_MAPPING.localPath}` }).disabled).toBe(false);
  expect(native.syncProject).not.toHaveBeenCalled();
  expect(native.revoke).not.toHaveBeenCalled();
  expect(native.forgetMapping).not.toHaveBeenCalled();
  expect(native.connectAccountWorkspace).not.toHaveBeenCalled();
  expect(native.createProject).not.toHaveBeenCalled();
  expect(native.refreshProjects).not.toHaveBeenCalled();
});

test('an unidentified old binding disables only its own switch', async () => {
  native.getState.mockResolvedValue({
    tunnel: false, serverUrl: 'https://current.example.invalid', mappings: [],
    inactiveMappings: [OLD_MAPPING, { localPath: 'C:\\work\\unidentified-project', serverPath: '/srv/unidentified-project' }],
  });
  render(<ChisaSettingsTab />);
  await act(async () => {});
  expect(screen.getByRole<HTMLButtonElement>('button', { name: `切换此项目：${OLD_MAPPING.localPath}` }).disabled).toBe(false);
  const button = screen.getByRole<HTMLButtonElement>('button', { name: '切换此项目：C:\\work\\unidentified-project' });
  expect(button.disabled).toBe(true);
  fireEvent.click(button);
  expect(native.switchAccountWorkspace).not.toHaveBeenCalled();
});

test.each(['account', 'connection'] as const)('a late project-switch result is ignored after a %s replacement', async replacement => {
  const replacementMapping = { ...OLD_MAPPING, localPath: 'C:\\work\\replacement-project', bindingEpoch: 'replacement-binding' };
  native.getState.mockResolvedValueOnce({
    tunnel: false, serverUrl: 'https://old.example.invalid', mappings: [], inactiveMappings: [OLD_MAPPING],
  }).mockResolvedValue({
    tunnel: false, serverUrl: 'https://replacement.example.invalid', mappings: [], inactiveMappings: [replacementMapping],
  });
  let finish!: (result: ChisaWorkspaceSwitchResult) => void;
  native.switchAccountWorkspace.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  render(<ChisaSettingsTab />);
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: `切换此项目：${OLD_MAPPING.localPath}` }));

  act(() => {
    if (replacement === 'account') {
      native.authVersion++;
      window.dispatchEvent(new Event('auth-identity-changed'));
    } else {
      native.connectionVersion++;
      window.dispatchEvent(new Event('server-connection-changed'));
    }
  });
  await act(async () => {});
  await act(async () => finish({ ok: true, projects: [SWITCHED_PROJECT] }));

  expect(screen.queryByText(OLD_MAPPING.localPath)).toBeNull();
  expect(screen.getByText(replacementMapping.localPath)).toBeDefined();
  expect(screen.getByRole<HTMLButtonElement>('button', { name: `切换此项目：${replacementMapping.localPath}` }).disabled).toBe(false);
  expect(screen.queryByRole('status')).toBeNull();
  expect(native.getState).toHaveBeenCalledTimes(2);
  expect(native.syncProject).not.toHaveBeenCalled();
  expect(native.revoke).not.toHaveBeenCalled();
  expect(native.createProject).not.toHaveBeenCalled();
  expect(native.recordLocalSelection).not.toHaveBeenCalled();
  expect(native.refreshProjects).not.toHaveBeenCalled();
});

test.each([
  { format: 'nested details', payload: { details: '旧版错误详情', error: { details: '目录 /opt/project 不在允许的工作区内', message: 'Internal server error' } }, reason: '目录 /opt/project 不在允许的工作区内' },
  { format: 'legacy details', payload: { details: '项目列表保存被拒绝', error: { message: 'Internal server error' } }, reason: '项目列表保存被拒绝' },
  { format: 'message', payload: { error: { message: '项目列表保存被拒绝' } }, reason: '项目列表保存被拒绝' },
])('a project list failure reports $format separately from the completed switch and retains unselected bindings', async ({ payload, reason }) => {
  const currentMapping = { ...OLD_MAPPING, ...SWITCHED_PROJECT, bindingEpoch: 'current-binding' };
  const state: ChisaState = {
    tunnel: false, serverUrl: 'https://current.example.invalid', mappings: [], inactiveMappings: [OLD_MAPPING, OTHER_OLD_MAPPING],
  };
  native.getState.mockResolvedValueOnce(state).mockResolvedValue({ ...state, tunnel: true, mappings: [currentMapping], inactiveMappings: [OTHER_OLD_MAPPING] });
  native.switchAccountWorkspace.mockResolvedValue({ ok: true, projects: [SWITCHED_PROJECT] });
  native.createProject.mockResolvedValueOnce(Response.json(payload, { status: 403 }));
  render(<ChisaSettingsTab />);
  await act(async () => {});

  fireEvent.click(screen.getByRole('button', { name: `切换此项目：${OLD_MAPPING.localPath}` }));
  await act(async () => {});

  expect(screen.getByText(`项目已切换，但更新项目列表失败：${reason}`).getAttribute('role')).toBe('status');
  expect(screen.getByText(currentMapping.serverPath)).toBeDefined();
  expect(screen.queryByRole('button', { name: `切换此项目：${OLD_MAPPING.localPath}` })).toBeNull();
  expect(screen.getByRole<HTMLButtonElement>('button', { name: `切换此项目：${OTHER_OLD_MAPPING.localPath}` }).disabled).toBe(false);
  expect(native.createProject).toHaveBeenCalledTimes(1);
  expect(native.recordLocalSelection).not.toHaveBeenCalled();
  expect(native.refreshProjects).not.toHaveBeenCalled();
});

test('settled workspace connections refresh the visible backend without polling or project synchronization', async () => {
  const disconnected: ChisaState = { tunnel: false, serverUrl: 'https://current.example.invalid', mappings: [] };
  native.getState.mockResolvedValueOnce(disconnected).mockResolvedValue({ ...disconnected, tunnel: true });
  const view = render(<ChisaSettingsTab />);
  await act(async () => {});
  expect(screen.getByText('当前后端：', { exact: false }).textContent).toContain('VPS 尚未连接');
  expect(native.getState).toHaveBeenCalledTimes(1);

  await act(async () => native.connectionListeners.forEach(listener => listener()));

  expect(screen.getByText('当前后端：', { exact: false }).textContent).toContain('VPS Linux');
  expect(native.getState).toHaveBeenCalledTimes(2);
  expect(native.syncProject).not.toHaveBeenCalled();
  expect(native.getProjectStorage).not.toHaveBeenCalled();
  view.unmount();
  native.connectionListeners.forEach(listener => listener());
  expect(native.getState).toHaveBeenCalledTimes(2);
});

test('remote preview recovery does not delay ordinary settings and updates only its section', async () => {
  const state = projectState();
  native.getState.mockResolvedValue(state);
  let finish!: (state: ChisaState) => void;
  native.refreshPreviews.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  render(<ChisaSettingsTab />);
  await act(async () => {});
  expect(screen.getByText('C:\\work\\project-0')).toBeDefined();
  expect(native.refreshPreviews).toHaveBeenCalledTimes(1);
  await act(async () => finish({ ...state, mappings: [], previews: [{ id: 'remote-preview', serverPath: PROJECT, localUrl: '' }] }));
  expect(screen.getByText('已恢复的远端预览')).toBeDefined();
  expect(screen.getByText('C:\\work\\project-0')).toBeDefined();
});

test('a late preview recovery cannot restore a capability after an explicit stop', async () => {
  const state: ChisaState = { ...projectState(), previews: [{ id: 'remote-preview', serverPath: PROJECT, localUrl: '' }] };
  native.getState.mockResolvedValueOnce(state).mockResolvedValue({ ...state, previews: [] });
  native.stopPreview.mockResolvedValue({ ok: true });
  let finish!: (state: ChisaState) => void;
  native.refreshPreviews.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  render(<ChisaSettingsTab />);
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: '停止' }));
  await act(async () => {});
  await act(async () => finish(state));
  expect(screen.queryByText('已恢复的远端预览')).toBeNull();
  expect(native.stopPreview).toHaveBeenCalledExactlyOnceWith('remote-preview');
});

test('preview discovery failure leaves connection and project controls usable', async () => {
  native.getState.mockResolvedValue(projectState());
  native.refreshPreviews.mockRejectedValueOnce(new Error('无法连接预览服务'));
  render(<ChisaSettingsTab />);
  await act(async () => {});
  expect(screen.getByRole('alert').textContent).toBe('无法连接预览服务');
  expect(screen.getByText('C:\\work\\project-0')).toBeDefined();
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '刷新状态' }).disabled).toBe(false);
});
