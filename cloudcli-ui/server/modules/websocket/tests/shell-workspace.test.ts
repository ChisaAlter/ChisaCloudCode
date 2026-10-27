import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { WebSocket } from 'ws';

import { handleShellConnection } from '@/modules/websocket/services/shell-websocket.service.js';
import { AppError, type WorkspaceDescriptor } from '@/shared/index.js';

type Dependencies = Parameters<typeof handleShellConnection>[1];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function socket() {
  const ws = new EventEmitter() as EventEmitter & { readyState: number; frames: Record<string, unknown>[]; send(value: string): void };
  ws.readyState = WebSocket.OPEN;
  ws.frames = [];
  ws.send = value => ws.frames.push(JSON.parse(value));
  return ws;
}

function childProcess() {
  const done = deferred<{ code: number | null; signal: NodeJS.Signals | null }>();
  const child = {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    completion: done.promise, kills: 0, input: '',
    async close() { child.kills += 1; await done.promise; },
    exit() { done.resolve({ code: 0, signal: null }); },
    fail(error: unknown) { done.reject(error); },
  };
  child.stdin.on('data', chunk => { child.input += String(chunk); });
  return child;
}

function harness(bound = true) {
  const id = randomUUID();
  const descriptor: WorkspaceDescriptor = {
    projectId: `project-${id}`, workspaceId: `workspace-${id}`, generation: 'generation-one',
    kind: 'session', sessionId: `session-${id}`, rootPath: process.cwd(), sourceRoot: process.cwd(),
    requestedMode: 'isolated', effectiveMode: 'isolated', phase: 'idle', publicationState: 'unpublished',
    capabilities: { read: true, write: true, git: true, shell: true, preview: true, integrate: true, cloudExecutionIndependentOfDesktop: true },
  };
  const state = {
    descriptor, admissions: [] as Parameters<NonNullable<Dependencies['admitWorkspaceExecution']>>[0][],
    launches: [] as { command: string; args: string[]; cwd?: string; env?: Record<string, string> }[],
    children: [] as ReturnType<typeof childProcess>[], closed: [] as number[], hostSpawns: 0,
    admissionError: undefined as unknown, spawnError: undefined as unknown, closeError: undefined as unknown,
    admissionGate: undefined as ReturnType<typeof deferred<void>> | undefined,
    spawnGate: undefined as ReturnType<typeof deferred<void>> | undefined,
    cleanupGate: undefined as ReturnType<typeof deferred<void>> | undefined,
    remappedRoot: undefined as string | undefined,
  };
  const dependencies: Dependencies = {
    resolveProviderSessionId: () => 'provider-session',
    spawnPty: () => { state.hostSpawns += 1; throw new Error('Host PTY must not run'); },
    resolveSelectedWorkspace(projectId, selector) {
      if (projectId !== descriptor.projectId || selector?.workspaceId !== descriptor.workspaceId || selector?.sessionId !== descriptor.sessionId) {
        throw new AppError('Foreign workspace', { code: 'WORKSPACE_SELECTION_MISMATCH', statusCode: 409 });
      }
      if (selector.generation !== descriptor.generation) {
        throw new AppError('Stale generation', { code: 'WORKSPACE_GENERATION_CHANGED', statusCode: 409 });
      }
      return { ...descriptor };
    },
    isWorkspaceBound: () => bound,
    admitWorkspaceExecution: async input => {
      state.admissions.push(input);
      if (state.admissionError) throw state.admissionError;
      const index = state.admissions.length - 1;
      if (state.admissionGate) await state.admissionGate.promise;
      return {
        bound, cwd: state.remappedRoot ?? descriptor.rootPath, executionRoot: state.remappedRoot ?? descriptor.rootPath,
        sourceCwd: descriptor.rootPath, sourceRoot: descriptor.sourceRoot, isolated: bound, readOnly: false,
        bindingKind: bound ? 'vps' as const : 'none' as const,
        async execute() { throw new Error('Shell must use spawnProcess'); },
        revoke() {},
        assertCurrent() {},
        async spawnProcess(input) {
          state.launches.push(input);
          if (state.spawnError) throw state.spawnError;
          const child = childProcess();
          state.children.push(child);
          if (state.spawnGate) await state.spawnGate.promise;
          return child;
        },
        async close() {
          state.closed.push(index);
          if (state.cleanupGate) await state.cleanupGate.promise;
          if (state.closeError) throw state.closeError;
        },
      };
    },
  };
  function init(extra: Record<string, unknown> = {}) {
    return JSON.stringify({ type: 'init', projectId: descriptor.projectId, workspaceId: descriptor.workspaceId,
      generation: descriptor.generation, sessionId: descriptor.sessionId, provider: 'plain-shell', isPlainShell: true,
      projectPath: '/client-cannot-select-this-path', ...extra });
  }
  function connect(userId = 'owner') {
    const ws = socket();
    handleShellConnection(ws as never, dependencies, { user: { id: userId } } as never);
    return ws;
  }
  return { ...state, state, dependencies, init, connect };
}

async function flush() {
  await new Promise<void>(resolve => setImmediate(resolve));
}

function errorCode(ws: ReturnType<typeof socket>) {
  return ws.frames.find(frame => frame.type === 'error')?.code;
}

test('production shell rejects client paths without a workspace selector', () => {
  for (const fields of [
    { projectPath: process.cwd() },
    { projectId: 'project', workspaceId: 'workspace' },
    { projectId: 'project', generation: 'generation' },
  ]) {
    const ws = socket();
    handleShellConnection(ws as never, { resolveProviderSessionId: () => null });
    ws.emit('message', JSON.stringify({ type: 'init', ...fields }));
    assert.equal(errorCode(ws), 'WORKSPACE_SELECTOR_REQUIRED');
  }
});

test('foreign selectors and stale generations fail before execution admission', async () => {
  const h = harness();
  for (const override of [{ generation: 'stale' }, { workspaceId: 'foreign' }, { sessionId: 'foreign' }, { projectId: 'foreign' }]) {
    const ws = h.connect();
    ws.emit('message', h.init(override));
    await flush();
    assert.equal(errorCode(ws), 'generation' in override ? 'WORKSPACE_GENERATION_CHANGED' : 'WORKSPACE_SELECTION_MISMATCH');
  }
  assert.equal(h.state.admissions.length, 0);
  assert.equal(h.state.hostSpawns, 0);
});

test('bound shell uses exact admitted workspace, supports pipe input, and closes only after process exit', async () => {
  const h = harness();
  const ws = h.connect();
  ws.emit('message', h.init());
  await flush();
  assert.deepEqual(h.state.admissions, [{ cwd: h.descriptor.rootPath, sessionId: h.descriptor.sessionId,
    workspaceMode: 'isolated', directExecution: true, expectedWorkspace: h.descriptor }]);
  assert.equal(h.state.hostSpawns, 0);
  assert.equal(h.state.launches[0].cwd, h.descriptor.rootPath);
  assert.deepEqual(h.state.launches[0].args, ['--noprofile', '--norc', '-i']);
  assert.equal(h.state.launches[0].env?.HOME, undefined);
  assert.equal(ws.frames.find(frame => frame.type === 'ready')?.transport, 'pipe');
  assert.equal(ws.frames.find(frame => frame.type === 'ready')?.resizeSupported, false);
  const child = h.state.children[0];
  ws.emit('message', JSON.stringify({ type: 'input', data: 'pwz\x7fd\r\n' }));
  assert.equal(child.input, 'pwd\n');
  child.stdout.write('result\n');
  assert.ok(ws.frames.some(frame => frame.data === 'result\r\n'));
  ws.emit('close');
  assert.deepEqual(h.state.closed, []);
  assert.equal(child.kills, 0);
  child.exit();
  await flush();
  assert.deepEqual(h.state.closed, [0]);
});

test('reconnect revalidates identity and rejects stale socket input, resize, and close', async () => {
  const h = harness();
  const first = h.connect();
  first.emit('message', h.init());
  await flush();
  const replacement = h.connect();
  replacement.emit('message', h.init({ projectPath: '/another-untrusted-path' }));
  await flush();
  assert.equal(h.state.admissions.length, 1);
  first.emit('message', JSON.stringify({ type: 'input', data: 'stale\r' }));
  first.emit('message', JSON.stringify({ type: 'resize', cols: 1, rows: 1 }));
  first.emit('close');
  replacement.emit('message', JSON.stringify({ type: 'input', data: 'current\r' }));
  const child = h.state.children[0];
  assert.equal(child.input, 'current\n');
  replacement.frames.length = 0;
  child.stdout.write('live-output');
  assert.deepEqual(replacement.frames, [{ type: 'output', data: 'live-output' }]);
  h.descriptor.generation = 'generation-two';
  const stale = h.connect();
  stale.emit('message', h.init({ generation: 'generation-one' }));
  await flush();
  assert.equal(errorCode(stale), 'WORKSPACE_GENERATION_CHANGED');
  assert.equal(h.state.admissions.length, 1);
  child.exit();
  await flush();
});

test('in-flight initialization is serialized across sockets without borrowed admissions', async () => {
  const h = harness();
  const gate = deferred<void>();
  h.state.admissionGate = gate;
  const first = h.connect();
  const second = h.connect();
  first.emit('message', h.init());
  second.emit('message', h.init());
  await flush();
  assert.equal(h.state.admissions.length, 1);
  assert.equal(h.state.children.length, 0);
  gate.resolve();
  await flush();
  assert.equal(h.state.admissions.length, 1);
  assert.equal(h.state.children.length, 1);
  first.emit('close');
  h.state.children[0].stdout.write('second-owns-output');
  assert.ok(second.frames.some(frame => frame.data === 'second-owns-output'));
  h.state.children[0].exit();
  await flush();
});

test('force restart waits for real process exit and exact admission cleanup', async () => {
  const h = harness();
  const first = h.connect();
  first.emit('message', h.init());
  await flush();
  const cleanup = deferred<void>();
  h.state.cleanupGate = cleanup;
  const second = h.connect();
  second.emit('message', h.init({ forceRestart: true }));
  await flush();
  assert.equal(h.state.children[0].kills, 1);
  assert.equal(h.state.admissions.length, 1);
  assert.deepEqual(h.state.closed, []);
  h.state.children[0].exit();
  await flush();
  assert.deepEqual(h.state.closed, [0]);
  assert.equal(h.state.admissions.length, 1);
  cleanup.resolve();
  await flush();
  assert.equal(h.state.admissions.length, 2);
  assert.equal(h.state.children.length, 2);
  first.emit('close');
  assert.equal(h.state.children[1].kills, 0);
  h.state.children[1].exit();
  await flush();
  assert.deepEqual(h.state.closed, [0, 1]);
});

test('busy workspace is rejected without host fallback or borrowed execution', async () => {
  const h = harness();
  h.state.admissionError = new AppError('An AI owns the workspace', { code: 'WORKSPACE_BUSY', statusCode: 409 });
  const ws = h.connect();
  ws.emit('message', h.init());
  await flush();
  assert.equal(errorCode(ws), 'WORKSPACE_BUSY');
  assert.equal(ws.frames.find(frame => frame.type === 'error')?.statusCode, 409);
  assert.equal(h.state.children.length, 0);
  assert.equal(h.state.hostSpawns, 0);
});

test('admission remapping and generation changes during admission cannot launch a shell', async () => {
  for (const changeGeneration of [false, true]) {
    const h = harness();
    const gate = deferred<void>();
    h.state.admissionGate = gate;
    if (!changeGeneration) h.state.remappedRoot = '/different-worktree';
    const ws = h.connect();
    ws.emit('message', h.init());
    await flush();
    if (changeGeneration) h.descriptor.generation = 'generation-two';
    gate.resolve();
    await flush();
    assert.equal(errorCode(ws), changeGeneration ? 'WORKSPACE_GENERATION_CHANGED' : 'SHELL_WORKSPACE_MISMATCH');
    assert.deepEqual(h.state.closed, [0]);
    assert.equal(h.state.children.length, 0);
    assert.equal(h.state.hostSpawns, 0);
  }
});

test('disconnect during admission closes the exact unused reservation', async () => {
  const h = harness();
  const gate = deferred<void>();
  h.state.admissionGate = gate;
  const ws = h.connect();
  ws.emit('message', h.init());
  await flush();
  ws.emit('close');
  gate.resolve();
  await flush();
  assert.deepEqual(h.state.closed, [0]);
  assert.equal(h.state.children.length, 0);
});

test('disconnect during spawn immediately kills the new process but keeps its reservation until exit', async () => {
  const h = harness();
  const gate = deferred<void>();
  h.state.spawnGate = gate;
  const ws = h.connect();
  ws.emit('message', h.init());
  await flush();
  const child = h.state.children[0];
  ws.emit('close');
  gate.resolve();
  await flush();
  assert.equal(child.kills, 1);
  assert.deepEqual(h.state.closed, []);
  assert.ok(!ws.frames.some(frame => frame.type === 'ready'));
  child.exit();
  await flush();
  assert.deepEqual(h.state.closed, [0]);
});

test('idle timeout requests process stop without releasing a live reservation', async () => {
  const h = harness();
  h.dependencies.sessionTimeoutMs = 1;
  const ws = h.connect();
  ws.emit('message', h.init());
  await flush();
  ws.emit('close');
  await new Promise(resolve => setTimeout(resolve, 10));
  const child = h.state.children[0];
  assert.equal(child.kills, 1);
  assert.deepEqual(h.state.closed, []);
  const reconnect = h.connect();
  reconnect.emit('message', h.init());
  await flush();
  assert.equal(errorCode(reconnect), 'WORKSPACE_BUSY');
  assert.equal(h.state.admissions.length, 1);
  child.exit();
  await flush();
  assert.deepEqual(h.state.closed, [0]);
});

test('spawn failure releases unused admission and cleanup failure prevents reuse', async () => {
  const failedSpawn = harness();
  failedSpawn.state.spawnError = new Error('Failed to spawn container');
  const failedSocket = failedSpawn.connect();
  failedSocket.emit('message', failedSpawn.init());
  await flush();
  assert.deepEqual(failedSpawn.state.closed, [0]);
  assert.ok(failedSocket.frames.some(frame => frame.message === 'Failed to spawn container'));

  const h = harness();
  const first = h.connect();
  first.emit('message', h.init());
  await flush();
  h.state.closeError = new AppError('Container cleanup not confirmed', { code: 'WORKSPACE_CLEANUP_FAILED', statusCode: 409 });
  h.state.children[0].exit();
  await flush();
  const reconnect = h.connect();
  reconnect.emit('message', h.init({ forceRestart: true }));
  await flush();
  assert.equal(errorCode(reconnect), 'WORKSPACE_CLEANUP_FAILED');
  assert.equal(h.state.admissions.length, 1);
});

test('a shell connection cannot remap itself to another generation', async () => {
  const h = harness();
  const ws = h.connect();
  ws.emit('message', h.init());
  await flush();
  h.descriptor.generation = 'generation-two';
  ws.emit('message', h.init());
  await flush();
  assert.equal(errorCode(ws), 'SHELL_WORKSPACE_MISMATCH');
  assert.equal(h.state.admissions.length, 1);
  h.state.children[0].exit();
  await flush();
});

test('provider resume command in a bound workspace uses Linux syntax and exact selected session', async () => {
  const h = harness();
  const ws = h.connect();
  ws.emit('message', h.init({ provider: 'claude', isPlainShell: false, hasSession: true, bypassPermissions: true }));
  await flush();
  assert.deepEqual(h.state.launches[0].args, ['-c',
    'claude --resume "provider-session" --dangerously-skip-permissions || claude --dangerously-skip-permissions']);
  h.state.children[0].exit();
  await flush();
});

test('validated unbound shared sessions use host PTY at the descriptor root only', async () => {
  const h = harness(false);
  h.descriptor.effectiveMode = 'shared';
  let onExit: (() => void) | undefined;
  h.dependencies.spawnPty = (_shell, _args, options) => {
    h.state.hostSpawns += 1;
    assert.equal(options?.cwd, h.descriptor.rootPath);
    return { onData() {}, onExit(listener: (event: { exitCode: number }) => void) { onExit = () => listener({ exitCode: 0 }); },
      write() {}, resize() {}, kill() {} } as never;
  };
  const ws = h.connect();
  ws.emit('message', h.init());
  await flush();
  assert.equal(h.state.hostSpawns, 1);
  assert.equal(h.state.admissions.length, 0);
  assert.equal(ws.frames.find(frame => frame.type === 'ready')?.transport, 'pty');
  onExit?.();
});

test('authenticated users cannot reconnect to another users retained terminal', async () => {
  const h = harness();
  const first = h.connect('one');
  first.emit('message', h.init());
  await flush();
  h.state.admissionError = new AppError('Existing writer', { code: 'WORKSPACE_BUSY', statusCode: 409 });
  const second = h.connect('two');
  second.emit('message', h.init());
  await flush();
  assert.equal(errorCode(second), 'WORKSPACE_BUSY');
  h.state.children[0].stdout.write('owner-only');
  assert.ok(first.frames.some(frame => frame.data === 'owner-only'));
  assert.ok(!second.frames.some(frame => frame.data === 'owner-only'));
  h.state.children[0].exit();
  await flush();
});
