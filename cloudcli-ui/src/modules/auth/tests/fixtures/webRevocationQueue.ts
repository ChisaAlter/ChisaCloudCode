import type { createWebRevocationService } from '@/modules/auth/web-revocation.service';

type Adapter = Parameters<typeof createWebRevocationService>[0]['queue'];
type Entry = Parameters<Adapter['reserve']>[0];

/** Auth integration fixtures preserve durable transaction ordering without claiming to execute a browser IndexedDB engine. */
export function createRevocationQueueFixture() {
  const entries = new Map<string, Entry>();
  const state = { failed: false };
  let tail = Promise.resolve();
  const queue: Adapter = {
    reserve(item, now) {
      const operation = tail.then(() => {
        if (state.failed) throw new Error('Persistent logout fixture failed');
        for (const value of entries.values()) if (value.expiresAt <= now) entries.delete(value.key);
        const previous = entries.get(item.key);
        if (previous && JSON.stringify(previous) !== JSON.stringify(item)) throw new Error('Conflicting entry');
        if (!previous && entries.size >= 32) throw new Error('Pending logout capacity reached');
        entries.set(item.key, { ...item });
      });
      tail = operation.catch(() => {}); return operation;
    },
    async list(server) { return [...entries.values()].filter(item => item.serverKey === server).map(item => ({ ...item })); },
    async removeExact(item) { if (JSON.stringify(entries.get(item.key)) === JSON.stringify(item)) entries.delete(item.key); },
  };
  return { queue, entries, state };
}
