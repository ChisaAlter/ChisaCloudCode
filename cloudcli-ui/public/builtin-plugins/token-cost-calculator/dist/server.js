// vendor/builtin-plugins/token-cost-calculator/src/server.ts
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
var PRESETS = [
  {
    name: "Claude Opus 4.7",
    provider: "Anthropic",
    inputPrice: 15,
    outputPrice: 75,
    cachedInputPrice: 1.5
  },
  {
    name: "Claude Sonnet 4.6",
    provider: "Anthropic",
    inputPrice: 3,
    outputPrice: 15,
    cachedInputPrice: 0.3
  },
  {
    name: "Claude Haiku 4.5",
    provider: "Anthropic",
    inputPrice: 0.8,
    outputPrice: 4,
    cachedInputPrice: 0.08
  },
  {
    name: "GPT-4o",
    provider: "OpenAI",
    inputPrice: 2.5,
    outputPrice: 10,
    cachedInputPrice: 1.25
  },
  {
    name: "GPT-4o-mini",
    provider: "OpenAI",
    inputPrice: 0.15,
    outputPrice: 0.6,
    cachedInputPrice: 0.075
  },
  {
    name: "Gemini 2.5 Pro",
    provider: "Google",
    inputPrice: 1.25,
    outputPrice: 10,
    cachedInputPrice: 0.313
  },
  {
    name: "Gemini 2.5 Flash",
    provider: "Google",
    inputPrice: 0.15,
    outputPrice: 0.6,
    cachedInputPrice: 0.038
  },
  {
    name: "DeepSeek V4 Pro",
    provider: "DeepSeek",
    inputPrice: 0.6,
    outputPrice: 2.4,
    cachedInputPrice: 0.06
  }
];
function normalizePath(p) {
  let n = p.trim();
  if (process.platform === "win32") {
    n = n.replace(/\//g, "\\");
    n = n.replace(/^([a-z]):/i, (_, d) => d.toUpperCase() + ":");
    n = n.replace(/^([A-Z]):(?!\\)/, "$1:\\");
  }
  return n;
}
function encodeProjectPath(projectPath) {
  const p = normalizePath(projectPath);
  return p.replace(/^([A-Z]):\\/, "$1--").replace(/\\/g, "-").replace(/:/g, "-").replace(/ /g, "-").replace(/_/g, "-");
}
function resolveClaudeDir() {
  const candidates = [];
  try {
    candidates.push(os.homedir());
  } catch {
  }
  if (process.env.USERPROFILE) candidates.push(process.env.USERPROFILE);
  if (process.env.HOME) candidates.push(process.env.HOME);
  try {
    const cwd = process.cwd();
    if (cwd) candidates.push(cwd);
  } catch {
  }
  for (const home of candidates) {
    const claudeDir = path.join(home, ".claude");
    if (fs.existsSync(claudeDir)) {
      return claudeDir;
    }
  }
  return path.join(candidates[0] || os.homedir(), ".claude");
}
function findSession(projectPath, sessionId) {
  const encoded = encodeProjectPath(projectPath);
  const claudeDir = resolveClaudeDir();
  const projectsRoot = path.join(claudeDir, "projects");
  const exactDir = path.join(projectsRoot, encoded);
  if (fs.existsSync(exactDir)) {
    const f = path.join(exactDir, `${sessionId}.jsonl`);
    if (fs.existsSync(f)) {
      return { projectsDir: exactDir, sessionFile: f };
    }
  }
  if (fs.existsSync(projectsRoot)) {
    try {
      const entries = fs.readdirSync(projectsRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const candidate = path.join(projectsRoot, entry.name, `${sessionId}.jsonl`);
        if (fs.existsSync(candidate)) {
          return { projectsDir: path.join(projectsRoot, entry.name), sessionFile: candidate };
        }
      }
    } catch {
    }
  }
  if (process.platform === "win32" && fs.existsSync(projectsRoot)) {
    try {
      const lower = encoded.toLowerCase();
      const entries = fs.readdirSync(projectsRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.toLowerCase() === lower) {
          const f = path.join(projectsRoot, entry.name, `${sessionId}.jsonl`);
          if (fs.existsSync(f)) {
            return { projectsDir: path.join(projectsRoot, entry.name), sessionFile: f };
          }
        }
      }
    } catch {
    }
  }
  return null;
}
async function parseSessionFile(filePath) {
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let turnCount = 0;
  let model = "";
  if (!fs.existsSync(filePath)) {
    return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, turnCount: 0, model: "" };
  }
  const rl = createInterface({
    input: fs.createReadStream(filePath, { encoding: "utf-8" }),
    crlfDelay: Infinity
  });
  const seenMsgIds = /* @__PURE__ */ new Set();
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type !== "assistant") continue;
      const usage = entry.message?.usage;
      if (!usage) continue;
      const msgId = entry.message?.id;
      if (msgId) {
        if (seenMsgIds.has(msgId)) continue;
        seenMsgIds.add(msgId);
      }
      turnCount++;
      inputTokens += usage.input_tokens ?? 0;
      outputTokens += usage.output_tokens ?? 0;
      cachedInputTokens += (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
      if (!model && entry.message?.model) {
        model = entry.message.model;
      }
    } catch {
    }
  }
  return { inputTokens, outputTokens, cachedInputTokens, turnCount, model };
}
async function getSessionUsage(projectPath, sessionId) {
  if (!projectPath || !sessionId) {
    return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, turnCount: 0, sessionId, projectPath, model: "", error: "Missing projectPath or sessionId" };
  }
  const found = findSession(projectPath, sessionId);
  if (!found) {
    const encoded = encodeProjectPath(projectPath);
    const claudeDir = resolveClaudeDir();
    return {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      turnCount: 0,
      sessionId,
      projectPath,
      model: "",
      error: `Session not found. Looked in: ${path.join(claudeDir, "projects", encoded)}. Try checking the project path and session ID.`
    };
  }
  const { projectsDir, sessionFile } = found;
  const main = await parseSessionFile(sessionFile);
  const subagentsDir = path.join(projectsDir, sessionId, "subagents");
  let subInput = 0;
  let subOutput = 0;
  let subCached = 0;
  let subTurns = 0;
  if (fs.existsSync(subagentsDir)) {
    const entries = fs.readdirSync(subagentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const sub = await parseSessionFile(path.join(subagentsDir, entry.name));
        subInput += sub.inputTokens;
        subOutput += sub.outputTokens;
        subCached += sub.cachedInputTokens;
        subTurns += sub.turnCount;
      }
    }
  }
  return {
    inputTokens: main.inputTokens + subInput,
    outputTokens: main.outputTokens + subOutput,
    cachedInputTokens: main.cachedInputTokens + subCached,
    turnCount: main.turnCount + subTurns,
    sessionId,
    projectPath,
    model: main.model || "unknown"
  };
}
async function getProjectUsage(projectPath) {
  if (!projectPath) {
    return { projectPath: "", inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, turnCount: 0, sessionCount: 0, sessions: [], error: "Missing projectPath" };
  }
  const encoded = encodeProjectPath(projectPath);
  const claudeDir = resolveClaudeDir();
  const projectsDir = path.join(claudeDir, "projects", encoded);
  if (!fs.existsSync(projectsDir)) {
    const claudeDirRoot = resolveClaudeDir();
    return {
      projectPath,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      turnCount: 0,
      sessionCount: 0,
      sessions: [],
      error: `Project directory not found. Looked in: ${path.join(claudeDirRoot, "projects", encoded)}`
    };
  }
  return scanProjectDir(projectsDir, projectPath);
}
async function scanProjectDir(projectsDir, projectPath) {
  const sessions = [];
  let totalInput = 0;
  let totalOutput = 0;
  let totalCached = 0;
  let totalTurns = 0;
  const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const sessionId = entry.name.replace(/\.jsonl$/, "");
    const sessionFile = path.join(projectsDir, entry.name);
    const main = await parseSessionFile(sessionFile);
    const subagentsDir = path.join(projectsDir, sessionId, "subagents");
    let subInput = 0;
    let subOutput = 0;
    let subCached = 0;
    let subTurns = 0;
    if (fs.existsSync(subagentsDir)) {
      try {
        const subEntries = fs.readdirSync(subagentsDir, { withFileTypes: true });
        for (const sub of subEntries) {
          if (sub.isFile() && sub.name.endsWith(".jsonl")) {
            const r = await parseSessionFile(path.join(subagentsDir, sub.name));
            subInput += r.inputTokens;
            subOutput += r.outputTokens;
            subCached += r.cachedInputTokens;
            subTurns += r.turnCount;
          }
        }
      } catch {
      }
    }
    const sInput = main.inputTokens + subInput;
    const sOutput = main.outputTokens + subOutput;
    const sCached = main.cachedInputTokens + subCached;
    const sTurns = main.turnCount + subTurns;
    if (sInput > 0 || sOutput > 0) {
      sessions.push({
        sessionId,
        inputTokens: sInput,
        outputTokens: sOutput,
        cachedInputTokens: sCached,
        turnCount: sTurns,
        model: main.model || "unknown"
      });
      totalInput += sInput;
      totalOutput += sOutput;
      totalCached += sCached;
      totalTurns += sTurns;
    }
  }
  sessions.sort((a, b) => b.inputTokens + b.outputTokens + b.cachedInputTokens - (a.inputTokens + a.outputTokens + a.cachedInputTokens));
  return {
    projectPath,
    inputTokens: totalInput,
    outputTokens: totalOutput,
    cachedInputTokens: totalCached,
    turnCount: totalTurns,
    sessionCount: sessions.length,
    sessions
  };
}
async function getAllUsage() {
  const claudeDir = resolveClaudeDir();
  const projectsRoot = path.join(claudeDir, "projects");
  if (!fs.existsSync(projectsRoot)) {
    return {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      turnCount: 0,
      sessionCount: 0,
      projectCount: 0,
      projects: [],
      error: `Projects directory not found: ${projectsRoot}`
    };
  }
  const projects = [];
  let totalInput = 0;
  let totalOutput = 0;
  let totalCached = 0;
  let totalTurns = 0;
  let totalSessions = 0;
  const dirEntries = fs.readdirSync(projectsRoot, { withFileTypes: true });
  for (const dir of dirEntries) {
    if (!dir.isDirectory()) continue;
    const projectDir = path.join(projectsRoot, dir.name);
    const decodedPath = decodeProjectPath(dir.name);
    const usage = await scanProjectDir(projectDir, decodedPath);
    if (usage.sessionCount > 0) {
      projects.push({
        projectPath: decodedPath,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        turnCount: usage.turnCount,
        sessionCount: usage.sessionCount
      });
      totalInput += usage.inputTokens;
      totalOutput += usage.outputTokens;
      totalCached += usage.cachedInputTokens;
      totalTurns += usage.turnCount;
      totalSessions += usage.sessionCount;
    }
  }
  projects.sort((a, b) => b.inputTokens + b.outputTokens + b.cachedInputTokens - (a.inputTokens + a.outputTokens + a.cachedInputTokens));
  return {
    inputTokens: totalInput,
    outputTokens: totalOutput,
    cachedInputTokens: totalCached,
    turnCount: totalTurns,
    sessionCount: totalSessions,
    projectCount: projects.length,
    projects
  };
}
function decodeProjectPath(encoded) {
  return encoded.replace(/^([A-Z])--/, "$1:\\");
}
async function getDailyUsage() {
  const claudeDir = resolveClaudeDir();
  const projectsRoot = path.join(claudeDir, "projects");
  if (!fs.existsSync(projectsRoot)) {
    return {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      turnCount: 0,
      sessionCount: 0,
      days: [],
      error: `Projects directory not found: ${projectsRoot}`
    };
  }
  const dayMap = /* @__PURE__ */ new Map();
  const dirEntries = fs.readdirSync(projectsRoot, { withFileTypes: true });
  for (const dir of dirEntries) {
    if (!dir.isDirectory()) continue;
    const projectDir = path.join(projectsRoot, dir.name);
    let fileEntries;
    try {
      fileEntries = fs.readdirSync(projectDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const file of fileEntries) {
      if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
      const sessionId = file.name.replace(/\.jsonl$/, "");
      const sessionFile = path.join(projectDir, file.name);
      const dailySessions = await parseDailyFile(sessionFile, sessionId);
      for (const [date, usage] of dailySessions) {
        let day = dayMap.get(date);
        if (!day) {
          day = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, turnCount: 0, sessions: /* @__PURE__ */ new Set() };
          dayMap.set(date, day);
        }
        day.inputTokens += usage.inputTokens;
        day.outputTokens += usage.outputTokens;
        day.cachedInputTokens += usage.cachedInputTokens;
        day.turnCount += usage.turnCount;
        day.sessions.add(sessionId);
      }
    }
  }
  let totalInput = 0;
  let totalOutput = 0;
  let totalCached = 0;
  let totalTurns = 0;
  const allSessions = /* @__PURE__ */ new Set();
  const days = Array.from(dayMap.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([date, d]) => {
    totalInput += d.inputTokens;
    totalOutput += d.outputTokens;
    totalCached += d.cachedInputTokens;
    totalTurns += d.turnCount;
    d.sessions.forEach((s) => allSessions.add(s));
    return {
      date,
      inputTokens: d.inputTokens,
      outputTokens: d.outputTokens,
      cachedInputTokens: d.cachedInputTokens,
      turnCount: d.turnCount,
      sessionCount: d.sessions.size
    };
  });
  return {
    inputTokens: totalInput,
    outputTokens: totalOutput,
    cachedInputTokens: totalCached,
    turnCount: totalTurns,
    sessionCount: allSessions.size,
    days
  };
}
async function parseDailyFile(filePath, _sessionId) {
  const dayMap = /* @__PURE__ */ new Map();
  if (!fs.existsSync(filePath)) return dayMap;
  const rl = createInterface({
    input: fs.createReadStream(filePath, { encoding: "utf-8" }),
    crlfDelay: Infinity
  });
  const seenMsgIds = /* @__PURE__ */ new Set();
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type !== "assistant") continue;
      const usage = entry.message?.usage;
      if (!usage) continue;
      const msgId = entry.message?.id;
      if (msgId) {
        if (seenMsgIds.has(msgId)) continue;
        seenMsgIds.add(msgId);
      }
      const ts = entry.timestamp;
      if (!ts) continue;
      const date = new Date(ts).toISOString().slice(0, 10);
      let day = dayMap.get(date);
      if (!day) {
        day = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, turnCount: 0 };
        dayMap.set(date, day);
      }
      day.inputTokens += usage.input_tokens ?? 0;
      day.outputTokens += usage.output_tokens ?? 0;
      day.cachedInputTokens += (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
      day.turnCount++;
    } catch {
    }
  }
  return dayMap;
}
var server = http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  const url = new URL(req.url || "/", "http://localhost");
  if (req.method === "GET" && (url.pathname === "/presets" || url.pathname === "//presets")) {
    res.writeHead(200);
    res.end(JSON.stringify(PRESETS));
    return;
  }
  if (req.method === "GET" && (url.pathname === "/session-usage" || url.pathname === "//session-usage")) {
    const projectPath = url.searchParams.get("projectPath");
    const sessionId = url.searchParams.get("sessionId");
    if (!projectPath || !sessionId) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "Missing projectPath or sessionId" }));
      return;
    }
    try {
      const usage = await getSessionUsage(projectPath, sessionId);
      res.writeHead(200);
      res.end(JSON.stringify(usage));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }
  if (req.method === "POST" && (url.pathname === "/calculate" || url.pathname === "//calculate")) {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        const { inputPrice, outputPrice, cachedInputPrice, inputTokens, outputTokens, cachedInputTokens } = JSON.parse(body);
        const inputCost = inputTokens / 1e6 * inputPrice;
        const outputCost = outputTokens / 1e6 * outputPrice;
        const cachedInputCost = cachedInputTokens / 1e6 * cachedInputPrice;
        const total = inputCost + outputCost + cachedInputCost;
        res.writeHead(200);
        res.end(JSON.stringify({
          inputCost: Math.round(inputCost * 1e4) / 1e4,
          outputCost: Math.round(outputCost * 1e4) / 1e4,
          cachedInputCost: Math.round(cachedInputCost * 1e4) / 1e4,
          total: Math.round(total * 1e4) / 1e4
        }));
      } catch (err) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }
  if (req.method === "GET" && (url.pathname === "/project-usage" || url.pathname === "//project-usage")) {
    const projectPath = url.searchParams.get("projectPath");
    if (!projectPath) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "Missing projectPath" }));
      return;
    }
    try {
      const usage = await getProjectUsage(projectPath);
      res.writeHead(200);
      res.end(JSON.stringify(usage));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }
  if (req.method === "GET" && (url.pathname === "/all-usage" || url.pathname === "//all-usage")) {
    try {
      const usage = await getAllUsage();
      res.writeHead(200);
      res.end(JSON.stringify(usage));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }
  if (req.method === "GET" && (url.pathname === "/daily-usage" || url.pathname === "//daily-usage")) {
    try {
      const usage = await getDailyUsage();
      res.writeHead(200);
      res.end(JSON.stringify(usage));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }
  res.writeHead(404);
  res.end(JSON.stringify({ error: "Not found" }));
});
server.listen(0, "127.0.0.1", () => {
  const addr = server.address();
  if (addr && typeof addr !== "string") {
    console.log(JSON.stringify({ ready: true, port: addr.port }));
  }
});
