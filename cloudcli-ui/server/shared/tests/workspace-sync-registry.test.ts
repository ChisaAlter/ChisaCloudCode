import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';

import {
  getWorkspaceSyncNetwork, isWorkspaceSyncControlHost, isWorkspaceSyncRecoveryOnly,
  registerWorkspaceSyncControlHost, registerWorkspaceSyncNetwork, registerWorkspaceSyncRecoveryTransport,
} from '../index.js';

const network = 'chisa-workspace-network-' + 'c'.repeat(24);

test('transport callbacks accept only inspected private IPv4 addresses or loopback', () => {
  assert.equal(isWorkspaceSyncControlHost('127.0.0.1'), true);
  assert.equal(isWorkspaceSyncControlHost('172.22.0.91'), false);
  for (const invalid of ['8.8.8.8', 'localhost', '::1', '172.32.0.1', '10.0.0.999']) {
    assert.throws(() => registerWorkspaceSyncControlHost(invalid));
    assert.equal(isWorkspaceSyncControlHost(invalid), false);
  }
  registerWorkspaceSyncControlHost('172.22.0.91');
  assert.equal(isWorkspaceSyncControlHost('172.22.0.91'), true);
});

test('network and recovery admission follow path ancestors without inheriting sibling prefixes', () => {
  const root = path.join(os.tmpdir(), 'chisa-registry-test', 'account');
  const child = path.join(root, 'project.chisa-worktrees', 'session');
  const sibling = root + '-other';
  assert.throws(() => registerWorkspaceSyncNetwork('relative-root', network, '172.22.0.92'));
  assert.throws(() => registerWorkspaceSyncNetwork(root, 'bridge', '172.22.0.92'));
  registerWorkspaceSyncRecoveryTransport(root, '172.22.0.92');
  assert.equal(isWorkspaceSyncRecoveryOnly(child), true);
  assert.equal(isWorkspaceSyncRecoveryOnly(sibling), false);
  assert.equal(getWorkspaceSyncNetwork(child), undefined);
  registerWorkspaceSyncNetwork(root, network, '172.22.0.92');
  assert.equal(isWorkspaceSyncRecoveryOnly(child), false);
  assert.equal(getWorkspaceSyncNetwork(root), network);
  assert.equal(getWorkspaceSyncNetwork(child), network);
  assert.equal(getWorkspaceSyncNetwork(sibling), undefined);
});
