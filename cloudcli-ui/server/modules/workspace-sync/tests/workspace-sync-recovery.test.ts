import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile as realExecFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as realFiles from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test, { mock } from 'node:test';

const fixture = await mkdtemp(path.join(os.tmpdir(), 'chisa-recovery-'));
const root = path.join(fixture, 'workspace');
await mkdir(root);
process.env.WORKSPACES_ROOT = fixture;
process.env.HOME = fixture;
process.env.USERPROFILE = fixture;
process.env.DATABASE_PATH = path.join(fixture, 'auth.db');
const commands: string[][] = [];
let label: string | undefined;
let beforeInspection: (() => Promise<void>) | undefined;
let activeLease: { root: string; id: string; epoch: string } | undefined;
const birth = { processStartTime: '424242', bootId: '01234567-89ab-cdef-0123-456789abcdef' };
const processFields = Array<string>(20).fill('0');
processFields[0] = 'S';
processFields[19] = birth.processStartTime;
let foreignProcess: ChildProcess;
let foreignPid: number;
let foreignProcessState = '';
let foreignProcessError: Error | undefined;
let foreignExecutable = '/usr/bin/sleep';
let foreignExecutableError: Error | undefined;
let executableReads = 0;
const forbiddenProcessReads: string[] = [];
const fakeExec = Object.assign(() => undefined, {
  [promisify.custom]: async (command: string, args: string[]) => {
    assert.equal(command, 'docker');
    commands.push(args);
    if (args[0] === 'container') {
      await beforeInspection?.();
      if (label === undefined) throw Object.assign(new Error('absent'), { stderr: 'No such container' });
      return { stdout: JSON.stringify([{ Config: { Labels: { 'chisa.workspace-root': label } } }]), stderr: '' };
    }
    return { stdout: '', stderr: '' };
  },
});
mock.module('node:child_process', { namedExports: { execFile: fakeExec as unknown as typeof realExecFile } });
// Keep module composition from opening the real auth database or model runtimes.
mock.module('@/modules/workspace-bridge/index.js', { namedExports: {
  isActiveWorkspaceLease: (candidate: string, id: string, epoch: string) =>
    activeLease?.root === candidate && activeLease.id === id && activeLease.epoch === epoch,
} });
mock.module('node:fs/promises', { namedExports: {
  ...realFiles,
  readFile: async (filename: string, encoding: BufferEncoding) => {
    if (/\/(?:environ|cmdline)$/.test(filename) || filename === '/proc/stat') forbiddenProcessReads.push(filename);
    assert.ok(!/\/(?:environ|cmdline)$/.test(filename), 'recovery must not inspect process credentials or arguments');
    assert.notEqual(filename, '/proc/stat', 'legacy process roles must not depend on wall-clock estimates');
    if (filename === '/proc/' + process.pid + '/stat') return process.pid + ' (node (fixture)) ' + processFields.join(' ');
    if (filename === '/proc/' + foreignPid + '/stat') {
      if (foreignProcessError) throw foreignProcessError;
      return foreignProcessState;
    }
    if (filename === '/proc/sys/kernel/random/boot_id') return birth.bootId + '\n';
    return realFiles.readFile(filename, encoding);
  },
  readlink: async (filename: string) => {
    if (filename !== '/proc/' + foreignPid + '/exe') forbiddenProcessReads.push('readlink:' + filename);
    assert.equal(filename, '/proc/' + foreignPid + '/exe');
    executableReads++;
    if (foreignExecutableError) throw foreignExecutableError;
    return foreignExecutable;
  },
} });
const { checkWorkspaceSyncLeaseRecovery } = await import('../workspace-sync-recovery.service.js');
const statePath = path.join(root + '.chisa-lease', 'state.json');
const lease = { id: 'reservation', epoch: 'bound-epoch', owner: 'sync-needed', cleanupPending: ['chisa-rpc-0123456789abcdef'] };
const saveLease = async (state: unknown) => {
  await mkdir(root + '.chisa-lease', { recursive: true });
  await writeFile(statePath, JSON.stringify(state));
};
test.before(async () => {
  foreignProcess = spawn(process.execPath, ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000)'], {
    cwd: fixture, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  await once(foreignProcess.stdout!, 'data');
  foreignPid = foreignProcess.pid!;
  assert.notEqual(foreignPid, process.pid);
  process.kill(foreignPid, 0);
});

async function saveLegacyForeignLease(executable = '/usr/bin/sleep') {
  const legacy = { ...lease, cleanupPending: [], owner: 'claude', pid: foreignPid };
  await saveLease(legacy);
  foreignProcessState = foreignPid + ' (node (legacy fixture)) ' + processFields.join(' ');
  foreignExecutable = executable;
  foreignExecutableError = undefined;
  foreignProcessError = undefined;
  executableReads = 0;
  commands.length = 0;
  return legacy;
}

test('host recovery retains running Claude and rejects stale bindings before touching Docker', async () => {
  try {
    await saveLease({ ...lease, owner: 'claude', pid: process.pid, ...birth });
    await assert.rejects(checkWorkspaceSyncLeaseRecovery(root, lease.epoch), { code: 'WORKSPACE_BUSY' });
    assert.equal(commands.length, 0);
    assert.equal((JSON.parse(await readFile(statePath, 'utf8')) as { pid: number }).pid, process.pid);
    await assert.rejects(checkWorkspaceSyncLeaseRecovery(root, 'wrong-epoch'), { code: 'STALE_BINDING' });
    await saveLease({ ...lease, owner: 'pi' });
    await assert.rejects(checkWorkspaceSyncLeaseRecovery(root, lease.epoch), { code: 'STALE_BINDING' });
    await saveLease({ ...lease, cleanupPending: ['unrelated-container'] });
    await assert.rejects(checkWorkspaceSyncLeaseRecovery(root, lease.epoch), { code: 'WORKSPACE_CLEANUP_FAILED' });
    assert.equal(commands.length, 0);
  } finally { commands.length = 0; }
});

test('a reused live PID with another process birth or boot can recover without changing its reservation', async () => {
  for (const identity of [
    { ...birth, processStartTime: '424241' },
    { ...birth, bootId: 'fedcba98-7654-3210-fedc-ba9876543210' },
  ]) {
    const stale = { ...lease, cleanupPending: [], owner: 'claude', pid: process.pid, ...identity };
    await saveLease(stale);
    commands.length = 0;
    assert.deepEqual(await checkWorkspaceSyncLeaseRecovery(root, lease.epoch), { ok: true, lease: stale });
    assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')), stale);
    assert.equal(commands.length, 0);
  }
});

test('an authoritative active reservation always remains busy despite stale or missing birth metadata', async () => {
  activeLease = { root, id: lease.id, epoch: lease.epoch };
  try {
    for (const identity of [{ ...birth, processStartTime: '424241' }, {}]) {
      const active = { ...lease, owner: 'claude', pid: process.pid, ...identity };
      await saveLease(active);
      commands.length = 0;
      await assert.rejects(checkWorkspaceSyncLeaseRecovery(root, lease.epoch), { code: 'WORKSPACE_BUSY' });
      assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')), active);
      assert.equal(commands.length, 0);
    }
  } finally { activeLease = undefined; }
});

test('a legacy lease with the current PID but no exact active reservation can recover', async () => {
  const stale = { ...lease, cleanupPending: [], owner: 'claude', pid: process.pid };
  await saveLease(stale);
  commands.length = 0;
  for (const otherReservation of [undefined,
    { root: root + '-other', id: lease.id, epoch: lease.epoch },
    { root, id: 'another-run', epoch: lease.epoch },
    { root, id: lease.id, epoch: 'another-epoch' },
  ]) {
    activeLease = otherReservation;
    assert.deepEqual(await checkWorkspaceSyncLeaseRecovery(root, lease.epoch), { ok: true, lease: stale });
  }
  activeLease = undefined;
  assert.equal(commands.length, 0);
  assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')), stale);
});

test('a reused live non-current PID with an explicit system non-Node executable can recover', async () => {
  for (const executable of ['/bin/sleep', '/sbin/systemd', '/usr/bin/python3.11', '/usr/sbin/sshd', '/bin/bash (deleted)']) {
    const legacy = await saveLegacyForeignLease(executable);
    process.kill(foreignPid, 0);
    assert.deepEqual(await checkWorkspaceSyncLeaseRecovery(root, lease.epoch), { ok: true, lease: legacy });
    assert.ok(executableReads > 0);
    assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')), legacy);
    assert.equal(commands.length, 0);
  }
});

test('Node and unknown executable aliases keep a live non-current legacy PID busy', async () => {
  for (const executable of ['/usr/bin/node', '/usr/bin/nodejs', process.execPath, '/opt/chisa/custom-node', '/usr/local/bin/sleep', '/usr/bin/node-alias']) {
    const legacy = await saveLegacyForeignLease(executable);
    process.kill(foreignPid, 0);
    await assert.rejects(checkWorkspaceSyncLeaseRecovery(root, lease.epoch), { code: 'WORKSPACE_BUSY' });
    assert.ok(executableReads > 0);
    assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')), legacy);
    assert.equal(commands.length, 0);
  }
});

test('an exact active legacy reservation wins over a known non-Node executable role', async () => {
  const legacy = await saveLegacyForeignLease('/usr/bin/sleep');
  activeLease = { root, id: lease.id, epoch: lease.epoch };
  try {
    await assert.rejects(checkWorkspaceSyncLeaseRecovery(root, lease.epoch), { code: 'WORKSPACE_BUSY' });
    assert.equal(executableReads, 0, 'active ownership must be checked before process role inspection');
    assert.equal(commands.length, 0);
    assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')), legacy);
  } finally { activeLease = undefined; }
});

test('missing or inaccessible proc stat does not prove exit while its legacy PID is alive', async () => {
  for (const code of ['ENOENT', 'EACCES', 'EPERM']) {
    const legacy = await saveLegacyForeignLease('/usr/bin/sleep');
    foreignProcessError = Object.assign(new Error('proc entry unavailable'), { code });
    try {
      process.kill(foreignPid, 0);
      await assert.rejects(checkWorkspaceSyncLeaseRecovery(root, lease.epoch), { code: 'WORKSPACE_BUSY' });
      assert.equal(executableReads, 0);
      assert.equal(commands.length, 0);
      assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')), legacy);
    } finally { foreignProcessError = undefined; }
  }
});

test('a missing or inaccessible executable keeps a live legacy PID busy', async () => {
  for (const code of ['ENOENT', 'EACCES', 'EPERM']) {
    const legacy = await saveLegacyForeignLease('/usr/bin/sleep');
    foreignExecutableError = Object.assign(new Error('exe unavailable'), { code });
    process.kill(foreignPid, 0);
    await assert.rejects(checkWorkspaceSyncLeaseRecovery(root, lease.epoch), { code: 'WORKSPACE_BUSY' });
    assert.ok(executableReads > 0);
    assert.equal(commands.length, 0);
    assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')), legacy);
  }
  foreignExecutableError = undefined;
});

test('malformed legacy proc identity is rejected before executable inspection', async () => {
  const legacy = await saveLegacyForeignLease('/usr/bin/sleep');
  foreignProcessState = foreignPid + ' (node) S invalid';
  await assert.rejects(checkWorkspaceSyncLeaseRecovery(root, lease.epoch), { code: 'STALE_BINDING' });
  assert.equal(executableReads, 0);
  assert.equal(commands.length, 0);
  assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')), legacy);
});

test('a zombie non-current legacy process can recover without executable inspection', async () => {
  const legacy = await saveLegacyForeignLease();
  foreignProcessState = foreignProcessState.replace(') S ', ') Z ');
  assert.deepEqual(await checkWorkspaceSyncLeaseRecovery(root, lease.epoch), { ok: true, lease: legacy });
  assert.equal(executableReads, 0);
  assert.equal(commands.length, 0);
});

test('a terminated non-current legacy process can recover without reading its executable', async () => {
  const legacy = await saveLegacyForeignLease('/usr/bin/node');
  const exited = once(foreignProcess, 'close');
  foreignProcess.kill();
  await exited;
  assert.throws(() => process.kill(foreignPid, 0), { code: 'ESRCH' });
  assert.deepEqual(await checkWorkspaceSyncLeaseRecovery(root, lease.epoch), { ok: true, lease: legacy });
  assert.equal(executableReads, 0);
  assert.equal(commands.length, 0);
  assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')), legacy);
});

test('invalid Claude process identity is rejected before Docker cleanup', async () => {
  for (const identity of [
    { pid: 0, ...birth }, { pid: 1.5, ...birth }, { pid: String(process.pid), ...birth },
    { pid: process.pid, processStartTime: 'not-a-tick', bootId: birth.bootId },
    { pid: process.pid, processStartTime: birth.processStartTime },
    { pid: process.pid, bootId: birth.bootId },
    { pid: process.pid, processStartTime: birth.processStartTime, bootId: 'invalid-boot' },
  ]) {
    const invalid = { ...lease, owner: 'claude', ...identity };
    await saveLease(invalid);
    commands.length = 0;
    await assert.rejects(checkWorkspaceSyncLeaseRecovery(root, lease.epoch), { code: 'STALE_BINDING' });
    assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')), invalid);
    assert.equal(commands.length, 0);
  }
});

test('cleanup removes only the workspace-labelled worker and returns the unchanged reservation', async () => {
  await saveLease(lease);
  label = 'another-workspace';
  await assert.rejects(checkWorkspaceSyncLeaseRecovery(root, lease.epoch), { code: 'WORKSPACE_CLEANUP_FAILED', statusCode: 403 });
  assert.ok(!commands.some(args => args[0] === 'rm'));
  commands.length = 0;
  label = createHash('sha256').update(root).digest('hex');
  assert.deepEqual(await checkWorkspaceSyncLeaseRecovery(root, lease.epoch), { ok: true, lease });
  assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')), lease);
  assert.deepEqual(commands.map(args => args[0]), ['container', 'rm', 'ps']);
  commands.length = 0;
  label = undefined;
  assert.deepEqual(await checkWorkspaceSyncLeaseRecovery(root, lease.epoch), { ok: true, lease });
  assert.deepEqual(commands.map(args => args[0]), ['container', 'ps']);
});

test('startup preview cleanup requires the same exact reservation and workspace label', async () => {
  const previewLease = { ...lease, cleanupPending: ['chisa-account-preview-0123456789abcdef0123-0123456789abcdef'] };
  await saveLease(previewLease);
  commands.length = 0;
  label = 'foreign-workspace';
  await assert.rejects(checkWorkspaceSyncLeaseRecovery(root, lease.epoch), { code: 'WORKSPACE_CLEANUP_FAILED', statusCode: 403 });
  assert.ok(!commands.some(args => args[0] === 'rm'));
  label = createHash('sha256').update(root).digest('hex');
  commands.length = 0;
  assert.deepEqual(await checkWorkspaceSyncLeaseRecovery(root, lease.epoch), { ok: true, lease: previewLease });
  assert.deepEqual(commands.find(args => args[0] === 'rm'), ['rm', '--force', previewLease.cleanupPending[0]]);
  assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')), previewLease);
});

test('a changed reservation between host check and removal prevents cleanup', async () => {
  await saveLease(lease);
  commands.length = 0;
  label = createHash('sha256').update(root).digest('hex');
  beforeInspection = () => saveLease({ ...lease, id: 'new-task' });
  await assert.rejects(checkWorkspaceSyncLeaseRecovery(root, lease.epoch), { code: 'STALE_BINDING' });
  assert.ok(!commands.some(args => args[0] === 'rm'));
  beforeInspection = undefined;
  await rm(root + '.chisa-lease', { recursive: true });
  assert.deepEqual(await checkWorkspaceSyncLeaseRecovery(root, lease.epoch), { ok: true, lease: null });
});

test.after(async () => {
  if (foreignProcess && foreignProcess.exitCode === null && foreignProcess.signalCode === null) {
    const exited = once(foreignProcess, 'close');
    foreignProcess.kill();
    await exited;
  }
  await rm(fixture, { recursive: true, force: true });
  assert.deepEqual(forbiddenProcessReads, [], 'recovery must not read argv, environment, unrelated executable paths, or clock estimates');
});
