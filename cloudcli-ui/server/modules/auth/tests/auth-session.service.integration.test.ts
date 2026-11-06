import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { authSessionsDb, closeConnection, getConnection, initializeDatabase, userDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/index.js';
import { createAuthSessionService } from '../auth-session.service.js';

const secret = 'isolated-auth-session-test-signing-key';
const hasCode = (code: string) => (error: unknown) => error instanceof AppError && error.code === code;
function signed(payload: Record<string, unknown>, algorithm = 'HS256', key = secret) {
  const encoded = `${Buffer.from(JSON.stringify({ alg: algorithm, typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  const signature = algorithm === 'none' ? '' : createHmac(algorithm === 'HS384' ? 'sha384' : 'sha256', key).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}
function claims(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
}
async function fixture(run: (context: {
  service: ReturnType<typeof createAuthSessionService>; user: NonNullable<ReturnType<typeof userDb.getUserByUsername>>;
  time: { value: number }; policy: { cutoff?: string };
}) => Promise<void> | void) {
  const previous = process.env.DATABASE_PATH;
  const root = await mkdtemp(path.join(tmpdir(), 'auth-session-verification-'));
  closeConnection(); process.env.DATABASE_PATH = path.join(root, 'auth.db');
  try {
    await writeFile(process.env.DATABASE_PATH, '');
    await initializeDatabase();
    userDb.createUser('alice', 'hash');
    const user = userDb.getUserByUsername('alice'); assert.ok(user);
    const time = { value: 1800000000 }; const policy: { cutoff?: string } = {};
    const service = createAuthSessionService({ sessions: authSessionsDb, users: userDb, secret: () => secret,
      now: () => time.value, legacyCutoff: () => policy.cutoff });
    await run({ service, user, time, policy });
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
}

test('canonical JWT requires exact identity/algorithm/issuer/audience and bounded integer claims', async () => {
  await fixture(({ service, user, time }) => {
    const token = service.generateToken(user); const original = claims(token);
    assert.equal(service.verifyAuthToken(token).user.id, user.id);
    for (const name of ['sub', 'userId', 'username', 'sid', 'sv', 'iat', 'exp', 'iss', 'aud']) {
      const missing = { ...original }; delete missing[name];
      assert.throws(() => service.verifyAuthToken(signed(missing)), hasCode('AUTH_TOKEN_INVALID'), name);
    }
    for (const mutation of [
      { iss: 'other-service' }, { aud: 'other-client' }, { aud: ['chisa-ui'] }, { sub: '2' },
      { userId: '1' }, { userId: 0 }, { userId: 1.2 }, { username: '' }, { username: 5 },
      { sid: 'unknown' }, { sid: '11111111-1111-1111-1111-111111111111' }, { sv: -1 }, { sv: 1 },
      { iat: time.value + 1 }, { iat: time.value - 1 }, { iat: 1.5 }, { exp: time.value + 8 * 86400 },
      { exp: Number(original.exp) - 1 }, { nbf: time.value + 100 },
    ]) assert.throws(() => service.verifyAuthToken(signed({ ...original, ...mutation })), hasCode('AUTH_TOKEN_INVALID'));
    for (const invalid of [signed(original, 'none'), signed(original, 'HS384'), signed(original, 'HS256', 'different'),
      'not-a-token', '', null, ['token'], 'x'.repeat(8193)]) {
      assert.throws(() => service.verifyAuthToken(invalid), hasCode('AUTH_TOKEN_INVALID'));
    }
    // Username is descriptive: identity and returned profile come from userId + the live DB.
    assert.equal(service.verifyAuthToken(signed({ ...original, username: 'not-the-owner' })).user.username, 'alice');
    const expired = { ...original, iat: time.value - 100, exp: time.value };
    assert.throws(() => service.verifyAuthToken(signed(expired)), hasCode('AUTH_TOKEN_EXPIRED'));
  });
});

test('refresh preserves sid/absolute lifetime and persistent logout rejects all token generations', async () => {
  await fixture(({ service, user, time }) => {
    const token = service.generateToken(user); const first = service.verifyAuthToken(token);
    time.value += 100;
    const refreshed = service.refreshToken(first.user, first.session); const next = service.verifyAuthToken(refreshed);
    assert.equal(next.session.id, first.session.id); assert.equal(next.session.expiresAt, first.session.expiresAt);
    assert.equal(Number(claims(refreshed).iat), time.value);
    assert.equal(service.isAuthSessionActive(first.session.id, user.id, first.session.version), true);
    assert.throws(() => service.refreshToken({ ...user, id: 999 }, first.session), hasCode('AUTH_TOKEN_INVALID'));
    service.revokeSession(first.session); closeConnection();
    for (const candidate of [token, refreshed]) assert.throws(() => service.verifyAuthToken(candidate), hasCode('AUTH_TOKEN_INVALID'));
    assert.throws(() => service.refreshToken(user, first.session), hasCode('AUTH_TOKEN_INVALID'));
    assert.equal(service.isAuthSessionActive(first.session.id, user.id, first.session.version), false);
    const fresh = service.generateToken(user); assert.notEqual(claims(fresh).sid, first.session.id);
    time.value = Number(claims(fresh).exp);
    assert.throws(() => service.verifyAuthToken(fresh), hasCode('AUTH_TOKEN_EXPIRED'));
  });
});

test('password race, version mismatch, wrong session owner and deactivation all fail closed', async () => {
  await fixture(({ service, user }) => {
    const token = service.generateToken(user); const context = service.verifyAuthToken(token).session;
    userDb.createUser('bob', 'bob-hash'); const bob = userDb.getUserByUsername('bob'); assert.ok(bob);
    assert.throws(() => service.verifyAuthToken(signed({ ...claims(token), userId: bob.id, sub: String(bob.id) })), hasCode('AUTH_TOKEN_INVALID'));
    getConnection().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run('updated-hash', user.id);
    assert.throws(() => service.generateToken(user), hasCode('AUTH_TOKEN_INVALID'));
    assert.throws(() => service.verifyAuthToken(token), hasCode('AUTH_TOKEN_INVALID'));
    assert.equal(service.isAuthSessionActive(context.id, user.id, 0), false);
    const changed = userDb.getUserByUsername('alice'); assert.ok(changed);
    const fresh = service.generateToken(changed);
    getConnection().prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(user.id);
    assert.throws(() => service.verifyAuthToken(fresh), hasCode('AUTH_TOKEN_INVALID'));
    getConnection().prepare('UPDATE users SET is_active = 1 WHERE id = ?').run(user.id);
    assert.throws(() => service.verifyAuthToken(fresh), hasCode('AUTH_TOKEN_INVALID'));
  });
});

test('legacy tokens default closed; opt-in keeps one persistent sid and cannot resurrect a tombstone', async () => {
  await fixture(({ service, user, time, policy }) => {
    const legacy = signed({ userId: user.id, username: user.username, iat: time.value - 100, exp: time.value + 1000 });
    assert.throws(() => service.verifyAuthToken(legacy), hasCode('AUTH_TOKEN_INVALID'));
    policy.cutoff = new Date((time.value + 500) * 1000).toISOString();
    const first = service.verifyAuthToken(legacy);
    assert.match(first.session.id, /^legacy-[a-f0-9]{64}$/);
    assert.equal(first.session.expiresAt, time.value + 500);
    const converted = service.refreshToken(first.user, first.session);
    assert.equal(claims(converted).sid, first.session.id);
    assert.equal(claims(converted).iss, 'chisa-cloud-code');
    closeConnection(); policy.cutoff = new Date((time.value + 2000) * 1000).toISOString();
    assert.equal(service.verifyAuthToken(legacy).session.id, first.session.id);
    assert.equal(service.verifyAuthToken(converted).session.expiresAt, first.session.expiresAt);
    service.revokeSession(first.session); closeConnection();
    for (const token of [legacy, converted]) assert.throws(() => service.verifyAuthToken(token), hasCode('AUTH_TOKEN_INVALID'));
    assert.equal(authSessionsDb.getSession(first.session.id)?.revokedAt, time.value);
  });
});

test('legacy policy rejects new/extra claims and caps canonical refresh plus existing WS sessions', async () => {
  await fixture(({ service, user, time, policy }) => {
    const originalTime = time.value;
    const legacyClaims = { userId: user.id, username: user.username, iat: originalTime - 10, exp: originalTime + 3000 };
    policy.cutoff = new Date((time.value + 1000) * 1000).toISOString();
    const first = service.verifyAuthToken(signed(legacyClaims));
    const converted = service.refreshToken(first.user, first.session);
    for (const mutation of [{ iat: originalTime + 1 }, { iss: 'chisa-cloud-code' }, { exp: originalTime + 8 * 86400 }]) {
      time.value = originalTime + 2;
      assert.throws(() => service.verifyAuthToken(signed({ ...legacyClaims, ...mutation })), hasCode('AUTH_TOKEN_INVALID'));
    }
    policy.cutoff = new Date((originalTime + 500) * 1000).toISOString();
    assert.throws(() => service.verifyAuthToken(converted), hasCode('AUTH_TOKEN_INVALID'));
    assert.equal(service.isAuthSessionActive(first.session.id, user.id, 0), false);
    // Shortening to a past deadline must persist, even if configuration later tries to reopen it.
    policy.cutoff = new Date((originalTime + 1) * 1000).toISOString();
    assert.throws(() => service.verifyAuthToken(signed(legacyClaims)), hasCode('AUTH_TOKEN_INVALID'));
    closeConnection(); policy.cutoff = new Date((originalTime + 2000) * 1000).toISOString();
    assert.throws(() => service.verifyAuthToken(signed(legacyClaims)), hasCode('AUTH_TOKEN_INVALID'));
  });
});

test('legacy malformed/unbounded policy and post-password-change first adoption are rejected', async () => {
  await fixture(({ service, user, time, policy }) => {
    const legacy = signed({ userId: user.id, username: user.username, iat: time.value - 10, exp: time.value + 1000 });
    for (const cutoff of ['tomorrow', '2027-01-01T00:00:00', new Date((time.value + 8 * 86400) * 1000).toISOString()]) {
      policy.cutoff = cutoff; assert.throws(() => service.verifyAuthToken(legacy), hasCode('AUTH_TOKEN_INVALID'));
    }
    policy.cutoff = new Date((time.value + 500) * 1000).toISOString();
    getConnection().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run('changed', user.id);
    assert.throws(() => service.verifyAuthToken(legacy), hasCode('AUTH_TOKEN_INVALID'));
  });
});

test('secret and session storage outages propagate as operational errors instead of credential rejection', async () => {
  await fixture(({ service, user, time }) => {
    const token = service.generateToken(user); const failure = new Error('sqlite unavailable');
    const brokenSecret = createAuthSessionService({ sessions: authSessionsDb, users: userDb, secret: () => { throw failure; }, now: () => time.value });
    assert.throws(() => brokenSecret.verifyAuthToken(token), error => error === failure);
    const brokenSessions = createAuthSessionService({ sessions: { ...authSessionsDb, getSession: () => { throw failure; } },
      users: userDb, secret: () => secret, now: () => time.value });
    assert.throws(() => brokenSessions.verifyAuthToken(token), error => error === failure);
    assert.equal(brokenSessions.isAuthSessionActive(claims(token).sid, user.id, 0), false);
  });
});
