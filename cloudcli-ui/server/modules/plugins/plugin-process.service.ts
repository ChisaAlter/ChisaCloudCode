import path from 'node:path';
import type { ChildProcess } from 'node:child_process';

// cross-spawn: drop-in spawn with Windows .cmd/PATHEXT resolution.
import spawn from 'cross-spawn';

import { scanPlugins, getPluginDir } from './plugin-registry.service.js';

type PluginProcessEntry = {
  process: ChildProcess;
  port: number | null;
  ended: boolean;
  stopping: boolean;
  exited: Promise<void>;
  stopPromise: Promise<void> | null;
  cancelStartup: (reason: Error) => void;
};

// Starting and unconfirmed stopping children also reserve their plugin name.
const pluginProcesses = new Map<string, PluginProcessEntry>();
const startingPlugins = new Map<string, Promise<number>>();

/**
 * Build the environment handed to a plugin server subprocess.
 *
 * Intentionally minimal: only non-secret essentials, never the host's full
 * environment. On Windows a handful of system variables are required for any
 * child to bootstrap (Node itself, and any Python or CLI a plugin shells out
 * to). Without APPDATA a `pip install --user` tool cannot locate its
 * site-packages and fails to import; SystemRoot, PATHEXT and TEMP are needed to
 * resolve system DLLs, executable extensions and a temp directory. None of
 * these carry secrets, so the ones that are set get passed straight through.
 */
function buildPluginEnv(name: string, pluginDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: process.env.NODE_ENV || 'production',
    PLUGIN_NAME: name,
  };

  // The bundled usage reader needs the credential-store location, not host secrets.
  const usagePlugin = name === 'claude-usage'
    ? scanPlugins().find((plugin) => plugin.name === name && plugin.bundled)
    : undefined;
  if (usagePlugin && getPluginDir(name) === pluginDir) {
    for (const key of ['CLAUDE_SECURESTORAGE_CONFIG_DIR', 'CLAUDE_CONFIG_DIR']) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
  }

  if (process.platform === 'win32') {
    const WINDOWS_ESSENTIALS = [
      'SystemRoot', 'windir', 'SystemDrive',
      'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
      'TEMP', 'TMP', 'PATHEXT',
    ];
    for (const key of WINDOWS_ESSENTIALS) {
      if (process.env[key] !== undefined) {
        env[key] = process.env[key];
      }
    }
  }

  return env;
}

/**
 * Plugins service and the startup loader start a plugin's server subprocess.
 * The plugin's server entry must print a JSON line with { ready: true, port: <number> }
 * to stdout within 10 seconds.
 */
export function startPluginServer(name: string, pluginDir: string, serverEntry: unknown): Promise<number> {
  const previous = pluginProcesses.get(name);
  if (previous && !previous.ended && previous.stopping) {
    return Promise.reject(new Error('Plugin server shutdown is not confirmed; stop it again before restarting'));
  }
  // Coalesce concurrent starts for the same plugin
  const pendingStart = startingPlugins.get(name);
  if (pendingStart) return pendingStart;
  if (previous && !previous.ended) {
    if (previous.port !== null) return Promise.resolve(previous.port);
  }
  if (typeof serverEntry !== 'string') return Promise.reject(new Error('Plugin server entry is invalid'));

  const startPromise = new Promise<number>((resolve, reject) => {

    const serverPath = path.join(pluginDir, serverEntry);

    const pluginProcess = spawn(process.execPath, [serverPath], {
      cwd: pluginDir,
      env: buildPluginEnv(name, pluginDir),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settled = false;
    let stdout = '';
    let confirmExit!: () => void;
    const entry: PluginProcessEntry = {
      process: pluginProcess, port: null, ended: false, stopping: false,
      exited: new Promise<void>((done) => { confirmExit = done; }),
      stopPromise: null, cancelStartup: () => {},
    };
    pluginProcesses.set(name, entry);

    const failStartup = (reason: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      // A readiness failure does not release the name while its child can
      // still run. Failed termination retains the entry for an explicit retry.
      void terminatePlugin(entry).then(() => reject(reason), (error: unknown) => {
        reject(new Error(`${reason.message}; ${error instanceof Error ? error.message : String(error)}`));
      });
    };
    entry.cancelStartup = failStartup;

    const timeout = setTimeout(() => {
      failStartup(new Error('Plugin server did not report ready within 10 seconds'));
    }, 10000);

    pluginProcess.stdout?.on('data', (data: Buffer) => {
      if (settled) return;
      stdout += data.toString();

      // Look for the JSON ready line
      let newline: number;
      while ((newline = stdout.indexOf('\n')) !== -1) {
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        try {
          const msg = JSON.parse(line.trim());
          if (msg.ready && typeof msg.port === 'number') {
            clearTimeout(timeout);
            settled = true;
            entry.port = msg.port;
            console.log(`[Plugins] Server started for "${name}" on port ${msg.port}`);
            resolve(msg.port);
            break;
          }
        } catch {
          // Not JSON yet, keep buffering
        }
      }
    });

    pluginProcess.stderr?.on('data', (data: Buffer) => {
      console.warn(`[Plugin:${name}] ${data.toString().trim()}`);
    });

    pluginProcess.on('error', (error: Error) => {
      failStartup(new Error(`Failed to start plugin server: ${error.message}`));
    });

    const exited = (code: number | null) => {
      if (entry.ended) return;
      entry.ended = true;
      clearTimeout(timeout);
      if (pluginProcesses.get(name) === entry) pluginProcesses.delete(name);
      confirmExit();
      if (!settled) {
        settled = true;
        reject(new Error(`Plugin server exited with code ${code} before reporting ready`));
      }
    };
    pluginProcess.once('exit', exited);
    // A failed spawn can emit close without exit; it has no live child to stop.
    pluginProcess.once('close', exited);
  }).finally(() => {
    if (startingPlugins.get(name) === startPromise) startingPlugins.delete(name);
  });

  startingPlugins.set(name, startPromise);
  return startPromise;
}

function terminatePlugin(entry: PluginProcessEntry): Promise<void> {
  if (entry.ended) return Promise.resolve();
  if (entry.stopPromise) return entry.stopPromise;
  entry.stopping = true;
  const stopPromise = new Promise<void>((resolve, reject) => {
    let completed = false;
    const finish = (error?: Error) => {
      if (completed) return;
      completed = true;
      clearTimeout(forceKillTimer);
      clearTimeout(confirmationTimer);
      if (error) reject(error); else resolve();
    };
    void entry.exited.then(() => finish());
    const forceKillTimer = setTimeout(() => {
      if (entry.ended) return;
      try { entry.process.kill('SIGKILL'); }
      catch (error) { console.error('[Plugins] Failed to force-stop server:', error); }
    }, 5000);
    const confirmationTimer = setTimeout(() => {
      if (entry.ended) finish();
      else finish(new Error('Plugin server exit was not confirmed; its process remains reserved'));
    }, 10000);
    try { entry.process.kill('SIGTERM'); }
    catch (error) { console.error('[Plugins] Failed to request server stop:', error); }
  }).finally(() => {
    if (entry.stopPromise === stopPromise) entry.stopPromise = null;
  });
  entry.stopPromise = stopPromise;
  return stopPromise;
}

/**
 * Plugins service stops starting or ready children. Resolution confirms exit;
 * a failed confirmation retains the process reservation for a later stop retry.
 */
export async function stopPluginServer(name: string): Promise<void> {
  const entry = pluginProcesses.get(name);
  if (!entry) return Promise.resolve();
  entry.cancelStartup(new Error('Plugin server startup was canceled'));
  await terminatePlugin(entry);
  console.log(`[Plugins] Server stopped for "${name}"`);
}

/**
 * Plugins RPC and WebSocket proxies obtain only a ready, non-stopping port.
 */
export function getPluginPort(name: string): number | undefined {
  const entry = pluginProcesses.get(name);
  return entry && !entry.ended && !entry.stopping ? entry.port ?? undefined : undefined;
}

/**
 * Plugins service treats a live unconfirmed stop as running, not disabled.
 */
export function isPluginRunning(name: string): boolean {
  const entry = pluginProcesses.get(name);
  return Boolean(entry && !entry.ended && (entry.port !== null || entry.stopping));
}

/**
 * Server shutdown waits for starting and ready plugin children to exit.
 */
export function stopAllPlugins(): Promise<void[]> {
  const stops = [];
  for (const [name] of pluginProcesses) {
    stops.push(stopPluginServer(name));
  }
  return Promise.all(stops);
}

/**
 * Server boot starts enabled plugins that declare a server entry.
 */
export async function startEnabledPluginServers() {
  const plugins = scanPlugins();

  for (const plugin of plugins) {
    if (!plugin.server) continue;
    if (!plugin.enabled) continue;

    const pluginDir = getPluginDir(plugin.name);
    if (!pluginDir) continue;

    try {
      await startPluginServer(plugin.name, pluginDir, plugin.server);
    } catch (error) {
      console.error(`[Plugins] Failed to start server for "${plugin.name}":`, error instanceof Error ? error.message : String(error));
    }
  }
}
