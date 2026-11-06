import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { localDependencyInputs, resolveNpmCli, selectBundleTarget, serverPackageJson } from '../release/build-server-bundle.js';

const root = fileURLToPath(new URL('../../', import.meta.url));

test('all supported hosts retain native labels and reject foreign architectures/platforms', () => {
  for (const [platform, label] of [['win32', 'win'], ['darwin', 'mac'], ['linux', 'linux']]) {
    for (const arch of ['x64', 'arm64']) {
      const host = { platform, arch };
      assert.deepEqual(selectBundleTarget({}, host), { platform: label, arch });
      assert.deepEqual(selectBundleTarget({ CLOUDCLI_BUNDLE_PLATFORM: label, CLOUDCLI_BUNDLE_ARCH: arch }, host), { platform: label, arch });
      assert.throws(() => selectBundleTarget({ CLOUDCLI_BUNDLE_ARCH: arch === 'x64' ? 'arm64' : 'x64' }, host), /cross-target/);
      assert.throws(() => selectBundleTarget({ CLOUDCLI_BUNDLE_PLATFORM: platform === 'linux' ? 'darwin' : 'linux' }, host), /cross-target/);
      assert.throws(() => selectBundleTarget({ CLOUDCLI_BUNDLE_PLATFORM: 'solaris' }, host), /Unsupported/);
      assert.throws(() => selectBundleTarget({ CLOUDCLI_BUNDLE_ARCH: 'ia32' }, host), /Unsupported/);
    }
  }
  assert.throws(() => selectBundleTarget({}, { platform: 'freebsd', arch: 'x64' }), /Unsupported/);
  assert.throws(() => selectBundleTarget({}, { platform: 'linux', arch: 'riscv64' }), /Unsupported/);
});

test('packaging removes only reviewed hooks and retains dependency/install policy', () => {
  const manifest = {
    dependencies: { native: '1.0.0' }, devDependencies: { lint: 'file:vendor/lint.tgz' },
    overrides: { minimatch: '11.0.3' }, allowScripts: { native: true },
    scripts: {
      prepare: 'husky', postinstall: 'node scripts/fix-node-pty.js', prepublishOnly: 'npm run build',
      preinstall: 'node check-engine.js', server: 'node dist-server/server/index.js', preserver: 'node scripts/promote-dist-server.mjs recover',
    },
  };
  const before = structuredClone(manifest);
  const result = serverPackageJson(manifest);
  assert.deepEqual(manifest, before);
  for (const hook of ['prepare', 'postinstall', 'prepublishOnly']) assert.equal(result.scripts[hook], undefined);
  for (const field of ['dependencies', 'devDependencies', 'overrides', 'allowScripts']) assert.deepEqual(result[field], manifest[field]);
  assert.equal(result.scripts.preinstall, manifest.scripts.preinstall);
  assert.equal(result.scripts.server, manifest.scripts.server);
  assert.equal(result.scripts.preserver, manifest.scripts.preserver);
  for (const hook of ['prepare', 'postinstall', 'prepublishOnly']) {
    assert.throws(() => serverPackageJson({ scripts: { [hook]: 'node future-required-step.js' } }), new RegExp(`scripts\\.${hook}`));
  }
  assert.deepEqual(serverPackageJson({ name: 'no-hooks' }), { name: 'no-hooks', scripts: {} });
});

test('local input discovery includes dev/lock-only tarballs and published provenance without checkout-wide copies', () => {
  const inputs = localDependencyInputs({
    dependencies: { runtime: 'file:vendor/runtime.tgz' },
    devDependencies: { dev: 'file:vendor/dev.tgz' },
    optionalDependencies: { optional: 'file:vendor/optional.tgz' },
    files: ['server/', 'scripts/', 'vendor/dev/', 'vendor/*.tgz', '!vendor/private/'],
  }, { packages: { 'node_modules/transitive': { resolved: 'file:vendor/transitive.tgz', dev: true } } });
  assert.deepEqual(inputs, ['vendor/dev.tgz', 'vendor/dev/', 'vendor/optional.tgz', 'vendor/runtime.tgz', 'vendor/transitive.tgz']);
  for (const spec of ['file:../outside.tgz', 'file:/absolute.tgz', 'file:C:/absolute.tgz', 'file:vendor\\..\\escape.tgz', 'file:.', 'file:release/loop', 'file:node_modules/recursive', 'file:.git/config']) {
    assert.throws(() => localDependencyInputs({ devDependencies: { invalid: spec } }, {}), /local dependency/);
  }
});

test('npm resolver accepts a real JS entrypoint with spaces and rejects a shell wrapper', async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'chisa npm & (resolver)-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const cli = path.join(temporary, 'npm-cli.js');
  await fs.writeFile(cli, '// fixture only\n');
  assert.equal(await resolveNpmCli({ npm_execpath: cli, PATH: '' }), cli);
  const realCli = await resolveNpmCli();
  assert.equal(path.basename(realCli), 'npm-cli.js');
  await fs.access(realCli);
  const wrapper = path.join(temporary, 'npm.cmd');
  await fs.writeFile(wrapper, '@echo must not run\r\n');
  // An unusable npm_execpath falls back to a real installation, never cmd.exe.
  assert.notEqual(await resolveNpmCli({ npm_execpath: wrapper, PATH: process.env.PATH, Path: process.env.Path }), wrapper);
});

test('current candidate local inputs exist with locked tarball integrity and licensed patch source', async () => {
  // Read-only against the current reviewed candidate: no installs or source builds.
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'));
  const inputs = localDependencyInputs(manifest, lock);
  assert.ok(inputs.includes('vendor/eslint-plugin-import-x-4.17.1-chisa.1.tgz'));
  assert.ok(inputs.includes('vendor/eslint-plugin-import-x/'));
  for (const input of inputs) await fs.access(path.join(root, input));
  const plugin = lock.packages['node_modules/eslint-plugin-import-x'];
  assert.equal(plugin.dev, true);
  assert.equal(manifest.devDependencies['eslint-plugin-import-x'], plugin.resolved);
  const bytes = await fs.readFile(path.join(root, plugin.resolved.slice(5)));
  assert.equal('sha512-' + crypto.createHash('sha512').update(bytes).digest('base64'), plugin.integrity);
  for (const input of ['LICENSE', 'CHISA-PATCH.md', 'lib/index.js', 'lib/index.cjs', 'package.json']) {
    await fs.access(path.join(root, 'vendor/eslint-plugin-import-x', input));
  }
  const staged = serverPackageJson(manifest);
  assert.deepEqual(staged.dependencies, lock.packages[''].dependencies);
  assert.deepEqual(staged.devDependencies, lock.packages[''].devDependencies);
  assert.equal(staged.scripts.preserver, 'node scripts/promote-dist-server.mjs recover');
});
