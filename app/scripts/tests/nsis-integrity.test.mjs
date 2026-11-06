import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadNsisManifest, nsisCandidates, nsisEnvironment, NSIS_ARCHIVE_SHA256, NSIS_VERSION, resolveTrustedNsis, verifyNsisTree } from '../nsis-integrity.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function tree(t) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'chisa-nsis-offline-'));
  const root = path.join(base, 'official NSIS & (fixture)');
  const files = { 'makensis.exe': 'not an executable: root compiler', 'Bin/makensis.exe': 'not an executable: Bin compiler', 'Include/MUI2.nsh': 'official fixture include', 'Plugins/x86-unicode/System.dll': 'official fixture plugin', 'nsisconf.nsh': '; official configuration fixture' };
  for (const [name, bytes] of Object.entries(files)) {
    const target = path.join(root, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes);
  }
  t.after(() => {
    assert.equal(path.dirname(base), fs.realpathSync.native(os.tmpdir()));
    assert.ok(path.basename(base).startsWith('chisa-nsis-offline-'));
    fs.rmSync(base, { recursive: true, force: true });
  });
  return { base, root, compiler: path.join(root, 'Bin/makensis.exe'), manifest: { schemaVersion: 1, version: NSIS_VERSION, archive: { sha256: NSIS_ARCHIVE_SHA256 }, files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, hash(bytes)])) } };
}

test('checked-in manifest is bound to the pinned official archive and all 441 distribution files', () => {
  const manifest = loadNsisManifest();
  assert.equal(manifest.version, '3.13'); assert.equal(manifest.archive.sha256, NSIS_ARCHIVE_SHA256);
  assert.equal(Object.keys(manifest.files).length, 441);
  assert.equal(manifest.files['makensis.exe'], '4ec390d0f96f9728507fbc2f4e91311dd90bfc6c8ddfe2159357b3651ae151c0');
  assert.equal(manifest.files['Bin/makensis.exe'], '65343c225ec88393cc4453b0963caf63f763f42f48cb55736d51893ff2e29d4a');
});

test('complete unexecuted distribution validates both official compiler locations including paths with metacharacters', t => {
  const f = tree(t);
  for (const compiler of [f.compiler, path.join(f.root, 'makensis.exe')]) {
    const result = verifyNsisTree(compiler, f.manifest);
    assert.equal(result.compiler, compiler); assert.equal(result.root, f.root); assert.equal(result.fileCount, 5); assert.equal(result.archiveSha256, NSIS_ARCHIVE_SHA256);
  }
});

for (const target of ['Bin/makensis.exe', 'Include/MUI2.nsh', 'Plugins/x86-unicode/System.dll', 'nsisconf.nsh']) {
  test('modified compiler/include/plugin/config is rejected before execution: ' + target, t => {
    const f = tree(t); fs.appendFileSync(path.join(f.root, target), '\nmodified');
    assert.throws(() => verifyNsisTree(f.compiler, f.manifest), /SHA256 mismatch/);
  });
}

test('missing required files and unrecognized additional configuration cannot pass a complete tree check', t => {
  const f = tree(t); const missing = path.join(f.root, 'Include/MUI2.nsh'); const bytes = fs.readFileSync(missing); fs.unlinkSync(missing);
  assert.throws(() => verifyNsisTree(f.compiler, f.manifest), /Missing NSIS file/);
  fs.writeFileSync(missing, bytes); fs.writeFileSync(path.join(f.root, '.nsisconf.nsh'), '!system malicious-command');
  assert.throws(() => verifyNsisTree(f.compiler, f.manifest), /Unexpected or duplicate NSIS file/);
});

test('unexpected empty directories are rejected as well as executable extra files', t => {
  const f = tree(t); fs.mkdirSync(path.join(f.root, 'UnreviewedPlugins'));
  assert.throws(() => verifyNsisTree(f.compiler, f.manifest), /Unexpected NSIS directory/);
});

test('directory junctions or symlinks cannot redirect a distribution resource', t => {
  const f = tree(t); const includes = path.join(f.root, 'Include'); const outside = path.join(f.base, 'external includes');
  fs.renameSync(includes, outside); fs.symlinkSync(outside, includes, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => verifyNsisTree(f.compiler, f.manifest), /Linked|Redirected/);
});

test('linked distribution roots or ancestors are rejected even when their full tree hashes are correct', t => {
  const f = tree(t); const alias = path.join(f.base, 'alias');
  fs.symlinkSync(f.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => verifyNsisTree(path.join(alias, 'Bin/makensis.exe'), f.manifest), /Linked|Redirected/);
  const ancestorAlias = path.join(f.base, 'parent alias');
  fs.symlinkSync(f.base, ancestorAlias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => verifyNsisTree(path.join(ancestorAlias, path.basename(f.root), 'Bin/makensis.exe'), f.manifest), /Linked|Redirected/);
});

test('an invalid explicit compiler never falls back to a valid PATH distribution', t => {
  const f = tree(t); const missing = path.join(f.base, 'missing/makensis.exe');
  assert.throws(() => resolveTrustedNsis({ MAKENSIS: missing, PATH: path.dirname(f.compiler) }, f.manifest), /Rejected NSIS from MAKENSIS/);
  const bad = path.join(f.base, 'untrusted/makensis.exe'); fs.mkdirSync(path.dirname(bad)); fs.writeFileSync(bad, 'untrusted');
  assert.throws(() => resolveTrustedNsis({ MAKENSIS: bad, PATH: path.dirname(f.compiler) }, f.manifest), /Rejected NSIS from MAKENSIS/);
  assert.equal(resolveTrustedNsis({ MAKENSIS: f.compiler, PATH: '' }, f.manifest).compiler, f.compiler);
});

test('an existing untrusted first PATH compiler is refused rather than silently skipped', t => {
  const f = tree(t); const bad = path.join(f.base, 'first PATH directory'); fs.mkdirSync(bad); fs.writeFileSync(path.join(bad, 'makensis.exe'), 'untrusted');
  assert.throws(() => resolveTrustedNsis({ PATH: bad + path.delimiter + path.dirname(f.compiler) }, f.manifest), /Rejected NSIS from PATH/);
  assert.equal(resolveTrustedNsis({ PATH: path.join(f.base, 'absent') + path.delimiter + path.dirname(f.compiler) }, f.manifest).compiler, f.compiler);
});

test('Windows discovery handles case-insensitive variables and quoted PATHs without running where or a shell', () => {
  const candidates = nsisCandidates({ mAkEnSiS: 'C:\\trusted\\Bin\\makensis.exe', pAtH: '"C:\\tool with spaces";C:\\other', LOCALAPPDATA: 'C:\\local' }, path.win32);
  assert.equal(candidates[0].source, 'MAKENSIS'); assert.equal(candidates[1].file, 'C:\\tool with spaces\\makensis.exe');
  assert.ok(candidates.some(row => row.file === 'C:\\local\\mygo\\nsis-3.13\\Bin\\makensis.exe'));
});

test('compiler environment removes every case variation of external NSIS configuration and preserves unrelated build tools', () => {
  const env = nsisEnvironment('C:\\reviewed NSIS', { Path: 'C:\\Go\\bin', NSISDIR: 'evil-a', nsisdir: 'evil-b', NsIsCoNfDiR: 'evil-c', GOTOOLCHAIN: 'local' });
  assert.equal(env.NSISDIR, 'C:\\reviewed NSIS'); assert.equal(env.NSISCONFDIR, 'C:\\reviewed NSIS'); assert.equal(env.GOTOOLCHAIN, 'local');
  assert.equal(env.PATH, path.join('C:\\reviewed NSIS','Bin') + path.delimiter + 'C:\\Go\\bin');
  assert.equal(env.HOME, path.join('C:\\reviewed NSIS','Bin')); assert.equal(env.APPDATA, path.join('C:\\reviewed NSIS','Bin')); assert.equal(env.MAKENSIS, path.join('C:\\reviewed NSIS','Bin','makensis.exe'));
  assert.equal(Object.keys(env).filter(key => key.toLowerCase()==='path').length, 1);
  assert.deepEqual(Object.keys(env).filter(key => ['nsisdir', 'nsisconfdir'].includes(key.toLowerCase())).sort(), ['NSISCONFDIR', 'NSISDIR']);
});

test('unsafe manifest paths and case-colliding resource identities are refused', t => {
  const f = tree(t);
  assert.throws(() => verifyNsisTree(f.compiler, { ...f.manifest, files: { ...f.manifest.files, '../escape': hash('x') } }), /Invalid NSIS manifest entry/);
  assert.throws(() => verifyNsisTree(f.compiler, { ...f.manifest, files: { ...f.manifest.files, 'BIN/MAKENSIS.EXE': hash('x') } }), /Duplicate NSIS manifest entry/);
});
