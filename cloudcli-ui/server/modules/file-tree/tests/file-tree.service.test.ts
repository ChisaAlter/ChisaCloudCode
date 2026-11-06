import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fsPromises, { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import test, { mock } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createFileTreeService } from '@/modules/file-tree/file-tree.service.js';
import { AppError, WORKSPACES_ROOT, registerWorkspaceRuntimeNetwork, resolveReadOnlyRootPath, validateWorkspacePath } from '@/shared/index.js';
import type { FileTreeFileSystem } from '@/shared/index.js';

// The real bridge process adapter consumes semantic broker replies. The fixture
// implements only that public boundary; it never intercepts Docker spawning.
const fixtureUser = 'file-tree-account';
type ControlFixture = { handle(request: unknown, incoming: Pick<IncomingMessage, 'headers'>): Response | Promise<Response> };
const controls = new Map<string, ControlFixture>();
const leaseMappings = new Map<string, { legacy: string; broker: string; session: string; epoch: string }>();
const leaseOperations = new Map<string, Map<string, { output: PassThrough; input: Buffer[]; sequence: number; complete: boolean; profileId: string }>>();
let ownership: Pick<typeof import('@/modules/workspace-runtime/index.js'), 'readCloudWorkspaceOwner' | 'assertCloudWorkspaceOwner'>;
const readCloudWorkspaceOwner: typeof ownership.readCloudWorkspaceOwner = (...args) => ownership.readCloudWorkspaceOwner(...args);
const assertCloudWorkspaceOwner: typeof ownership.assertCloudWorkspaceOwner = (...args) => ownership.assertCloudWorkspaceOwner(...args);
const runtimeMock = mock.module('@/modules/workspace-runtime/index.js', { namedExports: {
  ensureCloudWorkspaceBinding() {}, excludeCloudWorkspaceMetadata() {}, getWorkspaceRuntimeIdentity() { return undefined; },
  async getWorkspaceBrokerAdmission(input: { userId: string; root: string; leaseId?: string; brokerLeaseId?: string; bindingEpoch: string; sessionId?: string }) {
    assert.equal(input.userId, fixtureUser);assert.equal(input.bindingEpoch, 'test-epoch');
    const control = controls.get(input.root);assert.ok(control, 'broker root must be in this fixture enrollment');
    const key = input.root + '\0' + (input.leaseId ?? 'readonly');
    let mapped = leaseMappings.get(key);
    if (!mapped) { mapped = { legacy: input.leaseId ?? 'readonly', broker: 'broker-' + createHash('sha256').update(key).digest('hex'), session: 'file-tree-session', epoch: input.bindingEpoch };leaseMappings.set(key, mapped); }
    if (input.brokerLeaseId) assert.equal(input.brokerLeaseId, mapped.broker);
    if (input.sessionId) assert.equal(input.sessionId, mapped.session);
    let operations = leaseOperations.get(key);
    if (!operations) { operations = new Map();leaseOperations.set(key, operations); }
    const proof = (permission: string, profileId: string) => { assert.ok(['worker-ro','worker-rw'].includes(profileId));return permission + ':' + profileId; };
    const receipt = (id: string) => { const operation = operations.get(id);assert.ok(operation);return { operationId: id, workspaceId: 'file-tree-workspace', generation: 'file-tree-generation', leaseId: mapped.broker, profileId: operation.profileId, kind: 'run' as const, state: operation.complete ? 'complete' as const : 'running' as const, cleanupConfirmed: operation.complete, writerLeaseHeld: !operation.complete, resourceId: createHash('sha256').update(id).digest('hex'), exitCode: 0 }; };
    const client = {
      async run(grant: string, request: { operationId: string; workspaceId: string; generation: string; leaseId: string; profileId: string; command: string[]; cwd: string }) {
        assert.equal(grant, proof('run', request.profileId));assert.equal(request.workspaceId, 'file-tree-workspace');assert.equal(request.generation, 'file-tree-generation');assert.equal(request.leaseId, mapped.broker);
        assert.deepEqual(request.command, ['python3','/opt/chisa/workspace.py']);assert.equal(request.cwd, '');
        assert.equal(operations.has(request.operationId), false);operations.set(request.operationId, { output: new PassThrough(), input: [], sequence: 0, complete: false, profileId: request.profileId });return receipt(request.operationId);
      },
      async writeStdin(grant: string, id: string, chunk: { sequence: number; data: Buffer; end?: boolean }) {
        const operation = operations.get(id);assert.ok(operation);assert.equal(grant, proof('stdin', operation.profileId));assert.equal(chunk.sequence, ++operation.sequence);operation.input.push(chunk.data);
        if (chunk.end) {
          try { const reply = await control.handle(JSON.parse(Buffer.concat(operation.input).toString()), { headers: { 'x-cwd': Buffer.from(input.root).toString('latin1') } });const payload = await reply.json() as Record<string, unknown>;operation.output.end(JSON.stringify({ ok: !payload.error,...payload })); }
          catch (error) { operation.output.destroy(error as Error);throw error; }
        }
        return { sequence: chunk.sequence, replay: false };
      },
      async stream(grant: string, id: string) { const operation = operations.get(id);assert.ok(operation);assert.equal(grant, proof('stream', operation.profileId));const iterator = (async function* () { for await (const bytes of operation.output) yield { channel: 'stdout' as const, data: Buffer.from(bytes) };return receipt(id); })();return { next: () => iterator.next(),return: () => iterator.return(receipt(id)) }; },
      async status(grant: string, id: string) { const operation = operations.get(id);assert.ok(operation);assert.equal(grant, proof('status', operation.profileId));return receipt(id); },
      async cancel(grant: string, id: string) { const operation = operations.get(id);assert.ok(operation);assert.equal(grant, proof('cancel', operation.profileId));operation.complete = true;return receipt(id); },
      async reconcile(grant: string, id: string) { const operation = operations.get(id);assert.ok(operation);assert.equal(grant, proof('reconcile', operation.profileId));operation.complete = true;return receipt(id); },
    };
    return { client, userId: fixtureUser, root: input.root, bindingEpoch: mapped.epoch, sessionId: mapped.session, leaseId: mapped.broker, legacyReservationId: mapped.legacy, workspaceId: 'file-tree-workspace', generation: 'file-tree-generation', profileId: 'worker-rw', proof };
  },
  async closeWorkspaceBrokerLease(input: { root: string; leaseId: string; brokerLeaseId?: string; bindingEpoch: string }) {
    const key=input.root+'\0'+input.leaseId; const mapped=leaseMappings.get(key);assert.ok(mapped);
    assert.equal(input.brokerLeaseId,mapped.broker);assert.equal(input.bindingEpoch,mapped.epoch);
    const operations=leaseOperations.get(key);assert.ok(operations);
    for (const operation of operations.values()) assert.equal(operation.complete,true,'whole lease may close only after every tracked operation is cleaned');
    return { version: 1, state: 'closed', legacyReservationId: input.leaseId, leaseId: mapped.broker, root: input.root, bindingEpoch: input.bindingEpoch, quiescent: true, cleanupConfirmed: true, resourceInventoryComplete: true,
      resources: [...operations.keys()].map(operationId => ({ operationId, resourceId: createHash('sha256').update(operationId).digest('hex'), kind: 'run', cleanupConfirmed: true })) };
  },
  readCloudWorkspaceOwner, assertCloudWorkspaceOwner,
  executeWorkspaceRuntimePreview() { assert.fail('unexpected preview'); },
} });
const { bridgeFileSystem } = await import('@/modules/workspace-bridge/index.js');
// Bridge has captured the mock public boundary; now restore only future imports
// so ownership validation comes from the real public runtime barrel.
runtimeMock.restore();
ownership = await import('@/modules/workspace-runtime/index.js');
type FileTreeDirectoryEntry = ReturnType<FileTreeFileSystem['openDirectory']> extends AsyncIterable<infer Entry> ? Entry : never;
type FileTreeServiceDependencies = Parameters<typeof createFileTreeService>[0];
type FileTreeStats = Awaited<ReturnType<FileTreeFileSystem['stat']>>;
type FileTreeServices = ReturnType<typeof createFileTreeService>;

const testDirectory = path.dirname(fileURLToPath(import.meta.url));

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
  const accountRoot = path.resolve(WORKSPACES_ROOT);
  const privateHome = await mkdtemp(path.join(accountRoot, '.chisa-file-tree-private-'));
  const previousRoot = process.env.WORKSPACES_ROOT;const previousProfiles = process.env.CHISA_WORKSPACE_BROKER_PROFILE_CONFIG;
  process.env.WORKSPACES_ROOT = accountRoot;
  const homeMock = mock.method(os, 'homedir', () => privateHome);
  const owner = createHash('sha256').update(accountRoot + '\0' + fixtureUser).digest('hex').slice(0, 24);
  const stateDirectory = path.join(privateHome, '.chisa-workspace-runtime');await fsPromises.mkdir(stateDirectory, { recursive: true });
  await writeFile(path.join(stateDirectory, createHash('sha256').update(accountRoot).digest('hex').slice(0, 24) + '.json'), JSON.stringify({ version: 1, root: accountRoot, userId: fixtureUser, owner }), { mode: 0o600 });
  const profileFile = path.join(privateHome, 'worker-profiles.json');
  await writeFile(profileFile, JSON.stringify({ version: 1, profiles: roots.flatMap(root => [true, false].map(readOnly => ({ workspaceId: 'file-tree-workspace', generation: 'file-tree-generation', root, profileId: readOnly ? 'worker-ro' : 'worker-rw', purpose: 'worker', readOnly, runtimeMounts: [], gitMounts: [] }))) }), { mode: 0o600 });
  process.env.CHISA_WORKSPACE_BROKER_PROFILE_CONFIG = profileFile;
  registerWorkspaceRuntimeNetwork(accountRoot, 'chisa-workspace-network-' + owner, owner);
  for (const root of roots) { controls.set(root, { handle: (request, incoming) => handle(request as T, incoming) });await writeFile(path.join(root, '.chisa-bridge.json'), JSON.stringify({ protocol: 3, root, owner, bindingEpoch: 'test-epoch' }));assert.equal(readCloudWorkspaceOwner(root), fixtureUser); }
  context.after(async () => {
    homeMock.mock.restore();
    if (previousRoot === undefined) delete process.env.WORKSPACES_ROOT;else process.env.WORKSPACES_ROOT = previousRoot;
    if (previousProfiles === undefined) delete process.env.CHISA_WORKSPACE_BROKER_PROFILE_CONFIG;else process.env.CHISA_WORKSPACE_BROKER_PROFILE_CONFIG = previousProfiles;
    for (const root of roots) { controls.delete(root);for (const key of leaseMappings.keys()) if (key.startsWith(root + '\0')) { leaseMappings.delete(key);leaseOperations.delete(key); } }
    assert.equal(path.dirname(privateHome), accountRoot);await rm(privateHome, { recursive: true, force: true });
  });
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
      resolveReadOnlyRootPath: async () => null,
    },
    resolveMimeType: () => 'text/plain',
    fileSystemConcurrency: 4,
    logger: { error: () => undefined },
  };
}

test('cloud folder browsing skips SSH metadata before bridge dispatch and only lists the current directory', async () => {
  const workspaceRoot = path.resolve(WORKSPACES_ROOT);
  const opened: string[] = [];
  const metadata: string[] = [];
  const host = createFakeFileSystem({
    access: async candidate => { assert.equal(candidate, workspaceRoot); },
    stat: async candidate => { assert.equal(candidate, workspaceRoot); return createStats(true, 0o755); },
    realpath: async candidate => candidate,
    lstat: async candidate => { metadata.push(candidate); return createStats(true, 0o755); },
    openDirectory: createDirectoryReader(candidate => {
      opened.push(candidate);
      assert.equal(candidate, workspaceRoot, 'the chooser must not open child directories');
      return [
        createDirectoryEntry('.chisa-ssh-projects', true),
        createDirectoryEntry('zeta', true),
        createDirectoryEntry('.config', true),
        createDirectoryEntry('Projects', true),
        createDirectoryEntry('.chisa-ssh-projects-other', true),
        createDirectoryEntry('node_modules', true),
        createDirectoryEntry('README.md', false),
      ];
    }),
  });
  // Production's bridge rejects the metadata container even when no binding is missing.
  const service = createFileTreeService(createDependencies(bridgeFileSystem(host), workspaceRoot));
  for (const input of ['~', null, workspaceRoot]) {
    const result = await service.browseWorkspace(input);
    assert.equal(result.path, workspaceRoot);
    assert.deepEqual(result.suggestions, ['Projects', 'zeta', '.chisa-ssh-projects-other', '.config'].map(name => ({
      name, path: path.join(workspaceRoot, name), type: 'directory',
    })));
  }
  assert.deepEqual(opened, [workspaceRoot, workspaceRoot, workspaceRoot]);
  assert.deepEqual(metadata, [], 'folder suggestions do not need per-entry metadata');
});

test('legacy root project trees never traverse or expose SSH metadata containers', async () => {
  const workspaceRoot = path.resolve(WORKSPACES_ROOT);
  const opened: string[] = [];
  const host = createFakeFileSystem({
    access: async () => undefined,
    stat: async () => createStats(true, 0o755),
    openDirectory: createDirectoryReader(candidate => {
      opened.push(candidate);
      assert.equal(candidate, workspaceRoot);
      return [createDirectoryEntry('.chisa-ssh-projects', true), { ...createDirectoryEntry('README.md', false), stats: createStats(false, 0o644) }];
    }),
  });
  const service = createFileTreeService(createDependencies(bridgeFileSystem(host), workspaceRoot));
  for (const options of [undefined, { shallow: true, respectGitignore: false }]) {
    assert.deepEqual((await service.listProjectFiles('legacy-project', options)).map(entry => entry.name), ['README.md']);
  }
  assert.deepEqual(opened, [workspaceRoot, workspaceRoot]);
});

test('cloud chooser rejects explicit SSH metadata roots and descendants before filesystem access', async () => {
  const workspaceRoot = path.resolve('cloud-folder-test');
  const canonicalRoot = path.resolve('canonical-cloud-folder-test');
  const dependencies = createDependencies(createFakeFileSystem({ realpath: async () => canonicalRoot }), workspaceRoot);
  dependencies.workspace.validatePath = async candidate => ({ valid: true, resolvedPath: candidate.replace(workspaceRoot, canonicalRoot) });
  const service = createFileTreeService(dependencies);
  for (const candidate of [
    '~/.chisa-ssh-projects', '~/.chisa-ssh-projects/project/new',
    path.join(workspaceRoot, '.chisa-ssh-projects'),
    path.join(canonicalRoot, '.chisa-ssh-projects', 'project'),
  ]) {
    await assert.rejects(service.browseWorkspace(candidate), { code: 'SSH_ANCHOR_RESERVED', statusCode: 400 });
    await assert.rejects(service.createWorkspaceFolder(candidate), { code: 'SSH_ANCHOR_RESERVED', statusCode: 400 });
  }
});

test('cloud chooser hides canonical SSH metadata but preserves same-named ordinary nested directories', async () => {
  const workspaceRoot = path.resolve('cloud-folder-test');
  const canonicalRoot = path.resolve('canonical-cloud-folder-test');
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    stat: async () => createStats(true, 0o755),
    realpath: async () => canonicalRoot,
    openDirectory: createDirectoryReader(() => [createDirectoryEntry('.chisa-ssh-projects', true)]),
  });
  const dependencies = createDependencies(fileSystem, workspaceRoot);
  dependencies.workspace.validatePath = async candidate => ({ valid: true, resolvedPath: candidate.replace(workspaceRoot, canonicalRoot) });
  const service = createFileTreeService(dependencies);
  assert.deepEqual((await service.browseWorkspace('~')).suggestions, []);
  const nested = path.join(canonicalRoot, 'Projects');
  assert.deepEqual((await service.browseWorkspace(path.join(workspaceRoot, 'Projects'))).suggestions, [{
    name: '.chisa-ssh-projects', path: path.join(nested, '.chisa-ssh-projects'), type: 'directory',
  }]);
  dependencies.workspace.validatePath = async () => ({ valid: true, resolvedPath: path.join(canonicalRoot, '.chisa-ssh-projects', 'aliased') });
  await assert.rejects(service.browseWorkspace(path.join(workspaceRoot, 'alias')), { code: 'SSH_ANCHOR_RESERVED' });
  await assert.rejects(service.createWorkspaceFolder(path.join(workspaceRoot, 'alias', 'new')), { code: 'SSH_ANCHOR_RESERVED' });
});

test('cloud browsing reports an unreadable or disappeared directory instead of a successful empty listing', async () => {
  const workspaceRoot = path.resolve('cloud-folder-test');
  for (const [code, statusCode] of [['EACCES', 403], ['EPERM', 403], ['ENOENT', 404], ['EIO', undefined]] as const) {
    const failure = Object.assign(new Error('cannot list directory'), { code });
    const service = createFileTreeService(createDependencies(createFakeFileSystem({
      realpath: async candidate => candidate,
      access: async () => undefined,
      stat: async () => createStats(true, 0o755),
      openDirectory: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => { throw failure; } }) }),
    }), workspaceRoot));
    if (statusCode) await assert.rejects(service.browseWorkspace('~'), { code, statusCode });
    else await assert.rejects(service.browseWorkspace('~'), error => error === failure);
  }
});

test('cloud folder creation still permits ordinary and similarly named sibling directories', async () => {
  const workspaceRoot = path.resolve('cloud-folder-test');
  const created: string[] = [];
  const service = createFileTreeService(createDependencies(createFakeFileSystem({
    realpath: async candidate => candidate,
    access: async candidate => {
      if (candidate === workspaceRoot) return;
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    makeDirectory: async (candidate, recursive) => { assert.equal(recursive, false); created.push(candidate); },
  }), workspaceRoot));
  for (const name of ['new-project', '.chisa-ssh-projects-other']) {
    const target = path.join(workspaceRoot, name);
    assert.deepEqual(await service.createWorkspaceFolder(`~/${name}`), { success: true, path: target });
  }
  assert.deepEqual(created, [path.join(workspaceRoot, 'new-project'), path.join(workspaceRoot, '.chisa-ssh-projects-other')]);
});

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

test('readTextFile reports a directory as a client error, not a 500', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const fileSystem = createFakeFileSystem({
    readTextFile: async () => {
      const error = new Error('EISDIR: illegal operation on a directory, read');
      (error as NodeJS.ErrnoException).code = 'EISDIR';
      throw error;
    },
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  await assert.rejects(
    service.readTextFile('project-1', 'decisions'),
    (error: unknown) => error instanceof AppError
      && error.code === 'EISDIR'
      && error.statusCode === 400
      && error.message === 'Path is a directory, not a file',
  );
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

/**
 * Builds the service against the real filesystem and the real workspace policy,
 * which is the only way to exercise the read-only roots: the whole guarantee
 * rests on `realpath` resolving symlinks before the comparison.
 */
function createRealFileSystemService(projectRoot: string, workspaceRoot = projectRoot): FileTreeServices {
  return createFileTreeService({
    fileSystem: {
      access: (candidatePath) => fsPromises.access(candidatePath),
      stat: (candidatePath) => fsPromises.stat(candidatePath),
      lstat: (candidatePath) => fsPromises.lstat(candidatePath),
      openDirectory: async function* (directoryPath) {
        yield* await fsPromises.opendir(directoryPath);
      },
      realpath: (candidatePath) => fsPromises.realpath(candidatePath),
      readTextFile: (filePath) => fsPromises.readFile(filePath, 'utf8'),
      writeTextFile: (filePath, content) => fsPromises.writeFile(filePath, content, 'utf8'),
      async makeDirectory(directoryPath, recursive) {
        await fsPromises.mkdir(directoryPath, { recursive });
      },
      rename: (oldPath, newPath) => fsPromises.rename(oldPath, newPath),
      async removeDirectory(directoryPath) {
        await fsPromises.rm(directoryPath, { recursive: true, force: true });
      },
      unlink: (filePath) => fsPromises.unlink(filePath),
      copyFile: (source, destination) => fsPromises.copyFile(source, destination),
      createReadStream: (filePath) => createReadStream(filePath),
    },
    projects: { getProjectPathById: async () => projectRoot },
    workspace: {
      rootPath: workspaceRoot,
      validatePath: async (candidatePath) => {
        const relative = path.relative(workspaceRoot, candidatePath);
        if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
          return { valid: false, error: 'Path is outside the workspace root' };
        }
        return { valid: true, resolvedPath: candidatePath };
      },
      resolveReadOnlyRootPath: (candidatePath) => resolveReadOnlyRootPath(candidatePath),
    },
    resolveMimeType: () => 'text/plain',
    fileSystemConcurrency: 4,
    logger: { error: () => undefined },
  });
}

test('the temp directory can be browsed and read, but never written to', async () => {
  const temporaryDirectory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'file-tree-tmp-'));
  const projectRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'file-tree-project-'));

  try {
    // The shape a task notification quotes: an agent's output file written to
    // the system temp directory, outside every project.
    await fsPromises.mkdir(path.join(temporaryDirectory, 'tasks'));
    const outputPath = path.join(temporaryDirectory, 'tasks', 'agent.output');
    await fsPromises.writeFile(outputPath, 'what the agent found', 'utf8');

    const service = createRealFileSystemService(projectRoot);

    const browsed = await service.browseWorkspace(temporaryDirectory);
    assert.deepEqual(browsed.suggestions.map((entry) => entry.name), ['tasks']);

    const opened = await service.readTextFile('project-1', outputPath);
    assert.equal(opened.content, 'what the agent found');

    const streamed = await service.openFile('project-1', outputPath);
    streamed.stream.destroy();

    // Read-only means read-only: nothing may be created or changed there.
    await assert.rejects(
      service.saveTextFile('project-1', outputPath, 'overwritten'),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    await assert.rejects(
      service.createWorkspaceFolder(path.join(temporaryDirectory, 'new-folder')),
      (error: unknown) => (error as AppError).code === 'INVALID_WORKSPACE_PATH',
    );
    await assert.rejects(
      service.createEntry({
        projectId: 'project-1',
        parentPath: path.join(temporaryDirectory, 'tasks'),
        type: 'file',
        name: 'planted.txt',
      }),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    await assert.rejects(
      service.renameEntry({ projectId: 'project-1', oldPath: outputPath, newName: 'renamed.output' }),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    const uploadedTemporaryPath = path.join(projectRoot, 'upload.tmp');
    await fsPromises.writeFile(uploadedTemporaryPath, 'upload', 'utf8');
    await assert.rejects(
      service.storeUploadedFiles({
        projectId: 'project-1',
        targetPath: path.join(temporaryDirectory, 'tasks'),
        relativePaths: [],
        requestedFileCount: 1,
        files: [{ originalName: 'upload.txt', temporaryPath: uploadedTemporaryPath, size: 6, mimeType: 'text/plain' }],
      }),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    await assert.rejects(
      service.deleteEntry({ projectId: 'project-1', targetPath: outputPath }),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    assert.deepEqual(await fsPromises.readdir(path.join(temporaryDirectory, 'tasks')), ['agent.output']);
    assert.equal(await fsPromises.readFile(outputPath, 'utf8'), 'what the agent found');
  } finally {
    await fsPromises.rm(temporaryDirectory, { recursive: true, force: true });
    await fsPromises.rm(projectRoot, { recursive: true, force: true });
  }
});

test('reading through a symlink out of the temp directory is still refused', async () => {
  const temporaryDirectory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'file-tree-tmp-'));
  const projectRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'file-tree-project-'));
  // The link target has to sit under no read-only root. Beside this file is
  // deterministic; a directory under `$HOME` lands under `/tmp` whenever a
  // test run isolates its home there, and the Claude projects directory is a
  // read-only root too.
  const outsideDirectory = await fsPromises.mkdtemp(path.join(testDirectory, 'file-tree-outside-'));

  try {
    assert.equal(await resolveReadOnlyRootPath(outsideDirectory), null);
    await fsPromises.writeFile(path.join(outsideDirectory, 'secret.txt'), 'secret', 'utf8');
    await fsPromises.symlink(outsideDirectory, path.join(temporaryDirectory, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');

    const service = createRealFileSystemService(projectRoot);
    await assert.rejects(
      service.readTextFile('project-1', path.join(temporaryDirectory, 'escape', 'secret.txt')),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
  } finally {
    await fsPromises.rm(temporaryDirectory, { recursive: true, force: true });
    await fsPromises.rm(projectRoot, { recursive: true, force: true });
    await fsPromises.rm(outsideDirectory, { recursive: true, force: true });
  }
});

test('a file in another folder of the workspace can be read, but never written to', async () => {
  // Both sit beside this file, outside every read-only root, for the reason
  // given in the symlink test above.
  const workspaceRoot = await fsPromises.mkdtemp(path.join(testDirectory, 'file-tree-workspace-'));
  const projectRoot = path.join(workspaceRoot, 'project');
  const siblingDirectory = path.join(workspaceRoot, '.runs', 'run-1');
  const outsideDirectory = await fsPromises.mkdtemp(path.join(testDirectory, 'file-tree-outside-'));

  try {
    await fsPromises.mkdir(projectRoot);
    await fsPromises.mkdir(siblingDirectory, { recursive: true });
    const reportPath = path.join(siblingDirectory, 'report.md');
    await fsPromises.writeFile(reportPath, 'what the run found', 'utf8');
    await fsPromises.writeFile(path.join(outsideDirectory, 'secret.txt'), 'secret', 'utf8');
    await fsPromises.symlink(outsideDirectory, path.join(workspaceRoot, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');

    const service = createRealFileSystemService(projectRoot, workspaceRoot);

    const opened = await service.readTextFile('project-1', reportPath);
    assert.equal(opened.content, 'what the run found');
    const streamed = await service.openFile('project-1', reportPath);
    streamed.stream.destroy();

    await assert.rejects(
      service.saveTextFile('project-1', reportPath, 'overwritten'),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    await assert.rejects(
      service.deleteEntry({ projectId: 'project-1', targetPath: reportPath }),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    assert.equal(await fsPromises.readFile(reportPath, 'utf8'), 'what the run found');

    // A link inside the workspace does not open what lies outside it.
    await assert.rejects(
      service.readTextFile('project-1', path.join(workspaceRoot, 'escape', 'secret.txt')),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
  } finally {
    await fsPromises.rm(workspaceRoot, { recursive: true, force: true });
    await fsPromises.rm(outsideDirectory, { recursive: true, force: true });
  }
});
