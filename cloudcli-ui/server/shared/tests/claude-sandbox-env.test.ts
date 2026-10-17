import assert from 'node:assert/strict';
import test from 'node:test';

import { isRunningAsRoot, withClaudeRootSandboxEnv } from '@/shared/claude-sandbox-env.js';

const asRoot = { platform: 'linux' as const, getuid: () => 0 };
const asUser = { platform: 'linux' as const, getuid: () => 1000 };

test('root on Linux gets IS_SANDBOX=1 so Claude accepts bypassPermissions', () => {
  const env = withClaudeRootSandboxEnv({ PATH: '/usr/bin' }, asRoot);
  assert.deepEqual(env, { PATH: '/usr/bin', IS_SANDBOX: '1' });
});

test('a non-root server leaves the Claude env untouched', () => {
  const input = { PATH: '/usr/bin' };
  assert.equal(withClaudeRootSandboxEnv(input, asUser), input);
  assert.equal('IS_SANDBOX' in withClaudeRootSandboxEnv(input, asUser), false);
});

test('an operator-provided IS_SANDBOX value is never overridden', () => {
  assert.equal(withClaudeRootSandboxEnv({ IS_SANDBOX: '0' }, asRoot).IS_SANDBOX, '0');
  assert.equal(withClaudeRootSandboxEnv({ IS_SANDBOX: '1' }, asUser).IS_SANDBOX, '1');
});

test('Windows and platforms without getuid are never treated as root', () => {
  assert.equal(isRunningAsRoot({ platform: 'win32', getuid: () => 0 }), false);
  assert.equal(isRunningAsRoot({ platform: 'linux', getuid: undefined }), false);
});
