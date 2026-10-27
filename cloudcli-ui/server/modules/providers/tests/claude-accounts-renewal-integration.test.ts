import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { claudeAccountsDb, closeConnection, initializeDatabase, userDb } from '@/modules/database/index.js';
import { ClaudeAccountsService } from '@/modules/providers/services/claude-accounts.service.js';
import { ClaudeAccountProfiles } from '@/modules/providers/services/claude-accounts-profiles.service.js';
import { ClaudeAccountQuotaService } from '@/modules/providers/services/claude-accounts-quota.service.js';
import { ClaudeAccountRenewalService } from '@/modules/providers/services/claude-accounts-renewal.service.js';

class Child extends EventEmitter { pid = undefined; kill() { this.emit('close', null); return true; } }
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test('default quota and managed HiRoute subscription await silent renewal and hold account leases', async () => {
  const oldDatabase = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chisa-renewal-integration-'));
  const home = path.join(directory, 'home'); const database = path.join(directory, 'auth.db'); const now = Date.now();
  closeConnection(); process.env.DATABASE_PATH = database;
  await writeFile(database, ''); await mkdir(path.join(home, '.claude'), { recursive: true }); await initializeDatabase();
  const id = Number(userDb.createUser('renewal-fixture', 'fixture').id);
  const profiles = new ClaudeAccountProfiles({ databasePath: () => database, home: () => home, env: () => ({}) });
  const original = JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-expired', refreshToken: 'fixture-refresh', expiresAt: now - 60_000, subscriptionType: 'pro' } });
  const save = async (directory: string) => { await writeFile(path.join(directory, '.credentials.json'), original); await writeFile(path.join(directory, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'renewal@example.test', organizationUuid: 'fixture-org' } })); };
  await save(path.join(home, '.claude'));
  const children: Array<{ child: Child; directory: string }> = [];
  const renewal = new ClaudeAccountRenewalService({ now: () => now, resolveExecutable: () => 'fixture-cli', spawn: (_command, _args, options) => { const child = new Child(); children.push({ child, directory: String(options.env?.CLAUDE_SECURESTORAGE_CONFIG_DIR) }); return child as unknown as ChildProcess; } });
  let quotaCalls = 0;
  const quota = new ClaudeAccountQuotaService({ now: () => now, fetch: (async (_url, options) => {
    quotaCalls++; assert.equal(new Headers(options?.headers).get('Authorization'), 'Bearer fixture-renewed');
    return new Response(JSON.stringify({ five_hour: { utilization: 12, resets_at: now + 600_000 } }));
  }) as typeof fetch });
  const service = new ClaudeAccountsService({ profiles, renewal, quota, now: () => now });
  const finish = async (index: number) => { const item = children[index]; await writeFile(path.join(item.directory, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-renewed', refreshToken: 'fixture-rotated', expiresAt: now + 3_600_000, subscriptionType: 'pro' } })); item.child.emit('close', 0); };
  try {
    const statePending = service.getState(id); await flush();
    assert.equal(children.length, 1); assert.equal(quotaCalls, 0);
    await finish(0); const state = await statePending;
    assert.equal(state.defaultAccount?.needsSignIn, false); assert.equal(quotaCalls, 1);
    assert.equal(JSON.stringify(state).includes('renewalFingerprint'), false); assert.equal(JSON.stringify(state).includes('fixture-rotated'), false);
    const accountId = '00000000-0000-4000-8000-000000000001'; const managedHome = profiles.create(id, accountId); await save(managedHome);
    claudeAccountsDb.save(id, { id: accountId, name: 'Managed', email: 'renewal@example.test', organizationUuid: 'fixture-org', organizationName: null, plan: 'pro', createdAt: now, updatedAt: now }); claudeAccountsDb.activate(id, accountId);
    const subscription = service.readSubscription(id); await flush(); assert.equal(children.length, 2);
    await assert.rejects(service.remove(id, accountId), (error: unknown) => (error as { code?: string }).code === 'CLAUDE_ACCOUNT_IN_USE');
    await assert.rejects(service.startLogin(id, { accountId }), (error: unknown) => (error as { code?: string }).code === 'CLAUDE_ACCOUNT_IN_USE');
    await finish(1); assert.equal((await subscription)?.accessToken, 'fixture-renewed');
    // A temporary CLI/service failure preserves the exact refresh-bearing file and does not ask for another login.
    await save(managedHome); const transient = service.getState(id); await flush(); assert.equal(children.length, 3); children[2].child.emit('close', 0);
    const failedState = await transient; assert.equal(failedState.accounts[0].needsSignIn, false); assert.equal(failedState.accounts[0].usage.failureKind, 'stale-token');
    assert.equal(await readFile(path.join(managedHome, '.credentials.json'), 'utf8'), original);
    await service.getState(id); assert.equal(children.length, 3);
  } finally { await service.dispose(); closeConnection(); if (oldDatabase === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = oldDatabase; await rm(directory, { recursive: true, force: true }); }
});
