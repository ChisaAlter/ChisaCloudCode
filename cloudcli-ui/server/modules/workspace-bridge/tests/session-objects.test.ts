import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deflateSync } from 'node:zlib';

import { isolatedSessionObjects, sharedSessionGitRuntime } from '../session-objects.service.js';

async function git(args: string[], cwd: string, env: Record<string, string> = {}) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn('git', args, { cwd, env: { ...process.env, ...env }, windowsHide: true });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); }); child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject); child.on('close', code => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr)));
  });
}
async function fixture(run: (source: string, target: string, gitdir: string) => Promise<void>, sha256 = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chisa-private-odb-')); const source = path.join(root, 'source'); const target = path.join(root, 'retained');
  await mkdir(source);
  try {
    await git(['init', '-b', 'main', ...(sha256 ? ['--object-format=sha256'] : [])], source);
    await writeFile(path.join(source, 'base.txt'), 'base\n'); await git(['add', '.'], source); await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'base'], source);
    await git(['worktree', 'add', '-b', 'chisa/session-private/fixture/work', target], source);
    const gitdir = path.resolve(await git(['rev-parse', '--absolute-git-dir'], target));
    await run(source, target, gitdir);
  } finally { assert.equal(path.dirname(source), root); await rm(root, { recursive: true, force: true }); }
}

for (const sha256 of [false, true]) test(`private ODB commits read base and publish verified loose objects for manual host Git; sha256=${sha256}`, async () => {
  await fixture(async (source, target, gitdir) => {
    const before = await git(['rev-parse', 'main'], source); const sourceIndex = await readFile(path.join(source, '.git', 'index'));
    const runtime = isolatedSessionObjects(path.join(source, '.git'), path.resolve(gitdir));
    await writeFile(path.join(target, 'result.txt'), 'private object write\n');
    await git(['add', 'result.txt'], target, runtime.environment);
    await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'private result'], target, runtime.environment);
    const commit = await git(['rev-parse', 'HEAD'], target, runtime.environment);
    await assert.rejects(git(['cat-file', '-e', commit], source));
    await runtime.publish();
    await git(['cat-file', '-e', commit], source);
    assert.equal(await git(['show', commit + ':result.txt'], source), 'private object write');
    assert.equal(await git(['rev-parse', 'main'], source), before);
    assert.deepEqual(await readFile(path.join(source, '.git', 'index')), sourceIndex);
    await runtime.publish();
  }, sha256);
});

for (const sha256 of [false, true]) test(`private packed objects regenerate indexes without source ref mutation; sha256=${sha256}`, async () => {
  await fixture(async (source, target, gitdir) => {
    const runtime = isolatedSessionObjects(path.join(source, '.git'), path.resolve(gitdir));
    await writeFile(path.join(target, 'packed.txt'), 'private packed result\n'); await git(['add', '.'], target, runtime.environment);
    await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'private packed'], target, runtime.environment);
    await git(['repack', '-ad'], target, runtime.environment);
    await runtime.publish();
    assert.equal(await git(['show', 'HEAD:packed.txt'], target), 'private packed result');
    assert.equal(await git(['show', 'main:base.txt'], source), 'base');
  }, sha256);
});

test('shared Git commits use lease-local objects and publish after common metadata updates', async () => {
  await fixture(async source => {
    const lease = source + '.chisa-lease'; await mkdir(lease); await writeFile(path.join(lease, 'state.json'), JSON.stringify({ id: 'shared-owner', epoch: 'epoch', owner: 'claude' }));
    try {
      const runtime = sharedSessionGitRuntime(source, lease, false, true)!;
      assert.ok(runtime.mounts.includes(`${path.join(source, '.git', 'objects')}:/workspace/.git/objects:ro`));
      assert.ok(runtime.mounts.includes(`${runtime.environment.GIT_OBJECT_DIRECTORY}:${runtime.environment.GIT_OBJECT_DIRECTORY}:rw`));
      await writeFile(path.join(source, 'shared.txt'), 'shared private object write\n');
      await git(['add', 'shared.txt'], source, runtime.environment);
      await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'shared private'], source, runtime.environment);
      const tip = await git(['rev-parse', 'HEAD'], source, runtime.environment);
      await assert.rejects(git(['cat-file', '-e', tip], source));
      await runtime.publish();
      assert.equal(await git(['show', 'HEAD:shared.txt'], source), 'shared private object write');
    } finally { await rm(lease, { recursive: true, force: true }); }
  });
});

test('shared object publication rejects foreign lease and same-path directory replacement before publishing', async () => {
  for (const replacement of ['lease-owner', 'lease-directory', 'objects-directory']) await fixture(async source => {
    const lease = source + '.chisa-lease'; await mkdir(lease); const original = { id: 'original', epoch: 'epoch', owner: 'claude' }; await writeFile(path.join(lease, 'state.json'), JSON.stringify(original));
    const runtime = sharedSessionGitRuntime(source, lease, false)!;
    const content = Buffer.from('blob 6\0shared'); const oid = createHash('sha1').update(content).digest('hex');
    await mkdir(path.join(runtime.environment.GIT_OBJECT_DIRECTORY, oid.slice(0, 2)), { recursive: true }); await writeFile(path.join(runtime.environment.GIT_OBJECT_DIRECTORY, oid.slice(0, 2), oid.slice(2)), deflateSync(content));
    let moved: string | undefined;
    try {
      if (replacement === 'lease-owner') await writeFile(path.join(lease, 'state.json'), JSON.stringify({ ...original, id: 'foreign' }));
      else { const target = replacement === 'lease-directory' ? lease : path.join(source, '.git', 'objects'); moved = target + '.retained'; await rename(target, moved); await mkdir(target); if (replacement === 'lease-directory') await writeFile(path.join(target, 'state.json'), JSON.stringify(original)); }
      await assert.rejects(runtime.publish(), { code: 'WORKSPACE_GIT_OBJECT_INVALID' });
      await assert.rejects(git(['cat-file', '-e', oid], source));
    } finally { await rm(lease, { recursive: true, force: true }); if (moved && moved === lease + '.retained') await rm(moved, { recursive: true, force: true }); }
  });
});

test('corrupt private loose objects never overwrite or remove common objects', async () => {
  await fixture(async (source, _target, gitdir) => {
    const runtime = isolatedSessionObjects(path.join(source, '.git'), path.resolve(gitdir));
    const bytes = Buffer.from('blob 4\0oops'); const oid = createHash('sha1').update(bytes).digest('hex');
    await mkdir(path.join(runtime.directory, oid.slice(0, 2)), { recursive: true });
    await writeFile(path.join(runtime.directory, oid.slice(0, 2), oid.slice(2)), deflateSync(Buffer.from('blob 4\0fake')));
    const before = await git(['rev-parse', 'main'], source);
    await assert.rejects(runtime.publish(), { code: 'WORKSPACE_GIT_OBJECT_INVALID' });
    assert.equal(await git(['rev-parse', 'main'], source), before);
    await git(['fsck', '--no-dangling'], source);
  });
});
