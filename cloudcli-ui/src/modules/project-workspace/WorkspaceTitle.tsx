import { FolderGit2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { LLMProviderLogo } from '@/shared/ui';
import type { AppTab, Project, ProjectSession } from '@/shared/types';
import { usePlugins } from '@/modules/plugins';
import { getSessionTitle } from '@/shared/utils';

type WorkspaceTitleProps = {
  activeTab: AppTab;
  selectedProject: Project;
  selectedSession: ProjectSession | null;
  shouldShowTasksTab: boolean;
};

function getTabTitle(activeTab: AppTab, shouldShowTasksTab: boolean, t: (key: string) => string, pluginDisplayName?: string) {
  if (activeTab.startsWith('plugin:') && pluginDisplayName) {
    return pluginDisplayName;
  }

  if (activeTab === 'shell') {
    return t('tabs.shell');
  }

  if (activeTab === 'files') {
    return t('mainContent.projectFiles');
  }

  if (activeTab === 'git') {
    return t('tabs.git');
  }

  if (activeTab === 'tasks' && shouldShowTasksTab) {
    return 'TaskMaster';
  }

  if (activeTab === 'browser') {
    return t('tabs.browser');
  }

  return t('misc.projectFallback');
}

/** Rendered by WorkspaceHeader to label the workspace with the active session or tab name. */
export default function WorkspaceTitle({
  activeTab,
  selectedProject,
  selectedSession,
  shouldShowTasksTab,
}: WorkspaceTitleProps) {
  const { t } = useTranslation();
  const { plugins } = usePlugins();

  const pluginDisplayName = activeTab.startsWith('plugin:')
    ? plugins.find((p) => p.name === activeTab.replace('plugin:', ''))?.displayName
    : undefined;

  const showSessionIcon = activeTab === 'chat' && Boolean(selectedSession);
  const showChatNewSession = activeTab === 'chat' && !selectedSession;

  return (
    <div className="workspace-title scrollbar-hide flex min-w-0 flex-1 items-center gap-2.5 overflow-x-auto">
      <div className="workspace-title-icon flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-foreground/[0.07] text-foreground/75">
        {showSessionIcon ? (
          <LLMProviderLogo provider={selectedSession?.__provider} className="h-4 w-4" />
        ) : (
          <FolderGit2 className="h-4 w-4" />
        )}
      </div>

      <div className="min-w-0 flex-1" title={selectedProject.displayPath || selectedProject.fullPath}>
        {activeTab === 'chat' && selectedSession ? (
          <div className="min-w-0">
            <h2 title={getSessionTitle(selectedSession)} className="truncate text-sm font-semibold leading-tight text-foreground">
              {getSessionTitle(selectedSession)}
            </h2>
            <div className="truncate text-[11px] leading-tight text-muted-foreground">{selectedProject.displayName}</div>
          </div>
        ) : showChatNewSession ? (
          <div className="min-w-0">
            <h2 className="text-base font-semibold leading-tight text-foreground">{t('mainContent.newSession')}</h2>
            <div className="truncate text-xs leading-tight text-muted-foreground">{selectedProject.displayName}</div>
          </div>
        ) : (
          <div className="min-w-0">
            <h2 className="text-sm font-semibold leading-tight text-foreground">
              {selectedProject.sourceMode === 'ssh' && activeTab === 'shell' ? 'Windows 命令' : getTabTitle(activeTab, shouldShowTasksTab, t, pluginDisplayName)}
            </h2>
            <div className="truncate text-[11px] leading-tight text-muted-foreground">{selectedProject.displayName}</div>
          </div>
        )}
      </div>
    </div>
  );
}
