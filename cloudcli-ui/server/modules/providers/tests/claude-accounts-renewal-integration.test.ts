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

async function promptly<T>(operation: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('Local account response waited for remote quota/renewal.')), 1_000);
    })]);
  } finally { clearTimeout(timeout); }
}

test('account reads and mutations return local snapshots while quota and default renewal are pending', async () => {
  const oldDatabase = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chisa-account-fast-state-'));
  const home = path.join(directory, 'home'); const database = path.join(directory, 'auth.db');
  let now = Date.now();
  closeConnection(); process.env.DATABASE_PATH = database;
  await writeFile(database, ''); await mkdir(path.join(home, '.claude'), { recursive: true }); await initializeDatabase();
  const id = Number(userDb.createUser('fast-state-fixture', 'fixture').id);
  const profiles = new ClaudeAccountProfiles({ databasePath: () => database, home: () => home, env: () => ({}) });
  const save = async (directory: string, expiresAt: number) => {
    await writeFile(path.join(directory, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-fast-state', refreshToken: 'fixture-refresh', expiresAt, subscriptionType: 'pro' } }));
    await writeFile(path.join(directory, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'fast-state@example.test', organizationUuid: 'fixture-org' } }));
  };
  await save(path.join(home, '.claude'), now - 60_000);
  const accountIds = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'];
  for (const accountId of accountIds) {
    await save(profiles.create(id, accountId), now + 3_600_000);
    claudeAccountsDb.save(id, { id: accountId, name: accountId, email: 'fast-state@example.test', organizationUuid: 'fixture-org', organizationName: null, plan: 'pro', createdAt: now, updatedAt: now });
  }
  const children: Child[] = [];
  const renewal = new ClaudeAccountRenewalService({ now: () => now, resolveExecutable: () => 'fixture-cli', spawn: () => { const child = new Child(); children.push(child); return child as unknown as ChildProcess; } });
  let quotaCalls = 0;
  let resolveQuota: ((response: Response) => void) | undefined;
  const quota = new ClaudeAccountQuotaService({ now: () => now, fetch: (async () => {
    quotaCalls++;
    if (quotaCalls === 1) return new Response(JSON.stringify({ five_hour: { utilization: 12, resets_at: now + 600_000 } }));
    return new Promise<Response>(resolve => { resolveQuota = resolve; });
  }) as typeof fetch });
  const service = new ClaudeAccountsService({ profiles, renewal, quota, now: () => now });
  let quotaRefresh: ReturnType<typeof service.refresh> | undefined;
  let defaultRefresh: ReturnType<typeof service.refresh> | undefined;
  try {
    const initial = await promptly(service.select(id, accountIds[0]));
    assert.equal(initial.activeId, accountIds[0]); assert.equal(initial.accounts[0].usage.failureKind, 'not-read');
    assert.equal(children.length, 0); assert.equal(quotaCalls, 0);
    await service.refresh(id, { id: accountIds[0] });
    now += 1_000;
    quotaRefresh = service.refresh(id, { id: accountIds[0] });
    defaultRefresh = service.refresh(id, { id: null });
    await flush();
    assert.equal(quotaCalls, 2); assert.equal(children.length, 1); assert.equal(typeof resolveQuota, 'function');
    const selected = await promptly(service.select(id, accountIds[0]));
    assert.equal(selected.activeId, accountIds[0]); assert.equal(selected.route.accountId, accountIds[0]);
    assert.equal(selected.accounts[0].usage.windows[0].usedPercent, 12);
    assert.equal(selected.accounts[0].usage.checkedAt, now - 1_000);
    const defaultSelected = await promptly(service.select(id, null));
    assert.equal(defaultSelected.route.accountId, 'default'); assert.equal(defaultSelected.defaultAccount?.needsSignIn, false);
    assert.equal(defaultSelected.defaultAccount?.usage.failureKind, 'stale-token');
    assert.equal((await promptly(service.getState(id))).defaultAccount?.usage.failureKind, 'stale-token');
    assert.equal((await promptly(service.rename(id, accountIds[0], 'Renamed locally'))).accounts[0].name, 'Renamed locally');
    const removed = await promptly(service.remove(id, accountIds[1]));
    assert.equal(removed.accounts.length, 1); assert.equal(removed.accounts[0].usage.windows[0].usedPercent, 12);
    assert.equal(quotaCalls, 2); assert.equal(children.length, 1);
    resolveQuota!(new Response('', { status: 503 }));
    await quotaRefresh;
    const failed = await promptly(service.select(id, accountIds[0]));
    assert.equal(failed.accounts[0].usage.status, 'error'); assert.equal(failed.accounts[0].usage.failureKind, 'server');
    assert.equal(failed.accounts[0].usage.stale, true); assert.equal(failed.accounts[0].usage.windows[0].usedPercent, 12);
    children[0].emit('close', 0);
    await defaultRefresh;
  } finally {
    resolveQuota?.(new Response('', { status: 503 }));
    for (const child of children) child.emit('close', 0);
    await Promise.allSettled([quotaRefresh, defaultRefresh]);
    await service.dispose(); closeConnection();
    if (oldDatabase === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = oldDatabase;
    await rm(directory, { recursive: true, force: true });
  }
});

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
    const local = await service.getState(id);
    assert.equal(local.defaultAccount?.needsSignIn, false);
    assert.equal(local.defaultAccount?.usage.failureKind, 'stale-token');
    assert.equal(children.length, 0); assert.equal(quotaCalls, 0);
    const statePending = service.refresh(id); await flush();
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
    await save(managedHome); const transient = service.refresh(id); await flush(); assert.equal(children.length, 3); children[2].child.emit('close', 0);
    const failedState = await transient; assert.equal(failedState.accounts[0].needsSignIn, false); assert.equal(failedState.accounts[0].usage.failureKind, 'stale-token');
    assert.equal(await readFile(path.join(managedHome, '.credentials.json'), 'utf8'), original);
    await service.getState(id); assert.equal(children.length, 3);
  } finally { await service.dispose(); closeConnection(); if (oldDatabase === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = oldDatabase; await rm(directory, { recursive: true, force: true }); }
});
