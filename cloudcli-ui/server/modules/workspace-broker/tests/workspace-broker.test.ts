import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { chmod, chown, lstat, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Duplex } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import type { WorkspaceBrokerConfiguration, WorkspaceBrokerEngine, WorkspaceBrokerRunRequest } from '@/shared/index.js';

import { createWorkspaceBroker, createWorkspaceBrokerClient, createWorkspaceBrokerServer } from '../index.js';

class FakeSocket extends Duplex {
  received: Buffer[] = [];
  reads = 0;
  constructor() { super({ allowHalfOpen: true, highWaterMark: 1024 }); }
  _read() { this.reads++; }
  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) { this.received.push(Buffer.from(chunk)); callback(); }
  _final(callback: () => void) { callback(); }
  frame(channel: number, data: string | Buffer) { const value = Buffer.from(data); const header = Buffer.alloc(8); header[0] = channel; header.writeUInt32BE(value.length,4); return this.push(Buffer.concat([header,value])); }
}
class FakeEngine implements WorkspaceBrokerEngine {
  counter = 0;
  containers = new Map<string,NonNullable<Awaited<ReturnType<WorkspaceBrokerEngine['inspectContainer']>>>>();
  networks = new Map<string,NonNullable<Awaited<ReturnType<WorkspaceBrokerEngine['inspectNetwork']>>>>();
  sockets = new Map<string,FakeSocket>();
  execs = new Map<string,{ running: boolean; exitCode: number }>();
  calls: string[] = [];
  offline = false;
  removeFailure = false;
  retainOnRemove = false;
  createFailure: 'none' | 'before' | 'after' = 'none';
  startFailure = false;
  onStart?: () => void;
  replacement?: NonNullable<Awaited<ReturnType<WorkspaceBrokerEngine['inspectContainer']>>>;
  check(name: string) { this.calls.push(name); if (this.offline) throw new Error('daemon-unavailable'); }
  next() { return (++this.counter).toString(16).padStart(64,'0'); }
  async createSandbox(input: Parameters<WorkspaceBrokerEngine['createSandbox']>[0]) {
    this.check('create'); if (this.createFailure === 'before') throw new Error('lost-create-response');
    const id = this.next();
    this.containers.set(id,{ id, name: input.name, imageDigest: input.imageDigest, labels: { ...input.labels }, running: false, restarting: false, exitCode: 0,
      networkId: input.networkId, address: '172.30.0.2', uid: input.uid + ':' + input.gid, privileged: false, hostPid: false, readOnlyRootfs: true,
      capDrop: ['ALL'], securityOpt: ['no-new-privileges'], memoryBytes: input.memoryBytes, nanoCpus: input.nanoCpus, pidsLimit: input.pidsLimit,
      mounts: structuredClone(input.mounts), restartPolicy: 'no' });
    if (this.createFailure === 'after') throw new Error('lost-create-response');
    return id;
  }
  async startContainer(id: string) { this.check('start:' + id); this.onStart?.(); if (this.startFailure) throw new Error('start-failed'); this.containers.get(id)!.running = true; }
  async inspectContainer(target: string) { this.check('inspect:' + target); return structuredClone(this.containers.get(target) ?? [...this.containers.values()].find(item => item.name === target) ?? null); }
  async listWorkspaceContainers(key: string) { this.check('inventory'); return [...this.containers.values()].filter(item => item.labels['chisa.broker.workspace'] === key).map(item => item.id); }
  async removeContainer(id: string) { this.check('remove:' + id); if (this.removeFailure) throw new Error('remove-failed'); if (!this.retainOnRemove) this.containers.delete(id); if (this.replacement) this.containers.set(this.replacement.id,this.replacement); }
  async attachContainer(id: string) { this.check('attach:' + id); const socket = new FakeSocket(); this.sockets.set(id,socket); return socket; }
  async createExec(_id: string, _input: Parameters<WorkspaceBrokerEngine['createExec']>[1]) { this.check('exec-create'); const id = this.next(); this.execs.set(id,{ running: false, exitCode: 0 }); return id; }
  async startExec(id: string) { this.check('exec-start'); this.execs.get(id)!.running = true; const socket = new FakeSocket(); this.sockets.set(id,socket); return socket; }
  async inspectExec(id: string) { this.check('exec-inspect'); return structuredClone(this.execs.get(id)!); }
  async logs(id: string, _maxBytes: number) { this.check('logs:' + id); return Buffer.from('filtered owned log'); }
  async inspectNetwork(target: string) { this.check('network-inspect'); return structuredClone(this.networks.get(target) ?? [...this.networks.values()].find(item => item.name === target) ?? null); }
  async createNetwork(input: Parameters<WorkspaceBrokerEngine['createNetwork']>[0]) { this.check('network-create'); const id = this.next(); this.networks.set(id,{ id, name: input.name, driver: 'bridge', scope: 'local', internal: input.internal, defaultBridge: false, labels: input.labels }); return id; }
  async retireContainer(id: string) { this.check('retire:' + id); const item = this.containers.get(id)!; item.running = false; item.restarting = false; item.restartPolicy = 'no'; }
}

async function fixture(t: { after(callback: () => Promise<void>): void }, mutate?: (config: WorkspaceBrokerConfiguration) => void) {
  const base = await mkdtemp(path.join(os.tmpdir(),'chisa-broker-test-'));
  const root = path.join(base,'owner-a'); const otherRoot = path.join(base,'owner-b');
  await mkdir(path.join(root,'workspace'),{ recursive: true, mode: 0o700 });
  await mkdir(path.join(otherRoot,'workspace'),{ recursive: true, mode: 0o700 });
  const keys = generateKeyPairSync('ed25519');
  const config: WorkspaceBrokerConfiguration = {
    registryDirectory: path.join(base,'registry'), audience: 'test-broker',
    authorityKeys: [{ keyId: 'issuer-1', publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), owners: ['owner-a','owner-b'] }],
    controlledRoots: [{ id: 'root-a', ownerId: 'owner-a', path: root },{ id: 'root-b', ownerId: 'owner-b', path: otherRoot }],
    workspaces: [{ id: 'workspace-a', ownerId: 'owner-a', rootId: 'root-a', relativePath: 'workspace', generation: 'generation-a', profiles: ['worker'], network: { name: 'chisa-broker-account-a', internal: true } },
      { id: 'workspace-b', ownerId: 'owner-b', rootId: 'root-b', relativePath: 'workspace', generation: 'generation-b', profiles: ['worker'], network: { name: 'chisa-broker-account-b', internal: true } }],
    profiles: [{ id: 'worker', imageDigest: 'sha256:' + 'a'.repeat(64), uid: Math.max(1000,(process.getuid?.() ?? 0)+1), gid: 1000, memoryBytes: 1024 ** 3, nanoCpus: 1e9, pidsLimit: 64,
      tmpfsBytes: 64 * 1024 ** 2, timeoutMs: 60000, maxOutputBytes: 8192, maxStdinBytes: 4096, readOnlyWorkspace: false, environmentKeys: ['MODEL_TOKEN'] }],
  };
  mutate?.(config);
  const engine = new FakeEngine();
  let broker = await createWorkspaceBroker(config,engine);
  const proof = (overrides: Record<string,unknown> = {}) => {
    const payload = Buffer.from(JSON.stringify({ version: 1, keyId: 'issuer-1', audience: 'test-broker', ownerId: 'owner-a', workspaceId: 'workspace-a', generation: 'generation-a',
      leaseId: 'lease-a', profiles: ['worker'], permissions: ['run','exec','status','cancel','reconcile','network','logs','preview','stdin','stream','retire'],
      issuedAt: Date.now() - 1000, expiresAt: Date.now() + 120000, grantId: 'test-grant', ...overrides })).toString('base64url');
    return payload + '.' + sign(null,Buffer.from(payload),keys.privateKey).toString('base64url');
  };
  const run: WorkspaceBrokerRunRequest = { operationId: 'run-1', workspaceId: 'workspace-a', generation: 'generation-a', leaseId: 'lease-a', profileId: 'worker', command: ['sh','-c','printf hello'] };
  t.after(async () => {
    await broker.close();
    // Only delete this fixture's exclusively allocated absolute temporary tree.
    assert.equal(path.dirname(base),os.tmpdir()); assert.ok(path.basename(base).startsWith('chisa-broker-test-'));
    await rm(base,{ recursive: true, force: true });
  });
  return { base,root,config,engine,proof,run,get broker() { return broker; }, async restart() { await broker.close(); broker = await createWorkspaceBroker(config,engine); return broker; }, async configureFresh(next: WorkspaceBrokerConfiguration) { await broker.close(); next.registryDirectory=path.join(base,'registry-extra'); broker=await createWorkspaceBroker(next,engine); return broker; } };
}

test('verified owner grant admits a pinned profile and identical operation replay never spawns twice',async t => {
  const f = await fixture(t); const proof = f.proof();
  const first = await f.broker.run(proof,f.run);
  assert.equal(first.state,'running'); assert.equal(first.writerLeaseHeld,true); assert.match(first.resourceId!,/^[a-f0-9]{64}$/);
  const again = await f.broker.run(proof,structuredClone(f.run)); assert.deepEqual(again,first);
  assert.equal(f.engine.calls.filter(call => call === 'create').length,1);
  await assert.rejects(f.broker.run(proof,{ ...f.run, command: ['false'] }),/BROKER_OPERATION_CONFLICT/);
  const result = await f.broker.cancel(proof,f.run.operationId); assert.equal(result.cleanupConfirmed,true); assert.equal(result.writerLeaseHeld,false);
  assert.equal((await f.broker.run(proof,f.run)).state,'complete');
});

for (const [label,claims] of [
  ['cross owner',{ ownerId: 'owner-b' }],['cross workspace',{ workspaceId: 'workspace-b' }],['stale generation',{ generation: 'old' }],
  ['expired',{ issuedAt: Date.now()-10000, expiresAt: Date.now()-1 }],['future',{ issuedAt: Date.now()+10000 }],['wrong audience',{ audience: 'different' }],
  ['missing permission',{ permissions: ['status'] }],['wrong profile',{ profiles: ['unknown'] }],['long validity',{ expiresAt: Date.now()+600000 }],
] as const) test('admission rejects ' + label + ' without daemon calls',async t => {
  const f = await fixture(t); await assert.rejects(f.broker.run(f.proof(claims),f.run),/BROKER_/); assert.equal(f.engine.calls.length,0);
});

test('self asserted owner and modified signed payload fail before daemon access',async t => {
  const f = await fixture(t);
  await assert.rejects(f.broker.run('owner-a',f.run),/BROKER_UNAUTHORIZED/);
  const token = f.proof(); const [payload,signature] = token.split('.'); const decoded = JSON.parse(Buffer.from(payload,'base64url').toString()); decoded.ownerId = 'owner-b';
  await assert.rejects(f.broker.run(Buffer.from(JSON.stringify(decoded)).toString('base64url') + '.' + signature,f.run),/BROKER_UNAUTHORIZED/);
  assert.equal(f.engine.calls.length,0);
});

for (const extra of [{ image: 'alpine:latest' },{ mounts: ['/etc:/host'] },{ network: 'host' },{ uid: 0 },{ dockerArgs: ['--privileged'] },{ privileged: true }]) test('arbitrary Docker policy input rejects: ' + Object.keys(extra)[0],async t => {
  const f = await fixture(t); await assert.rejects(f.broker.run(f.proof(),{ ...f.run, ...extra }),/BROKER_INVALID_REQUEST/); assert.equal(f.engine.calls.length,0);
});

test('cwd traversal, unapproved environment, NUL command and stale lease reject',async t => {
  const f = await fixture(t);
  for (const request of [{ ...f.run,cwd: '../escape' },{ ...f.run,environment: { DOCKER_HOST: 'tcp://host' } },{ ...f.run,command: ['sh','\0'] },{ ...f.run,leaseId: 'other' }]) await assert.rejects(f.broker.run(f.proof(),request),/BROKER_/);
  assert.equal(f.engine.calls.length,0);
});

test('new lease is fenced while exact old resource cleanup is unconfirmed',async t => {
  const f = await fixture(t); const started = await f.broker.run(f.proof(),f.run);
  f.engine.offline = true;
  const pending = await f.broker.cancel(f.proof(),f.run.operationId);
  assert.equal(pending.state,'pending-cleanup'); assert.equal(pending.writerLeaseHeld,true); assert.equal(pending.cleanupConfirmed,false);
  f.engine.offline = false;
  await assert.rejects(f.broker.run(f.proof({ leaseId: 'next-lease' }),{ ...f.run, operationId: 'run-next', leaseId: 'next-lease' }),/BROKER_WORKSPACE_BUSY/);
  assert.equal(f.engine.containers.has(started.resourceId!),true);
  const done = await f.broker.reconcile(f.proof(),f.run.operationId); assert.equal(done.cleanupConfirmed,true); assert.equal(done.writerLeaseHeld,false);
});

test('daemon remove success while object is still present does not release lease',async t => {
  const f = await fixture(t); await f.broker.run(f.proof(),f.run); f.engine.retainOnRemove = true;
  const pending = await f.broker.cancel(f.proof(),f.run.operationId); assert.equal(pending.cleanupConfirmed,false); assert.equal(pending.writerLeaseHeld,true);
  f.engine.retainOnRemove = false; assert.equal((await f.broker.reconcile(f.proof(),f.run.operationId)).cleanupConfirmed,true);
});

test('creation response loss recovers only full exact identity and immutable id',async t => {
  const f = await fixture(t); f.engine.createFailure = 'after';
  const result = await f.broker.run(f.proof(),f.run);
  assert.equal(result.cleanupConfirmed,true); assert.equal(result.writerLeaseHeld,false); assert.equal(f.engine.containers.size,0);
  assert.equal(f.engine.calls.filter(call => call === 'create').length,1);
  await f.broker.run(f.proof(),f.run); assert.equal(f.engine.calls.filter(call => call === 'create').length,1);
});

test('empty inventory after an uncertain create remains quarantined, including after broker restart',async t => {
  const f = await fixture(t); f.engine.createFailure = 'before';
  const result = await f.broker.run(f.proof(),f.run); assert.equal(result.cleanupConfirmed,false); assert.equal(result.writerLeaseHeld,true); assert.equal(result.reason,'BROKER_CREATE_OUTCOME_UNKNOWN');
  await f.restart(); const again = await f.broker.reconcile(f.proof(),f.run.operationId); assert.equal(again.writerLeaseHeld,true); assert.equal(again.cleanupConfirmed,false);
  assert.equal(f.engine.calls.filter(call => call === 'create').length,1);
});

test('spawn/start failure retains a recoverable durable record and is never relaunched',async t => {
  const f = await fixture(t); f.engine.startFailure = true; f.engine.removeFailure = true;
  const result = await f.broker.run(f.proof(),f.run); assert.equal(result.cleanupConfirmed,false); assert.equal(result.writerLeaseHeld,true);
  await f.broker.close(); f.engine.removeFailure = false; await f.restart();
  const recovered = await f.broker.run(f.proof(),f.run); assert.equal(recovered.cleanupConfirmed,true); assert.equal(f.engine.calls.filter(call => call === 'create').length,1);
});

test('process restart with live container reconciles daemon resource, never local PID absence',async t => {
  const f = await fixture(t); const running = await f.broker.run(f.proof(),f.run); f.engine.offline = true;
  await f.restart(); assert.equal((await f.broker.cancel(f.proof(),f.run.operationId)).writerLeaseHeld,true);
  f.engine.offline = false; const done = await f.broker.reconcile(f.proof(),f.run.operationId); assert.equal(done.cleanupConfirmed,true);
  assert.ok(f.engine.calls.includes('remove:' + running.resourceId));
});

test('same-name replacement is never removed and cannot release old writer',async t => {
  const f = await fixture(t); const running = await f.broker.run(f.proof(),f.run);
  const original = f.engine.containers.get(running.resourceId!)!;
  const replacementId = f.engine.next();
  f.engine.replacement = { ...structuredClone(original),id: replacementId,labels: { ...original.labels,'chisa.broker.owner': 'foreign' } };
  const result = await f.broker.cancel(f.proof(),f.run.operationId);
  assert.equal(result.cleanupConfirmed,false); assert.equal(result.writerLeaseHeld,true); assert.equal(f.engine.containers.has(replacementId),true);
  assert.equal(f.engine.calls.includes('remove:' + replacementId),false);
});

test('foreign orphan with matching workspace identity blocks release without broad deletion',async t => {
  const f = await fixture(t); const running = await f.broker.run(f.proof(),f.run);
  const original = f.engine.containers.get(running.resourceId!)!; const id = f.engine.next();
  f.engine.containers.set(id,{ ...structuredClone(original), id, name: 'orphan' });
  const result = await f.broker.cancel(f.proof(),f.run.operationId); assert.equal(result.cleanupConfirmed,false); assert.equal(result.reason,'BROKER_ORPHAN_PRESENT');
  assert.equal(f.engine.calls.includes('remove:' + id),false);
});

for (const field of ['privileged','hostPid','readOnlyRootfs','networkId','imageDigest','uid','memoryBytes','nanoCpus','pidsLimit'] as const) test('resource drift fails closed: ' + field,async t => {
  const f = await fixture(t); const started = await f.broker.run(f.proof(),f.run); const resource = f.engine.containers.get(started.resourceId!)!;
  if (field === 'privileged' || field === 'hostPid') resource[field] = true;
  else if (field === 'readOnlyRootfs') resource[field] = false;
  else if (field === 'memoryBytes' || field === 'nanoCpus' || field === 'pidsLimit') resource[field] = 0;
  else resource[field] = 'foreign';
  const result = await f.broker.cancel(f.proof(),f.run.operationId); assert.equal(result.cleanupConfirmed,false); assert.equal(result.writerLeaseHeld,true);
  assert.equal(f.engine.calls.some(call => call.startsWith('remove:')),false);
});

test('new dispatch refuses an unregistered orphan even after a previous lease completed',async t => {
  const f = await fixture(t); const first = await f.broker.run(f.proof(),f.run); const orphan = structuredClone(f.engine.containers.get(first.resourceId!)!);
  await f.broker.cancel(f.proof(),first.operationId); orphan.id = f.engine.next(); orphan.name = 'external-orphan'; f.engine.containers.set(orphan.id,orphan);
  await assert.rejects(f.broker.run(f.proof(),{ ...f.run,operationId: 'after-orphan' }),/BROKER_ORPHAN_PRESENT/);
  assert.equal(f.engine.calls.filter(call => call === 'create').length,1); assert.equal(f.engine.containers.has(orphan.id),true);
});

test('network lifecycle pins id and rejects foreign/default/global/replaced account networks',async t => {
  const f = await fixture(t); const first = await f.broker.network(f.proof(),'workspace-a');
  const network = f.engine.networks.get(first.networkId)!;
  for (const mutation of [{ driver: 'overlay' },{ scope: 'global' },{ defaultBridge: true },{ labels: {} },{ internal: false }]) {
    const saved = structuredClone(network); Object.assign(network,mutation);
    await assert.rejects(f.broker.network(f.proof(),'workspace-a'),/BROKER_NETWORK_INVALID/); Object.assign(network,saved);
  }
  f.engine.networks.delete(first.networkId);
  await assert.rejects(f.broker.network(f.proof(),'workspace-a'),/BROKER_NETWORK_REPLACED/);
  assert.equal(f.engine.calls.filter(call => call === 'network-create').length,1);
});

test('workspace realpath/inode replacement rejects before new dispatch',async t => {
  const f = await fixture(t); await rename(path.join(f.root,'workspace'),path.join(f.root,'previous')); await mkdir(path.join(f.root,'workspace'),{ mode: 0o700 });
  await assert.rejects(f.broker.run(f.proof(),f.run),/BROKER_PATH_REPLACED/); assert.equal(f.engine.calls.length,0);
});

test('workspace symlink is rejected, including a canonical target outside controlled root',async t => {
  const f = await fixture(t); await rename(path.join(f.root,'workspace'),path.join(f.root,'previous'));
  try { await symlink(path.join(f.base,'owner-b','workspace'),path.join(f.root,'workspace'),process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM','EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('symlink creation denied by platform'); return; } throw error; }
  await assert.rejects(f.broker.run(f.proof(),f.run),/BROKER_PATH_/); assert.equal(f.engine.calls.length,0);
});

test('persistent registry tombstone and exclusive lifetime lock survive reopen',async t => {
  const f = await fixture(t);
  await assert.rejects(createWorkspaceBroker(f.config,f.engine),/locked|busy/i);
  await f.broker.run(f.proof(),f.run); await f.broker.cancel(f.proof(),f.run.operationId); await f.restart();
  assert.equal((await f.broker.run(f.proof(),f.run)).cleanupConfirmed,true); assert.equal(f.engine.calls.filter(call => call === 'create').length,1);
  const db = new DatabaseSync(path.join(f.config.registryDirectory,'registry.sqlite'),{ readOnly: true });
  const document = (db.prepare('SELECT value FROM broker_document').get() as { value: string }).value; db.close();
  assert.equal(document.includes(f.proof()),false); assert.ok(document.includes('run-1'));
});

test('manifest image, UID, root or generation changes are not silently adopted on restart',async t => {
  const f = await fixture(t); await f.broker.close();
  const config = structuredClone(f.config); config.workspaces[0].generation = 'new-generation';
  await assert.rejects(createWorkspaceBroker(config,f.engine),/BROKER_MANIFEST_CHANGED/);
});

test('stdin sequence replay delivers at most once and unknown sequence fails',async t => {
  const f = await fixture(t); const started = await f.broker.run(f.proof(),f.run); const socket = f.engine.sockets.get(started.resourceId!)!;
  await f.broker.writeStdin(f.proof(),f.run.operationId,{ sequence: 1, data: Buffer.from('hello') });
  assert.equal((await f.broker.writeStdin(f.proof(),f.run.operationId,{ sequence: 1, data: Buffer.from('hello') })).replay,true);
  await assert.rejects(f.broker.writeStdin(f.proof(),f.run.operationId,{ sequence: 1, data: Buffer.from('different') }),/BROKER_STDIN_STATE/);
  await assert.rejects(f.broker.writeStdin(f.proof(),f.run.operationId,{ sequence: 3, data: Buffer.from('skip') }),/BROKER_STDIN_STATE/);
  await f.broker.writeStdin(f.proof(),f.run.operationId,{ sequence: 2, data: Buffer.alloc(0), end: true });
  assert.equal(Buffer.concat(socket.received).toString(),'hello');
});

test('async iterator preserves stdout/stderr and drop invokes exact confirmed daemon cleanup',async t => {
  const f = await fixture(t); const started = await f.broker.run(f.proof(),f.run); const socket = f.engine.sockets.get(started.resourceId!)!;
  const stream = await f.broker.stream(f.proof(),f.run.operationId); socket.frame(1,'out'); socket.frame(2,'err');
  assert.deepEqual(await stream.next(),{ value: { channel: 'stdout',data: Buffer.from('out') },done: false });
  assert.deepEqual(await stream.next(),{ value: { channel: 'stderr',data: Buffer.from('err') },done: false });
  await stream.return();
  const done = await f.broker.status(f.proof(),f.run.operationId); assert.equal(done.cleanupConfirmed,true); assert.equal(done.writerLeaseHeld,false);
});

test('iterator return before first next still removes daemon writer',async t => {
  const f = await fixture(t); await f.broker.run(f.proof(),f.run); const stream = await f.broker.stream(f.proof(),f.run.operationId); await stream.return();
  assert.equal((await f.broker.status(f.proof(),f.run.operationId)).cleanupConfirmed,true);
});

test('stream frame and total-output budgets reject oversized daemon output and clean up',async t => {
  const f = await fixture(t); const started = await f.broker.run(f.proof(),f.run); const socket = f.engine.sockets.get(started.resourceId!)!;
  const stream = await f.broker.stream(f.proof(),f.run.operationId); socket.frame(1,Buffer.alloc(8193));
  await assert.rejects(stream.next(),/BROKER_OUTPUT_LIMIT/); assert.equal((await f.broker.status(f.proof(),f.run.operationId)).cleanupConfirmed,true);
});

test('normal run stream completion captures exit code and confirms daemon absence',async t => {
  const f = await fixture(t); const started = await f.broker.run(f.proof(),f.run); const socket = f.engine.sockets.get(started.resourceId!)!;
  const stream = await f.broker.stream(f.proof(),started.operationId); f.engine.containers.get(started.resourceId!)!.running = false; f.engine.containers.get(started.resourceId!)!.exitCode = 17;
  socket.frame(2,'failed'); socket.push(null); const frames = []; for await (const frame of stream) frames.push(frame);
  assert.equal(frames[0].channel,'stderr'); const result = await f.broker.status(f.proof(),started.operationId); assert.equal(result.exitCode,17); assert.equal(result.cleanupConfirmed,true); assert.equal(result.writerLeaseHeld,false);
});

test('abort while a stream next is pending unblocks it and keeps failed daemon cleanup fenced',async t => {
  const f = await fixture(t); await f.broker.run(f.proof(),f.run); const controller = new AbortController();
  const stream = await f.broker.stream(f.proof(),f.run.operationId,{ signal: controller.signal });
  const next = stream.next().catch(() => undefined); f.engine.removeFailure = true; controller.abort(); await next;
  const pending = await f.broker.cancel(f.proof(),f.run.operationId); assert.equal(pending.cleanupConfirmed,false); assert.equal(pending.writerLeaseHeld,true);
});

test('run cancellation during daemon start settles only after immutable absence',async t => {
  const f = await fixture(t); const controller = new AbortController(); f.engine.onStart = () => controller.abort();
  const result = await f.broker.run(f.proof(),f.run,{ signal: controller.signal }); assert.equal(result.cleanupConfirmed,true); assert.equal(result.writerLeaseHeld,false); assert.equal(f.engine.containers.size,0);
});

test('exec replays once and cancellation removes the exact parent instead of claiming exec PID absence',async t => {
  const f = await fixture(t); const parent = await f.broker.run(f.proof(),f.run);
  const request = { operationId: 'exec-1', parentOperationId: f.run.operationId,command: ['sh','-c','sleep 10'] };
  const child = await f.broker.exec(f.proof(),request); assert.equal(child.state,'running');
  await f.broker.exec(f.proof(),request); assert.equal(f.engine.calls.filter(call => call === 'exec-create').length,1);
  const done = await f.broker.cancel(f.proof(),child.operationId); assert.equal(done.cleanupConfirmed,true); assert.equal(done.writerLeaseHeld,false);
  assert.ok(f.engine.calls.includes('remove:' + parent.resourceId)); assert.equal((await f.broker.status(f.proof(),parent.operationId)).cleanupConfirmed,true);
});

test('preview target uses exact registered identity and never returns arbitrary host addresses',async t => {
  const f = await fixture(t); const result = await f.broker.run(f.proof(),{ ...f.run,previewPort: 3000 });
  assert.deepEqual(await f.broker.previewTarget(f.proof(),result.operationId),{ host: '172.30.0.2',port: 3000,resourceId: result.resourceId });
  f.engine.containers.get(result.resourceId!)!.address = '127.0.0.1'; await assert.rejects(f.broker.previewTarget(f.proof(),result.operationId),/BROKER_PREVIEW_UNAVAILABLE/);
});

test('normal exec completion preserves its live parent and retained workspace lease',async t => {
  const f = await fixture(t); const parent = await f.broker.run(f.proof(),f.run);
  const exec = await f.broker.exec(f.proof(),{ operationId: 'exec-normal',parentOperationId: parent.operationId,command: ['true'] });
  f.engine.execs.get(exec.execId!)!.running = false;
  const result = await f.broker.status(f.proof(),exec.operationId); assert.equal(result.exitCode,0); assert.equal(result.cleanupConfirmed,true); assert.equal(result.writerLeaseHeld,true);
  assert.equal(f.engine.containers.has(parent.resourceId!),true);
  assert.equal((await f.broker.cancel(f.proof(),parent.operationId)).writerLeaseHeld,false);
});

test('owner and per-parent aggregate budgets prevent unbounded authorized sandbox or exec allocation',async t => {
  const f = await fixture(t);
  const parents = [];
  for (let index = 0; index < 4; index++) parents.push(await f.broker.run(f.proof(),{ ...f.run,operationId: 'budget-' + index }));
  await assert.rejects(f.broker.run(f.proof(),{ ...f.run,operationId: 'over-budget' }),/BROKER_RESOURCE_BUDGET/);
  for (let index = 0; index < 4; index++) await f.broker.exec(f.proof(),{ operationId: 'exec-budget-' + index,parentOperationId: parents[0].operationId,command: ['true'] });
  await assert.rejects(f.broker.exec(f.proof(),{ operationId: 'exec-over',parentOperationId: parents[0].operationId,command: ['true'] }),/BROKER_RESOURCE_BUDGET/);
  assert.equal(f.engine.calls.filter(call => call === 'create').length,4); assert.equal(f.engine.calls.filter(call => call === 'exec-create').length,4);
});

test('worker control metadata is masked read-only before daemon creation',async t => {
  const f = await fixture(t); await writeFile(path.join(f.root,'workspace','.chisa-bridge.json'),'{}');
  const result = await f.broker.run(f.proof(),f.run); const container = f.engine.containers.get(result.resourceId!)!;
  assert.ok(container.mounts.some(mount => mount.source === '/dev/null' && mount.target === '/workspace/.chisa-bridge.json' && mount.readOnly));
});

test('stdin budget accumulates across chunks and rejects additional bytes',async t => {
  const f = await fixture(t); const started = await f.broker.run(f.proof(),f.run);
  await f.broker.writeStdin(f.proof(),started.operationId,{ sequence: 1,data: Buffer.alloc(3000) });
  await assert.rejects(f.broker.writeStdin(f.proof(),started.operationId,{ sequence: 2,data: Buffer.alloc(1097) }),/BROKER_STDIN_LIMIT/);
  assert.equal(Buffer.concat(f.engine.sockets.get(started.resourceId!)!.received).length,3000);
});

test('async iterator backpressure prevents eager draining daemon output',async t => {
  const f = await fixture(t); const started = await f.broker.run(f.proof(),f.run); const socket = f.engine.sockets.get(started.resourceId!)!;
  const stream = await f.broker.stream(f.proof(),started.operationId);
  assert.equal(socket.frame(1,Buffer.alloc(2048)),false); const readsBefore = socket.reads;
  assert.equal(socket.readableLength,2056); assert.equal(socket.reads,readsBefore);
  const next = await stream.next(); assert.equal(next.done,false); assert.equal(socket.readableLength,0); await stream.return();
});

test('timeout cleanup retains writer while daemon unavailable and later reconciles',async t => {
  const f = await fixture(t,config => { config.profiles[0].timeoutMs = 10; });
  await f.broker.run(f.proof(),f.run); f.engine.offline = true;
  await new Promise<void>(resolve => setTimeout(resolve,30));
  const pending = await f.broker.cancel(f.proof(),f.run.operationId); assert.equal(pending.writerLeaseHeld,true); assert.equal(pending.cleanupConfirmed,false);
  f.engine.offline = false; assert.equal((await f.broker.reconcile(f.proof(),f.run.operationId)).writerLeaseHeld,false);
});

test('registered legacy transport retires by immutable id and preserves files/container/network',async t => {
  const legacyId = 'e'.repeat(64); const networkId = 'f'.repeat(64);
  const f = await fixture(t,config => { config.workspaces[0].legacy = { resourceId: legacyId,name: 'exact-old-sync',network: networkId,
    mounts: [{ source: config.controlledRoots[0].path,target: config.controlledRoots[0].path,readOnly: false }] }; });
  const running = await f.broker.run(f.proof(),f.run); const template = f.engine.containers.get(running.resourceId!)!;
  f.engine.containers.set(legacyId,{ ...structuredClone(template),id: legacyId,name: 'exact-old-sync',networkId,
    labels: { 'chisa.workspace-sync.owner': 'owner-a' },mounts: [{ source: f.root,target: f.root,readOnly: false }],restartPolicy: 'always' });
  const result = await f.broker.retireLegacy(f.proof(),'workspace-a'); assert.equal(result.retired,true); assert.equal(f.engine.containers.has(legacyId),true);
  assert.equal(f.engine.containers.get(legacyId)!.running,false); assert.equal(f.engine.containers.get(legacyId)!.restartPolicy,'no');
  assert.equal((await lstat(f.root)).isDirectory(),true); assert.equal(f.engine.networks.size,1);
  f.engine.containers.get(legacyId)!.labels['chisa.workspace-sync.owner'] = 'foreign';
  await assert.rejects(f.broker.retireLegacy(f.proof(),'workspace-a'),/BROKER_LEGACY_MISMATCH/);
  assert.equal(f.engine.calls.filter(call => call === 'retire:' + legacyId).length,1);
});

test('registry replacement fails closed before executing another operation',{ skip: process.platform === 'win32' ? 'Windows locks open SQLite files; Linux inode replacement case' : false },async t => {
  const f = await fixture(t); const file = path.join(f.config.registryDirectory,'registry.sqlite');
  await f.broker.run(f.proof(),f.run); await rename(file,file + '.old'); await writeFile(file,'foreign',{ mode: 0o600 });
  await assert.rejects(f.broker.cancel(f.proof(),f.run.operationId),/BROKER_REGISTRY_REPLACED/);
});

test('quiescence permanently closes exact lease before cleanup, including renewed grants and restart',async t => {
  const f=await fixture(t);const running=await f.broker.run(f.proof(),f.run);
  await assert.rejects(f.broker.quiesceLease(f.proof(),{workspaceId:'workspace-a',generation:'generation-a',leaseId:'lease-a'}),/BROKER_UNAUTHORIZED/);
  f.engine.offline=true;const pending=await f.broker.quiesceLease(f.proof({permissions:['quiesce']}),{workspaceId:'workspace-a',generation:'generation-a',leaseId:'lease-a'});
  assert.equal(pending.quiescent,false);assert.equal(pending.cleanupConfirmed,false);assert.equal(pending.resourceInventoryComplete,false);
  await assert.rejects(f.broker.run(f.proof(),{...f.run,operationId:'closed-run'}),/BROKER_LEASE_QUIESCED/);
  await assert.rejects(f.broker.exec(f.proof(),{operationId:'closed-exec',parentOperationId:running.operationId,command:['true']}),/BROKER_LEASE_QUIESCED/);
  f.engine.offline=false;await f.restart();const confirmed=await f.broker.quiesceLease(f.proof({permissions:['quiesce']}),{workspaceId:'workspace-a',generation:'generation-a',leaseId:'lease-a'});
  assert.equal(confirmed.quiescent,true);assert.equal(confirmed.cleanupConfirmed,true);assert.equal(confirmed.resourceInventoryComplete,true);assert.deepEqual(confirmed.resources,[{operationId:running.operationId,resourceId:running.resourceId}]);
  await assert.rejects(f.broker.run(f.proof(),{...f.run,operationId:'after-restart'}),/BROKER_LEASE_QUIESCED/);
});

test('pre-dispatch lease has a complete empty inventory only after the permanent broker fence is durable',async t=>{const f=await fixture(t);const closed=await f.broker.quiesceLease(f.proof({permissions:['quiesce']}),{workspaceId:'workspace-a',generation:'generation-a',leaseId:'lease-a'});assert.equal(closed.resourceInventoryComplete,true);assert.equal(closed.quiescent,true);assert.deepEqual(closed.resources,[]);await assert.rejects(f.broker.run(f.proof(),f.run),/BROKER_LEASE_QUIESCED/);await f.restart();await assert.rejects(f.broker.run(f.proof(),f.run),/BROKER_LEASE_QUIESCED/);});
test('native sticky metadata namespace excludes every worker UID and GID and pins the leaf owner',{skip:process.platform!=='linux'||process.getuid?.()!==0},async t=>{const f=await fixture(t);await f.broker.close();await chown(f.root,0,10105);await chmod(f.root,0o1770);await chown(path.join(f.root,'workspace'),10002,10001);f.config.workspaces[0].nativeAccountGroupId=10105;f.config.workspaces[0].rootUid=10002;f.config.profiles[0].uid=10002;f.config.profiles[0].gid=10001;const missingPair=structuredClone(f.config);delete missingPair.workspaces[0].nativeAccountGroupId;delete missingPair.workspaces[0].rootUid;missingPair.registryDirectory=path.join(f.base,'missing-native-pair-registry');await assert.rejects(createWorkspaceBroker(missingPair,f.engine),/BROKER_NATIVE_NAMESPACE_REQUIRED/);await f.configureFresh(f.config);assert.equal((await f.broker.run(f.proof(),f.run)).state,'running');await f.broker.cancel(f.proof(),f.run.operationId);await chown(path.join(f.root,'workspace'),10003,10001);await assert.rejects(f.broker.run(f.proof(),{...f.run,operationId:'changed-leaf-owner'}),/BROKER_NATIVE_NAMESPACE_INVALID/);await chown(path.join(f.root,'workspace'),10002,10001);await chmod(f.root,0o1777);await assert.rejects(f.broker.run(f.proof(),{...f.run,operationId:'other-write-parent'}),/BROKER_PATH_PARENT_WRITABLE|BROKER_NATIVE_NAMESPACE_INVALID/);await chmod(f.root,0o1770);await f.broker.close();const bad=structuredClone(f.config);bad.registryDirectory=path.join(f.base,'unsafe-group-registry');bad.profiles[0].gid=10105;await assert.rejects(createWorkspaceBroker(bad,f.engine),/BROKER_PATH_PARENT_WRITABLE|BROKER_NATIVE_NAMESPACE_INVALID/);});
test('uncertain create and orphan inventory block quiescence attestation',async t=>{
  const f=await fixture(t);f.engine.createFailure='before';await f.broker.run(f.proof(),f.run);
  const result=await f.broker.quiesceLease(f.proof({permissions:['quiesce']}),{workspaceId:'workspace-a',generation:'generation-a',leaseId:'lease-a'});
  assert.equal(result.quiescent,false);assert.equal(result.cleanupConfirmed,false);assert.equal(result.resourceInventoryComplete,false);assert.equal(result.resources[0].resourceId,undefined);
});

test('same canonical workspace root cannot be aliased to bypass the lease fence',async t=>{
  const f=await fixture(t);await f.broker.close();const config=structuredClone(f.config);config.workspaces.push({...config.workspaces[0],id:'alias-workspace'});config.registryDirectory=path.join(f.base,'alias-registry');
  await assert.rejects(createWorkspaceBroker(config,f.engine),/BROKER_WORKSPACE_ROOT_OVERLAP/);
});

test('operator fixed profiles select exact directory and credential-file mounts',async t=>{
  const f=await fixture(t);await f.broker.close();const provider=path.join(f.base,'provider');await mkdir(provider,{mode:0o700});await writeFile(path.join(provider,'auth.json'),'test-credential',{mode:0o600});
  f.config.controlledRoots.push({id:'provider-root',ownerId:'owner-a',path:provider});
  f.config.profiles.push({...structuredClone(f.config.profiles[0]),id:'worker-b'});f.config.workspaces[1].profiles=['worker-b'];
  f.config.profiles[0].mounts=[{rootId:'provider-root',relativePath:'auth.json',target:'/runtime/provider-state/home/auth.json',readOnly:true}];
  await f.configureFresh(f.config);const result=await f.broker.run(f.proof(),f.run);const mounts=f.engine.containers.get(result.resourceId!)!.mounts;
  assert.ok(mounts.some(mount=>mount.source===path.join(provider,'auth.json')&&mount.target==='/runtime/provider-state/home/auth.json'&&mount.readOnly));
});

test('profile fixed environment allows exact echoes and rejects API HOME overrides',async t=>{
  const f=await fixture(t,config=>{config.profiles[0].environment={HOME:'/runtime/provider-state/home',PATH:'/runtime/provider-code/bin:/usr/bin',TMPDIR:'/tmp'};});
  await assert.rejects(f.broker.run(f.proof(),{...f.run,environment:{HOME:'/root'}}),/BROKER_ENV_INVALID/);
  assert.equal((await f.broker.run(f.proof(),{...f.run,environment:{HOME:'/runtime/provider-state/home'}})).state,'running');
});

test('private transport client supports signed semantic calls and contains no daemon fallback',async t => {
  const f = await fixture(t);
  const socketPath = process.platform === 'win32' ? '\\\\.\\pipe\\chisa-broker-' + path.basename(f.base) : path.join(f.base,'broker.sock');
  const server = await createWorkspaceBrokerServer(f.broker,{ socketPath }); t.after(() => server.close());
  const client = createWorkspaceBrokerClient({ socketPath });
  const result = await client.run(f.proof(),f.run); assert.equal(result.state,'running');
  await assert.rejects(client.status(f.proof({ ownerId: 'owner-b' }),result.operationId),/BROKER_UNAUTHORIZED/);
  const stream = await client.stream(f.proof(),result.operationId);
  f.engine.sockets.get(result.resourceId!)!.frame(1,'wire');
  const first = await stream.next(); assert.equal(first.done,false); if (first.done) assert.fail('expected stream data'); assert.equal(first.value.data.toString(),'wire');
  await stream.return();
  const done = await client.reconcile(f.proof(),result.operationId); assert.equal(done.cleanupConfirmed,true); assert.equal(done.writerLeaseHeld,false);
  const quiescent=await client.quiesceLease(f.proof({permissions:['quiesce']}),{workspaceId:'workspace-a',generation:'generation-a',leaseId:'lease-a'});assert.equal(quiescent.quiescent,true);
});
