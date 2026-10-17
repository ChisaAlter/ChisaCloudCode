import assert from 'node:assert/strict';
import test from 'node:test';

import { createPluginsService } from '../plugins.service.js';

type Dependencies = Parameters<typeof createPluginsService>[0];

function dependencies(overrides: Partial<Dependencies> = {}): Dependencies {
  return {
    scanPlugins: () => [], readConfig: () => ({}), saveConfig: () => undefined,
    getPluginDirectory: () => null,
    resolveAsset: () => null, assetIsFile: () => false, contentType: () => 'text/plain',
    startServer: async () => 4000,
    stopServer: async () => undefined, getServerPort: () => undefined,
    isServerRunning: () => false,
    ...overrides,
  };
}

test('setEnabled persists configuration and starts an enabled plugin server', async () => {
  const operations: string[] = [];
  const service = createPluginsService(dependencies({
    scanPlugins: () => [{ name: 'demo', dirName: 'demo', server: { entry: 'server.js' } }],
    getPluginDirectory: () => '/plugins/demo',
    saveConfig: () => operations.push('save'),
    startServer: async () => { operations.push('start'); return 4000; },
  }));
  await service.setEnabled('demo', true);
  assert.deepEqual(operations, ['start', 'save']);
});

test('bundled plugins reject legacy install, update and uninstall requests', async () => {
  const service = createPluginsService(dependencies());
  for (const request of [service.install('https://github.com/example/plugin'), service.update('demo'), service.uninstall('demo')]) {
    await assert.rejects(request, { code: 'PLUGINS_BUNDLED', statusCode: 405 });
  }
});

test('failed server enablement leaves the stored switch unchanged', async () => {
  let saved = false;
  const service = createPluginsService(dependencies({
    scanPlugins: () => [{ name: 'demo', enabled: false, server: 'dist/server.js' }],
    getPluginDirectory: () => '/public/builtin-plugins/demo',
    startServer: async () => { throw new Error('Cannot load server dependency'); },
    saveConfig: () => { saved = true; },
  }));
  await assert.rejects(service.setEnabled('demo', true), /Cannot load server dependency/);
  assert.equal(saved, false);
});

test('disabled plugin RPC is refused even while a stale server port exists', async () => {
  const service = createPluginsService(dependencies({
    scanPlugins: () => [{ name: 'demo', enabled: false, server: 'dist/server.js' }],
    getServerPort: () => 4000,
  }));
  await assert.rejects(service.prepareRpc('demo'), { code: 'PLUGIN_DISABLED', statusCode: 503 });
});

test('lazy RPC uses the same bundled directory as asset discovery', async () => {
  let startedDirectory: string | null = null;
  const service = createPluginsService(dependencies({
    scanPlugins: () => [{ name: 'demo', enabled: true, dirName: 'demo', server: 'dist/server.js' }],
    getPluginDirectory: () => '/public/builtin-plugins/demo',
    startServer: async (_name, directory) => { startedDirectory = directory; return 4000; },
  }));
  assert.equal((await service.prepareRpc('demo')).port, 4000);
  assert.equal(startedDirectory, '/public/builtin-plugins/demo');
});

test('disabling a not-yet-ready server awaits its stop before reporting the switch saved', async () => {
  let finish!: () => void;
  const stopped = new Promise<void>((resolve) => { finish = resolve; });
  const operations: string[] = [];
  const service = createPluginsService(dependencies({
    scanPlugins: () => [{ name: 'demo', enabled: true, server: 'dist/server.js' }],
    isServerRunning: () => false,
    stopServer: () => { operations.push('stop'); return stopped; },
    saveConfig: () => { operations.push('save'); },
  }));
  const disabling = service.setEnabled('demo', false);
  await Promise.resolve();
  assert.deepEqual(operations, ['stop']);
  finish();
  await disabling;
  assert.deepEqual(operations, ['stop', 'save']);
});

test('a running-but-unconfirmed stop cannot be enabled by skipping the lifecycle adapter', async () => {
  let saved = false;
  const service = createPluginsService(dependencies({
    scanPlugins: () => [{ name: 'demo', enabled: false, server: 'dist/server.js' }],
    getPluginDirectory: () => '/plugins/demo',
    isServerRunning: () => true,
    startServer: async () => { throw new Error('shutdown not confirmed'); },
    saveConfig: () => { saved = true; },
  }));
  await assert.rejects(service.setEnabled('demo', true), /shutdown not confirmed/);
  assert.equal(saved, false);
});
