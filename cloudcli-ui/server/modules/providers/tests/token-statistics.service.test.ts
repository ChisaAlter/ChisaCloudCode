import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, realpath, writeFile, appendFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';

import Database from 'better-sqlite3';
import express, { type Request, type Response, type NextFunction } from 'express';

import { createTokenStatisticsService, tokenStatisticsService } from '@/modules/providers/services/token-statistics.service.js';
import providerRouter from '@/modules/providers/provider.routes.js';

type Dependencies = NonNullable<Parameters<typeof createTokenStatisticsService>[0]>;
type Session = ReturnType<NonNullable<Dependencies['listSessions']>>[number];
const now = () => new Date('2026-10-29T04:00:00.000Z');
const query = { userId: 1, range: 'all' as const, timeZone: 'Asia/Shanghai' };
function session(id: string, overrides: Partial<Session> = {}): Session {
  return { session_id: id, provider: 'claude', provider_session_id: id, project_path: '/work/project',
    jsonl_path: null, provider_profile_path: null, custom_name: id, model: null, effort: null,
    forked_from_session_id: null, workspace_mode: 'isolated', isArchived: 0,
    created_at: '2026-10-01T00:00:00Z', updated_at: now().toISOString(), ...overrides };
}
function assistant(id: string, at: string | undefined, output = 4, extra: Record<string, unknown> = {}) {
  return { type: 'assistant', timestamp: at, requestId: `request-${id}`, message: { id, model: 'claude-fixture',
    usage: { input_tokens: 10, output_tokens: output, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 } }, ...extra };
}
async function fixture(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'token-statistics-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
async function transcript(file: string, rows: unknown[]) {
  await writeFile(file, rows.map((row) => typeof row === 'string' ? row : JSON.stringify(row)).join('\n'));
}
function service(sessions: Session[], overrides: Dependencies = {}) {
  return createTokenStatisticsService({ listSessions: () => sessions, canReadSession: () => true,
    getSupersededTranscriptPaths: () => [], projectName: () => 'ChisaBot', now, ...overrides });
}

test('all-history Claude requests deduplicate final chunks, fork copies, aliases and superseded archived generations', async () => fixture(async (directory) => {
  const current = path.join(directory, 'current.jsonl');
  const old = path.join(directory, 'old.jsonl');
  const fork = path.join(directory, 'fork.jsonl');
  const alias = path.join(directory, 'alias.jsonl');
  const first = assistant('first', '2026-10-27T01:00:00Z', 1);
  const final = assistant('first', '2026-10-27T01:00:01Z', 9);
  const retired = assistant('retired', '2026-10-26T01:00:00Z', 7);
  const sidechain = assistant('side', '2026-10-28T01:00:00Z', 5, { isSidechain: true });
  await transcript(current, [first, final, sidechain,
    assistant('synthetic', '2026-10-28T01:00:00Z', 100, { message: { id: 'synthetic', model: '<synthetic>', usage: { input_tokens: 999, output_tokens: 999 } } })]);
  await transcript(old, [first, retired]);
  await transcript(fork, [first, final, assistant('fork-only', '2026-10-29T01:00:00Z', 6)]);
  // Exercise alias canonicalization without requiring Windows symlink privileges.
  const reader = service([
    session('fork', { jsonl_path: fork, forked_from_session_id: 'original' }),
    session('original', { jsonl_path: current, isArchived: 1 }), session('alias', { jsonl_path: alias }),
  ], { getSupersededTranscriptPaths: (id) => id === 'original' ? [old] : [],
    canonicalPath: (file) => realpath(file === alias ? current : file) });
  const report = await reader.getStatistics(query);
  assert.equal(report.totals.requests, 4);
  assert.equal(report.totals.inputTokens, 40);
  assert.equal(report.totals.outputTokens, 27);
  assert.equal(report.totals.totalTokens, 87);
  assert.equal(report.totals.sessions, 2);
  assert.equal(report.bySession.find((row) => row.sessionId === 'original')?.isArchived, true);
  assert.equal(report.bySession.find((row) => row.sessionId === 'original')?.requests, 3);
  assert.equal(report.coverage.indexedSessions, 3);
  assert.equal(report.bySession[0].projectName, 'ChisaBot');
  assert.equal(report.coverage.unavailableSessions, 0);
  const scoped = await reader.getStatistics({ ...query, sessionId: 'fork' });
  assert.equal(scoped.totals.requests, 2);
  assert.equal(scoped.totals.outputTokens, 15);
}));

test('calendar ranges use requested timezone, include midnight, exclude future and mark undated/invalid usage unavailable', async () => fixture(async (directory) => {
  const file = path.join(directory, 'dated.jsonl');
  await transcript(file, [
    assistant('before-today', '2026-10-28T15:59:59Z'), assistant('today', '2026-10-28T16:00:00Z'),
    assistant('seven-boundary', '2026-10-22T16:00:00Z'), assistant('before-seven', '2026-10-22T15:59:59Z'),
    assistant('thirty-boundary', '2026-09-29T16:00:00Z'), assistant('before-thirty', '2026-09-29T15:59:59Z'),
    assistant('future', '2026-10-29T05:00:00Z'), assistant('undated', undefined),
    assistant('negative', '2026-10-29T01:00:00Z', -2), '{broken',
  ]);
  const reader = service([session('dated', { jsonl_path: file })]);
  const today = await reader.getStatistics({ ...query, range: 'today' });
  assert.equal(today.totals.requests, 1);
  assert.deepEqual(today.daily.map((day) => day.date), ['2026-10-29']);
  assert.equal((await reader.getStatistics({ ...query, range: '7d' })).totals.requests, 3);
  assert.equal((await reader.getStatistics({ ...query, range: '30d' })).totals.requests, 5);
  const all = await reader.getStatistics(query);
  assert.equal(all.totals.requests, 6);
  assert.equal(all.coverage.measuredSessions, 1);
  assert.equal(all.coverage.unavailableSessions, 1);
  const utc = await reader.getStatistics({ ...query, range: 'today', timeZone: 'UTC' });
  assert.equal(utc.totals.requests, 0);
}));

test('account ownership is checked before superseded paths, file reads, coverage; forbidden session returns 403', async () => {
  const accessed: string[] = [];
  const reader = service([session('mine'), session('foreign', { jsonl_path: '/must-not-read.jsonl' })], {
    canReadSession: (id) => id === 'mine',
    getSupersededTranscriptPaths: (id) => { accessed.push(id); return []; },
    canonicalPath: async () => { throw new Error('foreign read'); },
  });
  const report = await reader.getStatistics(query);
  assert.deepEqual(accessed, ['mine']);
  assert.equal(report.coverage.indexedSessions, 1);
  assert.equal(report.coverage.unavailableSessions, 1);
  await assert.rejects(reader.getStatistics({ ...query, sessionId: 'foreign' }), (error: any) => error.statusCode === 403);
  await assert.rejects(reader.getStatistics({ ...query, userId: null }), (error: any) => error.statusCode === 401);
  await assert.rejects(reader.getStatistics({ ...query, sessionId: 'missing' }), (error: any) => error.statusCode === 404);
});

test('Codex cumulative snapshots become deltas with cached input subtracted and repeated snapshots ignored', async () => fixture(async (directory) => {
  const file = path.join(directory, 'codex.jsonl');
  const snapshot = (at: string, input: number, cached: number, output: number) => ({ timestamp: at, type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } } } });
  await transcript(file, [{ type: 'turn_context', payload: { model: 'codex-fixture' } },
    snapshot('2026-10-28T10:00:00Z', 100, 20, 5), snapshot('2026-10-28T10:00:00Z', 100, 20, 5),
    snapshot('2026-10-29T01:00:00Z', 160, 40, 12), snapshot('2026-10-29T02:00:00Z', 150, 30, 11),
  ]);
  const reader = service([session('codex', { provider: 'codex', jsonl_path: file })]);
  const all = await reader.getStatistics(query);
  assert.deepEqual(all.totals, { inputTokens: 120, outputTokens: 12, cacheReadTokens: 40, cacheCreationTokens: 0, totalTokens: 172, requests: 2, sessions: 1 });
  const today = await reader.getStatistics({ ...query, range: 'today' });
  assert.equal(today.totals.inputTokens, 40);
  assert.equal(today.totals.outputTokens, 7);
  assert.equal(today.totals.cacheReadTokens, 20);
  assert.equal(today.totals.totalTokens, 67);
  assert.equal(all.coverage.unavailableSessions, 1);
}));

test('size/mtime cache invalidates on append, memory eviction and bounded reads report incomplete coverage', async () => fixture(async (directory) => {
  const file = path.join(directory, 'cached.jsonl');
  await transcript(file, [assistant('one', '2026-10-29T01:00:00Z')]);
  let reads = 0;
  const readLines: NonNullable<Dependencies['readLines']> = async function* (name, maxBytes) {
    reads += 1;
    const input = createReadStream(name, { encoding: 'utf8', end: maxBytes - 1 });
    const lines = createInterface({ input, crlfDelay: Infinity });
    try { for await (const line of lines) yield line; } finally { lines.close(); input.destroy(); }
  };
  const reader = service([session('cached', { jsonl_path: file })], { readLines });
  assert.equal((await reader.getStatistics(query)).totals.requests, 1);
  await reader.getStatistics(query);
  assert.equal(reads, 1);
  await appendFile(file, '\n' + JSON.stringify(assistant('two', '2026-10-29T02:00:00Z')));
  assert.equal((await reader.getStatistics(query)).totals.requests, 2);
  assert.equal(reads, 2);
  const capped = service([session('cached', { jsonl_path: file })], { maxRecordsPerFile: 1 });
  assert.equal((await capped.getStatistics(query)).coverage.unavailableSessions, 1);
  const byteCapped = service([session('cached', { jsonl_path: file })], { maxFileBytes: 50 });
  assert.equal((await byteCapped.getStatistics(query)).coverage.unavailableSessions, 1);
  const missing = service([session('missing', { jsonl_path: path.join(directory, 'absent.jsonl') }), session('cursor', { provider: 'cursor' })]);
  assert.deepEqual((await missing.getStatistics(query)).coverage, { indexedSessions: 2, measuredSessions: 0, unavailableSessions: 1, unsupportedSessions: 1 });
}));

test('message/request alias bridges coalesce across generations; empty placeholders and stream errors have honest coverage', async () => fixture(async (directory) => {
  const old = path.join(directory, 'old-bridge.jsonl');
  const latest = path.join(directory, 'latest-bridge.jsonl');
  await transcript(old, [assistant('bridge', '2026-10-29T01:00:00Z', 3, { requestId: undefined })]);
  await transcript(latest, [
    assistant('ignored', '2026-10-29T01:00:01Z', 5, { requestId: 'request-bridge', message: { model: 'claude-fixture', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 } } }),
    assistant('bridge', '2026-10-29T01:00:02Z', 8),
  ]);
  const reader = service([session('bridge', { jsonl_path: old })], { getSupersededTranscriptPaths: () => [latest] });
  assert.equal((await reader.getStatistics(query)).totals.requests, 1);
  assert.equal((await reader.getStatistics(query)).totals.outputTokens, 8);
  const placeholder = service([session('empty', { provider_session_id: null })]);
  assert.deepEqual((await placeholder.getStatistics(query)).coverage, { indexedSessions: 1, measuredSessions: 0, unavailableSessions: 0, unsupportedSessions: 0 });
  const brokenStream = service([session('read-error', { jsonl_path: old })], {
    readLines: async function* () { yield JSON.stringify(assistant('partial', '2026-10-29T01:00:00Z')); throw new Error('fixture stream failure'); },
  });
  assert.equal((await brokenStream.getStatistics(query)).coverage.unavailableSessions, 1);
}));

test('statistics route validates transport values and forwards only authenticated identity', async () => {
  const original = tokenStatisticsService.getStatistics;
  let forwarded: unknown;
  tokenStatisticsService.getStatistics = async (input) => { forwarded = input; return service([]).getStatistics(input); };
  const app = express().use((req, _res, next) => { (req as Request & { user: { id: number } }).user = { id: 42 }; next(); })
    .use('/api/providers', providerRouter)
    .use((error: any, _req: Request, res: Response, _next: NextFunction) => { res.status(error.statusCode ?? 500).json({ error: error.message }); });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/providers/token-statistics`;
  try {
    for (const suffix of ['?range=nope', '?range[]=today', '?timeZone=Nope/Invalid', '?timeZone[]=UTC', '?sessionId[]=a', '?sessionId=../a', '?sessionId=']) {
      assert.equal((await fetch(base + suffix)).status, 400, suffix);
    }
    const response = await fetch(base + '?range=today&timeZone=Asia%2FShanghai&userId=999');
    assert.equal(response.status, 200);
    assert.deepEqual(forwarded, { userId: 42, range: 'today', timeZone: 'Asia/Shanghai', sessionId: undefined });
    assert.equal(((await response.json()) as { success: boolean }).success, true);
    forwarded = null;
    assert.equal((await fetch(base)).status, 200);
    assert.deepEqual(forwarded, { userId: 42, range: '7d', timeZone: 'UTC', sessionId: undefined });
  } finally {
    tokenStatisticsService.getStatistics = original;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('OpenCode uses dated per-message actual token fields and treats legacy schemas as unsupported', async () => fixture(async (directory) => {
  const file = path.join(directory, 'opencode.db');
  const db = new Database(file);
  db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)');
  db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('oc-message', 'oc-native', Date.parse('2026-10-29T01:00:00Z'), JSON.stringify({ role: 'assistant', modelID: 'oc-fixture',
    tokens: { input: 20, output: 5, reasoning: 2, cache: { read: 8, write: 3 } } }));
  db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('foreign-message', 'foreign-native', Date.parse('2026-10-29T01:00:00Z'), JSON.stringify({ role: 'assistant', tokens: { input: 999, output: 999 } }));
  db.close();
  const reader = service([session('oc', { provider: 'opencode', provider_session_id: 'oc-native' })], { openCodeDatabasePath: () => file });
  const report = await reader.getStatistics(query);
  assert.deepEqual(report.totals, { inputTokens: 20, outputTokens: 7, cacheReadTokens: 8, cacheCreationTokens: 3, totalTokens: 38, requests: 1, sessions: 1 });
  assert.equal(report.byModel[0].model, 'oc-fixture');
  const legacyFile = path.join(directory, 'legacy.db');
  const legacy = new Database(legacyFile);
  legacy.exec('CREATE TABLE session (id TEXT PRIMARY KEY, tokens_input INTEGER)');
  legacy.close();
  const unsupported = service([session('legacy', { provider: 'opencode' })], { openCodeDatabasePath: () => legacyFile });
  assert.equal((await unsupported.getStatistics(query)).coverage.unsupportedSessions, 1);
}));
