// vendor/builtin-plugins/web-terminal/src/server.ts
import path2 from "node:path";
import os2 from "node:os";
import http from "node:http";
import fs2 from "node:fs";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// vendor/builtin-plugins/web-terminal/src/protocol.ts
var PROTOCOL_VERSION = 2;
var MIN_COLS = 1;
var MAX_COLS = 1e3;
var MIN_ROWS = 1;
var MAX_ROWS = 500;
function clampDimension(value, fallback, min, max) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(n, max));
}

// vendor/builtin-plugins/web-terminal/src/shell.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
var POSIX_SHELL_CANDIDATES = [
  "/bin/zsh",
  "/usr/bin/zsh",
  "/bin/bash",
  "/usr/bin/bash",
  "/usr/local/bin/bash",
  "/opt/homebrew/bin/bash",
  "/usr/bin/fish",
  "/usr/local/bin/fish",
  "/opt/homebrew/bin/fish",
  "/bin/sh",
  "/usr/bin/sh"
];
var WINDOWS_SHELL_CANDIDATES = ["pwsh.exe", "powershell.exe", "cmd.exe"];
function isExecutableFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}
function readEtcShells() {
  try {
    return fs.readFileSync("/etc/shells", "utf8").split("\n").map((line) => line.trim()).filter((line) => line.startsWith("/"));
  } catch {
    return [];
  }
}
function passwdShell() {
  try {
    const info = os.userInfo();
    return typeof info.shell === "string" && info.shell.startsWith("/") ? info.shell : null;
  } catch {
    return null;
  }
}
function findWindowsShell(env) {
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path");
  const dirs = (pathKey ? env[pathKey] : void 0)?.split(path.delimiter).filter(Boolean) ?? [];
  for (const candidate of WINDOWS_SHELL_CANDIDATES) {
    for (const dir of dirs) {
      if (isExecutableFile(path.join(dir, candidate))) return candidate;
    }
  }
  return "powershell.exe";
}
function listShells(platform = process.platform, env = process.env) {
  if (platform === "win32") {
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path");
    const dirs = (pathKey ? env[pathKey] : void 0)?.split(path.delimiter).filter(Boolean) ?? [];
    const found = WINDOWS_SHELL_CANDIDATES.filter((candidate) => dirs.some((dir) => isExecutableFile(path.join(dir, candidate))));
    return found.length > 0 ? found : ["powershell.exe"];
  }
  const seen = /* @__PURE__ */ new Set();
  const shells = [];
  const add = (candidate) => {
    if (!candidate || seen.has(candidate)) return;
    if (!isExecutableFile(candidate)) return;
    seen.add(candidate);
    shells.push(candidate);
  };
  add(passwdShell());
  add(env.SHELL);
  for (const candidate of POSIX_SHELL_CANDIDATES) add(candidate);
  for (const candidate of readEtcShells()) add(candidate);
  return shells.length > 0 ? shells : ["/bin/sh"];
}
function resolveShell(requested, platform = process.platform, env = process.env) {
  const available = listShells(platform, env);
  if (requested && available.includes(requested)) return requested;
  if (platform === "win32") return findWindowsShell(env);
  return passwdShell() ?? env.SHELL ?? available[0] ?? "/bin/sh";
}
function defaultLang(platform) {
  if (platform === "win32") return null;
  return platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8";
}
function buildShellEnv(baseEnv, options) {
  const platform = options.platform ?? process.platform;
  const env = { ...baseEnv };
  delete env.NODE_ENV;
  delete env.PLUGIN_NAME;
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  env.TERM_PROGRAM = "cloudcli-terminal";
  if (options.version) env.TERM_PROGRAM_VERSION = options.version;
  env.PWD = options.cwd;
  if (platform !== "win32") {
    env.SHELL = options.shell;
    let username = null;
    let home = null;
    try {
      const info = os.userInfo();
      username = info.username;
      home = info.homedir;
    } catch {
    }
    if (username) {
      if (!env.USER) env.USER = username;
      if (!env.LOGNAME) env.LOGNAME = username;
    }
    if (!env.HOME && home) env.HOME = home;
    const lang = defaultLang(platform);
    if (lang && !env.LANG && !env.LC_ALL && !env.LC_CTYPE) env.LANG = lang;
  }
  return env;
}
function prioritizeUserNpmGlobalBin(env) {
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") || "PATH";
  const currentPath = env[pathKey];
  if (!currentPath) return env;
  const readEnv = (key) => {
    const resolvedKey = Object.keys(env).find((envKey) => envKey.toLowerCase() === key.toLowerCase());
    return resolvedKey ? env[resolvedKey] : void 0;
  };
  const npmPrefix = readEnv("npm_config_prefix");
  const appData = readEnv("APPDATA");
  const candidates = [
    npmPrefix,
    npmPrefix ? path.join(npmPrefix, "bin") : void 0,
    appData ? path.join(appData, "npm") : void 0,
    path.join(os.homedir(), "AppData", "Roaming", "npm"),
    path.join(os.homedir(), ".npm-global", "bin")
  ].filter((entry) => Boolean(entry));
  const pathEntries = currentPath.split(path.delimiter).filter(Boolean);
  const normalize = (entry) => process.platform === "win32" ? entry.toLowerCase() : entry;
  const preferredEntries = candidates.filter((candidate, index) => candidates.findIndex((entry) => normalize(entry) === normalize(candidate)) === index && pathEntries.some((entry) => normalize(entry) === normalize(candidate)));
  if (preferredEntries.length === 0) return env;
  const preferred = new Set(preferredEntries.map(normalize));
  return {
    ...env,
    [pathKey]: [
      ...preferredEntries,
      ...pathEntries.filter((entry) => !preferred.has(normalize(entry)))
    ].join(path.delimiter)
  };
}
function resolveCwd(requested, home) {
  const fallbacks = [home, process.env.HOME, os.homedir(), os.tmpdir()];
  if (typeof requested === "string" && requested.trim()) {
    const candidate = path.resolve(requested.trim());
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
    }
  }
  for (const fallback of fallbacks) {
    if (!fallback) continue;
    try {
      if (fs.statSync(fallback).isDirectory()) return fallback;
    } catch {
    }
  }
  return process.cwd();
}

// vendor/builtin-plugins/web-terminal/src/server.ts
var require2 = createRequire(import.meta.url);
var __dirname = path2.dirname(fileURLToPath(import.meta.url));
var DETACHED_GRACE_MS = 30 * 60 * 1e3;
var REPLAY_BUFFER_BYTES = 256 * 1024;
var MAX_SESSIONS = 32;
var INIT_TIMEOUT_MS = 5e3;
var PLUGIN_VERSION = readPluginVersion();
function findModule(name) {
  const attempts = [];
  const tryRequire = (specifier) => {
    attempts.push(specifier);
    try {
      return require2(specifier);
    } catch {
      return null;
    }
  };
  const direct = tryRequire(name);
  if (direct) return direct;
  const roots = [
    path2.join("/opt", "claudecodeui", "node_modules", name),
    path2.join("/usr", "lib", "node_modules", "claudecodeui", "node_modules", name),
    path2.join("/usr", "local", "lib", "node_modules", "claudecodeui", "node_modules", name),
    path2.join("/workspace", "claudecodeui", "node_modules", name),
    path2.join("/app", "node_modules", name),
    path2.join(os2.homedir(), "claudecodeui", "node_modules", name)
  ];
  for (const candidate of roots) {
    if (!fs2.existsSync(candidate)) continue;
    const loaded = tryRequire(candidate);
    if (loaded) return loaded;
  }
  for (const start of [__dirname, process.cwd()]) {
    let dir = start;
    for (let depth = 0; depth < 12; depth++) {
      const candidate = path2.join(dir, "node_modules", name);
      if (fs2.existsSync(candidate)) {
        const loaded = tryRequire(candidate);
        if (loaded) return loaded;
      }
      const parent = path2.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  throw new Error(
    `[web-terminal] Cannot load '${name}'.
  Tried: ${attempts.join(", ")}
  Fix: run "npm install && npm rebuild ${name}" in ${path2.dirname(__dirname)}`
  );
}
function readPluginVersion() {
  try {
    const manifest = JSON.parse(fs2.readFileSync(path2.join(__dirname, "..", "manifest.json"), "utf8"));
    return typeof manifest.version === "string" ? manifest.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}
var pty = findModule("node-pty");
var { WebSocketServer, WebSocket } = findModule("ws");
var ReplayBuffer = class {
  constructor() {
    this.chunks = [];
    this.bytes = 0;
    /** Total bytes ever produced by this PTY, not just those still retained. */
    this.seq = 0;
  }
  push(chunk) {
    this.seq += chunk.length;
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    while (this.bytes > REPLAY_BUFFER_BYTES && this.chunks.length > 1) {
      this.bytes -= this.chunks.shift().length;
    }
  }
  /** The earliest byte offset still retained. */
  get oldestSeq() {
    return this.seq - this.bytes;
  }
  /** Everything retained, oldest first. */
  all() {
    return Buffer.concat(this.chunks);
  }
  /** Bytes produced since `fromSeq`, or null when that far back is gone. */
  since(fromSeq) {
    if (fromSeq > this.seq || fromSeq < this.oldestSeq) return null;
    const skip = fromSeq - this.oldestSeq;
    return this.all().subarray(skip);
  }
};
var sessions = /* @__PURE__ */ new Map();
function sendControl(ws, message) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(message));
    } catch {
    }
  }
}
function sendData(ws, chunk, done) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    done();
    return;
  }
  try {
    ws.send(chunk, () => done());
  } catch {
    done();
  }
}
function detachSession(session) {
  session.ws = null;
  if (session.reapTimer) clearTimeout(session.reapTimer);
  session.reapTimer = setTimeout(() => killSession(session.id), DETACHED_GRACE_MS);
  session.reapTimer.unref?.();
  try {
    session.pty.resume();
  } catch {
  }
}
function killSession(id) {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  if (session.reapTimer) clearTimeout(session.reapTimer);
  session.dispose();
  try {
    session.pty.kill();
  } catch {
  }
  try {
    session.ws?.close(1e3, "session closed");
  } catch {
  }
}
function createSession(options) {
  const id = crypto.randomUUID();
  const env = buildShellEnv(prioritizeUserNpmGlobalBin(process.env), {
    shell: options.shell,
    cwd: options.cwd,
    version: PLUGIN_VERSION
  });
  const ptyProc = pty.spawn(options.shell, [], {
    name: "xterm-256color",
    cols: options.cols,
    rows: options.rows,
    cwd: options.cwd,
    env,
    // 'utf8' rather than null: node-pty only enables the IUTF8 termios flag
    // when the encoding is exactly 'utf8'. Without it the tty line discipline
    // treats a multi-byte character as separate bytes, so backspacing over
    // "é" or an emoji at a shell prompt leaves mojibake behind. It also gives
    // us Node's StringDecoder, which stitches characters split across reads.
    encoding: "utf8"
  });
  const session = {
    id,
    pty: ptyProc,
    ws: null,
    shell: options.shell,
    cwd: options.cwd,
    cols: options.cols,
    rows: options.rows,
    replay: new ReplayBuffer(),
    reapTimer: null,
    exited: false,
    dispose: () => {
    }
  };
  const dataSub = ptyProc.onData((text) => {
    if (!text) return;
    const chunk = Buffer.from(text, "utf8");
    session.replay.push(chunk);
    if (!session.ws) return;
    session.pty.pause();
    sendData(session.ws, chunk, () => {
      try {
        session.pty.resume();
      } catch {
      }
    });
  });
  const exitSub = ptyProc.onExit(({ exitCode, signal }) => {
    session.exited = true;
    sendControl(session.ws, { type: "exit", sessionId: id, exitCode, signal });
    const ws = session.ws;
    sessions.delete(id);
    if (session.reapTimer) clearTimeout(session.reapTimer);
    session.dispose();
    if (ws && ws.readyState === WebSocket.OPEN) ws.close(1e3, "shell exited");
  });
  session.dispose = () => {
    try {
      dataSub.dispose();
    } catch {
    }
    try {
      exitSub.dispose();
    } catch {
    }
  };
  sessions.set(id, session);
  return session;
}
function attachSession(session, ws) {
  if (session.ws && session.ws !== ws) {
    try {
      session.ws.close(4409, "session claimed elsewhere");
    } catch {
    }
  }
  if (session.reapTimer) {
    clearTimeout(session.reapTimer);
    session.reapTimer = null;
  }
  session.ws = ws;
}
function isTrustedLocalRequest(req) {
  if (req.headers.origin) return false;
  const host = (req.headers.host || "").split(":")[0].toLowerCase();
  return host === "" || host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
}
var server = http.createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  if (!isTrustedLocalRequest(req)) {
    res.writeHead(403);
    res.end(JSON.stringify({ error: "Forbidden" }));
    return;
  }
  const url = (req.url || "/").split("?")[0];
  if (req.method === "GET" && (url === "/" || url === "/info")) {
    res.end(JSON.stringify({
      name: "web-terminal",
      version: PLUGIN_VERSION,
      protocol: PROTOCOL_VERSION,
      platform: process.platform,
      sessions: sessions.size,
      maxSessions: MAX_SESSIONS,
      defaultShell: resolveShell(),
      shells: listShells(),
      home: os2.homedir()
    }));
    return;
  }
  if (req.method === "GET" && url === "/health") {
    res.end(JSON.stringify({ ok: true, sessions: sessions.size }));
    return;
  }
  res.writeHead(404);
  res.end(JSON.stringify({ error: "Not found" }));
});
server.on("clientError", (_err, socket) => {
  if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});
var wss = new WebSocketServer({
  server,
  path: "/ws",
  // ~4 MiB: comfortably larger than any paste, small enough to bound memory.
  maxPayload: 4 * 1024 * 1024,
  verifyClient: (info) => isTrustedLocalRequest(info.req)
});
wss.on("connection", (ws) => {
  let session = null;
  let initialised = false;
  const fail = (message) => {
    sendControl(ws, { type: "error", message });
    try {
      ws.close(1011, "terminal error");
    } catch {
    }
  };
  const start = (msg = {}) => {
    if (initialised) return;
    initialised = true;
    clearTimeout(initTimer);
    const cols = clampDimension(msg.cols, 80, MIN_COLS, MAX_COLS);
    const rows = clampDimension(msg.rows, 24, MIN_ROWS, MAX_ROWS);
    const wanted = typeof msg.sessionId === "string" ? sessions.get(msg.sessionId) : void 0;
    if (wanted && !wanted.exited) {
      session = wanted;
      attachSession(session, ws);
      try {
        session.pty.resize(cols, rows);
        session.cols = cols;
        session.rows = rows;
      } catch {
      }
      const clientSeq = typeof msg.seq === "number" ? msg.seq : 0;
      const missed = session.replay.since(clientSeq);
      const reset = missed === null;
      const payload = reset ? session.replay.all() : missed;
      sendControl(ws, {
        type: "ready",
        sessionId: session.id,
        shell: session.shell,
        cwd: session.cwd,
        resumed: true,
        reset,
        // Offset of the first byte in the replay that follows, so the client
        // can keep counting from here without double-counting the replay.
        seq: reset ? session.replay.oldestSeq : clientSeq
      });
      if (payload.length > 0) sendData(ws, payload, () => {
      });
      return;
    }
    if (sessions.size >= MAX_SESSIONS) {
      fail(`Too many terminal sessions open (limit ${MAX_SESSIONS}). Close a tab and try again.`);
      return;
    }
    const shell = resolveShell(typeof msg.shell === "string" ? msg.shell : null);
    const cwd = resolveCwd(typeof msg.cwd === "string" ? msg.cwd : null);
    try {
      session = createSession({ shell, cwd, cols, rows });
    } catch (err) {
      fail(`Failed to start ${shell}: ${err.message}`);
      return;
    }
    attachSession(session, ws);
    sendControl(ws, {
      type: "ready",
      sessionId: session.id,
      shell,
      cwd,
      resumed: false,
      reset: false,
      seq: 0
    });
  };
  const initTimer = setTimeout(() => start(), INIT_TIMEOUT_MS);
  initTimer.unref?.();
  sendControl(ws, {
    type: "hello",
    protocol: PROTOCOL_VERSION,
    platform: process.platform,
    shells: listShells(),
    defaultShell: resolveShell(),
    home: os2.homedir()
  });
  ws.on("message", (raw, isBinary) => {
    if (isBinary) {
      if (!session || session.exited) return;
      try {
        session.pty.write(Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), "utf8"));
      } catch {
      }
      return;
    }
    let msg;
    try {
      msg = JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw));
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== "string") return;
    if (msg.type === "init") {
      start(msg);
      return;
    }
    if (msg.type === "ping") {
      sendControl(ws, { type: "pong" });
      return;
    }
    if (msg.type === "close") {
      if (session) killSession(session.id);
      return;
    }
    if (msg.type === "resize") {
      if (!session || session.exited) return;
      const cols = clampDimension(msg.cols, session.cols, MIN_COLS, MAX_COLS);
      const rows = clampDimension(msg.rows, session.rows, MIN_ROWS, MAX_ROWS);
      if (cols === session.cols && rows === session.rows) return;
      session.cols = cols;
      session.rows = rows;
      try {
        session.pty.resize(cols, rows);
      } catch {
      }
    }
  });
  ws.on("close", () => {
    clearTimeout(initTimer);
    if (session && sessions.get(session.id) === session && session.ws === ws) {
      detachSession(session);
    }
  });
  ws.on("error", (err) => {
    console.error("[web-terminal] socket error:", err.message);
  });
});
server.on("error", (err) => {
  console.error("[web-terminal] server error:", err.message);
  process.exit(1);
});
server.listen(0, "127.0.0.1", () => {
  const addr = server.address();
  if (addr && typeof addr !== "string") {
    process.stdout.write(JSON.stringify({ ready: true, port: addr.port }) + "\n");
  }
});
var shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const id of [...sessions.keys()]) killSession(id);
  for (const client of wss.clients) {
    try {
      client.terminate();
    } catch {
    }
  }
  wss.close(() => server.close(() => process.exit(code)));
  setTimeout(() => process.exit(code), 3e3).unref();
}
process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));
process.on("SIGHUP", () => shutdown(0));
var initialParentPid = process.ppid;
if (initialParentPid > 1) {
  const watchdog = setInterval(() => {
    let parentAlive = true;
    try {
      process.kill(initialParentPid, 0);
    } catch {
      parentAlive = false;
    }
    if (!parentAlive || process.ppid !== initialParentPid) {
      console.error("[web-terminal] host process exited; shutting down");
      shutdown(0);
    }
  }, 5e3);
  watchdog.unref();
}
process.on("uncaughtException", (err) => {
  console.error("[web-terminal] uncaught exception:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[web-terminal] unhandled rejection:", reason);
});
process.stdout.on("error", () => {
});
