import assert from 'node:assert/strict';
import test from 'node:test';

import { AppError } from '@/shared/index.js';
import type { WorkspaceDescriptor, WorkspaceResolution } from '@/shared/index.js';

import { createWorkspaceCatalog } from '../workspace-catalog.service.js';

function descriptor(kind: 'cloudReplica' | 'session', sessionId?: string): WorkspaceDescriptor {
  return {
    workspaceId: sessionId ? `workspace-${sessionId}` : 'replica-project', projectId: 'project',
    generation: 'generation-1', kind, ...(sessionId ? { sessionId } : {}),
    rootPath: sessionId ? `/sessions/${sessionId}` : '/repo', sourceRoot: '/repo',
    requestedMode: kind === 'session' ? 'isolated' : 'shared', effectiveMode: kind === 'session' ? 'isolated' : 'shared',
    phase: 'idle', publicationState: 'unpublished',
    capabilities: { read: true, write: true, git: true, shell: true, preview: true, integrate: kind === 'session', cloudExecutionIndependentOfDesktop: true },
  };
}

function setup() {
  const rows = new Map([
    ['app-session', { session_id: 'app-session', project_path: '/repo/./', workspace_mode: 'isolated' as const }],
    ['pending-session', { session_id: 'pending-session', project_path: '/repo', workspace_mode: 'isolated' as const }],
    ['foreign-session', { session_id: 'foreign-session', project_path: '/other', workspace_mode: 'isolated' as const }],
  ]);
  const session = descriptor('session', 'app-session');
  const cloudReplica = descriptor('cloudReplica');
  const described: string[] = [];
  const validated: WorkspaceDescriptor[] = [];
  let bound = true;
  let failValidation = false;
  const catalog = createWorkspaceCatalog({
    getProjectPathById: id => id === 'project' ? '/repo/' : null,
    getSessionById: id => rows.get(id) ?? null,
    getSessionsByProjectPath: () => [...rows.values()].filter(row => row.project_path !== '/other'),
    describeWorkspaceSelection: input => {
      described.push(input.sessionId ?? 'main');
      return { cloudReplica, session: input.sessionId === 'app-session' ? session : null };
    },
    assertWorkspaceDescriptor: selected => {
      validated.push(selected);
      if (failValidation) throw new AppError('replaced', { code: 'WORKSPACE_GENERATION_CHANGED', statusCode: 409 });
    },
    isWorkspaceBound: () => bound,
  });
  return { catalog, session, cloudReplica, rows, described, validated, setBound(value: boolean) { bound = value; }, setInvalid() { failValidation = true; } };
}

function hasCode(code: string) {
  return (error: unknown) => error instanceof AppError && error.code === code;
}

test('catalog resolves app-owned sessions after normalized path verification and allows a pending descriptor', () => {
  const state = setup();
  assert.equal(state.catalog.resolve('project', 'app-session').session?.rootPath, '/sessions/app-session');
  assert.deepEqual(state.catalog.resolve('project', 'pending-session'), { cloudReplica: state.cloudReplica, session: null });
  assert.deepEqual(state.described, ['app-session', 'pending-session']);
});

test('catalog rejects unknown provider ids and cross-project sessions before bridge lookup', () => {
  const state = setup();
  assert.throws(() => state.catalog.resolve('project', 'provider-session'), hasCode('WORKSPACE_SESSION_NOT_FOUND'));
  assert.throws(() => state.catalog.resolve('project', 'foreign-session'), hasCode('WORKSPACE_SELECTION_MISMATCH'));
  assert.throws(() => state.catalog.resolve('missing'), hasCode('PROJECT_NOT_FOUND'));
  assert.deepEqual(state.described, []);
});

test('bound projects require selectors while unbound OSS projects retain main-root compatibility', () => {
  const state = setup();
  assert.throws(() => state.catalog.resolveSelectedWorkspace('project'), hasCode('WORKSPACE_SELECTOR_REQUIRED'));
  state.setBound(false);
  assert.equal(state.catalog.resolveSelectedWorkspace('project').rootPath, '/repo');
  assert.deepEqual(state.validated, [state.cloudReplica]);
});

test('session selectors never fall back to main, even when the client supplies its id', () => {
  const state = setup();
  assert.throws(() => state.catalog.resolveSelectedWorkspace('project', {
    workspaceId: state.cloudReplica.workspaceId, generation: 'generation-1', sessionId: 'pending-session',
  }), hasCode('WORKSPACE_SESSION_NOT_READY'));
  assert.throws(() => state.catalog.resolveSelectedWorkspace('project', {
    workspaceId: state.cloudReplica.workspaceId, generation: 'generation-1', sessionId: 'app-session',
  }), hasCode('WORKSPACE_SELECTION_MISMATCH'));
});

test('opaque workspace ids can identify durable project sessions without a client session id', () => {
  const state = setup();
  const selected = state.catalog.resolveSelectedWorkspace('project', { workspaceId: 'workspace-app-session', generation: 'generation-1' });
  assert.equal(selected, state.session);
  assert.ok(state.described.includes('app-session'));
  assert.ok(state.described.includes('pending-session'));
  assert.deepEqual(state.validated, [state.session]);
});

test('a mismatching workspace or generation cannot pass descriptor validation', () => {
  const state = setup();
  assert.throws(() => state.catalog.resolveSelectedWorkspace('project', { workspaceId: 'workspace-foreign-session', generation: 'generation-1' }), hasCode('WORKSPACE_SELECTION_MISMATCH'));
  assert.throws(() => state.catalog.resolveSelectedWorkspace('project', { workspaceId: 'replica-project', generation: 'old-generation' }), hasCode('WORKSPACE_GENERATION_CHANGED'));
  assert.deepEqual(state.validated, []);
  state.setInvalid();
  assert.throws(() => state.catalog.resolveSelectedWorkspace('project', { workspaceId: 'replica-project', generation: 'generation-1' }), hasCode('WORKSPACE_GENERATION_CHANGED'));
});

test('catalog checks the bridge descriptor against the durable project owner', () => {
  const state = setup();
  state.session.sourceRoot = '/other';
  assert.throws(() => state.catalog.resolve('project', 'app-session'), hasCode('WORKSPACE_SELECTION_MISMATCH'));
  state.session.sourceRoot = '/repo';
  state.session.sessionId = 'other-app-session';
  assert.throws(() => state.catalog.resolve('project', 'app-session'), hasCode('WORKSPACE_SELECTION_MISMATCH'));
});

test('malformed explicit selectors cannot use the unbound compatibility branch', () => {
  const state = setup();
  state.setBound(false);
  assert.throws(() => state.catalog.resolveSelectedWorkspace('project', { workspaceId: '', generation: 'generation-1' }), hasCode('INVALID_WORKSPACE_SELECTOR'));
  assert.throws(() => state.catalog.resolveSelectedWorkspace('project', { workspaceId: 'replica-project', generation: 'generation-1', sessionId: '' }), hasCode('INVALID_WORKSPACE_SELECTOR'));
});

test('catalog resolution returns both descriptor identities without materializing a session', () => {
  const state = setup();
  const resolution: WorkspaceResolution = state.catalog.resolve('project');
  assert.equal(resolution.cloudReplica, state.cloudReplica);
  assert.equal(resolution.session, null);
  assert.deepEqual(state.described, ['main']);
});
