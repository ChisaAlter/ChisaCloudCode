import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, copyFileSync, chmodSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AppError } from '@/shared/index.js';

const require = createRequire(import.meta.url);
const CODE = '/runtime/provider-code';
let prepared: { source: string; target: string; writable: boolean } | undefined;
function unavailable(message: string): never { throw new AppError(message, { code: 'WORKSPACE_PROVIDER_RUNTIME_UNAVAILABLE', statusCode: 503 }); }
function safeDirectory(directory: string, mode = 0o700) {
  let existing = path.resolve(directory);
  while (!existsSync(existing)) { const parent = path.dirname(existing); if (parent === existing) break; existing = parent; }
  if (realpathSync(existing) !== existing || !lstatSync(existing).isDirectory() || lstatSync(existing).isSymbolicLink()) unavailable('The provider runtime cache has a noncanonical parent directory.');
  mkdirSync(directory, { recursive: true, mode });
  if (realpathSync(directory) !== path.resolve(directory) || !lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) unavailable('The shared provider runtime cache is not a canonical directory.');
}
function packageRoot(name: string, from: string) {
  const resolver = createRequire(path.join(from, '__provider_package__.cjs'));
  let entry: string;
  try { entry = resolver.resolve(`${name}/package.json`); }
  catch {
    try { entry = resolver.resolve(name); }
    catch {
      const installed = (resolver.resolve.paths(name) ?? []).map((base) => path.join(base, name, 'package.json')).find((manifest) => existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === name);
      if (!installed) return null;
      entry = installed;
    }
  }
  let directory = path.dirname(realpathSync(entry));
  while (true) {
    const manifest = path.join(directory, 'package.json');
    if (existsSync(manifest)) {
      const installed = JSON.parse(readFileSync(manifest, 'utf8'));
      const architecture = name === '@openai/codex-linux-x64' ? 'x64' : name === '@openai/codex-linux-arm64' ? 'arm64' : null;
      const nativeAlias = architecture && installed.name === '@openai/codex' && installed.os?.includes('linux') && installed.cpu?.includes(architecture) && typeof installed.version === 'string' && installed.version.endsWith(`-linux-${architecture}`);
      if (installed.name === name || nativeAlias) return directory;
    }
    const parent = path.dirname(directory); if (parent === directory) return null; directory = parent;
  }
}
function copyTree(source: string, destination: string, budget: { files: number; bytes: number }, includeNodeModules = false) {
  const stats = lstatSync(source);
  if (stats.isSymbolicLink() || (!stats.isDirectory() && !stats.isFile())) unavailable('Provider runtime packages must contain regular files and directories.');
  if (stats.isDirectory()) {
    mkdirSync(destination, { recursive: true, mode: 0o755 });
    for (const name of readdirSync(source)) if ((includeNodeModules || name !== 'node_modules') && name !== '.git') copyTree(path.join(source, name), path.join(destination, name), budget, includeNodeModules);
  } else {
    budget.files += 1; budget.bytes += stats.size;
    if (budget.files > 30_000 || budget.bytes > 1024 * 1024 * 1024) unavailable('The provider runtime package exceeds the bounded cache size.');
    copyFileSync(source, destination); chmodSync(destination, stats.mode & 0o111 ? 0o755 : 0o644);
  }
}

/** Provider container composition stages executable code into shared HOME so Docker never binds an image-only path or the entire application. */
export function prepareProviderCodeCache() {
  if (prepared) return prepared;
  if (process.platform !== 'linux') unavailable('Bound VPS providers require the Linux workspace container runtime.');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const javascript = path.join(here, 'provider-process.worker.js');
  const worker = existsSync(javascript) ? javascript : path.join(here, 'provider-process.worker.ts');
  const roots = new Map<string, string>();
  const visit = (name: string, from: string) => {
    if (roots.has(name)) return;
    const root = packageRoot(name, from); if (!root) unavailable('A required provider worker runtime package is not installed.');
    roots.set(name, root);
    const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    for (const dependency of Object.keys(manifest.dependencies ?? {})) visit(dependency, root);
  };
  visit('cross-spawn', here); visit('@openai/codex-sdk', here);
  const native = `@openai/codex-linux-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
  const nativeRoot = packageRoot(native, here); if (nativeRoot) roots.set(native, nativeRoot);
  const workerContent = readFileSync(worker, 'utf8');
  const identity = createHash('sha256').update('provider-code-cache-v3').update(workerContent).update(process.version).update(process.arch);
  const executable = realpathSync(process.execPath); const nodeStats = statSync(executable);
  identity.update(`${nodeStats.size}:${nodeStats.mtimeMs}`);
  for (const [name, root] of roots) identity.update(name).update(readFileSync(path.join(root, 'package.json')));
  const parent = path.join(os.homedir(), '.cloudcli', 'provider-runtime', 'code'); safeDirectory(parent);
  const destination = path.join(parent, identity.digest('hex'));
  if (!existsSync(path.join(destination, 'ready.json'))) {
    const staging = destination + '.' + randomUUID(); safeDirectory(staging, 0o755);
    const budget = { files: 0, bytes: 0 };
    copyFileSync(executable, path.join(staging, 'node')); chmodSync(path.join(staging, 'node'), 0o755);
    mkdirSync(path.join(staging, 'app', 'node_modules'), { recursive: true, mode: 0o755 });
    mkdirSync(path.join(staging, 'cli'), { mode: 0o755 }); // Nested CLI bind target exists before the code root becomes read-only.
    writeFileSync(path.join(staging, 'app', 'package.json'), '{"type":"module"}\n', { mode: 0o644 });
    const code = worker.endsWith('.ts') ? (require('esbuild') as typeof import('esbuild')).transformSync(workerContent, { loader: 'ts', format: 'esm', target: 'node22' }).code : workerContent;
    writeFileSync(path.join(staging, 'app', 'provider-process.worker.js'), code, { mode: 0o644 });
    for (const [name, root] of roots) { const target = path.join(staging, 'app', 'node_modules', name); mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 }); copyTree(root, target, budget); }
    writeFileSync(path.join(staging, 'ready.json'), JSON.stringify({ node: process.version, files: budget.files, bytes: budget.bytes }), { mode: 0o644 });
    try { renameSync(staging, destination); } catch (error) { if (!existsSync(path.join(destination, 'ready.json'))) throw error; }
  }
  if (realpathSync(destination) !== destination || lstatSync(destination).isSymbolicLink()) unavailable('The provider runtime cache identity is not canonical.');
  prepared = { source: destination, target: CODE, writable: false }; return prepared;
}

/** Cursor/OpenCode composition stages only a canonical self-contained CLI install into the shared code cache; no system bin or HOME directory is mounted. */
export function stageProviderCli(executable: string) {
  const file = realpathSync(executable); const directory = path.dirname(file);
  const stats = statSync(file);
  const forbidden = new Set(['/', '/bin', '/sbin', '/usr/bin', '/usr/local/bin', os.homedir(), path.dirname(os.homedir())]);
  const single = forbidden.has(directory);
  if (single) { const header = readFileSync(file).subarray(0, 4); if (header[0] !== 0x7f || header.subarray(1).toString() !== 'ELF') unavailable('Provider CLI wrappers require a self-contained installation for sandbox execution.'); }
  const key = createHash('sha256').update('provider-cli-cache-v2').update(file).update(`${stats.size}:${stats.mtimeMs}`).digest('hex');
  const parent = path.join(os.homedir(), '.cloudcli', 'provider-runtime', 'cli'); safeDirectory(parent);
  const destination = path.join(parent, key);
  if (!existsSync(path.join(destination, 'ready.json'))) {
    const staging = destination + '.' + randomUUID(); safeDirectory(staging, 0o755);
    const budget = { files: 0, bytes: 0 };
    if (single) { copyFileSync(file, path.join(staging, path.basename(file))); chmodSync(path.join(staging, path.basename(file)), 0o755); }
    else for (const name of readdirSync(directory)) if (name !== '.git') copyTree(path.join(directory, name), path.join(staging, name), budget, true);
    writeFileSync(path.join(staging, 'ready.json'), '{}\n', { mode: 0o644 });
    try { renameSync(staging, destination); } catch (error) { if (!existsSync(path.join(destination, 'ready.json'))) throw error; }
  }
  const ready = path.join(destination, 'ready.json');
  if (realpathSync(destination) !== destination || !lstatSync(destination).isDirectory() || lstatSync(destination).isSymbolicLink() || realpathSync(ready) !== ready || !lstatSync(ready).isFile() || lstatSync(ready).isSymbolicLink()) unavailable('The cached provider CLI is not a canonical installed directory.');
  return { mount: { source: destination, target: `${CODE}/cli`, writable: false }, executable: `${CODE}/cli/${path.basename(file)}` };
}
