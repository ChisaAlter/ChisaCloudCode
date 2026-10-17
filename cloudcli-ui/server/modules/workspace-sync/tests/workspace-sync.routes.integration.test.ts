import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import test, { mock } from 'node:test';

import express from 'express';
import type { ErrorRequestHandler } from 'express';

const jwt = createRequire(import.meta.url)('jsonwebtoken') as {
  sign(payload: object, secret: string, options?: { expiresIn: string }): string;
};

test('managed workspace endpoints require this instance JWT and reject private keys or foreign paths', async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'chisa-sync-routes-'));
  const root = path.join(fixture, 'workspaces');
  const foreign = path.join(fixture, 'other-instance', 'project');
  await mkdir(root, { recursive: true });
  await mkdir(foreign, { recursive: true });
  process.env.WORKSPACES_ROOT = root;
  process.env.DATABASE_PATH = path.join(fixture, 'auth.db');
  process.env.JWT_SECRET = 'workspace-route-instance-secret';
  process.env.VITE_IS_PLATFORM = 'false';
  await writeFile(process.env.DATABASE_PATH, '');
  const database = await import('@/modules/database/index.js');
  await database.initializeDatabase();
  const account = database.userDb.createUser('sync-route-account', 'unused-test-password-hash');
  const { authenticateToken } = await import('@/modules/auth/index.js');
  // This route fixture covers JWT and input boundaries; real Linux transport restoration has its own Docker acceptance.
  const realSyncService = await import('../workspace-sync.service.js');
  let migrationBlocked = false;
  let restorationCalls = 0;
  mock.module('../workspace-sync.service.js', { namedExports: {
    createWorkspaceSyncService: () => ({ ...realSyncService.createWorkspaceSyncService(), restore: async () => {
      restorationCalls++;
      if (migrationBlocked) throw Object.assign(new Error('Active work blocks network migration'), { code: 'MIGRATION_BLOCKED' });
    } }),
  } });
  const { createWorkspaceSyncRouter } = await import('../index.js');
  const { AppError } = await import('@/shared/index.js');
  const app = express();
  app.use(express.json());
  app.use('/api/workspace-sync', authenticateToken, createWorkspaceSyncRouter());
  const errors: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
    if (error instanceof AppError) response.status(error.statusCode).json({ error: { code: error.code, message: error.message } });
    else response.status(500).json({ error: String(error) });
  };
  app.use(errors);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/workspace-sync`;
  const token = jwt.sign({ userId: Number(account.id), username: account.username }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const otherToken = jwt.sign({ userId: Number(account.id), username: account.username }, 'other-instance-secret', { expiresIn: '1h' });
  const post = (endpoint: string, body: unknown, bearer?: string) => fetch(origin + endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: 'Bearer ' + bearer } : {}) },
    body: JSON.stringify(body),
  });
  try {
    for (const endpoint of ['/enroll', '/worker', '/preview', '/lease-recovery']) {
      assert.equal((await post(endpoint, {})).status, 401, endpoint + ' must require login');
      const denied = await post(endpoint, {}, otherToken);
      assert.equal(denied.status, 401, endpoint + ' must reject another instance token');
      assert.equal(denied.headers.get('x-auth-error'), 'invalid-token');
    }
    for (const publicKey of [
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'ssh-ed25519 AAAA\nssh-ed25519 AAAA',
      'command="do-something" ssh-ed25519 AAAA',
      'ssh-rsa AAAA',
      'ssh-ed25519 AAAA',
    ]) {
      const rejected = await post('/enroll', { publicKey }, token);
      assert.equal(rejected.status, 400);
      assert.equal((await rejected.json() as { error: { code: string } }).error.code, 'WORKSPACE_SYNC_KEY_INVALID');
    }
    const refreshed = jwt.sign({ userId: Number(account.id), username: account.username, iat: Math.floor(Date.now() / 1000) - 4 * 86400 },
      process.env.JWT_SECRET, { expiresIn: '7d' });
    const refreshResponse = await post('/enroll', { publicKey: 'not-a-key' }, refreshed);
    assert.equal(refreshResponse.status, 400);
    assert.ok(refreshResponse.headers.get('x-refreshed-token'));
    assert.equal((await post('/enroll?token=' + token, {})).status, 401, 'query-token authentication cannot enroll a machine');
    for (const candidate of [foreign, root]) {
      assert.equal((await post('/worker', { serverPath: candidate, bindingEpoch: 'epoch', request: { op: 'stat', path: '/workspace' } }, token)).status, 403);
      assert.equal((await post('/preview', { op: 'start', serverPath: candidate, bindingEpoch: 'epoch', command: 'node server.js', cwd: '/workspace', port: 3000 }, token)).status, 403);
      assert.equal((await post('/lease-recovery', { serverPath: candidate, bindingEpoch: 'epoch' }, token)).status, 403);
    }
    const project = path.join(root, 'bound-project');
    await mkdir(project);
    await writeFile(path.join(project, '.chisa-bridge.json'), JSON.stringify({ protocol: 2, port: 18082, token: 'fixture', bindingEpoch: 'new-epoch', vps: true }));
    const stale = await post('/worker', { serverPath: project, bindingEpoch: 'old-epoch', request: { op: 'stat', path: '/workspace' } }, token);
    assert.equal(stale.status, 409);
    migrationBlocked = true;
    for (const op of ['inspect', 'logs', 'remove']) {
      const previousCalls = restorationCalls;
      const result = await post('/preview', { op, id: 'foreign-preview' }, token);
      assert.equal(result.status, 404, 'owner validation must still protect preview drain');
      assert.equal(restorationCalls, previousCalls, 'drain must not wait for migration');
    }
    const previousCalls = restorationCalls;
    const recovered = await post('/lease-recovery', { serverPath: project, bindingEpoch: 'new-epoch' }, token);
    assert.equal(recovered.status, 200, 'a reservation must remain recoverable before network migration');
    assert.equal(restorationCalls, previousCalls);
    assert.equal((await post('/worker', { serverPath: project, bindingEpoch: 'new-epoch', request: { op: 'stat' } }, token)).status, 500);
    assert.equal(restorationCalls, previousCalls + 1, 'new work must not bypass blocked migration');
    process.env.VITE_IS_PLATFORM = 'true';
    assert.equal((await post('/enroll', { publicKey: 'not-a-key' }, token)).status, 401, 'platform bypass must not issue SSH access');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    database.closeConnection();
    await rm(fixture, { recursive: true, force: true });
  }
});
