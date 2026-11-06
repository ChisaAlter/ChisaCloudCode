import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { closeConnection, getConnection, initializeDatabase, userPreferencesDb } from '@/modules/database/index.js';
import type { UserPreferenceTransaction, UserPreferenceTransactionResult } from '@/shared/index.js';

import { createUserRouter } from '../user.routes.js';
import { createUserService } from '../user.service.js';

function operationId(now = Date.now()): string {
  const timestamp = now.toString(16).padStart(12, '0');
  const entropy = randomBytes(10).toString('hex');
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7${entropy.slice(0, 3)}-8${entropy.slice(3, 6)}-${entropy.slice(6, 18)}`;
}

function transaction(updates: Record<string, unknown>, expectedRevisions: Record<string, number>, now?: number): UserPreferenceTransaction {
  return { operationId: operationId(now), updates, expectedRevisions };
}

async function withPreferenceServer(run: (base: string) => Promise<void>): Promise<void> {
  const previousPath = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'preference-cas-http-'));
  const databasePath = path.join(directory, 'auth.db');
  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await writeFile(databasePath, '');
  try {
    await initializeDatabase();
    getConnection().prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(7, 'http-user', 'hash');
    getConnection().prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(8, 'other-user', 'hash');
    const unexpected = (): never => { throw new Error('Unexpected unrelated user workflow'); };
    const service = createUserService({
      users: { getGitConfig: unexpected, updateGitConfig: unexpected, completeOnboarding: unexpected, hasCompletedOnboarding: unexpected },
      preferences: userPreferencesDb,
      drafts: {
        getDrafts: unexpected, saveDraft: unexpected, saveDraftText: unexpected,
        appendQueuedMessage: unexpected, clearQueuedMessage: unexpected, deleteDraft: unexpected,
      },
      readSystemGitConfig: unexpected, applyGlobalGitConfig: unexpected,
      logInfo: () => undefined, logError: () => undefined,
    });
    const app = express();
    app.use(express.json());
    // Auth is outside this task: this test supplies its already-authenticated request identity.
    app.use((req, _res, next) => {
      (req as express.Request & { user: { id: number } }).user = { id: 7 };
      next();
    });
    app.use('/api/user', createUserRouter(service));
    app.use((error: { code?: string; statusCode?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(error.statusCode ?? 500).json({ code: error.code ?? 'INTERNAL_ERROR' });
    });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address() as AddressInfo;
      await run(`http://127.0.0.1:${address.port}/api/user`);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  } finally {
    closeConnection();
    if (previousPath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
}

const patch = (base: string, body: unknown, suffix = '/preferences/transactions') => fetch(`${base}${suffix}`, {
  method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

test('real router and service expose CAS snapshots, merge touched acks, and leave other user rows alone', async () => {
  await withPreferenceServer(async (base) => {
    userPreferencesDb.savePreferences(8, { theme: 'other' });
    const empty = await fetch(`${base}/preferences`);
    assert.equal(empty.status, 200);
    assert.deepEqual(await empty.json(), { success: true, preferences: {}, revisions: {} });
    const first = transaction({ theme: 'dark', arbitrarySetting: { enabled: true } }, { theme: 0, arbitrarySetting: 0 });
    const firstResponse = await patch(base, first);
    assert.equal(firstResponse.status, 200);
    const firstAck = await firstResponse.json();
    assert.deepEqual(firstAck, { success: true, operationId: first.operationId, replayed: false, preferences: first.updates, revisions: { arbitrarySetting: 1, theme: 1 } });
    const independent = await patch(base, transaction({ tasksEnabled: false }, { tasksEnabled: 0 }));
    assert.equal(independent.status, 200);
    assert.deepEqual((await independent.json() as UserPreferenceTransactionResult).preferences, { tasksEnabled: false });
    const latest = await patch(base, transaction({ theme: 'light' }, { theme: 1 }));
    assert.equal(latest.status, 200);
    const replay = await patch(base, first);
    assert.deepEqual(await replay.json(), { ...firstAck, replayed: true });
    const snapshot = await fetch(`${base}/preferences`);
    assert.deepEqual(await snapshot.json(), {
      success: true, preferences: { theme: 'light', arbitrarySetting: { enabled: true }, tasksEnabled: false },
      revisions: { theme: 2, arbitrarySetting: 1, tasksEnabled: 1 },
    });
    assert.deepEqual(userPreferencesDb.getPreferences(8), { theme: 'other' });
  });
});

test('real router returns 409 current values/revisions and no partial write; changed duplicate stays 409', async () => {
  await withPreferenceServer(async (base) => {
    const delayed = transaction({ theme: 'old', unrelated: 'must not write' }, { theme: 0, unrelated: 0 });
    assert.equal((await patch(base, transaction({ theme: 'new' }, { theme: 0 }))).status, 200);
    closeConnection();
    getConnection().pragma('foreign_keys = ON');
    const response = await patch(base, delayed);
    assert.equal(response.status, 409);
    const conflict = await response.json();
    assert.deepEqual(conflict, {
      success: false, code: 'PREFERENCE_REVISION_CONFLICT', operationId: delayed.operationId,
      replayed: false, preferences: { theme: 'new' }, revisions: { theme: 1, unrelated: 0 },
    });
    const mismatch = await patch(base, { ...delayed, expectedRevisions: { theme: 1, unrelated: 0 } });
    assert.equal(mismatch.status, 409);
    assert.equal((await mismatch.json() as { code: string }).code, 'PREFERENCE_OPERATION_MISMATCH');
    assert.deepEqual(userPreferencesDb.getPreferences(7), { theme: 'new' });
  });
});

test('late legacy PATCH returns 410 without overwriting successful CAS values or advancing revisions', async () => {
  await withPreferenceServer(async (base) => {
    const delayed = transaction({ theme: 'stale' }, { theme: 0 });
    const current = transaction({ theme: 'current' }, { theme: 0 });
    assert.equal((await patch(base, current)).status, 200);
    const before = userPreferencesDb.getPreferenceSnapshot(7);
    const db = getConnection();
    const totalChanges = () => (db.prepare('SELECT total_changes() AS changes').get() as { changes: number }).changes;
    const changesBefore = totalChanges();
    const legacy = await patch(base, { theme: 'legacy', extensibleKey: [1, null] }, '/preferences');
    assert.equal(legacy.status, 410);
    assert.deepEqual(await legacy.json(), {
      success: false,
      code: 'PREFERENCE_TRANSACTION_REQUIRED',
      message: 'Upgrade the client. GET /api/user/preferences for current values and revisions, then PATCH /api/user/preferences/transactions with a UUIDv7 operationId, updates and matching expectedRevisions.',
    });
    assert.equal(totalChanges(), changesBefore, 'retired HTTP writes must not touch any SQLite table');
    assert.deepEqual(userPreferencesDb.getPreferenceSnapshot(7), before);
    assert.deepEqual(before, { preferences: { theme: 'current' }, revisions: { theme: 1 } });

    const stale = await patch(base, delayed);
    assert.equal(stale.status, 409);
    assert.deepEqual(await stale.json(), {
      success: false, code: 'PREFERENCE_REVISION_CONFLICT', operationId: delayed.operationId,
      replayed: false, preferences: { theme: 'current' }, revisions: { theme: 1 },
    });
    const valid = await patch(base, transaction({ theme: 'latest' }, { theme: 1 }));
    assert.equal(valid.status, 200, 'current revision remains usable after the rejected legacy request');
    const snapshot = await fetch(`${base}/preferences`);
    assert.equal(snapshot.status, 200);
    assert.deepEqual(await snapshot.json(), { success: true, preferences: { theme: 'latest' }, revisions: { theme: 2 } });
  });
});

test('router strictly rejects malformed envelopes, operation IDs, revision maps, keys, and size before writes', async () => {
  await withPreferenceServer(async (base) => {
    const valid = transaction({ theme: 'dark' }, { theme: 0 });
    const cases: Array<[unknown, number, string]> = [
      [{ ...valid, userId: 8 }, 400, 'INVALID_PREFERENCE_TRANSACTION'],
      [{ ...valid, extra: true }, 400, 'INVALID_PREFERENCE_TRANSACTION'],
      [{ operationId: valid.operationId, updates: valid.updates }, 400, 'INVALID_PREFERENCE_TRANSACTION'],
      [[], 400, 'INVALID_PREFERENCE_TRANSACTION'],
      [{ ...valid, operationId: 'bad' }, 400, 'INVALID_PREFERENCE_OPERATION_ID'],
      [{ ...valid, operationId: '11111111-2222-4333-8444-555555555555' }, 400, 'INVALID_PREFERENCE_OPERATION_ID'],
      [{ ...valid, operationId: operationId(Date.now() + 6 * 60_000) }, 400, 'INVALID_PREFERENCE_OPERATION_ID'],
      [{ ...valid, updates: [] }, 400, 'INVALID_PREFERENCES'],
      [{ ...valid, updates: {}, expectedRevisions: {} }, 400, 'INVALID_PREFERENCE_TRANSACTION'],
      [{ ...valid, expectedRevisions: [] }, 400, 'INVALID_PREFERENCE_REVISIONS'],
      [{ ...valid, expectedRevisions: {} }, 400, 'INVALID_PREFERENCE_REVISIONS'],
      [{ ...valid, expectedRevisions: { theme: -1 } }, 400, 'INVALID_PREFERENCE_REVISIONS'],
      [{ ...valid, expectedRevisions: { theme: 0.5 } }, 400, 'INVALID_PREFERENCE_REVISIONS'],
      [{ ...valid, expectedRevisions: { theme: Number.MAX_SAFE_INTEGER + 1 } }, 400, 'INVALID_PREFERENCE_REVISIONS'],
      [{ ...valid, expectedRevisions: { theme: 0, extra: 0 } }, 400, 'INVALID_PREFERENCE_REVISIONS'],
      [transaction({ ['k'.repeat(201)]: true }, { ['k'.repeat(201)]: 0 }), 400, 'INVALID_PREFERENCE_KEY'],
      [transaction({ huge: 'x'.repeat(65_536) }, { huge: 0 }), 413, 'PREFERENCE_TRANSACTION_TOO_LARGE'],
    ];
    for (const [body, status, code] of cases) {
      const response = await patch(base, body);
      assert.equal(response.status, status, JSON.stringify(body).slice(0, 200));
      assert.deepEqual(await response.json(), { code });
    }
    assert.deepEqual(userPreferencesDb.getPreferenceSnapshot(7), { preferences: {}, revisions: {} });
  });
});

test('router returns expiry conflict and capacity backpressure rather than accepting new writes', async () => {
  await withPreferenceServer(async (base) => {
    const expired = await patch(base, transaction({ theme: 'too late' }, { theme: 0 }, Date.now() - 24 * 60 * 60_000));
    assert.equal(expired.status, 409);
    assert.equal((await expired.json() as { code: string }).code, 'PREFERENCE_OPERATION_EXPIRED');
    const fill = getConnection().prepare(`
      INSERT INTO user_preference_operations (user_id, op_id, request_hash, ack_json, expires_at) VALUES (?, ?, ?, ?, ?)
    `);
    getConnection().transaction(() => {
      for (let index = 0; index < 1_024; index += 1) fill.run(7, `http-capacity-${index}`, 'hash', '{}', Date.now() + 24 * 60 * 60_000);
    })();
    const full = await patch(base, transaction({ theme: 'no capacity' }, { theme: 0 }));
    assert.equal(full.status, 429);
    assert.equal((await full.json() as { code: string }).code, 'PREFERENCE_OPERATION_CAPACITY');
    assert.deepEqual(userPreferencesDb.getPreferences(7), {});
  });
});

test('own prototype-like JSON keys round-trip safely through HTTP and snapshots', async () => {
  await withPreferenceServer(async (base) => {
    const input = transaction(JSON.parse('{"__proto__":{"polluted":true},"constructor":"value"}') as Record<string, unknown>,
      JSON.parse('{"__proto__":0,"constructor":0}') as Record<string, number>);
    const response = await patch(base, input);
    assert.equal(response.status, 200);
    const body = await response.json() as UserPreferenceTransactionResult;
    assert.equal(Object.hasOwn(body.preferences, '__proto__'), true);
    assert.deepEqual(body.preferences, input.updates);
    assert.equal(({} as { polluted?: unknown }).polluted, undefined);
  });
});
