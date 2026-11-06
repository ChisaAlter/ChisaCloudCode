import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test, { after, mock } from 'node:test';

import { WORKSPACES_ROOT } from '@/shared/index.js';
import type { AnyRecord, WorkspaceDescriptor } from '@/shared/index.js';

// Provider imports open SQLite eagerly, so isolate the first connection too.
const previousDatabasePath = process.env.DATABASE_PATH;
const bootstrap = await mkdtemp(path.join(path.resolve(WORKSPACES_ROOT), '.chisa-chat-workspace-db-'));
process.env.DATABASE_PATH = path.join(bootstrap, 'auth.db');
await writeFile(process.env.DATABASE_PATH, '');
const { closeConnection, initializeDatabase, projectsDb, sessionsDb } = await import('@/modules/database/index.js');
// Selector fixtures use explicit cloud identity without account runtime restoration.
let realOwnership: Pick<typeof import('@/modules/workspace-runtime/index.js'),'assertCloudWorkspaceOwner'>;
type FixtureAdmission = { userId: string;root: string;leaseId?: string;brokerLeaseId?: string;bindingEpoch: string;sessionId?: string };
const enrolled = new Set<string>();
const leases = new Map<string,{ root: string;bindingEpoch: string;sessionId: string;brokerLeaseId: string }>();
let materializing = false;
const rejectSandbox = () => assert.fail('selector-only fixture must never dispatch a sandbox process');
const runtimeMock=mock.module('@/modules/workspace-runtime/index.js', { namedExports: {
  // These selector fixtures deliberately use synthetic protocol-3 identities;
  // account authorization is exercised with real persisted metadata separately.
  assertCloudWorkspaceOwner(candidate: string, userId: string | number | null, accounts?: string[]) {
    if (candidate && path.basename(candidate).startsWith('.chisa-chat-')) return;
    realOwnership.assertCloudWorkspaceOwner(candidate, userId, accounts);
  },
  ensureCloudWorkspaceBinding() {}, excludeCloudWorkspaceMetadata() {}, getWorkspaceRuntimeIdentity() { return undefined; },
  executeWorkspaceRuntimePreview() { assert.fail('unexpected preview'); }, createWorkspaceRuntimeService() { assert.fail('unexpected restore'); },
  async getWorkspaceBrokerAdmission(input: FixtureAdmission) {
    assert.equal(materializing,true,'only explicit fixture materialization may admit a lease');
    assert.equal(input.userId,'selector-fixture-user');assert.ok(enrolled.has(input.root));assert.ok(input.leaseId);
    const selected={root:input.root,bindingEpoch:input.bindingEpoch,sessionId:input.sessionId??'fixture-session',brokerLeaseId:'broker-'+input.leaseId};
    const previous=leases.get(input.leaseId);if(previous)assert.deepEqual(selected,previous);
    if(input.brokerLeaseId!==undefined)assert.equal(input.brokerLeaseId,selected.brokerLeaseId);
    leases.set(input.leaseId,selected);
    return { ...selected,legacyReservationId:input.leaseId,leaseId:selected.brokerLeaseId,workspaceId:'selector-workspace',generation:'selector-generation',profileId:'worker',root:input.root,
      proof:rejectSandbox,client:{run:rejectSandbox,stream:rejectSandbox,writeStdin:rejectSandbox,status:rejectSandbox,cancel:rejectSandbox,reconcile:rejectSandbox} };
  },
  async closeWorkspaceBrokerLease(input: FixtureAdmission) {
    assert.equal(materializing,true);assert.equal(input.userId,'selector-fixture-user');assert.ok(input.leaseId);
    const selected=leases.get(input.leaseId);assert.ok(selected);assert.equal(input.root,selected.root);assert.equal(input.bindingEpoch,selected.bindingEpoch);assert.equal(input.sessionId,selected.sessionId);assert.equal(input.brokerLeaseId,selected.brokerLeaseId);
    // Every process/proof method above fails: the complete inventory is truly empty.
    leases.delete(input.leaseId);
    return { state:'closed',legacyReservationId:input.leaseId,leaseId:selected.brokerLeaseId,root:input.root,bindingEpoch:input.bindingEpoch,quiescent:true,cleanupConfirmed:true,resourceInventoryComplete:true,resources:[] };
  },
  readCloudWorkspaceOwner() { return 'selector-fixture-user'; },
} });
const { admitWorkspaceExecution, describeWorkspaceSelection } = await import('@/modules/workspace-bridge/index.js');
const { providerModelsService, sessionsService } = await import('@/modules/providers/index.js');
const { handleChatConnection, runDetachedChatTurn } = await import('../services/chat-websocket.service.js');
const { chatRunRegistry } = await import('../services/chat-run-registry.service.js');
const { connectedClients } = await import('../services/websocket-state.service.js');
runtimeMock.restore();
realOwnership=await import('@/modules/workspace-runtime/index.js');
await initializeDatabase();
after(async () => {
  closeConnection();
  if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = previousDatabasePath;
  assert.equal(path.dirname(bootstrap), path.resolve(WORKSPACES_ROOT));
  await rm(bootstrap, { recursive: true, force: true });
});

function createSocket() {
  const socket = new EventEmitter() as EventEmitter & { readyState: number; frames: AnyRecord[]; send(data: string): void };
  socket.readyState = 1;
  socket.frames = [];
  socket.send = data => socket.frames.push(JSON.parse(data) as AnyRecord);
  return socket;
}

function selector(descriptor: WorkspaceDescriptor) {
  return { projectId: descriptor.projectId, workspaceId: descriptor.workspaceId, generation: descriptor.generation };
}

async function withGateway(
  runTest: (context: {
    cwd: string;
    foreignRoot: string;
    sessionId: string;
    otherSessionId: string;
    workspace: ReturnType<typeof selector>;
    foreignWorkspace: ReturnType<typeof selector>;
    socket: ReturnType<typeof createSocket>;
    runs: Array<{ command: string; options: AnyRecord }>;
    aborts: string[];
    dependencies: Parameters<typeof handleChatConnection>[2];
    frame(data: AnyRecord): Promise<void>;
    materialize(sessionId?: string): Promise<WorkspaceDescriptor>;
    bind(epoch: string): Promise<void>;
  }) => Promise<void>,
  bound = true,
): Promise<void> {
  const cwd = await mkdtemp(path.join(path.resolve(WORKSPACES_ROOT), '.chisa-chat-workspace-'));
  const foreignRoot = await mkdtemp(path.join(path.resolve(WORKSPACES_ROOT), '.chisa-chat-foreign-'));
  const bind = async (epoch: string) => {
    await writeFile(path.join(cwd, '.chisa-bridge.json'), JSON.stringify({ protocol: 3, root: cwd, owner: 'cloud-chat-fixture', bindingEpoch: epoch }));
  };
  enrolled.add(cwd);
  if (bound) await bind('first-epoch');
  const sessionId = 'app-workspace-' + randomUUID();
  const otherSessionId = 'app-other-' + randomUUID();
  sessionsDb.createAppSession(sessionId, 'claude', cwd, 'Selected session');
  sessionsDb.createAppSession(otherSessionId, 'claude', cwd, 'Other session');
  projectsDb.createProjectPath(foreignRoot);
  const project = projectsDb.getProjectPath(cwd)!;
  const foreignProject = projectsDb.getProjectPath(foreignRoot)!;
  const workspace = selector(describeWorkspaceSelection({ projectId: project.project_id, sourceRoot: cwd }).cloudReplica);
  const foreignWorkspace = selector(describeWorkspaceSelection({ projectId: foreignProject.project_id, sourceRoot: foreignRoot }).cloudReplica);
  const socket = createSocket();
  const runs: Array<{ command: string; options: AnyRecord }> = [];
  const aborts: string[] = [];
  const dependencies: Parameters<typeof handleChatConnection>[2] = { isSessionActive: () => true, runtime: {
    hasRuntime: () => true,
    run: async (_provider, command, options) => { runs.push({ command, options }); },
    abort: async (_provider, id) => { aborts.push(id); return true; },
    resolveToolApproval: () => {},
    hasBackgroundWork: () => false,
    hasBackgroundTask: () => false,
    stopBackgroundTask: async () => false,
    getPendingApprovalsForSession: () => [],
  } };
  handleChatConnection(socket as never, { user: { id: 1 } } as never, dependencies);
  try {
    await runTest({
      cwd, foreignRoot, sessionId, otherSessionId, workspace, foreignWorkspace, socket, runs, aborts, dependencies, bind,
      frame: async data => {
        const listener = socket.listeners('message')[0];
        assert.ok(listener);
        await listener(JSON.stringify(data));
      },
      materialize: async (id = sessionId) => {
        materializing=true;
        try {
          const execution = await admitWorkspaceExecution({ cwd, sessionId: id, workspaceMode: 'isolated' });
          await execution.close();
        } finally { materializing=false; }
        const descriptor = describeWorkspaceSelection({ projectId: project.project_id, sourceRoot: cwd, sessionId: id }).session;
        assert.ok(descriptor);
        return descriptor;
      },
    });
  } finally {
    enrolled.delete(cwd);for(const [id,lease] of leases)if(lease.root===cwd)leases.delete(id);
    materializing=false;
    mock.restoreAll();
    connectedClients.clear();
    chatRunRegistry.clearAll();
    sessionsDb.deleteSessionById(sessionId);
    sessionsDb.deleteSessionById(otherSessionId);
    for (const target of [cwd, cwd + '.chisa-state', cwd + '.replaced', foreignRoot, foreignRoot + '.chisa-state']) {
      assert.equal(path.dirname(path.resolve(target)), path.resolve(WORKSPACES_ROOT));
      await rm(target, { recursive: true, force: true });
    }
  }
}

function expectRejection(socket: ReturnType<typeof createSocket>, code: string, sessionId: string) {
  const error = [...socket.frames].reverse().find(frame => frame.kind === 'protocol_error');
  assert.equal(error?.code, code);
  assert.equal(error?.sessionId, sessionId);
  assert.equal(socket.frames.some(frame => frame.kind === 'history_truncated'), false);
  assert.equal(chatRunRegistry.getRun(sessionId), undefined);
}

test('bound sends require a complete selector before model persistence, edits or run registration', async () => {
  await withGateway(async ({ sessionId, workspace, socket, frame, runs }) => {
    const model = mock.method(providerModelsService, 'setSessionModel', () => {});
    const effort = mock.method(providerModelsService, 'setSessionEffort', () => {});
    const anchors = mock.method(sessionsService, 'resolveEditAnchor', async () => ({ supported: true, found: true, resumeThroughId: null }));
    for (const type of ['chat.send', 'chat.edit-send']) {
      await frame({ type, sessionId, anchorId: 'turn', content: 'reject', options: { model: 'model', effort: 'high' } });
      expectRejection(socket, 'WORKSPACE_SELECTOR_REQUIRED', sessionId);
      await frame({ type, sessionId, projectId: workspace.projectId, anchorId: 'turn', content: 'reject' });
      expectRejection(socket, 'INVALID_WORKSPACE_SELECTOR', sessionId);
    }
    assert.equal(anchors.mock.callCount(), 0);
    assert.equal(model.mock.callCount(), 0);
    assert.equal(effort.mock.callCount(), 0);
    assert.deepEqual(runs, []);
  });
});

test('missing live-session hook denies chat actions despite forged frame authorization fields', async () => {
  await withGateway(async ({ sessionId, workspace, socket, frame, runs, aborts, dependencies }) => {
    delete dependencies.isSessionActive;
    const anchors = mock.method(sessionsService, 'resolveEditAnchor', async () => { assert.fail('Missing guard must not read history'); });
    const model = mock.method(providerModelsService, 'setSessionModel', () => { assert.fail('Missing guard must not persist model'); });
    const lookups = mock.method(dependencies.runtime, 'hasRuntime', () => { assert.fail('Missing guard must not resolve runtime'); });
    for (const type of ['chat.send', 'chat.edit-send', 'chat.abort', 'chat.stop-task', 'chat.subscribe', 'chat.permission-response']) {
      await frame({ type, sessionId, ...workspace, anchorId: 'turn', taskId: 'task', requestId: 'approval',
        userId: 1, isSessionActive: true, content: 'reject', options: { model: 'forged', isSessionActive: true } });
      assert.equal(socket.frames.at(-1)?.code, 'UNAUTHORIZED');
      assert.equal(chatRunRegistry.getRun(sessionId), undefined);
    }
    assert.equal(anchors.mock.callCount(), 0);
    assert.equal(model.mock.callCount(), 0);
    assert.equal(lookups.mock.callCount(), 0);
    assert.deepEqual(runs, []);
    assert.deepEqual(aborts, []);
    assert.equal(socket.frames.some(message => message.kind === 'history_truncated'), false);
  });
});

test('retained preview checks capture the gateway login independently from socket liveness and frame options', async () => {
  await withGateway(async ({ sessionId, workspace, socket, frame, dependencies }) => {
    let active = true;
    let captured: (() => void) | undefined;
    dependencies.isAuthSessionActive = () => active;
    const run: typeof dependencies.runtime.run = async (_provider, _command, _options, writer) => {
      captured = writer.assertAuthSessionActive;
      assert.ok(captured);
      captured();
    };
    mock.method(dependencies.runtime, 'run', run);
    await frame({ type: 'chat.send', sessionId, ...workspace, content: 'preview', options: { isAuthSessionActive: true, assertAuthSessionActive: 'forged' } });
    assert.ok(captured);
    socket.readyState = 3;
    assert.doesNotThrow(captured, 'a healthy persistent login survives a disconnected transport');
    active = false;
    assert.throws(captured, { code: 'UNAUTHORIZED' });
    dependencies.isAuthSessionActive = () => true;
    assert.throws(captured, { code: 'UNAUTHORIZED' }, 'a replacement login or gateway callback cannot retarget an already captured preview');
  });
});

test('revoked edit anchor await denies before history, model persistence or run registration', async () => {
  await withGateway(async ({ sessionId, workspace, socket, frame, runs, dependencies }) => {
    let active = true;
    dependencies.isSessionActive = () => active;
    const model = mock.method(providerModelsService, 'setSessionModel', () => {});
    const effort = mock.method(providerModelsService, 'setSessionEffort', () => {});
    const rewind = mock.method(sessionsService, 'rewindSessionForEdit', async () => {});
    mock.method(sessionsService, 'providerRewindsForEdit', () => true);
    const anchors = mock.method(sessionsService, 'resolveEditAnchor', async () => {
      await Promise.resolve();
      active = false;
      return { supported: true, found: true, resumeThroughId: null };
    });
    await frame({ type: 'chat.edit-send', sessionId, ...workspace, anchorId: 'turn', content: 'revoked', options: { model: 'forged', effort: 'high' } });
    expectRejection(socket, 'UNAUTHORIZED', sessionId);
    assert.equal(anchors.mock.callCount(), 1);
    assert.equal(model.mock.callCount(), 0);
    assert.equal(effort.mock.callCount(), 0);
    assert.equal(rewind.mock.callCount(), 0);
    assert.deepEqual(runs, []);
  });
});

test('initial unmaterialized session accepts only its project replica and overrides forged execution options', async () => {
  await withGateway(async ({ cwd, sessionId, otherSessionId, workspace, frame, runs }) => {
    await frame({ type: 'chat.send', sessionId, ...workspace, content: 'first', options: {
      sessionId: otherSessionId, cwd: '/forged', projectPath: '/forged', workspaceMode: 'shared',
      workspaceDescriptor: { workspaceId: 'forged' }, workspace: { workspaceId: 'forged' },
    } });
    assert.equal(runs.length, 1);
    const options = runs[0].options;
    assert.equal(options.sessionId, sessionId);
    assert.equal(options.cwd, cwd);
    assert.equal(options.projectPath, cwd);
    assert.equal(options.workspaceMode, 'isolated');
    assert.deepEqual(selector(options.workspaceDescriptor), workspace);
    assert.equal(options.workspaceDescriptor.kind, 'cloudReplica');
    assert.equal(options.workspace, undefined);
  });
});

test('wrong project and another app session workspace cannot authorize an unmaterialized chat', async () => {
  await withGateway(async ({ sessionId, otherSessionId, foreignWorkspace, materialize, socket, frame, runs }) => {
    await frame({ type: 'chat.send', sessionId, ...foreignWorkspace, content: 'wrong project' });
    expectRejection(socket, 'WORKSPACE_SELECTION_MISMATCH', sessionId);
    const other = await materialize(otherSessionId);
    await frame({ type: 'chat.send', sessionId, ...selector(other), content: 'wrong session' });
    expectRejection(socket, 'WORKSPACE_SELECTION_MISMATCH', sessionId);
    assert.deepEqual(runs, []);
  });
});

test('materialized shared execution requires the exact session identity and generation even at the same root', async () => {
  await withGateway(async ({ cwd, sessionId, otherSessionId, workspace, materialize, socket, frame, runs }) => {
    const descriptor = await materialize();
    const other = await materialize(otherSessionId);
    assert.equal(descriptor.rootPath, cwd);
    assert.equal(descriptor.effectiveMode, 'shared');
    await frame({ type: 'chat.send', sessionId, ...workspace, content: 'replica is no longer valid' });
    expectRejection(socket, 'WORKSPACE_SELECTION_MISMATCH', sessionId);
    await frame({ type: 'chat.send', sessionId, ...selector(other), content: 'other session' });
    expectRejection(socket, 'WORKSPACE_SELECTION_MISMATCH', sessionId);
    await frame({ type: 'chat.send', sessionId, ...selector(descriptor), generation: randomUUID(), content: 'stale' });
    expectRejection(socket, 'WORKSPACE_GENERATION_CHANGED', sessionId);
    await frame({ type: 'chat.send', sessionId, ...selector(descriptor), content: 'correct' });
    assert.equal(runs.length, 1);
    assert.deepEqual(runs[0].options.workspaceDescriptor, descriptor);
    assert.equal(runs[0].options.cwd, cwd);
  });
});

test('binding replacement invalidates materialized sessions without falling back to the new replica', async () => {
  await withGateway(async ({ sessionId, materialize, bind, socket, frame, runs }) => {
    const descriptor = await materialize();
    await bind('replaced-epoch');
    await frame({ type: 'chat.send', sessionId, ...selector(descriptor), content: 'stale session' });
    expectRejection(socket, 'WORKSPACE_IDENTITY_CHANGED', sessionId);
    assert.deepEqual(runs, []);
  });
});

test('replaced execution directory is rejected before provider dispatch', async () => {
  await withGateway(async ({ cwd, sessionId, materialize, socket, frame, runs }) => {
    const descriptor = await materialize();
    const replaced = cwd + '.replaced';
    assert.equal(path.dirname(path.resolve(replaced)), path.resolve(WORKSPACES_ROOT));
    assert.equal(path.dirname(cwd), path.resolve(WORKSPACES_ROOT));
    await rename(cwd, replaced);
    await mkdir(cwd);
    await frame({ type: 'chat.send', sessionId, ...selector(descriptor), content: 'replaced' });
    expectRejection(socket, 'WORKSPACE_IDENTITY_CHANGED', sessionId);
    assert.deepEqual(runs, []);
  });
});

test('edit anchor await revalidates the replica before history, model or rewind side effects', async () => {
  await withGateway(async ({ sessionId, workspace, bind, socket, frame, runs }) => {
    const model = mock.method(providerModelsService, 'setSessionModel', () => {});
    const rewind = mock.method(sessionsService, 'rewindSessionForEdit', async () => {});
    mock.method(sessionsService, 'providerRewindsForEdit', () => true);
    mock.method(sessionsService, 'resolveEditAnchor', async () => {
      await bind('changed-during-anchor');
      return { supported: true, found: true, resumeThroughId: null };
    });
    await frame({ type: 'chat.edit-send', sessionId, ...workspace, anchorId: 'turn', content: 'stale edit', options: { model: 'new-model' } });
    expectRejection(socket, 'WORKSPACE_GENERATION_CHANGED', sessionId);
    assert.equal(model.mock.callCount(), 0);
    assert.equal(rewind.mock.callCount(), 0);
    assert.deepEqual(runs, []);
  });
});

test('edit anchor await revalidates persisted session ownership before any rewind', async () => {
  await withGateway(async ({ sessionId, foreignRoot, workspace, socket, frame, runs }) => {
    const rewind = mock.method(sessionsService, 'rewindSessionForEdit', async () => {});
    mock.method(sessionsService, 'providerRewindsForEdit', () => true);
    mock.method(sessionsService, 'resolveEditAnchor', async () => {
      sessionsDb.deleteSessionById(sessionId);
      sessionsDb.createAppSession(sessionId, 'claude', foreignRoot);
      return { supported: true, found: true, resumeThroughId: null };
    });
    await frame({ type: 'chat.edit-send', sessionId, ...workspace, anchorId: 'turn', content: 'moved session' });
    expectRejection(socket, 'WORKSPACE_SELECTION_MISMATCH', sessionId);
    assert.equal(rewind.mock.callCount(), 0);
    assert.deepEqual(runs, []);
  });
});

test('detached stale or missing snapshots cannot interrupt an active run', async () => {
  await withGateway(async ({ sessionId, workspace, dependencies, runs, aborts }) => {
    const active = chatRunRegistry.startRun({ appSessionId: sessionId, provider: 'claude', providerSessionId: null, connection: null, userId: 1 });
    assert.ok(active);
    for (const options of [undefined, { workspace: { ...workspace, generation: randomUUID() } }, { workspace: {} }, { workspace: null }]) {
      const result = await runDetachedChatTurn({ sessionId, userId: 1, content: 'stale queue', options, interruptActiveRun: true }, dependencies);
      assert.equal(result.started, false);
      assert.match(result.code!, /^(WORKSPACE_SELECTOR_REQUIRED|WORKSPACE_GENERATION_CHANGED|INVALID_WORKSPACE_SELECTOR)$/);
      assert.equal(chatRunRegistry.getRun(sessionId), active);
      assert.equal(active.status, 'running');
    }
    assert.deepEqual(aborts, []);
    assert.deepEqual(runs, []);
  });
});

test('detached snapshots remain immutable after materialization and valid session snapshots dispatch', async () => {
  await withGateway(async ({ sessionId, workspace, materialize, dependencies, runs }) => {
    const descriptor = await materialize();
    const stale = await runDetachedChatTurn({ sessionId, userId: 1, content: 'old queue', options: { workspace } }, dependencies);
    assert.equal(stale.started, false);
    assert.equal(stale.code, 'WORKSPACE_SELECTION_MISMATCH');
    const valid = await runDetachedChatTurn({ sessionId, userId: 1, content: 'new queue', options: { workspace: selector(descriptor), workspaceDescriptor: { workspaceId: 'forged' } } }, dependencies);
    assert.equal(valid.started, true);
    assert.equal(valid.error, null);
    assert.equal(runs.length, 1);
    assert.deepEqual(runs[0].options.workspaceDescriptor, descriptor);
  });
});

test('detached dispatch revalidates after awaiting cancellation', async () => {
  await withGateway(async ({ sessionId, workspace, bind, dependencies, runs }) => {
    const active = chatRunRegistry.startRun({ appSessionId: sessionId, provider: 'claude', providerSessionId: null, connection: null, userId: 1 });
    assert.ok(active);
    mock.method(dependencies.runtime, 'abort', async () => { await bind('changed-during-abort'); return true; });
    const result = await runDetachedChatTurn({ sessionId, userId: 1, content: 'stale after stop', options: { workspace }, interruptActiveRun: true }, dependencies);
    assert.equal(result.started, false);
    assert.equal(result.code, 'WORKSPACE_GENERATION_CHANGED');
    assert.deepEqual(runs, []);
  });
});

test('standalone clients retain selector-free compatibility and cannot inject a descriptor', async () => {
  await withGateway(async ({ sessionId, workspace, socket, frame, dependencies, runs }) => {
    await frame({ type: 'chat.send', sessionId, projectId: workspace.projectId, content: 'partial selector' });
    expectRejection(socket, 'INVALID_WORKSPACE_SELECTOR', sessionId);
    await frame({ type: 'chat.send', sessionId, content: 'legacy', options: { workspaceDescriptor: { workspaceId: 'forged' } } });
    const detached = await runDetachedChatTurn({ sessionId, userId: 1, content: 'legacy queue', options: { workspaceDescriptor: { workspaceId: 'forged' } } }, dependencies);
    assert.equal(detached.started, true);
    assert.equal(runs.length, 2);
    assert.ok(runs.every(run => Object.hasOwn(run.options, 'workspaceDescriptor') && run.options.workspaceDescriptor === undefined));
  }, false);
});
