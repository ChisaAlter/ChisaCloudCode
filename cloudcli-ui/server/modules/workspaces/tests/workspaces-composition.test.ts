import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test, { mock } from 'node:test';

import express, { type ErrorRequestHandler } from 'express';

import { AppError } from '@/shared/index.js';
import type { WorkspaceDescriptor } from '@/shared/index.js';

const root = '/metadata/ssh-project';
const descriptor: WorkspaceDescriptor = {
  projectId: 'project', workspaceId: 'windows-workspace', generation: 'generation', kind: 'cloudReplica', sourceMode: 'ssh',
  rootPath: root, sourceRoot: root, displayPath: 'C:\\project', requestedMode: 'shared', effectiveMode: 'shared', phase: 'idle', publicationState: 'integrated',
  capabilities: { read: true, write: true, git: true, shell: true, preview: false, integrate: false, cloudExecutionIndependentOfDesktop: false },
};
mock.module('@/modules/database/index.js', { namedExports: {
  projectsDb: { getProjectPathById: (id: string) => id === 'project' ? root : null },
  sessionsDb: {
    getSessionById: (id: string) => ({ session_id: id, project_path: id === 'foreign-session' ? '/other' : root, workspace_mode: 'shared' }),
    getSessionsByProjectPathIncludingArchived: () => [],
  },
} });
mock.module('@/modules/workspace-runtime/index.js', { namedExports: { createWorkspaceRuntimeService: () => ({ restore: async () => { throw new Error('SSH resolution must not restore cloud runtime'); } }) } });
mock.module('@/modules/workspace-bridge/index.js', { namedExports: {
  assertWorkspaceDescriptor: () => {},
  assertSshProjectOwner: (_target: unknown, id: unknown) => { if (id !== 'owner') throw new AppError('Foreign SSH owner', { code: 'SSH_WORKSPACE_FORBIDDEN', statusCode: 403 }); },
  resolveSshProjectTarget: (candidate: string) => candidate === root ? { ownerId: 'owner' } : null,
  describeWorkspaceSelection: ({ sessionId }: { sessionId?: string }) => ({ cloudReplica: descriptor, session: sessionId ? { ...descriptor, workspaceId: 'windows-workspace:session', kind: 'session', sessionId } : null }),
  integrateWorkspaceSession: async () => { throw new Error('Unexpected integration'); },
  isWorkspaceBound: () => true,
  workspaceRequestScope: (_request: unknown, _response: unknown, next: () => void) => next(),
} });
const { createWorkspacesRouter } = await import('../workspaces.module.js');

test('production workspace composition resolves a new app session while preserving ownership and strict operation selectors', async () => {
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    (request as express.Request & { user: { id: string } }).user = { id: String(request.headers['x-test-owner'] || 'owner') };
    next();
  });
  app.use('/api/workspaces', createWorkspacesRouter());
  app.use(((error, _request, response, _next) => response.status(error instanceof AppError ? error.statusCode : 500).json({ code: error.code })) as ErrorRequestHandler);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/workspaces`;
  try {
    const resolved = await fetch(`${base}/resolve?projectId=project&sessionId=new-session`);
    assert.equal(resolved.status, 200);
    assert.equal(((await resolved.json()) as { session: { sessionId: string } }).session.sessionId, 'new-session');
    assert.equal((await fetch(`${base}/resolve?projectId=project&sessionId=new-session`, { headers: { 'x-test-owner': 'other' } })).status, 403);
    assert.equal((await fetch(`${base}/resolve?projectId=project&sessionId=foreign-session`)).status, 409);
    assert.equal((await fetch(`${base}/resolve?projectId=project&sessionId=new-session&workspaceId=partial`)).status, 400);
    assert.equal((await fetch(`${base}/integration/recover`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: 'project', sessionId: 'new-session' }) })).status, 400);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
