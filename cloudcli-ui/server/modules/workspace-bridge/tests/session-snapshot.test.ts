import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { copyPinnedSessionSnapshot, isolatedSessionGitMounts } from '../session-snapshot.service.js';

function git(args: string[], cwd: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn('git', args, { cwd, windowsHide: true });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}
async function checked(args: string[], cwd: string) {
  const result = await git(args, cwd);
  assert.equal(result.code, 0, result.stderr);
  return result.stdout;
}
async function fixture(run: (source: string, target: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chisa-exact-snapshot-'));
  const source = path.join(root, 'source'); const target = path.join(root, 'retained');
  await mkdir(source);
  try {
    await checked(['init', '-b', 'main'], source);
    for (const name of ['deleted.txt', 'renamed.txt', 'staged.txt', 'unstaged-delete.txt', 'kept.txt']) await writeFile(path.join(source, name), 'base\n');
    await checked(['add', '.'], source);
    await checked(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'base'], source);
    await run(source, target);
  } finally {
    assert.equal(path.dirname(source), root);
    assert.equal(path.dirname(target), root);
    await rm(root, { recursive: true, force: true });
  }
}

for (const split of [false, true]) test(`real Git snapshot preserves deletion, rename and exact staged-vs-working bytes; split=${split}`, async () => {
  await fixture(async (source, target) => {
    await rm(path.join(source, 'deleted.txt'));
    await rename(path.join(source, 'renamed.txt'), path.join(source, 'new-name.txt'));
    await writeFile(path.join(source, 'staged.txt'), 'staged version\n');
    await checked(['add', '-A'], source);
    await writeFile(path.join(source, 'staged.txt'), 'working version\n');
    await rm(path.join(source, 'unstaged-delete.txt'));
    await writeFile(path.join(source, 'untracked.txt'), 'untracked\n');
    await writeFile(path.join(source, '.env'), 'secret');
    await writeFile(path.join(source, '.env.example'), 'example');
    await mkdir(path.join(source, 'node_modules'));
    await writeFile(path.join(source, 'node_modules', 'private'), 'dependency');
    if (split) await checked(['update-index', '--split-index'], source);
    const indexBefore = await readFile(path.join(source, '.git', 'index'));
    const statusBefore = await checked(['status', '--porcelain', '--untracked-files=all'], source);
    const branch = 'chisa/session-private/fixture/work';
    await checked(['worktree', 'add', '--no-checkout', '-b', branch, target, 'HEAD'], source);
    let pinChecks = 0;
    await copyPinnedSessionSnapshot(source, target, git, () => { pinChecks++; });
    assert.ok(pinChecks > 10);
    assert.equal(existsSync(path.join(target, 'deleted.txt')), false);
    assert.equal(existsSync(path.join(target, 'renamed.txt')), false);
    assert.equal(existsSync(path.join(target, 'unstaged-delete.txt')), false);
    assert.equal(await readFile(path.join(target, 'new-name.txt'), 'utf8'), 'base\n');
    assert.equal(await readFile(path.join(target, 'staged.txt'), 'utf8'), 'working version\n');
    assert.equal(await checked(['show', ':staged.txt'], target), 'staged version\n');
    assert.equal(await checked(['diff', '--cached', '--binary'], target), await checked(['diff', '--cached', '--binary'], source));
    assert.equal(await checked(['diff', '--binary'], target), await checked(['diff', '--binary'], source));
    assert.deepEqual(await readFile(path.join(source, '.git', 'index')), indexBefore);
    assert.equal(await checked(['status', '--porcelain', '--untracked-files=all'], source), statusBefore);
    assert.equal(existsSync(path.join(target, '.env')), false);
    assert.equal(existsSync(path.join(target, 'node_modules')), false);
    assert.equal(await readFile(path.join(target, '.env.example'), 'utf8'), 'example');
    const mounts = isolatedSessionGitMounts(target, source, branch, false);
    assert.ok(mounts.includes(`${path.join(source, '.git')}:${path.join(source, '.git')}:ro`));
    assert.ok(mounts.includes(`${path.join(source, '.git', 'refs', 'heads', 'chisa', 'session-private', 'fixture')}:${path.join(source, '.git', 'refs', 'heads', 'chisa', 'session-private', 'fixture')}:rw`));
    assert.ok(!mounts.some(item => item.includes(`${source}:/workspace`) || item === `${path.join(source, '.git', 'refs')}:${path.join(source, '.git', 'refs')}:rw`));
    assert.ok(isolatedSessionGitMounts(target, source, branch, true).filter(item => item !== '--volume').every(item => item.endsWith(':ro')));
    await checked(['add', '-A'], target);
    await checked(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'isolated result'], target);
    assert.notEqual(await checked(['rev-parse', 'HEAD'], target), await checked(['rev-parse', 'HEAD'], source));
    assert.equal(await checked(['branch', '--show-current'], source), 'main\n');
  });
});

test('source mutation during the exact copy is rejected by deterministic callback gating', async () => {
  await fixture(async (source, target) => {
    await checked(['worktree', 'add', '--no-checkout', '-b', 'chisa/session-private/race/work', target, 'HEAD'], source);
    let copied = false;
    const runner: typeof git = async (args, cwd) => {
      if (cwd === target && args.includes('update-index')) {
        // This is after cp completed and before the final stability check, not a
        // delay chosen to guess when the copy might have reached a file.
        copied = true;
        await writeFile(path.join(source, 'kept.txt'), 'changed concurrently');
      }
      return git(args, cwd);
    };
    await assert.rejects(copyPinnedSessionSnapshot(source, target, runner, () => {}), { code: 'WORKSPACE_SNAPSHOT_CHANGED' });
    assert.equal(copied, true);
  });
});

test('foreign Git lock is never removed by snapshot capture', async () => {
  await fixture(async (source, target) => {
    await checked(['worktree', 'add', '--no-checkout', '-b', 'chisa/session-private/locked/work', target, 'HEAD'], source);
    const lock = path.join(source, '.git', 'index.lock');
    await writeFile(lock, 'external lock');
    await assert.rejects(copyPinnedSessionSnapshot(source, target, git, () => {}), { code: 'WORKSPACE_GIT_OPERATION_IN_PROGRESS' });
    assert.equal(readFileSync(lock, 'utf8'), 'external lock');
  });
});
