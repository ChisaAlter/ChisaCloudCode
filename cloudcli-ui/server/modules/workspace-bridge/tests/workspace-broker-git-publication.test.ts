import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { PathLike } from 'node:fs';
import fs from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import test, { mock } from 'node:test';

import { prepareWorkspaceBrokerGitRuntime } from '../workspace-broker-git.service.js';

function git(args: string[],cwd: string,environment: Record<string,string>={}) { return new Promise<string>((resolve,reject) => {
  const child=spawn('git',args,{ cwd,env: { ...process.env,...environment },windowsHide: true,stdio: ['ignore','pipe','pipe'] }); let stdout=''; let stderr=''; child.stdout.on('data',chunk => { stdout+=String(chunk); }); child.stderr.on('data',chunk => { stderr+=String(chunk); }); child.once('error',reject); child.once('close',code => code===0 ? resolve(stdout.trim()) : reject(new Error(stderr)));
}); }
async function fixture(run: (root: string,runtime: NonNullable<Awaited<ReturnType<typeof prepareWorkspaceBrokerGitRuntime>>>,environment: Record<string,string>) => Promise<void>) {
  const base=realpathSync(await fs.mkdtemp(path.join(os.tmpdir(),'chisa-git-publication-'))); const root=path.join(base,'project'); await fs.mkdir(root);
  try {
    await git(['init','-b','main'],root); await fs.writeFile(path.join(root,'base'),'base'); await git(['add','.'],root); await git(['-c','user.name=Fixture','-c','user.email=fixture@localhost','commit','-m','base'],root);
    await fs.mkdir(root+'.chisa-lease'); await fs.writeFile(path.join(root+'.chisa-lease','state.json'),JSON.stringify({ owner: 'claude',id: 'lease',epoch: 'epoch' }));
    const runtime=(await prepareWorkspaceBrokerGitRuntime({ root,leaseDirectory: root+'.chisa-lease',readOnly: false }))!; const stage=path.join(root+'.chisa-state','broker-git');
    const environment={ ...runtime.environment,GIT_DIR: path.join(stage,'private'),GIT_COMMON_DIR: path.join(stage,'private'),GIT_WORK_TREE: root,GIT_OBJECT_DIRECTORY: path.join(stage,'chisa-objects'),GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(stage,'base') };
    await fs.writeFile(path.join(root,'result'),'result'); await git(['add','result'],root,environment); await git(['-c','user.name=Fixture','-c','user.email=fixture@localhost','commit','-m','result'],root,environment);
    try { await run(root,runtime,environment); } finally { runtime.close(); }
  } finally { assert.equal(path.dirname(root),base); await fs.rm(base,{ recursive: true,force: true }); }
}

test('foreign Git lock is retained before publication and same exact staged writer can retry',async () => fixture(async (root,runtime) => {
  const target=path.join(root,'.git','index.lock'); await fs.writeFile(target,'foreign-git-operation');
  await assert.rejects(runtime.publish()); assert.equal(await fs.readFile(target,'utf8'),'foreign-git-operation');
  // A preexisting lock is detected before any journal/metadata commit, so the
  // prepared quarantine remains the retry source rather than a synthetic journal.
  const journal=path.join(root+'.chisa-state','broker-git','publication.json'); assert.equal(existsSync(journal),false);
  await fs.unlink(target); await runtime.publish();
  assert.equal(await git(['show','HEAD:result'],root),'result'); assert.equal(existsSync(journal),false);
}));

test('partial metadata commit preserves journal and recovers only exact before-or-after identities',async () => fixture(async (root,runtime) => {
  const actual=fs.rename; let committed=0;
  const intercept=mock.method(fs,'rename',async (source: PathLike,target: PathLike) => {
    if (String(source).endsWith('.lock') && String(target).startsWith(path.join(root,'.git'))) {
      committed++; if (committed===2) throw new Error('publication acknowledgement lost');
    }
    return actual(source,target);
  });
  syncBuiltinESMExports();
  try { await assert.rejects(runtime.publish(),/acknowledgement lost/); } finally { intercept.mock.restore(); syncBuiltinESMExports(); }
  const journal=path.join(root+'.chisa-state','broker-git','publication.json'); assert.equal(existsSync(journal),true); assert.equal(existsSync(root+'.chisa-lease'),true);
  runtime.close(); const recovered=(await prepareWorkspaceBrokerGitRuntime({ root,leaseDirectory: root+'.chisa-lease',readOnly: false }))!;
  assert.equal(await git(['show','HEAD:result'],root),'result'); assert.equal(existsSync(journal),false); recovered.close();
}));

test('an active Git staging consumer blocks reuse until exact cleanup returns the slot',async () => fixture(async (root,runtime) => {
  await assert.rejects(prepareWorkspaceBrokerGitRuntime({ root,leaseDirectory: root+'.chisa-lease',readOnly: true }),{ code: 'WORKSPACE_BUSY' });
  runtime.close(); const next=(await prepareWorkspaceBrokerGitRuntime({ root,leaseDirectory: root+'.chisa-lease',readOnly: true }))!; next.close();
}));

test('hardlinked original metadata is rejected before its staging or publication',async () => {
  const base=realpathSync(await fs.mkdtemp(path.join(os.tmpdir(),'chisa-git-hardlink-'))); const root=path.join(base,'project'); await fs.mkdir(root);
  try {
    await git(['init','-b','main'],root); await fs.writeFile(path.join(root,'base'),'base'); await git(['add','.'],root); await git(['-c','user.name=Fixture','-c','user.email=fixture@localhost','commit','-m','base'],root);
    await fs.mkdir(root+'.chisa-lease'); await fs.writeFile(path.join(root+'.chisa-lease','state.json'),JSON.stringify({ owner: 'claude',id: 'lease',epoch: 'epoch' }));
    await fs.link(path.join(root,'.git','index'),path.join(base,'index-alias'));
    await assert.rejects(prepareWorkspaceBrokerGitRuntime({ root,leaseDirectory: root+'.chisa-lease',readOnly: false }),{ code: 'WORKSPACE_GIT_PUBLICATION_REQUIRED' });
  } finally { assert.equal(path.dirname(root),base); await fs.rm(base,{ recursive: true,force: true }); }
});
