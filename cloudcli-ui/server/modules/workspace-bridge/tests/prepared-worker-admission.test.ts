import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test, { mock } from 'node:test';

function gate() { let resolve!: () => void; const promise=new Promise<void>(done => { resolve=done; }); return { promise,resolve }; }
const fixtureRoot=await mkdtemp(path.join(os.tmpdir(),'chisa-prepared-broker-')); process.env.WORKSPACES_ROOT=fixtureRoot;
const epoch='current-binding';
let calls: string[]=[]; let beforeRun: ((root: string) => Promise<void>)|undefined; let finishRun=Promise.resolve(); let cleanup=Promise.resolve();
let cleanupConfirmed=true; let cleanupThrows=false; let exitCode=0; let response: unknown={ ok: true,stdout: 'completed',exitCode: 0 }; let rootRunning='';
let running=gate(); let cleaning=gate(); let failGateOnce=false; let gateReleases=0; let gateEnabled=false; let brokerReceiptOverrides: Record<string,unknown>={};
const operations=new Map<string,{ root: string;lease: string;profile: string;resource: string;output: PassThrough;controller: AbortController }>();
const login=Object.freeze({ id: 'prepared-fixture-login',userId: 7,version: 1,createdAt: 1,expiresAt: 4102444800 });
let authActive=true;
mock.module('@/modules/auth/index.js',{ namedExports: { isAuthSessionActive(id: string,userId: number,version: number) {
  assert.equal(id,login.id); assert.equal(userId,login.userId); assert.equal(version,login.version); return authActive;
} } });
mock.module('../workspace-broker-profile.service.js',{ namedExports: { selectWorkspaceBrokerProfile: (_admission: unknown,input: { readOnly: boolean;environment: Record<string,string> }) => ({ profileId: input.readOnly ? 'worker-ro' : 'worker-rw',environment: input.environment }) } });
mock.module('@/modules/workspace-runtime/index.js',{ namedExports: {
  ensureCloudWorkspaceBinding() {},excludeCloudWorkspaceMetadata() {},getWorkspaceRuntimeIdentity() { return undefined; },readCloudWorkspaceOwner() { return String(login.userId); },executeWorkspaceRuntimePreview() { assert.fail('unexpected preview'); },
  async closeWorkspaceBrokerLease(input: { root: string;userId: string;leaseId: string;brokerLeaseId?: string;bindingEpoch: string;sessionId?: string }) {
    assert.equal(input.userId,String(login.userId)); assert.equal(input.bindingEpoch,epoch);
    const brokerLeaseId='broker-'+input.leaseId;
    if (input.brokerLeaseId !== undefined) assert.equal(input.brokerLeaseId,brokerLeaseId);
    if (!cleanupConfirmed || cleanupThrows) throw new Error('independent broker cleanup is not confirmed');
    calls.push('close-lease'); const confirmedAt=Date.now();
    return { leaseId: brokerLeaseId,legacyReservationId: input.leaseId,workspaceId: 'workspace',generation: 'generation',root: input.root,userId: input.userId,ownerId: 'operator-owner',sessionId: input.sessionId ?? 'fixture-session',bindingEpoch: epoch,profileId: 'worker-rw',state: 'closed',quiescent: true,cleanupConfirmed: true,resourceInventoryComplete: true,closedAt: confirmedAt,confirmedAt,brokerInstanceId: 'fixture-broker',
      resources: [...operations].filter(([,operation]) => operation.root===input.root && operation.lease===brokerLeaseId).map(([operationId,operation]) => ({ operationId,resourceId: operation.resource })) };
  },
  async getWorkspaceBrokerAdmission(input: { root: string;userId: string;leaseId?: string;brokerLeaseId?: string;bindingEpoch: string;sessionId?: string }) {
    assert.equal(input.userId,String(login.userId)); assert.equal(input.bindingEpoch,epoch); calls.push('admission');
    const legacyReservationId=input.leaseId ?? 'readonly-reservation'; const leaseId='broker-'+legacyReservationId;
    if (input.brokerLeaseId !== undefined) assert.equal(input.brokerLeaseId,leaseId);
    let operationId=''; const receipt=(id=operationId) => ({ operationId: id,workspaceId: 'workspace',generation: 'generation',leaseId,profileId: operations.get(id)?.profile ?? 'preview-profile',kind: 'run' as const,
      state: 'complete' as const,resourceId: operations.get(id)?.resource ?? 'a'.repeat(64),exitCode,cleanupConfirmed,writerLeaseHeld: !cleanupConfirmed,...brokerReceiptOverrides });
    const client={
      async run(_proof: string,request: { operationId: string;leaseId: string;profileId: string;command: string[] },options: { signal?: AbortSignal }) {
        calls.push('run:'+request.profileId); operationId=request.operationId; rootRunning=input.root; await beforeRun?.(input.root);
        const output=new PassThrough(); const controller=new AbortController(); const original=options.signal;
        if (original?.aborted) original.throwIfAborted();
        assert.equal(request.leaseId,leaseId);
        operations.set(operationId,{ root: input.root,lease: request.leaseId,profile: request.profileId,resource: 'a'.repeat(64),output,controller });
        running.resolve(); return { ...receipt(),state: 'running',cleanupConfirmed: false,writerLeaseHeld: true };
      },
      async stream(_proof: string,id: string,options: { signal: AbortSignal }) {
        const operation=operations.get(id)!;
        options.signal.addEventListener('abort',() => operation.output.destroy(Object.assign(new Error('aborted'),{ name: 'AbortError' })),{ once: true });
        if (options.signal.aborted) operation.output.destroy(Object.assign(new Error('aborted'),{ name: 'AbortError' }));
        const iterator=(async function* () { for await (const bytes of operation.output) yield { channel: 'stdout' as const,data: Buffer.from(bytes) }; return receipt(id); })();
        return { next: () => iterator.next(),return: () => iterator.return(receipt(id)) };
      },
      async writeStdin(_proof: string,id: string,chunk: { sequence: number;data: Buffer;end?: boolean }) {
        if (chunk.end) void finishRun.then(() => operations.get(id)?.output.end(JSON.stringify(response)));
        return { sequence: chunk.sequence,replay: false };
      },
      async cancel(_proof: string,id: string) { calls.push('cancel'); cleaning.resolve(); await cleanup; if (cleanupThrows) throw new Error('broker disconnected'); return receipt(id); },
      async reconcile(_proof: string,id: string) { calls.push('reconcile'); if (cleanupThrows) throw new Error('broker disconnected'); return receipt(id); },
      async status(_proof: string,id: string) { return receipt(id); },
    };
    return { client,workspaceId: 'workspace',generation: 'generation',leaseId,legacyReservationId,bindingEpoch: epoch,sessionId: input.sessionId ?? 'fixture-session',profileId: 'worker-rw',previewProfileId: 'preview-profile',root: input.root,async proof(permission: string) { calls.push('proof:'+permission); return 'independent-grant'; } };
  },
} });
const realGate=await import('../workspace-writer-gate.service.js');
mock.module('../workspace-writer-gate.service.js',{ namedExports: { ...realGate,
  cloudWriterGateAvailable: () => gateEnabled,
  claimCloudWriterLease(root: string,lease: unknown) { mkdirSync(root+'.chisa-lease'); writeFileSync(path.join(root+'.chisa-lease','state.json'),JSON.stringify(lease)); return true; },
  releaseCloudWriterLease(root: string,lease: { id: string }) {
    if (failGateOnce) { failGateOnce=false; throw new Error('transient writer gate release'); }
    assert.equal(state(root).id,lease.id); gateReleases++; rmSync(root+'.chisa-lease',{ recursive: true });
  },
} });
const { admitWorkspaceExecution,executeSyncTransportWorker,prepareSyncTransportPreview,isActiveWorkspaceLease,workspaceRequestScope }=await import('../index.js');
const state=(root: string) => JSON.parse(readFileSync(path.join(root+'.chisa-lease','state.json'),'utf8')) as { id: string;epoch: string;owner: string;mayWrite?: boolean;cleanupPending?: string[];previews?: string[] };
const save=async (root: string,value: unknown) => { await mkdir(root+'.chisa-lease',{ recursive: true }); await writeFile(path.join(root+'.chisa-lease','state.json'),JSON.stringify(value)); };
async function fixture(run: (root: string) => Promise<void>) {
  const root=await mkdtemp(path.join(fixtureRoot,'project-')); await writeFile(path.join(root,'.chisa-bridge.json'),JSON.stringify({ protocol: 3,root,owner: 'fixture',bindingEpoch: epoch }));
  calls=[]; beforeRun=undefined; finishRun=Promise.resolve(); cleanup=Promise.resolve(); cleanupConfirmed=true; cleanupThrows=false; exitCode=0; response={ ok: true,stdout: 'completed',exitCode: 0 }; operations.clear();
  running=gate(); cleaning=gate(); failGateOnce=false; gateEnabled=false; gateReleases=0; brokerReceiptOverrides={}; authActive=true;
  const request=Object.assign(new EventEmitter(),{ headers: {},user: { id: login.userId },authSession: login,aborted: false });
  const httpResponse=Object.assign(new EventEmitter(),{ writableFinished: false });
  try { await new Promise<void>((resolve,reject) => workspaceRequestScope(request as never,httpResponse as never,() => { run(root).then(resolve,reject); })); }
  finally { httpResponse.writableFinished=true; httpResponse.emit('finish'); for (const target of [root,root+'.chisa-lease',root+'.chisa-state',root+'.chisa-worktrees']) { assert.equal(path.dirname(target),fixtureRoot); await rm(target,{ recursive: true,force: true }); } }
}
test.after(async () => { assert.equal(path.dirname(fixtureRoot),os.tmpdir()); await rm(fixtureRoot,{ recursive: true,force: true }); });

for (const owner of ['pi','sync','sync-needed']) test(`foreign ${owner} admission rejects before broker effects`,async () => fixture(async root => {
  const lease={ owner,id: 'foreign',epoch }; await save(root,lease);
  await assert.rejects(executeSyncTransportWorker(root,epoch,{ op: 'write' }),{ code: 'WORKSPACE_BUSY' }); assert.deepEqual(state(root),lease); assert.deepEqual(calls,[]);
}));

test('stale binding, stale lease and already aborted request never contact broker',async () => fixture(async root => {
  await assert.rejects(executeSyncTransportWorker(root,'old-epoch',{ op: 'read' }),{ code: 'STALE_BINDING' });
  await save(root,{ owner: 'claude',id: 'old',epoch: 'old' });
  await assert.rejects(executeSyncTransportWorker(root,epoch,{ op: 'write' }),{ code: 'WORKSPACE_BUSY' });
  await assert.rejects(executeSyncTransportWorker('invalid',epoch,{ op: 'write' },AbortSignal.abort()),{ name: 'AbortError' }); assert.deepEqual(calls,[]);
}));

test('JSON read and readonly exec use readonly broker profile without claiming an old writer lease',async () => fixture(async root => {
  beforeRun=async () => assert.equal(existsSync(root+'.chisa-lease'),false);
  const reply=await executeSyncTransportWorker(root,epoch,{ op: 'read',path: '/workspace/file' }); assert.equal(reply.stdout,'completed');
  await executeSyncTransportWorker(root,epoch,{ op: 'exec',readOnly: true,argv: ['git','status'] });
  assert.deepEqual(calls.filter(call => call.startsWith('run:')),['run:worker-ro','run:worker-ro']); assert.equal(existsSync(root+'.chisa-lease'),false);
}));

test('JSON worker stdin EOF and parsed stdout preserve the currently admitted exact lease',async () => fixture(async root => {
  const lease={ owner: 'claude',id: 'running-model',epoch,mayWrite: false }; await save(root,lease);
  await executeSyncTransportWorker(root,epoch,{ op: 'write',path: '/workspace/file' });
  assert.deepEqual(state(root),{ ...lease,brokerLeaseId: 'broker-'+lease.id,brokerSessionId: 'fixture-session',brokerPreviewProfileId: 'preview-profile',mayWrite: true,cleanupPending: [] }); assert.ok(calls.includes('proof:stdin'));
}));

test('idle mutation holds its original writer until immutable cleanup completes',async () => fixture(async root => {
  const done=gate(); const removed=gate(); finishRun=done.promise; cleanup=removed.promise;
  const operation=executeSyncTransportWorker(root,epoch,{ op: 'write' }); await running.promise;
  const captured=state(root); assert.equal(captured.mayWrite,true); assert.equal(captured.cleanupPending?.length,1); assert.equal(isActiveWorkspaceLease(root,captured.id,epoch),true);
  await assert.rejects(admitWorkspaceExecution({ cwd: root,workspaceMode: 'shared' }),{ code: 'WORKSPACE_BUSY' });
  done.resolve(); await cleaning.promise; assert.equal(existsSync(root+'.chisa-lease'),true); removed.resolve(); await operation;
  assert.equal(existsSync(root+'.chisa-lease'),false); assert.equal(calls.filter(call => call==='cancel').length,1);
}));

test('prepared work serializes and a cancelled queued request never runs',async () => fixture(async root => {
  const done=gate(); finishRun=done.promise;
  const first=executeSyncTransportWorker(root,epoch,{ op: 'write' }); await running.promise;
  const controller=new AbortController(); const second=executeSyncTransportWorker(root,epoch,{ op: 'write' },controller.signal); const rejected=assert.rejects(second,{ name: 'AbortError' }); controller.abort();
  done.resolve(); await first; await rejected; assert.equal(calls.filter(call => call.startsWith('run:')).length,1);
}));

for (const mode of ['unconfirmed','disconnected','replaced-resource'] as const) test(`broker ${mode} retains durable old writer recovery barrier`,async () => fixture(async root => {
  cleanupConfirmed=mode!=='unconfirmed'; cleanupThrows=mode==='disconnected';
  const completed=gate(); finishRun=completed.promise;
  const operation=executeSyncTransportWorker(root,epoch,{ op: 'write' });
  await running.promise;
  if (mode==='replaced-resource') brokerReceiptOverrides={ resourceId: 'b'.repeat(64) };
  completed.resolve();
  await assert.rejects(operation,{ code: 'WORKSPACE_CLEANUP_FAILED' });
  await assert.rejects(executeSyncTransportWorker(root,epoch,{ op: 'write' }),{ code: 'WORKSPACE_CLEANUP_FAILED' });
  assert.equal(state(root).cleanupPending?.length,1); assert.equal(state(root).owner,'claude');
}));

test('invalid JSON and nonzero normal exit release only after confirmed broker cleanup',async () => fixture(async root => {
  response='not-an-rpc-object'; await assert.rejects(executeSyncTransportWorker(root,epoch,{ op: 'write' })); assert.equal(existsSync(root+'.chisa-lease'),false);
  response={ ok: true }; exitCode=1; await assert.rejects(executeSyncTransportWorker(root,epoch,{ op: 'exec' }),{ code: 'WORKSPACE_UNAVAILABLE' }); assert.equal(existsSync(root+'.chisa-lease'),false);
}));

test('preview true flag is independently revalidated and false never removes reservation',async () => fixture(async root => {
  const preview=await prepareSyncTransportPreview(root,epoch); const id='chisa-account-preview-fixture'; preview.retain(id,async () => preview.release(id,true)); await preview.finish(true);
  const original=state(root); await preview.release(id,false); assert.deepEqual(state(root).previews,[id]); assert.deepEqual(state(root).cleanupPending,[id]);
  cleanupConfirmed=false; await assert.rejects(preview.release(id,true),{ code: 'WORKSPACE_CLEANUP_FAILED' }); assert.deepEqual(state(root).previews,[id]);
  cleanupConfirmed=true; await preview.release(id,true); assert.equal(existsSync(root+'.chisa-lease'),false); assert.equal(original.id.length>0,true); assert.ok(calls.includes('reconcile'));
}));

test('preview release retries original permanent gate failure after broker cleanup without losing identity',async () => fixture(async root => {
  gateEnabled=true; const preview=await prepareSyncTransportPreview(root,epoch); const id='chisa-account-preview-gate'; preview.retain(id,async () => preview.release(id,true)); await preview.finish(true);
  const captured=state(root); failGateOnce=true; await assert.rejects(preview.release(id,true),/transient writer gate release/);
  assert.deepEqual(state(root).previews,[]); assert.equal(isActiveWorkspaceLease(root,captured.id,epoch),true); await preview.release(id,true); await preview.release(id,true); assert.equal(gateReleases,1);
}));

test('changed old lease and detached preview calls cannot release another writer',async () => fixture(async root => {
  const preview=await prepareSyncTransportPreview(root,epoch); const id='chisa-account-preview-old'; preview.retain(id,async () => preview.release(id,true)); const original=state(root);
  const changed={ ...original,id: 'replacement' }; await save(root,changed);
  await assert.rejects(preview.finish(true),{ code: 'WORKSPACE_CLEANUP_FAILED' }); await assert.rejects(preview.release(id,true),{ code: 'WORKSPACE_CLEANUP_FAILED' }); assert.deepEqual(state(root),changed);
}));
