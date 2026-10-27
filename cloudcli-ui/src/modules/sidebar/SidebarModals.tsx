import { useId, useMemo } from 'react';
import ReactDOM from 'react-dom';
import { AlertTriangle, EyeOff, Trash2 } from 'lucide-react';
import type { TFunction } from 'i18next';

import { Button, Dialog, DialogContent, DialogTitle } from '@/shared/ui';
import { Settings } from '@/modules/settings';
import type { PendingSidebarDeletion, Project, SettingsProject } from '@/shared/types';
import { normalizeProjectForSettings } from '@/modules/sidebar/utils/sidebarProjectFormatting';
import { ProjectCreationWizard } from '@/modules/project-creation-wizard';

type SidebarModalsProps = {
  projects: Project[];
  showSettings: boolean;
  settingsInitialTab: string;
  onCloseSettings: () => void;
  showNewProject: boolean;
  onCloseNewProject: () => void;
  onProjectCreated: (project?: Record<string, unknown>) => void;
  pendingDeletion: PendingSidebarDeletion | null;
  isDeleting?: boolean;
  deletionError?: string | null;
  onCancelDeletion: () => void;
  onConfirmDeleteProject: (deleteData?: boolean) => void;
  onConfirmDeleteSession: (hardDelete?: boolean) => void;
  t: TFunction;
};

type TypedSettingsProps = {
  isOpen: boolean;
  onClose: () => void;
  projects: SettingsProject[];
  initialTab: string;
};

const SettingsComponent = Settings as (props: TypedSettingsProps) => JSX.Element;

function TypedSettings(props: TypedSettingsProps) {
  return <SettingsComponent {...props} />;
}

/** Rendered by Sidebar to host its settings, new-project and delete-confirmation modals in one place. */
export default function SidebarModals({
  projects,
  showSettings,
  settingsInitialTab,
  onCloseSettings,
  showNewProject,
  onCloseNewProject,
  onProjectCreated,
  pendingDeletion,
  isDeleting = false,
  deletionError = null,
  onCancelDeletion,
  onConfirmDeleteProject,
  onConfirmDeleteSession,
  t,
}: SidebarModalsProps) {
  const sessionTitleId = useId();
  const sessionErrorId = useId();
  // Settings expects project identity/path fields to be present for dropdown labels and local-scope MCP config.
  const settingsProjects = useMemo(
    () => projects.map(normalizeProjectForSettings),
    [projects],
  );

  return (
    <>
      {showNewProject &&
        ReactDOM.createPortal(
          <ProjectCreationWizard
            onClose={onCloseNewProject}
            onProjectCreated={onProjectCreated}
          />,
          document.body,
        )}

      {showSettings &&
        ReactDOM.createPortal(
          <TypedSettings
            isOpen={showSettings}
            onClose={onCloseSettings}
            projects={settingsProjects}
            initialTab={settingsInitialTab}
          />,
          document.body,
        )}

      {pendingDeletion?.kind === 'project' &&
        ReactDOM.createPortal(
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
            <div className="w-full max-w-md overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
              <div className="p-6">
                <div className="flex items-start gap-4">
                  <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full bg-orange-100 dark:bg-orange-900/30">
                    <AlertTriangle className="h-6 w-6 text-orange-600 dark:text-orange-400" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h3 className="mb-2 text-lg font-semibold text-foreground">
                      {t('deleteConfirmation.deleteProject')}
                    </h3>
                    <p className="mb-1 text-sm text-muted-foreground">
                      {t('deleteConfirmation.confirmDelete')}{' '}
                      <span className="font-medium text-foreground">
                        {pendingDeletion.project.displayName || pendingDeletion.project.projectId}
                      </span>
                      ?
                    </p>
                    {pendingDeletion.sessionCount > 0 && (
                      <p className="mt-2 text-sm text-muted-foreground">
                        {t('deleteConfirmation.sessionCount', { count: pendingDeletion.sessionCount })}
                      </p>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex flex-col gap-2 border-t border-border bg-muted/30 p-4">
                <Button
                  variant="outline"
                  className="w-full justify-start"
                  onClick={() => onConfirmDeleteProject(false)}
                >
                  <EyeOff className="mr-2 h-4 w-4" />
                  {t('deleteConfirmation.archiveProject', 'Archive project')}
                </Button>
                <Button
                  variant="destructive"
                  className="w-full justify-start bg-red-600 text-white hover:bg-red-700"
                  onClick={() => onConfirmDeleteProject(true)}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  {t('deleteConfirmation.deleteAllData')}
                </Button>
                <Button variant="ghost" className="w-full" onClick={onCancelDeletion}>
                  {t('actions.cancel')}
                </Button>
              </div>
            </div>
          </div>,
          document.body,
        )}

      <Dialog open={pendingDeletion?.kind === 'session'} onOpenChange={open => { if (!open && !isDeleting) onCancelDeletion(); }}>
        {pendingDeletion?.kind === 'session' && <DialogContent className="w-[calc(100vw-2rem)] max-w-md overflow-hidden rounded-xl border border-border bg-card p-0 shadow-2xl"
          aria-labelledby={sessionTitleId} aria-describedby={deletionError ? sessionErrorId : undefined} aria-busy={isDeleting}>
          <div className="p-6">
            <div className="flex items-start gap-4">
              <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full bg-red-100 dark:bg-red-900/30"><AlertTriangle className="h-6 w-6 text-red-600 dark:text-red-400" /></div>
              <div className="min-w-0 flex-1">
                <DialogTitle id={sessionTitleId} className="not-sr-only mb-2 text-lg font-semibold text-foreground">{t('deleteConfirmation.deleteSession')}</DialogTitle>
                <p className="mb-1 text-sm text-muted-foreground">{t('deleteConfirmation.confirmDelete')}{' '}<span className="font-medium text-foreground">{pendingDeletion.sessionTitle || t('sessions.unnamed')}</span>?</p>
                <p className="mt-3 text-xs text-muted-foreground">{pendingDeletion.isArchived
                  ? t('deleteConfirmation.archivedSessionNotice', 'This session is already archived. You can keep it hidden or delete it permanently.')
                  : t('deleteConfirmation.archiveSessionNotice', 'Archive keeps the session out of the active list while preserving its history.')}</p>
              </div>
            </div>
            {deletionError && <p id={sessionErrorId} role="alert" className="mt-4 break-words rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{deletionError}</p>}
          </div>
          <div className="flex flex-col gap-2 border-t border-border bg-muted/30 p-4">
            {!pendingDeletion.isArchived && <Button variant="outline" className="w-full justify-start" disabled={isDeleting} onClick={() => onConfirmDeleteSession(false)}><EyeOff className="mr-2 h-4 w-4" />{t('deleteConfirmation.archiveSession', 'Archive session')}</Button>}
            <Button variant="destructive" className="w-full justify-start bg-red-600 text-white hover:bg-red-700" disabled={isDeleting} onClick={() => onConfirmDeleteSession(true)}><Trash2 className="mr-2 h-4 w-4" />{t('deleteConfirmation.deleteSessionPermanently', 'Delete permanently')}</Button>
            <Button variant="ghost" className="w-full" disabled={isDeleting} onClick={onCancelDeletion}>{t('actions.cancel')}</Button>
          </div>
        </DialogContent>}
      </Dialog>

    </>
  );
}
