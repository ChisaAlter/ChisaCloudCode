import { createHash } from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseCredentials, normalizeUsage, LiveData } from './live.js';
import { parseTranscriptLine, projectLabel, aggregate, SessionEntries, UsageEntry } from './history.js';

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
// Only authentication is shared; history continues to use this instance's CLAUDE_DIR.
const secureStorage = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
const CREDENTIAL_DIR = secureStorage !== undefined
  ? secureStorage || path.join(os.homedir(), '.claude')
  : CLAUDE_DIR;
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const LIVE_CACHE_MS = 30_000;

// ── /live ──────────────────────────────────────────────────────────────

const liveCache = new Map<string, { at: number; fingerprint: string; data: LiveData }>();

function readLiveCredentials(credentialDir: string) {
  let contents: string;
  let credsJson: unknown;
  try {
    contents = fs.readFileSync(path.join(credentialDir, '.credentials.json'), 'utf-8');
    credsJson = JSON.parse(contents);
  } catch {
    liveCache.delete(credentialDir);
    throw Object.assign(new Error('No Claude Code credentials found — sign in with the claude CLI first.'), { status: 404 });
  }
  const creds = parseCredentials(credsJson, Date.now());
  if (!creds) {
    liveCache.delete(credentialDir);
    throw Object.assign(new Error('Unrecognized credentials file format.'), { status: 500 });
  }
  if (creds.expired) {
    liveCache.delete(credentialDir);
    throw Object.assign(new Error('OAuth token expired — run claude to refresh it, then retry.'), { status: 401 });
  }
  // Hash the entire credential payload so token, identity and plan changes invalidate old figures.
  // Only this digest is cached; raw credentials live solely in the current read/request stack.
  return { creds, fingerprint: createHash('sha256').update(contents!).digest('hex') };
}

async function getLive(credentialDir: string): Promise<LiveData> {
  const { creds, fingerprint } = readLiveCredentials(credentialDir);
  const cached = liveCache.get(credentialDir);
  if (cached?.fingerprint === fingerprint && Date.now() - cached.at < LIVE_CACHE_MS) return cached.data;
  if (cached && cached.fingerprint !== fingerprint) liveCache.delete(credentialDir);

  const res = await fetch(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${creds.accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw Object.assign(new Error(`Usage endpoint returned HTTP ${res.status}.`), { status: res.status === 429 ? 429 : 502 });
  }
  const data = normalizeUsage(await res.json(), creds.plan, creds.tier);
  let unchanged = false;
  try { unchanged = readLiveCredentials(credentialDir).fingerprint === fingerprint; }
  catch { /* Removed, malformed or expired credentials also invalidate the pending result. */ }
  if (!unchanged) {
    liveCache.delete(credentialDir);
    throw Object.assign(new Error('Claude account changed during the usage request — refresh to read the current account.'), { status: 409 });
  }
  if (liveCache.size >= 128) liveCache.delete(liveCache.keys().next().value!);
  liveCache.set(credentialDir, { at: Date.now(), fingerprint, data });
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

function getHistory(days: number, configDir: string) {
  const projectsDir = path.join(configDir, 'projects');
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

function requestScope(req: http.IncomingMessage, header: string, fallback: string): string {
  const value = req.headers[header];
  if (typeof value === 'string') {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    if (path.isAbsolute(decoded) && !decoded.includes('\0')) return decoded;
  }
  // The shipped host must provide a scope on every request. Standalone upstream
  // use keeps its environment fallback, but a host upgrade may never leak it.
  if (process.env.PLUGIN_NAME === 'claude-usage') throw Object.assign(new Error('Authenticated usage scope is required.'), { status: 403 });
  return fallback;
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/live') {
      res.end(JSON.stringify(await getLive(requestScope(req, 'x-chisa-claude-auth-dir', CREDENTIAL_DIR))));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/history') {
      const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 30, 1), 365);
      res.end(JSON.stringify(getHistory(days, requestScope(req, 'x-chisa-claude-config-dir', CLAUDE_DIR))));
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
