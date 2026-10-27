/** @typedef {{kind:string,label:string,usedPercent:number,resetsAt:number|null,model:string|null}} ClaudeQuotaWindow */

/** Normalize Claude's ISO, epoch-second, and epoch-millisecond reset timestamps. */
export function parseClaudeQuotaReset(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const numeric = typeof value === 'number' ? value : Number(value);
  if (Number.isFinite(numeric)) {
    const timestamp = numeric > 10_000_000_000 ? numeric : numeric * 1000;
    return timestamp >= 0 && timestamp <= 8_640_000_000_000_000 ? timestamp : null;
  }
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function percent(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null;
}

/**
 * Shared by the account service and bundled history plugin. Accept both Claude
 * usage response families without inventing a zero for a missing/invalid quota.
 * Named windows are authoritative; duplicate array entries supplement them only.
 * @param {unknown} raw
 * @returns {ClaudeQuotaWindow[]}
 */
export function normalizeClaudeQuota(raw) {
  const data = record(raw);
  if (!data) return [];
  /** @type {ClaudeQuotaWindow[]} */
  const windows = [];
  const seen = new Set();
  const add = (kind, model, input, providedLabel) => {
    const item = record(input);
    if (!item) return;
    const used = percent(item.utilization) ?? percent(item.used_percentage) ?? percent(item.percent);
    if (used === null) return;
    const normalizedModel = typeof model === 'string' && model.trim() ? model.trim() : null;
    const key = `${kind}:${normalizedModel?.toLowerCase() ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    const base = kind === 'session' ? 'Session (5h)' : kind === 'weekly_all' ? 'Weekly (all models)' : kind === 'weekly_scoped' ? 'Weekly' : providedLabel || kind;
    windows.push({ kind, label: normalizedModel ? `${base} — ${normalizedModel}` : base,
      usedPercent: used, resetsAt: parseClaudeQuotaReset(item.resets_at), model: normalizedModel });
  };
  add('session', null, data.five_hour);
  add('weekly_all', null, data.seven_day);
  for (const [field, model] of [['seven_day_opus', 'Opus'], ['seven_day_sonnet', 'Sonnet'], ['seven_day_oauth_apps', 'OAuth apps'], ['seven_day_cowork', 'Cowork']]) {
    add('weekly_scoped', model, data[field]);
  }
  for (const field of ['fable_weekly', 'fable_seven_day', 'seven_day_fable']) add('weekly_scoped', 'Fable', data[field]);
  if (Array.isArray(data.limits)) {
    for (const item of data.limits) {
      if (!record(item) || typeof item.kind !== 'string' || !item.kind.trim()) continue;
      const kind = item.kind === 'five_hour' ? 'session' : item.kind === 'seven_day' ? 'weekly_all' : item.kind;
      add(kind, record(record(item.scope)?.model)?.display_name ?? null, item);
    }
  }
  return windows;
}

/** Normalize optional overage amounts; absent/invalid currency fields remain unknown. */
export function normalizeClaudeExtraUsage(raw) {
  const data = record(raw);
  const extra = record(data?.extra_usage);
  if (!extra) return null;
  const amount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  const spentCents = amount(extra.used_credits);
  const limitCents = amount(extra.monthly_limit);
  const spent = spentCents === null ? null : spentCents / 100;
  const limit = limitCents === null ? null : limitCents / 100;
  return { enabled: extra.is_enabled === true, spent, limit,
    balance: spent === null || limit === null ? null : Math.max(0, limit - spent),
    usedPercent: percent(extra.utilization) ?? (limit && spent !== null ? percent(spent / limit * 100) : null),
    currency: typeof extra.currency === 'string' && /^[A-Z]{3}$/i.test(extra.currency) ? extra.currency.toUpperCase() : 'USD' };
}
