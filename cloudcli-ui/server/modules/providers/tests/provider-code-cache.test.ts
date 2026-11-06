import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp,mkdir,readFile,rm,symlink,writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import type { ProviderTrustedSlot } from '@/shared/index.js';

import { prepareProviderCodeCache,stageProviderCli } from '../services/provider-code-cache.service.js';

const runFile=promisify(execFile);
test('readonly operator CLI slot retains self-contained dependencies without creating API caches',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'chisa-slot-cli-'));
  try {
    await mkdir(path.join(root,'node_modules','fixture-dependency'),{recursive:true});await writeFile(path.join(root,'main.cjs'),"process.stdout.write(require('fixture-dependency'));\n");await writeFile(path.join(root,'node_modules','fixture-dependency','index.js'),"module.exports='bounded-cli-dependency';\n");
    const slot={cli:'/runtime/provider-code/main.cjs',executableSource:path.join(root,'main.cjs'),mounts:[{source:root,target:'/runtime/provider-code',writable:false}]} as ProviderTrustedSlot;
    const staged=stageProviderCli(slot.executableSource,slot);assert.equal(staged.mount.source,root);assert.equal(staged.executable,'/runtime/provider-code/main.cjs');assert.deepEqual(prepareProviderCodeCache(slot),slot.mounts[0]);assert.equal(await readFile(path.join(root,'node_modules','fixture-dependency','index.js'),'utf8'),"module.exports='bounded-cli-dependency';\n");
    const output=await runFile(process.execPath,[path.join(root,'main.cjs')],{env:{...process.env,NODE_OPTIONS:''}});assert.equal(output.stdout,'bounded-cli-dependency');
    assert.throws(()=>stageProviderCli('/unregistered/cli',slot),{code:'WORKSPACE_PROVIDER_RUNTIME_UNAVAILABLE'});assert.throws(()=>stageProviderCli(slot.executableSource),{code:'WORKSPACE_PROVIDER_RUNTIME_UNAVAILABLE'});assert.throws(()=>prepareProviderCodeCache(),{code:'WORKSPACE_PROVIDER_RUNTIME_UNAVAILABLE'});
  }finally{assert.equal(path.dirname(root),os.tmpdir());await rm(root,{recursive:true,force:true});}
});
test('operator CLI selector rejects replaced symlinks and writable code mounts',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'chisa-slot-cli-link-'));
  try{
    await mkdir(path.join(root,'outside'));await writeFile(path.join(root,'outside','main.cjs'),'secret fixture');await symlink(path.join(root,'outside'),path.join(root,'code'),process.platform==='win32'?'junction':'dir');
    const slot={cli:'/runtime/provider-code/main.cjs',mounts:[{source:path.join(root,'code'),target:'/runtime/provider-code',writable:false}]} as ProviderTrustedSlot;
    assert.throws(()=>stageProviderCli(undefined,slot),{code:'WORKSPACE_PROVIDER_RUNTIME_UNAVAILABLE'});slot.mounts[0].writable=true;assert.throws(()=>prepareProviderCodeCache(slot),{code:'WORKSPACE_PROVIDER_RUNTIME_UNAVAILABLE'});
  }finally{assert.equal(path.dirname(root),os.tmpdir());await rm(root,{recursive:true,force:true});}
});
