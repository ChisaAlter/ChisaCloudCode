import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, rm, writeFile, readFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import test, { mock } from 'node:test';

import type { SshProjectTarget } from '@/shared/types.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'chisa-ssh-route-'));
process.env.WORKSPACES_ROOT = root;
const anchor = path.join(root, '.chisa-ssh-projects', 'project');
await mkdir(anchor, { recursive: true });
await writeFile(path.join(anchor, 'same.txt'), 'VPS decoy');
let target: SshProjectTarget = { projectId: 'project', ownerId: 'owner', connectionId: 'windows', connectionLabel: 'Laptop',
  rootPath: 'D:\\Code\\App', rootIdentity: 'volume-file-id', generation: 'epoch', workspaceId: 'target', anchorPath: anchor,
  phase: 'idle', activeRunId: null, pendingJobId: null };
const requests: Record<string, unknown>[] = [];
const admissions: string[] = [];
let fail: Error | undefined;
let probes = 0;
let holdExecution: Promise<void> | undefined;
let pendingReference: string | undefined;
let receiptConfirmed = true;
let onExecute: ((request: Record<string, unknown>) => void) | undefined;
let remoteContent = Buffer.from('Windows source');
let sdk: ((input: unknown) => unknown) | undefined;
mock.module('@/modules/database/index.js', { namedExports: {
  sshProjectTargetsDb: {
    getByPath(candidate: string) { return candidate === anchor || candidate.startsWith(anchor + path.sep) ? { ...target } : null; },
    getByProjectId() { return { ...target }; },
    getByAnchor() { return { ...target }; },
    pinSession() {},
    beginRun(_project: string, id: string) { if (target.phase !== 'idle') throw Object.assign(new Error('busy'), { code: 'WORKSPACE_BUSY' }); admissions.push(id); target = { ...target, phase: 'running', activeRunId: id }; return target; },
    finishRun(_project: string, id: string, options: { uncertain?: boolean; pendingJobId?: string } = {}) {
      assert.equal(target.activeRunId, id); target = { ...target, phase: options.uncertain ? 'recovery' : 'idle', activeRunId: options.uncertain ? id : null, pendingJobId: options.pendingJobId ?? null }; return target;
    },
    recoverRun() { target = { ...target, phase: 'idle', activeRunId: null, pendingJobId: null }; },
    setPendingJob(_project: string, id: string, jobId: string | null) { assert.equal(id, target.activeRunId); target = { ...target, pendingJobId: jobId }; },
  },
  sessionsDb: { getSessionById: () => ({ session_id: 'session', project_path: anchor, workspace_mode: 'shared' }) },
} });
mock.module('@/modules/ssh-workspaces/index.js', { namedExports: {
  probeSshWorkspace: async () => { probes++; if (fail) throw fail; return { rootIdentity: target.rootIdentity, rootPath: target.rootPath }; },
  executeSshWorkspace: async (input: { expectedRootIdentity: string; request: Record<string, unknown>; onJobCreated?: (id: string) => void }) => {
    requests.push(input.request); assert.equal(input.expectedRootIdentity, target.rootIdentity);
    if (pendingReference && ['write', 'mkdir', 'rename', 'copy', 'remove'].includes(String(input.request.op))) input.onJobCreated?.(pendingReference);
    onExecute?.(input.request);
    if (holdExecution && input.request.op === 'exec') await holdExecution;
    if (fail) throw fail;
    if (input.request.op === 'batch') return { ok: true, results: (input.request.requests as Record<string, unknown>[]).map(request => request.op === 'realpath'
      ? { ok: true, path: request.path } : { ok: true, size: 1, mtime: 1, mode: 0o040755, dir: true, symlink: false }) };
    if (input.request.op === 'read') return { ok: true, b64: remoteContent.toString('base64'), hash: 'hash' };
    if (input.request.op === 'realpath') return { ok: true, path: '/workspace' };
    return { ok: true, stdout: 'Windows build', stderr: '', exitCode: 0, cleanupConfirmed: receiptConfirmed };
  },
} });
mock.module('@/modules/workspace-runtime/index.js', { namedExports: {
  ensureCloudWorkspaceBinding() { assert.fail('SSH must not initialize a cloud binding'); },
  excludeCloudWorkspaceMetadata() {}, getWorkspaceRuntimeIdentity() {}, executeWorkspaceRuntimePreview() {},
} });
mock.module('@anthropic-ai/claude-agent-sdk', { namedExports: {
  tool: (name: string, description: string, schema: unknown, handler: unknown) => ({ name, description, schema, handler }),
  createSdkMcpServer: (value: unknown) => value,
  query: (input: unknown) => { assert.ok(sdk); return sdk!(input); },
} });
const bridge = await import('@/modules/workspace-bridge/index.js');
const ssh = await import('../ssh-workspace-execution.service.js');
test.after(async () => { assert.equal(path.dirname(root), os.tmpdir()); await rm(root, { recursive: true, force: true }); });
test.beforeEach(() => { target = { ...target, phase: 'idle', activeRunId: null, pendingJobId: null }; requests.length = 0; admissions.length = 0; fail = undefined; probes = 0; holdExecution = undefined; pendingReference = undefined; receiptConfirmed = true; onExecute = undefined; remoteContent = Buffer.from('Windows source'); });

test('SSH file and command adapters never use the VPS decoy or Docker fallback', async () => {
  const base = new Proxy({}, { get() { return () => assert.fail('Host filesystem fallback'); } });
  const files = bridge.bridgeFileSystem(base as never);
  assert.equal(await files.readTextFile(path.join(anchor, 'same.txt')), 'Windows source');
  assert.equal(await readFile(path.join(anchor, 'same.txt'), 'utf8'), 'VPS decoy');
  assert.equal(requests[0]!.path, '/workspace/same.txt');
  await bridge.runWorkspaceCommand(anchor, 'git', ['status', '--porcelain'], { readOnly: true });
  assert.deepEqual(requests.at(-1)!.argv, ['git', '--literal-pathspecs', '--no-optional-locks', 'status', '--porcelain']);
  assert.equal(target.phase, 'idle');
});

test('parallel catalog metadata and canonical-path reads share a single SSH helper batch', async () => {
  const base = new Proxy({}, { get() { return () => assert.fail('Host filesystem fallback'); } });
  const files = bridge.bridgeFileSystem(base as never);
  const nested = path.join(anchor, '.claude', 'skills');
  const [first, second, canonicalRoot, canonicalNested] = await Promise.all([
    files.lstat(path.join(anchor, '.claude')), files.lstat(nested), files.realpath(anchor), files.realpath(nested),
  ]);
  assert.equal(first.isSymbolicLink(), false); assert.equal(second.isDirectory(), true);
  assert.equal(canonicalRoot, anchor); assert.equal(canonicalNested, nested);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].op, 'batch');
  assert.deepEqual((requests[0].requests as Array<{ op: string }>).map(item => item.op), ['lstat', 'lstat', 'realpath', 'realpath']);
});

test('four parallel SSH Git inspections remain FIFO under the same exclusive writer', { timeout: 5000 }, async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const order: string[] = [];
  let active = 0;
  let maximumActive = 0;
  const inspections = ['status', 'branches', 'remote-status', 'header'].map((name, index) => bridge.withWorkspaceGitReadOperation(anchor, async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    order.push('start:' + name);
    try {
      if (index === 0) await held;
      await bridge.runWorkspaceCommand(anchor, 'git', [name], { readOnly: true });
    } finally { active -= 1; order.push('end:' + name); }
  }));
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(order, ['start:status']);
    assert.equal(admissions.length, 1);
    const occupied = ssh.describeSshWorkspace(target).cloudReplica;
    assert.equal(occupied.phase, 'running');
    assert.equal(occupied.capabilities.write, false);
    assert.notEqual(occupied.connectionState, 'recovery');
    assert.equal(target.phase, 'running');
  } finally { release(); await Promise.all(inspections); }
  assert.equal(maximumActive, 1);
  assert.equal(admissions.length, 4);
  assert.deepEqual(order, ['start:status', 'end:status', 'start:branches', 'end:branches', 'start:remote-status', 'end:remote-status', 'start:header', 'end:header']);
  assert.equal(requests.filter(request => request.op === 'exec').length, 4);
  assert.equal(target.phase, 'idle');
  assert.equal(ssh.describeSshWorkspace(target).cloudReplica.capabilities.write, true);
});

test('stage completion then background inspection hands off once to commit before later polls', { timeout: 5000 }, async () => {
  const order: string[] = [];
  await bridge.withWorkspaceWriteOperation(anchor, async () => {
    await bridge.runWorkspaceCommand(anchor, 'git', ['add', '--all']);
    order.push('stage');
  });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const first = bridge.withWorkspaceGitReadOperation(anchor, async () => { order.push('read:start'); await held; order.push('read:end'); });
  const olderPoll = bridge.withWorkspaceGitReadOperation(anchor, async () => { order.push('older-poll'); });
  await new Promise<void>(resolve => setImmediate(resolve));
  const commit = bridge.withWorkspaceWriteOperation(anchor, async () => {
    order.push('commit');
    await bridge.runWorkspaceCommand(anchor, 'git', ['commit', '-m', 'one commit']);
  });
  const laterPoll = bridge.withWorkspaceGitReadOperation(anchor, async () => { order.push('later-poll'); });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(order, ['stage', 'read:start']);
    await assert.rejects(bridge.withWorkspaceWriteOperation(anchor, async () => assert.fail('second foreground queued')), { code: 'WORKSPACE_BUSY' });
  } finally { release(); await Promise.all([first, olderPoll, commit, laterPoll]); }
  assert.deepEqual(order, ['stage', 'read:start', 'read:end', 'commit', 'older-poll', 'later-poll']);
  assert.equal(requests.filter(request => (request.argv as string[] | undefined)?.includes('commit')).length, 1);
  assert.equal(target.phase, 'idle');
});

test('cancelled queued foreground is never admitted and does not release an active inspection', { timeout: 5000 }, async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const first = bridge.withWorkspaceGitReadOperation(anchor, () => held);
  await new Promise<void>(resolve => setImmediate(resolve));
  const request = Object.assign(new EventEmitter(), { headers: {}, user: { id: 'owner' }, aborted: false });
  const response = Object.assign(new EventEmitter(), { writableFinished: false });
  let entered = false;
  const foreground = new Promise<void>((resolve, reject) => bridge.workspaceRequestScope(request as never, response as never, () => {
    bridge.withWorkspaceWriteOperation(anchor, async () => { entered = true; }).then(resolve, reject);
  }));
  let follower = false;
  const poll = bridge.withWorkspaceGitReadOperation(anchor, async () => { follower = true; });
  try {
    const rejected = assert.rejects(foreground, { code: 'WORKSPACE_REQUEST_CANCELLED' });
    request.emit('aborted');
    await rejected;
    assert.equal(entered, false);
    assert.equal(follower, false);
    assert.equal(admissions.length, 1);
  } finally { release(); await Promise.all([first, foreground.catch(() => {}), poll]); response.emit('finish'); }
  assert.equal(entered, false);
  assert.equal(follower, true);
  assert.equal(admissions.length, 2);
});

test('first Claude admission waits behind header inspection, probes under its writer, and pauses queued polls', { timeout: 5000 }, async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const first = bridge.withWorkspaceGitReadOperation(anchor, () => held);
  let polled = false;
  const poll = bridge.withWorkspaceGitReadOperation(anchor, async () => { polled = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  const admissionPromise = bridge.admitWorkspaceExecution({ cwd: anchor, sessionId: 'session' });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(probes, 0);
  assert.equal(polled, false);
  release();
  const admission = await admissionPromise;
  try {
    await first;
    assert.equal(probes, 1);
    assert.equal(polled, false);
    assert.equal(target.phase, 'running');
    await assert.rejects(bridge.admitWorkspaceExecution({ cwd: anchor, sessionId: 'session' }), { code: 'WORKSPACE_BUSY' });
    await assert.rejects(bridge.runWorkspaceCommand(anchor, 'node', ['second']), { code: 'WORKSPACE_BUSY' });
    await assert.rejects(bridge.withWorkspaceGitReadOperation(anchor, async () => assert.fail('new read entered foreground')), { code: 'WORKSPACE_BUSY' });
  } finally { await admission.close(); await poll; }
  assert.equal(polled, true);
  assert.equal(target.phase, 'idle');
});

test('queued implicit file and console writers inherit cancellation and receive priority once', { timeout: 5000 }, async () => {
  for (const operation of ['file', 'console']) {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const first = bridge.withWorkspaceGitReadOperation(anchor, () => held);
    await new Promise<void>(resolve => setImmediate(resolve));
    const descriptor = ssh.describeSshWorkspace(target).cloudReplica;
    const foreground = operation === 'file' ? bridge.bridgeFileSystem({} as never).writeTextSnapshot!(path.join(anchor, 'new.txt'), 'a', null)
      : ssh.runSshWorkspaceCommand(descriptor, 'echo once');
    let follower = false;
    const poll = bridge.withWorkspaceGitReadOperation(anchor, async () => { follower = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(follower, false);
    release();
    await Promise.all([first, foreground, poll]);
    assert.equal(follower, true);
    assert.equal(requests.filter(request => request.op === (operation === 'file' ? 'write' : 'exec')).length, 1);
    requests.length = 0;
  }
});

test('foreground deadline expires before admission and never dispatches later', { timeout: 5000 }, async () => {
  let release!: () => void;
  const first = bridge.withWorkspaceGitReadOperation(anchor, () => new Promise<void>(resolve => { release = resolve; }));
  await new Promise<void>(resolve => setImmediate(resolve));
  mock.timers.enable({ apis: ['setTimeout'] });
  let entered = false;
  try {
    const foreground = bridge.withWorkspaceWriteOperation(anchor, async () => { entered = true; });
    const rejected = assert.rejects(foreground, { code: 'WORKSPACE_ADMISSION_TIMEOUT' });
    mock.timers.tick(120_001);
    await rejected;
    assert.equal(entered, false);
    release(); await first;
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(entered, false);
    assert.equal(admissions.length, 1);
  } finally { mock.timers.reset(); release(); await first; }
});

test('foreground execution is not timed out or replayed after its admission deadline is cleared', { timeout: 5000 }, async () => {
  let releaseRead!: () => void;
  const first = bridge.withWorkspaceGitReadOperation(anchor, () => new Promise<void>(resolve => { releaseRead = resolve; }));
  await new Promise<void>(resolve => setImmediate(resolve));
  mock.timers.enable({ apis: ['setTimeout'] });
  let releaseForeground!: () => void;
  let entered = 0;
  let completed = false;
  const foreground = bridge.withWorkspaceWriteOperation(anchor, async () => {
    entered++;
    await new Promise<void>(resolve => { releaseForeground = resolve; });
  }).then(() => { completed = true; });
  try {
    releaseRead(); await first;
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(entered, 1);
    mock.timers.tick(120_001);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(completed, false);
    assert.equal(target.phase, 'running');
    releaseForeground(); await foreground;
    assert.equal(entered, 1);
    assert.equal(target.phase, 'idle');
  } finally { mock.timers.reset(); releaseRead(); releaseForeground?.(); await Promise.allSettled([first, foreground]); }
});

test('queued foreground cancellation reaches implicit file and console admission before dispatch', { timeout: 5000 }, async () => {
  for (const operation of ['file', 'console']) {
    let release!: () => void;
    const first = bridge.withWorkspaceGitReadOperation(anchor, () => new Promise<void>(resolve => { release = resolve; }));
    await new Promise<void>(resolve => setImmediate(resolve));
    const request = Object.assign(new EventEmitter(), { headers: {}, user: { id: 'owner' }, aborted: false });
    const response = Object.assign(new EventEmitter(), { writableFinished: false });
    const controller = new AbortController();
    const pending = new Promise<unknown>((resolve, reject) => bridge.workspaceRequestScope(request as never, response as never, () => {
      const result = operation === 'file' ? bridge.bridgeFileSystem({} as never).writeTextSnapshot!(path.join(anchor, 'cancel.txt'), 'a', null)
        : ssh.runSshWorkspaceCommand(ssh.describeSshWorkspace(target).cloudReplica, 'never start', controller.signal);
      result.then(resolve, reject);
    }));
    const rejected = assert.rejects(pending, operation === 'file' ? { code: 'WORKSPACE_REQUEST_CANCELLED' } : /console cancelled/);
    if (operation === 'file') request.emit('aborted'); else controller.abort(new Error('console cancelled'));
    await rejected;
    release(); await first;
    response.emit('finish');
    assert.equal(requests.length, 0);
  }
});

test('queued callbacks retain their own HTTP signal when a previous cancelled request drains them', { timeout: 5000 }, async () => {
  let release!: () => void;
  const requestA = Object.assign(new EventEmitter(), { headers: {}, user: { id: 'owner' }, aborted: false });
  const responseA = Object.assign(new EventEmitter(), { writableFinished: false });
  const first = new Promise<void>((resolve, reject) => bridge.workspaceRequestScope(requestA as never, responseA as never, () => {
    bridge.withWorkspaceGitReadOperation(anchor, () => new Promise<void>(resume => { release = resume; })).then(resolve, reject);
  }));
  await new Promise<void>(resolve => setImmediate(resolve));
  const requestB = Object.assign(new EventEmitter(), { headers: {}, user: { id: 'owner' }, aborted: false });
  const responseB = Object.assign(new EventEmitter(), { writableFinished: false });
  let writes = 0;
  const foreground = new Promise<void>((resolve, reject) => bridge.workspaceRequestScope(requestB as never, responseB as never, () => {
    bridge.withWorkspaceWriteOperation(anchor, async () => { writes++; await bridge.runWorkspaceCommand(anchor, 'git', ['commit', '-m', 'own request']); }).then(resolve, reject);
  }));
  const cancelled = assert.rejects(first, { code: 'WORKSPACE_REQUEST_CANCELLED' });
  requestA.emit('aborted');
  release();
  await Promise.all([cancelled, foreground]);
  responseA.emit('finish'); responseB.emit('finish');
  assert.equal(writes, 1);
  assert.equal(requests.length, 1);
});

test('queued foreground generation change is rejected without dispatch or blocking the replacement', { timeout: 5000 }, async () => {
  const original = { ...target };
  let release!: () => void;
  const first = bridge.withWorkspaceGitReadOperation(anchor, () => new Promise<void>(resolve => { release = resolve; }));
  await new Promise<void>(resolve => setImmediate(resolve));
  const foreground = bridge.withWorkspaceWriteOperation(anchor, async () => assert.fail('old target admitted'));
  try {
    target = { ...target, generation: 'replacement', rootIdentity: 'different-root' };
    release();
    await Promise.all([assert.rejects(first, { code: 'WORKSPACE_GENERATION_CHANGED' }), assert.rejects(foreground, { code: 'WORKSPACE_GENERATION_CHANGED' })]);
    await bridge.withWorkspaceWriteOperation(anchor, async () => {});
    assert.equal(requests.length, 0);
  } finally { release(); await Promise.allSettled([first, foreground]); target = original; }
});

test('failed Claude probe releases its acquired writer and queued foreground cancels before probing', { timeout: 5000 }, async () => {
  let releaseProbe!: () => void;
  const header = bridge.withWorkspaceGitReadOperation(anchor, () => new Promise<void>(resolve => { releaseProbe = resolve; }));
  let resumed = 0;
  const queuedPoll = bridge.withWorkspaceGitReadOperation(anchor, async () => { resumed++; });
  await new Promise<void>(resolve => setImmediate(resolve));
  fail = Object.assign(new Error('probe offline'), { code: 'SSH_WORKSPACE_UNAVAILABLE' });
  const admission = bridge.admitWorkspaceExecution({ cwd: anchor, sessionId: 'session' });
  const rejectedProbe = assert.rejects(admission, /probe offline/);
  releaseProbe();
  await Promise.all([header, rejectedProbe, queuedPoll]);
  assert.equal(resumed, 1);
  assert.equal(target.phase, 'idle');
  fail = undefined;
  const controller = new AbortController();
  let release!: () => void;
  const first = bridge.withWorkspaceGitReadOperation(anchor, () => new Promise<void>(resolve => { release = resolve; }));
  await new Promise<void>(resolve => setImmediate(resolve));
  const before = probes;
  const pending = bridge.admitWorkspaceExecution({ cwd: anchor, sessionId: 'session', signal: controller.signal });
  const rejected = assert.rejects(pending, /cancelled Claude/);
  controller.abort(new Error('cancelled Claude'));
  await rejected;
  assert.equal(probes, before);
  release(); await first;
  assert.equal(target.phase, 'idle');
});

test('cancelling an HTTP Git inspection in the queue never starts it or releases the next early', { timeout: 5000 }, async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const request = Object.assign(new EventEmitter(), { headers: {}, user: { id: 'owner' }, aborted: false });
  const response = Object.assign(new EventEmitter(), { writableFinished: false });
  const first = bridge.withWorkspaceGitReadOperation(anchor, () => held);
  let cancelledEntered = false;
  let thirdEntered = false;
  const cancelled = new Promise<void>((resolve, reject) => {
    bridge.workspaceRequestScope(request as never, response as never, () => {
      bridge.withWorkspaceGitReadOperation(anchor, async () => { cancelledEntered = true; }).then(resolve, reject);
    });
  });
  const third = bridge.withWorkspaceGitReadOperation(anchor, async () => { thirdEntered = true; });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    const rejected = assert.rejects(cancelled, { code: 'WORKSPACE_REQUEST_CANCELLED' });
    request.emit('aborted');
    await rejected;
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(cancelledEntered, false);
    assert.equal(thirdEntered, false);
    assert.equal(admissions.length, 1);
  } finally { release(); await Promise.all([first, cancelled.catch(() => {}), third]); response.emit('finish'); }
  assert.equal(cancelledEntered, false);
  assert.equal(thirdEntered, true);
  assert.equal(admissions.length, 2);
  assert.equal(target.phase, 'idle');
});

test('cancelling an admitted Git inspection still waits for its operation cleanup', { timeout: 5000 }, async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const request = Object.assign(new EventEmitter(), { headers: {}, user: { id: 'owner' }, aborted: false });
  const response = Object.assign(new EventEmitter(), { writableFinished: false });
  let settled = false;
  const operation = new Promise<void>((resolve, reject) => {
    bridge.workspaceRequestScope(request as never, response as never, () => {
      bridge.withWorkspaceGitReadOperation(anchor, () => held).then(resolve, reject);
    });
  });
  const rejected = assert.rejects(operation, { code: 'WORKSPACE_REQUEST_CANCELLED' }).then(() => { settled = true; });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(admissions.length, 1);
    request.emit('aborted');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    assert.equal(target.phase, 'running');
  } finally { release(); await rejected; response.emit('finish'); }
  assert.equal(target.phase, 'idle');
});

test('nested SSH Git inspection reuses its current scope without queueing behind itself', { timeout: 5000 }, async () => {
  await bridge.withWorkspaceGitReadOperation(anchor, () => bridge.withWorkspaceGitReadOperation(anchor,
    () => bridge.runWorkspaceCommand(anchor, 'git', ['status'], { readOnly: true })));
  assert.equal(admissions.length, 1);
  assert.equal(requests.length, 1);
  assert.equal(target.phase, 'idle');
});

test('an uncertain SSH Git inspection fences its queued followers without dispatch', { timeout: 5000 }, async () => {
  fail = Object.assign(new Error('unknown inspection exit'), { code: 'SSH_EXECUTION_UNCONFIRMED', details: { jobId: 'job' } });
  let followerEntered = false;
  const first = bridge.withWorkspaceGitReadOperation(anchor, () => bridge.runWorkspaceCommand(anchor, 'git', ['status'], { readOnly: true }));
  const follower = bridge.withWorkspaceGitReadOperation(anchor, async () => { followerEntered = true; });
  const foreground = bridge.withWorkspaceWriteOperation(anchor, async () => assert.fail('uncertain predecessor admitted foreground'));
  await Promise.all([
    assert.rejects(first, /unknown inspection exit/),
    assert.rejects(follower, { code: 'SSH_WORKSPACE_RECOVERY_REQUIRED' }),
    assert.rejects(foreground, { code: 'WORKSPACE_BUSY' }),
  ]);
  assert.equal(followerEntered, false);
  assert.equal(admissions.length, 1);
  assert.equal(requests.length, 1);
  assert.equal(target.phase, 'recovery');
});

test('queued SSH Git inspection revalidates its pinned generation before admission', { timeout: 5000 }, async () => {
  const original = { ...target };
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const first = bridge.withWorkspaceGitReadOperation(anchor, () => held);
  let followerEntered = false;
  const follower = bridge.withWorkspaceGitReadOperation(anchor, async () => { followerEntered = true; });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    target = { ...target, generation: 'new-generation', rootPath: 'D:\\DifferentProject', connectionId: 'replacement' };
    release();
    await Promise.all([
      assert.rejects(first, { code: 'WORKSPACE_GENERATION_CHANGED' }),
      assert.rejects(follower, { code: 'WORKSPACE_GENERATION_CHANGED' }),
    ]);
    assert.equal(followerEntered, false);
    assert.equal(admissions.length, 1);
    assert.equal(requests.length, 0);
  } finally { release(); await Promise.allSettled([first, follower]); target = original; }
});

test('a confirmed SSH Git inspection failure does not poison later queued inspection', { timeout: 5000 }, async () => {
  let followerEntered = false;
  const first = bridge.withWorkspaceGitReadOperation(anchor, async () => { throw new Error('inspection failed'); });
  const follower = bridge.withWorkspaceGitReadOperation(anchor, async () => { followerEntered = true; });
  await Promise.all([assert.rejects(first, /inspection failed/), follower]);
  assert.equal(followerEntered, true);
  assert.equal(admissions.length, 2);
  assert.equal(target.phase, 'idle');
});

test('raw-path HTTP requests check SSH owner before dispatching to Windows', async () => {
  const request = Object.assign(new EventEmitter(), { headers: {}, user: { id: 'foreign' }, aborted: false });
  const response = Object.assign(new EventEmitter(), { writableFinished: false });
  const files = bridge.bridgeFileSystem({} as never);
  const operation = new Promise<void>((resolve, reject) => {
    bridge.workspaceRequestScope(request as never, response as never, () => {
      files.readTextFile(path.join(anchor, 'same.txt')).then(() => reject(new Error('foreign read allowed')), error => {
        try { assert.equal(error.code, 'SSH_WORKSPACE_FORBIDDEN'); resolve(); } catch (failure) { reject(failure); }
      });
    });
  });
  try { await operation; assert.equal(requests.length, 0); }
  finally { response.emit('finish'); }
});

test('SSH outage throws and missing reserved bindings cannot select host source', async () => {
  fail = Object.assign(new Error('offline'), { code: 'SSH_CONNECTION_FAILED' });
  await assert.rejects(bridge.runWorkspaceCommand(anchor, 'node', ['test.js']), /offline/);
  assert.equal(target.phase, 'idle');
  assert.throws(() => bridge.isWorkspaceBound(path.join(root, '.chisa-ssh-projects', 'unknown')), { code: 'SSH_WORKSPACE_NOT_FOUND' });
});

test('confirmed helper file errors keep SSH online while unconfirmed failures mark it offline', async () => {
  const files = bridge.bridgeFileSystem({} as never);
  const connectionState = () => ssh.describeSshWorkspace(target).cloudReplica.connectionState;
  for (const code of ['CONTENT_CONFLICT', 'ENOENT']) {
    fail = Object.assign(new Error('transport unavailable'), { code: 'SSH_WORKSPACE_UNAVAILABLE' });
    await assert.rejects(files.readTextFile(path.join(anchor, 'same.txt')), /transport unavailable/);
    assert.equal(connectionState(), 'offline');
    fail = Object.assign(new Error('expected file error'), { code, details: { transportConfirmed: true } });
    if (code === 'CONTENT_CONFLICT') await assert.rejects(files.writeTextSnapshot!(path.join(anchor, 'same.txt'), 'new content', 'stale-hash'), /expected file error/);
    else await assert.rejects(files.readTextFile(path.join(anchor, 'missing.txt')), /expected file error/);
    assert.equal(connectionState(), 'online');
    assert.equal(target.phase, 'idle');
  }
  fail = Object.assign(new Error('root changed'), { code: 'SSH_WORKSPACE_CHANGED' });
  await assert.rejects(files.readTextFile(path.join(anchor, 'same.txt')), /root changed/);
  assert.equal(connectionState(), 'offline');
});

test('remote command uncertainty remains fenced until exact job recovery', async () => {
  fail = Object.assign(new Error('unknown remote exit'), { code: 'SSH_EXECUTION_UNCONFIRMED', details: { jobId: 'job' } });
  await assert.rejects(bridge.runWorkspaceCommand(anchor, 'dotnet', ['test']), /unknown/);
  assert.equal(target.phase, 'recovery');
  assert.equal(target.pendingJobId, 'job');
  await assert.rejects(bridge.runWorkspaceCommand(anchor, 'dotnet', ['test']), { code: 'WORKSPACE_BUSY' });
  fail = undefined;
  assert.deepEqual(await ssh.recoverSshWorkspace(target, true), { status: 'idle' });
  assert.equal(target.phase, 'idle');
});

test('unknown file mutation stays fenced until its exact durable receipt confirms cleanup', async () => {
  const operationId = randomUUID();
  pendingReference = `operation:${operationId}`;
  fail = Object.assign(new Error('unknown file operation'), { code: 'SSH_OPERATION_UNCONFIRMED', details: { jobId: pendingReference } });
  const files = bridge.bridgeFileSystem({} as never);
  await assert.rejects(files.writeTextSnapshot!(path.join(anchor, 'same.txt'), 'new content', 'old-hash'), { code: 'SSH_OPERATION_UNCONFIRMED' });
  assert.equal(target.phase, 'recovery');
  assert.equal(target.pendingJobId, pendingReference);
  await assert.rejects(files.writeTextSnapshot!(path.join(anchor, 'same.txt'), 'replay', 'old-hash'), { code: 'WORKSPACE_BUSY' });
  assert.equal(requests.filter(request => request.op === 'write').length, 1);
  fail = undefined;
  receiptConfirmed = false;
  assert.deepEqual(await ssh.recoverSshWorkspace(target), { status: 'running', jobId: pendingReference });
  assert.equal(target.phase, 'recovery');
  assert.deepEqual(requests.at(-1), { op: 'operation_status', operationId });
  receiptConfirmed = true;
  assert.deepEqual(await ssh.recoverSshWorkspace(target, true), { status: 'idle', inspectChanges: true });
  assert.deepEqual(requests.at(-1), { op: 'operation_cancel', operationId });
  assert.equal(requests.filter(request => request.op === 'write').length, 1);
  assert.equal(target.phase, 'idle');
  assert.equal(target.pendingJobId, null);
});

test('legacy file uncertainty without a receipt cannot clear recovery after a successful probe', async () => {
  target = { ...target, phase: 'recovery', activeRunId: 'legacy-run', pendingJobId: null };
  for (const cancel of [false, true]) {
    await assert.rejects(ssh.recoverSshWorkspace(target, cancel), { code: 'SSH_OPERATION_RECOVERY_UNCONFIRMED' });
    assert.equal(target.phase, 'recovery');
    assert.equal(target.activeRunId, 'legacy-run');
  }
  assert.equal(requests.length, 0);
});

test('successful or pre-dispatch refused file operations clear only their receipt and keep writer usable', async () => {
  pendingReference = `operation:${randomUUID()}`;
  const files = bridge.bridgeFileSystem({} as never);
  for (const code of [undefined, 'AGENT_UNAUTHORIZED', 'CONTENT_CONFLICT']) {
    fail = code ? Object.assign(new Error('typed refusal'), { code, details: code === 'AGENT_UNAUTHORIZED'
      ? { requestDispatched: false } : { transportConfirmed: true } }) : undefined;
    if (fail) await assert.rejects(files.writeTextSnapshot!(path.join(anchor, 'same.txt'), 'new content', 'old-hash'), { code });
    else await files.writeTextSnapshot!(path.join(anchor, 'same.txt'), 'new content', 'old-hash');
    assert.equal(target.phase, 'idle');
    assert.equal(target.pendingJobId, null);
    assert.equal(ssh.describeSshWorkspace(target).cloudReplica.capabilities.write, true);
  }
});

test('an uncertain file operation immediately revokes SDK mutation admission before close', async () => {
  const admission = await bridge.admitWorkspaceExecution({ cwd: anchor, sessionId: 'session' });
  pendingReference = `operation:${randomUUID()}`;
  fail = Object.assign(new Error('unknown write'), { code: 'SSH_OPERATION_UNCONFIRMED', details: { jobId: pendingReference } });
  await assert.rejects(admission.execute({ op: 'mkdir', path: '/workspace/new' }), { code: 'SSH_OPERATION_UNCONFIRMED' });
  fail = undefined;
  await assert.rejects(admission.execute({ op: 'read', path: '/workspace/same.txt' }), { code: 'SSH_WORKSPACE_RECOVERY_REQUIRED' });
  await assert.rejects(admission.close(), { code: 'SSH_WORKSPACE_RECOVERY_REQUIRED' });
  assert.equal(target.phase, 'recovery');
  assert.equal(target.pendingJobId, pendingReference);
  assert.equal(requests.length, 1);
});

test('recovery does not clear a replaced run receipt after native completion', async () => {
  target = { ...target, phase: 'recovery', activeRunId: 'run-before', pendingJobId: `operation:${randomUUID()}` };
  onExecute = () => { target = { ...target, activeRunId: 'run-after', pendingJobId: `operation:${randomUUID()}` }; };
  await assert.rejects(ssh.recoverSshWorkspace(target), { code: 'WORKSPACE_GENERATION_CHANGED' });
  assert.equal(target.phase, 'recovery');
  assert.equal(target.activeRunId, 'run-after');
});

test('SSH catalog uses shared local identity and rejects a foreign account', () => {
  const resolved = bridge.describeWorkspaceSelection({ projectId: 'project', sourceRoot: anchor, sessionId: 'session' });
  assert.equal(resolved.session?.sourceMode, 'ssh');
  assert.equal(resolved.session?.rootPath, anchor);
  assert.equal(resolved.session?.displayPath, 'D:\\Code\\App');
  assert.equal(resolved.session?.capabilities.integrate, false);
  assert.equal(resolved.session?.capabilities.preview, false);
  assert.equal(resolved.session?.effectiveMode, 'shared');
  assert.throws(() => ssh.assertSshProjectOwner(target, 'foreign'), { code: 'SSH_WORKSPACE_FORBIDDEN' });
});

test('SSH Claude SDK stays on VPS, restricts real tools and plan mode exposes files only', async () => {
  let options: Record<string, any> | undefined;
  const preparedCwds: string[] = [];
  sdk = (input: any) => {
    options = input.options;
    return Object.assign((async function* () { yield { type: 'result', subtype: 'success' }; })(), { close() {} });
  };
  const iterator = bridge.workspaceQuery({ prompt: 'inspect', options: { cwd: anchor, permissionMode: 'plan',
    env: { ANTHROPIC_API_KEY: 'VPS fixture' }, tools: { type: 'preset', preset: 'claude_code' },
    systemPrompt: { type: 'preset', preset: 'claude_code' }, chisaSessionId: 'session',
    chisaPrepareLaunch: async (cwd: string) => { assert.equal(probes, 1); preparedCwds.push(cwd); } } } as never);
  for await (const _event of iterator) { /* SDK result */ }
  assert.equal(options!.cwd, anchor);
  assert.equal(options!.env.ANTHROPIC_API_KEY, 'VPS fixture');
  assert.deepEqual(options!.tools, ['AskUserQuestion', 'ExitPlanMode', 'TodoWrite']);
  assert.equal(options!.strictMcpConfig, true);
  assert.deepEqual(options!.settingSources, []);
  assert.deepEqual(options!.mcpServers.workspace.tools.map((tool: { name: string }) => tool.name), ['list_files', 'read_file', 'read_image', 'search_files']);
  assert.equal(probes, 1);
  assert.equal(target.phase, 'idle');
  assert.equal('chisaSessionId' in options!, false);
  assert.equal('chisaPrepareLaunch' in options!, false);
  assert.deepEqual(preparedCwds, [anchor]);
});

test('project screenshots use image content and per-turn attachments cannot read arbitrary VPS files', async () => {
  const { getGlobalImageAssetsDir } = await import('@/shared/index.js');
  const store = getGlobalImageAssetsDir();
  await mkdir(store, { recursive: true });
  const attached = path.join(store, 'ssh-tool-test-' + randomUUID() + '.txt');
  await writeFile(attached, 'attached text');
  remoteContent = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  let checked = false;
  sdk = (input: any) => Object.assign((async function* () {
    const tools = input.options.mcpServers.workspace.tools;
    const image = await tools.find((tool: { name: string }) => tool.name === 'read_image').handler({ path: '/workspace/screen.png' });
    assert.equal(image.content[0].type, 'image');
    assert.equal(image.content[0].mimeType, 'image/png');
    const attachment = tools.find((tool: { name: string }) => tool.name === 'read_attachment');
    const text = await attachment.handler({ path: attached, encoding: 'utf8' });
    assert.equal(JSON.parse(text.content[0].text).content, 'attached text');
    const denied = await attachment.handler({ path: path.join(anchor, 'same.txt'), encoding: 'utf8' });
    assert.equal(denied.isError, true);
    checked = true;
    yield { type: 'result' };
  })(), { close() {} });
  try {
    const iterator = bridge.workspaceQuery({ prompt: 'inspect', options: { cwd: anchor, chisaAttachments: [{ path: attached }] } } as never);
    for await (const _event of iterator) { /* image result */ }
    assert.equal(checked, true);
  } finally { await unlink(attached); }
});

test('failed VPS Claude spawn releases SSH admission instead of leaving an unrecoverable running scope', async () => {
  sdk = (input: any) => {
    const process = new EventEmitter() as EventEmitter & { exitCode: null };
    process.exitCode = null;
    input.options.spawnClaudeCodeProcess({ command: 'unused', args: [], env: {}, signal: new AbortController().signal });
    return Object.assign((async function* () { await Promise.reject(new Error('spawn failed')); yield { type: 'unreachable' }; })(), { close() {} });
  };
  const child = new EventEmitter() as EventEmitter & { exitCode: null };
  child.exitCode = null;
  const iterator = bridge.workspaceQuery({ prompt: 'inspect', options: { cwd: anchor,
    spawnClaudeCodeProcess: () => { queueMicrotask(() => child.emit('error', new Error('ENOENT'))); return child; } } } as never);
  await assert.rejects(async () => { for await (const _ of iterator) { /* no messages */ } }, /spawn failed/);
  assert.equal(target.phase, 'idle');
});

test('parallel SSH mutations are rejected and revocation precedes operation drain', async () => {
  let resume!: () => void;
  holdExecution = new Promise<void>(resolve => { resume = resolve; });
  const admission = await bridge.admitWorkspaceExecution({ cwd: anchor, sessionId: 'session' });
  const first = admission.execute({ op: 'exec', command: 'build' });
  await new Promise<void>(resolve => setImmediate(resolve));
  await assert.rejects(admission.execute({ op: 'exec', command: 'second' }), { code: 'WORKSPACE_BUSY' });
  const closing = admission.close();
  let secondClosed = false;
  const again = admission.close().then(() => { secondClosed = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(secondClosed, false);
  await assert.rejects(admission.execute({ op: 'read', path: '/workspace/same.txt' }), { code: 'WORKSPACE_BUSY' });
  resume(); await first; await closing; await again;
  assert.equal(requests.filter(request => request.op === 'exec').length, 1);
  assert.equal(target.phase, 'idle');
});

test('an uncertain command immediately prevents another tool before SDK cleanup', async () => {
  const admission = await bridge.admitWorkspaceExecution({ cwd: anchor, sessionId: 'session' });
  fail = Object.assign(new Error('unknown'), { code: 'SSH_EXECUTION_UNCONFIRMED', details: { jobId: 'job' } });
  await assert.rejects(admission.execute({ op: 'exec', command: 'build' }), /unknown/);
  fail = undefined;
  await assert.rejects(admission.execute({ op: 'write', path: '/workspace/new.txt', b64: '', expectedHash: null }), { code: 'SSH_WORKSPACE_RECOVERY_REQUIRED' });
  await assert.rejects(admission.close(), { code: 'SSH_WORKSPACE_RECOVERY_REQUIRED' });
  assert.equal(target.phase, 'recovery');
});

test('readonly SSH admission rejects shell even if called directly', async () => {
  const admission = await bridge.admitWorkspaceExecution({ cwd: anchor, sessionId: 'session', readOnly: true });
  try { await assert.rejects(admission.execute({ op: 'exec', command: 'echo unsafe', readOnly: true }), { code: 'WORKSPACE_READ_ONLY' }); }
  finally { await admission.close(); }
  assert.equal(requests.length, 0);
});
