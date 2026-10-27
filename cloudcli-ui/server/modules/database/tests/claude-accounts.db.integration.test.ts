import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  claudeAccountsDb,
  closeConnection,
  getConnection,
  initializeDatabase,
  userDb,
} from '@/modules/database/index.js';
import type { ClaudeAccountRecord } from '@/shared/types.js';

async function withIsolatedDatabase(run: () => void | Promise<void>): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(tmpdir(), 'claude-accounts-db-'));
  const database = path.join(directory, 'fixture.db');
  closeConnection();
  process.env.DATABASE_PATH = database;
  try {
    await writeFile(database, '');
    await initializeDatabase();
    await run();
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

test('subscription metadata and selections remain owner scoped across initialization and deletion', async () => {
  await withIsolatedDatabase(async () => {
    const first = Number(userDb.createUser('first-owner', 'fixture-hash').id);
    const second = Number(userDb.createUser('second-owner', 'fixture-hash').id);
    const disabled = Number(userDb.createUser('disabled-owner', 'fixture-hash').id);
    getConnection().prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(disabled);
    assert.deepEqual(userDb.getActiveUserIds(), [String(first), String(second)]);

    const account: ClaudeAccountRecord = {
      id: 'shared-account-id',
      name: 'First subscription',
      email: 'first@example.test',
      organizationUuid: 'first-org',
      organizationName: 'First organization',
      plan: 'pro',
      createdAt: 10,
      updatedAt: 20,
    };
    const other: ClaudeAccountRecord = { ...account, name: 'Second subscription', email: 'second@example.test', organizationUuid: 'second-org' };
    claudeAccountsDb.save(first, account);
    claudeAccountsDb.save(second, other);
    claudeAccountsDb.activate(first, account.id);
    claudeAccountsDb.activate(second, other.id);
    claudeAccountsDb.save(first, { ...account, name: 'Renamed subscription', createdAt: 99, updatedAt: 30 });

    closeConnection();
    await initializeDatabase();
    const updated = { ...account, name: 'Renamed subscription', updatedAt: 30 };
    assert.deepEqual(claudeAccountsDb.get(first, account.id), updated);
    assert.deepEqual(claudeAccountsDb.list(first), [updated]);
    assert.deepEqual(claudeAccountsDb.get(second, account.id), other);
    assert.equal(claudeAccountsDb.activeId(first), account.id);
    assert.equal(claudeAccountsDb.activeId(second), other.id);
    assert.deepEqual(claudeAccountsDb.listAll(), [
      { userId: first, ...updated },
      { userId: second, ...other },
    ]);

    claudeAccountsDb.delete(first, account.id);
    assert.equal(claudeAccountsDb.get(first, account.id), null);
    assert.equal(claudeAccountsDb.activeId(first), null);
    assert.deepEqual(claudeAccountsDb.get(second, account.id), other);
    assert.equal(claudeAccountsDb.activeId(second), other.id);
    claudeAccountsDb.activate(second, null);
    assert.equal(claudeAccountsDb.activeId(second), null);
    claudeAccountsDb.activate(second, other.id);
    getConnection().prepare('DELETE FROM users WHERE id = ?').run(second);
    assert.deepEqual(claudeAccountsDb.listAll(), []);
    assert.equal(claudeAccountsDb.activeId(second), null);
  });
});
