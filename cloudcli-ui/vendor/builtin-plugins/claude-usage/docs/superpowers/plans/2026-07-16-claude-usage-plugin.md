# Claude Usage Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A CloudCLI tab plugin showing live Claude Code plan-limit usage (session/weekly gauges) plus 30-day token & cost history parsed from local transcripts.

**Architecture:** Standard CloudCLI plugin: frontend ES module (`dist/index.js`, `mount(container, api)`) + Node backend subprocess (`dist/server.js`) reached via `api.rpc()`. Pure logic (pricing, transcript parsing/aggregation, live-response normalization) lives in dedicated modules tested with `node:test`; `server.ts` only does I/O and HTTP wiring; `index.ts` only renders.

**Tech Stack:** TypeScript (strict, ES2020, compiled by `tsc` to `dist/`), Node built-ins only (`node:http`, `node:fs`, `node:path`, `node:os`, global `fetch`, `node:test`). Zero runtime npm dependencies. Vanilla DOM + inline styles on the frontend (template's established style).

## Global Constraints

- No new npm dependencies (install runs with `--ignore-scripts`; spec requires Node built-ins only).
- All relative imports in `src/` must use the `.js` extension (e.g. `./pricing.js`) — compiled output runs as native ESM in Node.
- Never write to `~/.claude/.credentials.json`; never use the refresh token.
- The two API endpoints are `GET /live` and `GET /history?days=N`; each fails independently with `{"error": "..."}` and HTTP 4xx/5xx.
- Data dir resolution: `process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')`.
- Spec: `docs/superpowers/specs/2026-07-16-claude-usage-plugin-design.md`.

### Verified data shapes (from this machine — do not re-derive)

Transcript line (one JSON object per line, `~/.claude/projects/<project-dir>/<session-id>.jsonl`); usage lines repeat per message id, so dedupe on `message.id`:

```json
{"type":"assistant","timestamp":"2026-07-12T21:27:14.468Z","sessionId":"69ace7d1-...","message":{"id":"msg_011Ccxs...","model":"claude-opus-4-8","usage":{"input_tokens":2,"cache_creation_input_tokens":12518,"cache_read_input_tokens":16635,"output_tokens":205}}}
```

`~/.claude/.credentials.json`:

```json
{"claudeAiOauth":{"accessToken":"sk-ant-oat01-...","expiresAt":1752690599000,"subscriptionType":"max","rateLimitTier":"default_claude_max_20x"}}
```

`GET https://api.anthropic.com/api/oauth/usage` with headers `Authorization: Bearer <accessToken>`, `anthropic-beta: oauth-2025-04-20`, `Content-Type: application/json` returns (fields we use):

```json
{"limits":[
  {"kind":"session","group":"session","percent":43,"severity":"normal","resets_at":"2026-07-16T18:29:59.911148+00:00","scope":null,"is_active":true},
  {"kind":"weekly_all","group":"weekly","percent":12,"severity":"normal","resets_at":"2026-07-17T10:59:59.911206+00:00","scope":null,"is_active":false},
  {"kind":"weekly_scoped","group":"weekly","percent":15,"severity":"normal","resets_at":"...","scope":{"model":{"id":null,"display_name":"Fable"},"surface":null},"is_active":false}
]}
```

---

### Task 1: Rebrand plugin metadata and add test infrastructure

**Files:**
- Modify: `manifest.json`
- Modify: `package.json`
- Modify: `icon.svg`
- Delete: `index.html` (legacy iframe demo; not referenced by `manifest.json`)

**Interfaces:**
- Produces: `npm test` runs `tsc` then `node --test dist/` (later tasks rely on this command).

- [ ] **Step 1: Update manifest.json**

Replace the whole file with:

```json
{
  "name": "claude-usage",
  "displayName": "Claude Usage",
  "version": "1.0.0",
  "description": "Live Claude Code plan-limit gauges and 30-day token/cost history.",
  "author": "Valentin Clergue",
  "icon": "icon.svg",
  "type": "module",
  "slot": "tab",
  "entry": "dist/index.js",
  "server": "dist/server.js",
  "permissions": []
}
```

- [ ] **Step 2: Update package.json**

Replace the whole file with:

```json
{
  "name": "cloudcli-plugin-claude-usage",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "test": "tsc && node --test dist/"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "@types/node": "^20.0.0"
  }
}
```

- [ ] **Step 3: Replace icon.svg with a gauge icon**

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M12 20a8 8 0 1 1 8-8" />
  <path d="M12 12l4-4" />
  <path d="M12 20v.01" />
  <path d="M20 12h.01" />
  <path d="M4 12h.01" />
  <path d="M6.3 6.3l.01.01" />
</svg>
```

- [ ] **Step 4: Delete index.html**

```bash
git rm index.html
```

- [ ] **Step 5: Verify build still passes**

Run: `npm test`
Expected: `tsc` succeeds (template `src/` still compiles); `node --test dist/` reports 0 tests, exit 0.

- [ ] **Step 6: Commit**

```bash
git add manifest.json package.json icon.svg
git commit -m "chore: rebrand starter as claude-usage plugin, add test script"
```

---

### Task 2: Pricing module

**Files:**
- Create: `src/pricing.ts`
- Test: `src/pricing.test.ts`

**Interfaces:**
- Produces: `interface TokenCounts { input: number; output: number; cacheCreate: number; cacheRead: number }` and `function estimateCost(model: string, t: TokenCounts): number | null` (dollars; `null` = unknown model). Consumed by `history.ts` and its tests.

- [ ] **Step 1: Write the failing test**

Create `src/pricing.test.ts`:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateCost } from './pricing.js';

const M = 1_000_000;

test('opus 4.8 pricing', () => {
  // $5 in, $25 out, $6.25 cache write, $0.50 cache read per MTok
  const cost = estimateCost('claude-opus-4-8', {
    input: 1 * M, output: 1 * M, cacheCreate: 1 * M, cacheRead: 1 * M,
  });
  assert.equal(cost, 5 + 25 + 6.25 + 0.5);
});

test('fable pricing', () => {
  const cost = estimateCost('claude-fable-5', {
    input: 1 * M, output: 0, cacheCreate: 0, cacheRead: 0,
  });
  assert.equal(cost, 10);
});

test('haiku 4.5 pricing', () => {
  const cost = estimateCost('claude-haiku-4-5-20251001', {
    input: 0, output: 1 * M, cacheCreate: 0, cacheRead: 0,
  });
  assert.equal(cost, 5);
});

test('unknown model returns null', () => {
  assert.equal(estimateCost('gpt-4o', { input: 1, output: 1, cacheCreate: 0, cacheRead: 0 }), null);
  assert.equal(estimateCost('<synthetic>', { input: 1, output: 1, cacheCreate: 0, cacheRead: 0 }), null);
});

test('legacy opus 4.1 uses old pricing', () => {
  const cost = estimateCost('claude-opus-4-1-20250805', {
    input: 1 * M, output: 0, cacheCreate: 0, cacheRead: 0,
  });
  assert.equal(cost, 15);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module './pricing.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/pricing.ts`:

```typescript
/** Token counts for one or more messages. */
export interface TokenCounts {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
}

/** $ per million tokens: [input, output, cacheWrite, cacheRead]. */
type Price = [number, number, number, number];

// Order matters: first match wins. Cache write = 1.25x input (5m TTL),
// cache read = 0.1x input, per Anthropic pricing.
const PRICES: [RegExp, Price][] = [
  [/fable|mythos/, [10, 50, 12.5, 1]],
  [/opus-4-[01]\b/, [15, 75, 18.75, 1.5]],
  [/opus/, [5, 25, 6.25, 0.5]],
  [/sonnet/, [3, 15, 3.75, 0.3]],
  [/haiku-4/, [1, 5, 1.25, 0.1]],
  [/haiku-3-5|3-5-haiku/, [0.8, 4, 1, 0.08]],
  [/haiku/, [0.25, 1.25, 0.3, 0.03]],
];

const M = 1_000_000;

/** Estimated cost in dollars, or null when the model is not in the price table. */
export function estimateCost(model: string, t: TokenCounts): number | null {
  const price = PRICES.find(([re]) => re.test(model))?.[1];
  if (!price) return null;
  const [inp, out, cw, cr] = price;
  return (t.input * inp + t.output * out + t.cacheCreate * cw + t.cacheRead * cr) / M;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/pricing.ts src/pricing.test.ts
git commit -m "feat: model price table with cost estimation"
```

---

### Task 3: History parsing and aggregation module

**Files:**
- Create: `src/history.ts`
- Test: `src/history.test.ts`

**Interfaces:**
- Consumes: `TokenCounts`, `estimateCost` from `./pricing.js`.
- Produces (consumed by `server.ts` and the frontend as the `/history` response shape):

```typescript
interface UsageEntry { id: string; timestamp: string; model: string; tokens: TokenCounts }
interface SessionEntries { project: string; entries: UsageEntry[] }
interface TokenTotals extends TokenCounts { cost: number | null }   // cost null only if NO priced tokens
interface HistoryAggregate {
  daily: { date: string; tokens: TokenCounts; cost: number }[];     // ascending date, last `days` days, zero-filled
  byModel: { model: string; tokens: TokenCounts; cost: number | null }[];   // desc by total tokens
  byProject: { project: string; tokens: TokenCounts; cost: number | null }[]; // desc by total tokens
  totals: { tokens: TokenCounts; cost: number; sessions: number; messages: number };
}
function parseTranscriptLine(line: string): UsageEntry | null
function projectLabel(dirName: string): string
function aggregate(sessions: SessionEntries[], days: number, nowMs: number): HistoryAggregate
```

- [ ] **Step 1: Write the failing test**

Create `src/history.test.ts`:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTranscriptLine, projectLabel, aggregate } from './history.js';

const LINE = JSON.stringify({
  type: 'assistant',
  timestamp: '2026-07-12T21:27:14.468Z',
  message: {
    id: 'msg_1', model: 'claude-opus-4-8',
    usage: { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 200, output_tokens: 50 },
  },
});

test('parseTranscriptLine extracts usage entry', () => {
  const e = parseTranscriptLine(LINE);
  assert.deepEqual(e, {
    id: 'msg_1',
    timestamp: '2026-07-12T21:27:14.468Z',
    model: 'claude-opus-4-8',
    tokens: { input: 2, output: 50, cacheCreate: 100, cacheRead: 200 },
  });
});

test('parseTranscriptLine ignores non-usage and invalid lines', () => {
  assert.equal(parseTranscriptLine('{"type":"queue-operation"}'), null);
  assert.equal(parseTranscriptLine('not json'), null);
  assert.equal(parseTranscriptLine(''), null);
  // synthetic model entries carry no real usage
  const synth = JSON.stringify({ timestamp: 't', message: { id: 'm', model: '<synthetic>', usage: { input_tokens: 1 } } });
  assert.equal(parseTranscriptLine(synth), null);
});

test('projectLabel prettifies claude project dir names', () => {
  assert.equal(projectLabel('-home-cloudcli-projects-DotnetTokenKiller'), 'DotnetTokenKiller');
  assert.equal(projectLabel('-home-cloudcli'), 'home-cloudcli');
});

const NOW = Date.parse('2026-07-16T12:00:00Z');
function entry(id: string, ts: string, model = 'claude-opus-4-8', output = 10) {
  return { id, timestamp: ts, model, tokens: { input: 1, output, cacheCreate: 0, cacheRead: 0 } };
}

test('aggregate dedupes by message id and buckets by day', () => {
  const agg = aggregate(
    [{
      project: 'proj-a',
      entries: [
        entry('m1', '2026-07-15T10:00:00Z'),
        entry('m1', '2026-07-15T10:00:00Z'), // duplicate line — must count once
        entry('m2', '2026-07-16T09:00:00Z'),
      ],
    }],
    30, NOW,
  );
  assert.equal(agg.totals.messages, 2);
  assert.equal(agg.totals.tokens.output, 20);
  assert.equal(agg.totals.sessions, 1);
  assert.equal(agg.daily.length, 30);
  assert.equal(agg.daily[agg.daily.length - 1].date, '2026-07-16');
  assert.equal(agg.daily[agg.daily.length - 1].tokens.output, 10);
  assert.equal(agg.daily[agg.daily.length - 2].tokens.output, 10);
});

test('aggregate filters to window, breaks down by model and project', () => {
  const agg = aggregate(
    [
      { project: 'proj-a', entries: [entry('a1', '2026-07-16T01:00:00Z', 'claude-opus-4-8')] },
      { project: 'proj-b', entries: [entry('b1', '2026-07-16T02:00:00Z', 'claude-fable-5', 100)] },
      { project: 'proj-old', entries: [entry('c1', '2026-01-01T00:00:00Z')] }, // outside window
    ],
    30, NOW,
  );
  assert.equal(agg.totals.sessions, 2);
  assert.equal(agg.byModel.length, 2);
  assert.equal(agg.byModel[0].model, 'claude-fable-5'); // most tokens first
  assert.equal(agg.byProject.length, 2);
  assert.ok(agg.totals.cost > 0);
});

test('aggregate reports null cost for unknown models but counts tokens', () => {
  const agg = aggregate(
    [{ project: 'p', entries: [entry('x1', '2026-07-16T01:00:00Z', 'mystery-model')] }],
    30, NOW,
  );
  assert.equal(agg.byModel[0].cost, null);
  assert.equal(agg.totals.tokens.output, 10);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module './history.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/history.ts`:

```typescript
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
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cacheCreate: usage.cache_creation_input_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
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
  const cutoff = nowMs - days * 86_400_000;
  const seen = new Set<string>();
  const byDay = new Map<string, { tokens: TokenCounts; cost: number }>();
  const byModel = new Map<string, { tokens: TokenCounts; cost: number | null; priced: boolean }>();
  const byProject = new Map<string, { tokens: TokenCounts; cost: number | null; priced: boolean }>();
  const totals = { tokens: zero(), cost: 0, sessions: 0, messages: 0 };

  for (const session of sessions) {
    let sessionActive = false;
    for (const e of session.entries) {
      const ts = Date.parse(e.timestamp);
      if (!Number.isFinite(ts) || ts < cutoff || ts > nowMs + 86_400_000) continue;
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
        const b = map.get(key) ?? { tokens: zero(), cost: null, priced: false };
        add(b.tokens, e.tokens);
        if (cost !== null) {
          b.cost = (b.cost ?? 0) + cost;
          b.priced = true;
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (all pricing + history tests).

- [ ] **Step 5: Commit**

```bash
git add src/history.ts src/history.test.ts
git commit -m "feat: transcript parsing and history aggregation"
```

---

### Task 4: Live usage normalization module

**Files:**
- Create: `src/live.ts`
- Test: `src/live.test.ts`

**Interfaces:**
- Produces (consumed by `server.ts`; `LiveData` is the `/live` response shape):

```typescript
interface LiveLimit { kind: string; label: string; percent: number; severity: string; resetsAt: string | null; model: string | null }
interface LiveData { plan: string | null; tier: string | null; limits: LiveLimit[] }
interface Credentials { accessToken: string; expired: boolean; plan: string | null; tier: string | null }
function parseCredentials(json: unknown, nowMs: number): Credentials | null
function normalizeUsage(raw: unknown, plan: string | null, tier: string | null): LiveData
```

- [ ] **Step 1: Write the failing test**

Create `src/live.test.ts`:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCredentials, normalizeUsage } from './live.js';

const CREDS = {
  claudeAiOauth: {
    accessToken: 'sk-ant-test', refreshToken: 'never-read', expiresAt: 2000,
    subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x',
  },
};

test('parseCredentials extracts token, plan, expiry', () => {
  const c = parseCredentials(CREDS, 1000);
  assert.deepEqual(c, { accessToken: 'sk-ant-test', expired: false, plan: 'max', tier: 'default_claude_max_20x' });
  assert.equal(parseCredentials(CREDS, 3000)!.expired, true);
});

test('parseCredentials returns null for malformed input', () => {
  assert.equal(parseCredentials({}, 0), null);
  assert.equal(parseCredentials(null, 0), null);
});

const RAW = {
  limits: [
    { kind: 'session', percent: 43, severity: 'normal', resets_at: '2026-07-16T18:29:59Z', scope: null, is_active: true },
    { kind: 'weekly_all', percent: 12, severity: 'normal', resets_at: '2026-07-17T10:59:59Z', scope: null },
    { kind: 'weekly_scoped', percent: 15, severity: 'warning', resets_at: '2026-07-17T10:59:59Z', scope: { model: { id: null, display_name: 'Fable' } } },
    { kind: 'weird_new_kind', percent: 'not-a-number' }, // defensive: skipped
  ],
};

test('normalizeUsage maps known limits and skips malformed ones', () => {
  const live = normalizeUsage(RAW, 'max', '20x');
  assert.equal(live.plan, 'max');
  assert.equal(live.limits.length, 3);
  assert.deepEqual(live.limits[0], {
    kind: 'session', label: 'Session (5h)', percent: 43, severity: 'normal',
    resetsAt: '2026-07-16T18:29:59Z', model: null,
  });
  assert.equal(live.limits[1].label, 'Weekly (all models)');
  assert.equal(live.limits[2].label, 'Weekly — Fable');
  assert.equal(live.limits[2].model, 'Fable');
});

test('normalizeUsage tolerates missing limits array', () => {
  assert.deepEqual(normalizeUsage({}, null, null).limits, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module './live.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/live.ts`:

```typescript
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
      const model: string | null = l.scope?.model?.display_name ?? null;
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (all tests across the three test files).

- [ ] **Step 5: Commit**

```bash
git add src/live.ts src/live.test.ts
git commit -m "feat: live usage normalization and credentials parsing"
```

---

### Task 5: Backend server

**Files:**
- Rewrite: `src/server.ts` (replace the project-stats demo entirely)

**Interfaces:**
- Consumes: `parseCredentials`, `normalizeUsage` from `./live.js`; `parseTranscriptLine`, `projectLabel`, `aggregate` from `./history.js`.
- Produces: HTTP `GET /live` → `LiveData` JSON (or `{error}` with 4xx/5xx); `GET /history?days=N` → `HistoryAggregate` JSON. Prints `{"ready":true,"port":N}` on stdout (host contract).

- [ ] **Step 1: Write the implementation**

Replace `src/server.ts` with:

```typescript
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseCredentials, normalizeUsage, LiveData } from './live.js';
import { parseTranscriptLine, projectLabel, aggregate, SessionEntries, UsageEntry } from './history.js';

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const LIVE_CACHE_MS = 30_000;

// ── /live ──────────────────────────────────────────────────────────────

let liveCache: { at: number; data: LiveData } | null = null;

async function getLive(): Promise<LiveData> {
  if (liveCache && Date.now() - liveCache.at < LIVE_CACHE_MS) return liveCache.data;

  let credsJson: unknown;
  try {
    credsJson = JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, '.credentials.json'), 'utf-8'));
  } catch {
    throw Object.assign(new Error('No Claude Code credentials found — sign in with the claude CLI first.'), { status: 404 });
  }
  const creds = parseCredentials(credsJson, Date.now());
  if (!creds) throw Object.assign(new Error('Unrecognized credentials file format.'), { status: 500 });
  if (creds.expired) {
    throw Object.assign(new Error('OAuth token expired — run claude to refresh it, then retry.'), { status: 401 });
  }

  const res = await fetch(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${creds.accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw Object.assign(new Error(`Usage endpoint returned HTTP ${res.status}.`), { status: 502 });
  }
  const data = normalizeUsage(await res.json(), creds.plan, creds.tier);
  liveCache = { at: Date.now(), data };
  return data;
}

// ── /history ───────────────────────────────────────────────────────────

// Per-file parse cache keyed by mtime, so repeated polls only re-read changed files.
const fileCache = new Map<string, { mtimeMs: number; entries: UsageEntry[] }>();

function readSessionFile(file: string): UsageEntry[] {
  const mtimeMs = fs.statSync(file).mtimeMs;
  const cached = fileCache.get(file);
  if (cached && cached.mtimeMs === mtimeMs) return cached.entries;
  const entries: UsageEntry[] = [];
  for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
    const e = parseTranscriptLine(line);
    if (e) entries.push(e);
  }
  fileCache.set(file, { mtimeMs, entries });
  return entries;
}

function getHistory(days: number) {
  const projectsDir = path.join(CLAUDE_DIR, 'projects');
  const sessions: SessionEntries[] = [];
  let dirs: fs.Dirent[] = [];
  try {
    dirs = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    // no transcripts at all — aggregate over nothing, frontend shows empty state
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const project = projectLabel(dir.name);
    let files: string[] = [];
    try {
      files = fs.readdirSync(path.join(projectsDir, dir.name)).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) {
      try {
        sessions.push({ project, entries: readSessionFile(path.join(projectsDir, dir.name, f)) });
      } catch {
        /* unreadable file — skip */
      }
    }
  }
  return aggregate(sessions, days, Date.now());
}

// ── HTTP wiring ────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/live') {
      res.end(JSON.stringify(await getLive()));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/history') {
      const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 30, 1), 365);
      res.end(JSON.stringify(getHistory(days)));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  } catch (err: any) {
    res.writeHead(typeof err?.status === 'number' ? err.status : 500);
    res.end(JSON.stringify({ error: err?.message ?? 'Internal error' }));
  }
});

server.listen(0, '127.0.0.1', () => {
  const addr = server.address();
  if (addr && typeof addr !== 'string') {
    // Signal readiness to the host — this JSON line is required
    console.log(JSON.stringify({ ready: true, port: addr.port }));
  }
});
```

- [ ] **Step 2: Build**

Run: `npm test`
Expected: compile succeeds, all unit tests still pass.

- [ ] **Step 3: Runtime verification (real data)**

Run `node dist/server.js > /tmp/cu-server.log &`, read the port from the `{"ready":true,"port":N}` line in `/tmp/cu-server.log`, then:

```bash
curl -s "http://127.0.0.1:<port>/live" | head -c 400
curl -s "http://127.0.0.1:<port>/history?days=30" | head -c 400
curl -s "http://127.0.0.1:<port>/nope" -w '\n%{http_code}\n'
```

Expected: `/live` returns `{"plan":"max","tier":"default_claude_max_20x","limits":[{"kind":"session",...}]}` with real percents; `/history` returns `{"daily":[...30 items...],"byModel":[...],"byProject":[...],"totals":{...}}` with non-zero totals; `/nope` returns 404. Then stop the server.

- [ ] **Step 4: Commit**

```bash
git add src/server.ts
git commit -m "feat: backend server with /live and /history endpoints"
```

---

### Task 6: Frontend dashboard

**Files:**
- Rewrite: `src/index.ts` (replace the project-stats demo entirely; keep `src/types.ts` untouched)

**Interfaces:**
- Consumes: `PluginAPI`, `PluginContext` from `./types.js`; `api.rpc('GET', 'live')` → `LiveData` shape; `api.rpc('GET', 'history?days=30')` → `HistoryAggregate` shape (declared locally as response interfaces — the frontend must not import server modules, keeping the compiled entry free of node imports).
- Produces: `mount(container, api)` / `unmount(container)` module contract.

- [ ] **Step 1: Write the implementation**

Replace `src/index.ts` with (follows the template's styling conventions — `themeColors`, mono font, inline styles, `cu-` prefixes):

```typescript
/**
 * Claude Usage plugin — module entry point.
 * Live plan-limit gauges + 30-day token/cost history.
 */

import type { PluginAPI, PluginContext } from './types.js';

// ── Response shapes (mirror server.ts output; do not import server code) ─

interface TokenCounts { input: number; output: number; cacheCreate: number; cacheRead: number }
interface LiveLimit { kind: string; label: string; percent: number; severity: string; resetsAt: string | null; model: string | null }
interface LiveData { plan: string | null; tier: string | null; limits: LiveLimit[] }
interface HistoryData {
  daily: { date: string; tokens: TokenCounts; cost: number }[];
  byModel: { model: string; tokens: TokenCounts; cost: number | null }[];
  byProject: { project: string; tokens: TokenCounts; cost: number | null }[];
  totals: { tokens: TokenCounts; cost: number; sessions: number; messages: number };
}

// ── Theme (matches starter conventions) ─────────────────────────────────

const MONO = "'JetBrains Mono', 'Fira Code', ui-monospace, monospace";

interface ThemeColors { bg: string; surface: string; border: string; text: string; muted: string; accent: string; ok: string; warn: string; bad: string }

function themeColors(dark: boolean): ThemeColors {
  return dark
    ? { bg: '#08080f', surface: '#0e0e1a', border: '#1a1a2c', text: '#e2e0f0', muted: '#52507a', accent: '#fbbf24', ok: '#10b981', warn: '#f59e0b', bad: '#f43f5e' }
    : { bg: '#fafaf9', surface: '#ffffff', border: '#e8e6f0', text: '#0f0e1a', muted: '#9490b0', accent: '#d97706', ok: '#059669', warn: '#d97706', bad: '#e11d48' };
}

function sevColor(c: ThemeColors, severity: string, percent: number): string {
  if (severity !== 'normal' || percent >= 90) return c.bad;
  if (percent >= 70) return c.warn;
  return c.ok;
}

// ── Formatting helpers ──────────────────────────────────────────────────

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}

function fmtCost(n: number | null): string {
  return n === null ? '—' : `$${n.toFixed(2)}`;
}

function totalOf(t: TokenCounts): number {
  return t.input + t.output + t.cacheCreate + t.cacheRead;
}

function resetsIn(iso: string | null): string {
  if (!iso) return '';
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return 'resetting…';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (h >= 48) return `resets in ${Math.floor(h / 24)}d ${h % 24}h`;
  return h > 0 ? `resets in ${h}h ${m}m` : `resets in ${m}m`;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch] as string));
}

// ── Section renderers ───────────────────────────────────────────────────

function card(c: ThemeColors, title: string, body: string): string {
  return `
    <div style="background:${c.surface};border:1px solid ${c.border};border-radius:3px;padding:18px;margin-bottom:12px">
      <div style="font-size:0.62rem;color:${c.muted};letter-spacing:0.12em;text-transform:uppercase;margin-bottom:14px">${title}</div>
      ${body}
    </div>`;
}

function errorNote(c: ThemeColors, msg: string): string {
  return `<div style="font-size:0.75rem;color:${c.warn};opacity:0.9">⚠ ${esc(msg)}</div>`;
}

function renderLive(c: ThemeColors, live: LiveData | null, error: string | null): string {
  const badge = live?.plan
    ? `<span style="font-size:0.62rem;border:1px solid ${c.border};border-radius:3px;padding:2px 8px;color:${c.muted}">${esc(live.plan)}${live.tier ? ` · ${esc(live.tier.replace(/^default_claude_/, ''))}` : ''}</span>`
    : '';
  let body: string;
  if (error) {
    body = errorNote(c, error);
  } else if (!live || live.limits.length === 0) {
    body = `<div style="font-size:0.75rem;color:${c.muted}">No limit data available.</div>`;
  } else {
    body = live.limits.map((l) => {
      const color = sevColor(c, l.severity, l.percent);
      const pct = Math.max(0, Math.min(100, l.percent));
      return `
        <div style="margin-bottom:14px">
          <div style="display:flex;justify-content:space-between;font-size:0.72rem;margin-bottom:5px">
            <span>${esc(l.label)}</span>
            <span style="color:${c.muted}">${l.percent}% · ${resetsIn(l.resetsAt)}</span>
          </div>
          <div style="height:6px;background:${c.border};border-radius:3px;overflow:hidden">
            <div style="height:100%;width:${pct}%;background:${color};border-radius:3px;transition:width 0.4s"></div>
          </div>
        </div>`;
    }).join('');
  }
  return card(c, `plan limits ${badge}`, body);
}

function renderChart(c: ThemeColors, daily: HistoryData['daily']): string {
  const max = Math.max(1, ...daily.map((d) => totalOf(d.tokens)));
  const bars = daily.map((d, i) => {
    const h = Math.round((totalOf(d.tokens) / max) * 100);
    const label = `${d.date}: ${fmtTokens(totalOf(d.tokens))} tokens · ${fmtCost(d.cost)}`;
    return `<div title="${label}" style="flex:1;display:flex;align-items:flex-end;height:90px">
      <div style="width:100%;height:${Math.max(h, totalOf(d.tokens) > 0 ? 3 : 0)}%;background:${c.accent};opacity:${0.45 + 0.55 * (i / daily.length)};border-radius:1px"></div>
    </div>`;
  }).join('');
  return `<div style="display:flex;gap:2px;align-items:flex-end">${bars}</div>
    <div style="display:flex;justify-content:space-between;font-size:0.62rem;color:${c.muted};margin-top:6px">
      <span>${daily[0]?.date ?? ''}</span><span>${daily[daily.length - 1]?.date ?? ''}</span>
    </div>`;
}

function renderTable(c: ThemeColors, rows: [string, TokenCounts, number | null][]): string {
  if (rows.length === 0) return `<div style="font-size:0.75rem;color:${c.muted}">No data.</div>`;
  return rows.map(([name, tokens, cost]) => `
    <div style="display:flex;justify-content:space-between;gap:8px;padding:4px 0;border-bottom:1px solid ${c.border};font-size:0.72rem">
      <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;opacity:0.8" title="${esc(name)}">${esc(name)}</div>
      <div style="flex-shrink:0;color:${c.muted}">${fmtTokens(totalOf(tokens))}</div>
      <div style="flex-shrink:0;width:70px;text-align:right;color:${c.accent}">${fmtCost(cost)}</div>
    </div>`).join('');
}

function renderHistory(c: ThemeColors, history: HistoryData | null, error: string | null): string {
  if (error) return card(c, 'usage history (30 days)', errorNote(c, error));
  if (!history) return card(c, 'usage history (30 days)', `<div style="font-size:0.75rem;color:${c.muted}">Loading…</div>`);
  if (history.totals.messages === 0) {
    return card(c, 'usage history (30 days)', `<div style="font-size:0.75rem;color:${c.muted}">No Claude Code activity found in the last 30 days.</div>`);
  }
  const t = history.totals;
  const stats: [string, string][] = [
    ['total tokens', fmtTokens(totalOf(t.tokens))],
    ['output tokens', fmtTokens(t.tokens.output)],
    ['est. cost', fmtCost(t.cost)],
    ['sessions', String(t.sessions)],
  ];
  const statCards = `
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px">
      ${stats.map(([label, val]) => `
        <div style="background:${c.surface};border:1px solid ${c.border};border-radius:3px;padding:14px">
          <div style="font-size:1.35rem;font-weight:700;letter-spacing:-0.03em">${val}</div>
          <div style="font-size:0.62rem;color:${c.muted};margin-top:4px;letter-spacing:0.1em;text-transform:uppercase">${label}</div>
        </div>`).join('')}
    </div>`;
  return `
    ${statCards}
    ${card(c, 'daily tokens (30 days)', renderChart(c, history.daily))}
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      ${card(c, 'by model', renderTable(c, history.byModel.map((m) => [m.model, m.tokens, m.cost])))}
      ${card(c, 'by project', renderTable(c, history.byProject.slice(0, 10).map((p) => [p.project, p.tokens, p.cost])))}
    </div>`;
}

// ── Mount / Unmount ─────────────────────────────────────────────────────

interface State {
  live: LiveData | null;
  liveError: string | null;
  history: HistoryData | null;
  historyError: string | null;
}

export function mount(container: HTMLElement, api: PluginAPI): void {
  const root = document.createElement('div');
  Object.assign(root.style, {
    height: '100%', overflowY: 'auto', boxSizing: 'border-box',
    padding: '24px', fontFamily: MONO,
  });
  container.appendChild(root);

  const state: State = { live: null, liveError: null, history: null, historyError: null };

  function render(ctx: PluginContext): void {
    const c = themeColors(ctx.theme === 'dark');
    root.style.background = c.bg;
    root.style.color = c.text;
    root.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:20px">
        <div style="font-size:1.3rem;font-weight:700;letter-spacing:-0.02em">Claude Usage<span style="color:${c.accent}">▌</span></div>
        <button id="cu-refresh" style="padding:5px 12px;background:transparent;border:1px solid ${c.border};color:${c.muted};font-family:${MONO};font-size:0.7rem;border-radius:3px;cursor:pointer">↻ refresh</button>
      </div>
      ${renderLive(c, state.live, state.liveError)}
      ${renderHistory(c, state.history, state.historyError)}
    `;
    root.querySelector('#cu-refresh')?.addEventListener('click', () => void load(true));
  }

  async function loadLive(): Promise<void> {
    try {
      state.live = (await api.rpc('GET', 'live')) as LiveData;
      state.liveError = null;
    } catch (err) {
      state.live = null;
      state.liveError = (err as Error).message || 'Live usage unavailable.';
    }
  }

  async function loadHistory(): Promise<void> {
    try {
      state.history = (await api.rpc('GET', 'history?days=30')) as HistoryData;
      state.historyError = null;
    } catch (err) {
      state.history = null;
      state.historyError = (err as Error).message || 'History unavailable.';
    }
  }

  async function load(refreshHistory: boolean): Promise<void> {
    // Sections load and fail independently.
    await Promise.all([loadLive(), refreshHistory || !state.history ? loadHistory() : Promise.resolve()]);
    render(api.context);
  }

  render(api.context);
  void load(true);

  // Live gauges poll every 60s while mounted; countdown text refreshes with them.
  const timer = window.setInterval(() => void load(false), 60_000);
  const unsubscribe = api.onContextChange((ctx) => render(ctx));

  (container as any)._cuCleanup = () => {
    window.clearInterval(timer);
    unsubscribe();
  };
}

export function unmount(container: HTMLElement): void {
  (container as any)._cuCleanup?.();
  delete (container as any)._cuCleanup;
  container.innerHTML = '';
}
```

- [ ] **Step 2: Build and test**

Run: `npm test`
Expected: compile succeeds, all unit tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: usage dashboard frontend with gauges and history charts"
```

---

### Task 7: README, end-to-end verification

**Files:**
- Rewrite: `README.md`

**Interfaces:**
- Consumes: everything above; no new code.

- [ ] **Step 1: Rewrite README.md**

Replace with a plugin-specific README (keep the CloudCLI header/badges block from the template through the `---` on line 16, then):

```markdown
# Claude Usage — CloudCLI Plugin

Shows the current usage of Claude Code in a CloudCLI tab:

- **Live plan limits** — session (5h window), weekly, and per-model utilization
  gauges with severity coloring and reset countdowns, straight from the same
  endpoint that powers Claude Code's `/usage` screen. Auto-refreshes every 60s.
- **30-day history** — daily token bar chart, totals (tokens / estimated cost /
  sessions), and per-model / per-project breakdowns, parsed locally from
  `~/.claude/projects/**/*.jsonl` transcripts.

## Installation

Open **Settings > Plugins** in CloudCLI UI, paste this repository's URL, and
click **Install**. Or manually:

```bash
git clone <this-repo-url> ~/.claude-code-ui/plugins/claude-usage
cd ~/.claude-code-ui/plugins/claude-usage
npm install && npm run build
```

## How it works

The backend subprocess (`dist/server.js`) exposes two endpoints via the host's
RPC proxy:

- `GET /live` — reads the OAuth token from `~/.claude/.credentials.json` and
  calls `https://api.anthropic.com/api/oauth/usage` (cached 30s). It never
  writes to the credentials file and never uses the refresh token; if the token
  is expired it asks you to run `claude` to refresh it.
- `GET /history?days=30` — parses local session transcripts (deduped by message
  id, cached by file mtime) and aggregates tokens and estimated cost by day,
  model, and project. Costs use a bundled price table; unknown models show "—".

Both sections fail independently — no credentials still shows history, and
vice-versa.

> **Note:** the usage endpoint is unofficial and may change; the live section
> degrades gracefully if it does.

## Development

```bash
npm install
npm test        # tsc + node --test dist/
npm run dev     # tsc --watch
```

## License

MIT
```

- [ ] **Step 2: Full verification**

```bash
npm test
node dist/server.js   # note port from the ready line, then in another shell:
curl -s "http://127.0.0.1:<port>/live"
curl -s "http://127.0.0.1:<port>/history?days=30" | python3 -m json.tool | head -30
```

Expected: tests pass; `/live` shows current percents; `/history` daily array has 30 entries and totals are plausible against `du -sh ~/.claude/projects` activity. Stop the server.

If a CloudCLI UI instance is available: install the plugin from the repo path via **Settings > Plugins**, enable it, and confirm the tab renders both sections in dark and light themes.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: rewrite README for claude-usage plugin"
```
