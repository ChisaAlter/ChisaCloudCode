import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { createSystemRouter } from '../system.routes.js';
import type { createSystemUpdateService } from '../system.service.js';

test('version endpoint returns its startup identity without executing the update service', async () => {
  let updates = 0;
  const service = { updateSystem: async () => { updates++; throw new Error('must not execute'); } } as ReturnType<typeof createSystemUpdateService>;
  const identity = { version: null, commit: null, dirty: null, builtAt: null };
  const app = express();
  app.use(createSystemRouter(service, identity));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const response = await fetch(`http://127.0.0.1:${address.port}/version`);
    assert.deepEqual(await response.json(), identity);
    assert.equal(updates, 0);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
