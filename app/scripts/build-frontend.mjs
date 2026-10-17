import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import './build-sync-ssh.mjs';
const metadata = spawnSync(process.execPath, [fileURLToPath(new URL('../../cloudcli-ui/scripts/build-identity.mjs', import.meta.url)), '--native'], { stdio: 'inherit' });
if (metadata.status !== 0) process.exit(metadata.status ?? 1);
const dev = process.argv.includes('--dev');
const r = spawnSync('npm', ['run', dev ? 'dev:web' : 'build:web'], { cwd: fileURLToPath(new URL('../../cloudcli-ui', import.meta.url)), stdio: 'inherit', shell: true });
process.exit(r.status ?? 1);
