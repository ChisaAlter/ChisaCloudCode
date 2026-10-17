// @ts-nocheck -- manifest fields are narrowed at the Plugins service boundary.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const PLUGINS_DIR = path.join(os.homedir(), '.claude-code-ui', 'plugins');
const PLUGINS_CONFIG_PATH = path.join(os.homedir(), '.claude-code-ui', 'plugins.json');
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
// Source and compiled server layouts share the shipped public resource tree.
const BUILTIN_PLUGINS_DIR = [
  path.resolve(moduleDirectory, '../../../public/builtin-plugins'),
  path.resolve(moduleDirectory, '../../../../public/builtin-plugins'),
].find((candidate) => fs.existsSync(candidate));

/** Registry, process lifecycle and Plugins service read persisted switches here. */
export function getPluginsConfig() {
  try {
    if (fs.existsSync(PLUGINS_CONFIG_PATH)) return JSON.parse(fs.readFileSync(PLUGINS_CONFIG_PATH, 'utf-8'));
  } catch { /* An unreadable configuration has no persisted switches. */ }
  return {};
}

/** Plugins service writes switches without modifying shipped resources. */
export function savePluginsConfig(config) {
  fs.mkdirSync(path.dirname(PLUGINS_CONFIG_PATH), { recursive: true, mode: 0o700 });
  fs.writeFileSync(PLUGINS_CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') return false;
  if (!['name', 'displayName', 'entry'].every((field) => typeof manifest[field] === 'string' && manifest[field])) return false;
  if (!/^[a-zA-Z0-9_-]+$/.test(manifest.name)) return false;
  if (manifest.type && !['react', 'module'].includes(manifest.type)) return false;
  if (manifest.slot && manifest.slot !== 'tab') return false;
  if (manifest.entry.includes('..') || path.isAbsolute(manifest.entry)) return false;
  if (manifest.server && (typeof manifest.server !== 'string' || manifest.server.includes('..') || path.isAbsolute(manifest.server))) return false;
  return manifest.permissions === undefined || (Array.isArray(manifest.permissions) && manifest.permissions.every((permission) => typeof permission === 'string'));
}

function readPlugins() {
  const config = getPluginsConfig();
  const plugins = [];
  const seenNames = new Set();
  // Shipped versions win over an old Git installation with the same manifest
  // name, so a user's previous installation cannot register a second instance.
  for (const [directory, bundled] of [[BUILTIN_PLUGINS_DIR, true], [PLUGINS_DIR, false]]) {
    if (!directory || !fs.existsSync(directory)) continue;
    const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.tmp-')) continue;
      const pluginDirectory = path.join(directory, entry.name);
      const manifestPath = path.join(pluginDirectory, 'manifest.json');
      if (!fs.existsSync(manifestPath)) continue;
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        if (!validateManifest(manifest) || seenNames.has(manifest.name)) continue;
        seenNames.add(manifest.name);
        plugins.push({
          name: manifest.name, displayName: manifest.displayName,
          version: manifest.version || '0.0.0', description: manifest.description || '',
          author: manifest.author || '', icon: manifest.icon || 'Puzzle',
          type: manifest.type || 'module', slot: manifest.slot || 'tab',
          entry: manifest.entry, server: manifest.server || null, permissions: manifest.permissions || [],
          enabled: config[manifest.name]?.enabled ?? (bundled ? manifest.defaultEnabled === true : true),
          dirName: entry.name, repoUrl: null, bundled, pluginDirectory,
        });
      } catch (error) {
        console.warn(`[Plugins] Failed to read ${entry.name}:`, error.message);
      }
    }
  }
  return plugins;
}

/** Plugins service and startup process loader receive one manifest per name. */
export function scanPlugins() {
  return readPlugins().map(({ pluginDirectory: _directory, ...plugin }) => plugin);
}

/** Plugins service and process loader resolve the same shipped/user resource. */
export function getPluginDir(name) {
  return readPlugins().find((plugin) => plugin.name === name)?.pluginDirectory ?? null;
}

/** Plugins service resolves only files within the selected plugin resource. */
export function resolvePluginAssetPath(name, assetPath) {
  const pluginDirectory = getPluginDir(name);
  if (!pluginDirectory) return null;
  const resolved = path.resolve(pluginDirectory, assetPath);
  if (!fs.existsSync(resolved)) return null;
  const realResolved = fs.realpathSync(resolved);
  const realPluginDirectory = fs.realpathSync(pluginDirectory);
  return realResolved.startsWith(realPluginDirectory + path.sep) ? realResolved : null;
}
