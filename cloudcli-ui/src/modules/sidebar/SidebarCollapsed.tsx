import { PanelLeftOpen } from 'lucide-react';
import type { TFunction } from 'i18next';

import { AccountMenu } from '@/modules/auth';

type SidebarCollapsedProps = {
  onExpand: () => void;
  onShowSettings: () => void;
  t: TFunction;
};

/** Sidebar's collapsed icon rail keeps the same anchored account menu and standalone dialogs. */
export default function SidebarCollapsed({ onExpand, onShowSettings, t }: SidebarCollapsedProps) {
  return <div className="sidebar-rail flex h-full w-14 flex-col items-center gap-2 px-2 pb-3 pt-4">
    <button type="button" onClick={onExpand} className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent" aria-label={t('actions.expandSidebar', '展开侧边栏')} title={t('actions.expandSidebar', '展开侧边栏')}><PanelLeftOpen className="h-4 w-4" /></button>
    <AccountMenu collapsed onOpenSettings={onShowSettings} />
  </div>;
}
