import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import test, { mock } from 'node:test';
import type { TestContext } from 'node:test';

import { createFileTreeService } from '@/modules/file-tree/file-tree.service.js';
// File-tree integration uses a controlled cloud sandbox without restoring accounts.
mock.module('@/modules/workspace-runtime/index.js', { namedExports: {
  ensureCloudWorkspaceBinding() {}, excludeCloudWorkspaceMetadata() {}, getWorkspaceRuntimeIdentity() { return undefined; },
  executeWorkspaceRuntimePreview() { assert.fail('unexpected preview'); },
} });
const { bridgeFileSystem } = await import('@/modules/workspace-bridge/index.js');
import type { FileTreeFileSystem } from '@/shared/index.js';
type FileTreeDirectoryEntry = ReturnType<FileTreeFileSystem['openDirectory']> extends AsyncIterable<infer Entry> ? Entry : never;
type FileTreeServiceDependencies = Parameters<typeof createFileTreeService>[0];
type FileTreeStats = Awaited<ReturnType<FileTreeFileSystem['stat']>>;
import { AppError, WORKSPACES_ROOT, registerWorkspaceRuntimeNetwork } from '@/shared/index.js';

function createDirectoryEntry(name: string, directory: boolean): FileTreeDirectoryEntry {
  return {
    name,
    isDirectory: () => directory,
  };
}

/**
 * Adapts a path-keyed listing to the streaming directory contract so tests keep
 * describing directories as plain arrays.
 */
function createDirectoryReader(
  listDirectory: (directoryPath: string) => FileTreeDirectoryEntry[],
): FileTreeFileSystem['openDirectory'] {
  return async function* openDirectory(directoryPath) {
    yield* listDirectory(directoryPath);
  };
}

function createStats(directory: boolean, mode: number): FileTreeStats {
  return {
    size: directory ? 0 : 24,
    mtime: new Date('2026-01-02T03:04:05.000Z'),
    mode,
    isDirectory: () => directory,
    isSymbolicLink: () => false,
  };
}

function createFakeFileSystem(
  overrides: Partial<FileTreeFileSystem> = {},
): FileTreeFileSystem {
  const unexpectedOperation = async (): Promise<never> => {
    throw new Error('Unexpected File Tree filesystem operation');
  };

  return {
    access: unexpectedOperation,
    stat: unexpectedOperation,
    lstat: unexpectedOperation,
    openDirectory: () => ({
      [Symbol.asyncIterator]: () => ({ next: unexpectedOperation }),
    }),
    realpath: unexpectedOperation,
    readTextFile: unexpectedOperation,
    writeTextFile: unexpectedOperation,
    makeDirectory: unexpectedOperation,
    rename: unexpectedOperation,
    removeDirectory: unexpectedOperation,
    unlink: unexpectedOperation,
    copyFile: unexpectedOperation,
    createReadStream: () => Readable.from([]),
    ...overrides,
  };
}

async function startWorkspaceControl<T>(
  context: TestContext,
  roots: string[],
  _legacyReadBatch: boolean,
  handle: (request: T, incoming: Pick<IncomingMessage, 'headers'>) => Response | Promise<Response>,
) {
  let fixtureError: unknown;
  registerWorkspaceRuntimeNetwork(path.resolve(WORKSPACES_ROOT), 'chisa-workspace-network-' + 'f'.repeat(24), 'file-tree-cloud-fixture');
  const spawning = mock.method(childProcess, 'spawn', (_command: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() {} });
    if (args[0] !== 'run') { queueMicrotask(() => child.emit('close', 0)); return child as never; }
    const mount = args[args.indexOf('--volume') + 1]!;
    const cwd = mount.slice(0, mount.lastIndexOf(':/workspace:'));
    assert.ok(roots.includes(cwd));
    let input = '';
    child.stdin.on('data', chunk => { input += String(chunk); });
    child.stdin.once('finish', () => { void (async () => {
      const request = JSON.parse(input) as T;
      const reply = await handle(request, { headers: { 'x-cwd': Buffer.from(cwd).toString('latin1') } });
      child.stdout.write(JSON.stringify(await reply.json())); child.emit('close', 0);
    })().catch(error => { fixtureError = error; child.emit('error', error); child.emit('close', 1); }); });
    return child as never;
  });
  syncBuiltinESMExports();
  context.after(() => { spawning.mock.restore(); syncBuiltinESMExports(); if (fixtureError) throw fixtureError; });
  await Promise.all(roots.map(root => writeFile(path.join(root, '.chisa-bridge.json'), JSON.stringify({ protocol: 3, root, owner: 'cloud-file-tree-fixture', bindingEpoch: 'test-epoch' }))));
}

test('workspace editor saves use the hash of the loaded snapshot', async () => {
  const projectRoot = path.resolve('workspace-editor-project');
  const writes: Array<{ expectedHash?: string | null; content: string }> = [];
  const fileSystem = createFakeFileSystem({
    readTextSnapshot: async () => ({ content: 'loaded bytes', hash: 'loaded-version' }),
    writeTextSnapshot: async (_p, content, expectedHash) => {
      writes.push({ expectedHash, content });
      if (expectedHash !== 'loaded-version') throw new AppError('File changed', { code: 'CONTENT_CONFLICT', statusCode: 409 });
      return { hash: 'saved-version' };
    },
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));
  const loaded = await service.readTextFile('project', 'main.ts');
  assert.equal(loaded.hash, 'loaded-version');
  await assert.rejects(service.saveTextFile('project', 'main.ts', 'edited bytes', 'stale-version'), { code: 'CONTENT_CONFLICT' });
  const saved = await service.saveTextFile('project', 'main.ts', 'edited bytes', loaded.hash);
  assert.equal(saved.hash, 'saved-version');
  assert.deepEqual(writes, [{ content: 'edited bytes', expectedHash: 'stale-version' }, { content: 'edited bytes', expectedHash: 'loaded-version' }]);
});

test('real workspace file read/save enforces CAS and unavailable saves never change disk', async (context) => {
  const projectRoot = await mkdtemp(path.join(path.resolve(WORKSPACES_ROOT), '.chisa-real-file-save-'));
  context.after(async () => { assert.equal(path.dirname(projectRoot), path.resolve(WORKSPACES_ROOT)); await rm(projectRoot, { recursive: true, force: true }); });
  const target = path.join(projectRoot, 'document.txt');
  await writeFile(target, 'original');
  let unavailable = false;
  type FileRequest = { op: string; path: string; b64?: string; expectedHash?: string };
  await startWorkspaceControl<FileRequest>(context, [projectRoot], false, async request => {
    assert.equal(request.path, '/workspace/document.txt');
    const bytes = await readFile(target);
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (request.op === 'read') return Response.json({ b64: bytes.toString('base64'), hash });
    assert.equal(request.op, 'write');
    if (unavailable) return Response.json({ error: 'transport unavailable', code: 'WORKSPACE_UNAVAILABLE' }, { status: 503 });
    if (request.expectedHash !== hash) return Response.json({ error: 'changed', code: 'CONTENT_CONFLICT' }, { status: 409 });
    const incoming = Buffer.from(request.b64!, 'base64');
    await writeFile(target, incoming);
    return Response.json({ hash: createHash('sha256').update(incoming).digest('hex') });
  });
  const service = createFileTreeService(createDependencies(bridgeFileSystem(createFakeFileSystem()), projectRoot));
  const loaded = await service.readTextFile('project', 'document.txt');
  assert.equal(loaded.content, 'original');
  const saved = await service.saveTextFile('project', 'document.txt', 'edited', loaded.hash);
  assert.equal(saved.success, true);
  assert.equal(await readFile(target, 'utf8'), 'edited');
  assert.equal((await service.readTextFile('project', 'document.txt')).hash, saved.hash);
  await assert.rejects(service.saveTextFile('project', 'document.txt', 'stale write', loaded.hash), { code: 'CONTENT_CONFLICT', statusCode: 409 });
  unavailable = true;
  await assert.rejects(service.saveTextFile('project', 'document.txt', 'unavailable write', saved.hash), { code: 'WORKSPACE_UNAVAILABLE', statusCode: 503 });
  assert.equal(await readFile(target, 'utf8'), 'edited');
});

test('file open maps only ENOENT and preserves workspace and permission failures', async () => {
  const projectRoot = path.resolve('file-tree-error-project');
  const unavailable = new AppError('cannot connect', { code: 'WORKSPACE_UNAVAILABLE', statusCode: 503 });
  for (const failure of [unavailable, Object.assign(new Error('denied'), { code: 'EACCES' })]) {
    const service = createFileTreeService(createDependencies(createFakeFileSystem({ access: async () => { throw failure; } }), projectRoot));
    await assert.rejects(service.openFile('project', 'file.txt'), error => error === failure);
  }
  const missing = createFileTreeService(createDependencies(createFakeFileSystem({ access: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } }), projectRoot));
  await assert.rejects(missing.openFile('project', 'file.txt'), { code: 'FILE_NOT_FOUND', statusCode: 404 });
});

test('workspace createEntry preserves a same-name file created after the absence check', async (context) => {
  const projectRoot = await mkdtemp(path.join(path.resolve(WORKSPACES_ROOT), '.chisa-file-create-'));
  context.after(() => {
    assert.equal(path.dirname(projectRoot), path.resolve(WORKSPACES_ROOT));
    return rm(projectRoot, { recursive: true, force: true });
  });
  const targetPath = path.join(projectRoot, 'notes.txt');
  const localContent = 'Created by the local editor';
  const requests: Array<{ op: string; path: string; expectedHash?: string | null; b64?: string }> = [];
  await startWorkspaceControl<typeof requests[number]>(context, [projectRoot], false, async request => {
    requests.push(request);
    if (request.op === 'stat' && request.path === '/workspace/notes.txt') {
      // The existence result was already determined before the local editor
      // created the file; the subsequent creation RPC must retain that intent.
      await writeFile(targetPath, localContent);
      return Response.json({ error: 'No such file', code: 'ENOENT' });
    }
    if (request.op === 'stat' && request.path === '/workspace') return Response.json({ ok: true });
    const bytes = await readFile(targetPath);
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (request.op === 'read') return Response.json({ b64: bytes.toString('base64'), hash });
    assert.equal(request.op, 'write');
    if (request.expectedHash !== hash) return Response.json({ error: 'File changed', code: 'CONTENT_CONFLICT' });
    await writeFile(targetPath, Buffer.from(request.b64!, 'base64'));
    return Response.json({ ok: true });
  });
  const service = createFileTreeService(createDependencies(bridgeFileSystem(createFakeFileSystem()), projectRoot));

  await assert.rejects(service.createEntry({
    projectId: 'project', parentPath: projectRoot, type: 'file', name: 'notes.txt',
  }), { code: 'CONTENT_CONFLICT' });
  assert.equal(await readFile(targetPath, 'utf8'), localContent);
  assert.deepEqual(requests.map(request => request.op), ['stat', 'stat', 'write']);
});

function createDependencies(
  fileSystem: FileTreeFileSystem,
  projectRoot: string,
): FileTreeServiceDependencies {
  return {
    fileSystem,
    projects: {
      getProjectPathById: async () => projectRoot,
    },
    workspace: {
      rootPath: projectRoot,
      validatePath: async (candidatePath) => ({ valid: true, resolvedPath: candidatePath }),
    },
    resolveMimeType: () => 'text/plain',
    fileSystemConcurrency: 4,
    logger: { error: () => undefined },
  };
}

test('listProjectFiles maps only missing roots and preserves workspace unavailable errors', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const missingService = createFileTreeService(createDependencies(createFakeFileSystem({
    access: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
  }), projectRoot));
  await assert.rejects(missingService.listProjectFiles('project-1'), {
    code: 'PROJECT_PATH_NOT_FOUND', statusCode: 404,
  });

  const unavailable = new AppError('Workspace connection unavailable', {
    code: 'WORKSPACE_UNAVAILABLE', statusCode: 503,
  });
  const unavailableService = createFileTreeService(createDependencies(createFakeFileSystem({
    access: async () => { throw unavailable; },
  }), projectRoot));
  await assert.rejects(unavailableService.listProjectFiles('project-1'), (error: unknown) => error === unavailable);
});

test('workspace directory listing supplies tree metadata without per-entry lstat RPCs', async (context) => {
  const projectRoot = await mkdtemp(path.join(path.resolve(WORKSPACES_ROOT), '.chisa-list-stats-'));
  context.after(() => {
    assert.equal(path.dirname(projectRoot), path.resolve(WORKSPACES_ROOT));
    return rm(projectRoot, { recursive: true, force: true });
  });
  const requests: Array<{ op: string; path: string; includeStats?: boolean }> = [];
  const modified = new Date('2026-01-02T03:04:05.000Z');
  await startWorkspaceControl<typeof requests[number]>(context, [projectRoot], true, async request => {
    requests.push(request);
    assert.equal(request.path, '/workspace');
    if (request.op === 'stat') return Response.json({ ok: true });
    assert.equal(request.op, 'list');
    assert.equal(request.includeStats, true);
    return Response.json({ entries: [{ name: 'linked.txt', dir: false, stats: {
      size: 31, mtime: modified.getTime() / 1000, mode: 0o640, dir: false, symlink: true,
    } }] });
  });
  const service = createFileTreeService(createDependencies(bridgeFileSystem(createFakeFileSystem()), projectRoot));
  const tree = await service.listProjectFiles('project-1');

  assert.deepEqual(requests.map(request => request.op), ['stat', 'list']);
  assert.deepEqual(tree, [{
    name: 'linked.txt', path: path.join(projectRoot, 'linked.txt'), type: 'file',
    size: 31, modified: modified.toISOString(), permissions: '640', permissionsRwx: 'rw-r-----', isSymlink: true,
  }]);
});

test('cloud snapshot reads preserve each result independently without local callbacks', async (context) => {
  const projectRoot = await mkdtemp(path.join(path.resolve(WORKSPACES_ROOT), '.chisa-cloud-read-'));
  context.after(() => { assert.equal(path.dirname(projectRoot), path.resolve(WORKSPACES_ROOT)); return rm(projectRoot, { recursive: true, force: true }); });
  const requests: Array<{ op: string; path: string }> = [];
  await startWorkspaceControl<typeof requests[number]>(context, [projectRoot], false, async request => {
    requests.push(request);
    if (request.path.endsWith('/missing')) return Response.json({ error: 'No such file', code: 'ENOENT' });
    if (request.path.endsWith('/unavailable')) return Response.json({ error: 'Workspace unavailable', code: 'WORKSPACE_UNAVAILABLE' });
    return Response.json({ size: 17, mtime: 1, mode: 0o644, dir: false, symlink: false });
  });
  const files = bridgeFileSystem(createFakeFileSystem());
  const results = await Promise.allSettled([files.stat(path.join(projectRoot, 'current')), files.lstat(path.join(projectRoot, 'missing')), files.stat(path.join(projectRoot, 'unavailable'))]);
  assert.equal(results[0]!.status, 'fulfilled');
  if (results[0]!.status === 'fulfilled') assert.equal(results[0]!.value.size, 17);
  assert.equal(results[1]!.status, 'rejected');
  if (results[1]!.status === 'rejected') assert.equal(results[1]!.reason.code, 'ENOENT');
  assert.equal(results[2]!.status, 'rejected');
  if (results[2]!.status === 'rejected') assert.equal(results[2]!.reason.code, 'WORKSPACE_UNAVAILABLE');
  assert.deepEqual(requests.map(request => request.op), ['stat', 'lstat', 'stat']);
});

test('cloud snapshot reads stay isolated between project bindings', async (context) => {
  const roots = await Promise.all([0, 1].map(() => mkdtemp(path.join(path.resolve(WORKSPACES_ROOT), '.chisa-read-isolation-'))));
  context.after(() => Promise.all(roots.map(root => {
    assert.equal(path.dirname(root), path.resolve(WORKSPACES_ROOT));
    return rm(root, { recursive: true, force: true });
  })));
  const requests: Array<{ cwd: string; op: string; paths: string[] }> = [];
  await startWorkspaceControl<{ op: string; path?: string; requests?: Array<{ path: string }> }>(context, roots, true, async (request, incoming) => {
    const items = request.requests ?? [request];
    const cwd = Buffer.from(String(incoming.headers['x-cwd']), 'latin1').toString('utf8');
    requests.push({ cwd, op: request.op, paths: items.map(item => item.path!) });
    const result = { ok: true, size: 1, mtime: 1, mode: 0o644, dir: false, symlink: false };
    return Response.json(request.op === 'batch' ? { ok: true, results: items.map(() => result) } : result);
  });
  const fileSystem = bridgeFileSystem(createFakeFileSystem());
  await Promise.all([
    ...Array.from({ length: 65 }, (_, index) => fileSystem.stat(path.join(roots[0]!, `first-${index}`))),
    fileSystem.stat(path.join(roots[1]!, 'second-0')),
    fileSystem.stat(path.join(roots[1]!, 'second-1')),
  ]);
  const firstBindingRequests = requests.filter(request => request.cwd === roots[0]);
  const secondBindingRequests = requests.filter(request => request.cwd === roots[1]);
  assert.equal(firstBindingRequests.length, 65);
  assert.equal(secondBindingRequests.length, 2);
  assert.ok(firstBindingRequests.every(request => request.op === 'stat' && request.paths.every(candidate => candidate.startsWith('/workspace/first-'))));
  assert.deepEqual(secondBindingRequests.flatMap(request => request.paths).sort(), ['/workspace/second-0', '/workspace/second-1']);
});

test('concurrent cloud file-tree traversals drain all directories and keep metadata', async (context) => {
  const projectRoot = await mkdtemp(path.join(path.resolve(WORKSPACES_ROOT), '.chisa-traversal-flight-'));
  context.after(() => {
    assert.equal(path.dirname(projectRoot), path.resolve(WORKSPACES_ROOT));
    return rm(projectRoot, { recursive: true, force: true });
  });
  let activeRequests = 0;
  let maximumActiveRequests = 0;
  let listedDirectories = 0;
  let requestCount = 0;
  const entry = (name: string, dir: boolean) => ({
    name, dir, stats: { size: dir ? 0 : 31, mtime: 1, mode: 0o644, dir, symlink: false },
  });
  const answer = (request: { op: string; path: string }) => {
    if (request.op === 'stat') return { ok: true, size: 0, mtime: 1, mode: 0o755, dir: true, symlink: false };
    assert.equal(request.op, 'list');
    listedDirectories += 1;
    return { ok: true, entries: request.path === '/workspace'
      ? Array.from({ length: 80 }, (_, index) => entry(`directory-${index}`, true))
      : [entry('source.ts', false)] };
  };
  await startWorkspaceControl<{ op: string; path: string; requests?: Array<{ op: string; path: string }> }>(context, [projectRoot], true, async request => {
    requestCount += 1;
    activeRequests += 1;
    maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
    await new Promise<void>(resolve => setImmediate(resolve));
    activeRequests -= 1;
    return Response.json(request.op === 'batch'
      ? { ok: true, results: request.requests!.map(answer) }
      : answer(request));
  });
  const fileSystem = bridgeFileSystem(createFakeFileSystem());
  const service = createFileTreeService({ ...createDependencies(fileSystem, projectRoot), fileSystemConcurrency: 64 });
  const trees = await Promise.all([service.listProjectFiles('project-1'), service.listProjectFiles('project-1')]);
  assert.ok(maximumActiveRequests <= 128, 'each traversal keeps its configured 64-reader limit');
  assert.equal(listedDirectories, 162);
  for (const tree of trees) {
    assert.equal(tree.length, 80);
    assert.ok(tree.every(directory => directory.children?.length === 1 && directory.children[0]!.size === 31));
  }
  const completedRequestCount = requestCount;
  await fileSystem.stat(projectRoot);
  assert.equal(requestCount, completedRequestCount + 1);
});

test('shallow project files expose vendor sources without recursively opening directories', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const readDirectories: string[] = [];
  let lstatCalls = 0;
  const fileSystem = createFakeFileSystem({
    stat: async () => createStats(true, 0o755),
    readTextFile: async filePath => {
      assert.equal(filePath, path.join(projectRoot, '.gitignore'));
      return '*.log';
    },
    openDirectory: createDirectoryReader(directoryPath => {
      readDirectories.push(directoryPath);
      assert.equal(directoryPath, projectRoot);
      return [
        { ...createDirectoryEntry('vendor', true), stats: createStats(true, 0o755) },
        createDirectoryEntry('.git', true),
        createDirectoryEntry('node_modules', true),
        createDirectoryEntry('ignored.log', false),
        { ...createDirectoryEntry('README.md', false), stats: createStats(false, 0o644) },
      ];
    }),
    lstat: async () => { lstatCalls += 1; return createStats(false, 0o644); },
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));
  const tree = await service.listProjectFiles('project-1', { respectGitignore: true, shallow: true });
  assert.deepEqual(tree.map(entry => entry.name), ['vendor', 'README.md']);
  assert.equal(tree[0]!.children, undefined);
  assert.equal(tree[0]!.permissions, '755');
  assert.equal(tree[1]!.size, 24);
  assert.deepEqual(readDirectories, [projectRoot]);
  assert.equal(lstatCalls, 0);
});

test('shallow child listings apply the project root gitignore using project-relative paths', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const childPath = path.join(projectRoot, 'vendor', 'source');
  const readDirectories: string[] = [];
  const fileSystem = createFakeFileSystem({
    realpath: async candidate => candidate,
    stat: async candidate => { assert.equal(candidate, childPath); return createStats(true, 0o755); },
    readTextFile: async candidate => {
      assert.equal(candidate, path.join(projectRoot, '.gitignore'));
      return 'vendor/source/ignored.ts\nvendor/source/generated/\n*.log\n!vendor/source/keep.log';
    },
    openDirectory: createDirectoryReader(directoryPath => {
      readDirectories.push(directoryPath);
      return [
        createDirectoryEntry('generated', true), createDirectoryEntry('node_modules', true),
        createDirectoryEntry('ignored.ts', false), createDirectoryEntry('debug.log', false),
        { ...createDirectoryEntry('keep.log', false), stats: createStats(false, 0o640) },
        { ...createDirectoryEntry('main.ts', false), stats: createStats(false, 0o644) },
      ];
    }),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));
  const tree = await service.listProjectFiles('project-1', {
    respectGitignore: true, shallow: true, directoryPath: path.join('vendor', 'source'),
  });
  assert.deepEqual(tree.map(entry => entry.name), ['keep.log', 'main.ts']);
  assert.deepEqual(tree.map(entry => entry.path), [path.join(childPath, 'keep.log'), path.join(childPath, 'main.ts')]);
  assert.deepEqual(readDirectories, [childPath]);
});

test('shallow directory requests reject traversal, escaping symlinks and file targets', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const unusedService = createFileTreeService(createDependencies(createFakeFileSystem(), projectRoot));
  await assert.rejects(unusedService.listProjectFiles('project-1', {
    respectGitignore: true, shallow: true, directoryPath: '../outside',
  }), { code: 'PATH_OUTSIDE_PROJECT', statusCode: 403 });
  const escapingService = createFileTreeService(createDependencies(createFakeFileSystem({
    realpath: async candidate => candidate === projectRoot ? projectRoot : path.resolve(projectRoot, '../outside'),
  }), projectRoot));
  await assert.rejects(escapingService.listProjectFiles('project-1', {
    respectGitignore: true, shallow: true, directoryPath: 'linked',
  }), { code: 'PATH_OUTSIDE_PROJECT', statusCode: 403 });
  const fileService = createFileTreeService(createDependencies(createFakeFileSystem({
    realpath: async candidate => candidate,
    stat: async () => createStats(false, 0o644),
  }), projectRoot));
  await assert.rejects(fileService.listProjectFiles('project-1', {
    respectGitignore: true, shallow: true, directoryPath: 'file.txt',
  }), { code: 'NOT_A_DIRECTORY', statusCode: 400 });
});

test('exactly 10000 visible entries still permit an empty directory at zero remaining budget', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const emptyPath = path.join(projectRoot, 'empty');
  const readDirectories: string[] = [];
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    openDirectory: createDirectoryReader(directoryPath => {
      readDirectories.push(directoryPath);
      return directoryPath === projectRoot ? [
        { ...createDirectoryEntry('empty', true), stats: createStats(true, 0o755) },
        ...Array.from({ length: 9_999 }, (_, index) => ({
          ...createDirectoryEntry(`file-${index}.txt`, false), stats: createStats(false, 0o644),
        })),
      ] : [];
    }),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));
  const tree = await service.listProjectFiles('project-1');
  assert.equal(tree.length, 10_000);
  assert.deepEqual(tree[0]!.children, []);
  assert.deepEqual(readDirectories, [projectRoot, emptyPath]);
});

test('confirmed entry cap refusal stops queued directory collectors before opening them', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const overflowingPath = path.join(projectRoot, 'directory-0');
  const readDirectories: string[] = [];
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    openDirectory: createDirectoryReader(directoryPath => {
      readDirectories.push(directoryPath);
      if (directoryPath === projectRoot) return Array.from({ length: 10 }, (_, index) => ({
        ...createDirectoryEntry(`directory-${index}`, true), stats: createStats(true, 0o755),
      }));
      return directoryPath === overflowingPath
        ? Array.from({ length: 9_991 }, (_, index) => createDirectoryEntry(`file-${index}.txt`, false))
        : [createDirectoryEntry('must-not-be-read.txt', false)];
    }),
  });
  const service = createFileTreeService({ ...createDependencies(fileSystem, projectRoot), fileSystemConcurrency: 1 });
  await assert.rejects(service.listProjectFiles('project-1'), { code: 'FILE_TREE_TOO_LARGE', statusCode: 413 });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(readDirectories, [projectRoot, overflowingPath]);
});

test('listProjectFiles applies gitignore alongside hard directory exclusions', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const documentationDirectory = path.join(projectRoot, 'docs');
  const buildDocumentationDirectory = path.join(documentationDirectory, 'build');
  const gitDirectory = path.join(projectRoot, '.git');
  const nodeModulesDirectory = path.join(projectRoot, 'node_modules');
  const sourceDirectory = path.join(projectRoot, 'src');
  const readDirectories: string[] = [];
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    readTextFile: async (filePath) => {
      assert.equal(filePath, path.join(projectRoot, '.gitignore'));
      return '*.log';
    },
    openDirectory: createDirectoryReader((directoryPath) => {
      readDirectories.push(directoryPath);
      if (directoryPath === projectRoot) {
        return [
          createDirectoryEntry('.git', true),
          createDirectoryEntry('node_modules', true),
          createDirectoryEntry('README.md', false),
          createDirectoryEntry('docs', true),
          createDirectoryEntry('src', true),
        ];
      }
      if (directoryPath === documentationDirectory) {
        return [createDirectoryEntry('build', true)];
      }
      if (directoryPath === buildDocumentationDirectory) {
        return [createDirectoryEntry('foo.md', false)];
      }
      if (directoryPath === sourceDirectory) {
        return [createDirectoryEntry('index.ts', false)];
      }
      return [];
    }),
    lstat: async (candidatePath) => createStats(
      candidatePath === documentationDirectory
        || candidatePath === buildDocumentationDirectory
        || candidatePath === sourceDirectory
        || candidatePath === gitDirectory
        || candidatePath === nodeModulesDirectory,
      0o754,
    ),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const tree = await service.listProjectFiles('project-1', { respectGitignore: true });

  assert.deepEqual(tree.map((entry) => entry.name), ['docs', 'src', 'README.md']);
  const documentationEntry = tree[0];
  assert.deepEqual(documentationEntry?.children?.map((entry) => entry.name), ['build']);
  assert.deepEqual(documentationEntry?.children?.[0]?.children?.map((entry) => entry.name), ['foo.md']);
  const sourceEntry = tree[1];
  assert.ok(sourceEntry);
  assert.equal(sourceEntry.type, 'directory');
  assert.equal(sourceEntry.permissions, '754');
  assert.equal(sourceEntry.permissionsRwx, 'rwxr-xr--');
  assert.deepEqual(sourceEntry.children?.map((entry) => entry.name), ['index.ts']);
  assert.equal(readDirectories.includes(gitDirectory), false);
  assert.equal(readDirectories.includes(nodeModulesDirectory), false);
});

test('listProjectFiles excludes gitignored entries only when requested', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const cacheDirectory = path.join(projectRoot, 'cache');
  const sourceDirectory = path.join(projectRoot, 'src');
  const readDirectories: string[] = [];
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    readTextFile: async (filePath) => {
      assert.equal(filePath, path.join(projectRoot, '.gitignore'));
      return ['*.log', '!keep.log', 'cache/', 'src/generated.ts'].join('\n');
    },
    openDirectory: createDirectoryReader((directoryPath) => {
      readDirectories.push(directoryPath);
      if (directoryPath === projectRoot) {
        return [
          createDirectoryEntry('.gitignore', false),
          createDirectoryEntry('cache', true),
          createDirectoryEntry('ignored.log', false),
          createDirectoryEntry('keep.log', false),
          createDirectoryEntry('src', true),
        ];
      }
      if (directoryPath === cacheDirectory) {
        return [createDirectoryEntry('cached.txt', false)];
      }
      if (directoryPath === sourceDirectory) {
        return [
          createDirectoryEntry('generated.ts', false),
          createDirectoryEntry('index.ts', false),
        ];
      }
      return [];
    }),
    lstat: async (candidatePath) => createStats(
      candidatePath === cacheDirectory || candidatePath === sourceDirectory,
      0o644,
    ),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const tree = await service.listProjectFiles('project-1', { respectGitignore: true });

  assert.deepEqual(tree.map((entry) => entry.name), ['src', '.gitignore', 'keep.log']);
  assert.deepEqual(tree[0]?.children?.map((entry) => entry.name), ['index.ts']);
  assert.equal(readDirectories.includes(cacheDirectory), false);
});

test('listProjectFiles falls back to conventional directory names when no gitignore exists', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const documentationDirectory = path.join(projectRoot, 'docs');
  const buildDocumentationDirectory = path.join(documentationDirectory, 'build');
  const nodeModulesDirectory = path.join(projectRoot, 'node_modules');
  const readDirectories: string[] = [];
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    readTextFile: async () => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    openDirectory: createDirectoryReader((directoryPath) => {
      readDirectories.push(directoryPath);
      if (directoryPath === projectRoot) {
        return [
          createDirectoryEntry('debug.log', false),
          createDirectoryEntry('docs', true),
          createDirectoryEntry('node_modules', true),
        ];
      }
      if (directoryPath === documentationDirectory) {
        return [
          createDirectoryEntry('build', true),
          createDirectoryEntry('guide.md', false),
        ];
      }
      if (directoryPath === buildDocumentationDirectory) {
        return [createDirectoryEntry('generated.md', false)];
      }
      return [];
    }),
    lstat: async (candidatePath) => createStats(candidatePath === documentationDirectory, 0o644),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const tree = await service.listProjectFiles('project-1', { respectGitignore: true });

  assert.deepEqual(tree.map((entry) => entry.name), ['docs', 'debug.log']);
  assert.deepEqual(tree[0]?.children?.map((entry) => entry.name), ['guide.md']);
  assert.equal(readDirectories.includes(nodeModulesDirectory), false);
  assert.equal(readDirectories.includes(buildDocumentationDirectory), false);
});

test('listProjectFiles rejects a tree that exceeds the server entry limit', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    openDirectory: createDirectoryReader((directoryPath) => directoryPath === projectRoot
      ? Array.from({ length: 10_001 }, (_, index) => createDirectoryEntry(`file-${index}.txt`, false))
      : []),
    lstat: async () => createStats(false, 0o644),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  await assert.rejects(
    service.listProjectFiles('project-1'),
    (error: unknown) => error instanceof AppError
      && error.code === 'FILE_TREE_TOO_LARGE'
      && error.statusCode === 413,
  );
});

test('listProjectFiles abandons a directory stream as soon as the entry limit is passed', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  let streamedEntries = 0;
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    // Endless on purpose: the walk has to stop consuming the stream itself
    // instead of waiting for the directory listing to be materialized.
    openDirectory: async function* (directoryPath) {
      if (directoryPath !== projectRoot) {
        return;
      }
      for (let index = 0; ; index += 1) {
        streamedEntries += 1;
        yield createDirectoryEntry(`file-${index}.txt`, false);
      }
    },
    lstat: async () => createStats(false, 0o644),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  await assert.rejects(
    service.listProjectFiles('project-1'),
    (error: unknown) => error instanceof AppError
      && error.code === 'FILE_TREE_TOO_LARGE'
      && error.statusCode === 413,
  );
  // The budget plus the single entry that proves it was exceeded.
  assert.equal(streamedEntries, 10_001);
});

test('listProjectFiles shares the entry limit across nested directories', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const firstDirectory = path.join(projectRoot, 'first');
  const secondDirectory = path.join(projectRoot, 'second');
  const directoryPaths = new Set([firstDirectory, secondDirectory]);
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    openDirectory: createDirectoryReader((directoryPath) => {
      if (directoryPath === projectRoot) {
        return [
          createDirectoryEntry('first', true),
          createDirectoryEntry('second', true),
        ];
      }
      if (directoryPaths.has(directoryPath)) {
        return Array.from(
          { length: 5_000 },
          (_, index) => createDirectoryEntry(`${path.basename(directoryPath)}-${index}.txt`, false),
        );
      }
      return [];
    }),
    lstat: async (candidatePath) => createStats(directoryPaths.has(candidatePath), 0o644),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  await assert.rejects(
    service.listProjectFiles('project-1'),
    (error: unknown) => error instanceof AppError
      && error.code === 'FILE_TREE_TOO_LARGE'
      && error.statusCode === 413,
  );
});

test('readTextFile rejects traversal before invoking the filesystem adapter', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const readPaths: string[] = [];
  const fileSystem = createFakeFileSystem({
    readTextFile: async (filePath) => {
      readPaths.push(filePath);
      return 'should not be read';
    },
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  await assert.rejects(
    service.readTextFile('project-1', '../secret.txt'),
    (error: unknown) => error instanceof AppError
      && error.code === 'PATH_OUTSIDE_PROJECT'
      && error.statusCode === 403,
  );
  assert.deepEqual(readPaths, []);
});

test('createEntry performs filesystem mutation only through the injected adapter', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const targetPath = path.join(projectRoot, 'notes.txt');
  const writtenFiles: Array<{ filePath: string; content: string }> = [];
  const fileSystem = createFakeFileSystem({
    access: async (candidatePath) => {
      if (candidatePath === targetPath) {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
    },
    writeTextFile: async (filePath, content) => {
      writtenFiles.push({ filePath, content });
    },
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const result = await service.createEntry({
    projectId: 'project-1',
    parentPath: projectRoot,
    type: 'file',
    name: 'notes.txt',
  });

  assert.equal(result.path, targetPath);
  assert.deepEqual(writtenFiles, [{ filePath: targetPath, content: '' }]);
});
