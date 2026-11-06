import { useState } from 'react';
import { ChartNoAxesColumnIncreasing } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { TokenUsageDialog } from '@/modules/token-usage/TokenUsageDialog';
import { getAuthSessionVersion } from '@/shared/authToken';
import { getServerConnectionVersion } from '@/shared/chisa';
import { Button } from '@/shared/ui';
import { cn } from '@/shared/utils';

type TokenUsageButtonProps = {
  sessionId?: string | null;
  sessionTitle?: string;
  className?: string;
  onClick?: () => void;
};

/** The chat composer opens saved usage; its owner can share the same dialog with transcript actions. */
export function TokenUsageButton({ sessionId, sessionTitle, className, onClick }: TokenUsageButtonProps) {
  const { t } = useTranslation('chat');
  const identityKey = JSON.stringify([getAuthSessionVersion(), getServerConnectionVersion()]);
  // An owned dialog is open only for the account that opened it; delegated buttons keep no dialog state.
  const [openOwner, setOpenOwner] = useState<string | null>(null);
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={cn('token-statistics-trigger h-7 shrink-0 gap-1.5 px-2 text-xs text-muted-foreground', className)}
        title={t('tokenStatistics.title')}
        aria-label={t('tokenStatistics.title')}
        aria-haspopup="dialog"
        onClick={() => { if (onClick) onClick(); else setOpenOwner(identityKey); }}
      >
        <ChartNoAxesColumnIncreasing aria-hidden="true" className="!h-3.5 !w-3.5" />
        <span>Token</span>
      </Button>
      {!onClick && (
        <TokenUsageDialog open={openOwner === identityKey} onOpenChange={open => setOpenOwner(open ? identityKey : null)} sessionId={sessionId} sessionTitle={sessionTitle} />
      )}
    </>
  );
}
