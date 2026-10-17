import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  sessionDraftsDb,
  userPreferencesDb,
} from '@/modules/database/index.js';

const USER_ID = 1;

async function withDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'user-prefs-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await writeFile(databasePath, '');
  await initializeDatabase();

  // Both tables cascade from users(id), so a row has to exist to write against.
  getConnection()
    .prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)')
    .run(USER_ID, 'tester', 'hash');

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

test('preferences round-trip every JSON shape a setting can take', async () => {
  await withDatabase(() => {
    userPreferencesDb.savePreferences(USER_ID, {
      theme: 'dark',
      tasksEnabled: false,
      claudePermissions: { allowedTools: ['Read'], skipPermissions: true },
    });

    assert.deepEqual(userPreferencesDb.getPreferences(USER_ID), {
      theme: 'dark',
      tasksEnabled: false,
      claudePermissions: { allowedTools: ['Read'], skipPermissions: true },
    });
  });
});

test('saving preferences merge-patches instead of replacing the whole set', async () => {
  await withDatabase(() => {
    userPreferencesDb.savePreferences(USER_ID, { theme: 'dark', userLanguage: 'de' });
    userPreferencesDb.savePreferences(USER_ID, { theme: 'light' });

    assert.deepEqual(userPreferencesDb.getPreferences(USER_ID), {
      theme: 'light',
      userLanguage: 'de',
    });
  });
});

test('a preference set to undefined is removed', async () => {
  await withDatabase(() => {
    userPreferencesDb.savePreferences(USER_ID, { theme: 'dark', userLanguage: 'de' });
    userPreferencesDb.savePreferences(USER_ID, { userLanguage: undefined });

    assert.deepEqual(userPreferencesDb.getPreferences(USER_ID), { theme: 'dark' });
  });
});

test('one unreadable preference value does not cost the user the others', async () => {
  await withDatabase(() => {
    userPreferencesDb.savePreferences(USER_ID, { theme: 'dark' });
    getConnection()
      .prepare(
        `INSERT INTO user_preferences (user_id, preference_key, preference_value)
         VALUES (?, ?, ?)`
      )
      .run(USER_ID, 'broken', 'not json');

    assert.deepEqual(userPreferencesDb.getPreferences(USER_ID), { theme: 'dark' });
  });
});

test('drafts round-trip text and queued message per scope', async () => {
  await withDatabase(() => {
    sessionDraftsDb.saveDraft(USER_ID, 'session-a', { text: 'half typed', queuedMessage: null });
    sessionDraftsDb.saveDraft(USER_ID, 'project:p1', {
      text: '',
      queuedMessage: { content: 'run it' },
    });

    const drafts = sessionDraftsDb.getDrafts(USER_ID);
    const byScope = new Map(drafts.map((draft) => [draft.scope, draft]));

    assert.equal(byScope.get('session-a')?.text, 'half typed');
    assert.equal(byScope.get('session-a')?.queuedMessage, null);
    assert.equal(byScope.get('project:p1')?.text, '');
    assert.deepEqual(byScope.get('project:p1')?.queuedMessage, { content: 'run it' });
  });
});

test('saving an empty draft deletes the row rather than keeping a blank one', async () => {
  await withDatabase(() => {
    sessionDraftsDb.saveDraft(USER_ID, 'session-a', { text: 'typed', queuedMessage: null });
    sessionDraftsDb.saveDraft(USER_ID, 'session-a', { text: '', queuedMessage: null });

    assert.deepEqual(sessionDraftsDb.getDrafts(USER_ID), []);
  });
});

test('a claimed turn stays recoverable while text-only edits survive its successful completion', async () => {
  await withDatabase(() => {
    const queuedMessage = { content: 'queued once' };
    sessionDraftsDb.saveDraft(USER_ID, 'session-a', { text: 'draft', queuedMessage });
    sessionDraftsDb.saveDraft(USER_ID, 'session-a', { text: '' });
    assert.deepEqual(sessionDraftsDb.getDrafts(USER_ID)[0]?.queuedMessage, queuedMessage);
    const claim = { userId: USER_ID, sessionId: 'session-a', queuedMessage, claimToken: JSON.stringify(queuedMessage) };
    assert.equal(sessionDraftsDb.claimQueuedMessage(claim), true);
    sessionDraftsDb.saveDraft(USER_ID, 'session-a', { text: 'new draft' });
    const claimedMessage = sessionDraftsDb.getDrafts(USER_ID)[0]?.queuedMessage as Record<string, unknown>;
    assert.equal(claimedMessage.content, queuedMessage.content);
    assert.equal(claimedMessage.autoSend, false);
    assert.equal(typeof claimedMessage.claimRevision, 'string');
    assert.equal(sessionDraftsDb.claimQueuedMessage(claim), false);
    sessionDraftsDb.completeQueuedMessage(claim);
    assert.equal(sessionDraftsDb.getDrafts(USER_ID)[0]?.text, 'new draft');
    assert.equal(sessionDraftsDb.getDrafts(USER_ID)[0]?.queuedMessage, null);
    sessionDraftsDb.saveDraft(USER_ID, 'session-a', { text: '', queuedMessage });
    sessionDraftsDb.saveDraft(USER_ID, 'session-a', { text: '', queuedMessage: null });
    assert.deepEqual(sessionDraftsDb.getDrafts(USER_ID), []);
  });
});

test('an interrupted claim retains its complete envelope after the database is reopened', async () => {
  await withDatabase(() => {
    const queuedMessage = {
      content: 'recover this input',
      attachments: [{ path: '/tmp/image.png', metadata: { width: 32 } }],
      options: { model: 'opus', effort: 'high' },
      originalId: 'original-message',
      autoSend: true,
    };
    sessionDraftsDb.saveDraft(USER_ID, 'session-a', { text: 'later typing', queuedMessage });
    const claim = { userId: USER_ID, sessionId: 'session-a', queuedMessage, claimToken: JSON.stringify(queuedMessage) };
    assert.equal(sessionDraftsDb.claimQueuedMessage(claim), true);
    const stored = sessionDraftsDb.getDrafts(USER_ID);
    closeConnection();
    assert.deepEqual(sessionDraftsDb.getDrafts(USER_ID), stored);
    sessionDraftsDb.pauseClaimedQueuedMessage(claim);
    assert.equal(sessionDraftsDb.getDrafts(USER_ID)[0].text, 'later typing');
    assert.deepEqual(sessionDraftsDb.getDrafts(USER_ID)[0].queuedMessage, { ...queuedMessage, autoSend: false });
  });
});

for (const operation of ['restoreQueuedMessage', 'completeQueuedMessage', 'pauseClaimedQueuedMessage'] as const) {
  test(`${operation} cannot change a later queue or a cleared-and-recreated draft`, async (t) => {
    await withDatabase(() => {
      t.mock.method(Date, 'now', () => Date.UTC(2026, 9, 16));
      const queuedMessage = { content: 'same content', options: { effort: 'high' } };
      sessionDraftsDb.saveDraft(USER_ID, 'session-a', { text: '', queuedMessage });
      const claim = { userId: USER_ID, sessionId: 'session-a', queuedMessage, claimToken: JSON.stringify(queuedMessage) };
      assert.equal(sessionDraftsDb.claimQueuedMessage(claim), true);
      sessionDraftsDb.saveDraft(USER_ID, 'session-a', { text: 'new draft', queuedMessage: { content: 'replacement' } });
      const replacement = sessionDraftsDb.getDrafts(USER_ID);
      sessionDraftsDb[operation](claim);
      assert.deepEqual(sessionDraftsDb.getDrafts(USER_ID), replacement);
      sessionDraftsDb.saveDraft(USER_ID, 'session-a', { text: '', queuedMessage: null });
      sessionDraftsDb.saveDraft(USER_ID, 'session-a', { text: 'recreated draft', queuedMessage });
      const recreated = sessionDraftsDb.getDrafts(USER_ID);
      sessionDraftsDb[operation](claim);
      assert.deepEqual(sessionDraftsDb.getDrafts(USER_ID), recreated);
    });
  });
}

test('a listed revision cannot claim an identical queue recreated by a later user action', async (t) => {
  await withDatabase(() => {
    t.mock.method(Date, 'now', () => Date.UTC(2026, 9, 16));
    const queuedMessage = { content: 'identical requeue' };
    sessionDraftsDb.saveDraft(USER_ID, 'session-a', { text: '', queuedMessage });
    const claim = {
      userId: USER_ID,
      sessionId: 'session-a',
      queuedMessage,
      claimToken: JSON.stringify(queuedMessage),
      revision: sessionDraftsDb.getDrafts(USER_ID)[0].updatedAt,
    };
    sessionDraftsDb.saveDraft(USER_ID, 'session-a', { text: '', queuedMessage: null });
    sessionDraftsDb.saveDraft(USER_ID, 'session-a', { text: '', queuedMessage });
    assert.equal(sessionDraftsDb.claimQueuedMessage(claim), false);
    assert.deepEqual(sessionDraftsDb.getDrafts(USER_ID)[0].queuedMessage, queuedMessage);
  });
});

test('pausing a pending or claimed queue preserves attachments and options without claim metadata', async () => {
  await withDatabase(() => {
    const queuedMessage = { content: 'pending', attachments: [{ path: '/tmp/file.txt' }], options: { effort: 'high' } };
    sessionDraftsDb.saveDraft(USER_ID, 'session-a', { text: 'still drafting', queuedMessage });
    sessionDraftsDb.pauseQueuedMessage(USER_ID, 'session-a');
    assert.deepEqual(sessionDraftsDb.getDrafts(USER_ID)[0].queuedMessage, { ...queuedMessage, autoSend: false });
    const manualClaim = { userId: USER_ID, sessionId: 'session-a', queuedMessage, claimToken: JSON.stringify({ ...queuedMessage, autoSend: false }) };
    assert.equal(sessionDraftsDb.claimQueuedMessage(manualClaim), false);
    sessionDraftsDb.saveDraft(USER_ID, 'session-a', { text: 'still drafting', queuedMessage });
    const claim = { userId: USER_ID, sessionId: 'session-a', queuedMessage, claimToken: JSON.stringify(queuedMessage) };
    assert.equal(sessionDraftsDb.claimQueuedMessage(claim), true);
    sessionDraftsDb.pauseQueuedMessage(USER_ID, 'session-a');
    assert.deepEqual(sessionDraftsDb.getDrafts(USER_ID)[0].queuedMessage, { ...queuedMessage, autoSend: false });
    assert.equal(sessionDraftsDb.getDrafts(USER_ID)[0].text, 'still drafting');
  });
});

test('deleteDraft removes only the named scope', async () => {
  await withDatabase(() => {
    sessionDraftsDb.saveDraft(USER_ID, 'session-a', { text: 'a', queuedMessage: null });
    sessionDraftsDb.saveDraft(USER_ID, 'session-b', { text: 'b', queuedMessage: null });

    sessionDraftsDb.deleteDraft(USER_ID, 'session-a');

    assert.deepEqual(
      sessionDraftsDb.getDrafts(USER_ID).map((draft) => draft.scope),
      ['session-b'],
    );
  });
});
