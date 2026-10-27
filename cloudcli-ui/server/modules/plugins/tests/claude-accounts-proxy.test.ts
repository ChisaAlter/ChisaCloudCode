import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, get, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

import { createPluginsRouter } from '@/modules/plugins/plugins.routes.js';
import type { createPluginsService } from '@/modules/plugins/plugins.service.js';

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test('plugin RPC releases pending scopes after disconnect, strips spoofed paths and aborts upstream work', async () => {
  let upstreamCalls = 0;
  let lastHeaders: IncomingMessage['headers'] = {};
  let holdUpstream: ((request: IncomingMessage, response: ServerResponse) => void) | null = null;
  const upstream = createServer((req, res) => {
    upstreamCalls++; lastHeaders = req.headers;
    if (holdUpstream) { holdUpstream(req, res); return; }
    res.setHeader('content-type', 'application/json'); res.end('{"ok":true}');
  }).listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const port = (upstream.address() as AddressInfo).port;
  let releases = 0;
  let resolvePending: ((scope: { configDir: string; authDir: string; release(): void }) => void) | null = null;
  let scopeStarted: (() => void) | null = null;
  let pending = true;
  const scope = () => ({ configDir: '/fixture/user-1/history', authDir: '/fixture/user-1/auth', release() { releases++; } });
  const service = { prepareRpc: async () => ({ port, secrets: {} }) } as unknown as ReturnType<typeof createPluginsService>;
  const app = express().use((req, _res, next) => { Object.assign(req, { user: { id: 1 } }); next(); });
  app.use('/plugins', createPluginsRouter(service, async (id) => {
    assert.equal(id, 1);
    if (!pending) return scope();
    return new Promise(resolve => { resolvePending = resolve; scopeStarted?.(); });
  }));
  app.use((_error: unknown, _req: Request, res: Response, _next: NextFunction) => res.status(502).json({ error: 'fixture upstream failed' }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/plugins/claude-usage/rpc/history`;
  try {
    const started = new Promise<void>(resolve => { scopeStarted = resolve; });
    const client = get(url); client.on('error', () => {});
    await started;
    const clientClosed = new Promise<void>(resolve => client.once('close', resolve));
    client.destroy(); await clientClosed; await flush();
    const finishScope = resolvePending as unknown as (value: ReturnType<typeof scope>) => void;
    finishScope(scope()); await flush(); await flush();
    assert.equal(releases, 1);
    assert.equal(upstreamCalls, 0);

    pending = false;
    const good = await fetch(url, { headers: { 'x-chisa-claude-config-dir': Buffer.from('/spoof/foreign').toString('base64'), 'x-chisa-claude-auth-dir': Buffer.from('/spoof/credentials').toString('base64'), authorization: 'Bearer browser-token' } });
    assert.equal(good.status, 200); await good.json(); await flush();
    assert.equal(Buffer.from(String(lastHeaders['x-chisa-claude-config-dir']), 'base64').toString(), '/fixture/user-1/history');
    assert.equal(Buffer.from(String(lastHeaders['x-chisa-claude-auth-dir']), 'base64').toString(), '/fixture/user-1/auth');
    assert.equal(lastHeaders.authorization, undefined);
    assert.equal(releases, 2);

    let notifyReached: (() => void) | null = null;
    let notifyAborted: (() => void) | null = null;
    const reached = new Promise<void>(resolve => { notifyReached = resolve; });
    const aborted = new Promise<void>(resolve => { notifyAborted = resolve; });
    holdUpstream = (_req, res) => { res.once('close', () => notifyAborted?.()); notifyReached?.(); };
    const disconnect = get(url); disconnect.on('error', () => {});
    await reached; disconnect.destroy();
    await aborted; await flush();
    assert.equal(releases, 3);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
  }
});
