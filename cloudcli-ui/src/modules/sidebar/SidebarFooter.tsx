import type { TFunction } from 'i18next';

import { AccountMenu } from '@/modules/auth';
import { ClaudeUsageTrigger } from '@/modules/claude-accounts';
import { APP_VERSION } from '@/shared/constants';
import { isDesktop } from '@/shared/chisa';

type SidebarFooterProps = {
  onShowSettings: () => void;
  t: TFunction;
};

/** SidebarContent anchors the account menu here before opening a chosen standalone dialog. */
export default function SidebarFooter({ onShowSettings }: SidebarFooterProps) {
  return (
    <div className="sidebar-account-footer flex-shrink-0" style={{ paddingBottom: 'env(safe-area-inset-bottom, 0)' }}>
      <div className="nav-divider" />
      {!isDesktop() && APP_VERSION && <p className="sidebar-version px-3 pt-2 text-center text-[10px] text-muted-foreground/60">ChisaCloudCode v{APP_VERSION}</p>}
      <div className="sidebar-account-menu space-y-1 px-2 pb-2 pt-2">
        <div className="sidebar-account-quota">
          <ClaudeUsageTrigger />
        </div>
        <div className="sidebar-account-profile">
          <AccountMenu onOpenSettings={onShowSettings} />
        </div>
      </div>
    </div>
  );
}
