// vendor/builtin-plugins/codex-usage/src/codex-client.ts
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
var REQUEST_TIMEOUT_MS = 15e3;
var DEFAULT_SERVER_MAX_AGE_MS = 10 * 6e4;
function fingerprint(fileStat) {
  return `${fileStat.dev}:${fileStat.ino}:${fileStat.size}:${fileStat.mtimeMs}`;
}
var CodexAppServerClient = class {
  process = null;
  startPromise = null;
  freshnessQueue = Promise.resolve();
  initialized = false;
  nextId = 1;
  pending = /* @__PURE__ */ new Map();
  stderrTail = "";
  authFingerprint = null;
  startedAt = 0;
  authPath;
  maxServerAgeMs;
  now;
  readStat;
  spawnAppServer;
  constructor(options = {}) {
    this.authPath = options.authPath ?? path.join(os.homedir(), ".codex", "auth.json");
    this.maxServerAgeMs = options.maxServerAgeMs ?? DEFAULT_SERVER_MAX_AGE_MS;
    this.now = options.now ?? Date.now;
    this.readStat = options.readStat ?? stat;
    this.spawnAppServer = options.spawnAppServer ?? (() => spawn("codex", ["app-server", "--stdio"], {
      stdio: ["pipe", "pipe", "pipe"]
    }));
  }
  async request(method, params = {}) {
    const ready = this.freshnessQueue.then(
      () => this.ensureFreshServer(),
      () => this.ensureFreshServer()
    );
    this.freshnessQueue = ready.catch(() => void 0);
    await ready;
    return this.sendRequest(method, params);
  }
  close() {
    const process2 = this.process;
    this.process = null;
    this.initialized = false;
    this.authFingerprint = null;
    this.startedAt = 0;
    if (process2 && !process2.killed) process2.kill("SIGTERM");
    this.rejectPending(new Error("Codex app-server stopped."));
  }
  async authFileFingerprint() {
    try {
      return fingerprint(await this.readStat(this.authPath));
    } catch (error) {
      if (error?.code === "ENOENT") return "missing";
      throw error;
    }
  }
  async ensureFreshServer() {
    const beforeStart = await this.authFileFingerprint();
    const authChanged = this.authFingerprint !== null && this.authFingerprint !== beforeStart;
    const expired = this.startedAt > 0 && this.now() - this.startedAt >= this.maxServerAgeMs;
    if (authChanged || expired) this.stopForRestart();
    await this.ensureStarted();
    const afterStart = await this.authFileFingerprint();
    if (afterStart !== beforeStart) {
      this.stopForRestart();
      await this.ensureStarted();
    }
    this.authFingerprint = afterStart;
  }
  stopForRestart() {
    const process2 = this.process;
    this.process = null;
    this.initialized = false;
    this.startedAt = 0;
    if (process2 && !process2.killed) process2.kill("SIGTERM");
    this.rejectPending(new Error("Codex app-server restarted after authentication changed."));
  }
  async ensureStarted() {
    if (this.process && this.initialized && !this.process.killed) return;
    if (!this.startPromise) {
      this.startPromise = this.start().finally(() => {
        this.startPromise = null;
      });
    }
    await this.startPromise;
  }
  async start() {
    const child = this.spawnAppServer();
    this.process = child;
    this.initialized = false;
    this.stderrTail = "";
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (chunk) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString("utf8")}`.slice(-8e3);
    });
    child.once("error", (error) => {
      this.handleExit(child, new Error(`Unable to start Codex CLI: ${error.message}`));
    });
    child.once("exit", (code, signal) => {
      const detail = this.stderrTail.trim();
      const suffix = detail ? ` ${detail}` : "";
      this.handleExit(child, new Error(`Codex app-server exited (${signal ?? code ?? "unknown"}).${suffix}`));
    });
    await this.sendRequest("initialize", {
      clientInfo: {
        name: "cloudcli_codex_usage",
        title: "ChisaCloudCode Codex Usage",
        version: "1.0.0"
      },
      capabilities: {
        optOutNotificationMethods: ["account/rateLimits/updated"]
      }
    });
    this.sendNotification("initialized", {});
    this.initialized = true;
    this.startedAt = this.now();
  }
  sendRequest(method, params) {
    const child = this.process;
    if (!child || child.killed || !child.stdin.writable) {
      return Promise.reject(new Error("Codex app-server is not running."));
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ method, id, params })}
`, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(error);
      });
    });
  }
  sendNotification(method, params) {
    const child = this.process;
    if (child && !child.killed && child.stdin.writable) {
      child.stdin.write(`${JSON.stringify({ method, params })}
`);
    }
  }
  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.message ?? `Codex app-server error ${message.error.code ?? ""}`.trim()));
    } else {
      pending.resolve(message.result);
    }
  }
  handleExit(child, error) {
    if (this.process !== child) return;
    this.process = null;
    this.initialized = false;
    this.startedAt = 0;
    this.rejectPending(error);
  }
  rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
};

// vendor/builtin-plugins/codex-usage/src/server-app.ts
import http from "node:http";

// vendor/builtin-plugins/codex-usage/src/usage.ts
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function nonNegativeNumber(value) {
  const number = finiteNumber(value);
  return number !== null && number >= 0 ? number : null;
}
function nullableString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function normalizeWindow(kind, value) {
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
    resetsAt: resetSeconds === null ? null : new Date(resetSeconds * 1e3).toISOString()
  };
}
function normalizeCredits(value) {
  const raw = record(value);
  if (!raw) return null;
  return {
    hasCredits: raw.hasCredits === true,
    unlimited: raw.unlimited === true,
    balance: nullableString(raw.balance)
  };
}
function normalizeLimit(value, fallbackId) {
  const raw = record(value);
  if (!raw) return null;
  const id = nullableString(raw.limitId) ?? fallbackId;
  const windows = [
    normalizeWindow("primary", raw.primary),
    normalizeWindow("secondary", raw.secondary)
  ].filter((window) => window !== null);
  if (windows.length === 0) return null;
  return {
    id,
    name: nullableString(raw.limitName),
    planType: nullableString(raw.planType),
    reachedType: nullableString(raw.rateLimitReachedType),
    credits: normalizeCredits(raw.credits),
    windows
  };
}
function normalizeRateLimits(value) {
  const result = record(value) ?? {};
  const byId = record(result.rateLimitsByLimitId);
  const candidates = byId ? Object.entries(byId) : [["codex", result.rateLimits]];
  const limits = candidates.map(([id, limit]) => normalizeLimit(limit, id)).filter((limit) => limit !== null);
  const resetCredits = record(result.rateLimitResetCredits);
  return {
    limits,
    resetCreditsAvailable: nonNegativeNumber(resetCredits?.availableCount) ?? 0
  };
}
function summaryNumber(summary, key) {
  return nonNegativeNumber(summary?.[key]);
}
function normalizeActivity(value, days, nowMs) {
  const safeDays = Math.min(Math.max(Math.trunc(days), 1), 365);
  const result = record(value) ?? {};
  const summary = record(result.summary);
  const buckets = Array.isArray(result.dailyUsageBuckets) ? result.dailyUsageBuckets : [];
  const tokensByDate = /* @__PURE__ */ new Map();
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
  const daily = [];
  for (let offset = safeDays - 1; offset >= 0; offset -= 1) {
    const date = new Date(todayStartMs - offset * 864e5).toISOString().slice(0, 10);
    daily.push({ date, tokens: tokensByDate.get(date) ?? 0 });
  }
  return {
    days: safeDays,
    totalTokens: daily.reduce((total, day) => total + day.tokens, 0),
    daily,
    summary: {
      lifetimeTokens: summaryNumber(summary, "lifetimeTokens"),
      peakDailyTokens: summaryNumber(summary, "peakDailyTokens"),
      longestRunningTurnSec: summaryNumber(summary, "longestRunningTurnSec"),
      currentStreakDays: summaryNumber(summary, "currentStreakDays"),
      longestStreakDays: summaryNumber(summary, "longestStreakDays")
    }
  };
}

// vendor/builtin-plugins/codex-usage/src/server-app.ts
function createUsageServer(client2 = new CodexAppServerClient()) {
  return http.createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET" && url.pathname === "/rate-limits") {
        const result = await client2.request("account/rateLimits/read");
        response.end(JSON.stringify(normalizeRateLimits(result)));
        return;
      }
      if (request.method === "GET" && url.pathname === "/activity") {
        const requestedDays = Number(url.searchParams.get("days")) || 30;
        const days = Math.min(Math.max(Math.trunc(requestedDays), 1), 365);
        const result = await client2.request("account/usage/read");
        response.end(JSON.stringify(normalizeActivity(result, days, Date.now())));
        return;
      }
      response.writeHead(404);
      response.end(JSON.stringify({ error: "Not found" }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Codex usage is unavailable.";
      response.writeHead(502);
      response.end(JSON.stringify({ error: message }));
    }
  }).on("close", () => client2.close());
}

// vendor/builtin-plugins/codex-usage/src/server.ts
var client = new CodexAppServerClient();
var server = createUsageServer(client);
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address && typeof address !== "string") {
    console.log(JSON.stringify({ ready: true, port: address.port }));
  }
});
function shutdown() {
  server.close();
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
