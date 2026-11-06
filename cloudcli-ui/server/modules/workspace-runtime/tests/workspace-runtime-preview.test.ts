import assert from 'node:assert/strict';
import fsPromises, { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import type { WorkspaceRuntimePreviewReservation } from '@/shared/index.js';

const fixture = await mkdtemp(path.join(os.tmpdir(),'chisa-preview-broker-')); const root = path.join(fixture,'project'); await mkdir(root);
const home = await mkdtemp(path.join(os.tmpdir(),'chisa-preview-home-')); process.env.WORKSPACES_ROOT = fixture;
mock.module('node:os',{ defaultExport:{...os,homedir:()=>home},namedExports:{...os,homedir:()=>home} });
const identity = { userId:'17',root:fixture,owner:'d'.repeat(24),network:'a'.repeat(64) };
const operations = new Map<string,{ operationId:string;workspaceId:string;generation:string;leaseId:string;state:string;cleanupConfirmed:boolean;exitCode?:number;resourceId:string }>();
const streams = new Map<string,()=>void>();
let failedCleanup = false; let authorityFailure = false; let startupFailure = false; let stoppedRecovery = false; let restoreFails = false;let loginActive=true;let revokeDuringProof=false;let previewProfile: string|undefined='preview';let newPeer=false;let recoveryReleased=true;
const admissionRequests: Array<{userId:string;root:string;leaseId?:string;brokerLeaseId?:string;sessionId?:string;bindingEpoch?:string}>=[];
const events: string[] = []; let recoveries = 0; let lastRequest: any;
const client = {
  async run(_proof:string,request:any) { lastRequest=request;const result={operationId:request.operationId,workspaceId:'workspace',generation:'generation',leaseId:'broker-lease',state:'running',cleanupConfirmed:false,resourceId:'f'.repeat(64)};operations.set(request.operationId,result);if(startupFailure)throw new Error('run failed');return result; },
  async cancel(_proof:string,id:string) { events.push('broker-cancel:'+id);const operation=operations.get(id);if(!operation)throw new Error('unknown operation');if(failedCleanup)return {...operation,state:'pending-cleanup'};operation.state='complete';operation.cleanupConfirmed=true;streams.get(id)?.();return {...operation}; },
  async status(_proof:string,id:string) { const result=operations.get(id);if(!result)throw new Error('unknown operation');return {...result}; },
  async previewTarget() { return {host:'172.18.0.10',port:3000,resourceId:'f'.repeat(64)}; },
  async logs() { return {multiplexed:Buffer.from([1,0,0,0,0,0,0,2,111,107])}; },
  async stream(_proof:string,id:string) { let end!:()=>void;const done=new Promise<void>(resolve=>{end=resolve;});streams.set(id,end);return (async function*(){yield {channel:'stdout' as const,data:Buffer.from('preview ready')};await done;})(); },
};
mock.module('../workspace-runtime-broker.service.js',{namedExports:{getWorkspaceBrokerAdmission:async(input:{userId:string;root:string;leaseId?:string;brokerLeaseId?:string;sessionId?:string;bindingEpoch?:string})=>{
  admissionRequests.push({...input});if(newPeer&&input.brokerLeaseId)throw Object.assign(new Error('AUTHORITY_PEER_CHANGED'),{code:'WORKSPACE_FORBIDDEN',statusCode:403});
  if(authorityFailure)throw new Error('authority denied');assert.equal(input.userId,'17');assert.equal(input.root,root);if(input.leaseId)assert.equal(input.leaseId,'native-lease');if(input.brokerLeaseId)assert.equal(input.brokerLeaseId,'broker-lease');if(input.sessionId)assert.equal(input.sessionId,'session');if(input.bindingEpoch)assert.equal(input.bindingEpoch,'epoch');
  return {client,workspaceId:'workspace',generation:'generation',leaseId:'broker-lease',legacyReservationId:'native-lease',sessionId:'session',profileId:'provider-default',previewProfileId:previewProfile,accountRoot:fixture,proof:async(permission:string,profileId:string)=>{assert.equal(profileId,'preview');if(permission==='run'&&revokeDuringProof)loginActive=false;return permission;}, previewGateway:async(_id:string,base:string)=>({host:'172.18.0.1',port:4010,ticket:'independent-preview-ticket',resourceId:'f'.repeat(64),base}),closePreviewGateway:async()=>{events.push('preview-ticket:closed');}};
}}});
mock.module('../workspace-runtime.service.js',{namedExports:{getWorkspaceRuntimeIdentity:()=>identity,createWorkspaceRuntimeService:()=>({restore:async()=>{if(restoreFails)throw new Error('restore failed');return identity;}})}});
mock.module('@/modules/workspace-bridge/index.js',{namedExports:{recoverStoppedWorkspacePreview:async(input:{userId:string;accountRoot:string;root:string;previewId:string})=>{assert.deepEqual(input,{userId:'17',accountRoot:fixture,root,previewId:input.previewId});recoveries++;if(stoppedRecovery)throw new Error('supervisor proof required');return {released:recoveryReleased};}}});
const {registerWorkspaceRuntimeNetwork}=await import('@/shared/index.js');registerWorkspaceRuntimeNetwork(fixture,identity.network,identity.owner);
const {createWorkspaceRuntimePreviewService,executeWorkspaceRuntimePreview}=await import('../workspace-runtime-preview.service.js');
const {resolveWorkspaceRuntimePreviewAccess}=await import('../workspace-runtime-preview-access.service.js');
const {createWorkspacePreviewInventory}=await import('../workspace-runtime-preview-inventory.repository.js');
const {persistWorkspaceRuntimePreviewWitness,readWorkspaceRuntimePreviewWitness,removeWorkspaceRuntimePreviewWitness,listWorkspaceRuntimePreviewWitnesses}=await import('../workspace-runtime-preview-witness.service.js');
const service=createWorkspaceRuntimePreviewService();
const reservation=():WorkspaceRuntimePreviewReservation=>({root,assertAuthActive(){if(!loginActive)throw new Error('captured login revoked');},broker:{leaseId:'broker-lease',legacyReservationId:'native-lease',sessionId:'session',profileId:'preview'},retain(id){events.push('retain:'+id);},async release(_id,confirmed){events.push('release:'+confirmed);},async finish(confirmed){events.push('finish:'+confirmed);}});
test.beforeEach(()=>{newPeer=false;recoveryReleased=true;admissionRequests.length=0;loginActive=true;revokeDuringProof=false;previewProfile='preview';failedCleanup=authorityFailure=startupFailure=stoppedRecovery=restoreFails=false;events.length=0;recoveries=0;});
test.afterEach(async()=>{failedCleanup=false;authorityFailure=false;newPeer=false;for(const id of [...operations.keys()]){try{await service.discard('17',id);}catch{}streams.get(id)?.();}operations.clear();streams.clear();const inventory=await createWorkspacePreviewInventory('17');for(const entry of await inventory.list())await inventory.remove(entry.previewId);for(const witness of await listWorkspaceRuntimePreviewWitnesses('17'))await removeWorkspaceRuntimePreviewWitness('17',witness.previewId,witness.root);});
test.after(async()=>{assert.equal(path.dirname(fixture),os.tmpdir());await rm(fixture,{recursive:true,force:true});assert.equal(path.dirname(home),os.tmpdir());await rm(home,{recursive:true,force:true});});

test('configured preview runs broker semantics and retains exact reservation through confirmed stop',async()=>{
  const started=await executeWorkspaceRuntimePreview(root,'epoch',{op:'preview_start',command:'node preview.js',port:3000},reservation());
  assert.match(started.previewId!,/^chisa-account-preview-[a-f0-9]{20}-[a-f0-9]{16}$/);assert.deepEqual(lastRequest.command,['bash','-c','node preview.js']);assert.equal(lastRequest.environment.CHISA_PREVIEW_BASE,started.url);
  assert.equal(lastRequest.workspaceId,'workspace');assert.equal(lastRequest.leaseId,'broker-lease');assert.notEqual(lastRequest.leaseId,reservation().broker!.legacyReservationId);assert.ok(events[0].startsWith('retain:'));assert.ok(events.includes('finish:true'));
  const token=started.url!.split('/').at(-2)!;assert.equal((await resolveWorkspaceRuntimePreviewAccess(token)).host,'172.18.0.1');
  assert.equal((await executeWorkspaceRuntimePreview(root,'epoch',{op:'preview_stop',previewId:started.previewId})).status,'stopped');assert.ok(events.includes('release:true'));await assert.rejects(resolveWorkspaceRuntimePreviewAccess(token),{code:'PREVIEW_NOT_FOUND'});
});

test('failed cleanup reports pending, keeps inventory and never releases writer true',async()=>{
  const started=await executeWorkspaceRuntimePreview(root,'epoch',{op:'preview_start',command:'node preview.js',port:3000},reservation());failedCleanup=true;
  await assert.rejects(service.discard('17',started.previewId!),{code:'PREVIEW_CLEANUP_FAILED'});assert.ok(events.includes('release:false'));assert.equal(events.includes('release:true'),false);
  assert.ok(await(await createWorkspacePreviewInventory('17')).read(started.previewId!));failedCleanup=false;await service.discard('17',started.previewId!);assert.ok(events.includes('release:true'));
});

test('status validates root/epoch and gets HTTP readiness without daemon access',async()=>{
  const started=await executeWorkspaceRuntimePreview(root,'epoch',{op:'preview_start',command:'node preview.js',port:3000},reservation());
  const fetch=mock.method(globalThis,'fetch',async()=>new Response('ready'));
  try{const status=await executeWorkspaceRuntimePreview(root,'epoch',{op:'preview_status',previewId:started.previewId});assert.ok('running' in status);if(!('running' in status))assert.fail('expected status result');assert.equal(status.running,true);assert.equal(status.ready,true);assert.equal(status.url,started.url);await assert.rejects(executeWorkspaceRuntimePreview(root,'stale',{op:'preview_stop',previewId:started.previewId}),{code:'PREVIEW_NOT_FOUND'});}finally{fetch.mock.restore();}
});

async function orphanFixture(changes:Record<string,unknown>={},missingWitness=false) {
  const owner=(await import('node:crypto')).createHash('sha256').update(fixture+'\0'+'17').digest('hex').slice(0,20);const id='chisa-account-preview-'+owner+'-'+ 'e'.repeat(16);
  const entry={version:1 as const,userId:'17',accountRoot:fixture,root,previewId:id,bindingEpoch:'epoch',port:3000,workspaceId:'workspace',generation:'generation',leaseId:'old-broker-lease',legacyReservationId:'old-native-lease',sessionId:'old-session',profileId:'preview'};
  const inventory=await createWorkspacePreviewInventory('17');await inventory.put(entry);
  if(!missingWitness)await persistWorkspaceRuntimePreviewWitness('17',id,{...reservation(),lease:{owner:'claude',id:'old-native-lease',epoch:'epoch',pid:123,processStartTime:'456',bootId:'12345678-1234-1234-1234-123456789abc',pidNamespace:'pid:[4026531836]',brokerLeaseId:'old-broker-lease',brokerSessionId:'old-session',brokerPreviewProfileId:'preview',writerGate:true,...changes}});
  newPeer=true;return {id,inventory,entry};
}
test('persisted preview after API restart requires independent legacy recovery and retains inventory on failure',async()=>{
  const {id,inventory}=await orphanFixture();
  const {getWorkspaceBrokerAdmission}=await import('../workspace-runtime-broker.service.js');
  await assert.rejects(getWorkspaceBrokerAdmission({userId:'17',root,leaseId:'old-native-lease',brokerLeaseId:'old-broker-lease',bindingEpoch:'epoch',sessionId:'old-session'}),{code:'WORKSPACE_FORBIDDEN'});admissionRequests.length=0;
  const listed=await service.list('17');assert.deepEqual(listed.previews,[{id,serverPath:root,bindingEpoch:'epoch',remoteHost:'',remotePort:0,recoveryRequired:true,status:'recovery-required'}]);
  const status=await executeWorkspaceRuntimePreview(root,'epoch',{op:'preview_status',previewId:id});assert.equal(status.running,false);assert.equal(status.ready,false);assert.equal(status.recoveryRequired,true);assert.equal(status.status,'recovery-required');
  stoppedRecovery=true;await assert.rejects(service.discard('17',id),/supervisor proof required/);assert.ok(await inventory.read(id));assert.ok(await readWorkspaceRuntimePreviewWitness('17',id));assert.equal(recoveries,1);
  stoppedRecovery=false;await service.discard('17',id);assert.equal(await inventory.read(id),undefined);assert.equal(await readWorkspaceRuntimePreviewWitness('17',id),undefined);assert.equal(recoveries,2);assert.deepEqual(admissionRequests,[]);assert.equal(events.some(event=>event.startsWith('broker-cancel:')||event==='preview-ticket:closed'),false);
});
test('a successful exact native cleanup may retain another preview writer while dropping only this completed operation',async()=>{const {id,inventory}=await orphanFixture();recoveryReleased=false;await service.discard('17',id);assert.equal(recoveries,1);assert.equal(await inventory.read(id),undefined);assert.equal(await readWorkspaceRuntimePreviewWitness('17',id),undefined);assert.deepEqual(admissionRequests,[]);assert.equal(events.includes('release:true'),false);});
test('interruption after broker inventory removal retains the witness and retries exact native cleanup',async()=>{
  const {id,inventory}=await orphanFixture();const originalUnlink=fsPromises.unlink;let failed=false;
  const unlinkMock=mock.method(fsPromises,'unlink',async(location:Parameters<typeof fsPromises.unlink>[0])=>{if(String(location).includes(path.sep+'previews'+path.sep)&&String(location).endsWith(id+'.json')&&!failed){failed=true;throw Object.assign(new Error('witness unlink interrupted'),{code:'EIO'});}return originalUnlink(location);});syncBuiltinESMExports();
  try{await assert.rejects(service.discard('17',id),/witness unlink interrupted/);}finally{unlinkMock.mock.restore();syncBuiltinESMExports();}
  assert.equal(await inventory.read(id),undefined);assert.ok(await readWorkspaceRuntimePreviewWitness('17',id));assert.equal(recoveries,1);assert.equal((await service.list('17')).previews[0]?.recoveryRequired,true);
  await service.discard('17',id);assert.equal(recoveries,2);assert.equal(await readWorkspaceRuntimePreviewWitness('17',id),undefined);assert.deepEqual(admissionRequests,[]);
});
test('an orphan with no private native witness retains broker inventory and never claims successful recovery',async()=>{const {id,inventory}=await orphanFixture({},true);await assert.rejects(service.list('17'),{code:'PREVIEW_RECOVERY_REQUIRED'});await assert.rejects(service.discard('17',id),{code:'PREVIEW_RECOVERY_REQUIRED'});assert.ok(await inventory.read(id));assert.equal(recoveries,0);assert.deepEqual(admissionRequests,[]);});
for(const change of[{brokerLeaseId:'foreign-broker-lease'},{brokerSessionId:'foreign-session'},{brokerPreviewProfileId:'provider-default'},{brokerLeaseId:undefined},{brokerSessionId:undefined},{brokerPreviewProfileId:undefined}])test('orphan private witness cannot discard known broker identity '+Object.keys(change)[0]+'='+String(Object.values(change)[0]),async()=>{const {id,inventory}=await orphanFixture(change);await assert.rejects(service.list('17'),{code:'PREVIEW_RECOVERY_REQUIRED'});await assert.rejects(service.discard('17',id),{code:'PREVIEW_RECOVERY_REQUIRED'});assert.ok(await inventory.read(id));assert.ok(await readWorkspaceRuntimePreviewWitness('17',id));assert.equal(recoveries,0);assert.deepEqual(admissionRequests,[]);});

test('authority/config failure prevents run and settles startup before side effects',async()=>{authorityFailure=true;await assert.rejects(executeWorkspaceRuntimePreview(root,'epoch',{op:'preview_start',command:'node preview.js',port:3000},reservation()),/authority denied/);assert.equal(operations.size,0);assert.deepEqual(events,['finish:true']);});

test('broker run response loss still routes cleanup through persisted operation selector',async()=>{startupFailure=true;await assert.rejects(executeWorkspaceRuntimePreview(root,'epoch',{op:'preview_start',command:'node preview.js',port:3000},reservation()),/run failed/);assert.ok(events.includes('release:true'));assert.ok(events.includes('finish:true'));});

test('revocation while a fresh run proof is pending prevents actual dispatch and removes unstarted inventory',async()=>{revokeDuringProof=true;await assert.rejects(executeWorkspaceRuntimePreview(root,'epoch',{op:'preview_start',command:'node preview.js',port:3000},reservation()),/captured login revoked/);assert.equal(operations.size,0);assert.equal(events.some(event=>event.startsWith('retain:')),false);assert.ok(events.includes('finish:true'));assert.equal((await(await createWorkspacePreviewInventory('17')).list()).length,0);});
test('missing or mismatched operator preview identity never falls back to the provider profile',async()=>{previewProfile=undefined;await assert.rejects(executeWorkspaceRuntimePreview(root,'epoch',{op:'preview_start',command:'node preview.js',port:3000},reservation()),{code:'PREVIEW_PROFILE_REQUIRED'});assert.equal(operations.size,0);previewProfile='preview';const missing=reservation();delete missing.broker;await assert.rejects(executeWorkspaceRuntimePreview(root,'epoch',{op:'preview_start',command:'node preview.js',port:3000},missing),{code:'PREVIEW_RECOVERY_REQUIRED'});assert.equal(operations.size,0);});

test('invalid preflight path and port do not acquire broker operation',async()=>{for(const request of [{op:'preview_start',command:'x',path:'/workspace/../escape',port:3000},{op:'preview_start',command:'x',port:80}])await assert.rejects(executeWorkspaceRuntimePreview(root,'epoch',request,reservation()),{code:'INVALID_REQUEST'});assert.equal(operations.size,0);});
