import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import os from 'node:os';
import { createGzip } from 'node:zlib';
import { pipeline as pipelineAsync } from 'node:stream/promises';

// ── Config ────────────────────────────────────────────────────────────
// Which user home directories to scan for Claude session data.
// Override via SESSION_MANAGER_HOMES env var (comma-separated).
// Defaults to the current user's home directory.

const DEFAULT_HOMES = [os.homedir()];

const SCAN_HOMES = process.env.SESSION_MANAGER_HOMES
  ? process.env.SESSION_MANAGER_HOMES.split(',').map(h => h.trim()).filter(Boolean)
  : DEFAULT_HOMES;

// Which OS user to run resumed sessions as.
// Override via SESSION_MANAGER_USER env var.
const DEFAULT_USER = process.env.SESSION_MANAGER_USER || os.userInfo().username;

// ── Helpers ────────────────────────────────────────────────────────────

function readFile(p) {
  try { return fs.readFileSync(p, 'utf8').trim(); } catch { return null; }
}

function readJsonFile(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/** Return all pids that are running the `claude` CLI */
function findClaudePids() {
  const pids = [];
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const cmdline = readFile(`/proc/${entry}/cmdline`);
    if (!cmdline) continue;
    const parts = cmdline.split('\0').filter(Boolean);
    const isClaude = parts.some(p =>
      p.endsWith('/claude') || p === 'claude'
    ) && !parts.some(p =>
      p.includes('cloudcli') || p.includes('clauditor') || p.includes('claude-code-ui')
    );
    if (isClaude) pids.push(parseInt(entry, 10));
  }
  return pids;
}

/** Get process info from /proc */
function getProcInfo(pid) {
  const base = `/proc/${pid}`;
  if (!fs.existsSync(base)) return null;

  const cmdline = readFile(`${base}/cmdline`);
  const parts = cmdline ? cmdline.split('\0').filter(Boolean) : [];

  let cwd = null;
  try { cwd = fs.readlinkSync(`${base}/cwd`); } catch {}

  let user = 'unknown';
  try {
    const status = readFile(`${base}/status`) || '';
    const uidLine = status.split('\n').find(l => l.startsWith('Uid:'));
    if (uidLine) {
      const uid = parseInt(uidLine.split(/\s+/)[1], 10);
      user = uid === 0 ? 'root' : execFileSync('id', ['-un', String(uid)], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    }
  } catch {}

  let elapsedSec = 0;
  try {
    const stat = readFile(`${base}/stat`) || '';
    const fields = stat.split(' ');
    const startTicks = parseInt(fields[21], 10);
    const clkTck = 100;
    const uptimeSec = parseFloat(readFile('/proc/uptime').split(' ')[0]);
    elapsedSec = Math.floor(uptimeSec - startTicks / clkTck);
  } catch {}

  const wchan = readFile(`${base}/wchan`) || '';

  let resumeId = null;
  const rIdx = parts.indexOf('--resume');
  if (rIdx !== -1 && parts[rIdx + 1]) resumeId = parts[rIdx + 1];

  return { pid, cwd, user, elapsedSec, wchan, resumeId };
}

/**
 * Load all session JSON files keyed by PID.
 * Scans all configured home directories.
 */
function loadSessionsByPid() {
  const byPid = {};
  for (const home of SCAN_HOMES) {
    const sessionsDir = path.join(home, '.claude', 'sessions');
    try {
      for (const f of fs.readdirSync(sessionsDir)) {
        if (!f.endsWith('.json')) continue;
        const d = readJsonFile(path.join(sessionsDir, f));
        if (!d) continue;
        const pid = d.pid || parseInt(f, 10);
        if (!isNaN(pid)) {
          byPid[String(pid)] = {
            sessionId: d.sessionId || null,
            cwd: d.cwd || null,
            startedAt: d.startedAt || null,
            homeDir: home,
            filePath: path.join(sessionsDir, f),
          };
        }
      }
    } catch {}
  }
  return byPid;
}

/** Convert a cwd path to the Claude project directory name convention */
function cwdToProjectDir(cwd) {
  return (cwd || '').replace(/\//g, '-');
}

/** Find the .jsonl log file for a given sessionId + cwd */
function findJsonlPath(sessionId, cwd, preferredHome) {
  if (!sessionId || !cwd) return null;
  const projectDir = cwdToProjectDir(cwd);
  const homes = [preferredHome, ...SCAN_HOMES].filter(Boolean);
  const seen = new Set();
  for (const home of homes) {
    if (seen.has(home)) continue;
    seen.add(home);
    const candidate = path.join(home, '.claude', 'projects', projectDir, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Parse a .jsonl file and extract context (last prompt, away summary, last assistant text) */
function extractContext(jsonlPath) {
  let lastPrompt = null;
  let awaySummary = null;
  let lastAssistant = null;

  try {
    const lines = fs.readFileSync(jsonlPath, 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'last-prompt' && entry.lastPrompt) {
          lastPrompt = entry.lastPrompt;
        } else if (entry.type === 'system' && entry.subtype === 'away_summary' && entry.content) {
          awaySummary = entry.content;
        } else if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
          const textBlock = entry.message.content.find(b => b.type === 'text' && b.text);
          if (textBlock) lastAssistant = textBlock.text.slice(0, 800);
        }
      } catch {}
    }
  } catch {}

  return { lastPrompt, awaySummary, lastAssistant };
}

function formatElapsed(sec) {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec/60)}m ${sec%60}s`;
  const h = Math.floor(sec/3600);
  const m = Math.floor((sec%3600)/60);
  return `${h}h ${m}m`;
}

// ── Route handlers ─────────────────────────────────────────────────────

function handleListSessions(res) {
  const sessions = loadSessionsByPid();
  const pids = findClaudePids();
  const result = [];
  const nowMs = Date.now();

  for (const pid of pids) {
    const info = getProcInfo(pid);
    if (!info) continue;

    const sessionInfo = sessions[String(pid)] || null;

    // Three-state status: active / idle / stuck
    // active — wchan !== ep_poll (Claude is processing, tool running, etc.)
    // idle   — ep_poll but JSONL written within last 30 min
    // stuck  — ep_poll and JSONL untouched for 30+ min
    let status = 'active';
    if (info.wchan === 'ep_poll') {
      const sid = sessionInfo?.sessionId;
      const cwd = info.cwd || sessionInfo?.cwd;
      const home = sessionInfo?.homeDir;
      let jsonlIdleSec = info.elapsedSec;
      if (sid && cwd) {
        const jsonlPath = findJsonlPath(sid, cwd, home);
        if (jsonlPath) {
          try {
            const mtimeMs = fs.statSync(jsonlPath).mtimeMs;
            jsonlIdleSec = Math.floor((nowMs - mtimeMs) / 1000);
          } catch {}
        }
      }
      status = jsonlIdleSec < 1800 ? 'idle' : 'stuck';
    }

    result.push({
      pid: info.pid,
      user: info.user,
      cwd: info.cwd || sessionInfo?.cwd || 'unknown',
      project: info.cwd ? path.basename(info.cwd) : 'unknown',
      elapsed: formatElapsed(info.elapsedSec),
      elapsedSec: info.elapsedSec,
      wchan: info.wchan,
      status,
      sessionId: sessionInfo?.sessionId || info.resumeId || null,
    });
  }

  result.sort((a, b) => b.elapsedSec - a.elapsedSec);
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(result));
}

function handleContext(pid, res) {
  const sessions = loadSessionsByPid();
  const sessionInfo = sessions[String(pid)];

  if (!sessionInfo?.sessionId) {
    res.writeHead(404);
    res.end(JSON.stringify({ ok: false, error: 'No session record found for this PID' }));
    return;
  }

  const { sessionId, cwd, homeDir } = sessionInfo;
  const jsonlPath = findJsonlPath(sessionId, cwd, homeDir);

  if (!jsonlPath) {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, sessionId, lastPrompt: null, awaySummary: null, lastAssistant: null }));
    return;
  }

  const context = extractContext(jsonlPath);
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ ok: true, sessionId, ...context }));
}

function handleKill(pid, res) {
  // Verify the PID belongs to a known Claude process before signaling
  const claudePids = findClaudePids();
  if (!claudePids.includes(pid)) {
    res.writeHead(403);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: false, error: 'PID is not a managed Claude session' }));
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
    setTimeout(() => {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }, 2000);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, pid }));
  } catch (err) {
    res.writeHead(400);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: false, error: err.message }));
  }
}

function handleResume(body, res) {
  const { sessionId, cwd } = body || {};
  if (!sessionId || !cwd) {
    res.writeHead(400);
    res.end(JSON.stringify({ ok: false, error: 'sessionId and cwd required' }));
    return;
  }

  // Validate sessionId — must be UUID-like (hex + dashes)
  if (!/^[0-9a-f-]{8,64}$/i.test(sessionId)) {
    res.writeHead(400);
    res.end(JSON.stringify({ ok: false, error: 'Invalid sessionId format' }));
    return;
  }

  // Validate cwd — must be an absolute path, no shell metacharacters
  if (!/^\/[^\0;&|`$<>'"\\!]+$/.test(cwd)) {
    res.writeHead(400);
    res.end(JSON.stringify({ ok: false, error: 'Invalid cwd path' }));
    return;
  }

  // Always use the configured default user — never trust client-supplied user
  const runAs = DEFAULT_USER;

  try {
    const child = spawn('su', ['-', runAs, '-c',
      `cd '${cwd.replace(/'/g, "'\\''")}' && claude --resume '${sessionId}'`
    ], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, sessionId, pid: child.pid }));
  } catch (err) {
    res.writeHead(500);
    res.end(JSON.stringify({ ok: false, error: err.message }));
  }
}

async function handleCleanup(res) {
  const results = { deletedSessions: 0, compressedLogs: 0, errors: [] };
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

  for (const home of SCAN_HOMES) {
    // 1. Delete session JSON files for dead PIDs
    const sessionsDir = path.join(home, '.claude', 'sessions');
    try {
      for (const f of fs.readdirSync(sessionsDir)) {
        if (!f.endsWith('.json')) continue;
        const pid = parseInt(f, 10);
        if (!isNaN(pid) && !fs.existsSync(`/proc/${pid}`)) {
          try {
            fs.unlinkSync(path.join(sessionsDir, f));
            results.deletedSessions++;
          } catch (e) {
            results.errors.push(`Delete session ${f}: ${e.message}`);
          }
        }
      }
    } catch {}

    // 2. Compress .jsonl logs older than 30 days
    const projectsDir = path.join(home, '.claude', 'projects');
    try {
      for (const proj of fs.readdirSync(projectsDir)) {
        const projPath = path.join(projectsDir, proj);
        let isDir = false;
        try { isDir = fs.statSync(projPath).isDirectory(); } catch {}
        if (!isDir) continue;

        let files = [];
        try { files = fs.readdirSync(projPath); } catch {}

        for (const f of files) {
          if (!f.endsWith('.jsonl')) continue;
          const filePath = path.join(projPath, f);
          try {
            const stat = fs.statSync(filePath);
            if (stat.mtimeMs < thirtyDaysAgo) {
              const gzPath = filePath + '.gz';
              await pipelineAsync(
                fs.createReadStream(filePath),
                createGzip(),
                fs.createWriteStream(gzPath)
              );
              fs.unlinkSync(filePath);
              results.compressedLogs++;
            }
          } catch (e) {
            results.errors.push(`Compress ${f}: ${e.message}`);
          }
        }
      }
    } catch {}
  }

  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ ok: true, ...results }));
}

// ── HTTP server ────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && req.url === '/sessions') {
    handleListSessions(res);
    return;
  }

  const contextMatch = req.url?.match(/^\/sessions\/(\d+)\/context$/);
  if (req.method === 'GET' && contextMatch) {
    handleContext(parseInt(contextMatch[1], 10), res);
    return;
  }

  const killMatch = req.url?.match(/^\/sessions\/(\d+)\/kill$/);
  if (req.method === 'POST' && killMatch) {
    handleKill(parseInt(killMatch[1], 10), res);
    return;
  }

  if (req.method === 'POST' && req.url === '/sessions/resume') {
    let body = '';
    const MAX_BODY = 4096;
    let aborted = false;
    req.on('data', d => {
      body += d;
      if (body.length > MAX_BODY) {
        aborted = true;
        res.writeHead(413);
        res.end(JSON.stringify({ ok: false, error: 'Request too large' }));
        req.socket.destroy();
      }
    });
    req.on('end', () => {
      if (aborted) return;
      try { handleResume(JSON.parse(body), res); }
      catch { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'bad json' })); }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/sessions/cleanup') {
    handleCleanup(res).catch(err => {
      if (!res.writableEnded) {
        res.writeHead(500);
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
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
