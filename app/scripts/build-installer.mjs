import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') throw new Error('This installer entry point requires Windows.');
const app = fileURLToPath(new URL('../', import.meta.url));
const config = readFileSync(path.join(app, 'mygo.config.ts'), 'utf8');
function setting(name) {
  const match = config.match(new RegExp(`\\b${name}:\\s*"([^"]+)"`));
  if (!match || !/^[A-Za-z0-9 ._-]+$/.test(match[1])) throw new Error(`Unsupported MyGo ${name}`);
  return match[1];
}
const name = setting('name');
const version = setting('version');
const identifier = setting('identifier');
const stageArgument = process.argv.indexOf('--stage');
const stage = stageArgument >= 0 ? path.resolve(process.argv[stageArgument + 1] || '') : path.join(app, 'build', 'windows-amd64');
if (stageArgument >= 0 && !process.argv[stageArgument + 1]) throw new Error('--stage requires an existing build directory');
const output = path.join(stage, `${name} Setup ${version}.exe`);
// A failed guarded packaging attempt must not leave MyGo's unguarded candidate.
rmSync(output, { force: true });
const work = path.join(app, 'build', 'installer');
mkdirSync(work, { recursive: true });
const temporaryOutput = path.join(work, `${name} Setup ${version}.exe`);
const locate = spawnSync('where.exe', ['makensis.exe'], { encoding: 'utf8', windowsHide: true });
const compiler = [
  process.env.MAKENSIS,
  ...(locate.status === 0 ? locate.stdout.trim().split(/\r?\n/) : []),
  path.join(process.env['ProgramFiles(x86)'] || '', 'NSIS', 'makensis.exe'),
  path.join(process.env.ProgramFiles || '', 'NSIS', 'makensis.exe'),
  path.join(process.env.LOCALAPPDATA || '', 'mygo', 'nsis-3.13', 'Bin', 'makensis.exe'),
  path.join(process.env.LOCALAPPDATA || '', 'mygo', 'nsis-3.13', 'makensis.exe'),
].find(candidate => candidate && existsSync(candidate));
if (!compiler) throw new Error('NSIS is unavailable; run MyGo build to provision its existing compiler.');
if (!existsSync(path.join(stage, `${name}.exe`))) throw new Error('Build the native application before packaging its installer.');

const escape = value => value.replaceAll('$', () => '$$').replaceAll('"', '$\\"');
const quote = value => `"${escape(value)}"`;
const files = [];
function collect(directory, prefix = '') {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!prefix && entry.name.startsWith(`${name} Setup `) && entry.name.endsWith('.exe')) continue;
    const relative = path.join(prefix, entry.name);
    // MyGo can reuse an older staging directory. Never carry retired local
    // executors into an installer; leave source/installed files alone.
    if (['mutagen.exe', 'mutagen-agents.tar.gz', 'ssh.exe', 'scp.exe', 'sync-ssh'].includes(entry.name.toLowerCase())) continue;
    if (entry.isDirectory()) collect(path.join(directory, entry.name), relative);
    else if (entry.isFile()) files.push(relative);
    else throw new Error(`Unsupported staged entry: ${relative}`);
  }
}
collect(stage);
files.sort();
const preflight = path.join(work, 'preflight.nsh');
const uninstallPreflight = path.join(work, 'uninstall-preflight.nsh');
const payload = path.join(work, 'payload.nsh');
const uninstall = path.join(work, 'uninstall.nsh');
writeFileSync(preflight, files.map(file => `StrCpy $CheckedPath "$INSTDIR\\${escape(file)}"\nCall RequireWritableFile`).join('\n'));
writeFileSync(uninstallPreflight, files.map(file => `StrCpy $CheckedPath "$INSTDIR\\${escape(file)}"\nCall un.RequireWritableFile`).join('\n'));
writeFileSync(payload, files.map(file => {
  const directory = path.dirname(file);
  return `SetOutPath "$INSTDIR${directory === '.' ? '' : `\\${escape(directory)}`}"\nIfErrors install_failed\nFile ${quote(path.join(stage, file))}\nIfErrors install_failed`;
}).join('\n'));
// Delete only the files this installer owns. Non-recursive directory removal
// deliberately leaves user-created files and directories in place.
const directories = new Set();
for (const file of files) {
  for (let directory = path.dirname(file); directory !== '.'; directory = path.dirname(directory)) directories.add(directory);
}
const directoryRemoval = [...directories].sort((a, b) => b.split(path.sep).length - a.split(path.sep).length || a.localeCompare(b));
writeFileSync(uninstall, [
  ...files.map(file => `IfFileExists "$INSTDIR\\${escape(file)}" 0 +3\nDelete "$INSTDIR\\${escape(file)}"\nIfErrors uninstall_failed`),
  ...directoryRemoval.map(directory => `RMDir "$INSTDIR\\${escape(directory)}"`),
].join('\n'));
const result = spawnSync(compiler, [
  '/V2', '/INPUTCHARSET', 'UTF8', `/DPRODUCT_NAME=${name}`, `/DPRODUCT_ID=${identifier}`, `/DPRODUCT_VERSION=${version}`,
  `/DINSTALLER_OUTPUT=${temporaryOutput}`, `/DINSTALLER_ICON=${path.join(app, 'installer', 'icon.ico')}`,
  `/DPREFLIGHT_INCLUDE=${preflight}`, `/DUNINSTALL_PREFLIGHT_INCLUDE=${uninstallPreflight}`,
  `/DPAYLOAD_INCLUDE=${payload}`, `/DUNINSTALL_INCLUDE=${uninstall}`, path.join(app, 'installer', 'windows.nsi'),
], { stdio: 'inherit', windowsHide: true });
if (result.error || result.status !== 0) throw result.error || new Error(`NSIS exited ${result.status}`);
renameSync(temporaryOutput, output);
console.log(`Created guarded installer: ${output}`);
