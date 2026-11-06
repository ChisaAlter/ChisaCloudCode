import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import test from 'node:test';

import { WebSocket, WebSocketServer } from 'ws';

import { handlePluginWsProxy } from '../services/plugin-websocket-proxy.service.js';

class FakeClient extends EventEmitter {
  readyState = WebSocket.OPEN as number;
  bufferedAmount = 0;
  sent: string[] = [];
  closes: number[] = [];
  terminate() { this.readyState = WebSocket.CLOSED; this.emit('close'); }
  close(code: number) { this.closes.push(code); this.terminate(); }
  send(data: unknown, _options: unknown, callback?: (error?: Error) => void) { this.sent.push(String(data)); callback?.(); }
}
const makeDependencies = (changes: Partial<Parameters<typeof handlePluginWsProxy>[2]> = {}) => ({ getPluginPort: () => 1,
  authorizePluginAccess: () => {}, userId: 1, isSessionActive: () => true, ...changes });

test('authorization and identity failure never even resolve an upstream port', () => {
  for (const changes of [{ userId: 0 }, { isSessionActive: () => false }, { authorizePluginAccess: () => { throw new Error('denied'); } },
    { authorizePluginAccess: () => Promise.resolve(true) }]) {
    const socket = new FakeClient(); let lookups = 0;
    handlePluginWsProxy(socket as unknown as WebSocket, '/plugin-ws/sample', makeDependencies({ ...changes, getPluginPort: () => { lookups++; return 1234; } }));
    assert.equal(lookups, 0); assert.ok(socket.closes.length > 0);
  }
});

test('pending upstream buffers at most sixteen frames and closes both sides on overflow', async () => {
  const held: (() => void)[] = [];
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1', verifyClient: (_info, callback) => { held.push(() => callback(true)); } });
  await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address === 'object');
  const client = new FakeClient();
  try {
    handlePluginWsProxy(client as unknown as WebSocket, '/plugin-ws/sample', makeDependencies({ getPluginPort: () => address.port }));
    for (let i = 0; i < 16; i++) client.emit('message', Buffer.from('queued'), false);
    assert.equal(client.closes.length, 0);
    client.emit('message', Buffer.from('overflow'), false);
    assert.equal(client.closes[0], 4408);
  } finally { for (const release of held) release(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('oversize pending frame and idle proxy cannot retain memory or upstream connections', async context => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const oversize = new FakeClient(); const idle = new FakeClient();
  try {
    handlePluginWsProxy(oversize as unknown as WebSocket, '/plugin-ws/sample', makeDependencies({ getPluginPort: () => address.port }));
    oversize.emit('message', Buffer.alloc(256 * 1024 + 1), false); assert.equal(oversize.closes[0], 4408);
    context.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1000 });
    handlePluginWsProxy(idle as unknown as WebSocket, '/plugin-ws/sample', makeDependencies({ getPluginPort: () => address.port }));
    context.mock.timers.tick(60_000); assert.equal(idle.closes[0], 4408);
  } finally {
    context.mock.timers.reset(); for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('upstream echo respects downstream backpressure and closes when permissions are revoked', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const client = new FakeClient(); let active = true;
  try {
    const connection = once(server, 'connection');
    handlePluginWsProxy(client as unknown as WebSocket, '/plugin-ws/sample', makeDependencies({ getPluginPort: () => address.port, isSessionActive: () => active }));
    const [upstream] = await connection as [WebSocket];
    client.bufferedAmount = 512 * 1024;
    const closed = once(client, 'close'); upstream.send('pressure'); await closed;
    assert.equal(client.closes[0], 4408); assert.deepEqual(client.sent, []);
    const second = new FakeClient(); const newConnection = once(server, 'connection');
    handlePluginWsProxy(second as unknown as WebSocket, '/plugin-ws/sample', makeDependencies({ getPluginPort: () => address.port, isSessionActive: () => active }));
    await newConnection; active = false;
    second.emit('message', Buffer.from('blocked'), false); assert.equal(second.closes[0], 4403);
  } finally { for (const socket of server.clients) socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
