import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import express, { type ErrorRequestHandler } from 'express';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import { agentRelayBroker } from '@/modules/ssh-workspaces/index.js';
import { AppError } from '@/shared/index.js';

mock.module('@/modules/workspace-bridge/index.js', { namedExports: {
  assertSshProjectOwner() { assert.fail('No project operation is permitted in relay routes'); },
  recoverSshWorkspace() { assert.fail('No project recovery is permitted in relay routes'); },
  resolveSshProjectTarget() { assert.fail('No project path lookup is permitted in relay routes'); },
} });
mock.module('@/modules/projects/index.js', { namedExports: {
  probeSshProjectDirectory() { assert.fail('Relay routes must not probe projects'); },
} });
const { createSshWorkspacesRouter } = await import('../ssh-workspaces.routes.js');
const token = 'c'.repeat(64);

test('real HTTP V2 negotiates epoch, ACKs durable receives, cancels obsolete jobs and exposes safe diagnostics', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chisa-relay-v2-api-'));
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
  const headers = { 'content-type': 'application/json', 'X-Chisa-Agent-Token': token };
  const post = (suffix: string, body: unknown, extraHeaders: Record<string, string> = {}) => fetch(base + suffix, { method: 'POST', headers: { ...headers, ...extraHeaders }, body: JSON.stringify(body) });
  const controllers: AbortController[] = [];
  const calls: Promise<unknown>[] = [];
  try {
    const registration = await post('/agent/connections', { id: 'desktop-v2', name: 'V2 desktop', port: 18766, token, delivery: 'relay' });
    assert.equal(registration.status, 200);
    const poll = (wait: string) => fetch(base + '/agent/relay/poll?connectionId=desktop-v2&protocol=2&wait=' + wait, { headers });
    const ready = await (await poll('0')).json() as { protocol: number; epoch: string; jobs: unknown[] };
    assert.equal(ready.protocol, 2); assert.match(ready.epoch, /^[a-f0-9-]{36}$/); assert.deepEqual(ready.jobs, []);
    const deadlineAt = Date.now() + 10_000;
    const controller = new AbortController(); controllers.push(controller);
    const call = agentRelayBroker.call('owner', 'desktop-v2', token, { request: { op: 'read' } }, controller.signal, { deadlineAt });
    calls.push(call.catch(error => error));
    const received = await (await poll('1')).json() as { epoch: string; jobs: Array<{ requestId: string; deadlineAt: number }> };
    assert.equal(received.epoch, ready.epoch); assert.equal(received.jobs.length, 1); assert.equal(received.jobs[0].deadlineAt, deadlineAt);
    const requestId = received.jobs[0].requestId;
    const body = { connectionId: 'desktop-v2', epoch: ready.epoch, requestId };
    const missingAck = await post('/agent/relay/result', { ...body, response: { status: 200, body: 'early' } });
    assert.equal(missingAck.status, 409);
    assert.deepEqual(await (await post('/agent/relay/ack', { ...body, epoch: randomUUID() })).json(), { ok: true, accepted: false, epoch: ready.epoch });
    assert.deepEqual(await (await post('/agent/relay/ack', body)).json(), { ok: true, accepted: true, epoch: ready.epoch });
    assert.deepEqual(await (await post('/agent/relay/ack', body)).json(), { ok: true, accepted: true, epoch: ready.epoch });
    const heartbeat = await post('/agent/relay/heartbeat', { connectionId: 'desktop-v2', epoch: ready.epoch, activeRequestIds: [requestId] });
    assert.equal(heartbeat.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await heartbeat.json(), { ok: true, epoch: ready.epoch, obsoleteRequestIds: [] });
    const catalog = await (await fetch(base + '/connections', { headers })).json() as { connections: Array<{ relay: Record<string, unknown> }> };
    assert.equal(catalog.connections[0].relay.protocol, 2);
    assert.equal(catalog.connections[0].relay.pendingCount, 1);
    assert.equal(catalog.connections[0].relay.receivedCount, 1);
    assert.equal(JSON.stringify(catalog).includes(token), false);
    assert.equal(JSON.stringify(catalog).includes(ready.epoch), false);
    assert.equal(JSON.stringify(catalog).includes(requestId), false);
    const resultBody = { ...body, response: { status: 200, body: '{"ok":true}' } };
    assert.deepEqual(await (await post('/agent/relay/result', resultBody)).json(), { ok: true, accepted: true, epoch: ready.epoch });
    assert.deepEqual(await call, resultBody.response);
    assert.deepEqual(await (await post('/agent/relay/result', resultBody)).json(), { ok: true, accepted: false, epoch: ready.epoch });
    assert.equal((await post('/agent/relay/heartbeat', { connectionId: 'desktop-v2', epoch: ready.epoch, activeRequestIds: [1] })).status, 400);
    assert.equal((await post('/agent/relay/heartbeat', { connectionId: 'desktop-v2', epoch: ready.epoch, activeRequestIds: [] }, { 'x-test-owner': 'foreign' })).status, 401);
    const cancelled = new AbortController(); controllers.push(cancelled);
    const active = agentRelayBroker.call('owner', 'desktop-v2', token, { request: { op: 'read' } }, cancelled.signal);
    calls.push(active.catch(error => error));
    const activeJob = (await (await poll('1')).json() as { jobs: Array<{ requestId: string }> }).jobs[0];
    await post('/agent/relay/ack', { ...body, requestId: activeJob.requestId });
    cancelled.abort(); await active.catch(() => {});
    assert.deepEqual(await (await post('/agent/relay/heartbeat', { connectionId: 'desktop-v2', epoch: ready.epoch, activeRequestIds: [requestId, activeJob.requestId] })).json(),
      { ok: true, epoch: ready.epoch, obsoleteRequestIds: [requestId, activeJob.requestId] });
    assert.equal((await post('/agent/relay/ack', { ...body, requestId: activeJob.requestId })).status, 200);
    const denied = agentRelayBroker.call('owner', 'desktop-v2', token, { request: { op: 'write' } });
    calls.push(denied.catch(error => error));
    const deniedJob = (await (await poll('1')).json() as { jobs: Array<{ requestId: string }> }).jobs[0];
    const denial = await post('/agent/relay/reject', { ...body, requestId: deniedJob.requestId });
    assert.equal(denial.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await denial.json(), { ok: true, accepted: true, epoch: ready.epoch });
    const deniedResult = await denied;
    assert.equal(deniedResult.status, 503);
    assert.equal(JSON.parse(deniedResult.body).code, 'AGENT_BUSY');
    assert.deepEqual(await (await post('/agent/relay/ack', { ...body, requestId: deniedJob.requestId })).json(), { ok: true, accepted: false, epoch: ready.epoch });
  } finally {
    for (const controller of controllers) controller.abort();
    await Promise.all(calls);
    agentRelayBroker.invalidate('owner', 'desktop-v2');
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    closeConnection(); if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous;
    assert.equal(path.dirname(root), os.tmpdir()); await rm(root, { recursive: true, force: true });
  }
});
