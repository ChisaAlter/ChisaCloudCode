import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import Database from 'better-sqlite3';

import { prepareProviderProfile } from '@/modules/providers/services/provider-profile.service.js';
import { sessionsDb } from '@/modules/database/index.js';

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chisa-provider-profile-'));
  const home = mock.method(os, 'homedir', () => root);
  const byId = mock.method(sessionsDb, 'getSessionById', () => null);
  const byNative = mock.method(sessionsDb, 'getSessionByProviderSessionId', () => null);
  try { await run(root); }
  finally { byId.mock.restore(); byNative.mock.restore(); home.mock.restore(); await rm(root, { recursive: true, force: true }); }
}
const codexJob = { kind: 'codex' as const, providerSessionId: null, threadOptions: {}, input: 'fixture' };

test('managed profile persists session state across runs without host profile copyback', async () => {
  await fixture(async (root) => {
    await mkdir(path.join(root, '.codex'), { recursive: true });
    await writeFile(path.join(root, '.codex', 'auth.json'), '{"fixture":"original"}');
    const profile = await prepareProviderProfile('codex', 'app', codexJob);
    const store = profile.mounts.find((mount) => mount.writable)!;
    const credentials = profile.mounts.find((mount) => mount.target.endsWith('/auth.json'))!;
    assert.notEqual(credentials.source, path.join(root, '.codex', 'auth.json'));
    assert.equal(credentials.writable, false);
    assert.equal(await readFile(path.join(store.source, 'auth.json'), 'utf8'), '', 'Persistent mount targets must not store stale credentials');
    await mkdir(path.join(store.source, 'sessions'), { recursive: true });
    await writeFile(path.join(store.source, 'sessions', 'rollout.jsonl'), 'managed session\n');
    await profile.finish('publish');
    const resumed = await prepareProviderProfile('codex', 'app', codexJob);
    assert.equal(resumed.home, profile.home);
    assert.equal(await readFile(path.join(store.source, 'sessions', 'rollout.jsonl'), 'utf8'), 'managed session\n');
    assert.equal(await readFile(path.join(root, '.codex', 'auth.json'), 'utf8'), '{"fixture":"original"}');
    await assert.rejects(readFile(path.join(root, '.codex', 'sessions', 'rollout.jsonl')), { code: 'ENOENT' });
    await resumed.finish('publish');
  });
});

test('different app sessions have independent managed profile directories', async () => {
  await fixture(async () => {
    const first = await prepareProviderProfile('codex', 'app-one', codexJob);
    await first.finish('publish');
    const second = await prepareProviderProfile('codex', 'app-two', codexJob);
    assert.notEqual(first.home, second.home);
    await second.finish('publish');
  });
});

test('OpenCode imports a coherent native database once and never copies changes back', async () => {
  await fixture(async (root) => {
    const data = path.join(root, '.local', 'share', 'opencode');
    await mkdir(data, { recursive: true });
    const filename = path.join(data, 'opencode.db');
    const original = new Database(filename); original.exec("CREATE TABLE session(id TEXT); INSERT INTO session VALUES ('legacy')"); original.close();
    const job = { kind: 'cli' as const, command: 'opencode', args: ['--session', 'native'], cwd: root };
    const profile = await prepareProviderProfile('opencode', 'app', job);
    const store = profile.mounts.find((mount) => mount.writable)!;
    const snapshot = new Database(path.join(store.source, 'opencode.db')); snapshot.exec("INSERT INTO session VALUES ('managed')"); snapshot.close();
    await profile.finish('publish');
    const resumed = await prepareProviderProfile('opencode', 'app', job);
    const result = new Database(path.join(store.source, 'opencode.db'));
    const legacy = new Database(filename);
    try {
      assert.deepEqual(result.prepare('SELECT id FROM session').all(), [{ id: 'legacy' }, { id: 'managed' }]);
      assert.deepEqual(legacy.prepare('SELECT id FROM session').all(), [{ id: 'legacy' }]);
    } finally { result.close(); legacy.close(); await resumed.finish('publish'); }
  });
});

test('queued profile preparation responds to cancellation before the active run ends', async () => {
  await fixture(async () => {
    const first = await prepareProviderProfile('codex', 'app', codexJob);
    const cancellation = new AbortController();
    const waiting = prepareProviderProfile('codex', 'app', codexJob, cancellation.signal);
    cancellation.abort();
    await assert.rejects(waiting, { name: 'AbortError' });
    await first.finish('publish');
    const next = await prepareProviderProfile('codex', 'next', codexJob);
    await next.finish('publish');
  });
});
