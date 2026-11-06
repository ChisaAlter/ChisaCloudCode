import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createProjectCloneJobsService } from '../services/project-clone-jobs.service.js';
import type { startCloneProject } from '../services/project-clone.service.js';

const input = { workspacePath: path.resolve('/workspace/root'), githubUrl: 'https://host/team/repo', userId: '1', requestId: 'request-1', newGithubToken: 'secret-token' };
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture() { const directory = await mkdtemp(path.join(os.tmpdir(), 'clone-jobs-')); return { directory, remove: () => rm(directory, { recursive: true, force: true }) }; }

test('request-id cancellation tombstone prevents a late or lost-response POST from starting Git', async () => {
  const storage = await fixture(); let calls = 0;
  try {
    const jobs = createProjectCloneJobsService({ directory: storage.directory, assertOwner() {}, startClone: async () => { calls++; throw new Error('must not start'); } });
    const cancelled = await jobs.cancelRequest(input.requestId, input.userId);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal((await jobs.create(input)).jobId, cancelled.jobId);
    assert.equal(calls, 0);
    const restart = createProjectCloneJobsService({ directory: storage.directory, assertOwner() {}, startClone: async () => { calls++; throw new Error('must not start'); } });
    assert.equal((await restart.create(input)).status, 'cancelled');
    assert.equal(calls, 0);
  } finally { await storage.remove(); }
});

test('durable owner-scoped requestId reuses one execution independent of polling and restart', async () => {
  const storage = await fixture(); const started = gate(); const completion = gate(); let calls = 0;
  const start: typeof startCloneProject = async (_input, handlers) => {
    calls++; handlers.onTarget?.('/workspace/root/repo'); handlers.onProgress('secret-token https://user:pass@host/repo'); started.resolve();
    return { cancel() {}, waitForCompletion: completion.promise.then(() => { handlers.onComplete({ project: { projectId: 'p', path: '/workspace/root/repo', githubToken: 'secret-token' }, message: 'finished secret-token' }); }) };
  };
  try {
    const jobs = createProjectCloneJobsService({ directory: storage.directory, assertOwner() {}, startClone: start });
    const first = await jobs.create(input); await started.promise;
    assert.equal(first.status, 'running');
    const duplicate = await jobs.create({ ...input, githubUrl: 'https://host/team/other', newGithubToken: 'different' });
    assert.equal(duplicate.jobId, first.jobId); assert.equal(calls, 1);
    assert.throws(() => jobs.get(first.jobId, '2'), { code: 'CLONE_JOB_NOT_FOUND' });
    await assert.rejects(jobs.cancel(first.jobId, '2'), { code: 'CLONE_JOB_NOT_FOUND' });
    completion.resolve();
    // Awaiting a terminal cancellation request after execution naturally settled is an observation only.
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(jobs.get(first.jobId, '1').status, 'complete');
    const persisted = await readFile(path.join(storage.directory, 'jobs.json'), 'utf8');
    assert.ok(!persisted.includes('secret-token')); assert.ok(!persisted.includes('githubToken')); assert.ok(!persisted.includes('user:pass'));
    const restart = createProjectCloneJobsService({ directory: storage.directory, assertOwner() {}, startClone: async () => { throw new Error('must not restart'); } });
    assert.equal((await restart.create(input)).jobId, first.jobId);
    assert.equal(restart.get(first.jobId, '1').status, 'complete');
    assert.deepEqual(await restart.cancel(first.jobId, '1'), restart.get(first.jobId, '1'));
  } finally { await storage.remove(); }
});

test('restart converts unfinished clone to interrupted without restarting and keeps idempotency', async () => {
  const storage = await fixture(); const completion = gate();
  try {
    const jobs = createProjectCloneJobsService({ directory: storage.directory, assertOwner() {}, startClone: async (_input, handlers) => {
      handlers.onTarget?.('/workspace/root/repo'); return { cancel() {}, waitForCompletion: completion.promise };
    } });
    const created = await jobs.create(input);
    const restart = createProjectCloneJobsService({ directory: storage.directory, assertOwner() {}, startClone: async () => { throw new Error('must not run'); } });
    const snapshot = restart.get(created.jobId, '1');
    assert.equal(snapshot.status, 'error'); assert.equal(snapshot.code, 'CLONE_INTERRUPTED'); assert.equal(snapshot.targetPath, '/workspace/root/repo');
    assert.equal((await restart.create(input)).jobId, created.jobId);
    assert.match(await readFile(path.join(storage.directory, 'jobs.json'), 'utf8'), /CLONE_INTERRUPTED/);
    completion.resolve(); await new Promise<void>(resolve => setImmediate(resolve));
  } finally { await storage.remove(); }
});

test('DELETE during asynchronous preflight aborts before operation exists and settles after execution', async () => {
  const storage = await fixture(); const entered = gate(); const leave = gate(); let aborted = false;
  try {
    const jobs = createProjectCloneJobsService({ directory: storage.directory, assertOwner() {}, startClone: async cloneInput => {
      entered.resolve(); await leave.promise; aborted = cloneInput.signal?.aborted ?? false;
      if (aborted) throw new Error('preflight aborted'); return { cancel() {}, waitForCompletion: Promise.resolve() };
    } });
    const created = await jobs.create(input); await entered.promise;
    const cancellation = jobs.cancel(created.jobId, '1');
    assert.equal(jobs.get(created.jobId, '1').status, 'running'); leave.resolve();
    const cancelled = await cancellation; assert.equal(aborted, true); assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.code, 'CLONE_CANCELLED');
    assert.deepEqual(await jobs.cancel(created.jobId, '1'), cancelled);
    assert.equal((await jobs.create(input)).jobId, created.jobId);
  } finally { await storage.remove(); }
});

test('execution detaches caller AsyncLocal state, owners have separate request namespaces, capacity fails closed', async () => {
  const storage = await fixture(); const scope = new AsyncLocalStorage<string>(); const observed: unknown[] = [];
  try {
    const jobs = createProjectCloneJobsService({ directory: storage.directory, maxRecords: 2, assertOwner() {}, startClone: async (_input, handlers) => {
      observed.push(scope.getStore()); handlers.onComplete({ project: { projectId: 'p' }, message: 'done' }); return { cancel() {}, waitForCompletion: Promise.resolve() };
    } });
    const first = await scope.run('request-owner', () => jobs.create(input));
    const second = await jobs.create({ ...input, userId: '2' });
    assert.notEqual(first.jobId, second.jobId); assert.deepEqual(observed, [undefined, undefined]);
    await assert.rejects(jobs.create({ ...input, requestId: 'new-request' }), { code: 'CLONE_JOB_CAPACITY_REACHED' });
    assert.equal((await jobs.create(input)).jobId, first.jobId);
  } finally { await storage.remove(); }
});

test('bounded sanitized progress and errors never persist credentials', async () => {
  const storage = await fixture(); const completion = gate();
  try {
    const jobs = createProjectCloneJobsService({ directory: storage.directory, assertOwner() {}, startClone: async (_input, handlers) => {
      handlers.onProgress('secret-token ' + 'z'.repeat(50_000));
      return { cancel() {}, waitForCompletion: completion.promise.then(() => { throw new Error('failed secret-token Authorization: Basic xyz https://user:pass@host/repo'); }) };
    } });
    const created = await jobs.create(input); assert.ok(jobs.get(created.jobId, '1').message.length <= 4096);
    completion.resolve(); await new Promise<void>(resolve => setImmediate(resolve));
    const failed = jobs.get(created.jobId, '1'); assert.equal(failed.status, 'error'); assert.ok(!failed.message.includes('secret-token')); assert.ok(!failed.message.includes('xyz')); assert.ok(!failed.message.includes('user:pass'));
    assert.ok((await readFile(path.join(storage.directory, 'jobs.json'), 'utf8')).length < 6000);
  } finally { await storage.remove(); }
});
