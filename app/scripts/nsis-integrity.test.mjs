import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadNsisManifest, nsisCandidates, nsisEnvironment, resolveTrustedNsis, verifyNsisTree } from './nsis-integrity.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chisa-nsis-integrity-test-'));
  t.after(() => {
    assert.equal(path.dirname(root), os.tmpdir());
    assert.match(path.basename(root), /^chisa-nsis-integrity-test-/);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const files = { 'makensis.exe': 'root-not-executable', 'Bin/makensis.exe': 'bin-not-executable', 'Bin/zlib1.dll': 'library', 'Include/MUI2.nsh': 'include', 'Plugins/x86-unicode/System.dll': 'plugin', 'Stubs/zlib': 'stub', 'nsisconf.nsh': '; pinned config' };
  for (const [file, value] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), value);
  }
  return { root, manifest: { files: Object.fromEntries(Object.entries(files).map(([file, value]) => [file, digest(value)])) }, compiler: path.join(root, 'Bin', 'makensis.exe') };
}

test('accepts complete untouched tree through both official compiler paths without execution', t => {
  const f = fixture(t);
  assert.equal(verifyNsisTree(f.compiler, f.manifest).fileCount, 7);
  assert.equal(verifyNsisTree(path.join(f.root, 'makensis.exe'), f.manifest).root, f.root);
});
for (const name of ['makensis.exe', 'Bin/makensis.exe', 'Bin/zlib1.dll', 'Include/MUI2.nsh', 'Plugins/x86-unicode/System.dll', 'Stubs/zlib', 'nsisconf.nsh']) {
  test('rejects changed official file: ' + name, t => {
    const f = fixture(t);
    fs.appendFileSync(path.join(f.root, name), 'modified');
    assert.throws(() => verifyNsisTree(f.compiler, f.manifest), /SHA256 mismatch/);
  });
}
test('rejects missing plugin despite compiler existing', t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.root, 'Plugins/x86-unicode/System.dll'));
  assert.throws(() => verifyNsisTree(f.compiler, f.manifest), /Missing NSIS file/);
});
for (const name of ['Bin/extra.dll', '.nsisconf.nsh', 'NSISCONF.NSH.extra']) {
  test('rejects additional file: ' + name, t => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.root, name), 'extra');
    assert.throws(() => verifyNsisTree(f.compiler, f.manifest), /Unexpected or duplicate NSIS file/);
  });
}
test('rejects extra empty directory', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, 'unexpected'));
  assert.throws(() => verifyNsisTree(f.compiler, f.manifest), /Unexpected NSIS directory/);
});
test('rejects linked/junction descendant with valid-looking compiler tree', t => {
  const f = fixture(t);
  fs.symlinkSync(path.join(f.root, 'Include'), path.join(f.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => verifyNsisTree(f.compiler, f.manifest), /Linked NSIS entry/);
});
test('rejects linked/junction root', t => {
  const f = fixture(t);
  const outer = fixture(t);
  const link = path.join(outer.root, 'linked');
  fs.symlinkSync(f.root, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => verifyNsisTree(path.join(link, 'makensis.exe'), f.manifest), /Linked or non-directory NSIS path/);
});
test('preserves explicit override and PATH precedence with case-insensitive Windows env', () => {
  const rows = nsisCandidates({ MAKENSIS: 'C:\\custom\\makensis.exe', Path: '"C:\\first";C:\\second', LOCALAPPDATA: 'C:\\cache' }, path.win32);
  assert.deepEqual(rows.map(row => row.source), ['MAKENSIS', 'PATH', 'PATH', 'MyGo cache', 'MyGo cache']);
  assert.equal(rows[1].file, 'C:\\first\\makensis.exe');
});
test('explicit valid override is verified', t => {
  const f = fixture(t);
  assert.equal(resolveTrustedNsis({ MAKENSIS: f.compiler }, f.manifest).source, 'MAKENSIS');
});
test('PATH valid candidate is verified', t => {
  const f = fixture(t);
  assert.equal(resolveTrustedNsis({ PATH: path.dirname(f.compiler) }, f.manifest).compiler, f.compiler);
});
test('invalid explicit override cannot fall through to valid PATH candidate', t => {
  const f = fixture(t);
  assert.throws(() => resolveTrustedNsis({ MAKENSIS: path.join(f.root, 'missing', 'makensis.exe'), PATH: path.dirname(f.compiler) }, f.manifest), /Rejected NSIS from MAKENSIS/);
});
test('tampered first PATH tree cannot fall through to a later valid tree', t => {
  const bad = fixture(t), good = fixture(t);
  fs.appendFileSync(bad.compiler, 'modified');
  assert.throws(() => resolveTrustedNsis({ PATH: [path.dirname(bad.compiler), path.dirname(good.compiler)].join(path.delimiter) }, good.manifest), /Rejected NSIS from PATH/);
});
test('rejects missing compiler without network fallback', () => {
  assert.throws(() => resolveTrustedNsis({}, { files: {} }), /never downloads or installs/);
});
test('manifest cannot escape tree or have case-fold duplicate keys', t => {
  const f = fixture(t);
  assert.throws(() => verifyNsisTree(f.compiler, { files: { ...f.manifest.files, '../escape': digest('x') } }), /Invalid NSIS manifest entry/);
  assert.throws(() => verifyNsisTree(f.compiler, { files: { ...f.manifest.files, 'BIN/MAKENSIS.EXE': digest('x') } }), /Duplicate NSIS manifest entry/);
});
test('compiler environment pins upstream selection and confines config', t => {
  const f = fixture(t);
  const env = nsisEnvironment(f.root, { Path: 'old', PATH: 'duplicate', nsisdir: 'bad', NSISDIR: 'bad2', nsisconfdir: 'bad3', HOME: 'bad4', appdata: 'bad5', APPDATA: 'bad6', KEEP: 'yes' });
  assert.equal(env.NSISDIR, f.root);
  assert.equal(env.NSISCONFDIR, f.root);
  assert.equal(env.HOME, path.join(f.root, 'Bin'));
  assert.equal(env.APPDATA, path.join(f.root, 'Bin'));
  assert.equal(Object.keys(env).filter(key => key.toLowerCase() === 'appdata').length, 1);
  assert.equal(env.PATH.split(path.delimiter)[0], path.join(f.root, 'Bin'));
  assert.equal(env.KEEP, 'yes');
  assert.equal(Object.keys(env).filter(key => key.toLowerCase() === 'path').length, 1);
  assert.equal(Object.keys(env).filter(key => key.toLowerCase() === 'nsisdir').length, 1);
});
test('production manifest binds official archive and all 441 files', () => {
  const manifest = loadNsisManifest();
  assert.equal(Object.keys(manifest.files).length, 441);
  assert.equal(manifest.files['makensis.exe'], '4ec390d0f96f9728507fbc2f4e91311dd90bfc6c8ddfe2159357b3651ae151c0');
  assert.equal(manifest.files['Bin/makensis.exe'], '65343c225ec88393cc4453b0963caf63f763f42f48cb55736d51893ff2e29d4a');
});
