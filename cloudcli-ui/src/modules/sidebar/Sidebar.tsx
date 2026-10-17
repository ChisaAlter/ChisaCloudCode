import { memo, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { useDeviceSettings } from '@/shared/hooks/useDeviceSettings';
import { useUiPreferences, useSetUiPreference } from '@/shared/context/UiPreferencesContext';
import { useSidebarController } from '@/modules/sidebar/hooks/useSidebarController';
import { useTaskMaster, useTasksSettings } from '@/modules/task-master';
import { usePaletteOps } from '@/modules/command-palette';
import { isDesktop } from '@/shared/chisa';
import { api } from '@/shared/api';
import { beginBlockingOperation } from '@/shared/utils';
import { useBusySessionIdSet } from '@/shared/context/SessionProtectionContext';
import type { LLMProvider, LoadingProgress, MCPServerStatus, Project, ProjectSession, SidebarProjectListProps } from '@/shared/types';
import SidebarCollapsed from '@/modules/sidebar/SidebarCollapsed';
import SidebarContent from '@/modules/sidebar/SidebarContent';
import SidebarModals from '@/modules/sidebar/SidebarModals';

type SidebarProps = {
  projects: Project[];
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  attentionSessionIds: ReadonlySet<string>;
  onProjectSelect: (project: Project) => void;
  onSessionSelect: (session: ProjectSession) => void;
  onNewSession: (project: Project) => void;
  onSessionDelete?: (sessionId: string) => void;
  onLoadMoreSessions?: (projectId: string) => Promise<void> | void;
  // `projectId` is the DB identifier; the sidebar hands it back to the parent
  // when the delete flow completes.
  onProjectDelete?: (projectId: string) => void;
  isLoading: boolean;
  loadingProgress: LoadingProgress | null;
  onRefresh: () => Promise<void> | void;
  onShowSettings: () => void;
  showSettings: boolean;
  settingsInitialTab: string;
  onCloseSettings: () => void;
  isMobile: boolean;
};

type TaskMasterSidebarContext = {
  setCurrentProject: (project: Project) => void;
  mcpServerStatus: MCPServerStatus;
};

/** Exported through the sidebar barrel; the project-workspace module renders it as the app's project and session navigation panel. */
function Sidebar({
  projects,
  selectedProject,
  selectedSession,
  attentionSessionIds,
  onProjectSelect,
  onSessionSelect,
  onNewSession,
  onSessionDelete,
  onLoadMoreSessions,
  onProjectDelete,
  isLoading,
  loadingProgress,
  onRefresh,
  onShowSettings,
  showSettings,
  settingsInitialTab,
  onCloseSettings,
  isMobile,
}: SidebarProps) {
  const { t } = useTranslation(['sidebar', 'common']);
  const { isPWA } = useDeviceSettings({ trackMobile: false });
  const preferences = useUiPreferences();
  const setPreference = useSetUiPreference();
  const { sidebarVisible } = preferences;
  const { setCurrentProject, mcpServerStatus } = useTaskMaster() as TaskMasterSidebarContext;
  const { tasksEnabled } = useTasksSettings();
  const paletteOps = usePaletteOps();
  // Only membership is rendered here, so subscribing to the full activity map
  // would re-render the whole tree on every provider status frame.
  const activeSessions = useBusySessionIdSet();

  const {
    isSidebarCollapsed,
    expandedProjects,
    activeRename,
    showNewProject,
    initialSessionsLoaded,
    currentTime,
    isRefreshing,
    searchFilter,
    searchMode,
    setSearchMode,
    conversationResults,
    isSearching,
    searchProgress,
    clearConversationResults,
    runningSessionsCount,
    deletingProjects,
    pendingDeletion,
    filteredProjects,
    archivedProjects,
    archivedSessions,
    archivedSessionsCount,
    isArchivedSessionsLoading,
    recentConversations,
    recentConversationsTotal,
    recentConversationsHasMore,
    isRecentConversationsLoading,
    isLoadingMoreRecentConversations,
    recentConversationsError,
    reloadRecentConversations,
    loadMoreRecentConversations,
    toggleProject,
    handleSessionClick,
    toggleStarProject,
    isProjectStarred,
    getProjectSessions,
    loadingMoreProjects,
    loadMoreSessionsForProject,
    startEditingProject,
    startEditingSession,
    updateRenameDraft,
    cancelRename,
    saveProjectName,
    showDeleteSessionConfirmation,
    confirmDeleteSession,
    archiveSession,
    requestProjectDelete,
    confirmDeleteProject,
    handleProjectSelect,
    openArchivedSession,
    restoreArchivedProject,
    restoreArchivedSession,
    refreshProjects,
    updateSessionSummary,
    forkSession,
    collapseSidebar: handleCollapseSidebar,
    expandSidebar: handleExpandSidebar,
    setShowNewProject,
    setSearchFilter,
    setPendingDeletion,
  } = useSidebarController({
    projects,
    selectedProject,
    selectedSession,
    activeSessions,
    isLoading,
    isMobile,
    t,
    onRefresh,
    onProjectSelect,
    onSessionSelect,
    onSessionDelete,
    onLoadMoreSessions,
    onProjectDelete,
    setCurrentProject,
    setSidebarVisible: (visible) => setPreference('sidebarVisible', visible),
    sidebarVisible,
  });

  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }

    document.documentElement.classList.toggle('pwa-mode', isPWA);
    document.body.classList.toggle('pwa-mode', isPWA);
  }, [isPWA]);

  const handleProjectCreated = async (project?: Record<string, unknown>) => {
    // A newly opened directory must be visible even when recents or search was active.
    setSearchMode('projects');
    setSearchFilter('');
    clearConversationResults();
    if (project) {
      setCurrentProject(project as Project);
      onNewSession(project as Project);
    }
    await paletteOps.refreshProjects();
  };

  // Stable so memo() on the row components can bail out; an inline arrow here
  // would give every row a new callback on each sidebar render.
  const handleSaveProjectName = useCallback((projectId: string, nextName: string) => {
    void saveProjectName(projectId, nextName);
  }, [saveProjectName]);

  const handleSaveSessionName = useCallback(
    (projectName: string, sessionId: string, summary: string, provider: LLMProvider) => {
      void updateSessionSummary(projectName, sessionId, summary, provider);
    },
    [updateSessionSummary],
  );

  const projectListProps: SidebarProjectListProps = {
    projects,
    filteredProjects,
    selectedProject,
    selectedSession,
    isLoading,
    loadingProgress,
    expandedProjects,
    activeRename,
    initialSessionsLoaded,
    currentTime,
    deletingProjects,
    tasksEnabled,
    mcpServerStatus,
    getProjectSessions,
    loadingMoreProjects,
    activeSessions,
    attentionSessionIds,
    forceExpanded: searchMode === 'running',
    isProjectStarred,
    onRenameDraftChange: updateRenameDraft,
    onToggleProject: toggleProject,
    onProjectSelect: handleProjectSelect,
    onToggleStarProject: toggleStarProject,
    onStartEditingProject: startEditingProject,
    onCancelEditingProject: cancelRename,
    onSaveProjectName: handleSaveProjectName,
    onDeleteProject: requestProjectDelete,
    onSessionSelect: handleSessionClick,
    onDeleteSession: showDeleteSessionConfirmation,
    onArchiveSession: archiveSession,
    onForkSession: forkSession,
    onLoadMoreSessions: loadMoreSessionsForProject,
    onNewSession,
    onStartEditingSession: startEditingSession,
    onCancelEditingSession: cancelRename,
    onSaveEditingSession: handleSaveSessionName,
    t,
  };

  return (
    <>
        <SidebarModals
          projects={projects}
        showSettings={showSettings}
        settingsInitialTab={settingsInitialTab}
        onCloseSettings={onCloseSettings}
        showNewProject={showNewProject}
        onCloseNewProject={() => setShowNewProject(false)}
        onProjectCreated={handleProjectCreated}
        pendingDeletion={pendingDeletion}
        onCancelDeletion={() => setPendingDeletion(null)}
        onConfirmDeleteProject={confirmDeleteProject}
        onConfirmDeleteSession={confirmDeleteSession}
        t={t}
      />

      {isSidebarCollapsed ? (
        <SidebarCollapsed
          onExpand={handleExpandSidebar}
          onShowSettings={onShowSettings}
          t={t}
        />
      ) : (
        <>
        <SidebarContent
            isPWA={isPWA}
            isMobile={isMobile}
            isLoading={isLoading}
            projects={projects}
            runningSessionsCount={runningSessionsCount}
            archivedProjects={archivedProjects}
            archivedSessions={archivedSessions}
            archivedSessionsCount={archivedSessionsCount}
            isArchivedSessionsLoading={isArchivedSessionsLoading}
            recentConversations={recentConversations}
            recentConversationsTotal={recentConversationsTotal}
            recentConversationsHasMore={recentConversationsHasMore}
            isRecentConversationsLoading={isRecentConversationsLoading}
            isLoadingMoreRecentConversations={isLoadingMoreRecentConversations}
            recentConversationsError={recentConversationsError}
            searchFilter={searchFilter}
            onSearchFilterChange={setSearchFilter}
            onClearSearchFilter={() => setSearchFilter('')}
            searchMode={searchMode}
            onSearchModeChange={(mode) => {
              setSearchMode(mode);
              if (mode === 'projects') clearConversationResults();
            }}
            conversationResults={conversationResults}
            isSearching={isSearching}
            searchProgress={searchProgress}
            onRestoreArchivedProject={restoreArchivedProject}
            onLoadMoreRecentConversations={loadMoreRecentConversations}
            onRetryRecentConversations={reloadRecentConversations}
            onArchivedSessionClick={openArchivedSession}
            onRestoreArchivedSession={restoreArchivedSession}
            onDeleteArchivedSession={(session) => {
              showDeleteSessionConfirmation(
                session.sessionId,
                session.sessionTitle,
                { isArchived: true },
              );
            }}
            onConversationResultClick={(projectId: string | null, sessionId: string, provider: string, messageTimestamp?: string | null, messageSnippet?: string | null) => {
              // `projectId` (DB key) is the canonical identifier post-migration.
              // The server emits null when it can't resolve a project row for
              // the search hit; treat that as "no project" and still navigate
              // to the session so the user can open it from the URL.
              const resolvedProvider = (provider || 'claude') as LLMProvider;
              const project = projectId ? projects.find(p => p.projectId === projectId) : null;
              const searchTarget = { __searchTargetTimestamp: messageTimestamp || null, __searchTargetSnippet: messageSnippet || null };
              const sessionObj = {
                id: sessionId,
                __provider: resolvedProvider,
                __projectId: projectId ?? undefined,
                ...searchTarget,
              };
              if (project) {
                handleProjectSelect(project);
                const sessions = getProjectSessions(project);
                const existing = sessions.find(s => s.id === sessionId);
                if (existing) {
                  handleSessionClick({ ...existing, ...searchTarget }, project.projectId);
                } else {
                  handleSessionClick(sessionObj, project.projectId);
                }
              } else {
                handleSessionClick(sessionObj, projectId ?? '');
              }
            }}
            onRefresh={() => {
              void refreshProjects();
            }}
            isRefreshing={isRefreshing}
            onCreateProject={() => {
              if (isDesktop()) {
                // 桌面模式：选择本机文件夹 → 自动同步 + 建项目，不出服务器路径表单
                void (async () => {
                  const finish = beginBlockingOperation('正在打开工作目录', '正在准备工作区并载入项目，请稍候…');
                  try {
                    const { FrontendBridge, recordLocalSelection } = await import('@/shared/chisa');
                    const result = await FrontendBridge.selectLocalFolder();
                    if (result.canceled) return;
                    if (result.action === 'manage-mappings') {
                      finish();
                      paletteOps.openSettings('chisa');
                      return;
                    }
                    if (!result.ok || !result.serverPath) {
                      window.alert(String(result.error || '打开本地目录失败'));
                      return;
                    }
                    recordLocalSelection({
                      localPath: String(result.localPath || ''),
                      serverPath: String(result.serverPath),
                    });
                    const serverPath = String(result.serverPath);
                    const base = serverPath.split('/').filter(Boolean).pop() || 'local-project';
                    const cleanName = base.replace(/-[a-f0-9]{6}$/, '');
                    const existingProject = projects.find((project) =>
                      (project.fullPath || project.path) === serverPath,
                    );
                    if (existingProject) {
                      await handleProjectCreated(existingProject);
                      return;
                    }
                    const response = await api.createProject({ name: base, path: serverPath, customName: cleanName });
                    const data = await response.json();
                    if (!response.ok) {
                      throw new Error(data.error?.details || data.details || data.error?.message || data.error || '创建项目失败');
                    }
                    await handleProjectCreated(data.project);
                  } catch (e) {
                    window.alert('打开本地目录失败：' + (e instanceof Error ? e.message : String(e)));
                  } finally {
                    finish();
                  }
                })();
                return;
              }
              setShowNewProject(true);
            }}
            onCollapseSidebar={handleCollapseSidebar}
            onShowSettings={onShowSettings}
            projectListProps={projectListProps}
            t={t}
          />
        </>
      )}

    </>
  );
}

export default memo(Sidebar);
