import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { ExternalLink, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useClaudeAccounts } from '@/modules/claude-accounts/context/ClaudeAccountsContext';
import { Button, Input } from '@/shared/ui';

function loginUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && ['claude.ai', 'claude.com'].includes(url.hostname) ? url.toString() : null;
  } catch { return null; }
}

/** Account management retains one cancellable CLI login task without keeping any credential in browser storage. */
export function ClaudeAccountLoginForm() {
  const { t } = useTranslation('settings');
  const { login, loginError, loginBusy, submitCode, cancelLogin, dismissLogin } = useClaudeAccounts();
  // The one-time authorization code is transient and cleared after a confirmed submission or task change.
  const [codeDraft, setCodeDraft] = useState({ id: login?.id, value: '' });
  // The expiry countdown is local and never reissues a server login operation.
  const [now, setNow] = useState(Date.now);
  const loginId = login?.id;
  const code = codeDraft.id === loginId ? codeDraft.value : '';
  useEffect(() => {
    if (!loginId) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [loginId]);
  if (!login) return null;
  const pending = ['starting', 'waiting_code', 'completing'].includes(login.status);
  const expired = pending && login.expiresAt <= now;
  const url = loginUrl(login.url);
  const remaining = Math.max(0, Math.ceil((login.expiresAt - now) / 60_000));
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!code.trim()) return;
    const result = await submitCode(code.trim());
    if (result.ok) setCodeDraft({ id: loginId, value: '' });
  }
  return <section aria-label={t('claudeAccounts.loginTitle')} className="space-y-3 rounded-lg border border-border bg-muted/30 p-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="flex items-center gap-2 text-sm font-medium">{pending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}{t('claudeAccounts.loginTitle')}</h3>
      {pending && !expired && <p className="text-xs tabular-nums text-muted-foreground">{t('claudeAccounts.loginExpires', { minutes: remaining })}</p>}
    </div>
    <p role="status" className="text-sm">{expired ? t('claudeAccounts.loginExpired') : t(`claudeAccounts.loginStatus.${login.status}`)}</p>
    {pending && !expired && url && <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 break-all text-sm text-primary underline underline-offset-2"><ExternalLink className="h-3.5 w-3.5 shrink-0" />{t('claudeAccounts.openLogin')}</a>}
    {pending && !expired && login.status === 'waiting_code' && url && <form onSubmit={event => void submit(event)} className="space-y-2">
      <p className="text-xs text-muted-foreground">{t('claudeAccounts.codeHelp')}</p>
      <label className="block space-y-1 text-xs"><span>{t('claudeAccounts.code')}</span><Input value={code} onChange={event => setCodeDraft({ id: login.id, value: event.target.value })} autoComplete="off" autoCapitalize="none" spellCheck={false} disabled={loginBusy} maxLength={4096} /></label>
      <Button type="submit" size="sm" disabled={loginBusy || !code.trim()}>{loginBusy ? t('claudeAccounts.submittingCode') : t('claudeAccounts.submitCode')}</Button>
    </form>}
    {pending && !expired && login.url && !url && <p role="alert" className="text-xs text-destructive">{t('claudeAccounts.invalidLoginUrl')}</p>}
    {(login.error || loginError) && <p role="alert" className="break-words text-xs text-destructive">{login.error || loginError}</p>}
    {pending ? <Button type="button" size="sm" variant="outline" disabled={loginBusy} onClick={() => void cancelLogin()}>{t('claudeAccounts.cancelLogin')}</Button>
      : <Button type="button" size="sm" variant="outline" disabled={loginBusy} onClick={dismissLogin}>{t('claudeAccounts.dismissLogin')}</Button>}
  </section>;
}
