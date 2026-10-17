import type { TFunction } from 'i18next';

import { AccountMenu } from '@/modules/auth';
import { APP_VERSION } from '@/shared/constants';

type SidebarFooterProps = {
  onShowSettings: () => void;
  t: TFunction;
};

/** SidebarContent anchors the account menu here before opening a chosen standalone dialog. */
export default function SidebarFooter({ onShowSettings }: SidebarFooterProps) {
  return (
    <div className="flex-shrink-0" style={{ paddingBottom: 'env(safe-area-inset-bottom, 0)' }}>
      <div className="nav-divider" />
      {APP_VERSION && <p className="px-3 pt-2 text-center text-[10px] text-muted-foreground/60">ChisaCloudCode v{APP_VERSION}</p>}
      <div className="px-2 pb-2 pt-2">
        <AccountMenu onOpenSettings={onShowSettings} />
      </div>
    </div>
  );
}
