import { memo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { useProjectMainState } from '@/modules/project-workspace/context/ProjectsStateContext';
import type { SessionEstablishedContext, SessionNavigationOptions,ProjectWorkspaceShellProps } from '@/shared/types';
import WorkspaceMain from '@/modules/project-workspace/WorkspaceMain';

/** Rendered by ProjectWorkspaceShell to bind this module's project state to WorkspaceMain. */
function ProjectMainRegion({
  isMobile,
  ws,
  sendMessage,
  navigate,
}: ProjectWorkspaceShellProps) {
  const { t } = useTranslation('common');
  const {
    projects,
    selectedProject,
    selectedSession,
    activeTab,
    setActiveTab,
    setSidebarOpen,
    isLoadingProjects,
    projectsLoadFailed,
    openSettings,
    externalMessageUpdate,
    newSessionTrigger,
    registerOptimisticSession,
    handleProjectSelect,
    refreshProjectsSilently,
  } = useProjectMainState();

  const handleOpenSidebar = useCallback(() => {
    setSidebarOpen(true);
  }, [setSidebarOpen]);

  const handleNavigateToSession = useCallback((
    targetSessionId: string,
    options?: SessionNavigationOptions,
  ) => {
    navigate(`/session/${targetSessionId}`, { replace: Boolean(options?.replace) });
  }, [navigate]);

  const handleSessionEstablished = useCallback((
    targetSessionId: string,
    context: SessionEstablishedContext,
  ) => {
    registerOptimisticSession({ sessionId: targetSessionId, ...context });
  }, [registerOptimisticSession]);

  const handleProjectsRefresh = useCallback(() => {
    void refreshProjectsSilently();
  }, [refreshProjectsSilently]);

  return (
    <>
      {projectsLoadFailed && (
        <div role="alert" className="flex items-center justify-between gap-3 border-b border-border bg-muted px-4 py-2 text-sm">
          <span>{t('misc.projectsLoadFailed', { defaultValue: 'Could not load projects and sessions. Check your connection and retry.' })}</span>
          <button type="button" onClick={handleProjectsRefresh} disabled={isLoadingProjects} className="shrink-0 rounded px-3 py-1 hover:bg-accent disabled:opacity-50">
            {t('buttons.retry')}
          </button>
        </div>
      )}
      <WorkspaceMain
        projects={projects}
        selectedProject={selectedProject}
        selectedSession={selectedSession}
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        ws={ws}
        sendMessage={sendMessage}
        isMobile={isMobile}
        onMenuClick={handleOpenSidebar}
        isLoading={isLoadingProjects}
        onNavigateToSession={handleNavigateToSession}
        onSessionEstablished={handleSessionEstablished}
        onShowSettings={openSettings}
        externalMessageUpdate={externalMessageUpdate}
        newSessionTrigger={newSessionTrigger}
        onProjectSelect={handleProjectSelect}
        onProjectsRefresh={handleProjectsRefresh}
      />
    </>
  );
}

export default memo(ProjectMainRegion);
