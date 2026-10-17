// vendor/builtin-plugins/prism/src/server.ts
import http from "node:http";
import path from "node:path";
import os from "node:os";
import spawn from "cross-spawn";

// vendor/builtin-plugins/prism/src/lib.ts
function buildAnalyzeArgs(projectPath) {
  const args = ["analyze", "--json"];
  if (projectPath) {
    args.push("--project", projectPath);
  }
  return args;
}
function parseVersion(stdout) {
  const match = stdout.match(/prism\s+v(\S+)/);
  return match ? match[1] : null;
}
function parseReports(stdout) {
  const start = stdout.indexOf("[");
  const end = stdout.lastIndexOf("]");
  if (start === -1 || end <= start) {
    throw new Error("prism returned no JSON report");
  }
  const parsed = JSON.parse(stdout.slice(start, end + 1));
  if (!Array.isArray(parsed)) {
    throw new Error("prism returned unexpected JSON");
  }
  return parsed;
}

// vendor/builtin-plugins/prism/src/server.ts
var PRISM_BIN = process.env.PRISM_BIN || "prism";
var PRISM_TIMEOUT_MS = 12e4;
var MAX_BUFFER = 16 * 1024 * 1024;
function buildPrismEnv() {
  const env = {
    ...process.env,
    // prism renders through a rich console; force plain, unwrapped output so
    // the piped JSON survives intact.
    NO_COLOR: "1",
    TERM: "dumb",
    COLUMNS: "4096"
  };
  if (process.platform === "win32") {
    const home = process.env.USERPROFILE || os.homedir();
    if (home) {
      env.USERPROFILE ??= home;
      env.APPDATA ??= path.join(home, "AppData", "Roaming");
      env.LOCALAPPDATA ??= path.join(home, "AppData", "Local");
      env.TEMP ??= path.join(home, "AppData", "Local", "Temp");
      env.TMP ??= env.TEMP;
    }
    env.SystemRoot ??= process.env.windir || "C:\\Windows";
    env.windir ??= env.SystemRoot;
    env.PATHEXT ??= ".COM;.EXE;.BAT;.CMD";
  }
  return env;
}
function runPrism(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(PRISM_BIN, args, {
      windowsHide: true,
      // The host strips Windows-essential vars from the plugin subprocess env;
      // restore them so a `pip install --user` prism can import its package.
      env: buildPrismEnv()
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;
    let killTimer;
    const settle = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const terminate = () => {
      if (killTimer) return;
      child.kill();
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5e3);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, PRISM_TIMEOUT_MS);
    child.stdout?.on("data", (chunk) => {
      if (settled) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_BUFFER) {
        terminate();
        settle(() => reject(new Error("prism output exceeded buffer limit")));
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      if (settled) return;
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_BUFFER) {
        terminate();
        settle(() => reject(new Error("prism output exceeded buffer limit")));
        return;
      }
      stderrChunks.push(chunk);
    });
    child.on("error", (err) => {
      settle(() => {
        if (err.code === "ENOENT") {
          const e = new Error(
            "prism is not installed or not on PATH (pip install prism-cc)"
          );
          e.notInstalled = true;
          reject(e);
        } else {
          reject(err);
        }
      });
    });
    child.on("close", (code) => {
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = void 0;
      }
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      settle(() => {
        if (timedOut) {
          reject(new Error(`prism timed out after ${PRISM_TIMEOUT_MS}ms`));
        } else if (code !== 0) {
          reject(new Error((stderr || `prism exited with code ${code}`).trim()));
        } else {
          resolve(stdout);
        }
      });
    });
  });
}
async function handleHealth() {
  try {
    const stdout = await runPrism(["--version"]);
    return { installed: true, version: parseVersion(stdout) };
  } catch (err) {
    if (err.notInstalled) {
      return { installed: false, version: null };
    }
    throw err;
  }
}
async function handleReport(projectPath) {
  if (projectPath !== null && (!path.isAbsolute(projectPath) || projectPath.includes(".."))) {
    return { reports: [] };
  }
  try {
    const stdout = await runPrism(buildAnalyzeArgs(projectPath ?? void 0));
    return { reports: parseReports(stdout) };
  } catch (err) {
    if (err.notInstalled) {
      throw err;
    }
    const scope = projectPath === null ? "overview" : `project ${projectPath}`;
    console.error(`[prism] no report for ${scope}: ${err.message}`);
    return { reports: [] };
  }
}
var server = http.createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  const respond = (promise) => {
    promise.then((payload) => {
      res.end(JSON.stringify(payload));
    }).catch((err) => {
      res.writeHead(err.notInstalled ? 503 : 400);
      res.end(JSON.stringify({ error: err.message, notInstalled: !!err.notInstalled }));
    });
  };
  if (req.method === "GET" && req.url?.startsWith("/health")) {
    respond(handleHealth());
    return;
  }
  if (req.method === "GET" && req.url?.startsWith("/report")) {
    const { searchParams } = new URL(req.url, "http://localhost");
    respond(handleReport(searchParams.get("path")));
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
