import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolveNpmCli } from '../release/build-server-bundle.js';

const execute = promisify(execFile);
const scriptPath = fileURLToPath(new URL('../release/build-server-bundle.js', import.meta.url));
const scriptSource = await fs.readFile(scriptPath, 'utf8');
const otherPlatform = process.platform === 'linux' ? 'win32' : 'linux';
const label = { linux: 'linux', win32: 'win', darwin: 'mac' }[process.platform];

async function put(root, relative, contents) {
  const filename = path.join(root, relative);
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, contents);
}

async function fixture(t) {
  // Shell metacharacters in a real checkout path must stay ordinary path text.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chisa-bundle space & (fixture)-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const manifest = {
    name: 'chisa-server-bundle-fixture', version: '1.0.0', type: 'module',
    main: 'dist-server/server/index.js',
    scripts: {
      server: 'node dist-server/server/index.js',
      preserver: 'node scripts/promote-dist-server.mjs recover',
      prepare: 'husky', postinstall: 'node scripts/fix-node-pty.js',
      prepublishOnly: 'npm run build', build: 'node must-not-build.js',
    },
    dependencies: { 'bundle-runtime-fixture': 'file:vendor/bundle-runtime-fixture-1.0.0.tgz' },
    devDependencies: { 'bundle-dev-fixture': 'file:vendor/bundle-dev-fixture-1.0.0.tgz' },
    files: ['dist/', 'dist-server/', 'vendor/bundle-dev-fixture-1.0.0.tgz', 'vendor/bundle-dev-fixture/'],
  };
  const lock = {
    name: manifest.name, version: manifest.version, lockfileVersion: 3, requires: true,
    packages: {
      '': { name: manifest.name, version: manifest.version, dependencies: manifest.dependencies, devDependencies: manifest.devDependencies },
      'node_modules/bundle-runtime-fixture': {
        version: '1.0.0', resolved: 'file:vendor/bundle-runtime-fixture-1.0.0.tgz', hasInstallScript: true,
      },
      'node_modules/bundle-dev-fixture': {
        version: '1.0.0', resolved: 'file:vendor/bundle-dev-fixture-1.0.0.tgz', dev: true,
      },
    },
  };
  await put(root, 'package.json', JSON.stringify(manifest));
  await put(root, 'package-lock.json', JSON.stringify(lock));
  await put(root, 'LICENSE', 'Fixture distribution license\n');
  await put(root, 'README.md', 'Fixture distribution and startup documentation\n');
  await put(root, 'scripts/release/build-server-bundle.js', scriptSource);
  await put(root, 'scripts/fix-node-pty.js', 'console.log("fixture pty fix executed");\n');
  await put(root, 'scripts/promote-dist-server.mjs', 'if(process.argv[2]!=="recover")throw Error("unexpected recovery mode");\n');
  await put(root, 'dist/index.html', '<!doctype html><title>bundle fixture</title>');
  await put(root, 'dist-server/server/index.js', 'console.log("fixture server entered");\n');
  await put(root, 'public/asset.txt', 'fixture public asset');
  await put(root, 'shared/runtime.js', 'export const fixture = true;\n');
  await put(root, 'vendor/bundle-dev-fixture/package.json', JSON.stringify({ name: 'bundle-dev-fixture', version: '1.0.0' }));
  await put(root, 'vendor/bundle-dev-fixture/LICENSE', 'Fixture license\n');
  await put(root, 'vendor/bundle-dev-fixture/CHISA-PATCH.md', 'Fixture provenance\n');
  await execute('tar', ['-czf', path.join(root, 'vendor/bundle-dev-fixture-1.0.0.tgz'), '-C', path.join(root, 'vendor'), 'bundle-dev-fixture']);
  await put(root, 'vendor/runtime-package/package.json', JSON.stringify({
    name: 'bundle-runtime-fixture', version: '1.0.0',
    scripts: { install: 'node install.cjs' },
  }));
  await put(root, 'vendor/runtime-package/install.cjs', 'require("node:fs").writeFileSync("installed-native.json",JSON.stringify({platform:process.platform,arch:process.arch}));\n');
  await execute('tar', ['-czf', path.join(root, 'vendor/bundle-runtime-fixture-1.0.0.tgz'), '-C', path.join(root, 'vendor'), 'runtime-package']);
  return { root, manifest, lock };
}

async function bundle(root, extraEnv = {}) {
  try {
    const result = await execute(process.execPath, ['scripts/release/build-server-bundle.js'], {
      cwd: root, timeout: 60_000,
      env: { ...process.env, CLOUDCLI_BUNDLE_PLATFORM: process.platform, CLOUDCLI_BUNDLE_ARCH: process.arch, ...extraEnv },
    });
    return { ...result, code: 0 };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

async function extract(root, directory = 'extracted') {
  const filename = `chisacloudcode-local-server-1.0.0-${label}-${process.arch}.tar.gz`;
  const archive = path.join(root, 'release/local-server', filename);
  const output = path.join(root, directory);
  await fs.mkdir(output, { recursive: true });
  await execute('tar', ['-xzf', archive, '-C', output]);
  return { archive, output, filename };
}

test('bundle rejects cross-platform labeling before altering an existing stage', async (t) => {
  const { root } = await fixture(t);
  const stage = `release/local-server/.stage-1.0.0-${otherPlatform === 'linux' ? 'linux' : 'win'}-${process.arch}`;
  await put(root, `${stage}/sentinel.txt`, 'must survive invalid target');
  const result = await bundle(root, { CLOUDCLI_BUNDLE_PLATFORM: otherPlatform });
  assert.notEqual(result.code, 0, JSON.stringify(result));
  assert.match(result.stderr, /cross.target|native host/i);
  assert.equal(await fs.readFile(path.join(root, stage, 'sentinel.txt'), 'utf8'), 'must survive invalid target');
});

test('native bundle preserves local dependency inputs, recovery helper and unchanged lockfile', async (t) => {
  const { root, manifest } = await fixture(t);
  const result = await bundle(root);
  assert.equal(result.code, 0, JSON.stringify(result));
  const { archive, output, filename } = await extract(root);
  for (const relative of [
    'dist/index.html', 'dist-server/server/index.js', 'public/asset.txt', 'shared/runtime.js', 'LICENSE', 'README.md',
    'scripts/fix-node-pty.js', 'scripts/promote-dist-server.mjs', 'vendor/bundle-dev-fixture-1.0.0.tgz',
    'vendor/bundle-runtime-fixture-1.0.0.tgz',
    'vendor/bundle-dev-fixture/LICENSE', 'vendor/bundle-dev-fixture/CHISA-PATCH.md',
  ]) {
    assert.deepEqual(await fs.readFile(path.join(output, relative)), await fs.readFile(path.join(root, relative)), relative);
  }
  assert.deepEqual(await fs.readFile(path.join(output, 'package-lock.json')), await fs.readFile(path.join(root, 'package-lock.json')));
  const staged = JSON.parse(await fs.readFile(path.join(output, 'package.json'), 'utf8'));
  assert.deepEqual(staged.devDependencies, manifest.devDependencies);
  for (const hook of ['prepare', 'postinstall', 'prepublishOnly']) assert.equal(staged.scripts[hook], undefined);
  assert.equal(staged.scripts.preserver, manifest.scripts.preserver);
  assert.equal(staged.scripts.server, manifest.scripts.server);
  assert.match(result.stdout, /fixture pty fix executed/);
  const entered = await execute(process.execPath, [await resolveNpmCli(), 'run', 'server'], { cwd: output, timeout: 10_000 });
  assert.match(entered.stdout, /fixture server entered/);
  const metadata = JSON.parse(await fs.readFile(path.join(output, '.installed.json'), 'utf8'));
  assert.equal(metadata.platform, label);
  assert.equal(metadata.arch, process.arch);
  assert.equal(metadata.version, manifest.version);
  assert.ok(Number.isFinite(Date.parse(metadata.builtAt)));
  await assert.rejects(fs.access(path.join(output, 'node_modules/bundle-dev-fixture')));
  const installedNative = JSON.parse(await fs.readFile(path.join(output, 'node_modules/bundle-runtime-fixture/installed-native.json'), 'utf8'));
  assert.deepEqual(installedNative, { platform: process.platform, arch: process.arch });
  const checksum = crypto.createHash('sha256').update(await fs.readFile(archive)).digest('hex');
  assert.equal(await fs.readFile(`${archive}.sha256`, 'utf8'), `${checksum}  ${filename}\n`);
  await assert.rejects(fs.access(path.join(root, 'release/local-server', `.stage-1.0.0-${label}-${process.arch}`)));
});

test('repeating the same fixture bundle reconstructs the same payload and complete local inputs', async (t) => {
  const { root } = await fixture(t);
  const snapshot = async (directory, relative = '') => {
    const hashes = {};
    for (const entry of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) Object.assign(hashes, await snapshot(directory, name));
      else if (name !== '.installed.json') hashes[name] = crypto.createHash('sha256').update(await fs.readFile(path.join(directory, name))).digest('hex');
    }
    return hashes;
  };
  const first = await bundle(root);
  assert.equal(first.code, 0, JSON.stringify(first));
  const firstPayload = await extract(root, 'first-extracted');
  const firstHashes = await snapshot(firstPayload.output);
  const second = await bundle(root);
  assert.equal(second.code, 0, JSON.stringify(second));
  const secondPayload = await extract(root, 'second-extracted');
  assert.deepEqual(await snapshot(secondPayload.output), firstHashes);
});

test('bundle rejects cross-architecture and unsupported labels before writing output', async (t) => {
  const { root } = await fixture(t);
  for (const env of [
    { CLOUDCLI_BUNDLE_ARCH: process.arch === 'x64' ? 'arm64' : 'x64' },
    { CLOUDCLI_BUNDLE_PLATFORM: 'freebsd' },
    { CLOUDCLI_BUNDLE_ARCH: 'ia32' },
  ]) {
    const result = await bundle(root, env);
    assert.notEqual(result.code, 0, JSON.stringify(result));
    assert.match(result.stderr, /cross-target|Unsupported server bundle target/);
    await assert.rejects(fs.access(path.join(root, 'release')));
  }
});

test('changed lifecycle hooks need review and never run inside the stage', async (t) => {
  const { root, manifest } = await fixture(t);
  manifest.scripts.postinstall = 'node unexpected-install.js';
  await put(root, 'package.json', JSON.stringify(manifest));
  await put(root, 'unexpected-install.js', 'throw Error("must not execute future hook");\n');
  const result = await bundle(root);
  assert.notEqual(result.code, 0, JSON.stringify(result));
  assert.match(result.stderr, /needs review of scripts.postinstall/);
  assert.doesNotMatch(result.stdout, /Installing production/);
  await assert.rejects(fs.access(path.join(root, 'release')));
});

test('missing local dev tarball rejects before npm ci instead of weakening dependency metadata', async (t) => {
  const { root } = await fixture(t);
  const archive = path.join(root, 'vendor/bundle-dev-fixture-1.0.0.tgz');
  await fs.unlink(archive);
  const before = await fs.readFile(path.join(root, 'package-lock.json'));
  const result = await bundle(root);
  assert.notEqual(result.code, 0, JSON.stringify(result));
  assert.match(result.stderr, /Required server bundle input is missing: vendor\/bundle-dev-fixture-1.0.0.tgz/);
  assert.doesNotMatch(result.stdout, /Installing production/);
  assert.deepEqual(await fs.readFile(path.join(root, 'package-lock.json')), before);
});

test('missing built input or runtime recovery helper cannot produce a successful archive', async (t) => {
  for (const missing of ['dist/index.html', 'scripts/promote-dist-server.mjs']) {
    const { root } = await fixture(t);
    const target = path.join(root, missing);
    if (missing.startsWith('dist/')) await fs.rename(path.join(root, 'dist'), path.join(root, 'dist.unbuilt'));
    else await fs.unlink(target);
    const result = await bundle(root);
    assert.notEqual(result.code, 0, JSON.stringify(result));
    assert.match(result.stderr, /Required server bundle input is missing/);
    assert.doesNotMatch(result.stdout, /Installing production/);
    await assert.rejects(fs.access(path.join(root, 'release/local-server', `chisacloudcode-local-server-1.0.0-${label}-${process.arch}.tar.gz`)));
  }
});

test('npm lifecycle failure remains a failure and no archive is announced', async (t) => {
  const { root, manifest } = await fixture(t);
  manifest.scripts.preinstall = 'node fail-install.cjs';
  await put(root, 'package.json', JSON.stringify(manifest));
  // This file is an explicit local runtime input, not an inherited root hook.
  await put(root, 'shared/fail-install.cjs', 'console.error("fixture install failed deliberately");process.exit(7);\n');
  manifest.scripts.preinstall = 'node shared/fail-install.cjs';
  await put(root, 'package.json', JSON.stringify(manifest));
  const result = await bundle(root);
  assert.notEqual(result.code, 0, JSON.stringify(result));
  assert.match(result.stderr, /fixture install failed deliberately/);
  assert.match(result.stderr, /exited with code 7/);
  assert.doesNotMatch(result.stdout, /Wrote release/);
});
