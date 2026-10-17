export interface LiveLimit {
  kind: string;
  label: string;
  percent: number;
  severity: string;
  resetsAt: string | null;
  model: string | null;
}

export interface LiveData {
  plan: string | null;
  tier: string | null;
  limits: LiveLimit[];
}

export interface Credentials {
  accessToken: string;
  expired: boolean;
  plan: string | null;
  tier: string | null;
}

/** Read what we need from ~/.claude/.credentials.json. Never touches the refresh token. */
export function parseCredentials(json: unknown, nowMs: number): Credentials | null {
  const oauth = (json as any)?.claudeAiOauth;
  if (!oauth || typeof oauth.accessToken !== 'string') return null;
  return {
    accessToken: oauth.accessToken,
    expired: typeof oauth.expiresAt === 'number' && oauth.expiresAt < nowMs,
    plan: typeof oauth.subscriptionType === 'string' ? oauth.subscriptionType : null,
    tier: typeof oauth.rateLimitTier === 'string' ? oauth.rateLimitTier : null,
  };
}

const KIND_LABELS: Record<string, string> = {
  session: 'Session (5h)',
  weekly_all: 'Weekly (all models)',
  weekly_scoped: 'Weekly',
};

/** Defensive mapping of the (unofficial) usage endpoint response. */
export function normalizeUsage(raw: unknown, plan: string | null, tier: string | null): LiveData {
  const limits: LiveLimit[] = [];
  const rawLimits = (raw as any)?.limits;
  if (Array.isArray(rawLimits)) {
    for (const l of rawLimits) {
      if (typeof l?.kind !== 'string' || typeof l?.percent !== 'number') continue;
      const rawModel = l.scope?.model?.display_name;
      const model: string | null = typeof rawModel === 'string' && rawModel !== '' ? rawModel : null;
      const base = KIND_LABELS[l.kind] ?? l.kind;
      limits.push({
        kind: l.kind,
        label: model ? `${base} — ${model}` : base,
        percent: l.percent,
        severity: typeof l.severity === 'string' ? l.severity : 'normal',
        resetsAt: typeof l.resets_at === 'string' ? l.resets_at : null,
        model,
      });
    }
  }
  return { plan, tier, limits };
}
