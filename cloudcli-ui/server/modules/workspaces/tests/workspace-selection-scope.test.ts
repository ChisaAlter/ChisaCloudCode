import assert from 'node:assert/strict';
import { AsyncResource } from 'node:async_hooks';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express, { type ErrorRequestHandler } from 'express';
import multer from 'multer';

import { AppError } from '@/shared/index.js';

import { currentWorkspaceSelector, currentWorkspaceUserId, workspaceResolutionScope, workspaceSelectionScope } from '../workspace-selection-scope.js';

async function withServer(run: (baseUrl: string) => Promise<void>) {
  const app = express();
  app.use(express.json());
  app.use((request, response, next) => {
    (request as express.Request & { user: { id: string } }).user = { id: 'authenticated-owner' };
    (request.method === 'GET' && request.path === '/resolve' ? workspaceResolutionScope : workspaceSelectionScope)(request, response, next);
  });
  app.get('/resolve', (_request, response) => response.json({ selector: currentWorkspaceSelector(), userId: currentWorkspaceUserId() }));
  const handler: express.RequestHandler = async (request, response, next) => {
    try {
      const before = currentWorkspaceSelector();
      await new Promise<void>(resolve => setImmediate(resolve));
      response.json({ before, after: currentWorkspaceSelector(), projectId: request.params.projectId });
    } catch (error) { next(error); }
  };
  const upload = multer().none();
  app.post('/projects/:projectId/upload', (request, response, next) => {
    upload(request, response, AsyncResource.bind((error?: unknown) => {
      if (error) next(error);
      else void handler(request, response, next);
    }));
  });
  app.all('/projects/:projectId', handler);
  app.use(((error: unknown, _request, response, _next) => {
    response.status(error instanceof AppError ? error.statusCode : 500).json({ code: error instanceof AppError ? error.code : 'INTERNAL_ERROR' });
  }) as ErrorRequestHandler);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); }
  finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

test('selection is captured before route params and remains isolated across concurrent async requests', async () => {
  await withServer(async baseUrl => {
    const results = await Promise.all(Array.from({ length: 10 }, async (_, index) => {
      const selector = { workspaceId: `workspace-${index}`, generation: `generation-${index}`, sessionId: `session-${index}` };
      const response = await fetch(`${baseUrl}/projects/project-${index}?${new URLSearchParams(selector)}`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { before: selector, after: selector, projectId: `project-${index}` });
    }));
    assert.equal(results.length, 10);
    assert.equal(currentWorkspaceSelector(), null);
  });
});

test('selection scope rejects partial, array, object and query/body conflicting selectors', async () => {
  await withServer(async baseUrl => {
    for (const query of ['workspaceId=one', 'generation=one', 'sessionId=one', 'workspaceId=one&workspaceId=two&generation=g', 'workspaceId[x]=one&generation=g']) {
      const response = await fetch(`${baseUrl}/projects/project?${query}`);
      assert.equal(response.status, 400, query);
      assert.deepEqual(await response.json(), { code: 'INVALID_WORKSPACE_SELECTOR' });
    }
    const conflict = await fetch(`${baseUrl}/projects/project?workspaceId=one&generation=g`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspaceId: 'two', generation: 'g' }),
    });
    assert.equal(conflict.status, 400);
  });
});

test('matching body/query selectors and selector-free unbound requests remain representable', async () => {
  await withServer(async baseUrl => {
    const selector = { workspaceId: 'one', generation: 'g' };
    const response = await fetch(`${baseUrl}/projects/project?${new URLSearchParams(selector)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(selector),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { before: selector, after: selector, projectId: 'project' });
    const unscoped = await fetch(`${baseUrl}/projects/project`);
    assert.equal(unscoped.status, 200);
    assert.deepEqual(await unscoped.json(), { before: null, after: null, projectId: 'project' });
  });
});

test('only catalog resolution permits session lookup without a selector and retains the authenticated owner', async () => {
  await withServer(async baseUrl => {
    const lookup = await fetch(`${baseUrl}/resolve?projectId=project&sessionId=new-session`);
    assert.equal(lookup.status, 200);
    assert.deepEqual(await lookup.json(), { selector: null, userId: 'authenticated-owner' });
    const full = await fetch(`${baseUrl}/resolve?projectId=project&sessionId=new-session&workspaceId=workspace&generation=g`);
    assert.equal(full.status, 200);
    assert.deepEqual(await full.json(), { selector: { workspaceId: 'workspace', generation: 'g', sessionId: 'new-session' }, userId: 'authenticated-owner' });
    for (const query of ['sessionId=new-session&workspaceId=workspace', 'sessionId=new-session&generation=g', 'sessionId=one&sessionId=two']) {
      assert.equal((await fetch(`${baseUrl}/resolve?projectId=project&${query}`)).status, 400);
    }
    assert.equal((await fetch(`${baseUrl}/projects/project?sessionId=new-session`)).status, 400);
  });
});

test('multipart fields are checked after parsing and cannot redirect the query selector', async () => {
  await withServer(async baseUrl => {
    const invalid = new FormData();
    invalid.append('workspaceId', 'other');
    invalid.append('generation', 'g');
    const rejected = await fetch(`${baseUrl}/projects/project/upload?workspaceId=one&generation=g`, { method: 'POST', body: invalid });
    assert.equal(rejected.status, 400);
    assert.deepEqual(await rejected.json(), { code: 'INVALID_WORKSPACE_SELECTOR' });
    const valid = new FormData();
    valid.append('workspaceId', 'one');
    valid.append('generation', 'g');
    const accepted = await fetch(`${baseUrl}/projects/project/upload?workspaceId=one&generation=g`, { method: 'POST', body: valid });
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { before: { workspaceId: 'one', generation: 'g' }, after: { workspaceId: 'one', generation: 'g' }, projectId: 'project' });
  });
});
