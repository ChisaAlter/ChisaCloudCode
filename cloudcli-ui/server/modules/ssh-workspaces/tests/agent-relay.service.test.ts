import assert from 'node:assert/strict';
import test from 'node:test';

import { createAgentRelayBroker } from '../agent-relay.service.js';

const tokenA = 'a'.repeat(64), tokenB = 'b'.repeat(64);
const payload = { protocol: 1, rootPath: 'C:\\QA', request: { op: 'read', path: '/workspace/input.txt' } };
function fixture() {
  const rows = new Map([['owner:desktop', { token: tokenA, delivery: 'relay' }], ['other:desktop', { token: tokenB, delivery: 'relay' }]]);
  let currentTime = 100_000;
  const broker = createAgentRelayBroker({ lookup: (owner, id) => rows.get(owner + ':' + id) ?? null, now: () => currentTime, offlineMs: 100 });
  return { broker, rows, advance: () => { currentTime += 200; } };
}

test('relay handshake, delivery, reply and duplicate result are correlated without exposing token', async () => {
  const { broker } = fixture();
  assert.deepEqual(await broker.poll('owner', 'desktop', tokenA, undefined, 0), { ready: true, jobs: [] });
  const receive = broker.poll('owner', 'desktop', tokenA);
  const call = broker.call('owner', 'desktop', tokenA, payload);
  const { jobs } = await receive;
  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0].payload, payload);
  assert.equal(JSON.stringify(jobs).includes(tokenA), false);
  const reply = { status: 200, body: '{"ok":true}' };
  assert.deepEqual(broker.settle('owner', 'desktop', tokenA, jobs[0].requestId, reply), { ok: true, accepted: true });
  assert.deepEqual(await call, reply);
  assert.deepEqual(broker.settle('owner', 'desktop', tokenA, jobs[0].requestId, reply), { ok: true, accepted: false });
  assert.deepEqual((await broker.poll('owner', 'desktop', tokenA, undefined, 1)).jobs, []);
});

test('same connection id across accounts cannot poll or settle each other work', async () => {
  const { broker } = fixture();
  await broker.poll('owner', 'desktop', tokenA, undefined, 0);
  await broker.poll('other', 'desktop', tokenB, undefined, 0);
  await assert.rejects(broker.poll('other', 'desktop', tokenA, undefined, 0), { code: 'AGENT_UNAUTHORIZED' });
  const call = broker.call('owner', 'desktop', tokenA, payload);
  const job = (await broker.poll('owner', 'desktop', tokenA)).jobs[0];
  assert.deepEqual(broker.settle('other', 'desktop', tokenB, job.requestId, { status: 200, body: 'foreign' }), { ok: true, accepted: false });
  broker.settle('owner', 'desktop', tokenA, job.requestId, { status: 200, body: 'owner' });
  assert.equal((await call).body, 'owner');
});

test('abort before delivery removes queued work; abort after delivery never requeues it', async () => {
  const { broker } = fixture();
  await broker.poll('owner', 'desktop', tokenA, undefined, 0);
  const before = new AbortController();
  const first = broker.call('owner', 'desktop', tokenA, payload, before.signal);
  before.abort();
  await assert.rejects(first, (error: any) => error.code === 'AGENT_RELAY_INTERRUPTED' && error.details.requestDispatched === false);
  assert.deepEqual((await broker.poll('owner', 'desktop', tokenA, undefined, 1)).jobs, []);
  const after = new AbortController();
  const second = broker.call('owner', 'desktop', tokenA, payload, after.signal);
  const job = (await broker.poll('owner', 'desktop', tokenA)).jobs[0];
  after.abort();
  await assert.rejects(second, (error: any) => error.code === 'AGENT_RELAY_INTERRUPTED' && error.details.requestDispatched === true);
  assert.deepEqual(broker.settle('owner', 'desktop', tokenA, job.requestId, { status: 200, body: 'late' }), { ok: true, accepted: false });
  assert.deepEqual((await broker.poll('owner', 'desktop', tokenA, undefined, 1)).jobs, []);
});

test('token rotation retires old pending work and old credentials cannot poll', async () => {
  const { broker, rows } = fixture();
  await broker.poll('owner', 'desktop', tokenA, undefined, 0);
  const old = broker.call('owner', 'desktop', tokenA, payload);
  const oldError = assert.rejects(old, (error: any) => error.code === 'AGENT_RELAY_REPLACED' && error.details.requestDispatched === false);
  rows.set('owner:desktop', { token: tokenB, delivery: 'relay' });
  await assert.rejects(broker.poll('owner', 'desktop', tokenA, undefined, 0), { code: 'AGENT_UNAUTHORIZED' });
  assert.deepEqual(await broker.poll('owner', 'desktop', tokenB, undefined, 0), { ready: true, jobs: [] });
  await oldError;
});

test('control requests bypass queued normal jobs and long command reply does not block polling', async () => {
  const { broker } = fixture();
  await broker.poll('owner', 'desktop', tokenA, undefined, 0);
  const pending = Array.from({ length: 5 }, () => broker.call('owner', 'desktop', tokenA, payload));
  const cancel = broker.call('owner', 'desktop', tokenA, { ...payload, request: { op: 'job_cancel', jobId: 'known-job' } });
  const first = (await broker.poll('owner', 'desktop', tokenA)).jobs;
  assert.equal((first[0].payload.request as any).op, 'job_cancel');
  assert.equal(first.length, 4);
  const second = (await broker.poll('owner', 'desktop', tokenA)).jobs;
  assert.equal(second.length, 2);
  for (const job of [...first, ...second]) broker.settle('owner', 'desktop', tokenA, job.requestId, { status: 200, body: 'ok' });
  await Promise.all([...pending, cancel]);
});

test('offline Agent, channel overload and oversized messages fail with bounded typed errors', async () => {
  const { broker, advance } = fixture();
  await assert.rejects(broker.call('owner', 'desktop', tokenA, payload), (error: any) => error.code === 'AGENT_RELAY_OFFLINE' && error.details.requestDispatched === false);
  await broker.poll('owner', 'desktop', tokenA, undefined, 0);
  advance();
  await assert.rejects(broker.call('owner', 'desktop', tokenA, payload), { code: 'AGENT_RELAY_OFFLINE' });
  await broker.poll('owner', 'desktop', tokenA, undefined, 0);
  await assert.rejects(broker.call('owner', 'desktop', tokenA, { text: 'x'.repeat(12 * 1024 * 1024) }), { code: 'AGENT_RELAY_REQUEST_TOO_LARGE' });
  const controller = new AbortController();
  const pending = Array.from({ length: 32 }, () => broker.call('owner', 'desktop', tokenA, payload, controller.signal).catch(error => error));
  await assert.rejects(broker.call('owner', 'desktop', tokenA, payload), { code: 'AGENT_RELAY_BUSY' });
  controller.abort(); await Promise.all(pending);
});

test('normal saturation keeps cancellation slots and byte budgets recover after abort', async () => {
  const { broker } = fixture();
  await broker.poll('owner', 'desktop', tokenA, undefined, 0);
  const controller = new AbortController();
  const pending = Array.from({ length: 32 }, () => broker.call('owner', 'desktop', tokenA, payload, controller.signal).catch(error => error));
  const cancel = broker.call('owner', 'desktop', tokenA, { request: { op: 'operation_cancel', operationId: 'known' } }, controller.signal).catch(error => error);
  assert.equal(((await broker.poll('owner', 'desktop', tokenA)).jobs[0].payload.request as any).op, 'operation_cancel');
  controller.abort(); await Promise.all([...pending, cancel]);
  const bytes = Buffer.byteLength(JSON.stringify(payload));
  const bounded = createAgentRelayBroker({ lookup: () => ({ token: tokenA, delivery: 'relay' }), globalByteLimit: bytes * 2, ownerByteLimit: bytes });
  await bounded.poll('owner', 'desktop', tokenA, undefined, 0);
  const first = new AbortController();
  const held = bounded.call('owner', 'desktop', tokenA, payload, first.signal).catch(error => error);
  await assert.rejects(bounded.call('owner', 'desktop', tokenA, payload), { code: 'AGENT_RELAY_BUSY' });
  first.abort(); await held;
  const next = bounded.call('owner', 'desktop', tokenA, payload);
  const job = (await bounded.poll('owner', 'desktop', tokenA)).jobs[0];
  bounded.settle('owner', 'desktop', tokenA, job.requestId, { status: 200, body: 'budget-released' });
  assert.equal((await next).body, 'budget-released');
});

test('delivered work is never repeated after a lost poll or token replacement', async () => {
  const { broker, rows } = fixture();
  await broker.poll('owner', 'desktop', tokenA, undefined, 0);
  await assert.rejects(broker.poll('owner', 'desktop', tokenA + '\n', undefined, 0), { code: 'AGENT_UNAUTHORIZED' });
  const caller = new AbortController();
  const result = broker.call('owner', 'desktop', tokenA, payload, caller.signal);
  const delivered = (await broker.poll('owner', 'desktop', tokenA)).jobs[0];
  assert.deepEqual((await broker.poll('owner', 'desktop', tokenA, undefined, 1)).jobs, []);
  const retired = assert.rejects(result, (error: any) => error.code === 'AGENT_RELAY_REPLACED' && error.details.requestDispatched === true);
  rows.set('owner:desktop', { token: tokenB, delivery: 'relay' });
  await broker.poll('owner', 'desktop', tokenB, undefined, 0);
  await retired;
  assert.throws(() => broker.settle('owner', 'desktop', tokenA, delivered.requestId, { status: 200, body: 'late' }), { code: 'AGENT_UNAUTHORIZED' });
  assert.deepEqual(broker.settle('owner', 'desktop', tokenB, delivered.requestId, { status: 200, body: 'late' }), { ok: true, accepted: false });
});

test('poll cancellation is isolated and never cancels another desktop operation', async () => {
  const { broker } = fixture();
  const controller = new AbortController();
  const poll = broker.poll('owner', 'desktop', tokenA, controller.signal);
  await assert.rejects(broker.poll('owner', 'desktop', tokenA), { code: 'AGENT_RELAY_POLL_IN_PROGRESS' });
  controller.abort(); await assert.rejects(poll);
  assert.deepEqual(await broker.poll('owner', 'desktop', tokenA, undefined, 0), { ready: true, jobs: [] });
});
