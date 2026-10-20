import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as nativeFileSystem from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import { createServer, request as httpRequest } from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import express from 'express';

import { createGitRouter } from '@/modules/git/git.routes.js';
import { bridgeGitFileSystem } from '@/modules/workspace-bridge/index.js';
import { WORKSPACES_ROOT } from '@/shared/index.js';

test('commit preserves a partially staged file and commits the existing index only', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'git-partial-stage-'));
  const execute = promisify(execFile);
  const git = (...args: string[]) => execute('git', args, { cwd: root });
  const commands: string[][] = [];
  const unexpected = async () => { throw new Error('unexpected provider'); };
  let server: ReturnType<typeof createServer> | undefined;
  try {
    await git('init', '-b', 'main');
    await git('config', 'user.name', 'Test');
    await git('config', 'user.email', 'test@example.invalid');
    await writeFile(path.join(root, 'partial.txt'), 'base\n');
    await writeFile(path.join(root, 'other.txt'), 'other base\n');
    await git('add', '--', 'partial.txt', 'other.txt');
    await git('commit', '-m', 'base');
    await writeFile(path.join(root, 'partial.txt'), 'staged hunk\n');
    await git('add', '--', 'partial.txt');
    await writeFile(path.join(root, 'partial.txt'), 'staged hunk\nunstaged hunk\n');
    await writeFile(path.join(root, 'other.txt'), 'other staged\n');
    await git('add', '--', 'other.txt');
    const app = express();
    app.use(express.json());
    app.use(createGitRouter({ fileSystem: nativeFileSystem as never, resolveProjectPathById: () => root,
      spawnProcess: ((command: string, args: string[], options: Parameters<typeof spawn>[2]) => { commands.push(args); return spawn(command, args, options); }) as never,
      queryClaude: unexpected, queryCursor: unexpected }));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/commit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: 'fixture', message: 'preserve staged content', files: ['partial.txt'] }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { success: boolean }).success, true);
    assert.equal((await git('show', 'HEAD:partial.txt')).stdout, 'staged hunk\n');
    assert.equal((await git('show', 'HEAD:other.txt')).stdout, 'other staged\n');
    assert.match((await git('diff', '--', 'partial.txt')).stdout, /\+unstaged hunk/);
    assert.equal((await git('diff', '--cached')).stdout, '');
    assert.equal(commands.some(args => args.includes('add')), false);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
    assert.equal(path.dirname(root), os.tmpdir());
    await rm(root, { recursive: true, force: true });
  }
});

test('status returns the exact branch name when a tag shadows it', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'git-shadowed-branch-'));
  const execute = promisify(execFile);
  const git = (...args: string[]) => execute('git', args, { cwd: root });
  const unexpected = async () => { throw new Error('unexpected provider'); };
  let server: ReturnType<typeof createServer> | undefined;
  try {
    await git('init', '-b', 'topic');
    await git('config', 'user.name', 'Test');
    await git('config', 'user.email', 'test@example.invalid');
    await git('commit', '--allow-empty', '-m', 'base');
    await git('tag', 'topic');
    assert.equal((await git('symbolic-ref', '--short', 'HEAD')).stdout.trim(), 'heads/topic');
    const app = express();
    app.use(createGitRouter({ fileSystem: nativeFileSystem as never, resolveProjectPathById: () => root, spawnProcess: spawn as never, queryClaude: unexpected, queryCursor: unexpected }));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/status?project=fixture`);
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { branch: string }).branch, 'topic');
  } finally {
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
    assert.equal(path.dirname(root), os.tmpdir());
    await rm(root, { recursive: true, force: true });
  }
});

test('branch switching rejects unmerged entries and an unfinished merge without changing HEAD', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'git-switch-conflict-'));
  const execute = promisify(execFile);
  const git = (...args: string[]) => execute('git', args, { cwd: root });
  const unexpected = async () => { throw new Error('unexpected provider'); };
  let server: ReturnType<typeof createServer> | undefined;
  try {
    await git('init', '-b', 'main');
    await git('config', 'user.name', 'Test');
    await git('config', 'user.email', 'test@example.invalid');
    await writeFile(path.join(root, 'conflict.txt'), 'base\n');
    await git('add', '--', 'conflict.txt');
    await git('commit', '-m', 'base');
    await git('switch', '-c', 'topic');
    await writeFile(path.join(root, 'conflict.txt'), 'topic\n');
    await git('commit', '-am', 'topic');
    await git('switch', 'main');
    await writeFile(path.join(root, 'conflict.txt'), 'main\n');
    await git('commit', '-am', 'main');
    await assert.rejects(git('merge', 'topic'));
    const originalHead = (await git('rev-parse', 'HEAD')).stdout;
    const originalIndex = (await git('ls-files', '--stage')).stdout;
    const app = express(); app.use(express.json());
    app.use(createGitRouter({ fileSystem: nativeFileSystem as never, resolveProjectPathById: () => root, spawnProcess: spawn as never, queryClaude: unexpected, queryCursor: unexpected }));
    server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const post = async (endpoint: string, branch: string) => {
      const response = await fetch(`http://127.0.0.1:${(server!.address() as AddressInfo).port}${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: 'fixture', branch }) });
      return { status: response.status, body: await response.json() as { code: string } };
    };
    for (const [endpoint, branch] of [['/checkout', 'topic'], ['/create-branch', 'new-topic']]) {
      const response = await post(endpoint, branch);
      assert.equal(response.status, 409); assert.equal(response.body.code, 'GIT_OPERATION_IN_PROGRESS');
    }
    assert.equal((await git('rev-parse', 'HEAD')).stdout, originalHead);
    assert.equal((await git('ls-files', '--stage')).stdout, originalIndex);
    await writeFile(path.join(root, 'conflict.txt'), 'resolved\n');
    await git('add', '--', 'conflict.txt');
    assert.equal((await git('ls-files', '--unmerged')).stdout, '');
    assert.equal((await post('/checkout', 'topic')).status, 409);
    assert.equal((await git('branch', '--show-current')).stdout.trim(), 'main');
    for (const branch of ['-f', '@{-1}', 'feature/../main', '.hidden', 'bad.lock']) {
      const response = await post('/checkout', branch);
      assert.equal(response.status, 400); assert.equal(response.body.code, 'GIT_INVALID_BRANCH');
    }
  } finally {
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
    assert.equal(path.dirname(root), os.tmpdir());
    await rm(root, { recursive: true, force: true });
  }
});

test('git init does not run when repository validation fails for an execution error', async () => {
  const commands: string[][] = [];
  const spawnProcess = ((_command: string, args: string[]) => {
    commands.push(args);
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    process.nextTick(() => {
      child.emit('error', Object.assign(new Error('permission denied'), { code: 'EACCES' }));
      child.emit('close', -1);
    });
    return child;
  }) as Parameters<typeof createGitRouter>[0]['spawnProcess'];
  const unexpectedProvider = async (): Promise<never> => { throw new Error('unexpected provider call'); };
  const router = createGitRouter({
    fileSystem: { access: async () => undefined } as unknown as Parameters<typeof createGitRouter>[0]['fileSystem'],
    spawnProcess,
    resolveProjectPathById: () => '/workspace/repo',
    queryClaude: unexpectedProvider,
    queryCursor: unexpectedProvider,
  });
  const app = express();
  app.use(express.json());
  app.use('/api/git', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/git/init`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'project-1' }),
    });
    const body = await response.json() as { success: boolean; error: string };
    assert.equal(body.success, false);
    assert.match(body.error, /permission denied/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  assert.deepEqual(commands, [['rev-parse', '--is-inside-work-tree']]);
});

test('delete branch parses force and uses Git force deletion', async () => {
  const commands: string[][] = [];
  const spawnProcess = ((_command: string, args: string[]) => {
    commands.push(args);
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    process.nextTick(() => {
      if (args.includes('--is-inside-work-tree')) child.stdout.write('true\n');
      if (args.includes('--show-toplevel')) child.stdout.write('/workspace/repo\n');
      if (args.includes('--show-current')) child.stdout.write('main\n');
      if (args.includes('-D')) child.stdout.write('Deleted branch feature/unmerged.\n');
      child.stdout.end();
      child.stderr.end();
      child.emit('close', 0);
    });
    return child;
  }) as Parameters<typeof createGitRouter>[0]['spawnProcess'];
  const unexpectedProvider = async (): Promise<never> => { throw new Error('unexpected provider call'); };
  const router = createGitRouter({
    fileSystem: { access: async () => undefined } as unknown as Parameters<typeof createGitRouter>[0]['fileSystem'],
    spawnProcess,
    resolveProjectPathById: () => '/workspace/repo',
    queryClaude: unexpectedProvider,
    queryCursor: unexpectedProvider,
  });
  const app = express();
  app.use(express.json());
  app.use('/api/git', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/git/delete-branch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'project-1', branch: 'feature/unmerged', force: true }),
    });
    const body = await response.json() as { success: boolean; output: string };
    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.match(body.output, /Deleted branch/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  assert.deepEqual(commands.at(-1), ['branch', '-D', '--', 'feature/unmerged']);
});

test('delete branch rejects a non-boolean force value before running Git', async () => {
  const spawnProcess = (() => {
    throw new Error('Git must not run for invalid input');
  }) as Parameters<typeof createGitRouter>[0]['spawnProcess'];
  const unexpectedProvider = async (): Promise<never> => { throw new Error('unexpected provider call'); };
  const router = createGitRouter({
    fileSystem: { access: async () => undefined } as unknown as Parameters<typeof createGitRouter>[0]['fileSystem'],
    spawnProcess,
    resolveProjectPathById: () => '/workspace/repo',
    queryClaude: unexpectedProvider,
    queryCursor: unexpectedProvider,
  });
  const app = express();
  app.use(express.json());
  app.use('/api/git', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/git/delete-branch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'project-1', branch: 'feature/unmerged', force: 'yes' }),
    });
    const body = await response.json() as { error: string };
    assert.equal(response.status, 400);
    assert.equal(body.error, 'force must be a boolean');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('initial commit preserves an authoritative workspace failure instead of treating it as missing HEAD', async () => {
  const root = await mkdtemp(path.join(path.resolve(WORKSPACES_ROOT), 'git-authoritative-'));
  const calls: Array<Record<string, unknown>> = [];
  const control = createServer(async (incoming, outgoing) => {
    const bytes: Buffer[] = [];
    for await (const chunk of incoming) bytes.push(Buffer.from(chunk));
    const request = JSON.parse(Buffer.concat(bytes).toString()) as Record<string, unknown>;
    calls.push(request);
    if (request.op === 'stat') outgoing.end(JSON.stringify({ size: 0, mtime: 1, mode: 0o755, dir: true }));
    else if ((request.argv as string[]).includes('--is-inside-work-tree')) outgoing.end(JSON.stringify({ stdout: 'true', exitCode: 0 }));
    else if ((request.argv as string[]).includes('--show-toplevel')) outgoing.end(JSON.stringify({ stdout: '/workspace\n', exitCode: 0 }));
    else { outgoing.statusCode = 503; outgoing.end(JSON.stringify({ error: 'workspace unavailable', code: 'WORKSPACE_UNAVAILABLE' })); }
  });
  control.listen(0, '127.0.0.1');
  await once(control, 'listening');
  const controlPort = (control.address() as AddressInfo).port;
  await writeFile(path.join(root, '.chisa-bridge.json'), JSON.stringify({ protocol: 1, port: controlPort, token: 'fixture', bindingEpoch: 'fixture' }));
  const app = express();
  app.use(express.json());
  const unexpected = async () => { throw new Error('unexpected provider'); };
  app.use(createGitRouter({
    fileSystem: bridgeGitFileSystem({} as never),
    resolveProjectPathById: () => root,
    spawnProcess: (() => { throw new Error('unexpected local Git'); }) as never,
    queryClaude: unexpected, queryCursor: unexpected,
  }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/initial-commit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: 'fixture' }) });
    assert.equal(response.status, 503);
    assert.match((await response.json() as { error: string }).error, /workspace unavailable/);
    assert.equal(calls.filter(call => call.op === 'exec').length, 3);
    assert.equal(calls.some(call => (call.argv as string[] | undefined)?.includes('add')), false);
  } finally {
    for (const listener of [server, control]) { listener.closeAllConnections(); await new Promise<void>(resolve => listener.close(() => resolve())); }
    assert.equal(path.dirname(root), path.resolve(WORKSPACES_ROOT));
    await rm(root, { recursive: true, force: true });
  }
});

test('HTTP disconnection cancels local Git and prevents a later commit stage', { timeout: 5000 }, async () => {
  const entering = (() => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; })();
  const cancelled = (() => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; })();
  const calls: string[][] = [];
  const spawnProcess = ((_command: string, args: string[], options: { signal: AbortSignal }) => {
    calls.push(args);
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
    queueMicrotask(() => {
      if (args.includes('--is-inside-work-tree')) child.stdout.write('true');
      if (args.includes('--show-toplevel')) child.stdout.write('/fixture-repo');
      if (args.includes('symbolic-ref')) {
        entering.resolve();
        options.signal.addEventListener('abort', () => {
          child.emit('error', Object.assign(new Error('cancelled'), { name: 'AbortError' }));
          child.emit('close', -1);
          cancelled.resolve();
        }, { once: true });
      } else child.emit('close', 0);
    });
    return child;
  }) as Parameters<typeof createGitRouter>[0]['spawnProcess'];
  const app = express();
  app.use(express.json());
  const unexpected = async () => { throw new Error('unexpected provider'); };
  app.use(createGitRouter({ fileSystem: { access: async () => {} } as never, spawnProcess, resolveProjectPathById: () => '/fixture-repo', queryClaude: unexpected, queryCursor: unexpected }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const client = httpRequest({ hostname: '127.0.0.1', port: (server.address() as AddressInfo).port, path: '/pull', method: 'POST', headers: { 'Content-Type': 'application/json' } });
  client.on('error', () => {});
  client.end(JSON.stringify({ project: 'fixture' }));
  try {
    await entering.promise;
    client.destroy();
    await cancelled.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(calls.length, 3);
    assert.equal(calls.some(args => args.includes('pull')), false);
  } finally {
    client.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
