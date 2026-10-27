import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { useWorkspaceResolution } from '@/modules/project-workspace/hooks/useWorkspaceResolution';
import { api } from '@/shared/api';
import { clearAuthToken, startAuthSession } from '@/shared/authToken';
import type { WorkspaceDescriptor } from '@/shared/types';

const workspace: WorkspaceDescriptor = {
  projectId: 'local', workspaceId: 'local-one', generation: 'gen-one', kind: 'cloudReplica', sourceMode: 'ssh', rootPath: '/meta/local', sourceRoot: '/meta/local',
  requestedMode: 'shared', effectiveMode: 'shared', phase: 'idle', publicationState: 'unpublished', connectionState: 'online',
  capabilities: { read: true, write: true, git: true, shell: true, preview: false, integrate: false, cloudExecutionIndependentOfDesktop: false },
};
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => { startAuthSession('initial.payload.signature'); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

test('no project is idle rather than an indefinite pending workspace', () => {
  const resolve = vi.spyOn(api.workspaces, 'resolve');
  const { result } = renderHook(() => useWorkspaceResolution());
  expect(result.current.status).toBe('idle');
  expect(result.current.loading).toBe(false);
  expect(result.current.resolution).toBeNull();
  expect(resolve).not.toHaveBeenCalled();
});

test('refresh explicitly revokes old write capability until a current response completes', async () => {
  const delayed = deferred<Response>();
  vi.spyOn(api.workspaces, 'resolve').mockResolvedValueOnce(Response.json({ cloudReplica: workspace, session: null })).mockReturnValueOnce(delayed.promise);
  const { result } = renderHook(() => useWorkspaceResolution('local'));
  await waitFor(() => expect(result.current.status).toBe('ready'));
  expect(result.current.resolution?.cloudReplica.capabilities.write).toBe(true);
  act(() => result.current.refresh());
  expect(result.current.status).toBe('pending');
  expect(result.current.resolution).toBeNull();
  await act(async () => { delayed.resolve(Response.json({ error: 'connection unavailable' }, { status: 503 })); });
  expect(result.current.status).toBe('error');
  expect(result.current.error).toBe('connection unavailable');
  expect(result.current.resolution).toBeNull();
});

test('late account A resolution cannot grant writes to account B selecting the same project id', async () => {
  const old = deferred<Response>();
  const fresh = deferred<Response>();
  vi.spyOn(api.workspaces, 'resolve').mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
  const { result, rerender } = renderHook(() => useWorkspaceResolution('local'));
  act(() => { clearAuthToken(); startAuthSession('new.payload.signature'); });
  rerender();
  await act(async () => { old.resolve(Response.json({ cloudReplica: workspace, session: null })); });
  expect(result.current.resolution).toBeNull();
  expect(result.current.status).toBe('pending');
  await act(async () => { fresh.resolve(Response.json({ cloudReplica: { ...workspace, phase: 'running', capabilities: { ...workspace.capabilities, write: false } }, session: null })); });
  expect(result.current.status).toBe('ready');
  expect(result.current.resolution?.cloudReplica.capabilities.write).toBe(false);
});
