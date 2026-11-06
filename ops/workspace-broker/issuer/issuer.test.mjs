import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { lstat, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createWorkspaceGrantIssuer,createWorkspaceGrantIssuerServer } from './issuer.mjs';

async function fixture(t,options={}) {
  const base=await mkdtemp(path.join(os.tmpdir(),'chisa-issuer-'));const root=path.join(base,'workspace');const witnessDirectory=path.join(base,'witnesses');await mkdir(root,{mode:0o700});await mkdir(witnessDirectory,{mode:0o700});
  const keys=generateKeyPairSync('ed25519');const ticket='a'.repeat(64);const pin=await lstat(root,{bigint:true});const expiresAt=Date.now()+600000;
  const entry={ticketHash:createHash('sha256').update(ticket).digest('hex'),ownerId:'owner-a',userId:'17',root,rootDev:pin.dev.toString(),rootIno:pin.ino.toString(),workspaceId:'workspace',generation:'generation',sessionId:'session',leaseId:'lease',bindingEpoch:'epoch',witnessId:'witness',profiles:['worker'],permissions:['status','run','exec','network',...(options.recovery?['quiesce']:[])],expiresAt,...(options.slot?{providerSlotId:'slot-a'}:{}),...(options.recovery?{recoveryPurpose:options.recovery}:{})};
  const writer={pid:123,processStartTime:'456',bootId:'12345678-1234-1234-1234-123456789abc',pidNamespace:'pid:[4026531836]'};
  const witness={version:1,root,workspaceId:'workspace',generation:'generation',sessionId:'session',leaseId:'lease',bindingEpoch:'epoch',active:true,expiresAt,writer,...(options.recovery?{recoveryPurpose:options.recovery}:{}),...(options.recovery==='legacy-writer-release'?{supervisorStopped:{...writer,leaseId:'lease',bindingEpoch:'epoch',stopped:true,stopId:'stop-receipt'}}:{})};
  const witnessPath=path.join(witnessDirectory,'witness.json');await writeFile(witnessPath,JSON.stringify(witness),{mode:0o600});
  const providerPreparedDirectory=path.join(base,'prepared');if(options.slot)await mkdir(providerPreparedDirectory,{mode:0o700});
  const manifest={...(options.slot?{providerPreparedDirectory}:{}),version:1,audience:'test-broker',keyId:'issuer',privateKey:keys.privateKey.export({type:'pkcs8',format:'pem'}).toString(),registryDirectory:path.join(base,'registry'),witnessDirectory,entries:[entry]};
  const issuer=await createWorkspaceGrantIssuer(manifest);
  t.after(async()=>{issuer.close();assert.equal(path.dirname(base),os.tmpdir());await rm(base,{recursive:true,force:true});});
  const request={ticket,userId:'17',root,workspaceId:'workspace',generation:'generation',permission:'run',profileId:'worker'};
  return{base,root,issuer,manifest,entry,witness,witnessPath,request,keys};
}

test('independent registry signs narrow renewable short grants without API owner authority',async t=>{
  const f=await fixture(t);const first=await f.issuer.grant(f.request);const [payload,signature]=first.proof.split('.');const claims=JSON.parse(Buffer.from(payload,'base64url').toString());
  assert.equal(verify(null,Buffer.from(payload),f.keys.publicKey,Buffer.from(signature,'base64url')),true);assert.equal(claims.ownerId,'owner-a');assert.deepEqual(claims.permissions,['run']);assert.deepEqual(claims.profiles,['worker']);assert.ok(claims.expiresAt-claims.issuedAt<=120000);
  const renewed=await f.issuer.grant(f.request);assert.notEqual(renewed.proof,first.proof);assert.equal(renewed.leaseId,'lease');
});
for(const mutation of[{ticket:'b'.repeat(64)},{userId:'18'},{ownerId:'owner-b'},{workspaceId:'other'},{generation:'stale'},{leaseId:'foreign'},{sessionId:'foreign'},{bindingEpoch:'stale'},{profileId:'root'},{permission:'quiesce'}])test('issuer rejects forged selector '+Object.keys(mutation)[0],async t=>{const f=await fixture(t);await assert.rejects(f.issuer.grant({...f.request,...mutation}),/ISSUER_/);});

test('issuer renew revalidates trusted witness and canonical device/inode every time',async t=>{
  const f=await fixture(t);await f.issuer.grant(f.request);f.witness.leaseId='new-lease';await writeFile(f.witnessPath,JSON.stringify(f.witness));await assert.rejects(f.issuer.grant(f.request),/WITNESS/);
  f.witness.leaseId='lease';await writeFile(f.witnessPath,JSON.stringify(f.witness));await rename(f.root,f.root+'-old');await mkdir(f.root);await assert.rejects(f.issuer.grant(f.request),/ROOT_REPLACED/);
});

test('recovery permission requires exact independent stopped birth witness, not API boolean',async t=>{
  const f=await fixture(t,{recovery:'legacy-writer-release'});const request={...f.request,permission:'quiesce',recoveryPurpose:'legacy-writer-release'};
  assert.ok((await f.issuer.grant(request)).proof);f.witness.supervisorStopped.pidNamespace='pid:[other]';await writeFile(f.witnessPath,JSON.stringify(f.witness));await assert.rejects(f.issuer.grant(request),/STOP_WITNESS/);
});

test('live release purpose cannot be used as orphan death authorization',async t=>{
  const f=await fixture(t,{recovery:'live-writer-release'});assert.ok((await f.issuer.grant({...f.request,permission:'quiesce',recoveryPurpose:'live-writer-release'})).proof);
  await assert.rejects(f.issuer.grant({...f.request,permission:'quiesce',recoveryPurpose:'legacy-writer-release'}),/WITNESS/);
});

test('provider run and exec require the latest exact independent prepared slot witness',async t=>{
  const f=await fixture(t,{slot:true});const filename=path.join(f.manifest.providerPreparedDirectory,'slot-a.json');
  assert.ok((await f.issuer.grant({...f.request,permission:'status'})).proof);
  await assert.rejects(f.issuer.grant(f.request));
  const prepared={version:1,active:true,prepared:true,slotId:'slot-a',root:f.root,ownerId:f.entry.ownerId,userId:f.entry.userId,workspaceId:f.entry.workspaceId,generation:f.entry.generation,leaseId:f.entry.leaseId,bindingEpoch:f.entry.bindingEpoch,sessionId:f.entry.sessionId,profileId:'worker',fingerprint:'f'.repeat(64),expiresAt:Date.now()+300000};
  await writeFile(filename,JSON.stringify(prepared),{mode:0o600});assert.ok((await f.issuer.grant(f.request)).proof);assert.ok((await f.issuer.grant({...f.request,permission:'exec'})).proof);
  for(const mutation of[{prepared:false},{slotId:'other'},{profileId:'other'},{leaseId:'other'},{userId:'18'},{sessionId:'other'},{expiresAt:0}]){await writeFile(filename,JSON.stringify({...prepared,...mutation}));await assert.rejects(f.issuer.grant(f.request),/PROVIDER_SLOT/);}
});

test('issuer exposes only bounded grant endpoint on an actual private IPC channel',async t=>{
  const f=await fixture(t);const socketPath=process.platform==='win32'?'\\\\.\\pipe\\chisa-broker-issuer-'+path.basename(f.base):path.join(f.base,'issuer.sock');
  const server=await createWorkspaceGrantIssuerServer(f.issuer,{socketPath});t.after(()=>server.close());
  const {request}=await import('node:http');const data=Buffer.from(JSON.stringify(f.request));
  const result=await new Promise((resolve,reject)=>{const req=request({socketPath,path:'/v1/grant',method:'POST',headers:{'Content-Type':'application/json','Content-Length':data.length}},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,value:JSON.parse(Buffer.concat(chunks).toString())}));});req.on('error',reject);req.end(data);});
  assert.equal(result.status,200);assert.ok(result.value.proof);
});
