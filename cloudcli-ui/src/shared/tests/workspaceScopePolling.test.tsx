import { act, cleanup, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { WorkspaceScopeContext, useWorkspaceApi, useWorkspaceGitApi } from '@/shared/context/WorkspaceScopeContext';
import type { WorkspaceDescriptor } from '@/shared/types';

const workspace: WorkspaceDescriptor = {
  projectId: 'project', workspaceId: 'local', generation: 'one', kind: 'cloudReplica', sourceMode: 'ssh',
  rootPath: '/meta/project', sourceRoot: '/meta/project', requestedMode: 'shared', effectiveMode: 'shared',
  phase: 'idle', publicationState: 'integrated', connectionState: 'offline',
  capabilities: { read: true, write: true, git: true, shell: true, preview: false, integrate: false, cloudExecutionIndependentOfDesktop: false },
};
let current: WorkspaceDescriptor | null | undefined;
const wrapper = ({ children }: { children: ReactNode }) => <WorkspaceScopeContext.Provider value={current}>{children}</WorkspaceScopeContext.Provider>;
const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  current = workspace;
  vi.stubGlobal('mygo', undefined);
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset().mockImplementation(async () => Response.json({}));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test('status-only polls preserve scoped requests while write revocation replaces the write guard', async () => {
  const view = renderHook(() => ({ api: useWorkspaceApi(), git: useWorkspaceGitApi() }), { wrapper });
  const initial = view.result.current;
  current = { ...workspace, phase: 'running', connectionState: 'online', displayPath: 'C:\\work', capabilities: { ...workspace.capabilities } };
  view.rerender();
  expect(view.result.current.api).toBe(initial.api);
  expect(view.result.current.git).toBe(initial.git);
  current = { ...current, capabilities: { ...current.capabilities, write: false } };
  view.rerender();
  expect(view.result.current.api).not.toBe(initial.api);
  expect(view.result.current.git).toBe(initial.git);
  await expect(view.result.current.api.saveFile('project', 'a.ts', 'new', 'hash')).rejects.toThrow('暂不允许');
  expect(fetchMock).not.toHaveBeenCalled();
  await view.result.current.api.readFile('project', 'a.ts');
  expect(fetchMock).toHaveBeenCalledOnce();
  current = { ...current, generation: 'two' };
  view.rerender();
  expect(view.result.current.git).not.toBe(initial.git);
  await view.result.current.git.status('project');
  expect(String(fetchMock.mock.calls[1][0])).toContain('generation=two');
});

test('unavailable and revoked Git scopes never reuse a permissive API', async () => {
  const view = renderHook(() => ({ api: useWorkspaceApi(), git: useWorkspaceGitApi() }), { wrapper });
  current = { ...workspace, capabilities: { ...workspace.capabilities, git: false, read: false } };
  view.rerender();
  await expect(view.result.current.git.status('project')).rejects.toThrow('暂不允许');
  await expect(view.result.current.api.readFile('project', 'a.ts')).rejects.toThrow('暂不允许');
  current = null;
  view.rerender();
  await expect(view.result.current.api.readFile('project', 'a.ts')).rejects.toThrow('尚未准备好');
  expect(fetchMock).not.toHaveBeenCalled();
  await act(async () => { current = undefined; view.rerender(); });
  await view.result.current.api.readFile('project', 'a.ts');
  expect(String(fetchMock.mock.calls[0][0])).not.toContain('workspaceId=');
});
