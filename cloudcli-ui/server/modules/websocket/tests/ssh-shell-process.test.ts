import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import type { WorkspaceDescriptor } from '@/shared/index.js';
const descriptor: WorkspaceDescriptor = { projectId: 'project', workspaceId: 'workspace', generation: 'generation', sourceMode: 'ssh',
  kind: 'cloudReplica', rootPath: '/meta', sourceRoot: '/meta', displayPath: 'D:\\Code', requestedMode: 'shared', effectiveMode: 'shared',
  phase: 'idle', publicationState: 'integrated', capabilities: { read: true, write: true, git: true, shell: true, integrate: false, preview: false, cloudExecutionIndependentOfDesktop: false } };
let commands: string[] = [];
let run: (command: string, signal?: AbortSignal) => Promise<unknown>;
mock.module('@/modules/workspace-bridge/index.js', { namedExports: {
  assertWorkspaceDescriptor(value: WorkspaceDescriptor) { assert.equal(value.generation, 'generation'); },
  resolveSshProjectTarget() { return { projectId: 'project' }; },
  runSshWorkspaceCommand: async (_descriptor: WorkspaceDescriptor, command: string, signal?: AbortSignal) => { commands.push(command); return run(command, signal); },
} });
const { createSshCommandConsole } = await import('../services/ssh-shell-process.service.js');
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
test.beforeEach(() => { commands = []; run = async () => ({ stdout: 'actual Windows\n', stderr: 'warning\n', exitCode: 7 }); });

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
