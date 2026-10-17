import { useState } from 'react';
import { LogIn } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { AccountMenu } from '@/modules/auth/AccountMenu';
import { AccountPopup } from '@/modules/auth/AccountPopup';

/** ProtectedRoute renders this desktop shell without loading authenticated projects until login succeeds. */
export function SignedOutDesktop() {
  const { t } = useTranslation('auth');
  // The central welcome action opens login directly; the bottom entry first opens the account menu.
  const [showAccount, setShowAccount] = useState(false);
  return <div className="flex h-screen bg-background pt-8">
    <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-card p-3">
      <span className="px-2 py-3 text-lg font-semibold">ChisaCloudCode</span>
      <p className="mt-5 px-2 text-sm text-muted-foreground">{t('accountMenu.workspaceHint')}</p>
      <div className="mt-auto"><AccountMenu /></div>
    </aside>
    <main className="flex min-w-0 flex-1 flex-col items-center justify-center gap-4 p-6 text-center"><LogIn className="h-8 w-8 text-muted-foreground" /><h1 className="text-xl font-medium">{t('accountMenu.welcome')}</h1><p className="text-sm text-muted-foreground">{t('accountMenu.continueHint')}</p><button type="button" className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground" onClick={() => setShowAccount(true)}>{t('login.submit')}</button></main>
    <AccountPopup isOpen={showAccount} onClose={() => setShowAccount(false)} />
  </div>;
}
