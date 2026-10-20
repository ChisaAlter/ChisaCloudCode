import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { frontendRoot, vite } from './frontend.mjs';
import './build-sync-ssh.mjs';

function runScript(url, args = []) {
  const result = spawnSync(process.execPath, [fileURLToPath(url), ...args], { cwd: frontendRoot, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${url.pathname} failed (${result.status ?? result.signal})`);
}

try {
  runScript(new URL('../../cloudcli-ui/scripts/build-identity.mjs', import.meta.url), ['--native']);
  if (process.argv.includes('--dev')) {
    // Also support `mygo dev` directly, with the same EOF-safe Vite runner.
    await import('./dev-frontend.mjs');
  } else if (!process.argv.includes('--prepare')) {
    // Preserve build:web's prebuild hook without npm.cmd/shell quoting or an
    // extra process tree. The sibling frontend owns Vite and its config.
    runScript(new URL('../../cloudcli-ui/scripts/build-builtin-plugins.mjs', import.meta.url));
    process.chdir(frontendRoot);
    const { build } = await vite();
    await build({ root: frontendRoot });
  }
} catch (error) {
  console.error(`[frontend] ${error.stack || error}`);
  process.exitCode = 1;
}
