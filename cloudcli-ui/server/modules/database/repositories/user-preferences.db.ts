import { createHash } from 'node:crypto';

import type { Database } from 'better-sqlite3';

import { getConnection } from '@/modules/database/connection.js';
import { AppError } from '@/shared/index.js';
import type {
  UserPreferenceSnapshot,
  UserPreferenceTransaction,
  UserPreferenceTransactionResult,
} from '@/shared/index.js';

type PreferenceRow = {
  key: string;
  preference_value: string | null;
  revision: number;
};

type OperationRow = {
  request_hash: string;
  ack_json: string;
};

const OPERATION_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const MAX_FUTURE_OPERATION_MS = 5 * 60 * 1_000;
const MAX_LIVE_OPERATIONS = 1_024;
const MAX_TRANSACTION_BYTES = 64 * 1_024;
const MAX_TRANSACTION_FIELDS = 128;

/** A single statement keeps values and revisions from different writers in one SQLite snapshot. */
function readSnapshot(db: Database, userId: number, keys?: string[]): UserPreferenceSnapshot {
  let rows: PreferenceRow[];
  if (keys) {
    const select = db.prepare(`
      SELECT ? AS key,
        (SELECT preference_value FROM user_preferences WHERE user_id = ? AND preference_key = ?) AS preference_value,
        COALESCE((SELECT revision FROM user_preference_versions WHERE user_id = ? AND key = ?), 0) AS revision
    `);
    rows = keys.map((key) => select.get(key, userId, key, userId, key) as PreferenceRow);
  } else {
    rows = db.prepare(`
      SELECT p.preference_key AS key, p.preference_value, COALESCE(v.revision, 0) AS revision
      FROM user_preferences p
      LEFT JOIN user_preference_versions v ON v.user_id = p.user_id AND v.key = p.preference_key
      WHERE p.user_id = ?
      UNION ALL
      SELECT v.key, NULL AS preference_value, v.revision
      FROM user_preference_versions v
      WHERE v.user_id = ? AND NOT EXISTS (
        SELECT 1 FROM user_preferences p WHERE p.user_id = v.user_id AND p.preference_key = v.key
      )
    `).all(userId, userId) as PreferenceRow[];
  }

  const values: Array<[string, unknown]> = [];
  for (const row of rows) {
    if (row.preference_value === null) continue;
    try {
      values.push([row.key, JSON.parse(row.preference_value) as unknown]);
    } catch {
      // Preserve the revision even if one damaged value cannot be decoded.
      console.warn(`[UserPreferences] Dropping unreadable value for "${row.key}"`);
    }
  }
  // fromEntries also preserves legitimate own keys such as "__proto__" without setters.
  return {
    preferences: Object.fromEntries(values),
    revisions: Object.fromEntries(rows.map((row) => [row.key, row.revision])),
  };
}

/** Canonical JSON treats object ordering as immaterial and refuses values HTTP JSON cannot carry. */
function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== 'object' || !value || ancestors.has(value)) {
    throw new AppError('Preference transactions require finite JSON values', {
      code: 'INVALID_PREFERENCE_TRANSACTION', statusCode: 400,
    });
  }
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype
    && Object.getPrototypeOf(value) !== null) {
    throw new AppError('Preference transactions require plain JSON objects', {
      code: 'INVALID_PREFERENCE_TRANSACTION', statusCode: 400,
    });
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${Array.from(value, (item) => canonicalJson(item, ancestors)).join(',')}]`;
    }
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(object[key], ancestors)}`
    )).join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

/** Checks repository invariants too: callers cannot bypass CAS by supplying missing/unsafe revisions. */
function prepareTransaction(transaction: UserPreferenceTransaction) {
  const { operationId, updates, expectedRevisions } = transaction;
  if (typeof operationId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId)) {
    throw new AppError('A UUIDv7 preference operation ID is required', {
      code: 'INVALID_PREFERENCE_OPERATION_ID', statusCode: 400,
    });
  }
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)
    || !expectedRevisions || typeof expectedRevisions !== 'object' || Array.isArray(expectedRevisions)) {
    throw new AppError('Updates and expected revisions must be objects', {
      code: 'INVALID_PREFERENCE_TRANSACTION', statusCode: 400,
    });
  }
  const keys = Object.keys(updates).sort();
  if (keys.length === 0 || keys.length > MAX_TRANSACTION_FIELDS) {
    throw new AppError('A preference transaction must contain 1-128 fields', {
      code: 'INVALID_PREFERENCE_TRANSACTION', statusCode: 400,
    });
  }
  if (keys.some((key) => !key || key.length > 200)) {
    throw new AppError('Preference keys must be 1-200 characters', {
      code: 'INVALID_PREFERENCE_KEY', statusCode: 400,
    });
  }
  if (Object.keys(expectedRevisions).length !== keys.length || keys.some((key) => (
    !Object.hasOwn(expectedRevisions, key)
    || !Number.isSafeInteger(expectedRevisions[key]) || expectedRevisions[key]! < 0
  ))) {
    throw new AppError('Expected revisions must match all updated fields and be nonnegative safe integers', {
      code: 'INVALID_PREFERENCE_REVISIONS', statusCode: 400,
    });
  }
  let payload: string;
  try {
    payload = canonicalJson({ updates, expectedRevisions });
  } catch (error) {
    if (error instanceof RangeError) {
      throw new AppError('Preference transaction nesting is too deep', {
        code: 'INVALID_PREFERENCE_TRANSACTION', statusCode: 400,
      });
    }
    throw error;
  }
  if (Buffer.byteLength(payload, 'utf8') > MAX_TRANSACTION_BYTES) {
    throw new AppError('Preference transaction exceeds 64 KiB', {
      code: 'PREFERENCE_TRANSACTION_TOO_LARGE', statusCode: 413,
    });
  }
  return {
    operationId: operationId.toLowerCase(),
    createdAt: Number.parseInt(operationId.replaceAll('-', '').slice(0, 12), 16),
    keys,
    requestHash: createHash('sha256').update(payload).digest('hex'),
    // Freeze the validated JSON values before entering the write transaction.
    ...JSON.parse(payload) as Pick<UserPreferenceTransaction, 'updates' | 'expectedRevisions'>,
  };
}

/** Writes values and revision tombstones together; every supplied key invalidates earlier CAS reads. */
function writePreferences(db: Database, userId: number, updates: Record<string, unknown>): void {
  const upsert = db.prepare(`
    INSERT INTO user_preferences (user_id, preference_key, preference_value, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id, preference_key) DO UPDATE SET
      preference_value = excluded.preference_value, updated_at = CURRENT_TIMESTAMP
  `);
  const remove = db.prepare('DELETE FROM user_preferences WHERE user_id = ? AND preference_key = ?');
  const increment = db.prepare(`
    INSERT INTO user_preference_versions (user_id, key, revision) VALUES (?, ?, 1)
    ON CONFLICT(user_id, key) DO UPDATE SET revision = revision + 1
  `);
  for (const [key, value] of Object.entries(updates)) {
    // The schema's integer/range CHECK fails closed on revision exhaustion and rolls back all fields.
    increment.run(userId, key);
    if (value === undefined) {
      remove.run(userId, key);
    } else {
      upsert.run(userId, key, JSON.stringify(value));
    }
  }
}

/** User persists settings through this repository; Providers reads the existing plain-value view. */
export const userPreferencesDb = {
  /** Existing repository consumers retain the plain values contract. */
  getPreferences(userId: number): Record<string, unknown> {
    return readSnapshot(getConnection(), userId).preferences;
  },

  /** User GET/legacy PATCH exposes values and durable revisions from one database snapshot. */
  getPreferenceSnapshot(userId: number): UserPreferenceSnapshot {
    return readSnapshot(getConnection(), userId);
  },

  /** Legacy merge-patch remains compatible, but invalidates all prior versioned reads of touched keys. */
  savePreferences(userId: number, updates: Record<string, unknown>): void {
    const db = getConnection();
    db.transaction(() => writePreferences(db, userId, updates)).immediate();
  },

  /** User's transaction endpoint commits all fields or none, with durable bounded replay protection. */
  savePreferenceTransaction(userId: number, transaction: UserPreferenceTransaction): UserPreferenceTransactionResult {
    const prepared = prepareTransaction(transaction);
    const db = getConnection();
    return db.transaction((): UserPreferenceTransactionResult => {
      const clock = db.prepare('SELECT observed_at FROM user_preference_cas_state WHERE user_id = ?')
        .get(userId) as { observed_at: number } | undefined;
      const now = Math.max(Date.now(), clock?.observed_at ?? 0);
      if (prepared.createdAt > now + MAX_FUTURE_OPERATION_MS) {
        throw new AppError('Preference operation ID is more than five minutes in the future', {
          code: 'INVALID_PREFERENCE_OPERATION_ID', statusCode: 400,
        });
      }
      db.prepare(`
        INSERT INTO user_preference_cas_state (user_id, observed_at) VALUES (?, ?)
        ON CONFLICT(user_id) DO UPDATE SET observed_at = excluded.observed_at
      `).run(userId, now);

      // IDs carry immutable time. After pruning, the persisted clock still refuses every expired ID.
      db.prepare('DELETE FROM user_preference_operations WHERE user_id = ? AND expires_at <= ?').run(userId, now);
      const current = readSnapshot(db, userId, prepared.keys);
      const failure = (code: Extract<UserPreferenceTransactionResult, { success: false }>['code']): UserPreferenceTransactionResult => ({
        success: false, operationId: prepared.operationId, replayed: false, code, ...current,
      });
      if (prepared.createdAt + OPERATION_LIFETIME_MS <= now) {
        return failure('PREFERENCE_OPERATION_EXPIRED');
      }
      const previous = db.prepare(`
        SELECT request_hash, ack_json FROM user_preference_operations WHERE user_id = ? AND op_id = ?
      `).get(userId, prepared.operationId) as OperationRow | undefined;
      if (previous) {
        if (previous.request_hash !== prepared.requestHash) return failure('PREFERENCE_OPERATION_MISMATCH');
        return { ...JSON.parse(previous.ack_json) as UserPreferenceTransactionResult, replayed: true };
      }
      const count = db.prepare('SELECT COUNT(*) AS count FROM user_preference_operations WHERE user_id = ?')
        .get(userId) as { count: number };
      if (count.count >= MAX_LIVE_OPERATIONS) return failure('PREFERENCE_OPERATION_CAPACITY');

      let result: UserPreferenceTransactionResult;
      if (prepared.keys.some((key) => current.revisions[key] !== prepared.expectedRevisions[key])) {
        result = failure('PREFERENCE_REVISION_CONFLICT');
      } else {
        writePreferences(db, userId, prepared.updates);
        result = {
          success: true, operationId: prepared.operationId, replayed: false,
          ...readSnapshot(db, userId, prepared.keys),
        };
      }
      db.prepare(`
        INSERT INTO user_preference_operations (user_id, op_id, request_hash, ack_json, expires_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(userId, prepared.operationId, prepared.requestHash, JSON.stringify(result), prepared.createdAt + OPERATION_LIFETIME_MS);
      return result;
    }).immediate();
  },
};
