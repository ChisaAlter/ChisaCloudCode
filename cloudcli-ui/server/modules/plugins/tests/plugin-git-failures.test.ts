import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import { AppError } from '@/shared/index.js';

import { createPluginsRouter } from '../plugins.routes.js';
import { createPluginsService } from '../plugins.service.js';

// The real service's ownership check must run even when these routes are mounted behind authentication elsewhere.
test('network install and arbitrary token mutations cannot run plugin commands', async () => {
  const operations: string[] = [];
  const service = createPluginsService({
    scanPlugins: () => [], readConfig: () => ({}), saveConfig: () => { operations.push('save'); },
    getPluginDirectory: () => null, resolveAsset: () => null, assetIsFile: () => false, contentType: () => 'text/plain',
    startServer: async () => { operations.push('start'); return 4000; }, stopServer: async () => { operations.push('stop'); },
    getServerPort: () => undefined, isServerRunning: () => false, activeUserIds: () => ['1'],
  });
  const app = express().use(express.json()).use((req, _res, next) => {
    const id = req.headers['x-fixture-user']; if (id) Object.assign(req, { user: { id } }); next();
  }).use('/api/plugins', createPluginsRouter(service));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    assert.ok(error instanceof AppError); res.status(error.statusCode).json({ code: error.code });
  });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/plugins`;
    for (const user of ['', '2', '1']) {
      const response = await fetch(`${base}/install`, { method: 'POST', headers: { 'content-type': 'application/json', ...(user ? { 'x-fixture-user': user } : {}) }, body: JSON.stringify({ url: 'https://example.invalid/plugin.git' }) });
      assert.equal(response.status, user === '1' ? 400 : 401);
      assert.equal((await response.json() as { code: string }).code, user === '1' ? 'PLUGIN_LOCAL_REVIEW_REQUIRED' : 'UNAUTHORIZED');
    }
    assert.deepEqual(operations, []);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
