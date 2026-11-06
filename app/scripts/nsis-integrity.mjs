import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const NSIS_VERSION = '3.13';
export const NSIS_ARCHIVE_SHA256 = 'ba63dffc4410ee89193e1cb5a41989991bd77c61068da17e3156d136b7b0b3d8';
export const NSIS_MANIFEST_URL = new URL('../installer/nsis-3.13-integrity.json', import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fold = value => value.toLowerCase();

export function loadNsisManifest() {
  const manifest = JSON.parse(fs.readFileSync(NSIS_MANIFEST_URL, 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.version !== NSIS_VERSION || manifest.archive?.sha256 !== NSIS_ARCHIVE_SHA256) {
    throw new Error('Unsupported NSIS integrity manifest; regenerate it from the pinned official archive.');
  }
  return manifest;
}

// Pure discovery: never invoke a compiler, where.exe, a shell, or a downloader.
export function nsisCandidates(env = process.env, paths = path) {
  const values = Object.fromEntries(Object.entries(env).map(([key, value]) => [key.toLowerCase(), value]));
  const candidates = [];
  const add = (file, source) => { if (file && !candidates.some(row => fold(row.file) === fold(file))) candidates.push({ file, source }); };
  if (values.makensis) add(values.makensis, 'MAKENSIS');
  for (const directory of (values.path || '').split(paths.delimiter)) {
    const clean = directory.replace(/^"(.*)"$/, '$1').trim();
    if (clean) add(paths.join(clean, 'makensis.exe'), 'PATH');
  }
  for (const name of ['programfiles(x86)', 'programfiles']) if (values[name]) add(paths.join(values[name], 'NSIS', 'makensis.exe'), name);
  if (values.localappdata) {
    add(paths.join(values.localappdata, 'mygo', 'nsis-' + NSIS_VERSION, 'Bin', 'makensis.exe'), 'MyGo cache');
    add(paths.join(values.localappdata, 'mygo', 'nsis-' + NSIS_VERSION, 'makensis.exe'), 'MyGo cache');
  }
  return candidates;
}

export function verifyNsisTree(compiler, manifest = loadNsisManifest()) {
  const absolute = path.resolve(compiler);
  if (fold(path.basename(absolute)) !== 'makensis.exe') throw new Error('Expected makensis.exe in the official NSIS distribution.');
  const parent = path.dirname(absolute);
  const root = fold(path.basename(parent)) === 'bin' ? path.dirname(parent) : parent;
  const expected = new Map();
  const expectedDirectories = new Set();
  for (const [relative, sha256] of Object.entries(manifest.files || {})) {
    if (!relative || relative.includes('\\') || relative.split('/').some(piece => !piece || piece === '.' || piece === '..' || piece.includes(':')) || !/^[a-f0-9]{64}$/.test(sha256)) {
      throw new Error('Invalid NSIS manifest entry: ' + relative);
    }
    const key = fold(relative);
    if (expected.has(key)) throw new Error('Duplicate NSIS manifest entry: ' + relative);
    expected.set(key, sha256);
    const pieces = key.split('/');
    for (let count = 1; count < pieces.length; count++) expectedDirectories.add(pieces.slice(0, count).join('/'));
  }
  const compilerKey = fold(path.relative(root, absolute).split(path.sep).join('/'));
  if (!expected.has(compilerKey) || !expected.has('makensis.exe') || !expected.has('bin/makensis.exe')) throw new Error('NSIS manifest lacks the official compilers.');
  // Reject linked roots and parent junctions as well as linked descendants.
  for (let current = root; ; current = path.dirname(current)) {
    const status = fs.lstatSync(current);
    if (status.isSymbolicLink() || !status.isDirectory()) throw new Error('Linked or non-directory NSIS path: ' + current);
    if (fold(fs.realpathSync.native(current)) !== fold(path.resolve(current))) throw new Error('Redirected NSIS path: ' + current);
    if (path.dirname(current) === current) break;
  }
  const seen = new Set();
  function visit(directory, prefix = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? prefix + '/' + entry.name : entry.name;
      const key = fold(relative);
      const full = path.join(directory, entry.name);
      const status = fs.lstatSync(full);
      if (status.isSymbolicLink()) throw new Error('Linked NSIS entry: ' + relative);
      if (fold(fs.realpathSync.native(full)) !== fold(path.resolve(full))) throw new Error('Redirected NSIS entry: ' + relative);
      if (status.isDirectory()) {
        if (!expectedDirectories.has(key)) throw new Error('Unexpected NSIS directory: ' + relative);
        visit(full, relative);
      } else if (status.isFile()) {
        if (!expected.has(key) || seen.has(key)) throw new Error('Unexpected or duplicate NSIS file: ' + relative);
        if (status.size > 16 * 1024 * 1024 || hash(fs.readFileSync(full)) !== expected.get(key)) throw new Error('NSIS SHA256 mismatch: ' + relative);
        seen.add(key);
      } else throw new Error('Nonregular NSIS entry: ' + relative);
    }
  }
  visit(root);
  for (const key of expected.keys()) if (!seen.has(key)) throw new Error('Missing NSIS file: ' + key);
  return { compiler: absolute, root, version: NSIS_VERSION, archiveSha256: NSIS_ARCHIVE_SHA256, fileCount: seen.size };
}

// An explicit override or first existing candidate must pass. Do not silently hide
// an unsafe PATH/cache installation by falling through to another executable.
export function resolveTrustedNsis(env = process.env, manifest = loadNsisManifest()) {
  for (const candidate of nsisCandidates(env)) {
    if (!fs.existsSync(candidate.file) && candidate.source !== 'MAKENSIS') continue;
    try {
      return { ...verifyNsisTree(candidate.file, manifest), source: candidate.source };
    } catch (error) {
      throw new Error(`Rejected NSIS from ${candidate.source} (${candidate.file}): ${error.message}. Use an untouched extraction of official nsis-${NSIS_VERSION}.zip (SHA256 ${NSIS_ARCHIVE_SHA256}).`, { cause: error });
    }
  }
  throw new Error(`NSIS ${NSIS_VERSION} is unavailable. Set MAKENSIS to makensis.exe in an untouched extraction of the pinned official archive; packaging never downloads or installs a compiler.`);
}

export function nsisEnvironment(root, env = process.env) {
  // MyGo 0.1.22 invokes makensis from PATH before our guarded installer. Pin
  // its first match to the verified Bin compiler; it does not read MAKENSIS.
  // NSISCONFDIR confines system config to the pinned nsisconf.nsh. NSIS 3.13
  // reads APPDATA/nsisconf.nsh on Windows and HOME/.nsisconf.nsh elsewhere.
  // Verified Bin contains neither user config; unknown files fail tree checks.
  // Our direct compiler invocation additionally supplies /NOCONFIG.
  const values = Object.fromEntries(Object.entries(env).map(([key, value]) => [key.toLowerCase(), value]));
  const result = Object.fromEntries(Object.entries(env).filter(([key]) => !['path', 'nsisdir', 'nsisconfdir', 'home', 'appdata', 'makensis'].includes(key.toLowerCase())));
  result.PATH = [path.join(root, 'Bin'), values.path || ''].filter(Boolean).join(path.delimiter);
  result.NSISDIR = root;
  result.NSISCONFDIR = root;
  result.HOME = path.join(root, 'Bin');
  result.APPDATA = path.join(root, 'Bin');
  result.MAKENSIS = path.join(root, 'Bin', 'makensis.exe');
  return result;
}
