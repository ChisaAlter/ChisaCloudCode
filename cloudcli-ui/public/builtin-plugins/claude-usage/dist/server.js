// vendor/builtin-plugins/claude-usage/src/server.ts
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// vendor/builtin-plugins/claude-usage/src/live.ts
function parseCredentials(json, nowMs) {
  const oauth = json?.claudeAiOauth;
  if (!oauth || typeof oauth.accessToken !== "string") return null;
  return {
    accessToken: oauth.accessToken,
    expired: typeof oauth.expiresAt === "number" && oauth.expiresAt < nowMs,
    plan: typeof oauth.subscriptionType === "string" ? oauth.subscriptionType : null,
    tier: typeof oauth.rateLimitTier === "string" ? oauth.rateLimitTier : null
  };
}
var KIND_LABELS = {
  session: "Session (5h)",
  weekly_all: "Weekly (all models)",
  weekly_scoped: "Weekly"
};
function normalizeUsage(raw, plan, tier) {
  const limits = [];
  const rawLimits = raw?.limits;
  if (Array.isArray(rawLimits)) {
    for (const l of rawLimits) {
      if (typeof l?.kind !== "string" || typeof l?.percent !== "number") continue;
      const rawModel = l.scope?.model?.display_name;
      const model = typeof rawModel === "string" && rawModel !== "" ? rawModel : null;
      const base = KIND_LABELS[l.kind] ?? l.kind;
      limits.push({
        kind: l.kind,
        label: model ? `${base} \u2014 ${model}` : base,
        percent: l.percent,
        severity: typeof l.severity === "string" ? l.severity : "normal",
        resetsAt: typeof l.resets_at === "string" ? l.resets_at : null,
        model
      });
    }
  }
  return { plan, tier, limits };
}

// vendor/builtin-plugins/claude-usage/src/pricing.ts
var PRICES = [
  [/fable|mythos/, [10, 50, 12.5, 1]],
  [/opus-4-[01]\b|3-opus/, [15, 75, 18.75, 1.5]],
  [/opus/, [5, 25, 6.25, 0.5]],
  [/sonnet/, [3, 15, 3.75, 0.3]],
  [/haiku-4/, [1, 5, 1.25, 0.1]],
  [/haiku-3-5|3-5-haiku/, [0.8, 4, 1, 0.08]],
  [/haiku/, [0.25, 1.25, 0.3, 0.03]]
];
var M = 1e6;
function estimateCost(model, t) {
  const price = PRICES.find(([re]) => re.test(model))?.[1];
  if (!price) return null;
  const [inp, out, cw, cr] = price;
  return (t.input * inp + t.output * out + t.cacheCreate * cw + t.cacheRead * cr) / M;
}

// vendor/builtin-plugins/claude-usage/src/history.ts
function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
function parseTranscriptLine(line) {
  if (!line.includes('"usage"')) return null;
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  const msg = obj?.message;
  const usage = msg?.usage;
  if (!msg?.id || !msg?.model || !usage || typeof obj.timestamp !== "string") return null;
  if (msg.model === "<synthetic>") return null;
  return {
    id: msg.id,
    timestamp: obj.timestamp,
    model: msg.model,
    tokens: {
      input: num(usage.input_tokens),
      output: num(usage.output_tokens),
      cacheCreate: num(usage.cache_creation_input_tokens),
      cacheRead: num(usage.cache_read_input_tokens)
    }
  };
}
function projectLabel(dirName) {
  const m = dirName.match(/-projects-(.+)$/);
  return m ? m[1] : dirName.replace(/^-/, "");
}
function zero() {
  return { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };
}
function add(a, b) {
  a.input += b.input;
  a.output += b.output;
  a.cacheCreate += b.cacheCreate;
  a.cacheRead += b.cacheRead;
}
function totalOf(t) {
  return t.input + t.output + t.cacheCreate + t.cacheRead;
}
function aggregate(sessions, days, nowMs) {
  const DAY_MS = 864e5;
  const todayStartMs = Math.floor(nowMs / DAY_MS) * DAY_MS;
  const windowStartMs = todayStartMs - (days - 1) * DAY_MS;
  const windowEndMs = todayStartMs + DAY_MS;
  const seen = /* @__PURE__ */ new Set();
  const byDay = /* @__PURE__ */ new Map();
  const byModel = /* @__PURE__ */ new Map();
  const byProject = /* @__PURE__ */ new Map();
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
        [byProject, session.project]
      ]) {
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
  const daily = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(nowMs - i * 864e5).toISOString().slice(0, 10);
    const d = byDay.get(date);
    daily.push({ date, tokens: d?.tokens ?? zero(), cost: d?.cost ?? 0 });
  }
  const rank = (m) => [...m.entries()].sort((a, b) => totalOf(b[1].tokens) - totalOf(a[1].tokens)).map(([key, v]) => ({ key, tokens: v.tokens, cost: v.cost }));
  return {
    daily,
    byModel: rank(byModel).map(({ key, ...v }) => ({ model: key, ...v })),
    byProject: rank(byProject).map(({ key, ...v }) => ({ project: key, ...v })),
    totals
  };
}

// vendor/builtin-plugins/claude-usage/src/server.ts
var CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
var secureStorage = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
var CREDENTIAL_DIR = secureStorage !== void 0 ? secureStorage || path.join(os.homedir(), ".claude") : CLAUDE_DIR;
var USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
var LIVE_CACHE_MS = 3e4;
var liveCache = null;
async function getLive() {
  if (liveCache && Date.now() - liveCache.at < LIVE_CACHE_MS) return liveCache.data;
  let credsJson;
  try {
    credsJson = JSON.parse(fs.readFileSync(path.join(CREDENTIAL_DIR, ".credentials.json"), "utf-8"));
  } catch {
    throw Object.assign(new Error("No Claude Code credentials found \u2014 sign in with the claude CLI first."), { status: 404 });
  }
  const creds = parseCredentials(credsJson, Date.now());
  if (!creds) throw Object.assign(new Error("Unrecognized credentials file format."), { status: 500 });
  if (creds.expired) {
    throw Object.assign(new Error("OAuth token expired \u2014 run claude to refresh it, then retry."), { status: 401 });
  }
  const res = await fetch(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${creds.accessToken}`,
      "anthropic-beta": "oauth-2025-04-20",
      "Content-Type": "application/json"
    },
    signal: AbortSignal.timeout(1e4)
  });
  if (!res.ok) {
    throw Object.assign(new Error(`Usage endpoint returned HTTP ${res.status}.`), { status: res.status === 429 ? 429 : 502 });
  }
  const data = normalizeUsage(await res.json(), creds.plan, creds.tier);
  liveCache = { at: Date.now(), data };
  return data;
}
var fileCache = /* @__PURE__ */ new Map();
function readSessionFile(file) {
  const mtimeMs = fs.statSync(file).mtimeMs;
  const cached = fileCache.get(file);
  if (cached && cached.mtimeMs === mtimeMs) return cached.entries;
  const entries = [];
  for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
    const e = parseTranscriptLine(line);
    if (e) entries.push(e);
  }
  fileCache.set(file, { mtimeMs, entries });
  return entries;
}
function getHistory(days) {
  const projectsDir = path.join(CLAUDE_DIR, "projects");
  const sessions = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const project = projectLabel(dir.name);
    let files = [];
    try {
      files = fs.readdirSync(path.join(projectsDir, dir.name)).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of files) {
      try {
        sessions.push({ project, entries: readSessionFile(path.join(projectsDir, dir.name, f)) });
      } catch {
      }
    }
  }
  return aggregate(sessions, days, Date.now());
}
var server = http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/live") {
      res.end(JSON.stringify(await getLive()));
      return;
    }
    if (req.method === "GET" && url.pathname === "/history") {
      const days = Math.min(Math.max(Number(url.searchParams.get("days")) || 30, 1), 365);
      res.end(JSON.stringify(getHistory(days)));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not found" }));
  } catch (err) {
    res.writeHead(typeof err?.status === "number" ? err.status : 500);
    res.end(JSON.stringify({ error: err?.message ?? "Internal error" }));
  }
});
server.listen(0, "127.0.0.1", () => {
  const addr = server.address();
  if (addr && typeof addr !== "string") {
    console.log(JSON.stringify({ ready: true, port: addr.port }));
  }
});
