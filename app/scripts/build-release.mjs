import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { binaryPath } from 'mygo-cli';
import configuration from '../mygo.config.ts';
import { nsisEnvironment, resolveTrustedNsis, verifyNsisTree } from './nsis-integrity.mjs';

const app = fileURLToPath(new URL('../', import.meta.url));
const frontend = fileURLToPath(new URL('../../cloudcli-ui/', import.meta.url));
const args = process.argv.slice(2);
const option = flag => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
const out = path.resolve(app, option('--out') || 'build/release-candidate');
const stage = mkdtempSync(path.join(os.tmpdir(), 'chisa-native-release-'));
const run = (executable, values, cwd = app, extra = {}) => {
  const result = spawnSync(executable, values, { cwd, stdio: 'inherit', windowsHide: true, ...extra });
  if (result.error || result.status !== 0) throw result.error || new Error(`${path.basename(executable)} failed (${result.status ?? result.signal})`);
};
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
try {
  // MyGo 0.1.22 also runs makensis internally. Verify and pin that first
  // invocation before any build command can reach its PATH/cache discovery.
  const trustedNsis = process.platform === 'win32' ? resolveTrustedNsis() : undefined;
  const nativeEnv = trustedNsis ? nsisEnvironment(trustedNsis.root) : process.env;
  if (trustedNsis) {
    // Go 1.27 uses APPDATA/go/telemetry even during compilation. Keep its
    // documented internal directory override outside the immutable NSIS tree;
    // disabling counters here must not change the user's global Go settings.
    const telemetry = path.join(stage, 'go-telemetry');
    mkdirSync(telemetry);
    writeFileSync(path.join(telemetry, 'mode'), 'off\n');
    for (const key of Object.keys(nativeEnv)) if (['test_telemetry_dir', 'goenv'].includes(key.toLowerCase())) delete nativeEnv[key];
    nativeEnv.TEST_TELEMETRY_DIR = telemetry;
    nativeEnv.GOENV = 'off';
  }
  // Node loads the existing typed config directly. The isolated JSON staging
  // avoids Bun config-loader failures without renaming the user's config or
  // changing source midway through a build.
  run(process.execPath, [path.join(frontend, 'node_modules/typescript/bin/tsc'), '--noEmit', '-p', path.join(frontend, 'tsconfig.json')]);
  run(process.execPath, [path.join(app, 'scripts/build-frontend.mjs')]);
  const sources = readdirSync(app).filter(name => name.endsWith('.go') && !name.endsWith('_test.go')).sort();
  for (const file of [...sources, 'go.mod', 'go.sum']) cpSync(path.join(app, file), path.join(stage, file));
  mkdirSync(path.join(stage, 'resources'), { recursive: true });
  // Distribution inputs are explicit. Runtime journals or test artifacts must
  // never be picked up just because they were created beside the helper.
  for (const file of ['icon.png', 'service.json', 'ssh-workspace.ps1']) cpSync(path.join(app, 'resources', file), path.join(stage, 'resources', file));
  const sourceHashes = Object.fromEntries([...sources, 'go.mod', 'go.sum', 'resources/ssh-workspace.ps1'].map(file => [file, hash(path.join(app, file))]));
  const config = { ...configuration, buildCommand: '', frontendDist: path.join(frontend, 'dist'), bindings: 'generated/chisa.ts', out };
  writeFileSync(path.join(stage, 'mygo.json'), JSON.stringify(config));
  const values = ['build', '-skip-build-command', '-o', out];
  if (args.includes('--debug')) values.push('-debug');
  if (trustedNsis) verifyNsisTree(trustedNsis.compiler);
  run(binaryPath(), values, stage, { env: nativeEnv });
  if (process.platform === 'win32') run(process.execPath, [path.join(app, 'scripts/build-installer.mjs'), '--stage', path.join(out, 'windows-amd64')], app, { env: nativeEnv });
  if (trustedNsis) verifyNsisTree(trustedNsis.compiler);
  const executable = path.join(out, `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch === 'x64' ? 'amd64' : process.arch}`, configuration.name + (process.platform === 'win32' ? '.exe' : ''));
  if (!existsSync(executable)) throw new Error('Native build did not produce the expected executable');
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, 'build-receipt.json'), JSON.stringify({ builtAt: new Date().toISOString(), version: configuration.version,
    buildIdentity: readFileSync(path.join(app, 'build_identity_generated.go'), 'utf8'), debug: args.includes('--debug'), executable,
    executableSha256: hash(executable), sourceHashes, frontendIndexSha256: hash(path.join(frontend, 'dist/index.html')),
    ...(trustedNsis ? { nsis: { version: trustedNsis.version, archiveSha256: trustedNsis.archiveSha256, fileCount: trustedNsis.fileCount, source: trustedNsis.source, compilerSha256: hash(trustedNsis.compiler), upstreamSelection: 'verified Bin first on PATH; NSISDIR/NSISCONFDIR fixed root; APPDATA/HOME fixed verified Bin without user config', guardedInstaller: '/NOCONFIG' } } : {}) }, null, 2));
  console.log(`Build receipt: ${path.join(out, 'build-receipt.json')}`);
} finally {
  // stage is the exact newly allocated temp root, never a user-supplied path.
  if (!path.basename(stage).startsWith('chisa-native-release-') || path.dirname(stage) !== os.tmpdir()) throw new Error('Unexpected release staging directory');
  rmSync(stage, { recursive: true, force: true });
}
