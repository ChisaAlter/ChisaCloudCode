import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import express from 'express';

const fixture = await mkdtemp(path.join(os.tmpdir(), 'project-clone-routes-'));
const root = path.join(fixture, 'account');
const privateHome = path.join(fixture, 'home');
const previousRoot = process.env.WORKSPACES_ROOT;
process.env.WORKSPACES_ROOT = root;
await mkdir(root);
await mkdir(path.join(privateHome, '.chisa-workspace-runtime'), { recursive: true });
mock.method(os, 'homedir', () => privateHome);

let activeAccounts = ['1', '2'];
const cloneCalls: Array<{ workspacePath: string; userId: string | number }> = [];
mock.module('@/modules/database/index.js', { namedExports: {
  userDb: { getActiveUserIds: () => activeAccounts },
} });
// The owner policy is real; runtime preview orchestration stays outside this test.
mock.module('@/modules/workspace-bridge/index.js', { namedExports: { recoverStoppedWorkspacePreview() {} } });
// Keep unrelated project routes out of this transport/policy test.
mock.module('@/modules/projects/services/project-management.service.js', { namedExports: { createProject() {}, updateProjectDisplayName() {} } });
mock.module('@/modules/projects/services/ssh-project-management.service.js', { namedExports: { createSshProject() {} } });
mock.module('@/modules/projects/services/project-ssh-access.service.js', { namedExports: { assertProjectSshAccess() {} } });
mock.module('@/modules/projects/services/legacy-project-registration.service.js', { namedExports: { registerExistingProjectPaths() {} } });
mock.module('@/modules/projects/services/projects-has-taskmaster.service.js', { namedExports: { getProjectTaskMaster() {} } });
mock.module('@/modules/projects/services/project-settings.service.js', { namedExports: { projectSettingsService: {} } });
mock.module('@/modules/projects/services/project-context.service.js', { namedExports: { projectContextService: {} } });
mock.module('@/modules/projects/services/project-runtime-context.service.js', { namedExports: { getCurrentProjectRuntimeManifest() {}, getCurrentProjectMemory() {}, saveCurrentProjectMemory() {} } });
mock.module('@/modules/projects/services/project-actions.service.js', { namedExports: { projectActionsService: {} } });
mock.module('@/modules/projects/services/projects-with-sessions-fetch.service.js', { namedExports: { getArchivedProjectsWithSessions() {}, getProjectSessionsPage() {}, getProjectsWithSessions() {} } });
mock.module('@/modules/projects/services/project-delete.service.js', { namedExports: { deleteOrArchiveProject() {}, restoreArchivedProject() {} } });
mock.module('@/modules/projects/services/project-star.service.js', { namedExports: { applyLegacyStarredProjectIds() {}, toggleProjectStar() {} } });
mock.module('@/modules/projects/services/project-clone.service.js', { namedExports: {
  startCloneProject: async (input: { workspacePath: string; userId: string | number }, handlers: { onComplete: (value: { project: object; message: string }) => void }) => {
    cloneCalls.push(input);
    handlers.onComplete({ project: { projectId: 'cloned' }, message: 'Cloned' });
    return { waitForCompletion: Promise.resolve(), cancel() {} };
  },
} });

const { default: router } = await import('../projects.routes.js');
const app = express().use(express.json()).use((request, _response, next) => {
  (request as express.Request & { user: { id: string } }).user = { id: request.header('x-user') ?? '1' };
  next();
}).use((_request, response, next) => { response.setHeader('Access-Control-Allow-Origin', '*'); next(); }).use(router)
  .use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    response.status(error instanceof Error && 'statusCode' in error ? Number(error.statusCode) : 500).json({ error: error instanceof Error ? error.message : String(error) });
  });
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const request = async (workspacePath: string, userId = '1') => {
  const posted = await fetch(base + '/clone', { method: 'POST', headers: { 'x-user': userId, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: workspacePath, githubUrl: 'https://github.com/example/repo' }) });
  const body = await posted.json() as { cloneId?: string; error?: string };
  if (!posted.ok) return body.error ?? '';
  const response = await fetch(base + '/clone-progress?cloneId=' + encodeURIComponent(body.cloneId ?? ''), { headers: { 'x-user': userId } });
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  assert.equal(response.headers.get('access-control-allow-origin'), null, 'the desktop proxy supplies exactly one CORS origin');
  assert.equal(response.headers.get('x-accel-buffering'), 'no');
  return response.text();
};

test.after(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  mock.restoreAll();
  if (previousRoot === undefined) delete process.env.WORKSPACES_ROOT;
  else process.env.WORKSPACES_ROOT = previousRoot;
  assert.equal(path.dirname(fixture), os.tmpdir());
  await rm(fixture, { recursive: true, force: true });
});

test('clone-progress enforces persisted owner and legacy account policy before clone service', async () => {
  const unbound = path.join(root, 'not-created');
  assert.match(await request(unbound), /Workspace does not belong to the current account/);
  assert.equal(cloneCalls.length, 0, 'unbound multiaccount paths must never reach clone');

  activeAccounts = ['1'];
  assert.match(await request(unbound, '2'), /Workspace does not belong to the current account/);
  assert.equal(cloneCalls.length, 0, 'the sole legacy account still must match');
  assert.match(await request(unbound), /"type":"complete"/);
  assert.equal(cloneCalls.length, 1);
  assert.equal(cloneCalls[0].userId, '1');

  activeAccounts = ['1', '2'];
  const owner = createHash('sha256').update(root + '\0' + '1').digest('hex').slice(0, 24);
  const statePath = path.join(privateHome, '.chisa-workspace-runtime', createHash('sha256').update(root).digest('hex').slice(0, 24) + '.json');
  const state = JSON.stringify({ version: 1, root, userId: '1', owner });
  await writeFile(statePath, state, { mode: 0o600 });
  assert.match(await request(unbound, '2'), /Workspace does not belong to the current account/);
  assert.equal(cloneCalls.length, 1, 'foreign account must never reach clone');
  assert.match(await request(unbound), /"type":"complete"/);
  assert.equal(cloneCalls.length, 2);
  assert.equal(await readFile(statePath, 'utf8'), state, 'owner preflight must be read-only');
});

import type {
  NextFunction,
  Request,
  Response,
} from 'express';

import { createProjectCloneRouter } from '@/modules/projects/project-clone.routes.js';
import { createPendingCloneRequests } from '@/modules/projects/services/project-clone-request.service.js';
import type { startCloneProject } from '@/modules/projects/services/project-clone.service.js';
import { AppError } from '@/shared/utils.js';

type CloneRunner = typeof startCloneProject;
type CloneInput = Parameters<CloneRunner>[0];

/**
 * A clone runner that reports one progress line and completes at once. What
 * it was asked to clone is recorded so a test can check the request survived
 * the POST -> claim -> run hand-off intact.
 */
function createFakeCloneRunner(inputs: CloneInput[]): CloneRunner {
  return async (input, handlers) => {
    inputs.push(input);
    handlers.onProgress('Receiving objects: 100% (20/20), done.');
    handlers.onComplete({ project: { projectId: 'project-1' }, message: 'Repository cloned successfully' });
    return { waitForCompletion: Promise.resolve(), cancel: () => undefined };
  };
}

const unexpectedCloneRunner: CloneRunner = async () => {
  throw new Error('startCloneProject must not run before the progress stream is opened');
};

type ServerOptions = {
  startCloneProject: CloneRunner;
  pendingCloneTtlMs?: number;
};

// The auth middleware is mounted ahead of the router in production; here the
// `x-user-id` header plays its part so a test can act as two different users.
async function withProjectsServer(
  options: ServerOptions,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const userId = req.header('x-user-id');
    if (userId) {
      (req as Request & { user?: { id: number } }).user = { id: Number(userId) };
    }
    next();
  });
  app.use('/api/projects', createProjectCloneRouter({
    startCloneProject: options.startCloneProject,
    pendingCloneRequests: createPendingCloneRequests(options.pendingCloneTtlMs ?? 60_000),
  }));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ error: error.code });
      return;
    }

    res.status(500).json({ error: 'INTERNAL_ERROR' });
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

const cloneBody = {
  path: '/workspace/root',
  githubUrl: 'https://github.com/example/repo.git',
  githubTokenId: null,
  newGithubToken: 'ghp_supersecrettoken1234567890abcd',
};

async function postClone(baseUrl: string, userId: number, body: Record<string, unknown> = cloneBody) {
  const response = await fetch(`${baseUrl}/api/projects/clone`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user-id': String(userId) },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as { cloneId?: string; error?: string } };
}

async function openProgress(baseUrl: string, userId: number, cloneId: string) {
  const response = await fetch(
    `${baseUrl}/api/projects/clone-progress?cloneId=${encodeURIComponent(cloneId)}`,
    { headers: { 'x-user-id': String(userId) } },
  );
  const text = await response.text();
  const events = text
    .split('\n\n')
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice('data: '.length)) as { type: string; message?: string });
  return { status: response.status, contentType: response.headers.get('content-type') ?? '', text, events };
}

test('POST /clone parks the request under a fresh id without spawning anything', async () => {
  await withProjectsServer({ startCloneProject: unexpectedCloneRunner }, async (baseUrl) => {
    const first = await postClone(baseUrl, 1);
    const second = await postClone(baseUrl, 1);

    assert.equal(first.status, 200);
    assert.match(first.body.cloneId ?? '', /^[0-9a-f-]{36}$/);
    assert.notEqual(first.body.cloneId, second.body.cloneId);
  });
});

test('POST /clone requires an authenticated user', async () => {
  await withProjectsServer({ startCloneProject: unexpectedCloneRunner }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/projects/clone`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(cloneBody),
    });

    assert.equal(response.status, 401);
  });
});

test('GET /clone-progress streams the clone the id names, then retires the id', async () => {
  const inputs: CloneInput[] = [];
  await withProjectsServer({ startCloneProject: createFakeCloneRunner(inputs) }, async (baseUrl) => {
    const { body } = await postClone(baseUrl, 7, { ...cloneBody, githubTokenId: 12, newGithubToken: null });
    assert.equal(inputs.length, 0, 'the POST alone must not start a clone');

    const stream = await openProgress(baseUrl, 7, body.cloneId ?? '');

    assert.equal(stream.status, 200);
    assert.match(stream.contentType, /^text\/event-stream/);
    assert.deepEqual(stream.events.map((event) => event.type), ['progress', 'complete']);
    assert.equal(stream.events[0]?.message, 'Receiving objects: 100% (20/20), done.');
    assert.equal(inputs[0]?.signal?.aborted, false);
    const { signal: _signal, ...postedInput } = inputs[0]!;
    assert.deepEqual([postedInput], [{
      workspacePath: '/workspace/root',
      githubUrl: 'https://github.com/example/repo.git',
      githubTokenId: 12,
      newGithubToken: null,
      userId: 7,
    }]);

    const replay = await openProgress(baseUrl, 7, body.cloneId ?? '');
    assert.equal(replay.status, 404, 'a claimed id must not run the clone twice');
  });
});

test('GET /clone-progress hands the posted token to the clone without it touching the URL', async () => {
  const inputs: CloneInput[] = [];
  await withProjectsServer({ startCloneProject: createFakeCloneRunner(inputs) }, async (baseUrl) => {
    const { body } = await postClone(baseUrl, 1);
    const stream = await openProgress(baseUrl, 1, body.cloneId ?? '');

    assert.equal(stream.status, 200);
    assert.equal(inputs[0]?.newGithubToken, cloneBody.newGithubToken);
    assert.ok(!(body.cloneId ?? '').includes(cloneBody.newGithubToken));
  });
});

test('GET /clone-progress rejects an unknown id with 404', async () => {
  await withProjectsServer({ startCloneProject: unexpectedCloneRunner }, async (baseUrl) => {
    const stream = await openProgress(baseUrl, 1, 'not-a-clone-id');

    assert.equal(stream.status, 404);
    assert.deepEqual(JSON.parse(stream.text), { error: 'CLONE_REQUEST_NOT_FOUND' });
  });
});

test('GET /clone-progress rejects another user id with 404 and keeps it for its owner', async () => {
  const inputs: CloneInput[] = [];
  await withProjectsServer({ startCloneProject: createFakeCloneRunner(inputs) }, async (baseUrl) => {
    const { body } = await postClone(baseUrl, 1);

    const foreign = await openProgress(baseUrl, 2, body.cloneId ?? '');
    assert.equal(foreign.status, 404);
    assert.equal(inputs.length, 0, 'a foreign claim must not run the clone');

    const owner = await openProgress(baseUrl, 1, body.cloneId ?? '');
    assert.equal(owner.status, 200);
    assert.equal(inputs[0]?.userId, 1);
  });
});

test('GET /clone-progress rejects an expired id with 404', async () => {
  await withProjectsServer(
    { startCloneProject: unexpectedCloneRunner, pendingCloneTtlMs: 20 },
    async (baseUrl) => {
      const { body } = await postClone(baseUrl, 1);
      await new Promise((resolve) => setTimeout(resolve, 60));

      const stream = await openProgress(baseUrl, 1, body.cloneId ?? '');
      assert.equal(stream.status, 404);
    },
  );
});

test('GET /clone-progress cancels a clone whose client left before the git process existed', async () => {
  // The close listener could only cancel an operation it already had; a
  // client gone during validation left git cloning for nobody, under an id
  // no reconnect could reach.
  let releaseStart: () => void = () => undefined;
  const started = new Promise<void>((resolve) => { releaseStart = resolve; });
  let cancelled = 0;
  let resolveRun: () => void = () => undefined;
  const runFinished = new Promise<void>((resolve) => { resolveRun = resolve; });
  const slowRunner: CloneRunner = async () => {
    await started;
    return {
      waitForCompletion: new Promise<void>((resolve) => { setTimeout(resolve, 20); }).then(() => resolveRun()),
      cancel: () => { cancelled += 1; },
    };
  };

  await withProjectsServer({ startCloneProject: slowRunner }, async (baseUrl) => {
    const { body } = await postClone(baseUrl, 1);
    const controller = new AbortController();
    const request = fetch(
      `${baseUrl}/api/projects/clone-progress?cloneId=${encodeURIComponent(body.cloneId ?? '')}`,
      { headers: { 'x-user-id': '1' }, signal: controller.signal },
    );
    // Headers are flushed before the runner is awaited; drop the client
    // while the runner is still "validating".
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    controller.abort();
    await request.catch(() => undefined);
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    assert.equal(cancelled, 0, 'nothing to cancel yet');

    releaseStart();
    await runFinished;
    assert.equal(cancelled, 1, 'the operation is cancelled as soon as it exists');
  });
});
