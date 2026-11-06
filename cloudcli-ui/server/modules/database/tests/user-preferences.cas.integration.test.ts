import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  userPreferencesDb,
} from '@/modules/database/index.js';
import type { UserPreferenceTransaction, UserPreferenceTransactionResult } from '@/shared/index.js';

import { runMigrations } from '../migrations.js';

const DAY = 24 * 60 * 60 * 1_000;
const USER_ID = 1;

function operationId(now = Date.now()): string {
  const timestamp = now.toString(16).padStart(12, '0');
  const entropy = randomBytes(10).toString('hex');
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7${entropy.slice(0, 3)}-8${entropy.slice(3, 6)}-${entropy.slice(6, 18)}`;
}

function transaction(updates: Record<string, unknown>, expectedRevisions: Record<string, number>, now?: number): UserPreferenceTransaction {
  return { operationId: operationId(now), updates, expectedRevisions };
}

async function withDatabase(run: (directory: string, databasePath: string) => void | Promise<void>): Promise<void> {
  const previousPath = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'preference-cas-'));
  const databasePath = path.join(directory, 'auth.db');
  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await writeFile(databasePath, '');
  try {
    await initializeDatabase();
    getConnection().prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(USER_ID, 'cas-user', 'hash');
    await run(directory, databasePath);
  } finally {
    closeConnection();
    if (previousPath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
}

function count(table: string): number {
  return (getConnection().prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

test('additive migration preserves existing values at revision zero and is safe to repeat', async () => {
  await withDatabase(() => {
    getConnection().exec('DROP TABLE user_preference_operations; DROP TABLE user_preference_versions; DROP TABLE user_preference_cas_state');
    getConnection().prepare('INSERT INTO user_preferences (user_id, preference_key, preference_value) VALUES (?, ?, ?)')
      .run(USER_ID, 'existing', JSON.stringify('kept'));
    runMigrations(getConnection());
    runMigrations(getConnection());
    assert.deepEqual(userPreferencesDb.getPreferenceSnapshot(USER_ID), { preferences: { existing: 'kept' }, revisions: { existing: 0 } });
    assert.equal(userPreferencesDb.savePreferenceTransaction(USER_ID, transaction({ existing: 'updated' }, { existing: 0 })).success, true);
    assert.deepEqual(userPreferencesDb.getPreferenceSnapshot(USER_ID), { preferences: { existing: 'updated' }, revisions: { existing: 1 } });
  });
});

test('CAS normal path increments all supplied fields and replays canonical JSON without another write', async () => {
  await withDatabase(() => {
    const input = transaction({ theme: 'dark', nested: { a: 1, b: [true, null] } }, { theme: 0, nested: 0 });
    const result = userPreferencesDb.savePreferenceTransaction(USER_ID, input);
    assert.deepEqual(result, {
      success: true, operationId: input.operationId, replayed: false,
      preferences: input.updates, revisions: { nested: 1, theme: 1 },
    });
    const reordered = {
      ...input, operationId: input.operationId.toUpperCase(),
      updates: { nested: { b: [true, null], a: 1 }, theme: 'dark' }, expectedRevisions: { nested: 0, theme: 0 },
    };
    assert.deepEqual(userPreferencesDb.savePreferenceTransaction(USER_ID, reordered), { ...result, replayed: true });
    assert.deepEqual(userPreferencesDb.getPreferenceSnapshot(USER_ID), {
      preferences: input.updates, revisions: { nested: 1, theme: 1 },
    });
    assert.equal(count('user_preference_operations'), 1);
  });
});

test('CAS mismatch rolls back every field and journals the rejected operation', async () => {
  await withDatabase(() => {
    userPreferencesDb.savePreferences(USER_ID, { theme: 'new' });
    const stale = transaction({ theme: 'old', untouched: true }, { theme: 0, untouched: 0 });
    const result = userPreferencesDb.savePreferenceTransaction(USER_ID, stale);
    assert.deepEqual(result, {
      success: false, code: 'PREFERENCE_REVISION_CONFLICT', operationId: stale.operationId, replayed: false,
      preferences: { theme: 'new' }, revisions: { theme: 1, untouched: 0 },
    });
    assert.deepEqual(userPreferencesDb.getPreferenceSnapshot(USER_ID), { preferences: { theme: 'new' }, revisions: { theme: 1 } });
    assert.deepEqual(userPreferencesDb.savePreferenceTransaction(USER_ID, stale), { ...result, replayed: true });
    const changed = userPreferencesDb.savePreferenceTransaction(USER_ID, { ...stale, expectedRevisions: { theme: 1, untouched: 0 } });
    assert.equal(changed.success, false);
    assert.equal('code' in changed && changed.code, 'PREFERENCE_OPERATION_MISMATCH');
  });
});

test('SQL failure after the first field rolls back values, revisions, clock and journal', async () => {
  await withDatabase(() => {
    getConnection().exec(`
      CREATE TRIGGER reject_cas_second BEFORE INSERT ON user_preferences WHEN NEW.preference_key = 'second'
      BEGIN SELECT RAISE(ABORT, 'deliberate CAS failure'); END
    `);
    const input = transaction({ first: true, second: true }, { first: 0, second: 0 });
    assert.throws(() => userPreferencesDb.savePreferenceTransaction(USER_ID, input), /deliberate CAS failure/);
    assert.deepEqual(userPreferencesDb.getPreferenceSnapshot(USER_ID), { preferences: {}, revisions: {} });
    assert.equal(count('user_preference_operations'), 0);
    assert.equal(count('user_preference_cas_state'), 0);
    getConnection().exec('DROP TRIGGER reject_cas_second');
    assert.equal(userPreferencesDb.savePreferenceTransaction(USER_ID, input).success, true, 'an actual rollback may safely retry');
  });
});

test('delayed stale payload and historical acknowledgement cannot write over a later commit after restart', async () => {
  await withDatabase(() => {
    const first = transaction({ theme: 'first' }, { theme: 0 });
    const delayed = transaction({ theme: 'delayed-old' }, { theme: 0 });
    const firstAck = userPreferencesDb.savePreferenceTransaction(USER_ID, first);
    const latest = transaction({ theme: 'latest' }, { theme: 1 });
    assert.equal(userPreferencesDb.savePreferenceTransaction(USER_ID, latest).success, true);
    closeConnection();
    // Reopen an entirely new SQLite connection; no process-local revision state is available.
    getConnection().pragma('foreign_keys = ON');
    const staleAck = userPreferencesDb.savePreferenceTransaction(USER_ID, delayed);
    assert.equal('code' in staleAck && staleAck.code, 'PREFERENCE_REVISION_CONFLICT');
    assert.deepEqual(userPreferencesDb.savePreferenceTransaction(USER_ID, first), { ...firstAck, replayed: true });
    assert.deepEqual(userPreferencesDb.getPreferenceSnapshot(USER_ID), { preferences: { theme: 'latest' }, revisions: { theme: 2 } });
  });
});

test('legacy equal writes and deletes advance durable revisions and invalidate old versioned requests', async () => {
  await withDatabase(() => {
    userPreferencesDb.savePreferences(USER_ID, { theme: 'dark' });
    const beforeLegacy = transaction({ theme: 'stale' }, { theme: 1 });
    userPreferencesDb.savePreferences(USER_ID, { theme: 'dark' });
    const stale = userPreferencesDb.savePreferenceTransaction(USER_ID, beforeLegacy);
    assert.equal('code' in stale && stale.code, 'PREFERENCE_REVISION_CONFLICT');
    userPreferencesDb.savePreferences(USER_ID, { theme: undefined });
    assert.deepEqual(userPreferencesDb.getPreferenceSnapshot(USER_ID), { preferences: {}, revisions: { theme: 3 } });
    const absentStale = userPreferencesDb.savePreferenceTransaction(USER_ID, transaction({ theme: 'resurrected' }, { theme: 0 }));
    assert.equal('code' in absentStale && absentStale.code, 'PREFERENCE_REVISION_CONFLICT');
    assert.equal(userPreferencesDb.savePreferenceTransaction(USER_ID, transaction({ theme: 'fresh' }, { theme: 3 })).success, true);
  });
});

test('expired journal pruning never treats an old operation as fresh, even after restart and clock rollback', async () => {
  await withDatabase(() => {
    const originalNow = Date.now;
    const start = originalNow();
    const accepted = transaction({ theme: 'before' }, { theme: 0 }, start);
    const neverArrived = transaction({ newKey: 'late' }, { newKey: 0 }, start);
    try {
      Date.now = () => start;
      assert.equal(userPreferencesDb.savePreferenceTransaction(USER_ID, accepted).success, true);
      Date.now = () => start + DAY + 1;
      const expired = userPreferencesDb.savePreferenceTransaction(USER_ID, accepted);
      assert.equal('code' in expired && expired.code, 'PREFERENCE_OPERATION_EXPIRED');
      assert.equal(count('user_preference_operations'), 0);
      closeConnection();
      Date.now = () => start;
      const expiredLate = userPreferencesDb.savePreferenceTransaction(USER_ID, neverArrived);
      assert.equal('code' in expiredLate && expiredLate.code, 'PREFERENCE_OPERATION_EXPIRED');
      assert.deepEqual(userPreferencesDb.getPreferenceSnapshot(USER_ID), { preferences: { theme: 'before' }, revisions: { theme: 1 } });
      assert.throws(() => userPreferencesDb.savePreferenceTransaction(USER_ID, transaction({ x: 1 }, { x: 0 }, start + DAY + 6 * 60_000)), /future/);
    } finally {
      Date.now = originalNow;
    }
  });
});

test('live journal saturation refuses admission, keeps live acks, and expired entries make space', async () => {
  await withDatabase(() => {
    const originalNow = Date.now;
    const start = originalNow();
    try {
      Date.now = () => start;
      const first = transaction({ theme: 'kept' }, { theme: 0 }, start);
      assert.equal(userPreferencesDb.savePreferenceTransaction(USER_ID, first).success, true);
      const fill = getConnection().prepare(`
        INSERT INTO user_preference_operations (user_id, op_id, request_hash, ack_json, expires_at) VALUES (?, ?, ?, ?, ?)
      `);
      getConnection().transaction(() => {
        for (let index = 1; index < 1_024; index += 1) fill.run(USER_ID, `capacity-fixture-${index}`, 'hash', '{}', start + DAY);
      })();
      const blocked = userPreferencesDb.savePreferenceTransaction(USER_ID, transaction({ other: true }, { other: 0 }, start));
      assert.equal('code' in blocked && blocked.code, 'PREFERENCE_OPERATION_CAPACITY');
      assert.equal(count('user_preference_operations'), 1_024);
      assert.equal(userPreferencesDb.savePreferenceTransaction(USER_ID, first).replayed, true, 'live duplicate remains replayable even at capacity');
      Date.now = () => start + DAY + 1;
      assert.equal(userPreferencesDb.savePreferenceTransaction(USER_ID, transaction({ other: true }, { other: 0 }, Date.now())).success, true);
      assert.equal(count('user_preference_operations'), 1);
    } finally {
      Date.now = originalNow;
    }
  });
});

test('operations and revisions are user scoped and all CAS state cascades when a user is removed', async () => {
  await withDatabase(() => {
    getConnection().prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(2, 'other-user', 'hash');
    const input = transaction({ theme: 'one' }, { theme: 0 });
    assert.equal(userPreferencesDb.savePreferenceTransaction(USER_ID, input).success, true);
    assert.equal(userPreferencesDb.savePreferenceTransaction(2, { ...input, updates: { theme: 'two' } }).success, true);
    assert.deepEqual(userPreferencesDb.getPreferences(USER_ID), { theme: 'one' });
    assert.deepEqual(userPreferencesDb.getPreferences(2), { theme: 'two' });
    getConnection().prepare('DELETE FROM users WHERE id = ?').run(USER_ID);
    for (const table of ['user_preferences', 'user_preference_versions', 'user_preference_operations', 'user_preference_cas_state']) {
      assert.equal(count(table), 1, `${table} contains only the other user's row`);
    }
  });
});

test('repository rejects unsafe revisions/non-JSON/oversize input before changing preferences', async () => {
  await withDatabase(() => {
    const invalidRevisions: Array<Record<string, number>> = [{}, { theme: -1 }, { theme: 0.5 }, { theme: Number.MAX_SAFE_INTEGER + 1 }, { theme: 0, extra: 0 }];
    for (const revisions of invalidRevisions) {
      assert.throws(() => userPreferencesDb.savePreferenceTransaction(USER_ID, transaction({ theme: 'x' }, revisions)), /revisions/);
    }
    for (const value of [undefined, Number.NaN, Number.POSITIVE_INFINITY, 1n, new Date()]) {
      assert.throws(() => userPreferencesDb.savePreferenceTransaction(USER_ID, transaction({ value }, { value: 0 })), /JSON/);
    }
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    assert.throws(() => userPreferencesDb.savePreferenceTransaction(USER_ID, transaction({ cyclic }, { cyclic: 0 })), /JSON/);
    assert.throws(() => userPreferencesDb.savePreferenceTransaction(USER_ID, transaction({ huge: 'x'.repeat(65_536) }, { huge: 0 })), /64 KiB/);
    assert.deepEqual(userPreferencesDb.getPreferenceSnapshot(USER_ID), { preferences: {}, revisions: {} });
  });
});

test('safe integer revision exhaustion rolls back the entire transaction instead of losing precision', async () => {
  await withDatabase(() => {
    getConnection().prepare('INSERT INTO user_preference_versions (user_id, key, revision) VALUES (?, ?, ?)')
      .run(USER_ID, 'second', Number.MAX_SAFE_INTEGER);
    const input = transaction({ first: 'no', second: 'no' }, { first: 0, second: Number.MAX_SAFE_INTEGER });
    assert.throws(() => userPreferencesDb.savePreferenceTransaction(USER_ID, input), /CHECK constraint/);
    assert.deepEqual(userPreferencesDb.getPreferenceSnapshot(USER_ID), { preferences: {}, revisions: { second: Number.MAX_SAFE_INTEGER } });
    assert.equal(count('user_preference_operations'), 0);
  });
});

test('real independent SQLite writer processes race: exactly one compare-and-swap commits', async () => {
  await withDatabase(async (directory, databasePath) => {
    const gatePath = path.join(directory, 'gate');
    const workerPath = fileURLToPath(new URL('./user-preferences.cas-writer.ts', import.meta.url));
    const first = transaction({ theme: 'writer-a', companion: 'a' }, { theme: 0, companion: 0 });
    const second = transaction({ theme: 'writer-b', companion: 'b' }, { theme: 0, companion: 0 });
    const runWriter = (input: UserPreferenceTransaction, name: string) => {
      const resultPath = path.join(directory, name);
      const child = spawn(process.execPath, ['--import', 'tsx', workerPath, gatePath, resultPath, JSON.stringify(input)], {
        cwd: process.cwd(), env: { ...process.env, DATABASE_PATH: databasePath, TSX_TSCONFIG_PATH: path.resolve('server/tsconfig.json') }, stdio: 'inherit',
      });
      return new Promise<UserPreferenceTransactionResult>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => {
          if (code !== 0) { reject(new Error(`CAS writer exited ${code}`)); return; }
          readFile(resultPath, 'utf8').then((text) => resolve(JSON.parse(text) as UserPreferenceTransactionResult), reject);
        });
      });
    };
    const results = [runWriter(first, 'a.json'), runWriter(second, 'b.json')];
    await writeFile(gatePath, 'go');
    const settled = await Promise.allSettled(results);
    for (const result of settled) if (result.status === 'rejected') throw result.reason;
    const acks = settled.map((result) => (result as PromiseFulfilledResult<UserPreferenceTransactionResult>).value);
    assert.equal(acks.filter((result) => result.success).length, 1);
    assert.equal(acks.filter((result) => !result.success && result.code === 'PREFERENCE_REVISION_CONFLICT').length, 1);
    const winner = acks.find((result) => result.success)!;
    assert.deepEqual(userPreferencesDb.getPreferenceSnapshot(USER_ID), { preferences: winner.preferences, revisions: { companion: 1, theme: 1 } });
    assert.equal(count('user_preference_operations'), 2);
  });
});
