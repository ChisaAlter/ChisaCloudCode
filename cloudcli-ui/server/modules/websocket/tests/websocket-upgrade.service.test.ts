import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingMessage } from 'node:http';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { WebSocket } from 'ws';

import { createWebSocketServer } from '@/modules/websocket/services/websocket-server.service.js';

type Dependencies = Parameters<typeof createWebSocketServer>[1];

function dependencies(): Dependencies {
  return {
    verifyClient: { isPlatform: false, authenticateWebSocket: token => token === 'test-token' ? { id: 'one', username: 'test' } : null },
    chat: {} as Dependencies['chat'],
    shell: { resolveProviderSessionId: () => null },
    getPluginPort: () => null,
  };
}

test('one upgrade dispatcher exclusively delegates runtime preview requests', async () => {
  const server = createServer();
  let previewCalls = 0;
  const wss = createWebSocketServer(server, {
    ...dependencies(),
    handlePreviewUpgrade(request, socket, head) {
      previewCalls += 1;
      assert.equal(request.url, '/api/workspace-runtime/preview/token/hmr');
      assert.equal(head.toString(), 'head');
      socket.destroy();
      return true;
    },
  });
  assert.equal(server.listenerCount('upgrade'), 1);
  let ordinaryUpgrades = 0;
  wss.handleUpgrade = () => { ordinaryUpgrades += 1; };
  server.emit('upgrade', { url: '/api/workspace-runtime/preview/token/hmr' } as IncomingMessage, new PassThrough(), Buffer.from('head'));
  assert.equal(previewCalls, 1);
  assert.equal(ordinaryUpgrades, 0);
  const closed = once(wss, 'close');
  wss.close();
  await closed;
  assert.equal(server.listenerCount('upgrade'), 0);
});

test('ordinary shell upgrade still authenticates and enforces workspace selectors', async () => {
  const server = createServer();
  const wss = createWebSocketServer(server, dependencies());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const denied = new WebSocket(`ws://127.0.0.1:${address.port}/shell?token=invalid`);
  const rejected = await new Promise<Error>(resolve => denied.once('error', resolve));
  assert.match(rejected.message, /401/);
  const client = new WebSocket(`ws://127.0.0.1:${address.port}/shell?token=test-token`);
  try {
    await once(client, 'open');
    const message = once(client, 'message');
    client.send(JSON.stringify({ type: 'init', projectPath: process.cwd() }));
    const [frame] = await message;
    assert.equal(JSON.parse(String(frame)).code, 'WORKSPACE_SELECTOR_REQUIRED');
  } finally {
    const closed = once(client, 'close');
    client.close();
    await closed;
    const gatewayClosed = once(wss, 'close');
    wss.close();
    await gatewayClosed;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
