import assert from 'node:assert/strict';
import test from 'node:test';

import { AppError } from '@/shared/index.js';
import type { AuthSessionContext } from '@/shared/index.js';

import { createAuthService } from '../auth.service.js';
import { createLoginGuard } from '../login-guard.service.js';

type AuthDependencies = Parameters<typeof createAuthService>[0];
const alice = { id: 1, username: 'alice', password_hash: 'hash', auth_version: 0 };
const session: AuthSessionContext = { id: 'test-session', userId: 1, version: 0, createdAt: 1000, expiresAt: 2000 };
const hasCode = (code: string) => (error: unknown) => error instanceof AppError && error.code === code;
function dependencies(overrides: Partial<AuthDependencies> = {}): AuthDependencies {
  return {
    users: { getUserByUsername: () => undefined, updateLastLogin: () => undefined, updateProfile: () => undefined },
    comparePassword: async () => false, generateToken: () => 'signed-token',
    refreshToken: () => 'refreshed-token', revokeSession: () => undefined,
    issueWebSocketTicket: () => ({ ticket: 'fixture-ticket', expiresAt: 1000 }), ...overrides,
  };
}

test('unknown and inactive accounts consume one cost12 dummy comparison and never issue a token', async () => {
  for (const inactive of [false, true]) {
    const hashes: string[] = [];
    let tokens = 0;
    const service = createAuthService(dependencies({
      users: { getUserByUsername: () => inactive ? { ...alice, is_active: 0 } : undefined,
        updateLastLogin: () => undefined, updateProfile: () => undefined },
      comparePassword: async (_value, hash) => { hashes.push(hash); return true; },
      generateToken: () => { tokens += 1; return 'token'; },
    }));
    await assert.rejects(service.login('unknown-account', 'secret12'), hasCode('AUTH_INVALID_CREDENTIALS'));
    assert.equal(hashes.length, 1);
    assert.match(hashes[0]!, /^\$2b\$12\$/);
    assert.equal(tokens, 0);
  }
});

test('incorrect password and invalid input cannot create a session', async () => {
  let comparisons = 0;
  const service = createAuthService(dependencies({
    users: { getUserByUsername: () => alice, updateLastLogin: () => undefined, updateProfile: () => undefined },
    comparePassword: async () => { comparisons += 1; return false; },
    generateToken: () => { assert.fail('must not issue'); },
  }));
  await assert.rejects(service.login('alice', 'wrong-password'), hasCode('AUTH_INVALID_CREDENTIALS'));
  await assert.rejects(service.login('', 'secret'), hasCode('AUTH_CREDENTIALS_REQUIRED'));
  await assert.rejects(service.login('a'.repeat(129), 'secret'), hasCode('AUTH_CREDENTIALS_INVALID'));
  await assert.rejects(service.login('alice', '界'.repeat(25)), hasCode('AUTH_CREDENTIALS_INVALID'));
  assert.equal(comparisons, 1);
});

test('refresh keeps the authenticated context and logout revokes it before success', () => {
  const calls: string[] = [];
  const service = createAuthService(dependencies({
    generateToken: () => { assert.fail('refresh must not create another session'); },
    refreshToken: (user, actual) => { assert.equal(user.id, alice.id); assert.deepEqual(actual, session); calls.push('refresh'); return 'replacement'; },
    revokeSession: actual => { assert.deepEqual(actual, session); calls.push('revoke'); },
  }));
  assert.deepEqual(service.refreshSession(alice, session), { token: 'replacement' });
  assert.equal(service.logout(session).success, true);
  assert.deepEqual(calls, ['refresh', 'revoke']);
  assert.throws(() => service.refreshSession(alice), hasCode('AUTH_TOKEN_INVALID'));
  assert.throws(() => service.logout(), hasCode('AUTH_TOKEN_INVALID'));
});

test('successful login preserves the version/hash snapshot for atomic session publication', async () => {
  const service = createAuthService(dependencies({
    users: { getUserByUsername: () => alice, updateLastLogin: () => undefined, updateProfile: () => undefined },
    comparePassword: async () => true,
    generateToken: user => { assert.equal(user, alice); return 'token'; },
  }));
  assert.deepEqual(await service.login('alice', 'secret'), {
    success: true, user: { id: 1, username: 'alice', displayName: null, avatarDataUrl: null }, token: 'token',
  });
});

test('account and source budgets are independent and expire only with their window', async () => {
  let time = 100;
  const guard = createLoginGuard({ now: () => time, windowMs: 1000, accountLimit: 2, sourceLimit: 3 });
  const run = (name: string, source: string) => guard.run(name, source, async () => true);
  await run('alice', 'one'); await run('alice', 'two');
  await assert.rejects(run('alice', 'three'), hasCode('AUTH_LOGIN_RATE_LIMITED'));
  await run('bob', 'one'); await run('carol', 'one');
  await assert.rejects(run('dave', 'one'), hasCode('AUTH_LOGIN_RATE_LIMITED'));
  time = 1100;
  assert.equal(await run('alice', 'one'), true);
});

test('bcrypt admission has no waiting queue and releases capacity on rejection', async () => {
  const guard = createLoginGuard({ concurrency: 1 });
  let finish: (() => void) | undefined;
  const blocker = guard.run('one', 'source', () => new Promise<void>(resolve => { finish = resolve; }));
  await assert.rejects(guard.run('two', 'source', async () => true), hasCode('AUTH_LOGIN_BUSY'));
  assert.ok(finish); finish(); await blocker;
  await assert.rejects(guard.run('three', 'source', async () => { throw new Error('comparison failed'); }), /comparison failed/);
  assert.equal(await guard.run('four', 'source', async () => true), true);
});

test('random usernames cannot evict live account rate limits when key storage fills', async () => {
  let time = 0;
  const guard = createLoginGuard({ now: () => time, windowMs: 1000, maxKeys: 2, accountLimit: 1 });
  await guard.run('alice', 'source', async () => true);
  await assert.rejects(guard.run('random', 'other', async () => true), hasCode('AUTH_LOGIN_RATE_LIMITED'));
  await assert.rejects(guard.run('alice', 'source', async () => true), hasCode('AUTH_LOGIN_RATE_LIMITED'));
  time = 1000;
  assert.equal(await guard.run('random', 'other', async () => true), true);
});
