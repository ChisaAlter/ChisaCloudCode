import { fork, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { binaryPath } from 'mygo-cli';
import { appRoot, assertPortAvailable, devPort } from './frontend.mjs';

// Own both children: upstream MyGo only watches devCommand until its URL first
// responds, so a later Vite failure would otherwise leave a broken window open.
let frontend;
let desktop;
let closing = false;
let exitCode = 0;
const exit = (child) => !child || !child.pid || child.exitCode !== null || child.signalCode !== null;
async function stopChild(child, graceful) {
  if (exit(child)) return;
  const done = new Promise((resolve) => child.once('exit', resolve));
  if (graceful && child.connected) child.send('shutdown');
  else if (process.platform === 'win32') {
    // Only the process tree created by this launcher; never kill by image name.
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
  } else child.kill('SIGTERM');
  const timeout = setTimeout(() => {
    if (!exit(child)) child.kill('SIGKILL');
  }, 5000);
  await done;
  clearTimeout(timeout);
}
async function close(code = 0) {
  if (closing) return;
  closing = true;
  exitCode = code;
  await stopChild(desktop, false);
  await stopChild(frontend, true);
  process.exitCode = exitCode;
}
process.once('SIGINT', () => close(130));
process.once('SIGTERM', () => close(143));

try {
  const args = process.argv.slice(2);
  const smokeArg = args.find((arg) => arg.startsWith('--smoke-seconds='));
  const smokeSeconds = smokeArg ? Number(smokeArg.split('=')[1]) : 0;
  if (smokeArg && (!Number.isFinite(smokeSeconds) || smokeSeconds < 5)) throw new Error('--smoke-seconds must be at least 5');
  const mygoArgs = args.filter((arg) => arg !== smokeArg);
  if (mygoArgs.includes('--skip-dev-command')) throw new Error('npm run dev manages its frontend; use npm run dev:native for an externally managed frontend');
  await assertPortAvailable();
  const prepare = spawnSync(process.execPath, [fileURLToPath(new URL('./build-frontend.mjs', import.meta.url)), '--prepare'], { cwd: appRoot, stdio: 'inherit' });
  if (prepare.error) throw prepare.error;
  if (prepare.status !== 0) throw new Error(`Frontend preparation failed (${prepare.status ?? prepare.signal})`);
  frontend = fork(fileURLToPath(new URL('./dev-frontend.mjs', import.meta.url)), [], { cwd: appRoot, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Frontend startup timed out')), 30000);
    frontend.once('message', (message) => { if (message?.type === 'ready') { clearTimeout(timer); resolve(); } });
    frontend.once('error', (error) => { clearTimeout(timer); reject(error); });
    frontend.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Frontend exited before ready (${code})`)); });
  });
  if (closing) await close(exitCode);
  else {
    const session = randomUUID();
    const configRoot = process.platform === 'win32' ? process.env.APPDATA : process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support') : process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
    const profile = resolve(process.env.CHISA_DATA_DIR || join(configRoot || homedir(), 'ChisaCloudCode Dev', 'sessions', session));
    const env = {
      ...process.env, CHISA_DEV_SESSION: session, CHISA_DEV_PORT: String(devPort()),
      CHISA_DATA_DIR: profile,
      WEBVIEW2_USER_DATA_FOLDER: process.env.WEBVIEW2_USER_DATA_FOLDER || join(profile, 'WebView2'),
    };
    console.log(`[dev] Profile: ${profile}`);
    desktop = spawn(binaryPath(), ['dev', '--skip-dev-command', ...mygoArgs], { cwd: appRoot, env, stdio: 'inherit' });
    desktop.once('error', (error) => { console.error(`[dev] ${error.message}`); close(1); });
    desktop.once('exit', (code, signal) => close(code ?? (signal ? 1 : 0)));
    frontend.once('exit', (code) => {
      if (!closing) { console.error(`[dev] Frontend stopped unexpectedly (${code}); stopping this development session.`); close(code || 1); }
    });
    if (smokeSeconds) {
      const timer = setTimeout(() => { console.log(`[dev] Smoke window finished after ${smokeSeconds}s`); close(); }, smokeSeconds * 1000);
      timer.unref();
    }
  }
} catch (error) {
  console.error(`[dev] ${error.stack || error}`);
  await close(1);
}
