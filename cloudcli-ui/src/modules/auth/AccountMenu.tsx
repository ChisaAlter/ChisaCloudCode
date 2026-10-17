import { useState } from 'react';
import { ChevronUp, Gauge, LogOut, Settings } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useAuth } from '@/modules/auth/context/AuthContext';
import { AccountAvatar } from '@/modules/auth/AccountAvatar';
import { AccountPopup } from '@/modules/auth/AccountPopup';
import { ActionMenu } from '@/shared/ui';
import type { AccountPopupSection } from '@/shared/types';

/** Sidebar's footer and collapsed rail, plus the signed-out desktop shell, share this account menu. */
export function AccountMenu({ onOpenSettings, collapsed = false }: { onOpenSettings?: () => void; collapsed?: boolean }) {
  const { user, logout } = useAuth();
  const { t } = useTranslation('auth');
  // Only the selected function mounts; opening the menu itself never requests quota data.
  const [section, setSection] = useState<AccountPopupSection | null>(null);
  const accountName = user?.displayName || user?.username || t('accountMenu.guest');

  return <>
    <ActionMenu
      label={accountName}
      ariaLabel={t('accountMenu.open', { name: accountName })}
      variant="ghost"
      portal
      className={collapsed ? 'mt-auto' : 'w-full'}
      triggerClassName={collapsed ? 'h-9 w-9 rounded-full p-0' : 'h-auto w-full justify-start gap-3 rounded-xl px-2.5 py-2.5 text-left'}
      triggerContent={<><AccountAvatar user={user} />{!collapsed && <><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-foreground">{accountName}</span><span className="block truncate text-xs text-muted-foreground">{t('accountMenu.subtitle')}</span></span><ChevronUp className="h-4 w-4 shrink-0 text-muted-foreground" /></>}</>}
      menuClassName="w-[min(16.25rem,calc(100vw-1rem))] rounded-xl p-1.5 shadow-xl"
      items={[
        {
          key: 'account',
          label: user ? accountName : t('login.submit'),
          description: user ? t('accountMenu.profile') : t('accountMenu.loginDescription'),
          leading: <AccountAvatar user={user} />,
          onSelect: () => setSection('account'),
        },
        { key: 'quota', label: t('accountMenu.usage'), icon: Gauge, showDividerBefore: true, onSelect: () => setSection('quota') },
        { key: 'settings', label: t('accountMenu.settings'), icon: Settings, onSelect: () => onOpenSettings ? onOpenSettings() : setSection('settings') },
        ...(user ? [{ key: 'logout', label: t('logout.button'), icon: LogOut, showDividerBefore: true, onSelect: logout }] : []),
      ]}
    />
    <AccountPopup isOpen={section !== null} section={section ?? 'account'} onClose={() => setSection(null)} />
  </>;
}
