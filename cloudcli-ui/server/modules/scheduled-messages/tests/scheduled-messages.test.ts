import { AsyncLocalStorage } from 'node:async_hooks';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { closeConnection, initializeDatabase, scheduledMessagesDb, sessionDraftsDb, sessionsDb, userDb } from '@/modules/database/index.js';
import { closeScheduledMessageDispatcher, dispatchDueScheduledMessages, dispatchQueuedMessages, initializeScheduledMessageDispatcher } from '@/modules/scheduled-messages/services/scheduled-message-dispatcher.service.js';
import { scheduledMessagesService } from '@/modules/scheduled-messages/services/scheduled-messages.service.js';
import { chatRunRegistry, isChatRunInFlight, onChatRunSettled, runDetachedChatTurn } from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import type { ProviderRuntimeWriter } from '@/shared/index.js';
import { createCompleteMessage } from '@/shared/utils.js';

const SESSION_ID = 'scheduled-session';

async function withIsolatedDatabase(runTest: (userId: number) => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'scheduled-messages-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await writeFile(process.env.DATABASE_PATH, '');
  await initializeDatabase();

  try {
    const user = userDb.createUser('scheduler', 'hash');
    sessionsDb.createAppSession(SESSION_ID, 'claude', tempDirectory, 'Scheduled session');
    await runTest(Number(user.id));
  } finally {
    closeScheduledMessageDispatcher();
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

function createRuntime(runs: RunCall[], behaviour: 'ok' | 'throw' | 'failed' | 'stopped' = 'ok', aborts: string[] = []): ProviderRuntimeGateway {
  return {
    hasRuntime: () => true,
    run: async (provider, command, options, writer) => {
      if (behaviour === 'throw') {
        throw new Error('provider exploded');
      }
      runs.push({ provider, command, options });
      writer.send(createCompleteMessage({ provider, sessionId: String(options.sessionId), exitCode: behaviour === 'failed' ? 1 : 0, aborted: behaviour === 'stopped' }));
    },
    abort: async (_provider: string, sessionId: string) => {
      aborts.push(sessionId);
      return true;
    },
    resolveToolApproval: () => {},
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

test('a run-reservation race retains the queued input and sends it on the next idle pass', async (t) => {
  await withIsolatedDatabase(async (userId) => {
    const queuedMessage = { content: 'race-safe input', attachments: [{ path: '/tmp/original.png' }], options: { effort: 'high' } };
    sessionDraftsDb.saveDraft(userId, SESSION_ID, { text: '', queuedMessage });
    const runs: RunCall[] = [];
    const reservation = t.mock.method(chatRunRegistry, 'startRun', () => null);
    assert.equal(await dispatchQueuedMessages(createRuntime(runs)), 1);
    assert.deepEqual(sessionDraftsDb.getDrafts(userId)[0].queuedMessage, queuedMessage);
    assert.equal(runs.length, 0);
    reservation.mock.restore();
    assert.equal(await dispatchQueuedMessages(createRuntime(runs)), 1);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].command, queuedMessage.content);
    assert.deepEqual(sessionDraftsDb.getDrafts(userId), []);
  });
});

for (const behaviour of ['throw', 'failed', 'stopped', 'unavailable'] as const) {
  test(`a ${behaviour} queued turn preserves its original envelope and pauses automatic resending`, async () => {
    await withIsolatedDatabase(async (userId) => {
      const queuedMessage = {
        content: 'recover failed input',
        options: { model: 'claude-opus-5', effort: 'high', futureSetting: 17 },
        attachments: [{ path: '/tmp/original.png', metadata: { width: 10 } }],
        originalId: 'snapshot-1',
      };
      sessionDraftsDb.saveDraft(userId, SESSION_ID, { text: 'new typing', queuedMessage });
      const runs: RunCall[] = [];
      const runtime = createRuntime(runs, behaviour === 'unavailable' ? 'ok' : behaviour);
      if (behaviour === 'unavailable') runtime.hasRuntime = () => false;
      assert.equal(await dispatchQueuedMessages(runtime), 1);
      assert.deepEqual(sessionDraftsDb.getDrafts(userId)[0].queuedMessage, { ...queuedMessage, autoSend: false });
      assert.equal(sessionDraftsDb.getDrafts(userId)[0].text, 'new typing');
      assert.equal(chatRunRegistry.isProcessing(SESSION_ID), false);
      closeScheduledMessageDispatcher();
    chatRunRegistry.clearAll();
      const retries: RunCall[] = [];
      assert.equal(await dispatchQueuedMessages(createRuntime(retries)), 0);
      assert.deepEqual(retries, []);
    });
  });
}

test('a queued claim stays persisted in flight and cannot be dispatched twice', async () => {
  await withIsolatedDatabase(async (userId) => {
    const queuedMessage = { content: 'long-running input', options: { effort: 'high' }, attachments: [{ path: '/tmp/kept.png' }] };
    sessionDraftsDb.saveDraft(userId, SESSION_ID, { text: '', queuedMessage });
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const runs: string[] = [];
    const runtime: ProviderRuntimeGateway = {
      ...createRuntime([]),
      run: async (provider, command, options, writer) => {
        runs.push(command);
        entered();
        await held;
        writer.send(createCompleteMessage({ provider, sessionId: String(options.sessionId), exitCode: 0 }));
      },
    };
    const dispatch = dispatchQueuedMessages(runtime);
    await started;
    try {
      const stored = sessionDraftsDb.getDrafts(userId)[0].queuedMessage as Record<string, unknown>;
      assert.deepEqual({ ...stored, claimRevision: undefined }, { ...queuedMessage, autoSend: false, claimRevision: undefined });
      assert.equal(typeof stored.claimRevision, 'string');
      assert.equal(await dispatchQueuedMessages(runtime), 0);
      assert.deepEqual(runs, [queuedMessage.content]);
    } finally {
      release();
      await dispatch;
    }
    assert.deepEqual(sessionDraftsDb.getDrafts(userId), []);
  });
});

test('a queued turn is not consumed when its runtime settles before stop confirmation', { timeout: 6000 }, async () => {
  await withIsolatedDatabase(async (userId) => {
    const queuedMessage = { content: 'stopped input', options: { effort: 'high' }, attachments: [{ path: '/tmp/stopped.png' }] };
    sessionDraftsDb.saveDraft(userId, SESSION_ID, { text: '', queuedMessage });
    let entered!: () => void;
    let settleRun!: () => void;
    let stopping!: () => void;
    let finishStop!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const heldRun = new Promise<void>(resolve => { settleRun = resolve; });
    const stopEntered = new Promise<void>(resolve => { stopping = resolve; });
    const heldStop = new Promise<void>(resolve => { finishStop = resolve; });
    const runtime: ProviderRuntimeGateway = {
      ...createRuntime([]),
      run: async (provider, command, options, writer) => {
        if (command === queuedMessage.content) { entered(); await heldRun; return; }
        writer.send(createCompleteMessage({ provider, sessionId: String(options.sessionId), exitCode: 0 }));
      },
      abort: async () => { settleRun(); stopping(); await heldStop; return true; },
    };
    const queuedPass = dispatchQueuedMessages(runtime);
    await started;
    scheduledMessagesService.schedule({ userId, sessionId: SESSION_ID, content: 'scheduled interruption', scheduledFor: new Date(Date.now() - 1).toISOString() });
    const scheduledPass = dispatchDueScheduledMessages(runtime);
    try {
      await stopEntered;
      await new Promise<void>(resolve => setImmediate(resolve));
      const stored = sessionDraftsDb.getDrafts(userId)[0]?.queuedMessage as Record<string, unknown> | undefined;
      assert.ok(stored, 'runtime settlement cannot consume a queued input before its terminal result');
      assert.equal(stored.content, queuedMessage.content);
      assert.deepEqual(stored.attachments, queuedMessage.attachments);
      assert.deepEqual(stored.options, queuedMessage.options);
      assert.equal(stored.autoSend, false);
      finishStop();
      assert.equal(await queuedPass, 1);
      assert.equal(await scheduledPass, 1);
      assert.deepEqual(sessionDraftsDb.getDrafts(userId)[0]?.queuedMessage, { ...queuedMessage, autoSend: false });
    } finally {
      settleRun();
      finishStop();
      await Promise.allSettled([queuedPass, scheduledPass]);
    }
  });
});

for (const replacesQueue of [false, true]) {
  test(`successful completion preserves later ${replacesQueue ? 'queued input through immediate dispatch and composer text' : 'text-only composer changes'}`, { timeout: 6000 }, async () => {
    await withIsolatedDatabase(async (userId) => {
      const nextQueue = { content: 'later queued input', attachments: [{ path: '/tmp/later.txt' }] };
      sessionDraftsDb.saveDraft(userId, SESSION_ID, { text: '', queuedMessage: { content: 'claimed input' } });
      let successorStarted!: () => void;
      let releaseSuccessor!: () => void;
      const started = new Promise<void>(resolve => { successorStarted = resolve; });
      const held = new Promise<void>(resolve => { releaseSuccessor = resolve; });
      const commands: string[] = [];
      const runtime: ProviderRuntimeGateway = {
        ...createRuntime([]),
        run: async (provider, command, options, writer) => {
          commands.push(command);
          if (command === 'claimed input') {
            sessionDraftsDb.saveDraft(userId, SESSION_ID, {
              text: 'later composer text',
              ...(replacesQueue ? { queuedMessage: nextQueue } : {}),
            });
          } else {
            assert.equal(command, nextQueue.content);
            successorStarted();
            await held;
          }
          writer.send(createCompleteMessage({ provider, sessionId: String(options.sessionId), exitCode: 0 }));
        },
      };
      const dispatch = dispatchQueuedMessages(runtime);
      try {
        if (replacesQueue) {
          await Promise.race([started, dispatch.then(() => assert.fail('the successor must be dispatched immediately'))]);
          const draft = sessionDraftsDb.getDrafts(userId)[0];
          const queued = draft.queuedMessage as Record<string, unknown>;
          assert.equal(draft.text, 'later composer text');
          assert.deepEqual({ ...queued, claimRevision: undefined }, { ...nextQueue, autoSend: false, claimRevision: undefined });
          assert.equal(typeof queued.claimRevision, 'string');
          assert.equal(chatRunRegistry.isProcessing(SESSION_ID), true);
        }
      } finally {
        releaseSuccessor();
        assert.equal(await dispatch, 1);
      }
      assert.deepEqual(commands, replacesQueue ? ['claimed input', nextQueue.content] : ['claimed input']);
      assert.equal(sessionDraftsDb.getDrafts(userId)[0].text, 'later composer text');
      assert.equal(sessionDraftsDb.getDrafts(userId)[0].queuedMessage, null);
    });
  });
}

test('a due message interrupts a run in progress instead of failing', { timeout: 6000 }, async () => {
  await withIsolatedDatabase(async (userId) => {
    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'the schedule wins',
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    });
    const runs: RunCall[] = [];
    const aborts: string[] = [];
    let entered!: () => void;
    let release!: () => void;
    const running = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const runtime: ProviderRuntimeGateway = {
      ...createRuntime(runs, 'ok', aborts),
      run: async (provider, command, options, writer) => {
        if (command === 'already running') { entered(); await held; return; }
        runs.push({ provider, command, options });
        writer.send(createCompleteMessage({ provider, sessionId: String(options.sessionId), exitCode: 0 }));
      },
      abort: async (_provider, sessionId) => { aborts.push(sessionId); release(); return true; },
    };
    // Enter the real gateway so its preparation/runtime ownership is accurate.
    const active = runDetachedChatTurn({ sessionId: SESSION_ID, userId, content: 'already running' }, { runtime });
    await running;
    try {
      assert.equal(await dispatchDueScheduledMessages(runtime), 1);
      assert.deepEqual(aborts, [SESSION_ID]);
      assert.equal(runs.length, 1);
      assert.equal(runs[0].command, 'the schedule wins');
      assert.equal(scheduledMessagesDb.listForSession(userId, SESSION_ID)[0].status, 'sent');
    } finally {
      release();
      await active;
    }
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

test('draft-save admits idle sessions immediately outside HTTP scope and retains a same-session save during a long turn', { timeout: 6000 }, async () => {
  await withIsolatedDatabase(async userId => {
    const requestScope = new AsyncLocalStorage<string>();
    let started!: () => void;
    let release!: () => void;
    let secondStarted!: () => void;
    let thirdStarted!: () => void;
    const firstStarted = new Promise<void>(resolve => { started = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const second = new Promise<void>(resolve => { secondStarted = resolve; });
    const third = new Promise<void>(resolve => { thirdStarted = resolve; });
    const otherSessionId = `${SESSION_ID}-other`;
    sessionsDb.createAppSession(otherSessionId, 'claude', sessionsDb.getSessionById(SESSION_ID)!.project_path!, 'Independent session');
    const commands: string[] = [];
    const scopes: Array<string | undefined> = [];
    const runtime = {
      ...createRuntime([]),
      run: async (_provider: string, command: string, options: Record<string, unknown>, writer: ProviderRuntimeWriter) => {
        commands.push(command);
        scopes.push(requestScope.getStore());
        if (commands.length === 1) { started(); await held; }
        writer.send(createCompleteMessage({ provider: 'claude', sessionId: String(options.sessionId), exitCode: 0 }));
        if (commands.length === 2) secondStarted();
        if (commands.length === 3) thirdStarted();
      },
    } as never;
    initializeScheduledMessageDispatcher(runtime);
    await new Promise<void>(resolve => setImmediate(resolve));
    const due = scheduledMessagesService.schedule({ userId, sessionId: SESSION_ID, content: 'time-based remains independent', scheduledFor: new Date(Date.now() - 1).toISOString() });
    const { userRoutes } = await import('@/modules/user/index.js');
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => {
      Object.assign(request, { user: { id: userId } });
      requestScope.run('HTTP-save-request', next);
    });
    app.use('/user', userRoutes);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const save = async (content: string, scope = SESSION_ID) => {
      const response = await fetch(`http://127.0.0.1:${address.port}/user/drafts`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope, text: '', queuedMessage: { content, autoSend: true, options: { effort: 'high' } } }) });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { success: true });
    };
    try {
      await save('manual first');
      await firstStarted;
      await save('independent session', otherSessionId);
      await second;
      assert.deepEqual(commands, ['manual first', 'independent session'], 'an idle session must start before the long turn is released');
      await save('manual second');
      assert.deepEqual(commands, ['manual first', 'independent session']);
      release();
      await third;
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.deepEqual(commands, ['manual first', 'independent session', 'manual second']);
      assert.deepEqual(scopes, [undefined, undefined, undefined]);
      assert.equal(scheduledMessagesDb.listForSession(userId, SESSION_ID).find(row => row.id === due.id)?.status, 'pending');
      assert.equal(sessionDraftsDb.getDrafts(userId).length, 0);
    } finally {
      release();
      closeScheduledMessageDispatcher();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});

test('an old run terminal cannot suspend a newer run queue', async () => {
  await withIsolatedDatabase(async userId => {
    const old = chatRunRegistry.startRun({ appSessionId: SESSION_ID, provider: 'claude', providerSessionId: null, connection: null, userId });
    assert.ok(old);
    chatRunRegistry.clearAll();
    const current = chatRunRegistry.startRun({ appSessionId: SESSION_ID, provider: 'claude', providerSessionId: null, connection: null, userId });
    assert.ok(current);
    const queued = { content: 'new queue', autoSend: true };
    sessionDraftsDb.saveDraft(userId, SESSION_ID, { text: '', queuedMessage: queued });
    old.writer.send(createCompleteMessage({ provider: 'claude', sessionId: SESSION_ID, exitCode: 1 }));
    assert.equal(chatRunRegistry.getRun(SESSION_ID), current);
    assert.deepEqual(sessionDraftsDb.getDrafts(userId)[0].queuedMessage, queued);
  });
});



test('due runs block only their own session and queued turns wake after handback', { timeout: 5000 }, async () => {
  await withIsolatedDatabase(async userId => {
    const otherSession = 'other-scheduled-session';
    sessionsDb.createAppSession(otherSession, 'claude', '/workspace/other');
    scheduledMessagesService.schedule({ userId, sessionId: SESSION_ID, content: 'long scheduled run', scheduledFor: new Date(Date.now() - 1000).toISOString() });
    sessionDraftsDb.saveDraft(userId, SESSION_ID, { text: '', queuedMessage: { content: 'same session next' } });
    sessionDraftsDb.saveDraft(userId, otherSession, { text: '', queuedMessage: { content: 'unrelated queue' } });
    const entered = gate();
    const handback = gate();
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
        } else writer.send(createCompleteMessage({ provider: 'claude', exitCode: 0 }));
      },
    } as ProviderRuntimeGateway;
    initializeScheduledMessageDispatcher(runtime);
    try {
      await entered.promise;
      await flushDispatcher();
      assert.equal(isChatRunInFlight(SESSION_ID), true);
      assert.deepEqual(calls, ['long scheduled run', 'unrelated queue']);
      assert.equal(await dispatchQueuedMessages(runtime, false), 0);
      assert.equal((sessionDraftsDb.getDrafts(userId)[0].queuedMessage as { content: string }).content, 'same session next');
      handback.resolve();
      await flushDispatcher();
      assert.deepEqual(calls, ['long scheduled run', 'unrelated queue', 'same session next']);
      assert.equal(sessionDraftsDb.getDrafts(userId).length, 0);
    } finally {
      handback.resolve();
      await flushDispatcher();
    }
  });
});


test('workspace admission busy preserves the exact draft without self-waking and can retry once', { timeout: 5000 }, async () => {
  await withIsolatedDatabase(async userId => {
    const queuedMessage = { content: 'retry after workspace handback', options: { workspaceMode: 'isolated', model: 'claude-opus-5' }, attachments: [] };
    sessionDraftsDb.saveDraft(userId, SESSION_ID, { text: 'new draft text', queuedMessage });
    let calls = 0;
    let busy = true;
    let settled = 0;
    const remove = onChatRunSettled(() => { settled++; });
    const runtime = {
      ...createRuntime([]),
      run: async (_provider, _command, _options, writer) => {
        calls++;
        if (busy) {
          writer.send({ ...createCompleteMessage({ provider: 'claude', exitCode: 1 }), workspaceAdmissionRejected: true });
          throw Object.assign(new Error('Workspace reserved by synchronization'), { code: 'WORKSPACE_BUSY', workspaceAdmissionRejected: true });
        }
        writer.send(createCompleteMessage({ provider: 'claude', exitCode: 0 }));
      },
    } as ProviderRuntimeGateway;
    initializeScheduledMessageDispatcher(runtime);
    try {
      await flushDispatcher();
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
    } finally { remove(); }
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


test('interactive completion wakes a queued turn only after runtime teardown', { timeout: 5000 }, async () => {
  await withIsolatedDatabase(async userId => {
    const entered = gate();
    const teardown = gate();
    const calls: string[] = [];
    const runtime = {
      ...createRuntime([]),
      run: async (_provider: string, command: string, _options: unknown, writer: Parameters<ProviderRuntimeGateway['run']>[3]) => {
        calls.push(command);
        if (command === 'interactive original') {
          writer.send({ kind: 'complete', provider: 'claude', sessionId: SESSION_ID, exitCode: 0 });
          entered.resolve();
          await teardown.promise;
        } else writer.send(createCompleteMessage({ provider: 'claude', exitCode: 0 }));
      },
    } as ProviderRuntimeGateway;
    const original = runDetachedChatTurn({ sessionId: SESSION_ID, userId, content: 'interactive original' }, { runtime });
    await entered.promise;
    sessionDraftsDb.saveDraft(userId, SESSION_ID, { text: '', queuedMessage: { content: 'queued continuation' } });
    initializeScheduledMessageDispatcher(runtime);
    try {
      await flushDispatcher();
      assert.deepEqual(calls, ['interactive original']);
      teardown.resolve();
      await original;
      await flushDispatcher();
      assert.deepEqual(calls, ['interactive original', 'queued continuation']);
      assert.equal(sessionDraftsDb.getDrafts(userId).length, 0);
    } finally { teardown.resolve(); await original; }
  });
});

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function flushDispatcher(): Promise<void> {
  await new Promise<void>(resolve => { setImmediate(resolve); });
  await new Promise<void>(resolve => { setImmediate(resolve); });
}
