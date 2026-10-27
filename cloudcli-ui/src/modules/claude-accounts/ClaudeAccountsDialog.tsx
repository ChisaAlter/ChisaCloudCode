import { useId } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { ClaudeAccountsPanel } from '@/modules/claude-accounts/ClaudeAccountsPanel';
import { Button, Dialog, DialogContent, DialogTitle } from '@/shared/ui';

/** Sidebar uses the focus-trapped dialog; App and settings can also open it through controlled props. */
export function ClaudeAccountsDialog({ open, onOpenChange, onOpenHistory }: { open: boolean; onOpenChange: (open: boolean) => void; onOpenHistory?: () => void }) {
  const { t } = useTranslation('settings');
  const titleId = useId();
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="claude-accounts-dialog" aria-labelledby={titleId}>
      <div className="claude-accounts-dialog-header">
        <div><DialogTitle id={titleId} className="claude-accounts-dialog-title not-sr-only">{t('claudeAccounts.title')}</DialogTitle>
          <p className="claude-accounts-dialog-subtitle">{t('claudeAccounts.savedLoginShort')}</p></div>
        <Button type="button" variant="ghost" size="icon" className="h-8 w-8" aria-label={t('claudeAccounts.close')} onClick={() => onOpenChange(false)}><X className="h-4 w-4" /></Button>
      </div>
      <div className="claude-accounts-dialog-body">{open && <ClaudeAccountsPanel onOpenHistory={onOpenHistory} />}</div>
    </DialogContent>
  </Dialog>;
}
