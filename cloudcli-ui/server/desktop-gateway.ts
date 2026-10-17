import { readFileSync } from 'node:fs';
import type { Duplex } from 'node:stream';

import { createDesktopGateway } from './modules/desktop-gateway/index.js';

const configuration = JSON.parse(readFileSync(process.env.CHISA_GATEWAY_CONFIG ?? '', 'utf8'));
const server = createDesktopGateway({ ...configuration,
  key: readFileSync(process.env.CHISA_GATEWAY_KEY ?? ''),
  cert: readFileSync(process.env.CHISA_GATEWAY_CERT ?? ''),
});
// HTTPS keep-alive, incomplete TLS handshakes and upgraded WebSockets all retain
// their underlying TCP connection. server.close alone does not drain upgrades.
const connections = new Set<Duplex>();
server.on('connection', connection => {
  connections.add(connection);
  connection.once('close', () => connections.delete(connection));
});
server.listen(Number(process.env.CHISA_GATEWAY_PORT ?? 8794), process.env.CHISA_GATEWAY_HOST ?? '0.0.0.0', () => {
  console.log('ChisaCloudCode encrypted account gateway is listening');
});
let stopping = false;
function stopGateway() {
  if (stopping) return;
  stopping = true;
  const finish = () => {
    for (const connection of connections) connection.destroy();
    process.exit(0);
  };
  // Allow short HTTP replies to finish, but never leave a deployment waiting
  // indefinitely for a desktop's long-lived WebSocket or stalled request.
  const deadline = setTimeout(finish, 1500);
  deadline.unref();
  server.close(() => {
    clearTimeout(deadline);
    finish();
  });
  server.closeIdleConnections();
}
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, stopGateway);
