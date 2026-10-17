import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The bundled Mutagen transport always reads the app's own SSH configuration.
if (process.platform === 'win32') {
  const target = fileURLToPath(new URL('../resources/windows-amd64/sync-ssh/', import.meta.url));
  mkdirSync(target, { recursive: true });
  const result = spawnSync('go', ['build', '-trimpath', '-ldflags=-s -w -H=windowsgui', '-o', target + 'ssh.exe', './cmd/sync-ssh'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: 'inherit',
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
  copyFileSync(target + 'ssh.exe', target + 'scp.exe');
}
