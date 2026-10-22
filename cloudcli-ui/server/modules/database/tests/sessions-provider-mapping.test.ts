import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'sessions-mapping-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  // Precreate an empty fixture: initialization must never import user profile
  // contents or write anything outside this disposable directory.
  await writeFile(databasePath, '');
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('dedicated provider profile registration survives restart and transcript rescans', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('managed-app', 'opencode', '/source');
    sessionsDb.setProviderProfilePath('managed-app', '/private/managed/profile');
    sessionsDb.assignProviderSessionId('managed-app', 'managed-native');
    sessionsDb.createSession('managed-native', 'opencode', '/execution', 'native', undefined, undefined, null);
    closeConnection();
    await initializeDatabase();
    const row = sessionsDb.getSessionById('managed-app');
    assert.equal(row?.provider_profile_path, '/private/managed/profile');
    assert.equal(row?.project_path, path.normalize('/source'));
    assert.equal(row?.jsonl_path, null, 'Shared provider databases are never deletable transcript paths');
  });
});

test('disk-discovered sessions are keyed by the provider id for both columns', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('provider-abc', 'claude', '/workspace/demo', 'From Disk');

    const row = sessionsDb.getSessionById('provider-abc');
    assert.equal(row?.session_id, 'provider-abc');
    assert.equal(row?.provider_session_id, 'provider-abc');

    const byProviderId = sessionsDb.getSessionByProviderSessionId('provider-abc');
    assert.equal(byProviderId?.session_id, 'provider-abc');
  });
});

test('restarting the database preserves unstarted and detached app sessions', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-unstarted', 'claude', '/workspace/demo');
    sessionsDb.createAppSession('app-detached', 'claude', '/workspace/demo');
    sessionsDb.assignProviderSessionId('app-detached', 'provider-before-edit');
    sessionsDb.detachProviderSession('app-detached');
    sessionsDb.createSession('provider-existing', 'claude', '/workspace/demo');

    closeConnection();
    await initializeDatabase();

    assert.equal(sessionsDb.getSessionById('app-unstarted')?.provider_session_id, null);
    assert.equal(sessionsDb.getSessionById('app-detached')?.provider_session_id, null);
    assert.equal(sessionsDb.getSessionById('provider-existing')?.provider_session_id, 'provider-existing');
  });
});

test('databases without the mapping column still backfill legacy provider ids', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('provider-legacy', 'claude', '/workspace/demo');
    getConnection().exec('DROP INDEX idx_sessions_provider_session_id');
    getConnection().exec('ALTER TABLE sessions DROP COLUMN provider_session_id');

    closeConnection();
    await initializeDatabase();

    assert.equal(sessionsDb.getSessionById('provider-legacy')?.provider_session_id, 'provider-legacy');
  });
});

test('app sessions get the provider id assigned without creating a duplicate row', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-id-1', 'claude', '/workspace/demo', 'Initial CloudCLI message');
    sessionsDb.assignProviderSessionId('app-id-1', 'provider-xyz');

    // A later synchronizer pass that discovers the transcript on disk must
    // update the app row in place instead of inserting a provider-keyed row.
    const returnedId = sessionsDb.createSession(
      'provider-xyz',
      'claude',
      '/workspace/demo',
      'Synced Name',
      undefined,
      undefined,
      '/fake/path/provider-xyz.jsonl',
    );

    assert.equal(returnedId, 'app-id-1');
    assert.equal(sessionsDb.getAllSessions().length, 1);

    const row = sessionsDb.getSessionById('app-id-1');
    assert.equal(row?.provider_session_id, 'provider-xyz');
    assert.equal(row?.jsonl_path, '/fake/path/provider-xyz.jsonl');
    assert.equal(row?.custom_name, 'Initial CloudCLI message');
  });
});

test('assignProviderSessionId merges a watcher-created duplicate into the app row', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-id-2', 'codex', '/workspace/demo');

    // Simulate the race: the filesystem watcher indexed the provider
    // transcript before the runtime announced its session id to the gateway.
    sessionsDb.createSession(
      'provider-race',
      'codex',
      '/workspace/demo',
      'Watcher Name',
      undefined,
      undefined,
      '/fake/provider-race.jsonl',
    );
    assert.equal(sessionsDb.getAllSessions().length, 2);

    sessionsDb.assignProviderSessionId('app-id-2', 'provider-race');

    const rows = sessionsDb.getAllSessions();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.session_id, 'app-id-2');
    assert.equal(rows[0]?.provider_session_id, 'provider-race');
    // Transcript path and name from the duplicate are adopted.
    assert.equal(rows[0]?.jsonl_path, '/fake/provider-race.jsonl');
    assert.equal(rows[0]?.custom_name, 'Watcher Name');
  });
});

for (const provider of ['claude', 'codex', 'cursor', 'opencode']) {
  test(`${provider} transcript execution cwd never replaces app-owned original project`, async () => {
    await withIsolatedDatabase(() => {
      sessionsDb.createAppSession('app-source', provider, '/workspace/source', 'App title');
      sessionsDb.assignProviderSessionId('app-source', 'provider-isolated');
      const indexedId = sessionsDb.createSession('provider-isolated', provider, '/worktrees/session-private', 'Transcript title', undefined, undefined, '/transcripts/current.jsonl');
      assert.equal(indexedId, 'app-source');
      const row = sessionsDb.getSessionById('app-source');
      assert.equal(row?.project_path, path.normalize('/workspace/source'));
      assert.equal(row?.custom_name, 'App title');
      assert.equal(row?.jsonl_path, '/transcripts/current.jsonl');
      assert.equal(getConnection().prepare('SELECT 1 FROM projects WHERE project_path = ?').get(path.normalize('/worktrees/session-private')), undefined);
    });
  });
}

test('watcher-before-provider-assignment race keeps original project through later rescans', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-race-source', 'codex', '/workspace/source');
    sessionsDb.createSession('provider-race-isolated', 'codex', '/worktrees/private', undefined, undefined, undefined, '/transcripts/private.jsonl');
    sessionsDb.assignProviderSessionId('app-race-source', 'provider-race-isolated');
    sessionsDb.createSession('provider-race-isolated', 'codex', '/worktrees/private');
    assert.equal(sessionsDb.getAllSessions().length, 1);
    assert.equal(sessionsDb.getSessionById('app-race-source')?.project_path, path.normalize('/workspace/source'));
  });
});

test('legacy app row without provider mapping preserves project when indexed by its id', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('legacy-app-source', 'claude', '/workspace/source', 'Original title');
    for (const worktree of ['/worktrees/private', '/worktrees/next', '/worktrees/third']) {
      sessionsDb.createSession('legacy-app-source', 'claude', worktree, 'Indexed title');
    }
    const row = sessionsDb.getSessionById('legacy-app-source');
    assert.equal(row?.provider_session_id, 'legacy-app-source');
    assert.equal(row?.project_path, path.normalize('/workspace/source'));
    assert.equal(row?.custom_name, 'Original title');
  });
});

test('externally created session still follows transcript project metadata', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('external-session', 'opencode', '/workspace/old');
    sessionsDb.createSession('external-session', 'opencode', '/workspace/new');
    assert.equal(sessionsDb.getSessionById('external-session')?.project_path, path.normalize('/workspace/new'));
  });
});

test('ownership migration backfills only provable app rows and survives repeated initialization', async () => {
  await withIsolatedDatabase(async () => {
    const db = getConnection();
    sessionsDb.createAppSession('pending-origin', 'claude', '/workspace/source');
    sessionsDb.createAppSession('mapped-origin', 'codex', '/workspace/source');
    sessionsDb.assignProviderSessionId('mapped-origin', 'native-origin');
    sessionsDb.createSession('external-origin', 'cursor', '/workspace/external');
    db.exec('ALTER TABLE sessions DROP COLUMN project_path_owned');
    await initializeDatabase();
    const ownership = (id: string) => (db.prepare('SELECT project_path_owned AS owned FROM sessions WHERE session_id = ?').get(id) as { owned: number }).owned;
    assert.equal(ownership('pending-origin'), 1);
    assert.equal(ownership('mapped-origin'), 1);
    assert.equal(ownership('external-origin'), 0);
    sessionsDb.createSession('pending-origin', 'claude', '/worktrees/first');
    await initializeDatabase();
    sessionsDb.createSession('pending-origin', 'claude', '/worktrees/second');
    sessionsDb.createSession('pending-origin', 'claude', '/worktrees/third');
    assert.equal(sessionsDb.getSessionById('pending-origin')?.project_path, path.normalize('/workspace/source'));
    sessionsDb.createSession('external-origin', 'cursor', '/workspace/external-new');
    assert.equal(sessionsDb.getSessionById('external-origin')?.project_path, path.normalize('/workspace/external-new'));
  });
});

test('legacy session rebuild preserves an existing ownership marker', async () => {
  await withIsolatedDatabase(async () => {
    const db = getConnection();
    sessionsDb.createAppSession('owned-rebuild', 'claude', '/workspace/source');
    sessionsDb.assignProviderSessionId('owned-rebuild', 'owned-rebuild');
    db.exec('ALTER TABLE sessions RENAME COLUMN project_path TO workspace_path');
    await initializeDatabase();
    const marker = db.prepare('SELECT project_path_owned AS owned FROM sessions WHERE session_id = ?').get('owned-rebuild') as { owned: number };
    assert.equal(marker.owned, 1);
    sessionsDb.createSession('owned-rebuild', 'claude', '/worktrees/rebuilt');
    assert.equal(sessionsDb.getSessionById('owned-rebuild')?.project_path, path.normalize('/workspace/source'));
  });
});

test('legacy provider-keyed rows stay resolvable through both lookups', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('legacy-1', 'opencode', '/workspace/demo');

    assert.equal(sessionsDb.getSessionById('legacy-1')?.provider, 'opencode');
    assert.equal(sessionsDb.getSessionByProviderSessionId('legacy-1')?.session_id, 'legacy-1');
  });
});
