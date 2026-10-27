import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { useCodeEditorDocument } from '@/modules/code-editor/hooks/useCodeEditorDocument';
import { WorkspaceScopeContext } from '@/shared/context/WorkspaceScopeContext';
import type { CodeEditorFile, WorkspaceDescriptor } from '@/shared/types';

const workspace: WorkspaceDescriptor = {
  projectId: 'project', workspaceId: 'local', generation: 'one', kind: 'cloudReplica', sourceMode: 'ssh',
  rootPath: '/meta/project', sourceRoot: '/meta/project', requestedMode: 'shared', effectiveMode: 'shared',
  phase: 'running', publicationState: 'integrated', connectionState: 'online',
  capabilities: { read: true, write: false, git: true, shell: true, preview: false, integrate: false, cloudExecutionIndependentOfDesktop: false },
};
const file: CodeEditorFile = { projectId: 'project', name: 'a.ts', path: '/meta/project/a.ts', workspace };
let current: WorkspaceDescriptor;
const wrapper = ({ children }: { children: ReactNode }) => <WorkspaceScopeContext.Provider value={current}>{children}</WorkspaceScopeContext.Provider>;
const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  current = workspace;
  vi.stubGlobal('mygo', undefined);
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset().mockImplementation(async (_url, options) => Response.json(options?.method === 'PUT' ? { hash: 'saved' } : { content: 'original', hash: 'loaded' }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test('an editor opened during a running Git task can save after idle without losing edits or its read hash', async () => {
  const view = renderHook(() => useCodeEditorDocument({ file }), { wrapper });
  await waitFor(() => expect(view.result.current.loading).toBe(false));
  act(() => view.result.current.setContent('unsaved edit'));
  await act(async () => { await view.result.current.handleSave(); });
  expect(view.result.current.saveError).toContain('暂不允许');
  expect(fetchMock).toHaveBeenCalledOnce();
  current = { ...workspace, phase: 'idle', capabilities: { ...workspace.capabilities, write: true } };
  view.rerender();
  expect(view.result.current.content).toBe('unsaved edit');
  expect(view.result.current.loading).toBe(false);
  expect(fetchMock).toHaveBeenCalledOnce();
  await act(async () => { await view.result.current.handleSave(); });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({ content: 'unsaved edit', expectedHash: 'loaded', workspaceId: 'local', generation: 'one' });
  expect(view.result.current.saveSuccess).toBe(true);
  current = { ...workspace };
  view.rerender();
  act(() => view.result.current.setContent('keep after revocation'));
  await act(async () => { await view.result.current.handleSave(); });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(view.result.current.content).toBe('keep after revocation');
  expect(view.result.current.saveSuccess).toBe(false);
  expect(view.result.current.saveError).toContain('暂不允许');
});

test.each([
  { generation: 'two' }, { projectId: 'other' }, { workspaceId: 'other' },
  { kind: 'session' as const, sessionId: 'session' }, { sourceMode: 'cloud' as const },
])('another active identity cannot grant writes to the pinned read-only document: %j', async change => {
  const view = renderHook(() => useCodeEditorDocument({ file }), { wrapper });
  await waitFor(() => expect(view.result.current.loading).toBe(false));
  act(() => view.result.current.setContent('retained'));
  current = { ...workspace, ...change, phase: 'idle', capabilities: { ...workspace.capabilities, write: true } };
  view.rerender();
  await act(async () => { await view.result.current.handleSave(); });
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(view.result.current.content).toBe('retained');
  expect(view.result.current.saveError).toContain('暂不允许');
});

test('switching the main view does not retarget an already writable session editor', async () => {
  const session = { ...workspace, kind: 'session' as const, sessionId: 'session', workspaceId: 'local:session', capabilities: { ...workspace.capabilities, write: true } };
  const view = renderHook(() => useCodeEditorDocument({ file: { ...file, workspace: session } }), { wrapper });
  await waitFor(() => expect(view.result.current.loading).toBe(false));
  act(() => view.result.current.setContent('session edit'));
  await act(async () => { await view.result.current.handleSave(); });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({ content: 'session edit', workspaceId: 'local:session', generation: 'one', expectedHash: 'loaded' });
  expect(view.result.current.content).toBe('session edit');
});
