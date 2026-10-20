import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { Options } from '@anthropic-ai/claude-agent-sdk';
import express, { type NextFunction, type Request, type Response } from 'express';

import { closeConnection, credentialsDb, getConnection, initializeDatabase, userDb } from '@/modules/database/index.js';
import providerRouter from '@/modules/providers/provider.routes.js';
import { hirouteService } from '@/modules/providers/services/hiroute.service.js';
import { AppError } from '@/shared/utils.js';

const input = { enabled: true, baseUrl: 'http://127.0.0.1:46559/', routeModel: 'plan/example', authToken: 'gateway-grant-fixture' };

test('HiRoute settings validate, isolate users, retain/redact grants and apply gateway SDK options', async () => {
  const previousPath = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chisa-hiroute-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'test.db');
  // An existing empty SQLite file prevents initialization from migrating the legacy database.
  await writeFile(process.env.DATABASE_PATH, '', { flag: 'wx' });
  await initializeDatabase();
  assert.equal((getConnection().prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count, 0);
  const firstUser = Number(userDb.createUser('hiroute-first', 'fixture').id);
  const secondUser = Number(userDb.createUser('hiroute-second', 'fixture').id);

  const app = express().use(express.json()).use((req, _res, next) => {
    // Identity is supplied by authentication, never by the HiRoute body.
    if (req.headers['x-test-user']) Object.assign(req, { user: { id: Number(req.headers['x-test-user']) } });
    next();
  }).use('/api/providers', providerRouter);
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof AppError) res.status(error.statusCode).json({ success: false, error: { code: error.code, message: error.message } });
    else res.status(500).json({ success: false });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/providers/claude/hiroute`;
  const save = (value: unknown, id = firstUser) => fetch(url, {
    method: 'PUT', headers: { 'content-type': 'application/json', 'x-test-user': String(id) }, body: JSON.stringify(value),
  });
  try {
    assert.equal((await fetch(url)).status, 401);
    assert.deepEqual(hirouteService.getSettings(firstUser), { enabled: false, baseUrl: '', routeModel: '', hasAuthToken: false });
    for (const invalid of [
      { ...input, enabled: 'true' }, { ...input, authToken: 'header\ninjection' },
      { ...input, baseUrl: 'file:///tmp/gateway' }, { ...input, baseUrl: 'http://user:pass@localhost' },
      { ...input, baseUrl: 'http://localhost/v1/messages' }, { ...input, baseUrl: 'http://localhost/v1' },
      { ...input, routeModel: 'two models' }, { ...input, userId: secondUser },
      { ...input, authToken: '' },
    ]) {
      assert.equal((await save(invalid)).status, 400);
    }
    const saved = await save(input);
    assert.equal(saved.status, 200);
    const body = await saved.text();
    assert.equal(body.includes(input.authToken), false);
    assert.deepEqual(JSON.parse(body).data, { enabled: true, baseUrl: 'http://127.0.0.1:46559', routeModel: 'plan/example', hasAuthToken: true });
    const read = await fetch(url, { headers: { 'x-test-user': String(firstUser) } });
    assert.equal((await read.text()).includes(input.authToken), false);
    assert.equal(hirouteService.getActiveConnection(secondUser), null);
    assert.equal(hirouteService.getActiveConnection(undefined), null);
    assert.equal(hirouteService.getSettings(secondUser).hasAuthToken, false);

    assert.equal((await save({ enabled: true, baseUrl: input.baseUrl, routeModel: 'plan/updated' })).status, 200);
    assert.equal(hirouteService.getActiveConnection(firstUser)?.authToken, input.authToken);
    credentialsDb.createCredential(firstUser, 'Unrelated credential', 'hiroute_connection', '{}');
    assert.equal(hirouteService.getActiveConnection(firstUser)?.authToken, input.authToken);
    assert.equal(credentialsDb.getCredentials(firstUser).some(row => JSON.stringify(row).includes(input.authToken)), false);
    assert.equal((await save({ enabled: true, baseUrl: 'http://localhost:9999', routeModel: 'plan/updated' })).status, 400);

    const hostEnv = { PATH: 'fixture-path', ANTHROPIC_API_KEY: 'host-key', CLAUDE_CODE_OAUTH_TOKEN: 'host-oauth', ANTHROPIC_CUSTOM_HEADERS: 'Authorization: host-secret' };
    const options: Options = {
      model: 'sonnet', fallbackModel: 'opus', effort: 'high', env: { ...hostEnv },
      settingSources: ['project', 'user', 'local'], resume: 'existing-session',
      settings: { ultracode: true, enableWorkflows: true, env: { ANTHROPIC_API_KEY: 'settings-key' }, permissions: { allow: ['Read'] } },
    };
    hirouteService.applyToOptions(options, hirouteService.getActiveConnection(firstUser));
    assert.equal(options.model, 'plan/updated');
    assert.equal(options.fallbackModel, undefined);
    assert.equal(options.effort, undefined);
    assert.equal(options.env?.ANTHROPIC_AUTH_TOKEN, input.authToken);
    assert.equal(options.env?.ANTHROPIC_API_KEY, '');
    assert.equal(options.env?.CLAUDE_CODE_OAUTH_TOKEN, '');
    assert.equal(options.env?.ANTHROPIC_CUSTOM_HEADERS, '');
    assert.equal(options.env?.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'plan/updated');
    assert.equal(options.env?.CLAUDE_CODE_SUBAGENT_MODEL, 'plan/updated');
    assert.equal(options.env?.PATH, 'fixture-path');
    assert.equal(options.resume, 'existing-session');
    assert.deepEqual(options.settingSources, ['project', 'user', 'local']);
    assert.equal(typeof options.settings, 'object');
    if (typeof options.settings === 'object') {
      assert.equal(options.settings.env?.ANTHROPIC_AUTH_TOKEN, input.authToken);
      assert.equal(options.settings.ultracode, undefined);
      assert.deepEqual(options.settings.permissions, { allow: ['Read'] });
    }
    assert.equal(hostEnv.ANTHROPIC_API_KEY, 'host-key');
    const original: Options = { model: 'sonnet', env: hostEnv, effort: 'high' };
    hirouteService.applyToOptions(original, null);
    assert.deepEqual(original, { model: 'sonnet', env: hostEnv, effort: 'high' });

    assert.equal((await save({ enabled: false, baseUrl: input.baseUrl, routeModel: 'plan/updated', authToken: null })).status, 200);
    assert.equal(hirouteService.getSettings(firstUser).hasAuthToken, false);
    assert.equal(hirouteService.getActiveConnection(firstUser), null);
    getConnection().prepare('UPDATE hiroute_connections SET connection_json = ? WHERE user_id = ?').run('{}', firstUser);
    assert.throws(() => hirouteService.getActiveConnection(firstUser), /Stored HiRoute configuration is invalid/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    closeConnection();
    if (previousPath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
});
