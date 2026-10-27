import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import test, { mock } from 'node:test';
import type { TestContext } from 'node:test';

import express from 'express';

import { closeConnection, initializeDatabase, projectsDb, sessionsDb } from '@/modules/database/index.js';
// Catalog/selector fixtures deliberately do not restore an account runtime.
mock.module('@/modules/workspace-runtime/index.js', { namedExports: {
  ensureCloudWorkspaceBinding() {}, excludeCloudWorkspaceMetadata() {}, getWorkspaceRuntimeIdentity() { return undefined; },
  assertCloudWorkspaceOwner() { assert.fail('unexpected account-history authorization in catalog fixture'); },
  executeWorkspaceRuntimePreview() { assert.fail('unexpected preview'); }, createWorkspaceRuntimeService() { assert.fail('unexpected restore'); },
} });
const { assertWorkspaceDescriptor, bridgeFileSystem, describeWorkspaceSelection, isWorkspaceBound, workspaceRequestScope } = await import('@/modules/workspace-bridge/index.js');
const { resolveSelectedWorkspace } = await import('@/modules/workspaces/index.js');
import { AppError, WORKSPACES_ROOT } from '@/shared/index.js';
import type { FileTreeFileSystem, WorkspaceDescriptor, WorkspaceSelector } from '@/shared/index.js';

import { createCommandsRouter } from '../commands.routes.js';
import { createCommandsService } from '../commands.service.js';

type Dependencies = Parameters<typeof createCommandsService>[0];
const sourceRoot = path.resolve('command-test-source');
const sessionRoot = path.resolve('command-test-session');
const userRoot = path.resolve('command-test-home');
const commandPath = (root: string, name = 'check.md') => path.join(root, '.claude', 'commands', name);
const makeError = (code: string, statusCode = 409) => new AppError(code, { code, statusCode });
const replica: WorkspaceDescriptor = {
  projectId: 'project', workspaceId: 'replica', generation: 'replica-generation', kind: 'cloudReplica',
  rootPath: sourceRoot, sourceRoot, requestedMode: 'shared', effectiveMode: 'shared', phase: 'idle', publicationState: 'integrated',
  capabilities: { read: true, write: true, git: true, shell: true, preview: true, integrate: false, cloudExecutionIndependentOfDesktop: true },
};
const selected: WorkspaceDescriptor = {
  ...replica, workspaceId: 'session-workspace', generation: 'session-generation', kind: 'session', sessionId: 'chat',
  rootPath: sessionRoot, requestedMode: 'isolated', effectiveMode: 'isolated', publicationState: 'unpublished',
};
const selector = (descriptor = selected) => ({ projectId: descriptor.projectId, workspaceId: descriptor.workspaceId, generation: descriptor.generation, ...(descriptor.sessionId ? { sessionId: descriptor.sessionId } : {}) });
function stats(directory = false, symlink = false): Awaited<ReturnType<FileTreeFileSystem['lstat']>> {
  return { size: 100, mtime: new Date(0), mode: symlink ? 0o120777 : directory ? 0o040755 : 0o100644, isDirectory: () => directory, isSymbolicLink: () => symlink };
}
function memoryFiles(contents: Record<string, string> = {}) {
  const files = new Map(Object.entries(contents));
  const directories = new Set<string>();
  const symlinks = new Set<string>();
  const reads: string[] = [];
  for (const file of files.keys()) {
    let parent = path.dirname(file);
    while (!directories.has(parent)) {
      directories.add(parent);
      if (parent === path.dirname(parent)) break;
      parent = path.dirname(parent);
    }
  }
  const adapter: Dependencies['files'] = {
    async lstat(candidate) {
      if (symlinks.has(candidate)) return stats(false, true);
      if (files.has(candidate)) return stats();
      if (directories.has(candidate)) return stats(true);
      throw Object.assign(new Error('Missing fixture path'), { code: 'ENOENT' });
    },
    async realpath(candidate) { return candidate; },
    async *openDirectory(candidate) {
      const names = new Set([...directories, ...files.keys(), ...symlinks]);
      for (const entry of names) if (path.dirname(entry) === candidate && entry !== candidate) {
        yield { name: path.basename(entry), isDirectory: () => directories.has(entry) };
      }
    },
    async readTextFile(candidate) {
      reads.push(candidate);
      const text = files.get(candidate);
      if (text === undefined) throw Object.assign(new Error('Missing fixture file'), { code: 'ENOENT' });
      return text;
    },
  };
  return { adapter, files, directories, symlinks, reads };
}
function fixture(overrides: Partial<Dependencies> = {}) {
  const memory = memoryFiles({
    [commandPath(sourceRoot)]: 'SOURCE ONLY',
    [commandPath(sessionRoot)]: '---\ndescription: Selected session command\n---\nSESSION $ARGUMENTS / $1 / $10\n@notes.txt\n!pwd',
    [commandPath(userRoot, 'user.md')]: 'USER COMMAND',
    [path.join(sessionRoot, 'CLAUDE.md')]: 'SESSION MEMORY',
  });
  const calls: Array<{ projectId: string; selector?: WorkspaceSelector }> = [];
  const state = { materialized: true, generation: selected.generation, bound: true, assertionError: undefined as Error | undefined };
  const dependencies: Dependencies = {
    files: memory.adapter, homeDirectory: () => userRoot, readPackage: async () => '{"name":"fixture","version":"1.0"}',
    runtime: { uptime: () => 1, memoryUsage: () => ({ rss: 0, heapUsed: 0, heapTotal: 0, external: 0, arrayBuffers: 0 }), version: 'fixture', platform: 'linux', pid: 1 },
    models: { getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'model' }), resolveSessionModel: async () => ({ model: 'model' }) } as unknown as Dependencies['models'],
    workspace: {
      resolve(projectId, selection) {
        calls.push({ projectId, selector: selection });
        if (projectId !== 'project') throw makeError('PROJECT_NOT_FOUND', 404);
        if (!selection) {
          if (state.bound) throw makeError('WORKSPACE_SELECTOR_REQUIRED', 400);
          return replica;
        }
        if (selection.sessionId && selection.sessionId !== 'chat') throw makeError('WORKSPACE_SELECTION_MISMATCH');
        if (selection.sessionId && !state.materialized) throw makeError('WORKSPACE_SESSION_NOT_READY');
        const descriptor = selection.sessionId || selection.workspaceId === selected.workspaceId ? { ...selected, generation: state.generation } : replica;
        if (descriptor.workspaceId !== selection.workspaceId) throw makeError('WORKSPACE_SELECTION_MISMATCH');
        if (descriptor.generation !== selection.generation) throw makeError('WORKSPACE_GENERATION_CHANGED');
        return descriptor;
      },
      assert() { if (state.assertionError) throw state.assertionError; },
      isBound: () => state.bound,
      projectIdForPath: candidate => candidate === sourceRoot ? 'project' : null,
    },
    ...overrides,
  };
  return { memory, calls, state, dependencies, service: createCommandsService(dependencies) };
}
async function startApi(context: TestContext, service: ReturnType<typeof createCommandsService>) {
  const server = express().use(express.json()).use('/commands', createCommandsRouter(service, workspaceRequestScope)).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  context.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return async (endpoint: string, body: unknown) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/commands/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
}

test('list, custom preparation and memory all use the selected root and return its identity', async context => {
  const f = fixture();
  const post = await startApi(context, f.service);
  const scope = { ...selector(), projectPath: sourceRoot };
  const listing = await post('list', scope);
  assert.equal(listing.status, 200);
  assert.deepEqual(listing.body.workspace, selected);
  assert.equal(listing.body.custom.find((entry: any) => entry.namespace === 'project').path, commandPath(sessionRoot));
  assert.equal(listing.body.custom.find((entry: any) => entry.namespace === 'project').description, 'Selected session command');
  assert.ok(!f.memory.reads.includes(commandPath(sourceRoot)));
  const args = ['$&$2', 'two', '3', '4', '5', '6', '7', '8', '9', 'ten'];
  const execution = await post('execute', { commandName: '/check', commandPath: commandPath(sessionRoot), args, context: scope });
  assert.equal(execution.status, 200);
  assert.equal(execution.body.content, `SESSION ${args.join(' ')} / $&$2 / ten\n@notes.txt\n!pwd`);
  assert.equal(execution.body.hasBashCommands, true);
  assert.equal(execution.body.hasFileIncludes, true);
  assert.deepEqual(execution.body.workspace, selected);
  assert.ok(f.memory.reads.every(candidate => candidate.endsWith('.md')), 'provider instructions were not expanded before confirmation');
  const memory = await post('execute', { commandName: '/memory', context: scope });
  assert.equal(memory.status, 200);
  assert.equal(memory.body.data.path, path.join(sessionRoot, 'CLAUDE.md'));
  assert.equal(memory.body.data.exists, true);
  assert.deepEqual(memory.body.workspace, selected);
});

test('every scoped built-in response carries the exact descriptor', async context => {
  const f = fixture();
  const post = await startApi(context, f.service);
  for (const commandName of ['/help', '/config', '/models', '/cost', '/status', '/memory']) {
    const response = await post('execute', { commandName, context: selector() });
    assert.equal(response.status, 200, commandName);
    assert.deepEqual(response.body.workspace, selected, commandName);
  }
});

test('missing, foreign, stale and wrong-session selectors fail before any reads', async context => {
  const f = fixture();
  const post = await startApi(context, f.service);
  const cases = [
    [{ projectId: 'project' }, 400, 'WORKSPACE_SELECTOR_REQUIRED'],
    [{ projectPath: sourceRoot }, 400, 'PROJECT_ID_REQUIRED'],
    [{ workspaceId: selected.workspaceId, generation: selected.generation }, 400, 'PROJECT_ID_REQUIRED'],
    [{ ...selector(), generation: 'old' }, 409, 'WORKSPACE_GENERATION_CHANGED'],
    [{ ...selector(), workspaceId: 'foreign' }, 409, 'WORKSPACE_SELECTION_MISMATCH'],
    [{ ...selector(), sessionId: 'other-session' }, 409, 'WORKSPACE_SELECTION_MISMATCH'],
    [{ ...selector(), projectId: 'other-project' }, 404, 'PROJECT_NOT_FOUND'],
    [{ ...selector(replica), sessionId: 'chat' }, 409, 'WORKSPACE_SELECTION_MISMATCH'],
  ] as const;
  for (const [scope, status, code] of cases) {
    for (const endpoint of ['list', 'execute']) {
      const response = await post(endpoint, endpoint === 'list' ? scope : { commandName: '/check', commandPath: commandPath(sessionRoot), context: scope });
      assert.equal(response.status, status, JSON.stringify(scope));
      assert.equal(response.body.code, code);
    }
  }
  assert.deepEqual(f.memory.reads, []);
});

test('unmaterialized chat may select its replica but cannot borrow another session workspace', async context => {
  const f = fixture();
  f.state.materialized = false;
  const post = await startApi(context, f.service);
  const response = await post('execute', { commandName: '/check', commandPath: commandPath(sourceRoot), context: { ...selector(replica), sessionId: 'chat' } });
  assert.equal(response.status, 200);
  assert.equal(response.body.content, 'SOURCE ONLY');
  assert.deepEqual(response.body.workspace, replica);
  const other = await post('execute', { commandName: '/check', commandPath: commandPath(sessionRoot), context: selector() });
  assert.equal(other.status, 409);
  assert.equal(other.body.code, 'WORKSPACE_SELECTION_MISMATCH');
});

test('generation changes during command reads discard output and never retry against source', async context => {
  const f = fixture();
  const read = f.memory.adapter.readTextFile;
  f.memory.adapter.readTextFile = async candidate => {
    const text = await read(candidate);
    f.state.generation = 'replacement-generation';
    return text;
  };
  const post = await startApi(context, f.service);
  const response = await post('execute', { commandName: '/check', commandPath: commandPath(sessionRoot), context: selector() });
  assert.equal(response.status, 409);
  assert.equal(response.body.code, 'WORKSPACE_GENERATION_CHANGED');
  assert.equal(response.body.content, undefined);
  assert.deepEqual(f.memory.reads, [commandPath(sessionRoot)]);
});

test('replica bootstrap is rechecked after awaits if the chat workspace materializes', async context => {
  const f = fixture();
  f.state.materialized = false;
  const read = f.memory.adapter.readTextFile;
  f.memory.adapter.readTextFile = async candidate => { const text = await read(candidate); f.state.materialized = true; return text; };
  const post = await startApi(context, f.service);
  const response = await post('execute', { commandName: '/check', commandPath: commandPath(sourceRoot), context: { ...selector(replica), sessionId: 'chat' } });
  assert.equal(response.status, 409);
  assert.equal(response.body.code, 'WORKSPACE_SELECTION_MISMATCH');
  assert.equal(response.body.content, undefined);
});

test('scan and memory retain workspace transport errors instead of treating them as missing files', async context => {
  const f = fixture();
  f.memory.adapter.lstat = async () => { throw makeError('WORKSPACE_UNAVAILABLE', 503); };
  const post = await startApi(context, f.service);
  for (const [endpoint, body] of [
    ['list', selector()],
    ['execute', { commandName: '/memory', context: selector() }],
    ['execute', { commandName: '/check', commandPath: commandPath(sessionRoot), context: selector() }],
  ] as const) {
    const response = await post(endpoint, body);
    assert.equal(response.status, 503);
    assert.equal(response.body.code, 'WORKSPACE_UNAVAILABLE');
  }
});

test('missing optional directories and memory retain their normal empty states', async context => {
  const f = fixture();
  f.memory.files.clear();
  f.memory.directories.clear();
  const post = await startApi(context, f.service);
  const list = await post('list', selector());
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.custom, []);
  const memory = await post('execute', { commandName: '/memory', context: selector() });
  assert.equal(memory.status, 200);
  assert.equal(memory.body.data.exists, false);
  const custom = await post('execute', { commandName: '/check', commandPath: commandPath(sessionRoot), context: selector() });
  assert.equal(custom.status, 404);
});

test('custom commands reject source, sibling-prefix, private and symlink paths', async context => {
  const f = fixture();
  f.memory.symlinks.add(commandPath(sessionRoot, 'linked.md'));
  f.memory.symlinks.add(path.join(sessionRoot, '.claude', 'commands', 'linked-directory'));
  const post = await startApi(context, f.service);
  for (const candidate of [
    commandPath(sourceRoot),
    path.join(sessionRoot, '.claude', 'commands-copy', 'check.md'),
    commandPath(sessionRoot, '../secret.md'),
    commandPath(sessionRoot, '.chisa-bridge.json.md'),
    commandPath(sessionRoot, 'linked.md'),
    commandPath(sessionRoot, 'linked-directory/command.md'),
  ]) {
    const response = await post('execute', { commandName: '/check', commandPath: candidate, context: selector() });
    assert.equal(response.status, 403, candidate);
    assert.equal(response.body.code, 'COMMAND_PATH_DENIED');
  }
  assert.deepEqual(f.memory.reads, []);
});

test('canonical path escape is rejected even when lstat does not report a symlink', async context => {
  const f = fixture();
  f.memory.adapter.realpath = async candidate => candidate === commandPath(sessionRoot) ? commandPath(sourceRoot) : candidate;
  const post = await startApi(context, f.service);
  const response = await post('execute', { commandName: '/check', commandPath: commandPath(sessionRoot), context: selector() });
  assert.equal(response.status, 403);
  assert.equal(response.body.code, 'COMMAND_PATH_DENIED');
  assert.deepEqual(f.memory.reads, []);
});

test('scan does not return a partial success when an advertised file disappears', async context => {
  const f = fixture();
  f.memory.adapter.readTextFile = async () => { throw Object.assign(new Error('Concurrent removal'), { code: 'ENOENT' }); };
  const post = await startApi(context, f.service);
  const response = await post('list', selector());
  assert.equal(response.status, 404);
  assert.equal(response.body.custom, undefined);
});

test('list never advertises private or symlinked command files', async context => {
  const f = fixture();
  f.memory.files.set(commandPath(sessionRoot, '.chisa-secret.md'), 'PRIVATE');
  f.memory.symlinks.add(commandPath(sessionRoot, 'linked.md'));
  const post = await startApi(context, f.service);
  const response = await post('list', selector());
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.custom.map((entry: any) => entry.name), ['/check', '/user']);
  assert.ok(f.memory.reads.every(candidate => !candidate.includes('.chisa-secret')));
});

test('unbound registered legacy project paths resolve through the server catalog', async context => {
  const f = fixture();
  f.state.bound = false;
  const post = await startApi(context, f.service);
  const response = await post('execute', { commandName: '/check', commandPath: commandPath(sourceRoot), context: { projectPath: sourceRoot } });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.workspace, replica);
  const unknown = await post('list', { projectPath: '/arbitrary/client/path' });
  assert.equal(unknown.status, 404);
});

test('route rejects malformed selectors and conflicts while accepting query selectors', async context => {
  const f = fixture();
  const post = await startApi(context, f.service);
  for (const scope of [
    { ...selector(), generation: null }, { ...selector(), workspaceId: ['session-workspace'] },
    { ...selector(), generation: '' }, { projectId: 'project', workspaceId: selected.workspaceId },
    { ...selector(), projectId: 'project\0' },
  ]) {
    assert.equal((await post('execute', { commandName: '/help', context: scope })).status, 400);
  }
  assert.equal((await post('execute?generation=other', { commandName: '/help', context: selector() })).status, 400);
  const query = new URLSearchParams(selector()).toString();
  const response = await post(`execute?${query}`, { commandName: '/help' });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.workspace, selected);
  assert.equal((await post('execute', { commandName: '/help', args: {} })).status, 400);
});

test('durable catalog rejects retired local command reads without callback or host fallback', async context => {
  await mkdir(WORKSPACES_ROOT, { recursive: true });
  const container = await mkdtemp(path.join(path.resolve(WORKSPACES_ROOT), 'commands-api-fixture-'));
  const project = path.join(container, 'project');
  const home = path.join(container, 'home');
  await Promise.all([mkdir(project), mkdir(home)]);
  const previousDatabase = process.env.DATABASE_PATH;
  closeConnection();
  process.env.DATABASE_PATH = path.join(container, 'app.db');
  await writeFile(process.env.DATABASE_PATH, '');
  context.after(async () => {
    closeConnection();
    if (previousDatabase === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previousDatabase;
    assert.equal(path.dirname(container), path.resolve(WORKSPACES_ROOT));
    assert.ok(path.basename(container).startsWith('commands-api-fixture-'));
    await rm(container, { recursive: true, force: true });
  });
  await initializeDatabase();
  const projectId = projectsDb.createProjectPath(project).project!.project_id;
  sessionsDb.createAppSession('pending-chat', 'claude', project);
  const otherProject = path.join(container, 'other');
  await mkdir(otherProject);
  projectsDb.createProjectPath(otherProject);
  sessionsDb.createAppSession('foreign-chat', 'claude', otherProject);
  let transportUnavailable = false;
  const requests: Array<{ op: string; path: string }> = [];
  let fixtureFailure: unknown;
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      assert.equal(incoming.url, '/workspace/rpc');
      assert.equal(incoming.headers['x-bridge-token'], 'commands-token');
      assert.equal(incoming.headers['x-binding-epoch'], 'commands-epoch');
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { op: string; path: string };
      requests.push(request);
      if (transportUnavailable) {
        outgoing.writeHead(503, { 'Content-Type': 'application/json' });
        outgoing.end(JSON.stringify({ code: 'WORKSPACE_UNAVAILABLE', error: 'Offline fixture' }));
        return;
      }
      let result: unknown;
      const directories = ['/workspace', '/workspace/.claude', '/workspace/.claude/commands'];
      if (request.op === 'stat' || request.op === 'lstat') result = { size: 100, mtime: 0, mode: directories.includes(request.path) ? 0o040755 : 0o100644, dir: directories.includes(request.path), symlink: false };
      else if (request.op === 'realpath') result = { path: request.path };
      else if (request.op === 'list') result = { entries: [{ name: 'remote.md', dir: false }] };
      else if (request.op === 'read') { assert.equal(request.path, '/workspace/.claude/commands/remote.md'); result = { b64: Buffer.from('REMOTE COMMAND\n@remote.txt\n!pwd').toString('base64') }; }
      else assert.fail(`Unexpected RPC ${request.op}`);
      outgoing.writeHead(200, { 'Content-Type': 'application/json' });
      outgoing.end(JSON.stringify(result));
    })().catch(error => { fixtureFailure = error; outgoing.statusCode = 500; outgoing.end(JSON.stringify({ error: 'Fixture error' })); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (fixtureFailure) throw fixtureFailure;
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await writeFile(path.join(project, '.chisa-bridge.json'), JSON.stringify({ protocol: 1, port: address.port, token: 'commands-token', bindingEpoch: 'commands-epoch' }));
  const descriptor = describeWorkspaceSelection({ projectId, sourceRoot: project }).cloudReplica;
  const base = memoryFiles();
  const failHostRead = async (): Promise<never> => assert.fail('Selected bridge file unexpectedly fell back to the host');
  const bridged = bridgeFileSystem({
    ...base.adapter, access: failHostRead, stat: base.adapter.lstat, readTextFile: failHostRead,
    writeTextFile: failHostRead, makeDirectory: failHostRead, rename: failHostRead, removeDirectory: failHostRead,
    unlink: failHostRead, copyFile: failHostRead, createReadStream: () => assert.fail('Unexpected host stream'),
  });
  const service = fixture({
    files: bridged, homeDirectory: () => home,
    workspace: { resolve: resolveSelectedWorkspace, assert: assertWorkspaceDescriptor, isBound: isWorkspaceBound, projectIdForPath: candidate => projectsDb.getProjectPath(candidate)?.project_id ?? null },
  }).service;
  const post = await startApi(context, service);
  const scope = { ...selector(descriptor), sessionId: 'pending-chat', projectPath: otherProject };
  const response = await post('execute', { commandName: '/remote', commandPath: commandPath(project, 'remote.md'), context: scope });
  assert.equal(response.status, 409, JSON.stringify(response.body));
  assert.equal(response.body.code, 'LOCAL_WORKSPACE_REMOVED');
  const listing = await post('list', selector(descriptor));
  assert.equal(listing.status, 409, JSON.stringify(listing.body));
  assert.equal(listing.body.code, 'LOCAL_WORKSPACE_REMOVED');
  assert.deepEqual(requests, []);
  const before = requests.length;
  for (const invalid of [
    { projectId },
    { ...scope, generation: 'stale' },
    { ...scope, sessionId: 'foreign-chat' },
    { ...scope, sessionId: 'missing-chat' },
  ]) {
    const rejected = await post('execute', { commandName: '/remote', commandPath: commandPath(project, 'remote.md'), context: invalid });
    assert.ok(rejected.status >= 400, JSON.stringify(rejected.body));
  }
  assert.equal(requests.length, before, 'invalid identity must fail before RPC');
  transportUnavailable = true;
  const unavailable = await post('list', selector(descriptor));
  assert.equal(unavailable.status, 409, JSON.stringify(unavailable.body));
  assert.equal(unavailable.body.code, 'LOCAL_WORKSPACE_REMOVED');
  assert.deepEqual(requests, []);
});
