import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Info, MoreHorizontal, Pencil, RotateCw, Trash2 } from 'lucide-react';

import { useClaudeAccounts } from '@/modules/claude-accounts/context/ClaudeAccountsContext';
import { ClaudeQuotaDisplay } from '@/modules/claude-accounts/ClaudeQuotaDisplay';
import { ActionMenu, Button, Input } from '@/shared/ui';
import type { ClaudeAccountSummary } from '@/shared/types';

type ClaudeAccountRowProps = {
  account: ClaudeAccountSummary;
  active: boolean;
  isDefault?: boolean;
  onAccountChange?: () => void;
};

/** Account management uses equal-sized rows so saved accounts' quota and switch actions can be compared directly. */
export function ClaudeAccountRow({ account, active, isDefault = false, onAccountChange }: ClaudeAccountRowProps) {
  const { t } = useTranslation('settings');
  const { snapshot, busy, loginBusy, activate, rename, remove, startLogin } = useClaudeAccounts();
  const detailsId = useId();
  // Management stays hidden until an explicit menu action; quota never needs a second disclosure.
  const [detail, setDetail] = useState<'info' | 'rename' | 'delete' | null>(null);
  // Keep an unsaved label local until the server confirms it.
  const [name, setName] = useState(account.name);
  const displayName = isDefault ? t('claudeAccounts.defaultAccount') : account.name || account.email || t('claudeAccounts.unnamed');
  const primaryName = account.email || displayName;
  const selectedSubscriptionIsRoute = active && (snapshot?.route.kind === 'subscription' || snapshot?.route.kind === 'default');
  const menuItems = [
    { key: 'info', label: t('claudeAccounts.accountDetails'), icon: Info, onSelect: () => setDetail(detail === 'info' ? null : 'info') },
    ...(!isDefault ? [
      { key: 'rename', label: t('claudeAccounts.rename'), icon: Pencil, disabled: busy,
        onSelect: () => { setName(account.name); setDetail('rename'); } },
      { key: 'login', label: t('claudeAccounts.relogin'), icon: RotateCw, disabled: busy || loginBusy,
        onSelect: () => { void startLogin({ accountId: account.id }); } },
      { key: 'delete', label: t('claudeAccounts.delete'), icon: Trash2, disabled: busy, isDanger: true, showDividerBefore: true,
        onSelect: () => setDetail('delete') },
    ] : []),
  ];
  async function saveName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim()) return;
    const result = await rename(account.id, name.trim());
    if (result.ok) setDetail(null);
  }
  async function switchAccount() {
    const result = await activate(isDefault ? null : account.id);
    if (result.ok) onAccountChange?.();
  }
  async function deleteAccount() {
    const result = await remove(account.id);
    if (result.ok) onAccountChange?.();
  }
  return <li className={`claude-account-row ${selectedSubscriptionIsRoute ? 'claude-account-row--selected' : ''}`} aria-label={displayName}>
    <div className="claude-account-identity">
      <span className="claude-account-monogram" aria-hidden>{(account.email || account.name || 'C').charAt(0).toUpperCase()}</span>
      <div className="claude-account-identity-text">
        <h4 className="claude-account-name" title={primaryName}>{primaryName}</h4>
        <div className="claude-account-meta">
          {account.plan && <span className="claude-account-plan">{account.plan}</span>}
          {primaryName !== displayName && <span className="claude-account-label" title={displayName}>{displayName}</span>}
        </div>
      </div>
      <div className="claude-account-identity-actions">
        <Button type="button" size="sm" variant={selectedSubscriptionIsRoute ? 'ghost' : 'outline'} className={selectedSubscriptionIsRoute ? 'claude-account-selected' : 'claude-account-switch'}
          disabled={busy || selectedSubscriptionIsRoute || account.needsSignIn} onClick={() => void switchAccount()} aria-label={t('claudeAccounts.switchNamed', { name: displayName })}>
          {selectedSubscriptionIsRoute ? <><Check aria-hidden />{t('claudeAccounts.selected')}</> : active ? t('claudeAccounts.useSubscription') : t('claudeAccounts.switch')}
        </Button>
        <ActionMenu label={t('claudeAccounts.more')} ariaLabel={t('claudeAccounts.manageNamed', { name: displayName })}
          icon={MoreHorizontal} iconOnly size="icon" variant="ghost" triggerClassName="claude-account-menu-trigger"
          menuClassName="claude-account-menu" items={menuItems} />
      </div>
    </div>
    {account.needsSignIn && <div className="claude-account-signin-warning"><span>{t('claudeAccounts.signInRequired')}</span>
      {!isDefault && <Button type="button" size="sm" variant="ghost" disabled={busy || loginBusy} onClick={() => void startLogin({ accountId: account.id })}>{t('claudeAccounts.relogin')}</Button>}
    </div>}
    <ClaudeQuotaDisplay usage={account.usage} overview />
    {detail && <div id={detailsId} className="claude-account-details">
      {detail === 'info' && <>
        <div className="claude-account-info-heading"><span>{t('claudeAccounts.accountDetails')}</span><Button type="button" size="sm" variant="ghost" onClick={() => setDetail(null)}>{t('claudeAccounts.collapse')}</Button></div>
        {isDefault && <p>{t('claudeAccounts.defaultSource')}</p>}
        {account.organizationName && <p>{account.organizationName}</p>}
        <p>{t('claudeAccounts.savedLoginHelp')}</p>
      </>}
      {detail === 'rename' && <form onSubmit={event => void saveName(event)}>
        <label className="block space-y-1 text-xs"><span>{t('claudeAccounts.accountName')}</span><Input autoFocus value={name} onChange={event => setName(event.target.value)} maxLength={128} disabled={busy} /></label>
        <div className="claude-account-edit-actions"><Button type="submit" size="sm" disabled={busy || !name.trim()}>{t('claudeAccounts.saveName')}</Button><Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setDetail(null)}>{t('claudeAccounts.cancel')}</Button></div>
      </form>}
      {detail === 'delete' && <>
        <p className="claude-account-delete-question">{t('claudeAccounts.deleteConfirmText', { name: displayName })}</p>
        <div className="claude-account-edit-actions"><Button type="button" size="sm" variant="destructive" disabled={busy} onClick={() => void deleteAccount()}>{t('claudeAccounts.confirmDelete')}</Button><Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setDetail(null)}>{t('claudeAccounts.keepAccount')}</Button></div>
      </>}
    </div>}
  </li>;
}
