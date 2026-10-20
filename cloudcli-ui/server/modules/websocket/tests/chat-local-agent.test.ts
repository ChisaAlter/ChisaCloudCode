import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test, { after, mock } from 'node:test';

import { createCompleteMessage, WORKSPACES_ROOT } from '@/shared/index.js';
import type { LLMProvider } from '@/shared/types.js';

// Provider imports open SQLite eagerly. Isolate that first connection as well.
const originalDatabasePath = process.env.DATABASE_PATH;
const bootstrapDirectory = await mkdtemp(path.join(path.resolve(WORKSPACES_ROOT), '.chisa-chat-isolation-bootstrap-'));
process.env.DATABASE_PATH = path.join(bootstrapDirectory, 'auth.db');
await writeFile(process.env.DATABASE_PATH, '');
const { closeConnection, initializeDatabase, sessionDraftsDb, sessionsDb, userDb } = await import('@/modules/database/index.js');
const { providerModelsService, sessionsService } = await import('@/modules/providers/index.js');
const { chatRunRegistry } = await import('@/modules/websocket/services/chat-run-registry.service.js');
const { handleChatConnection, runDetachedChatTurn } = await import('@/modules/websocket/services/chat-websocket.service.js');
const { connectedClients } = await import('@/modules/websocket/services/websocket-state.service.js');
after(async () => {
  closeConnection();
  if (originalDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = originalDatabasePath;
  assert.equal(path.dirname(bootstrapDirectory), path.resolve(WORKSPACES_ROOT));
  await rm(bootstrapDirectory, { recursive: true, force: true });
});

const SESSION_ID = 'private-workspace-chat-session';
type RpcRequest = Record<string, unknown>;

function createSocket() {
  const socket = new EventEmitter() as EventEmitter & { readyState: number; frames: Array<Record<string, unknown>>; send(data: string): void };
  socket.readyState = 1;
  socket.frames = [];
  socket.send = data => { const frame = JSON.parse(data) as Record<string, unknown>; if (frame.kind !== "chat_run_status") socket.frames.push(frame); };
  return socket;
}

async function withGateway(
  runTest: (context: {
    cwd: string;
    socket: ReturnType<typeof createSocket>;
    requests: RpcRequest[];
    aborts: string[];
    runs: string[];
    dependencies: Parameters<typeof handleChatConnection>[2];
    frame(data: RpcRequest): Promise<void>;
  }) => Promise<void>,
  provider: 'claude' | 'codex' = 'claude',
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const cwd = await mkdtemp(path.join(path.resolve(WORKSPACES_ROOT), '.chisa-chat-isolation-qa-'));
  await writeFile(path.join(cwd, '.chisa-bridge.json'), JSON.stringify({ protocol: 1, port: 19081, token: 'fixture-capability', bindingEpoch: 'fixture-epoch', localAgent: true }));
  const transcript = path.join(cwd, 'transcript.jsonl');
  await writeFile(transcript, [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-a' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'first' } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-a' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-b' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'second' } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-b' } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');

  closeConnection();
  process.env.DATABASE_PATH = path.join(cwd, 'auth.db');
  await writeFile(process.env.DATABASE_PATH, '');
  await initializeDatabase();
  const now = new Date().toISOString();
  sessionsDb.createSession(SESSION_ID, provider, cwd, 'Private workspace', now, now, transcript);
  const socket = createSocket();
  const requests: RpcRequest[] = [];
  const aborts: string[] = [];
  const runs: string[] = [];
  // An offline private workspace must not affect chat dispatch or abort.
  mock.method(globalThis, 'fetch', async (_input: unknown, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)) as RpcRequest);
    throw new Error('Private workspace transport must not be queried by chat');
  });
  const dependencies: Parameters<typeof handleChatConnection>[2] = {
    runtime: {
      hasRuntime: () => true,
      run: async (_provider, command, _options, writer) => {
        runs.push(command);
        writer.send(createCompleteMessage({ provider: _provider, exitCode: 0 }));
      },
      abort: async (_provider, sessionId) => { aborts.push(sessionId); return true; },
      resolveToolApproval: () => {},
      getPendingApprovalsForSession: () => [],
    },
  };
  handleChatConnection(socket as never, { user: { id: 1 } } as never, dependencies);
  try {
    await runTest({
      cwd, socket, requests, aborts, runs, dependencies,
      frame: async data => {
        const listener = socket.listeners('message')[0];
        assert.ok(listener);
        await listener(JSON.stringify(data));
      },
    });
    assert.deepEqual(requests, [], 'Chat must not discover, inspect or stop private agents');
    assert.doesNotMatch(JSON.stringify(socket.frames), /\bpi\b|local[_ -]agent|windows|native|delegate/i);
  } finally {
    mock.restoreAll();
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    assert.equal(path.dirname(cwd), path.resolve(WORKSPACES_ROOT));
    await rm(cwd, { recursive: true, force: true });
  }
}

function startRun(socket: ReturnType<typeof createSocket>, provider: 'claude' | 'codex' = 'claude') {
  const run = chatRunRegistry.startRun({ appSessionId: SESSION_ID, provider, providerSessionId: null, connection: socket as never, userId: 1 });
  assert.ok(run);
  return run;
}

/** Reserve through dispatch so stop tests exercise a genuinely started provider. */
async function withActiveRuntime(
  frame: (data: RpcRequest) => Promise<void>,
  dependencies: Parameters<typeof handleChatConnection>[2],
  runTest: (run: NonNullable<ReturnType<typeof chatRunRegistry.getRun>>) => Promise<void>,
): Promise<void> {
  let entered!: () => void;
  let release!: () => void;
  const running = new Promise<void>(resolve => { entered = resolve; });
  const settlement = new Promise<void>(resolve => { release = resolve; });
  const originalRun = dependencies.runtime.run;
  const runtimeMock = mock.method(dependencies.runtime, 'run', async (...args: Parameters<typeof originalRun>) => {
    if (args[1] === 'fixture active turn') {
      entered();
      await settlement;
    } else {
      await originalRun(...args);
    }
  });
  const dispatch = frame({ type: 'chat.send', sessionId: SESSION_ID, content: 'fixture active turn' });
  await running;
  const run = chatRunRegistry.getRun(SESSION_ID);
  assert.ok(run);
  try {
    await runTest(run);
  } finally {
    release();
    await dispatch;
    runtimeMock.mock.restore();
  }
}

test('ordinary, edited and detached turns remain independent of private workspace agents', async () => {
  await withGateway(async ({ socket, frame, runs, dependencies }) => {
    const models: string[] = [];
    const rewinds: string[] = [];
    mock.method(providerModelsService, 'setSessionModel', () => { models.push('model'); });
    mock.method(providerModelsService, 'setSessionEffort', () => { models.push('effort'); });
    mock.method(sessionsService, 'rewindSessionForEdit', async () => { rewinds.push('rewind'); });
    const options = { model: 'changed-model', effort: 'high' };
    await frame({ type: 'chat.send', sessionId: SESSION_ID, content: 'ordinary', options });
    await frame({ type: 'chat.edit-send', sessionId: SESSION_ID, anchorId: 'turn-b', content: 'edited', options });
    const detached = await runDetachedChatTurn({ sessionId: SESSION_ID, userId: 1, content: 'detached', options }, dependencies);
    assert.equal(detached.started, true);
    assert.equal(detached.error, null);
    assert.deepEqual(runs, ['ordinary', 'edited', 'detached']);
    assert.deepEqual(models, ['model', 'effort', 'model', 'effort', 'model', 'effort']);
    assert.deepEqual(rewinds, ['rewind']);
    assert.equal(socket.frames.filter(frame => frame.kind === 'history_truncated').length, 1);
    assert.equal(socket.frames.some(frame => frame.kind === 'protocol_error'), false);
  }, 'codex');
});

test('scheduled interrupt aborts only the active cloud provider and starts its next turn', async () => {
  await withGateway(async ({ socket, frame, runs, dependencies, aborts }) => {
    await withActiveRuntime(frame, dependencies, async active => {
      const result = await runDetachedChatTurn({ sessionId: SESSION_ID, userId: 1, content: 'timer', interruptActiveRun: true }, dependencies);
      assert.equal(result.started, true);
      assert.equal(active.status, 'completed');
      assert.deepEqual(aborts, [SESSION_ID]);
      assert.deepEqual(runs, ['timer']);
      assert.equal(socket.frames.find(frame => frame.kind === 'complete')?.aborted, true);
    });
  });
});

test('a queued next Claude turn survives settlement of the previous runtime promise', async () => {
  await withGateway(async ({ socket, frame, dependencies }) => {
    let releaseFirst!: () => void;
    let releaseNext!: () => void;
    let enteredFirst!: () => void;
    let enteredNext!: () => void;
    const firstEntered = new Promise<void>(resolve => { enteredFirst = resolve; });
    const nextEntered = new Promise<void>(resolve => { enteredNext = resolve; });
    mock.method(dependencies.runtime, 'run', async (...[_provider, command, _options, writer]: Parameters<typeof dependencies.runtime.run>) => {
      if (command === 'first') {
        writer.send({ kind: 'complete', provider: 'claude', sessionId: SESSION_ID, exitCode: 0 });
        enteredFirst();
        await new Promise<void>(resolve => { releaseFirst = resolve; });
      } else {
        enteredNext();
        await new Promise<void>(resolve => { releaseNext = resolve; });
      }
    });
    const first = frame({ type: 'chat.send', sessionId: SESSION_ID, content: 'first' });
    await firstEntered;
    const next = frame({ type: 'chat.send', sessionId: SESSION_ID, content: 'queued' });
    await nextEntered;
    const current = chatRunRegistry.getRun(SESSION_ID);
    assert.ok(current);
    releaseFirst();
    await first;
    assert.equal(chatRunRegistry.getRun(SESSION_ID), current);
    assert.equal(current.status, 'running');
    assert.equal(socket.frames.filter(frame => frame.kind === 'complete').length, 1);
    releaseNext();
    await next;
  });
});

test('chat.abort stops only its provider even when the private workspace transport is unavailable', async () => {
  await withGateway(async ({ socket, frame, aborts, dependencies }) => {
    await withActiveRuntime(frame, dependencies, async () => {
      await frame({ type: 'chat.abort', sessionId: SESSION_ID });
      assert.deepEqual(aborts, [SESSION_ID]);
      const complete = socket.frames.find(frame => frame.kind === 'complete');
      assert.equal(complete?.exitCode, 0);
      assert.equal(complete?.aborted, true);
      assert.equal(socket.frames.some(frame => frame.kind === 'protocol_error'), false);
    });
  });
});

test('provider abort failures retain the actual error without falsely completing a run that has not settled', async () => {
  await withGateway(async ({ socket, frame, dependencies }) => {
    await withActiveRuntime(frame, dependencies, async active => {
      mock.method(dependencies.runtime, 'abort', async () => { throw new Error('Fixture provider abort failed'); });
      await frame({ type: 'chat.abort', sessionId: SESSION_ID });
      const error = socket.frames.find(frame => frame.kind === 'protocol_error');
      assert.equal(error?.code, 'CHAT_ABORT_FAILED');
      assert.equal(error?.error, 'Fixture provider abort failed');
      assert.equal(socket.frames.some(frame => frame.kind === 'complete'), false);
      assert.equal(chatRunRegistry.getRun(SESSION_ID), active);
      assert.equal(active.status, 'running');
    });
  });
});

test('a false provider abort is reported and the still-running task remains reserved', async () => {
  await withGateway(async ({ socket, frame, dependencies }) => {
    await withActiveRuntime(frame, dependencies, async active => {
      mock.method(dependencies.runtime, 'abort', async () => false);
      await frame({ type: 'chat.abort', sessionId: SESSION_ID });
      assert.equal(socket.frames.find(event => event.kind === 'protocol_error')?.code, 'CHAT_ABORT_FAILED');
      assert.equal(socket.frames.some(event => event.kind === 'complete'), false);
      assert.equal(chatRunRegistry.getRun(SESSION_ID), active);
      assert.equal(active.status, 'running');
      await frame({ type: 'chat.send', sessionId: SESSION_ID, content: 'must not start' });
      assert.equal([...socket.frames].reverse().find(event => event.kind === 'protocol_error')?.code, 'RUN_IN_PROGRESS');
    });
  });
});

for (const outcome of ['false', 'throws'] as const) {
  test(`an interrupt replacement is not started when provider cancellation ${outcome}`, async () => {
    await withGateway(async ({ socket, frame, dependencies, runs }) => {
      await withActiveRuntime(frame, dependencies, async active => {
        mock.method(dependencies.runtime, 'abort', async () => {
          if (outcome === 'throws') throw new Error('replacement stop failed');
          return false;
        });
        const result = await runDetachedChatTurn({ sessionId: SESSION_ID, userId: 1, content: 'replacement', interruptActiveRun: true }, dependencies);
        assert.equal(result.started, false);
        assert.match(result.error ?? '', outcome === 'throws' ? /replacement stop failed/ : /has not confirmed cancellation/);
        assert.deepEqual(runs, []);
        assert.equal(socket.frames.some(event => event.kind === 'complete'), false);
        assert.equal(chatRunRegistry.getRun(SESSION_ID), active);
        assert.equal(active.status, 'running');
      });
    });
  });
}

test('repeated stop during a Codex fork retains its run until the fork settles without aborting a stale provider handle', { timeout: 5000 }, async () => {
  await withGateway(async ({ socket, frame, dependencies, runs, aborts }) => {
    let entered!: () => void;
    let finishRewind!: () => void;
    const rewinding = new Promise<void>((resolve) => { entered = resolve; });
    const rewindComplete = new Promise<void>((resolve) => { finishRewind = resolve; });
    mock.method(sessionsService, 'resolveEditAnchor', async () => ({ supported: true, found: true, resumeThroughId: 'turn-a' }));
    mock.method(sessionsService, 'providerRewindsForEdit', () => true);
    mock.method(sessionsService, 'rewindSessionForEdit', async () => {
      entered();
      await rewindComplete;
    });
    // A completed provider handle from the previous turn must never be called
    // for the new run, which has not started its own runtime yet.
    mock.method(dependencies.runtime, 'abort', async (_provider: LLMProvider, sessionId: string) => {
      aborts.push(sessionId);
      return true;
    });
    const send = frame({ type: 'chat.edit-send', sessionId: SESSION_ID, anchorId: 'turn-b', content: 'not dispatched' });
    await rewinding;
    const active = chatRunRegistry.getRun(SESSION_ID);
    assert.ok(active);
    let stopSettled = false;
    const stop = frame({ type: 'chat.abort', sessionId: SESSION_ID }).then(() => { stopSettled = true; });
    let retrySettled = false;
    const retry = frame({ type: 'chat.abort', sessionId: SESSION_ID }).then(() => { retrySettled = true; });
    await Promise.resolve();
    assert.equal(stopSettled, false, 'Stop cannot acknowledge while the admitted fork can still mutate the session');
    assert.equal(retrySettled, false, 'A repeated stop shares the admitted fork settlement');
    assert.deepEqual(aborts, [], 'A previous completed provider handle does not own the admitted fork');
    assert.equal(socket.frames.some(event => event.kind === 'complete'), false);
    assert.equal(chatRunRegistry.getRun(SESSION_ID), active);
    assert.equal(active.status, 'running');
    await frame({ type: 'chat.send', sessionId: SESSION_ID, content: 'must wait for fork' });
    assert.equal(socket.frames.find(event => event.kind === 'protocol_error')?.code, 'RUN_IN_PROGRESS');
    assert.deepEqual(runs, []);
    finishRewind();
    await Promise.all([send, stop, retry]);
    assert.deepEqual(runs, []);
    assert.deepEqual(aborts, []);
    const complete = socket.frames.find(event => event.kind === 'complete');
    assert.equal(complete?.exitCode, 0);
    assert.equal(complete?.aborted, true);
    assert.equal(complete?.runId, active.runId);
    assert.equal(chatRunRegistry.getRun(SESSION_ID)?.status, 'completed');
    assert.equal(socket.frames.filter(event => event.kind === 'complete').length, 1);
    assert.equal(socket.frames.some(event => event.code === 'CHAT_ABORT_FAILED'), false);
    await frame({ type: 'chat.send', sessionId: SESSION_ID, content: 'after fork settled' });
    assert.deepEqual(runs, ['after fork settled']);
  }, 'codex');
});

test('an explicit stop retry reaches the active provider but waits for the original stop barrier', { timeout: 5000 }, async () => {
  await withGateway(async ({ socket, frame, dependencies, aborts }) => {
    await withActiveRuntime(frame, dependencies, async active => {
      let finishFirst!: (stopped: boolean) => void;
      const firstBarrier = new Promise<boolean>(resolve => { finishFirst = resolve; });
      mock.method(dependencies.runtime, 'abort', async (_provider: LLMProvider, sessionId: string) => {
        aborts.push(sessionId);
        return aborts.length === 1 ? firstBarrier : true;
      });
      let firstSettled = false;
      let retrySettled = false;
      const first = frame({ type: 'chat.abort', sessionId: SESSION_ID }).then(() => { firstSettled = true; });
      const retry = frame({ type: 'chat.abort', sessionId: SESSION_ID }).then(() => { retrySettled = true; });
      try {
        assert.deepEqual(aborts, [SESSION_ID, SESSION_ID], 'The explicit retry must reach the current provider');
        await Promise.resolve();
        assert.equal(firstSettled, false);
        assert.equal(retrySettled, false, 'Retry success alone cannot bypass the in-flight cleanup barrier');
        assert.equal(socket.frames.some(event => event.kind === 'complete'), false);
        assert.equal(chatRunRegistry.getRun(SESSION_ID), active);
        assert.equal(active.status, 'running');
        await frame({ type: 'chat.subscribe', sessions: [{ sessionId: SESSION_ID, runId: active.runId, lastSeq: 0 }] });
        assert.equal(socket.frames.find(event => event.kind === 'chat_subscribed')?.isProcessing, true);
        await frame({ type: 'chat.send', sessionId: SESSION_ID, content: 'must wait for stop barrier' });
        assert.equal(socket.frames.find(event => event.kind === 'protocol_error')?.code, 'RUN_IN_PROGRESS');

        finishFirst(true);
        await Promise.all([first, retry]);
        const completes = socket.frames.filter(event => event.kind === 'complete');
        assert.equal(completes.length, 1);
        assert.equal(completes[0]?.aborted, true);
        assert.equal(completes[0]?.runId, active.runId);
        assert.equal(active.status, 'completed');
      } finally {
        finishFirst(true);
        await Promise.all([first, retry]);
      }
    });
  }, 'codex');
});

test('a failed earlier stop cannot release a retry that still owns provider cleanup', { timeout: 5000 }, async () => {
  await withGateway(async ({ socket, frame, dependencies, aborts }) => {
    let enterRun!: () => void;
    let settleRun!: () => void;
    let finishFirst!: (stopped: boolean) => void;
    let finishRetry!: (stopped: boolean) => void;
    const running = new Promise<void>(resolve => { enterRun = resolve; });
    const runBarrier = new Promise<void>(resolve => { settleRun = resolve; });
    const firstBarrier = new Promise<boolean>(resolve => { finishFirst = resolve; });
    const retryBarrier = new Promise<boolean>(resolve => { finishRetry = resolve; });
    mock.method(dependencies.runtime, 'run', async () => { enterRun(); await runBarrier; });
    mock.method(dependencies.runtime, 'abort', async (_provider: LLMProvider, sessionId: string) => {
      aborts.push(sessionId);
      return aborts.length === 1 ? firstBarrier : retryBarrier;
    });
    const send = frame({ type: 'chat.send', sessionId: SESSION_ID, content: 'active Codex turn' });
    await running;
    const active = chatRunRegistry.getRun(SESSION_ID);
    assert.ok(active);
    const first = frame({ type: 'chat.abort', sessionId: SESSION_ID });
    const retry = frame({ type: 'chat.abort', sessionId: SESSION_ID });
    try {
      assert.deepEqual(aborts, [SESSION_ID, SESSION_ID]);
      finishFirst(false);
      await first;
      assert.equal(socket.frames.find(event => event.kind === 'protocol_error')?.code, 'CHAT_ABORT_FAILED');
      settleRun();
      await send;
      assert.equal(socket.frames.some(event => event.kind === 'complete'), false, 'Dispatch settlement must still defer to the pending retry');
      assert.equal(chatRunRegistry.getRun(SESSION_ID), active);
      assert.equal(active.status, 'running');
      await frame({ type: 'chat.send', sessionId: SESSION_ID, content: 'too early for retry cleanup' });
      assert.equal([...socket.frames].reverse().find(event => event.kind === 'protocol_error')?.code, 'RUN_IN_PROGRESS');

      finishRetry(true);
      await retry;
      const completes = socket.frames.filter(event => event.kind === 'complete');
      assert.equal(completes.length, 1);
      assert.equal(completes[0]?.aborted, true);
      assert.equal(active.status, 'completed');
    } finally {
      finishFirst(false);
      finishRetry(true);
      settleRun();
      await Promise.all([send, first, retry]);
    }
  }, 'codex');
});

test('runtime settlement during stop does not admit another turn before workspace release', async () => {
  await withGateway(async ({ socket, frame, dependencies }) => {
    let settleRun!: () => void;
    let runEntered!: () => void;
    let finishStop!: () => void;
    let stopEntered!: () => void;
    const running = new Promise<void>(resolve => { runEntered = resolve; });
    const stopping = new Promise<void>(resolve => { stopEntered = resolve; });
    mock.method(dependencies.runtime, 'run', async () => {
      runEntered();
      await new Promise<void>(resolve => { settleRun = resolve; });
    });
    mock.method(dependencies.runtime, 'abort', async () => {
      settleRun();
      stopEntered();
      await new Promise<void>(resolve => { finishStop = resolve; });
      return true;
    });
    const send = frame({ type: 'chat.send', sessionId: SESSION_ID, content: 'first' });
    await running;
    const stop = frame({ type: 'chat.abort', sessionId: SESSION_ID });
    await stopping;
    await send;
    assert.equal(socket.frames.some(event => event.kind === 'complete'), false);
    assert.equal(chatRunRegistry.getRun(SESSION_ID)?.status, 'running');
    await frame({ type: 'chat.send', sessionId: SESSION_ID, content: 'too early' });
    assert.equal(socket.frames.find(event => event.kind === 'protocol_error')?.code, 'RUN_IN_PROGRESS');
    finishStop();
    await stop;
    const complete = socket.frames.find(event => event.kind === 'complete');
    assert.equal(complete?.exitCode, 0);
    assert.equal(complete?.aborted, true);
    assert.equal(socket.frames.filter(event => event.kind === 'complete').length, 1);
  });
});

test('late provider abort settlement cannot complete the next Claude run', async () => {
  await withGateway(async ({ socket, frame, dependencies }) => {
    await withActiveRuntime(frame, dependencies, async original => {
      let releaseAbort!: (success: boolean) => void;
      let enteredAbort!: () => void;
      const entered = new Promise<void>(resolve => { enteredAbort = resolve; });
      mock.method(dependencies.runtime, 'abort', async () => {
        enteredAbort();
        return new Promise<boolean>(resolve => { releaseAbort = resolve; });
      });
      const abort = frame({ type: 'chat.abort', sessionId: SESSION_ID });
      await entered;
      original.writer.send({ kind: 'complete', provider: 'claude', sessionId: SESSION_ID, exitCode: 0, aborted: true });
      const next = startRun(socket);
      releaseAbort(true);
      await abort;
      assert.equal(chatRunRegistry.getRun(SESSION_ID), next);
      assert.equal(next.status, 'running');
      assert.equal(socket.frames.filter(frame => frame.kind === 'complete').length, 1);
    });
  });
});

test('subscribe discards a previous run watermark and reports the current model-stopped run before replay', async () => {
  await withGateway(async ({ socket, frame }) => {
    const previous = startRun(socket);
    previous.writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: SESSION_ID, content: 'previous turn' });
    previous.writer.send({ kind: 'complete', provider: 'claude', sessionId: SESSION_ID, exitCode: 0 });
    const current = startRun(socket);
    assert.notEqual(current.runId, previous.runId);
    current.writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: SESSION_ID, content: 'current turn' });
    current.writer.send({ kind: 'status', provider: 'claude', sessionId: SESSION_ID, text: 'model_stopped' });
    socket.frames.length = 0;

    await frame({ type: 'chat.subscribe', sessions: [{ sessionId: SESSION_ID, runId: previous.runId, lastSeq: 100 }] });

    assert.equal(socket.frames[0]?.kind, 'chat_subscribed');
    assert.equal(socket.frames[0]?.runId, current.runId);
    assert.equal(socket.frames[0]?.lastSeq, 4);
    assert.equal(socket.frames[0]?.isProcessing, true, 'The stopped model still holds its workspace until release');
    assert.equal(socket.frames[0]?.modelStopped, true);
    assert.deepEqual(socket.frames.slice(1).map(event => [event.kind, event.seq, event.runId]), [
      ['stream_delta', 3, current.runId],
      ['status', 4, current.runId],
    ]);
    assert.equal(socket.frames[1]?.content, 'current turn');
    assert.equal(socket.frames[2]?.text, 'model_stopped');
    assert.equal(socket.frames.some(event => event.content === 'previous turn'), false);
  });
});

test('subscribe with the current run id replays only events after that run watermark', async () => {
  await withGateway(async ({ socket, frame }) => {
    const current = startRun(socket);
    for (const content of ['already received', 'missed', 'also missed']) {
      current.writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: SESSION_ID, content });
    }
    socket.frames.length = 0;

    await frame({ type: 'chat.subscribe', sessions: [{ sessionId: SESSION_ID, runId: current.runId, lastSeq: 1 }] });

    assert.equal(socket.frames[0]?.kind, 'chat_subscribed');
    assert.equal(socket.frames[0]?.runId, current.runId);
    assert.equal(socket.frames[0]?.modelStopped, false);
    assert.deepEqual(socket.frames.slice(1).map(event => [event.content, event.seq, event.runId]), [
      ['missed', 2, current.runId],
      ['also missed', 3, current.runId],
    ]);
    socket.frames.length = 0;
    current.writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: SESSION_ID, content: 'live after subscribe' });
    assert.deepEqual(socket.frames.map(event => [event.content, event.seq, event.runId]), [
      ['live after subscribe', 4, current.runId],
    ]);
  });
});

test('an already-open idle conversation receives the queued user turn before thinking and completion', async () => {
  await withGateway(async ({ socket, frame, dependencies }) => {
    await frame({ type: 'chat.subscribe', sessions: [{ sessionId: SESSION_ID, lastSeq: 200 }] });
    assert.equal(socket.frames[0]?.isProcessing, false);
    mock.method(dependencies.runtime, 'run', async (...[_provider, _command, _options, writer]: Parameters<typeof dependencies.runtime.run>) => {
      writer.send({ kind: 'status', text: 'thinking', provider: 'claude' });
      writer.send({ kind: 'text', role: 'assistant', content: 'queued reply', provider: 'claude' });
      writer.send(createCompleteMessage({ provider: _provider, exitCode: 0 }));
    });
    const result = await runDetachedChatTurn({ sessionId: SESSION_ID, userId: 1, content: 'my queued input' }, dependencies);
    assert.deepEqual(result, { started: true, error: null });
    assert.deepEqual(socket.frames.slice(1).map(event => event.kind), ['text', 'status', 'text', 'complete']);
    assert.equal(socket.frames[1]?.role, 'user');
    assert.equal(socket.frames[1]?.content, 'my queued input');
    assert.match(String(socket.frames[1]?.id), /^local_detached_/);
    assert.equal(socket.frames.at(-1)?.success, true);
    assert.equal(chatRunRegistry.isProcessing(SESSION_ID), false);
    const cursor = socket.frames.at(-1)?.seq as number;
    await runDetachedChatTurn({ sessionId: SESSION_ID, userId: 1, content: 'my second queued input' }, dependencies);
    assert.equal(socket.frames[5]?.seq, cursor + 1);
    socket.emit('close');
    const received = socket.frames.length;
    await runDetachedChatTurn({ sessionId: SESSION_ID, userId: 1, content: 'after disconnect' }, dependencies);
    assert.equal(socket.frames.length, received);
  });
});

test('a detached provider failure or stop is returned even when the runtime resolves normally', async () => {
  await withGateway(async ({ dependencies }) => {
    const user = userDb.createUser('queue-terminal', 'fixture-hash');
    assert.equal(Number(user.id), 1);
    const queuedMessage = { content: 'retain queued input', attachments: [], options: { effort: 'high' } };
    for (const terminal of [{ exitCode: 1 }, { exitCode: 0, aborted: true }]) {
      sessionDraftsDb.saveDraft(1, SESSION_ID, { text: 'newer composer draft', queuedMessage });
      mock.method(dependencies.runtime, 'run', async (...[_provider, _command, _options, writer]: Parameters<typeof dependencies.runtime.run>) => {
        writer.send(createCompleteMessage({ provider: _provider, ...terminal }));
      });
      const result = await runDetachedChatTurn({ sessionId: SESSION_ID, userId: 1, content: 'retain this input' }, dependencies);
      assert.equal(result.started, true);
      assert.ok(result.error);
      assert.equal(chatRunRegistry.isProcessing(SESSION_ID), false);
      assert.deepEqual(sessionDraftsDb.getDrafts(1)[0]?.queuedMessage, { ...queuedMessage, autoSend: false });
      assert.equal(sessionDraftsDb.getDrafts(1)[0]?.text, 'newer composer draft');
    }
  });
});

test('stop pauses a pending queued input even when its previous run has already finished', async () => {
  await withGateway(async ({ socket, frame }) => {
    const user = userDb.createUser('queue-stop', 'fixture-hash');
    assert.equal(Number(user.id), 1);
    const queuedMessage = { content: 'keep my input', attachments: [{ path: '/fixture/file.txt' }], options: { effort: 'high' } };
    sessionDraftsDb.saveDraft(1, SESSION_ID, { text: 'newer composer draft', queuedMessage });
    await frame({ type: 'chat.abort', sessionId: SESSION_ID });
    assert.equal(socket.frames.find(event => event.kind === 'protocol_error')?.code, 'NO_ACTIVE_RUN');
    assert.deepEqual(sessionDraftsDb.getDrafts(1)[0]?.queuedMessage, { ...queuedMessage, autoSend: false });
    assert.equal(sessionDraftsDb.getDrafts(1)[0]?.text, 'newer composer draft');
  });
});

test('a previous server epoch cannot suppress the queued user event even when numeric cursors collide', async () => {
  await withGateway(async ({ socket, frame, dependencies }) => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    mock.method(dependencies.runtime, 'run', async (...[_provider, _command, _options, writer]: Parameters<typeof dependencies.runtime.run>) => {
      writer.send({ kind: 'status', text: 'workspace_prepare', provider: 'claude' });
      entered();
      await new Promise<void>(resolve => { release = resolve; });
      writer.send(createCompleteMessage({ provider: _provider, exitCode: 0 }));
    });
    const turn = runDetachedChatTurn({ sessionId: SESSION_ID, userId: 1, content: 'queued after restart' }, dependencies);
    await started;
    const active = chatRunRegistry.getRun(SESSION_ID);
    assert.ok(active);
    await frame({ type: 'chat.subscribe', sessions: [{ sessionId: SESSION_ID, runId: active.runId, lastSeq: active.lastSeq, replayEpoch: 'previous-server' }] });
    assert.deepEqual(socket.frames.map(event => event.kind), ['chat_subscribed', 'text', 'status']);
    assert.deepEqual(socket.frames.slice(1).map(event => event.seq), [1, 2]);
    assert.equal(socket.frames[1]?.role, 'user');
    assert.equal(socket.frames[1]?.content, 'queued after restart');
    assert.equal(socket.frames[0]?.replayEpoch, chatRunRegistry.getReplayEpoch(SESSION_ID));
    release();
    await turn;
  });
});

test('a same-epoch cursor crosses queued runs and replays only missing current events without losing model-stop state', { timeout: 5000 }, async () => {
  await withGateway(async ({ socket, frame, dependencies }) => {
    await frame({ type: 'chat.subscribe', sessions: [{ sessionId: SESSION_ID }] });
    const epoch = socket.frames[0]?.replayEpoch;
    assert.equal(typeof epoch, 'string');
    let started!: () => void;
    let finishCleanup!: () => void;
    const secondStarted = new Promise<void>(resolve => { started = resolve; });
    const cleanup = new Promise<void>(resolve => { finishCleanup = resolve; });
    mock.method(dependencies.runtime, 'run', async (...[provider, command, _options, writer]: Parameters<typeof dependencies.runtime.run>) => {
      writer.send({ kind: 'status', provider, text: 'thinking' });
      if (command === 'first queued input') {
        writer.send({ kind: 'text', role: 'assistant', provider, content: 'first queued reply' });
      } else {
        writer.send({ kind: 'stream_delta', provider, content: 'second queued partial' });
        writer.send({ kind: 'status', provider, text: 'model_stopped' });
        started();
        await cleanup;
      }
      writer.send(createCompleteMessage({ provider, exitCode: 0 }));
    });

    assert.deepEqual(await runDetachedChatTurn({ sessionId: SESSION_ID, userId: 1, content: 'first queued input' }, dependencies), { started: true, error: null });
    const firstComplete = socket.frames.at(-1);
    assert.equal(firstComplete?.kind, 'complete');
    assert.equal(firstComplete?.seq, 4);
    const secondTurn = runDetachedChatTurn({ sessionId: SESSION_ID, userId: 1, content: 'second queued input' }, dependencies);
    await secondStarted;
    const current = chatRunRegistry.getRun(SESSION_ID);
    assert.ok(current);
    try {
      assert.notEqual(current.runId, firstComplete?.runId);
      assert.deepEqual(socket.frames.slice(-4).map(event => [event.kind, event.seq, event.replayEpoch]), [
        ['text', 5, epoch],
        ['status', 6, epoch],
        ['stream_delta', 7, epoch],
        ['status', 8, epoch],
      ]);
      socket.frames.length = 0;

      await frame({ type: 'chat.subscribe', sessions: [{ sessionId: SESSION_ID, replayEpoch: epoch, runId: firstComplete?.runId, lastSeq: 6 }] });

      const ack = socket.frames[0];
      assert.equal(ack?.kind, 'chat_subscribed');
      assert.equal(ack?.runId, current.runId);
      assert.equal(ack?.replayEpoch, epoch);
      assert.equal(ack?.lastSeq, 8);
      assert.equal(ack?.isProcessing, true);
      assert.equal(ack?.modelStopped, true);
      // The ack's advertised tail is not a consumed cursor: events below it
      // still follow the ack when the subscriber has only consumed through 6.
      assert.deepEqual(socket.frames.slice(1).map(event => [event.kind, event.seq, event.runId]), [
        ['stream_delta', 7, current.runId],
        ['status', 8, current.runId],
      ]);
      assert.equal(socket.frames[1]?.content, 'second queued partial');
      assert.equal(socket.frames[2]?.text, 'model_stopped');
      assert.equal(socket.frames.some(event => event.content === 'first queued reply'), false);
      assert.equal(chatRunRegistry.isProcessing(SESSION_ID), true);
    } finally {
      finishCleanup();
      assert.deepEqual(await secondTurn, { started: true, error: null });
    }
    assert.equal(socket.frames.at(-1)?.kind, 'complete');
    assert.equal(socket.frames.at(-1)?.seq, 9);
    assert.equal(chatRunRegistry.isProcessing(SESSION_ID), false);
  });
});

test('an already-open idle conversation receives the queued user turn before thinking and completion', async () => {
  await withGateway(async ({ socket, frame, dependencies }) => {
    await frame({ type: 'chat.subscribe', sessions: [{ sessionId: SESSION_ID, lastSeq: 200 }] });
    assert.equal(socket.frames[0]?.isProcessing, false);
    mock.method(dependencies.runtime, 'run', async (...[_provider, _command, _options, writer]: Parameters<typeof dependencies.runtime.run>) => {
      writer.send({ kind: 'status', text: 'thinking', provider: 'claude' });
      writer.send({ kind: 'text', role: 'assistant', content: 'queued reply', provider: 'claude' });
      writer.send(createCompleteMessage({ provider: _provider, exitCode: 0 }));
    });
    const result = await runDetachedChatTurn({ sessionId: SESSION_ID, userId: 1, content: 'my queued input' }, dependencies);
    assert.deepEqual(result, { started: true, error: null });
    assert.deepEqual(socket.frames.slice(1).map(event => event.kind), ['text', 'status', 'text', 'complete']);
    assert.equal(socket.frames[1]?.role, 'user');
    assert.equal(socket.frames[1]?.content, 'my queued input');
    assert.match(String(socket.frames[1]?.id), /^local_detached_/);
    assert.equal(socket.frames.at(-1)?.success, true);
    assert.equal(chatRunRegistry.isProcessing(SESSION_ID), false);
    const cursor = socket.frames.at(-1)?.seq as number;
    await runDetachedChatTurn({ sessionId: SESSION_ID, userId: 1, content: 'my second queued input' }, dependencies);
    assert.equal(socket.frames[5]?.seq, cursor + 1);
    socket.emit('close');
    const received = socket.frames.length;
    await runDetachedChatTurn({ sessionId: SESSION_ID, userId: 1, content: 'after disconnect' }, dependencies);
    assert.equal(socket.frames.length, received);
  });
});

test('a detached provider failure or stop is returned even when the runtime resolves normally', async () => {
  await withGateway(async ({ dependencies }) => {
    for (const terminal of [{ exitCode: 1 }, { exitCode: 0, aborted: true }]) {
      mock.method(dependencies.runtime, 'run', async (...[_provider, _command, _options, writer]: Parameters<typeof dependencies.runtime.run>) => {
        writer.send(createCompleteMessage({ provider: _provider, ...terminal }));
      });
      const result = await runDetachedChatTurn({ sessionId: SESSION_ID, userId: 1, content: 'retain this input' }, dependencies);
      assert.equal(result.started, true);
      assert.ok(result.error);
      assert.equal(chatRunRegistry.isProcessing(SESSION_ID), false);
    }
  });
});

test('stop pauses a pending queued input even when its previous run has already finished', async () => {
  await withGateway(async ({ socket, frame }) => {
    const user = userDb.createUser('queue-stop', 'fixture-hash');
    assert.equal(Number(user.id), 1);
    const queuedMessage = { content: 'keep my input', attachments: [{ path: '/fixture/file.txt' }], options: { effort: 'high' } };
    sessionDraftsDb.saveDraft(1, SESSION_ID, { text: 'newer composer draft', queuedMessage });
    await frame({ type: 'chat.abort', sessionId: SESSION_ID });
    assert.equal(socket.frames.find(event => event.kind === 'protocol_error')?.code, 'NO_ACTIVE_RUN');
    assert.deepEqual(sessionDraftsDb.getDrafts(1)[0]?.queuedMessage, { ...queuedMessage, autoSend: false });
    assert.equal(sessionDraftsDb.getDrafts(1)[0]?.text, 'newer composer draft');
  });
});

test('a previous server epoch cannot suppress the queued user event even when numeric cursors collide', async () => {
  await withGateway(async ({ socket, frame, dependencies }) => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    mock.method(dependencies.runtime, 'run', async (...[_provider, _command, _options, writer]: Parameters<typeof dependencies.runtime.run>) => {
      writer.send({ kind: 'status', text: 'workspace_prepare', provider: 'claude' });
      entered();
      await new Promise<void>(resolve => { release = resolve; });
      writer.send(createCompleteMessage({ provider: _provider, exitCode: 0 }));
    });
    const turn = runDetachedChatTurn({ sessionId: SESSION_ID, userId: 1, content: 'queued after restart' }, dependencies);
    await started;
    await frame({ type: 'chat.subscribe', sessions: [{ sessionId: SESSION_ID, lastSeq: 2, replayEpoch: 'previous-server' }] });
    assert.deepEqual(socket.frames.map(event => event.kind), ['chat_subscribed', 'text', 'status']);
    assert.equal(socket.frames[1]?.role, 'user');
    assert.equal(socket.frames[1]?.content, 'queued after restart');
    assert.equal(socket.frames[0]?.replayEpoch, chatRunRegistry.getReplayEpoch(SESSION_ID));
    release();
    await turn;
  });
});
