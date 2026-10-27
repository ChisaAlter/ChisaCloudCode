import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';
import type { Options } from '@anthropic-ai/claude-agent-sdk';

import { claudeAccountsDb, closeConnection, getConnection, initializeDatabase, userDb } from '@/modules/database/index.js';
import { createClaudeAccountsRouter } from '@/modules/providers/claude-accounts.routes.js';
import { ClaudeAccountsService } from '@/modules/providers/services/claude-accounts.service.js';
import { ClaudeAccountProfiles } from '@/modules/providers/services/claude-accounts-profiles.service.js';
import { ClaudeAccountLoginService } from '@/modules/providers/services/claude-accounts-login.service.js';
import { ClaudeAccountQuotaService } from '@/modules/providers/services/claude-accounts-quota.service.js';
import { ClaudeAccountRenewalService } from '@/modules/providers/services/claude-accounts-renewal.service.js';
import type { ClaudeAccountCredentialRead, ClaudeAccountLoginTask, ClaudeAccountsState } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

class FakeLogin extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = undefined;
  killed = false;
  kill() { this.killed = true; queueMicrotask(() => this.emit('close', null)); return true; }
  asChild() { return this as unknown as ChildProcess; }
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const manualUrl = 'https://claude.ai/oauth/authorize?client_id=fixture&code=true&redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcode%2Fcallback&state=fixture';
const credentials = (now: number, patch: Partial<ClaudeAccountCredentialRead> = {}): ClaudeAccountCredentialRead => ({ accessToken: 'fixture-only-access', expiresAt: now + 60_000, refreshable: true, email: 'fixture@example.test', organizationUuid: 'fixture-org', organizationName: 'Fixture', plan: 'max', tier: 'fixture', unavailable: false, ...patch });

async function writeLogin(home: string, now: number, email: string) {
  await writeFile(path.join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-access-never-real', expiresAt: now + 3_600_000, refreshToken: 'fixture-refresh-never-real', subscriptionType: 'max' } }));
  await writeFile(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: email, organizationUuid: 'fixture-org', organizationName: 'Fixture organization' } }));
}

test('subscription ownership, CLI login, leases, switching and routes use only the caller identity', async () => {
  const oldDatabase = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chisa-subscription-'));
  const home = path.join(directory, 'user-home');
  const database = path.join(directory, 'auth.db');
  let now = Date.now();
  closeConnection();
  process.env.DATABASE_PATH = database;
  await writeFile(database, '');
  await mkdir(path.join(home, '.claude'), { recursive: true });
  await initializeDatabase();
  const first = Number(userDb.createUser('subscription-first', 'fixture').id);
  const profileEnv: NodeJS.ProcessEnv = {};
  const profiles = new ClaudeAccountProfiles({ databasePath: () => database, home: () => home, env: () => profileEnv });
  await writeLogin(path.join(home, '.claude'), now, 'global-default@example.test');
  const children: Array<{ child: FakeLogin; args: string[]; options: SpawnOptions }> = [];
  let fetchCount = 0;
  const service = new ClaudeAccountsService({ profiles, now: () => now, renewal: new ClaudeAccountRenewalService({ resolveExecutable: () => undefined }),
    quota: new ClaudeAccountQuotaService({ now: () => now, fetch: (async () => { fetchCount++; return new globalThis.Response(JSON.stringify({ five_hour: { utilization: 42, resets_at: now + 3_600_000 }, seven_day: { utilization: 17, resets_at: now + 86_400_000 } })); }) as typeof fetch }),
    login: { env: () => ({ PATH: 'fixture-path', ANTHROPIC_API_KEY: 'inherited-secret' }), resolveExecutable: () => 'fixture-claude', spawn: (_command, args, options) => { const child = new FakeLogin(); children.push({ child, args, options }); return child.asChild(); } },
  });
  const app = express().use(express.json()).use((req, _res, next) => { if (req.headers['x-test-user']) Object.assign(req, { user: { id: Number(req.headers['x-test-user']) } }); next(); })
    .use('/api/providers/claude/accounts', createClaudeAccountsRouter(service));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => { if (error instanceof AppError) res.status(error.statusCode).json({ success: false, error: { code: error.code, message: error.message } }); else res.status(500).json({ success: false }); });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/providers/claude/accounts`;
  const request = (method: string, suffix = '', body?: unknown, user = first) => fetch(url + suffix, { method, headers: { 'x-test-user': String(user), 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = async <T>(response: globalThis.Response) => (await response.json() as { data: T }).data;
  try {
    assert.equal((await fetch(url)).status, 401);
    const single = await service.getState(first);
    assert.equal(single.defaultAccount?.email, 'global-default@example.test');
    assert.equal(single.defaultAccount?.usage.windows.length, 2);
    const defaultLease = service.captureLaunch(first);
    assert.equal(defaultLease?.accountId, 'default'); defaultLease?.release(); defaultLease?.release();
    profileEnv.CLAUDE_CODE_OAUTH_TOKEN = 'fixture-env-only-oauth';
    assert.equal((await service.readSubscription(first))?.accessToken, 'fixture-env-only-oauth');
    assert.equal((await service.readSubscription(first))?.expiresAt, null);
    profileEnv.ANTHROPIC_API_KEY = 'fixture-env-api';
    assert.equal((await service.getState(first)).route.kind, 'api');
    delete profileEnv.CLAUDE_CODE_OAUTH_TOKEN;
    // API-only legacy users remain connected even with no OAuth credential file.
    await rm(path.join(home, '.claude', '.credentials.json'));
    assert.deepEqual(await service.getSelectedAuthStatus(first), { authenticated: true, email: null, method: 'api_key' });
    delete profileEnv.ANTHROPIC_API_KEY;
    profileEnv.CLAUDE_CODE_USE_BEDROCK = '1';
    assert.deepEqual(await service.getSelectedAuthStatus(first), { authenticated: true, email: null, method: 'api_key' });
    delete profileEnv.CLAUDE_CODE_USE_BEDROCK;
    assert.equal((await service.getSelectedAuthStatus(first))?.authenticated, false);
    await writeLogin(path.join(home, '.claude'), now, 'global-default@example.test');

    const second = Number(userDb.createUser('subscription-second', 'fixture').id);
    profileEnv.ANTHROPIC_API_KEY = 'fixture-shared-api';
    assert.equal((await service.getSelectedAuthStatus(first))?.authenticated, false);
    assert.equal((await service.getSelectedAuthStatus(second))?.authenticated, false);
    delete profileEnv.ANTHROPIC_API_KEY;
    assert.equal((await service.getState(first)).defaultAccount, null);
    assert.equal((await service.getState(second)).defaultAccount, null);
    assert.equal(service.captureLaunch(first), null);
    assert.equal(await service.readSubscription(second), null);
    assert.equal(service.captureLaunch(undefined), null);
    const baseCount = fetchCount;
    for (const bad of [{ userId: second }, { accountId: '../bad' }, { name: '' }, { name: 'bad\nname' }]) assert.equal((await request('POST', '/login', bad)).status, 400);
    const task = await data<ClaudeAccountLoginTask>(await request('POST', '/login', { name: 'Work' }));
    assert.equal(task.status, 'starting');
    assert.deepEqual(children[0].args, ['auth', 'login', '--claudeai']);
    assert.equal(children[0].options.env?.ANTHROPIC_API_KEY, '');
    assert.equal(children[0].options.env?.CLAUDE_CONFIG_DIR, children[0].options.env?.CLAUDE_SECURESTORAGE_CONFIG_DIR);
    assert.equal((await request('GET', `/login/${task.id}`, undefined, second)).status, 404);
    children[0].child.stdout.write('https://evil.example/authorize?code=true&redirect_uri=https://evil.example/callback\n');
    assert.equal(service.getLogin(first, task.id).url, null);
    // A split URL must not be emitted before the terminating whitespace arrives.
    children[0].child.stdout.write(manualUrl.slice(0, 60));
    children[0].child.stdout.write(manualUrl.slice(60));
    assert.equal(service.getLogin(first, task.id).url, null);
    children[0].child.stdout.write('\n');
    assert.equal(service.getLogin(first, task.id).url, manualUrl);
    for (const bad of [{ code: '' }, { code: 'bad<code' }, { code: 'fixture-code', unexpected: true }]) {
      const response = await request('POST', `/login/${task.id}/code`, bad);
      assert.equal(response.status, 400);
      const failure = await response.json() as { error: { code: string; message: string } };
      assert.equal(failure.error.code, 'CLAUDE_LOGIN_CODE_INVALID');
      assert.notEqual(failure.error.message, 'Invalid Claude account request.');
      assert.equal(service.getLogin(first, task.id).status, 'waiting_code');
      assert.equal(children[0].child.stdin.read(), null);
    }
    const completing = await data<ClaudeAccountLoginTask>(await request('POST', `/login/${task.id}/code`, { code: '  fixture-\ncode\u200b #\r\nfixture  ' }));
    assert.equal(completing.status, 'completing');
    assert.equal(children[0].child.stdin.read()?.toString(), 'fixture-code#fixture\n');
    const profile = String(children[0].options.cwd);
    await writeLogin(profile, now, 'managed@example.test');
    children[0].child.emit('close', 0);
    await flush();
    assert.equal(service.getLogin(first, task.id).status, 'succeeded');
    assert.equal(claudeAccountsDb.activeId(first), null);
    assert.equal(claudeAccountsDb.list(first).length, 1);
    assert.equal(claudeAccountsDb.list(second).length, 0);
    assert.equal((await request('PUT', '/active', { id: task.accountId }, second)).status, 404);
    assert.equal((await request('PUT', '/active', { id: task.accountId, userId: second })).status, 400);
    const selected = await data<ClaudeAccountsState>(await request('PUT', '/active', { id: task.accountId }));
    assert.equal(selected.route.kind, 'subscription');
    assert.equal(selected.activeId, task.accountId);
    assert.equal(selected.accounts[0].usage.windows[0].usedPercent, 42);
    assert.equal(fetchCount, baseCount + 1);
    await service.getState(first);
    assert.equal(fetchCount, baseCount + 1);
    assert.equal(JSON.stringify(selected).includes('fixture-access-never-real'), false);
    assert.equal(JSON.stringify(selected).includes(profile), false);
    const lease = service.captureLaunch(first)!;
    const sdkOptions: Options = { env: { PATH: 'kept', ANTHROPIC_API_KEY: 'poison', ANTHROPIC_BASE_URL: 'https://poison' }, settings: { apiKeyHelper: 'poison', env: { CLAUDE_CODE_OAUTH_TOKEN: 'poison' }, permissions: { allow: ['Read'] } }, resume: 'same-conversation' };
    service.applyToOptions(sdkOptions, lease);
    assert.equal(sdkOptions.env?.ANTHROPIC_API_KEY, '');
    assert.equal(sdkOptions.env?.ANTHROPIC_BASE_URL, '');
    assert.equal(sdkOptions.env?.CLAUDE_SECURESTORAGE_CONFIG_DIR, profile);
    assert.equal(sdkOptions.env?.PATH, 'kept');
    assert.equal(sdkOptions.resume, 'same-conversation');
    assert.equal(typeof sdkOptions.settings === 'object' && sdkOptions.settings.env?.CLAUDE_CODE_OAUTH_TOKEN, '');
    await assert.rejects(service.remove(first, task.accountId), (error: unknown) => error instanceof AppError && error.statusCode === 409);
    await assert.rejects(service.startLogin(first, { accountId: task.accountId }), (error: unknown) => error instanceof AppError && error.statusCode === 409);
    await assert.rejects(service.select(first, null), (error: unknown) => error instanceof AppError && error.code === 'CLAUDE_DEFAULT_ACCOUNT_UNAVAILABLE');
    const nextTask = await service.startLogin(first, { name: 'Next subscription' });
    await writeLogin(String(children.at(-1)!.options.cwd), now, 'next-managed@example.test');
    children.at(-1)!.child.emit('close', 0);
    await flush();
    await service.select(first, nextTask.accountId);
    assert.equal(lease.accountId, task.accountId);
    assert.equal((await service.readSubscription(first, lease))?.accountId, task.accountId);
    lease.release(); lease.release();
    await service.rename(first, task.accountId, 'Renamed');
    const shared = path.join(directory, 'shared-history'); await mkdir(shared); await writeFile(path.join(shared, 'keep.txt'), 'keep');
    await symlink(shared, path.join(profile, 'projects'), process.platform === 'win32' ? 'junction' : 'dir');
    await service.remove(first, task.accountId);
    assert.equal(await readFile(path.join(shared, 'keep.txt'), 'utf8'), 'keep');
    await service.remove(first, nextTask.accountId);
    assert.equal(claudeAccountsDb.list(first).length, 0);

    const cancelled = await service.startLogin(first, { name: 'Cancel' });
    const cancelChild = children.at(-1)!.child;
    await service.cancelLogin(first, cancelled.id);
    assert.equal(cancelChild.killed, true);
    assert.equal(service.getLogin(first, cancelled.id).status, 'cancelled');
    await assert.rejects(readFile(path.join(String(children.at(-1)!.options.cwd), '.credentials.json')));
    const row = getConnection().prepare('SELECT COUNT(*) AS count FROM claude_subscription_accounts').get() as { count: number };
    assert.equal(row.count, 0);
  } finally {
    await service.dispose();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    closeConnection();
    if (oldDatabase === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = oldDatabase;
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('quota supports both response families, coalesces refresh, honors cooldown and invalidates reset/stale data', async () => {
  let now = 2_000_000_000_000;
  let mode = 'ok';
  let calls = 0;
  let current = credentials(now, { expiresAt: now + 10_000_000 });
  let resolveResponse: ((response: globalThis.Response) => void) | null = null;
  const quota = new ClaudeAccountQuotaService({ now: () => now, fetch: (async () => {
    calls++;
    if (mode === 'pending') return new Promise<globalThis.Response>(resolve => { resolveResponse = resolve; });
    if (mode === 'limited') return new globalThis.Response('', { status: 429, headers: { 'retry-after': '120' } });
    return new globalThis.Response(JSON.stringify({ five_hour: { utilization: 42, resets_at: now + 100_000 }, limits: [{ kind: 'weekly_all', percent: 17, resets_at: now + 1_000_000 }] }));
  }) as typeof fetch });
  const read = () => current;
  const first = await quota.read('1:server:a', read);
  assert.deepEqual(first.windows.map(window => window.usedPercent), [42, 17]);
  assert.equal(first.status, 'ok');
  assert.equal((await quota.read('1:server:a', read)).status, 'ok'); assert.equal(calls, 1);
  mode = 'limited';
  const limited = await quota.read('1:server:a', read, true);
  assert.equal(limited.status, 'error'); assert.equal(limited.stale, true); assert.equal(limited.windows.length, 2);
  assert.equal(limited.retryAt, now + 120_000);
  await quota.read('1:server:a', read, true); assert.equal(calls, 2);
  now += 130_000;
  const reset = await quota.read('1:server:a', read, true);
  assert.equal(reset.windows.length, 1);
  assert.equal(reset.windows[0].kind, 'weekly_all');
  current = credentials(now, { expiresAt: now - 1, refreshable: true });
  const expired = await quota.read('1:server:b', read);
  assert.equal(expired.failureKind, 'stale-token'); assert.equal(expired.status, 'error');
  assert.equal(calls, 3);
  current = credentials(now);
  mode = 'pending';
  const p1 = quota.read('1:server:c', read, true);
  const p2 = quota.read('1:server:c', read, true);
  await flush(); assert.equal(calls, 4);
  quota.evict('1:server:c');
  const resolve = resolveResponse as unknown as (response: globalThis.Response) => void;
  resolve(new globalThis.Response(JSON.stringify({ limits: [{ kind: 'session', percent: 99 }] })));
  const [stale1, stale2] = await Promise.all([p1, p2]);
  assert.equal(stale1.failureKind, 'account-changed'); assert.equal(stale2.windows.length, 0);
  const changed = quota.read('1:server:d', read, true);
  await flush();
  current = { ...current, accessToken: 'new-fixture-account-token' };
  const changedResolve = resolveResponse as unknown as (response: globalThis.Response) => void;
  changedResolve(new globalThis.Response(JSON.stringify({ five_hour: { utilization: 88 } })));
  assert.equal((await changed).failureKind, 'account-changed');
});

test('CLI login teardown handles errors, superseded attempts and expiry without accepting late success', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chisa-login-teardown-'));
  const children: FakeLogin[] = [];
  let successes = 0;
  let abandoned = 0;
  const login = new ClaudeAccountLoginService({ assertHome: () => directory, onSuccess: () => { successes++; }, onAbandon: () => { abandoned++; },
    timeoutMs: 60, resolveExecutable: () => 'fixture-claude', env: () => ({}), spawn: () => { const child = new FakeLogin(); children.push(child); return child.asChild(); } });
  const input = { userId: 1, accountId: 'fixture', name: 'Fixture', home: directory, newAccount: true };
  try {
    const failed = await login.start(input);
    children[0].emit('error', new Error('raw diagnostic contains fixture-secret'));
    await flush();
    assert.equal(children[0].killed, true);
    assert.equal(login.get(1, failed.id).status, 'failed');
    assert.equal(JSON.stringify(login.get(1, failed.id)).includes('fixture-secret'), false);
    const cancelled = await login.start(input);
    const current = await login.start(input);
    assert.equal(children[1].killed, true);
    assert.equal(login.get(1, cancelled.id).status, 'cancelled');
    children[1].emit('close', 0);
    assert.equal(successes, 0);
    await once(children[2], 'close');
    assert.equal(children[2].killed, true);
    assert.equal(login.get(1, current.id).status, 'failed');
    assert.match(login.get(1, current.id).error ?? '', /超时/);
    assert.equal(successes, 0);
    assert.equal(abandoned, 3);
  } finally { await login.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('CLI 2.1.303 manual authorization accepts the current Claude platform URL and rejects lookalikes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chisa-login-current-url-'));
  const children: FakeLogin[] = [];
  const login = new ClaudeAccountLoginService({ assertHome: () => directory, onSuccess() {}, onAbandon() {},
    resolveExecutable: () => 'fixture-claude', env: () => ({}), spawn: () => { const child = new FakeLogin(); children.push(child); return child.asChild(); } });
  const input = { userId: 1, accountId: 'fixture', name: 'Fixture', home: directory, newAccount: true };
  const currentUrl = 'https://claude.com/cai/oauth/authorize?code=true&client_id=fixture&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=fixture';
  try {
    for (const unsafe of [currentUrl.replace('https://claude.com/', 'https://claude.com.evil.test/'), currentUrl.replace('platform.claude.com', 'platform.claude.com.evil.test'), currentUrl.replace('code=true', 'code=false')]) {
      const task = await login.start(input);
      children.at(-1)!.stdout.write(`If the browser didn't open, visit: ${unsafe}\nPaste code here if prompted > `);
      assert.equal(login.get(1, task.id).status, 'starting');
      assert.equal(login.get(1, task.id).url, null);
    }
    const task = await login.start(input);
    const child = children.at(-1)!;
    const split = currentUrl.indexOf('redirect_uri=') + 20;
    child.stdout.write(`Opening browser to sign in…\nIf the browser didn't open, visit: ${currentUrl.slice(0, split)}`);
    assert.equal(login.get(1, task.id).url, null);
    child.stdout.write(`${currentUrl.slice(split)}\nPaste code here if prompted > `);
    assert.equal(login.get(1, task.id).status, 'waiting_code');
    assert.equal(login.get(1, task.id).url, currentUrl);
  } finally { await login.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('authorization URL scanning separates streams and handles chunked OSC hyperlinks without state corruption', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chisa-login-output-'));
  const children: FakeLogin[] = [];
  const login = new ClaudeAccountLoginService({ assertHome: () => directory, onSuccess() {}, onAbandon() {},
    resolveExecutable: () => 'fixture-claude', env: () => ({}), spawn: () => { const child = new FakeLogin(); children.push(child); return child.asChild(); } });
  const input = { userId: 1, accountId: 'fixture', name: 'Fixture', home: directory, newAccount: true };
  const url = manualUrl.replace('state=fixture', 'state=fixture_base64url_state_A-1');
  try {
    const task = await login.start(input);
    const child = children.at(-1)!;
    child.stdout.write(url.slice(0, -7));
    child.stderr.write('\nfixture diagnostic\n');
    assert.equal(login.get(1, task.id).url, null);
    child.stdout.write(`${url.slice(-7)}\n`);
    assert.equal(login.get(1, task.id).url, url);
    for (const terminator of ['\u0007', '\u001b\\']) {
      const linked = `\u001b]8;;${url}${terminator}${url}\u001b]8;;${terminator}\n`;
      for (const split of [1, 3, url.length, linked.length - 3, linked.length - 1]) {
        const next = await login.start(input);
        const process = children.at(-1)!;
        process.stdout.write(linked.slice(0, split));
        process.stdout.write(linked.slice(split));
        assert.equal(login.get(1, next.id).url, url, `OSC ending ${JSON.stringify(terminator)}, split ${split}`);
      }
    }
    const punctuation = await login.start(input);
    children.at(-1)!.stdout.write(`Visit (${url})\n`);
    assert.equal(login.get(1, punctuation.id).url, url);
  } finally { await login.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('manual code submission completes plain codes with task state and remains retryable after CLI input rejection', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chisa-login-manual-code-'));
  const child = new FakeLogin();
  const login = new ClaudeAccountLoginService({ assertHome: () => directory, onSuccess() {}, onAbandon() {},
    resolveExecutable: () => 'fixture-claude', env: () => ({}), spawn: () => child.asChild() });
  const input = { userId: 1, accountId: 'fixture', name: 'Fixture', home: directory, newAccount: true };
  try {
    const task = await login.start(input);
    child.stdout.write(`${manualUrl}\nPaste code here if prompted > `);
    for (const code of ['#fixture', 'code#', 'code#fixture#extra', 'bad\u0000code']) {
      assert.throws(() => login.submitCode(1, task.id, code), (error: unknown) => error instanceof AppError && error.statusCode === 400);
      assert.equal(login.get(1, task.id).status, 'waiting_code');
      assert.equal(child.stdin.read(), null);
    }
    assert.equal(login.submitCode(1, task.id, '  fixture-\ncode\u200b  ').status, 'completing');
    assert.equal(child.stdin.read()?.toString(), 'fixture-code#fixture\n');
    child.stderr.write('Invalid code. Please make sure the full code was copied.\n');
    assert.equal(login.get(1, task.id).status, 'waiting_code');
    assert.match(login.get(1, task.id).error ?? '', /重新复制/);
    // The official CLI's manual callback accepts an opaque suffix and uses its own saved state/PKCE at exchange.
    assert.equal(login.submitCode(1, task.id, 'retry-code#opaque-browser-suffix').status, 'completing');
    assert.equal(login.get(1, task.id).error, null);
    assert.equal(child.stdin.read()?.toString(), 'retry-code#opaque-browser-suffix\n');
    assert.equal(JSON.stringify(login.get(1, task.id)).includes('retry-code'), false);
  } finally { await login.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('parent links and owner marker tampering cannot create or delete another account folder', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chisa-profile-path-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'chisa-profile-outside-'));
  const profiles = new ClaudeAccountProfiles({ databasePath: () => path.join(directory, 'auth.db') });
  const id = '11111111-1111-4111-8111-111111111111';
  try {
    await mkdir(path.join(directory, 'claude-accounts'));
    await symlink(outside, path.join(directory, 'claude-accounts', 'users'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => profiles.create(1, id), (error: unknown) => error instanceof AppError && error.code === 'CLAUDE_ACCOUNT_PROFILE_UNSAFE');
    await rm(path.join(directory, 'claude-accounts', 'users'));
    const home = profiles.create(1, id);
    await writeFile(path.join(path.dirname(home), 'owner.json'), JSON.stringify({ version: 1, userId: 2, accountId: id }));
    assert.throws(() => profiles.remove(1, id), (error: unknown) => error instanceof AppError && error.code === 'CLAUDE_ACCOUNT_PROFILE_UNSAFE');
    await assert.rejects(readFile(path.join(outside, '1', 'profiles', id, 'owner.json')));
  } finally { await rm(directory, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
