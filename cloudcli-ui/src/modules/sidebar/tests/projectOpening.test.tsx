import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import Sidebar from '@/modules/sidebar/Sidebar';
import { ProjectCreationWizard } from '@/modules/project-creation-wizard';
import { api } from '@/shared/api';
import type { Project } from '@/shared/types';
import { getBlockingOperations } from '@/shared/utils';
import { BlockingOperationDialog } from '@/shared/ui/BlockingOperationDialog';

const mocks = vi.hoisted(() => ({ refresh: vi.fn(), currentProject: vi.fn(), newSession: vi.fn(), register: vi.fn(), nativeCall: vi.fn() }));
const openedProject: Project = { projectId: 'opened', displayName: 'Cloud project', fullPath: '/cloud/project' };

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('mygo-runtime', () => ({ call: mocks.nativeCall }));
vi.mock('@/shared/hooks/useDeviceSettings', () => ({ useDeviceSettings: () => ({ isPWA: false }) }));
vi.mock('@/modules/auth', () => ({ AccountMenu: () => null, AccountAvatar: () => null, useAuth: () => ({ user: null }) }));
vi.mock('@/shared/context/UiPreferencesContext', () => ({
  useUiPreferences: () => ({ sidebarVisible: true }), useSetUiPreference: () => vi.fn(),
}));
vi.mock('@/shared/context/SessionProtectionContext', () => ({ useBusySessionIdSet: () => new Set() }));
vi.mock('@/modules/task-master', () => ({
  useTaskMaster: () => ({ setCurrentProject: mocks.currentProject }), useTasksSettings: () => ({ tasksEnabled: false }),
}));
vi.mock('@/modules/command-palette', () => ({
  usePaletteOps: () => ({ refreshProjects: mocks.refresh }), usePaletteOpsRegister: mocks.register,
}));
vi.mock('@/modules/sidebar/hooks/useSidebarController', () => ({
  useSidebarController: () => {
    // Start with recents to verify that cloud creation reveals the project view.
    const [searchMode, setSearchMode] = useState('conversations');
    // A pre-existing search must be cleared so it cannot hide the created project.
    const [searchFilter, setSearchFilter] = useState('old conversation');
    // Exercise the sidebar's real open/close state for the cloud project wizard.
    const [showNewProject, setShowNewProject] = useState(false);
    return { searchMode, setSearchMode, searchFilter, setSearchFilter, showNewProject, setShowNewProject, clearConversationResults: vi.fn() };
  },
}));
vi.mock('@/modules/sidebar/SidebarContent', () => ({
  default: (props: { searchMode: string; searchFilter: string; onCreateProject: () => void }) => (
    <><div data-testid="view">{props.searchMode}:{props.searchFilter}</div>
      <button onClick={props.onCreateProject}>Add cloud project</button></>
  ),
}));
vi.mock('@/modules/sidebar/SidebarModals', () => ({
  default: ({ showNewProject, onCloseNewProject, onProjectCreated }: { showNewProject: boolean; onCloseNewProject: () => void; onProjectCreated: (project?: Record<string, unknown>) => Promise<void> }) => showNewProject
    ? <ProjectCreationWizard onClose={onCloseNewProject} onProjectCreated={onProjectCreated} /> : null,
}));

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function showSidebar() {
  render(<><BlockingOperationDialog /><Sidebar projects={[]} selectedProject={null} selectedSession={null} attentionSessionIds={new Set()}
    onProjectSelect={vi.fn()} onSessionSelect={vi.fn()} onNewSession={mocks.newSession}
    isLoading={false} loadingProgress={null} onRefresh={mocks.refresh} onShowSettings={vi.fn()}
    showSettings={false} settingsInitialTab="general" onCloseSettings={vi.fn()} isMobile={false} /></>);
}

function reviewCloudProject() {
  fireEvent.change(screen.getByPlaceholderText('/path/to/project/workspace'), { target: { value: openedProject.fullPath } });
  fireEvent.click(screen.getByRole('button', { name: 'projectWizard.buttons.next' }));
  expect(screen.getByText(openedProject.fullPath)).toBeDefined();
  expect(screen.queryByText('本地文件夹')).toBeNull();
}

test('desktop project creation opens the cloud wizard directly and reveals the returned project', async () => {
  const create = vi.spyOn(api, 'createProject').mockResolvedValue(Response.json({ project: openedProject }, { status: 201 }));
  showSidebar();
  fireEvent.click(screen.getByRole('button', { name: 'Add cloud project' }));
  expect(screen.queryByText('从本地目录初始化（可选）')).toBeNull();
  expect(screen.queryByRole('button', { name: '本机' })).toBeNull();
  reviewCloudProject();
  fireEvent.click(screen.getByRole('button', { name: 'projectWizard.buttons.createProject' }));
  await waitFor(() => expect(mocks.newSession).toHaveBeenCalledWith(openedProject));
  expect(create).toHaveBeenCalledExactlyOnceWith({ path: openedProject.fullPath });
  expect(screen.getByTestId('view').textContent).toBe('projects:');
  expect(mocks.currentProject).toHaveBeenCalledWith(openedProject);
  expect(mocks.refresh).toHaveBeenCalledTimes(1);
  expect(mocks.nativeCall).not.toHaveBeenCalled();
});

test('welcome and command palette share the cloud project wizard', () => {
  showSidebar();
  act(() => mocks.register.mock.lastCall![0].createProject());
  expect(screen.getByPlaceholderText('/path/to/project/workspace')).toBeDefined();
  expect(mocks.nativeCall).not.toHaveBeenCalled();
});

test('a cloud creation failure keeps the wizard editable and releases the busy dialog', async () => {
  vi.spyOn(api, 'createProject').mockResolvedValue(Response.json({ error: { message: 'Directory unavailable', details: 'Cloud path is outside the configured root' } }, { status: 403 }));
  showSidebar();
  fireEvent.click(screen.getByRole('button', { name: 'Add cloud project' }));
  reviewCloudProject();
  fireEvent.click(screen.getByRole('button', { name: 'projectWizard.buttons.createProject' }));
  await screen.findByText('Cloud path is outside the configured root');
  expect(getBlockingOperations()).toHaveLength(0);
  expect(mocks.newSession).not.toHaveBeenCalled();
  expect(screen.getByTestId('view').textContent).toBe('conversations:old conversation');
  fireEvent.click(screen.getByRole('button', { name: 'projectWizard.buttons.back' }));
  expect((screen.getByPlaceholderText('/path/to/project/workspace') as HTMLInputElement).value).toBe(openedProject.fullPath);
});

test('creating a cloud project remains blocked until project-list refresh completes', async () => {
  let created!: (response: Response) => void;
  let refreshed!: () => void;
  vi.spyOn(api, 'createProject').mockImplementation(() => new Promise(resolve => { created = resolve; }));
  mocks.refresh.mockImplementationOnce(() => new Promise<void>(resolve => { refreshed = resolve; }));
  showSidebar();
  fireEvent.click(screen.getByRole('button', { name: 'Add cloud project' }));
  reviewCloudProject();
  fireEvent.click(screen.getByRole('button', { name: 'projectWizard.buttons.createProject' }));
  await waitFor(() => expect(created).toBeDefined());
  expect(getBlockingOperations()).toHaveLength(1);
  await act(async () => { created(Response.json({ project: openedProject })); });
  await waitFor(() => expect(refreshed).toBeDefined());
  expect(getBlockingOperations()).toHaveLength(1);
  await act(async () => { refreshed(); });
  await waitFor(() => expect(getBlockingOperations()).toHaveLength(0));
});
