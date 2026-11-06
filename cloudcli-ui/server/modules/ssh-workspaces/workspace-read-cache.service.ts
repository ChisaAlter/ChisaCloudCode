import { createHash } from 'node:crypto';

import type { SshWorkspaceRpcResult } from '@/shared/index.js';

const TTL_MS = 20_000;
const MAX_ENTRIES_PER_ROOT = 256;
const MAX_ENTRIES_TOTAL = 2048;
const MAX_CACHED_RESULT_BYTES = 512 * 1024;

/**
 * Read-path memo for desktop-agent workspace calls. Entries live only while a
 * target pins a verified root identity: mutation/exec dispatches and agent
 * filesystem events drop the whole root bucket, and a short TTL bounds any
 * external change the watcher cannot see yet. Keys carry no secrets; cached
 * results are the same payload the caller would receive over the transport.
 */
export function createSshWorkspaceReadCache() {
  type Entry = { result: SshWorkspaceRpcResult; expiresAt: number };
  const entries = new Map<string, Entry>();
  const rootKeys = new Map<string, Set<string>>();

  const rootBucket = (userId: string, connectionId: string, rootPath: string) => JSON.stringify([userId, connectionId, rootPath]);
  const entryKey = (userId: string, connectionId: string, rootPath: string, request: Record<string, unknown>) =>
    rootBucket(userId, connectionId, rootPath) + '|' + createHash('sha256').update(JSON.stringify(request)).digest('hex');

  function sweep(now: number) {
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= now) {
        entries.delete(key);
        for (const keys of rootKeys.values()) keys.delete(key);
      }
    }
  }

  return {
    /** The transport consults this before dispatching an inspection operation. */
    get(userId: string, connectionId: string, rootPath: string, request: Record<string, unknown>): SshWorkspaceRpcResult | undefined {
      const now = Date.now();
      const key = entryKey(userId, connectionId, rootPath, request);
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= now) {
        entries.delete(key);
        rootKeys.get(rootBucket(userId, connectionId, rootPath))?.delete(key);
        return undefined;
      }
      entries.delete(key);
      entries.set(key, entry);
      return entry.result;
    },

    /** Successful inspection results land here; oversized payloads are skipped rather than evicting everything else. */
    put(userId: string, connectionId: string, rootPath: string, request: Record<string, unknown>, result: SshWorkspaceRpcResult) {
      if (JSON.stringify(result).length > MAX_CACHED_RESULT_BYTES) return;
      const now = Date.now();
      sweep(now);
      const bucket = rootBucket(userId, connectionId, rootPath);
      const keys = rootKeys.get(bucket) ?? new Set<string>();
      if (!rootKeys.has(bucket)) rootKeys.set(bucket, keys);
      if (keys.size >= MAX_ENTRIES_PER_ROOT) {
        for (const key of entries.keys()) {
          if (keys.has(key)) { entries.delete(key); keys.delete(key); break; }
        }
      }
      while (entries.size >= MAX_ENTRIES_TOTAL) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
        for (const set of rootKeys.values()) set.delete(oldest);
      }
      const key = bucket + '|' + createHash('sha256').update(JSON.stringify(request)).digest('hex');
      entries.set(key, { result, expiresAt: now + TTL_MS });
      keys.add(key);
    },

    /** Mutations, command execution and agent filesystem events all land here; dropping a bucket is always safe. */
    invalidateRoot(userId: string, connectionId: string, rootPath: string) {
      const keys = rootKeys.get(rootBucket(userId, connectionId, rootPath));
      if (!keys) return;
      for (const key of keys) entries.delete(key);
      rootKeys.delete(rootBucket(userId, connectionId, rootPath));
    },

    /** Tests observe capacity without touching private maps. */
    stats() {
      return { entries: entries.size, roots: rootKeys.size };
    },
  };
}

/** The default transport's shared cache; the events fan-out and mutation dispatch both invalidate it. */
export const sshWorkspaceReadCache = createSshWorkspaceReadCache();
