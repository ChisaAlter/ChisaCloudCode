import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express, { type ErrorRequestHandler } from 'express';

import { AppError } from '@/shared/index.js';
import type { WorkspaceDescriptor } from '@/shared/index.js';

import { createWorkspacesRoutes } from '../workspaces.routes.js';

const session: WorkspaceDescriptor = {
  workspaceId: 'workspace-session', projectId: 'project', sessionId: 'app-session', kind: 'session',
  generation: 'generation-1', rootPath: '/sessions/app-session', sourceRoot: '/replica',
  requestedMode: 'isolated', effectiveMode: 'isolated', baseRevision: 'base', phase: 'idle', publicationState: 'unpublished',
  capabilities: { read: true, write: true, git: true, shell: true, preview: true, integrate: true, cloudExecutionIndependentOfDesktop: true },
};
const replica: WorkspaceDescriptor = { ...session, kind: 'cloudReplica', workspaceId: 'workspace-replica', sessionId: undefined, rootPath: '/replica', baseRevision: undefined };
const selector = { projectId: 'project', workspaceId: 'workspace-session', generation: 'generation-1', sessionId: 'app-session' };

async function withServer(run: (baseUrl: string, integrationInputs: unknown[], resolveInputs: unknown[]) => Promise<void>) {
  const integrationInputs: unknown[] = [];
  const resolveInputs: unknown[] = [];
  const app = express();
  app.use(express.json());
  app.use('/api/workspaces', createWorkspacesRoutes({
    catalog: {
      resolve(projectId, sessionId) {
        resolveInputs.push({ projectId, sessionId });
        return { cloudReplica: replica, session: sessionId === 'pending-session' ? null : session };
      },
      resolveSelectedWorkspace(projectId, requested) {
        assert.equal(projectId, 'project');
        if (requested?.generation !== 'generation-1') throw new AppError('stale generation', { code: 'WORKSPACE_GENERATION_CHANGED', statusCode: 409 });
        return requested.workspaceId === 'workspace-replica' ? replica : session;
      },
    },
    async integrate(input) {
      integrationInputs.push(input);
      if (input.action === 'preview') return { status: 'preview', previewId: 'preview-1', sourceRevision: 'source', targetRevision: 'target', changes: [], conflicts: [] };
      return { status: input.action === 'recover' ? 'idle' : 'applied' };
    },
    async runProjectAction(projectId, actionId) {
      return { projectId, actionId, exitCode: 0, stdout: 'ok', stderr: '', truncated: false };
    },
  }));
  app.use(((error: unknown, _request, response, _next) => {
    response.status(error instanceof AppError ? error.statusCode : 500).json({ code: error instanceof AppError ? error.code : 'INTERNAL_ERROR' });
  }) as ErrorRequestHandler);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/workspaces`, integrationInputs, resolveInputs); }
  finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

function post(url: string, body: unknown) {
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

test('resolver exposes a pending session as null without inventing a fallback and validates query scalars', async () => {
  await withServer(async (baseUrl, _integrationInputs, resolveInputs) => {
    const response = await fetch(`${baseUrl}/resolve?projectId=project&sessionId=pending-session`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { cloudReplica: JSON.parse(JSON.stringify(replica)), session: null });
    assert.deepEqual(resolveInputs, [{ projectId: 'project', sessionId: 'pending-session' }]);
    for (const query of ['sessionId=app-session', 'projectId=project&sessionId=', 'projectId=one&projectId=two']) {
      assert.equal((await fetch(`${baseUrl}/resolve?${query}`)).status, 400);
    }
    assert.equal(resolveInputs.length, 1);
  });
});

test('project action run requires both ids and returns the execution result', async () => {
  await withServer(async (baseUrl) => {
    const response = await post(`${baseUrl}/actions/run`, { projectId: 'project', actionId: 'action-1' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      projectId: 'project',
      actionId: 'action-1',
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
      truncated: false,
    });
    assert.equal((await post(`${baseUrl}/actions/run`, { projectId: 'project' })).status, 400);
    assert.equal((await post(`${baseUrl}/actions/run`, { actionId: 'action-1' })).status, 400);
  });
});

test('integration requires the reviewed token, both revisions and operation id for apply only', async () => {
  await withServer(async (baseUrl, integrationInputs) => {
    const required = { previewId: 'preview-1', expectedSourceRevision: 'source', expectedTargetRevision: 'target', operationId: 'operation-1' };
    for (const key of Object.keys(required)) {
      const fields = { ...required } as Record<string, string>;
      delete fields[key];
      const response = await post(`${baseUrl}/integration/apply`, { ...selector, ...fields });
      assert.equal(response.status, 400, key);
    }
    assert.equal(integrationInputs.length, 0);
    const applied = await post(`${baseUrl}/integration/apply`, { ...selector, ...required });
    assert.equal(applied.status, 200);
    assert.deepEqual(await applied.json(), { status: 'applied' });
    assert.deepEqual(integrationInputs, [{ descriptor: session, action: 'apply', ...required }]);
    const preview = await post(`${baseUrl}/integration/preview`, selector);
    assert.equal(preview.status, 200);
    assert.equal((await preview.json() as { previewId: string }).previewId, 'preview-1');
    const recover = await post(`${baseUrl}/integration/recover`, selector);
    assert.equal(recover.status, 200);
    assert.deepEqual(await recover.json(), { status: 'idle' });
  });
});

test('integration refuses client paths, conflicting selectors, overlong ids and stale roots before calling the bridge', async () => {
  await withServer(async (baseUrl, integrationInputs) => {
    for (const field of ['descriptor', 'rootPath', 'sourceRoot', 'targetRoot', 'executionRoot', 'stateRoot']) {
      assert.equal((await post(`${baseUrl}/integration/preview`, { ...selector, [field]: '/client-path' })).status, 400);
    }
    assert.equal((await post(`${baseUrl}/integration/preview?generation=other`, selector)).status, 400);
    assert.equal((await post(`${baseUrl}/integration/preview`, { ...selector, operationId: 'x'.repeat(257) })).status, 400);
    assert.equal((await post(`${baseUrl}/integration/preview`, { ...selector, generation: 'old' })).status, 409);
    assert.equal((await post(`${baseUrl}/integration/preview`, { ...selector, workspaceId: 'workspace-replica' })).status, 409);
    assert.deepEqual(integrationInputs, []);
  });
});
