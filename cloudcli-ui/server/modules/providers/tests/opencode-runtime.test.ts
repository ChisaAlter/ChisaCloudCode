import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test, { after, beforeEach, mock } from 'node:test';
import type { ChildProcess } from 'node:child_process';

import Database from 'better-sqlite3';
import type { NormalizedMessage, ProviderRuntimeContext } from '@/shared/types.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'chisa-opencode-lifecycle-'));
const environmentKeys = ['HOME', 'USERPROFILE', 'DATABASE_PATH', 'WORKSPACES_ROOT'] as const;
const previousEnvironment = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
process.env.HOME = root;
process.env.USERPROFILE = root;
process.env.DATABASE_PATH = path.join(root, 'auth.db');
process.env.WORKSPACES_ROOT = path.join(root, 'workspaces');
assert.equal(os.homedir(), root);
await mkdir(process.env.WORKSPACES_ROOT, { recursive: true });
await writeFile(process.env.DATABASE_PATH, '');

const shared = await import('@/shared/index.js');
const tokenDatabasePath = shared.getOpenCodeDatabasePath();
await mkdir(path.dirname(tokenDatabasePath), { recursive: true });
const database = new Database(tokenDatabasePath);
database.exec(`CREATE TABLE session (
  id TEXT PRIMARY KEY, tokens_input INTEGER, tokens_output INTEGER,
  tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER
); INSERT INTO session VALUES ('native-session', 11, 7, 3, 5, 2)`);
database.close();

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

class FakeOpenCodeProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 424242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  closed = false;

  close(code: number | null = 0) {
    this.exitCode = code;
    this.signalCode = code === null ? 'SIGTERM' : null;
    this.closed = true;
    this.emit('close', code, this.signalCode);
  }
}

let children: FakeOpenCodeProcess[] = [];
let launched = gate();
let terminationCalls: ChildProcess[] = [];
let terminate: (child: ChildProcess) => Promise<void>;
let failedNotifications = 0;
let stoppedNotifications = 0;

mock.module('cross-spawn', { defaultExport: (_command: string, _args: string[], options: { detached: boolean }) => {
  assert.equal(options.detached, process.platform !== 'win32');
  const child = new FakeOpenCodeProcess();
  children.push(child);
  launched.resolve();
  return child;
} });
mock.module('@/shared/index.js', { namedExports: {
  ...shared,
  terminateProviderProcess: (child: ChildProcess) => { terminationCalls.push(child); return terminate(child); },
} });
mock.module('@/modules/notifications/index.js', { namedExports: {
  notifyRunFailed() { failedNotifications++; },
  notifyRunStopped() { stoppedNotifications++; },
} });
const { opencodeRuntime } = await import('@/modules/providers/list/opencode/opencode-runtime.provider.js');
const { OpenCodeSessionsProvider } = await import('@/modules/providers/list/opencode/opencode-sessions.provider.js');
const sessions = new OpenCodeSessionsProvider();

const context = (): ProviderRuntimeContext => ({
  resolveProviderSessionId: () => 'native-session',
  resolveResumeModel: async () => 'test-model',
  getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'test-model' }),
  normalizeMessage: (event, sessionId) => sessions.normalizeMessage(event, sessionId),
  isProviderInstalled: async () => true,
});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const writer = (frames: NormalizedMessage[]) => ({ send: (frame: unknown) => { frames.push(frame as NormalizedMessage); } });
const stoppedFrames = (frames: NormalizedMessage[]) => frames.filter(frame => frame.kind === 'status' && frame.text === 'model_stopped');

beforeEach(() => {
  children = [];
  launched = gate();
  terminationCalls = [];
  failedNotifications = 0;
  stoppedNotifications = 0;
  terminate = async child => { (child as unknown as FakeOpenCodeProcess).close(null); };
});
after(async () => {
  mock.restoreAll();
  for (const key of environmentKeys) {
    if (previousEnvironment[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnvironment[key];
  }
  await rm(root, { recursive: true, force: true });
});

for (const phase of ['model', 'catalog'] as const) {
  test(`OpenCode cancellation during ${phase} preparation cannot spawn`, { timeout: 5000 }, async () => {
    const entered = gate();
    const prepared = gate();
    const frames: NormalizedMessage[] = [];
    const controller = new AbortController();
    const runtimeContext = context();
    if (phase === 'model') runtimeContext.resolveResumeModel = async () => { entered.resolve(); await prepared.promise; return 'test-model'; };
    else runtimeContext.getProviderModels = async () => { entered.resolve(); await prepared.promise; return { OPTIONS: [], DEFAULT: 'test-model' }; };
    const sessionId = `preparation-${phase}`;
    const running = opencodeRuntime.run('do not launch', { sessionId, cwd: root, abortSignal: controller.signal }, writer(frames), runtimeContext);
    await entered.promise;
    controller.abort();
    let confirmed = false;
    const stopping = opencodeRuntime.abort(sessionId).then(success => { confirmed = success; });
    await tick();
    assert.equal(confirmed, false);
    await assert.rejects(opencodeRuntime.run('duplicate', { sessionId, cwd: root }, writer(frames), context()), /already running/);
    assert.equal(children.length, 0);
    assert.equal(stoppedFrames(frames).length, 0);
    prepared.resolve();
    await Promise.all([running, stopping]);
    assert.equal(confirmed, true);
    assert.equal(children.length, 0);
    assert.equal(terminationCalls.length, 0);
    assert.equal(stoppedFrames(frames).length, 1);
    assert.equal(stoppedFrames(frames)[0].canInterrupt, false);
    assert.equal(frames.some(frame => frame.kind === 'complete'), false);
  });
}

test('OpenCode stream end and process exit remain nonterminal until close', { timeout: 5000 }, async () => {
  const frames: NormalizedMessage[] = [];
  const running = opencodeRuntime.run('ordinary turn', { sessionId: 'normal-close', cwd: root }, writer(frames), context());
  await launched.promise;
  const child = children[0];
  child.stdout.write(JSON.stringify({ type: 'step_finish', sessionID: 'native-session' }) + '\n');
  child.exitCode = 0;
  child.emit('exit', 0, null);
  await tick();
  assert.equal(frames.filter(frame => frame.kind === 'stream_end').length, 1);
  assert.equal(frames.some(frame => frame.kind === 'complete'), false);
  child.close(0);
  await running;
  assert.equal(frames.filter(frame => frame.kind === 'complete').length, 1);
  assert.equal(frames.find(frame => frame.kind === 'complete')?.success, true);
  const tokenBudget = frames.find(frame => frame.text === 'token_budget')?.tokenBudget as {
    used: number;
    inputTokens: number;
    outputTokens: number;
  } | undefined;
  assert.equal(tokenBudget?.used, 28);
  assert.equal(tokenBudget?.inputTokens, 16);
  assert.equal(tokenBudget?.outputTokens, 7);
  assert.equal(failedNotifications, 0);
  assert.equal(stoppedNotifications, 1);
});

test('OpenCode process error retains ownership and emits one failed completion only after close', { timeout: 5000 }, async () => {
  const frames: NormalizedMessage[] = [];
  const sessionId = 'error-before-close';
  const running = opencodeRuntime.run('failed task', { sessionId, cwd: root }, writer(frames), context());
  await launched.promise;
  const failure = new Error('fixture process error');
  children[0].emit('error', failure);
  await tick();
  assert.equal(frames.some(frame => frame.kind === 'complete'), false);
  await assert.rejects(opencodeRuntime.run('too early', { sessionId, cwd: root }, writer(frames), context()), /already running/);
  const rejected = assert.rejects(running, error => error === failure);
  children[0].close(1);
  await rejected;
  assert.equal(frames.filter(frame => frame.kind === 'complete').length, 1);
  assert.equal(frames.find(frame => frame.kind === 'complete')?.exitCode, 1);
  assert.equal(frames.find(frame => frame.kind === 'complete')?.success, false);
  assert.equal(frames.find(frame => frame.kind === 'error')?.content, failure.message);
  assert.equal(failedNotifications, 1);
  assert.equal(stoppedFrames(frames).length, 0);
});

for (const first of ['close', 'termination'] as const) {
  test(`OpenCode stop waits for both close and tree termination (${first} first)`, { timeout: 5000 }, async () => {
    const treeTerminated = gate();
    terminate = () => treeTerminated.promise;
    const frames: NormalizedMessage[] = [];
    const controller = new AbortController();
    const sessionId = `stop-order-${first}`;
    const running = opencodeRuntime.run('active task', { sessionId, cwd: root, abortSignal: controller.signal }, writer(frames), context());
    await launched.promise;
    const child = children[0];
    controller.abort();
    let confirmed = false;
    const stopping = opencodeRuntime.abort(sessionId).then(success => { confirmed = success; });
    if (first === 'close') child.close(null);
    else treeTerminated.resolve();
    await tick();
    assert.equal(terminationCalls.length, 1, 'signal and explicit abort must share this run\'s termination');
    assert.equal(terminationCalls[0], child as unknown as ChildProcess);
    assert.equal(confirmed, false);
    assert.equal(stoppedFrames(frames).length, 0);
    assert.equal(frames.some(frame => frame.kind === 'complete'), false);
    await assert.rejects(opencodeRuntime.run('too early', { sessionId, cwd: root }, writer(frames), context()), /already running/);
    if (first === 'close') treeTerminated.resolve();
    else child.close(null);
    await Promise.all([running, stopping]);
    assert.equal(confirmed, true);
    assert.equal(stoppedFrames(frames).length, 1);
    assert.equal(stoppedFrames(frames)[0].canInterrupt, false);
    assert.equal(frames.some(frame => frame.kind === 'complete'), false, 'only the gateway owns cancelled terminal completion');
    assert.equal(failedNotifications, 0);
  });
}

test('OpenCode signal-only termination failure is handled and preserves ownership until an explicit successful retry', { timeout: 5000 }, async t => {
  const frames: NormalizedMessage[] = [];
  const controller = new AbortController();
  const errors: unknown[][] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => { unhandled.push(error); };
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.removeListener('unhandledRejection', onUnhandled));
  t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args); });
  const denied = Object.assign(new Error('fixture termination denied'), { code: 'EPERM' });
  const recovered = gate();
  terminate = () => terminationCalls.length <= 2 ? Promise.reject(denied) : recovered.promise;
  const sessionId = 'failed-termination';
  let runSettled = false;
  const running = opencodeRuntime.run('active task', { sessionId, cwd: root, abortSignal: controller.signal }, writer(frames), context()).then(() => { runSettled = true; });
  await launched.promise;
  controller.abort();
  await tick();
  await tick();
  assert.equal(terminationCalls.length, 1, 'failure must not trigger automatic retries');
  assert.equal(errors.length, 1);
  assert.equal(errors[0][0], 'OpenCode process cancellation failed:');
  assert.equal(errors[0][1], denied);
  assert.deepEqual(unhandled, []);
  children[0].close(null);
  await tick();
  assert.equal(runSettled, false, 'CLI close cannot confirm failed tree termination');
  assert.equal(stoppedFrames(frames).length, 0);
  await assert.rejects(opencodeRuntime.run('replacement', { sessionId, cwd: root }, writer(frames), context()), /already running/);
  await assert.rejects(opencodeRuntime.abort(sessionId), error => error === denied);
  assert.equal(terminationCalls.length, 2, 'explicit abort must propagate failure');
  const stopping = opencodeRuntime.abort(sessionId);
  await tick();
  assert.equal(terminationCalls.length, 3);
  assert.equal(runSettled, false);
  recovered.resolve();
  assert.equal(await stopping, true);
  await running;
  assert.equal(stoppedFrames(frames).length, 1);
  assert.equal(frames.some(frame => frame.kind === 'complete'), false);
  assert.deepEqual(unhandled, []);
});

test('OpenCode complete admits the next owner and old cleanup cannot remove its abort handle', { timeout: 5000 }, async () => {
  const firstFrames: NormalizedMessage[] = [];
  const nextFrames: NormalizedMessage[] = [];
  let next: Promise<void> | undefined;
  const nextLaunched = gate();
  const sessionId = 'complete-handoff';
  const first = opencodeRuntime.run('first', { sessionId, cwd: root }, { send(frame: unknown) {
    const message = frame as NormalizedMessage;
    firstFrames.push(message);
    if (message.kind === 'complete') {
      launched = nextLaunched;
      next = opencodeRuntime.run('next', { sessionId, cwd: root }, writer(nextFrames), context());
    }
  } }, context());
  await launched.promise;
  children[0].close(0);
  await first;
  assert.ok(next);
  // Propagate admission failure immediately instead of waiting on a never-spawned child.
  await Promise.race([nextLaunched.promise, next]);
  assert.equal(children.length, 2);
  assert.equal(await opencodeRuntime.abort(sessionId), true);
  await next;
  assert.equal(terminationCalls[0], children[1] as unknown as ChildProcess);
  assert.equal(stoppedFrames(nextFrames).length, 1);
  assert.equal(nextFrames.some(frame => frame.kind === 'complete'), false);
  assert.equal(firstFrames.filter(frame => frame.kind === 'complete').length, 1);
});
