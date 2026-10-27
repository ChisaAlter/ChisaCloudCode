import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';
import { promisify } from 'node:util';

const root = path.resolve(os.tmpdir(), 'chisa-retirement-fixture');
const owner = 'a'.repeat(24);
const name = 'chisa-workspace-sync-' + owner;
const immutableId = 'b'.repeat(64);
const configuration = path.join(os.homedir(), '.chisa-workspace-sync', owner);

function transport() {
  return {
    Id: immutableId,
    Name: '/' + name,
    Config: { Labels: { 'chisa.workspace-sync.owner': owner } },
    HostConfig: { Privileged: false, NetworkMode: 'chisa-workspace-network-' + owner, RestartPolicy: { Name: 'unless-stopped' } },
    State: { Running: true, Restarting: false },
    Mounts: [
      { Type: 'bind', Source: root, Destination: root, RW: true },
      { Type: 'bind', Source: configuration, Destination: '/etc/chisa-sync', RW: false },
      { Type: 'bind', Source: path.join(configuration, 'staging'), Destination: '/root/.mutagen/staging', RW: true },
    ],
  };
}

type TransportFixture = ReturnType<typeof transport>;
const containers = new Map<string, TransportFixture>();
const commands: string[][] = [];
const inspectionFailures = new Map<string, Error>();
const inspectionOutput = new Map<string, string>();
let namedId: string | undefined;
let updateFailure: Error | undefined;
let stopFailure: Error | undefined;
let ignoreUpdate = false;
let ignoreStop = false;
let removeAfterStop = false;
let afterNamedInspection: (() => void) | undefined;
let beforeFinalInspection: (() => void) | undefined;

const fakeExec = Object.assign(() => undefined, { [promisify.custom]: async (command: string, args: string[], options: { timeout: number; maxBuffer: number }) => {
  assert.equal(command, 'docker');
  assert.ok(options.timeout > 0, 'Docker calls must have a timeout');
  assert.ok(options.maxBuffer > 0, 'Docker output must be bounded');
  commands.push([...args]);
  const target = args.at(-1)!;
  if (args[0] === 'container' && args[1] === 'inspect') {
    if (target === immutableId) beforeFinalInspection?.();
    const failure = inspectionFailures.get(target);
    if (failure) throw failure;
    if (inspectionOutput.has(target)) return { stdout: inspectionOutput.get(target)!, stderr: '' };
    const container = containers.get(target === name ? namedId ?? '' : target);
    if (!container) throw Object.assign(new Error('container absent'), { stderr: 'Error: No such object: ' + target });
    const stdout = JSON.stringify([container]);
    if (target === name) afterNamedInspection?.();
    return { stdout, stderr: '' };
  }
  // Reject any name-based mutation even when the fake happens to know that name.
  assert.equal(target, immutableId, 'retirement mutations must pin the inspected immutable container ID');
  const container = containers.get(target)!;
  assert.ok(container);
  if (args[0] === 'update') {
    assert.deepEqual(args, ['update', '--restart=no', immutableId]);
    if (updateFailure) throw updateFailure;
    if (!ignoreUpdate) container.HostConfig.RestartPolicy.Name = 'no';
  } else if (args[0] === 'stop') {
    assert.deepEqual(args, ['stop', '--time', '10', immutableId]);
    if (stopFailure) throw stopFailure;
    if (!ignoreStop) container.State = { Running: false, Restarting: false };
    if (removeAfterStop) containers.delete(target);
  } else {
    assert.fail('retirement must not remove, create, start, or restart containers: ' + args.join(' '));
  }
  return { stdout: target, stderr: '' };
} });
mock.module('node:child_process', { namedExports: { ...childProcess, execFile: fakeExec as unknown as typeof childProcess.execFile } });
const { retireWorkspaceSyncTransport } = await import('../workspace-runtime-retirement.service.js');

test.beforeEach(() => {
  containers.clear(); containers.set(immutableId, transport()); namedId = immutableId;
  commands.length = 0; inspectionFailures.clear(); inspectionOutput.clear();
  updateFailure = stopFailure = undefined;
  ignoreUpdate = ignoreStop = removeAfterStop = false;
  afterNamedInspection = beforeFinalInspection = undefined;
});

test('retirement disables auto restart before stopping only the verified immutable ID and retains all mounts', async () => {
  const original = structuredClone(containers.get(immutableId)!);
  await retireWorkspaceSyncTransport(root, owner);
  assert.deepEqual(commands, [
    ['container', 'inspect', name],
    ['update', '--restart=no', immutableId],
    ['stop', '--time', '10', immutableId],
    ['container', 'inspect', immutableId],
  ]);
  const retained = containers.get(immutableId)!;
  assert.deepEqual(retained.Mounts, original.Mounts);
  assert.deepEqual(retained.Config, original.Config);
  assert.equal(retained.HostConfig.RestartPolicy.Name, 'no');
  assert.deepEqual(retained.State, { Running: false, Restarting: false });
  assert.equal(containers.size, 1, 'stopped transport remains available for manual inspection');
});

test('a concurrent replacement of the Docker name cannot redirect stop or restart policy changes', async () => {
  const replacement = { ...transport(), Id: 'c'.repeat(64) };
  afterNamedInspection = () => { containers.set(replacement.Id, replacement); namedId = replacement.Id; };
  await retireWorkspaceSyncTransport(root, owner);
  assert.deepEqual(replacement.State, { Running: true, Restarting: false });
  assert.equal(replacement.HostConfig.RestartPolicy.Name, 'unless-stopped');
  assert.equal(containers.get(immutableId)!.State.Running, false);
  assert.equal(commands.slice(1).every(args => args.at(-1) === immutableId), true);
});

test('an already retired transport is verified again without mutations', async () => {
  const container = containers.get(immutableId)!;
  container.State.Running = false; container.HostConfig.RestartPolicy.Name = 'no';
  await retireWorkspaceSyncTransport(root, owner);
  assert.deepEqual(commands, [['container', 'inspect', name], ['container', 'inspect', immutableId]]);
});

test('a stopped transport still loses its restart policy and a restarting transport is explicitly stopped', async () => {
  const container = containers.get(immutableId)!;
  container.State.Running = false;
  await retireWorkspaceSyncTransport(root, owner);
  assert.deepEqual(commands.map(args => args[0]), ['container', 'update', 'container']);
  commands.length = 0; container.State.Restarting = true;
  await retireWorkspaceSyncTransport(root, owner);
  assert.deepEqual(commands.map(args => args[0]), ['container', 'stop', 'container']);
});

test('the former bridge transport without a staging mount can be retired', async () => {
  const container = containers.get(immutableId)!;
  container.HostConfig.NetworkMode = 'bridge'; container.Mounts.pop();
  await retireWorkspaceSyncTransport(root, owner);
  assert.equal(container.State.Running, false);
  assert.equal(container.Mounts.length, 2);
});

const invalidTransports: Array<{ label: string; change: (container: TransportFixture) => void }> = [
  { label: 'foreign owner label', change: container => { container.Config.Labels['chisa.workspace-sync.owner'] = 'foreign'; } },
  { label: 'different container name', change: container => { container.Name += '-foreign'; } },
  { label: 'nonimmutable container ID', change: container => { container.Id = 'short-id'; } },
  { label: 'privileged container', change: container => { container.HostConfig.Privileged = true; } },
  { label: 'host network', change: container => { container.HostConfig.NetworkMode = 'host'; } },
  { label: 'another account network', change: container => { container.HostConfig.NetworkMode = 'chisa-workspace-network-foreign'; } },
  { label: 'different project source', change: container => { container.Mounts[0].Source = root + '-foreign'; } },
  { label: 'read only project mount', change: container => { container.Mounts[0].RW = false; } },
  { label: 'writable configuration mount', change: container => { container.Mounts[1].RW = true; } },
  { label: 'different configuration source', change: container => { container.Mounts[1].Source = path.join(configuration, 'foreign'); } },
  { label: 'different staging source', change: container => { container.Mounts[2].Source = path.join(configuration, 'foreign-staging'); } },
  { label: 'volume in place of bind', change: container => { container.Mounts[0].Type = 'volume'; } },
  { label: 'unexpected extra mount', change: container => { container.Mounts.push({ Type: 'bind', Source: root, Destination: '/extra', RW: true }); } },
];
for (const invalid of invalidTransports) {
  test('retirement rejects ' + invalid.label + ' without any Docker mutation', async () => {
    invalid.change(containers.get(immutableId)!);
    const before = structuredClone(containers.get(immutableId)!);
    await assert.rejects(retireWorkspaceSyncTransport(root, owner), { code: 'WORKSPACE_RUNTIME_MISMATCH', statusCode: 503 });
    assert.deepEqual(commands, [['container', 'inspect', name]]);
    assert.deepEqual(containers.get(immutableId), before);
  });
}

test('only the exact named container absence makes retirement a no-op', async () => {
  for (const diagnostic of ['No such container: ', 'Error: No such object: ', 'Error response from daemon: No such container: ']) {
    commands.length = 0;
    inspectionFailures.set(name, Object.assign(new Error('absent'), { stderr: diagnostic + name + '\n' }));
    await retireWorkspaceSyncTransport(root, owner);
    assert.deepEqual(commands, [['container', 'inspect', name]]);
  }
});

test('daemon failures and another container absence cannot be treated as successful retirement', async () => {
  for (const stderr of ['permission denied', 'Cannot connect to the Docker daemon', 'Error: No such object: foreign', 'Error: No such container: ' + name + '-foreign']) {
    commands.length = 0;
    const failure = Object.assign(new Error('inspect failed'), { stderr });
    inspectionFailures.set(name, failure);
    await assert.rejects(retireWorkspaceSyncTransport(root, owner), error => error === failure);
    assert.deepEqual(commands, [['container', 'inspect', name]]);
  }
});

test('ambiguous or malformed inspection output cannot authorize container mutations', async () => {
  for (const output of ['{broken', 'null', '{}', '[]', '[null]', '[1]', JSON.stringify([transport(), transport()])]) {
    commands.length = 0; inspectionOutput.set(name, output);
    await assert.rejects(retireWorkspaceSyncTransport(root, owner));
    assert.deepEqual(commands, [['container', 'inspect', name]]);
  }
});

test('failed restart policy changes and failed stop commands surface and remain retryable', async () => {
  const failure = new Error('Docker update failed');
  updateFailure = failure;
  await assert.rejects(retireWorkspaceSyncTransport(root, owner), error => error === failure);
  assert.deepEqual(commands.map(args => args[0]), ['container', 'update']);
  assert.equal(containers.get(immutableId)!.State.Running, true);
  updateFailure = undefined; stopFailure = new Error('Docker stop failed'); commands.length = 0;
  await assert.rejects(retireWorkspaceSyncTransport(root, owner), error => error === stopFailure);
  assert.deepEqual(commands.map(args => args[0]), ['container', 'update', 'stop']);
  stopFailure = undefined; commands.length = 0;
  await retireWorkspaceSyncTransport(root, owner);
  assert.deepEqual(commands.map(args => args[0]), ['container', 'stop', 'container']);
});

test('retirement confirms both stopped state and disabled restart policy instead of trusting successful commands', async () => {
  ignoreStop = true;
  await assert.rejects(retireWorkspaceSyncTransport(root, owner), { code: 'WORKSPACE_RUNTIME_UNAVAILABLE', statusCode: 503 });
  ignoreStop = false; ignoreUpdate = true;
  containers.set(immutableId, transport()); commands.length = 0;
  await assert.rejects(retireWorkspaceSyncTransport(root, owner), { code: 'WORKSPACE_RUNTIME_UNAVAILABLE', statusCode: 503 });
  assert.equal(commands.at(-1)!.at(-1), immutableId);
});

test('final inspection must return the exact immutable ID and a confirmed nonrestarting state', async () => {
  for (const change of [
    (container: TransportFixture) => { container.Id = 'c'.repeat(64); },
    (container: TransportFixture) => { container.State.Restarting = true; },
  ]) {
    containers.set(immutableId, transport()); commands.length = 0;
    beforeFinalInspection = () => change(containers.get(immutableId)!);
    await assert.rejects(retireWorkspaceSyncTransport(root, owner), { code: 'WORKSPACE_RUNTIME_UNAVAILABLE', statusCode: 503 });
    assert.deepEqual(commands.at(-1), ['container', 'inspect', immutableId]);
  }
});

test('disappearance of the verified ID after stop is safe while a final daemon failure is not', async () => {
  removeAfterStop = true;
  await retireWorkspaceSyncTransport(root, owner);
  assert.deepEqual(commands.at(-1), ['container', 'inspect', immutableId]);
  containers.set(immutableId, transport()); removeAfterStop = false; commands.length = 0;
  const failure = Object.assign(new Error('daemon unavailable'), { stderr: 'Cannot connect to the Docker daemon' });
  inspectionFailures.set(immutableId, failure);
  await assert.rejects(retireWorkspaceSyncTransport(root, owner), error => error === failure);
  assert.deepEqual(commands.at(-1), ['container', 'inspect', immutableId]);
});
