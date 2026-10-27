import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test, { after, mock } from 'node:test';

import { WORKSPACES_ROOT } from '@/shared/index.js';

// Provider imports open SQLite eagerly. Isolate that first connection as well.
const originalDatabasePath = process.env.DATABASE_PATH;
const bootstrapDirectory = await mkdtemp(path.join(path.resolve(WORKSPACES_ROOT), '.chisa-chat-isolation-bootstrap-'));
process.env.DATABASE_PATH = path.join(bootstrapDirectory, 'auth.db');
await writeFile(process.env.DATABASE_PATH, '');
const { closeConnection, initializeDatabase, projectsDb, sessionsDb } = await import('@/modules/database/index.js');
// Retired local metadata may still drive offline chat without a restored cloud account.
const { assertCloudWorkspaceOwner } = await import('@/modules/workspace-runtime/index.js');
mock.module('@/modules/workspace-runtime/index.js', { namedExports: {
  assertCloudWorkspaceOwner,
  ensureCloudWorkspaceBinding() {}, excludeCloudWorkspaceMetadata() {}, getWorkspaceRuntimeIdentity() { return undefined; },
  executeWorkspaceRuntimePreview() { assert.fail('unexpected preview'); }, createWorkspaceRuntimeService() { assert.fail('unexpected restore'); },
} });
const { describeWorkspaceSelection } = await import('@/modules/workspace-bridge/index.js');
const { providerModelsService, sessionsService } = await import('@/modules/providers/index.js');
const { chatRunRegistry } = await import('@/modules/websocket/services/chat-run-registry.service.js');
const { handleChatConnection, onChatRunSettled, runDetachedChatTurn } = await import('@/modules/websocket/services/chat-websocket.service.js');
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
  socket.send = data => socket.frames.push(JSON.parse(data) as Record<string, unknown>);
  return socket;
}

async function withGateway(
  runTest: (context: {
    cwd: string;
    socket: ReturnType<typeof createSocket>;
    requests: RpcRequest[];
    aborts: string[];
    runs: string[];
    workspace: { projectId: string; workspaceId: string; generation: string };
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
  const project = projectsDb.getProjectPath(cwd);
  assert.ok(project);
  const replica = describeWorkspaceSelection({ projectId: project.project_id, sourceRoot: cwd }).cloudReplica;
  const workspace = { projectId: project.project_id, workspaceId: replica.workspaceId, generation: replica.generation };
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
      run: async (_provider, command) => { runs.push(command); },
      abort: async (_provider, sessionId) => { aborts.push(sessionId); return true; },
      resolveToolApproval: () => {},
      getPendingApprovalsForSession: () => [],
    },
  };
  handleChatConnection(socket as never, { user: { id: 1 } } as never, dependencies);
  try {
    await runTest({
      cwd, socket, requests, aborts, runs, workspace, dependencies,
      frame: async data => {
        const listener = socket.listeners('message')[0];
        assert.ok(listener);
        const selector = data.type === 'chat.send' || data.type === 'chat.edit-send' ? workspace : {};
        await listener(JSON.stringify({ ...selector, ...data }));
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
    for (const target of [cwd, cwd + '.chisa-state']) {
      assert.equal(path.dirname(path.resolve(target)), path.resolve(WORKSPACES_ROOT));
      await rm(target, { recursive: true, force: true });
    }
  }
}

function startRun(socket: ReturnType<typeof createSocket>, provider: 'claude' | 'codex' = 'claude') {
  const run = chatRunRegistry.startRun({ appSessionId: SESSION_ID, provider, providerSessionId: null, connection: socket as never, userId: 1 });
  assert.ok(run);
  return run;
}

for (const cursor of ['same', 'other', 'unknown', 'legacy'] as const) {
  test(`subscribe uses the ${cursor} run identity when replaying sequence cursors`, async () => {
    await withGateway(async ({ socket, frame }) => {
      const run = startRun(socket);
      run.writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: SESSION_ID, content: 'one' });
      run.writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: SESSION_ID, content: 'two' });
      socket.frames.length = 0;
      const target = { sessionId: SESSION_ID, lastSeq: 1, ...(cursor === 'legacy' ? {} : { runId: cursor === 'same' ? run.runId : cursor === 'unknown' ? null : 'previous-run' }) };
      await frame({ type: 'chat.subscribe', sessions: [target] });
      const replayed = socket.frames.filter(event => event.kind === 'stream_delta');
      assert.deepEqual(replayed.map(event => event.content), cursor === 'same' || cursor === 'legacy' ? ['two'] : ['one', 'two']);
      assert.equal(replayed.every(event => event.runId === run.runId), true);
      assert.equal(socket.frames.find(event => event.kind === 'chat_subscribed')?.runId, run.runId);
    });
  });
}

test('ordinary, edited and detached turns remain independent of private workspace agents', async () => {
  await withGateway(async ({ socket, frame, runs, workspace, dependencies }) => {
    const models: string[] = [];
    const rewinds: string[] = [];
    mock.method(providerModelsService, 'setSessionModel', () => { models.push('model'); });
    mock.method(providerModelsService, 'setSessionEffort', () => { models.push('effort'); });
    mock.method(sessionsService, 'rewindSessionForEdit', async () => { rewinds.push('rewind'); });
    const options = { model: 'changed-model', effort: 'high' };
    await frame({ type: 'chat.send', sessionId: SESSION_ID, content: 'ordinary', options });
    await frame({ type: 'chat.edit-send', sessionId: SESSION_ID, anchorId: 'turn-b', content: 'edited', options });
    const detached = await runDetachedChatTurn({ sessionId: SESSION_ID, userId: 1, content: 'detached', options: { ...options, workspace } }, dependencies);
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
  await withGateway(async ({ socket, runs, workspace, dependencies, aborts }) => {
    const active = startRun(socket);
    const result = await runDetachedChatTurn({ sessionId: SESSION_ID, userId: 1, content: 'timer', options: { workspace }, interruptActiveRun: true }, dependencies);
    assert.equal(result.started, true);
    assert.equal(active.status, 'completed');
    assert.deepEqual(aborts, [SESSION_ID]);
    assert.deepEqual(runs, ['timer']);
    assert.equal(socket.frames.find(frame => frame.kind === 'complete')?.aborted, true);
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
  await withGateway(async ({ socket, frame, aborts }) => {
    startRun(socket);
    await frame({ type: 'chat.abort', sessionId: SESSION_ID });
    assert.deepEqual(aborts, [SESSION_ID]);
    const complete = socket.frames.find(frame => frame.kind === 'complete');
    assert.equal(complete?.exitCode, 0);
    assert.equal(complete?.aborted, true);
    assert.equal(socket.frames.some(frame => frame.kind === 'protocol_error'), false);
  });
});

test('provider abort failures retain the actual error without falsely completing a run that has not settled', async () => {
  await withGateway(async ({ socket, frame, dependencies }) => {
    const active = startRun(socket);
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

test('a false provider abort is reported and the still-running task remains reserved', async () => {
  await withGateway(async ({ socket, frame, dependencies }) => {
    const active = startRun(socket);
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

for (const outcome of ['false', 'throws'] as const) {
  test(`an interrupt replacement is not started when provider cancellation ${outcome}`, async () => {
    await withGateway(async ({ socket, workspace, dependencies, runs }) => {
      const active = startRun(socket);
      mock.method(dependencies.runtime, 'abort', async () => {
        if (outcome === 'throws') throw new Error('replacement stop failed');
        return false;
      });
      const result = await runDetachedChatTurn({ sessionId: SESSION_ID, userId: 1, content: 'replacement', options: { workspace }, interruptActiveRun: true }, dependencies);
      assert.equal(result.started, false);
      assert.match(result.error ?? '', outcome === 'throws' ? /replacement stop failed/ : /has not confirmed cancellation/);
      assert.deepEqual(runs, []);
      assert.equal(socket.frames.some(event => event.kind === 'complete'), false);
      assert.equal(chatRunRegistry.getRun(SESSION_ID), active);
      assert.equal(active.status, 'running');
    });
  });
}

test('cancellation before runtime startup fails only after the deferred rewind has independently settled', async () => {
  await withGateway(async ({ socket, frame, dependencies, runs }) => {
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
    mock.method(dependencies.runtime, 'abort', async () => false);
    const send = frame({ type: 'chat.edit-send', sessionId: SESSION_ID, anchorId: 'turn-b', content: 'not dispatched' });
    await rewinding;
    await frame({ type: 'chat.abort', sessionId: SESSION_ID });
    assert.equal(socket.frames.find(event => event.kind === 'protocol_error')?.code, 'CHAT_ABORT_FAILED');
    assert.equal(socket.frames.some(event => event.kind === 'complete'), false);
    assert.equal(chatRunRegistry.getRun(SESSION_ID)?.status, 'running');
    finishRewind();
    await send;
    assert.deepEqual(runs, []);
    const complete = socket.frames.find(event => event.kind === 'complete');
    assert.equal(complete?.exitCode, 1);
    assert.notEqual(complete?.aborted, true);
    assert.equal(chatRunRegistry.getRun(SESSION_ID)?.status, 'completed');
    assert.equal(socket.frames.filter(event => event.kind === 'complete').length, 1);
  }, 'codex');
});

test('runtime settlement during stop does not admit another turn before workspace release', async () => {
  await withGateway(async ({ socket, frame, dependencies }) => {
    let settledNotifications = 0;
    const unsubscribe = onChatRunSettled(() => { settledNotifications++; });
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
    assert.equal(settledNotifications, 0);
    assert.equal(socket.frames.some(event => event.kind === 'complete'), false);
    assert.equal(chatRunRegistry.getRun(SESSION_ID)?.status, 'running');
    await frame({ type: 'chat.send', sessionId: SESSION_ID, content: 'too early' });
    assert.equal(socket.frames.find(event => event.kind === 'protocol_error')?.code, 'RUN_IN_PROGRESS');
    finishStop();
    await stop;
    assert.equal(settledNotifications, 1);
    unsubscribe();
    const complete = socket.frames.find(event => event.kind === 'complete');
    assert.equal(complete?.exitCode, 0);
    assert.equal(complete?.aborted, true);
    assert.equal(socket.frames.filter(event => event.kind === 'complete').length, 1);
  });
});

test('late provider abort settlement cannot complete the next Claude run', async () => {
  await withGateway(async ({ socket, frame, dependencies }) => {
    const original = startRun(socket);
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
