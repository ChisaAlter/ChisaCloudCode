export type RateWindow = {
  kind: 'primary' | 'secondary';
  usedPercent: number;
  windowDurationMins: number;
  resetsAt: string | null;
};

export type CreditBalance = {
  hasCredits: boolean;
  unlimited: boolean;
  balance: string | null;
};

export type RateLimit = {
  id: string;
  name: string | null;
  planType: string | null;
  reachedType: string | null;
  credits: CreditBalance | null;
  windows: RateWindow[];
};

export type RateLimitsData = {
  limits: RateLimit[];
  resetCreditsAvailable: number;
};

export type UsageSummary = {
  lifetimeTokens: number | null;
  peakDailyTokens: number | null;
  longestRunningTurnSec: number | null;
  currentStreakDays: number | null;
  longestStreakDays: number | null;
};

export type ActivityData = {
  days: number;
  totalTokens: number;
  daily: { date: string; tokens: number }[];
  summary: UsageSummary;
};

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonNegativeNumber(value: unknown): number | null {
  const number = finiteNumber(value);
  return number !== null && number >= 0 ? number : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function normalizeWindow(kind: RateWindow['kind'], value: unknown): RateWindow | null {
  const raw = record(value);
  if (!raw) return null;
  const usedPercent = nonNegativeNumber(raw.usedPercent);
  const windowDurationMins = nonNegativeNumber(raw.windowDurationMins);
  if (usedPercent === null || windowDurationMins === null) return null;
  const resetSeconds = nonNegativeNumber(raw.resetsAt);
  return {
    kind,
    usedPercent: Math.min(100, usedPercent),
    windowDurationMins,
    resetsAt: resetSeconds === null ? null : new Date(resetSeconds * 1000).toISOString(),
  };
}

function normalizeCredits(value: unknown): CreditBalance | null {
  const raw = record(value);
  if (!raw) return null;
  return {
    hasCredits: raw.hasCredits === true,
    unlimited: raw.unlimited === true,
    balance: nullableString(raw.balance),
  };
}

function normalizeLimit(value: unknown, fallbackId: string): RateLimit | null {
  const raw = record(value);
  if (!raw) return null;
  const id = nullableString(raw.limitId) ?? fallbackId;
  const windows = [
    normalizeWindow('primary', raw.primary),
    normalizeWindow('secondary', raw.secondary),
  ].filter((window): window is RateWindow => window !== null);
  if (windows.length === 0) return null;
  return {
    id,
    name: nullableString(raw.limitName),
    planType: nullableString(raw.planType),
    reachedType: nullableString(raw.rateLimitReachedType),
    credits: normalizeCredits(raw.credits),
    windows,
  };
}

/** Convert the Codex app-server rate-limit response into stable plugin data. */
export function normalizeRateLimits(value: unknown): RateLimitsData {
  const result = record(value) ?? {};
  const byId = record(result.rateLimitsByLimitId);
  const candidates = byId
    ? Object.entries(byId)
    : [['codex', result.rateLimits] as const];
  const limits = candidates
    .map(([id, limit]) => normalizeLimit(limit, id))
    .filter((limit): limit is RateLimit => limit !== null);
  const resetCredits = record(result.rateLimitResetCredits);
  return {
    limits,
    resetCreditsAvailable: nonNegativeNumber(resetCredits?.availableCount) ?? 0,
  };
}

function summaryNumber(summary: JsonRecord | null, key: keyof UsageSummary): number | null {
  return nonNegativeNumber(summary?.[key]);
}

/** Build a zero-filled UTC activity series from the Codex account usage response. */
export function normalizeActivity(value: unknown, days: number, nowMs: number): ActivityData {
  const safeDays = Math.min(Math.max(Math.trunc(days), 1), 365);
  const result = record(value) ?? {};
  const summary = record(result.summary);
  const buckets = Array.isArray(result.dailyUsageBuckets) ? result.dailyUsageBuckets : [];
  const tokensByDate = new Map<string, number>();
  for (const bucketValue of buckets) {
    const bucket = record(bucketValue);
    const date = nullableString(bucket?.startDate);
    const tokens = nonNegativeNumber(bucket?.tokens);
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date) && tokens !== null) {
      tokensByDate.set(date, tokens);
    }
  }

  const today = new Date(nowMs);
  const todayStartMs = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const daily: ActivityData['daily'] = [];
  for (let offset = safeDays - 1; offset >= 0; offset -= 1) {
    const date = new Date(todayStartMs - offset * 86_400_000).toISOString().slice(0, 10);
    daily.push({ date, tokens: tokensByDate.get(date) ?? 0 });
  }

  return {
    days: safeDays,
    totalTokens: daily.reduce((total, day) => total + day.tokens, 0),
    daily,
    summary: {
      lifetimeTokens: summaryNumber(summary, 'lifetimeTokens'),
      peakDailyTokens: summaryNumber(summary, 'peakDailyTokens'),
      longestRunningTurnSec: summaryNumber(summary, 'longestRunningTurnSec'),
      currentStreakDays: summaryNumber(summary, 'currentStreakDays'),
      longestStreakDays: summaryNumber(summary, 'longestStreakDays'),
    },
  };
}
