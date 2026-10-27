import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { agentWorkspaceConnectionsDb, closeConnection, getConnection, initializeDatabase } from '@/modules/database/index.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'agent-connections-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');
  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  try {
    await writeFile(databasePath, '');
    await initializeDatabase();
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('agent connection endpoints are account scoped and update in place', async () => {
  await withIsolatedDatabase(() => {
    const first = agentWorkspaceConnectionsDb.upsert('owner-1', 'desktop-a', 'Desktop A', 18765, 'a'.repeat(64));
    assert.equal(first.port, 18765);
    assert.equal(first.token, 'a'.repeat(64));
    agentWorkspaceConnectionsDb.upsert('owner-1', 'desktop-a', 'Desktop A2', 18766, 'b'.repeat(64));
    const rows = agentWorkspaceConnectionsDb.list('owner-1');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.name, 'Desktop A2');
    assert.equal(rows[0]?.port, 18766);
    assert.equal(rows[0]?.token, 'b'.repeat(64));
    assert.equal(agentWorkspaceConnectionsDb.list('owner-2').length, 0);
    assert.equal(agentWorkspaceConnectionsDb.remove('owner-2', 'desktop-a'), false);
    assert.equal(agentWorkspaceConnectionsDb.remove('owner-1', 'desktop-a'), true);
    assert.equal(agentWorkspaceConnectionsDb.list('owner-1').length, 0);
  });
});

test('identical desktop IDs never overwrite, delete, or disclose another owner endpoint', async () => {
  await withIsolatedDatabase(async () => {
    const first = agentWorkspaceConnectionsDb.upsert('owner-1', 'desktop-a', 'First', 18765, 'a'.repeat(64));
    const second = agentWorkspaceConnectionsDb.upsert('owner-2', 'desktop-a', 'Second', 18766, 'b'.repeat(64));
    agentWorkspaceConnectionsDb.upsert('owner-2', 'desktop-a', 'Second rotated', 18767, 'c'.repeat(64), 'relay');
    assert.deepEqual(agentWorkspaceConnectionsDb.get('owner-1', 'desktop-a'), first);
    assert.equal(agentWorkspaceConnectionsDb.get('owner-2', 'desktop-a')?.createdAt, second.createdAt);
    assert.equal(agentWorkspaceConnectionsDb.get('owner-2', 'desktop-a')?.token, 'c'.repeat(64));
    await initializeDatabase();
    assert.equal(agentWorkspaceConnectionsDb.get('owner-2', 'desktop-a')?.delivery, 'relay');
    assert.equal(agentWorkspaceConnectionsDb.remove('owner-2', 'desktop-a'), true);
    assert.deepEqual(agentWorkspaceConnectionsDb.get('owner-1', 'desktop-a'), first);
    assert.equal(agentWorkspaceConnectionsDb.get('owner-2', 'desktop-a'), null);
  });
});

for (const hasToken of [false, true]) {
  test(`legacy global ID migration preserves endpoints, timestamps and ${hasToken ? 'tokens' : 'missing token state'}`, async () => {
    await withIsolatedDatabase(async () => {
      const db = getConnection();
      db.exec(`DROP TABLE agent_workspace_connections;
        CREATE TABLE agent_workspace_connections (
          id TEXT PRIMARY KEY NOT NULL, owner_id TEXT NOT NULL, name TEXT NOT NULL,
          port INTEGER NOT NULL CHECK (port BETWEEN 1024 AND 65535), ${hasToken ? 'token TEXT,' : ''}
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX idx_agent_workspace_connections_owner ON agent_workspace_connections(owner_id, updated_at);`);
      db.prepare(`INSERT INTO agent_workspace_connections (id, owner_id, name, port, ${hasToken ? 'token,' : ''} created_at, updated_at)
        VALUES ('legacy', 'owner-1', 'Legacy desktop', 18765, ${hasToken ? '?,' : ''} '2026-01-01 00:00:00', '2026-02-02 00:00:00')`)
        .run(...(hasToken ? ['d'.repeat(64)] : []));
      await initializeDatabase();
      const expected = { id: 'legacy', ownerId: 'owner-1', name: 'Legacy desktop', port: 18765,
        token: hasToken ? 'd'.repeat(64) : null, delivery: 'direct', createdAt: '2026-01-01 00:00:00', updatedAt: '2026-02-02 00:00:00' };
      assert.deepEqual(agentWorkspaceConnectionsDb.get('owner-1', 'legacy'), expected);
      const key = (db.prepare('PRAGMA table_info(agent_workspace_connections)').all() as Array<{ name: string; pk: number }>)
        .filter(column => column.pk > 0).sort((left, right) => left.pk - right.pk).map(column => column.name);
      assert.deepEqual(key, ['owner_id', 'id']);
      agentWorkspaceConnectionsDb.upsert('owner-2', 'legacy', 'Other desktop', 18766, 'e'.repeat(64));
      await initializeDatabase();
      assert.deepEqual(agentWorkspaceConnectionsDb.get('owner-1', 'legacy'), expected);
      assert.equal(agentWorkspaceConnectionsDb.list('owner-2').length, 1);
      assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'agent_workspace_connections_legacy'").get(), undefined);
    });
  });
}
