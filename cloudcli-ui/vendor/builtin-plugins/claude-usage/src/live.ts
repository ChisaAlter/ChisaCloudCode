import { normalizeClaudeQuota } from '../../../../shared/claude-quota.js';

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

/** Share the account service's defensive mapper for both usage response families. */
export function normalizeUsage(raw: unknown, plan: string | null, tier: string | null): LiveData {
  const limits: LiveLimit[] = normalizeClaudeQuota(raw).map((window) => ({
    kind: window.kind,
    label: window.label,
    percent: window.usedPercent,
    severity: window.usedPercent >= 90 ? 'danger' : window.usedPercent >= 70 ? 'warning' : 'normal',
    resetsAt: window.resetsAt === null ? null : new Date(window.resetsAt).toISOString(),
    model: window.model,
  }));
  return { plan, tier, limits };
}
