import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import { Sidebar } from '@/modules/sidebar';
import { api } from '@/shared/api';
import type * as ChisaRuntime from '@/shared/chisa';
import type { Project, SidebarSearchMode } from '@/shared/types';

const scenario = vi.hoisted(() => ({ collapsed: false }));
const actions = vi.hoisted(() => ({ refresh: vi.fn(), currentProject: vi.fn(), newSession: vi.fn(), register: vi.fn() }));
const createdProject: Project = { projectId: 'created', displayName: 'Created project', fullPath: '/cloud/created' };
const existingProject: Project = { projectId: 'existing', displayName: 'Existing project', fullPath: '/cloud/existing' };

vi.mock('@/shared/chisa', async (importOriginal) => ({
  ...await importOriginal<typeof ChisaRuntime>(),
  isDesktop: () => true,
}));
vi.mock('@/shared/hooks/useDeviceSettings', () => ({ useDeviceSettings: () => ({ isPWA: false }) }));
vi.mock('@/shared/context/UiPreferencesContext', () => ({
  useUiPreferences: () => ({ sidebarVisible: true }),
  useSetUiPreference: () => vi.fn(),
}));
vi.mock('@/shared/context/SessionProtectionContext', () => ({ useBusySessionIdSet: () => new Set() }));
vi.mock('@/modules/auth', () => ({ AccountMenu: () => null }));
vi.mock('@/modules/claude-accounts', () => ({ ClaudeUsageTrigger: () => null }));
vi.mock('@/modules/settings', () => ({ Settings: () => null }));
vi.mock('@/modules/task-master', () => ({
  useTaskMaster: () => ({ setCurrentProject: actions.currentProject, mcpServerStatus: {} }),
  useTasksSettings: () => ({ tasksEnabled: false }),
}));
vi.mock('@/modules/command-palette', () => ({
  usePaletteOps: () => ({ refreshProjects: actions.refresh }),
  usePaletteOpsRegister: actions.register,
}));
vi.mock('@/modules/sidebar/hooks/useSidebarController', () => ({
  useSidebarController: () => {
    // Keep the real Sidebar create callback and modal wiring under test in either rail layout.
    const [showNewProject, setShowNewProject] = useState(false);
    // Creation must still reveal the project view through Sidebar's existing completion callback.
    const [searchMode, setSearchMode] = useState<SidebarSearchMode>('conversations');
    return {
      isSidebarCollapsed: scenario.collapsed,
      showNewProject,
      setShowNewProject,
      searchMode,
      setSearchMode,
      searchFilter: '',
      setSearchFilter: vi.fn(),
      clearConversationResults: vi.fn(),
      activeRename: null,
      expandedProjects: new Set(),
      initialSessionsLoaded: new Set(),
      currentTime: new Date(),
      deletingProjects: new Set(),
      pendingDeletion: null,
      filteredProjects: [],
      archivedProjects: [],
      archivedSessions: [],
      archivedSessionsCount: 0,
      recentConversations: [],
      pinnedConversations: [],
      recentConversationsTotal: 0,
      runningSessionsCount: 0,
      loadingMoreProjects: new Set(),
      getProjectSessions: () => [],
    };
  },
}));

beforeEach(async () => {
  scenario.collapsed = false;
  vi.clearAllMocks();
  localStorage.clear();
  vi.spyOn(api.user, 'savePreferences').mockResolvedValue(Response.json({ success: true }));
  await i18n.changeLanguage('zh-CN');
});

function renderSidebar(selectedProject: Project | null = existingProject) {
  return render(<Sidebar projects={selectedProject ? [selectedProject] : []} selectedProject={selectedProject}
    selectedSession={null} attentionSessionIds={new Set()} onProjectSelect={vi.fn()} onSessionSelect={vi.fn()}
    onNewSession={actions.newSession} isLoading={false} loadingProgress={null} onRefresh={actions.refresh}
    onShowSettings={vi.fn()} showSettings={false} settingsInitialTab="general" onCloseSettings={vi.fn()} isMobile={false} />);
}

function getVisibleCreateEntry() {
  const button = screen.getByRole('button', { name: '新建项目' }) as HTMLButtonElement;
  expect(button.type).toBe('button');
  expect(button.disabled).toBe(false);
  expect(button.tabIndex).toBe(0);
  expect(button.textContent).toContain('新建项目');
  expect(button.closest('[role="menu"]')).toBeNull();
  button.focus();
  expect(document.activeElement).toBe(button);
  return button;
}

test.each([false, true])('desktop project entry opens the existing cloud wizard when collapsed=%s', async (collapsed) => {
  scenario.collapsed = collapsed;
  const create = vi.spyOn(api, 'createProject').mockResolvedValue(Response.json({ project: createdProject }, { status: 201 }));
  renderSidebar();
  const button = getVisibleCreateEntry();
  if (!collapsed) {
    expect(within(screen.getByRole('navigation', { name: '项目' })).getByRole('button', { name: '新建项目' })).toBe(button);
    expect(screen.getByRole('button', { name: /新建会话/ })).toBeTruthy();
  }

  // Keyboard activation of a native button dispatches a click with detail zero.
  fireEvent.click(button, { detail: 0 });
  expect(screen.getByRole('heading', { name: '创建新项目' })).toBeTruthy();
  expect((screen.getByRole('radio', { name: '云端 VPS' }) as HTMLInputElement).checked).toBe(true);
  const pathField = screen.getByPlaceholderText('/path/to/project/workspace');
  expect(actions.newSession).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
  fireEvent.change(pathField, { target: { value: createdProject.fullPath } });
  fireEvent.click(screen.getByRole('button', { name: '下一步' }));
  fireEvent.click(screen.getByRole('button', { name: '创建项目' }));
  await waitFor(() => expect(actions.newSession).toHaveBeenCalledExactlyOnceWith(createdProject));
  await waitFor(() => expect(screen.queryByPlaceholderText('/path/to/project/workspace')).toBeNull());
  expect(create).toHaveBeenCalledExactlyOnceWith({ path: createdProject.fullPath });
  expect(actions.currentProject).toHaveBeenCalledWith(createdProject);
  expect(actions.refresh).toHaveBeenCalledOnce();
});

test('an empty desktop sidebar has one direct create entry and retains the compose shortcut', () => {
  renderSidebar(null);
  const button = getVisibleCreateEntry();
  expect(screen.getAllByRole('button', { name: /新建项目|创建新项目/ })).toHaveLength(1);
  expect(button.getAttribute('aria-keyshortcuts')).toBe('Control+Alt+N Meta+Alt+N');
  fireEvent.keyDown(window, { key: 'n', code: 'KeyN', ctrlKey: true, altKey: true });
  expect(screen.getByPlaceholderText('/path/to/project/workspace')).toBeTruthy();
  expect(actions.newSession).not.toHaveBeenCalled();
});

test('the direct entry shares the command palette wizard callback', () => {
  renderSidebar();
  fireEvent.click(getVisibleCreateEntry());
  expect(screen.getByPlaceholderText('/path/to/project/workspace')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(screen.queryByPlaceholderText('/path/to/project/workspace')).toBeNull();
  act(() => actions.register.mock.lastCall![0].createProject());
  expect(screen.getAllByPlaceholderText('/path/to/project/workspace')).toHaveLength(1);
});

test.each([false, true])('the visible project entry uses the existing English translation when collapsed=%s', async (collapsed) => {
  scenario.collapsed = collapsed;
  await i18n.changeLanguage('en');
  renderSidebar();
  const button = screen.getByRole('button', { name: 'New Project' });
  expect(button.textContent).toContain('New Project');
});
