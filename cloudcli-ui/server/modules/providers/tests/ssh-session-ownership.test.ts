import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express, { type ErrorRequestHandler } from 'express';

const root = await mkdtemp(path.join(os.tmpdir(), 'chisa-ssh-history-'));
process.env.WORKSPACES_ROOT = root;
process.env.DATABASE_PATH = path.join(root, 'db.sqlite');
await writeFile(process.env.DATABASE_PATH, '');
const { initializeDatabase, closeConnection, sessionsDb, projectsDb, sshProjectTargetsDb } = await import('@/modules/database/index.js');
const { default: providerRouter } = await import('../provider.routes.js');
const { scheduledMessagesRoutes } = await import('@/modules/scheduled-messages/index.js');
const { AppError } = await import('@/shared/index.js');
await initializeDatabase();
const target = sshProjectTargetsDb.createWithProject({ projectId: 'local-project', ownerId: '1', connectionId: 'laptop', connectionLabel: 'Laptop',
  rootPath: 'D:\\Code', rootIdentity: 'physical', anchorPath: path.join(root, '.chisa-ssh-projects', 'local'), displayName: 'Windows App' });
sessionsDb.createAppSession('local-session', 'claude', target.anchorPath, 'private local title');
const cloud = projectsDb.createProjectPath(path.join(root, 'cloud'));
sessionsDb.createAppSession('cloud-session', 'claude', cloud.project!.project_path, 'public cloud title');
const app = express().use(express.json()).use((request, _response, next) => {
  (request as express.Request & { user: { id: string } }).user = { id: request.header('x-test-user') ?? '1' }; next();
}).use('/providers', providerRouter).use('/scheduled', scheduledMessagesRoutes);
app.use(((error, _request, response, _next) => { response.status(error instanceof AppError ? error.statusCode : 500).json({ code: error instanceof AppError ? error.code : 'INTERNAL' }); }) as ErrorRequestHandler);
const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/providers`;
const headers = { 'x-test-user': '2', 'content-type': 'application/json' };
test.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); closeConnection(); assert.equal(path.dirname(root), os.tmpdir()); await rm(root, { recursive: true, force: true }); });

test('foreign account cannot read, edit, fork or delete SSH session even through raw session routes', async () => {
  for (const [method, suffix, body] of [
    ['GET', '', undefined], ['GET', '/messages', undefined], ['GET', '/provider-id', undefined], ['GET', '/token-usage', undefined],
    ['PUT', '', { summary: 'steal' }], ['POST', '/fork', {}], ['POST', '/restore', {}], ['DELETE', '', undefined],
    ['GET', '/active-model', undefined],
  ] as const) {
    const response = await fetch(base + (suffix === '/active-model' ? '/claude' : '') + '/sessions/local-session' + suffix, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal(response.status, 403, `${method} ${suffix}`);
    assert.equal((await response.json() as { code: string }).code, 'SSH_WORKSPACE_FORBIDDEN');
  }
  assert.ok(sessionsDb.getSessionById('local-session'));
});

test('SSH conversation feeds and search hide foreign metadata before pagination while cloud remains visible', async () => {
  const recent = await fetch(base + '/sessions/recent?limit=1', { headers });
  const page = (await recent.json() as { data: { conversations: { sessionId: string }[]; total: number } }).data;
  assert.equal(page.total, 1);
  assert.deepEqual(page.conversations.map(row => row.sessionId), ['cloud-session']);
  const search = await (await fetch(base + '/search/sessions?q=private', { headers })).text();
  assert.doesNotMatch(search, /local-session|private local title|Windows App/);
  const details = await (await fetch(base + '/sessions/local-session')).json() as { data: { project: { sourceMode: string; displayPath: string } } };
  assert.equal(details.data.project.sourceMode, 'ssh');
  assert.equal(details.data.project.displayPath, 'D:\\Code');
});

test('scheduled local turns authorize SSH owner before persisting a message', async () => {
  const response = await fetch(base.replace('/providers', '/scheduled'), { method: 'POST', headers, body: JSON.stringify({ sessionId: 'local-session', content: 'build', scheduledFor: new Date().toISOString() }) });
  assert.equal(response.status, 403);
  assert.equal((await response.json() as { code: string }).code, 'SSH_WORKSPACE_FORBIDDEN');
});
