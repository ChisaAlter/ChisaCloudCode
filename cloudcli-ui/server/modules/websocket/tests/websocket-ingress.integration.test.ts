import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';

import { createHttpIngressPolicy } from '@/modules/http-ingress/index.js';

import { createWebSocketServer } from '../services/websocket-server.service.js';

test('real HTTP login/ticket and all WS routes enforce exact origin, one-use paths, session revocation and healthy parallel sockets', { timeout: 30_000 }, async context => {
  const root = await mkdtemp(path.join(tmpdir(), 'websocket-ingress-'));
  const previousDb = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = path.join(root, 'auth.db'); await writeFile(process.env.DATABASE_PATH, '');
  const { closeConnection, initializeDatabase, userDb, getConnection } = await import('@/modules/database/index.js');
  closeConnection(); await initializeDatabase();
  const auth = await import('@/modules/auth/index.js');
  const { AppError } = await import('@/shared/index.js');
  const app = express();
  const policy = createHttpIngressPolicy({ CHISA_ALLOWED_HOSTS: 'app.test:3001', CHISA_ALLOWED_ORIGINS: 'https://approved-ui.test' });
  policy.install(app); app.use(express.json({ limit: '64kb' }));
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.use('/api/auth', auth.authRoutes);
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    response.status(error instanceof AppError ? error.statusCode : 500).json({ error: error instanceof AppError ? error.code : 'unexpected' });
  });
  const upstream = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(upstream, 'listening');
  let pluginAllowed = true; let upstreamConnections = 0; let forwarded = 0;
  upstream.on('connection', socket => { upstreamConnections++; socket.on('message', data => { forwarded++; socket.send(data); }); });
  const upstreamAddress = upstream.address(); assert.ok(upstreamAddress && typeof upstreamAddress === 'object');
  const server = createServer(app);
  const wss = createWebSocketServer(server, {
    verifyClient: { isPlatform: false, authenticateWebSocket: auth.authenticateWebSocket, consumeWebSocketTicket: auth.consumeWebSocketTicket,
      isAuthSessionActive: auth.isAuthSessionActive, authorizeUpgrade: policy.authorizeUpgrade },
    chat: {} as Parameters<typeof createWebSocketServer>[1]['chat'],
    shell: { resolveProviderSessionId: () => null },
    getPluginPort: () => upstreamAddress.port,
    authorizePluginAccess: () => { if (!pluginAllowed) throw new Error('denied'); },
    limits: { revalidateMs: 20, maxConnectionsPerSession: 4 },
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const clients = new Set<WebSocket>();
  const http = (route: string, method = 'GET', body?: unknown, token?: string) => new Promise<Response>((resolve, reject) => {
    const outgoing = httpRequest({ host: '127.0.0.1', port: address.port, path: route, method,
      headers: { Host: 'app.test:3001', Origin: 'http://app.test:3001', 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    }, response => {
      const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode!, headers: response.headers as Record<string, string> })));
    });
    outgoing.once('error', reject); outgoing.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const ticket = async (token: string, route: string) => {
    const response = await http('/api/auth/ws-ticket', 'POST', { path: route }, token); assert.equal(response.status, 200);
    return (await response.json() as { ticket: string }).ticket;
  };
  const connect = (route: string, headers: Record<string, string> = {}) => {
    const client = new WebSocket(`ws://127.0.0.1:${address.port}${route}`, { headers: { Host: 'app.test:3001', Origin: 'http://app.test:3001', ...headers } });
    clients.add(client); client.on('error', () => {}); return client;
  };
  const refused = async (route: string, headers?: Record<string, string>) => {
    const socket = connect(route, headers);
    const failure = await new Promise<Error>((resolve, reject) => { socket.once('error', resolve); socket.once('open', () => reject(new Error('Unexpected accepted handshake'))); });
    assert.match(failure.message, /401/);
  };
  try {
    assert.equal((await http('/health')).status, 200);
    const credentials = { username: 'ws-fixture', password: 'invalid-fixture-only' };
    assert.equal((await http('/api/auth/login', 'POST', credentials)).status, 401, 'login remains public behind ingress');
    userDb.createUser('ws-fixture', 'hash'); const user = userDb.getUserByUsername('ws-fixture'); assert.ok(user);
    const { createRequire } = await import('node:module');
    const bcrypt = createRequire(import.meta.url)('bcrypt') as { hashSync(value: string, rounds: number): string };
    getConnection().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(credentials.password, 4), user.id);
    const login = await http('/api/auth/login', 'POST', credentials); assert.equal(login.status, 200);
    const token = (await login.json() as { token: string }).token;
    await refused(`/ws?token=${encodeURIComponent(token)}`);
    await refused(`/ws?ticket=${await ticket(token, '/ws')}`, { Origin: 'https://evil.test' });
    await refused(`/ws?ticket=${await ticket(token, '/ws')}`, { Origin: 'null' });
    await refused(`/ws?ticket=${await ticket(token, '/ws')}`, { Host: 'evil.test' });
    const expired = await ticket(token, '/ws');
    context.mock.timers.enable({ apis: ['Date'], now: Date.now() + 31_000 });
    try { await refused(`/ws?ticket=${expired}`); } finally { context.mock.timers.reset(); }
    const pathMix = await ticket(token, '/shell');
    await refused(`/ws?ticket=${pathMix}`); await refused(`/shell?ticket=${pathMix}`);
    const reused = await ticket(token, '/ws');
    const chat = connect(`/ws?ticket=${reused}`, { Origin: 'https://approved-ui.test' }); await once(chat, 'open');
    await refused(`/ws?ticket=${reused}`);
    const shell = connect(`/shell?ticket=${await ticket(token, '/shell')}`); await once(shell, 'open');
    const notification = connect(`/desktop-notifications?ticket=${await ticket(token, '/desktop-notifications')}`); await once(notification, 'open');
    const plugin = connect(`/plugin-ws/approved?ticket=${await ticket(token, '/plugin-ws/approved')}`); await once(plugin, 'open');
    await refused(`/ws?ticket=${await ticket(token, '/ws')}`);
    const shellResponse = once(shell, 'message'); shell.send(JSON.stringify({ type: 'init' }));
    assert.equal(JSON.parse(String((await shellResponse)[0])).code, 'WORKSPACE_SELECTOR_REQUIRED');
    const echo = once(plugin, 'message'); plugin.send('hello'); assert.equal(String((await echo)[0]), 'hello');
    assert.equal(upstreamConnections, 1); assert.equal(forwarded, 1);
    pluginAllowed = false;
    const deniedClose = once(plugin, 'close'); plugin.send('blocked'); await deniedClose;
    assert.equal(forwarded, 1, 'revoked plugin permissions cannot forward one more frame');
    const closeEvents = [chat, shell, notification].map(socket => once(socket, 'close'));
    assert.equal((await http('/api/auth/logout', 'POST', undefined, token)).status, 200);
    // These frames must be blocked before the route-specific business listeners run.
    notification.send(JSON.stringify({ type: 'register', deviceId: 'revoked-device' }));
    shell.send(JSON.stringify({ type: 'input', data: 'must-not-execute' }));
    const closes = await Promise.all(closeEvents); for (const [code] of closes) assert.equal(code, 4401);
    await refused('/ws', { Authorization: `Bearer ${token}` });
    const tokenAfterLogout = (await (await http('/api/auth/login', 'POST', credentials)).json() as { token: string }).token;
    const afterPassword = connect(`/ws?ticket=${await ticket(tokenAfterLogout, '/ws')}`); await once(afterPassword, 'open');
    const changedClose = once(afterPassword, 'close');
    getConnection().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run('changed-hash', user.id);
    assert.equal((await changedClose)[0], 4401, 'password change closes an existing idle socket');
    assert.throws(() => auth.verifyAuthToken(tokenAfterLogout));
    getConnection().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(credentials.password, 4), user.id);
    const expiryToken = (await (await http('/api/auth/login', 'POST', credentials)).json() as { token: string }).token;
    const expiring = connect(`/ws?ticket=${await ticket(expiryToken, '/ws')}`); await once(expiring, 'open');
    const expiryClose = once(expiring, 'close');
    const expiry = auth.verifyAuthToken(expiryToken).session.expiresAt;
    context.mock.timers.enable({ apis: ['Date'], now: expiry * 1000 });
    try { assert.equal((await expiryClose)[0], 4401, 'absolute lifetime closes an existing idle socket'); }
    finally { context.mock.timers.reset(); }
  } finally {
    for (const socket of clients) socket.terminate();
    for (const socket of wss.clients) socket.terminate();
    for (const socket of upstream.clients) socket.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
    closeConnection(); if (previousDb === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previousDb;
    await rm(root, { recursive: true, force: true });
  }
});
