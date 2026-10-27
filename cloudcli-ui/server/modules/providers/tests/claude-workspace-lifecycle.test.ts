import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import { createSdkMcpServer, tool, type Options } from '@anthropic-ai/claude-agent-sdk';

import { sessionsDb, sshProjectTargetsDb, userDb } from '@/modules/database/index.js';
import { claudeConnectionsService } from '@/modules/providers/services/claude-connections.service.js';
import { WORKSPACES_ROOT } from '@/shared/index.js';
import type { ProviderRuntimeContext, SshProjectTarget, SshSessionTarget } from '@/shared/index.js';
import type { ClaudeAccountLaunchSnapshot, HiRouteConnection, NormalizedMessage } from '@/shared/types.js';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

const sshAnchor = path.join(WORKSPACES_ROOT, '.chisa-ssh-projects', 'claude-owner-fixture');
let sshTarget: SshProjectTarget = { projectId: 'ssh-project', ownerId: '42', connectionId: 'windows', connectionLabel: 'Fixture',
  rootPath: 'D:\\Code\\App', rootIdentity: 'physical-root', generation: 'ssh-generation', workspaceId: 'ssh-workspace', anchorPath: sshAnchor,
  phase: 'idle', activeRunId: null, pendingJobId: null };
let sshProbes = 0;
let sshOperations = 0;
let sshPreflightRequests: Array<Record<string, unknown>> = [];
mock.module('@/modules/ssh-workspaces/index.js', { namedExports: {
  probeSshWorkspace: async () => { sshProbes++; return { rootIdentity: sshTarget.rootIdentity, rootPath: sshTarget.rootPath }; },
  executeSshWorkspace: async (input: { request: Record<string, unknown>; userId: string; generation: string; expectedRootIdentity: string }) => {
    sshOperations++;
    assert.equal(input.userId, sshTarget.ownerId);
    assert.equal(input.generation, sshTarget.generation);
    assert.equal(input.expectedRootIdentity, sshTarget.rootIdentity);
    assert.ok(['lstat', 'list', 'read'].includes(String(input.request.op)), 'only configuration inspection is permitted in this lifecycle fixture');
    assert.ok(String(input.request.path).startsWith('/workspace/'));
    sshPreflightRequests.push({ ...input.request });
    throw Object.assign(new Error('Fixture has no remote project configuration'), { code: 'ENOENT' });
  },
} });

let queries = 0;
let managedReleases: unknown[] = [];
let releaseScenario: () => Promise<void> = async () => {};
let scenario: (input: Parameters<typeof import('@anthropic-ai/claude-agent-sdk').query>[0]) => unknown;
mock.module('@anthropic-ai/claude-agent-sdk', {
  namedExports: { tool, createSdkMcpServer, query: (input: Parameters<typeof import('@anthropic-ai/claude-agent-sdk').query>[0]) => { queries++; assert.equal('chisaPrepareLaunch' in (input.options ?? {}), false); assert.equal('chisaProjectRuntime' in (input.options ?? {}), false); return scenario(input); } },
});
let managedScenario: (userId: unknown, signal?: AbortSignal) => Promise<HiRouteConnection> = async () => { throw new Error('Managed HiRoute must be selected explicitly'); };
mock.module('@/modules/providers/services/hiroute-managed.service.js', { namedExports: {
  prepareManagedHiRoute: (userId: unknown, signal?: AbortSignal) => managedScenario(userId, signal),
  releaseManagedHiRoute: async (userId: unknown) => { managedReleases.push(userId); await releaseScenario(); },
} });
let accountReleases = 0;
let selectedAccount = 'profile-a';
let captureAccount: (userId: unknown) => ClaudeAccountLaunchSnapshot | null = () => null;
let historyCalls: { kind: string; accountId?: string; userId?: number; options: Record<string, unknown> }[] = [];
mock.module('@/modules/providers/services/claude-accounts.service.js', { namedExports: { claudeAccountsService: {
  captureLaunch: (userId: unknown) => captureAccount(userId),
  applyToOptions: (options: Options, snapshot: ClaudeAccountLaunchSnapshot) => { options.env = { ...options.env, CLAUDE_CONFIG_DIR: snapshot.configDir, CLAUDE_SECURESTORAGE_CONFIG_DIR: snapshot.authDir }; },
} } });
mock.module('@/modules/providers/services/claude-account-history.service.js', { namedExports: {
  prepareClaudeAccountHistory: async (snapshot: ClaudeAccountLaunchSnapshot, options: Record<string, unknown> = {}) => { historyCalls.push({ kind: 'account', accountId: snapshot.accountId, options }); },
  prepareClaudeUserHistory: async (userId: number, options: Record<string, unknown> = {}) => { historyCalls.push({ kind: 'private', userId, options }); return path.join(os.tmpdir(), 'private-history-fixture', String(userId)); },
} });
mock.module('@/shared/claude-cli-path.js', { namedExports: { resolveClaudeCodeExecutablePath: () => undefined } });
mock.module('@/modules/notifications/index.js', { namedExports: {
  createNotificationEvent: (event: unknown) => event,
  notifyBackgroundWorkCompleted() {}, notifyRunFailed() {}, notifyRunStopped() {}, notifyUserIfEnabled() {},
} });
const { queryClaudeSDK, abortClaudeSDKSession } = await import('@/modules/providers/list/claude/claude-runtime.provider.js');
const { describeWorkspaceSelection } = await import('@/modules/workspace-bridge/index.js');

async function fixture(run: (cwd: string, context: ProviderRuntimeContext, frames: NormalizedMessage[]) => Promise<void>) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'chisa-sdk-lifecycle-'));
  await writeFile(path.join(cwd, 'README.md'), 'fixture');
  const access = fs.access.bind(fs);
  mock.method(fs, 'access', async (candidate: Parameters<typeof fs.access>[0], mode?: number) => {
    if (String(candidate) === path.join(os.homedir(), '.claude.json')) throw Object.assign(new Error('isolated'), { code: 'ENOENT' });
    return access(candidate, mode);
  });
  mock.method(userDb, 'getActiveUserIds', () => []);
  mock.method(sessionsDb, 'getSessionById', () => null);
  mock.method(sessionsDb, 'getSessionByProviderSessionId', () => null);
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => 'sonnet',
    getProviderModels: async () => ({}) as never,
    normalizeMessage: () => [],
    isProviderInstalled: async () => true,
  };
  queries = 0;
  managedReleases = [];
  accountReleases = 0;
  selectedAccount = 'profile-a';
  historyCalls = [];
  captureAccount = (userId: unknown) => {
    if (Number(userId) !== 42) return null;
    const accountId = selectedAccount;
    let released = false;
    return { userId: 42, accountId, configDir: path.join(cwd, accountId), authDir: path.join(cwd, accountId), email: `${accountId}@fixture.test`, release: () => { if (!released) { released = true; accountReleases++; } } };
  };
  mock.method(claudeConnectionsService, 'getActiveConnection', () => null);
  releaseScenario = async () => {};
  try { await run(cwd, context, []); }
  finally {
    mock.restoreAll();
    await rm(cwd, { recursive: true, force: true });
    await rm(cwd + '.chisa-state', { recursive: true, force: true });
  }
}

function sshFixture(sessionId = 'ssh-app-session') {
  sshTarget = { ...sshTarget, phase: 'idle', activeRunId: null, pendingJobId: null };
  sshProbes = 0;
  sshOperations = 0;
  sshPreflightRequests = [];
  const row = { session_id: sessionId, provider: 'claude', provider_session_id: 'ssh-provider-session', project_path: sshAnchor, workspace_mode: 'shared' } as NonNullable<ReturnType<typeof sessionsDb.getSessionById>>;
  mock.method(sshProjectTargetsDb, 'getByPath', (candidate: string) => {
    const absolute = path.resolve(candidate);
    return absolute === sshAnchor || absolute.startsWith(sshAnchor + path.sep) ? { ...sshTarget } : null;
  });
  mock.method(sshProjectTargetsDb, 'getByProjectId', () => ({ ...sshTarget }));
  mock.method(sshProjectTargetsDb, 'getByAnchor', () => ({ ...sshTarget }));
  mock.method(sshProjectTargetsDb, 'getSessionTarget', (id: string): SshSessionTarget | null => id === sessionId
    ? { sessionId, projectId: sshTarget.projectId, generation: sshTarget.generation } : null);
  mock.method(sshProjectTargetsDb, 'pinSession', () => ({ sessionId, projectId: sshTarget.projectId, generation: sshTarget.generation }));
  mock.method(sshProjectTargetsDb, 'beginRun', (_project: string, runId: string) => {
    sshTarget = { ...sshTarget, phase: 'running', activeRunId: runId };
    return { ...sshTarget };
  });
  mock.method(sshProjectTargetsDb, 'finishRun', () => {
    sshTarget = { ...sshTarget, phase: 'idle', activeRunId: null };
    return { ...sshTarget };
  });
  mock.method(sessionsDb, 'getSessionById', (id: string) => id === sessionId ? row : null);
  mock.method(sessionsDb, 'getSessionByProviderSessionId', (id: string) => id === row.provider_session_id ? row : null);
  return row;
}

function watchRuntimeSideEffects(context: ProviderRuntimeContext) {
  const calls = { session: 0, model: 0, catalog: 0, installed: 0, credentials: 0, managed: 0, mcp: 0 };
  context.resolveProviderSessionId = () => { calls.session++; return 'untrusted-context-session'; };
  context.resolveResumeModel = async () => { calls.model++; return 'sonnet'; };
  context.getProviderModels = async () => { calls.catalog++; return {} as never; };
  context.isProviderInstalled = async () => { calls.installed++; return true; };
  mock.method(claudeConnectionsService, 'applyToOptions', () => { calls.credentials++; });
  managedScenario = async () => { calls.managed++; throw new Error('Managed routing must not be selected'); };
  mock.method(fs, 'access', async () => { calls.mcp++; throw Object.assign(new Error('isolated'), { code: 'ENOENT' }); });
  return calls;
}

function assertNoRuntimeSideEffects(calls: ReturnType<typeof watchRuntimeSideEffects>) {
  assert.deepEqual(calls, { session: 0, model: 0, catalog: 0, installed: 0, credentials: 0, managed: 0, mcp: 0 });
  assert.equal(queries, 0);
  assert.equal(sshProbes, 0);
  assert.equal(sshOperations, 0);
}

for (const userId of [undefined, null, 'foreign'] as const) {
  test(`Claude rejects SSH writer ${String(userId)} before any runtime lookup`, async () => {
    await fixture(async (_cwd, context) => {
      sshFixture();
      const calls = watchRuntimeSideEffects(context);
      for (const location of [{ cwd: sshAnchor }, { projectPath: sshAnchor }]) {
        for (const sessionId of [undefined, 'ssh-app-session']) {
          for (const model of ['sonnet', 'hiroute']) {
            await assert.rejects(queryClaudeSDK('fixture', { ...location, sessionId, model, permissionMode: 'bypassPermissions' }, { userId, send() {} }, context), { code: 'SSH_WORKSPACE_FORBIDDEN' });
          }
        }
      }
      assertNoRuntimeSideEffects(calls);
    });
  });
}

test('Claude rejects unknown SSH anchors before model and SDK initialization', async () => {
  await fixture(async (_cwd, context) => {
    sshFixture();
    const calls = watchRuntimeSideEffects(context);
    await assert.rejects(queryClaudeSDK('fixture', { cwd: path.join(WORKSPACES_ROOT, '.chisa-ssh-projects', 'unknown') }, { userId: 42, send() {} }, context), { code: 'SSH_WORKSPACE_NOT_FOUND' });
    assertNoRuntimeSideEffects(calls);
  });
});

test('Claude rejects unmapped, native, foreign, provider-mismatched and stale SSH sessions before lookups', async () => {
  await fixture(async (cwd, context) => {
    const row = sshFixture();
    const calls = watchRuntimeSideEffects(context);
    for (const sessionId of ['missing-session', 'ssh-provider-session']) {
      await assert.rejects(queryClaudeSDK('fixture', { cwd: sshAnchor, sessionId }, { userId: 42, send() {} }, context), { code: 'WORKSPACE_SELECTION_MISMATCH' });
    }
    mock.method(sessionsDb, 'getSessionById', () => ({ ...row, project_path: cwd }));
    await assert.rejects(queryClaudeSDK('fixture', { cwd: sshAnchor, sessionId: row.session_id }, { userId: 42, send() {} }, context), { code: 'WORKSPACE_SELECTION_MISMATCH' });
    const foreignAnchor = path.join(WORKSPACES_ROOT, '.chisa-ssh-projects', 'foreign-project');
    mock.method(sshProjectTargetsDb, 'getByPath', (candidate: string) => path.resolve(candidate) === foreignAnchor
      ? { ...sshTarget, projectId: 'foreign-project', ownerId: 'foreign', anchorPath: foreignAnchor } : { ...sshTarget });
    mock.method(sessionsDb, 'getSessionById', () => ({ ...row, project_path: foreignAnchor }));
    await assert.rejects(queryClaudeSDK('fixture', { cwd: sshAnchor, sessionId: row.session_id }, { userId: 42, send() {} }, context), { code: 'SSH_WORKSPACE_FORBIDDEN' });
    mock.method(sessionsDb, 'getSessionById', () => ({ ...row, provider: 'codex' }));
    await assert.rejects(queryClaudeSDK('fixture', { cwd: sshAnchor, sessionId: row.session_id }, { userId: 42, send() {} }, context), { code: 'WORKSPACE_PROVIDER_UNSUPPORTED' });
    mock.method(sessionsDb, 'getSessionById', () => row);
    for (const pin of [null, { sessionId: row.session_id, projectId: 'other-project', generation: sshTarget.generation }]) {
      mock.method(sshProjectTargetsDb, 'getSessionTarget', () => pin);
      await assert.rejects(queryClaudeSDK('fixture', { cwd: sshAnchor, sessionId: row.session_id }, { userId: 42, send() {} }, context), { code: 'WORKSPACE_SELECTION_MISMATCH' });
    }
    mock.method(sshProjectTargetsDb, 'getSessionTarget', () => ({ sessionId: row.session_id, projectId: sshTarget.projectId, generation: 'stale' }));
    await assert.rejects(queryClaudeSDK('fixture', { cwd: sshAnchor, sessionId: row.session_id }, { userId: 42, send() {} }, context), { code: 'WORKSPACE_GENERATION_CHANGED' });
    assertNoRuntimeSideEffects(calls);
  });
});

test('Claude cannot resume a known SSH session through a cloud cwd', async () => {
  await fixture(async (cwd, context) => {
    const row = sshFixture();
    const calls = watchRuntimeSideEffects(context);
    for (const sessionId of [row.session_id, row.provider_session_id]) {
      await assert.rejects(queryClaudeSDK('fixture', { cwd, sessionId }, { userId: 'foreign', send() {} }, context), { code: 'SSH_WORKSPACE_FORBIDDEN' });
      await assert.rejects(queryClaudeSDK('fixture', { cwd, sessionId }, { userId: 42, send() {} }, context), { code: 'WORKSPACE_SELECTION_MISMATCH' });
    }
    assertNoRuntimeSideEffects(calls);
  });
});

test('Claude allows an authenticated SSH owner with the exact pinned session and mapped provider id', async () => {
  await fixture(async (_cwd, context) => {
    const row = sshFixture();
    const calls = watchRuntimeSideEffects(context);
    scenario = input => {
      assert.equal(input.options?.cwd, sshAnchor);
      assert.equal(input.options?.resume, row.provider_session_id);
      return Object.assign((async function* () { yield { type: 'result', subtype: 'success' }; })(), { close() {} });
    };
    await queryClaudeSDK('fixture', { projectPath: sshAnchor, sessionId: row.session_id, permissionMode: 'bypassPermissions' }, { userId: 42, send() {} }, context);
    assert.equal(queries, 1);
    assert.equal(calls.session, 0, 'the validated row owns provider resume mapping');
    assert.equal(calls.model, 1);
    assert.equal(calls.catalog, 1);
    assert.equal(calls.credentials, 1);
    assert.equal(sshProbes, 1);
    assert.ok(sshOperations > 0, 'authenticated admission reads optional project configuration before query');
    assert.ok(sshPreflightRequests.some(request => request.op === 'lstat' && request.path === '/workspace/CLAUDE.md'));
    assert.ok(sshPreflightRequests.every(request => ['lstat', 'list', 'read'].includes(String(request.op))));
    assert.equal(sshTarget.phase, 'idle');
  });
});

test('Claude allows an authenticated direct SSH owner without a session', async () => {
  await fixture(async (_cwd, context) => {
    sshFixture();
    const calls = watchRuntimeSideEffects(context);
    scenario = input => {
      assert.equal(input.options?.cwd, sshAnchor);
      assert.equal(input.options?.resume, undefined);
      return Object.assign((async function* () { yield { type: 'result', subtype: 'success' }; })(), { close() {} });
    };
    await queryClaudeSDK('fixture', { cwd: sshAnchor }, { userId: '42', send() {} }, context);
    assert.equal(queries, 1);
    assert.equal(calls.session, 0);
    assert.equal(sshProbes, 1);
    assert.ok(sshPreflightRequests.some(request => request.op === 'lstat' && request.path === '/workspace/CLAUDE.md'));
    assert.ok(sshPreflightRequests.every(request => ['lstat', 'list', 'read'].includes(String(request.op))));
    assert.equal(sshTarget.phase, 'idle');
  });
});

test('Claude streams observed main-session versions without rewriting the pinned SDK model', { timeout: 5000 }, async () => {
  await fixture(async (cwd, context, frames) => {
    context.resolveResumeModel = async () => 'claude-opus-5';
    scenario = input => {
      assert.equal(input.options?.model, 'claude-opus-5');
      void (async () => { for await (const _message of input.prompt as AsyncIterable<unknown>) { /* consume held stdin */ } })();
      return Object.assign((async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'provider-id', model: 'claude-opus-5' };
        yield { type: 'assistant', session_id: 'provider-id', message: { model: 'claude-opus-5' } };
        yield { type: 'assistant', session_id: 'provider-id', parent_tool_use_id: 'task', message: { model: 'claude-haiku-4-5' } };
        yield { type: 'result', subtype: 'success' };
      })(), { close() {} });
    };
    await queryClaudeSDK('fixture', { cwd, sessionId: 'version-fixture', model: 'claude-opus-5' }, { send: (frame: NormalizedMessage) => frames.push(frame) }, context);
    const updates = frames.filter(frame => frame.kind === 'status' && frame.text === 'model_resolved');
    assert.equal(updates.length, 1);
    assert.equal(updates[0].model, 'claude-opus-5');
  });
});

test('Claude carries the selected workspace through admission but strips it from SDK options', { timeout: 5000 }, async () => {
  await fixture(async (cwd, context) => {
    const descriptor = describeWorkspaceSelection({ projectId: 'project', sourceRoot: cwd }).cloudReplica;
    scenario = input => {
      assert.equal(input.options?.cwd, cwd);
      assert.equal('chisaWorkspaceDescriptor' in input.options!, false);
      assert.equal('chisaSessionId' in input.options!, false);
      return Object.assign((async function* () { yield { type: 'result', subtype: 'success' }; })(), { close() {} });
    };
    await queryClaudeSDK('fixture', { cwd, sessionId: 'selected-fixture', workspaceDescriptor: descriptor }, { send() {} }, context);
    assert.equal(queries, 1);
    await assert.rejects(queryClaudeSDK('stale', { cwd, sessionId: 'stale-fixture', workspaceDescriptor: { ...descriptor, generation: 'stale-generation' } }, { send() {} }, context), { code: 'WORKSPACE_GENERATION_CHANGED' });
    assert.equal(queries, 1, 'a stale descriptor must stop before SDK entry');
  });
});

test('Claude rechecks selected workspace at a delayed actual process launch', { timeout: 5000 }, async () => {
  await fixture(async (cwd, context) => {
    const descriptor = describeWorkspaceSelection({ projectId: 'project', sourceRoot: cwd }).cloudReplica;
    let spawnChecked = false;
    scenario = input => Object.assign((async function* () {
      // Initializing a repository legitimately rotates its catalog generation
      // after SDK entry, before the SDK invokes the actual process spawn hook.
      await fs.mkdir(path.join(cwd, '.git'));
      assert.throws(() => input.options!.spawnClaudeCodeProcess!({ command: 'must-not-execute', args: [], cwd, env: {}, signal: new AbortController().signal }), { code: 'WORKSPACE_GENERATION_CHANGED' });
      spawnChecked = true;
      yield { type: 'result', subtype: 'success' };
    })(), { close() {} });
    await queryClaudeSDK('fixture', { cwd, sessionId: 'delayed-spawn-fixture', workspaceDescriptor: descriptor }, { send() {} }, context);
    assert.equal(spawnChecked, true);
  });
});

test('explicit HiRoute awaits managed preparation and bypasses the saved active connection', { timeout: 5000 }, async () => {
  await fixture(async (cwd, context, frames) => {
    const entered = gate();
    const ready = gate();
    let managedSignal: AbortSignal | undefined;
    managedScenario = async (userId, signal) => {
      assert.equal(userId, 42);
      assert.ok(signal instanceof AbortSignal);
      assert.equal(signal.aborted, false);
      managedSignal = signal;
      entered.resolve();
      await ready.promise;
      return { enabled: true, baseUrl: 'https://managed.fixture', routeModel: 'plan/managed', authToken: 'managed-fixture-token' };
    };
    mock.method(claudeConnectionsService, 'applyActiveToOptions', () => { throw new Error('Saved active endpoint must not override managed routing'); });
    // Session readback can return an ordinary model; explicit HiRoute selection still owns routing.
    context.resolveResumeModel = async () => 'sonnet';
    scenario = input => {
      assert.equal(input.options?.abortController?.signal, managedSignal);
      assert.equal(input.options?.model, 'plan/managed');
      assert.equal(input.options?.env?.ANTHROPIC_BASE_URL, 'https://managed.fixture');
      assert.equal(input.options?.env?.ANTHROPIC_AUTH_TOKEN, 'managed-fixture-token');
      assert.equal(input.options?.env?.ANTHROPIC_API_KEY, '');
      assert.equal(input.options?.effort, undefined);
      return Object.assign((async function* () { yield { type: 'result', subtype: 'success' }; })(), { close() {} });
    };
    const run = queryClaudeSDK('fixture', { cwd, sessionId: 'managed-fixture', model: 'hiroute', effort: 'high' }, { userId: 42, send: (frame: NormalizedMessage) => frames.push(frame) }, context);
    await entered.promise;
    assert.equal(queries, 0);
    ready.resolve();
    await run;
    assert.equal(queries, 1);
    assert.deepEqual(managedReleases, [42]);
    assert.equal(frames.find(frame => frame.kind === 'complete')?.success, true);
  });
});

test('HiRoute preparation consumes lifecycle cancellation before the SDK launches', { timeout: 5000 }, async () => {
  await fixture(async (cwd, context, frames) => {
    const entered = gate();
    let managedSignal: AbortSignal | undefined;
    managedScenario = async (_userId, signal) => {
      assert.ok(signal instanceof AbortSignal);
      managedSignal = signal;
      entered.resolve();
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      throw new Error('Preparation must reject cancellation');
    };
    scenario = () => { throw new Error('SDK must not launch'); };
    const run = queryClaudeSDK('fixture', { cwd, sessionId: 'managed-cancel-fixture', model: 'hiroute' }, { userId: 42, send: (frame: NormalizedMessage) => frames.push(frame) }, context);
    await entered.promise;
    const stop = abortClaudeSDKSession('managed-cancel-fixture');
    assert.equal(managedSignal?.aborted, true);
    assert.equal(await stop, true);
    await run;
    assert.equal(queries, 0);
    assert.deepEqual(managedReleases, []);
    assert.equal(frames.some(frame => frame.kind === 'complete' || frame.kind === 'error'), false);
  });
});

test('managed preparation failure reports an error before launching the SDK', { timeout: 5000 }, async () => {
  await fixture(async (cwd, context, frames) => {
    managedScenario = async () => { throw new Error('Managed fixture is unavailable'); };
    scenario = () => { throw new Error('SDK must not launch'); };
    await assert.rejects(queryClaudeSDK('fixture', { cwd, sessionId: 'managed-failure-fixture', model: 'hiroute' }, { userId: 42, send: (frame: NormalizedMessage) => frames.push(frame) }, context), /Managed fixture is unavailable/);
    assert.equal(queries, 0);
    assert.equal(frames.find(frame => frame.kind === 'error')?.content, 'Managed fixture is unavailable');
    assert.equal(frames.find(frame => frame.kind === 'complete')?.success, false);
  });
});

test('Claude preserves the original workspace admission failure for the detached dispatcher', { timeout: 5000 }, async () => {
  await fixture(async (cwd, context, frames) => {
    const original = Object.assign(new Error('Workspace admission fixture is busy'), { code: 'WORKSPACE_BUSY', workspaceAdmissionRejected: true });
    context.resolveResumeModel = async () => { throw original; };
    scenario = () => { throw new Error('SDK must not launch'); };
    await assert.rejects(queryClaudeSDK('fixture', { cwd, sessionId: 'busy-propagation-fixture' }, { send: (frame: NormalizedMessage) => frames.push(frame) }, context), error => error === original);
    assert.equal(queries, 0);
    assert.equal(frames.filter(frame => frame.kind === 'error').length, 1);
    assert.equal(frames.filter(frame => frame.kind === 'complete').length, 1);
    assert.equal(frames.find(frame => frame.kind === 'complete')?.success, false);
  });
});

test('managed gateway is retained through SDK teardown and released before completion', { timeout: 5000 }, async () => {
  await fixture(async (cwd, context, frames) => {
    const streamed = gate();
    const teardown = gate();
    const releasing = gate();
    const released = gate();
    managedScenario = async () => ({ enabled: true, baseUrl: 'https://managed.fixture', routeModel: 'plan/managed', authToken: 'fixture' });
    releaseScenario = async () => { releasing.resolve(); await released.promise; };
    scenario = () => Object.assign((async function* () { yield { type: 'result', subtype: 'success' }; streamed.resolve(); await teardown.promise; })(), { close() {} });
    const run = queryClaudeSDK('fixture', { cwd, sessionId: 'managed-release-fixture', model: 'hiroute' }, { userId: 42, send: (frame: NormalizedMessage) => frames.push(frame) }, context);
    await streamed.promise;
    assert.deepEqual(managedReleases, []);
    teardown.resolve();
    await releasing.promise;
    assert.equal(frames.some(frame => frame.kind === 'complete'), false);
    released.resolve();
    await run;
    assert.deepEqual(managedReleases, [42]);
    assert.equal(frames.find(frame => frame.kind === 'complete')?.success, true);
  });
});

test('SDK failure releases the acquired gateway before publishing failure', { timeout: 5000 }, async () => {
  await fixture(async (cwd, context, frames) => {
    managedScenario = async () => ({ enabled: true, baseUrl: 'https://managed.fixture', routeModel: 'plan/managed', authToken: 'fixture' });
    scenario = () => { throw new Error('SDK fixture failed'); };
    await assert.rejects(queryClaudeSDK('fixture', { cwd, sessionId: 'managed-sdk-error-fixture', model: 'hiroute' }, { userId: 42, send: (frame: NormalizedMessage) => {
      if (frame.kind === 'error' || frame.kind === 'complete') assert.deepEqual(managedReleases, [42]);
      frames.push(frame);
    } }, context), /SDK fixture failed/);
    assert.deepEqual(managedReleases, [42]);
    assert.equal(frames.find(frame => frame.kind === 'complete')?.success, false);
  });
});

test('late successful preparation after cancellation releases its acquired gateway without launching SDK', { timeout: 5000 }, async () => {
  await fixture(async (cwd, context) => {
    const entered = gate();
    const prepared = gate();
    managedScenario = async () => { entered.resolve(); await prepared.promise; return { enabled: true, baseUrl: 'https://managed.fixture', routeModel: 'plan/managed', authToken: 'fixture' }; };
    const run = queryClaudeSDK('fixture', { cwd, sessionId: 'managed-late-fixture', model: 'hiroute' }, { userId: 42, send() {} }, context);
    await entered.promise;
    const stop = abortClaudeSDKSession('managed-late-fixture');
    prepared.resolve();
    assert.equal(await stop, true);
    await run;
    assert.equal(queries, 0);
    assert.deepEqual(managedReleases, [42]);
  });
});

test('ordinary Claude selection applies only the saved active connection', { timeout: 5000 }, async () => {
  await fixture(async (cwd, context) => {
    managedScenario = async () => { throw new Error('Ordinary runs must not prepare HiRoute'); };
    const saved = { id: 'saved-fixture', name: 'Fixture', baseUrl: 'https://fixture.test', apiKey: 'fixture-key', model: 'saved-fixture-model', authType: 'api_key' as const };
    mock.method(claudeConnectionsService, 'getActiveConnection', () => saved);
    const active = mock.method(claudeConnectionsService, 'applyToOptions', (options: Options, connection: unknown) => {
      assert.equal(connection, saved);
      assert.ok(options.abortController);
      options.model = 'saved-fixture-model';
    });
    scenario = input => {
      assert.equal(input.options?.model, 'saved-fixture-model');
      return Object.assign((async function* () { yield { type: 'result', subtype: 'success' }; })(), { close() {} });
    };
    await queryClaudeSDK('fixture', { cwd, sessionId: 'saved-fixture', model: 'sonnet' }, { userId: 42, send() {} }, context);
    assert.equal(active.mock.callCount(), 1);
    assert.equal(queries, 1);
  });
});

test('Claude fixes the account before asynchronous preparation and releases it before the next turn', { timeout: 5000 }, async () => {
  await fixture(async (cwd, context) => {
    const firstPreparation = gate();
    const captured = gate();
    context.resolveResumeModel = async () => { captured.resolve(); await firstPreparation.promise; return 'sonnet'; };
    const configDirs: string[] = [];
    scenario = input => {
      configDirs.push(input.options!.env!.CLAUDE_CONFIG_DIR!);
      return Object.assign((async function* () { yield { type: 'result', subtype: 'success' }; })(), { close() {} });
    };
    const first = queryClaudeSDK('fixture', { cwd, sessionId: 'identity-fixture' }, { userId: 42, send() {} }, context);
    await captured.promise;
    selectedAccount = 'profile-b';
    assert.equal(accountReleases, 0);
    firstPreparation.resolve();
    await first;
    assert.equal(accountReleases, 1);
    await queryClaudeSDK('fixture', { cwd, sessionId: 'identity-fixture' }, { userId: 42, send() {} }, context);
    assert.deepEqual(configDirs, [path.join(cwd, 'profile-a'), path.join(cwd, 'profile-b')]);
    assert.equal(accountReleases, 2);
    assert.deepEqual(historyCalls.map(call => call.accountId), ['profile-a', 'profile-a', 'profile-b', 'profile-b']);
    assert.deepEqual(historyCalls.filter(call => call.options.cwd !== undefined).map(call => call.options.cwd), [cwd, cwd]);
  });
});

test('Claude cannot fall back to global credentials for a user with no subscription scope', async () => {
  await fixture(async (cwd, context) => {
    captureAccount = () => null;
    const frames: NormalizedMessage[] = [];
    await assert.rejects(queryClaudeSDK('fixture', { cwd, sessionId: 'unscoped-fixture' }, { userId: 42, send: (frame: NormalizedMessage) => frames.push(frame) }, context), { code: 'CLAUDE_ACCOUNT_REQUIRED' });
    assert.equal(queries, 0);
    assert.equal(historyCalls.length, 0);
    assert.ok(frames.some(frame => frame.kind === 'error'));
  });
});

test('Claude result stays nonterminal until teardown and permits the next owner at complete', { timeout: 5000 }, async () => {
  await fixture(async (cwd, context, frames) => {
    const finished = gate();
    const result = gate();
    scenario = input => {
      const hold = finished;
      void (async () => { for await (const _message of input.prompt as AsyncIterable<unknown>) { /* consume held stdin */ } })();
      return Object.assign((async function* () { yield { type: 'result', subtype: 'success' }; await hold.promise; })(), { close: () => hold.resolve() });
    };
    let next: Promise<void> | undefined;
    const writer = { send: (frame: NormalizedMessage) => {
      frames.push(frame);
      if (frame.kind === 'status' && frame.text === 'workspace_finalizing') result.resolve();
      if (frame.kind === 'complete' && !next) next = queryClaudeSDK('next', { cwd, sessionId: 'finalize-fixture' }, { send() {} }, context);
    } };
    const first = queryClaudeSDK('first', { cwd, sessionId: 'finalize-fixture' }, writer, context);
    await result.promise;
    assert.equal(frames.some(frame => frame.kind === 'complete'), false);
    finished.resolve();
    await first;
    await next;
    assert.equal(queries, 2);
    assert.equal(frames.filter(frame => frame.kind === 'complete').length, 1);
    assert.equal(frames.find(frame => frame.kind === 'complete')?.exitCode, 0);
  });
});

test('initializing Claude can be stopped before the SDK or model is launched', { timeout: 5000 }, async () => {
  await fixture(async (cwd, context, frames) => {
    const entered = gate();
    const resolved = gate();
    context.resolveResumeModel = async () => { entered.resolve(); await resolved.promise; return 'sonnet'; };
    scenario = () => { throw new Error('SDK must not launch'); };
    const run = queryClaudeSDK('fixture', { cwd, sessionId: 'initializing-fixture' }, { send: (frame: NormalizedMessage) => frames.push(frame) }, context);
    await entered.promise;
    let confirmed = false;
    const stop = abortClaudeSDKSession('initializing-fixture').then(success => { confirmed = success; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(confirmed, false);
    resolved.resolve();
    await Promise.all([run, stop]);
    assert.equal(confirmed, true);
    assert.equal(queries, 0);
    assert.equal(frames.some(frame => frame.kind === 'complete'), false);
  });
});

test('true background work retains held stdin after result and releases it after its follow-up', { timeout: 5000 }, async () => {
  await fixture(async (cwd, context, frames) => {
    const background = gate();
    const followup = gate();
    const promptDone = gate();
    let stdinEnded = false;
    scenario = input => {
      void (async () => { for await (const _message of input.prompt as AsyncIterable<unknown>) { /* consume held stdin */ } stdinEnded = true; promptDone.resolve(); })();
      return Object.assign((async function* () {
        yield { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { run_in_background: true } }] } };
        yield { type: 'result', subtype: 'success' };
        await followup.promise;
        yield { type: 'result', subtype: 'success' };
        await promptDone.promise;
      })(), { close: () => promptDone.resolve() });
    };
    const run = queryClaudeSDK('fixture', { cwd, sessionId: 'background-fixture' }, { send: (frame: NormalizedMessage) => {
      frames.push(frame);
      if (frame.text === 'background_work') background.resolve();
    } }, context);
    await background.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(stdinEnded, false);
    assert.equal(frames.some(frame => frame.kind === 'complete'), false);
    followup.resolve();
    await run;
    assert.equal(stdinEnded, true);
    assert.equal(frames.filter(frame => frame.kind === 'complete').length, 1);
    assert.equal(frames.find(frame => frame.kind === 'complete')?.success, true);
  });
});
