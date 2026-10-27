import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveClaudeUsagePluginScope } from '@/modules/providers/services/claude-usage-plugin-scope.service.js';
import type { ClaudeAccountLaunchSnapshot } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

test('plugin history remains available across sign-in failures and uses central history for managed/API routes', async () => {
  let releases = 0;
  let prepared = 0;
  const snapshot: ClaudeAccountLaunchSnapshot = { userId: 1, accountId: 'managed', configDir: '/fixture/profiles/account/home', authDir: '/fixture/profiles/account/auth', email: 'fixture@example.test', release: () => { releases++; } };
  const prepareHistory = async (id: number) => { assert.equal(id, 1); prepared++; return '/fixture/users/1/runtime-home'; };
  const managed = await resolveClaudeUsagePluginScope(1, { captureLaunch: () => snapshot, prepareHistory, hasApiConnection: () => false });
  assert.equal(managed.configDir, '/fixture/users/1/runtime-home');
  assert.equal(managed.authDir, '/fixture/profiles/account/auth');
  managed.release(); managed.release(); assert.equal(releases, 1);
  const defaultSnapshot = { ...snapshot, accountId: 'default', configDir: '/fixture/default/home', authDir: '/fixture/default/auth' };
  const legacy = await resolveClaudeUsagePluginScope(1, { captureLaunch: () => defaultSnapshot, prepareHistory, hasApiConnection: () => false });
  assert.equal(legacy.configDir, '/fixture/default/home'); legacy.release();
  const api = await resolveClaudeUsagePluginScope(1, { captureLaunch: () => defaultSnapshot, prepareHistory, hasApiConnection: () => true });
  assert.equal(api.configDir, '/fixture/users/1/runtime-home'); api.release();
  for (const code of ['CLAUDE_ACCOUNT_SIGN_IN_REQUIRED', 'CLAUDE_ACCOUNT_IN_USE']) {
    const offline = await resolveClaudeUsagePluginScope(1, { captureLaunch: () => { throw new AppError('Fixture', { code, statusCode: 409 }); }, prepareHistory, hasApiConnection: () => false });
    assert.equal(offline.configDir, '/fixture/users/1/runtime-home');
    assert.equal(offline.authDir, offline.configDir); offline.release();
  }
  assert.equal(prepared, 4);
  await assert.rejects(resolveClaudeUsagePluginScope(1, { captureLaunch: () => snapshot, prepareHistory: async () => { throw new Error('fixture history failed'); }, hasApiConnection: () => false }));
  assert.equal(releases, 4);
  await assert.rejects(resolveClaudeUsagePluginScope(1, { captureLaunch: () => { throw new AppError('Unsafe', { code: 'CLAUDE_ACCOUNT_PROFILE_UNSAFE', statusCode: 409 }); }, prepareHistory }), (error: unknown) => error instanceof AppError && error.code === 'CLAUDE_ACCOUNT_PROFILE_UNSAFE');
  await assert.rejects(resolveClaudeUsagePluginScope(undefined, { captureLaunch: () => { throw new Error('Must not reach profile'); } }), (error: unknown) => error instanceof AppError && error.statusCode === 401);
});
