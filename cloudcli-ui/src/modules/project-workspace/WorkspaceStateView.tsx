import { Folder, FolderPlus, PanelLeftOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { usePaletteOps } from '@/modules/command-palette';
import { useSetUiPreference } from '@/shared/context/UiPreferencesContext';
import MobileMenuButton from '@/modules/project-workspace/MobileMenuButton';

type WorkspaceStateViewProps = {
  mode: 'loading' | 'empty';
  isMobile: boolean;
  onMenuClick: () => void;
};

/** Offers real workspace entry actions while the sidebar owns project creation. */
export default function WorkspaceStateView({ mode, isMobile, onMenuClick }: WorkspaceStateViewProps) {
  const { t } = useTranslation();
  const { createProject } = usePaletteOps();
  const setPreference = useSetUiPreference();
  const isLoading = mode === 'loading';

  const showProjects = () => {
    setPreference('sidebarVisible', true);
    if (isMobile) onMenuClick();
  };

  return (
    <div className="flex h-full flex-col">
      {!isMobile && <div className="workspace-header desktop-drag shrink-0" />}
      {isMobile && (
        <div className="workspace-header desktop-drag pwa-header-safe flex-shrink-0 p-2 sm:p-3">
          <MobileMenuButton onMenuClick={onMenuClick} compact />
        </div>
      )}
      {isLoading ? (
        <div className="flex flex-1 items-center justify-center" role="status">
          <div className="text-center text-muted-foreground">
            <div className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-2 border-muted border-t-primary" />
            <h2 className="mb-1 text-lg font-semibold text-foreground">{t('mainContent.loading')}</h2>
            <p className="text-sm">{t('mainContent.settingUpWorkspace')}</p>
          </div>
        </div>
      ) : (
        <div className="workspace-welcome flex flex-1 items-center justify-center">
          <div className="mx-auto max-w-lg px-6 pb-16 text-center">
            <div className="mx-auto mb-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10">
              <Folder className="h-7 w-7 text-primary" strokeWidth={1.5} />
            </div>
            <h2 className="mb-3 text-3xl font-medium tracking-tight text-foreground">{t('mainContent.chooseProject')}</h2>
            <p className="mx-auto mb-7 max-w-sm text-sm leading-relaxed text-muted-foreground">{t('mainContent.selectProjectDescription')}</p>
            <div className="flex flex-wrap justify-center gap-3">
              <button type="button" onClick={createProject} className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90">
                <FolderPlus className="h-4 w-4" />{t('mainContent.createProjectAction', { defaultValue: 'Add project' })}
              </button>
              <button type="button" onClick={showProjects} className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2.5 text-sm text-foreground hover:bg-accent">
                <PanelLeftOpen className="h-4 w-4" />{t('mainContent.browseProjectsAction', { defaultValue: 'Browse conversations and projects' })}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
