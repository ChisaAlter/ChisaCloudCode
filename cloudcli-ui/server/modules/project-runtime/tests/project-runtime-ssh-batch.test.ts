import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import type { Options } from '@anthropic-ai/claude-agent-sdk';

import type { ProjectRuntimeLaunchContext, ProjectRuntimeManifest, WorkspaceDescriptor } from '@/shared/index.js';

type ProjectFiles = {
  read(candidate: string): Promise<{ content: string; hash: string } | null>;
  list(candidate: string): Promise<Array<{ name: string; directory: boolean }>>;
};
type Operation = { op: string; path: string; includeStats?: boolean };
type Response = Record<string, unknown>;
type Transform = (operation: Operation, result: Response, batch: number, index: number) => Response;
let action: (files: ProjectFiles) => Promise<void> = async () => {};
let resolvers = 0;
let saved: ProjectRuntimeManifest | undefined;
mock.module('@anthropic-ai/claude-agent-sdk', { namedExports: {
  tool(name: string, _description: string, _schema: unknown, invoke: unknown) { return { name, invoke }; },
  createSdkMcpServer(input: unknown) { return input; },
} });
// Exercise the real service filesystem boundary directly, independently of the
// content resolver's optional prefetch scheduling and parsing behavior.
mock.module('../project-runtime-content.service.js', { namedExports: {
  createProjectContentResolver(files: ProjectFiles) {
    const project = resolvers++ === 0;
    return {
      async resolve() {
        if (project) await action(files);
        return { instructions: '', sources: [], skills: [], warnings: [], projectSettings: {}, localSettings: {} };
      },
      async rulesForPath() { return ''; },
      async activateSkill() { assert.fail('Not used by inspection tests'); },
    };
  },
} });
mock.module('../project-runtime-state.service.js', { namedExports: {
  saveProjectRuntimeManifest(_user: string, manifest: ProjectRuntimeManifest) { saved = manifest; },
  updateProjectRuntimeManifest(_user: string, _project: string, _run: string, manifest: ProjectRuntimeManifest) { saved = manifest; },
  readProjectMemory() { return { content: '', hash: '' }; },
  writeProjectMemory() { assert.fail('Read-only preparation cannot write memory'); },
} });
const { prepareProjectRuntime } = await import('../project-runtime.service.js');
const hash = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');
const absent = () => Object.assign(new Error('Missing fixture path'), { code: 'ENOENT' });
const metadata = (dir: boolean, size = 0) => ({ size, mtime: 1, mode: dir ? 0o040755 : 0o100644, dir, symlink: false });
const skillPath = '.claude/skills/check/SKILL.md';
const skillDirectory = '.claude/skills/check';

function startupSnapshot(content: string | Buffer = 'Fixture skill'): Response {
  const bytes = Buffer.from(content);
  return { ok: true, protocol: 1, platform: 'win32', snapshotVersion: 1,
    files: [
      ...['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md', '.claude/settings.json', '.claude/settings.local.json', '.mcp.json'].map(candidate => ({ path: candidate, missing: true })),
      { path: skillPath, stats: metadata(false, bytes.length), b64: bytes.toString('base64'), hash: hash(bytes) },
    ],
    directories: [
      { path: '.claude/rules', entries: [] },
      { path: '.claude/skills', entries: [{ name: 'check', dir: true, stats: metadata(true) }] },
      { path: skillDirectory, entries: [{ name: 'SKILL.md', dir: false, stats: metadata(false, bytes.length) }] },
    ],
  };
}

async function fixture(run: (current: Awaited<ReturnType<typeof createFixture>>) => Promise<void>, mode: WorkspaceDescriptor['sourceMode'] | null = 'ssh') {
  const current = await createFixture(mode === null ? undefined : mode);
  try {
    await run(current);
    const snapshots = current.requests.filter(request => request.op === 'project_snapshot');
    if (mode === 'ssh' && current.requests.length) assert.deepEqual(snapshots, [{ op: 'project_snapshot' }], 'one capability dispatch is shared for the whole preparation');
    else assert.deepEqual(snapshots, [], 'cloud/legacy and already-cancelled preparations never probe snapshot support');
  } finally {
    assert.equal(path.dirname(path.resolve(current.root)), path.resolve(tmpdir()));
    assert.ok(path.basename(current.root).startsWith('project-runtime-ssh-batch-'));
    await rm(current.root, { recursive: true, force: true });
  }
}
async function createFixture(mode: WorkspaceDescriptor['sourceMode']) {
  const root = await mkdtemp(path.join(tmpdir(), 'project-runtime-ssh-batch-'));
  const account = path.join(root, 'account');
  await mkdir(account);
  const controller = new AbortController();
  const remote = new Map<string, string>([[skillPath, 'Fixture skill'], ['other.md', 'Other configuration']]);
  const requests: Array<Record<string, unknown>> = [];
  // Keep full dispatches above; inspection counts exclude only the explicit
  // older-helper capability refusal and still measure each real batch call.
  const inspections: Array<Record<string, unknown>> = [];
  const operations: Operation[] = [];
  let snapshotResponse: (() => unknown) | undefined;
  let transform: Transform = (_operation, value) => value;
  let envelope: (value: Response) => unknown = value => value;
  let afterExecute: () => void = () => {};
  let current = true;
  const assertCurrent = () => {
    if (!current) throw Object.assign(new Error('Workspace generation changed'), { code: 'WORKSPACE_GENERATION_CHANGED' });
  };
  function inspect(operation: Operation, batch: number, index: number): Response {
    assert.ok(['lstat', 'read', 'list'].includes(operation.op));
    assert.ok(operation.path.startsWith('/workspace/'));
    assert.equal(operation.path.includes(account), false);
    operations.push(operation);
    const relative = operation.path.slice('/workspace/'.length);
    const text = remote.get(relative);
    const children = [...remote.keys()].filter(name => name.startsWith(relative + '/'));
    let result: Response;
    if (operation.op === 'lstat') {
      if (text !== undefined) result = metadata(false, Buffer.byteLength(text));
      else if (children.length) result = metadata(true);
      else throw absent();
    } else if (operation.op === 'read') {
      if (text === undefined) throw absent();
      result = { b64: Buffer.from(text).toString('base64'), hash: hash(text) };
    } else {
      if (!children.length) throw absent();
      assert.equal(operation.includeStats, true);
      const names = new Map<string, boolean>();
      for (const child of children) {
        const [name, ...rest] = child.slice(relative.length + 1).split('/');
        names.set(name, rest.length > 0);
      }
      result = { entries: [...names].map(([name, dir]) => ({ name, dir, stats: metadata(dir) })), truncated: false };
    }
    return transform(operation, result, batch, index);
  }
  const execute: Parameters<typeof prepareProjectRuntime>[0]['execute'] = async (request, signal) => {
    assert.equal(signal, controller.signal, 'retain the caller cancellation/deadline signal for every batch');
    signal?.throwIfAborted();
    assertCurrent();
    requests.push(request);
    if (request.op === 'project_snapshot') {
      assert.deepEqual(request, { op: 'project_snapshot' }, 'snapshot cannot override the admitted owner or root');
      if (!snapshotResponse) throw Object.assign(new Error('Fixture helper does not support startup snapshots'), { code: 'SSH_WORKSPACE_REQUEST_INVALID' });
      const value = snapshotResponse();
      afterExecute();
      return value as Awaited<ReturnType<Parameters<typeof prepareProjectRuntime>[0]['execute']>>;
    }
    inspections.push(request);
    let result: unknown;
    if (request.op === 'batch') {
      assert.ok(Array.isArray(request.requests), 'actual native schema is requests, never operations');
      assert.equal(request.operations, undefined);
      assert.ok(request.requests.length >= 1 && request.requests.length <= 64);
      const batch = inspections.length;
      // Array.map stops at the first thrown ENOENT, matching Invoke-Operation.
      result = envelope({ results: request.requests.map((row, index) => inspect(row, batch, index)), ok: true, protocol: 1, platform: 'win32' });
    } else result = inspect(request as Operation, inspections.length, 0);
    afterExecute();
    return result as Awaited<ReturnType<Parameters<typeof prepareProjectRuntime>[0]['execute']>>;
  };
  const descriptor: WorkspaceDescriptor = { workspaceId: 'workspace', projectId: 'project', generation: 'generation', kind: 'session',
    sessionId: 'session', sourceMode: mode, rootPath: root, sourceRoot: root, requestedMode: 'shared', effectiveMode: 'shared',
    phase: 'running', publicationState: 'integrated',
    capabilities: { read: true, write: true, git: true, shell: true, preview: false, integrate: false, cloudExecutionIndependentOfDesktop: false } };
  const launch: ProjectRuntimeLaunchContext = { userId: 'user', configDir: account, accountKey: 'account', sessionId: 'session', prompt: '' };
  return { root, remote, requests, inspections, operations, controller,
    setSnapshot(value: () => unknown) { snapshotResponse = value; },
    setTransform(value: Transform) { transform = value; },
    setEnvelope(value: typeof envelope) { envelope = value; },
    afterExecute(value: typeof afterExecute) { afterExecute = value; },
    setCurrent(value: boolean) { current = value; },
    async prepare(inspectProject: typeof action) {
      action = inspectProject; resolvers = 0; saved = undefined;
      const options: Options = { permissionMode: 'default' };
      return prepareProjectRuntime({ descriptor, launch, options, signal: controller.signal, execute, assertCurrent });
    },
  };
}

function candidateOps(candidate: string): Operation[] {
  let cursor = '/workspace';
  return candidate.split('/').map(component => ({ op: 'lstat', path: cursor += '/' + component }));
}

test('older SSH helper uses two ordered file-inspection batches after one snapshot capability refusal', async () => fixture(async current => {
  const runtime = await current.prepare(async files => {
    assert.deepEqual(await files.read(skillPath), { content: 'Fixture skill', hash: hash('Fixture skill') });
    const before = candidateOps(skillPath);
    assert.deepEqual(current.inspections, [
      { op: 'batch', requests: before },
      { op: 'batch', requests: [{ op: 'read', path: '/workspace/' + skillPath }, ...before] },
    ]);
  });
  runtime.close();
}));

test('older SSH helper lists a three-component directory in two ordered batches with stats enabled', async () => fixture(async current => {
  const runtime = await current.prepare(async files => {
    assert.deepEqual(await files.list(skillDirectory), [{ name: 'SKILL.md', directory: false }]);
    const before = candidateOps(skillDirectory);
    assert.deepEqual(current.inspections, [
      { op: 'batch', requests: before },
      { op: 'batch', requests: [{ op: 'list', path: '/workspace/' + skillDirectory, includeStats: true }, ...before] },
    ]);
  });
  runtime.close();
}));

test('missing candidates stop their own batch without suppressing an unrelated optional path', async () => fixture(async current => {
  const runtime = await current.prepare(async files => {
    assert.equal(await files.read('.claude/absent/file.md'), null);
    assert.equal(current.inspections.length, 1);
    assert.equal(current.operations.at(-1)?.path, '/workspace/.claude/absent');
    assert.deepEqual(await files.list('.claude/absent/directory'), []);
    assert.equal(current.inspections.length, 2);
    assert.equal((await files.read('other.md'))?.content, 'Other configuration');
    assert.equal(current.inspections.length, 4);
  });
  runtime.close();
}));

test('ENOENT during read/list or their postchecks retains optional-path absence behavior', async () => {
  for (const operation of ['read', 'list']) for (const stage of ['operation', 'postcheck']) await fixture(async current => {
    const candidate = operation === 'read' ? skillPath : skillDirectory;
    current.setTransform((request, result, batch) => {
      if (batch === 2 && (stage === 'operation' ? request.op === operation : request.op === 'lstat')) throw absent();
      return result;
    });
    const runtime = await current.prepare(async files => {
      assert.deepEqual(operation === 'read' ? await files.read(candidate) : await files.list(candidate), operation === 'read' ? null : []);
      assert.equal(current.inspections.length, 2);
    });
    runtime.close();
  });
});

test('linked components in either batch are denied, including mode-only links and parent links', async () => {
  for (const operation of ['read', 'list']) for (const batch of [1, 2]) for (const component of ['parent', 'leaf', 'mode']) await fixture(async current => {
    const candidate = operation === 'read' ? skillPath : skillDirectory;
    current.setTransform((request, result, number) => {
      const selected = component === 'parent' ? '/workspace/.claude' : '/workspace/' + candidate;
      if (number === batch && request.op === 'lstat' && request.path === selected) return { ...result, symlink: component !== 'mode', mode: 0o120777 };
      return result;
    });
    await assert.rejects(current.prepare(files => operation === 'read' ? files.read(candidate).then(() => {}) : files.list(candidate).then(() => {})), { code: 'PROJECT_RUNTIME_PATH_INVALID' });
    assert.equal(current.inspections.length, batch);
    if (batch === 1) assert.equal(current.operations.some(request => request.op === operation), false);
    assert.equal(saved?.status, 'failed');
  });
});

test('oversized pre-read metadata prevents bytes from being requested; oversized post metadata is rejected too', async () => {
  for (const batch of [1, 2]) await fixture(async current => {
    current.setTransform((request, result, number) => number === batch && request.path === '/workspace/' + skillPath && request.op === 'lstat' ? { ...result, size: 256 * 1024 + 1 } : result);
    await assert.rejects(current.prepare(files => files.read(skillPath).then(() => {})), { code: 'PROJECT_RUNTIME_LIMIT' });
    assert.equal(current.inspections.length, batch);
    assert.equal(current.operations.some(request => request.op === 'read'), batch === 2);
  });
});

test('malformed, partial, reordered and error-item batch responses cannot be accepted', async () => {
  const corruptions: Array<(result: Response) => unknown> = [
    () => null,
    () => [],
    () => ({}),
    result => ({ ...result, results: {} }),
    result => ({ ...result, results: (result.results as unknown[]).slice(1) }),
    result => ({ ...result, results: [...result.results as unknown[], {}] }),
    result => ({ ...result, results: [null, ...(result.results as unknown[]).slice(1)] }),
    result => ({ ...result, results: [...result.results as unknown[]].reverse() }),
    result => ({ ...result, results: [{ ok: false, code: 'ENOENT' }, ...(result.results as unknown[]).slice(1)] }),
    result => ({ ...result, ok: false }),
    result => ({ ...result, truncated: true }),
  ];
  for (const corrupt of corruptions) await fixture(async current => {
    current.setEnvelope(corrupt);
    await assert.rejects(current.prepare(files => files.read(skillPath).then(() => {})), { code: 'PROJECT_RUNTIME_CONFIG_INVALID' });
    assert.equal(current.inspections.length, 1);
    assert.equal(current.operations.some(request => request.op === 'read'), false);
  });
});

test('file metadata requires exact regular types, finite bounds and directory ancestors', async () => {
  const corruptions = [
    { size: undefined }, { size: -1 }, { size: NaN }, { size: Infinity }, { size: '1' }, { size: 1.5 },
    { mode: 0o010000 }, { mode: 0o040755 }, { mode: 0o100644 + 0.5 }, { dir: 'false' },
    { symlink: undefined }, { mtime: undefined }, { mtime: Infinity }, { truncated: true },
  ];
  for (const corrupt of corruptions) await fixture(async current => {
    current.setTransform((request, result) => request.path === '/workspace/' + skillPath && request.op === 'lstat' ? { ...result, ...corrupt } : result);
    await assert.rejects(current.prepare(files => files.read(skillPath).then(() => {})), { code: 'PROJECT_RUNTIME_CONFIG_INVALID' });
    assert.equal(current.inspections.length, 1);
  });
  await fixture(async current => {
    current.setTransform((request, result) => request.path === '/workspace/.claude' ? metadata(false) : result);
    await assert.rejects(current.prepare(files => files.read(skillPath).then(() => {})), { code: 'PROJECT_RUNTIME_CONFIG_INVALID' });
    assert.equal(current.inspections.length, 1);
  });
});

test('tampered hashes, noncanonical base64, missing content, invalid UTF-8 and truncated reads fail closed', async () => {
  const corruptions: Response[] = [
    { hash: '0'.repeat(64) }, { hash: undefined }, { b64: undefined }, { b64: 'AA@A' },
    { b64: 'Zg', hash: hash('f') }, { b64: 'Zh==', hash: hash('f') }, { truncated: true }, { truncated: 'false' },
    { b64: Buffer.from([0xff]).toString('base64'), hash: hash(Buffer.from([0xff])) },
  ];
  for (const corrupt of corruptions) await fixture(async current => {
    current.setTransform((request, result) => request.op === 'read' ? { ...result, ...corrupt } : result);
    await assert.rejects(current.prepare(files => files.read(skillPath).then(() => {})), { code: corrupt.truncated === true ? 'PROJECT_RUNTIME_LIMIT' : corrupt.b64 === '/w==' ? 'ERR_ENCODING_INVALID_ENCODED_DATA' : 'PROJECT_RUNTIME_CONFIG_INVALID' });
    assert.equal(current.inspections.length, 2, 'corruption is checked after actual bytes and postchecks return');
    assert.equal(current.operations.filter(operation => operation.op === 'read').length, 1);
    assert.equal(saved?.status, 'failed');
  });
});

test('read bytes and aggregate configuration remain limited even with falsely small metadata', async () => {
  for (const size of [256 * 1024 + 1, 256 * 1024 + 4]) await fixture(async current => {
    const bytes = Buffer.alloc(size, 'x');
    current.setTransform((request, result) => request.op === 'read' ? { b64: bytes.toString('base64'), hash: hash(bytes) } : result);
    await assert.rejects(current.prepare(files => files.read(skillPath).then(() => {})), { code: 'PROJECT_RUNTIME_LIMIT' });
  });
  await fixture(async current => {
    current.remote.set(skillPath, 'x'.repeat(150 * 1024));
    current.remote.set('other.md', 'y'.repeat(150 * 1024));
    await assert.rejects(current.prepare(async files => { await files.read(skillPath); await files.read('other.md'); }), { code: 'PROJECT_RUNTIME_LIMIT' });
  });
});

test('native list shape, entry stats and discovery bounds are validated before accepting entries', async () => {
  const normal = { name: 'SKILL.md', dir: false, stats: metadata(false) };
  const corruptions: Array<{ patch: Response; code: string }> = [
    { patch: { truncated: true }, code: 'PROJECT_RUNTIME_LIMIT' },
    { patch: { truncated: undefined }, code: 'PROJECT_RUNTIME_CONFIG_INVALID' },
    { patch: { truncated: 'false' }, code: 'PROJECT_RUNTIME_CONFIG_INVALID' },
    { patch: { entries: null }, code: 'PROJECT_RUNTIME_CONFIG_INVALID' },
    { patch: { entries: new Array(513).fill(normal) }, code: 'PROJECT_RUNTIME_LIMIT' },
    { patch: { entries: [null] }, code: 'PROJECT_RUNTIME_CONFIG_INVALID' },
    { patch: { entries: [{ ...normal, name: '../secret' }] }, code: 'PROJECT_RUNTIME_CONFIG_INVALID' },
    { patch: { entries: [normal, normal] }, code: 'PROJECT_RUNTIME_CONFIG_INVALID' },
    { patch: { entries: [{ ...normal, dir: true }] }, code: 'PROJECT_RUNTIME_CONFIG_INVALID' },
    { patch: { entries: [{ ...normal, stats: undefined }] }, code: 'PROJECT_RUNTIME_CONFIG_INVALID' },
    { patch: { entries: [{ ...normal, stats: { ...metadata(false), symlink: true } }] }, code: 'PROJECT_RUNTIME_PATH_INVALID' },
    { patch: { entries: [{ ...normal, stats: { ...metadata(false), mode: 0o120777 } }] }, code: 'PROJECT_RUNTIME_PATH_INVALID' },
  ];
  for (const { patch, code } of corruptions) await fixture(async current => {
    current.setTransform((request, result) => request.op === 'list' ? { ...result, ...patch } : result);
    await assert.rejects(current.prepare(files => files.list(skillDirectory).then(() => {})), { code });
    assert.equal(saved?.status, 'failed');
  });
});

test('component depth guard fits the native maximum of 64 operations without chunking one candidate', async () => fixture(async current => {
  const allowed = [...new Array(62).fill('a'), 'file.md'].join('/');
  const denied = 'a/' + allowed;
  current.remote.set(allowed, 'Deep file');
  const runtime = await current.prepare(async files => {
    assert.equal((await files.read(allowed))?.content, 'Deep file');
    assert.equal((current.inspections[0].requests as unknown[]).length, 63);
    assert.equal((current.inspections[1].requests as unknown[]).length, 64);
    const calls = current.inspections.length;
    await assert.rejects(files.read(denied), { code: 'PROJECT_RUNTIME_LIMIT' });
    assert.equal(current.inspections.length, calls);
    await assert.rejects(files.read('a'.repeat(2040)), { code: 'PROJECT_RUNTIME_LIMIT' });
    assert.equal(current.inspections.length, calls);
  });
  runtime.close();
}));

test('cancellation and changed admission after the first batch prevent the second dispatch', async () => {
  for (const abort of [true, false]) await fixture(async current => {
    current.afterExecute(() => {
      if (abort) current.controller.abort(new Error('Deadline/cancellation reached'));
      else current.setCurrent(false);
    });
    await assert.rejects(current.prepare(files => files.read(skillPath).then(() => {})), abort ? /Deadline\/cancellation reached/ : { code: 'WORKSPACE_GENERATION_CHANGED' });
    assert.equal(current.inspections.length, 1);
    assert.equal(current.operations.some(request => request.op === 'read'), false);
    assert.equal(saved?.status, 'failed');
  });
  await fixture(async current => {
    current.controller.abort(new Error('Already cancelled'));
    await assert.rejects(current.prepare(files => files.read(skillPath).then(() => {})), /Already cancelled/);
    assert.equal(current.requests.length, 0);
    assert.equal(current.inspections.length, 0);
  });
});

test('empty files, the exact 256 KiB file boundary and empty directories remain valid', async () => {
  for (const text of ['', 'x'.repeat(256 * 1024)]) await fixture(async current => {
    current.remote.set(skillPath, text);
    const runtime = await current.prepare(async files => {
      assert.deepEqual(await files.read(skillPath), { content: text, hash: hash(text) });
      assert.equal(current.inspections.length, 2);
    });
    runtime.close();
  });
  await fixture(async current => {
    current.setTransform((request, result) => request.op === 'list' ? { entries: [], truncated: false } : result);
    const runtime = await current.prepare(async files => { assert.deepEqual(await files.list(skillDirectory), []); });
    runtime.close();
  });
});

test('malformed or linked postchecks never accept a file or directory result already returned', async () => {
  for (const operation of ['read', 'list']) for (const corrupt of [{ dir: false, mode: 0o100644 }, { mtime: undefined }, { symlink: true }]) await fixture(async current => {
    current.setTransform((request, result, batch) => batch === 2 && request.op === 'lstat' && request.path === '/workspace/.claude' ? { ...result, ...corrupt } : result);
    await assert.rejects(current.prepare(files => operation === 'read' ? files.read(skillPath).then(() => {}) : files.list(skillDirectory).then(() => {})), { code: corrupt.symlink ? 'PROJECT_RUNTIME_PATH_INVALID' : 'PROJECT_RUNTIME_CONFIG_INVALID' });
    assert.equal(current.inspections.length, 2);
    assert.equal(saved?.status, 'failed');
  });
});

test('external IDE metadata changes remain acceptable when both checks and returned bytes are individually safe', async () => fixture(async current => {
  current.setTransform((request, result, batch) => batch === 2 && request.op === 'lstat' && request.path === '/workspace/' + skillPath ? { ...result, size: 5, mtime: 2 } : result);
  const runtime = await current.prepare(async files => {
    assert.equal((await files.read(skillPath))?.content, 'Fixture skill');
  });
  runtime.close();
}));

test('startup snapshot serves native files, missing rows and directory entries without extra dispatches', async () => fixture(async current => {
  current.setSnapshot(() => startupSnapshot());
  const runtime = await current.prepare(async files => {
    assert.deepEqual(await files.read(skillPath), { content: 'Fixture skill', hash: hash('Fixture skill') });
    assert.equal(await files.read('CLAUDE.md'), null);
    assert.deepEqual(await files.list(skillDirectory), [{ name: 'SKILL.md', directory: false }]);
    assert.deepEqual(await files.list('.claude/rules'), []);
    assert.deepEqual(current.requests, [{ op: 'project_snapshot' }]);
    assert.equal(current.operations.length, 0);
  });
  assert.equal(saved?.status, 'loaded');
  runtime.close();
}));

test('snapshot misses retain both ordered inspection batches for an unrelated imported file', async () => fixture(async current => {
  current.setSnapshot(() => startupSnapshot());
  const runtime = await current.prepare(async files => {
    assert.equal((await files.read('other.md'))?.content, 'Other configuration');
    const checks = candidateOps('other.md');
    assert.deepEqual(current.requests, [
      { op: 'project_snapshot' },
      { op: 'batch', requests: checks },
      { op: 'batch', requests: [{ op: 'read', path: '/workspace/other.md' }, ...checks] },
    ]);
    assert.deepEqual(await files.list(skillDirectory), [{ name: 'SKILL.md', directory: false }]);
    assert.equal(current.requests.length, 3, 'a cached directory must not repeat the snapshot or start another batch');
  });
  runtime.close();
}));

test('snapshot schema, duplicate paths and collection limits fail without fallback inspection', async () => {
  const file = (startupSnapshot().files as Response[]).at(-1)!;
  const directory = { path: skillDirectory, entries: [] };
  const corruptions: unknown[] = [
    null, [], {}, { ...startupSnapshot(), snapshotVersion: 2 },
    { ...startupSnapshot(), files: null }, { ...startupSnapshot(), directories: null },
    { ...startupSnapshot(), files: [null] }, { ...startupSnapshot(), files: [file, file] },
    { ...startupSnapshot(), files: new Array(257).fill(file) },
    { ...startupSnapshot(), directories: [null] }, { ...startupSnapshot(), directories: [directory, directory] },
    { ...startupSnapshot(), directories: new Array(129).fill(directory) },
    { ...startupSnapshot(), directories: [{ ...directory, entries: null }] },
  ];
  for (const corrupt of corruptions) await fixture(async current => {
    current.setSnapshot(() => corrupt);
    await assert.rejects(current.prepare(files => files.read(skillPath).then(() => {})), { code: 'PROJECT_RUNTIME_CONFIG_INVALID' });
    assert.deepEqual(current.requests, [{ op: 'project_snapshot' }]);
    assert.equal(current.operations.length, 0);
    assert.equal(saved?.status, 'failed');
  });
});

test('snapshot file metadata and byte hashes reject tampering before any fallback read', async () => {
  const file = (startupSnapshot().files as Response[]).at(-1)!;
  const corruptions: Array<{ patch: Response; code: string }> = [
    ...[{ symlink: true }, { mode: 0o120777 }].map(stats => ({ patch: { stats: { ...file.stats as Response, ...stats } }, code: 'PROJECT_RUNTIME_PATH_INVALID' })),
    ...[{ size: -1 }, { size: NaN }, { dir: true }, { symlink: undefined }, { mtime: Infinity }, { mode: 0o010000 }].map(stats => ({ patch: { stats: { ...file.stats as Response, ...stats } }, code: 'PROJECT_RUNTIME_CONFIG_INVALID' })),
    { patch: { stats: metadata(false, 256 * 1024 + 1) }, code: 'PROJECT_RUNTIME_LIMIT' },
    ...[{ hash: '0'.repeat(64) }, { hash: undefined }, { b64: undefined }, { b64: 'Zg', hash: hash('f') }, { b64: 'Zh==', hash: hash('f') }, { truncated: 'false' }].map(patch => ({ patch, code: 'PROJECT_RUNTIME_CONFIG_INVALID' })),
    { patch: { truncated: true }, code: 'PROJECT_RUNTIME_LIMIT' },
    { patch: { b64: '/w==', hash: hash(Buffer.from([0xff])) }, code: 'ERR_ENCODING_INVALID_ENCODED_DATA' },
  ];
  for (const { patch, code } of corruptions) await fixture(async current => {
    current.setSnapshot(() => ({ ...startupSnapshot(), files: [{ ...file, ...patch }] }));
    await assert.rejects(current.prepare(files => files.read(skillPath).then(() => {})), { code });
    assert.deepEqual(current.requests, [{ op: 'project_snapshot' }]);
    assert.equal(current.operations.length, 0);
    assert.equal(saved?.status, 'failed');
  });
});

test('snapshot and caller paths cannot escape the exact admitted workspace', async () => {
  for (const candidate of ['../secret', 'nested/../../secret', '/etc/passwd', 'C:\\secret', '~/.credentials', '.chisa-private/key', 'nested//key', 'nul\u0000byte']) {
    for (const collection of ['files', 'directories']) await fixture(async current => {
      current.setSnapshot(() => ({ ...startupSnapshot(), [collection]: [{ path: candidate, missing: true, entries: [] }] }));
      await assert.rejects(current.prepare(files => files.read(skillPath).then(() => {})), { code: 'PROJECT_RUNTIME_PATH_INVALID' });
      assert.deepEqual(current.requests, [{ op: 'project_snapshot' }]);
      assert.equal(saved?.status, 'failed');
    });
    await fixture(async current => {
      current.setSnapshot(() => startupSnapshot());
      const runtime = await current.prepare(async files => {
        for (const operation of ['read', 'list'] as const) await assert.rejects(files[operation](candidate), { code: 'PROJECT_RUNTIME_PATH_INVALID' });
        assert.equal(current.requests.length, 0, 'invalid caller paths never cross the RPC boundary');
      });
      runtime.close();
    });
  }
  for (const candidate of ['/workspace/' + skillPath, skillPath.replaceAll('/', '\\')]) await fixture(async current => {
    current.setSnapshot(() => ({ ...startupSnapshot(), files: [{ path: candidate, missing: true }] }));
    await assert.rejects(current.prepare(files => files.read(skillPath).then(() => {})), { code: 'PROJECT_RUNTIME_CONFIG_INVALID' });
    assert.equal(saved?.status, 'failed');
  });
});

test('snapshot listings validate unsafe names, duplicate entries, links and discovery bounds', async () => {
  const entry = { name: 'SKILL.md', dir: false, stats: metadata(false) };
  const corruptions: Array<{ entries: unknown[]; code: string }> = [
    { entries: [null], code: 'PROJECT_RUNTIME_CONFIG_INVALID' },
    { entries: [entry, entry], code: 'PROJECT_RUNTIME_CONFIG_INVALID' },
    { entries: [{ ...entry, name: '../secret' }], code: 'PROJECT_RUNTIME_CONFIG_INVALID' },
    { entries: [{ ...entry, stats: undefined }], code: 'PROJECT_RUNTIME_CONFIG_INVALID' },
    { entries: [{ ...entry, dir: true }], code: 'PROJECT_RUNTIME_CONFIG_INVALID' },
    { entries: [{ ...entry, stats: { ...entry.stats, symlink: true } }], code: 'PROJECT_RUNTIME_PATH_INVALID' },
    { entries: new Array(513).fill(entry), code: 'PROJECT_RUNTIME_LIMIT' },
  ];
  for (const { entries, code } of corruptions) await fixture(async current => {
    current.setSnapshot(() => ({ ...startupSnapshot(), directories: [{ path: skillDirectory, entries }] }));
    await assert.rejects(current.prepare(files => files.list(skillDirectory).then(() => {})), { code });
    assert.deepEqual(current.requests, [{ op: 'project_snapshot' }]);
    assert.equal(saved?.status, 'failed');
  });
});

test('snapshot cancellation and changed admission discard returned bytes before any cached result is exposed', async () => {
  for (const abort of [true, false]) await fixture(async current => {
    current.setSnapshot(() => startupSnapshot());
    current.afterExecute(() => {
      if (abort) current.controller.abort(new Error('Snapshot caller cancelled'));
      else current.setCurrent(false);
    });
    let exposed = false;
    await assert.rejects(current.prepare(async files => { await files.read(skillPath); exposed = true; }), abort ? /Snapshot caller cancelled/ : { code: 'WORKSPACE_GENERATION_CHANGED' });
    assert.equal(exposed, false);
    assert.deepEqual(current.requests, [{ op: 'project_snapshot' }]);
    assert.equal(saved?.status, 'failed');
  });
  for (const code of ['SSH_WORKSPACE_PATH_UNSAFE', 'SSH_WORKSPACE_UNAVAILABLE']) await fixture(async current => {
    current.setSnapshot(() => { throw Object.assign(new Error('Snapshot transport refusal'), { code }); });
    await assert.rejects(current.prepare(files => files.read(skillPath).then(() => {})), { code });
    assert.equal(current.inspections.length, 0, 'only the explicit unsupported-operation code may use fallback');
  });
});

test('cloud and legacy descriptors retain the existing nine/seven single-operation sequences', async () => {
  for (const mode of ['cloud', null] as const) await fixture(async current => {
    const runtime = await current.prepare(async files => {
      await files.read(skillPath);
      const fileChecks = candidateOps(skillPath);
      assert.deepEqual(current.inspections, [...fileChecks, { op: 'read', path: '/workspace/' + skillPath }, ...fileChecks]);
      current.inspections.length = 0;
      await files.list(skillDirectory);
      const directoryChecks = candidateOps(skillDirectory);
      assert.deepEqual(current.inspections, [...directoryChecks, { op: 'list', path: '/workspace/' + skillDirectory, includeStats: true }, ...directoryChecks]);
      assert.equal(current.inspections.some(request => request.op === 'batch'), false);
    });
    runtime.close();
  }, mode);
});
