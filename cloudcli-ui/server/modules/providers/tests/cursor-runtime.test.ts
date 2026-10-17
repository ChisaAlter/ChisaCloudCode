import assert from 'node:assert/strict';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test, { after, mock } from 'node:test';

import type { ProviderRuntimeContext } from '@/shared/index.js';

type RuntimeFrame = ReturnType<typeof import('@/shared/index.js').createNormalizedMessage>;

const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'chisa-cursor-runtime-'));
const previousEnvironment = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  DATABASE_PATH: process.env.DATABASE_PATH,
  WORKSPACES_ROOT: process.env.WORKSPACES_ROOT,
};
process.env.HOME = tempRoot;
process.env.USERPROFILE = tempRoot;
process.env.DATABASE_PATH = path.join(tempRoot, 'fixture.db');
process.env.WORKSPACES_ROOT = path.join(tempRoot, 'workspaces');
await mkdir(process.env.WORKSPACES_ROOT, { recursive: true });

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));

class FakeCursorProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid: number;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  closed = false;

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  output(message: unknown): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  close(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    if (this.closed) return;
    this.closed = true;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }
}

type RuntimeFixture = {
  cwd: string;
  context: ProviderRuntimeContext;
  frames: RuntimeFrame[];
  processes: FakeCursorProcess[];
  spawns: { command: string; args: string[]; options: SpawnOptions }[];
  terminations: FakeCursorProcess[];
  terminate(child: FakeCursorProcess): Promise<void>;
  waitForProcess(index: number): Promise<FakeCursorProcess>;
  hold(): ReturnType<typeof gate>;
  start(sessionId: string, options?: Record<string, unknown>, send?: (frame: RuntimeFrame) => void): Promise<void>;
};

let fixture: RuntimeFixture;
const spawnWaiters = new Map<number, (child: FakeCursorProcess) => void>();
mock.module('cross-spawn', { defaultExport: (command: string, args: string[], options: SpawnOptions) => {
  const child = new FakeCursorProcess(10_000 + fixture.processes.length);
  fixture.spawns.push({ command, args: [...args], options });
  fixture.processes.push(child);
  spawnWaiters.get(fixture.processes.length - 1)?.(child);
  return child;
} });

const shared = await import('@/shared/index.js');
mock.module('@/shared/index.js', { namedExports: {
  ...shared,
  terminateProviderProcess: (child: ChildProcess) => {
    const process = child as unknown as FakeCursorProcess;
    fixture.terminations.push(process);
    return fixture.terminate(process);
  },
} });
mock.module('@/modules/notifications/index.js', { namedExports: {
  notifyRunFailed() {},
  notifyRunStopped() {},
} });
const { cursorRuntime } = await import('@/modules/providers/list/cursor/cursor-runtime.provider.js');

async function withFixture(exercise: (current: RuntimeFixture) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(path.join(process.env.WORKSPACES_ROOT!, 'cursor-'));
  const runs: Promise<void>[] = [];
  const holds: ReturnType<typeof gate>[] = [];
  spawnWaiters.clear();
  fixture = {
    cwd,
    context: {
      resolveProviderSessionId: () => null,
      resolveResumeModel: async () => 'composer-fixture',
      getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'composer-fixture' }),
      normalizeMessage: () => [],
      isProviderInstalled: async () => true,
    },
    frames: [],
    processes: [],
    spawns: [],
    terminations: [],
    async terminate(child) { child.close(null, 'SIGTERM'); },
    waitForProcess(index) {
      const child = fixture.processes[index];
      return child ? Promise.resolve(child) : new Promise(resolve => { spawnWaiters.set(index, resolve); });
    },
    hold() {
      const held = gate();
      holds.push(held);
      return held;
    },
    start(sessionId, options = {}, send) {
      const run = cursorRuntime.run('fixture prompt', { cwd, sessionId, ...options }, {
        send(frame: unknown) {
          fixture.frames.push(frame as RuntimeFrame);
          send?.(frame as RuntimeFrame);
        },
      }, fixture.context);
      runs.push(run);
      // Tests retain and assert the original promise; attach a rejection
      // observer immediately for deliberately rejected admission/stop paths.
      void run.catch(() => {});
      return run;
    },
  };
  try {
    await exercise(fixture);
  } finally {
    for (const held of holds) held.resolve();
    fixture.terminate = async child => { child.close(null, 'SIGTERM'); };
    for (const child of fixture.processes) child.close();
    await nextTurn();
    for (const runId of ['preparing', 'trust-cancel', 'trust-success', 'result', 'successor', 'retry-stop']) {
      await cursorRuntime.abort(runId);
    }
    await Promise.allSettled(runs);
  }
}

after(async () => {
  mock.restoreAll();
  for (const [name, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  assert.equal(path.dirname(tempRoot), path.resolve(os.tmpdir()));
  await rm(tempRoot, { recursive: true, force: true });
});

test('Cursor preparation cancellation waits for preparation and never spawns the CLI', { timeout: 5000 }, async () => {
  await withFixture(async current => {
    const entered = current.hold();
    const modelReady = current.hold();
    current.context.resolveResumeModel = async () => { entered.resolve(); await modelReady.promise; return 'composer-fixture'; };
    const cancellation = new AbortController();
    const run = current.start('preparing', { abortSignal: cancellation.signal });
    await entered.promise;
    cancellation.abort();
    let stopped = false;
    const stop = cursorRuntime.abort('preparing').then(success => { stopped = success; });
    await nextTurn();
    assert.equal(stopped, false);
    assert.equal(current.processes.length, 0);
    assert.equal(current.terminations.length, 0);
    assert.equal(current.frames.some(frame => frame.kind === 'complete' || frame.text === 'model_stopped'), false);
    await assert.rejects(current.start('preparing'), /still running or stopping/);

    modelReady.resolve();
    await Promise.all([run, stop]);
    assert.equal(stopped, true);
    assert.equal(current.processes.length, 0);
    const status = current.frames.filter(frame => frame.text === 'model_stopped');
    assert.equal(status.length, 1);
    assert.equal(status[0].kind, 'status');
    assert.equal(status[0].sessionId, 'preparing');
    assert.equal(status[0].provider, 'cursor');
    assert.equal(status[0].canInterrupt, false);
    assert.ok(status[0].id);
    assert.ok(status[0].timestamp);
    assert.equal(current.frames.some(frame => frame.kind === 'complete'), false);
    assert.equal(await cursorRuntime.abort('preparing'), false);
  });
});

test('cancelled Cursor trust prompts cannot restart and close cannot bypass group termination', { timeout: 5000 }, async () => {
  await withFixture(async current => {
    const groupStopped = current.hold();
    current.terminate = async () => groupStopped.promise;
    const cancellation = new AbortController();
    const run = current.start('trust-cancel', { abortSignal: cancellation.signal });
    const child = await current.waitForProcess(0);
    child.stderr.write('workspace trust required\n');
    cancellation.abort();
    let confirmed = false;
    const stop = cursorRuntime.abort('trust-cancel').then(success => { confirmed = success; });
    child.close(null, 'SIGTERM');
    await nextTurn();
    assert.equal(confirmed, false);
    assert.equal(current.processes.length, 1);
    assert.deepEqual(current.terminations, [child]);
    assert.equal(current.frames.some(frame => frame.kind === 'complete' || frame.text === 'model_stopped'), false);
    await assert.rejects(current.start('trust-cancel'), /still running or stopping/);

    groupStopped.resolve();
    await Promise.all([run, stop]);
    assert.equal(confirmed, true);
    assert.equal(current.processes.length, 1);
    assert.equal(current.frames.filter(frame => frame.text === 'model_stopped').length, 1);
    assert.equal(current.frames.some(frame => frame.kind === 'complete'), false);
  });
});

test('uncancelled Cursor still retries trust once and completes only after the retry closes', { timeout: 5000 }, async () => {
  await withFixture(async current => {
    const run = current.start('trust-success');
    const first = await current.waitForProcess(0);
    first.stderr.write('workspace trust required\n');
    first.close(1);
    const retry = await current.waitForProcess(1);
    assert.equal(current.spawns[0].command, 'cursor-agent');
    assert.equal(current.spawns[0].options.detached, process.platform !== 'win32');
    assert.equal(current.spawns[0].args.includes('--trust'), false);
    assert.equal(current.spawns[1].args.includes('--trust'), true);
    retry.output({ type: 'result', subtype: 'success' });
    await nextTurn();
    assert.equal(current.frames.some(frame => frame.kind === 'complete'), false);
    retry.close(0);
    await run;
    assert.equal(current.processes.length, 2);
    const completes = current.frames.filter(frame => frame.kind === 'complete');
    assert.equal(completes.length, 1);
    assert.equal(completes[0].success, true);
  });
});

test('Cursor result retains admission until close and stale callbacks cannot lose the next owner', { timeout: 5000 }, async () => {
  await withFixture(async current => {
    let successor: Promise<void> | undefined;
    const run = current.start('result', {}, frame => {
      if (frame.kind === 'complete') successor = current.start('result');
    });
    const first = await current.waitForProcess(0);
    first.output({ type: 'result', subtype: 'success' });
    await nextTurn();
    assert.equal(current.frames.some(frame => frame.kind === 'complete'), false);
    await assert.rejects(current.start('result'), /still running or stopping/);
    first.close(0);
    await run;
    assert.equal(current.processes.length, 2, 'the terminal event must hand admission to its consumer');
    const next = current.processes[1];
    // Replay callbacks retained by the old instance after a new run owns the
    // app session. They must not delete or cancel that new run's handle.
    first.emit('close', 0, null);
    first.emit('error', new Error('late old process error'));
    assert.equal(await cursorRuntime.abort('result'), true);
    await successor;
    assert.deepEqual(current.terminations, [next]);
    assert.equal(current.frames.filter(frame => frame.kind === 'complete').length, 1);
    assert.equal(current.frames.filter(frame => frame.text === 'model_stopped').length, 1);
  });
});

test('Cursor termination failure retains occupancy and explicit stop retries the same process group', { timeout: 5000 }, async () => {
  await withFixture(async current => {
    const groupStopped = current.hold();
    let attempts = 0;
    current.terminate = async () => {
      if (++attempts === 1) throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
      await groupStopped.promise;
    };
    let settled = false;
    const run = current.start('retry-stop').then(() => { settled = true; });
    const child = await current.waitForProcess(0);
    await assert.rejects(cursorRuntime.abort('retry-stop'), /permission denied/);
    child.close(null, 'SIGTERM');
    await nextTurn();
    assert.equal(settled, false);
    assert.equal(current.frames.some(frame => frame.kind === 'complete' || frame.text === 'model_stopped'), false);
    await assert.rejects(current.start('retry-stop'), /still running or stopping/);

    let stopped = false;
    const stop = cursorRuntime.abort('retry-stop').then(success => { stopped = success; });
    await nextTurn();
    assert.equal(stopped, false);
    assert.equal(settled, false);
    assert.deepEqual(current.terminations, [child, child]);
    groupStopped.resolve();
    await Promise.all([run, stop]);
    assert.equal(stopped, true);
    assert.equal(settled, true);
    assert.equal(current.frames.filter(frame => frame.text === 'model_stopped').length, 1);
    assert.equal(current.frames.some(frame => frame.kind === 'complete'), false);
  });
});
