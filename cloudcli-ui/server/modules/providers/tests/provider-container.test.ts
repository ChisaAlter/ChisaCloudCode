import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { createContainerProviderRunner } from '@/modules/providers/services/provider-container.service.js';
import type { ProviderProcessJob } from '@/shared/index.js';

const runtime = { mounts: [], env: {}, args: ['worker', '--stdio'], cli: '/runtime/provider-code/fake' };
const job: ProviderProcessJob = { kind: 'cli', command: 'opencode', args: ['run'], cwd: '/fixture/execution' };

function fixture(close: () => Promise<void>) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let resolveCompletion!: (value: { code: number | null; signal: NodeJS.Signals | null }) => void;
  let rejectCompletion!: (error: unknown) => void;
  const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => { resolveCompletion = resolve; rejectCompletion = reject; });
  let captured: unknown;
  const execution = {
    cwd: '/fixture/execution',
    async spawnProcess(input: unknown) {
      captured = input;
      return { stdin, stdout, stderr, completion, close };
    },
  } as unknown as Parameters<typeof createContainerProviderRunner>[0];
  const runner = createContainerProviderRunner(execution, 'opencode', [], { prepareRuntime: () => runtime });
  return { stdin, stdout, stderr, completion, resolveCompletion, rejectCompletion, runner, captured: () => captured };
}

test('container worker frames preserve native output and await confirmed removal after done', async () => {
  let release!: () => void;
  const cleanup = new Promise<void>((resolve) => { release = resolve; });
  let closing = false;
  const process = fixture(async () => { closing = true; await cleanup; });
  const output: unknown[] = [];
  const running = process.runner(job, { stdout: (text) => output.push(text), event: (event) => output.push(event) });
  let settled = false;
  void running.finally(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  const command = JSON.parse(process.stdin.read().toString());
  assert.equal(command.job.command, '/runtime/provider-code/fake');
  process.stdout.write('{"kind":"stdout","text":"hel');
  process.stdout.write('lo"}\n{"kind":"event","event":{"type":"native"}}\n{"kind":"done","code":0}\n');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(output, ['hello', { type: 'native' }]);
  assert.equal(closing, true);
  assert.equal(settled, false);
  release();
  assert.equal((await running).code, 0);
});

test('failed container removal remains an explicit unsafe teardown', async () => {
  const process = fixture(async () => { throw Object.assign(new Error('container retained'), { workspaceCleanupError: true }); });
  const running = process.runner(job, {});
  await new Promise((resolve) => setImmediate(resolve));
  process.stdout.write('{"kind":"done","code":0}\n');
  await assert.rejects(running, { processTeardownError: true, workspaceCleanupError: true });
});

test('launcher errors after confirmed removal do not retain an unsafe teardown flag', async () => {
  const missing = Object.assign(new Error('docker is unavailable'), { code: 'ENOENT' });
  const process = fixture(async () => { throw missing; });
  const running = process.runner(job, {});
  await new Promise((resolve) => setImmediate(resolve));
  process.rejectCompletion(missing);
  await assert.rejects(running, (error: any) => error === missing && !error.processTeardownError);
});

test('external cancellation reports AbortError only after successful container cleanup', async () => {
  const cancellation = new AbortController();
  const abort = Object.assign(new Error('cancelled'), { name: 'AbortError' });
  let removed = false;
  const process = fixture(async () => { removed = true; throw abort; });
  const running = process.runner(job, {}, cancellation.signal);
  await new Promise((resolve) => setImmediate(resolve));
  cancellation.abort();
  process.rejectCompletion(abort);
  await assert.rejects(running, { name: 'AbortError' });
  assert.equal(removed, true);
});

test('oversized unterminated worker output confirms cleanup before rejecting the protocol', async () => {
  let removed = false;
  const process = fixture(async () => { removed = true; });
  const running = process.runner(job, {});
  await new Promise((resolve) => setImmediate(resolve));
  process.stdout.write('x'.repeat(8 * 1024 * 1024 + 1));
  await assert.rejects(running, { code: 'WORKSPACE_PROVIDER_RUNTIME_UNAVAILABLE' });
  assert.equal(removed, true);
});

test('malformed worker frames still confirm cleanup before propagating error', async () => {
  let removed = false;
  const process = fixture(async () => { removed = true; });
  const running = process.runner(job, {});
  await new Promise((resolve) => setImmediate(resolve));
  process.stdout.write('not-json\n');
  await assert.rejects(running, SyntaxError);
  assert.equal(removed, true);
});
