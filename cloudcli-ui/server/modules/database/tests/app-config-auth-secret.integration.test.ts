import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { appConfigDb, closeConnection, getConnection, initializeDatabase } from '../index.js';

async function fixture(run: () => void) {
  const previous = process.env.DATABASE_PATH;
  const root = await mkdtemp(path.join(tmpdir(), 'auth-secret-db-'));
  closeConnection(); process.env.DATABASE_PATH = path.join(root, 'auth.db');
  try {
    await writeFile(process.env.DATABASE_PATH, '');
    await initializeDatabase();
    run();
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
}

test('the signing secret is initialized once and survives reopen without rewrite', async () => {
  await fixture(() => {
    const first = appConfigDb.getOrCreateJwtSecret();
    assert.match(first, /^[a-f0-9]{128}$/);
    getConnection().exec("CREATE TRIGGER forbid_secret_update BEFORE UPDATE ON app_config WHEN OLD.key='jwt_secret' BEGIN SELECT RAISE(ABORT, 'do not rotate'); END");
    assert.equal(appConfigDb.getOrCreateJwtSecret(), first);
    closeConnection();
    assert.equal(appConfigDb.getOrCreateJwtSecret(), first);
  });
});

test('stored malformed signing keys fail closed and are not silently replaced', async () => {
  await fixture(() => {
    for (const value of ['', 'short']) {
      appConfigDb.set('jwt_secret', value);
      assert.throws(() => appConfigDb.getOrCreateJwtSecret(), /unavailable or invalid/);
      assert.equal(appConfigDb.get('jwt_secret'), value);
    }
  });
});

test('a failed secret SELECT never triggers INSERT or key rotation', async () => {
  await fixture(() => {
    const expected = appConfigDb.getOrCreateJwtSecret();
    const db = getConnection();
    db.exec('ALTER TABLE app_config RENAME TO preserved_app_config');
    db.exec('CREATE VIEW app_config AS SELECT key, value FROM missing_auth_secret_source');
    assert.throws(() => appConfigDb.getOrCreateJwtSecret(), /no such table/);
    assert.equal((db.prepare("SELECT value FROM preserved_app_config WHERE key = 'jwt_secret'").get() as { value: string }).value, expected);
    db.exec('DROP VIEW app_config');
    db.exec('ALTER TABLE preserved_app_config RENAME TO app_config');
    closeConnection();
    assert.equal(appConfigDb.getOrCreateJwtSecret(), expected);
  });
});

test('read-only storage can read an existing key but cannot report an unpersisted key as success', async () => {
  await fixture(() => {
    const db = getConnection();
    db.exec('PRAGMA query_only = ON');
    assert.throws(() => appConfigDb.getOrCreateJwtSecret(), /readonly/);
    db.exec('PRAGMA query_only = OFF');
    assert.equal(appConfigDb.get('jwt_secret'), null);
    const expected = appConfigDb.getOrCreateJwtSecret();
    db.exec('PRAGMA query_only = ON');
    assert.equal(appConfigDb.getOrCreateJwtSecret(), expected);
    db.exec('PRAGMA query_only = OFF');
  });
});
