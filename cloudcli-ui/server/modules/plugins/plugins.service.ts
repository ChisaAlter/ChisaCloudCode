import { AppError } from '@/shared/index.js';

import type { createPluginRegistry } from './plugin-registry.service.js';

type Registry = ReturnType<typeof createPluginRegistry>;
type Manifest = ReturnType<Registry['scanPlugins']>[number];
type PluginDependencies = {
  scanPlugins(): Manifest[];
  readConfig: Registry['readConfig'];
  saveConfig: Registry['saveConfig'];
  getPluginDirectory(pluginName: string): string | null;
  resolveAsset(pluginName: string, assetPath: string): string | null;
  assetIsFile(assetPath: string): boolean;
  contentType(assetPath: string): string;
  startServer(pluginName: string, pluginDirectory: string, serverConfig: unknown): Promise<number>;
  stopServer(pluginName: string): Promise<void>;
  getServerPort(pluginName: string): number | undefined;
  isServerRunning(pluginName: string): boolean;
  activeUserIds(): string[];
};
function validatePluginName(name: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new AppError('Invalid plugin name', { code: 'INVALID_PLUGIN_NAME', statusCode: 400 });
}

/** Plugin routes and the websocket authorization barrel use these workflows; only a verified installation owner can grant execution. */
export function createPluginsService(dependencies: PluginDependencies) {
  function assertOwner(userId: unknown): string {
    const id = typeof userId === 'string' || typeof userId === 'number' ? String(userId) : '';
    const active = dependencies.activeUserIds();
    if (!id || !active.includes(id)) throw new AppError('Authentication is required.', { code: 'UNAUTHORIZED', statusCode: 401 });
    if (active.length !== 1 || active[0] !== id) throw new AppError('Plugin execution requires the verified single installation owner. Multi-owner execution is not enabled.', { code: 'PLUGIN_OWNER_REQUIRED', statusCode: 403 });
    return id;
  }
  function manifest(name: string): Manifest {
    validatePluginName(name);
    const plugin = dependencies.scanPlugins().find(candidate => candidate.name === name);
    if (!plugin) throw new AppError('Plugin not found', { code: 'PLUGIN_NOT_FOUND', statusCode: 404 });
    return plugin;
  }
  function permitted(plugin: Manifest, ownerId: string): boolean {
    return plugin.security.trusted && plugin.security.permitted
      && (plugin.security.releaseTrusted || plugin.security.approvedOwnerId === ownerId);
  }
  function assertTrusted(plugin: Manifest, ownerId: string, permission?: string) {
    if (!permitted(plugin, ownerId)) throw new AppError('Review and explicitly approve this plugin version before execution.', { code: 'PLUGIN_REVIEW_REQUIRED', statusCode: 403 });
    if (permission && !plugin.security.permissions.includes(permission)) throw new AppError('The plugin has not been granted this host capability.', { code: 'PLUGIN_PERMISSION_REQUIRED', statusCode: 403 });
  }
  function review(name: string, userId: unknown) {
    const ownerId = assertOwner(userId);
    const plugin = manifest(name);
    return { ...plugin, enabled: plugin.enabled && permitted(plugin, ownerId),
      security: { ...plugin.security, permitted: permitted(plugin, ownerId), reviewRequired: !permitted(plugin, ownerId) } };
  }
  function approval(plugin: Manifest, value: unknown, ownerId: string) {
    const input = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    if (input.confirmed !== true || input.expectedDigest !== plugin.security.digest || !Array.isArray(input.grantedPermissions)
      || input.grantedPermissions.some(item => typeof item !== 'string')
      || JSON.stringify([...new Set(input.grantedPermissions)].sort()) !== JSON.stringify(plugin.security.permissions)) {
      throw new AppError('Confirm the exact source, version, digest and complete permission manifest.', { code: 'PLUGIN_APPROVAL_REQUIRED', statusCode: 409 });
    }
    return { ownerId, digest: plugin.security.digest, source: JSON.stringify(plugin.security.source),
      permissions: [...plugin.security.permissions], approvedAt: new Date().toISOString() };
  }
  const transitions = new Set<string>();
  async function transition(name: string, enabled: unknown, userId: unknown, input?: unknown) {
    const ownerId = assertOwner(userId);
    if (typeof enabled !== 'boolean') throw new AppError('"enabled" must be a boolean', { code: 'INVALID_PLUGIN_ENABLED', statusCode: 400 });
    const plugin = manifest(name);
    const approved = enabled ? approval(plugin, input, ownerId) : undefined;
    // Approval is a version transition, never permission to keep using an already running older backend.
    if (plugin.server && (!enabled || dependencies.isServerRunning(name))) await dependencies.stopServer(name);
    assertOwner(userId);
    if (enabled && manifest(name).security.digest !== plugin.security.digest) throw new AppError('Plugin changed after review.', { code: 'PLUGIN_CHANGED', statusCode: 409 });
    const previous = dependencies.readConfig();
    const next = { ...previous, [name]: { ...previous[name], enabled, ...(approved ? { approval: approved } : {}) } };
    // Publish approval before startup so the process adapter sees the exact authorized digest; restore on a failed start.
    dependencies.saveConfig(next);
    try {
      if (enabled && plugin.server) {
        const directory = dependencies.getPluginDirectory(name);
        if (!directory) throw new AppError('Plugin resource is unavailable', { code: 'PLUGIN_NOT_FOUND', statusCode: 404 });
        const current = manifest(name);
        if (current.security.digest !== plugin.security.digest) throw new AppError('Plugin changed after review.', { code: 'PLUGIN_CHANGED', statusCode: 409 });
        await dependencies.startServer(name, directory, plugin.server);
        assertOwner(userId);
        if (manifest(name).security.digest !== plugin.security.digest) throw new AppError('Plugin changed during startup.', { code: 'PLUGIN_CHANGED', statusCode: 409 });
      }
    } catch (error) {
      if (enabled && plugin.server) {
        try { await dependencies.stopServer(name); }
        catch {
          dependencies.saveConfig({ ...previous, [name]: { ...previous[name], enabled: false } });
          throw new AppError('Plugin startup failed and process cleanup is unconfirmed; execution is disabled.', { code: 'PLUGIN_CLEANUP_PENDING', statusCode: 503 });
        }
      }
      dependencies.saveConfig(previous); throw error;
    }
    return { success: true, name, enabled };
  }
  async function enable(name: string, enabled: unknown, userId: unknown, input?: unknown) {
    validatePluginName(name);
    if (transitions.has(name)) throw new AppError('A plugin lifecycle transition is already pending.', { code: 'PLUGIN_TRANSITION_PENDING', statusCode: 409 });
    transitions.add(name);
    try { return await transition(name, enabled, userId, input); } finally { transitions.delete(name); }
  }
  return {
    list(userId: unknown) {
      const active = dependencies.activeUserIds();
      const id = typeof userId === 'string' || typeof userId === 'number' ? String(userId) : '';
      if (!id || !active.includes(id)) throw new AppError('Authentication is required.', { code: 'UNAUTHORIZED', statusCode: 401 });
      const manages = active.length === 1 && active[0] === id;
      return { model: 'trusted-only', canManage: manages, plugins: dependencies.scanPlugins().map(plugin => ({ ...plugin,
        enabled: manages && permitted(plugin, id) && plugin.enabled,
        serverRunning: manages && permitted(plugin, id) && plugin.server ? dependencies.isServerRunning(plugin.name) : false,
        security: { ...plugin.security, permitted: manages && permitted(plugin, id), reviewRequired: !permitted(plugin, id) },
      })) };
    },
    getManifest: review,
    review,
    resolveAsset(name: string, assetPath: string, userId: unknown) {
      const ownerId = assertOwner(userId);
      const plugin = manifest(name);
      assertTrusted(plugin, ownerId);
      if (!assetPath) throw new AppError('No asset path specified', { code: 'PLUGIN_ASSET_REQUIRED', statusCode: 400 });
      const resolved = dependencies.resolveAsset(name, assetPath);
      if (!resolved || !dependencies.assetIsFile(resolved)) throw new AppError('Asset not found', { code: 'PLUGIN_ASSET_NOT_FOUND', statusCode: 404 });
      return { path: resolved, contentType: dependencies.contentType(resolved) };
    },
    setEnabled: enable,
    async install(input: unknown, userId: unknown) {
      assertOwner(userId);
      if (!input || typeof input !== 'object' || typeof (input as Record<string, unknown>).name !== 'string') {
        throw new AppError('Community plugins must be staged locally by the installation owner, reviewed and explicitly approved. Network command installation is disabled.', { code: 'PLUGIN_LOCAL_REVIEW_REQUIRED', statusCode: 400 });
      }
      return enable((input as { name: string }).name, true, userId, input);
    },
    async update(name: string, userId: unknown, input?: unknown) { return enable(name, true, userId, input); },
    authorizePluginAccess(name: string, userId: unknown, purpose: 'rpc' | 'websocket') {
      const ownerId = assertOwner(userId);
      const plugin = manifest(name);
      if (!plugin.enabled) throw new AppError('Plugin is disabled', { code: 'PLUGIN_DISABLED', statusCode: 503 });
      assertTrusted(plugin, ownerId, purpose === 'websocket' ? 'host:websocket' : 'host:rpc');
      return plugin;
    },
    async prepareRpc(name: string, userId: unknown) {
      const plugin = this.authorizePluginAccess(name, userId, 'rpc');
      const ownerId = assertOwner(userId);
      // Pin the application's default usage grant to its first verified owner/digest. A later resource replacement needs review.
      if (plugin.security.releaseTrusted && !dependencies.readConfig()[name]?.approval) {
        const config = dependencies.readConfig();
        dependencies.saveConfig({ ...config, [name]: { ...config[name], enabled: true,
          approval: approval(plugin, { confirmed: true, expectedDigest: plugin.security.digest,
            grantedPermissions: plugin.security.permissions }, ownerId) } });
      }
      let port = dependencies.getServerPort(name);
      if (!port) {
        const directory = dependencies.getPluginDirectory(name);
        if (!directory || !plugin.server) throw new AppError('Plugin server is unavailable', { code: 'PLUGIN_SERVER_UNAVAILABLE', statusCode: 503 });
        port = await dependencies.startServer(name, directory, plugin.server);
      }
      const revalidated = this.authorizePluginAccess(name, userId, 'rpc');
      if (revalidated.security.digest !== plugin.security.digest) throw new AppError('Plugin changed while preparing its backend.', { code: 'PLUGIN_CHANGED', statusCode: 409 });
      // Never return stored secrets to a browser. Only the trusted loopback proxy receives this private result.
      return { port, secrets: dependencies.readConfig()[name]?.secrets ?? {} };
    },
    async uninstall(name: string, userId: unknown) { return enable(name, false, userId); },
  };
}
