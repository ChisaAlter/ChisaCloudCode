import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';
import { promisify } from 'node:util';

import express from 'express';

import type { ProjectRepositoryRow } from '@/shared/types.js';

// Every filesystem/Git operation stays beneath this process-owned directory.
// Database and Projects are the only mocked boundaries; the module, routes,
// workspace admission, Git adapters and worktree workflows are the real ones.
const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'chisa-worktree-composition-'));
const isolatedHome = path.join(fixtureRoot, 'home');
await mkdir(isolatedHome);
Object.assign(process.env, {
  HOME: isolatedHome,
  USERPROFILE: isolatedHome,
  DATABASE_PATH: path.join(fixtureRoot, 'unused.db'),
  WORKSPACES_ROOT: fixtureRoot,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: path.join(isolatedHome, '.gitconfig'),
});

const projectRows = new Map<string, ProjectRepositoryRow>();
const projectPaths = new Map<string, string>();
let registrationFailure = false;
mock.module('@/modules/database/index.js', { namedExports: {
  projectsDb: {
    getProjectPathById: (id: string) => projectPaths.get(id),
    getProjectPath: (candidate: string) => projectRows.get(candidate),
  },
} });
mock.module('@/modules/projects/index.js', { namedExports: {
  createProject: async (input: { projectPath: string; customName: string }) => {
    if (registrationFailure) throw new Error('fixture registration failed');
    const projectId = `created-${projectRows.size}`;
    projectRows.set(input.projectPath, {
      project_id: projectId,
      project_path: input.projectPath,
      custom_project_name: input.customName,
      isStarred: 0,
      isArchived: 0,
    });
    return { outcome: 'created', project: { projectId } };
  },
  deleteOrArchiveProject: async (id: string) => {
    const row = [...projectRows.values()].find(item => item.project_id === id);
    if (row) row.isArchived = 1;
  },
  restoreArchivedProject: async () => {},
} });

const { AppError, normalizeProjectPath } = await import('@/shared/utils.js');
const { worktreesRoutes } = await import('@/modules/worktrees/index.js');
const run = promisify(execFile);
const git = async (cwd: string, ...args: string[]) =>
  (await run('git', args, { cwd, encoding: 'utf8' })).stdout.trim();

async function exists(candidate: string): Promise<boolean> {
  try { await access(candidate); return true; } catch { return false; }
}

async function withRepository(
  operation: (fixture: {
    main: string;
    linked: string;
    calls: Array<{ op: string; root: string; changed?: boolean }>;
    bind: (root: string) => Promise<void>;
    post: (route: string, body: Record<string, unknown>, deadline?: number) => Promise<Response>;
  }) => Promise<void>,
): Promise<void> {
  projectRows.clear();
  projectPaths.clear();
  registrationFailure = false;
  const directory = await mkdtemp(path.join(fixtureRoot, 'repo-'));
  const main = normalizeProjectPath(path.join(directory, 'main'));
  const linked = normalizeProjectPath(path.join(directory, 'linked'));
  await mkdir(main);
  await git(main, 'init', '-b', 'main');
  await git(main, 'config', 'user.name', 'Worktree fixture');
  await git(main, 'config', 'user.email', 'worktree@example.invalid');
  await writeFile(path.join(main, 'base.txt'), 'base\n');
  await git(main, 'add', 'base.txt');
  await git(main, 'commit', '-m', 'fixture base');
  await writeFile(path.join(main, '.git', 'info', 'exclude'), '.chisa-bridge.json\n');
  await git(main, 'worktree', 'add', linked, '-b', 'selected');
  projectPaths.set('main', main);
  projectPaths.set('selected', linked);

  const calls: Array<{ op: string; root: string; changed?: boolean }> = [];
  const bridge = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { op: string; runId?: string; changed?: boolean };
    const root = Buffer.from(String(request.headers['x-cwd']), 'latin1').toString('utf8');
    assert.equal(request.url, '/workspace/rpc');
    assert.equal(request.headers['x-bridge-token'], 'fixture-token');
    calls.push({ op: body.op, root, ...(body.changed === undefined ? {} : { changed: body.changed }) });
    if (body.op === 'sync_end') {
      // Native sync_end now owns compare-and-release before acknowledging the
      // completed handback. The fixture consumes that contract, not Node-side
      // cleanup, and may remove only this repository's exact claimed roots.
      assert.ok(root === main || root === linked);
      const leaseDirectory = path.resolve(root + '.chisa-lease');
      assert.equal(path.dirname(leaseDirectory), path.resolve(directory));
      const state = JSON.parse(await readFile(path.join(leaseDirectory, 'state.json'), 'utf8')) as {
        owner: string; id: string; epoch: string;
      };
      assert.equal(state.owner, 'sync-needed');
      assert.equal(state.id, body.runId);
      assert.equal(state.epoch, request.headers['x-binding-epoch']);
      assert.equal(await exists(path.join(leaseDirectory, 'sync-job.json')), false);
      await rm(leaseDirectory, { recursive: true });
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));
  });
  bridge.listen(0, '127.0.0.1');
  await once(bridge, 'listening');

  const app = express();
  app.use(express.json());
  app.use('/api/worktrees', worktreesRoutes);
  const errorHandler: express.ErrorRequestHandler = (error, _request, response, _next) => {
    response.status(error instanceof AppError ? error.statusCode : 500).json({
      error: error instanceof AppError ? error.code : 'INTERNAL_ERROR',
      message: error instanceof Error ? error.message : String(error),
    });
  };
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    await operation({
      main,
      linked,
      calls,
      bind: root => writeFile(path.join(root, '.chisa-bridge.json'), JSON.stringify({
        protocol: 2,
        port: (bridge.address() as AddressInfo).port,
        token: 'fixture-token',
        bindingEpoch: 'fixture-epoch',
      })),
      post: (route, body, deadline) => fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/worktrees/${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(deadline === undefined ? {} : { 'X-Chisa-Deadline-Ms': String(deadline) }) },
        body: JSON.stringify(body),
      }),
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => bridge.close(error => error ? reject(error) : resolve()));
  }
}

test.after(async () => {
  const resolved = path.resolve(fixtureRoot);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('chisa-worktree-composition-'));
  await rm(resolved, { recursive: true, force: true });
});

test('HTTP create from a linked project protects the main binding for its full create-and-open transaction', async () => {
  await withRepository(async ({ main, calls, bind, post }) => {
    await bind(main);
    const response = await post('create', { project: 'selected', branch: 'feature/new' });
    assert.equal(response.status, 200, await response.text());
    const target = path.join(path.dirname(main), 'main-worktrees', 'feature-new');
    assert.equal(await git(target, 'branch', '--show-current'), 'feature/new');
    assert.ok(projectRows.has(normalizeProjectPath(target)), 'the same transaction registers the created worktree');
    assert.deepEqual(calls, [
      { op: 'sync_begin', root: main },
      { op: 'sync_end', root: main, changed: true },
      { op: 'sync_released', root: main },
    ]);
    assert.equal(await exists(main + '.chisa-lease'), false);
  });
});

test('create refuses the selected linked project busy binding when main is unbound', async () => {
  await withRepository(async ({ main, linked, calls, bind, post }) => {
    await bind(linked);
    const state = { owner: 'pi', id: 'selected-run', epoch: 'fixture-epoch' };
    await mkdir(linked + '.chisa-lease');
    await writeFile(path.join(linked + '.chisa-lease', 'state.json'), JSON.stringify(state));
    const before = await git(main, 'worktree', 'list', '--porcelain');
    const response = await post('create', { project: 'selected', branch: 'selected-blocked' });
    assert.equal(response.status, 409);
    assert.equal((await response.json() as { error: string }).error, 'WORKSPACE_BUSY');
    assert.equal(await git(main, 'worktree', 'list', '--porcelain'), before);
    assert.equal(await git(main, 'branch', '--list', 'selected-blocked'), '');
    assert.equal(await exists(path.join(path.dirname(main), 'main-worktrees', 'selected-blocked')), false);
    assert.deepEqual(JSON.parse(await readFile(path.join(linked + '.chisa-lease', 'state.json'), 'utf8')), state);
    assert.deepEqual(calls, []);
  });
});

test('create admits the selected linked binding for the complete transaction when main is unbound', async () => {
  await withRepository(async ({ main, linked, calls, bind, post }) => {
    await bind(linked);
    const response = await post('create', { project: 'selected', branch: 'selected-created' });
    assert.equal(response.status, 200, await response.text());
    const target = path.join(path.dirname(main), 'main-worktrees', 'selected-created');
    assert.equal(await git(target, 'branch', '--show-current'), 'selected-created');
    assert.ok(projectRows.has(normalizeProjectPath(target)));
    assert.deepEqual(calls, [
      { op: 'sync_begin', root: linked },
      { op: 'sync_end', root: linked, changed: true },
      { op: 'sync_released', root: linked },
    ]);
    assert.equal(await exists(linked + '.chisa-lease'), false);
    assert.equal(await exists(main + '.chisa-lease'), false);
    assert.equal(await exists(path.join(linked, '.chisa-bridge.json')), true);
  });
});

test('create registration compensation stays inside one admitted transaction', async () => {
  await withRepository(async ({ main, calls, bind, post }) => {
    await bind(main);
    registrationFailure = true;
    const response = await post('create', { project: 'selected', branch: 'rollback' });
    assert.equal(response.status, 500);
    assert.equal((await response.json() as { message: string }).message, 'fixture registration failed');
    assert.equal(await git(main, 'branch', '--list', 'rollback'), '');
    assert.equal(await exists(path.join(path.dirname(main), 'main-worktrees', 'rollback')), false);
    assert.deepEqual(calls.map(call => call.op), ['sync_begin', 'sync_end', 'sync_released']);
  });
});

for (const route of ['create', 'merge', 'remove']) {
  test(`${route} refuses a busy main binding before changing Git`, async () => {
    await withRepository(async ({ main, linked, calls, bind, post }) => {
      await bind(main);
      const state = { owner: 'pi', id: 'existing-run', epoch: 'fixture-epoch' };
      await mkdir(main + '.chisa-lease');
      await writeFile(path.join(main + '.chisa-lease', 'state.json'), JSON.stringify(state));
      const before = await git(main, 'worktree', 'list', '--porcelain');
      const response = await post(route, { project: 'selected', branch: 'blocked', worktreePath: linked });
      assert.equal(response.status, 409);
      assert.equal((await response.json() as { error: string }).error, 'WORKSPACE_BUSY');
      assert.equal(await git(main, 'worktree', 'list', '--porcelain'), before);
      assert.equal(await git(main, 'branch', '--list', 'blocked'), '');
      assert.deepEqual(JSON.parse(await readFile(path.join(main + '.chisa-lease', 'state.json'), 'utf8')), state);
      assert.deepEqual(calls, []);
    });
  });
}

for (const route of ['merge', 'remove']) {
  test(`${route} also refuses a busy source binding when the main worktree is unbound`, async () => {
    await withRepository(async ({ main, linked, calls, bind, post }) => {
      await bind(linked);
      await mkdir(linked + '.chisa-lease');
      await writeFile(path.join(linked + '.chisa-lease', 'state.json'), JSON.stringify({ owner: 'sync-needed', id: 'pending', epoch: 'fixture-epoch' }));
      const before = await git(main, 'worktree', 'list', '--porcelain');
      const response = await post(route, { project: 'main', worktreePath: linked });
      assert.equal(response.status, 409);
      assert.equal((await response.json() as { error: string }).error, 'WORKSPACE_BUSY');
      assert.equal(await git(main, 'worktree', 'list', '--porcelain'), before);
      assert.deepEqual(calls, []);
    });
  });
}

test('merge without removal holds both bindings for one transaction and preserves the source capability', async () => {
  await withRepository(async ({ main, linked, calls, bind, post }) => {
    await bind(main);
    await bind(linked);
    await writeFile(path.join(linked, 'feature.txt'), 'feature\n');
    await git(linked, 'add', 'feature.txt');
    await git(linked, 'commit', '-m', 'fixture feature');
    const response = await post('merge', { project: 'selected', worktreePath: linked, removeAfterMerge: false });
    assert.equal(response.status, 200, await response.text());
    assert.equal(await readFile(path.join(main, 'feature.txt'), 'utf8'), 'feature\n');
    assert.equal(await exists(path.join(linked, '.chisa-bridge.json')), true);
    assert.equal(await git(linked, 'branch', '--show-current'), 'selected');
    assert.equal(await exists(main + '.chisa-lease'), false);
    assert.equal(await exists(linked + '.chisa-lease'), false);
    const orderedRoots = [main, linked].sort((left, right) => left.localeCompare(right));
    assert.deepEqual(calls, [
      ...orderedRoots.map(root => ({ op: 'sync_begin', root })),
      ...[...orderedRoots].reverse().flatMap(root => [
        { op: 'sync_end', root, changed: true },
        { op: 'sync_released', root },
      ]),
    ]);
  });
});

for (const route of ['merge', 'remove']) {
  test(`${route} refuses destruction of a bound source before any Git mutation and releases both claims`, async () => {
    await withRepository(async ({ main, linked, calls, bind, post }) => {
      await bind(main);
      await bind(linked);
      await writeFile(path.join(linked, 'feature.txt'), 'feature\n');
      await git(linked, 'add', 'feature.txt');
      await git(linked, 'commit', '-m', 'fixture feature');
      const mainHead = await git(main, 'rev-parse', 'HEAD');
      const sourceHead = await git(linked, 'rev-parse', 'HEAD');
      const before = await git(main, 'worktree', 'list', '--porcelain');
      const marker = await readFile(path.join(linked, '.chisa-bridge.json'), 'utf8');
      const response = await post(route, {
        project: 'selected', worktreePath: linked, removeAfterMerge: true, deleteBranch: true,
      });
      assert.equal(response.status, 409);
      assert.equal((await response.json() as { error: string }).error, 'WORKTREE_BINDING_ACTIVE');
      assert.equal(await git(main, 'rev-parse', 'HEAD'), mainHead);
      assert.equal(await git(linked, 'rev-parse', 'HEAD'), sourceHead);
      assert.equal(await git(linked, 'branch', '--show-current'), 'selected');
      assert.equal(await git(main, 'worktree', 'list', '--porcelain'), before);
      assert.equal(await exists(path.join(main, 'feature.txt')), false);
      assert.equal(await readFile(path.join(linked, '.chisa-bridge.json'), 'utf8'), marker);
      assert.equal(await exists(main + '.chisa-lease'), false);
      assert.equal(await exists(linked + '.chisa-lease'), false);
      const orderedRoots = [main, linked].sort((left, right) => left.localeCompare(right));
      assert.deepEqual(calls, [
        ...orderedRoots.map(root => ({ op: 'sync_begin', root })),
        ...[...orderedRoots].reverse().flatMap(root => [
          { op: 'sync_end', root, changed: true },
          { op: 'sync_released', root },
        ]),
      ]);
    });
  });
}

test('merge with removal retains the ordinary source path when only the main worktree is bound', async () => {
  await withRepository(async ({ main, linked, calls, bind, post }) => {
    await bind(main);
    await writeFile(path.join(linked, 'feature.txt'), 'feature\n');
    await git(linked, 'add', 'feature.txt');
    await git(linked, 'commit', '-m', 'fixture feature');
    const response = await post('merge', { project: 'selected', worktreePath: linked, removeAfterMerge: true });
    assert.equal(response.status, 200, await response.text());
    assert.equal(await readFile(path.join(main, 'feature.txt'), 'utf8'), 'feature\n');
    assert.equal(await exists(linked), false);
    assert.equal(await git(main, 'branch', '--list', 'selected'), '');
    assert.equal(await exists(main + '.chisa-lease'), false);
    assert.deepEqual(calls, [
      { op: 'sync_begin', root: main },
      { op: 'sync_end', root: main, changed: true },
      { op: 'sync_released', root: main },
    ]);
  });
});

test('standalone removal retains the ordinary source path when only the main worktree is bound', async () => {
  await withRepository(async ({ main, linked, calls, bind, post }) => {
    await bind(main);
    const response = await post('remove', { project: 'selected', worktreePath: linked });
    assert.equal(response.status, 200, await response.text());
    assert.equal(await exists(linked), false);
    assert.equal(await exists(main + '.chisa-lease'), false);
    assert.equal(await exists(linked + '.chisa-lease'), false);
    assert.deepEqual(calls, [
      { op: 'sync_begin', root: main },
      { op: 'sync_end', root: main, changed: true },
      { op: 'sync_released', root: main },
    ]);
  });
});

test('HTTP deadline cancellation reaches the mutation boundary before creating a worktree', async () => {
  await withRepository(async ({ main, calls, bind, post }) => {
    await bind(main);
    const response = await post('create', { project: 'selected', branch: 'expired' }, Date.now() - 1_000);
    assert.equal(response.status, 499);
    assert.equal((await response.json() as { error: string }).error, 'WORKSPACE_REQUEST_CANCELLED');
    assert.equal(await git(main, 'branch', '--list', 'expired'), '');
    assert.equal(await exists(path.join(path.dirname(main), 'main-worktrees', 'expired')), false);
    assert.deepEqual(calls, []);
  });
});
