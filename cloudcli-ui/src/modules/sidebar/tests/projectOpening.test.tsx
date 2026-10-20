import React, { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import Sidebar from '@/modules/sidebar/Sidebar';
import { api } from '@/shared/api';
import { FrontendBridge } from '@/shared/chisa';
import type { Project } from '@/shared/types';
import { getBlockingOperations } from '@/shared/utils';
import { BlockingOperationDialog } from '@/shared/ui/BlockingOperationDialog';

const mocks = vi.hoisted(() => ({ refresh: vi.fn(), currentProject: vi.fn(), newSession: vi.fn(), openSettings: vi.fn(), register: vi.fn() }));
const openedProject: Project = { projectId: 'opened', displayName: 'ams-载货车', fullPath: '/work/ams' };

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/shared/hooks/useDeviceSettings', () => ({ useDeviceSettings: () => ({ isPWA: false }) }));
// Account presentation is independent of these directory-opening transitions.
vi.mock('@/modules/auth', () => ({ AccountMenu: () => null, AccountAvatar: () => null, useAuth: () => ({ user: null }) }));
vi.mock('@/shared/context/UiPreferencesContext', () => ({
  useUiPreferences: () => ({ sidebarVisible: true }), useSetUiPreference: () => vi.fn(),
}));
vi.mock('@/shared/context/SessionProtectionContext', () => ({ useBusySessionIdSet: () => new Set() }));
vi.mock('@/modules/task-master', () => ({
  useTaskMaster: () => ({ setCurrentProject: mocks.currentProject }), useTasksSettings: () => ({ tasksEnabled: false }),
}));
vi.mock('@/modules/command-palette', () => ({
  usePaletteOps: () => ({ refreshProjects: mocks.refresh, openSettings: mocks.openSettings }),
  usePaletteOpsRegister: mocks.register,
}));
vi.mock('@/shared/chisa', () => ({
  isDesktop: () => true, FrontendBridge: { selectLocalFolder: vi.fn() }, recordLocalSelection: vi.fn(),
  subscribeWorkspaceSynchronization: () => () => {},
}));
vi.mock('@/modules/sidebar/hooks/useSidebarController', () => ({
  useSidebarController: () => {
    // Start with a different view and a filter that hides the opened directory.
    const [searchMode, setSearchMode] = useState('conversations');
    const [searchFilter, setSearchFilter] = useState('old conversation');
    return { searchMode, setSearchMode, searchFilter, setSearchFilter, clearConversationResults: vi.fn() };
  },
}));
vi.mock('@/modules/sidebar/SidebarContent', () => ({
  default: (props: { searchMode: string; searchFilter: string; onCreateProject: () => void }) => (
    <><div data-testid="view">{props.searchMode}:{props.searchFilter}</div>
      <button onClick={props.onCreateProject}>Open directory</button></>
  ),
}));
vi.mock('@/modules/sidebar/SidebarModals', () => ({ default: () => null }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(FrontendBridge.selectLocalFolder).mockResolvedValue({ ok: true, localPath: 'C:\\work\\ams', serverPath: '/work/ams' });
});
afterEach(cleanup);

function showSidebar(projects: Project[] = []) {
  render(<><BlockingOperationDialog /><Sidebar projects={projects} selectedProject={null} selectedSession={null} attentionSessionIds={new Set()}
    onProjectSelect={vi.fn()} onSessionSelect={vi.fn()} onNewSession={mocks.newSession}
    isLoading={false} loadingProgress={null} onRefresh={mocks.refresh} onShowSettings={vi.fn()}
    showSettings={false} settingsInitialTab="general" onCloseSettings={vi.fn()} isMobile={false} /></>);
}

test('opening a new directory reveals projects and starts its blank draft', async () => {
  vi.spyOn(api, 'createProject').mockResolvedValue(Response.json({ project: openedProject }, { status: 201 }));
  showSidebar();
  fireEvent.click(screen.getByRole('button', { name: 'Open directory' }));
  await waitFor(() => expect(mocks.newSession).toHaveBeenCalledWith(openedProject));
  expect(screen.getByTestId('view').textContent).toBe('projects:');
  expect(mocks.currentProject).toHaveBeenCalledWith(openedProject);
  expect(mocks.refresh).toHaveBeenCalledTimes(1);
});

test('the welcome action uses the same native directory picker and project flow', async () => {
  vi.spyOn(api, 'createProject').mockResolvedValue(Response.json({ project: openedProject }, { status: 201 }));
  showSidebar();
  act(() => mocks.register.mock.lastCall![0].createProject());
  await waitFor(() => expect(mocks.newSession).toHaveBeenCalledWith(openedProject));
  expect(FrontendBridge.selectLocalFolder).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId('view').textContent).toBe('projects:');
});

test('reopening a registered directory opens its draft without creating another project', async () => {
  const create = vi.spyOn(api, 'createProject');
  showSidebar([openedProject]);
  fireEvent.click(screen.getByRole('button', { name: 'Open directory' }));
  await waitFor(() => expect(mocks.newSession).toHaveBeenCalledWith(openedProject));
  expect(create).not.toHaveBeenCalled();
  expect(screen.getByTestId('view').textContent).toBe('projects:');
});

test.each([
  { error: { message: 'Directory unavailable', details: 'Workspace path is outside the configured root' } },
  { error: 'Directory unavailable', details: 'Workspace path is outside the configured root' },
])('a failed project creation replaces the busy dialog with the full API error: %j', async (failure) => {
  let failCreation!: (response: Response) => void;
  vi.spyOn(api, 'createProject').mockImplementation(() => new Promise(resolve => { failCreation = resolve; }));
  const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
  showSidebar();
  fireEvent.click(screen.getByRole('button', { name: 'Open directory' }));
  await waitFor(() => expect(failCreation).toBeDefined());
  expect(screen.getByRole('dialog', { name: '正在打开工作目录' })).toBeDefined();
  await act(async () => failCreation(Response.json(failure, { status: 403 })));
  await screen.findByRole('dialog', { name: '打开本地目录失败' });
  expect(screen.getByText(/Directory unavailable/).textContent).toContain('Workspace path is outside the configured root');
  expect(screen.queryByRole('dialog', { name: '正在打开工作目录' })).toBeNull();
  expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  expect(getBlockingOperations()).toHaveLength(0);
  expect(alert).not.toHaveBeenCalled();
  expect(mocks.newSession).not.toHaveBeenCalled();
  expect(mocks.refresh).not.toHaveBeenCalled();
  expect(screen.getByTestId('view').textContent).toBe('conversations:old conversation');
  fireEvent.click(screen.getByRole('button', { name: '确定' }));
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('enrollment failure releases the busy dialog and permits retry after dismissing its error', async () => {
  vi.mocked(FrontendBridge.selectLocalFolder).mockResolvedValueOnce({
    ok: false, error: '自动文件同步授权失败（HTTP 404），请重新连接文件同步',
  });
  const create = vi.spyOn(api, 'createProject').mockResolvedValue(Response.json({ project: openedProject }, { status: 201 }));
  const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
  showSidebar();
  fireEvent.click(screen.getByRole('button', { name: 'Open directory' }));
  await screen.findByRole('dialog', { name: '打开本地目录失败' });
  expect(screen.getByText(/HTTP 404/)).toBeDefined();
  expect(screen.queryByRole('dialog', { name: '正在打开工作目录' })).toBeNull();
  expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  expect(getBlockingOperations()).toHaveLength(0);
  expect(alert).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
  expect(mocks.newSession).not.toHaveBeenCalled();
  expect(screen.getByTestId('view').textContent).toBe('conversations:old conversation');
  fireEvent.click(screen.getByRole('button', { name: '确定' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Open directory' }));
  await waitFor(() => expect(mocks.newSession).toHaveBeenCalledWith(openedProject));
  expect(getBlockingOperations()).toHaveLength(0);
});

test('opening a directory stays blocked through project creation and list refresh', async () => {
  let created!: (response: Response) => void;
  let refreshed!: () => void;
  vi.spyOn(api, 'createProject').mockImplementation(() => new Promise(resolve => { created = resolve; }));
  mocks.refresh.mockImplementationOnce(() => new Promise<void>(resolve => { refreshed = resolve; }));
  showSidebar();
  fireEvent.click(screen.getByRole('button', { name: 'Open directory' }));
  await waitFor(() => expect(created).toBeDefined());
  expect(getBlockingOperations()).toHaveLength(1);
  expect(screen.getByRole('dialog', { name: '正在打开工作目录' })).toBeDefined();
  created(Response.json({ project: openedProject }, { status: 201 }));
  await waitFor(() => expect(refreshed).toBeDefined());
  expect(getBlockingOperations()).toHaveLength(1);
  refreshed();
  await waitFor(() => expect(getBlockingOperations()).toHaveLength(0));
});

test('an old binding conflict opens sync settings after releasing the directory-opening overlay', async () => {
  let selected!: (result: Record<string, unknown>) => void;
  vi.mocked(FrontendBridge.selectLocalFolder).mockReturnValueOnce(new Promise(resolve => { selected = resolve; }));
  const create = vi.spyOn(api, 'createProject');
  const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
  mocks.openSettings.mockImplementationOnce(() => {
    expect(getBlockingOperations()).toHaveLength(0);
  });
  showSidebar();
  fireEvent.click(screen.getByRole('button', { name: 'Open directory' }));
  await waitFor(() => expect(selected).toBeDefined());
  expect(getBlockingOperations()).toHaveLength(1);

  await act(async () => selected({ ok: false, action: 'manage-mappings', error: '当前本机目录绑定属于其他同步连接' }));

  expect(mocks.openSettings).toHaveBeenCalledExactlyOnceWith('chisa');
  expect(getBlockingOperations()).toHaveLength(0);
  expect(alert).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
  expect(mocks.newSession).not.toHaveBeenCalled();
  expect(mocks.refresh).not.toHaveBeenCalled();
  expect(screen.getByTestId('view').textContent).toBe('conversations:old conversation');
});
