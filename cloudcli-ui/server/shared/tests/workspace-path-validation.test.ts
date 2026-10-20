import assert from 'node:assert/strict';
import * as files from 'node:fs/promises';
import path from 'node:path';
import { mock, test } from 'node:test';

const root = '/opt/chisacloudcode/workspaces';
const originalRoot = process.env.WORKSPACES_ROOT;
const originalPlatform = process.platform;
Object.defineProperty(process, 'platform', { value: 'linux' });
process.env.WORKSPACES_ROOT = root;
const existing = new Set<string>();
const links = new Map<string, string>();
const missing = () => Object.assign(new Error('Path does not exist'), { code: 'ENOENT' });

function canonical(filename: string): string {
  for (const [link, target] of links) {
    if (filename === link || filename.startsWith(link + '/')) {
      return target + filename.slice(link.length);
    }
  }
  return filename;
}

mock.module('node:path', { defaultExport: path.posix, namedExports: { ...path.posix } });
mock.module('node:fs/promises', { namedExports: {
  ...files,
  realpath: async (filename: string) => {
    if (!existing.has(filename)) throw missing();
    return canonical(filename);
  },
  access: async (filename: string) => {
    if (!existing.has(filename)) throw missing();
  },
  lstat: async (filename: string) => ({ isSymbolicLink: () => links.has(filename) }),
  readlink: async (filename: string) => links.get(filename),
} });
const { validateWorkspacePath } = await import('@/shared/utils.js');

test.beforeEach(() => {
  process.env.WORKSPACES_ROOT = root;
  existing.clear();
  links.clear();
  for (const directory of ['/', '/opt', '/opt/chisacloudcode', root, root + '/local', root + '/local/project']) {
    existing.add(directory);
  }
});
test.after(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform });
  if (originalRoot === undefined) delete process.env.WORKSPACES_ROOT;
  else process.env.WORKSPACES_ROOT = originalRoot;
});

test('explicit /opt workspace accepts existing and new nested project directories', async () => {
  for (const project of [root, root + '/local/project', root + '/local/new/nested']) {
    assert.deepEqual(await validateWorkspacePath(project), { valid: true, resolvedPath: project });
  }
});

test('rejects paths outside root, traversal and sibling prefixes', async () => {
  for (const project of ['/opt/other/project', root + '/../outside', root + '-other/project', '/etc/passwd', '/']) {
    assert.equal((await validateWorkspacePath(project)).valid, false, project);
  }
});

test('does not waive /opt ban when the workspace is not explicitly configured', async () => {
  delete process.env.WORKSPACES_ROOT;
  assert.equal((await validateWorkspacePath(root + '/local/project')).valid, false);
});

test('existing project symlink outside the root is rejected', async () => {
  links.set(root + '/local/project', '/opt/other/project');
  assert.equal((await validateWorkspacePath(root + '/local/project')).valid, false);
});

test('missing nested project cannot escape through an existing symlink ancestor', async () => {
  links.set(root + '/local', '/opt/other');
  assert.equal((await validateWorkspacePath(root + '/local/new/nested')).valid, false);
});

test('in-root symlink resolves to its canonical project location', async () => {
  links.set(root + '/local/project', root + '/target');
  existing.add(root + '/target');
  assert.deepEqual(await validateWorkspacePath(root + '/local/project'), {
    valid: true, resolvedPath: root + '/target',
  });
});

test('canonical root symlink to a critical directory does not bypass its ban', async () => {
  links.set(root, '/etc/workspaces');
  assert.equal((await validateWorkspacePath(root + '/local/project')).valid, false);
});

test('critical directory itself stays forbidden even when it is the canonical workspace root', async () => {
  links.set(root, '/opt');
  assert.equal((await validateWorkspacePath(root)).valid, false);
  links.set(root, '/');
  assert.equal((await validateWorkspacePath(root)).valid, false);
});

test('safe workspace root alias under /opt retains canonical containment', async () => {
  links.set(root, '/opt/actual-workspaces');
  assert.deepEqual(await validateWorkspacePath(root + '/local/new/nested'), {
    valid: true, resolvedPath: '/opt/actual-workspaces/local/new/nested',
  });
});
