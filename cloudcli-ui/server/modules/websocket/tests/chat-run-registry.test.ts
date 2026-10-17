import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

/**
 * Minimal stand-in for a websocket connection: collects every JSON frame the
 * gateway writer forwards so assertions can inspect the outbound protocol.
 */
class FakeConnection {
  readyState = 1; // WS_OPEN_STATE
  frames: Array<Record<string, unknown>> = [];

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }
}

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'chat-run-registry-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    connectedClients.clear();
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

test('live events carry the run id, use the app session id, and are sequenced', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-1', 'claude', '/workspace/demo');
    const connection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-1',
      provider: 'claude',
      providerSessionId: null,
      connection,
      userId: 'user-1',
    });
    assert.ok(run);
    assert.equal(typeof run.runId, 'string');
    assert.notEqual(run.runId, '');

    run.writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: 'provider-id-9', content: 'hello' });
    run.writer.send({ kind: 'text', provider: 'claude', sessionId: 'provider-id-9', content: 'hello world' });

    assert.equal(connection.frames.length, 2);
    assert.equal(connection.frames[0]?.sessionId, 'app-run-1');
    assert.equal(connection.frames[0]?.seq, 1);
    assert.equal(connection.frames[1]?.sessionId, 'app-run-1');
    assert.equal(connection.frames[1]?.seq, 2);
    assert.deepEqual(connection.frames.map((frame) => frame.runId), [run.runId, run.runId]);
  });
});

test('session_created is swallowed and persisted as the provider-id mapping', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-run-2', 'cursor', '/workspace/demo');
    const connection = new FakeConnection();
    connectedClients.add(connection as never);
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-2',
      provider: 'cursor',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(run);

    run.writer.send({
      kind: 'session_created',
      provider: 'cursor',
      sessionId: 'cursor-native-7',
      newSessionId: 'cursor-native-7',
    });

    // The upsert is broadcast without blocking the run: resolving the owning
    // project's display name is async, so let that settle before asserting.
    await new Promise((resolve) => { setTimeout(resolve, 0); });

    // The provider-native event itself is never forwarded...
    const sessionUpserts = connection.frames.filter((frame) => frame.kind === 'session_upserted');
    assert.equal(sessionUpserts.length, 1);
    assert.equal(sessionUpserts[0]?.sessionId, 'app-run-2');
    assert.equal(sessionUpserts[0]?.providerSessionId, 'cursor-native-7');
    // ...but the canonical mapping is recorded and persisted in the database.
    assert.equal(run.providerSessionId, 'cursor-native-7');
    assert.equal(sessionsDb.getSessionById('app-run-2')?.provider_session_id, 'cursor-native-7');
  });
});

test('complete marks the run finished and duplicate completes are dropped', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-3', 'codex', '/workspace/demo');
    const connection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-3',
      provider: 'codex',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(run);

    run.writer.send({ kind: 'complete', provider: 'codex', sessionId: 'native-3', exitCode: 0 });
    // Late duplicate from a killed runtime's exit handler.
    run.writer.send({ kind: 'complete', provider: 'codex', sessionId: 'native-3', exitCode: 1 });

    const completes = connection.frames.filter((frame) => frame.kind === 'complete');
    assert.equal(completes.length, 1);
    assert.equal(completes[0]?.actualSessionId, 'app-run-3');
    assert.equal(chatRunRegistry.isProcessing('app-run-3'), false);

    // completeRun is also a no-op once the run already completed.
    chatRunRegistry.completeRun('app-run-3', { exitCode: 1 });
    assert.equal(connection.frames.filter((frame) => frame.kind === 'complete').length, 1);
  });
});

test('model_stopped keeps the run processing until workspace cleanup completes', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-stop', 'claude', '/workspace/demo');
    const connection = new FakeConnection();
    const input = {
      appSessionId: 'app-run-stop',
      provider: 'claude' as const,
      providerSessionId: null,
      connection,
      userId: null,
    };
    const run = chatRunRegistry.startRun(input);
    assert.ok(run);
    assert.equal(run.modelStopped, false);

    run.writer.send({ kind: 'status', provider: 'claude', text: 'model_stopped' });

    assert.equal(run.modelStopped, true);
    assert.equal(chatRunRegistry.isProcessing('app-run-stop'), true);
    assert.equal(chatRunRegistry.startRun(input), null);
    assert.deepEqual(connection.frames.map((frame) => frame.kind), ['status']);
    assert.equal(connection.frames[0]?.text, 'model_stopped');
    assert.equal(connection.frames[0]?.runId, run.runId);

    // Only the cleanup owner's terminal event releases the session.
    chatRunRegistry.completeRun('app-run-stop', { exitCode: 0, aborted: true });

    assert.equal(chatRunRegistry.isProcessing('app-run-stop'), false);
    assert.deepEqual(connection.frames.map((frame) => frame.kind), ['status', 'complete']);
    assert.equal(connection.frames[1]?.aborted, true);
    assert.equal(connection.frames[1]?.runId, run.runId);
  });
});

test('a finished run\'s safety net cannot complete the session\'s next run', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-9', 'codex', '/workspace/demo');
    const connection = new FakeConnection();

    const firstRun = chatRunRegistry.startRun({
      appSessionId: 'app-run-9',
      provider: 'codex',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(firstRun);
    firstRun.writer.send({ kind: 'complete', provider: 'codex', sessionId: 'native-9', exitCode: 0 });

    // A queued message starts the next run before the first run's runtime
    // promise settles (the chat handler's `finally` hasn't executed yet).
    const secondRun = chatRunRegistry.startRun({
      appSessionId: 'app-run-9',
      provider: 'codex',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(secondRun);

    // First run's safety net fires late: it must not touch the new run.
    chatRunRegistry.completeRunIfCurrent(firstRun, { exitCode: 1 });
    assert.equal(chatRunRegistry.isProcessing('app-run-9'), true);
    assert.equal(connection.frames.filter((frame) => frame.kind === 'complete').length, 1);

    // The second run's own safety net still works while it is current.
    chatRunRegistry.completeRunIfCurrent(secondRun, { exitCode: 1 });
    assert.equal(chatRunRegistry.isProcessing('app-run-9'), false);
    assert.equal(connection.frames.filter((frame) => frame.kind === 'complete').length, 2);
  });
});

test('listRunningRuns exposes run identity and model-stop state only for active sessions', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-7', 'claude', '/workspace/demo');
    sessionsDb.createAppSession('app-run-8', 'codex', '/workspace/demo');
    const connection = new FakeConnection();

    const completedRun = chatRunRegistry.startRun({
      appSessionId: 'app-run-7',
      provider: 'claude',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(completedRun);

    const runningRun = chatRunRegistry.startRun({
      appSessionId: 'app-run-8',
      provider: 'codex',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(runningRun);

    chatRunRegistry.completeRun('app-run-7', { exitCode: 0 });

    assert.deepEqual(chatRunRegistry.listRunningRuns(), [{
      sessionId: 'app-run-8',
      runId: runningRun.runId,
      provider: 'codex',
      startedAt: runningRun.startedAt,
      lastSeq: 0,
      modelStopped: false,
    }]);

    runningRun.writer.send({ kind: 'status', provider: 'codex', text: 'model_stopped' });

    assert.deepEqual(chatRunRegistry.listRunningRuns(), [{
      sessionId: 'app-run-8',
      runId: runningRun.runId,
      provider: 'codex',
      startedAt: runningRun.startedAt,
      lastSeq: 1,
      modelStopped: true,
    }]);

    chatRunRegistry.completeRun('app-run-8', { exitCode: 0, aborted: true });
    assert.deepEqual(chatRunRegistry.listRunningRuns(), []);
  });
});

test('replayEvents returns only events after the requested seq', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-4', 'claude', '/workspace/demo');
    const connection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-4',
      provider: 'claude',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(run);

    run.writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: 'x', content: 'a' });
    run.writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: 'x', content: 'b' });
    run.writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: 'x', content: 'c' });

    const replayed = chatRunRegistry.replayEvents('app-run-4', 1);
    assert.deepEqual(replayed.map((event) => event.content), ['b', 'c']);
    assert.deepEqual(replayed.map((event) => event.seq), [2, 3]);
    assert.deepEqual(replayed.map((event) => event.runId), [run.runId, run.runId]);
  });
});

test('each turn has a new run id and replays only that turn with session-monotonic seq', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-turns', 'claude', '/workspace/demo');
    const connection = new FakeConnection();
    const input = {
      appSessionId: 'app-run-turns',
      provider: 'claude' as const,
      providerSessionId: null,
      connection,
      userId: null,
    };
    const firstRun = chatRunRegistry.startRun(input);
    assert.ok(firstRun);
    const replayEpoch = chatRunRegistry.getReplayEpoch('app-run-turns');
    firstRun.writer.send({ kind: 'stream_delta', provider: 'claude', content: 'first-a' });
    firstRun.writer.send({ kind: 'stream_delta', provider: 'claude', content: 'first-b' });
    chatRunRegistry.completeRun('app-run-turns', { exitCode: 0 });

    const secondRun = chatRunRegistry.startRun(input);
    assert.ok(secondRun);
    assert.notEqual(secondRun.runId, firstRun.runId);
    secondRun.writer.send({ kind: 'stream_delta', provider: 'claude', content: 'second-a' });
    secondRun.writer.send({ kind: 'stream_delta', provider: 'claude', content: 'second-b' });

    assert.deepEqual(connection.frames.map((frame) => frame.seq), [1, 2, 3, 4, 5]);
    assert.deepEqual(connection.frames.map((frame) => frame.runId), [
      firstRun.runId,
      firstRun.runId,
      firstRun.runId,
      secondRun.runId,
      secondRun.runId,
    ]);
    const replayed = chatRunRegistry.replayEvents('app-run-turns', 0);
    assert.deepEqual(replayed.map((event) => event.content), ['second-a', 'second-b']);
    assert.deepEqual(replayed.map((event) => event.seq), [4, 5]);
    assert.deepEqual(replayed.map((event) => event.runId), [secondRun.runId, secondRun.runId]);
    assert.deepEqual(chatRunRegistry.replayEvents('app-run-turns', 4).map((event) => event.content), ['second-b']);
    assert.equal(chatRunRegistry.getReplayEpoch('app-run-turns'), replayEpoch);
    assert.deepEqual(connection.frames.map((frame) => frame.replayEpoch), Array(5).fill(replayEpoch));
  });
});

test('attachConnection adds a socket without cutting off the ones already watching', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-5', 'opencode', '/workspace/demo');
    const firstConnection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-5',
      provider: 'opencode',
      providerSessionId: null,
      connection: firstConnection,
      userId: null,
    });
    assert.ok(run);

    run.writer.send({ kind: 'stream_delta', provider: 'opencode', sessionId: 'o', content: 'before' });

    // A second tab on the same session subscribes mid-run.
    const secondConnection = new FakeConnection();
    assert.equal(chatRunRegistry.attachConnection('app-run-5', secondConnection), true);
    run.writer.send({ kind: 'stream_delta', provider: 'opencode', sessionId: 'o', content: 'after' });

    assert.deepEqual(firstConnection.frames.map((frame) => frame.content), ['before', 'after']);
    assert.deepEqual(secondConnection.frames.map((frame) => frame.content), ['after']);
  });
});

test('a refreshed tab stops receiving once its old socket is closed', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-5b', 'opencode', '/workspace/demo');
    const staleConnection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-5b',
      provider: 'opencode',
      providerSessionId: null,
      connection: staleConnection,
      userId: null,
    });
    assert.ok(run);

    // The page reloads: the original socket closes and the fresh one subscribes.
    staleConnection.readyState = 3;
    const reloadedConnection = new FakeConnection();
    assert.equal(chatRunRegistry.attachConnection('app-run-5b', reloadedConnection), true);

    run.writer.send({ kind: 'stream_delta', provider: 'opencode', sessionId: 'o', content: 'after' });
    run.writer.send({ kind: 'stream_delta', provider: 'opencode', sessionId: 'o', content: 'later' });

    assert.deepEqual(staleConnection.frames, []);
    assert.deepEqual(reloadedConnection.frames.map((frame) => frame.content), ['after', 'later']);
  });
});

test('startRun rejects a second concurrent run for the same session', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-6', 'opencode', '/workspace/demo');
    const connection = new FakeConnection();
    const first = chatRunRegistry.startRun({
      appSessionId: 'app-run-6',
      provider: 'opencode',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(first);

    const second = chatRunRegistry.startRun({
      appSessionId: 'app-run-6',
      provider: 'opencode',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.equal(second, null);

    // After the run finishes a new one is allowed again.
    chatRunRegistry.completeRun('app-run-6', { exitCode: 0 });
    const third = chatRunRegistry.startRun({
      appSessionId: 'app-run-6',
      provider: 'opencode',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(third);
  });
});

test('idle session subscribers receive consecutive detached turns with increasing replay cursors', async () => {
  await withIsolatedDatabase(() => {
    const first = new FakeConnection();
    const second = new FakeConnection();
    chatRunRegistry.attachConnection('queued-channel', first);
    chatRunRegistry.attachConnection('queued-channel', second);
    const replayEpoch = chatRunRegistry.getReplayEpoch('queued-channel');
    const start = () => chatRunRegistry.startRun({
      appSessionId: 'queued-channel', provider: 'claude', providerSessionId: null,
      connection: null, userId: null,
    });
    const run = start();
    assert.ok(run);
    run.writer.send({ kind: 'text', role: 'user', content: 'queued input' });
    run.writer.sendComplete({ exitCode: 0 });
    const cursor = run.lastSeq;
    const next = start();
    assert.ok(next);
    assert.notEqual(next.runId, run.runId);
    next.writer.send({ kind: 'text', role: 'user', content: 'next queued input' });
    assert.deepEqual(first.frames, second.frames);
    assert.deepEqual(first.frames.map((frame) => frame.seq), [1, 2, 3]);
    assert.deepEqual(first.frames.map((frame) => frame.runId), [run.runId, run.runId, next.runId]);
    assert.deepEqual(first.frames.map((frame) => frame.replayEpoch), Array(3).fill(replayEpoch));
    assert.equal(chatRunRegistry.replayEvents('queued-channel', cursor)[0]?.content, 'next queued input');
    assert.equal(chatRunRegistry.replayEvents('queued-channel', 999)[0]?.content, 'next queued input');
    chatRunRegistry.removeConnection(first);
    next.writer.sendComplete({ exitCode: 0 });
    assert.equal(first.frames.length, 3);
    assert.equal(second.frames.length, 4);
    assert.equal(second.frames[3]?.runId, next.runId);
    assert.equal(second.frames[3]?.replayEpoch, replayEpoch);
  });
});

test('idle subscription survives replay eviction and an older eviction cannot remove a newer run', async (context) => {
  await withIsolatedDatabase(() => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const connection = new FakeConnection();
    chatRunRegistry.attachConnection('retained-channel', connection);
    const replayEpoch = chatRunRegistry.getReplayEpoch('retained-channel');
    const start = () => chatRunRegistry.startRun({
      appSessionId: 'retained-channel', provider: 'claude', providerSessionId: null,
      connection: null, userId: null,
    });
    const first = start();
    assert.ok(first);
    first.writer.sendComplete({ exitCode: 0 });
    context.mock.timers.tick(60_000);
    const second = start();
    assert.ok(second);
    second.writer.sendComplete({ exitCode: 0 });
    context.mock.timers.tick(4 * 60_000);
    assert.equal(chatRunRegistry.getRun('retained-channel'), second);
    context.mock.timers.tick(60_000);
    assert.equal(chatRunRegistry.getRun('retained-channel'), undefined);
    const third = start();
    assert.ok(third);
    third.writer.sendComplete({ exitCode: 0 });
    assert.deepEqual(connection.frames.map((frame) => frame.seq), [1, 2, 3]);
    assert.deepEqual(connection.frames.map((frame) => frame.runId), [first.runId, second.runId, third.runId]);
    assert.equal(chatRunRegistry.getReplayEpoch('retained-channel'), replayEpoch);
    assert.deepEqual(connection.frames.map((frame) => frame.replayEpoch), Array(3).fill(replayEpoch));
  });
});

test('evicting an unobserved channel changes its replay epoch before numeric cursors can be reused', async (context) => {
  await withIsolatedDatabase(() => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const start = () => chatRunRegistry.startRun({
      appSessionId: 'rebuilt-channel', provider: 'claude', providerSessionId: null,
      connection: null, userId: null,
    });
    const first = start();
    assert.ok(first);
    first.writer.sendComplete({ exitCode: 0 });
    const previousEpoch = chatRunRegistry.getReplayEpoch('rebuilt-channel');
    context.mock.timers.tick(5 * 60_000);
    assert.equal(chatRunRegistry.getRun('rebuilt-channel'), undefined);
    const next = start();
    assert.ok(next);
    next.writer.send({ kind: 'text', role: 'user', content: 'do not miss the new input' });
    assert.equal(next.lastSeq, 1);
    assert.notEqual(chatRunRegistry.getReplayEpoch('rebuilt-channel'), previousEpoch);
    assert.equal(next.events[0]?.replayEpoch, chatRunRegistry.getReplayEpoch('rebuilt-channel'));
    assert.notEqual(next.events[0]?.replayEpoch, previousEpoch);
  });
});

test('clearAll starts a new replay epoch when a session channel is recreated', async () => {
  await withIsolatedDatabase(() => {
    const connection = new FakeConnection();
    const start = () => chatRunRegistry.startRun({
      appSessionId: 'cleared-channel', provider: 'claude', providerSessionId: null,
      connection, userId: null,
    });
    const first = start();
    assert.ok(first);
    first.writer.sendComplete({ exitCode: 0 });
    const previousEpoch = chatRunRegistry.getReplayEpoch('cleared-channel');

    chatRunRegistry.clearAll();

    const next = start();
    assert.ok(next);
    next.writer.send({ kind: 'text', role: 'user', content: 'new registry lifetime' });
    const nextEpoch = chatRunRegistry.getReplayEpoch('cleared-channel');
    assert.notEqual(nextEpoch, previousEpoch);
    assert.notEqual(next.runId, first.runId);
    assert.deepEqual(connection.frames.map((frame) => frame.seq), [1, 1]);
    assert.deepEqual(connection.frames.map((frame) => frame.replayEpoch), [previousEpoch, nextEpoch]);
    assert.deepEqual(chatRunRegistry.replayEvents('cleared-channel', 0).map((event) => event.content), ['new registry lifetime']);
  });
});

test('completed-run late output cannot reach the shared audience or change the next run cursor', async () => {
  await withIsolatedDatabase(() => {
    const connection = new FakeConnection();
    const start = () => chatRunRegistry.startRun({
      appSessionId: 'late-output-channel', provider: 'claude', providerSessionId: null,
      connection, userId: null,
    });
    const first = start();
    assert.ok(first);
    first.writer.sendComplete({ exitCode: 0 });
    const next = start();
    assert.ok(next);
    first.writer.send({ kind: 'text', content: 'stale output' });
    first.writer.send({ kind: 'status', text: 'model_stopped' });
    first.writer.sendComplete({ exitCode: 1, aborted: true });
    next.writer.send({ kind: 'text', content: 'current output' });

    assert.deepEqual(connection.frames.map((frame) => frame.kind), ['complete', 'text']);
    assert.deepEqual(connection.frames.map((frame) => frame.seq), [1, 2]);
    assert.deepEqual(connection.frames.map((frame) => frame.runId), [first.runId, next.runId]);
    assert.deepEqual(chatRunRegistry.replayEvents('late-output-channel', 0).map((event) => event.content), ['current output']);
    assert.equal(next.modelStopped, false);
    assert.equal(chatRunRegistry.isProcessing('late-output-channel'), true);
  });
});

test('completed-run late session ids cannot overwrite the next run provider mapping', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('late-mapping-channel', 'claude', '/workspace/demo');
    const connection = new FakeConnection();
    const start = () => chatRunRegistry.startRun({
      appSessionId: 'late-mapping-channel', provider: 'claude', providerSessionId: null,
      connection, userId: null,
    });
    const first = start();
    assert.ok(first);
    first.writer.setSessionId('native-previous');
    first.writer.sendComplete({ exitCode: 0 });
    const next = start();
    assert.ok(next);
    next.writer.setSessionId('native-current');

    first.writer.send({ kind: 'session_created', sessionId: 'native-stale-event' });
    assert.equal(sessionsDb.getSessionById('late-mapping-channel')?.provider_session_id, 'native-current');
    first.writer.setSessionId('native-stale-setter');
    assert.equal(sessionsDb.getSessionById('late-mapping-channel')?.provider_session_id, 'native-current');

    // Let the current run's nonblocking mapping broadcast settle before closing its database.
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    assert.equal(chatRunRegistry.getRun('late-mapping-channel'), next);
    assert.equal(next.providerSessionId, 'native-current');
  });
});
