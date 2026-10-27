import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import express, { type NextFunction, type Request, type Response } from 'express';

import { closeConnection, credentialsDb, getConnection, initializeDatabase, userDb } from '@/modules/database/index.js';
import providerRouter from '@/modules/providers/provider.routes.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { claudeConnectionsService } from '@/modules/providers/services/claude-connections.service.js';
import { hirouteService } from '@/modules/providers/services/hiroute.service.js';
import { providerAuthService } from '@/modules/providers/services/provider-auth.service.js';
import type { ClaudeModelConnections, ProviderAuthStatus } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

const input = { name: 'DeepSeek', baseUrl: 'https://fixture.example/anthropic/', model: 'deepseek-chat', apiKey: 'fixture-private-key' };

test('custom Claude connections enforce CRUD isolation, redaction, validation, activation and SDK authentication', async () => {
  const previousPath = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chisa-connections-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'test.db');
  // An existing empty SQLite file prevents initialization from migrating the legacy database.
  await writeFile(process.env.DATABASE_PATH, '', { flag: 'wx' });
  await initializeDatabase();
  assert.equal((getConnection().prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count, 0);
  const first = Number(userDb.createUser('connection-first', 'fixture').id);
  const second = Number(userDb.createUser('connection-second', 'fixture').id);
  const app = express().use(express.json()).use((req, _res, next) => {
    if (req.headers['x-test-user']) Object.assign(req, { user: { id: Number(req.headers['x-test-user']) } });
    next();
  }).use('/api/providers', providerRouter);
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof AppError) res.status(error.statusCode).json({ success: false, error: { code: error.code, message: error.message } });
    else res.status(500).json({ success: false });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/providers/claude/connections`;
  const request = (method: string, suffix = '', body?: unknown, userId = first) => fetch(url + suffix, {
    method, headers: { 'content-type': 'application/json', 'x-test-user': String(userId) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const snapshot = async (response: globalThis.Response) => (await response.json() as { data: ClaudeModelConnections }).data;
  try {
    assert.equal((await fetch(url)).status, 401);
    assert.deepEqual(await snapshot(await request('GET')), { activeId: null, connections: [] });
    for (const invalid of [
      { ...input, name: '' }, { ...input, name: 'bad\nname' }, { ...input, name: 'x'.repeat(129) },
      { ...input, model: '' }, { ...input, model: 'two models' }, { ...input, model: 'x'.repeat(257) },
      { ...input, apiKey: null }, { ...input, apiKey: '' }, { ...input, apiKey: 'bad\nkey' }, { ...input, apiKey: 'x'.repeat(16385) },
      { ...input, baseUrl: 'file:///tmp/model' }, { ...input, baseUrl: 'https://a:b@fixture.example' },
      { ...input, baseUrl: 'https://fixture.example?secret=1' }, { ...input, baseUrl: 'https://fixture.example#fragment' },
      { ...input, baseUrl: 'https://fixture.example?' }, { ...input, baseUrl: 'https://fixture.example#' },
      { ...input, baseUrl: 'https://fixture.example/v1/' }, { ...input, baseUrl: 'https://fixture.example/prefix/v1/messages' },
      { ...input, baseUrl: 'https://fixture.example/%76%31' }, { ...input, baseUrl: 'https://fixture.example/space path' },
      { ...input, userId: second },
    ]) assert.equal((await request('POST', '', invalid)).status, 400);

    const created = await request('POST', '', input);
    assert.equal(created.status, 201);
    const text = await created.text();
    assert.equal(text.includes(input.apiKey), false);
    assert.equal(text.includes('"apiKey"'), false);
    const state = JSON.parse(text).data as ClaudeModelConnections;
    const id = state.connections[0].id;
    assert.deepEqual(state, { activeId: null, connections: [{ id, name: input.name, baseUrl: 'https://fixture.example/anthropic', model: input.model, hasApiKey: true, authType: 'api_key' }] });
    assert.deepEqual(await snapshot(await request('GET', '', undefined, second)), { activeId: null, connections: [] });
    for (const method of ['PUT', 'DELETE']) assert.equal((await request(method, `/${id}`, method === 'PUT' ? input : undefined, second)).status, 404);
    assert.equal((await request('PUT', '/active', { id }, second)).status, 404);
    assert.equal((await request('PUT', '/active', { id: 'invalid' })).status, 400);
    assert.equal((await request('PUT', '/active', { id, userId: second })).status, 400);

    assert.equal((await request('PUT', `/${id}`, { name: 'Kimi', baseUrl: input.baseUrl, model: 'kimi-k2' })).status, 200);
    assert.equal((await request('PUT', `/${id}`, { name: 'Kimi', baseUrl: input.baseUrl, model: 'kimi-k2', apiKey: '   ' })).status, 200);
    assert.equal((await request('PUT', `/${id}`, { ...input, apiKey: null })).status, 400);
    assert.equal((await request('PUT', `/${id}`, { name: 'Kimi', baseUrl: 'https://another.example/anthropic', model: 'kimi-k2' })).status, 400);
    assert.equal((await request('PUT', `/${id}`, { ...input, baseUrl: 'https://another.example/anthropic', apiKey: 'replacement-key' })).status, 200);
    assert.equal((await request('PUT', `/${id}`, input)).status, 200);
    credentialsDb.createCredential(first, 'unrelated', 'claude_model_connection', '{}');
    assert.equal(credentialsDb.getCredentials(first).some(row => JSON.stringify(row).includes(input.apiKey)), false);

    hirouteService.saveSettings(first, { enabled: true, baseUrl: 'https://gateway.example', routeModel: 'plan/smart', authToken: 'grant-fixture' });
    assert.equal((await request('PUT', '/active', { id })).status, 200);
    assert.equal(hirouteService.getSettings(first).enabled, true);
    assert.equal(claudeConnectionsService.getSettings(first).activeId, id);
    assert.equal(claudeConnectionsService.getActiveConnection(first)?.apiKey, input.apiKey);
    assert.equal(claudeConnectionsService.getActiveConnection(second), null);
    assert.equal(claudeConnectionsService.getActiveConnection(undefined), null);

    const hooks = { SessionStart: [] };
    const options: Options = { model: 'sonnet', fallbackModel: 'opus', effort: 'high', resume: 'prior-session', hooks,
      settingSources: ['user', 'project', 'local'], env: { PATH: 'original-path', ANTHROPIC_AUTH_TOKEN: 'wrong-grant' },
      settings: { apiKeyHelper: 'wrong-helper', env: { ANTHROPIC_API_KEY: 'wrong-key' }, permissions: { allow: ['Read'] } } };
    claudeConnectionsService.applyActiveToOptions(options, first);
    assert.equal(options.model, input.model);
    assert.equal(options.env?.ANTHROPIC_BASE_URL, 'https://fixture.example/anthropic');
    assert.equal(options.env?.ANTHROPIC_API_KEY, input.apiKey);
    assert.equal(options.env?.ANTHROPIC_AUTH_TOKEN, '');
    assert.equal(options.env?.CLAUDE_CODE_OAUTH_TOKEN, '');
    assert.equal(options.env?.ANTHROPIC_CUSTOM_HEADERS, '');
    assert.equal(options.env?.ANTHROPIC_DEFAULT_OPUS_MODEL, input.model);
    assert.equal(options.env?.ANTHROPIC_DEFAULT_HAIKU_MODEL, input.model);
    assert.equal(options.env?.CLAUDE_CODE_SUBAGENT_MODEL, input.model);
    assert.equal(options.env?.PATH, 'original-path');
    assert.equal(options.resume, 'prior-session');
    assert.equal(options.hooks, hooks);
    assert.deepEqual(options.settingSources, ['user', 'project', 'local']);
    assert.equal(options.fallbackModel, undefined);
    assert.equal(options.effort, undefined);
    assert.equal(typeof options.settings, 'object');
    if (typeof options.settings === 'object') {
      assert.equal(options.settings.env?.ANTHROPIC_API_KEY, input.apiKey);
      assert.equal(options.settings.env?.ANTHROPIC_AUTH_TOKEN, '');
      assert.equal(options.settings.apiKeyHelper, '');
      assert.deepEqual(options.settings.permissions, { allow: ['Read'] });
    }
    const originalGetStatus = providerRegistry.resolveProvider('claude').auth.getStatus;
    providerRegistry.resolveProvider('claude').auth.getStatus = async () => ({ provider: 'claude', installed: true, authenticated: false, email: null, method: null });
    try {
      assert.equal((await providerAuthService.getProviderAuthStatus('claude', first)).method, 'model_connection');
      assert.equal((await providerAuthService.getProviderAuthStatus('claude', second)).authenticated, false);
      claudeConnectionsService.activate(first, null);
      // Any saved endpoint enables HiRoute availability without requiring it to be active.
      assert.equal((await providerAuthService.getProviderAuthStatus('claude', first)).method, 'model_connection');
      const nativeStatus: ProviderAuthStatus = { provider: 'claude', installed: true, authenticated: true, email: 'native-fixture', method: 'credentials_file' };
      providerRegistry.resolveProvider('claude').auth.getStatus = async () => nativeStatus;
      const scoped = await providerAuthService.getProviderAuthStatus('claude', first);
      assert.equal(scoped.method, 'model_connection', 'a multi-user server never reports shared native credentials as this caller\'s subscription');
      assert.notEqual(scoped.email, nativeStatus.email);
      providerRegistry.resolveProvider('claude').auth.getStatus = async () => ({ provider: 'claude', installed: true, authenticated: false, email: null, method: null });
      // Corrupt legacy gateway settings cannot interfere with ordinary activation or authentication.
      getConnection().prepare('UPDATE hiroute_connections SET connection_json = ? WHERE user_id = ?').run('{}', first);
      claudeConnectionsService.activate(first, id);
      assert.equal(claudeConnectionsService.getSettings(first).activeId, id);
      const legacyOptions: Options = {};
      claudeConnectionsService.applyActiveToOptions(legacyOptions, first);
      assert.equal(legacyOptions.env?.ANTHROPIC_AUTH_TOKEN, '');
      assert.equal(legacyOptions.env?.ANTHROPIC_API_KEY, input.apiKey);
      assert.equal((await providerAuthService.getProviderAuthStatus('claude', first)).method, 'model_connection');
      getConnection().prepare('UPDATE hiroute_connections SET connection_json = ? WHERE user_id = ?').run(JSON.stringify({ enabled: true, baseUrl: 'https://gateway.example', routeModel: 'plan/smart', authToken: 'grant-fixture' }), first);
      hirouteService.saveSettings(first, { enabled: true, baseUrl: 'https://gateway.example', routeModel: 'plan/smart' });
      assert.equal(claudeConnectionsService.getSettings(first).activeId, id);
      assert.equal((await request('PUT', '/active', { id })).status, 200);
      assert.equal(hirouteService.getSettings(first).enabled, true);
      // A manual gateway alone is not a source for managed HiRoute authentication.
      hirouteService.saveSettings(second, { enabled: true, baseUrl: 'https://other-gateway.example', routeModel: 'plan/manual', authToken: 'other-grant' });
      assert.equal((await providerAuthService.getProviderAuthStatus('claude', second)).authenticated, false);
    } finally { providerRegistry.resolveProvider('claude').auth.getStatus = originalGetStatus; }

    assert.equal((await request('PUT', `/${id}`, { ...input, authType: 'invalid' })).status, 400);
    assert.equal((await request('PUT', `/${id}`, { name: input.name, baseUrl: input.baseUrl, model: input.model, authType: 'auth_token' })).status, 400);
    assert.equal((await request('PUT', `/${id}`, { ...input, authType: 'auth_token' })).status, 200);
    const bearerOptions: Options = {};
    claudeConnectionsService.applyActiveToOptions(bearerOptions, first);
    assert.equal(bearerOptions.env?.ANTHROPIC_AUTH_TOKEN, input.apiKey);
    assert.equal(bearerOptions.env?.ANTHROPIC_API_KEY, '');
    assert.equal(claudeConnectionsService.getSettings(first).connections[0].authType, 'auth_token');
    assert.equal((await request('PUT', `/${id}`, { name: input.name, baseUrl: input.baseUrl, model: input.model })).status, 200);
    assert.equal(claudeConnectionsService.getSettings(first).connections[0].authType, 'auth_token');
    hirouteService.saveSettings(first, { enabled: true, baseUrl: 'https://gateway.example', routeModel: 'plan/smart' });
    assert.equal((await snapshot(await request('PUT', '/active', { id: null }))).activeId, null);
    assert.equal(hirouteService.getSettings(first).enabled, true);
    const ordinary: Options = { model: 'sonnet', resume: 'unchanged' };
    claudeConnectionsService.applyActiveToOptions(ordinary, first);
    assert.deepEqual(ordinary, { model: 'sonnet', resume: 'unchanged' });
    await request('PUT', '/active', { id });
    assert.deepEqual(await snapshot(await request('DELETE', `/${id}`)), { activeId: null, connections: [] });
    assert.equal((await request('DELETE', `/${id}`)).status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    closeConnection();
    if (previousPath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousPath;
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('actual Claude SDK sends x-api-key to the prefixed Messages endpoint despite inherited auth settings', { timeout: 60000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'claude-key-smoke-'));
  const seen: { path: string; model: string; key: unknown; authorization: unknown; poison: unknown }[] = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (!req.url?.includes('/messages')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return; }
    const body = JSON.parse(raw) as { model: string };
    seen.push({ path: req.url, model: body.model, key: req.headers['x-api-key'], authorization: req.headers.authorization, poison: req.headers['x-poison'] });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const event = (type: string, value: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
    event('message_start', { message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } });
    event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'CUSTOM_CONNECTION_OK' } });
    event('content_block_stop', { index: 0 });
    event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
    event('message_stop', {});
    res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  try {
    const config = path.join(directory, 'config');
    await mkdir(config);
    await mkdir(path.join(directory, '.claude'));
    const poisonEnv = { ANTHROPIC_BASE_URL: baseUrl + '/wrong', ANTHROPIC_AUTH_TOKEN: 'wrong-grant', ANTHROPIC_API_KEY: 'wrong-key', ANTHROPIC_CUSTOM_HEADERS: 'X-Poison: wrong', CLAUDE_CODE_OAUTH_TOKEN: 'wrong-oauth' };
    const poisonSettings = { env: poisonEnv, apiKeyHelper: 'echo wrong-helper' };
    await writeFile(path.join(config, 'settings.json'), JSON.stringify(poisonSettings));
    await writeFile(path.join(directory, '.claude', 'settings.json'), JSON.stringify(poisonSettings));
    const options: Options = { cwd: directory, env: { ...process.env, ...poisonEnv, CLAUDE_CONFIG_DIR: config, DISABLE_AUTOUPDATER: '1' },
      model: 'sonnet', tools: [], persistSession: false, settingSources: ['user', 'project', 'local'], maxTurns: 1, abortController: controller };
    claudeConnectionsService.applyToOptions(options, { id: 'fixture', name: 'Fixture', baseUrl: baseUrl + '/anthropic', model: 'fixture-custom-model', apiKey: 'fixture-custom-key', authType: 'api_key' });
    let success = false;
    for await (const message of query({ prompt: 'Reply OK.', options })) {
      if (message.type === 'result') success = message.subtype === 'success' && !message.is_error;
    }
    assert.equal(success, true);
    assert.ok(seen.length >= 1);
    assert.ok(seen.every(request => request.path.startsWith('/anthropic/v1/messages') && request.model === 'fixture-custom-model'
      && request.key === 'fixture-custom-key' && request.authorization === undefined && request.poison === undefined));
  } finally {
    clearTimeout(timeout);
    controller.abort();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
