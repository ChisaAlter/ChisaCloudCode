import { useEffect, useId, useRef, useState } from 'react';
import { HelpCircle, Plus, RefreshCw, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useClaudeAccounts } from '@/modules/claude-accounts/context/ClaudeAccountsContext';
import { ClaudeAccountRow } from '@/modules/claude-accounts/ClaudeAccountRow';
import { ClaudeAccountLoginForm } from '@/modules/claude-accounts/ClaudeAccountLoginForm';
import { Button, Input } from '@/shared/ui';
import '@/modules/claude-accounts/claude-accounts.css';

/** Sidebar, account settings and AccountPopup share the same saved-account switcher and persistent server login. */
export function ClaudeAccountsPanel({ onOpenHistory }: { onOpenHistory?: () => void }) {
  const { t } = useTranslation('settings');
  const { snapshot, loading, refreshing, busy, error, login, loginError, loginBusy, refresh, openAccounts, startLogin } = useClaudeAccounts();
  const refreshRef = useRef<HTMLButtonElement>(null);
  // A switched or removed row hands keyboard focus to a stable control after its quota refresh finishes.
  const focusAfterChange = useRef(false);
  const helpId = useId();
  const loginId = useId();
  // Account labels are optional and stay local until the user starts authorization.
  const [newName, setNewName] = useState('');
  // Browser authorization is only exposed after adding or explicitly signing in again.
  const [adding, setAdding] = useState(false);
  // Runtime and billing explanations remain available without crowding the switcher.
  const [helpOpen, setHelpOpen] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(openAccounts, 0);
    return () => window.clearTimeout(timer);
  }, [openAccounts]);
  const accounts = snapshot ? [
    ...(snapshot.defaultAccount ? [{ account: snapshot.defaultAccount, isDefault: true }] : []),
    ...snapshot.accounts.map(account => ({ account, isDefault: false })),
  ] : [];
  const selectedId = snapshot?.activeId ?? 'default';
  const orderedAccounts = [...accounts].sort((a, b) => Number(b.account.id === selectedId) - Number(a.account.id === selectedId));
  const pendingLogin = login && ['starting', 'waiting_code', 'completing'].includes(login.status);
  const showLogin = adding || Boolean(login) || Boolean(loginError);
  const subscriptionRoute = snapshot?.route.kind === 'subscription' || snapshot?.route.kind === 'default';
  const restoreAccountFocus = () => {
    focusAfterChange.current = true;
    window.requestAnimationFrame(() => {
      if (refreshRef.current && !refreshRef.current.disabled) {
        refreshRef.current.focus();
        focusAfterChange.current = false;
      }
    });
  };
  useEffect(() => {
    if (!busy && !refreshing && focusAfterChange.current && refreshRef.current) {
      refreshRef.current.focus();
      focusAfterChange.current = false;
    }
  }, [busy, refreshing]);
  return <section className="claude-accounts-panel" aria-label={t('claudeAccounts.title')}>
    {snapshot && !subscriptionRoute && <div className="claude-accounts-route">
      <p className="claude-accounts-route-label">{t(`claudeAccounts.routeKinds.${snapshot.route.kind}`)} · {snapshot.route.label}</p>
      <p className="claude-accounts-route-note">{snapshot.route.kind === 'hiroute' ? t('claudeAccounts.hirouteHelp') : t('claudeAccounts.routeQuotaHelp')}</p>
    </div>}
    <div className="claude-accounts-toolbar">
      <h3>{t('claudeAccounts.accountsTitle')}{accounts.length > 0 && <span className="claude-accounts-count">{accounts.length}</span>}</h3>
      <Button ref={refreshRef} type="button" variant="ghost" size="sm" className="claude-accounts-refresh" disabled={refreshing || busy} onClick={() => void refresh({ all: true })} aria-label={t('claudeAccounts.refreshAll')}>
        <RefreshCw className={refreshing ? 'animate-spin' : ''} aria-hidden />{t('claudeAccounts.refresh')}
      </Button>
    </div>
    {loading && !snapshot && <p role="status" className="claude-accounts-empty">{t('claudeAccounts.loading')}</p>}
    {error && <div className="claude-accounts-error"><p role="alert">{error}</p><Button type="button" variant="ghost" size="sm" disabled={refreshing || busy} onClick={() => void refresh()}>{t('claudeAccounts.retry')}</Button></div>}
    {snapshot && <>
      {accounts.length > 0 ? <ul className="claude-accounts-list" aria-label={t('claudeAccounts.accountsList')}>
        {orderedAccounts.map(({ account, isDefault }) => <ClaudeAccountRow key={`${isDefault ? 'default' : 'saved'}:${account.id}`} account={account} active={account.id === selectedId} isDefault={isDefault} onAccountChange={restoreAccountFocus} />)}
      </ul> : <div className="claude-accounts-empty-state"><ShieldCheck aria-hidden /><p>{t('claudeAccounts.empty')}</p><span>{t('claudeAccounts.savedLoginHelp')}</span></div>}
      <div className="claude-accounts-footer">
        <div className="claude-accounts-footer-actions">
          <Button type="button" size="sm" variant="outline" className="claude-accounts-add" aria-expanded={showLogin} aria-controls={loginId} onClick={() => setAdding(!showLogin)}><Plus aria-hidden />{t('claudeAccounts.addAccount')}</Button>
          <Button type="button" size="sm" variant="ghost" className="claude-accounts-help-toggle" aria-expanded={helpOpen} aria-controls={helpId} onClick={() => setHelpOpen(!helpOpen)}><HelpCircle aria-hidden />{t('claudeAccounts.quotaHelp')}</Button>
        </div>
        <p className="claude-accounts-switch-note">{t('claudeAccounts.switchBrief')}</p>
      </div>
      {showLogin && <div id={loginId} className="claude-accounts-login">
        {!pendingLogin && <>
          <p>{t('claudeAccounts.loginHelp')}</p>
          <form onSubmit={event => { event.preventDefault(); void startLogin(newName.trim() ? { name: newName.trim() } : {}); }}>
            <label className="block space-y-1"><span>{t('claudeAccounts.optionalName')}</span><Input value={newName} onChange={event => setNewName(event.target.value)} maxLength={128} disabled={loginBusy || busy} /></label>
            <Button type="submit" size="sm" disabled={loginBusy || busy}>{loginBusy ? t('claudeAccounts.loginStatus.starting') : t('claudeAccounts.startLogin')}</Button>
          </form>
        </>}
        {!login && loginError && <p role="alert" className="claude-accounts-error">{loginError}</p>}
        <ClaudeAccountLoginForm />
      </div>}
      {helpOpen && <div id={helpId} className="claude-accounts-help">
        <p>{t('claudeAccounts.savedLoginHelp')}</p>
        <p>{t('claudeAccounts.switchHelp')}</p>
        <p>{t('claudeAccounts.hirouteHelp')}</p>
        <p>{snapshot.runtime.label || t('claudeAccounts.serverRuntime')}</p>
        {onOpenHistory && <><p>{t('claudeAccounts.historyHelp')}</p><Button type="button" variant="ghost" size="sm" onClick={onOpenHistory}>{t('claudeAccounts.openHistory')}</Button></>}
      </div>}
    </>}
  </section>;
}
