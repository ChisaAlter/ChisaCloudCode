import { CodexAppServerClient } from './codex-client.js';
import { createUsageServer } from './server-app.js';

const client = new CodexAppServerClient();
const server = createUsageServer(client);

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (address && typeof address !== 'string') {
    console.log(JSON.stringify({ ready: true, port: address.port }));
  }
});

function shutdown(): void {
  server.close();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
