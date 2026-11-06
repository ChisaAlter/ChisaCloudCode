import assert from 'node:assert/strict';
import test from 'node:test';

import { createPluginsService } from '../plugins.service.js';

type Dependencies = Parameters<typeof createPluginsService>[0];
function fixture(overrides: Partial<Dependencies> = {}) {
  const plugin: ReturnType<Dependencies['scanPlugins']>[number] = {
    name: 'demo', displayName: 'Demo', dirName: 'demo', version: '1.0', description: '', author: '', icon: '', type: 'module', slot: 'tab',
    entry: 'index.js', server: 'server.js', enabled: false, permissions: ['backend:process', 'host:context', 'host:rpc'], repoUrl: null, bundled: false,
    security: { model: 'trusted-only', digest: `sha256:${'a'.repeat(64)}`, source: { kind: 'local', location: 'local:demo', version: '1.0' },
      permissions: ['backend:process', 'host:context', 'host:rpc'], trusted: false, permitted: false, reviewRequired: true, releaseTrusted: false, approvedOwnerId: null },
  };
  let config: ReturnType<Dependencies['readConfig']> = {};
  const operations: string[] = [];
  const dependencies: Dependencies = {
    scanPlugins: () => [{ ...plugin, enabled: config.demo?.enabled ?? false,
      security: { ...plugin.security, trusted: Boolean(config.demo?.approval), permitted: Boolean(config.demo?.approval),
        reviewRequired: !config.demo?.approval, approvedOwnerId: config.demo?.approval?.ownerId ?? null } }],
    readConfig: () => structuredClone(config), saveConfig: value => { config = structuredClone(value); operations.push('save'); },
    getPluginDirectory: () => '/plugins/demo', resolveAsset: () => '/plugins/demo/index.js', assetIsFile: () => true, contentType: () => 'text/javascript',
    startServer: async () => { operations.push('start'); return 4000; }, stopServer: async () => { operations.push('stop'); },
    getServerPort: () => undefined, isServerRunning: () => false, activeUserIds: () => ['1'], ...overrides,
  };
  const service = createPluginsService(dependencies);
  const approval = { confirmed: true, expectedDigest: plugin.security.digest, grantedPermissions: plugin.security.permissions };
  return { service, operations, approval, plugin, dependencies, config: () => config };
}

test('reviewed community activation saves owner/digest/source/permissions and starts its backend', async () => {
  const { service, approval, operations, config } = fixture();
  await service.install({ name: 'demo', ...approval }, 1);
  assert.deepEqual(operations, ['save', 'start']);
  assert.equal(config().demo.approval?.ownerId, '1');
  assert.equal(config().demo.approval?.digest, approval.expectedDigest);
  assert.equal((await service.prepareRpc('demo', '1')).port, 4000);
  assert.equal(service.list('1').plugins[0].enabled, true);
});

test('untrusted, incomplete and stale digest approvals cannot start a process or expose RPC/assets', async () => {
  const { service, approval, operations } = fixture();
  await assert.rejects(service.setEnabled('demo', true, '1'), { code: 'PLUGIN_APPROVAL_REQUIRED' });
  await assert.rejects(service.update('demo', '1', { ...approval, expectedDigest: `sha256:${'b'.repeat(64)}` }), { code: 'PLUGIN_APPROVAL_REQUIRED' });
  await assert.rejects(service.setEnabled('demo', true, '1', { ...approval, grantedPermissions: ['host:rpc'] }), { code: 'PLUGIN_APPROVAL_REQUIRED' });
  await assert.rejects(service.prepareRpc('demo', '1'), { code: 'PLUGIN_DISABLED' });
  assert.throws(() => service.resolveAsset('demo', 'index.js', '1'), { code: 'PLUGIN_REVIEW_REQUIRED' });
  assert.deepEqual(operations, []);
});

test('unknown, foreign and multiple owners cannot grant backend execution', async () => {
  for (const [users, user] of [[['1'], null], [['1'], '2'], [['1', '2'], '1'], [['1', '2'], '2']] as const) {
    const { service, approval, operations } = fixture({ activeUserIds: () => [...users] });
    await assert.rejects(service.install({ name: 'demo', ...approval }, user), (error: unknown) => error instanceof Error && /Authentication|single installation owner/.test(error.message));
    assert.deepEqual(operations, []);
  }
});

test('network URL install is rejected without clone/npm/start side effects', async () => {
  const { service, operations } = fixture();
  await assert.rejects(service.install({ url: 'https://example.invalid/plugin' }, '1'), { code: 'PLUGIN_LOCAL_REVIEW_REQUIRED' });
  assert.deepEqual(operations, []);
});

test('failed start restores the previous approval and switch', async () => {
  const { service, approval, config } = fixture({ startServer: async () => { throw new Error('Cannot load server dependency'); } });
  await assert.rejects(service.setEnabled('demo', true, '1', approval), /Cannot load server dependency/);
  assert.deepEqual(config(), {});
});

test('disabling waits for confirmed process exit before persisting disabled', async () => {
  let complete!: () => void;
  const stopped = new Promise<void>(resolve => { complete = resolve; });
  const { service, operations } = fixture({ stopServer: async () => { operations.push('stop'); await stopped; } });
  const disabling = service.setEnabled('demo', false, '1');
  await Promise.resolve();
  assert.deepEqual(operations, ['stop']);
  complete(); await disabling;
  assert.deepEqual(operations, ['stop', 'save']);
});

test('normal default usage pins the release grant to the real owner and reviewed digest', async () => {
  const base = fixture();
  const usage = { ...base.plugin, name: 'claude-usage', enabled: true,
    security: { ...base.plugin.security, trusted: true, permitted: true, releaseTrusted: true, reviewRequired: false } };
  let saved: ReturnType<Dependencies['readConfig']> = {};
  const service = createPluginsService({ ...base.dependencies, scanPlugins: () => [usage],
    readConfig: () => saved, saveConfig: value => { saved = value; }, getServerPort: () => 4000 });
  assert.equal((await service.prepareRpc('claude-usage', '1')).port, 4000);
  assert.equal(saved['claude-usage'].approval?.ownerId, '1');
  assert.equal(saved['claude-usage'].approval?.digest, usage.security.digest);
});

test('overlapping lifecycle changes cannot race a disable against an enable', async () => {
  let complete!: () => void;
  const stopped = new Promise<void>(resolve => { complete = resolve; });
  const { service, approval, operations } = fixture({ stopServer: async () => { operations.push('stop'); await stopped; } });
  const disabling = service.setEnabled('demo', false, '1');
  await Promise.resolve();
  await assert.rejects(service.setEnabled('demo', true, '1', approval), { code: 'PLUGIN_TRANSITION_PENDING' });
  complete(); await disabling;
  assert.deepEqual(operations, ['stop', 'save']);
});

test('approving an updated digest stops the old backend before starting the approved version', async () => {
  const { service, approval, operations } = fixture({ isServerRunning: () => true });
  await service.update('demo', '1', approval);
  assert.deepEqual(operations, ['stop', 'save', 'start']);
});

test('websocket capability is denied unless explicitly in the approved manifest', async () => {
  const { service, approval } = fixture();
  await service.setEnabled('demo', true, '1', approval);
  assert.throws(() => service.authorizePluginAccess('demo', '1', 'websocket'), { code: 'PLUGIN_PERMISSION_REQUIRED' });
  assert.equal(service.authorizePluginAccess('demo', '1', 'rpc').name, 'demo');
});
