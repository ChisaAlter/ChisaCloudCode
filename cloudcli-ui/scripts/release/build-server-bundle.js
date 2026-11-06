#!/usr/bin/env node
import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const platformLabels = { darwin: 'mac', mac: 'mac', win32: 'win', win: 'win', linux: 'linux' };
const packagingHooks = {
  prepare: 'husky',
  postinstall: 'node scripts/fix-node-pty.js',
  prepublishOnly: 'npm run build',
};

export function selectBundleTarget(env = process.env, host = process) {
  const platform = platformLabels[env.CLOUDCLI_BUNDLE_PLATFORM || host.platform];
  const nativePlatform = platformLabels[host.platform];
  const arch = env.CLOUDCLI_BUNDLE_ARCH || host.arch;
  if (!platform || !nativePlatform || !['x64', 'arm64'].includes(arch) || !['x64', 'arm64'].includes(host.arch)) {
    throw new Error('Unsupported server bundle target; supported native hosts are linux/mac/win on x64/arm64.');
  }
  if (platform !== nativePlatform || arch !== host.arch) {
    throw new Error(`Server bundle cross-target packaging is unsupported: use a native host for ${platform}-${arch} (current host: ${nativePlatform}-${host.arch}).`);
  }
  return { platform, arch };
}

export function serverPackageJson(packageJson) {
  const staged = { ...packageJson, scripts: { ...(packageJson.scripts || {}) } };
  // Only these reviewed build/checkout hooks are replaced in a prebuilt bundle.
  // The postinstall permission fix is explicitly run after npm ci instead; do
  // not silently discard a new lifecycle hook when the source manifest changes.
  for (const [hook, expected] of Object.entries(packagingHooks)) {
    if (staged.scripts[hook] !== undefined && staged.scripts[hook] !== expected) {
      throw new Error(`Server bundle needs review of scripts.${hook}: expected ${JSON.stringify(expected)}.`);
    }
    delete staged.scripts[hook];
  }
  return staged;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: 'inherit', shell: false });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited with ${signal ? `signal ${signal}` : `code ${code}`}`));
    });
  });
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function resolveNpmCli(env = process.env) {
  // npm.cmd needs cmd.exe on Windows. Locate its JS entrypoint and run it with
  // this Node executable, so spaces and shell metacharacters remain path text.
  const bins = [path.dirname(process.execPath), ...(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)];
  const candidates = [env.npm_execpath];
  for (const bin of bins) {
    candidates.push(path.join(bin, 'node_modules/npm/bin/npm-cli.js'));
    candidates.push(path.resolve(bin, '../lib/node_modules/npm/bin/npm-cli.js'));
    try {
      candidates.push(await fs.realpath(path.join(bin, 'npm')));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  for (const candidate of candidates) {
    if (candidate && path.basename(candidate) === 'npm-cli.js' && await pathExists(candidate)) return candidate;
  }
  throw new Error('Cannot locate npm-cli.js; run through npm run server:bundle or install npm alongside Node/on PATH.');
}

function localInputPath(spec) {
  const relative = spec.slice('file:'.length);
  if (!relative || path.isAbsolute(relative) || /^[a-z]:/i.test(relative) || relative.includes('\\') || relative.split('/').includes('..')) {
    throw new Error(`Server bundle local dependency must be a project-relative file: ${spec}`);
  }
  const normalized = path.posix.normalize(relative);
  if (normalized === '.' || ['node_modules', 'release', '.git'].includes(normalized.split('/')[0])) {
    throw new Error(`Unsupported server bundle local dependency input: ${spec}`);
  }
  return normalized;
}

export function localDependencyInputs(packageJson, lockJson) {
  const inputs = new Set();
  // npm still resolves a complete lock graph with --omit=dev. Preserve its
  // local inputs, including dev-only tarballs, without changing the manifest
  // or lock to hide a missing dependency.
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    for (const spec of Object.values(packageJson[field] || {})) {
      if (typeof spec === 'string' && spec.startsWith('file:')) inputs.add(localInputPath(spec));
    }
  }
  for (const entry of Object.values(lockJson.packages || {})) {
    if (typeof entry.resolved === 'string' && entry.resolved.startsWith('file:')) inputs.add(localInputPath(entry.resolved));
  }
  // Published companion source contains the license and patch provenance for a
  // vendored archive. Include only explicitly published vendor inputs, never
  // a catch-all copy of the checkout or its dependency/install directories.
  for (const entry of packageJson.files || []) {
    if (typeof entry === 'string' && entry.startsWith('vendor/') && !/[!*?\[\]{}]/.test(entry)) {
      inputs.add(localInputPath(`file:${entry}`));
    }
  }
  return [...inputs].sort();
}

async function copyRequired(sourceRoot, stageDir, relativePath) {
  const from = path.join(sourceRoot, relativePath);
  if (!(await pathExists(from))) throw new Error(`Required server bundle input is missing: ${relativePath}`);
  await fs.cp(from, path.join(stageDir, relativePath), { recursive: true });
}

function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

export async function buildServerBundle(sourceRoot = rootDir) {
  // Refuse relabeling before deleting or writing any staging/release paths:
  // npm ci and native install scripts always run on the current host.
  const { platform, arch } = selectBundleTarget();
  const packageJson = JSON.parse(await fs.readFile(path.join(sourceRoot, 'package.json'), 'utf8'));
  const stagedPackageJson = serverPackageJson(packageJson);
  const lockJson = JSON.parse(await fs.readFile(path.join(sourceRoot, 'package-lock.json'), 'utf8'));
  const localInputs = localDependencyInputs(packageJson, lockJson);
  const npmCli = await resolveNpmCli();
  const version = packageJson.version;
  const bundleName = `chisacloudcode-local-server-${version}-${platform}-${arch}.tar.gz`;
  const bundleRoot = path.join(sourceRoot, 'release', 'local-server');
  const stageDir = path.join(bundleRoot, `.stage-${version}-${platform}-${arch}`);
  const archivePath = path.join(bundleRoot, bundleName);

  await fs.rm(stageDir, { recursive: true, force: true });
  await fs.mkdir(stageDir, { recursive: true });
  for (const input of ['dist', 'dist-server', 'public', 'shared', 'package-lock.json', 'LICENSE', 'README.md', ...localInputs]) {
    await copyRequired(sourceRoot, stageDir, input);
  }
  // npm run server invokes this recovery hook before the compiled entrypoint.
  if (packageJson.scripts?.preserver) {
    if (packageJson.scripts.preserver !== 'node scripts/promote-dist-server.mjs recover') {
      throw new Error('Server bundle needs review of scripts.preserver and its runtime inputs.');
    }
    await copyRequired(sourceRoot, stageDir, 'scripts/promote-dist-server.mjs');
  }
  const ptyFix = 'scripts/fix-node-pty.js';
  if (packageJson.scripts?.postinstall || await pathExists(path.join(sourceRoot, ptyFix))) {
    await copyRequired(sourceRoot, stageDir, ptyFix);
  }
  await fs.writeFile(path.join(stageDir, 'package.json'), `${JSON.stringify(stagedPackageJson, null, 2)}\n`, 'utf8');

  console.log('Installing production server dependencies into bundle stage...');
  await run(process.execPath, [npmCli, 'ci', '--omit=dev'], {
    cwd: stageDir,
    env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false' },
  });
  if (await pathExists(path.join(stageDir, ptyFix))) await run(process.execPath, [ptyFix], { cwd: stageDir });

  await fs.writeFile(
    path.join(stageDir, '.installed.json'),
    JSON.stringify({ version, platform, arch, builtAt: new Date().toISOString() }, null, 2),
    'utf8',
  );
  await fs.rm(archivePath, { force: true });
  await run('tar', ['-czf', archivePath, '-C', stageDir, '.']);
  const digest = await sha256(archivePath);
  const checksumPath = `${archivePath}.sha256`;
  await fs.writeFile(checksumPath, `${digest}  ${bundleName}\n`, 'utf8');
  await fs.rm(stageDir, { recursive: true, force: true });
  const size = (await fs.stat(archivePath)).size / 1024 / 1024;
  console.log(`Wrote ${path.relative(sourceRoot, archivePath)} (${size.toFixed(1)} MB)`);
  console.log(`Wrote ${path.relative(sourceRoot, checksumPath)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildServerBundle();
}
