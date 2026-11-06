import { createHash } from 'node:crypto';

import { AppError } from '@/shared/index.js';

/** Auth composition owns one process-wide guard; tests inject a clock/budgets to exercise bounded admission without sleeps. */
export function createLoginGuard(options: {
  now?: () => number; windowMs?: number; accountLimit?: number; sourceLimit?: number; concurrency?: number; maxKeys?: number;
} = {}) {
  const now = options.now ?? Date.now;
  const windowMs = options.windowMs ?? 15 * 60 * 1000;
  const accountLimit = options.accountLimit ?? 10;
  const sourceLimit = options.sourceLimit ?? 60;
  const concurrency = options.concurrency ?? 4;
  const maxKeys = options.maxKeys ?? 10000;
  if ([windowMs, accountLimit, sourceLimit, concurrency, maxKeys].some(value => !Number.isSafeInteger(value) || value <= 0)) {
    throw new Error('Invalid login admission configuration');
  }
  const buckets = new Map<string, { count: number; expiresAt: number }>();
  let running = 0;
  let nextSweep = 0;

  function limited(retryAfterSeconds: number): never {
    throw new AppError('Too many login attempts. Try again later.', {
      statusCode: 429, code: 'AUTH_LOGIN_RATE_LIMITED', details: { retryAfterSeconds },
    });
  }

  return {
    async run<T>(username: string, socketSource: string, compareAndIssue: () => Promise<T>): Promise<T> {
      const instant = now();
      if (instant >= nextSweep || buckets.size + 2 > maxKeys) {
        for (const [key, bucket] of buckets) if (bucket.expiresAt <= instant) buckets.delete(key);
        nextSweep = instant + windowMs;
      }
      // Account and source keys stay bounded and reveal neither usernames nor addresses in diagnostics.
      const keys = [
        `account:${createHash('sha256').update(username).digest('hex')}`,
        `source:${createHash('sha256').update(socketSource || 'unknown').digest('hex')}`,
      ];
      const limits = [accountLimit, sourceLimit];
      const entries = keys.map(key => {
        const old = buckets.get(key);
        return old && old.expiresAt > instant ? old : { count: 0, expiresAt: instant + windowMs };
      });
      for (let index = 0; index < keys.length; index += 1) {
        if (entries[index]!.count >= limits[index]!) limited(Math.max(1, Math.ceil((entries[index]!.expiresAt - instant) / 1000)));
      }
      if (buckets.size + keys.filter(key => !buckets.has(key)).length > maxKeys) limited(Math.ceil(windowMs / 1000));
      for (let index = 0; index < keys.length; index += 1) {
        entries[index]!.count += 1;
        buckets.set(keys[index]!, entries[index]!);
      }
      if (running >= concurrency) throw new AppError('Login verification is busy. Try again shortly.', {
        statusCode: 503, code: 'AUTH_LOGIN_BUSY', details: { retryAfterSeconds: 1 },
      });
      running += 1;
      try { return await compareAndIssue(); } finally { running -= 1; }
    },
  };
}
