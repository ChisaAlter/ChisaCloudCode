import { Activity, Archive, Folder, FolderPlus, MessageSquare, PanelLeftClose, Plus, RefreshCw, Search, X } from 'lucide-react';
import type { TFunction } from 'i18next';

import { Input } from '@/shared/ui';
import { cn } from '@/shared/utils';
import type { SidebarSearchMode } from '@/shared/types';

type SidebarHeaderProps = {
  isPWA: boolean;
  isMobile: boolean;
  isLoading: boolean;
  projectsCount: number;
  runningSessionsCount: number;
  archivedSessionsCount: number;
  isArchivedSessionsLoading: boolean;
  searchFilter: string;
  onSearchFilterChange: (value: string) => void;
  onClearSearchFilter: () => void;
  searchMode: SidebarSearchMode;
  onSearchModeChange: (mode: SidebarSearchMode) => void;
  onRefresh: () => void;
  isRefreshing: boolean;
  onCreateProject: () => void;
  onNewSession?: () => void;
  onCollapseSidebar: () => void;
  t: TFunction;
};

/** Rendered by SidebarContent for the app identity, primary navigation and search. */
export default function SidebarHeader({
  isPWA, isMobile, isLoading, projectsCount, runningSessionsCount,
  archivedSessionsCount, isArchivedSessionsLoading, searchFilter,
  onSearchFilterChange, onClearSearchFilter, searchMode, onSearchModeChange,
  onRefresh, isRefreshing, onCreateProject, onNewSession, onCollapseSidebar, t,
}: SidebarHeaderProps) {
  const showSearchTools = (projectsCount > 0 || runningSessionsCount > 0 || archivedSessionsCount > 0 || isArchivedSessionsLoading) && !isLoading;
  const searchPlaceholder = searchMode === 'conversations'
    ? t('search.conversationsPlaceholder')
    : searchMode === 'archived'
      ? t('search.archivedPlaceholder', 'Search archived sessions...')
      : searchMode === 'running'
        ? t('search.runningPlaceholder', 'Search running sessions...')
        : t('projects.searchPlaceholder');

  return (
    <div className="shrink-0" style={isPWA && isMobile ? { paddingTop: 'env(safe-area-inset-top)' } : undefined}>
      <div className="sidebar-brand desktop-drag flex h-14 items-center justify-between gap-2 px-5">
        <h1 className="min-w-0 truncate text-[15px] font-semibold tracking-tight text-foreground">{t('app.title')}</h1>
        <button type="button" onClick={onCollapseSidebar} className="sidebar-icon hidden md:flex" aria-label={t('tooltips.hideSidebar')} title={t('tooltips.hideSidebar')}>
          <PanelLeftClose className="h-4 w-4" />
        </button>
      </div>

      <div className="space-y-1 px-3 pb-3">
        <button type="button" onClick={onNewSession ?? onCreateProject} className="sidebar-new-chat flex h-10 w-full items-center gap-3 rounded-lg px-3 text-sm font-medium">
          <Plus className="h-4 w-4" />
          {onNewSession ? t('sessions.newSession') : t('tooltips.createProject')}
        </button>

        {showSearchTools && (
          <>
            <div className="relative py-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search" aria-label={searchPlaceholder} placeholder={searchPlaceholder}
                value={searchFilter} onChange={(event) => onSearchFilterChange(event.target.value)}
                className="sidebar-search h-9 rounded-lg border-transparent bg-transparent pl-10 pr-8 text-[13px] shadow-none focus-visible:ring-1 focus-visible:ring-ring/30 focus-visible:ring-offset-0"
              />
              {searchFilter && <button type="button" onClick={onClearSearchFilter} aria-label={t('tooltips.clearSearch')} className="sidebar-icon absolute right-1 top-1/2 -translate-y-1/2"><X className="h-3.5 w-3.5" /></button>}
            </div>
            <nav aria-label={t('search.modeProjects')} className="space-y-0.5">
              <button type="button" onClick={() => onSearchModeChange('conversations')} aria-pressed={searchMode === 'conversations'} className={cn('sidebar-nav-item', searchMode === 'conversations' && 'is-active')}>
                <MessageSquare className="h-4 w-4" /><span>{t('search.modeConversations')}</span>
              </button>
              <button type="button" onClick={() => onSearchModeChange('projects')} aria-pressed={searchMode === 'projects'} className={cn('sidebar-nav-item', searchMode === 'projects' && 'is-active')}>
                <Folder className="h-4 w-4" /><span>{t('search.modeProjects')}</span>
              </button>
            </nav>
          </>
        )}
      </div>

      <div className="flex items-center gap-1 px-5 pb-2 pt-2">
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
          {searchMode === 'conversations' ? t('recent.title', 'Recent conversations') : searchMode === 'archived' ? t('search.archiveOnlyTooltip', 'Archive') : searchMode === 'running' ? t('search.runningTooltip', 'Running sessions') : t('search.modeProjects')}
        </span>
        {showSearchTools && <>
          <button type="button" onClick={() => onSearchModeChange(searchMode === 'running' ? 'projects' : 'running')} aria-pressed={searchMode === 'running'} aria-label={t('search.runningTooltip', 'Running sessions')} title={t('search.runningTooltip', 'Running sessions')} className={cn('sidebar-icon', searchMode === 'running' && 'is-active')}>
            <Activity className="h-3.5 w-3.5" />{runningSessionsCount > 0 && <span className="text-[10px]">{runningSessionsCount}</span>}
          </button>
          <button type="button" onClick={() => onSearchModeChange(searchMode === 'archived' ? 'projects' : 'archived')} aria-pressed={searchMode === 'archived'} aria-label={t('search.archiveOnlyTooltip', 'Archive')} title={t('search.archiveOnlyTooltip', 'Archive')} className={cn('sidebar-icon', searchMode === 'archived' && 'is-active')}><Archive className="h-3.5 w-3.5" /></button>
        </>}
        <button type="button" onClick={onRefresh} disabled={isRefreshing} aria-label={t('tooltips.refresh')} title={t('tooltips.refresh')} className="sidebar-icon"><RefreshCw className={cn('h-3.5 w-3.5', isRefreshing && 'animate-spin')} /></button>
        <button type="button" onClick={onCreateProject} aria-label={t('tooltips.createProject')} title={t('tooltips.createProject')} className="sidebar-icon"><FolderPlus className="h-3.5 w-3.5" /></button>
      </div>
    </div>
  );
}
