import { useState } from 'react';
import { ChevronRight, Gauge } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useOptionalClaudeAccounts } from '@/modules/claude-accounts/context/ClaudeAccountsContext';
import { ClaudeAccountsDialog } from '@/modules/claude-accounts/ClaudeAccountsDialog';
import { ClaudeQuotaDisplay } from '@/modules/claude-accounts/ClaudeQuotaDisplay';
import { Button } from '@/shared/ui';

/** Expanded and collapsed sidebar footers keep this quota entry visible without opening the Chisa account menu. */
export function ClaudeUsageTrigger({ collapsed = false, onOpenHistory }: { collapsed?: boolean; onOpenHistory?: () => void }) {
  const { t } = useTranslation('settings');
  const accounts = useOptionalClaudeAccounts();
  // Each mounted sidebar presentation owns its dialog; quota and login data remain shared in the provider.
  const [open, setOpen] = useState(false);
  if (!accounts) return null;
  const { snapshot, loading, error } = accounts;
  const account = snapshot?.activeId === null ? snapshot.defaultAccount : snapshot?.accounts.find(item => item.id === snapshot.activeId);
  const routeIsSubscription = !snapshot || snapshot.route.kind === 'subscription' || snapshot.route.kind === 'default';
  const headline = !routeIsSubscription ? snapshot.route.label
    : account?.name || account?.email || t('claudeAccounts.quota');
  const title = `${t('claudeAccounts.title')} · ${headline}`;
  return <>
    <Button type="button" variant="ghost" className={collapsed ? 'h-9 w-9 shrink-0 rounded-lg p-0' : 'h-auto w-full justify-start gap-2 rounded-lg px-2.5 py-2 text-left'}
      aria-label={t('claudeAccounts.open')} title={title} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
      <Gauge className={`h-4 w-4 shrink-0 ${error ? 'text-destructive' : 'text-muted-foreground'}`} />
      {!collapsed && <><span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium">{headline}</span>
        {loading && !snapshot ? <span className="block text-[11px] text-muted-foreground">{t('claudeAccounts.loadingUsage')}</span>
          : !routeIsSubscription ? <span className="block truncate text-[11px] text-muted-foreground">{t('claudeAccounts.externalRoute')}</span>
          : <ClaudeQuotaDisplay usage={account?.usage ?? null} compact />}
      </span><ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /></>}
    </Button>
    <ClaudeAccountsDialog open={open} onOpenChange={setOpen} onOpenHistory={onOpenHistory} />
  </>;
}
