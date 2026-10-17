import { memo } from 'react';
import { Check, Edit3, Folder, FolderOpen, MoreHorizontal, SquarePen, Star, Trash2, X } from 'lucide-react';
import type { TFunction } from 'i18next';

import { ActionMenu } from '@/shared/ui';
import { cn } from '@/shared/utils';
import type { LLMProvider, MCPServerStatus, Project, ProjectSession, SessionWithProvider } from '@/shared/types';
import SidebarProjectSessions from '@/modules/sidebar/SidebarProjectSessions';
type SidebarProjectItemProps = {
  project: Project;
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  isExpanded: boolean;
  isDeleting: boolean;
  isStarred: boolean;
  /** Resolved for this row: only the project being renamed re-renders on a keystroke. */
  isEditing: boolean;
  renameDraft: string;
  sessions: SessionWithProvider[];
  initialSessionsLoaded: boolean;
  isLoadingMoreSessions: boolean;
  currentTime: Date;
  /** The session being renamed, when it belongs to this project. */
  sessionRenameId: string | null;
  sessionRenameDraft: string;
  tasksEnabled: boolean;
  mcpServerStatus: MCPServerStatus;
  onRenameDraftChange: (name: string) => void;
  onToggleProject: (projectName: string) => void;
  onProjectSelect: (project: Project) => void;
  onToggleStarProject: (projectName: string) => void;
  onStartEditingProject: (project: Project) => void;
  onCancelEditingProject: () => void;
  onSaveProjectName: (projectId: string, nextName: string) => void;
  onDeleteProject: (project: Project) => void;
  onSessionSelect: (session: SessionWithProvider, projectName: string) => void;
  onArchiveSession?: (sessionId: string) => void;
  onDeleteSession: (sessionId: string, sessionTitle: string) => void;
  onForkSession?: (session: SessionWithProvider) => void;
  onLoadMoreSessions: (projectId: string) => void;
  activeSessions: ReadonlySet<string>;
  attentionSessionIds: ReadonlySet<string>;
  onNewSession: (project: Project) => void;
  onStartEditingSession: (projectId: string, sessionId: string, initialName: string) => void;
  onCancelEditingSession: () => void;
  onSaveEditingSession: (projectName: string, sessionId: string, summary: string, provider: LLMProvider) => void;
  t: TFunction;
};

/** Used by SidebarProjectList for the workspace header and conversations. */
function SidebarProjectItem({
  project,
  selectedProject,
  selectedSession,
  isExpanded,
  isDeleting,
  isStarred,
  isEditing,
  renameDraft,
  sessions,
  initialSessionsLoaded,
  isLoadingMoreSessions,
  currentTime,
  sessionRenameId,
  sessionRenameDraft,
  onRenameDraftChange,
  onToggleProject,
  onProjectSelect,
  onToggleStarProject,
  onStartEditingProject,
  onCancelEditingProject,
  onSaveProjectName,
  onDeleteProject,
  onSessionSelect,
  onDeleteSession,
  onArchiveSession,
  onForkSession,
  onLoadMoreSessions,
  activeSessions,
  attentionSessionIds,
  onNewSession,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  t,
}: SidebarProjectItemProps) {
  const isSelected = selectedProject?.projectId === project.projectId;
  const saveProjectName = () => onSaveProjectName(project.projectId, renameDraft);
  return (
    <div className={cn('space-y-1', isDeleting && 'opacity-50 pointer-events-none')}>
      <div className="group sidebar-project-row flex min-h-9 items-center gap-1 rounded-lg px-2 hover:bg-accent/50">
        <button type="button" className="flex h-8 min-w-0 flex-1 items-center gap-2 text-left" aria-expanded={isExpanded}
          onClick={() => { if (!isSelected) onProjectSelect(project); onToggleProject(project.projectId); }}>
          {isExpanded ? <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" /> : <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />}
          {!isEditing && <span className="min-w-0 flex-1 truncate text-[13px] font-normal" title={project.fullPath}>{project.displayName}</span>}
          {isStarred && <Star className="h-3 w-3 shrink-0 fill-current text-muted-foreground" />}
        </button>
        {isEditing ? (
          <div className="flex min-w-0 flex-1 items-center gap-1">
            <input type="text" value={renameDraft} onChange={(event) => onRenameDraftChange(event.target.value)}
              className="w-full min-w-0 rounded border border-border bg-background px-2 py-1 text-sm" autoFocus
              aria-label={t('projects.projectNamePlaceholder')}
              onKeyDown={(event) => { if (event.key === 'Enter') saveProjectName(); if (event.key === 'Escape') onCancelEditingProject(); }} />
            <button type="button" className="sidebar-icon" onClick={saveProjectName} aria-label={t('tooltips.save')}><Check className="h-3.5 w-3.5" /></button>
            <button type="button" className="sidebar-icon" onClick={onCancelEditingProject} aria-label={t('tooltips.cancel')}><X className="h-3.5 w-3.5" /></button>
          </div>
        ) : (
          <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
            <ActionMenu label={t('projects.options')} icon={MoreHorizontal} iconOnly portal variant="ghost" size="icon"
              triggerClassName="h-6 w-6 text-muted-foreground hover:bg-accent" menuClassName="w-[260px]"
              items={[
                { key: 'rename', label: t('projects.renameProject'), icon: Edit3, onSelect: () => onStartEditingProject(project) },
                { key: 'favorite', label: t(isStarred ? 'tooltips.removeFromFavorites' : 'tooltips.addToFavorites'), icon: Star, onSelect: () => onToggleStarProject(project.projectId) },
                { key: 'remove', label: t('projects.deleteProject'), icon: Trash2, onSelect: () => onDeleteProject(project), showDividerBefore: true },
              ]} />
            <button type="button" className="sidebar-icon h-6 w-6" title={t('projects.newConversation')} aria-label={t('projects.newConversation')}
              onClick={() => onNewSession(project)}><SquarePen className="h-3.5 w-3.5" /></button>
          </div>
        )}
      </div>
      <SidebarProjectSessions project={project} isExpanded={isExpanded} sessions={sessions} selectedSession={selectedSession}
        initialSessionsLoaded={initialSessionsLoaded} hasMoreSessions={Boolean(project.sessionMeta?.hasMore)} isLoadingMoreSessions={isLoadingMoreSessions}
        activeSessions={activeSessions} attentionSessionIds={attentionSessionIds} currentTime={currentTime}
        sessionRenameId={sessionRenameId} sessionRenameDraft={sessionRenameDraft} onRenameDraftChange={onRenameDraftChange}
        onStartEditingSession={onStartEditingSession} onCancelEditingSession={onCancelEditingSession} onSaveEditingSession={onSaveEditingSession}
        onProjectSelect={onProjectSelect} onSessionSelect={onSessionSelect} onDeleteSession={onDeleteSession} onArchiveSession={onArchiveSession}
        onForkSession={onForkSession} onLoadMoreSessions={onLoadMoreSessions} t={t} />
    </div>
  );
}
export default memo(SidebarProjectItem);
