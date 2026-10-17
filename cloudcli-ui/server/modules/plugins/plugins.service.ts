import { AppError } from '@/shared/utils.js';

type PluginManifest = Record<string, unknown> & {
  name: string;
  dirName?: string;
  enabled?: boolean;
  server?: unknown;
};

type PluginConfig = Record<string, { enabled?: boolean; secrets?: Record<string, unknown> }>;

type PluginDependencies = {
  scanPlugins(): PluginManifest[];
  readConfig(): PluginConfig;
  saveConfig(config: PluginConfig): void;
  getPluginDirectory(pluginName: string): string | null;
  resolveAsset(pluginName: string, assetPath: string): string | null;
  assetIsFile(assetPath: string): boolean;
  contentType(assetPath: string): string;
  startServer(pluginName: string, pluginDirectory: string, serverConfig: unknown): Promise<number>;
  stopServer(pluginName: string): Promise<void>;
  getServerPort(pluginName: string): number | undefined;
  isServerRunning(pluginName: string): boolean;
};

function validatePluginName(pluginName: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(pluginName)) {
    throw new AppError('Invalid plugin name', { code: 'INVALID_PLUGIN_NAME', statusCode: 400 });
  }
}

/** Creates plugin-management workflows around loader and process adapters. */
export function createPluginsService(dependencies: PluginDependencies) {
  async function startServerIfAvailable(plugin: PluginManifest): Promise<void> {
    if (!plugin.server) return;
    const pluginDirectory = dependencies.getPluginDirectory(plugin.name);
    if (!pluginDirectory) return;
    await dependencies.startServer(plugin.name, pluginDirectory, plugin.server);
  }

  return {
    list() {
      return {
        plugins: dependencies.scanPlugins().map((plugin) => ({
          ...plugin,
          serverRunning: plugin.server ? dependencies.isServerRunning(plugin.name) : false,
        })),
      };
    },
    getManifest(pluginName: string) {
      validatePluginName(pluginName);
      const plugin = dependencies.scanPlugins().find((candidate) => candidate.name === pluginName);
      if (!plugin) throw new AppError('Plugin not found', { code: 'PLUGIN_NOT_FOUND', statusCode: 404 });
      return plugin;
    },
    resolveAsset(pluginName: string, assetPath: string) {
      validatePluginName(pluginName);
      if (!assetPath) throw new AppError('No asset path specified', { code: 'PLUGIN_ASSET_REQUIRED', statusCode: 400 });
      const resolvedPath = dependencies.resolveAsset(pluginName, assetPath);
      if (!resolvedPath || !dependencies.assetIsFile(resolvedPath)) {
        throw new AppError('Asset not found', { code: 'PLUGIN_ASSET_NOT_FOUND', statusCode: 404 });
      }
      return { path: resolvedPath, contentType: dependencies.contentType(resolvedPath) };
    },
    async setEnabled(pluginName: string, enabled: unknown) {
      validatePluginName(pluginName);
      if (typeof enabled !== 'boolean') {
        throw new AppError('"enabled" must be a boolean', { code: 'INVALID_PLUGIN_ENABLED', statusCode: 400 });
      }
      const plugin = this.getManifest(pluginName);
      // Persist only after the process transition succeeds; failed enablement
      // must not leave a green switch for a server that never started.
      if (plugin.server && enabled) await startServerIfAvailable(plugin);
      if (plugin.server && !enabled) {
        await dependencies.stopServer(pluginName);
      }
      const config = dependencies.readConfig();
      config[pluginName] = { ...config[pluginName], enabled };
      dependencies.saveConfig(config);
      return { success: true, name: pluginName, enabled };
    },
    async install(_urlInput: unknown) {
      throw new AppError('Plugins are included with ChisaCloudCode; use the enable switch.', { code: 'PLUGINS_BUNDLED', statusCode: 405 });
    },
    async update(pluginName: string) {
      validatePluginName(pluginName);
      throw new AppError('Plugins update together with ChisaCloudCode.', { code: 'PLUGINS_BUNDLED', statusCode: 405 });
    },
    async prepareRpc(pluginName: string) {
      validatePluginName(pluginName);
      const plugin = this.getManifest(pluginName);
      if (!plugin.enabled) throw new AppError('Plugin is disabled', { code: 'PLUGIN_DISABLED', statusCode: 503 });
      let port = dependencies.getServerPort(pluginName);
      if (!port) {
        if (!plugin.server) throw new AppError('Plugin server is not running', { code: 'PLUGIN_SERVER_UNAVAILABLE', statusCode: 503 });
        const pluginDirectory = dependencies.getPluginDirectory(pluginName);
        if (!pluginDirectory) throw new AppError('Plugin resource is unavailable', { code: 'PLUGIN_NOT_FOUND', statusCode: 404 });
        port = await dependencies.startServer(pluginName, pluginDirectory, plugin.server);
      }
      const secrets = dependencies.readConfig()[pluginName]?.secrets ?? {};
      return { port, secrets };
    },
    async uninstall(pluginName: string) {
      validatePluginName(pluginName);
      throw new AppError('Plugins are included with ChisaCloudCode; turn the switch off to disable one.', { code: 'PLUGINS_BUNDLED', statusCode: 405 });
    },
  };
}
