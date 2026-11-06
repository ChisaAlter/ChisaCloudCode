import assert from 'node:assert/strict';
import { spawn as realSpawn } from 'node:child_process';
import * as childProcess from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test, { mock } from 'node:test';

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';

function gate() { let resolve!: () => void; const promise=new Promise<void>(done => { resolve=done; }); return { promise,resolve }; }
const fixtureRoot=await mkdtemp(path.join(os.tmpdir(),'chisa-broker-cancel-')); process.env.WORKSPACES_ROOT=fixtureRoot;
let sdkOptions: Parameters<typeof createSdkMcpServer>[0]|undefined; let sdkQueries=0; let sdkEnd=gate(); let sdkStarted=gate();
let queryScenario: ((input: Parameters<typeof import('@anthropic-ai/claude-agent-sdk').query>[0]) => unknown)|undefined;
let actualChild: ReturnType<typeof realSpawn>|undefined;
let runHold=Promise.resolve(); let cleanupHold=Promise.resolve(); let outputHold=Promise.resolve(); let cleaned=true; let commandStarted=gate(); let cleanupStarted=gate(); let aborted=false; let runs=0; let lastReadOnly=false;
type BrokerInput={ root: string;userId: string;leaseId?: string;brokerLeaseId?: string;bindingEpoch: string;sessionId?: string };
const admissions=new Map<string,{ root: string;bindingEpoch: string;sessionId: string;brokerLeaseId: string }>();
const records=new Map<string,{ output: PassThrough;root: string;leaseId: string;profileId: string;cleanupConfirmed: boolean;request?: unknown }>();
mock.module('../workspace-broker-profile.service.js',{ namedExports: { selectWorkspaceBrokerProfile: (_admission: unknown,input: { readOnly: boolean;environment: Record<string,string> }) => ({ profileId: input.readOnly ? 'readonly' : 'write',environment: input.environment }) } });
mock.module('@/modules/workspace-runtime/index.js',{ namedExports: {
  ensureCloudWorkspaceBinding() {},excludeCloudWorkspaceMetadata() {},getWorkspaceRuntimeIdentity() { return undefined; },readCloudWorkspaceOwner() { return 'fixture-user'; },executeWorkspaceRuntimePreview() { assert.fail('unexpected preview'); },
  async closeWorkspaceBrokerLease(input: BrokerInput) {
    assert.equal(input.userId,'fixture-user'); assert.ok(input.leaseId);
    const selected=admissions.get(input.leaseId); assert.ok(selected);
    assert.equal(input.root,selected.root); assert.equal(input.bindingEpoch,selected.bindingEpoch);
    assert.equal(input.brokerLeaseId,selected.brokerLeaseId); assert.equal(input.sessionId,selected.sessionId);
    const owned=[...records].filter(([,operation]) => operation.root===input.root && operation.leaseId===selected.brokerLeaseId);
    if (!cleaned || owned.some(([,operation]) => !operation.cleanupConfirmed)) throw new Error('independent broker cleanup is not confirmed');
    const confirmedAt=Date.now();
    return { workspaceId: 'workspace',generation: 'generation',root: input.root,userId: input.userId,ownerId: 'operator-owner',bindingEpoch: selected.bindingEpoch,sessionId: selected.sessionId,legacyReservationId: input.leaseId,leaseId: selected.brokerLeaseId,profileId: 'write',state: 'closed',quiescent: true,cleanupConfirmed: true,resourceInventoryComplete: true,resources: owned.map(([operationId]) => ({ operationId,resourceId: 'a'.repeat(64) })),closedAt: confirmedAt,confirmedAt,brokerInstanceId: 'fixture-broker' };
  },
  async getWorkspaceBrokerAdmission(input: BrokerInput) {
    assert.equal(input.userId,'fixture-user');
    const legacyReservationId=input.leaseId;
    const selected={ root: input.root,bindingEpoch: input.bindingEpoch,sessionId: input.sessionId ?? 'fixture-session',brokerLeaseId: legacyReservationId ? 'broker-'+legacyReservationId : 'broker-readonly' };
    if (legacyReservationId) {
      const previous=admissions.get(legacyReservationId); if (previous) assert.deepEqual(selected,previous);
      admissions.set(legacyReservationId,selected);
    }
    if (input.brokerLeaseId!==undefined) assert.equal(input.brokerLeaseId,selected.brokerLeaseId);
    const receipt=(operationId: string) => {
      const operation=records.get(operationId); assert.ok(operation); assert.equal(operation.leaseId,selected.brokerLeaseId);
      return { operationId,workspaceId: 'workspace',generation: 'generation',leaseId: selected.brokerLeaseId,profileId: operation.profileId,kind: 'run' as const,state: 'complete' as const,resourceId: 'a'.repeat(64),exitCode: 0,cleanupConfirmed: operation.cleanupConfirmed,writerLeaseHeld: !operation.cleanupConfirmed };
    };
    const checkProof=(proof: string,permission: string,operationId: string) => { assert.equal(proof,permission+':'+records.get(operationId)!.profileId); };
    return { workspaceId: 'workspace',generation: 'generation',legacyReservationId,leaseId: selected.brokerLeaseId,bindingEpoch: selected.bindingEpoch,sessionId: selected.sessionId,profileId: 'write',previewProfileId: 'preview',root: input.root,
      async proof(permission: string,profileId: string) { assert.ok(['write','readonly'].includes(profileId)); return permission+':'+profileId; },client: {
      async run(proof: string,request: { operationId: string;workspaceId: string;generation: string;leaseId: string;profileId: string }) {
        assert.equal(proof,'run:'+request.profileId); assert.equal(request.workspaceId,'workspace'); assert.equal(request.generation,'generation'); assert.equal(request.leaseId,selected.brokerLeaseId);
        runs++; lastReadOnly=request.profileId==='readonly'; records.set(request.operationId,{ output: new PassThrough(),root: input.root,leaseId: selected.brokerLeaseId,profileId: request.profileId,cleanupConfirmed: false }); commandStarted.resolve();
        await runHold;
        return { ...receipt(request.operationId),state: 'running',cleanupConfirmed: false,writerLeaseHeld: true };
      },
      async stream(proof: string,operationId: string,options: { signal: AbortSignal }) {
        checkProof(proof,'stream',operationId);
        const output=records.get(operationId)!.output;
        // close() may revoke before the async iterator installs its listener.
        // Keep the transport error observable to that iterator without an orphan event.
        output.on('error',() => {});
        const abort=() => { aborted=true; output.destroy(Object.assign(new Error('aborted'),{ name: 'AbortError' })); };
        options.signal.addEventListener('abort',abort,{ once: true }); if (options.signal.aborted) abort();
        const iterator=(async function* () { try { for await (const bytes of output) yield { channel: 'stdout' as const,data: Buffer.from(bytes) }; return receipt(operationId); } finally { options.signal.removeEventListener('abort',abort); } })();
        return { next: () => iterator.next(),return: () => iterator.return(receipt(operationId)) };
      },
      async writeStdin(proof: string,operationId: string,chunk: { sequence: number;data: Buffer;end?: boolean }) {
        checkProof(proof,'stdin',operationId);
        if (chunk.data.length) records.get(operationId)!.request=JSON.parse(chunk.data.toString());
        if (chunk.end) void outputHold.then(() => records.get(operationId)?.output.end(JSON.stringify({ ok: true,stdout: 'actual executor result',exitCode: 0 })));
        return { sequence: chunk.sequence,replay: false };
      },
      async cancel(proof: string,operationId: string) { checkProof(proof,'cancel',operationId); cleanupStarted.resolve(); await cleanupHold; records.get(operationId)!.cleanupConfirmed=cleaned; return receipt(operationId); },
      async reconcile(proof: string,operationId: string) { checkProof(proof,'reconcile',operationId); await cleanupHold; records.get(operationId)!.cleanupConfirmed=cleaned; return receipt(operationId); },
      async status(proof: string,operationId: string) { checkProof(proof,'status',operationId); return receipt(operationId); },
    } };
  },
} });
mock.module('@anthropic-ai/claude-agent-sdk',{ namedExports: { tool,createSdkMcpServer: (options: Parameters<typeof createSdkMcpServer>[0]) => { sdkOptions=options; return createSdkMcpServer(options); },query: (input: Parameters<typeof import('@anthropic-ai/claude-agent-sdk').query>[0]) => {
  sdkQueries++; if (queryScenario) return queryScenario(input);
  const ended=sdkEnd; const stream=(async function* () { sdkStarted.resolve(); yield { type: 'system',subtype: 'init',session_id: 'fixture' }; await ended.promise; })();
  return Object.assign(stream,{ close: () => ended.resolve() });
} } });
mock.module('node:child_process',{ namedExports: { ...childProcess,spawn(command: string,args: string[],options: Parameters<typeof realSpawn>[2]) {
  assert.notEqual(command,'docker','API must never dispatch a Docker CLI fallback'); const child=realSpawn(command,args,options); if (command===process.execPath) actualChild=child; return child;
} } });
const { admitWorkspaceExecution,workspaceQuery,bridgeFileSystem,runWorkspaceCommand,runWorkspaceGitBranchOperation }=await import('../index.js');
async function fixture(run: (root: string) => Promise<void>,protocol=3) {
  const root=await mkdtemp(path.join(fixtureRoot,'project-')); await writeFile(path.join(root,'.chisa-bridge.json'),JSON.stringify(protocol===3 ? { protocol,root,owner: 'fixture-user',bindingEpoch: 'epoch' } : { protocol,port: 19081,token: 'retired',bindingEpoch: 'epoch' }));
  sdkOptions=undefined; sdkQueries=0; sdkEnd=gate(); sdkStarted=gate(); queryScenario=undefined; actualChild=undefined; runHold=Promise.resolve(); cleanupHold=Promise.resolve(); outputHold=Promise.resolve(); cleaned=true; commandStarted=gate(); cleanupStarted=gate(); aborted=false; runs=0; records.clear(); admissions.clear();
  try { await run(root); }
  finally { const child=actualChild as ReturnType<typeof realSpawn>|undefined; if (child && child.exitCode===null) child.kill('SIGKILL'); for (const target of [root,root+'.chisa-lease',root+'.chisa-state',root+'.chisa-worktrees']) { assert.equal(path.dirname(target),fixtureRoot); await rm(target,{ recursive: true,force: true }); } }
}
test.after(async () => { assert.equal(path.dirname(fixtureRoot),os.tmpdir()); await rm(fixtureRoot,{ recursive: true,force: true }); });

test('Claude preparation pins admission and cancellation before SDK launch keeps query unsent',async () => fixture(async root => {
  const entered=gate(); const finish=gate(); const controller=new AbortController(); const options={ cwd: root,abortController: controller,chisaPrepareLaunch: async () => { entered.resolve(); await finish.promise; } }; const query=workspaceQuery({ prompt: 'fixture',options });
  const pending=query.next(); await entered.promise; assert.equal(existsSync(root+'.chisa-lease'),true); controller.abort(); finish.resolve(); await assert.rejects(pending,{ name: 'AbortError' }); assert.equal(sdkQueries,0); assert.equal(existsSync(root+'.chisa-lease'),false);
}));

test('stopTask forwards the exact running SDK task and retains workspace until query teardown',async () => fixture(async root => {
  const ended=gate(); const stopped: string[]=[]; queryScenario=() => Object.assign((async function* () { yield { type: 'system',subtype: 'init' }; await ended.promise; })(),{ close: () => ended.resolve(),async stopTask(id: string) { stopped.push(id); } });
  const query=workspaceQuery({ prompt: 'background',options: { cwd: root } }); await assert.rejects(query.stopTask('before-start'),/not running/); await query.next();
  const before=await readFile(root+'.chisa-lease/state.json','utf8'); await query.stopTask('task-1'); assert.deepEqual(stopped,['task-1']); assert.equal(await readFile(root+'.chisa-lease/state.json','utf8'),before); await query.interrupt(); assert.equal(existsSync(root+'.chisa-lease'),false);
}));

test('plan session exposes read-only tools and admits another turn immediately after confirmed close',async () => fixture(async root => {
  const query=workspaceQuery({ prompt: 'plan',options: { cwd: root,permissionMode: 'plan' } }); await query.next();
  const write=sdkOptions!.tools!.find(item => item.name==='write_file')!; const denied=await write.handler({ path: '/workspace/no',content: 'no',expectedHash: null },{}); assert.equal(denied.isError,true); assert.equal(runs,0);
  await query.interrupt(); const next=await admitWorkspaceExecution({ cwd: root,workspaceMode: 'shared' }); await next.close(); assert.equal(existsSync(root+'.chisa-lease'),false);
}));

test('query cancellation waits exact broker cleanup before releasing old lease',async () => fixture(async root => {
  const done=gate(); outputHold=done.promise; const removed=gate(); cleanupHold=removed.promise;
  const query=workspaceQuery({ prompt: 'run',options: { cwd: root } }); await query.next();
  const command=sdkOptions!.tools!.find(item => item.name==='run_command')!; const result=command.handler({ command: 'sleep 600',path: '/workspace',timeoutSeconds: 600,readOnly: false },{}); await commandStarted.promise;
  await new Promise<void>(resolve => setImmediate(resolve));
  const stop=query.interrupt(); await cleanupStarted.promise; assert.equal(aborted,true); assert.equal(existsSync(root+'.chisa-lease'),true); await assert.rejects(admitWorkspaceExecution({ cwd: root }),{ code: 'WORKSPACE_BUSY' });
  removed.resolve(); await stop; done.resolve(); assert.equal((await result).isError,true); assert.equal(existsSync(root+'.chisa-lease'),false);
}));

for (const readOnly of [false,true]) test(`actual worker applies broker readonly=${readOnly} and records write state`,async () => fixture(async root => {
  const run=await admitWorkspaceExecution({ cwd: root,workspaceMode: 'shared' }); const result=await run.execute({ op: 'exec',readOnly,argv: ['git','status'] }); assert.equal(result.stdout,'actual executor result'); assert.equal(lastReadOnly,readOnly);
  assert.equal(JSON.parse(await readFile(root+'.chisa-lease/state.json','utf8')).mayWrite,!readOnly); await run.close();
}));

test('a finished SDK iterator cannot release ownership before its real process exits',async () => fixture(async root => {
  queryScenario=input => { input.options!.spawnClaudeCodeProcess!({ command: process.execPath,args: ['-e','process.stdin.on("data",()=>process.exit(0));process.stdin.resume()'],cwd: root,env: { PATH: process.env.PATH },signal: new AbortController().signal }); return Object.assign((async function* () { yield { type: 'result',subtype: 'success' }; })(),{ close() {} }); };
  const query=workspaceQuery({ prompt: 'process',options: { cwd: root } }); await query.next(); assert.ok(actualChild); let completed=false; const next=query.next().then(value => { completed=true; return value; });
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(completed,false); assert.equal(existsSync(root+'.chisa-lease'),true); actualChild.stdin!.write('exit\n'); await next; assert.equal(existsSync(root+'.chisa-lease'),false);
}));

for (const field of ['id','epoch','owner','pid','processStartTime','bootId'] as const) test(`old writer close refuses replacement ${field}`,async () => fixture(async root => {
  const run=await admitWorkspaceExecution({ cwd: root,workspaceMode: 'shared' }); const before=JSON.parse(await readFile(root+'.chisa-lease/state.json','utf8')); const replacement={ ...before,[field]: field==='pid' ? process.pid+1 : field==='owner' ? 'pi' : 'changed' }; await writeFile(root+'.chisa-lease/state.json',JSON.stringify(replacement));
  await assert.rejects(run.close()); assert.deepEqual(JSON.parse(await readFile(root+'.chisa-lease/state.json','utf8')),replacement); await assert.rejects(admitWorkspaceExecution({ cwd: root }),{ code: 'WORKSPACE_BUSY' });
}));

test('unconfirmed broker cleanup retains exact pending operation and prevents query completion',async () => fixture(async root => {
  const query=workspaceQuery({ prompt: 'cleanup',options: { cwd: root } }); await query.next(); cleaned=false;
  const command=sdkOptions!.tools!.find(item => item.name==='run_command')!; const result=await command.handler({ command: 'fixture',path: '/workspace',readOnly: false,timeoutSeconds: 60 },{}); assert.equal(result.isError,true);
  const pending=JSON.parse(await readFile(root+'.chisa-lease/state.json','utf8')); assert.equal(pending.cleanupPending.length,1); await assert.rejects(query.interrupt(),{ code: 'WORKSPACE_CLEANUP_FAILED' }); assert.equal(existsSync(root+'.chisa-lease'),true);
}));

test('admitted run close drains worker and streaming process instead of letting borrowed tools write',async () => fixture(async root => {
  const done=gate(); outputHold=done.promise; const run=await admitWorkspaceExecution({ cwd: root,workspaceMode: 'shared' }); const execution=run.execute({ op: 'exec',argv: ['git','status'],readOnly: false }); const deniedExecution=assert.rejects(execution,{ code: 'WORKSPACE_BUSY' }); await commandStarted.promise;
  await assert.rejects(bridgeFileSystem({} as never).writeTextFile(path.join(root,'borrowed'),'no'),{ code: 'WORKSPACE_BUSY' }); const closing=run.close(); await assert.rejects(run.execute({ op: 'read' }),{ code: 'WORKSPACE_BUSY' }); done.resolve(); await deniedExecution; await closing;
  const next=await admitWorkspaceExecution({ cwd: root,workspaceMode: 'shared' }); const child=await next.spawnProcess({ command: 'bash',args: [] }); child.stdout.resume(); child.stderr.resume(); const removed=gate(); cleanupHold=removed.promise; cleanupStarted=gate(); const stop=child.close(); await cleanupStarted.promise;
  const final=next.close(); assert.equal(existsSync(root+'.chisa-lease'),true); removed.resolve(); await stop; await final; assert.equal(existsSync(root+'.chisa-lease'),false);
}));

test('close waits an in-flight independent admission and cleans the sandbox before releasing lease',async () => fixture(async root => {
  const run=await admitWorkspaceExecution({ cwd: root,workspaceMode: 'shared' });
  const hold=gate(); runHold=hold.promise;
  const started=run.spawnProcess({ command: 'bash',args: [] }); const rejected=assert.rejects(started,{ code: 'WORKSPACE_BUSY' });
  await commandStarted.promise; const closing=run.close();
  assert.equal(existsSync(root+'.chisa-lease'),true); hold.resolve(); await rejected; await closing;
  assert.equal(existsSync(root+'.chisa-lease'),false); assert.equal(runs,1);
}));

test('retired protocol-1 file and command paths never fall back to Docker',async () => fixture(async root => {
  const query=workspaceQuery({ prompt: 'offline',options: { cwd: root } }); await query.next(); assert.equal(sdkQueries,1); await query.interrupt();
  await assert.rejects(runWorkspaceCommand(root,'git',['status']),{ code: 'LOCAL_WORKSPACE_REMOVED' }); await assert.rejects(runWorkspaceGitBranchOperation(root,'create','old'),{ code: 'LOCAL_WORKSPACE_REMOVED' }); assert.equal(runs,0);
},1));
