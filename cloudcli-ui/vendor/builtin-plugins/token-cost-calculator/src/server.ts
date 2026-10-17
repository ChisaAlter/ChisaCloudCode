/**
 * Token Cost Calculator — backend server.
 *
 * Serves preset model pricing data, performs cost calculations,
 * and reads Claude session transcript files to auto-detect token usage.
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

// ── Preset model pricing (per 1M tokens, USD) ─────────────────────────

interface ModelPricing {
  name: string;
  provider: string;
  inputPrice: number;
  outputPrice: number;
  cachedInputPrice: number;
}

const PRESETS: ModelPricing[] = [
  {
    name: 'Claude Opus 4.7',
    provider: 'Anthropic',
    inputPrice: 15.0,
    outputPrice: 75.0,
    cachedInputPrice: 1.5,
  },
  {
    name: 'Claude Sonnet 4.6',
    provider: 'Anthropic',
    inputPrice: 3.0,
    outputPrice: 15.0,
    cachedInputPrice: 0.3,
  },
  {
    name: 'Claude Haiku 4.5',
    provider: 'Anthropic',
    inputPrice: 0.8,
    outputPrice: 4.0,
    cachedInputPrice: 0.08,
  },
  {
    name: 'GPT-4o',
    provider: 'OpenAI',
    inputPrice: 2.5,
    outputPrice: 10.0,
    cachedInputPrice: 1.25,
  },
  {
    name: 'GPT-4o-mini',
    provider: 'OpenAI',
    inputPrice: 0.15,
    outputPrice: 0.6,
    cachedInputPrice: 0.075,
  },
  {
    name: 'Gemini 2.5 Pro',
    provider: 'Google',
    inputPrice: 1.25,
    outputPrice: 10.0,
    cachedInputPrice: 0.313,
  },
  {
    name: 'Gemini 2.5 Flash',
    provider: 'Google',
    inputPrice: 0.15,
    outputPrice: 0.6,
    cachedInputPrice: 0.038,
  },
  {
    name: 'DeepSeek V4 Pro',
    provider: 'DeepSeek',
    inputPrice: 0.6,
    outputPrice: 2.4,
    cachedInputPrice: 0.06,
  },
];

// ── Session token reader ───────────────────────────────────────────────

interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  turnCount: number;
  sessionId: string;
  projectPath: string;
  model: string;
  error?: string;
}

interface SessionSummary {
  sessionId: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  turnCount: number;
  model: string;
}

interface ProjectUsage {
  projectPath: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  turnCount: number;
  sessionCount: number;
  sessions: SessionSummary[];
  error?: string;
}

interface AllUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  turnCount: number;
  sessionCount: number;
  projectCount: number;
  projects: {
    projectPath: string;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    turnCount: number;
    sessionCount: number;
  }[];
  error?: string;
}

interface DailyUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  turnCount: number;
  sessionCount: number;
  days: {
    date: string;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    turnCount: number;
    sessionCount: number;
  }[];
  error?: string;
}

interface UsageFields {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/**
 * Normalize a user-supplied path to the canonical Windows form.
 * Handles: C:/Users/...  →  C:\Users\...  or  /home/user/...  as-is.
 */
function normalizePath(p: string): string {
  let n = p.trim();
  // Convert forward slashes to backslashes on Windows
  if (process.platform === 'win32') {
    n = n.replace(/\//g, '\\');
    // Ensure drive letter is uppercase (C: → C:)
    n = n.replace(/^([a-z]):/i, (_, d) => d.toUpperCase() + ':');
    // If path starts with drive but no backslash, fix (C:Users → C:\Users)
    n = n.replace(/^([A-Z]):(?!\\)/, '$1:\\');
  }
  return n;
}

/**
 * Encode a Windows project path to match Claude's directory naming.
 * C:\Users\...  →  C--Users-...
 * Also handles forward-slash inputs and lowercase drive letters.
 */
function encodeProjectPath(projectPath: string): string {
  const p = normalizePath(projectPath);
  // C:\Users\... → C--Users-...
  // Claude Code replaces \ : space _ and other special chars with -
  return p
    .replace(/^([A-Z]):\\/, '$1--')
    .replace(/\\/g, '-')
    .replace(/:/g, '-')
    .replace(/ /g, '-')
    .replace(/_/g, '-');
}

/**
 * Resolve the Claude data root directory (~/.claude).
 * Tries multiple sources since the plugin subprocess has a restricted env.
 */
function resolveClaudeDir(): string {
  const candidates: string[] = [];

  // os.homedir() is most reliable
  try { candidates.push(os.homedir()); } catch { /* ignore */ }
  // Windows fallbacks
  if (process.env.USERPROFILE) candidates.push(process.env.USERPROFILE);
  // Unix HOME
  if (process.env.HOME) candidates.push(process.env.HOME);
  // Derive from process.cwd() if it looks like it's under a home dir
  try {
    const cwd = process.cwd();
    if (cwd) candidates.push(cwd);
  } catch { /* ignore */ }

  for (const home of candidates) {
    const claudeDir = path.join(home, '.claude');
    if (fs.existsSync(claudeDir)) {
      return claudeDir;
    }
  }

  // Last resort: return first candidate
  return path.join(candidates[0] || os.homedir(), '.claude');
}

/**
 * Try to find a session JSONL file by scanning the projects directory.
 * Returns { projectsDir, sessionFile } or null.
 */
function findSession(projectPath: string, sessionId: string): { projectsDir: string; sessionFile: string } | null {
  const encoded = encodeProjectPath(projectPath);
  const claudeDir = resolveClaudeDir();
  const projectsRoot = path.join(claudeDir, 'projects');

  // 1) Exact match with encoded path
  const exactDir = path.join(projectsRoot, encoded);
  if (fs.existsSync(exactDir)) {
    const f = path.join(exactDir, `${sessionId}.jsonl`);
    if (fs.existsSync(f)) {
      return { projectsDir: exactDir, sessionFile: f };
    }
  }

  // 2) Scan all project dirs for a matching session file
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
    } catch { /* ignore */ }
  }

  // 3) Fallback: try case-insensitive match on Windows
  if (process.platform === 'win32' && fs.existsSync(projectsRoot)) {
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
    } catch { /* ignore */ }
  }

  return null;
}

/**
 * Parse a single JSONL file and accumulate token usage from assistant messages.
 */
async function parseSessionFile(filePath: string): Promise<{ inputTokens: number; outputTokens: number; cachedInputTokens: number; turnCount: number; model: string }> {
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let turnCount = 0;
  let model = '';

  if (!fs.existsSync(filePath)) {
    return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, turnCount: 0, model: '' };
  }

  const rl = createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  const seenMsgIds = new Set<string>();

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type !== 'assistant') continue;

      const usage = entry.message?.usage as UsageFields | undefined;
      if (!usage) continue;

      // DeepSeek models produce multiple content blocks per API call
      // (thinking, text, tool_use) — each gets its own JSONL entry but
      // they all share the same message.id and identical usage. Deduplicate.
      const msgId = entry.message?.id as string | undefined;
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
      // skip malformed lines
    }
  }

  return { inputTokens, outputTokens, cachedInputTokens, turnCount, model };
}

/**
 * Read token usage from a Claude session JSONL file (including subagents).
 */
async function getSessionUsage(projectPath: string, sessionId: string): Promise<SessionUsage> {
  if (!projectPath || !sessionId) {
    return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, turnCount: 0, sessionId, projectPath, model: '', error: 'Missing projectPath or sessionId' };
  }

  const found = findSession(projectPath, sessionId);
  if (!found) {
    const encoded = encodeProjectPath(projectPath);
    const claudeDir = resolveClaudeDir();
    return {
      inputTokens: 0, outputTokens: 0, cachedInputTokens: 0,
      turnCount: 0, sessionId, projectPath, model: '',
      error: `Session not found. Looked in: ${path.join(claudeDir, 'projects', encoded)}. Try checking the project path and session ID.`,
    };
  }

  const { projectsDir, sessionFile } = found;
  const main = await parseSessionFile(sessionFile);

  // Also parse subagent sessions
  const subagentsDir = path.join(projectsDir, sessionId, 'subagents');
  let subInput = 0;
  let subOutput = 0;
  let subCached = 0;
  let subTurns = 0;

  if (fs.existsSync(subagentsDir)) {
    const entries = fs.readdirSync(subagentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
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
    model: main.model || 'unknown',
  };
}

// ── Project / All-time scanners ───────────────────────────────────────

/**
 * Parse all sessions for a single project directory and return aggregate.
 */
async function getProjectUsage(projectPath: string): Promise<ProjectUsage> {
  if (!projectPath) {
    return { projectPath: '', inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, turnCount: 0, sessionCount: 0, sessions: [], error: 'Missing projectPath' };
  }

  const encoded = encodeProjectPath(projectPath);
  const claudeDir = resolveClaudeDir();
  const projectsDir = path.join(claudeDir, 'projects', encoded);

  if (!fs.existsSync(projectsDir)) {
    // Try findSession to locate by scanning
    const claudeDirRoot = resolveClaudeDir();
    return {
      projectPath,
      inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, turnCount: 0, sessionCount: 0, sessions: [],
      error: `Project directory not found. Looked in: ${path.join(claudeDirRoot, 'projects', encoded)}`,
    };
  }

  return scanProjectDir(projectsDir, projectPath);
}

async function scanProjectDir(projectsDir: string, projectPath: string): Promise<ProjectUsage> {
  const sessions: SessionSummary[] = [];
  let totalInput = 0;
  let totalOutput = 0;
  let totalCached = 0;
  let totalTurns = 0;

  const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;

    const sessionId = entry.name.replace(/\.jsonl$/, '');
    const sessionFile = path.join(projectsDir, entry.name);
    const main = await parseSessionFile(sessionFile);

    // Include subagents
    const subagentsDir = path.join(projectsDir, sessionId, 'subagents');
    let subInput = 0;
    let subOutput = 0;
    let subCached = 0;
    let subTurns = 0;

    if (fs.existsSync(subagentsDir)) {
      try {
        const subEntries = fs.readdirSync(subagentsDir, { withFileTypes: true });
        for (const sub of subEntries) {
          if (sub.isFile() && sub.name.endsWith('.jsonl')) {
            const r = await parseSessionFile(path.join(subagentsDir, sub.name));
            subInput += r.inputTokens;
            subOutput += r.outputTokens;
            subCached += r.cachedInputTokens;
            subTurns += r.turnCount;
          }
        }
      } catch { /* ignore */ }
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
        model: main.model || 'unknown',
      });
      totalInput += sInput;
      totalOutput += sOutput;
      totalCached += sCached;
      totalTurns += sTurns;
    }
  }

  // Sort sessions by total tokens descending
  sessions.sort((a, b) => (b.inputTokens + b.outputTokens + b.cachedInputTokens) - (a.inputTokens + a.outputTokens + a.cachedInputTokens));

  return {
    projectPath,
    inputTokens: totalInput,
    outputTokens: totalOutput,
    cachedInputTokens: totalCached,
    turnCount: totalTurns,
    sessionCount: sessions.length,
    sessions,
  };
}

/**
 * Scan ALL projects under ~/.claude/projects and return aggregate.
 */
async function getAllUsage(): Promise<AllUsage> {
  const claudeDir = resolveClaudeDir();
  const projectsRoot = path.join(claudeDir, 'projects');

  if (!fs.existsSync(projectsRoot)) {
    return {
      inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, turnCount: 0, sessionCount: 0, projectCount: 0, projects: [],
      error: `Projects directory not found: ${projectsRoot}`,
    };
  }

  const projects: AllUsage['projects'] = [];
  let totalInput = 0;
  let totalOutput = 0;
  let totalCached = 0;
  let totalTurns = 0;
  let totalSessions = 0;

  const dirEntries = fs.readdirSync(projectsRoot, { withFileTypes: true });
  for (const dir of dirEntries) {
    if (!dir.isDirectory()) continue;

    const projectDir = path.join(projectsRoot, dir.name);
    // Decode project path for display (reverse of encode)
    const decodedPath = decodeProjectPath(dir.name);
    const usage = await scanProjectDir(projectDir, decodedPath);

    if (usage.sessionCount > 0) {
      projects.push({
        projectPath: decodedPath,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        turnCount: usage.turnCount,
        sessionCount: usage.sessionCount,
      });
      totalInput += usage.inputTokens;
      totalOutput += usage.outputTokens;
      totalCached += usage.cachedInputTokens;
      totalTurns += usage.turnCount;
      totalSessions += usage.sessionCount;
    }
  }

  // Sort projects by total tokens descending
  projects.sort((a, b) => (b.inputTokens + b.outputTokens + b.cachedInputTokens) - (a.inputTokens + a.outputTokens + a.cachedInputTokens));

  return {
    inputTokens: totalInput,
    outputTokens: totalOutput,
    cachedInputTokens: totalCached,
    turnCount: totalTurns,
    sessionCount: totalSessions,
    projectCount: projects.length,
    projects,
  };
}

/**
 * Reverse the encoded project path back to a readable form.
 * C--Users-19447-Documents-cc-project  →  C:\Users-19447-Documents-cc-project
 * Note: lossy — spaces/underscores that were encoded as - stay as -.
 */
function decodeProjectPath(encoded: string): string {
  // E--... → E:\...
  return encoded.replace(/^([A-Z])--/, '$1:\\');
}

// ── Daily usage scanner ─────────────────────────────────────────────

/**
 * Scan all sessions across all projects and aggregate token usage by day.
 */
async function getDailyUsage(): Promise<DailyUsage> {
  const claudeDir = resolveClaudeDir();
  const projectsRoot = path.join(claudeDir, 'projects');

  if (!fs.existsSync(projectsRoot)) {
    return {
      inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, turnCount: 0, sessionCount: 0, days: [],
      error: `Projects directory not found: ${projectsRoot}`,
    };
  }

  // Map from date string (YYYY-MM-DD) to aggregate
  const dayMap = new Map<string, { inputTokens: number; outputTokens: number; cachedInputTokens: number; turnCount: number; sessions: Set<string> }>();

  const dirEntries = fs.readdirSync(projectsRoot, { withFileTypes: true });
  for (const dir of dirEntries) {
    if (!dir.isDirectory()) continue;

    const projectDir = path.join(projectsRoot, dir.name);
    let fileEntries: fs.Dirent[];
    try { fileEntries = fs.readdirSync(projectDir, { withFileTypes: true }); } catch { continue; }

    for (const file of fileEntries) {
      if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;

      const sessionId = file.name.replace(/\.jsonl$/, '');
      const sessionFile = path.join(projectDir, file.name);
      const dailySessions = await parseDailyFile(sessionFile, sessionId);

      for (const [date, usage] of dailySessions) {
        let day = dayMap.get(date);
        if (!day) {
          day = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, turnCount: 0, sessions: new Set() };
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

  // Build sorted array
  let totalInput = 0;
  let totalOutput = 0;
  let totalCached = 0;
  let totalTurns = 0;
  const allSessions = new Set<string>();

  const days = Array.from(dayMap.entries())
    .sort(([a], [b]) => a.localeCompare(b)) // chronological
    .map(([date, d]) => {
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
        sessionCount: d.sessions.size,
      };
    });

  return {
    inputTokens: totalInput,
    outputTokens: totalOutput,
    cachedInputTokens: totalCached,
    turnCount: totalTurns,
    sessionCount: allSessions.size,
    days,
  };
}

/**
 * Parse a JSONL file and aggregate token usage per day.
 * Returns a Map of date → usage.
 */
async function parseDailyFile(
  filePath: string,
  _sessionId: string,
): Promise<Map<string, { inputTokens: number; outputTokens: number; cachedInputTokens: number; turnCount: number }>> {
  const dayMap = new Map<string, { inputTokens: number; outputTokens: number; cachedInputTokens: number; turnCount: number }>();

  if (!fs.existsSync(filePath)) return dayMap;

  const rl = createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  const seenMsgIds = new Set<string>();

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type !== 'assistant') continue;

      const usage = entry.message?.usage as UsageFields | undefined;
      if (!usage) continue;

      // DeepSeek models produce multiple content blocks per API call
      // (thinking, text, tool_use) — each gets its own JSONL entry but
      // they all share the same message.id and identical usage. Deduplicate.
      const msgId = entry.message?.id as string | undefined;
      if (msgId) {
        if (seenMsgIds.has(msgId)) continue;
        seenMsgIds.add(msgId);
      }

      const ts = entry.timestamp;
      if (!ts) continue; // no timestamp, skip

      const date = new Date(ts).toISOString().slice(0, 10); // YYYY-MM-DD

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
      // skip malformed lines
    }
  }

  return dayMap;
}

// ── HTTP server ────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || '/', 'http://localhost');

  // GET /presets — return all preset model pricing
  if (req.method === 'GET' && (url.pathname === '/presets' || url.pathname === '//presets')) {
    res.writeHead(200);
    res.end(JSON.stringify(PRESETS));
    return;
  }

  // GET /session-usage?projectPath=...&sessionId=...
  if (req.method === 'GET' && (url.pathname === '/session-usage' || url.pathname === '//session-usage')) {
    const projectPath = url.searchParams.get('projectPath');
    const sessionId = url.searchParams.get('sessionId');

    if (!projectPath || !sessionId) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Missing projectPath or sessionId' }));
      return;
    }

    try {
      const usage = await getSessionUsage(projectPath, sessionId);
      res.writeHead(200);
      res.end(JSON.stringify(usage));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return;
  }

  // POST /calculate — server-side cost verification
  if (req.method === 'POST' && (url.pathname === '/calculate' || url.pathname === '//calculate')) {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const { inputPrice, outputPrice, cachedInputPrice, inputTokens, outputTokens, cachedInputTokens } = JSON.parse(body);

        const inputCost = (inputTokens / 1_000_000) * inputPrice;
        const outputCost = (outputTokens / 1_000_000) * outputPrice;
        const cachedInputCost = (cachedInputTokens / 1_000_000) * cachedInputPrice;
        const total = inputCost + outputCost + cachedInputCost;

        res.writeHead(200);
        res.end(JSON.stringify({
          inputCost: Math.round(inputCost * 10000) / 10000,
          outputCost: Math.round(outputCost * 10000) / 10000,
          cachedInputCost: Math.round(cachedInputCost * 10000) / 10000,
          total: Math.round(total * 10000) / 10000,
        }));
      } catch (err) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
    });
    return;
  }

  // GET /project-usage?projectPath=... — sum of all sessions in one project
  if (req.method === 'GET' && (url.pathname === '/project-usage' || url.pathname === '//project-usage')) {
    const projectPath = url.searchParams.get('projectPath');
    if (!projectPath) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Missing projectPath' }));
      return;
    }
    try {
      const usage = await getProjectUsage(projectPath);
      res.writeHead(200);
      res.end(JSON.stringify(usage));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return;
  }

  // GET /all-usage — sum of all sessions across all projects
  if (req.method === 'GET' && (url.pathname === '/all-usage' || url.pathname === '//all-usage')) {
    try {
      const usage = await getAllUsage();
      res.writeHead(200);
      res.end(JSON.stringify(usage));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return;
  }

  // GET /daily-usage — token usage aggregated by day across all projects
  if (req.method === 'GET' && (url.pathname === '/daily-usage' || url.pathname === '//daily-usage')) {
    try {
      const usage = await getDailyUsage();
      res.writeHead(200);
      res.end(JSON.stringify(usage));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(0, '127.0.0.1', () => {
  const addr = server.address();
  if (addr && typeof addr !== 'string') {
    console.log(JSON.stringify({ ready: true, port: addr.port }));
  }
});
