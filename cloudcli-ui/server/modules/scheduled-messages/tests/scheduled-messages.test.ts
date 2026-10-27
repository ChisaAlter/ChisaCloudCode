import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, scheduledMessagesDb, sessionDraftsDb, sessionsDb, userDb } from '@/modules/database/index.js';
import { closeScheduledMessageDispatcher, dispatchDueScheduledMessages, dispatchQueuedMessages, initializeScheduledMessageDispatcher } from '@/modules/scheduled-messages/services/scheduled-message-dispatcher.service.js';
import { scheduledMessagesService } from '@/modules/scheduled-messages/services/scheduled-messages.service.js';
import { chatRunRegistry, isChatRunInFlight, onChatRunSettled, runDetachedChatTurn } from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';

const SESSION_ID = 'scheduled-session';

async function withIsolatedDatabase(runTest: (userId: number) => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'scheduled-messages-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');

  try {
    // Keep the fixture independent of the developer's legacy database contents.
    await writeFile(process.env.DATABASE_PATH, '');
    await initializeDatabase();
    const user = userDb.createUser('scheduler', 'hash');
    sessionsDb.createAppSession(SESSION_ID, 'claude', tempDirectory, 'Scheduled session');
    await runTest(Number(user.id));
  } finally {
    closeScheduledMessageDispatcher();
    await dispatcherCheckpoint();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

type RunCall = { provider: string; command: string; options: Record<string, unknown> };

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function observeSettledRuns() {
  let count = 0;
  const waiters: Array<{ count: number; resolve: () => void }> = [];
  const remove = onChatRunSettled(() => {
    count++;
    for (const waiter of waiters) if (count >= waiter.count) waiter.resolve();
  });
  return {
    waitFor: async (expected: number) => {
      const reached = count >= expected
        ? Promise.resolve()
        : new Promise<void>(resolve => { waiters.push({ count: expected, resolve }); });
      // Dispatcher wakeups are unref'ed; keep the loop alive to run an enqueued wake.
      await dispatcherCheckpoint();
      await reached;
    },
    remove,
  };
}

/** After explicit run settlement, let dispatch bookkeeping and its immediate wake finish. */
async function dispatcherCheckpoint(): Promise<void> {
  await new Promise<void>(resolve => { setImmediate(resolve); });
}

function createRuntime(runs: RunCall[], behaviour: 'ok' | 'throw' = 'ok', aborts: string[] = []): ProviderRuntimeGateway {
  return {
    hasRuntime: () => true,
    run: async (provider: string, command: string, options: Record<string, unknown>) => {
      if (behaviour === 'throw') {
        throw new Error('provider exploded');
      }
      runs.push({ provider, command, options });
    },
    abort: async (_provider: string, sessionId: string) => {
      aborts.push(sessionId);
      return true;
    },
    resolveToolApproval() {},
    getPendingApprovalsForSession: () => [],
  };
}

test('a message due in the past is sent on the next pass, not skipped', async () => {
  await withIsolatedDatabase(async (userId) => {
    // The server was down when this came due.
    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'run the nightly checks',
      scheduledFor: new Date(Date.now() - 60_000).toISOString(),
    });

    const runs: RunCall[] = [];
    const sent = await dispatchDueScheduledMessages(createRuntime(runs));

    assert.equal(sent, 1);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].command, 'run the nightly checks');
    assert.equal(scheduledMessagesDb.listForSession(userId, SESSION_ID)[0].status, 'sent');
  });
});

test('a queued message is sent by the server without a browser connection', async () => {
  await withIsolatedDatabase(async (userId) => {
    sessionDraftsDb.saveDraft(userId, SESSION_ID, {
      text: '',
      queuedMessage: {
        content: 'continue on the VPS',
        options: { model: 'claude-opus-5' },
        attachments: [{ path: '/tmp/upload.png' }],
      },
    });

    const runs: RunCall[] = [];
    assert.equal(await dispatchQueuedMessages(createRuntime(runs)), 1);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].command, 'continue on the VPS');
    assert.equal(runs[0].options.model, 'claude-opus-5');
    assert.deepEqual(runs[0].options.attachments, []);
    assert.equal(sessionDraftsDb.getDrafts(userId).length, 0);
  });
});

test('a queued message stays pending while its session is busy', async () => {
  await withIsolatedDatabase(async (userId) => {
    sessionDraftsDb.saveDraft(userId, SESSION_ID, {
      text: '',
      queuedMessage: { content: 'send after this run' },
    });
    chatRunRegistry.startRun({
      appSessionId: SESSION_ID,
      provider: 'claude',
      providerSessionId: null,
      connection: null,
      userId,
    });

    const runs: RunCall[] = [];
    assert.equal(await dispatchQueuedMessages(createRuntime(runs)), 0);
    assert.equal(runs.length, 0);
    assert.deepEqual(sessionDraftsDb.getDrafts(userId)[0]?.queuedMessage, {
      content: 'send after this run',
    });
  });
});

test('a due message interrupts a run in progress instead of failing', async () => {
  await withIsolatedDatabase(async (userId) => {
    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'the schedule wins',
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    });
    chatRunRegistry.startRun({
      appSessionId: SESSION_ID,
      provider: 'claude',
      providerSessionId: null,
      connection: null,
      userId,
    });

    const runs: RunCall[] = [];
    const aborts: string[] = [];
    assert.equal(await dispatchDueScheduledMessages(createRuntime(runs, 'ok', aborts)), 1);

    assert.deepEqual(aborts, [SESSION_ID]);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].command, 'the schedule wins');
    assert.equal(scheduledMessagesDb.listForSession(userId, SESSION_ID)[0].status, 'sent');
  });
});

test('a message that is not due yet is left alone', async () => {
  await withIsolatedDatabase(async (userId) => {
    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'later',
      scheduledFor: new Date(Date.now() + 3_600_000).toISOString(),
    });

    const runs: RunCall[] = [];
    assert.equal(await dispatchDueScheduledMessages(createRuntime(runs)), 0);
    assert.equal(runs.length, 0);
    assert.equal(scheduledMessagesDb.listForSession(userId, SESSION_ID)[0].status, 'pending');
  });
});

test('a due message is claimed once, so overlapping passes cannot double-send it', async () => {
  await withIsolatedDatabase(async (userId) => {
    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'only once',
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    });

    const runs: RunCall[] = [];
    const runtime = createRuntime(runs);
    await Promise.all([
      dispatchDueScheduledMessages(runtime),
      dispatchDueScheduledMessages(runtime),
    ]);

    assert.equal(runs.length, 1);
  });
});

test('the composer settings it was scheduled with travel with it', async () => {
  await withIsolatedDatabase(async (userId) => {
    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'with options',
      options: { model: 'claude-opus-5', permissionMode: 'plan' },
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    });

    const runs: RunCall[] = [];
    await dispatchDueScheduledMessages(createRuntime(runs));

    assert.equal(runs[0].options.model, 'claude-opus-5');
    assert.equal(runs[0].options.permissionMode, 'plan');
  });
});

test('a provider failure is recorded on the message instead of vanishing', async () => {
  await withIsolatedDatabase(async (userId) => {
    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'will fail',
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    });

    await dispatchDueScheduledMessages(createRuntime([], 'throw'));

    const row = scheduledMessagesDb.listForSession(userId, SESSION_ID)[0];
    assert.equal(row.status, 'failed');
    assert.match(row.failure_reason ?? '', /provider exploded/);
  });
});

test('a cancelled message never fires', async () => {
  await withIsolatedDatabase(async (userId) => {
    const scheduled = scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'never mind',
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    });
    scheduledMessagesService.cancel(userId, scheduled.id);

    const runs: RunCall[] = [];
    assert.equal(await dispatchDueScheduledMessages(createRuntime(runs)), 0);
    assert.equal(runs.length, 0);
  });
});

test('a failed message can be dismissed, and stays dismissed', async () => {
  await withIsolatedDatabase(async (userId) => {
    const scheduled = scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'will fail',
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    });
    await dispatchDueScheduledMessages(createRuntime([], 'throw'));
    assert.equal(scheduledMessagesDb.listForSession(userId, SESSION_ID)[0].status, 'failed');

    scheduledMessagesService.cancel(userId, scheduled.id);

    assert.equal(scheduledMessagesDb.listForSession(userId, SESSION_ID)[0].status, 'cancelled');
  });
});

test('cancelling something that already fired is refused', async () => {
  await withIsolatedDatabase(async (userId) => {
    const scheduled = scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'gone',
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    });
    await dispatchDueScheduledMessages(createRuntime([]));

    assert.throws(
      () => scheduledMessagesService.cancel(userId, scheduled.id),
      (error: Error & { code?: string }) => error.code === 'SCHEDULED_MESSAGE_NOT_PENDING',
    );
  });
});

test('one user cannot cancel another user\'s scheduled message', async () => {
  await withIsolatedDatabase(async (userId) => {
    const scheduled = scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'mine',
      scheduledFor: new Date(Date.now() + 3_600_000).toISOString(),
    });

    assert.throws(
      () => scheduledMessagesService.cancel(userId + 1, scheduled.id),
      (error: Error & { code?: string }) => error.code === 'SCHEDULED_MESSAGE_NOT_PENDING',
    );
    assert.equal(scheduledMessagesDb.listForSession(userId, SESSION_ID)[0].status, 'pending');
  });
});

test('due runs block only their own session and queued turns wake after handback', { timeout: 15_000 }, async () => {
  await withIsolatedDatabase(async userId => {
    const otherSession = 'other-scheduled-session';
    sessionsDb.createAppSession(otherSession, 'claude', '/workspace/other');
    scheduledMessagesService.schedule({ userId, sessionId: SESSION_ID, content: 'long scheduled run', scheduledFor: new Date(Date.now() - 1000).toISOString() });
    sessionDraftsDb.saveDraft(userId, SESSION_ID, { text: '', queuedMessage: { content: 'same session next' } });
    sessionDraftsDb.saveDraft(userId, otherSession, { text: '', queuedMessage: { content: 'unrelated queue' } });
    const entered = gate();
    const handback = gate();
    const settled = observeSettledRuns();
    const calls: string[] = [];
    const runtime = {
      ...createRuntime([]),
      run: async (_provider: string, command: string, _options: unknown, writer: Parameters<ProviderRuntimeGateway['run']>[3]) => {
        calls.push(command);
        if (command === 'long scheduled run') {
          // A provider terminal frame can precede actual workspace cleanup.
          writer.send({ kind: 'complete', provider: 'claude', sessionId: SESSION_ID, exitCode: 0 });
          entered.resolve();
          await handback.promise;
        }
      },
    } as ProviderRuntimeGateway;
    initializeScheduledMessageDispatcher(runtime);
    try {
      await entered.promise;
      // Only the unrelated queue can settle while the scheduled run holds handback.
      await settled.waitFor(1);
      await dispatcherCheckpoint();
      assert.equal(isChatRunInFlight(SESSION_ID), true);
      assert.deepEqual(calls, ['long scheduled run', 'unrelated queue']);
      assert.equal(await dispatchQueuedMessages(runtime, false), 0);
      assert.equal((sessionDraftsDb.getDrafts(userId)[0].queuedMessage as { content: string }).content, 'same session next');
      handback.resolve();
      await settled.waitFor(3);
      await dispatcherCheckpoint();
      assert.deepEqual(calls, ['long scheduled run', 'unrelated queue', 'same session next']);
      assert.equal(sessionDraftsDb.getDrafts(userId).length, 0);
    } finally {
      closeScheduledMessageDispatcher();
      handback.resolve();
      // Closing cancels future wakes, so await only runs that really entered.
      await settled.waitFor(calls.length);
      await dispatcherCheckpoint();
      settled.remove();
    }
  });
});

test('workspace admission busy preserves the exact draft without self-waking and can retry once', { timeout: 15_000 }, async () => {
  await withIsolatedDatabase(async userId => {
    const queuedMessage = { content: 'retry after workspace handback', options: { workspaceMode: 'isolated', model: 'claude-opus-5' }, attachments: [] };
    sessionDraftsDb.saveDraft(userId, SESSION_ID, { text: 'new draft text', queuedMessage });
    let calls = 0;
    let busy = true;
    let settled = 0;
    const remove = onChatRunSettled(() => { settled++; });
    const runtime = {
      ...createRuntime([]),
      run: async () => {
        calls++;
        if (busy) throw Object.assign(new Error('Workspace reserved by synchronization'), { code: 'WORKSPACE_BUSY', workspaceAdmissionRejected: true });
      },
    } as ProviderRuntimeGateway;
    // Own the first attempt's promise while the background dispatcher observes it.
    const firstAttempt = dispatchQueuedMessages(runtime);
    initializeScheduledMessageDispatcher(runtime);
    try {
      await firstAttempt;
      await dispatcherCheckpoint();
      assert.equal(calls, 1);
      assert.equal(settled, 0);
      assert.deepEqual(sessionDraftsDb.getDrafts(userId)[0].queuedMessage, queuedMessage);
      assert.equal(sessionDraftsDb.getDrafts(userId)[0].text, 'new draft text');
      busy = false;
      const results = await Promise.all([dispatchQueuedMessages(runtime), dispatchQueuedMessages(runtime)]);
      assert.deepEqual(results, [1, 0]);
      assert.equal(calls, 2);
      assert.equal(settled, 1);
      assert.equal(sessionDraftsDb.getDrafts(userId)[0].queuedMessage, null);
    } finally {
      closeScheduledMessageDispatcher();
      await firstAttempt;
      await dispatcherCheckpoint();
      remove();
    }
  });
});

test('a newer queued draft wins over a rejected admission restore', async () => {
  await withIsolatedDatabase(async userId => {
    sessionDraftsDb.saveDraft(userId, SESSION_ID, { text: '', queuedMessage: { content: 'old queue' } });
    const runtime = {
      ...createRuntime([]),
      run: async () => {
        sessionDraftsDb.saveDraft(userId, SESSION_ID, { text: 'new text', queuedMessage: { content: 'new queue' } });
        throw Object.assign(new Error('Workspace busy'), { code: 'WORKSPACE_BUSY', workspaceAdmissionRejected: true });
      },
    } as ProviderRuntimeGateway;
    assert.equal(await dispatchQueuedMessages(runtime), 1);
    assert.deepEqual(sessionDraftsDb.getDrafts(userId)[0].queuedMessage, { content: 'new queue' });
    assert.equal(sessionDraftsDb.getDrafts(userId)[0].text, 'new text');
  });
});

test('a real queued execution failure is reported and is never replayed as unsent', async () => {
  await withIsolatedDatabase(async userId => {
    sessionDraftsDb.saveDraft(userId, SESSION_ID, { text: '', queuedMessage: { content: 'run once' } });
    const runtime = {
      ...createRuntime([]),
      run: async () => { throw Object.assign(new Error('Workspace busy after tool already ran'), { code: 'WORKSPACE_BUSY' }); },
    } as ProviderRuntimeGateway;
    await assert.rejects(dispatchQueuedMessages(runtime), /Workspace busy after tool already ran/);
    assert.equal(sessionDraftsDb.getDrafts(userId).length, 0);
    assert.equal(await dispatchQueuedMessages(runtime), 0);
  });
});

test('interactive completion wakes a queued turn only after runtime teardown', { timeout: 15_000 }, async () => {
  await withIsolatedDatabase(async userId => {
    const entered = gate();
    const teardown = gate();
    const settled = observeSettledRuns();
    const calls: string[] = [];
    const runtime = {
      ...createRuntime([]),
      run: async (_provider: string, command: string, _options: unknown, writer: Parameters<ProviderRuntimeGateway['run']>[3]) => {
        calls.push(command);
        if (command === 'interactive original') {
          writer.send({ kind: 'complete', provider: 'claude', sessionId: SESSION_ID, exitCode: 0 });
          entered.resolve();
          await teardown.promise;
        }
      },
    } as ProviderRuntimeGateway;
    const original = runDetachedChatTurn({ sessionId: SESSION_ID, userId, content: 'interactive original' }, { runtime });
    try {
      await entered.promise;
      sessionDraftsDb.saveDraft(userId, SESSION_ID, { text: '', queuedMessage: { content: 'queued continuation' } });
      initializeScheduledMessageDispatcher(runtime);
      await dispatcherCheckpoint();
      assert.deepEqual(calls, ['interactive original']);
      teardown.resolve();
      await original;
      await settled.waitFor(2);
      await dispatcherCheckpoint();
      assert.deepEqual(calls, ['interactive original', 'queued continuation']);
      assert.equal(sessionDraftsDb.getDrafts(userId).length, 0);
    } finally {
      closeScheduledMessageDispatcher();
      teardown.resolve();
      await original;
      await dispatcherCheckpoint();
      settled.remove();
    }
  });
});

test('scheduling validates its input', async () => {
  await withIsolatedDatabase(async (userId) => {
    const base = { userId, sessionId: SESSION_ID, scheduledFor: new Date(Date.now() + 1000).toISOString() };

    assert.throws(
      () => scheduledMessagesService.schedule({ ...base, content: '   ' }),
      (error: Error & { code?: string }) => error.code === 'CONTENT_REQUIRED',
    );
    assert.throws(
      () => scheduledMessagesService.schedule({ ...base, content: 'hi', scheduledFor: 'not a date' }),
      (error: Error & { code?: string }) => error.code === 'INVALID_SCHEDULE_TIME',
    );
    assert.throws(
      () => scheduledMessagesService.schedule({
        ...base,
        content: 'hi',
        scheduledFor: new Date(Date.now() + 400 * 24 * 3600 * 1000).toISOString(),
      }),
      (error: Error & { code?: string }) => error.code === 'SCHEDULE_TOO_FAR_AHEAD',
    );
    assert.throws(
      () => scheduledMessagesService.schedule({ ...base, sessionId: 'nope', content: 'hi' }),
      (error: Error & { code?: string }) => error.code === 'SESSION_NOT_FOUND',
    );
  });
});
