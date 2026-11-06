import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { startCloneProject } from '../services/project-clone.service.js';

type Dependencies = NonNullable<Parameters<typeof startCloneProject>[2]>;
function processFixture() {
  const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kills: number; kill: () => void };
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kills = 0;
  child.kill = () => { child.kills++; };
  return child;
}
function dependencies(child = processFixture(), overrides: Partial<Dependencies> = {}): Dependencies {
  return {
    validatePath: async requested => ({ valid: true, resolvedPath: requested }),
    ensureDirectory: async () => {}, pathExists: async () => false, reserveDirectory: async () => {},
    removePath: async () => {}, getGithubTokenById: async () => ({ github_token: 'selected-secret' }),
    spawnGitClone: () => child, registerProject: async target => ({ project: { projectId: 'p', path: target } }), logError: () => {}, ...overrides,
  };
}
const handlers = { onProgress() {}, onComplete() {} };
const input = { workspacePath: path.resolve('/workspace/root'), githubUrl: 'https://github.com/team/repo.git', userId: '1' };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('stored GitHub token cannot be sent to another HTTPS host or alternate port', async () => {
  let lookups = 0; let spawned = 0;
  for (const githubUrl of ['https://attacker.example/team/repo', 'https://github.com.evil/team/repo', 'https://github.com:444/team/repo']) {
    await assert.rejects(startCloneProject({ ...input, githubUrl, githubTokenId: 1 }, handlers, dependencies(undefined, {
      getGithubTokenById: async () => { lookups++; return { github_token: 'secret' }; },
      spawnGitClone: () => { spawned++; return processFixture(); },
    })), { code: 'GITHUB_TOKEN_HOST_MISMATCH' });
  }
  assert.equal(lookups, 0); assert.equal(spawned, 0);
});

test('exclusive mkdir admits one concurrent clone and loser never cleans the winner', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'clone-race-'));
  const child = processFixture();
  let spawned = 0; let removed = 0;
  const deps = dependencies(child, {
    ensureDirectory: async () => {},
    reserveDirectory: async target => { await mkdir(target, { recursive: false }); },
    spawnGitClone: () => { spawned++; return child; },
    removePath: async target => { removed++; await rm(target, { recursive: true, force: true }); },
  });
  try {
    const outcomes = await Promise.allSettled([startCloneProject({ ...input, workspacePath: parent }, handlers, deps), startCloneProject({ ...input, workspacePath: parent }, handlers, deps)]);
    const success = outcomes.find(result => result.status === 'fulfilled');
    const failure = outcomes.find(result => result.status === 'rejected');
    assert.ok(success?.status === 'fulfilled'); assert.ok(failure?.status === 'rejected');
    assert.equal(failure.reason.code, 'CLONE_TARGET_ALREADY_EXISTS'); assert.equal(spawned, 1); assert.equal(removed, 0);
    await writeFile(path.join(parent, 'repo', 'winner.txt'), 'owned');
    child.emit('close', 0); await success.value.waitForCompletion;
    assert.equal(await readFile(path.join(parent, 'repo', 'winner.txt'), 'utf8'), 'owned');
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('cancellation during preflight prevents reservation, spawn and registration', async () => {
  const gate = deferred(); const cancellation = new AbortController(); const effects: string[] = [];
  const pending = startCloneProject({ ...input, signal: cancellation.signal }, handlers, dependencies(undefined, {
    validatePath: async requested => { await gate.promise; return { valid: true, resolvedPath: requested }; },
    reserveDirectory: async () => { effects.push('reserve'); }, spawnGitClone: () => { effects.push('spawn'); throw new Error('unreachable'); },
    registerProject: async () => { effects.push('register'); return { project: {} }; },
  }));
  cancellation.abort(); gate.resolve();
  await assert.rejects(pending, { code: 'CLONE_CANCELLED' }); assert.deepEqual(effects, []);
});

test('cancellation awaits close, removes owned target once and never registers even on zero exit', async () => {
  const child = processFixture(); const effects: string[] = [];
  const operation = await startCloneProject(input, handlers, dependencies(child, { removePath: async () => { effects.push('remove'); }, registerProject: async () => { effects.push('register'); return { project: {} }; } }));
  const rejected = assert.rejects(operation.waitForCompletion, { code: 'CLONE_CANCELLED' });
  operation.cancel(); operation.cancel();
  assert.equal(child.kills, 1); assert.deepEqual(effects, []);
  child.emit('close', 0); child.emit('close', 0); await rejected; assert.deepEqual(effects, ['remove']);
});

test('spawn errors do not clean until close; synchronous spawn errors clean only the reservation', async () => {
  const child = processFixture(); let removed = 0;
  const deps = dependencies(child, { removePath: async () => { removed++; } });
  const operation = await startCloneProject(input, handlers, deps);
  const rejected = assert.rejects(operation.waitForCompletion, { code: 'GIT_NOT_FOUND' });
  child.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' }));
  assert.equal(removed, 0); child.emit('close', -2); await rejected; assert.equal(removed, 1);
  await assert.rejects(startCloneProject(input, handlers, { ...deps, spawnGitClone: () => { throw new Error('sync spawn'); } }), /sync spawn/);
  assert.equal(removed, 2);
});

test('HTTPS credentials stay out of argv/origin, output redacts split raw/encoded/basic credentials and is bounded', async () => {
  const child = processFixture(); const progress: string[] = []; let environment: NodeJS.ProcessEnv | undefined;
  const token = 'secret+value'; const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  const operation = await startCloneProject({ ...input, newGithubToken: token }, { ...handlers, onProgress: message => progress.push(message) }, dependencies(child, {
    spawnGitClone: (remote, target, env) => { assert.equal(remote, input.githubUrl); assert.equal(path.basename(target), 'repo'); environment = env; return child; },
  }));
  child.stderr.write('remote: secret+'); child.stderr.write(`value ${encodeURIComponent(token)} Authorization: Basic ${basic}\n`);
  child.stdout.write('https://person:password@github.com/repo\n'); child.stderr.write('z'.repeat(10_000)); child.stderr.write('\n');
  child.emit('close', 1);
  await assert.rejects(operation.waitForCompletion, error => {
    const message = (error as Error).message; assert.ok(!message.includes(token)); assert.ok(!message.includes(basic)); return true;
  });
  assert.equal(environment?.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraheader');
  assert.equal(environment?.GIT_CONFIG_VALUE_0, 'Authorization: Basic ' + basic);
  assert.ok(progress.every(message => message.length <= 4096 && !message.includes(token) && !message.includes(encodeURIComponent(token)) && !message.includes(basic) && !message.includes('password')));
});

test('rejects unsafe remotes and non-HTTPS credentials while preserving standard Git remotes', async () => {
  for (const githubUrl of ['file:///repo', '/local/repo', 'ext::command repo', 'git://host/repo', 'https://token@host/repo', 'https://host/repo?token=secret', 'host:repo/../', 'C:/local/repo', 'https://host/a/%2e%2e.git']) {
    await assert.rejects(startCloneProject({ ...input, githubUrl }, handlers, dependencies()), { code: 'INVALID_GITHUB_URL' }, githubUrl);
  }
  for (const githubUrl of ['http://host/team/repo.git', 'ssh://git@host/team/repo.git', 'git@host:team/repo.git']) {
    await assert.rejects(startCloneProject({ ...input, githubUrl, newGithubToken: 'secret' }, handlers, dependencies()), { code: 'CLONE_CREDENTIALS_REQUIRE_HTTPS' });
    const child = processFixture(); const operation = await startCloneProject({ ...input, githubUrl }, handlers, dependencies(child)); child.emit('close', 0); await operation.waitForCompletion;
  }
});

test('registration failure retains completed directory with actionable path and code', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'clone-register-')); const child = processFixture(); let removed = false;
  try {
    const operation = await startCloneProject({ ...input, workspacePath: parent }, handlers, dependencies(child, {
      reserveDirectory: async target => { await mkdir(target); }, removePath: async () => { removed = true; }, registerProject: async () => { throw new Error('database unavailable'); },
    }));
    child.emit('close', 0);
    await assert.rejects(operation.waitForCompletion, error => {
      assert.equal((error as { code: string }).code, 'CLONE_PROJECT_REGISTRATION_FAILED'); assert.match((error as Error).message, /add this existing directory/); assert.ok((error as Error).message.includes(path.join(parent, 'repo'))); return true;
    });
    assert.equal(removed, false); assert.ok((await stat(path.join(parent, 'repo'))).isDirectory());
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('cancellation once registration commits cannot delete a registered source', async () => {
  const child = processFixture(); const entered = deferred(); const commit = deferred(); const cancellation = new AbortController();
  let removed = false; let complete = false;
  const operation = await startCloneProject({ ...input, signal: cancellation.signal }, { ...handlers, onComplete: () => { complete = true; } }, dependencies(child, {
    removePath: async () => { removed = true; }, registerProject: async () => { entered.resolve(); await commit.promise; return { project: { projectId: 'p' } }; },
  }));
  child.emit('close', 0); await entered.promise; cancellation.abort(); operation.cancel(); commit.resolve();
  await operation.waitForCompletion; assert.equal(removed, false); assert.equal(complete, true);
});

test('explicit ownership is rechecked after asynchronous preflight and immediately before registration', async () => {
  const child = processFixture(); let allowed = true; let registered = false;
  const operation = await startCloneProject(input, handlers, dependencies(child, {
    assertOwner: () => { if (!allowed) throw new Error('owner changed'); },
    registerProject: async () => { registered = true; return { project: {} }; },
  }));
  allowed = false; child.emit('close', 0);
  await assert.rejects(operation.waitForCompletion, { code: 'CLONE_PROJECT_REGISTRATION_FAILED' }); assert.equal(registered, false);
});
