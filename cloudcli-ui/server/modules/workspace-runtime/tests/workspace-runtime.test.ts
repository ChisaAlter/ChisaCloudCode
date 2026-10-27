import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import * as realFiles from 'node:fs/promises';
import realOs from 'node:os';
import realPath from 'node:path';
import { promisify } from 'node:util';
import test, { mock } from 'node:test';

const files = new Map<string, string>();
const networks = new Map<string, { Name: string; Driver: string; Scope?: string; Labels: Record<string, string>; Options?: Record<string, string> }>();
const commands: string[][] = [];
const writes: string[] = [];
const retirements: Array<{ root: string; owner: string }> = [];
const operations: string[] = [];
let retirementFailure: Error | undefined;
let retirementGate: Promise<void> | undefined;
let onRetirement: (() => void) | undefined;
let networkFailure: string | undefined;
let unsafeDirectory = false;
let unsafeFile = false;
let fileSymlink = false;
let canonicalRoot: string | undefined;
const noEntry = () => Object.assign(new Error('absent'), { code: 'ENOENT' });
const directoryMetadata = () => ({ isDirectory: () => true, isSymbolicLink: () => unsafeDirectory, mode: 0o700, uid: process.getuid?.() ?? 0 });
mock.module('node:path', { defaultExport: realPath.posix, namedExports: { ...realPath.posix } });
mock.module('node:os', { defaultExport: { ...realOs, homedir: () => '/home/runtime' }, namedExports: { ...realOs, homedir: () => '/home/runtime' } });
mock.module('node:fs/promises', { namedExports: {
  ...realFiles,
  mkdir: async (_filename: string, options: { mode: number }) => { assert.equal(options.mode, 0o700); },
  lstat: async () => directoryMetadata(),
  stat: async () => ({ isDirectory: () => true }),
  realpath: async (filename: string) => filename === '/home/runtime' ? filename : canonicalRoot ?? filename,
  open: async (filename: string, flags: number, mode?: number) => {
    if ((flags & constants.O_CREAT) !== 0) {
      assert.ok((flags & constants.O_EXCL) !== 0, 'account state must use exclusive creation');
      assert.equal(mode, 0o600);
      if (files.has(filename) || fileSymlink) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      files.set(filename, '');
      writes.push('created');
    } else if (filename.endsWith('.json')) {
      if (fileSymlink) throw Object.assign(new Error('symlink'), { code: 'ELOOP' });
      if (!files.has(filename)) throw noEntry();
    }
    return {
      writeFile: async (value: string) => { files.set(filename, value); writes.push('written'); },
      sync: async () => { writes.push(filename.endsWith('.json') ? 'file-synced' : 'directory-synced'); },
      close: async () => {},
      stat: async () => ({ isFile: () => true, nlink: 1, mode: unsafeFile ? 0o666 : 0o600, uid: process.getuid?.() ?? 0, size: files.get(filename)?.length ?? 0 }),
      readFile: async () => files.get(filename),
    };
  },
} });
const fakeExec = Object.assign(() => undefined, { [promisify.custom]: async (command: string, args: string[]) => {
  assert.equal(command, 'docker');
  commands.push(args);
  operations.push('network-' + args[1]);
  assert.equal(args[0], 'network', 'network recovery delegates former container retirement to its own service');
  if (args[1] === 'inspect') {
    if (networkFailure) throw Object.assign(new Error('network inspection failed'), { stderr: networkFailure });
    const value = networks.get(args[2]);
    if (!value) throw Object.assign(new Error('absent'), { stderr: 'Error response from daemon: network ' + args[2] + ' not found' });
    return { stdout: JSON.stringify([value]), stderr: '' };
  }
  assert.equal(args[1], 'create');
  const name = args.at(-1)!;
  const [label, owner] = args[args.indexOf('--label') + 1].split('=');
  networks.set(name, { Name: name, Driver: 'bridge', Scope: 'local', Labels: { [label]: owner } });
  return { stdout: name, stderr: '' };
} });
mock.module('node:child_process', { namedExports: { ...childProcess, execFile: fakeExec as unknown as typeof childProcess.execFile } });
mock.module('../workspace-runtime-retirement.service.js', { namedExports: {
  retireWorkspaceSyncTransport: async (root: string, owner: string) => {
    retirements.push({ root, owner });
    operations.push('retire');
    assert.equal(JSON.parse([...files.values()][0]).owner, owner, 'persisted ownership must be verified before retirement');
    onRetirement?.();
    await retirementGate;
    if (retirementFailure) throw retirementFailure;
  },
} });
const originalWorkspacesRoot = process.env.WORKSPACES_ROOT;
process.env.WORKSPACES_ROOT = '/srv/runtime-test';
const { createWorkspaceRuntimeService, getWorkspaceRuntimeIdentity } = await import('../workspace-runtime.service.js');
const { getWorkspaceSyncNetwork, isWorkspaceSyncControlHost, registerWorkspaceSyncRecoveryTransport, isWorkspaceSyncRecoveryOnly } = await import('@/shared/index.js');
const platform = process.platform;
let caseNumber = 0;
test.before(() => Object.defineProperty(process, 'platform', { value: 'linux' }));
test.beforeEach(() => {
  process.env.WORKSPACES_ROOT = '/srv/runtime-test-' + ++caseNumber;
  files.clear(); networks.clear(); commands.length = 0; writes.length = 0;
  retirements.length = 0; operations.length = 0; retirementFailure = undefined; retirementGate = undefined; onRetirement = undefined;
  unsafeDirectory = unsafeFile = fileSymlink = false; networkFailure = canonicalRoot = undefined;
});
test.after(() => {
  Object.defineProperty(process, 'platform', { value: platform });
  if (originalWorkspacesRoot === undefined) delete process.env.WORKSPACES_ROOT;
  else process.env.WORKSPACES_ROOT = originalWorkspacesRoot;
});

test('runtime creates and restores an owned network without the sync sidecar or image', async () => {
  const service = createWorkspaceRuntimeService();
  const result = await service.restore('17');
  const root = process.env.WORKSPACES_ROOT!;
  const owner = createHash('sha256').update(root + '\0' + '17').digest('hex').slice(0, 24);
  assert.deepEqual(result, { root, owner, network: 'chisa-workspace-network-' + owner });
  assert.deepEqual(retirements, [{ root, owner }]);
  assert.deepEqual(operations, ['retire', 'network-inspect', 'network-create', 'network-inspect']);
  assert.deepEqual(getWorkspaceRuntimeIdentity(root + '/project'), { ...result, userId: '17' });
  assert.equal(getWorkspaceSyncNetwork(root + '/project'), result.network);
  assert.equal(getWorkspaceSyncNetwork(root + '-neighbor/project'), undefined);
  assert.equal(isWorkspaceSyncControlHost('172.25.0.18'), false, 'network registration cannot authorize a transport address');
  assert.deepEqual(writes, ['created', 'written', 'file-synced', 'directory-synced']);
  assert.deepEqual(JSON.parse([...files.values()][0]), { version: 1, root, owner, userId: '17' });
  await createWorkspaceRuntimeService().restore('17');
  assert.equal(commands.filter(args => args[1] === 'create').length, 1);
  assert.equal(commands.filter(args => args[1] === 'inspect').length, 3, 'restart must verify actual network ownership');
  assert.deepEqual(retirements, [{ root, owner }, { root, owner }], 'later restorations reverify former sync transport retirement');
});

test('concurrent restoration coalesces and a different account cannot take the same canonical root', async () => {
  canonicalRoot = '/srv/canonical-runtime-' + caseNumber;
  const first = createWorkspaceRuntimeService();
  const second = createWorkspaceRuntimeService();
  const [a, b] = await Promise.all([first.restore('17'), second.restore('17')]);
  assert.deepEqual(a, b);
  assert.equal(commands.length, 3);
  assert.deepEqual(retirements, [{ root: a.root, owner: a.owner }], 'concurrent requests share one retirement');
  const count = commands.length;
  await assert.rejects(second.restore('18'), { code: 'WORKSPACE_RUNTIME_MISMATCH' });
  assert.equal(commands.length, count, 'foreign identity cannot inspect or mutate Docker');
  assert.equal(retirements.length, 1, 'foreign identity cannot retire a container');
  assert.equal(JSON.parse([...files.values()][0]).userId, '17');
});

test('failed sync retirement blocks network recovery and identity registration until retry succeeds', async () => {
  const root = process.env.WORKSPACES_ROOT!;
  const failure = new Error('legacy sync stop was not confirmed');
  retirementFailure = failure;
  const service = createWorkspaceRuntimeService();
  await assert.rejects(service.restore('17'), error => error === failure);
  assert.deepEqual(operations, ['retire']);
  assert.equal(commands.length, 0);
  assert.equal(getWorkspaceRuntimeIdentity(root), undefined);
  assert.equal(getWorkspaceSyncNetwork(root + '/project'), undefined);
  const saved = [...files.values()][0];
  retirementFailure = undefined;
  const result = await service.restore('17');
  assert.equal(retirements.length, 2, 'failed retirement must be retried rather than cached');
  assert.equal([...files.values()][0], saved, 'retry must retain the account claim');
  assert.equal(getWorkspaceRuntimeIdentity(root)?.owner, result.owner);
});

test('pending revalidation retains the verified identity for admitted operations until the new inspection settles', async () => {
  const service = createWorkspaceRuntimeService();
  const restored = await service.restore('17');
  let markStarted!: () => void;
  let releaseRetirement!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  retirementGate = new Promise<void>(resolve => { releaseRetirement = resolve; });
  onRetirement = markStarted;
  const pending = service.restore('17');
  try {
    await started;
    assert.deepEqual(getWorkspaceRuntimeIdentity(restored.root + '/project'), { ...restored, userId: '17' });
    assert.equal(getWorkspaceSyncNetwork(restored.root + '/project'), restored.network);
    assert.equal(operations.at(-1), 'retire', 'the next network inspection is still waiting on retirement');
  } finally {
    releaseRetirement();
    await pending;
  }
  assert.equal(getWorkspaceRuntimeIdentity(restored.root)?.owner, restored.owner);
});

test('failed revalidation revokes the previously registered identity until a complete restoration succeeds', async () => {
  const service = createWorkspaceRuntimeService();
  const restored = await service.restore('17');
  assert.equal(getWorkspaceRuntimeIdentity(restored.root + '/project')?.owner, restored.owner);
  retirementFailure = new Error('legacy transport verification unavailable');
  await assert.rejects(service.restore('17'), error => error === retirementFailure);
  assert.equal(getWorkspaceRuntimeIdentity(restored.root + '/project'), undefined);
  retirementFailure = undefined;
  await service.restore('17');
  assert.equal(getWorkspaceRuntimeIdentity(restored.root)?.owner, restored.owner);
  networkFailure = 'Cannot connect to the Docker daemon';
  await assert.rejects(service.restore('17'), { stderr: networkFailure });
  assert.equal(getWorkspaceRuntimeIdentity(restored.root + '/project'), undefined);
  networkFailure = undefined;
  await service.restore('17');
  assert.equal(getWorkspaceRuntimeIdentity(restored.root)?.owner, restored.owner);
});

test('runtime restoration preserves a legacy sync recovery barrier', async () => {
  const root = process.env.WORKSPACES_ROOT!;
  registerWorkspaceSyncRecoveryTransport(root, '172.17.0.34');
  await createWorkspaceRuntimeService().restore('17');
  assert.equal(isWorkspaceSyncRecoveryOnly(root + '/project'), true);
});

test('foreign labels, nonlocal drivers and default bridge masquerading fail closed', async () => {
  const service = createWorkspaceRuntimeService();
  const restored = await service.restore('17');
  const network = networks.get(restored.network)!;
  for (const mutate of [
    () => { network.Labels['chisa.workspace-network.owner'] = 'foreign'; },
    () => { network.Driver = 'overlay'; },
    () => { network.Scope = 'swarm'; },
    () => { network.Options = { 'com.docker.network.bridge.default_bridge': 'true' }; },
  ]) {
    const original = structuredClone(network);
    mutate();
    const before = commands.length;
    await assert.rejects(service.restore('17'), { code: 'WORKSPACE_RUNTIME_MISMATCH' });
    assert.equal(commands.length, before + 1);
    Object.assign(network, original, { Options: original.Options });
  }
  await service.restore('17');
});

test('Docker errors other than the exact missing network cannot create or modify a network', async () => {
  const service = createWorkspaceRuntimeService();
  for (const stderr of ['permission denied', 'No such network: foreign', 'network other-account not found']) {
    networkFailure = stderr;
    await assert.rejects(service.restore('17'), { stderr });
  }
  assert.equal(commands.every(args => args[1] === 'inspect'), true);
  networkFailure = undefined;
  await service.restore('17');
  assert.equal(networks.size, 1, 'a failed restoration must not poison future retries');
});

test('untrusted state directory, symlinked identity and writable state never authorize a network', async () => {
  const service = createWorkspaceRuntimeService();
  unsafeDirectory = true;
  await assert.rejects(service.restore('17'), { code: 'WORKSPACE_RUNTIME_MISMATCH' });
  unsafeDirectory = false;
  fileSymlink = true;
  await assert.rejects(service.restore('17'), { code: 'ELOOP' });
  fileSymlink = false;
  unsafeFile = true;
  await assert.rejects(service.restore('17'), { code: 'WORKSPACE_RUNTIME_MISMATCH' });
  assert.equal(commands.length, 0);
  assert.equal(retirements.length, 0, 'unverified account ownership must never reach retirement');
});

test('malformed persisted state cannot be silently replaced after a restart', async () => {
  await createWorkspaceRuntimeService().restore('17');
  const [statePath] = files.keys();
  files.set(statePath, '{broken');
  const before = commands.length;
  await assert.rejects(createWorkspaceRuntimeService().restore('17'), { code: 'WORKSPACE_RUNTIME_MISMATCH' });
  assert.equal(files.get(statePath), '{broken');
  assert.equal(commands.length, before);
});
