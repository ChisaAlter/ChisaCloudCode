import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const BUILTIN_NAMES = new Set(['claude-usage', 'codex-usage', 'project-stats', 'prism', 'session-manager', 'task-queue', 'token-cost-calculator', 'web-terminal', 'workspace-scheduled-prompts', 'claude-github-issue']);
const MAX_PLUGIN_BYTES = 128 * 1024 * 1024;
const MAX_PLUGIN_FILES = 8192;
type Approval = { ownerId: string; digest: string; source: string; permissions: string[]; approvedAt: string };
type PluginConfig = Record<string, { enabled?: boolean; secrets?: Record<string, unknown>; approval?: Approval }>;

function relativeFile(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\\\x00-\x1f]/.test(value)
    && !path.isAbsolute(value) && value.split('/').every(part => part !== '..' && part !== '.' && part !== '.git' && part !== '');
}
function manifestValid(value: unknown): value is Record<string, unknown> & { name: string; displayName: string; entry: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const manifest = value as Record<string, unknown>;
  return typeof manifest.name === 'string' && /^[a-zA-Z0-9_-]+$/.test(manifest.name)
    && typeof manifest.displayName === 'string' && manifest.displayName.length > 0
    && relativeFile(manifest.entry) && (!manifest.server || relativeFile(manifest.server))
    && (!manifest.type || ['react', 'module'].includes(String(manifest.type)))
    && (!manifest.slot || manifest.slot === 'tab')
    && (manifest.permissions === undefined || (Array.isArray(manifest.permissions) && manifest.permissions.length <= 64
      && manifest.permissions.every(permission => typeof permission === 'string' && /^[a-zA-Z0-9:._/-]{1,128}$/.test(permission))));
}
const digestCache = new Map<string, { fingerprint: string; digest: string }>();
function digestDirectory(directory: string): string {
  const hash = crypto.createHash('sha256');
  const fingerprint = crypto.createHash('sha256');
  const resources: { filename: string; relative: string; size: number; ino: number; dev: number; mtime: number; ctime: number }[] = [];
  let bytes = 0;
  let files = 0;
  function walk(current: string, depth = 0) {
    if (depth > 24) throw new Error('Plugin directory nesting exceeds the review budget');
    for (const name of fs.readdirSync(current).sort()) {
      // Git administration is not executed by the host and contains mutable checkout bookkeeping.
      if (name === '.git') continue;
      const filename = path.join(current, name);
      const stat = fs.lstatSync(filename);
      if (stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o022) !== 0)) throw new Error('Plugin symbolic links or group/world-writable resources are not supported');
      if (stat.isDirectory()) { fingerprint.update(`${filename}:${stat.dev}:${stat.ino}:${stat.mode}:${stat.ctimeMs};`); walk(filename, depth + 1); continue; }
      if (!stat.isFile() || stat.nlink !== 1) throw new Error('Plugin contains a non-regular resource');
      bytes += stat.size;
      if (++files > MAX_PLUGIN_FILES || bytes > MAX_PLUGIN_BYTES) throw new Error('Plugin exceeds the review budget');
      const relative = path.relative(directory, filename).split(path.sep).join('/');
      fingerprint.update(`${relative}:${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs};`);
      resources.push({ filename, relative, size: stat.size, ino: stat.ino, dev: stat.dev, mtime: stat.mtimeMs, ctime: stat.ctimeMs });
    }
  }
  walk(directory);
  const resourceFingerprint = fingerprint.digest('hex');
  const cached = digestCache.get(directory);
  if (cached?.fingerprint === resourceFingerprint) return cached.digest;
  for (const resource of resources) {
    const contents = fs.readFileSync(resource.filename);
    const after = fs.lstatSync(resource.filename);
    if (!after.isFile() || after.ino !== resource.ino || after.dev !== resource.dev || after.size !== resource.size
      || after.mtimeMs !== resource.mtime || after.ctimeMs !== resource.ctime || contents.length !== resource.size) throw new Error('Plugin changed during review');
    hash.update(`${Buffer.byteLength(resource.relative)}:${resource.relative}:${contents.length}:`);
    hash.update(contents);
  }
  const digest = `sha256:${hash.digest('hex')}`;
  digestCache.set(directory, { fingerprint: resourceFingerprint, digest });
  if (digestCache.size > 256) digestCache.delete(digestCache.keys().next().value!);
  return digest;
}

/** Plugin module and filesystem tests use one registry so approval and resource resolution share the same digest. */
export function createPluginRegistry(options: { builtinDirectory?: string | null; pluginsDirectory?: string; configPath?: string } = {}) {
  const builtinDirectory = options.builtinDirectory === undefined ? [
    path.resolve(moduleDirectory, '../../../public/builtin-plugins'),
    path.resolve(moduleDirectory, '../../../../public/builtin-plugins'),
  ].find(candidate => fs.existsSync(candidate)) : options.builtinDirectory;
  const pluginsDirectory = options.pluginsDirectory ?? path.join(os.homedir(), '.claude-code-ui', 'plugins');
  const configPath = options.configPath ?? path.join(os.homedir(), '.claude-code-ui', 'plugins.json');

  function readConfig(): PluginConfig {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as PluginConfig : {};
    } catch { return {}; }
  }
  function saveConfig(config: PluginConfig): void {
    fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
    const temporary = `${configPath}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(config, null, 2), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, configPath);
    } finally { try { fs.unlinkSync(temporary); } catch { /* Rename consumed the temporary file. */ } }
  }
  function readPlugins() {
    const config = readConfig();
    const plugins = [];
    const seenNames = new Set<string>();
    for (const [directory, bundled] of [[builtinDirectory, true], [pluginsDirectory, false]] as const) {
      if (!directory || !fs.existsSync(directory) || fs.lstatSync(directory).isSymbolicLink() || (process.platform !== 'win32' && (fs.lstatSync(directory).mode & 0o022) !== 0)) continue;
      for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const pluginDirectory = path.join(directory, entry.name);
        try {
          if (process.platform !== 'win32' && (fs.lstatSync(pluginDirectory).mode & 0o022) !== 0) throw new Error('Plugin directory is writable by another identity');
          const manifestPath = path.join(pluginDirectory, 'manifest.json');
          if (fs.lstatSync(manifestPath).size > 64 * 1024) throw new Error('Plugin manifest is too large');
          const manifest: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          if (!manifestValid(manifest) || seenNames.has(manifest.name)) continue;
          const digest = digestDirectory(pluginDirectory);
          if (!fs.statSync(path.join(pluginDirectory, manifest.entry)).isFile()) continue;
          const server = typeof manifest.server === 'string' && manifest.server ? manifest.server : null;
          if (server && !fs.statSync(path.join(pluginDirectory, server)).isFile()) continue;
          const releaseTrusted = bundled && BUILTIN_NAMES.has(manifest.name) && entry.name === manifest.name;
          const permissions = [...new Set([
            'browser:same-origin', 'host:context', ...(server ? ['host:rpc', 'backend:process', 'backend:filesystem', 'backend:network'] : []),
            ...(['web-terminal', 'task-queue'].includes(manifest.name) ? ['host:websocket'] : []),
            ...(Array.isArray(manifest.permissions) ? manifest.permissions as string[] : []),
          ])].sort();
          const source = { kind: bundled ? 'bundled' as const : 'local' as const,
            location: bundled ? `application:builtin/${entry.name}` : `local:${entry.name}`,
            version: typeof manifest.version === 'string' ? manifest.version : '0.0.0' };
          const approval = config[manifest.name]?.approval;
          const approved = Boolean(approval && typeof approval.ownerId === 'string' && approval.ownerId.length > 0
            && approval.digest === digest && approval.source === JSON.stringify(source)
            && JSON.stringify(approval.permissions) === JSON.stringify(permissions));
          const trusted = releaseTrusted || approved;
          // Only the released default usage reader has an application grant. Legacy enable flags never grant new backend commands.
          const releasePermitted = releaseTrusted && manifest.name === 'claude-usage' && manifest.defaultEnabled === true && !approval;
          const permitted = approved || releasePermitted;
          seenNames.add(manifest.name);
          plugins.push({ name: manifest.name, displayName: manifest.displayName, version: source.version,
            description: typeof manifest.description === 'string' ? manifest.description : '',
            author: typeof manifest.author === 'string' ? manifest.author : '', icon: typeof manifest.icon === 'string' ? manifest.icon : 'Puzzle',
            type: manifest.type === 'react' ? 'react' as const : 'module' as const, slot: 'tab' as const,
            entry: manifest.entry, server, permissions, enabled: permitted && (config[manifest.name]?.enabled ?? releasePermitted),
            dirName: entry.name, repoUrl: null, bundled, pluginDirectory,
            security: { model: 'trusted-only' as const, digest, source, permissions, trusted, permitted,
              reviewRequired: !permitted, releaseTrusted: releasePermitted, approvedOwnerId: approved ? approval!.ownerId : null } });
        } catch (error) {
          console.warn(`[Plugins] Resource ${entry.name} is unavailable for trusted execution: ${error instanceof Error ? error.message : 'invalid resource'}`);
        }
      }
    }
    return plugins;
  }
  return {
    readConfig, saveConfig,
    scanPlugins: () => readPlugins().map(({ pluginDirectory: _directory, ...plugin }) => plugin),
    getPluginDirectory: (name: string) => readPlugins().find(plugin => plugin.name === name)?.pluginDirectory ?? null,
    resolveAsset(name: string, assetPath: string): string | null {
      if (!relativeFile(assetPath)) return null;
      const plugin = readPlugins().find(candidate => candidate.name === name);
      if (!plugin) return null;
      const resolved = path.resolve(plugin.pluginDirectory, assetPath);
      if (!fs.existsSync(resolved)) return null;
      const real = fs.realpathSync(resolved);
      return real.startsWith(fs.realpathSync(plugin.pluginDirectory) + path.sep) ? real : null;
    },
  };
}
const registry = createPluginRegistry();
/** Plugin workflows and process environment read persisted approval and switches. */
export const getPluginsConfig = registry.readConfig;
/** Plugin workflows atomically persist an exact reviewed resource approval. */
export const savePluginsConfig = registry.saveConfig;
/** Plugin workflows and startup discover trusted execution metadata. */
export const scanPlugins = registry.scanPlugins;
/** Process startup and resource reads resolve the same validated plugin directory. */
export const getPluginDir = registry.getPluginDirectory;
/** Plugin asset routes resolve only regular resources within the reviewed directory. */
export const resolvePluginAssetPath = registry.resolveAsset;
