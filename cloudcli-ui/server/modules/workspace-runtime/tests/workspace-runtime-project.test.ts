import assert from 'node:assert/strict';
import * as realFiles from 'node:fs';
import realPath from 'node:path';
import test, { mock } from 'node:test';

import { AppError } from '@/shared/index.js';

type Entry = {
  kind: 'directory' | 'file' | 'symlink' | 'special'; ino: number; dev: number; nlink: number;
  uid: number; gid: number; contents: string; target?: string; children: Map<string, Entry>;
};
type Handle = { filename: string; entry: Entry };
const root = '/srv/account/project';
const info = root + '/.git/info';
const outside = '/srv/other-account';
const handles = new Map<number, Handle>();
const ownership: Array<{ filename: string; ino: number; uid: number; gid: number }> = [];
const opened: Array<{ filename: string; flags: number }> = [];
const safeFlags = realFiles.constants;
let nextInode = 1;
let nextFd = 20;
let uid = 0;
let tree: Entry;
let beforeOpen: ((filename: string) => void) | undefined;
let afterOpen: ((handle: Handle) => void) | undefined;

function entry(kind: Entry['kind'], contents = ''): Entry {
  return { kind, ino: nextInode++, dev: 1, nlink: 1, uid: 0, gid: 0, contents, children: new Map() };
}
function lookup(filename: string, followFinal = true): { entry: Entry; filename: string } {
  const anchored = /^\/proc\/self\/fd\/(\d+)(?:\/(.*))?$/.exec(filename);
  let current = anchored ? handles.get(Number(anchored[1]))!.entry : tree;
  let resolved = anchored ? handles.get(Number(anchored[1]))!.filename : '';
  const parts = (anchored ? anchored[2] ?? '' : filename).split('/').filter(Boolean);
  for (let index = 0; index < parts.length; index++) {
    if (current.kind !== 'directory') throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' });
    const child = current.children.get(parts[index]);
    if (!child) throw Object.assign(new Error('missing ' + filename), { code: 'ENOENT' });
    resolved += '/' + parts[index];
    if (child.kind === 'symlink' && (followFinal || index < parts.length - 1)) {
      return lookup(child.target! + (index < parts.length - 1 ? '/' + parts.slice(index + 1).join('/') : ''), followFinal);
    }
    current = child;
  }
  return { entry: current, filename: resolved || '/' };
}
function add(filename: string, kind: Entry['kind'] = 'file', contents = ''): Entry {
  const parent = realPath.posix.dirname(filename);
  let directory: Entry;
  try { directory = lookup(parent).entry; }
  catch { directory = add(parent, 'directory'); }
  const value = entry(kind, contents);
  directory.children.set(realPath.posix.basename(filename), value);
  return value;
}
function stats(value: Entry) {
  return {
    dev: value.dev, ino: value.ino, nlink: value.nlink, size: value.contents.length, mode: 0o600,
    isDirectory: () => value.kind === 'directory', isFile: () => value.kind === 'file', isSymbolicLink: () => value.kind === 'symlink',
  };
}
function seedRepository(): void {
  add(info, 'directory');
  add(info + '/exclude', 'file', '# personal excludes\n*.scratch\n');
}

mock.module('@/shared/index.js', { namedExports: { AppError } });
mock.module('node:path', { defaultExport: realPath.posix, namedExports: { ...realPath.posix } });
mock.module('node:fs', { namedExports: {
  ...realFiles,
  constants: safeFlags,
  existsSync: (filename: string) => { try { lookup(filename); return true; } catch { return false; } },
  lstatSync: (filename: string) => stats(lookup(filename, false).entry),
  realpathSync: (filename: string) => lookup(filename).filename,
  readdirSync: (filename: string) => [...lookup(filename).entry.children.keys()],
  mkdirSync: (filename: string) => { try { lookup(filename); } catch { add(filename, 'directory'); } },
  openSync: (filename: string, flags: number) => {
    opened.push({ filename, flags }); beforeOpen?.(filename);
    let value: Entry;
    try { value = lookup(filename, false).entry; }
    catch (error) { if (!(flags & safeFlags.O_CREAT)) throw error; value = add(filename); }
    if ((flags & safeFlags.O_NOFOLLOW) && value.kind === 'symlink') throw Object.assign(new Error('symlink rejected'), { code: 'ELOOP' });
    if ((flags & safeFlags.O_DIRECTORY) && value.kind !== 'directory') throw Object.assign(new Error('directory required'), { code: 'ENOTDIR' });
    const fd = nextFd++;
    const handle = { filename: lookup(filename).filename, entry: value };
    handles.set(fd, handle); afterOpen?.(handle); return fd;
  },
  fstatSync: (fd: number) => stats(handles.get(fd)!.entry),
  fchownSync: (fd: number, owner: number, group: number) => {
    const handle = handles.get(fd)!;
    assert.ok(handle, 'ownership must use an open descriptor');
    ownership.push({ filename: handle.filename, ino: handle.entry.ino, uid: owner, gid: group });
    handle.entry.uid = owner; handle.entry.gid = group;
  },
  chownSync: () => assert.fail('path-based chown could follow a replacement symlink'),
  closeSync: (fd: number) => { assert.ok(handles.delete(fd), 'each descriptor must close exactly once'); },
  readFileSync: (fd: number) => handles.get(fd)!.entry.contents,
  writeSync: (fd: number, text: string) => { handles.get(fd)!.entry.contents += text; return text.length; },
  fsyncSync: (fd: number) => { assert.ok(handles.has(fd)); },
} });
const { prepareCloudProjectOwnership, excludeCloudWorkspaceMetadata } = await import('../workspace-runtime-project.service.js');
const platform = process.platform;
const getuid = Object.getOwnPropertyDescriptor(process, 'getuid');
test.before(() => {
  Object.defineProperty(process, 'platform', { value: 'linux' });
  Object.defineProperty(process, 'getuid', { configurable: true, value: () => uid });
});
test.beforeEach(() => {
  nextInode = 1; nextFd = 20; tree = entry('directory'); uid = 0;
  handles.clear(); ownership.length = 0; opened.length = 0; beforeOpen = afterOpen = undefined;
  add(root, 'directory'); add(root + '/src', 'directory'); add(root + '/src/cloned.ts', 'file', 'cloned content');
  add(outside, 'directory'); add(outside + '/secret', 'file', 'foreign state');
});
test.afterEach(() => { assert.equal(handles.size, 0, 'all descriptors close even after rejection'); });
test.after(() => {
  Object.defineProperty(process, 'platform', { value: platform });
  if (getuid) Object.defineProperty(process, 'getuid', getuid); else Reflect.deleteProperty(process, 'getuid');
});

test('Linux root prepares cloned project files for UID/GID 1000 without touching markers, sibling state or symlink targets', () => {
  seedRepository();
  add(root + '/.chisa-bridge.json', 'file', 'server marker'); add(root + '/.chisa-session.json', 'file', 'server session');
  add(root + '.chisa-state', 'directory'); add(root + '.chisa-state/replica.json', 'file', 'server replica');
  const link = add(root + '/external-link', 'symlink'); link.target = outside;
  prepareCloudProjectOwnership(root);
  const changed = ownership.map(value => value.filename).sort();
  assert.deepEqual(changed, [root, root + '/src', root + '/src/cloned.ts', root + '/.git', info, info + '/exclude'].sort());
  assert.equal(ownership.every(value => value.uid === 1000 && value.gid === 1000), true);
  for (const filename of [outside, outside + '/secret', root + '.chisa-state', root + '/.chisa-bridge.json', root + '/.chisa-session.json']) {
    assert.equal(lookup(filename).entry.uid, 0, 'unrelated state must keep its owner: ' + filename);
  }
  assert.equal(link.uid, 0);
  if (safeFlags.O_NOFOLLOW) assert.equal(opened.every(value => (value.flags & safeFlags.O_NOFOLLOW) !== 0), true);
});

test('unsafe hardlinks and special files abort the full ownership preflight before any chown', () => {
  for (const kind of ['hardlink', 'special']) {
    ownership.length = 0; opened.length = 0;
    const unsafe = add(root + '/unsafe', kind === 'special' ? 'special' : 'file');
    if (kind === 'hardlink') unsafe.nlink = 2;
    assert.throws(() => prepareCloudProjectOwnership(root), { code: 'WORKSPACE_PROJECT_UNSAFE', statusCode: 409 });
    assert.equal(ownership.length, 0); assert.equal(opened.length, 0);
  }
});

test('ownership rejects a file replaced between preflight and open without changing the replacement owner', () => {
  let replacement: Entry | undefined;
  beforeOpen = filename => { if (filename === root + '/src/cloned.ts') replacement = add(filename, 'file', 'replacement'); };
  assert.throws(() => prepareCloudProjectOwnership(root), { code: 'WORKSPACE_BUSY', statusCode: 409 });
  assert.ok(replacement); assert.equal(replacement.uid, 0);
  assert.equal(ownership.some(value => value.ino === replacement!.ino), false);
});

test('ownership rejects a post-scan symlink and never opens its foreign target', () => {
  afterOpen = handle => {
    if (handle.filename === root) { const link = add(root + '/src/cloned.ts', 'symlink'); link.target = outside + '/secret'; }
  };
  assert.throws(() => prepareCloudProjectOwnership(root), { code: 'WORKSPACE_BUSY', statusCode: 409 });
  assert.equal(ownership.some(value => value.filename.startsWith(outside)), false);
  assert.equal(lookup(outside + '/secret').entry.uid, 0);
});

test('nonroot Linux and Windows host fixtures do not attempt ownership changes', () => {
  uid = 1000; prepareCloudProjectOwnership(root);
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try { uid = 0; prepareCloudProjectOwnership(root); }
  finally { Object.defineProperty(process, 'platform', { value: 'linux' }); }
  assert.equal(opened.length, 0); assert.equal(ownership.length, 0);
});

test('Git metadata exclusions use verified directory descriptors and preserve user rules exactly once', () => {
  seedRepository();
  excludeCloudWorkspaceMetadata(root);
  const contents = lookup(info + '/exclude').entry.contents;
  assert.equal(contents, '# personal excludes\n*.scratch\n\n/.chisa-bridge.json\n/.chisa-session.json\n');
  assert.ok(opened.some(value => /^\/proc\/self\/fd\/\d+\/exclude$/.test(value.filename)), 'Linux writes must anchor to the verified parent descriptor');
  assert.deepEqual(ownership.map(value => value.filename).sort(), [info, info + '/exclude'].sort());
  assert.equal(ownership.every(value => value.uid === 1000 && value.gid === 1000), true);
  excludeCloudWorkspaceMetadata(root);
  assert.equal(lookup(info + '/exclude').entry.contents, contents);
});

test('a Git info directory replaced after open cannot redirect exclude edits or chown to another account', () => {
  seedRepository();
  const originalInfo = lookup(info).entry;
  const originalExclude = lookup(info + '/exclude').entry;
  add(outside + '/exclude', 'file', 'foreign exclude\n');
  afterOpen = handle => {
    if (handle.entry === originalInfo) { const link = add(info, 'symlink'); link.target = outside; }
  };
  // Directory revalidation may fail closed before opening the anchored file.
  // If it proceeds, only the original descriptor's files may change.
  try { excludeCloudWorkspaceMetadata(root); }
  catch (error) { assert.equal((error as { code?: string }).code, 'WORKSPACE_BUSY'); }
  assert.equal(lookup(outside + '/exclude').entry.contents, 'foreign exclude\n');
  assert.equal(lookup(outside).entry.uid, 0); assert.equal(lookup(outside + '/exclude').entry.uid, 0);
  assert.equal(ownership.every(value => value.ino === originalInfo.ino || value.ino === originalExclude.ino), true);
});

test('a parent replacement during the anchored file open still cannot redirect edits outside the verified directory', () => {
  seedRepository();
  const originalInfo = lookup(info).entry;
  const originalExclude = lookup(info + '/exclude').entry;
  add(outside + '/exclude', 'file', 'foreign exclude\n');
  beforeOpen = filename => {
    if (filename.startsWith('/proc/self/fd/')) { const link = add(info, 'symlink'); link.target = outside; }
  };
  excludeCloudWorkspaceMetadata(root);
  assert.match(originalExclude.contents, /\/.chisa-bridge\.json/);
  assert.equal(lookup(outside + '/exclude').entry.contents, 'foreign exclude\n');
  assert.equal(lookup(outside + '/exclude').entry.uid, 0);
  assert.equal(ownership.every(value => value.ino === originalInfo.ino || value.ino === originalExclude.ino), true);
});

test('hardlinked Git excludes are rejected before edits or ownership changes', () => {
  seedRepository();
  const exclude = lookup(info + '/exclude').entry; exclude.nlink = 2;
  const before = exclude.contents;
  assert.throws(() => excludeCloudWorkspaceMetadata(root), { code: 'WORKSPACE_GIT_UNSUPPORTED', statusCode: 409 });
  assert.equal(exclude.contents, before); assert.equal(ownership.length, 0);
});

test('linked worktree Git pointers and symlinked Git directories are never followed on the host', () => {
  add(root + '/.git', 'file', 'gitdir: ' + outside);
  excludeCloudWorkspaceMetadata(root);
  const link = add(root + '/.git', 'symlink'); link.target = outside;
  excludeCloudWorkspaceMetadata(root);
  assert.equal(opened.length, 0); assert.equal(ownership.length, 0);
});
