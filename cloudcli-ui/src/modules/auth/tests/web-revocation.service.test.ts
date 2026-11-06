import { Buffer } from 'node:buffer';

import { afterEach, expect, test, vi } from 'vitest';

import { createAuthSessionStore } from '@/modules/auth-session';
import { createWebRevocationService } from '@/modules/auth/web-revocation.service';

type Adapter = Parameters<typeof createWebRevocationService>[0]['queue'];
type Entry = Parameters<Adapter['reserve']>[0];
const serverKey = location.origin;
function token(user = 1, exp = Math.floor(Date.now() / 1000) + 3600) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return encode({ alg: 'HS256' }) + '.' + encode({ userId: user, sid: 'sid-' + user, exp }) + '.signature';
}
function storage(): Storage {
  const map = new Map<string, string>();
  return { get length() { return map.size; }, key: index => [...map.keys()][index] ?? null, getItem: name => map.get(name) ?? null,
    setItem: (name, value) => { map.set(name, value); }, removeItem: name => { map.delete(name); }, clear: () => map.clear() };
}
function queueAdapter() {
  const entries = new Map<string, Entry>();
  let transaction = Promise.resolve();
  const state = { failed: false };
  const queue: Adapter = {
    reserve(item, now) {
      const operation = transaction.then(() => {
        if (state.failed) throw new Error('durable-store-failed');
        for (const entry of entries.values()) if (entry.expiresAt <= now) entries.delete(entry.key);
        const previous = entries.get(item.key);
        if (previous && JSON.stringify(previous) !== JSON.stringify(item)) throw new Error('conflict');
        if (!previous && entries.size >= 32) throw new Error('capacity');
        entries.set(item.key, { ...item });
      });
      transaction = operation.catch(() => {}); return operation;
    },
    async list(server) { return [...entries.values()].filter(item => item.serverKey === server).map(item => ({ ...item })); },
    async removeExact(item) { if (JSON.stringify(entries.get(item.key)) === JSON.stringify(item)) entries.delete(item.key); },
  };
  return { queue, entries, state };
}
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value) }; }
async function fixture() {
  const durable = queueAdapter(); const session = storage();
  const store = createAuthSessionStore({ serverKey, desktop: false, windowStorage: session });
  await store.initialize(); const ready = await store.start(token()); expect(ready).not.toBeNull(); store.acknowledge(ready!);
  const request = vi.fn(async () => new Response(JSON.stringify({ success: true })));
  const dependencies = { end: store.endWithRevocation, request, queue: durable.queue, serverKey: () => serverKey };
  return { store, ready: ready!, durable, session, request, service: createWebRevocationService(dependencies), dependencies };
}
afterEach(() => vi.restoreAllMocks());

test('committed durable intent precedes exact Bearer dispatch and ACK removes only its item', async () => {
  const value = await fixture();
  value.request.mockImplementation(async () => {
    expect(value.durable.entries.size).toBe(1); expect(value.store.getSnapshot().phase).toBe('closing');
    return new Response(JSON.stringify({ success: true }));
  });
  const pending = value.service.logout(value.ready); expect(value.store.getSnapshot().phase).toBe('closing');
  await expect(value.store.dispatch(value.ready, async () => 'blocked')).rejects.toMatchObject({ name: 'AbortError' });
  const admitted = await pending; expect(admitted).not.toBeNull();
  expect(value.store.getSnapshot().token).toBeNull(); expect(value.request).toHaveBeenCalledWith(value.ready.token, serverKey);
  expect((await admitted!.operation).remoteStatus).toBe('revoked'); expect(value.durable.entries.size).toBe(0);
});

test('A logout then B login is not cleared or supplied B credentials when A ACK arrives', async () => {
  const value = await fixture(); const response = deferred<Response>(); value.request.mockReturnValue(response.promise);
  const admitted = await value.service.logout(value.ready); const second = await value.store.start(token(2), value.store.getSnapshot());
  expect(second).not.toBeNull(); value.store.acknowledge(second!);
  response.resolve(new Response(JSON.stringify({ success: true }))); await admitted!.operation;
  expect(value.store.getSnapshot().sessionInstanceId).toBe(second!.sessionInstanceId); expect(value.store.getSnapshot().token).toBe(second!.token);
  expect(value.request).toHaveBeenCalledTimes(1); expect(value.request).toHaveBeenCalledWith(value.ready.token, serverKey);
});

test('offline logout survives service/window recreation and retries original A rather than current B token', async () => {
  const value = await fixture(); value.request.mockRejectedValue(new TypeError('offline'));
  const admitted = await value.service.logout(value.ready); expect((await admitted!.operation).remoteStatus).toBe('pending');
  expect(value.durable.entries.size).toBe(1); expect(value.store.getSnapshot().phase).toBe('signedOut');
  // A different window authority gets no active credential from the outbox.
  const other = createAuthSessionStore({ serverKey, desktop: false, windowStorage: storage() }); await other.initialize(); expect(other.getSnapshot().token).toBeNull();
  await other.start(token(2));
  const retry = vi.fn(async () => new Response(JSON.stringify({ success: true })));
  const restored = createWebRevocationService({ ...value.dependencies, end: other.endWithRevocation, request: retry });
  expect(await restored.pending()).toHaveLength(1); expect((await restored.retry())[0].remoteStatus).toBe('revoked');
  expect(retry).toHaveBeenCalledWith(value.ready.token, serverKey); expect(value.durable.entries.size).toBe(0); expect(other.getSnapshot().token).toBe(token(2));
});

test('durable transaction failure keeps closing identity and never sends an unrecorded revocation', async () => {
  const value = await fixture(); value.durable.state.failed = true;
  await expect(value.service.logout(value.ready)).rejects.toThrow('durable-store-failed');
  expect(value.store.getSnapshot().phase).toBe('closing'); expect(value.store.getSnapshot().token).toBe(value.ready.token); expect(value.request).not.toHaveBeenCalled();
  await expect(value.store.dispatch(value.ready, async () => 'unsafe')).rejects.toMatchObject({ name: 'AbortError' });
  value.durable.state.failed = false; const retry = await value.service.logout(value.store.getSnapshot());
  expect((await retry!.operation).remoteStatus).toBe('revoked'); expect(value.store.getSnapshot().phase).toBe('signedOut');
});

test('local clear failure retains original durable proof and cannot reopen revoked identity as ready', async () => {
  const value = await fixture(); const write = value.session.setItem;
  value.session.setItem = (key, raw) => {
    if ((JSON.parse(raw) as { phase: string }).phase === 'signedOut') throw new DOMException('full', 'QuotaExceededError');
    write(key, raw);
  }; value.request.mockRejectedValue(new TypeError('offline'));
  await expect(value.service.logout(value.ready)).rejects.toThrow('full');
  expect(value.store.getSnapshot().phase).toBe('closing'); expect(value.durable.entries.size).toBe(1);
  value.session.setItem = write; value.request.mockImplementation(async () => new Response(JSON.stringify({ success: true })));
  const retried = await value.service.logout(value.store.getSnapshot()); expect((await retried!.operation).remoteStatus).toBe('revoked'); expect(value.store.getSnapshot().phase).toBe('signedOut');
});

test('reload after queue commit but before local clear restores only a fenced closing tombstone', async () => {
  const value = await fixture(); const write = value.session.setItem;
  value.session.setItem = (key, raw) => {
    if ((JSON.parse(raw) as { phase: string }).phase === 'signedOut') throw new Error('crash-before-local-clear');
    write(key, raw);
  };
  value.request.mockRejectedValue(new TypeError('offline'));
  await expect(value.service.logout(value.ready)).rejects.toThrow('crash-before-local-clear');
  expect(value.durable.entries.size).toBe(1); value.session.setItem = write;
  const reloaded = createAuthSessionStore({ serverKey, desktop: false, windowStorage: value.session }); await reloaded.initialize();
  expect(reloaded.getSnapshot().phase).toBe('closing'); expect(reloaded.getSnapshot().revocationClosing?.reason).toBe('explicit-logout');
  expect(await reloaded.start(token(2))).toBeNull(); expect(await reloaded.refresh(token(2))).toBe(false);
  await expect(reloaded.dispatch(reloaded.getSnapshot(), async () => 'unsafe')).rejects.toMatchObject({ name: 'AbortError' });
  value.request.mockImplementation(async () => new Response(JSON.stringify({ success: true })));
  const restoredService = createWebRevocationService({ ...value.dependencies, end: reloaded.endWithRevocation });
  const admitted = await restoredService.logout(reloaded.getSnapshot()); expect((await admitted!.operation).remoteStatus).toBe('revoked');
  expect(reloaded.getSnapshot().phase).toBe('signedOut'); expect(reloaded.getSnapshot().revocationClosing).toBeUndefined();
});

test('expired records are classified expired without request and rejected response is never revoked', async () => {
  const value = await fixture(); let now = Math.floor(Date.now() / 1000); const service = createWebRevocationService({ ...value.dependencies, now: () => now });
  value.request.mockResolvedValue(new Response('{}', { status: 401 })); const admitted = await service.logout(value.ready);
  expect((await admitted!.operation).remoteStatus).toBe('rejected'); expect(value.durable.entries.size).toBe(1);
  now += 7200; value.request.mockClear(); expect((await service.retry())[0].remoteStatus).toBe('expired'); expect(value.request).not.toHaveBeenCalled(); expect(value.durable.entries.size).toBe(0);
});

test('transactional adapter caps concurrent window reservations at 32 without evicting live entries', async () => {
  const durable = queueAdapter(); const accepted: Promise<unknown>[] = [];
  for (let i = 0; i < 33; i++) {
    const store = createAuthSessionStore({ serverKey, desktop: false, windowStorage: storage() }); await store.initialize(); const ready = await store.start(token(i + 1));
    const service = createWebRevocationService({ end: store.endWithRevocation, queue: durable.queue, serverKey: () => serverKey, request: async () => { throw new TypeError('offline'); } });
    accepted.push(service.logout(ready!));
  }
  const results = await Promise.allSettled(accepted); expect(results.filter(item => item.status === 'fulfilled')).toHaveLength(32);
  expect(durable.entries.size).toBe(32); expect(results.filter(item => item.status === 'rejected')).toHaveLength(1);
});

test('stale predecessor and foreign server entries never dispatch or overwrite a replacement login', async () => {
  const value = await fixture(); await value.store.start(token(2), value.ready);
  expect(await value.service.logout(value.ready)).toBeNull(); expect(value.request).not.toHaveBeenCalled();
  const foreign = createWebRevocationService({ ...value.dependencies, serverKey: () => 'https://different.test' });
  await expect(foreign.logout(value.store.getSnapshot())).rejects.toThrow('Logout session changed'); expect(value.request).not.toHaveBeenCalled();
});
