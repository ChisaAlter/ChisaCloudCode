import { FolderPlus, PanelLeftOpen } from 'lucide-react';
import type { TFunction } from 'i18next';

import { AccountMenu } from '@/modules/auth';
import { ClaudeUsageTrigger } from '@/modules/claude-accounts';

type SidebarCollapsedProps = {
  onExpand: () => void;
  onCreateProject: () => void;
  onShowSettings: () => void;
  t: TFunction;
};

/** Rendered by Sidebar to keep project creation and the anchored account menu accessible in the collapsed rail. */
export default function SidebarCollapsed({ onExpand, onCreateProject, onShowSettings, t }: SidebarCollapsedProps) {
  return <div className="sidebar-rail flex h-full w-14 flex-col items-center gap-2 px-2 pb-3 pt-4">
    <button type="button" onClick={onExpand} className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent" aria-label={t('actions.expandSidebar', '展开侧边栏')} title={t('actions.expandSidebar', '展开侧边栏')}><PanelLeftOpen className="h-4 w-4" /></button>
    <button
      type="button"
      onClick={onCreateProject}
      className="flex w-10 flex-col items-center justify-center gap-1 rounded-lg py-2 text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      aria-label={t('projects.newProject')}
      title={t('projects.newProject')}
    >
      <FolderPlus className="h-4 w-4 shrink-0" />
      <span className="w-full break-words text-center text-[10px] leading-tight">{t('projects.newProject')}</span>
    </button>
    <div className="mt-auto flex flex-col items-center gap-1">
      <ClaudeUsageTrigger collapsed />
      <AccountMenu collapsed onOpenSettings={onShowSettings} />
    </div>
  </div>;
}
