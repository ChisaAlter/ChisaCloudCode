import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp,mkdir,lstat,readFile,rm,writeFile,symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { enrollProviderSlot } from './enroll-slot.mjs';
import { createProviderSlotSupervisor } from './slot-supervisor.mjs';
import { createWorkspaceGrantIssuer,createWorkspaceGrantIssuerServer } from '../workspace-broker/issuer/issuer.mjs';

async function fixture(t) {
  const base=await mkdtemp(path.join(os.tmpdir(),'chisa-slot-enroll-'));const root=path.join(base,'workspace');const slotParent=path.join(base,'slots');const codeSource=path.join(base,'installed-code');const credentials=path.join(base,'auth.json');const witnessDirectory=path.join(base,'writer-witness');const preparedDirectory=path.join(base,'prepared');
  for(const directory of[root,slotParent,codeSource,witnessDirectory,preparedDirectory])await mkdir(directory,{mode:0o755});await mkdir(path.join(codeSource,'app'));await writeFile(path.join(codeSource,'node'),'fixture-node');await writeFile(path.join(codeSource,'app','provider-process.worker.js'),'fixture-worker');await writeFile(path.join(codeSource,'cli'),'fixture-cli');await writeFile(credentials,'fixture-private-credential');
  t.after(async()=>{assert.equal(path.dirname(base),os.tmpdir());await rm(base,{recursive:true,force:true});});
  const spec={version:1,slotId:'slot',provider:'codex',userId:'17',ownerId:'owner',sessionId:'session',workspaceId:'workspace',generation:'generation',leaseId:'lease',bindingEpoch:'epoch',profileId:'profile',witnessId:'writer',root,slotParent,codeSource,cliRelative:'cli',controlledRootId:'provider-root',uid:1000,assetCount:2,ticket:'a'.repeat(64),brokerTicket:'b'.repeat(64),credentials:[{source:credentials,relativePath:'.codex/auth.json'}],expiresAt:Date.now()+600000};
  return{base,root,slotParent,codeSource,credentials,witnessDirectory,preparedDirectory,spec};
}
test('operator enrollment snapshots exact CLI and credentials, pins empty assets and emits readonly selectors',async t=>{
  const f=await fixture(t);const enrolled=await enrollProviderSlot(f.spec);assert.equal(enrolled.slot.home,path.join(f.slotParent,'slot','home'));assert.equal(enrolled.privateSlot.codeFiles.length,3);assert.equal(enrolled.privateSlot.credentialFiles.length,1);assert.equal(enrolled.privateSlot.assetFiles.length,2);assert.equal(enrolled.issuerEntry.providerSlotId,'slot');assert.equal(enrolled.slot.cli,'/runtime/provider-code/cli');assert.equal(await readFile(path.join(enrolled.slotRoot,'credentials','credential-0'),'utf8'),'fixture-private-credential');assert.equal(await readFile(path.join(enrolled.slot.home,'.codex','auth.json'),'utf8'),'');
  const mounts=JSON.parse(await readFile(path.join(enrolled.slotRoot,'broker-profile-mounts.json'),'utf8'));assert.equal(mounts.mounts.length,5);assert.equal(mounts.mounts.find(mount=>mount.target.endsWith('/auth.json')).readOnly,true);assert.ok(mounts.mounts.every(mount=>mount.rootId==='provider-root'));await assert.rejects(enrollProviderSlot(f.spec),{code:'EEXIST'});
});
test('same session may reuse its persistent HOME across separately enrolled leases',async t=>{const f=await fixture(t);const first=await enrollProviderSlot(f.spec);await writeFile(path.join(first.slot.home,'history'),'session history');const second=await enrollProviderSlot({...f.spec,slotId:'slot-next',leaseId:'lease-next',profileId:'profile-next',persistentHome:first.slot.home});assert.equal(second.slot.home,first.slot.home);assert.equal(await readFile(path.join(second.slot.home,'history'),'utf8'),'session history');await assert.rejects(enrollProviderSlot({...f.spec,slotId:'foreign',sessionId:'foreign',persistentHome:first.slot.home}),/HOME_OWNER/);});

test('independent real issuer grants run only after supervisor seals operator-enrolled assets',async t=>{
  const f=await fixture(t);const enrolled=await enrollProviderSlot(f.spec);const keys=generateKeyPairSync('ed25519');const witness={version:1,active:true,workspaceId:'workspace',generation:'generation',sessionId:'session',leaseId:'lease',bindingEpoch:'epoch',expiresAt:f.spec.expiresAt};await writeFile(path.join(f.witnessDirectory,'writer.json'),JSON.stringify(witness),{mode:0o600});
  const issuer=await createWorkspaceGrantIssuer({version:1,audience:'broker',keyId:'issuer',privateKey:keys.privateKey.export({type:'pkcs8',format:'pem'}).toString(),registryDirectory:path.join(f.base,'issuer-registry'),witnessDirectory:f.witnessDirectory,providerPreparedDirectory:f.preparedDirectory,entries:[enrolled.issuerEntry]});const socketPath=process.platform==='win32'?'\\\\.\\pipe\\chisa-slot-enroll-'+path.basename(f.base):path.join(f.base,'issuer.sock');const server=await createWorkspaceGrantIssuerServer(issuer,{socketPath});
  const supervisor=await createProviderSlotSupervisor({version:1,registryDirectory:path.join(f.base,'supervisor-registry'),witnessDirectory:f.preparedDirectory,issuerSocketPath:socketPath,brokerSocketPath:socketPath,slots:[enrolled.privateSlot]});
  try{const request={ticket:f.spec.brokerTicket,userId:'17',root:f.root,workspaceId:'workspace',generation:'generation',sessionId:'session',leaseId:'lease',bindingEpoch:'epoch',permission:'run',profileId:'profile'};await assert.rejects(issuer.grant(request));const body={ticket:f.spec.ticket,...Object.fromEntries(['slotId','provider','userId','ownerId','sessionId','root','workspaceId','generation','leaseId','bindingEpoch','profileId'].map(field=>[field,enrolled.slot[field]])),assets:[]};assert.equal((await supervisor.prepare(body)).prepared,true);assert.ok((await issuer.grant(request)).proof);await writeFile(path.join(f.preparedDirectory,'slot.json'),JSON.stringify({...JSON.parse(await readFile(path.join(f.preparedDirectory,'slot.json'),'utf8')),leaseId:'foreign'}));await assert.rejects(issuer.grant(request),/PROVIDER_SLOT/);}finally{await supervisor.close();await server.close();issuer.close();}
});
test('operator enrollment refuses a redirected source rather than following host content',async t=>{
  const f=await fixture(t);const outside=path.join(f.base,'outside');await mkdir(outside);await writeFile(path.join(outside,'secret'),'fixture');await symlink(outside,path.join(f.codeSource,'redirected'),process.platform==='win32'?'junction':'dir');await assert.rejects(enrollProviderSlot(f.spec),{message:/^SLOT_INSTALL_(?:PATH|UNTRUSTED)$/});
});
