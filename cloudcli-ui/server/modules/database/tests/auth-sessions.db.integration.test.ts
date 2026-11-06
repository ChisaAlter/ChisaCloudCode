import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { authSessionsDb, closeConnection, getConnection, initializeDatabase, userDb } from '../index.js';

async function fixture(run: () => Promise<void> | void, oldSchema = false) {
  const previous = process.env.DATABASE_PATH;
  const root = await mkdtemp(path.join(tmpdir(), 'auth-session-db-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  try {
    await writeFile(process.env.DATABASE_PATH, '');
    if (oldSchema) getConnection().exec(`CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, last_login DATETIME, is_active BOOLEAN DEFAULT 1,
      git_name TEXT, git_email TEXT, has_completed_onboarding BOOLEAN DEFAULT 0)`);
    await initializeDatabase();
    await run();
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
}

function account(name = 'alice') {
  userDb.createUser(name, 'hash');
  const user = userDb.getUserByUsername(name);
  assert.ok(user);
  return user;
}

test('first boot and old-schema migration install versioning idempotently', async () => {
  for (const oldSchema of [false, true]) await fixture(async () => {
    const user = account();
    assert.equal(user.auth_version, 0);
    await initializeDatabase(); await initializeDatabase();
    assert.equal(authSessionsDb.getUserAuthState(user.id)?.sessionVersion, 0);
    const proof = { id: randomUUID(), userId: user.id, version: 0, createdAt: 1000, expiresAt: 2000, expectedPasswordHash: 'hash' };
    assert.ok(authSessionsDb.createSession(proof));
    getConnection().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run('hash2', user.id);
    assert.equal(authSessionsDb.getUserAuthState(user.id)?.sessionVersion, 1);
    assert.notEqual(authSessionsDb.getSession(proof.id)?.revokedAt, null);
    // Writing the same values and rerunning startup must not revoke newly issued proof.
    const next = { ...proof, id: randomUUID(), version: 1, expectedPasswordHash: 'hash2' };
    assert.ok(authSessionsDb.createSession(next));
    getConnection().prepare('UPDATE users SET password_hash = ?, is_active = 1 WHERE id = ?').run('hash2', user.id);
    await initializeDatabase();
    assert.equal(authSessionsDb.getUserAuthState(user.id)?.sessionVersion, 1);
    assert.equal(authSessionsDb.getSession(next.id)?.revokedAt, null);
  }, oldSchema);
});

test('CAS refuses stale hash/version and deactivation/re-enable cannot resurrect sessions', async () => {
  await fixture(() => {
    const user = account();
    const proof = { id: randomUUID(), userId: user.id, version: 0, createdAt: 1000, expiresAt: 2000 };
    assert.equal(authSessionsDb.createSession({ ...proof, expectedPasswordHash: 'wrong' }), undefined);
    assert.equal(authSessionsDb.createSession({ ...proof, version: 1, expectedPasswordHash: 'hash' }), undefined);
    assert.ok(authSessionsDb.createSession({ ...proof, expectedPasswordHash: 'hash' }));
    getConnection().prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(user.id);
    assert.equal(authSessionsDb.getUserAuthState(user.id)?.isActive, false);
    assert.equal(authSessionsDb.createSession({ ...proof, id: randomUUID(), version: 1 }), undefined);
    getConnection().prepare('UPDATE users SET is_active = 1 WHERE id = ?').run(user.id);
    assert.equal(authSessionsDb.getUserAuthState(user.id)?.sessionVersion, 2);
    assert.notEqual(authSessionsDb.getSession(proof.id)?.revokedAt, null);
    assert.equal(authSessionsDb.createSession({ ...proof, id: randomUUID(), expectedPasswordHash: 'hash' }), undefined);
  });
});

test('session revoke survives reopen and owner mismatches cannot revoke or replace proof', async () => {
  await fixture(() => {
    const alice = account(); const bob = account('bob');
    const proof = { id: randomUUID(), userId: alice.id, version: 0, createdAt: 1000, expiresAt: 2000 };
    assert.ok(authSessionsDb.createSession(proof));
    authSessionsDb.revokeSession(proof.id, bob.id, 1500);
    assert.equal(authSessionsDb.getSession(proof.id)?.revokedAt, null);
    assert.equal(authSessionsDb.createSession({ ...proof, userId: bob.id }), undefined);
    authSessionsDb.revokeSession(proof.id, alice.id, 1500);
    closeConnection();
    assert.equal(authSessionsDb.getSession(proof.id)?.revokedAt, 1500);
    assert.equal(authSessionsDb.createSession(proof)?.revokedAt, 1500);
    authSessionsDb.revokeUserSessions(alice.id, 1600);
    assert.equal(authSessionsDb.getUserAuthState(alice.id)?.sessionVersion, 1);
  });
});

test('legacy activation and deadline persist and cannot move later across reopen', async () => {
  await fixture(() => {
    assert.equal(authSessionsDb.legacyWindow(1000, 1000 + 7 * 86400 + 1), undefined);
    assert.deepEqual(authSessionsDb.legacyWindow(1000, 2000), { enabledAt: 1000, cutoff: 2000 });
    closeConnection();
    assert.deepEqual(authSessionsDb.legacyWindow(1100, 3000), { enabledAt: 1000, cutoff: 2000 });
    assert.deepEqual(authSessionsDb.legacyWindow(1200, 1800), { enabledAt: 1000, cutoff: 1800 });
    assert.equal(authSessionsDb.legacyWindow(1300, 1250), undefined);
    closeConnection();
    assert.equal(authSessionsDb.legacyWindow(1400, 4000), undefined);
  });
});
