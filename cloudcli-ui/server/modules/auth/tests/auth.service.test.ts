import assert from 'node:assert/strict';
import test from 'node:test';

import { AppError } from '@/shared/index.js';

import { createAuthService } from '../auth.service.js';

type AuthDependencies = Parameters<typeof createAuthService>[0];

function createDependencies(overrides: Partial<AuthDependencies> = {}): AuthDependencies {
  return {
    users: {
      getUserByUsername: () => undefined,
      updateLastLogin: () => undefined,
      updateProfile: () => undefined,
    },
    comparePassword: async () => false,
    generateToken: () => 'signed-token',
    ...overrides,
  };
}

test('login rejects an unknown account without comparing a password or issuing a token', async () => {
  const operations: string[] = [];
  const service = createAuthService(createDependencies({
    comparePassword: async () => {
      operations.push('compare');
      return true;
    },
    generateToken: () => {
      operations.push('token');
      return 'token';
    },
  }));

  await assert.rejects(
    service.login('unknown-account', 'secret12'),
    (error: unknown) => error instanceof AppError && error.code === 'AUTH_INVALID_CREDENTIALS',
  );
  assert.deepEqual(operations, []);
});

test('login rejects an invalid password without issuing a token', async () => {
  let tokenIssued = false;
  const service = createAuthService(createDependencies({
    users: {
      getUserByUsername: () => ({ id: 1, username: 'alice', password_hash: 'hash' }),
      updateLastLogin: () => undefined,
      updateProfile: () => undefined,
    },
    comparePassword: async () => false,
    generateToken: () => {
      tokenIssued = true;
      return 'token';
    },
  }));

  await assert.rejects(
    service.login('alice', 'wrong-password'),
    (error: unknown) => error instanceof AppError && error.code === 'AUTH_INVALID_CREDENTIALS',
  );
  assert.equal(tokenIssued, false);
});

test('refreshSession issues a replacement token for the authenticated user', () => {
  let tokenUser: { id: number | bigint; username: string } | undefined;
  const service = createAuthService(createDependencies({
    generateToken: (user) => {
      tokenUser = user;
      return 'replacement-token';
    },
  }));

  const result = service.refreshSession({ id: 7, username: 'alice' });

  assert.deepEqual(result, { token: 'replacement-token' });
  assert.deepEqual(tokenUser, { id: 7, username: 'alice' });
});
