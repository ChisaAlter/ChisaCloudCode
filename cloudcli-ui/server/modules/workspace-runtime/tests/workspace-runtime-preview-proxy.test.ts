import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import test, { mock } from 'node:test';

import express from 'express';

const token = 'a'.repeat(64);
const base = '/api/workspace-runtime/preview/' + token + '/';
const connections = new Set<() => void>();
let enabled = true;
let revokeAfterResolve = false;
let upstreamPort = 0;
let received: { path?: string; headers?: http.IncomingHttpHeaders; body?: string } = {};
mock.module('../workspace-runtime-preview-access.service.js', { namedExports: {
  resolveWorkspaceRuntimePreviewAccess: async (value: string) => {
    if (value !== token || !enabled) throw Object.assign(new Error('Preview unavailable'), { statusCode: 404 });
    if (revokeAfterResolve) queueMicrotask(() => { enabled = false; });
    return { host: '127.0.0.1', port: upstreamPort, base };
  },
  retainWorkspaceRuntimePreviewConnection: (_token: string, close: () => void) => {
    if (!enabled) throw Object.assign(new Error('Preview unavailable'), { statusCode: 404 });
    connections.add(close); return () => { connections.delete(close); };
  },
} });
const { createWorkspaceRuntimePreviewRouter, handleWorkspaceRuntimePreviewUpgrade } = await import('../workspace-runtime-preview.routes.js');
const upstream = http.createServer(async (request, response) => {
  const body: Buffer[] = [];
  for await (const chunk of request) body.push(Buffer.from(chunk));
  received = { path: request.url, headers: request.headers, body: Buffer.concat(body).toString() };
  if (request.url === base + 'redirect') { response.writeHead(302, { Location: '/api/auth' }); response.end(); return; }
  if (request.url === base + 'same-redirect') { response.writeHead(302, { Location: './next?ok=1' }); response.end(); return; }
  if (request.url === base + 'malformed-redirect') { response.writeHead(302, { Location: 'http://[' }); response.end(); return; }
  response.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'main=bad', 'Clear-Site-Data': '"*"',
    'Service-Worker-Allowed': '/', 'Content-Security-Policy': "default-src *", 'Access-Control-Allow-Origin': 'https://evil.example',
    'Access-Control-Allow-Credentials': 'true', Refresh: '0; url=/api/auth' });
  response.end('<html>preview:' + received.body + '</html>');
});
upstream.on('upgrade', (request, socket, head) => {
  received = { path: request.url, headers: request.headers };
  socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: fixture\r\nSet-Cookie: main=bad\r\n\r\n');
  if (head.length) socket.write(head);
  socket.on('data', data => socket.write(data));
});
const app = express();
app.use('/api/workspace-runtime', createWorkspaceRuntimePreviewRouter());
app.use(express.json());
app.use((error: Error & { statusCode?: number }, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  response.status(error.statusCode ?? 502).json({ error: error.message });
});
const server = http.createServer(app);
server.on('upgrade', (request, socket, head) => { if (!handleWorkspaceRuntimePreviewUpgrade(request, socket, head)) socket.destroy(); });
let origin = '';

test.before(async () => {
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  upstreamPort = (upstream.address() as AddressInfo).port;
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
});
test.beforeEach(() => { enabled = true; revokeAfterResolve = false; received = {}; });
test.after(async () => {
  for (const close of connections) close();
  server.closeAllConnections(); upstream.closeAllConnections();
  await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => upstream.close(() => resolve()))]);
});

test('HTTP preview streams its base path and body without main-app credentials or browser privileges', async () => {
  const response = await fetch(origin + base + 'asset?q=one', { method: 'POST', headers: {
    Authorization: 'Bearer main-secret', Cookie: 'main=secret', Origin: 'https://main.example', Referer: 'https://main.example/private',
    'X-Forwarded-Host': 'main.example', 'Content-Type': 'application/json',
  }, body: '{"hello":"world"}' });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '<html>preview:{"hello":"world"}</html>');
  assert.equal(received.path, base + 'asset?q=one');
  assert.equal(received.body, '{"hello":"world"}');
  for (const name of ['authorization', 'cookie', 'origin', 'referer', 'x-forwarded-host']) assert.equal(received.headers?.[name], undefined);
  assert.equal(received.headers?.['content-type'], 'application/json');
  for (const name of ['set-cookie', 'clear-site-data', 'service-worker-allowed', 'refresh', 'access-control-allow-credentials']) assert.equal(response.headers.get(name), null);
  const policy = response.headers.get('content-security-policy')!;
  assert.match(policy, /sandbox allow-scripts allow-forms;/);
  assert.doesNotMatch(policy, /allow-same-origin|allow-top-navigation|allow-popups/);
  assert.ok(policy.includes("connect-src " + origin + base + ' ' + origin.replace(/^http/, 'ws') + base));
  assert.ok(policy.includes("worker-src 'none'"));
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(connections.size, 0);
});

test('redirects stay within the exact preview base', async () => {
  const unsafe = await fetch(origin + base + 'redirect', { redirect: 'manual' });
  assert.equal(unsafe.status, 502); await unsafe.body?.cancel();
  assert.equal(unsafe.headers.get('location'), null);
  const safe = await fetch(origin + base + 'same-redirect', { redirect: 'manual' });
  assert.equal(safe.status, 302);
  assert.equal(safe.headers.get('location'), base + 'next?ok=1'); await safe.body?.cancel();
  const malformed = await fetch(origin + base + 'malformed-redirect', { redirect: 'manual' });
  assert.equal(malformed.status, 502); await malformed.body?.cancel();
  assert.equal(malformed.headers.get('location'), null);
  assert.equal(connections.size, 0);
});

test('unknown or revoked capability never reaches the upstream', async () => {
  enabled = false;
  const response = await fetch(origin + base);
  assert.equal(response.status, 404); await response.body?.cancel();
  assert.equal(received.path, undefined);
  const malformed = await fetch(origin + '/api/workspace-runtime/preview/not-a-token/');
  assert.equal(malformed.status, 404); await malformed.body?.cancel();
});

test('revocation after access resolution does not allocate an upstream HTTP or WebSocket connection', { timeout: 5_000 }, async () => {
  revokeAfterResolve = true;
  const response = await fetch(origin + base);
  assert.equal(response.status, 404); await response.body?.cancel();
  assert.equal(received.path, undefined);
  assert.equal(connections.size, 0);
  enabled = true;
  const socket = net.connect((server.address() as AddressInfo).port, '127.0.0.1');
  socket.on('error', () => {});
  await once(socket, 'connect');
  const closed = once(socket, 'close');
  socket.write('GET ' + base + 'hmr HTTP/1.1\r\nHost: main.example\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: fixture\r\nSec-WebSocket-Version: 13\r\n\r\n');
  await closed;
  assert.equal(received.path, undefined);
  assert.equal(connections.size, 0);
});

test('sandbox CORS preflight uses the capability without forwarding to the app', async () => {
  const response = await fetch(origin + base, { method: 'OPTIONS', headers: { Origin: 'null', 'Access-Control-Request-Headers': 'content-type' } });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-headers'), 'content-type');
  assert.equal(response.headers.get('access-control-allow-credentials'), null);
  assert.equal(received.path, undefined);
});

test('WebSocket proxy strips credentials, preserves its path and closes on capability revocation', { timeout: 5_000 }, async () => {
  const socket = net.connect((server.address() as AddressInfo).port, '127.0.0.1');
  socket.on('error', () => {});
  await once(socket, 'connect');
  socket.write('GET ' + base + 'hmr HTTP/1.1\r\nHost: main.example\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: fixture\r\nSec-WebSocket-Version: 13\r\nCookie: main=secret\r\nAuthorization: Bearer secret\r\nOrigin: null\r\n\r\n');
  const [handshake] = await once(socket, 'data') as [Buffer];
  assert.match(handshake.toString(), /101 Switching Protocols/);
  assert.doesNotMatch(handshake.toString().toLowerCase(), /set-cookie/);
  assert.equal(received.path, base + 'hmr');
  for (const name of ['authorization', 'cookie', 'origin']) assert.equal(received.headers?.[name], undefined);
  assert.equal(connections.size, 1);
  const closed = once(socket, 'close');
  enabled = false; for (const close of connections) close();
  await closed;
});
