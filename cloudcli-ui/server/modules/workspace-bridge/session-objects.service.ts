import { spawn } from 'node:child_process';
import { chownSync, createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { link, open, readFile, rm, stat } from 'node:fs/promises';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { inflateSync } from 'node:zlib';

import { AppError } from '@/shared/index.js';

function invalid(message: string) { return new AppError(message, { code: 'WORKSPACE_GIT_OBJECT_INVALID', statusCode: 409 }); }
function canonicalDirectory(directory: string): void {
  const existed = existsSync(directory);
  mkdirSync(directory, { recursive: true });
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink() || realpathSync(directory) !== directory) throw invalid('The private Git object directory is not canonical');
  // Only newly created object/private directories inherit their parent owner.
  // Existing source fanouts and unrelated Git metadata are never chowned.
  if (!existed && process.platform !== 'win32' && process.getuid?.() === 0) { const parent = lstatSync(path.dirname(directory)); chownSync(directory, parent.uid, parent.gid); }
}
function canonicalFile(filename: string): void {
  if (!lstatSync(filename).isFile() || lstatSync(filename).isSymbolicLink() || realpathSync(filename) !== filename) throw invalid('The private Git object file is not canonical');
}
async function git(args: string[], env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    const child = spawn('git', ['-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', ...args], { env: { ...inherited, GIT_CONFIG_NOSYSTEM: '1', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, signal: AbortSignal.timeout(600_000), killSignal: 'SIGKILL' });
    let stdout = ''; let stderr = ''; let failure: Error | undefined;
    child.stdout.on('data', chunk => { if (stdout.length < 65_536) stdout += chunk.toString().slice(0, 65_536 - stdout.length); });
    child.stderr.on('data', chunk => { if (stderr.length < 65_536) stderr += chunk.toString().slice(0, 65_536 - stderr.length); });
    child.once('error', error => { failure = error; });
    child.once('close', code => failure ? reject(failure) : code !== 0 ? reject(invalid('The private Git object pack failed verification: ' + stderr.trim())) : resolve(stdout.trim()));
  });
}

/** Shared and isolated launchers quarantine object writes while keeping the actual common ODB read-only in the sandbox. */
export function sharedSessionGitRuntime(root: string, leaseDirectory: string, readOnly: boolean, buffered = false) {
  const common = path.join(root, '.git');
  if (!existsSync(common)) return undefined;
  if (!lstatSync(common).isDirectory() || lstatSync(common).isSymbolicLink() || realpathSync(common) !== common) throw invalid('Shared Git object quarantine requires a canonical Git directory');
  if (leaseDirectory !== root + '.chisa-lease' || realpathSync(leaseDirectory) !== leaseDirectory) throw invalid('Shared Git object quarantine requires the exact execution lease');
  const originalLease = JSON.parse(readFileSync(path.join(leaseDirectory, 'state.json'), 'utf8')) as { id?: unknown; epoch?: unknown; owner?: unknown };
  const privateGit = path.join(leaseDirectory, 'git-runtime');
  canonicalDirectory(privateGit);
  if (process.platform !== 'win32' && process.getuid?.() === 0) chownSync(privateGit, 1000, 1000);
  const identity = [common, path.join(common, 'objects'), leaseDirectory, privateGit].map(filename => { const stats = lstatSync(filename); return { filename, dev: stats.dev, ino: stats.ino }; });
  const assertIdentity = () => {
    for (const original of identity) { const stats = lstatSync(original.filename); if (realpathSync(original.filename) !== original.filename || !stats.isDirectory() || stats.dev !== original.dev || stats.ino !== original.ino) throw invalid('The shared Git object quarantine changed during execution'); }
    const current = JSON.parse(readFileSync(path.join(leaseDirectory, 'state.json'), 'utf8')) as { id?: unknown; epoch?: unknown; owner?: unknown };
    if (!originalLease.id || !originalLease.epoch || !originalLease.owner || current.id !== originalLease.id || current.epoch !== originalLease.epoch || current.owner !== originalLease.owner) throw invalid('The shared Git object lease changed during publication');
  };
  const store = isolatedSessionObjects(common, privateGit, assertIdentity);
  const objectIdentity = lstatSync(store.directory);
  identity.push({ filename: store.directory, dev: objectIdentity.dev, ino: objectIdentity.ino });
  const volume = (source: string, target: string, writable: boolean) => ['--volume', `${source}:${target}:${writable && !readOnly ? 'rw' : 'ro'}`];
  return {
    mounts: [...volume(store.base, store.base, false), ...(buffered ? volume(store.base, '/workspace/.git/objects', false) : []), ...volume(store.directory, store.directory, true)],
    environment: store.environment,
    async publish() {
      assertIdentity();
      await store.publish();
    },
  };
}

/** Snapshot mounts keep the common ODB read-only; only this persistent session quarantine receives Git writes. */
export function isolatedSessionObjects(common: string, gitdir: string, assertPublication: () => void = () => {}) {
  const base = path.join(common, 'objects');
  canonicalDirectory(base);
  if (existsSync(path.join(base, 'info', 'alternates'))) throw invalid('Git object alternates require an explicit safe mapping');
  const directory = path.join(gitdir, 'chisa-objects');
  canonicalDirectory(directory);
  canonicalDirectory(path.join(directory, 'info'));
  canonicalDirectory(path.join(directory, 'pack'));
  // No alternate file from task-controlled storage is read by the host verifier.
  if (existsSync(path.join(directory, 'info', 'alternates'))) throw invalid('A private object database cannot add external alternates');
  const environment = { GIT_OBJECT_DIRECTORY: directory, GIT_ALTERNATE_OBJECT_DIRECTORIES: base };
  const owner = lstatSync(gitdir);
  if (process.platform !== 'win32' && process.getuid?.() === 0) for (const owned of [directory, path.join(directory, 'info'), path.join(directory, 'pack')]) chownSync(owned, owner.uid, owner.gid);
  const mount = `${directory}:${directory}:rw`;
  return {
    directory, base, environment, mount,
    async publish(): Promise<void> {
      assertPublication();
      const format = await git(['--git-dir=' + common, 'rev-parse', '--show-object-format=storage'], { ...environment, GIT_NO_REPLACE_OBJECTS: '1' });
      if (format !== 'sha1' && format !== 'sha256') throw invalid('Unsupported Git object format');
      const oidLength = format === 'sha256' ? 64 : 40;
      canonicalDirectory(directory); canonicalDirectory(base);
      if (existsSync(path.join(directory, 'info', 'alternates'))) throw invalid('Private Git alternates changed during execution');
      for (const name of readdirSync(directory)) {
        if (name === 'pack' || name === 'info') continue;
        if (!/^[a-f0-9]{2}$/.test(name)) throw invalid('Unexpected file in private Git object storage');
        const prefix = path.join(directory, name); canonicalDirectory(prefix);
        for (const suffix of readdirSync(prefix)) {
          if (!new RegExp(`^[a-f0-9]{${oidLength - 2}}$`).test(suffix)) throw invalid('Unexpected loose Git object name');
          const filename = path.join(prefix, suffix); canonicalFile(filename);
          if ((await stat(filename)).size > 260 * 1024 * 1024) throw invalid('A private loose Git object exceeds the verification budget; retain the session and pack it before retrying');
          const bytes = await readFile(filename);
          let object: Buffer;
          try { object = inflateSync(bytes, { maxOutputLength: 256 * 1024 * 1024 }); } catch { throw invalid('A private loose Git object is not valid compressed data'); }
          const separator = object.indexOf(0);
          const header = separator >= 0 ? object.subarray(0, separator).toString('ascii') : '';
          const fields = /^(blob|tree|commit|tag) (0|[1-9][0-9]*)$/.exec(header);
          if (!fields || Number(fields[2]) !== object.length - separator - 1 || createHash(format).update(object).digest('hex') !== name + suffix) throw invalid('A private loose Git object does not match its immutable identity');
          const destination = path.join(base, name, suffix);
          if (existsSync(destination)) {
            canonicalFile(destination);
            let existing: Buffer;
            try { existing = inflateSync(await readFile(destination), { maxOutputLength: 256 * 1024 * 1024 }); } catch { throw invalid('An existing immutable Git object is invalid'); }
            if (createHash(format).update(existing).digest('hex') !== name + suffix || !existing.equals(object)) throw invalid('An existing immutable Git object has a different logical identity');
          } else await publishBytes(bytes, destination, object, assertPublication);
        }
      }
      const packDirectory = path.join(directory, 'pack'); canonicalDirectory(packDirectory);
      for (const name of readdirSync(packDirectory)) {
        if (!name.endsWith('.pack')) continue;
        const match = new RegExp(`^pack-([a-f0-9]{${oidLength}})\\.pack$`).exec(name);
        if (!match) throw invalid('Unexpected packed Git object name');
        const filename = path.join(packDirectory, name); canonicalFile(filename);
        const verifyRoot = path.join(gitdir, 'chisa-object-verify-' + randomUUID());
        canonicalDirectory(verifyRoot);
        if (path.dirname(verifyRoot) !== gitdir || !path.basename(verifyRoot).startsWith('chisa-object-verify-')) throw invalid('Invalid Git object verification cleanup path');
        const index = path.join(verifyRoot, 'pack.idx');
        try {
          const checksum = await git(['--git-dir=' + common, 'index-pack', '--strict', '--index-version=2', '-o', index, filename], { ...environment, GIT_NO_REPLACE_OBJECTS: '1' });
          if (checksum !== match[1]) throw invalid('The private pack checksum does not match its name');
          canonicalFile(index);
          // Stream the verified pack into a fresh immutable inode. Large repo
          // repacks must not duplicate a complete pack in Node's heap.
          await publishPack(filename, path.join(base, 'pack', name), match[1]!, format, assertPublication);
          await publishBytes(await readFile(index), path.join(base, 'pack', name.replace(/\.pack$/, '.idx')), undefined, assertPublication);
        } finally {
          await rm(verifyRoot, { recursive: true, force: true });
        }
      }
    },
  };
}

async function publishBytes(bytes: Buffer, destination: string, looseObject?: Buffer, assertPublication: () => void = () => {}): Promise<void> {
  const matches = (existing: Buffer) => {
    if (existing.equals(bytes)) return true;
    if (!looseObject) return false;
    try { return inflateSync(existing, { maxOutputLength: 256 * 1024 * 1024 }).equals(looseObject); } catch { return false; }
  };
  assertPublication();
  canonicalDirectory(path.dirname(destination));
  if (existsSync(destination)) {
    canonicalFile(destination);
    if (!matches(await readFile(destination))) throw invalid('An existing immutable Git object has different bytes');
    return;
  }
  const temporary = path.join(path.dirname(destination), '.chisa-object-' + randomUUID());
  if (path.dirname(temporary) !== path.dirname(destination) || !path.basename(temporary).startsWith('.chisa-object-')) throw invalid('Invalid Git object publication cleanup path');
  const descriptor = await open(temporary, 'wx', 0o444);
  try {
    await descriptor.writeFile(bytes); await descriptor.sync(); await descriptor.close();
    assertPublication();
    try { await link(temporary, destination); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      canonicalFile(destination);
      if (!matches(await readFile(destination))) throw invalid('A concurrent immutable Git object has different bytes');
    }
  } finally {
    await descriptor.close().catch(() => {});
    await rm(temporary, { force: true });
  }
}


async function packIdentity(filename: string, expected: string, algorithm: string): Promise<void> {
  canonicalFile(filename);
  const details = await stat(filename);
  const checksumLength = expected.length / 2;
  if (details.size <= checksumLength) throw invalid('The Git pack is incomplete');
  const checksum = createHash(algorithm);
  for await (const chunk of createReadStream(filename, { start: 0, end: details.size - checksumLength - 1 })) checksum.update(chunk);
  const descriptor = await open(filename, 'r');
  try {
    const trailer = Buffer.alloc(checksumLength);
    await descriptor.read(trailer, 0, checksumLength, details.size - checksumLength);
    if (trailer.toString('hex') !== expected || checksum.digest('hex') !== expected) throw invalid('The private Git pack changed after verification');
  } finally { await descriptor.close(); }
}

async function publishPack(source: string, destination: string, expected: string, algorithm: string, assertPublication: () => void = () => {}): Promise<void> {
  await packIdentity(source, expected, algorithm);
  assertPublication();
  canonicalDirectory(path.dirname(destination));
  if (existsSync(destination)) { await packIdentity(destination, expected, algorithm); return; }
  const temporary = path.join(path.dirname(destination), '.chisa-object-' + randomUUID());
  if (path.dirname(temporary) !== path.dirname(destination) || !path.basename(temporary).startsWith('.chisa-object-')) throw invalid('Invalid Git object publication cleanup path');
  const descriptor = await open(temporary, 'wx', 0o444);
  try {
    await pipeline(createReadStream(source), new Writable({ write(chunk: Buffer, _encoding, done) { void (async () => { let offset = 0; while (offset < chunk.length) { const result = await descriptor.write(chunk, offset, chunk.length - offset); if (!result.bytesWritten) throw invalid('Git pack publication stopped before the file was complete'); offset += result.bytesWritten; } })().then(() => done(), done); } }));
    await descriptor.sync(); await descriptor.close();
    await packIdentity(temporary, expected, algorithm);
    assertPublication();
    try { await link(temporary, destination); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await packIdentity(destination, expected, algorithm);
    }
  } finally {
    await descriptor.close().catch(() => {});
    await rm(temporary, { force: true });
  }
}
