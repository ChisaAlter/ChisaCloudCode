import { estimateCost, TokenCounts } from './pricing.js';

export interface UsageEntry {
  id: string;
  timestamp: string;
  model: string;
  tokens: TokenCounts;
}

export interface SessionEntries {
  project: string;
  entries: UsageEntry[];
}

export interface HistoryAggregate {
  daily: { date: string; tokens: TokenCounts; cost: number }[];
  byModel: { model: string; tokens: TokenCounts; cost: number | null }[];
  byProject: { project: string; tokens: TokenCounts; cost: number | null }[];
  totals: { tokens: TokenCounts; cost: number; sessions: number; messages: number };
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Parse one transcript JSONL line; null when it carries no billable usage. */
export function parseTranscriptLine(line: string): UsageEntry | null {
  if (!line.includes('"usage"')) return null; // fast path
  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  const msg = obj?.message;
  const usage = msg?.usage;
  if (!msg?.id || !msg?.model || !usage || typeof obj.timestamp !== 'string') return null;
  if (msg.model === '<synthetic>') return null;
  return {
    id: msg.id,
    timestamp: obj.timestamp,
    model: msg.model,
    tokens: {
      input: num(usage.input_tokens),
      output: num(usage.output_tokens),
      cacheCreate: num(usage.cache_creation_input_tokens),
      cacheRead: num(usage.cache_read_input_tokens),
    },
  };
}

/** "-home-user-projects-Foo" -> "Foo"; falls back to the trimmed dir name. */
export function projectLabel(dirName: string): string {
  const m = dirName.match(/-projects-(.+)$/);
  return m ? m[1] : dirName.replace(/^-/, '');
}

function zero(): TokenCounts {
  return { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };
}

function add(a: TokenCounts, b: TokenCounts): void {
  a.input += b.input;
  a.output += b.output;
  a.cacheCreate += b.cacheCreate;
  a.cacheRead += b.cacheRead;
}

function totalOf(t: TokenCounts): number {
  return t.input + t.output + t.cacheCreate + t.cacheRead;
}

export function aggregate(sessions: SessionEntries[], days: number, nowMs: number): HistoryAggregate {
  const DAY_MS = 86_400_000;
  const todayStartMs = Math.floor(nowMs / DAY_MS) * DAY_MS; // UTC day start
  const windowStartMs = todayStartMs - (days - 1) * DAY_MS;
  const windowEndMs = todayStartMs + DAY_MS; // exclusive
  const seen = new Set<string>();
  const byDay = new Map<string, { tokens: TokenCounts; cost: number }>();
  const byModel = new Map<string, { tokens: TokenCounts; cost: number | null }>();
  const byProject = new Map<string, { tokens: TokenCounts; cost: number | null }>();
  const totals = { tokens: zero(), cost: 0, sessions: 0, messages: 0 };

  for (const session of sessions) {
    let sessionActive = false;
    for (const e of session.entries) {
      const ts = Date.parse(e.timestamp);
      if (!Number.isFinite(ts) || ts < windowStartMs || ts >= windowEndMs) continue;
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      sessionActive = true;

      const cost = estimateCost(e.model, e.tokens);
      totals.messages += 1;
      add(totals.tokens, e.tokens);
      totals.cost += cost ?? 0;

      const day = new Date(ts).toISOString().slice(0, 10);
      const d = byDay.get(day) ?? { tokens: zero(), cost: 0 };
      add(d.tokens, e.tokens);
      d.cost += cost ?? 0;
      byDay.set(day, d);

      for (const [map, key] of [
        [byModel, e.model],
        [byProject, session.project],
      ] as const) {
        const b = map.get(key) ?? { tokens: zero(), cost: null };
        add(b.tokens, e.tokens);
        if (cost !== null) {
          b.cost = (b.cost ?? 0) + cost;
        }
        map.set(key, b);
      }
    }
    if (sessionActive) totals.sessions += 1;
  }

  // Zero-filled ascending day series ending today (UTC).
  const daily: HistoryAggregate['daily'] = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(nowMs - i * 86_400_000).toISOString().slice(0, 10);
    const d = byDay.get(date);
    daily.push({ date, tokens: d?.tokens ?? zero(), cost: d?.cost ?? 0 });
  }

  const rank = (m: Map<string, { tokens: TokenCounts; cost: number | null }>) =>
    [...m.entries()]
      .sort((a, b) => totalOf(b[1].tokens) - totalOf(a[1].tokens))
      .map(([key, v]) => ({ key, tokens: v.tokens, cost: v.cost }));

  return {
    daily,
    byModel: rank(byModel).map(({ key, ...v }) => ({ model: key, ...v })),
    byProject: rank(byProject).map(({ key, ...v }) => ({ project: key, ...v })),
    totals,
  };
}
