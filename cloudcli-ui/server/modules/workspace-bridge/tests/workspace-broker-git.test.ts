import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { prepareWorkspaceBrokerGitRuntime } from '../workspace-broker-git.service.js';

function git(args: string[],cwd: string,env: Record<string,string>={}) { return new Promise<string>((resolve,reject) => {
  const child=spawn('git',['-c','core.hooksPath=','-c','core.fsmonitor=false',...args],{ cwd,env: { ...process.env,...env },stdio: ['ignore','pipe','pipe'],windowsHide: true });
  let stdout=''; let stderr=''; child.stdout.on('data',chunk => { stdout+=String(chunk); }); child.stderr.on('data',chunk => { stderr+=String(chunk); }); child.once('error',reject); child.once('close',code => code===0 ? resolve(stdout.trim()) : reject(new Error(stderr)));
}); }
async function fixture(run: (root: string,base: string) => Promise<void>,sha256=false) {
  const base=realpathSync(await mkdtemp(path.join(os.tmpdir(),'chisa-broker-git-'))); const root=path.join(base,'project'); await mkdir(root);
  try {
    await git(['init','-b','main',...(sha256 ? ['--object-format=sha256'] : [])],root); await writeFile(path.join(root,'base.txt'),'base\n'); await git(['add','.'],root);
    await git(['-c','user.name=Fixture','-c','user.email=fixture@localhost','commit','-m','base'],root);
    await run(root,base);
  } finally { assert.equal(path.dirname(root),base); await rm(base,{ recursive: true,force: true }); }
}
async function lease(root: string,id='lease') { const directory=root+'.chisa-lease'; await mkdir(directory,{ recursive: true }); await writeFile(path.join(directory,'state.json'),JSON.stringify({ owner: 'claude',id,epoch: 'epoch' })); return directory; }
function hostEnvironment(runtime: NonNullable<Awaited<ReturnType<typeof prepareWorkspaceBrokerGitRuntime>>>,root: string) {
  const stage=path.join(root+'.chisa-state','broker-git');
  return { ...runtime.environment,GIT_DIR: path.join(stage,'private'),GIT_COMMON_DIR: path.join(stage,'private'),GIT_WORK_TREE: root,GIT_OBJECT_DIRECTORY: path.join(stage,'chisa-objects'),GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(stage,'base') };
}
for (const sha256 of [false,true]) test(`actual staged shared Git commits publish objects before original metadata; sha256=${sha256}`,async () => fixture(async root => {
  const directory=await lease(root); const original=await git(['rev-parse','HEAD'],root);
  const runtime=(await prepareWorkspaceBrokerGitRuntime({ root,leaseDirectory: directory,readOnly: false }))!;
  const env=hostEnvironment(runtime,root);
  assert.ok(runtime.mounts.includes(`${path.join(root+'.chisa-state','broker-git','private')}:/workspace/.git:rw`));
  assert.ok(runtime.mounts.filter(item => item!=='--volume').every(item => !item.startsWith(path.join(root,'.git')+':')));
  await writeFile(path.join(root,'result.txt'),'staged result\n'); await git(['add','result.txt'],root,env);
  await git(['-c','user.name=Fixture','-c','user.email=fixture@localhost','commit','-m','sandbox result'],root,env);
  const tip=await git(['rev-parse','HEAD'],root,env); assert.notEqual(tip,original); assert.equal(await git(['rev-parse','HEAD'],root),original);
  await assert.rejects(git(['cat-file','-e',tip],root));
  await runtime.publish(); assert.equal(await git(['show','HEAD:result.txt'],root),'staged result'); assert.equal(await git(['rev-parse','HEAD'],root),tip);
  assert.equal(existsSync(path.join(root+'.chisa-state','broker-git','publication.json')),false);
  assert.deepEqual((await readFile(path.join(directory,'state.json'),'utf8')),JSON.stringify({ owner: 'claude',id: 'lease',epoch: 'epoch' }));
},sha256));

test('isolated staging publishes only its private branch and index while source branch stays fixed',async () => fixture(async (root,base) => {
  const target=path.join(base,'session'); const branch='chisa/session-private/test/work'; await git(['worktree','add','--no-checkout','-b',branch,target,'HEAD'],root); await git(['read-tree','HEAD'],target); await git(['checkout-index','-a'],target);
  const sourceTip=await git(['rev-parse','main'],root); const directory=await lease(target);
  const runtime=(await prepareWorkspaceBrokerGitRuntime({ root: target,sourceRoot: root,branch,leaseDirectory: directory,readOnly: false }))!;
  const env=hostEnvironment(runtime,target); await writeFile(path.join(target,'session.txt'),'isolated staged\n'); await git(['add','session.txt'],target,env);
  await git(['-c','user.name=Fixture','-c','user.email=fixture@localhost','commit','-m','session result'],target,env);
  await runtime.publish(); assert.equal(await git(['rev-parse','main'],root),sourceTip); assert.equal(await git(['show','HEAD:session.txt'],target),'isolated staged');
}));

for (const mutation of ['lease','index','stage-parent','foreign-ref'] as const) test(`publication rejects changed ${mutation} and retains quarantine`,async () => fixture(async root => {
  const directory=await lease(root); const sourceTip=await git(['rev-parse','HEAD'],root); const runtime=(await prepareWorkspaceBrokerGitRuntime({ root,leaseDirectory: directory,readOnly: false }))!;
  const env=hostEnvironment(runtime,root); await writeFile(path.join(root,'result.txt'),'unpublished\n'); await git(['add','result.txt'],root,env); await git(['-c','user.name=Fixture','-c','user.email=fixture@localhost','commit','-m','result'],root,env);
  if (mutation==='lease') await lease(root,'replacement');
  if (mutation==='index') await writeFile(path.join(root,'.git','index'),Buffer.from('changed'));
  if (mutation==='stage-parent') { const stage=path.join(root+'.chisa-state','broker-git'); await rename(stage,stage+'.retained'); await mkdir(stage); }
  if (mutation==='foreign-ref') await writeFile(path.join(root,'.git','refs','heads','foreign'),sourceTip+'\n');
  await assert.rejects(runtime.publish(),{ code: 'WORKSPACE_GIT_PUBLICATION_REQUIRED' }); assert.equal(await git(['rev-parse','HEAD'],root),sourceTip); assert.equal(existsSync(directory),true);
}));

test('staging preserves inode across new leases and rejects an unrelated retained publication journal',async () => fixture(async root => {
  const directory=await lease(root); const first=(await prepareWorkspaceBrokerGitRuntime({ root,leaseDirectory: directory,readOnly: true }))!;
  const before=first.mounts.join('\n'); first.close(); await rm(directory,{ recursive: true }); await lease(root,'next');
  const next=(await prepareWorkspaceBrokerGitRuntime({ root,leaseDirectory: directory,readOnly: true }))!; assert.equal(next.mounts.join('\n'),before); next.close();
  const stage=path.join(root+'.chisa-state','broker-git'); await writeFile(path.join(stage,'publication.json'),JSON.stringify({ version: 1,leaseId: 'previous',bindingEpoch: 'epoch',files: [] }));
  await assert.rejects(prepareWorkspaceBrokerGitRuntime({ root,leaseDirectory: directory,readOnly: false }),{ code: 'WORKSPACE_GIT_PUBLICATION_REQUIRED' }); assert.equal(existsSync(path.join(stage,'publication.json')),true);
}));
