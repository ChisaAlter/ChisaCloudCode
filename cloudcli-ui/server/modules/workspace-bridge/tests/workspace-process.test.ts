import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import test, { mock } from 'node:test';

function gate<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
let getAdmission: (input: unknown) => unknown;
mock.module('@/modules/workspace-runtime/index.js',{ namedExports: { getWorkspaceBrokerAdmission: (input: unknown) => getAdmission(input) } });
let selectProfile = () => ({ profileId: 'worker', environment: {} as Record<string,string> });
mock.module('../workspace-broker-profile.service.js',{ namedExports: { selectWorkspaceBrokerProfile: () => selectProfile() } });
const { spawnWorkspaceProcess } = await import('../workspace-process.service.js');

async function fixture(run: (f: ReturnType<typeof broker>, root: string) => Promise<void>) {
  const base = await mkdtemp(path.join(os.tmpdir(),'chisa-broker-process-')); const root = path.join(base,'project'); await mkdir(root);
  const fake = broker(); fake.admission.root = root; selectProfile = () => ({ profileId: 'worker', environment: {} });
  getAdmission = (input: unknown) => { fake.admissions.push(input); return fake.admission; };
  try { await run(fake,root); }
  finally { assert.equal(path.dirname(root),base); await rm(base,{ recursive: true,force: true }); }
}
function broker() {
  const output = new PassThrough({ highWaterMark: 1024 });
  const calls: string[] = []; const admissions: unknown[] = []; const inputs: Array<{ sequence: number; data: Buffer; end?: boolean }> = [];
  let request: Record<string,unknown> = {}; let sequence = 0; let cleanupConfirmed = true;
  let cleanupHold = Promise.resolve(); let stdinHold = Promise.resolve(); let resourceId = 'a'.repeat(64); let nextCalls = 0; let failRun = false; let failStream = false;
  const removed = gate(); const cleaning = gate();
  const receipt = () => ({ operationId: String(request.operationId), workspaceId: 'workspace',generation: 'generation',leaseId: 'broker-lease',profileId: String(request.profileId ?? 'worker'),kind: 'run' as const,
    state: 'complete' as const,cleanupConfirmed,writerLeaseHeld: !cleanupConfirmed,resourceId,exitCode: 0 });
  const client = {
    async run(_proof: string, input: Record<string,unknown>) { calls.push('run'); request = input; if (failRun) throw new Error('run reply lost'); return { ...receipt(),state: 'running',cleanupConfirmed: false,writerLeaseHeld: true }; },
    async stream(_proof: string,_id: string,options: { signal: AbortSignal }) {
      if (failStream) throw new Error('stream lost');
      options.signal.addEventListener('abort',() => output.destroy(options.signal.reason instanceof Error ? options.signal.reason : Object.assign(new Error('aborted'),{ name: 'AbortError' })),{ once: true });
      if (options.signal.aborted) output.destroy(new Error('aborted'));
      const iterator = (async function* () { for await (const bytes of output) yield { channel: 'stdout' as const,data: Buffer.from(bytes) }; return receipt(); })();
      return { next() { nextCalls++; return iterator.next(); },async return() { output.destroy(); return iterator.return(receipt()); } };
    },
    async writeStdin(_proof: string,_id: string,input: { sequence: number; data: Buffer; end?: boolean }) {
      calls.push('stdin'); assert.equal(input.sequence,++sequence); inputs.push({ ...input,data: Buffer.from(input.data) }); await stdinHold; return { sequence,replay: false };
    },
    async cancel() { calls.push('cancel'); cleaning.resolve(); await cleanupHold; removed.resolve(); return receipt(); },
    async reconcile() { calls.push('reconcile'); return receipt(); },
    async status() { calls.push('status'); return receipt(); },
  };
  return { admissions,calls,inputs,output,cleaning,removed,client,
    admission: { client,workspaceId: 'workspace',generation: 'generation',leaseId: 'broker-lease',legacyReservationId: 'lease',bindingEpoch: 'epoch',sessionId: 'session',profileId: 'worker',root: '',async proof(permission: string,profileId: string) { assert.equal(profileId,'worker'); calls.push('proof:'+permission); return 'independent-grant'; } },
    get request() { return request; },get nextCalls() { return nextCalls; },
    set cleanupConfirmed(value: boolean) { cleanupConfirmed = value; },set cleanupHold(value: Promise<void>) { cleanupHold = value; },set stdinHold(value: Promise<void>) { stdinHold = value; },
    set resourceId(value: string) { resourceId = value; },set failRun(value: boolean) { failRun = value; },set failStream(value: boolean) { failStream = value; },
  };
}
function workspace(root: string,record: (value: boolean) => void = () => {},publish?: () => Promise<void>) {
  return { root,readOnly: false,name: 'operation-1',userId: '17',leaseId: 'lease',brokerLeaseId: 'broker-lease',bindingEpoch: 'epoch',sessionId: 'session',purpose: 'provider' as const,gitMounts: [],record,publish };
}

test('semantic streaming launch pins admission, forwards sandbox argv only and waits cleanup before publication',async () => fixture(async (f,root) => {
  const hold = gate(); f.cleanupHold = hold.promise; const recorded: boolean[] = []; const events: string[] = [];
  const child = await spawnWorkspaceProcess({ command: 'node',args: ['worker'],cwd: root },workspace(root,value => recorded.push(value),async () => { events.push('publish'); }));
  child.stdout.resume(); child.stderr.resume();
  assert.deepEqual(f.admissions,[{ userId: '17',root,leaseId: 'lease',brokerLeaseId: 'broker-lease',bindingEpoch: 'epoch',sessionId: 'session' }]);
  assert.deepEqual(f.request,{ operationId: 'operation-1',workspaceId: 'workspace',generation: 'generation',leaseId: 'broker-lease',profileId: 'worker',command: ['node','worker'],cwd: '',environment: {} });
  assert.ok(!Object.keys(f.request).some(key => /mount|network|image|uid|docker/i.test(key)));
  f.output.end('result'); await f.cleaning.promise;
  assert.deepEqual(recorded,[true]); assert.deepEqual(events,[]);
  hold.resolve(); assert.deepEqual(await child.completion,{ code: 0,signal: null });
  assert.deepEqual(recorded,[true,false]); assert.deepEqual(events,['publish']); assert.equal(f.calls.filter(call => call==='run').length,1);
}));

test('ordered stdin chunks and EOF wait for acknowledgement and propagate write backpressure',async () => fixture(async (f,root) => {
  const hold = gate(); f.stdinHold = hold.promise;
  const child = await spawnWorkspaceProcess({ command: 'node',args: [] },workspace(root)); child.stdout.resume(); child.stderr.resume();
  let accepted = false;
  const writable = child.stdin.write(Buffer.alloc(140_000,65),() => { accepted = true; });
  child.stdin.end(); await setImmediate();
  assert.equal(writable,false); assert.equal(accepted,false); assert.equal(f.inputs.length,1); assert.equal(f.inputs[0].sequence,1);
  hold.resolve(); await new Promise<void>(resolve => child.stdin.once('finish',resolve));
  assert.equal(accepted,true); assert.deepEqual(f.inputs.map(item => item.sequence),[1,2,3,4]);
  assert.equal(Buffer.concat(f.inputs.map(item => item.data)).length,140_000); assert.equal(f.inputs[3].end,true);
  f.output.end(); await child.completion;
}));

test('unconsumed stdout stops requesting broker frames until local reader drains',async () => fixture(async (f,root) => {
  const child = await spawnWorkspaceProcess({ command: 'node',args: [] },workspace(root)); child.stderr.resume();
  f.output.write(Buffer.alloc(256*1024)); await setImmediate(); await setImmediate();
  const reads = f.nextCalls; assert.equal(reads,1);
  await setImmediate(); assert.equal(f.nextCalls,reads);
  child.stdout.resume(); f.output.end(); await child.completion; assert.ok(f.nextCalls>reads);
}));

for (const external of [false,true]) test(`cancel keeps cleanup independent and deduplicated; caller abort=${external}`,async () => fixture(async (f,root) => {
  const hold = gate(); f.cleanupHold = hold.promise; const caller = new AbortController(); const recorded: boolean[] = [];
  const child = await spawnWorkspaceProcess({ command: 'node',args: [],signal: caller.signal },workspace(root,value => recorded.push(value))); child.stdout.resume(); child.stderr.resume();
  if (external) caller.abort();
  const closing = child.close(); const rejected = external ? assert.rejects(closing,{ name: 'AbortError' }) : closing;
  await f.cleaning.promise; assert.deepEqual(recorded,[true]); hold.resolve(); await rejected; await (external ? assert.rejects(child.close(),{ name: 'AbortError' }) : child.close());
  assert.equal(f.calls.filter(call => call==='cancel').length,1); assert.deepEqual(recorded,[true,false]);
}));

for (const failure of ['unconfirmed','replacement','lost-run','lost-stream'] as const) test(`uncertain ${failure} never republishes or relaunches`,async () => fixture(async (f,root) => {
  let published = false; const recorded: boolean[] = [];
  if (failure==='unconfirmed') f.cleanupConfirmed = false;
  if (failure==='lost-run') { f.failRun = true; f.cleanupConfirmed = false; }
  if (failure==='lost-stream') f.failStream = true;
  const spawning = spawnWorkspaceProcess({ command: 'node',args: [] },workspace(root,value => recorded.push(value),async () => { published = true; }));
  if (failure==='lost-run') { await assert.rejects(spawning,{ code: 'WORKSPACE_CLEANUP_FAILED' }); }
  else {
    const child = await spawning; child.stdout.resume(); child.stderr.resume();
    if (failure==='replacement') f.resourceId='b'.repeat(64);
    f.output.end();
    await assert.rejects(child.completion,failure==='lost-stream' ? /stream lost/ : { code: 'WORKSPACE_CLEANUP_FAILED' });
  }
  assert.equal(f.calls.filter(call => call==='run').length,1);
  assert.equal(published,failure==='lost-stream'); assert.deepEqual(recorded,failure==='lost-stream' ? [true,false] : [true]);
}));

test('invalid command/path/profile and already-aborted input never dispatch broker run',async () => fixture(async (f,root) => {
  await assert.rejects(spawnWorkspaceProcess({ command: 'node\n',args: [] },workspace(root)),{ code: 'INVALID_REQUEST' });
  await assert.rejects(spawnWorkspaceProcess({ command: 'node',args: [],cwd: os.tmpdir() },workspace(root)),{ code: 'WORKSPACE_PATH_INVALID' });
  const signal = AbortSignal.abort(); await assert.rejects(spawnWorkspaceProcess({ command: 'node',args: [],signal },workspace(root)),{ name: 'AbortError' });
  selectProfile = () => { throw Object.assign(new Error('profile not enrolled'),{ code: 'WORKSPACE_BROKER_PROFILE_UNAVAILABLE' }); };
  await assert.rejects(spawnWorkspaceProcess({ command: 'node',args: [],runtimeMounts: [{ source: root,target: '/runtime/provider-code',writable: false }] },workspace(root)),{ code: 'WORKSPACE_BROKER_PROFILE_UNAVAILABLE' });
  assert.ok(!f.calls.includes('run'));
}));

for (const field of ['root','bindingEpoch','legacyReservationId','leaseId','sessionId'] as const) test(`changed admitted ${field} is refused before dispatch`,async () => fixture(async (f,root) => {
  f.admission[field]='foreign';
  await assert.rejects(spawnWorkspaceProcess({ command: 'node',args: [] },workspace(root)),{ code: 'WORKSPACE_CLEANUP_FAILED' });
  assert.ok(!f.calls.includes('run')); assert.ok(!f.calls.some(call => call.startsWith('proof:')));
}));

for (const boundary of ['admission','proof','run'] as const) test(`captured activity revocation after ${boundary} cannot dispatch or deliver an admitted process`,async () => fixture(async (f,root) => {
  let active=true; const recorded: boolean[]=[]; const selected=workspace(root,value => recorded.push(value));
  const captured={ ...selected,assertActive() { if (!active) throw Object.assign(new Error('captured activity revoked'),{ code: 'CAPTURED_ACTIVITY_REVOKED' }); } };
  if (boundary==='admission') getAdmission=(input: unknown) => { f.admissions.push(input); active=false; return f.admission; };
  if (boundary==='proof') {
    const original=f.admission.proof; f.admission.proof=async (permission,profileId) => { const result=await original(permission,profileId); if (permission==='run') active=false; return result; };
  }
  if (boundary==='run') {
    const original=f.client.run; f.client.run=async (proof,request) => { const result=await original(proof,request); active=false; return result; };
  }
  if (boundary==='proof') {
    // The local pending record exists, but no immutable daemon resource was ever
    // returned. Revocation cannot manufacture a cleanup receipt for that record.
    await assert.rejects(spawnWorkspaceProcess({ command: 'node',args: [] },captured),(error: unknown) => {
      const failure=error as { code?: string;cause?: { operation?: { code?: string } } };
      assert.equal(failure.code,'WORKSPACE_CLEANUP_FAILED'); assert.equal(failure.cause?.operation?.code,'CAPTURED_ACTIVITY_REVOKED'); return true;
    });
  } else await assert.rejects(spawnWorkspaceProcess({ command: 'node',args: [] },captured),{ code: 'CAPTURED_ACTIVITY_REVOKED' });
  assert.equal(f.calls.filter(call => call==='run').length,boundary==='run'?1:0);
  if (boundary==='admission') assert.deepEqual(recorded,[]);
  else { assert.deepEqual(recorded,boundary==='proof'?[true]:[true,false]); assert.equal(f.calls.filter(call => call==='cancel').length,1); }
  if (boundary==='proof') assert.equal(f.calls.filter(call => call==='reconcile').length,1);
}));
