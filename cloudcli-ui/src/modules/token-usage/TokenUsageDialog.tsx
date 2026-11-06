import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { Loader2, RefreshCw, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useTokenStatistics } from '@/modules/token-usage/hooks/useTokenStatistics';
import { getAuthSessionVersion } from '@/shared/authToken';
import { getServerConnectionVersion } from '@/shared/chisa';
import { Button, Dialog, DialogContent, DialogTitle } from '@/shared/ui';
import type { TokenStatisticsCounts, TokenStatisticsRange } from '@/shared/types';

const RANGES: TokenStatisticsRange[] = ['today', '7d', '30d', 'all'];

function StatisticsTable({ label, columns, children }: { label: string; columns: string[]; children: ReactNode }) {
  return (
    <div className="max-h-64 overflow-auto rounded-md border border-border" role="region" aria-label={label} tabIndex={0}>
      <table className="w-full text-xs">
        <caption className="sr-only">{label}</caption>
        <thead className="sticky top-0 bg-popover">
          <tr>
            {columns.map((column, index) => (
              <th key={column} scope="col" className={`whitespace-nowrap border-b border-border px-3 py-2 font-medium text-muted-foreground ${index ? 'text-right' : 'text-left'}`}>
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">{children}</tbody>
      </table>
    </div>
  );
}

function TokenUsageContent({ sessionId, sessionTitle }: { sessionId?: string; sessionTitle?: string }) {
  const { t, i18n } = useTranslation('chat');
  // Opening a session starts at its complete history; account statistics start at the last seven calendar dates.
  const [scope, setScope] = useState<'session' | 'all'>(sessionId ? 'session' : 'all');
  // Range is independently editable after each scope's initial default has been selected.
  const [range, setRange] = useState<TokenStatisticsRange>(sessionId ? 'all' : '7d');
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const { report, loading, error, unsupportedServer, refresh } = useTokenStatistics(range, timeZone, scope === 'session' ? sessionId : undefined);
  const format = (value: number) => value.toLocaleString(i18n.resolvedLanguage || i18n.language);
  const hasMeasurements = Boolean(report && report.coverage.measuredSessions > 0);
  const noMeasurements = Boolean(report && !hasMeasurements);
  const zeroUsage = hasMeasurements && report?.totals.totalTokens === 0;
  const count = (value: number | undefined) => hasMeasurements && value !== undefined ? format(value) : '—';
  const metrics = [
    { key: 'input', value: report?.totals.inputTokens },
    { key: 'output', value: report?.totals.outputTokens },
    { key: 'cacheRead', value: report?.totals.cacheReadTokens },
    { key: 'cacheCreation', value: report?.totals.cacheCreationTokens },
  ];
  const columns = [t('tokenStatistics.total'), t('tokenStatistics.input'), t('tokenStatistics.output'), t('tokenStatistics.cacheRead'), t('tokenStatistics.cacheCreation'), t('tokenStatistics.requests')];
  const counters = (row: TokenStatisticsCounts) => (
    [row.totalTokens, row.inputTokens, row.outputTokens, row.cacheReadTokens, row.cacheCreationTokens, row.requests].map((value, index) => (
      <td key={index} className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{format(value)}</td>
    ))
  );

  return (
    <div className="space-y-4" aria-busy={loading}>
      <section className="space-y-4" aria-label={t('tokenStatistics.summary')}>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">{t('tokenStatistics.total')}</p>
            <p className="mt-1 break-all text-3xl font-semibold tabular-nums leading-tight" data-testid="token-statistics-total">
              {count(report?.totals.totalTokens)}
            </p>
          </div>
          <div className="flex items-center gap-3">
            {hasMeasurements && report && (
              <p className="text-xs text-muted-foreground">
                {t('tokenStatistics.requestCount', { count: report.totals.requests, value: format(report.totals.requests) })}
                {' · '}
                {t('tokenStatistics.sessionCount', { count: report.totals.sessions, value: format(report.totals.sessions) })}
              </p>
            )}
            <Button type="button" variant="ghost" size="sm" className="h-8 gap-1.5 px-2 text-xs" onClick={refresh} disabled={loading} aria-label={t('tokenStatistics.refresh')}>
              <RefreshCw aria-hidden="true" className={loading ? 'animate-spin' : ''} />
              {t('tokenStatistics.refresh')}
            </Button>
          </div>
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          {metrics.map(metric => (
            <div key={metric.key} className="min-w-0">
              <dt className="text-xs text-muted-foreground">{t(`tokenStatistics.${metric.key}`)}</dt>
              <dd className="mt-1 break-all text-sm font-medium tabular-nums" data-testid={`token-statistics-${metric.key}`}>{count(metric.value)}</dd>
            </div>
          ))}
        </dl>
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3 border-y border-border py-3">
        {sessionId ? (
          <div role="group" aria-label={t('tokenStatistics.scope')} className="flex flex-wrap gap-1">
            {(['session', 'all'] as const).map(value => (
              <Button key={value} type="button" size="sm" variant={scope === value ? 'secondary' : 'ghost'} aria-pressed={scope === value} className="h-8 px-2.5 text-xs" onClick={() => {
                if (scope === value) return;
                setScope(value);
                setRange(value === 'session' ? 'all' : '7d');
              }}>
                {t(value === 'session' ? 'tokenStatistics.currentSession' : 'tokenStatistics.allSessions')}
              </Button>
            ))}
          </div>
        ) : <p className="text-xs text-muted-foreground">{t('tokenStatistics.allSessions')}</p>}
        <div role="group" aria-label={t('tokenStatistics.range')} className="flex flex-wrap gap-1">
          {RANGES.map(value => (
            <Button key={value} type="button" size="sm" variant={range === value ? 'secondary' : 'ghost'} aria-pressed={range === value} className="h-8 px-2.5 text-xs" onClick={() => setRange(value)}>
              {t(`tokenStatistics.ranges.${value}`)}
            </Button>
          ))}
        </div>
      </div>

      {scope === 'session' && sessionTitle && <p className="break-words text-xs text-muted-foreground">{sessionTitle}</p>}
      {loading && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />{t('tokenStatistics.loading')}</p>}
      {error && (
        <div role="alert" className="space-y-2">
          {/* A server without the route cannot be fixed by retrying, so name the version gap instead of a failed read. */}
          <p className="text-sm text-destructive">{t(unsupportedServer ? 'tokenStatistics.unsupportedServer' : 'tokenStatistics.loadError')}</p>
          {error.message && <p className="break-words text-xs text-muted-foreground">{error.message}</p>}
          <Button type="button" variant="outline" size="sm" onClick={refresh}>{t('tokenStatistics.retry')}</Button>
        </div>
      )}
      {noMeasurements && report && (
        <p role="status" className="text-sm text-muted-foreground">
          {t(report.coverage.indexedSessions === 0 ? 'tokenStatistics.empty' : 'tokenStatistics.unmeasured')}
        </p>
      )}
      {zeroUsage && <p role="status" className="text-sm text-muted-foreground">{t('tokenStatistics.zeroUsage')}</p>}

      {report && (
        <>
          <div className="space-y-1 text-xs text-muted-foreground">
            <p>{t('tokenStatistics.coverageSummary', { measured: format(report.coverage.measuredSessions), indexed: format(report.coverage.indexedSessions) })}</p>
            <p>{t('tokenStatistics.timeZone', { timeZone: report.timeZone })}</p>
            {(report.coverage.unavailableSessions > 0 || report.coverage.unsupportedSessions > 0) && (
              <p>{t('tokenStatistics.coverageMissing', { unavailable: format(report.coverage.unavailableSessions), unsupported: format(report.coverage.unsupportedSessions) })}</p>
            )}
          </div>
          <div className="divide-y divide-border">
            <details className="py-3">
              <summary className="cursor-pointer text-sm font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">{t('tokenStatistics.daily')}</summary>
              <div className="mt-3">
                {report.daily.length ? (
                  <StatisticsTable label={t('tokenStatistics.daily')} columns={[t('tokenStatistics.date'), ...columns]}>
                    {report.daily.map(row => <tr key={row.date}><th scope="row" className="whitespace-nowrap px-3 py-2 text-left font-normal">{row.date}</th>{counters(row)}</tr>)}
                  </StatisticsTable>
                ) : <p className="text-xs text-muted-foreground">{t('tokenStatistics.noBreakdown')}</p>}
              </div>
            </details>
            <details className="py-3">
              <summary className="cursor-pointer text-sm font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">{t('tokenStatistics.byModel')}</summary>
              <div className="mt-3">
                {report.byModel.length ? (
                  <StatisticsTable label={t('tokenStatistics.byModel')} columns={[t('tokenStatistics.model'), ...columns]}>
                    {report.byModel.map((row, index) => (
                      <tr key={`${row.provider}:${row.model}:${index}`}>
                        <th scope="row" className="min-w-32 max-w-64 px-3 py-2 text-left font-normal"><span className="block break-words">{row.model || t('tokenStatistics.unknownModel')}</span>{row.provider && <span className="mt-0.5 block text-muted-foreground">{row.provider}</span>}</th>
                        {counters(row)}
                      </tr>
                    ))}
                  </StatisticsTable>
                ) : <p className="text-xs text-muted-foreground">{t('tokenStatistics.noBreakdown')}</p>}
              </div>
            </details>
            <details className="py-3">
              <summary className="cursor-pointer text-sm font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">{t('tokenStatistics.bySession')}</summary>
              <div className="mt-3">
                {report.bySession.length ? (
                  <StatisticsTable label={t('tokenStatistics.bySession')} columns={[t('tokenStatistics.session'), ...columns]}>
                    {report.bySession.map(row => (
                      <tr key={row.sessionId}>
                        <th scope="row" className="min-w-40 max-w-64 px-3 py-2 text-left font-normal">
                          <span className="block break-words">{row.title || t('tokenStatistics.untitledSession')}</span>
                          {(row.projectName || row.provider) && <span className="mt-0.5 block break-words text-muted-foreground">{[row.projectName, row.provider].filter(Boolean).join(' · ')}</span>}
                          {row.isArchived && <span className="mt-1 inline-block rounded border border-border px-1.5 py-0.5 text-muted-foreground">{t('tokenStatistics.archived')}</span>}
                        </th>
                        {counters(row)}
                      </tr>
                    ))}
                  </StatisticsTable>
                ) : <p className="text-xs text-muted-foreground">{t('tokenStatistics.noBreakdown')}</p>}
              </div>
            </details>
            <details className="py-3">
              <summary className="cursor-pointer text-sm font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">{t('tokenStatistics.coverage')}</summary>
              <div className="mt-3 space-y-2 text-xs leading-relaxed text-muted-foreground">
                <p>{t('tokenStatistics.sourceNote')}</p>
                <p>{t('tokenStatistics.countingNote')}</p>
                <p>{t('tokenStatistics.coverageNote')}</p>
                <p>{t('tokenStatistics.calendarNote', { timeZone: report.timeZone })}</p>
                <p>{t('tokenStatistics.updatedAt', { time: new Date(report.generatedAt).toLocaleString(i18n.resolvedLanguage || i18n.language) })}</p>
              </div>
            </details>
          </div>
        </>
      )}
    </div>
  );
}

type TokenUsageDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId?: string | null;
  sessionTitle?: string;
};

/** The chat and auth account-menu modules open saved usage for a session or the whole account. */
export function TokenUsageDialog({ open, onOpenChange, sessionId, sessionTitle }: TokenUsageDialogProps) {
  const { t } = useTranslation('chat');
  const titleId = useId();
  const identityKey = JSON.stringify([getAuthSessionVersion(), getServerConnectionVersion(), sessionId || null]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-labelledby={titleId} className="token-statistics-dialog max-h-[85dvh] w-[calc(100%-2rem)] max-w-2xl overflow-y-auto p-4 sm:p-5">
        <div className="mb-4 flex items-center justify-between gap-3">
          <DialogTitle id={titleId} className="not-sr-only text-base font-semibold">{t('tokenStatistics.title')}</DialogTitle>
          <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0" aria-label={t('tokenStatistics.close')} onClick={() => onOpenChange(false)}><X aria-hidden="true" /></Button>
        </div>
        {open && <TokenUsageContent key={identityKey} sessionId={sessionId || undefined} sessionTitle={sessionTitle} />}
      </DialogContent>
    </Dialog>
  );
}
