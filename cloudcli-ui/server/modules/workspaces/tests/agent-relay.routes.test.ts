import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import express, { type ErrorRequestHandler } from 'express';

import { agentWorkspaceConnectionsDb, closeConnection, getConnection, initializeDatabase } from '@/modules/database/index.js';
import { agentRelayBroker } from '@/modules/ssh-workspaces/index.js';
import { AppError } from '@/shared/index.js';

mock.module('@/modules/workspace-bridge/index.js', { namedExports: {
  assertSshProjectOwner() { assert.fail('No project operation is permitted in relay routes'); },
  recoverSshWorkspace() { assert.fail('No project recovery is permitted in relay routes'); },
  resolveSshProjectTarget() { assert.fail('No project path lookup is permitted in relay routes'); },
} });
mock.module('@/modules/projects/index.js', { namedExports: {
  probeSshProjectDirectory() { assert.fail('Relay routes must not probe or reveal projects'); },
} });
const { createSshWorkspacesRouter } = await import('../ssh-workspaces.routes.js');
const tokenA = 'a'.repeat(64), tokenB = 'b'.repeat(64);

test('real HTTP relay registration is account fenced, private, rotated and correlated', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chisa-relay-api-'));
  const previous = process.env.DATABASE_PATH;
  closeConnection(); process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await writeFile(process.env.DATABASE_PATH, '');
  await initializeDatabase();
  const app = express(); app.use(express.json({ limit: '24mb' }));
  app.use((request, _response, next) => { (request as express.Request & { user?: { id: string } }).user = { id: String(request.headers['x-test-owner'] ?? 'owner') }; next(); });
  app.use('/api/ssh-workspaces', createSshWorkspacesRouter());
  app.use(((error, _request, response, _next) => response.status(error instanceof AppError ? error.statusCode : 500).json({ code: error.code })) as ErrorRequestHandler);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ssh-workspaces`;
  const headers = (token = tokenA, owner = 'owner') => ({ 'content-type': 'application/json', 'x-test-owner': owner, 'X-Chisa-Agent-Token': token });
  const register = async (token = tokenA, owner = 'owner') => fetch(base + '/agent/connections', { method: 'POST', headers: headers(token, owner), body: JSON.stringify({ id: 'desktop', name: 'Built-in desktop', port: 18766, token, delivery: 'relay' }) });
  try {
    const registration = await register();
    assert.equal(registration.status, 200);
    const safe = await registration.text();
    assert.equal(safe.includes(tokenA), false); assert.match(safe, /"delivery":"relay"/);
    const catalog = await (await fetch(base + '/connections', { headers: headers() })).text();
    assert.equal(catalog.includes(tokenA), false);
    const poll = (token = tokenA, owner = 'owner', wait = '0') => fetch(base + '/agent/relay/poll?connectionId=desktop&wait=' + wait, { headers: headers(token, owner) });
    assert.equal((await poll()).status, 200);
    assert.equal((await poll(tokenB)).status, 401);
    assert.equal((await poll(tokenA, 'foreign')).status, 401);
    const operation = agentRelayBroker.call('owner', 'desktop', tokenA, { protocol: 1, request: { op: 'probe' } });
    const received = await poll(tokenA, 'owner', '1');
    const batch = await received.json() as { jobs: Array<{ requestId: string; payload: unknown }> };
    assert.equal(batch.jobs.length, 1);
    const result = await fetch(base + '/agent/relay/result', { method: 'POST', headers: headers(), body: JSON.stringify({ connectionId: 'desktop', requestId: batch.jobs[0].requestId, response: { status: 200, body: '{"ok":true}' } }) });
    assert.equal(result.status, 200); assert.deepEqual(await operation, { status: 200, body: '{"ok":true}' });
    // Same-token registration is an idempotent retry, not a new session.
    const waiting = agentRelayBroker.call('owner', 'desktop', tokenA, { request: { op: 'read' } });
    assert.equal((await register()).status, 200);
    const oldFailure = assert.rejects(waiting, { code: 'AGENT_RELAY_REPLACED' });
    assert.equal((await register(tokenB)).status, 200); await oldFailure;
    assert.equal((await poll(tokenA)).status, 401); assert.equal((await poll(tokenB)).status, 200);
    assert.equal(agentWorkspaceConnectionsDb.get('owner', 'desktop')?.delivery, 'relay');
    assert.equal((await fetch(base + '/agent/connections/desktop', { method: 'DELETE', headers: headers(tokenB, 'foreign') })).status, 404);
    assert.equal((await fetch(base + '/agent/connections/desktop', { method: 'DELETE', headers: headers(tokenB) })).status, 200);
    assert.equal((await poll(tokenB)).status, 401);
    assert.equal((getConnection().prepare('SELECT count(*) AS total FROM agent_workspace_connections').get() as { total: number }).total, 0);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    closeConnection(); if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous;
    assert.equal(path.dirname(root), os.tmpdir()); await rm(root, { recursive: true, force: true });
  }
});
