import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { WorkspaceScopeBar } from '@/modules/project-workspace/WorkspaceScopeBar';
import type { WorkspaceDescriptor } from '@/shared/types';

const requests = vi.hoisted(() => ({ previewIntegration: vi.fn(), applyIntegration: vi.fn(), recoverIntegration: vi.fn() }));
vi.mock('@/shared/api', async (original) => ({ ...await original<Record<string, unknown>>(), api: { workspaces: requests } }));
const session: WorkspaceDescriptor = {
  workspaceId: 'session:one', generation: 'one', projectId: 'project', kind: 'session', sessionId: 'one',
  rootPath: '/isolated/one', sourceRoot: '/cloud/project', requestedMode: 'isolated', effectiveMode: 'isolated',
  phase: 'idle', publicationState: 'unpublished',
  capabilities: { read: true, write: true, git: true, shell: true, preview: true, integrate: true, cloudExecutionIndependentOfDesktop: true },
};
const preview = { baselineId: 'baseline', previewId: 'preview', sourceRevision: 'source', targetRevision: 'target', checkpointRevision: 'checkpoint', changes: [{ path: 'a.ts', kind: 'modify' }], conflicts: [], canApply: true };
const props = (value: WorkspaceDescriptor | null = session) => ({ selectionKey: 'project/one', workspace: value, session: value, kind: 'session' as const, hasSession: true, loading: false, error: null, onSelect: vi.fn(), onRefresh: vi.fn() });
const error = (code: string) => Response.json({ error: { code, message: code } }, { status: 409 });
beforeEach(() => {
  vi.resetAllMocks(); sessionStorage.clear();
  requests.previewIntegration.mockImplementation(async () => Response.json(preview));
});
afterEach(cleanup);
async function showReview() {
  fireEvent.click(screen.getByRole('button', { name: '预览并集成到云端' }));
  await screen.findByRole('button', { name: '确认集成' });
}
async function unknownApply() {
  requests.applyIntegration.mockRejectedValueOnce(new Error('connection lost'));
  await showReview();
  fireEvent.click(screen.getByRole('button', { name: '确认集成' }));
  await screen.findByRole('button', { name: '重试同一集成操作' });
}

test('unknown apply keeps its original selector and receipt across outage, reload, and generation changes', async () => {
  const view = render(<WorkspaceScopeBar {...props()} />);
  await unknownApply();
  const original = requests.applyIntegration.mock.calls[0][0];
  view.rerender(<WorkspaceScopeBar {...props({ ...session, phase: 'recovery', capabilities: { ...session.capabilities, integrate: false } })} />);
  expect((screen.getByRole('button', { name: '重试同一集成操作' }) as HTMLButtonElement).disabled).toBe(false);
  expect((screen.getByRole('button', { name: '检查并恢复集成' }) as HTMLButtonElement).disabled).toBe(false);
  expect((screen.getByRole('button', { name: '预览并集成到云端' }) as HTMLButtonElement).disabled).toBe(true);
  view.rerender(<WorkspaceScopeBar {...props(null)} />);
  expect((screen.getByRole('button', { name: '取消' }) as HTMLButtonElement).disabled).toBe(true);
  view.unmount();
  render(<WorkspaceScopeBar {...props({ ...session, generation: 'new-generation', workspaceId: 'replacement' })} />);
  requests.applyIntegration.mockImplementationOnce(async body => Response.json({ status: 'applied', operationId: body.operationId, changedPaths: ['a.ts'] }));
  fireEvent.click(screen.getByRole('button', { name: '重试同一集成操作' }));
  await waitFor(() => expect(screen.queryByRole('region', { name: '集成预览' })).toBeNull());
  expect(requests.applyIntegration.mock.calls[1][0]).toEqual(original);
  expect(requests.previewIntegration).toHaveBeenCalledOnce();
  expect(sessionStorage.length).toBe(0);
});

test('recover idle, blocked, or another receipt never discard an unknown operation', async () => {
  render(<WorkspaceScopeBar {...props()} />);
  await unknownApply();
  const original = requests.applyIntegration.mock.calls[0][0];
  for (const result of [{ status: 'idle' }, { status: 'blocked', conflicts: [{ path: '.git', reason: 'target-git-changed' }] }, { status: 'applied', operationId: 'other-operation' }]) {
    requests.recoverIntegration.mockResolvedValueOnce(Response.json(result));
    fireEvent.click(screen.getByRole('button', { name: '检查并恢复集成' }));
    await screen.findByRole('button', { name: '检查并恢复集成' });
    expect(screen.getByRole('button', { name: '重试同一集成操作' })).toBeDefined();
    expect(sessionStorage.length).toBe(1);
  }
  expect(requests.recoverIntegration.mock.calls[0][0]).toEqual({ projectId: original.projectId, workspaceId: original.workspaceId, generation: original.generation });
  requests.recoverIntegration.mockResolvedValueOnce(Response.json({ status: 'applied', operationId: original.operationId, changedPaths: ['a.ts'] }));
  fireEvent.click(screen.getByRole('button', { name: '检查并恢复集成' }));
  await waitFor(() => expect(sessionStorage.length).toBe(0));
});

test('a definite first prewrite refusal permits a fresh preview but the same error after unknown does not', async () => {
  render(<WorkspaceScopeBar {...props()} />);
  await showReview();
  requests.applyIntegration.mockResolvedValueOnce(error('WORKSPACE_CHANGES_STALE'));
  fireEvent.click(screen.getByRole('button', { name: '确认集成' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: '确认集成' })).toBeNull());
  expect(sessionStorage.length).toBe(0);
  await unknownApply();
  requests.applyIntegration.mockResolvedValueOnce(error('WORKSPACE_CHANGES_STALE'));
  fireEvent.click(screen.getByRole('button', { name: '重试同一集成操作' }));
  await screen.findByRole('button', { name: '重试同一集成操作' });
  expect(sessionStorage.length).toBe(1);
  expect(requests.applyIntegration.mock.calls[2][0]).toEqual(requests.applyIntegration.mock.calls[1][0]);
});

test('preview respects server canApply and displays open conflict reason strings', async () => {
  requests.previewIntegration.mockResolvedValueOnce(Response.json({ ...preview, canApply: false, conflicts: [{ path: '.', reason: 'future-protected-reason', base: null, source: null, target: null }] }));
  render(<WorkspaceScopeBar {...props()} />);
  await showReview();
  expect((screen.getByRole('button', { name: '确认集成' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole('alert').textContent).toContain('future-protected-reason');
  fireEvent.click(screen.getByRole('button', { name: '确认集成' }));
  expect(requests.applyIntegration).not.toHaveBeenCalled();
});
