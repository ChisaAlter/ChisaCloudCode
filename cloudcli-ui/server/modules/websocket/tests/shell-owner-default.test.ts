import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test, { mock } from 'node:test';

const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'shell-owner-default-')));
const previousDatabase = process.env.DATABASE_PATH;
const previousRoot = process.env.WORKSPACES_ROOT;
const accountRoot = path.join(directory, 'account');
const privateHome = path.join(directory, 'home');
process.env.DATABASE_PATH = path.join(directory, 'fixture.db');
process.env.WORKSPACES_ROOT = accountRoot;
await mkdir(accountRoot, { recursive: true });
await mkdir(path.join(privateHome, '.chisa-workspace-runtime'), { recursive: true });
await writeFile(process.env.DATABASE_PATH, '');
mock.method(os, 'homedir', () => privateHome);
const statePath = path.join(privateHome, '.chisa-workspace-runtime', createHash('sha256').update(accountRoot).digest('hex').slice(0, 24) + '.json');
async function setOwner(userId: string) {
  await writeFile(statePath, JSON.stringify({ version: 1, root: accountRoot, userId,
    owner: createHash('sha256').update(accountRoot + '\0' + userId).digest('hex').slice(0, 24) }), { mode: 0o600 });
}
await setOwner('1');
const { closeConnection, getConnection, initializeDatabase, projectsDb, sshProjectTargetsDb, userDb } = await import('@/modules/database/index.js');
const runtime = await import('@/modules/workspace-runtime/index.js');
// Docker enrollment is outside this fixture. Persisted owner reads, catalog,
// descriptor storage and the shell's default explicit-user resolver stay real.
mock.module('@/modules/workspace-runtime/index.js', { namedExports: { ...runtime, ensureCloudWorkspaceBinding() {} } });
const { describeWorkspaceSelection } = await import('@/modules/workspace-bridge/index.js');
const { resolveSelectedWorkspaceForUser } = await import('@/modules/workspaces/index.js');
const { handleShellConnection } = await import('../services/shell-websocket.service.js');
await initializeDatabase();
userDb.createUser('owner', 'fixture');
userDb.createUser('other', 'fixture');

test.after(async () => {
  closeConnection();
  mock.restoreAll();
  if (previousDatabase === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previousDatabase;
  if (previousRoot === undefined) delete process.env.WORKSPACES_ROOT; else process.env.WORKSPACES_ROOT = previousRoot;
  assert.equal(path.dirname(directory), await realpath(os.tmpdir()));
  await rm(directory, { recursive: true, force: true });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(accept => { resolve = accept; });
  return { promise, resolve };
}

async function fixture(legacy = false) {
  const root = path.join(legacy ? directory : accountRoot, randomUUID());
  await mkdir(root);
  const project = projectsDb.createProjectPath(root).project!;
  const descriptor = describeWorkspaceSelection({ projectId: project.project_id, sourceRoot: root }).cloudReplica;
  const state = { active: true, admissions: 0, launches: 0, closes: 0, kills: 0,
    admissionGate: undefined as ReturnType<typeof deferred> | undefined,
    spawnGate: undefined as ReturnType<typeof deferred> | undefined,
    cleanupGate: undefined as ReturnType<typeof deferred> | undefined,
    admitted: deferred(), spawning: deferred(), closing: deferred(),
    children: [] as Array<{ exit(): void }> };
  const dependencies: Parameters<typeof handleShellConnection>[1] = {
    isSessionActive: () => state.active,
    resolveProviderSessionId: () => null,
    // Only execution is fake; omitting resolveSelectedWorkspace exercises the
    // production dynamic import on every initial resolve and revalidation.
    isWorkspaceBound: () => true,
    spawnPty: () => assert.fail('host PTY must never be used'),
    async admitWorkspaceExecution(input) {
      assert.equal(input.cwd, root);
      state.admissions += 1;
      state.admitted.resolve();
      await state.admissionGate?.promise;
      return { bound: true, bindingKind: 'vps', cwd: root, executionRoot: root, sourceCwd: root, sourceRoot: root,
        isolated: false, readOnly: false, revoke() {}, assertCurrent() {},
        async execute() { assert.fail('unexpected execution'); },
        async spawnProcess() {
          state.launches += 1;
          const done = deferred();
          const child = { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
            completion: done.promise.then(() => ({ code: 0, signal: null })),
            async close() { state.kills += 1; done.resolve(); }, exit: done.resolve };
          state.children.push(child);
          state.spawning.resolve();
          await state.spawnGate?.promise;
          return child;
        },
        async close() { state.closes += 1; state.closing.resolve(); await state.cleanupGate?.promise; },
      };
    },
  };
  const sockets: Array<EventEmitter & { readyState: number; frames: Record<string, unknown>[] }> = [];
  function connect(user: Record<string, unknown> = { id: 1 }, withSessionGuard = true) {
    const socket = Object.assign(new EventEmitter(), { readyState: 1, frames: [] as Record<string, unknown>[],
      send(text: string) { this.frames.push(JSON.parse(text)); } });
    sockets.push(socket);
    handleShellConnection(socket as never, { ...dependencies, ...(withSessionGuard ? {} : { isSessionActive: undefined }) }, { user } as never);
    async function init(extra: Record<string, unknown> = {}) {
      for (const listener of socket.listeners('message')) await listener(JSON.stringify({ type: 'init',
        projectId: project.project_id, workspaceId: descriptor.workspaceId, generation: descriptor.generation,
        isPlainShell: true, provider: 'plain-shell', ...extra }));
    }
    return { socket, init };
  }
  async function changeGeneration() {
    const file = path.join(root + '.chisa-state', 'replica.json');
    const value = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, JSON.stringify({ ...value, generation: randomUUID() }), { mode: 0o600 });
  }
  async function finish() {
    for (const child of state.children) child.exit();
    for (const socket of sockets) { socket.readyState = 3; socket.emit('close'); }
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  return { root, project, descriptor, state, connect, changeGeneration, finish };
}

function code(socket: { frames: Record<string, unknown>[] }) { return socket.frames.find(frame => frame.type === 'error')?.code; }

test('default resolver carries the real cloud owner from handshake to shell admission', async () => {
  const h = await fixture();
  try {
    const owner = h.connect({ userId: '1' });
    await owner.init();
    assert.equal(code(owner.socket), undefined);
    assert.equal(owner.socket.frames.find(frame => frame.type === 'ready')?.workspaceId, h.descriptor.workspaceId);
    assert.equal(h.state.admissions, 1);
    const foreign = h.connect({ id: 2 });
    await foreign.init({ userId: 1, ownerId: 1 });
    assert.equal(code(foreign.socket), 'WORKSPACE_FORBIDDEN');
    assert.equal(h.state.admissions, 1);
  } finally { await h.finish(); }
});

test('missing handshake identity cannot borrow an owner from the init frame or username', async () => {
  const h = await fixture();
  try {
    for (const user of [{}, { username: 'owner' }, { id: '' }, { id: '1\n' }]) {
      const connection = h.connect(user);
      await connection.init({ userId: 1, ownerId: 1 });
      assert.equal(code(connection.socket), 'UNAUTHORIZED');
    }
    assert.equal(h.state.admissions, 0);
  } finally { await h.finish(); }
});

test('missing trusted authentication guard rejects before workspace admission', async () => {
  const h = await fixture();
  try {
    const connection = h.connect({ id: 1 }, false);
    await connection.init({ isSessionActive: true, userId: 1 });
    assert.equal(code(connection.socket), 'UNAUTHORIZED');
    assert.equal(h.state.admissions, 0);
    assert.equal(h.state.launches, 0);
  } finally { await h.finish(); }
});

for (const stage of ['admission', 'spawn', 'pending', 'restart'] as const) {
  test(`authentication revoked during ${stage} cannot expose or reuse a shell`, async () => {
    const h = await fixture();
    const gate = deferred();
    try {
      const first = h.connect();
      if (stage === 'admission' || stage === 'pending') h.state.admissionGate = gate;
      if (stage === 'spawn') h.state.spawnGate = gate;
      if (stage === 'restart') { await first.init(); h.state.cleanupGate = gate; }
      const second = stage === 'restart' ? h.connect() : first;
      const running = second.init(stage === 'restart' ? { forceRestart: true } : {});
      await (stage === 'spawn' ? h.state.spawning.promise : stage === 'restart' ? h.state.closing.promise : h.state.admitted.promise);
      const pending = stage === 'pending' ? h.connect() : null;
      const waiting = pending?.init();
      await new Promise<void>(resolve => setImmediate(resolve));
      h.state.active = false;
      gate.resolve();
      await running;
      await waiting;
      assert.equal(code(second.socket), 'UNAUTHORIZED');
      assert.equal(second.socket.frames.some(frame => frame.type === 'ready'), false);
      if (pending) assert.equal(code(pending.socket), 'UNAUTHORIZED');
      assert.equal(h.state.admissions, 1);
      assert.equal(h.state.launches, stage === 'spawn' || stage === 'restart' ? 1 : 0);
      assert.equal(h.state.kills, stage === 'spawn' || stage === 'restart' ? 1 : 0);
      assert.equal(h.state.closes, 1);
    } finally { gate.resolve(); await h.finish(); }
  });
}

test('real resolver denies ownerless multiaccount data and preserves the sole-account policy', async () => {
  const h = await fixture(true);
  try {
    const multi = h.connect();
    await multi.init();
    assert.equal(code(multi.socket), 'WORKSPACE_FORBIDDEN');
    getConnection().prepare('UPDATE users SET is_active = 0 WHERE id = 2').run();
    const other = h.connect({ id: 2 });
    await other.init();
    assert.equal(code(other.socket), 'WORKSPACE_FORBIDDEN');
    const sole = h.connect();
    await sole.init();
    assert.equal(code(sole.socket), undefined);
    assert.equal(h.state.admissions, 1);
  } finally {
    getConnection().prepare('UPDATE users SET is_active = 1 WHERE id = 2').run();
    await h.finish();
  }
});

test('default explicit-user resolver enforces persisted SSH ownership', async () => {
  const anchor = path.join(accountRoot, '.chisa-ssh-projects', randomUUID());
  await mkdir(anchor, { recursive: true });
  const target = sshProjectTargetsDb.createWithProject({ projectId: randomUUID(), ownerId: '1', connectionId: 'fixture',
    connectionLabel: 'Fixture', rootPath: 'C:\\work\\App', rootIdentity: 'volume:file', anchorPath: anchor, displayName: 'App' });
  const selector = { workspaceId: target.workspaceId, generation: target.generation };
  const descriptor = resolveSelectedWorkspaceForUser(target.projectId, 1, selector);
  assert.equal(descriptor.sourceMode, 'ssh');
  assert.equal(descriptor.rootPath, anchor);
  assert.throws(() => resolveSelectedWorkspaceForUser(target.projectId, 2, selector), { code: 'SSH_WORKSPACE_FORBIDDEN' });
  assert.throws(() => resolveSelectedWorkspaceForUser(target.projectId, null as never, selector), { code: 'UNAUTHORIZED' });
});

for (const stage of ['admission', 'spawn', 'pending', 'restart'] as const) {
  test(`persisted owner changes during ${stage} cannot expose or reuse a shell`, async () => {
    const h = await fixture();
    try {
      const first = h.connect();
      const gate = deferred();
      if (stage === 'admission' || stage === 'pending') h.state.admissionGate = gate;
      if (stage === 'spawn') h.state.spawnGate = gate;
      if (stage === 'restart') {
        await first.init();
        h.state.cleanupGate = gate;
      }
      const second = stage === 'restart' ? h.connect() : first;
      const running = second.init(stage === 'restart' ? { forceRestart: true } : {});
      await (stage === 'spawn' ? h.state.spawning.promise : stage === 'restart' ? h.state.closing.promise : h.state.admitted.promise);
      const pending = stage === 'pending' ? h.connect() : null;
      const waiting = pending?.init();
      await new Promise<void>(resolve => setImmediate(resolve));
      await setOwner('2');
      gate.resolve();
      await running;
      await waiting;
      assert.equal(code(second.socket), 'WORKSPACE_FORBIDDEN');
      assert.equal(second.socket.frames.some(frame => frame.type === 'ready'), false);
      if (pending) assert.equal(code(pending.socket), 'WORKSPACE_FORBIDDEN');
      assert.equal(h.state.admissions, 1);
      assert.equal(h.state.launches, stage === 'spawn' || stage === 'restart' ? 1 : 0);
      assert.equal(h.state.closes, 1);
    } finally { await setOwner('1'); await h.finish(); }
  });
}

for (const stage of ['spawn', 'pending', 'restart'] as const) {
  test(`durable generation changes during ${stage} fail before exposing a shell`, async () => {
    const h = await fixture();
    try {
      const first = h.connect();
      const gate = deferred();
      if (stage === 'pending') h.state.admissionGate = gate;
      if (stage === 'spawn') h.state.spawnGate = gate;
      if (stage === 'restart') { await first.init(); h.state.cleanupGate = gate; }
      const second = stage === 'restart' ? h.connect() : first;
      const running = second.init(stage === 'restart' ? { forceRestart: true } : {});
      await (stage === 'spawn' ? h.state.spawning.promise : stage === 'restart' ? h.state.closing.promise : h.state.admitted.promise);
      const pending = stage === 'pending' ? h.connect() : null;
      const waiting = pending?.init();
      await new Promise<void>(resolve => setImmediate(resolve));
      await h.changeGeneration();
      gate.resolve();
      await running;
      await waiting;
      assert.equal(code(second.socket), 'WORKSPACE_GENERATION_CHANGED');
      assert.equal(second.socket.frames.some(frame => frame.type === 'ready'), false);
      if (pending) assert.equal(code(pending.socket), 'WORKSPACE_GENERATION_CHANGED');
      assert.equal(h.state.admissions, 1);
      assert.equal(h.state.closes, 1);
    } finally { await h.finish(); }
  });
}
