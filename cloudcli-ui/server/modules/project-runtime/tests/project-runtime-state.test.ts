import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Worker } from 'node:worker_threads';

import { closeConnection, getConnection, initializeDatabase } from '@/modules/database/index.js';
import type { ProjectRuntimeManifest } from '@/shared/index.js';

import { getProjectRuntimeManifest, readProjectMemory, saveProjectRuntimeManifest, updateProjectRuntimeManifest, writeProjectMemory } from '../project-runtime-state.service.js';

async function fixture(run: () => void | Promise<void>) {
  const previous = process.env.DATABASE_PATH;
  const root = await mkdtemp(path.join(tmpdir(), 'project-runtime-state-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'fixture.db');
  await writeFile(process.env.DATABASE_PATH, '', { flag: 'wx' });
  try { await initializeDatabase(); await run(); }
  finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
}

function manifest(overrides: Partial<ProjectRuntimeManifest> = {}): ProjectRuntimeManifest {
  return {
    runId: 'run-1', sessionId: 'session-1', projectId: 'project-1', workspaceId: 'workspace-1', generation: 'generation-1',
    at: '2026-10-26T15:00:00.000Z', configRevision: 'revision-1', status: 'loaded',
    files: [{ path: 'CLAUDE.md', hash: 'hash-1', kind: 'instruction' }],
    skills: [{ name: 'check', path: '.claude/skills/check/SKILL.md', status: 'available' }],
    mcp: [{ name: 'docs', transport: 'http', location: 'cloud', status: 'selected' }], warnings: [], ...overrides,
  };
}

const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

test('manifest reads isolate app users, projects, selected Claude accounts and exact source generations', async () => fixture(() => {
  assert.equal(getProjectRuntimeManifest('user-1', 'project-1'), null);
  saveProjectRuntimeManifest('user-1', manifest());
  assert.deepEqual(getProjectRuntimeManifest('user-1', 'project-1'), manifest());
  assert.deepEqual(getProjectRuntimeManifest('user-1', 'project-1', { accountKey: 'app' }), manifest());
  assert.equal(getProjectRuntimeManifest('user-2', 'project-1'), null);
  assert.equal(getProjectRuntimeManifest('user-1', 'project-2'), null);
  assert.equal(getProjectRuntimeManifest('user-1', 'project-1', { accountKey: 'subscription-2' }), null);
  assert.equal(getProjectRuntimeManifest('user-1', 'project-1', { workspaceId: 'workspace-2' }), null);
  assert.equal(getProjectRuntimeManifest('user-1', 'project-1', { generation: 'generation-2' }), null);
  assert.deepEqual(getProjectRuntimeManifest('user-1', 'project-1', { workspaceId: 'workspace-1', generation: 'generation-1' }), manifest());
  saveProjectRuntimeManifest('user-1', manifest({ runId: 'another-account' }), 'subscription-2');
  saveProjectRuntimeManifest('user-2', manifest({ runId: 'another-user' }));
  assert.equal(getProjectRuntimeManifest('user-1', 'project-1')?.runId, 'run-1');
  assert.equal(getProjectRuntimeManifest('user-1', 'project-1', { accountKey: 'subscription-2' })?.runId, 'another-account');
  assert.equal(getProjectRuntimeManifest('user-2', 'project-1')?.runId, 'another-user');
  assert.equal(updateProjectRuntimeManifest('user-2', 'project-1', 'run-1', { status: 'failed' }), null);
  assert.equal(updateProjectRuntimeManifest('user-1', 'project-1', 'run-1', { status: 'failed' }, 'missing-account'), null);
  assert.equal(getProjectRuntimeManifest('user-1', 'project-1')?.status, 'loaded');
}));

test('run updates compare identity atomically and never let delayed starts or stale completion replace a newer run', async () => fixture(() => {
  saveProjectRuntimeManifest('user-1', manifest({ status: 'loading' }));
  assert.equal(updateProjectRuntimeManifest('user-1', 'project-1', 'run-1', { status: 'loaded', warnings: ['Loaded exact content.'] })?.status, 'loaded');
  saveProjectRuntimeManifest('user-1', manifest({ status: 'loading' }));
  assert.equal(getProjectRuntimeManifest('user-1', 'project-1')?.status, 'loaded', 'duplicate start must not erase tool/config updates');
  const next = manifest({ runId: 'run-2', at: '2026-10-26T15:01:00.000Z', status: 'loading', generation: 'generation-2' });
  saveProjectRuntimeManifest('user-1', next);
  assert.equal(updateProjectRuntimeManifest('user-1', 'project-1', 'run-1', { status: 'completed' }), null);
  saveProjectRuntimeManifest('user-1', manifest({ runId: 'older-start' }));
  assert.deepEqual(getProjectRuntimeManifest('user-1', 'project-1'), next);
  assert.equal(updateProjectRuntimeManifest('user-1', 'project-1', 'run-2', { status: 'failed', error: 'Explicit launch failure.' })?.error, 'Explicit launch failure.');
  const completed = updateProjectRuntimeManifest('user-1', 'project-1', 'run-2', { status: 'completed', error: undefined });
  assert.equal(completed?.error, undefined);
  assert.equal(completed?.at, next.at);
  assert.equal(getProjectRuntimeManifest('user-1', 'project-1', { generation: 'generation-1' }), null);
  const equalTime = { ...next, runId: 'run-3' };
  saveProjectRuntimeManifest('user-1', equalTime);
  assert.equal(getProjectRuntimeManifest('user-1', 'project-1')?.runId, 'run-3', 'equal timestamp admits the newest serialized start call');
}));

test('run patch cannot retarget its immutable source identity, session or original start timestamp', async () => fixture(() => {
  const initial = manifest();
  saveProjectRuntimeManifest('user-1', initial);
  for (const [field, value] of Object.entries({ runId: 'other-run', sessionId: 'other-session', projectId: 'other-project', workspaceId: 'other-workspace', generation: 'other-generation', at: '2026-10-26T16:00:00.000Z' })) {
    assert.throws(() => updateProjectRuntimeManifest('user-1', 'project-1', 'run-1', { [field]: value }), { code: 'PROJECT_RUNTIME_STATE_INVALID' });
    assert.deepEqual(getProjectRuntimeManifest('user-1', 'project-1'), initial);
  }
  assert.equal(updateProjectRuntimeManifest('user-1', 'project-1', 'run-1', { runId: initial.runId, generation: initial.generation, status: 'completed' })?.status, 'completed');
}));

test('manifest persistence strips raw configuration and unknown nested properties rather than serializing arbitrary objects', async () => fixture(() => {
  const initial = manifest();
  const unsafe = { ...initial, apiKey: 'must-not-store', rawConfig: { env: { token: 'must-not-store' } },
    files: [{ ...initial.files[0]!, content: 'secret instructions' }],
    skills: [{ ...initial.skills[0]!, body: 'secret skill body' }],
    mcp: [{ ...initial.mcp[0]!, url: 'https://example.test/?token=secret', headers: { Authorization: 'Bearer secret' } }],
  };
  saveProjectRuntimeManifest('user-1', unsafe);
  assert.deepEqual(getProjectRuntimeManifest('user-1', 'project-1'), initial);
  const raw = (getConnection().prepare("SELECT value FROM app_config WHERE key LIKE 'project-runtime:manifest:%'").get() as { value: string }).value;
  assert.equal(raw.includes('secret'), false);
  assert.equal(raw.includes('must-not-store'), false);
  updateProjectRuntimeManifest('user-1', 'project-1', 'run-1', { status: 'completed', token: 'patch-secret' } as Partial<ProjectRuntimeManifest>);
  assert.equal(JSON.stringify(getProjectRuntimeManifest('user-1', 'project-1')).includes('patch-secret'), false);
  const result = getProjectRuntimeManifest('user-1', 'project-1')!;
  result.files[0]!.path = 'changed-after-read';
  assert.equal(getProjectRuntimeManifest('user-1', 'project-1')?.files[0]?.path, 'CLAUDE.md');
}));

test('manifest text, item counts and total UTF-8 serialization are bounded before persistence', async () => fixture(() => {
  const invalidValues: Array<Partial<ProjectRuntimeManifest>> = [
    { at: 'not-a-timestamp' }, { runId: '' }, { projectId: ' project-1' }, { generation: '\n' },
    { status: 'pretend-success' as ProjectRuntimeManifest['status'] }, { files: [{ path: 'x'.repeat(1025), hash: 'hash', kind: 'instruction' }] },
    { warnings: Array.from({ length: 201 }, () => 'warning') },
  ];
  for (const value of invalidValues) assert.throws(() => saveProjectRuntimeManifest('user-1', manifest(value)), { code: 'PROJECT_RUNTIME_STATE_INVALID' });
  assert.throws(() => saveProjectRuntimeManifest('user-1', manifest({ warnings: Array.from({ length: 30 }, () => '文'.repeat(1024)) })), { code: 'PROJECT_RUNTIME_MANIFEST_TOO_LARGE' });
  assert.equal(getProjectRuntimeManifest('user-1', 'project-1'), null);
}));

test('project memory defaults to SHA256 of empty text, requires exact hashes and persists only explicit content', async () => fixture(() => {
  const empty = readProjectMemory('user-1', 'project-1');
  assert.deepEqual(empty, { content: '', hash: hash('') });
  const saved = writeProjectMemory('user-1', 'project-1', '# 项目记忆\nExplicit user note.\n', empty.hash);
  assert.equal(saved.hash, hash(saved.content));
  assert.deepEqual(readProjectMemory('user-1', 'project-1'), saved);
  assert.throws(() => writeProjectMemory('user-1', 'project-1', 'stale note', empty.hash), { code: 'PROJECT_MEMORY_CONFLICT', statusCode: 409 });
  assert.throws(() => writeProjectMemory('user-1', 'project-1', 'no read', ''), { code: 'PROJECT_MEMORY_CONFLICT' });
  assert.deepEqual(readProjectMemory('user-1', 'project-1'), saved);
  const cleared = writeProjectMemory('user-1', 'project-1', '', saved.hash);
  assert.deepEqual(cleared, empty);
  assert.deepEqual(readProjectMemory('user-1', 'project-1'), empty);
}));

test('memory isolates user/project tuples while remaining unchanged by the chosen Claude account or source generation', async () => fixture(() => {
  const emptyHash = hash('');
  writeProjectMemory('user:1', 'project:1', 'first owner note', emptyHash);
  writeProjectMemory('user', '1:project:1', 'different tuple note', emptyHash);
  assert.equal(readProjectMemory('user:1', 'project:1').content, 'first owner note');
  assert.equal(readProjectMemory('user', '1:project:1').content, 'different tuple note');
  assert.deepEqual(readProjectMemory('foreign', 'project:1'), { content: '', hash: emptyHash });
  assert.deepEqual(readProjectMemory('user:1', 'other-project'), { content: '', hash: emptyHash });
  saveProjectRuntimeManifest('user:1', manifest({ projectId: 'project:1' }), 'claude-account-a');
  saveProjectRuntimeManifest('user:1', manifest({ projectId: 'project:1', generation: 'new-generation' }), 'claude-account-b');
  assert.equal(readProjectMemory('user:1', 'project:1').content, 'first owner note');
  writeProjectMemory("'; DROP TABLE app_config; --", 'project', 'safe tuple key', emptyHash);
  assert.equal(readProjectMemory("'; DROP TABLE app_config; --", 'project').content, 'safe tuple key');
}));

test('memory accepts the byte boundary and multiline text while rejecting oversize or binary input without changing the saved version', async () => fixture(() => {
  const initial = writeProjectMemory('user-1', 'project-1', 'a'.repeat(65536), hash(''));
  assert.equal(Buffer.byteLength(initial.content), 65536);
  for (const invalid of ['\0binary', 'control\u001btext', '\ud800']) {
    assert.throws(() => writeProjectMemory('user-1', 'project-1', invalid, initial.hash), { code: 'PROJECT_MEMORY_INVALID' });
  }
  for (const oversize of ['a'.repeat(65537), '文'.repeat(21846)]) {
    assert.throws(() => writeProjectMemory('user-1', 'project-1', oversize, initial.hash), { code: 'PROJECT_MEMORY_TOO_LARGE' });
  }
  assert.deepEqual(readProjectMemory('user-1', 'project-1'), initial);
  assert.equal(writeProjectMemory('user-1', 'project-1', 'line one\r\n\tline two', initial.hash).content, 'line one\r\n\tline two');
  for (const args of [['', 'project-1'], ['user-1', ''], ['user-1\n', 'project-1']]) {
    assert.throws(() => readProjectMemory(args[0]!, args[1]!), { code: 'PROJECT_RUNTIME_STATE_INVALID' });
  }
}));

test('runtime manifest and memory survive connection reopen without restoring deleted source files or accepting old hashes/runs', async () => fixture(async () => {
  const initial = manifest();
  saveProjectRuntimeManifest('user-1', initial, 'claude-account');
  const note = writeProjectMemory('user-1', 'project-1', 'Durable explicit note.', hash(''));
  closeConnection();
  await initializeDatabase();
  assert.deepEqual(getProjectRuntimeManifest('user-1', 'project-1', { accountKey: 'claude-account', generation: initial.generation }), initial);
  assert.deepEqual(readProjectMemory('user-1', 'project-1'), note);
  assert.equal(updateProjectRuntimeManifest('user-1', 'project-1', 'outdated-run', { status: 'failed' }, 'claude-account'), null);
  assert.throws(() => writeProjectMemory('user-1', 'project-1', 'lost update', hash('')), { code: 'PROJECT_MEMORY_CONFLICT' });
}));

test('two independent SQLite connections cannot both commit the same project memory hash', async () => fixture(async () => {
  const work = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { tsImport } = await import(workerData.tsx);
      const state = await tsImport(workerData.service, { parentURL: workerData.parent, tsconfig: workerData.tsconfig });
      parentPort.once('message', () => {
        try { parentPort.postMessage({ ok: true, result: state.writeProjectMemory('user-1', 'project-1', workerData.content, workerData.hash) }); }
        catch (error) { parentPort.postMessage({ ok: false, code: error.code }); }
      });
      parentPort.postMessage('ready');
    })().catch(error => { throw error; });
  `;
  const workerData = { tsx: import.meta.resolve('tsx/esm/api'), service: new URL('../project-runtime-state.service.ts', import.meta.url).href,
    parent: import.meta.url, tsconfig: path.resolve('server/tsconfig.json'), hash: hash('') };
  const workers = ['first writer', 'second writer'].map(content => new Worker(work, { eval: true, execArgv: [], workerData: { ...workerData, content } }));
  try {
    await Promise.all(workers.map(worker => once(worker, 'message')));
    const results = workers.map(worker => once(worker, 'message'));
    workers.forEach(worker => worker.postMessage('write'));
    const outcomes = (await Promise.all(results)).map(value => value[0] as { ok: boolean; code?: string; result?: { content: string; hash: string } });
    assert.equal(outcomes.filter(value => value.ok).length, 1);
    assert.deepEqual(outcomes.filter(value => !value.ok).map(value => value.code), ['PROJECT_MEMORY_CONFLICT']);
    assert.deepEqual(readProjectMemory('user-1', 'project-1'), outcomes.find(value => value.ok)?.result);
  } finally { await Promise.all(workers.map(worker => worker.terminate())); }
}));

test('missing rows return null, corrupted metadata and actual database errors remain explicit failures', async () => fixture(() => {
  saveProjectRuntimeManifest('user-1', manifest());
  getConnection().prepare("UPDATE app_config SET value = ? WHERE key LIKE 'project-runtime:manifest:%'").run('{bad json');
  assert.throws(() => getProjectRuntimeManifest('user-1', 'project-1'), { code: 'PROJECT_RUNTIME_STATE_CORRUPT' });
  getConnection().exec('DROP TABLE app_config');
  assert.throws(() => getProjectRuntimeManifest('user-1', 'project-1'), /no such table/);
  assert.throws(() => readProjectMemory('user-1', 'project-1'), /no such table/);
}));
