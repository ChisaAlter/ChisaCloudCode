import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test, { mock } from 'node:test';

import express from 'express';

import { AppError } from '@/shared/index.js';
import type { ProviderRunFunction, ProviderRuntimeWriter } from '@/shared/index.js';

const root = path.resolve('git-commit-message-fixture');
const readScope = new AsyncLocalStorage<boolean>();
const requestScope = new AsyncLocalStorage<AbortSignal>();
let activeRead = false;
let readReservations = 0;
let providerCalls = 0;
let history: string[] = [];
let commandArgs: string[][] = [];
let hasCommits = true;
let collectionError: Error | undefined;
let changedPath = false;
let resolutions = 0;
let query: ProviderRunFunction;
let afterRead: (() => void) | undefined;
let requestController: AbortController;

mock.module('@/modules/workspace-bridge/index.js', { namedExports: {
  resolveSshProjectTarget() { return null; },
  async withWorkspaceGitReadOperation<T>(_cwd: string, operation: () => Promise<T>): Promise<T> {
    assert.equal(activeRead, false, 'Git workflow must have only one read reservation');
    readReservations += 1;
    activeRead = true;
    history.push('git-enter');
    try { return await readScope.run(true, operation); }
    finally { activeRead = false; history.push('git-release'); afterRead?.(); }
  },
  async withWorkspaceWriteOperation() { assert.fail('commit generation must not acquire the mutating Git wrapper'); },
  async runWorkspaceGitBranchOperation() { assert.fail('commit generation must not change Git branches'); },
  workspaceRequestScope(_request: unknown, response: express.Response, next: () => void) {
    requestController = new AbortController();
    const close = () => { if (!response.writableFinished) requestController.abort(); };
    response.once('close', close);
    response.once('finish', () => response.off('close', close));
    requestScope.run(requestController.signal, next);
  },
  workspaceRequestSignal() { const signal = requestScope.getStore(); signal?.throwIfAborted(); return signal; },
  async runWorkspaceCommand(_cwd: string, _command: string, args: string[], options: { readOnly?: boolean }) {
    assert.equal(activeRead, true, 'Git collection command escaped its reservation');
    assert.equal(readScope.getStore(), true);
    assert.equal(options.readOnly, true, 'inspection must retain read command classification');
    commandArgs.push(args);
    if (collectionError) throw collectionError;
    let stdout = '';
    if (args.includes('--is-inside-work-tree')) stdout = 'true\n';
    else if (args.includes('--show-toplevel')) stdout = root + '\n';
    else if (args.includes('--verify') && !hasCommits) throw Object.assign(new Error('bad revision HEAD'), { stderr: 'bad revision HEAD' });
    else if (args[0] === 'status') stdout = ' M file.txt\0';
    else if (args[0] === 'diff') stdout = 'diff --git a/file.txt b/file.txt\n-old\n+new\n';
    return { exitCode: 0, stdout, stderr: '' };
  },
} });

const { createGitRouter } = await import('../git.routes.js');
const { gitOperationReadOnly } = await import('../git-operation.service.js');

async function startRouter() {
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => { (request as express.Request & { user: { id: number } }).user = { id: 73 }; next(); });
  const run: ProviderRunFunction = async (prompt, options, writer) => {
    assert.equal(activeRead, false, 'provider started before the Git reservation closed');
    assert.equal(readScope.getStore(), undefined, 'the provider inherited a live Git reservation context');
    assert.equal(gitOperationReadOnly(), false, 'Git classification must end before the provider phase');
    assert.equal(writer.userId, 73);
    assert.equal(options.cwd, root);
    assert.equal(options.permissionMode, 'plan');
    assert.equal(options.skipPermissions, undefined);
    assert.equal(options.abortSignal, requestController.signal);
    assert.match(prompt, /-old\n\+new/);
    assert.match(prompt, /file\.txt/);
    providerCalls += 1;
    history.push('provider');
    return query(prompt, options, writer);
  };
  app.use(createGitRouter({
    fileSystem: { access: async () => { assert.equal(activeRead, true); } } as never,
    spawnProcess: (() => assert.fail('remote fixture must not execute host Git')) as never,
    resolveProjectPathById: () => { resolutions += 1; return changedPath && resolutions > 1 ? root + '-changed' : root; },
    queryClaude: run,
    queryCursor: run,
  }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function stopRouter(server: Server) {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

async function generate(body: unknown = { project: 'project', files: ['file.txt'] }) {
  const { server, url } = await startRouter();
  try {
    const response = await fetch(url + '/generate-commit-message', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  } finally { await stopRouter(server); }
}

function emit(writer: ProviderRuntimeWriter, messages: unknown[]) { for (const message of messages) writer.send(message); }

test.beforeEach(() => {
  activeRead = false; readReservations = 0; providerCalls = 0; history = []; commandArgs = [];
  hasCommits = true; collectionError = undefined; changedPath = false; resolutions = 0; afterRead = undefined;
  query = async (_prompt, _options, writer) => writer.send({ kind: 'text', role: 'assistant', content: 'fix: describe actual changes' });
});

test('commit generation releases its only Git lease before read-only Claude admission and collects normalized text once', async () => {
  query = async (_prompt, _options, writer) => emit(writer, [
    { kind: 'text', role: 'user', content: 'prompt echo must be ignored' },
    { kind: 'stream_delta', content: 'fix(git): ' },
    JSON.stringify({ kind: 'delta', text: 'show real changes' }),
    { kind: 'text', role: 'assistant', id: 'reply', content: 'fix(git): show real changes\n\nExplain the actual fix.' },
    { kind: 'text', role: 'assistant', id: 'reply', content: 'fix(git): show real changes\n\nExplain the actual fix.' },
    { kind: 'complete', exitCode: 0 },
  ]);
  const result = await generate();
  assert.deepEqual(result, { status: 200, body: { message: 'fix(git): show real changes\n\nExplain the actual fix.' } });
  assert.equal(readReservations, 1);
  assert.equal(providerCalls, 1);
  assert.deepEqual(history, ['git-enter', 'git-release', 'provider']);
});

test('stream-only normalized chunks generate a commit message', async () => {
  query = async (_prompt, _options, writer) => emit(writer, [{ kind: 'stream_delta', content: 'fix: ' }, { kind: 'stream_delta', content: 'collect streamed output' }]);
  assert.deepEqual(await generate(), { status: 200, body: { message: 'fix: collect streamed output' } });
});

test('Cursor stays supported with its own read-only plan and legacy output', async () => {
  query = async (_prompt, _options, writer) => emit(writer, [{ type: 'cursor-output', output: '```text\nfeat: preserve Cursor\n```' }]);
  assert.deepEqual(await generate({ project: 'project', files: ['file.txt'], provider: 'cursor' }), { status: 200, body: { message: 'feat: preserve Cursor' } });
});

test('legacy Claude text remains supported without collecting a prompt echo', async () => {
  query = async (_prompt, _options, writer) => emit(writer, [
    { type: 'claude-response', data: { message: { role: 'user', content: [{ type: 'text', text: 'ignore prompt echo' }] } } },
    { type: 'claude-response', data: { message: { role: 'assistant', content: [{ type: 'text', text: 'fix: preserve old output' }] } } },
  ]);
  assert.equal((await generate()).body.message, 'fix: preserve old output');
});

test('a real provider exception is returned with its original code and never generic fallback', async () => {
  query = async () => { throw new AppError('The model endpoint refused this owner', { code: 'MODEL_CONNECTION_FORBIDDEN', statusCode: 403 }); };
  assert.deepEqual(await generate(), { status: 403, body: { success: false, error: 'The model endpoint refused this owner', code: 'MODEL_CONNECTION_FORBIDDEN' } });
  assert.equal(activeRead, false);
});

test('normalized provider errors remain failures even after partial output', async () => {
  query = async (_prompt, _options, writer) => emit(writer, [
    { kind: 'stream_delta', content: 'chore: partial' },
    { kind: 'error', content: 'Endpoint unavailable', code: 'MODEL_ENDPOINT_UNAVAILABLE' },
    { kind: 'complete', exitCode: 1 },
  ]);
  assert.deepEqual(await generate(), { status: 503, body: { success: false, error: 'Endpoint unavailable', code: 'MODEL_ENDPOINT_UNAVAILABLE' } });
});

test('empty or malformed provider output is explicit failure instead of invented commit text', async () => {
  for (const messages of [[], ['invalid JSON'], [{ kind: 'complete', exitCode: 1 }], [{ kind: 'text', content: 'chore: partial' }, { kind: 'complete', exitCode: 0, success: false, aborted: true }]]) {
    query = async (_prompt, _options, writer) => emit(writer, messages);
    const result = await generate();
    assert.ok(result.status >= 500);
    assert.equal(result.body.message, undefined);
    assert.doesNotMatch(JSON.stringify(result.body), /chore: update/);
  }
});

test('first-commit snapshot reads the index diff without an invalid HEAD diff', async () => {
  hasCommits = false;
  assert.equal((await generate()).status, 200);
  const diff = commandArgs.find(args => args[0] === 'diff');
  assert.ok(diff?.includes('--cached'));
  assert.equal(diff?.includes('HEAD'), false);
});

test('collection errors and changed selection prevent provider admission', async () => {
  collectionError = new AppError('SSH unavailable', { code: 'SSH_WORKSPACE_UNAVAILABLE', statusCode: 503 });
  assert.equal((await generate()).body.code, 'SSH_WORKSPACE_UNAVAILABLE');
  assert.equal(providerCalls, 0);
  collectionError = undefined; changedPath = true; resolutions = 0;
  assert.equal((await generate()).body.code, 'WORKSPACE_SELECTION_MISMATCH');
  assert.equal(providerCalls, 0);
});

test('cancellation after collection cleanup prevents any provider start', async () => {
  afterRead = () => requestController.abort(new AppError('Cancelled while returning the Git workspace', { code: 'WORKSPACE_REQUEST_CANCELLED', statusCode: 499 }));
  assert.equal((await generate()).body.code, 'WORKSPACE_REQUEST_CANCELLED');
  assert.equal(providerCalls, 0);
  assert.equal(activeRead, false);
});

test('invalid file payload and traversal are rejected before acquiring any lease', async () => {
  for (const body of [{ project: 'project', files: 'file.txt' }, { project: 'project', files: [null] }, { project: 'project', files: ['../secrets'] }]) {
    assert.equal((await generate(body)).status, 400);
  }
  assert.equal(readReservations, 0);
  assert.equal(providerCalls, 0);
});
