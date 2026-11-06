import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { createAgentRelayBroker } from '../agent-relay.service.js';

const tokenA = 'a'.repeat(64), tokenB = 'b'.repeat(64);
const payload = { protocol: 1, rootPath: 'C:\\QA', request: { op: 'read', path: '/workspace/input.txt' } };
const reply = { status: 200, body: '{"ok":true}' };
function fixture() {
  let currentTime = 100_000;
  const rows = new Map([['owner:desktop', { token: tokenA, delivery: 'relay' }], ['other:desktop', { token: tokenB, delivery: 'relay' }]]);
  const broker = createAgentRelayBroker({ lookup: (owner, id) => rows.get(owner + ':' + id) ?? null, now: () => currentTime });
  return { broker, rows, advance: (milliseconds: number) => { currentTime += milliseconds; }, now: () => currentTime };
}

async function handshake(broker: ReturnType<typeof createAgentRelayBroker>) {
  const ready = await broker.poll('owner', 'desktop', tokenA, undefined, 0, 2);
  assert.equal(ready.protocol, 2);
  assert.match(ready.epoch!, /^[a-f0-9-]{36}$/);
  assert.deepEqual(ready.jobs, []);
  return ready.epoch!;
}

test('V2 a lost receive response reoffers the exact immutable request until durable receipt ACK', async () => {
  const { broker, advance, now } = fixture();
  const epoch = await handshake(broker);
  const submitted = structuredClone(payload);
  const deadlineAt = now() + 80_000;
  const call = broker.call('owner', 'desktop', tokenA, submitted, undefined, { deadlineAt });
  submitted.request.path = '/workspace/changed.txt';
  const first = (await broker.poll('owner', 'desktop', tokenA, undefined, 25_000, 2)).jobs[0];
  assert.deepEqual(first.payload, payload);
  assert.equal(first.deadlineAt, deadlineAt);
  assert.deepEqual(broker.status('owner', 'desktop'), { online: true, protocol: 2, lastActivityAt: now(), pendingCount: 1, offeredCount: 1, receivedCount: 0 });
  assert.deepEqual((await broker.poll('owner', 'desktop', tokenA, undefined, 1, 2)).jobs, []);
  advance(3_001);
  const second = (await broker.poll('owner', 'desktop', tokenA, undefined, 25_000, 2)).jobs[0];
  assert.deepEqual(second, first, 'network loss must preserve request ID, payload and absolute deadline');
  assert.deepEqual(broker.acknowledge('owner', 'desktop', tokenA, first.requestId, epoch), { ok: true, accepted: true, epoch });
  assert.deepEqual(broker.acknowledge('owner', 'desktop', tokenA, first.requestId, epoch), { ok: true, accepted: true, epoch });
  advance(3_001);
  assert.deepEqual((await broker.poll('owner', 'desktop', tokenA, undefined, 1, 2)).jobs, []);
  assert.deepEqual(broker.settle('owner', 'desktop', tokenA, first.requestId, reply, epoch), { ok: true, accepted: true, epoch });
  assert.deepEqual(await call, reply);
});

test('V2 offer lease wakes an already waiting long poll without a 25 second redelivery stall', async () => {
  const broker = createAgentRelayBroker({ lookup: () => ({ token: tokenA, delivery: 'relay' }), offerLeaseMs: 15 });
  const epoch = await handshake(broker);
  const call = broker.call('owner', 'desktop', tokenA, payload);
  const first = (await broker.poll('owner', 'desktop', tokenA, undefined, 1000, 2)).jobs[0];
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const started = Date.now();
    const retry = await broker.poll('owner', 'desktop', tokenA, undefined, 1000, 2);
    assert.deepEqual(retry.jobs, [first]);
    assert.ok(Date.now() - started < 700, 'offer lease should wake long poll before its normal deadline');
    broker.acknowledge('owner', 'desktop', tokenA, first.requestId, epoch);
    broker.settle('owner', 'desktop', tokenA, first.requestId, reply, epoch);
    await call;
  } finally { clearTimeout(keepAlive); }
});

test('V2 heartbeat keeps liveness independent from poll start and reports only obsolete active jobs', async () => {
  const { broker, advance } = fixture();
  const epoch = await handshake(broker);
  advance(39_000);
  assert.deepEqual(broker.heartbeat('owner', 'desktop', tokenA, epoch, []), { ok: true, epoch, obsoleteRequestIds: [] });
  advance(39_000);
  const call = broker.call('owner', 'desktop', tokenA, payload);
  const job = (await broker.poll('owner', 'desktop', tokenA, undefined, 25_000, 2)).jobs[0];
  broker.acknowledge('owner', 'desktop', tokenA, job.requestId, epoch);
  const absent = randomUUID();
  assert.deepEqual(broker.heartbeat('owner', 'desktop', tokenA, epoch, [job.requestId, absent, absent]), { ok: true, epoch, obsoleteRequestIds: [absent] });
  broker.settle('owner', 'desktop', tokenA, job.requestId, reply, epoch);
  await call;
  assert.deepEqual(broker.heartbeat('owner', 'desktop', tokenA, epoch, [job.requestId]), { ok: true, epoch, obsoleteRequestIds: [job.requestId] });
  advance(40_001);
  await assert.rejects(broker.call('owner', 'desktop', tokenA, payload), { code: 'AGENT_RELAY_OFFLINE' });
});

test('V2 abort before ACK prevents execution and abort after ACK retains delivered uncertainty', async () => {
  for (const acknowledged of [false, true]) {
    const { broker } = fixture();
    const epoch = await handshake(broker);
    const controller = new AbortController();
    const call = broker.call('owner', 'desktop', tokenA, payload, controller.signal);
    const failure = assert.rejects(call, (error: any) => error.code === 'AGENT_RELAY_INTERRUPTED' && error.details.requestDispatched === acknowledged);
    const job = (await broker.poll('owner', 'desktop', tokenA, undefined, 25_000, 2)).jobs[0];
    if (acknowledged) broker.acknowledge('owner', 'desktop', tokenA, job.requestId, epoch);
    controller.abort();
    await failure;
    assert.deepEqual(broker.acknowledge('owner', 'desktop', tokenA, job.requestId, epoch), { ok: true, accepted: false, epoch }, 'late ACK cannot authorize an expired offer');
    assert.deepEqual(broker.heartbeat('owner', 'desktop', tokenA, epoch, [job.requestId]), { ok: true, epoch, obsoleteRequestIds: [job.requestId] });
    assert.deepEqual(broker.settle('owner', 'desktop', tokenA, job.requestId, reply, epoch), { ok: true, accepted: false, epoch });
    assert.equal(broker.status('owner', 'desktop').pendingCount, 0);
  }
});

test('V2 absolute deadlines expire even without caller abort and release request byte budgets', async () => {
  const bytes = Buffer.byteLength(JSON.stringify(payload));
  const broker = createAgentRelayBroker({ lookup: () => ({ token: tokenA, delivery: 'relay' }), ownerByteLimit: bytes });
  const epoch = await handshake(broker);
  const call = broker.call('owner', 'desktop', tokenA, payload, undefined, { deadlineAt: Date.now() + 40 });
  const failure = assert.rejects(call, (error: any) => error.code === 'AGENT_RELAY_TIMEOUT' && error.details.requestDispatched === false);
  const job = (await broker.poll('owner', 'desktop', tokenA, undefined, 25_000, 2)).jobs[0];
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await failure;
    assert.deepEqual(broker.acknowledge('owner', 'desktop', tokenA, job.requestId, epoch), { ok: true, accepted: false, epoch });
    const next = broker.call('owner', 'desktop', tokenA, payload);
    const replacement = (await broker.poll('owner', 'desktop', tokenA, undefined, 25_000, 2)).jobs[0];
    broker.acknowledge('owner', 'desktop', tokenA, replacement.requestId, epoch);
    broker.settle('owner', 'desktop', tokenA, replacement.requestId, reply, epoch);
    assert.deepEqual(await next, reply);
  } finally { clearTimeout(keepAlive); }
});

test('V2 broker restart changes epoch and rejects old ACK, heartbeat work and results', async () => {
  const { broker } = fixture();
  const epoch = await handshake(broker);
  const controller = new AbortController();
  const original = broker.call('owner', 'desktop', tokenA, payload, controller.signal).catch(error => error);
  const job = (await broker.poll('owner', 'desktop', tokenA, undefined, 25_000, 2)).jobs[0];
  broker.acknowledge('owner', 'desktop', tokenA, job.requestId, epoch);
  const replacement = fixture().broker;
  const currentEpoch = await handshake(replacement);
  assert.notEqual(currentEpoch, epoch);
  assert.deepEqual(replacement.acknowledge('owner', 'desktop', tokenA, job.requestId, epoch), { ok: true, accepted: false, epoch: currentEpoch });
  assert.deepEqual(replacement.heartbeat('owner', 'desktop', tokenA, epoch, [job.requestId]), { ok: true, epoch: currentEpoch, obsoleteRequestIds: [job.requestId] });
  assert.deepEqual(replacement.settle('owner', 'desktop', tokenA, job.requestId, reply, epoch), { ok: true, accepted: false, epoch: currentEpoch });
  controller.abort(); await original;
});

test('V2 pending, stale epoch, missing ACK and conflicting duplicate results remain fenced', async () => {
  const { broker } = fixture();
  const epoch = await handshake(broker);
  const call = broker.call('owner', 'desktop', tokenA, payload);
  const job = (await broker.poll('owner', 'desktop', tokenA, undefined, 25_000, 2)).jobs[0];
  assert.throws(() => broker.settle('owner', 'desktop', tokenA, job.requestId, reply, epoch), { code: 'INVALID_AGENT_RELAY_RESULT' });
  assert.deepEqual(broker.acknowledge('owner', 'desktop', tokenA, job.requestId, randomUUID()), { ok: true, accepted: false, epoch });
  broker.acknowledge('owner', 'desktop', tokenA, job.requestId, epoch);
  assert.throws(() => broker.settle('owner', 'desktop', tokenA, job.requestId, reply), { code: 'INVALID_AGENT_RELAY_RESULT' });
  broker.settle('owner', 'desktop', tokenA, job.requestId, reply, epoch);
  await call;
  assert.deepEqual(broker.settle('owner', 'desktop', tokenA, job.requestId, reply, epoch), { ok: true, accepted: false, epoch });
  assert.throws(() => broker.settle('owner', 'desktop', tokenA, job.requestId, { ...reply, body: 'different' }, epoch), { code: 'INVALID_AGENT_RELAY_RESULT' });
  assert.deepEqual(broker.acknowledge('owner', 'desktop', tokenA, job.requestId, epoch), { ok: true, accepted: false, epoch });
});

test('V2 owner, token rotation and invalid heartbeat data cannot acquire another session', async () => {
  const { broker, rows } = fixture();
  const epoch = await handshake(broker);
  const controller = new AbortController();
  const call = broker.call('owner', 'desktop', tokenA, payload, controller.signal);
  const failure = assert.rejects(call, (error: any) => error.code === 'AGENT_RELAY_REPLACED' && error.details.requestDispatched === true);
  const job = (await broker.poll('owner', 'desktop', tokenA, undefined, 25_000, 2)).jobs[0];
  broker.acknowledge('owner', 'desktop', tokenA, job.requestId, epoch);
  assert.throws(() => broker.heartbeat('other', 'desktop', tokenA, epoch, []), { code: 'AGENT_UNAUTHORIZED' });
  assert.throws(() => broker.heartbeat('owner', 'desktop', tokenA, epoch, [1]), { code: 'INVALID_AGENT_RELAY_REQUEST' });
  assert.throws(() => broker.heartbeat('owner', 'desktop', tokenA, epoch, Array.from({ length: 129 }, () => randomUUID())), { code: 'INVALID_AGENT_RELAY_HEARTBEAT' });
  rows.set('owner:desktop', { token: tokenB, delivery: 'relay' });
  const current = await broker.poll('owner', 'desktop', tokenB, undefined, 0, 2);
  await failure;
  assert.notEqual(current.epoch, epoch);
  assert.throws(() => broker.acknowledge('owner', 'desktop', tokenA, job.requestId, epoch), { code: 'AGENT_UNAUTHORIZED' });
  assert.deepEqual(broker.acknowledge('owner', 'desktop', tokenB, job.requestId, epoch), { ok: true, accepted: false, epoch: current.epoch });
  assert.equal(JSON.stringify(broker.status('owner', 'desktop')).includes(tokenB), false);
});

test('V2 batches reserve recovery controls while allowing regular FIFO progress', async () => {
  const { broker } = fixture();
  const epoch = await handshake(broker);
  const controller = new AbortController();
  const calls = Array.from({ length: 5 }, (_, index) => broker.call('owner', 'desktop', tokenA, { request: { op: 'read', path: String(index) } }, controller.signal).catch(error => error));
  for (let index = 0; index < 4; index++) calls.push(broker.call('owner', 'desktop', tokenA, { request: { op: 'job_status', jobId: String(index) } }, controller.signal).catch(error => error));
  const first = (await broker.poll('owner', 'desktop', tokenA, undefined, 25_000, 2)).jobs;
  assert.deepEqual(first.map(job => (job.payload.request as any).op), ['job_status', 'job_status', 'job_status', 'read']);
  assert.deepEqual(first.slice(0, 3).map(job => (job.payload.request as any).jobId), ['0', '1', '2']);
  assert.equal((first[3].payload.request as any).path, '0');
  for (const job of first) broker.acknowledge('owner', 'desktop', tokenA, job.requestId, epoch);
  const next = (await broker.poll('owner', 'desktop', tokenA, undefined, 25_000, 2)).jobs;
  assert.equal((next[0].payload.request as any).jobId, '3');
  controller.abort(); await Promise.all(calls);
});

test('V2 durable admission rejection fails before dispatch and cannot reject an ACKed operation', async () => {
  const { broker } = fixture();
  const epoch = await handshake(broker);
  const call = broker.call('owner', 'desktop', tokenA, payload);
  const job = (await broker.poll('owner', 'desktop', tokenA, undefined, 25_000, 2)).jobs[0];
  assert.deepEqual(broker.rejectReceipt('owner', 'desktop', tokenA, job.requestId, randomUUID()), { ok: true, accepted: false, epoch });
  assert.deepEqual(broker.rejectReceipt('owner', 'desktop', tokenA, job.requestId, epoch), { ok: true, accepted: true, epoch });
  const rejected = await call;
  assert.equal(rejected.status, 503);
  assert.deepEqual(JSON.parse(rejected.body), { ok: false, protocol: 1, platform: 'win32', code: 'AGENT_BUSY',
    error: 'Desktop cannot admit this operation; journal capacity or storage is unavailable' });
  assert.deepEqual(broker.rejectReceipt('owner', 'desktop', tokenA, job.requestId, epoch), { ok: true, accepted: false, epoch });
  assert.deepEqual(broker.acknowledge('owner', 'desktop', tokenA, job.requestId, epoch), { ok: true, accepted: false, epoch });
  assert.equal(broker.status('owner', 'desktop').pendingCount, 0);
  const next = broker.call('owner', 'desktop', tokenA, payload);
  const received = (await broker.poll('owner', 'desktop', tokenA, undefined, 25_000, 2)).jobs[0];
  broker.acknowledge('owner', 'desktop', tokenA, received.requestId, epoch);
  assert.deepEqual(broker.rejectReceipt('owner', 'desktop', tokenA, received.requestId, epoch), { ok: true, accepted: false, epoch });
  broker.settle('owner', 'desktop', tokenA, received.requestId, reply, epoch);
  assert.deepEqual(await next, reply);
});

test('V2 protocol negotiation retires a V1 poll and forbids bypassing durable receipt ACK', async () => {
  const { broker } = fixture();
  const oldPoll = broker.poll('owner', 'desktop', tokenA);
  const oldFailure = assert.rejects(oldPoll, { code: 'AGENT_RELAY_PROTOCOL_CHANGED' });
  const epoch = await handshake(broker);
  await oldFailure;
  await assert.rejects(broker.poll('owner', 'desktop', tokenA, undefined, 0), { code: 'AGENT_RELAY_PROTOCOL_CHANGED' });
  const call = broker.call('owner', 'desktop', tokenA, payload);
  const job = (await broker.poll('owner', 'desktop', tokenA, undefined, 25_000, 2)).jobs[0];
  broker.acknowledge('owner', 'desktop', tokenA, job.requestId, epoch);
  broker.settle('owner', 'desktop', tokenA, job.requestId, reply, epoch);
  await call;
});
