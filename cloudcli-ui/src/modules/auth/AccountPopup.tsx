import { useId } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useAuth } from '@/modules/auth/context/AuthContext';
import LoginForm from '@/modules/auth/LoginForm';
import { AccountProfileEditor } from '@/modules/auth/AccountProfileEditor';
import { AccountServerConnection } from '@/modules/auth/AccountServerConnection';
import { ClaudeUsageContent } from '@/modules/plugins';
import { Dialog, DialogContent, DialogTitle } from '@/shared/ui';
import type { AccountPopupSection } from '@/shared/types';

/** Auth's account menu and signed-out shell open the selected account function in its own dialog. */
export function AccountPopup({ isOpen, onClose, section = 'account' }: { isOpen: boolean; onClose: () => void; section?: AccountPopupSection }) {
  const { user } = useAuth();
  const { t } = useTranslation('auth');
  const titleId = useId();
  const title = section === 'quota' ? t('accountMenu.usage') : section === 'settings' ? t('accountMenu.settings') : user ? t('accountMenu.profile') : t('login.submit');
  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className={`w-[calc(100vw-2rem)] ${section === 'quota' ? 'max-w-2xl' : 'max-w-lg'} overflow-hidden rounded-2xl border border-border bg-card p-0 shadow-2xl`} aria-labelledby={titleId}>
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <DialogTitle id={titleId} className="not-sr-only text-base font-semibold">{title}</DialogTitle>
          <button type="button" className="rounded-md p-1.5 text-muted-foreground hover:bg-accent" aria-label={t('accountMenu.close')} onClick={onClose}><X className="h-4 w-4" /></button>
        </div>
        <div className="max-h-[min(75vh,42rem)] overflow-y-auto p-5">
          {isOpen && section === 'account' && (user ? <AccountProfileEditor /> : (
            <div className="space-y-4"><p className="text-sm text-muted-foreground">{t('accountMenu.loginDescription')}</p><LoginForm embedded /></div>
          ))}
          {isOpen && section === 'settings' && <AccountServerConnection />}
          {isOpen && section === 'quota' && (user ? <ClaudeUsageContent /> : <p className="text-sm text-muted-foreground">{t('accountMenu.loginForUsage')}</p>)}
        </div>
      </DialogContent>
    </Dialog>
  );
}
