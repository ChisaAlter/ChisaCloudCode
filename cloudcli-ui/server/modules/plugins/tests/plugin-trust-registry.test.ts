import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { createPluginRegistry } from '../plugin-registry.service.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chisa-plugin-trust-'));
  const bundled = path.join(root, 'bundled');
  const local = path.join(root, 'local');
  fs.mkdirSync(bundled); fs.mkdirSync(local);
  const registry = createPluginRegistry({ builtinDirectory: bundled, pluginsDirectory: local, configPath: path.join(root, 'config.json') });
  const write = (name: string, builtin = false, extra: Record<string, unknown> = {}) => {
    const directory = path.join(builtin ? bundled : local, name); fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ name, displayName: name, version: '1.0', entry: 'index.js', server: 'server.js', ...extra }));
    fs.writeFileSync(path.join(directory, 'index.js'), 'export function mount(){}');
    fs.writeFileSync(path.join(directory, 'server.js'), 'console.log("server")');
    return directory;
  };
  const approve = (name: string) => {
    const plugin = registry.scanPlugins().find(item => item.name === name)!;
    registry.saveConfig({ [name]: { enabled: true, approval: { ownerId: '1', digest: plugin.security.digest,
      source: JSON.stringify(plugin.security.source), permissions: plugin.security.permissions, approvedAt: '2026-11-01' } } });
  };
  return { root, registry, write, approve };
}

test('default bundled usage retains release trust; legacy community switches do not grant execution', () => {
  const { root, registry, write } = fixture();
  try {
    write('claude-usage', true, { defaultEnabled: true }); write('community'); write('web-terminal', true);
    registry.saveConfig({ community: { enabled: true }, 'web-terminal': { enabled: true } });
    const usage = registry.scanPlugins().find(item => item.name === 'claude-usage')!;
    assert.equal(usage.enabled, true); assert.equal(usage.security.trusted, true); assert.equal(usage.security.permitted, true);
    for (const name of ['community', 'web-terminal']) {
      const plugin = registry.scanPlugins().find(item => item.name === name)!;
      assert.equal(plugin.enabled, false); assert.equal(plugin.security.permitted, false); assert.equal(plugin.security.reviewRequired, true);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('community approval is invalidated by entry, backend, manifest permission or version changes', () => {
  for (const file of ['index.js', 'server.js', 'manifest.json']) {
    const { root, registry, write, approve } = fixture();
    try {
      const directory = write('community'); approve('community');
      const before = registry.scanPlugins()[0];
      assert.equal(before.enabled, true); assert.equal(before.security.approvedOwnerId, '1');
      if (file === 'manifest.json') fs.writeFileSync(path.join(directory, file), JSON.stringify({ name: 'community', displayName: 'community', version: '2.0', permissions: ['host:websocket'], entry: 'index.js', server: 'server.js' }));
      else fs.appendFileSync(path.join(directory, file), '\n// changed');
      const after = registry.scanPlugins()[0];
      assert.notEqual(after.security.digest, before.security.digest); assert.equal(after.enabled, false); assert.equal(after.security.permitted, false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test('approval permissions cannot be widened by persisted configuration without re-review', () => {
  const { root, registry, write, approve } = fixture();
  try {
    write('community'); approve('community');
    const config = registry.readConfig(); config.community.approval!.permissions.push('host:websocket'); registry.saveConfig(config);
    assert.equal(registry.scanPlugins()[0].enabled, false);
    assert.equal(registry.resolveAsset('community', '../config.json'), null);
    assert.equal(registry.resolveAsset('community', 'index.js')?.endsWith('index.js'), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the actual shipped usage/provider/community catalog remains reviewable with valid resources', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chisa-builtin-catalog-'));
  try {
    const actual = fileURLToPath(new URL('../../../../public/builtin-plugins/', import.meta.url));
    const registry = createPluginRegistry({ builtinDirectory: actual, pluginsDirectory: path.join(root, 'none'), configPath: path.join(root, 'config.json') });
    const rows = registry.scanPlugins();
    for (const name of ['claude-usage', 'codex-usage', 'claude-github-issue', 'web-terminal', 'task-queue']) {
      const plugin = rows.find(row => row.name === name); assert.ok(plugin, name);
      assert.equal(plugin.security.trusted, true, name); assert.match(plugin.security.digest, /^sha256:[a-f0-9]{64}$/);
      assert.ok(registry.resolveAsset(name, plugin.entry));
    }
    assert.equal(rows.find(row => row.name === 'claude-usage')?.enabled, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('published source metadata and digest do not expose absolute home paths or stored secrets', () => {
  const { root, registry, write } = fixture();
  try {
    write('claude-usage', true, { defaultEnabled: true }); registry.saveConfig({ 'claude-usage': { secrets: { token: 'do-not-return' } } });
    const catalog = JSON.stringify(registry.scanPlugins());
    assert.ok(!catalog.includes(root)); assert.ok(!catalog.includes('do-not-return'));
    assert.match(registry.scanPlugins()[0].security.digest, /^sha256:[a-f0-9]{64}$/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
