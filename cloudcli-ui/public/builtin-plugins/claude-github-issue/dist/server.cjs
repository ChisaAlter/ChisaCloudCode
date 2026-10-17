"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// vendor/builtin-plugins/claude-github-issue/src/backend/server.ts
var import_http = __toESM(require("http"));
var import_path3 = __toESM(require("path"));
var import_fs3 = __toESM(require("fs"));
var import_url = require("url");

// vendor/builtin-plugins/claude-github-issue/src/backend/github.service.ts
var GITHUB_API = "https://api.github.com";
function makeHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json"
  };
}
async function githubFetch(token, method, urlPath, body) {
  const opts = { method, headers: makeHeaders(token) };
  if (body !== void 0) opts.body = JSON.stringify(body);
  const res = await fetch(`${GITHUB_API}${urlPath}`, opts);
  if (res.status === 204) return null;
  const json = await res.json();
  if (!res.ok) {
    const msg = json?.message ?? JSON.stringify(json);
    throw new Error(`GitHub ${method} ${urlPath} \u2192 ${res.status}: ${msg}`);
  }
  return json;
}
async function listIssues(token, owner, repo, state = "all") {
  const all = [];
  let page = 1;
  while (true) {
    const batch = await githubFetch(
      token,
      "GET",
      `/repos/${owner}/${repo}/issues?state=${state}&per_page=100&page=${page}`
    );
    const issues = batch.filter((i) => !i.pull_request);
    all.push(...issues);
    if (batch.length < 100) break;
    page++;
    if (page > 20) break;
  }
  return all;
}
async function listIssueComments(token, owner, repo, issueNumber) {
  return githubFetch(
    token,
    "GET",
    `/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100`
  );
}
async function patchIssue(token, owner, repo, number, patch) {
  return githubFetch(token, "PATCH", `/repos/${owner}/${repo}/issues/${number}`, patch);
}
async function getIssue(token, owner, repo, number) {
  return githubFetch(token, "GET", `/repos/${owner}/${repo}/issues/${number}`);
}
async function createIssue(token, owner, repo, title, body, labels) {
  const payload = { title };
  if (body?.trim()) payload.body = body.trim();
  if (labels?.length) payload.labels = labels;
  return githubFetch(token, "POST", `/repos/${owner}/${repo}/issues`, payload);
}
async function createComment(token, owner, repo, issueNumber, body) {
  return githubFetch(
    token,
    "POST",
    `/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
    { body }
  );
}
async function listMilestones(token, owner, repo, state = "all") {
  return githubFetch(
    token,
    "GET",
    `/repos/${owner}/${repo}/milestones?state=${state}&per_page=100`
  );
}
async function setIssueMilestone(token, owner, repo, issueNumber, milestoneNumber) {
  return githubFetch(
    token,
    "PATCH",
    `/repos/${owner}/${repo}/issues/${issueNumber}`,
    { milestone: milestoneNumber }
  );
}
async function createMilestone(token, owner, repo, title) {
  return githubFetch(
    token,
    "POST",
    `/repos/${owner}/${repo}/milestones`,
    { title }
  );
}

// vendor/builtin-plugins/claude-github-issue/src/backend/config.service.ts
var import_path = __toESM(require("path"));
var import_fs = require("fs");
var SYNC_FILE = ".GitHubBoard/github-sync.json";
var TASKMASTER_SYNC_FILE = ".taskmaster/github-sync.json";
async function readConfigFile(filePath) {
  try {
    const content = await import_fs.promises.readFile(filePath, "utf8");
    const parsed = JSON.parse(content);
    if (!parsed.token || !parsed.owner || !parsed.repo) return null;
    return {
      token: parsed.token,
      owner: parsed.owner,
      repo: parsed.repo,
      enabled: parsed.enabled !== false,
      anthropicKey: parsed.anthropicKey
    };
  } catch {
    return null;
  }
}
async function readConfig(projectPath) {
  if (!projectPath) return null;
  return await readConfigFile(import_path.default.join(projectPath, SYNC_FILE)) ?? await readConfigFile(import_path.default.join(projectPath, TASKMASTER_SYNC_FILE));
}
async function writeConfig(projectPath, config) {
  if (!projectPath) throw new Error("projectPath required");
  const dir = import_path.default.join(projectPath, ".GitHubBoard");
  await import_fs.promises.mkdir(dir, { recursive: true });
  const filePath = import_path.default.join(projectPath, SYNC_FILE);
  await import_fs.promises.writeFile(filePath, JSON.stringify(config, null, 2), "utf8");
}

// vendor/builtin-plugins/claude-github-issue/src/backend/cache.ts
var Cache = class {
  store = /* @__PURE__ */ new Map();
  get(key) {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }
  set(key, value, ttlMs) {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }
  delete(key) {
    this.store.delete(key);
  }
  deletePrefix(prefix) {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) this.store.delete(key);
    }
  }
  clear() {
    this.store.clear();
  }
};
var globalCache = new Cache();
function cacheGet(key) {
  return globalCache.get(key);
}
function cacheSet(key, value, ttlMs) {
  globalCache.set(key, value, ttlMs);
}
function cacheDeletePrefix(prefix) {
  globalCache.deletePrefix(prefix);
}

// vendor/builtin-plugins/claude-github-issue/src/backend/issues.service.ts
var ISSUES_TTL = 6e4;
var COMMENTS_TTL = 3e4;
var COLUMNS = [
  { id: "todo", name: "To Do", title: "To Do", state: "open", labels: [] },
  { id: "in-progress", name: "In Progress", title: "In Progress", state: "open", labels: ["in-progress"] },
  { id: "review", name: "In Review", title: "In Review", state: "open", labels: ["review"] },
  { id: "blocked", name: "Blocked", title: "Blocked", state: "open", labels: ["blocked"] },
  { id: "done", name: "Done", title: "Done", state: "closed", labels: [] }
];
function buildColumns() {
  return COLUMNS.map((c) => ({ id: c.id, name: c.name, labels: c.labels }));
}
function issueToColumnId(issue) {
  if (issue.state === "closed") return "done";
  const labelNames = new Set(issue.labels.map((l) => l.name));
  for (const col of COLUMNS) {
    if (col.labels.length > 0 && col.labels.some((l) => labelNames.has(l))) {
      return col.id;
    }
  }
  return "todo";
}
function categorizeIssues(issues) {
  return issues.map((issue) => ({ ...issue, columnId: issueToColumnId(issue) }));
}
async function fetchIssues(projectPath) {
  const config = await readConfig(projectPath);
  if (!config?.token || !config?.owner || !config?.repo) {
    const err = new Error("GitHub not configured for this project");
    err.notConfigured = true;
    throw err;
  }
  const cacheKey = `issues:${config.owner}/${config.repo}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;
  const raw = await listIssues(config.token, config.owner, config.repo, "all");
  const issues = categorizeIssues(raw);
  const result = { issues, columns: buildColumns(), owner: config.owner, repo: config.repo };
  cacheSet(cacheKey, result, ISSUES_TTL);
  return result;
}
async function getCachedRepoIssues(config) {
  const cacheKey = `issues:${config.owner}/${config.repo}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached.issues;
  const raw = await listIssues(config.token, config.owner, config.repo, "all");
  const issues = categorizeIssues(raw);
  cacheSet(cacheKey, { issues, columns: buildColumns(), owner: config.owner, repo: config.repo }, ISSUES_TTL);
  return issues;
}
async function getCachedMilestones(config) {
  const cacheKey = `milestones:${config.owner}/${config.repo}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;
  const milestones = await listMilestones(config.token, config.owner, config.repo, "all");
  cacheSet(cacheKey, milestones, ISSUES_TTL);
  return milestones;
}
function invalidateRepo(config) {
  cacheDeletePrefix(`issues:${config.owner}/${config.repo}`);
  cacheDeletePrefix(`milestones:${config.owner}/${config.repo}`);
}
async function fetchComments(projectPath, issueNumber) {
  const config = await readConfig(projectPath);
  if (!config?.token || !config?.owner || !config?.repo) return [];
  const cacheKey = `comments:${config.owner}/${config.repo}:${issueNumber}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;
  const comments = await listIssueComments(config.token, config.owner, config.repo, issueNumber);
  cacheSet(cacheKey, comments, COMMENTS_TTL);
  return comments;
}
async function addComment(projectPath, issueNumber, body) {
  const config = await readConfig(projectPath);
  if (!config?.token || !config?.owner || !config?.repo) throw new Error("Not configured");
  const comment = await createComment(config.token, config.owner, config.repo, issueNumber, body);
  cacheDeletePrefix(`comments:${config.owner}/${config.repo}:${issueNumber}`);
  return comment;
}
async function createIssue2(projectPath, title, body, labels) {
  const config = await readConfig(projectPath);
  if (!config?.token || !config?.owner || !config?.repo) throw new Error("Not configured");
  const issue = await createIssue(config.token, config.owner, config.repo, title, body, labels);
  cacheDeletePrefix(`issues:${config.owner}/${config.repo}`);
  return issue;
}
async function updateIssue(projectPath, issueNumber, { state, addLabels, removeLabels, labels, title }) {
  const config = await readConfig(projectPath);
  if (!config?.token || !config?.owner || !config?.repo) throw new Error("Not configured");
  const patch = {};
  if (state !== void 0) patch.state = state;
  if (title !== void 0) patch.title = title;
  if (labels !== void 0) {
    patch.labels = labels;
  } else if (addLabels?.length || removeLabels?.length) {
    const current = await getIssue(config.token, config.owner, config.repo, issueNumber);
    const currentLabels = (current.labels || []).map((l) => l.name);
    const filtered = currentLabels.filter((l) => !(removeLabels ?? []).includes(l));
    patch.labels = [.../* @__PURE__ */ new Set([...filtered, ...addLabels ?? []])];
  }
  const updated = await patchIssue(config.token, config.owner, config.repo, issueNumber, patch);
  cacheDeletePrefix(`issues:${config.owner}/${config.repo}`);
  return updated;
}

// vendor/builtin-plugins/claude-github-issue/src/backend/ai.service.ts
var import_https = __toESM(require("https"));
var CRITICAL_PATTERNS = ["critical", "blocker", "security", "vulnerability", "crash", "data-loss", "data loss"];
var HIGH_PATTERNS = ["bug", "high", "p0", "p1", "urgent", "priority:high", "high-priority"];
var LOW_PATTERNS = ["nice-to-have", "enhancement", "feature", "improvement", "low", "p3", "wontfix", "documentation", "docs"];
function heuristicScore(issue) {
  let score = 0;
  const labels = issue.labels.map((l) => l.name.toLowerCase());
  if (labels.some((l) => CRITICAL_PATTERNS.some((p) => l.includes(p)))) {
    score += 30;
  } else if (labels.some((l) => HIGH_PATTERNS.some((p) => l === p || l.includes(p)))) {
    score += 15;
  } else if (labels.some((l) => LOW_PATTERNS.some((p) => l.includes(p)))) {
    score -= 10;
  }
  score += Math.min(issue.comments * 2, 15);
  const ageDays = (Date.now() - Date.parse(issue.created_at)) / 864e5;
  score += Math.min(ageDays / 14, 10);
  return score;
}
function levelFromScore(score) {
  if (score >= 25) return "high";
  if (score >= 10) return "medium";
  return "low";
}
function reasonFromScore(issue, score) {
  const labels = issue.labels.map((l) => l.name.toLowerCase());
  if (labels.some((l) => CRITICAL_PATTERNS.some((p) => l.includes(p)))) return "Critical/security label detected";
  if (labels.some((l) => HIGH_PATTERNS.some((p) => l.includes(p)))) return "High-priority label detected";
  if (issue.comments > 5) return `High engagement (${issue.comments} comments)`;
  const ageDays = Math.round((Date.now() - Date.parse(issue.created_at)) / 864e5);
  if (ageDays > 30) return `Open for ${ageDays} days`;
  if (score < 5) return "Low-priority label or enhancement";
  return "Assessed by activity and labels";
}
function heuristicPrioritize(issues) {
  const priorities = issues.filter((i) => i.state !== "closed").map((issue) => {
    const score = heuristicScore(issue);
    return {
      number: issue.number,
      priority: levelFromScore(score),
      score,
      reason: reasonFromScore(issue, score)
    };
  });
  return { priorities, usingAI: false };
}
async function callAnthropic(issues, apiKey) {
  const openIssues = issues.filter((i) => i.state !== "closed").slice(0, 50);
  const issueList = openIssues.map(
    (i) => `#${i.number}: ${i.title}
Labels: ${i.labels.map((l) => l.name).join(", ") || "none"}
Comments: ${i.comments}
Created: ${i.created_at.split("T")[0]}
Description: ${(i.body ?? "").slice(0, 300)}`
  ).join("\n\n---\n\n");
  const prompt = `You are a software project manager. Analyze these GitHub issues and assign each a priority level.

Issues:
${issueList}

Criteria:
- high: security issues, crashes, data loss, critical bugs blocking users
- medium: regular bugs affecting users, important features, performance problems
- low: minor issues, nice-to-have features, documentation, minor enhancements

Return ONLY valid JSON, no explanation:
{"priorities":[{"number":<n>,"priority":"high"|"medium"|"low","reason":"<one brief sentence>"}]}`;
  const reqBody = JSON.stringify({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }]
  });
  return new Promise((resolve, reject) => {
    const req = import_https.default.request(
      {
        hostname: "api.anthropic.com",
        path: "/v1/messages",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "Content-Length": Buffer.byteLength(reqBody)
        },
        timeout: 3e4
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => {
          raw += chunk.toString();
        });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(raw);
            if (parsed.error) {
              reject(new Error(parsed.error.message));
              return;
            }
            const text = parsed.content?.[0]?.text ?? "{}";
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
              reject(new Error("No JSON in AI response"));
              return;
            }
            const data = JSON.parse(jsonMatch[0]);
            const priorities = (data.priorities ?? []).map((p) => ({
              number: p.number,
              priority: ["high", "medium", "low"].includes(p.priority) ? p.priority : "medium",
              score: p.priority === "high" ? 80 : p.priority === "medium" ? 50 : 20,
              reason: p.reason ?? ""
            }));
            resolve(priorities);
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Anthropic API timeout"));
    });
    req.write(reqBody);
    req.end();
  });
}
async function prioritizeIssues(issues, anthropicKey) {
  if (anthropicKey?.trim()) {
    try {
      const priorities = await callAnthropic(issues, anthropicKey.trim());
      return { priorities, usingAI: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn("[claude-github-issue] Anthropic AI failed, falling back to heuristics:", msg);
    }
  }
  return heuristicPrioritize(issues);
}

// vendor/builtin-plugins/claude-github-issue/src/backend/plan.service.ts
var import_path2 = __toESM(require("path"));
var import_fs2 = require("fs");
var PLAN_FILE = ".GitHubBoard/plan.json";
var PHASE_ORDER_KEY = "__phaseOrder__";
async function readRaw(projectPath) {
  if (!projectPath) return {};
  const filePath = import_path2.default.join(projectPath, PLAN_FILE);
  try {
    const content = await import_fs2.promises.readFile(filePath, "utf8");
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}
async function writeRaw(projectPath, obj) {
  if (!projectPath) throw new Error("projectPath required");
  const dir = import_path2.default.join(projectPath, ".GitHubBoard");
  await import_fs2.promises.mkdir(dir, { recursive: true });
  const filePath = import_path2.default.join(projectPath, PLAN_FILE);
  await import_fs2.promises.writeFile(filePath, JSON.stringify(obj, null, 2), "utf8");
}
async function readPlan(projectPath) {
  const raw = await readRaw(projectPath);
  const store = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === PHASE_ORDER_KEY) continue;
    if (v && typeof v === "object" && typeof v.order === "number") {
      store[k] = v;
    }
  }
  return store;
}
async function readPhaseOrder(projectPath) {
  const raw = await readRaw(projectPath);
  const v = raw[PHASE_ORDER_KEY];
  return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
}
async function setPhaseOrder(projectPath, titles) {
  const raw = await readRaw(projectPath);
  raw[PHASE_ORDER_KEY] = titles;
  await writeRaw(projectPath, raw);
}
async function setOrder(projectPath, phase, issueNumbers) {
  const raw = await readRaw(projectPath);
  issueNumbers.forEach((num, idx) => {
    const key = String(num);
    const existing = raw[key];
    raw[key] = { order: idx, phase: phase ?? existing?.phase };
  });
  await writeRaw(projectPath, raw);
  return readPlan(projectPath);
}

// vendor/builtin-plugins/claude-github-issue/src/backend/plan.controller.ts
var NO_PHASE = "__no_phase__";
async function requireConfig(projectPath) {
  const config = await readConfig(projectPath);
  if (!config) {
    const err = new Error("GitHub not configured");
    err.notConfigured = true;
    throw err;
  }
  return config;
}
async function buildPlan(projectPath) {
  const config = await requireConfig(projectPath);
  const [issues, milestones, store, phaseOrder] = await Promise.all([
    getCachedRepoIssues(config),
    getCachedMilestones(config),
    readPlan(projectPath),
    readPhaseOrder(projectPath)
  ]);
  const groups = /* @__PURE__ */ new Map();
  for (const issue of issues) {
    const key = issue.milestone ? String(issue.milestone.number) : NO_PHASE;
    const arr = groups.get(key) ?? [];
    arr.push(issue);
    groups.set(key, arr);
  }
  const orderOf = (num) => {
    const entry = store[String(num)];
    return entry ? entry.order : Number.MAX_SAFE_INTEGER;
  };
  const sortGroup = (arr) => arr.sort((a, b) => {
    const oa = orderOf(a.number);
    const ob = orderOf(b.number);
    if (oa !== ob) return oa - ob;
    return a.number - b.number;
  });
  const phases = [];
  for (const m of milestones) {
    const arr = sortGroup(groups.get(String(m.number)) ?? []);
    phases.push({
      title: m.title,
      milestoneNumber: m.number,
      total: arr.length,
      closed: arr.filter((i) => i.state === "closed").length,
      issues: arr
    });
  }
  if (phaseOrder.length > 0) {
    const rank = (title) => {
      const i = phaseOrder.indexOf(title);
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    };
    phases.sort((a, b) => rank(a.title) - rank(b.title));
  }
  const noPhase = sortGroup(groups.get(NO_PHASE) ?? []);
  if (noPhase.length > 0) {
    phases.push({
      title: "No phase",
      milestoneNumber: null,
      total: noPhase.length,
      closed: noPhase.filter((i) => i.state === "closed").length,
      issues: noPhase
    });
  }
  return { phases };
}
async function saveOrder(projectPath, phase, issueNumbers) {
  await requireConfig(projectPath);
  await setOrder(projectPath, phase, issueNumbers);
}
async function savePhaseOrder(projectPath, titles) {
  await requireConfig(projectPath);
  await setPhaseOrder(projectPath, titles);
}
async function assignPhase(projectPath, issueNumber, milestoneNumber) {
  const config = await requireConfig(projectPath);
  await setIssueMilestone(config.token, config.owner, config.repo, issueNumber, milestoneNumber);
  invalidateRepo(config);
}
async function bootstrap(projectPath, phases) {
  const config = await requireConfig(projectPath);
  const existing = await listMilestones(config.token, config.owner, config.repo, "all");
  const byTitle = new Map(existing.map((m) => [m.title, m.number]));
  const created = [];
  let assigned = 0;
  for (const phase of phases) {
    let num = byTitle.get(phase.title);
    if (num === void 0) {
      const m = await createMilestone(config.token, config.owner, config.repo, phase.title);
      num = m.number;
      byTitle.set(phase.title, num);
      created.push(phase.title);
    }
    for (const issueNumber of phase.issues) {
      await setIssueMilestone(config.token, config.owner, config.repo, issueNumber, num);
      assigned++;
    }
  }
  if (created.length || assigned) invalidateRepo(config);
  return { created, assigned };
}

// vendor/builtin-plugins/claude-github-issue/src/backend/server.ts
function installSkill() {
  try {
    const homeDir = process.env.HOME || process.env.USERPROFILE || "";
    if (!homeDir) return;
    const skillDir = import_path3.default.join(homeDir, ".claude", "skills", "github-task");
    const skillFile = import_path3.default.join(skillDir, "SKILL.md");
    const sourceSkill = import_path3.default.join(__dirname, "..", "skill", "SKILL.md");
    if (!import_fs3.default.existsSync(sourceSkill)) {
      console.log("[claude-github-issue] Skill source not found at", sourceSkill, "\u2014 skipping auto-install");
      return;
    }
    const source = import_fs3.default.readFileSync(sourceSkill, "utf8");
    const current = import_fs3.default.existsSync(skillFile) ? import_fs3.default.readFileSync(skillFile, "utf8") : null;
    if (current !== null) return;
    import_fs3.default.mkdirSync(skillDir, { recursive: true });
    import_fs3.default.writeFileSync(skillFile, source, "utf8");
    console.log("[claude-github-issue] Installed /github-task skill at", skillFile);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[claude-github-issue] Could not install skill:", msg);
  }
}
installSkill();
function parseQuery(rawUrl) {
  try {
    const u = new import_url.URL(rawUrl, "http://localhost");
    const result = {};
    u.searchParams.forEach((v, k) => {
      result[k] = v;
    });
    return result;
  } catch {
    return {};
  }
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
function sendJson(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
    "Access-Control-Allow-Origin": "*"
  });
  res.end(json);
}
async function handleGetIssues(req, res) {
  const query = parseQuery(req.url ?? "");
  const projectPath = query["path"] ?? "";
  if (!projectPath) {
    sendJson(res, 400, { error: "path query parameter required" });
    return;
  }
  try {
    const result = await fetchIssues(projectPath);
    sendJson(res, 200, result);
  } catch (e) {
    const err = e;
    if (err.notConfigured) {
      sendJson(res, 200, { notConfigured: true, error: err.message });
    } else {
      sendJson(res, 500, { error: err.message ?? "Internal error" });
    }
  }
}
async function handlePatchIssue(req, res, issueNumber) {
  const query = parseQuery(req.url ?? "");
  const projectPath = query["path"] ?? "";
  if (!projectPath) {
    sendJson(res, 400, { error: "path query parameter required" });
    return;
  }
  try {
    const raw = await readBody(req);
    const body = JSON.parse(raw);
    const updated = await updateIssue(projectPath, issueNumber, body);
    sendJson(res, 200, { ok: true, issue: updated });
  } catch (e) {
    const err = e;
    sendJson(res, 500, { error: err.message ?? "Internal error" });
  }
}
async function handleGetComments(req, res, issueNumber) {
  const query = parseQuery(req.url ?? "");
  const projectPath = query["path"] ?? "";
  if (!projectPath) {
    sendJson(res, 400, { error: "path query parameter required" });
    return;
  }
  try {
    const comments = await fetchComments(projectPath, issueNumber);
    sendJson(res, 200, { comments });
  } catch (e) {
    const err = e;
    sendJson(res, 500, { error: err.message ?? "Internal error" });
  }
}
async function handlePostComment(req, res, issueNumber) {
  const query = parseQuery(req.url ?? "");
  const projectPath = query["path"] ?? "";
  if (!projectPath) {
    sendJson(res, 400, { error: "path query parameter required" });
    return;
  }
  try {
    const raw = await readBody(req);
    const body = JSON.parse(raw);
    if (!body.body?.trim()) {
      sendJson(res, 400, { error: "Comment body required" });
      return;
    }
    const comment = await addComment(projectPath, issueNumber, body.body.trim());
    sendJson(res, 200, { ok: true, comment });
  } catch (e) {
    const err = e;
    sendJson(res, 500, { error: err.message ?? "Internal error" });
  }
}
async function handleGetConfig(req, res) {
  const query = parseQuery(req.url ?? "");
  const projectPath = query["path"] ?? "";
  if (!projectPath) {
    sendJson(res, 400, { error: "path query parameter required" });
    return;
  }
  try {
    const config = await readConfig(projectPath);
    if (!config) {
      sendJson(res, 200, { configured: false });
    } else {
      sendJson(res, 200, {
        configured: true,
        enabled: config.enabled,
        owner: config.owner,
        repo: config.repo,
        hasToken: Boolean(config.token),
        hasAnthropicKey: Boolean(config.anthropicKey)
      });
    }
  } catch (e) {
    const err = e;
    sendJson(res, 500, { error: err.message ?? "Internal error" });
  }
}
async function handleGetPlan(req, res) {
  const query = parseQuery(req.url ?? "");
  const projectPath = query["path"] ?? "";
  if (!projectPath) {
    sendJson(res, 400, { error: "path query parameter required" });
    return;
  }
  try {
    const plan = await buildPlan(projectPath);
    sendJson(res, 200, plan);
  } catch (e) {
    const err = e;
    if (err.notConfigured) sendJson(res, 200, { notConfigured: true, error: err.message });
    else sendJson(res, 500, { error: err.message ?? "Internal error" });
  }
}
async function handlePutPlanOrder(req, res) {
  const query = parseQuery(req.url ?? "");
  const projectPath = query["path"] ?? "";
  if (!projectPath) {
    sendJson(res, 400, { error: "path query parameter required" });
    return;
  }
  try {
    const raw = await readBody(req);
    const body = JSON.parse(raw);
    if (!Array.isArray(body.order)) {
      sendJson(res, 400, { error: "order array required" });
      return;
    }
    await saveOrder(projectPath, body.phase ?? null, body.order);
    sendJson(res, 200, { ok: true });
  } catch (e) {
    sendJson(res, 500, { error: e.message ?? "Internal error" });
  }
}
async function handlePutPlanPhase(req, res) {
  const query = parseQuery(req.url ?? "");
  const projectPath = query["path"] ?? "";
  if (!projectPath) {
    sendJson(res, 400, { error: "path query parameter required" });
    return;
  }
  try {
    const raw = await readBody(req);
    const body = JSON.parse(raw);
    if (typeof body.issue !== "number") {
      sendJson(res, 400, { error: "issue number required" });
      return;
    }
    await assignPhase(projectPath, body.issue, body.milestone ?? null);
    sendJson(res, 200, { ok: true });
  } catch (e) {
    sendJson(res, 500, { error: e.message ?? "Internal error" });
  }
}
async function handlePutPlanPhaseOrder(req, res) {
  const query = parseQuery(req.url ?? "");
  const projectPath = query["path"] ?? "";
  if (!projectPath) {
    sendJson(res, 400, { error: "path query parameter required" });
    return;
  }
  try {
    const raw = await readBody(req);
    const body = JSON.parse(raw);
    if (!Array.isArray(body.order)) {
      sendJson(res, 400, { error: "order array required" });
      return;
    }
    await savePhaseOrder(projectPath, body.order);
    sendJson(res, 200, { ok: true });
  } catch (e) {
    sendJson(res, 500, { error: e.message ?? "Internal error" });
  }
}
async function handlePostPlanBootstrap(req, res) {
  const query = parseQuery(req.url ?? "");
  const projectPath = query["path"] ?? "";
  if (!projectPath) {
    sendJson(res, 400, { error: "path query parameter required" });
    return;
  }
  try {
    const raw = await readBody(req);
    const body = JSON.parse(raw);
    if (!Array.isArray(body.phases)) {
      sendJson(res, 400, { error: "phases array required" });
      return;
    }
    const result = await bootstrap(projectPath, body.phases);
    sendJson(res, 200, { ok: true, ...result });
  } catch (e) {
    sendJson(res, 500, { error: e.message ?? "Internal error" });
  }
}
var server = import_http.default.createServer(async (req, res) => {
  const method = req.method ?? "GET";
  const rawUrl = req.url ?? "/";
  let pathname;
  try {
    pathname = new import_url.URL(rawUrl, "http://localhost").pathname;
  } catch {
    pathname = rawUrl.split("?")[0] ?? "/";
  }
  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    res.end();
    return;
  }
  try {
    if (method === "GET" && pathname === "/issues") {
      await handleGetIssues(req, res);
      return;
    }
    if (method === "GET" && pathname === "/config") {
      await handleGetConfig(req, res);
      return;
    }
    if (method === "GET" && pathname === "/plan") {
      await handleGetPlan(req, res);
      return;
    }
    if (method === "PUT" && pathname === "/plan/order") {
      await handlePutPlanOrder(req, res);
      return;
    }
    if (method === "PUT" && pathname === "/plan/phase-order") {
      await handlePutPlanPhaseOrder(req, res);
      return;
    }
    if (method === "PUT" && pathname === "/plan/phase") {
      await handlePutPlanPhase(req, res);
      return;
    }
    if (method === "POST" && pathname === "/plan/bootstrap") {
      await handlePostPlanBootstrap(req, res);
      return;
    }
    if (method === "POST" && pathname === "/issues") {
      const query = parseQuery(req.url ?? "");
      const projectPath = query["path"] ?? "";
      if (!projectPath) {
        sendJson(res, 400, { error: "path query parameter required" });
        return;
      }
      try {
        const raw = await readBody(req);
        const body = JSON.parse(raw);
        if (!body.title?.trim()) {
          sendJson(res, 400, { error: "title is required" });
          return;
        }
        const issue = await createIssue2(projectPath, body.title.trim(), body.body, body.labels);
        sendJson(res, 201, { ok: true, issue });
      } catch (e) {
        sendJson(res, 500, { error: e.message ?? "Internal error" });
      }
      return;
    }
    const patchMatch = method === "PATCH" && pathname.match(/^\/issues\/(\d+)$/);
    if (patchMatch && patchMatch[1]) {
      await handlePatchIssue(req, res, patchMatch[1]);
      return;
    }
    const getCommentsMatch = method === "GET" && pathname.match(/^\/issues\/(\d+)\/comments$/);
    if (getCommentsMatch && getCommentsMatch[1]) {
      await handleGetComments(req, res, getCommentsMatch[1]);
      return;
    }
    const postCommentMatch = method === "POST" && pathname.match(/^\/issues\/(\d+)\/comments$/);
    if (postCommentMatch && postCommentMatch[1]) {
      await handlePostComment(req, res, postCommentMatch[1]);
      return;
    }
    if (method === "PUT" && pathname === "/config") {
      const query = parseQuery(req.url ?? "");
      const projectPath = query["path"] ?? "";
      if (!projectPath) {
        sendJson(res, 400, { error: "path query parameter required" });
        return;
      }
      try {
        const raw = await readBody(req);
        const body = JSON.parse(raw);
        if (!body.token?.trim() || !body.owner?.trim() || !body.repo?.trim()) {
          sendJson(res, 400, { error: "token, owner, and repo are required" });
          return;
        }
        const existing = await readConfig(projectPath);
        const config = {
          token: body.token.trim(),
          owner: body.owner.trim(),
          repo: body.repo.trim(),
          enabled: body.enabled !== false,
          anthropicKey: body.anthropicKey?.trim() || existing?.anthropicKey || void 0
        };
        await writeConfig(projectPath, config);
        sendJson(res, 200, { ok: true });
      } catch (e) {
        sendJson(res, 500, { error: e.message ?? "Internal error" });
      }
      return;
    }
    if (method === "POST" && pathname === "/ai-prioritize") {
      const query = parseQuery(req.url ?? "");
      const projectPath = query["path"] ?? "";
      if (!projectPath) {
        sendJson(res, 400, { error: "path query parameter required" });
        return;
      }
      try {
        const raw = await readBody(req);
        const body = JSON.parse(raw);
        if (!Array.isArray(body.issues) || body.issues.length === 0) {
          sendJson(res, 400, { error: "issues array required" });
          return;
        }
        const config = await readConfig(projectPath);
        const result = await prioritizeIssues(body.issues, config?.anthropicKey);
        sendJson(res, 200, result);
      } catch (e) {
        sendJson(res, 500, { error: e.message ?? "Internal error" });
      }
      return;
    }
    if (method === "GET" && pathname === "/health") {
      sendJson(res, 200, { ok: true, plugin: "claude-github-issue" });
      return;
    }
    sendJson(res, 404, { error: "Not found" });
  } catch (e) {
    const err = e;
    console.error("[claude-github-issue] Unhandled error:", err.message);
    sendJson(res, 500, { error: "Internal server error" });
  }
});
server.listen(0, "127.0.0.1", () => {
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  process.stdout.write(JSON.stringify({ ready: true, port }) + "\n");
});
server.on("error", (err) => {
  console.error("[claude-github-issue] Server error:", err.message);
  process.exit(1);
});
