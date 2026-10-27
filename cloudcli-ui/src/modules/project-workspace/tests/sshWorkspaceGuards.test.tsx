import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import WorkspaceMain from '@/modules/project-workspace/WorkspaceMain';
import type { AppTab, WorkspaceDescriptor } from '@/shared/types';

const panels = vi.hoisted(() => ({ task: vi.fn(() => null), browser: vi.fn(() => null), plugin: vi.fn(() => null), sync: vi.fn() }));
vi.mock('@/modules/chat', () => ({ ChatInterface: () => null }));
vi.mock('@/modules/file-tree', () => ({ FileTree: () => null }));
vi.mock('@/modules/standalone-shell', () => ({ StandaloneShell: () => null }));
vi.mock('@/modules/git-panel', () => ({ GitPanel: () => null }));
vi.mock('@/modules/plugins', () => ({ PluginTabContent: panels.plugin }));
vi.mock('@/modules/browser-use', () => ({ BrowserUsePanel: panels.browser, useBrowserUseEnabled: () => true }));
vi.mock('@/modules/task-master', () => ({ TaskMasterPanel: panels.task, useTaskMasterProjectSync: panels.sync, useTasksSettings: () => ({ tasksEnabled: true, isTaskMasterInstalled: true }) }));
vi.mock('@/modules/command-palette', () => ({ usePaletteOpsRegister: () => {} }));
vi.mock('@/shared/context/UiPreferencesContext', () => ({ useUiPreferences: () => ({}) }));
vi.mock('@/modules/code-editor', () => ({ EditorSidebar: () => null, useEditorSidebar: () => ({ handleFileOpen: vi.fn() }) }));
vi.mock('@/modules/project-workspace/WorkspaceHeader', () => ({ default: () => null }));
vi.mock('@/modules/project-workspace/WorkspaceScopeBar', () => ({ WorkspaceScopeBar: () => null }));
vi.mock('@/modules/project-workspace/ProjectCommandPalette', () => ({ default: () => null }));
vi.mock('@/modules/project-workspace/hooks/useFileOpenResolver', () => ({ useFileOpenResolver: () => vi.fn() }));
const workspace: WorkspaceDescriptor = {
  workspaceId: 'local', projectId: 'local', generation: 'one', sourceMode: 'ssh', displayPath: 'C:\\work\\app', connectionState: 'offline',
  kind: 'cloudReplica', rootPath: '/meta/local', sourceRoot: '/meta/local', requestedMode: 'shared', effectiveMode: 'shared', phase: 'idle', publicationState: 'unpublished',
  capabilities: { read: true, write: true, git: true, shell: true, preview: false, integrate: false, cloudExecutionIndependentOfDesktop: false },
};
vi.mock('@/modules/project-workspace/hooks/useWorkspaceResolution', () => ({ useWorkspaceResolution: () => ({ resolution: { cloudReplica: workspace, session: null }, loading: false, error: null, refresh: vi.fn() }) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

for (const tab of ['plugin:example', 'tasks', 'browser'] as AppTab[]) {
  test(`SSH redirects an unsupported persisted ${tab} tab without mounting its panel`, () => {
    const setActiveTab = vi.fn();
    render(<WorkspaceMain projects={[]} selectedProject={{ projectId: 'local', displayName: 'Local', fullPath: '/meta/local', sourceMode: 'ssh' }} selectedSession={null}
      activeTab={tab} setActiveTab={setActiveTab} ws={null} sendMessage={vi.fn()} isMobile={false} onMenuClick={vi.fn()} isLoading={false}
      onNavigateToSession={vi.fn()} onSessionEstablished={vi.fn()} onShowSettings={vi.fn()} externalMessageUpdate={0} newSessionTrigger={0} onProjectSelect={vi.fn()} onProjectsRefresh={vi.fn()} />);
    expect(setActiveTab).toHaveBeenCalledWith('chat');
    expect(panels.sync).toHaveBeenCalledWith(null);
    expect(panels.plugin).not.toHaveBeenCalled();
    expect(panels.task).not.toHaveBeenCalled();
    expect(panels.browser).not.toHaveBeenCalled();
  });
}
