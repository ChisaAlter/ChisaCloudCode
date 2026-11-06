import React, { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';

import { ChatInterface } from '@/modules/chat';
import { FileTree } from '@/modules/file-tree';
import { StandaloneShell } from '@/modules/standalone-shell';
import { GitPanel } from '@/modules/git-panel';
import { PluginTabContent } from '@/modules/plugins';
import { SshAgentStatus, useSshAgent } from '@/modules/ssh-workspaces';
import { BrowserUsePanel, useBrowserUseEnabled } from '@/modules/browser-use';
import { usePaletteOpsRegister } from '@/modules/command-palette';
import { TaskMasterPanel, useTaskMasterProjectSync, useTasksSettings } from '@/modules/task-master';
import type { AppTab, CodeEditorDiffInfo, DirectoryRevealRequest, Project, ProjectSession, SessionEstablishedContext, SessionNavigationOptions, SettingsMainTab, WorkspaceDescriptor } from '@/shared/types';
import { useUiPreferences } from '@/shared/context/UiPreferencesContext';
import { useFileOpenResolver } from '@/modules/project-workspace/hooks/useFileOpenResolver';
import { EditorSidebar, useEditorSidebar } from '@/modules/code-editor';
import WorkspaceHeader from '@/modules/project-workspace/WorkspaceHeader';
import WorkspaceStateView from '@/modules/project-workspace/WorkspaceStateView';
import WorkspaceErrorBoundary from '@/modules/project-workspace/WorkspaceErrorBoundary';
import { WorkspaceExecutionContext, WorkspaceScopeContext } from '@/shared/context/WorkspaceScopeContext';
import { useWorkspaceResolution } from '@/modules/project-workspace/hooks/useWorkspaceResolution';
import { WorkspaceScopeBar } from '@/modules/project-workspace/WorkspaceScopeBar';
import ProjectCommandPalette from '@/modules/project-workspace/ProjectCommandPalette';

type WorkspaceMainProps = {
  projects: Project[];
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  activeTab: AppTab;
  setActiveTab: Dispatch<SetStateAction<AppTab>>;
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  isMobile: boolean;
  onMenuClick: () => void;
  isLoading: boolean;
  onNavigateToSession: (targetSessionId: string, options?: SessionNavigationOptions) => void;
  onSessionEstablished: (sessionId: string, context: SessionEstablishedContext) => void;
  onShowSettings: (tab?: SettingsMainTab) => void;
  externalMessageUpdate: number;
  newSessionTrigger: number;
  /** Switches the app to another project — used by the git panel's Worktrees view. */
  onProjectSelect: (project: Project) => void;
  /** Silently re-syncs the sidebar project list after worktree projects change. */
  onProjectsRefresh: () => void;
  /** Persists a new title for a session; resolves false when the backend refuses it. Used by the header's inline rename. */
  onRenameSession: (sessionId: string, summary: string) => Promise<boolean>;
};

/** Rendered by ProjectMainRegion to show the selected project's active tab: chat, files, shell, git, tasks, browser or a plugin. */
function WorkspaceMain({
  projects,
  selectedProject,
  selectedSession,
  activeTab,
  setActiveTab,
  ws,
  sendMessage,
  isMobile,
  onMenuClick,
  isLoading,
  onNavigateToSession,
  onSessionEstablished,
  onShowSettings,
  externalMessageUpdate,
  newSessionTrigger,
  onProjectSelect,
  onProjectsRefresh,
  onRenameSession,
}: WorkspaceMainProps) {
  const preferences = useUiPreferences();
  const { showRawParameters, showThinking, sendByCtrlEnter } = preferences;

  const { tasksEnabled, isTaskMasterInstalled } = useTasksSettings();
  const browserUseEnabled = useBrowserUseEnabled();

  useTaskMasterProjectSync(selectedProject?.sourceMode === 'ssh' ? null : selectedProject);
  // The folder an in-chat `path/` reference asked to reveal. Held as an object
  // so that re-clicking the same folder is a new request the tree acts on.
  const [revealDirectory, setRevealDirectory] = useState<DirectoryRevealRequest | null>(null);

  const sshProject = selectedProject?.sourceMode === 'ssh';
  const shouldShowTasksTab = Boolean(!sshProject && tasksEnabled && isTaskMasterInstalled);
  const shouldShowBrowserTab = !sshProject && browserUseEnabled;
  const agent = useSshAgent();
  const workspaceState = useWorkspaceResolution(selectedProject?.projectId, selectedSession?.id, agent?.revision);
  useEffect(() => {
    if (sshProject && selectedProject?.sshConnectionId) void agent?.activate(selectedProject.sshConnectionId);
  }, [sshProject, selectedProject?.sshConnectionId, agent?.activate]);
  // The user's choice survives polling; a new conversation defaults to its execution workspace.
  const selectionKey = JSON.stringify([selectedProject?.projectId, selectedSession?.id]);
  const [scopeChoice, setScopeChoice] = useState<{ key: string; kind: WorkspaceDescriptor['kind'] } | null>(null);
  const workspaceKind = sshProject ? 'cloudReplica' : scopeChoice?.key === selectionKey ? scopeChoice.kind : selectedSession ? 'session' : 'cloudReplica';
  const activeWorkspace = workspaceState.resolution?.[workspaceKind] ?? null;
  const sessionWorkspace = workspaceState.resolution?.session ?? (sshProject ? workspaceState.resolution?.cloudReplica ?? null : null);
  // A running task can revoke writes temporarily without replacing its own mounted observers.
  const scopeKey = JSON.stringify([activeWorkspace?.projectId, activeWorkspace?.kind, activeWorkspace?.sessionId, activeWorkspace?.workspaceId, activeWorkspace?.generation, activeWorkspace?.sourceMode]);
  const scopedProject = useMemo(() => selectedProject && activeWorkspace
    ? { ...selectedProject, fullPath: activeWorkspace.rootPath, path: activeWorkspace.rootPath, sourceMode: activeWorkspace.sourceMode ?? selectedProject.sourceMode, displayPath: activeWorkspace.displayPath ?? selectedProject.displayPath } : null, [selectedProject, activeWorkspace]);

  const {
    editingFile,
    editorWidth,
    editorExpanded,
    hasManualWidth,
    resizeHandleRef,
    handleFileOpen,
    handleCloseEditor,
    handleToggleEditorExpand,
    handleResizeStart,
    handleUnsavedChangesChange,
  } = useEditorSidebar({
    projects,
    selectedProject,
    isMobile,
  });

  // Resolves bare/partial file references (e.g. links inside chat messages) to
  // real project files before opening them in the in-app editor.
  const openWorkspaceFile = useCallback((path: string, diffInfo?: CodeEditorDiffInfo | null, line?: number | null) => {
    return handleFileOpen(path, diffInfo, activeWorkspace, line);
  }, [handleFileOpen, activeWorkspace]);
  const openSessionFile = useCallback((path: string, diffInfo?: CodeEditorDiffInfo | null, line?: number | null) => {
    return handleFileOpen(path, diffInfo, sessionWorkspace, line);
  }, [handleFileOpen, sessionWorkspace]);
  const resolvedFileOpen = useFileOpenResolver(selectedProject, openWorkspaceFile, activeWorkspace);
  const resolvedSessionFileOpen = useFileOpenResolver(selectedProject, openSessionFile, sessionWorkspace);

  useEffect(() => {
    if (!shouldShowTasksTab && activeTab === 'tasks') {
      setActiveTab('chat');
    }
  }, [shouldShowTasksTab, activeTab, setActiveTab]);

  useEffect(() => {
    if ((!shouldShowBrowserTab && activeTab === 'browser') || (sshProject && activeTab.startsWith('plugin:'))) {
      setActiveTab('chat');
    }
  }, [shouldShowBrowserTab, sshProject, activeTab, setActiveTab]);

  // Stable so React.memo(ChatInterface) can bail out: an inline arrow here made
  // every WorkspaceMain render re-render the whole chat tree, including during
  // an editor-divider drag.
  const showAllTasks = useCallback(() => {
    setActiveTab('tasks');
  }, [setActiveTab]);

  const openFile = useCallback((filePath: string) => {
    if (openWorkspaceFile(filePath)) setActiveTab('files');
  }, [openWorkspaceFile, setActiveTab]);

  // Opens the editor side panel in place, keeping the current tab (e.g. chat).
  const openFileInEditor = useCallback((filePath: string, line?: number | null) => {
    const resolve = activeTab === 'chat' ? resolvedSessionFileOpen : resolvedFileOpen;
    resolve(filePath, undefined, line);
  }, [activeTab, resolvedFileOpen, resolvedSessionFileOpen]);

  // Directories cannot be read as text: reveal them in the file tree instead.
  const openDirectory = useCallback((directoryPath: string) => {
    const target = activeTab === 'chat' ? sessionWorkspace : activeWorkspace;
    if (!target?.capabilities.read) return;
    setScopeChoice({ key: selectionKey, kind: target.kind });
    setActiveTab('files');
    setRevealDirectory({ path: directoryPath });
  }, [activeTab, activeWorkspace, selectionKey, sessionWorkspace, setActiveTab]);

  // Stable arguments keep usePaletteOpsRegister's effect from tearing down and
  // rewriting the whole palette registry on every render.
  usePaletteOpsRegister({ openFile, openFileInEditor, openDirectory });

  if (isLoading) {
    return <WorkspaceScopeContext.Provider value={null}><WorkspaceStateView mode="loading" isMobile={isMobile} onMenuClick={onMenuClick} /><ProjectCommandPalette /></WorkspaceScopeContext.Provider>;
  }

  if (!selectedProject) {
    return <WorkspaceScopeContext.Provider value={null}><WorkspaceStateView mode="empty" isMobile={isMobile} onMenuClick={onMenuClick} /><ProjectCommandPalette /></WorkspaceScopeContext.Provider>;
  }

  const workspaceControl = <WorkspaceScopeBar
    key={selectionKey}
    selectionKey={selectionKey}
    workspace={activeWorkspace}
    session={sessionWorkspace}
    kind={workspaceKind}
    hasSession={Boolean(selectedSession)}
    loading={workspaceState.loading}
    error={workspaceState.error}
    onSelect={kind => setScopeChoice({ key: selectionKey, kind })}
    onRefresh={workspaceState.refresh}
    sourceMode={selectedProject.sourceMode}
    displayPath={selectedProject.displayPath || selectedProject.remotePath}
    agentStatus={sshProject && selectedProject.sshConnectionId && (agent?.errors.$profiles || agent?.profiles.some(profile => profile.id === selectedProject.sshConnectionId && profile.mode === 'agent')) ? <SshAgentStatus profileId={selectedProject.sshConnectionId} /> : undefined}
  />;

  return (
    <WorkspaceScopeContext.Provider value={activeWorkspace}>
    <div className="flex h-full flex-col">
      <WorkspaceHeader
        key={scopeKey}
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        selectedProject={selectedProject}
        selectedSession={selectedSession}
        shouldShowTasksTab={shouldShowTasksTab}
        shouldShowBrowserTab={shouldShowBrowserTab}
        isMobile={isMobile}
        onMenuClick={onMenuClick}
        statusControl={sshProject ? workspaceControl : undefined}
        onRenameSession={onRenameSession}
      />

      {!sshProject && workspaceControl}

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className={`flex min-h-0 min-w-[200px] flex-col overflow-hidden ${editorExpanded ? 'hidden' : ''} flex-1`}>
          <div className={`h-full ${activeTab === 'chat' ? 'block' : 'hidden'}`}>
            <WorkspaceErrorBoundary showDetails>
              <WorkspaceScopeContext.Provider value={sessionWorkspace}>
              <WorkspaceExecutionContext.Provider value={sessionWorkspace ?? workspaceState.resolution?.cloudReplica ?? null}>
              <ChatInterface
                isActive={activeTab === 'chat'}
                selectedProject={selectedProject}
                selectedSession={selectedSession}
                ws={ws}
                sendMessage={sendMessage}
                onFileOpen={resolvedSessionFileOpen}
                onNavigateToSession={onNavigateToSession}
                onSessionEstablished={onSessionEstablished}
                onShowSettings={onShowSettings}
                showRawParameters={showRawParameters}
                showThinking={showThinking}
                sendByCtrlEnter={sendByCtrlEnter}
                externalMessageUpdate={externalMessageUpdate}
                newSessionTrigger={newSessionTrigger}
                onShowAllTasks={shouldShowTasksTab ? showAllTasks : null}
              />
              </WorkspaceExecutionContext.Provider>
              </WorkspaceScopeContext.Provider>
            </WorkspaceErrorBoundary>
          </div>

          {activeTab === 'files' && activeWorkspace?.capabilities.read && (
            <div key={scopeKey} className="h-full overflow-hidden">
              <FileTree selectedProject={scopedProject} onFileOpen={openWorkspaceFile} revealDirectory={revealDirectory} />
            </div>
          )}

          {activeTab === 'shell' && activeWorkspace?.capabilities.shell && (
            <div key={scopeKey} className="h-full w-full overflow-hidden">
              <StandaloneShell
                project={scopedProject}
                session={activeWorkspace.kind === 'session' ? selectedSession : null}
                showHeader={false}
                isActive={activeTab === 'shell'}
                isPlainShell={sshProject ? true : null}
              />
            </div>
          )}

          {activeTab === 'git' && activeWorkspace?.capabilities.git && (
            <div key={scopeKey} className="h-full overflow-hidden">
              <GitPanel
                selectedProject={scopedProject}
                isMobile={isMobile}
                onFileOpen={openWorkspaceFile}
                onProjectSelect={onProjectSelect}
                onProjectsRefresh={onProjectsRefresh}
              />
            </div>
          )}

          {((activeTab === 'files' && !activeWorkspace?.capabilities.read) || (activeTab === 'git' && !activeWorkspace?.capabilities.git) || (activeTab === 'shell' && !activeWorkspace?.capabilities.shell)) && (
            <div role="status" className="p-6 text-sm text-muted-foreground">当前工作区暂不支持此操作。请刷新工作区状态，或选择主工作区。</div>
          )}

          {shouldShowTasksTab && <TaskMasterPanel isVisible={activeTab === 'tasks'} />}

          {shouldShowBrowserTab && activeTab === 'browser' && (
            <div className="h-full overflow-hidden">
              <BrowserUsePanel isVisible={activeTab === 'browser'} onShowSettings={onShowSettings} />
            </div>
          )}

          {activeTab.startsWith('plugin:') && !sshProject && activeWorkspace && (
            <div key={scopeKey} className="h-full overflow-hidden">
              <PluginTabContent
                pluginName={activeTab.replace('plugin:', '')}
                selectedProject={scopedProject}
                selectedSession={selectedSession}
              />
            </div>
          )}
        </div>

        <EditorSidebar
          editingFile={editingFile}
          isMobile={isMobile}
          editorExpanded={editorExpanded}
          editorWidth={editorWidth}
          hasManualWidth={hasManualWidth}
          resizeHandleRef={resizeHandleRef}
          onResizeStart={handleResizeStart}
          onCloseEditor={handleCloseEditor}
          onToggleEditorExpand={handleToggleEditorExpand}
          projectPath={editingFile?.workspace?.rootPath ?? selectedProject.path}
          onUnsavedChangesChange={handleUnsavedChangesChange}
          fillSpace={activeTab === 'files'}
        />
      </div>
    </div>
    <ProjectCommandPalette key={scopeKey} />
    </WorkspaceScopeContext.Provider>
  );
}

export default React.memo(WorkspaceMain);
