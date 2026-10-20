import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer as createNetServer } from 'node:net';

export const appRoot = fileURLToPath(new URL('../', import.meta.url));
export const frontendRoot = fileURLToPath(new URL('../../cloudcli-ui/', import.meta.url));
const frontendRequire = createRequire(new URL('../../cloudcli-ui/package.json', import.meta.url));

export function devPort() {
  const value = process.env.CHISA_DEV_PORT || '5173';
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error('CHISA_DEV_PORT must be an integer from 1 to 65535');
  }
  return Number(value);
}

export async function assertPortAvailable(port = devPort()) {
  const server = createNetServer();
  await new Promise((resolve, reject) => {
    server.once('error', (error) => reject(new Error(`Development port 127.0.0.1:${port} is unavailable (${error.code}). Close that development session or set CHISA_DEV_PORT to a free port. Existing processes were left running.`)));
    server.listen(port, '127.0.0.1', resolve);
  });
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

export async function vite() {
  // Resolve from the sibling frontend: its config and plugins use this version.
  return import(pathToFileURL(frontendRequire.resolve('vite')).href);
}

export async function serveFrontend() {
  const port = devPort();
  await assertPortAvailable(port);
  // MyGo deliberately supplies no stdin to devCommand. Vite treats that EOF as
  // shutdown outside CI; lifetime here is controlled by signals/IPC instead.
  process.env.CI = 'true';
  process.chdir(frontendRoot);
  const { createServer } = await vite();
  const server = await createServer({
    root: frontendRoot,
    clearScreen: false,
    server: {
      host: '127.0.0.1', port, strictPort: true, open: false,
      // Atomic editor saves can briefly lock their temporary directories on
      // Windows; polling avoids native fs.watch EBUSY terminating Vite.
      watch: {
        usePolling: process.platform === 'win32', interval: 300,
        ignored: ['**/.*.tmpdir/**', '**/*.tmp'],
      },
    },
  });
  await server.listen();
  server.printUrls();
  return server;
}
