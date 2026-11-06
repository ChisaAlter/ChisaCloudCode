import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request as httpRequest, type IncomingMessage } from 'node:http';
import test from 'node:test';

import express from 'express';

import { createHttpIngressPolicy } from '../http-ingress.service.js';

async function fixture(env: NodeJS.ProcessEnv, run: (request: (path: string, headers?: Record<string, string>, method?: string) => Promise<{ status: number; headers: IncomingMessage['headers']; body: string }>) => Promise<void>) {
  const app = express();
  const policy = createHttpIngressPolicy({ SERVER_PORT: '3001', CHISA_ALLOWED_HOSTS: 'app.example:3001', ...env });
  policy.assertStartup(); policy.install(app);
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.post('/api/auth/login', (_req, res) => res.json({ public: true }));
  app.all('/api/workspace-runtime/preview/:cap/*', (_req, res) => res.status(404).json({ previewVerifier: true }));
  app.get('/source', (req, res) => res.json({ ip: req.ip, protocol: req.protocol, hostname: req.hostname }));
  const server = createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const request = (path: string, headers: Record<string, string> = {}, method = 'GET') => new Promise<{ status: number; headers: IncomingMessage['headers']; body: string }>((resolve, reject) => {
    const outgoing = httpRequest({ host: '127.0.0.1', port: address.port, path, method, headers: { Host: 'app.example:3001', ...headers } }, response => {
      let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body }));
    });
    outgoing.once('error', reject); outgoing.end();
  });
  try { await run(request); }
  finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

test('real HTTP public routes remain reachable with security headers and exact same-origin CORS', async () => {
  await fixture({}, async request => {
    const health = await request('/health'); assert.equal(health.status, 200);
    assert.equal(health.headers['x-content-type-options'], 'nosniff');
    assert.equal(health.headers['referrer-policy'], 'no-referrer');
    assert.equal(health.headers['x-frame-options'], 'SAMEORIGIN');
    assert.match(String(health.headers['content-security-policy']), /frame-ancestors 'self'/);
    assert.equal(health.headers['x-powered-by'], undefined);
    const login = await request('/api/auth/login', { Origin: 'http://app.example:3001' }, 'POST');
    assert.equal(login.status, 200); assert.equal(login.headers['access-control-allow-origin'], 'http://app.example:3001');
    const preflight = await request('/api/auth/login', { Origin: 'http://app.example:3001', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' }, 'OPTIONS');
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers['access-control-allow-origin'], 'http://app.example:3001');
    const preview = await request('/api/workspace-runtime/preview/' + 'a'.repeat(64) + '/hmr', { Origin: 'null' });
    assert.equal(preview.status, 404); assert.deepEqual(JSON.parse(preview.body), { previewVerifier: true });
    assert.equal((await request('/api/workspace-runtime/preview/not-cap/hmr', { Origin: 'null' })).status, 403);
    for (const headers of ([{ Host: 'app.example.evil:3001' }, { Host: 'evil.test:3001', 'X-Forwarded-Host': 'app.example:3001' },
      { Origin: 'http://app.example.evil:3001' }, { Origin: 'null' }, { Origin: 'http://app.example:3001/' }, { 'Sec-Fetch-Site': 'cross-site' }] as Record<string, string>[])) {
      assert.equal((await request('/health', headers)).status, 403, JSON.stringify(headers));
    }
  });
});

test('explicit cross-origin allowlist is exact, preflight headers are bounded and forged proxy headers do not change identity', async () => {
  await fixture({ CHISA_ALLOWED_ORIGINS: 'https://ui.example' }, async request => {
    assert.equal((await request('/health', { Origin: 'https://ui.example' })).status, 200);
    assert.equal((await request('/health', { Origin: 'https://ui.example.evil' })).status, 403);
    assert.equal((await request('/health', { Origin: 'https://ui.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-arbitrary' }, 'OPTIONS')).status, 403);
    const source = JSON.parse((await request('/source', { 'X-Forwarded-For': '198.51.100.9', 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'evil.test' })).body);
    assert.equal(source.ip, '127.0.0.1'); assert.equal(source.protocol, 'http'); assert.equal(source.hostname, 'app.example');
    assert.equal((await request('/health', { Origin: 'https://app.example:3001', 'X-Forwarded-Proto': 'https' })).status, 403);
  });
  await fixture({ CHISA_TRUSTED_PROXIES: '127.0.0.1' }, async request => {
    const source = JSON.parse((await request('/source', { 'X-Forwarded-For': '198.51.100.9, 192.0.2.1', 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'evil.test' })).body);
    assert.equal(source.ip, '192.0.2.1', 'only the direct trusted hop may influence source');
    assert.equal(source.hostname, 'app.example'); assert.equal(source.protocol, 'https');
    assert.equal((await request('/health', { Origin: 'https://app.example:3001', 'X-Forwarded-Proto': 'https' })).status, 200);
    assert.equal((await request('/health', { Origin: 'https://app.example:3001', 'X-Forwarded-Proto': 'https,http' })).status, 403);
  });
});

test('platform bypass refuses public/proxied startup and malformed broad ingress configuration', () => {
  for (const env of [{ VITE_IS_PLATFORM: 'true' }, { IS_PLATFORM: 'true', HOST: '0.0.0.0', CHISA_ALLOW_PLATFORM_LOOPBACK: '1' },
    { VITE_IS_PLATFORM: 'true', HOST: '127.0.0.1', CHISA_ALLOW_PLATFORM_LOOPBACK: '1', CHISA_TRUSTED_PROXIES: '127.0.0.1' },
    { VITE_IS_PLATFORM: 'true', HOST: '127.0.0.1', CHISA_ALLOW_PLATFORM_LOOPBACK: '1', CHISA_ALLOWED_HOSTS: 'public.example:3001' }]) {
    assert.throws(() => createHttpIngressPolicy(env).assertStartup(), /IS_PLATFORM/);
  }
  assert.doesNotThrow(() => createHttpIngressPolicy({ VITE_IS_PLATFORM: 'true', HOST: '127.0.0.1', CHISA_ALLOW_PLATFORM_LOOPBACK: '1' }).assertStartup());
  for (const env of [{ CHISA_ALLOWED_HOSTS: '2130706433:3001' }, { CHISA_ALLOWED_HOSTS: '127.1:3001' }, { CHISA_ALLOWED_HOSTS: 'localhost:03001' }, { CHISA_ALLOWED_HOSTS: '*' }, { CHISA_ALLOWED_ORIGINS: '*' }, { CHISA_ALLOWED_ORIGINS: 'https://ui.example/' }, { CHISA_TRUSTED_PROXIES: 'loopback' }, { CHISA_TRUSTED_PROXIES: '127.0.0.0/8' }]) {
    assert.throws(() => createHttpIngressPolicy(env));
  }
});

test('originless upgrades require explicit loopback native bearer policy and exact allowed host', () => {
  const policy = createHttpIngressPolicy({ CHISA_TRUSTED_PROXIES: '127.0.0.1', CHISA_ALLOW_NATIVE_HEADER_WS: '1' });
  const request = { headers: { host: '127.0.0.1:3001', authorization: 'Bearer native' }, socket: { remoteAddress: '::ffff:127.0.0.1' } } as IncomingMessage;
  assert.equal(policy.authorizeUpgrade(request, true), true);
  assert.equal(policy.authorizeUpgrade(request, false), false);
  assert.equal(createHttpIngressPolicy({}).authorizeUpgrade(request, true), false);
  request.headers.origin = 'null'; assert.equal(policy.authorizeUpgrade(request, true), false);
  request.url = '/api/workspace-runtime/preview/' + 'a'.repeat(64) + '/hmr';
  assert.equal(policy.authorizePreviewUpgrade(request), true);
  for (const suffix of ['//hmr', '/%2fhmr', '/%252fhmr', '/a/../hmr']) {
    request.url = '/api/workspace-runtime/preview/' + 'a'.repeat(64) + suffix;
    assert.equal(policy.authorizePreviewUpgrade(request), false);
  }
  request.url = '/api/workspace-runtime/preview/' + 'a'.repeat(64) + '/hmr';
  request.headers.host = 'evil.test'; assert.equal(policy.authorizePreviewUpgrade(request), false);
  request.headers.host = '127.0.0.1:3001'; request.url = '/ws'; assert.equal(policy.authorizePreviewUpgrade(request), false);
  delete request.headers.origin; request.headers.host = 'evil.test'; assert.equal(policy.authorizeUpgrade(request, true), false);
});
