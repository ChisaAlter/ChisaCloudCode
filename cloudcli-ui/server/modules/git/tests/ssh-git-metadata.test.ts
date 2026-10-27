import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';
import { promisify } from 'node:util';

import express from 'express';

const execute = promisify(execFile);
let root = 'C:\\Project 中文 space';
let selected = true;
let active = false;
let calls = 0;
let reservations = 0;
let real = false;
let patch: Record<string, unknown> = {};
let rpcError: Error | undefined;
let lastRaw: Record<string, unknown> | undefined;
const ok = (stdout: string, code = 0, stderr = '') => ({ stdout, code, stderr });

mock.module('@/modules/workspace-bridge/index.js', { namedExports: {
  resolveSshProjectTarget() { return selected ? { rootPath: root } : null; },
  async withWorkspaceGitReadOperation<T>(_cwd: string, operation: () => Promise<T>) { reservations++; active = true; try { return await operation(); } finally { active = false; } },
  async withWorkspaceWriteOperation() { assert.fail('metadata cannot mutate'); },
  async runWorkspaceGitBranchOperation() { assert.fail('metadata cannot change branches'); },
  workspaceRequestScope(_request: unknown, _response: unknown, next: () => void) { next(); },
  workspaceRequestSignal() { return undefined; },
  async runWorkspaceCommand(_cwd: string, command: string, args: string[], options: { readOnly: boolean }) {
    calls++;
    assert.equal(command, 'powershell.exe'); assert.equal(options.readOnly, true);
    assert.deepEqual(args.slice(0, 7), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', args[6]]);
    if (rpcError) throw rpcError;
    if (real) {
      const result = await execute(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true });
      lastRaw = JSON.parse(result.stdout) as Record<string, unknown>;
      return { exitCode: 0, ...result };
    }
    assert.equal(active, true);
    const script = Buffer.from(args[6], 'base64').toString('utf16le');
    assert.equal(script.includes(root), false, 'project data must not appear in the static script');
    assert.match(script, /ReadToEndAsync/);
    return { exitCode: 0, stdout: JSON.stringify({
      repository: ok('true\n' + root.replace(/\\/g, '/') + '\n'),
      branch: ok('refs/heads/main\n'), head: ok('hash\n'),
      status: ok('M  padded 中文.txt \0?? new\tfile.txt\0'),
      branches: ok('* main\n  topic\n  remotes/origin/HEAD -> origin/main\n  remotes/origin/topic\n'),
      remotes: ok('origin\n'), upstream: ok('origin/main\n'), counts: ok('2\t3\n'), ...patch,
    }), stderr: '' };
  },
} });
const { createGitRouter } = await import('../git.routes.js');
const { readSshGitMetadata } = await import('../ssh-git-metadata.service.js');

test.beforeEach(() => { root = 'C:\\Project 中文 space'; selected = true; active = false; calls = 0; reservations = 0; real = false; patch = {}; rpcError = undefined; });

test('three SSH metadata routes each retain one read reservation and use exactly one RPC with no file preflight', async () => {
  const app = express();
  const unexpected = async () => assert.fail('unexpected provider');
  app.use(createGitRouter({
    fileSystem: { access: async () => assert.fail('extra file RPC') } as never,
    spawnProcess: (() => assert.fail('host fallback')) as never,
    resolveProjectPathById: () => path.resolve('virtual-anchor'), queryClaude: unexpected, queryCursor: unexpected,
  }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    for (const mode of ['status', 'branches', 'remote-status']) {
      const before = calls;
      const response = await fetch(base + '/' + mode + '?project=fixture');
      assert.equal(response.status, 200);
      const body = await response.json();
      if (mode === 'status') assert.deepEqual(body, { branch: 'main', hasCommits: true, modified: ['padded 中文.txt '], added: [], deleted: [], untracked: ['new\tfile.txt'], staged: ['padded 中文.txt '] });
      if (mode === 'branches') assert.deepEqual(body, { branches: ['main', 'topic'], localBranches: ['main', 'topic'], remoteBranches: [] });
      if (mode === 'remote-status') assert.deepEqual(body, { hasRemote: true, hasUpstream: true, branch: 'main', remoteBranch: 'origin/main', remoteName: 'origin', ahead: 3, behind: 2, isUpToDate: false });
      assert.equal(calls - before, 1);
    }
    assert.equal(reservations, 3);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('non-SSH metadata does not execute or replace the cloud command path', async () => {
  selected = false;
  assert.equal(await readSshGitMetadata('cloud-root', 'status'), null);
  assert.equal(calls, 0);
});

test('metadata rejects mismatched repo roots and does not fall back after transport errors', async () => {
  active = true;
  patch = { repository: ok('true\nC:/ForeignRepo\n') };
  await assert.rejects(readSshGitMetadata('anchor', 'status'), { code: 'SSH_WORKSPACE_ROOT_MISMATCH' });
  patch = {}; rpcError = Object.assign(new Error('target changed'), { code: 'WORKSPACE_GENERATION_CHANGED' });
  await assert.rejects(readSshGitMetadata('anchor', 'status'), { code: 'WORKSPACE_GENERATION_CHANGED' });
  assert.equal(calls, 2);
});

test('non-repository, unborn, detached and no-upstream states preserve existing responses', async () => {
  active = true;
  patch = { repository: ok('', 128, 'fatal: not a git repository') };
  await assert.rejects(readSshGitMetadata('anchor', 'status'), { code: 'NOT_A_GIT_REPOSITORY' });
  patch = { head: ok('', 128, 'fatal: Needed a single revision'), remotes: ok('') };
  assert.deepEqual(await readSshGitMetadata('anchor', 'remote-status'), { hasRemote: false, hasUpstream: false, branch: 'main', remoteName: null, ahead: 0, behind: 0, isUpToDate: false, message: 'Repository has no commits yet' });
  patch = { branch: ok('HEAD\n'), upstream: ok('', 128, 'HEAD does not point to a branch') };
  assert.deepEqual(await readSshGitMetadata('anchor', 'remote-status'), { hasRemote: true, hasUpstream: false, branch: 'HEAD', remoteName: 'origin', message: 'No remote tracking branch configured' });
});

test('real Windows composite preserves literal NUL filenames, staged state, branch aliases, detached and remote counts', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'git-metadata-中文 space-'));
  real = true;
  const git = (args: string[]) => execute('git', args, { cwd: root, encoding: 'utf8' });
  try {
    await git(['init', '-b', 'main']); await git(['config', 'core.autocrlf', 'false']);
    const started = performance.now();
    const unborn = await readSshGitMetadata('anchor', 'status');
    assert.ok(unborn && 'hasCommits' in unborn); assert.equal(unborn.hasCommits, false); assert.equal(unborn.branch, 'main');
    await fs.writeFile(path.join(root, 'padded 中文.txt'), 'first\n');
    await git(['add', '--all']); await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'base']);
    const filename = (await fs.readdir(root)).find(file => file.startsWith('padded'))!;
    await fs.writeFile(path.join(root, filename), 'second\n');
    await git(['add', '--', filename]);
    await fs.writeFile(path.join(root, 'new 中文.txt'), 'new\n');
    const statusBefore = (await git(['status', '--porcelain=v1', '-z'])).stdout;
    const status = await readSshGitMetadata('anchor', 'status');
    assert.ok(status && 'staged' in status); assert.deepEqual(status.staged, [filename]); assert.deepEqual(status.untracked, ['new 中文.txt']);
    await git(['tag', 'main']);
    assert.equal((await readSshGitMetadata('anchor', 'status'))?.branch, 'main');
    await git(['remote', 'add', 'origin', 'https://example.invalid/fixture.git']);
    await git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    await git(['config', 'branch.main.remote', 'origin']); await git(['config', 'branch.main.merge', 'refs/heads/main']);
    const remote = await readSshGitMetadata('anchor', 'remote-status');
    assert.equal(remote?.hasUpstream, true); assert.equal(remote?.ahead, 0); assert.equal(remote?.behind, 0);
    assert.ok((await readSshGitMetadata('anchor', 'branches'))?.localBranches?.includes('main'));
    assert.equal((await git(['status', '--porcelain=v1', '-z'])).stdout, statusBefore);
    await git(['checkout', '--detach']); assert.equal((await readSshGitMetadata('anchor', 'status'))?.branch, 'HEAD');
    const repositoryRoot = root;
    root = path.join(repositoryRoot, 'nested');
    await fs.mkdir(root);
    try {
      await assert.rejects(readSshGitMetadata('anchor', 'status'), { code: 'SSH_WORKSPACE_ROOT_MISMATCH' });
      assert.deepEqual(Object.keys(lastRaw ?? {}), ['repository'], 'foreign repository metadata must never be collected after the proof');
    } finally { root = repositoryRoot; }
    console.log(`real Windows metadata: ${calls} one-RPC snapshots in ${Math.round(performance.now() - started)} ms (includes fixture Git setup)`);
  } finally { assert.equal(path.dirname(root), os.tmpdir()); await fs.rm(root, { recursive: true, force: true }); }
});
