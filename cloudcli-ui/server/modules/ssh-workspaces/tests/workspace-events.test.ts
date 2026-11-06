import assert from 'node:assert/strict';
import test from 'node:test';

import { createAgentRelayBroker } from '../agent-relay.service.js';
import { createSshWorkspaceReadCache } from '../workspace-read-cache.service.js';

const tokenA = 'a'.repeat(64);
function fixture() {
  const rows = new Map([['owner:desktop', { token: tokenA, delivery: 'relay' }]]);
  let currentTime = 100_000;
  const broker = createAgentRelayBroker({ lookup: (owner, id) => rows.get(owner + ':' + id) ?? null, now: () => currentTime });
  return { broker, advance: (ms: number) => { currentTime += ms; } };
}

test('protocol 2 handshake advertises the events capability only on v2', async () => {
  const { broker } = fixture();
  assert.deepEqual(await broker.poll('owner', 'desktop', tokenA, undefined, 0), { ready: true, jobs: [] });
  const v2 = await broker.poll('owner', 'desktop', tokenA, undefined, 0, 2);
  assert.equal(v2.protocol, 2);
  assert.equal(typeof v2.epoch, 'string');
  assert.deepEqual(v2.capabilities, { events: 1 });
});

test('workspace events validate the batch, fence by epoch and reach listeners', async () => {
  const { broker, advance } = fixture();
  const { epoch } = await broker.poll('owner', 'desktop', tokenA, undefined, 0, 2);
  const seen: Array<{ ownerId: string; connectionId: string; events: unknown[] }> = [];
  const unsubscribe = broker.onWorkspaceEvents(notice => seen.push(notice as typeof seen[number]));

  const events = [{ root: 'C:\\QA', rootIdentity: 'vol:file', path: 'src/a.ts', kind: 'write' }];
  assert.deepEqual(broker.events('owner', 'desktop', tokenA, epoch, events), { ok: true, accepted: true, epoch, delivered: 1 });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].ownerId, 'owner');
  assert.deepEqual(seen[0].events, events);

  // A stale epoch reports the current one without fanning the events out.
  assert.deepEqual(broker.events('owner', 'desktop', tokenA, '0'.repeat(36), events), { ok: true, accepted: false, epoch });
  assert.equal(seen.length, 1);

  advance(50);
  unsubscribe();
  broker.events('owner', 'desktop', tokenA, epoch, events);
  assert.equal(seen.length, 1);
});

test('malformed workspace event batches are rejected without channel state changes', async () => {
  const { broker } = fixture();
  const { epoch } = await broker.poll('owner', 'desktop', tokenA, undefined, 0, 2);
  for (const bad of [
    'not-an-array',
    [{ root: 'C:\\QA', path: 'a', kind: 'explode' }],
    [{ root: '', path: 'a', kind: 'write' }],
    [{ root: 'C:\\QA', path: 'a', kind: 'write', rootIdentity: 42 }],
    Array.from({ length: 300 }, () => ({ root: 'C:\\QA', path: 'a', kind: 'write' })),
  ]) {
    assert.throws(() => broker.events('owner', 'desktop', tokenA, epoch, bad), { code: 'INVALID_AGENT_RELAY_EVENTS' });
  }
});

test('job_output requests ride the control lane ahead of regular work', async () => {
  const { broker } = fixture();
  await broker.poll('owner', 'desktop', tokenA, undefined, 0);
  const payload = { protocol: 1, rootPath: 'C:\\QA', request: { op: 'read', path: 'a' } };
  for (let i = 0; i < 4; i++) void broker.call('owner', 'desktop', tokenA, payload);
  void broker.call('owner', 'desktop', tokenA, { ...payload, request: { op: 'job_output', jobId: '00000000-0000-4000-8000-000000000000' } });
  const { jobs } = await broker.poll('owner', 'desktop', tokenA);
  assert.equal((jobs[0].payload.request as { op: string }).op, 'job_output');
});

test('read cache serves hits inside TTL and root invalidation drops the bucket', () => {
  const cache = createSshWorkspaceReadCache();
  const request = { op: 'read', path: '/workspace/a.ts' };
  const result = { ok: true as const, b64: 'QQ==', hash: 'h' };
  assert.equal(cache.get('o', 'c', 'root-id', request), undefined);
  cache.put('o', 'c', 'root-id', request, result);
  assert.deepEqual(cache.get('o', 'c', 'root-id', request), result);
  // Another root/owner/connection never shares the entry.
  assert.equal(cache.get('o', 'c', 'other-root', request), undefined);
  assert.equal(cache.get('o2', 'c', 'root-id', request), undefined);
  cache.invalidateRoot('o', 'c', 'root-id');
  assert.equal(cache.get('o', 'c', 'root-id', request), undefined);
});
