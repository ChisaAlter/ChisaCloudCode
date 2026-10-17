import assert from 'node:assert/strict';

import { test } from 'vitest';

import { CLAUDE_LOGIN_COMMAND, getProviderCommand } from '@/modules/provider-auth/providerLoginCommand';

test('Claude login runs /login without --dangerously-skip-permissions', () => {
  const command = getProviderCommand({ provider: 'claude' });
  assert.equal(command, 'claude /login');
  assert.equal(command, CLAUDE_LOGIN_COMMAND);
  assert.doesNotMatch(command, /dangerously-skip-permissions/);
});

test('a custom login command still wins over the provider default', () => {
  assert.equal(getProviderCommand({ provider: 'claude', customCommand: 'claude setup-token' }), 'claude setup-token');
});

test('other providers keep their own login commands', () => {
  assert.equal(getProviderCommand({ provider: 'cursor' }), 'cursor-agent login');
  assert.equal(getProviderCommand({ provider: 'opencode' }), 'opencode auth login');
  assert.equal(getProviderCommand({ provider: 'codex' }), 'codex login');
});
