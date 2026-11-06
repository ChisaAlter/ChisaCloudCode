import { useEffect, useMemo, useState } from 'react';

import { ApiRequestError, api, readApiJson } from '@/shared/api';
import { getAuthSessionVersion } from '@/shared/authToken';
import { getServerConnectionVersion } from '@/shared/chisa';
import type { TokenStatisticsCounts, TokenStatisticsRange, TokenStatisticsReport } from '@/shared/types';

function validCounts(value: unknown): value is TokenStatisticsCounts {
  if (!value || typeof value !== 'object') return false;
  const counts = value as Record<string, unknown>;
  return ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens', 'totalTokens', 'requests'].every(key => (
    typeof counts[key] === 'number' && Number.isFinite(counts[key]) && (counts[key] as number) >= 0
  ));
}

function validReport(value: TokenStatisticsReport | undefined, range: TokenStatisticsRange, timeZone: string, sessionId?: string): value is TokenStatisticsReport {
  if (!value || value.range !== range || value.timeZone !== timeZone || value.sessionId !== (sessionId ?? null)) return false;
  if (typeof value.generatedAt !== 'string' || !Number.isFinite(Date.parse(value.generatedAt))) return false;
  if (!validCounts(value.totals) || !Number.isFinite(value.totals.sessions) || value.totals.sessions < 0) return false;
  if (!value.coverage || !['indexedSessions', 'measuredSessions', 'unavailableSessions', 'unsupportedSessions'].every(key => {
    const count = value.coverage[key as keyof TokenStatisticsReport['coverage']];
    return typeof count === 'number' && Number.isFinite(count) && count >= 0;
  })) return false;
  return Array.isArray(value.daily) && value.daily.every(row => validCounts(row) && typeof row.date === 'string')
    && Array.isArray(value.byModel) && value.byModel.every(row => validCounts(row) && typeof row.model === 'string' && typeof row.provider === 'string')
    && Array.isArray(value.bySession) && value.bySession.every(row => validCounts(row)
      && typeof row.sessionId === 'string' && typeof row.title === 'string' && typeof row.projectName === 'string'
      && typeof row.provider === 'string' && typeof row.isArchived === 'boolean');
}

/**
 * Recognizes a connected server that predates the statistics endpoint: an
 * unmatched route answers with the SPA shell (a 200 body that is not JSON) or a
 * bare 404/405, which retrying can never fix. Any other failure stays a
 * transient read error so the dialog keeps its neutral wording.
 */
function isUnsupportedServer(error: Error | null): boolean {
  if (!(error instanceof ApiRequestError)) return false;
  return error.code === 'INVALID_JSON_RESPONSE' || error.status === 404 || error.status === 405;
}

/** The token-usage dialog reads only the current filter's account-owned saved statistics. */
export function useTokenStatistics(range: TokenStatisticsRange, timeZone: string, sessionId?: string) {
  const authVersion = getAuthSessionVersion();
  const serverVersion = getServerConnectionVersion();
  // Refresh starts a new read even when the visible filters have not changed.
  const [refreshVersion, setRefreshVersion] = useState(0);
  const key = JSON.stringify([authVersion, serverVersion, range, timeZone, sessionId ?? null, refreshVersion]);
  // A new query incarnation also covers returning to an earlier filter before its replacement finishes.
  const query = useMemo(() => ({ key }), [key]);
  // Reports and failures belong to one exact query; a pending replacement never presents a previous total.
  const [snapshot, setSnapshot] = useState<{
    query: object;
    report: TokenStatisticsReport | null;
    error: Error | null;
  } | null>(null);
  const refresh = () => setRefreshVersion(version => version + 1);

  useEffect(() => {
    const controller = new AbortController();
    const current = () => !controller.signal.aborted
      && authVersion === getAuthSessionVersion() && serverVersion === getServerConnectionVersion();
    const load = async () => {
      try {
        const response = await api.providers.tokenStatistics({ range, timeZone, ...(sessionId ? { sessionId } : {}) }, { signal: controller.signal });
        const payload = await readApiJson<{ success: true; data: TokenStatisticsReport }>(response);
        if (!current()) return;
        // A successful HTTP envelope without measured data is a failed read, never a zero-usage report.
        if (payload?.success !== true || !validReport(payload.data, range, timeZone, sessionId)) throw new Error();
        setSnapshot({ query, report: payload.data, error: null });
      } catch (failure) {
        if (current()) setSnapshot({ query, report: null, error: failure instanceof Error ? failure : new Error() });
      }
    };
    void load();
    return () => controller.abort();
  }, [authVersion, query, range, serverVersion, sessionId, timeZone]);

  const owned = snapshot?.query === query && authVersion === getAuthSessionVersion() && serverVersion === getServerConnectionVersion();
  const ownedError = owned ? snapshot.error : null;
  return {
    report: owned ? snapshot.report : null,
    error: ownedError,
    unsupportedServer: isUnsupportedServer(ownedError),
    loading: !owned,
    refresh,
  };
}
