import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { ClaudeAccountUsage } from '@/shared/types';

/** Account rows and the persistent sidebar trigger render the same authoritative windows and unknown states. */
export function ClaudeQuotaDisplay({ usage, compact = false, overview = false }: { usage: ClaudeAccountUsage | null; compact?: boolean; overview?: boolean }) {
  const { t, i18n } = useTranslation('settings');
  // One minute clock per visible quota group updates reset labels without requesting the quota API.
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const windows = usage?.windows.filter(window => Number.isFinite(window.usedPercent) && (window.resetsAt === null || window.resetsAt > now)) ?? [];
  const expired = Boolean(usage?.windows.length && windows.length === 0);
  const noSubscription = usage?.failureKind === 'no-subscription';
  const unavailableText = noSubscription ? t('claudeAccounts.noSubscription') : expired ? t('claudeAccounts.awaitingReset')
    : usage?.status === 'loading' ? t('claudeAccounts.loadingUsage') : t('claudeAccounts.noUsage');
  const windowLabel = (kind: string, label: string) => /^(session|five_hour|5h)$/.test(kind) ? t('claudeAccounts.fiveHour')
    : /^(weekly|weekly_all|seven_day|7d)$/.test(kind) ? t('claudeAccounts.weekly') : label;
  const resetLabel = (at: number | null) => {
    if (at === null) return t('claudeAccounts.resetUnknown');
    const minutes = Math.max(0, Math.ceil((at - now) / 60_000));
    if (minutes === 0) return t('claudeAccounts.awaitingReset');
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    return t('claudeAccounts.resetsIn', { time: days ? t('claudeAccounts.daysHours', { days, hours })
      : hours ? t('claudeAccounts.hoursMinutes', { hours, minutes: minutes % 60 }) : t('claudeAccounts.minutes', { minutes }) });
  };
  const number = (value: number) => new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 }).format(value);
  if (compact) return <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] tabular-nums text-muted-foreground">
    {windows.length > 0 ? windows.slice(0, 2).map(window => <span key={`${window.kind}:${window.label}`} className={window.usedPercent >= 90 ? 'text-destructive' : undefined}>
      {windowLabel(window.kind, window.label)} {number(window.usedPercent)}%
    </span>) : <span>{unavailableText}</span>}
    {usage?.stale && <span>{t('claudeAccounts.staleShort')}</span>}
    {usage?.status === 'error' && !usage.stale && <span>{t('claudeAccounts.errorShort')}</span>}
  </span>;
  return <div className={overview ? 'claude-quota-overview' : 'min-w-0 space-y-2'}>
    {windows.length > 0 ? <div className={overview ? 'claude-quota-windows' : 'space-y-3'}>{windows.map(window => <div key={`${window.kind}:${window.label}`} className={overview ? 'claude-quota-window' : 'space-y-1'}>
      {overview ? <div className="claude-quota-window-heading">
        <p className="claude-quota-window-label">{windowLabel(window.kind, window.label)}</p>
        <div className="claude-quota-value"><span className="claude-quota-percent">{number(window.usedPercent)}<span className="claude-quota-percent-sign">%</span></span><span className="claude-quota-used">{t('claudeAccounts.usedLabel')}</span></div>
      </div> : <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5 text-xs">
        <span className="font-medium text-foreground">{windowLabel(window.kind, window.label)}</span>
        <span className="tabular-nums text-muted-foreground">{t('claudeAccounts.percentUsed', { percent: number(window.usedPercent) })}</span>
      </div>}
      <div role="progressbar" aria-label={windowLabel(window.kind, window.label)} aria-valuenow={window.usedPercent} aria-valuemin={0} aria-valuemax={100}
        className="claude-quota-track">
        <div className={`claude-quota-fill ${window.usedPercent >= 90 ? 'claude-quota-fill--high' : ''}`} style={{ width: `${Math.min(100, Math.max(0, window.usedPercent))}%` }} />
      </div>
      <p className="claude-quota-reset" title={window.resetsAt ? new Date(window.resetsAt).toLocaleString(i18n.language) : undefined}>{resetLabel(window.resetsAt)}</p>
    </div>)}</div> : <p className="claude-quota-unavailable">{unavailableText}</p>}
    {usage?.extraUsage?.enabled && <p className="claude-quota-notice tabular-nums">{t('claudeAccounts.extraUsage', {
      spent: usage.extraUsage.spent === null ? '—' : `${usage.extraUsage.currency} ${number(usage.extraUsage.spent)}`,
      limit: usage.extraUsage.limit === null ? '—' : `${usage.extraUsage.currency} ${number(usage.extraUsage.limit)}`,
    })}</p>}
    {usage?.stale && <p className="claude-quota-notice">{t('claudeAccounts.staleDescription')}</p>}
    {usage?.error && <p className="claude-quota-notice claude-quota-error">{usage.error}</p>}
    {usage?.retryAt && usage.retryAt > now && <p className="claude-quota-notice">{t('claudeAccounts.retryAfter', { time: new Date(usage.retryAt).toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' }) })}</p>}
    <p className="claude-quota-updated">{usage?.updatedAt
      ? t('claudeAccounts.updatedAt', { time: new Date(usage.updatedAt).toLocaleString(i18n.language, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) })
      : t('claudeAccounts.neverUpdated')}</p>
  </div>;
}
