import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import https from 'node:https';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import express from 'express';

import { createDesktopGateway } from '../index.js';

const jwt = createRequire(import.meta.url)('jsonwebtoken') as {
  sign(payload: object, secret: string): string;
  verify(token: string, secret: string): unknown;
};

test('gateway routes login and enrollment to the account instance, replacing only trusted connection metadata', async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'chisa-gateway-'));
  const keyPath = path.join(fixture, 'key.pem');
  const certPath = path.join(fixture, 'cert.pem');
  const openssl = process.platform === 'win32' ? 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe' : 'openssl';
  await promisify(execFile)(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath,
    '-out', certPath, '-subj', '/CN=localhost', '-days', '1'], { timeout: 15_000 });
  const hosts: string[] = [];
  const instances = ['main', 'user2'].map((id) => {
    const app = express();
    app.use(express.json());
    app.post('/api/auth/login', (request, response) => {
      response.json({ token: jwt.sign({ userId: 1, username: request.body.username }, id + '-secret'), user: { id: 1 } });
    });
    app.use((request, response, next) => {
      try { jwt.verify((request.headers.authorization ?? '').split(' ')[1], id + '-secret'); next(); }
      catch { response.setHeader('X-Auth-Error', 'invalid-token'); response.status(401).json({ error: 'Wrong instance' }); }
    });
    app.post('/api/workspace-sync/enroll', (request, response) => {
      hosts.push(request.get('host') ?? '');
      response.setHeader('X-Refreshed-Token', 'updated-' + id);
      response.json({ sshHost: 'untrusted.example', workspaceServerUrl: 'http://untrusted.example', sshPort: 32022,
        sshUser: 'root', hostKey: 'host-key-' + id, controlHost: '172.17.0.8', workspaceRoot: '/srv/workspaces/' + id });
    });
    app.get('/api/auth/user', (_request, response) => response.json({ user: { id: 1 } }));
    return app.listen(0, '127.0.0.1');
  });
  await Promise.all(instances.map(server => once(server, 'listening')));
  const configuration = Object.fromEntries(instances.map((server, index) => [index === 0 ? 'main' : 'user2', {
    port: (server.address() as AddressInfo).port, workspaceServerUrl: `http://trusted.example:${8791 + index}`,
  }]));
  const gateway = createDesktopGateway({ key: await readFile(keyPath), cert: await readFile(certPath),
    instances: configuration, accounts: { secondAccount: 'user2' }, defaultInstance: 'main' });
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  const port = (gateway.address() as AddressInfo).port;
  const request = (endpoint: string, method: string, body?: unknown, token?: string) => new Promise<{
    status: number; headers: import('node:http').IncomingHttpHeaders; body: Record<string, unknown>;
  }>((resolve, reject) => {
    const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const outgoing = https.request({ hostname: '127.0.0.1', port, path: endpoint, method, rejectUnauthorized: false,
      headers: { ...(bytes ? { 'Content-Type': 'application/json', 'Content-Length': bytes.length } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) } }, incoming => {
      const chunks: Buffer[] = [];
      incoming.on('data', chunk => chunks.push(Buffer.from(chunk)));
      incoming.on('error', reject);
      incoming.on('end', () => resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> }));
    });
    outgoing.on('error', reject);
    outgoing.end(bytes);
  });
  try {
    const malformed = await request('//%/', 'GET');
    assert.equal(malformed.status, 404);
    await new Promise<void>((resolve, reject) => {
      const outgoing = https.request({ hostname: '127.0.0.1', port, path: '//%/', method: 'GET', rejectUnauthorized: false,
        headers: { Connection: 'Upgrade', Upgrade: 'websocket' } }, incoming => {
        assert.equal(incoming.statusCode, 404);
        incoming.resume();
        incoming.on('end', resolve);
        incoming.on('error', reject);
      });
      outgoing.on('error', reject);
      outgoing.end();
    });
    const login = await request('/api/auth/login', 'POST', { username: 'secondAccount', password: 'fixture' });
    assert.equal(login.status, 200);
    assert.equal(login.body.instancePath, '/instances/user2');
    assert.equal(login.body.workspaceServerUrl, 'http://trusted.example:8792');
    const token = String(login.body.token);
    const enrolled = await request('/instances/user2/api/workspace-sync/enroll', 'POST', { publicKey: 'fixture-public-key' }, token);
    assert.equal(enrolled.status, 200);
    assert.deepEqual(enrolled.body, { sshHost: 'trusted.example', workspaceServerUrl: 'http://trusted.example:8792', sshPort: 32022,
      sshUser: 'root', hostKey: 'host-key-user2', controlHost: '172.17.0.8', workspaceRoot: '/srv/workspaces/user2' });
    assert.equal(enrolled.headers['x-refreshed-token'], 'updated-user2');
    assert.equal(hosts[0], '127.0.0.1:' + configuration.user2.port);
    const crossed = await request('/instances/main/api/workspace-sync/enroll', 'POST', { publicKey: 'fixture-public-key' }, token);
    assert.equal(crossed.status, 401);
    assert.equal(crossed.headers['x-auth-error'], 'invalid-token');
    const restored = await request('/instances/user2/api/auth/user', 'GET', undefined, token);
    assert.equal(restored.status, 200);
    assert.equal(restored.headers['x-chisa-instance-path'], '/instances/user2');
    assert.equal(restored.headers['x-chisa-workspace-server-url'], 'http://trusted.example:8792');
  } finally {
    gateway.closeAllConnections();
    await new Promise<void>(resolve => gateway.close(() => resolve()));
    await Promise.all(instances.map(async server => {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }));
    await rm(fixture, { recursive: true, force: true });
  }
});
