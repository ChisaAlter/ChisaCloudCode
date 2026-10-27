import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import WorkspaceMain from '@/modules/project-workspace/WorkspaceMain';
import type { WorkspaceDescriptor } from '@/shared/types';

const lifetime = vi.hoisted(() => ({ headers: [] as AbortSignal[], files: [] as AbortSignal[], workspace: null as WorkspaceDescriptor | null }));
vi.mock('@/modules/project-workspace/WorkspaceHeader', async () => {
  const { useEffect } = await import('react');
  return { default: function HeaderProbe() { useEffect(() => { const controller = new AbortController(); lifetime.headers.push(controller.signal); return () => controller.abort(); }, []); return null; } };
});
vi.mock('@/modules/file-tree', async () => {
  const { useEffect } = await import('react');
  return { FileTree: function FileProbe() { useEffect(() => { const controller = new AbortController(); lifetime.files.push(controller.signal); return () => controller.abort(); }, []); return null; } };
});
vi.mock('@/modules/chat', () => ({ ChatInterface: () => null }));
vi.mock('@/modules/standalone-shell', () => ({ StandaloneShell: () => null }));
vi.mock('@/modules/git-panel', () => ({ GitPanel: () => null }));
vi.mock('@/modules/plugins', () => ({ PluginTabContent: () => null }));
vi.mock('@/modules/browser-use', () => ({ BrowserUsePanel: () => null, useBrowserUseEnabled: () => false }));
vi.mock('@/modules/task-master', () => ({ TaskMasterPanel: () => null, useTaskMasterProjectSync: () => {}, useTasksSettings: () => ({}) }));
vi.mock('@/modules/command-palette', () => ({ usePaletteOpsRegister: () => {} }));
vi.mock('@/shared/context/UiPreferencesContext', () => ({ useUiPreferences: () => ({}) }));
vi.mock('@/modules/code-editor', () => ({ EditorSidebar: () => null, useEditorSidebar: () => ({ handleFileOpen: vi.fn() }) }));
vi.mock('@/modules/project-workspace/WorkspaceScopeBar', () => ({ WorkspaceScopeBar: () => null }));
vi.mock('@/modules/project-workspace/ProjectCommandPalette', () => ({ default: () => null }));
vi.mock('@/modules/project-workspace/hooks/useFileOpenResolver', () => ({ useFileOpenResolver: () => vi.fn() }));
vi.mock('@/modules/project-workspace/hooks/useWorkspaceResolution', () => ({ useWorkspaceResolution: () => ({ resolution: { cloudReplica: lifetime.workspace, session: null }, loading: false, error: null, refresh: vi.fn() }) }));
const workspace: WorkspaceDescriptor = {
  projectId: 'project', workspaceId: 'local', generation: 'one', kind: 'cloudReplica', sourceMode: 'ssh',
  rootPath: '/meta/project', sourceRoot: '/meta/project', requestedMode: 'shared', effectiveMode: 'shared',
  phase: 'idle', publicationState: 'integrated', connectionState: 'offline',
  capabilities: { read: true, write: true, git: true, shell: true, preview: false, integrate: false, cloudExecutionIndependentOfDesktop: false },
};
const content = () => <WorkspaceMain projects={[]} selectedProject={{ projectId: 'project', displayName: 'Local', fullPath: '/meta/project', sourceMode: 'ssh' }} selectedSession={null} activeTab="files" setActiveTab={vi.fn()}
  ws={null} sendMessage={vi.fn()} isMobile={false} onMenuClick={vi.fn()} isLoading={false} onNavigateToSession={vi.fn()} onSessionEstablished={vi.fn()} onShowSettings={vi.fn()}
  externalMessageUpdate={0} newSessionTrigger={0} onProjectSelect={vi.fn()} onProjectsRefresh={vi.fn()} />;
afterEach(() => { cleanup(); lifetime.headers.length = 0; lifetime.files.length = 0; });

test('header and file requests remain mounted through phase polls but reset for a new generation', () => {
  lifetime.workspace = workspace;
  const view = render(content());
  lifetime.workspace = { ...workspace, phase: 'running', capabilities: { ...workspace.capabilities, write: false } };
  view.rerender(content());
  lifetime.workspace = { ...workspace, connectionState: 'online' };
  view.rerender(content());
  expect(lifetime.headers).toHaveLength(1);
  expect(lifetime.files).toHaveLength(1);
  expect(lifetime.headers[0].aborted).toBe(false);
  expect(lifetime.files[0].aborted).toBe(false);
  lifetime.workspace = { ...workspace, generation: 'two' };
  view.rerender(content());
  expect(lifetime.headers[0].aborted).toBe(true);
  expect(lifetime.files[0].aborted).toBe(true);
  expect(lifetime.headers).toHaveLength(2);
  expect(lifetime.files).toHaveLength(2);
});
