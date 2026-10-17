// Simple in-memory TTL cache

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class Cache<T> {
  private store = new Map<string, CacheEntry<T>>();

  get(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  set(key: string, value: T, ttlMs: number): void {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  deletePrefix(prefix: string): void {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) this.store.delete(key);
    }
  }

  clear(): void {
    this.store.clear();
  }
}

// Shared global cache instance
export const globalCache = new Cache<unknown>();

export function cacheGet(key: string): unknown {
  return globalCache.get(key);
}

export function cacheSet(key: string, value: unknown, ttlMs: number): void {
  globalCache.set(key, value, ttlMs);
}

export function cacheDelete(key: string): void {
  globalCache.delete(key);
}

export function cacheDeletePrefix(prefix: string): void {
  globalCache.deletePrefix(prefix);
}
