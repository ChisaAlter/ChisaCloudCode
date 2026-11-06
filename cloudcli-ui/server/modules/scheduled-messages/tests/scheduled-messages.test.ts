import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';

// The shared upload store captures its global root at import time. Isolate the
// home before importing any backend barrel so dispatch checks the real store.
const fixtureHome = await mkdtemp(path.join(tmpdir(), 'scheduled-messages-home-'));
const previousEnvironment = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  DATABASE_PATH: process.env.DATABASE_PATH,
};
process.env.HOME = fixtureHome;
process.env.USERPROFILE = fixtureHome;
process.env.DATABASE_PATH = path.join(fixtureHome, 'bootstrap.db');
await writeFile(process.env.DATABASE_PATH, '');

const { createImageAssetService } = await import('@/modules/assets/index.js');
const { closeConnection, initializeDatabase, scheduledMessagesDb, sessionDraftsDb, sessionsDb, userDb } = await import('@/modules/database/index.js');
const { closeScheduledMessageDispatcher, dispatchDueScheduledMessages, dispatchQueuedMessages, initializeScheduledMessageDispatcher } = await import('@/modules/scheduled-messages/services/scheduled-message-dispatcher.service.js');
const { scheduledMessagesService } = await import('@/modules/scheduled-messages/services/scheduled-messages.service.js');
const { chatRunRegistry, connectedClients, isChatRunInFlight, onChatRunSettled, runDetachedChatTurn, setConnectedClientUserId } = await import('@/modules/websocket/index.js');
const { getGlobalImageAssetsDir } = await import('@/shared/index.js');
const assetStore = createImageAssetService();

// Publish through the upload service, including its persisted owner and byte
// validation; no descriptor or metadata record is manufactured by the fixture.
async function uploadImage(ownerUserId: number) {
  await assetStore.inventory();
  assert.equal(getGlobalImageAssetsDir(), path.join(fixtureHome, '.cloudcli', 'assets'));
  const { default: sharp } = await import('sharp');
  const bytes = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#4488cc' } }).png().toBuffer();
  const stagedPath = path.join(getGlobalImageAssetsDir(), '.staging', `${randomUUID()}.upload`);
  await writeFile(stagedPath, bytes);
  const [attachment] = await assetStore.saveUploads([
    { path: stagedPath, originalname: 'upload.png', mimetype: 'image/png' },
  ], ownerUserId, 'images');
  return attachment;
}

after(async () => {
  closeConnection();
  for (const [name, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(fixtureHome, { recursive: true, force: true });
});

const SESSION_ID = 'scheduled-session';
let fixtureUserId = 1;

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
    fixtureUserId = Number(user.id);
    sessionsDb.createAppSession(SESSION_ID, 'claude', tempDirectory, 'Scheduled session');
    await runTest(Number(user.id));
  } finally {
    closeScheduledMessageDispatcher();
    await dispatcherCheckpoint();
    chatRunRegistry.clearAll();
    connectedClients.clear();
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

function createRuntime(
  runs: RunCall[],
  behaviour: 'ok' | 'throw' = 'ok',
  aborts: string[] = [],
  hasBackgroundWork: (sessionId: string) => boolean = () => false,
): ProviderRuntimeGateway {
  return {
    hasRuntime: () => true,
    stopBackgroundTask: async () => false,
    hasBackgroundWork,
    hasBackgroundTask: () => false,
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

/** A chat socket that records what it is sent, standing in for an open browser tab. */
class FakeConnection {
  readyState = 1; // WS_OPEN_STATE
  frames: Array<Record<string, unknown>> = [];

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }

  /** The scheduled-message announcements among everything this socket received. */
  announcements(): Array<Record<string, unknown>> {
    return this.frames.filter((frame) => frame.kind === 'scheduled_messages_changed');
  }
}

function openTab(): FakeConnection {
  const connection = new FakeConnection();
  connectedClients.add(connection as never);
  setConnectedClientUserId(connection as never, fixtureUserId);
  return connection;
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
    const attachment = await uploadImage(userId);
    sessionDraftsDb.saveDraft(userId, SESSION_ID, {
      text: '',
      queuedMessage: {
        content: 'continue on the VPS',
        options: { model: 'claude-opus-5' },
        // Dispatch must recover the trusted descriptor from storage rather
        // than trust the queued client's name, MIME type or size.
        attachments: [{ ...attachment, name: 'forged.html', mimeType: 'text/html', size: 0 }],
      },
    });

    const runs: RunCall[] = [];
    assert.equal(connectedClients.size, 0);
    assert.equal(await dispatchQueuedMessages(createRuntime(runs)), 1);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].command, 'continue on the VPS');
    assert.equal(runs[0].options.model, 'claude-opus-5');
    assert.deepEqual(runs[0].options.attachments, [attachment]);
    assert.deepEqual(runs[0].options.images, [attachment]);
    assert.deepEqual(runs[0].options.files, []);
    assert.equal(attachment.mimeType, 'image/png');
    assert.equal(sessionDraftsDb.getDrafts(userId).length, 0);
  });
});

for (const source of ['forged', 'foreign', 'unknown'] as const) {
  test(`a queued message with ${source === 'unknown' ? 'an' : 'a'} ${source} attachment is rejected before a run starts`, async () => {
    await withIsolatedDatabase(async (userId) => {
      const ownedAttachment = await uploadImage(userId);
      // Keep the legacy workspace's single-account admission valid while the
      // real upload store persists a different principal as the asset owner.
      const invalidAttachment = source === 'foreign' ? await uploadImage(userId + 1) : {
        path: source === 'forged' ? '/tmp/upload.png' : path.join(getGlobalImageAssetsDir(), `${randomUUID()}.png`),
        name: 'upload.png', mimeType: 'image/png', size: 1,
      };
      sessionDraftsDb.saveDraft(userId, SESSION_ID, {
        text: 'new composer text',
        queuedMessage: { content: 'must not run', attachments: [ownedAttachment, invalidAttachment] },
      });

      const runs: RunCall[] = [];
      assert.equal(connectedClients.size, 0);
      await assert.rejects(dispatchQueuedMessages(createRuntime(runs)), (error: Error & { code?: string }) => {
        assert.equal(error.code, 'ATTACHMENT_NOT_FOUND');
        assert.equal(error.message, 'Asset not found');
        return true;
      });
      assert.equal(runs.length, 0);
      assert.equal(chatRunRegistry.getRun(SESSION_ID), undefined);
      assert.equal(isChatRunInFlight(SESSION_ID), false);
      assert.equal(sessionDraftsDb.getDrafts(userId)[0].text, 'new composer text');
      assert.equal(await dispatchQueuedMessages(createRuntime(runs)), 0);
    });
  });
}

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

test('a queued message waits for background work its session\'s last turn left running', async () => {
  await withIsolatedDatabase(async (userId) => {
    sessionDraftsDb.saveDraft(userId, SESSION_ID, {
      text: '',
      queuedMessage: { content: 'send after the background job' },
    });
    // Turn A ended, so its run is completed, but it backgrounded a command
    // that is still running under A's CLI process.
    const runA = chatRunRegistry.startRun({
      appSessionId: SESSION_ID,
      provider: 'claude',
      providerSessionId: null,
      connection: null,
      userId,
    });
    runA!.writer.sendComplete({ exitCode: 0 });
    assert.equal(chatRunRegistry.isProcessing(SESSION_ID), false);

    let backgroundWork = true;
    const runs: RunCall[] = [];
    const runtime = createRuntime(runs, 'ok', [], (sessionId) => sessionId === SESSION_ID && backgroundWork);

    // Starting B now would replace that process and stop the command.
    assert.equal(await dispatchQueuedMessages(runtime), 0);
    assert.equal(runs.length, 0);
    assert.deepEqual(sessionDraftsDb.getDrafts(userId)[0]?.queuedMessage, {
      content: 'send after the background job',
    });

    // Once the work has reported back, B goes on the next pass.
    backgroundWork = false;
    assert.equal(await dispatchQueuedMessages(runtime), 1);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].command, 'send after the background job');
    assert.equal(sessionDraftsDb.getDrafts(userId).length, 0);
  });
});

test('follow-ups queued during one turn are all sent, once, in order, as the next turn', async () => {
  await withIsolatedDatabase(async (userId) => {
    for (const content of ['follow-up A', 'follow-up B', 'follow-up C']) {
      sessionDraftsDb.appendQueuedMessage(userId, SESSION_ID, { content, options: { model: 'opus' }, attachments: [] });
    }

    const runs: RunCall[] = [];
    assert.equal(await dispatchQueuedMessages(createRuntime(runs)), 1);
    assert.equal(await dispatchQueuedMessages(createRuntime(runs)), 0, 'nothing is left to send');

    assert.equal(runs.length, 1);
    assert.equal(runs[0].command, 'follow-up A\n\nfollow-up B\n\nfollow-up C');
    assert.equal(runs[0].options.model, 'opus');
    assert.equal(sessionDraftsDb.getDrafts(userId).length, 0);
  });
});

test('a draft-text save after the queued message was sent does not send it again', async () => {
  await withIsolatedDatabase(async (userId) => {
    sessionDraftsDb.appendQueuedMessage(userId, SESSION_ID, { content: 'send me once', attachments: [] });
    const runs: RunCall[] = [];
    assert.equal(await dispatchQueuedMessages(createRuntime(runs)), 1);

    // The composer keeps saving its text while the user types the next
    // follow-up; its copy of the queue still holds the message just sent.
    sessionDraftsDb.saveDraftText(userId, SESSION_ID, 'typing the next one');

    assert.equal(await dispatchQueuedMessages(createRuntime(runs)), 0);
    assert.deepEqual(runs.map((run) => run.command), ['send me once']);
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

test('a rejected admission restores its queue ahead of a newer queued draft', async () => {
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
    assert.deepEqual(sessionDraftsDb.getDrafts(userId)[0].queuedMessage, { content: 'old queue\n\nnew queue', attachments: [] });
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

// The composer banner is read over REST, so these announcements are the only
// way an open tab learns that its list changed without it doing anything
// (#1546): the banner of a message the timer had already sent stayed up until
// a reload.

test('a due message is announced to open tabs as it is claimed, before its turn runs', async () => {
  await withIsolatedDatabase(async (userId) => {
    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'run the nightly checks',
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    });
    const tab = openTab();

    let announcedBeforeTheTurn: Array<Record<string, unknown>> = [];
    const runtime = {
      hasRuntime: () => true,
      hasBackgroundWork: () => false,
      run: async () => {
        announcedBeforeTheTurn = tab.announcements();
      },
      abort: async () => true,
    } as never;
    assert.equal(await dispatchDueScheduledMessages(runtime), 1);

    // The banner comes down when the turn starts, not after it finishes,
    // which for a long turn can be many minutes later.
    assert.equal(announcedBeforeTheTurn.length, 1);
    assert.equal(announcedBeforeTheTurn[0].sessionId, SESSION_ID);
    assert.equal(tab.announcements().length, 1);
  });
});

test('a pass announces each session it claimed from once, however many of its messages were due', async () => {
  await withIsolatedDatabase(async (userId) => {
    const otherSessionId = 'other-scheduled-session';
    sessionsDb.createAppSession(otherSessionId, 'claude', tmpdir(), 'Other scheduled session');
    for (const [sessionId, content] of [
      [SESSION_ID, 'first for this session'],
      [SESSION_ID, 'second for this session'],
      [otherSessionId, 'only one for the other session'],
    ]) {
      scheduledMessagesService.schedule({
        userId,
        sessionId,
        content,
        scheduledFor: new Date(Date.now() - 1_000).toISOString(),
      });
    }
    const tab = openTab();

    assert.equal(await dispatchDueScheduledMessages(createRuntime([])), 3);

    // One read per session is enough: a single GET returns all of its rows.
    assert.deepEqual(tab.announcements().map((frame) => frame.sessionId).sort(), [otherSessionId, SESSION_ID]);
  });
});

test('a message that fails to send is announced again once the reason is recorded', async () => {
  await withIsolatedDatabase(async (userId) => {
    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'will fail',
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    });
    const tab = openTab();

    await dispatchDueScheduledMessages(createRuntime([], 'throw'));

    // Claimed (the banner comes down), then failed (it comes back as the
    // failure notice).
    assert.deepEqual(tab.announcements().map((frame) => frame.sessionId), [SESSION_ID, SESSION_ID]);
    assert.equal(scheduledMessagesDb.listForSession(userId, SESSION_ID)[0].status, 'failed');
  });
});

test('scheduling and cancelling are announced, so other tabs and devices follow', async () => {
  await withIsolatedDatabase(async (userId) => {
    const tab = openTab();

    const scheduled = scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'from another tab',
      scheduledFor: new Date(Date.now() + 3_600_000).toISOString(),
    });
    assert.equal(tab.announcements().length, 1);

    scheduledMessagesService.cancel(userId, scheduled.id);
    assert.equal(tab.announcements().length, 2);

    // A refused cancel changed nothing, so there is nothing to announce.
    assert.throws(() => scheduledMessagesService.cancel(userId, scheduled.id));
    assert.equal(tab.announcements().length, 2);

    // The frame names the session and nothing else: each tab reads the list
    // again through its own authenticated request.
    for (const frame of tab.announcements()) {
      assert.deepEqual(Object.keys(frame).sort(), ['kind', 'sessionId', 'timestamp']);
      assert.equal(frame.sessionId, SESSION_ID);
    }
  });
});

test('a socket that cannot be written to does not stop a claimed message from being sent', async () => {
  await withIsolatedDatabase(async (userId) => {
    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'still goes',
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    });
    const closedTab = openTab();
    closedTab.readyState = 3; // CLOSED
    connectedClients.add({
      readyState: 1,
      send: () => {
        throw new Error('socket went away mid-send');
      },
    } as never);

    const runs: RunCall[] = [];
    assert.equal(await dispatchDueScheduledMessages(createRuntime(runs)), 1);

    assert.equal(runs.length, 1);
    assert.equal(runs[0].command, 'still goes');
    assert.equal(closedTab.frames.length, 0);
  });
});
