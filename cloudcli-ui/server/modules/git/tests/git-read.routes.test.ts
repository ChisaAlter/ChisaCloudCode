import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import * as nativeFileSystem from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { promisify } from 'node:util';

import express from 'express';

import type { WorkspaceGitFileSystem } from '@/shared/index.js';

import { createGitRouter } from '../git.routes.js';

type RouterDependencies = Parameters<typeof createGitRouter>[0];
const execute = promisify(execFile);
const unexpectedProvider = async (): Promise<never> => { throw new Error('unexpected provider call'); };

async function startRouter(dependencies: Pick<RouterDependencies, 'fileSystem' | 'spawnProcess' | 'resolveProjectPathById'>) {
  const app = express();
  app.use(createGitRouter({ ...dependencies, queryClaude: unexpectedProvider, queryCursor: unexpectedProvider }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function stopRouter(server: Server) {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

for (const staged of [false, true]) {
  test(`read routes show HEAD content for a ${staged ? 'staged-modified then' : 'tracked'} deleted file`, async () => {
    const root = await nativeFileSystem.mkdtemp(path.join(os.tmpdir(), 'git-read-deleted-'));
    const git = (...args: string[]) => execute('git', args, { cwd: root });
    let server: Server | undefined;
    try {
      await git('init', '-b', 'main');
      await git('config', 'user.name', 'Test');
      await git('config', 'user.email', 'test@example.invalid');
      await git('config', 'core.autocrlf', 'false');
      await nativeFileSystem.writeFile(path.join(root, 'deleted.txt'), 'committed content\n');
      await git('add', '--', 'deleted.txt');
      await git('commit', '-m', 'base');
      if (staged) {
        await nativeFileSystem.writeFile(path.join(root, 'deleted.txt'), 'staged content\n');
        await git('add', '--', 'deleted.txt');
      }
      await nativeFileSystem.unlink(path.join(root, 'deleted.txt'));
      const statusBefore = (await git('status', '--porcelain=v1', '-z')).stdout;
      const indexBefore = (await git('ls-files', '--stage')).stdout;
      assert.equal(statusBefore, `${staged ? 'MD' : ' D'} deleted.txt\0`);
      const started = await startRouter({ fileSystem: nativeFileSystem as never, spawnProcess: spawn as never, resolveProjectPathById: () => root });
      server = started.server;
      const response = await fetch(`${started.url}/file-with-diff?project=fixture&file=deleted.txt`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        currentContent: 'committed content\n', oldContent: 'committed content\n', isDeleted: true, isUntracked: false,
      });
      const diffResponse = await fetch(`${started.url}/diff?project=fixture&file=deleted.txt`);
      assert.equal(diffResponse.status, 200);
      const { diff } = await diffResponse.json() as { diff: string };
      assert.match(diff, /-committed content/);
      assert.doesNotMatch(diff, /staged content/);
      assert.equal((await git('status', '--porcelain=v1', '-z')).stdout, statusBefore);
      assert.equal((await git('ls-files', '--stage')).stdout, indexBefore);
    } finally {
      if (server) await stopRouter(server);
      assert.equal(path.dirname(root), os.tmpdir());
      await nativeFileSystem.rm(root, { recursive: true, force: true });
    }
  });
}

for (const hasCommits of [false, true]) {
  test(`read routes show index content for a staged added-deleted file ${hasCommits ? 'absent from HEAD' : 'before the first commit'}`, async () => {
    const root = await nativeFileSystem.mkdtemp(path.join(os.tmpdir(), 'git-read-added-deleted-'));
    const git = (...args: string[]) => execute('git', args, { cwd: root });
    let server: Server | undefined;
    try {
      await git('init', '-b', 'main');
      await git('config', 'user.name', 'Test');
      await git('config', 'user.email', 'test@example.invalid');
      await git('config', 'core.autocrlf', 'false');
      if (hasCommits) await git('commit', '--allow-empty', '-m', 'base');
      await nativeFileSystem.writeFile(path.join(root, 'new.txt'), 'staged addition\n');
      await git('add', '--', 'new.txt');
      await nativeFileSystem.unlink(path.join(root, 'new.txt'));
      const statusBefore = (await git('status', '--porcelain=v1', '-z')).stdout;
      const indexBefore = (await git('ls-files', '--stage')).stdout;
      assert.equal(statusBefore, 'AD new.txt\0');
      const started = await startRouter({ fileSystem: nativeFileSystem as never, spawnProcess: spawn as never, resolveProjectPathById: () => root });
      server = started.server;
      const response = await fetch(`${started.url}/file-with-diff?project=fixture&file=new.txt`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        currentContent: 'staged addition\n', oldContent: '', isDeleted: true, isUntracked: false,
      });
      const diffResponse = await fetch(`${started.url}/diff?project=fixture&file=new.txt`);
      assert.equal(diffResponse.status, 200);
      assert.match((await diffResponse.json() as { diff: string }).diff, /-staged addition/);
      assert.equal((await git('status', '--porcelain=v1', '-z')).stdout, statusBefore);
      assert.equal((await git('ls-files', '--stage')).stdout, indexBefore);
    } finally {
      if (server) await stopRouter(server);
      assert.equal(path.dirname(root), os.tmpdir());
      await nativeFileSystem.rm(root, { recursive: true, force: true });
    }
  });
}

function statusFixture(repositoryRootPath: string, entry: string, filePath: string, previousPath?: string) {
  const commands: string[][] = [];
  const spawnProcess = ((_command: string, args: string[]) => {
    commands.push(args);
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
    process.nextTick(() => {
      try {
        let stdout: string;
        if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') stdout = 'true\n';
        else if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') stdout = `${repositoryRootPath}\n`;
        else if (args[0] === 'symbolic-ref') stdout = 'refs/heads/main\n';
        else if (args[0] === 'rev-parse' && args[1] === '--verify') stdout = 'abc123\n';
        else if (args[0] === 'status') {
          const matches = !args.includes('--') || args.at(-1) === filePath;
          // Match Git's actual output for both the route's old line parser and NUL porcelain.
          stdout = !matches ? '' : args.includes('-z')
            ? `${entry} ${filePath}\0${previousPath === undefined ? '' : `${previousPath}\0`}`
            : `${entry} ${previousPath === undefined ? JSON.stringify(filePath) : `${JSON.stringify(previousPath)} -> ${JSON.stringify(filePath)}`}\n`;
        } else if (args[0] === 'show' && args[1] === `HEAD:${filePath}`) stdout = 'old content\n';
        else if (args[0] === 'diff' && args.at(-1) === filePath) stdout = '@@ -1 +1 @@\n-old content\n+new content\n';
        else throw new Error(`Unexpected Git command: ${JSON.stringify(args)}`);
        child.stdout.end(stdout);
        child.emit('close', 0);
      } catch (error) {
        child.emit('error', error);
        child.emit('close', -1);
      }
    });
    return child;
  }) as RouterDependencies['spawnProcess'];
  return { commands, spawnProcess };
}

for (const scenario of [
  { name: 'exact filename', requested: ' padded.txt ', actual: ' padded.txt ', entry: ' M' },
  { name: 'bare filename fallback', requested: ' padded.txt ', actual: 'folder/ padded.txt ', entry: ' M' },
  { name: 'rename fallback with a literal arrow', requested: ' padded -> name.txt ', actual: 'folder/ padded -> name.txt ', entry: 'R ', previous: 'old/ padded -> name.txt ' },
  { name: 'untracked filename with tab whitespace', requested: '\tpadded.txt\t', actual: '\tpadded.txt\t', entry: '??' },
]) {
  test(`read routes preserve NUL porcelain filename whitespace for ${scenario.name}`, async () => {
    const root = path.resolve(os.tmpdir(), 'git-read-whitespace-fixture');
    const expectedPath = path.join(root, scenario.actual);
    const fixture = statusFixture(root, scenario.entry, scenario.actual, scenario.previous);
    const fileSystem: WorkspaceGitFileSystem = {
      access: async candidate => { assert.equal(candidate, root); },
      stat: async candidate => { assert.equal(candidate, expectedPath); return { isDirectory: () => false } as never; },
      readFile: async candidate => { assert.equal(candidate, expectedPath); return 'new content\n'; },
      rm: async () => { throw new Error('read route must not remove files'); },
      unlink: async () => { throw new Error('read route must not unlink files'); },
    };
    const { server, url } = await startRouter({ fileSystem, spawnProcess: fixture.spawnProcess, resolveProjectPathById: () => root });
    try {
      const status = await fetch(`${url}/status?project=fixture`);
      assert.equal(status.status, 200);
      const summary = await status.json() as { modified: string[]; untracked: string[] };
      assert.deepEqual(scenario.entry === '??' ? summary.untracked : summary.modified, [scenario.actual]);
      const query = new URLSearchParams({ project: 'fixture', file: scenario.requested });
      const response = await fetch(`${url}/file-with-diff?${query}`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        currentContent: 'new content\n', oldContent: scenario.entry === '??' ? '' : 'old content\n', isDeleted: false, isUntracked: scenario.entry === '??',
      });
      const diffResponse = await fetch(`${url}/diff?${query}`);
      assert.equal(diffResponse.status, 200);
      assert.match((await diffResponse.json() as { diff: string }).diff, /\+new content/);
      const fileCommands = fixture.commands.filter(args => args[0] === 'show' || args[0] === 'diff');
      assert.ok(fileCommands.every(args => args.at(-1) === scenario.actual || args.at(-1) === `HEAD:${scenario.actual}`));
    } finally {
      await stopRouter(server);
    }
  });
}

test('branches removes current and worktree markers while keeping literal leading plus signs', async () => {
  const root = await nativeFileSystem.mkdtemp(path.join(os.tmpdir(), 'git-read-branches-'));
  const repository = path.join(root, 'repo');
  const worktree = path.join(root, 'worktree');
  await nativeFileSystem.mkdir(repository);
  const git = (...args: string[]) => execute('git', args, { cwd: repository });
  let server: Server | undefined;
  try {
    await git('init', '-b', '+main');
    await git('config', 'user.name', 'Test');
    await git('config', 'user.email', 'test@example.invalid');
    await git('commit', '--allow-empty', '-m', 'base');
    await git('branch', '+available');
    await git('worktree', 'add', '-b', '+linked', worktree);
    await git('update-ref', 'refs/remotes/origin/+remote', 'HEAD');
    await git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/+remote');
    const branchOutput = (await git('branch', '-a')).stdout;
    assert.match(branchOutput, /^\+ \+linked$/m);
    assert.match(branchOutput, /^\* \+main$/m);
    const started = await startRouter({ fileSystem: nativeFileSystem as never, spawnProcess: spawn as never, resolveProjectPathById: () => repository });
    server = started.server;
    const response = await fetch(`${started.url}/branches?project=fixture`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      branches: ['+available', '+linked', '+main', '+remote'],
      localBranches: ['+available', '+linked', '+main'], remoteBranches: ['+remote'],
    });
  } finally {
    if (server) await stopRouter(server);
    assert.equal(path.dirname(root), os.tmpdir());
    await nativeFileSystem.rm(root, { recursive: true, force: true });
  }
});
