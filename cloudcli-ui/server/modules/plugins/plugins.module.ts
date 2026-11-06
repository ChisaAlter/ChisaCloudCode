import fs from 'node:fs';

import mime from 'mime-types';

import { userDb } from '@/modules/database/index.js';

import {
  getPluginDir, getPluginsConfig,
  resolvePluginAssetPath, savePluginsConfig, scanPlugins,
} from './plugin-registry.service.js';
import {
  getPluginPort, isPluginRunning, startPluginServer, stopPluginServer,
} from './plugin-process.service.js';
import { createPluginsRouter } from './plugins.routes.js';
import { createPluginsService } from './plugins.service.js';

const pluginsService = createPluginsService({
  scanPlugins, readConfig: getPluginsConfig, saveConfig: savePluginsConfig,
  getPluginDirectory: getPluginDir,
  resolveAsset: resolvePluginAssetPath,
  assetIsFile: (assetPath) => { try { return fs.statSync(assetPath).isFile(); } catch { return false; } },
  contentType: (assetPath) => mime.lookup(assetPath) || 'application/octet-stream',
  startServer: startPluginServer,
  stopServer: async (pluginName) => { await stopPluginServer(pluginName); },
  getServerPort: getPluginPort, isServerRunning: isPluginRunning,
  activeUserIds: () => userDb.getActiveUserIds(),
});

/** Plugin router assembled with filesystem, loader, and process adapters. */
export const pluginsRoutes = createPluginsRouter(pluginsService);

/** Websocket setup checks the authenticated owner and approved resource before exposing any plugin process. */
export const authorizePluginAccess = pluginsService.authorizePluginAccess;

/** Server startup restores only trusted enabled plugins for a database-verified single installation owner. */
export async function startEnabledPluginServers(): Promise<void> {
  const users = userDb.getActiveUserIds();
  if (users.length !== 1) return;
  for (const plugin of scanPlugins()) {
    if (!plugin.enabled || !plugin.server) continue;
    try {
      await pluginsService.prepareRpc(plugin.name, users[0]);
    } catch (error) { console.error('[Plugins] Trusted startup failed:', plugin.name, error instanceof Error ? error.message : 'unavailable'); }
  }
}
