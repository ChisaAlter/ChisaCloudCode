import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test, { mock } from 'node:test';

import express from 'express';

const calls: Array<Record<string, unknown>> = [];
const ownerChecks: Array<{ candidate: unknown; ownerId: unknown }> = [];
mock.module('@/modules/database/index.js', { namedExports: { userDb: { getActiveUserIds: () => ['1', '2'] } } });
mock.module('@/modules/workspace-runtime/index.js', { namedExports: { assertCloudWorkspaceOwner(candidate: unknown, ownerId: unknown) {
  ownerChecks.push({ candidate, ownerId });
  if (candidate === '/foreign') throw Object.assign(new Error('foreign owner'), { forbidden: true });
} } });
mock.module('@/modules/projects/services/project-clone-jobs.service.js', { namedExports: { projectCloneJobsService: {
  async create(input: Record<string, unknown>) { calls.push({ action: 'create', ...input }); return { jobId: 'job-1', status: 'running', message: 'Preparing repository clone' }; },
  get(jobId: string, userId: string) { calls.push({ action: 'get', jobId, userId }); return { jobId, status: 'complete', message: 'done', project: { projectId: 'p' } }; },
  async cancel(jobId: string, userId: string) { calls.push({ action: 'cancel', jobId, userId }); return { jobId, status: 'cancelled', message: 'cancelled', code: 'CLONE_CANCELLED' }; },
} } });
const { default: router } = await import('../project-clone-jobs.routes.js');
const app = express().use(express.json()).use((request, _response, next) => {
  const value = request.header('x-user');
  if (value) (request as express.Request & { user: object }).user = request.header('x-user-field') === 'userId' ? { userId: value } : { id: value };
  next();
}).use('/api/projects', router);
const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects`;
const body = { path: '/workspace/raw', githubUrl: 'https://host/team/repo', githubTokenId: '12', requestId: 'request-1', newGithubToken: 'ephemeral' };
function create(overrides: Record<string, unknown> = {}, headers: Record<string, string> = { 'x-user': '1' }) { return fetch(base + '/clone-jobs', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ ...body, ...overrides }) }); }

test.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); mock.restoreAll(); });

test('POST accepts numeric-string authenticated userId and checks raw owner before service', async () => {
  const response = await create({}, { 'x-user': '2', 'x-user-field': 'userId' });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { jobId: 'job-1', status: 'running', message: 'Preparing repository clone' });
  assert.deepEqual(ownerChecks.at(-1), { candidate: '/workspace/raw', ownerId: '2' });
  assert.deepEqual(calls.at(-1), { action: 'create', workspacePath: '/workspace/raw', githubUrl: body.githubUrl, githubTokenId: 12, requestId: 'request-1', userId: '2', newGithubToken: 'ephemeral' });
});

test('invalid auth and token input never enter execution service', async () => {
  const previous = calls.length;
  for (const id of ['', '1oops', '0', '-1', '1.5']) assert.equal((await create({}, id ? { 'x-user': id } : {})).status, 401, id);
  for (const githubTokenId of ['12oops', 0, -1, 1.5]) assert.equal((await create({ githubTokenId })).status, 400);
  assert.equal((await create({ newGithubToken: {} })).status, 400);
  assert.equal((await create({ path: '/foreign' })).status, 500);
  assert.equal(calls.length, previous);
});

test('GET and DELETE use owner from either authenticated identity field and return flat snapshots', async () => {
  const get = await fetch(base + '/clone-jobs/job-1', { headers: { 'x-user': '1' } });
  assert.equal(get.status, 200); assert.equal(((await get.json()) as { status: string }).status, 'complete');
  const deleted = await fetch(base + '/clone-jobs/job-1', { method: 'DELETE', headers: { 'x-user': '2', 'x-user-field': 'userId' } });
  assert.equal(deleted.status, 200); assert.equal(((await deleted.json()) as { status: string }).status, 'cancelled');
  assert.deepEqual(calls.slice(-2), [{ action: 'get', jobId: 'job-1', userId: '1' }, { action: 'cancel', jobId: 'job-1', userId: '2' }]);
});
