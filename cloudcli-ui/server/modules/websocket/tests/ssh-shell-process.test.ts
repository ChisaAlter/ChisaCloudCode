import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import type { WorkspaceDescriptor } from '@/shared/index.js';
const descriptor: WorkspaceDescriptor = { projectId: 'project', workspaceId: 'workspace', generation: 'generation', sourceMode: 'ssh',
  kind: 'cloudReplica', rootPath: '/meta', sourceRoot: '/meta', displayPath: 'D:\\Code', requestedMode: 'shared', effectiveMode: 'shared',
  phase: 'idle', publicationState: 'integrated', capabilities: { read: true, write: true, git: true, shell: true, integrate: false, preview: false, cloudExecutionIndependentOfDesktop: false } };
let commands: string[] = [];
let run: (command: string, signal?: AbortSignal, options?: { onJobCreated?: (jobId: string) => void }) => Promise<unknown>;
let readOutput: (input: { jobId: string; stream?: 'stdout' | 'stderr'; offset?: number; maxBytes?: number }) => Promise<unknown>;
mock.module('@/modules/workspace-bridge/index.js', { namedExports: {
  assertWorkspaceDescriptor(value: WorkspaceDescriptor) { assert.equal(value.generation, 'generation'); },
  resolveSshProjectTarget() { return { projectId: 'project' }; },
  readSshWorkspaceJobOutput: async (_target: unknown, input: { jobId: string; stream?: 'stdout' | 'stderr'; offset?: number; maxBytes?: number }) => readOutput(input),
  runSshWorkspaceCommand: async (_descriptor: WorkspaceDescriptor, command: string, signal?: AbortSignal, options?: { onJobCreated?: (jobId: string) => void }) => { commands.push(command); return run(command, signal, options); },
} });
const { createSshCommandConsole } = await import('../services/ssh-shell-process.service.js');
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
test.beforeEach(() => {
  commands = [];
  run = async () => ({ stdout: 'actual Windows\n', stderr: 'warning\n', exitCode: 7 });
  readOutput = async ({ stream = 'stdout', offset = 0 }) => ({ ok: true, jobId: 'job-1', stream, offset, total: offset, chunk: '', eof: false, state: 'running', truncated: false });
});

test('Windows console executes entered lines remotely and reports actual status without launching a provider', async () => {
  const terminal = createSshCommandConsole(descriptor);
  let output = ''; terminal.onData(text => { output += text; });
  await tick();
  terminal.write('dotnet test\r\n');
  await tick();
  assert.deepEqual(commands, ['dotnet test']);
  assert.match(output, /actual Windows\r\nwarning\r\n/);
  assert.match(output, /exit 7/);
  assert.equal(terminal.transport, 'pipe');
  terminal.write('exit\r');
});

test('Windows console streams incremental job_output chunks before command completion without duplicating final output', async () => {
  let finishCommand!: (value: unknown) => void;
  readOutput = async ({ stream = 'stdout', offset = 0 }) => {
    if (stream === 'stdout' && offset === 0) {
      return { ok: true, jobId: 'job-stream', stream: 'stdout', offset: 0, total: 6, chunk: Buffer.from('step1\n', 'utf8').toString('base64'), eof: false, state: 'running', truncated: false };
    }
    return { ok: true, jobId: 'job-stream', stream, offset, total: offset, chunk: '', eof: false, state: 'running', truncated: false };
  };
  run = (_command, _signal, options) => new Promise(resolve => {
    finishCommand = resolve;
    options?.onJobCreated?.('job-stream');
  });
  const terminal = createSshCommandConsole(descriptor);
  let output = ''; terminal.onData(text => { output += text; });
  await tick();
  terminal.write('cargo test\r');
  await tick();
  await tick();
  // Streamed chunk arrives while the command is still running.
  assert.match(output, /step1\r\n/);
  assert.doesNotMatch(output, /step2/);
  finishCommand({ stdout: 'step1\nstep2\n', stderr: '', exitCode: 0 });
  await tick();
  await tick();
  // Only the un-streamed tail (step2) is appended on completion.
  assert.equal(output.match(/step1\r\n/g)?.length, 1);
  assert.match(output, /step1\r\nstep2\r\n/);
  assert.match(output, /\[exit 0\]/);
  await terminal.kill();
});

test('Ctrl+C aborts exact pending task and does not queue input while it is running', async () => {
  let aborted = false;
  run = (_command, signal) => new Promise((_resolve, reject) => signal?.addEventListener('abort', () => { aborted = true; reject(new Error('cancelled')); }));
  const terminal = createSshCommandConsole(descriptor);
  terminal.onData(() => {});
  await tick();
  terminal.write('long-running\r');
  await tick();
  terminal.write('do-not-replay\r\x03');
  await tick();
  assert.equal(aborted, true);
  assert.deepEqual(commands, ['long-running']);
  await terminal.kill();
});

test('uncertain remote teardown ends console with error instead of accepting another command', async () => {
  run = async () => { throw Object.assign(new Error('check job'), { code: 'SSH_EXECUTION_UNCONFIRMED' }); };
  const terminal = createSshCommandConsole(descriptor);
  const exits: unknown[] = []; terminal.onExit(exit => exits.push(exit)); terminal.onData(() => {});
  await tick(); terminal.write('build\r'); await tick();
  terminal.write('second\r'); await tick();
  assert.deepEqual(commands, ['build']);
  assert.equal(exits.length, 1);
  assert.equal((exits[0] as { exitCode: unknown }).exitCode, null);
});
