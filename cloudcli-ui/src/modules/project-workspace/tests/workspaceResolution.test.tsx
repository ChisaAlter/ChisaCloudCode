import { Buffer } from 'node:buffer';
import { createHmac } from 'node:crypto';

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { useWorkspaceResolution } from '@/modules/project-workspace/hooks/useWorkspaceResolution';
import { api } from '@/shared/api';
import { acknowledgeAuthSession, clearAuthToken, initializeAuthSession, startAuthSession } from '@/shared/authToken';
import type { WorkspaceDescriptor } from '@/shared/types';

const workspace: WorkspaceDescriptor = {
  projectId: 'local', workspaceId: 'local-one', generation: 'gen-one', kind: 'cloudReplica', sourceMode: 'ssh', rootPath: '/meta/local', sourceRoot: '/meta/local',
  requestedMode: 'shared', effectiveMode: 'shared', phase: 'idle', publicationState: 'unpublished', connectionState: 'online',
  capabilities: { read: true, write: true, git: true, shell: true, preview: false, integrate: false, cloudExecutionIndependentOfDesktop: false },
};
const recovery: WorkspaceDescriptor = { ...workspace, phase: 'recovery', connectionState: 'recovery', capabilities: { ...workspace.capabilities, write: false } };
const resolved = (value: WorkspaceDescriptor = recovery) => Response.json({ cloudReplica: value, session: null });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function flush() { await act(async () => { for (let turn = 0; turn < 12; ++turn) await Promise.resolve(); }); }
async function authenticateWorkspaceAccount(userId = 'workspace-account-a') {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const issuedAt = Math.floor(Date.now() / 1000);
  const unsigned = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ userId, iat: issuedAt, exp: issuedAt + 3600 })}`;
  const token = `${unsigned}.${createHmac('sha256', 'workspace-resolution-test-key').update(unsigned).digest('base64url')}`;
  await clearAuthToken(await initializeAuthSession());
  const session = await startAuthSession(token, await initializeAuthSession());
  expect(session, 'workspace fixture login must commit before rendering').not.toBeNull();
  if (!session) throw new Error('Workspace fixture login did not commit');
  acknowledgeAuthSession(session);
}

beforeEach(async () => { await authenticateWorkspaceAccount(); });
afterEach(async () => { cleanup(); await clearAuthToken(); vi.restoreAllMocks(); vi.useRealTimers(); });

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
  await act(async () => { await authenticateWorkspaceAccount('workspace-account-b'); });
  rerender();
  await act(async () => { old.resolve(Response.json({ cloudReplica: workspace, session: null })); });
  expect(result.current.resolution).toBeNull();
  expect(result.current.status).toBe('pending');
  await act(async () => { fresh.resolve(Response.json({ cloudReplica: { ...workspace, phase: 'running', capabilities: { ...workspace.capabilities, write: false } }, session: null })); });
  expect(result.current.status).toBe('ready');
  expect(result.current.resolution?.cloudReplica.capabilities.write).toBe(false);
});

test('a terminal SSH task is automatically confirmed and re-resolved before granting writes', async () => {
  const resolve = vi.spyOn(api.workspaces, 'resolve').mockResolvedValueOnce(resolved()).mockResolvedValueOnce(resolved(workspace));
  const recover = vi.spyOn(api.sshWorkspaces, 'recover').mockResolvedValueOnce(Response.json({ status: 'idle' }));
  const { result } = renderHook(() => useWorkspaceResolution('local'));
  await waitFor(() => expect(result.current.resolution?.cloudReplica.capabilities.write).toBe(true));
  expect(result.current.error).toBeNull();
  expect(resolve).toHaveBeenCalledTimes(2);
  expect(recover).toHaveBeenCalledExactlyOnceWith({ projectId: 'local', generation: 'gen-one' }, { signal: expect.any(AbortSignal) });
});

test('running recovery retries on the existing poll and rapid refreshes never cancel or loop', async () => {
  vi.useFakeTimers();
  let terminal = false;
  vi.spyOn(api.workspaces, 'resolve').mockImplementation(async () => resolved(terminal ? workspace : recovery));
  const recover = vi.spyOn(api.sshWorkspaces, 'recover').mockResolvedValueOnce(Response.json({ status: 'running' })).mockImplementationOnce(async () => { terminal = true; return Response.json({ status: 'idle' }); });
  const { result } = renderHook(() => useWorkspaceResolution('local'));
  await flush();
  expect(result.current.resolution?.cloudReplica.phase).toBe('recovery');
  act(() => { result.current.refresh(); result.current.refresh(); window.dispatchEvent(new Event('focus')); });
  await flush();
  expect(recover).toHaveBeenCalledOnce();
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  await flush();
  expect(recover).toHaveBeenCalledTimes(2);
  expect(result.current.resolution?.cloudReplica.capabilities.write).toBe(true);
  expect(recover.mock.calls.every(([body]) => !body.cancel)).toBe(true);
});

test('recovery errors retain the gate and specific reason, then retry with bounded poll backoff', async () => {
  vi.useFakeTimers();
  vi.spyOn(api.workspaces, 'resolve').mockImplementation(async () => resolved());
  const recover = vi.spyOn(api.sshWorkspaces, 'recover').mockResolvedValueOnce(Response.json({ error: { code: 'SSH_RECEIPT_MISSING', message: '缺少原任务回执，暂不能确认' } }, { status: 409 })).mockResolvedValueOnce(Response.json({ status: 'running' }));
  const { result } = renderHook(() => useWorkspaceResolution('local'));
  await flush();
  expect(result.current.resolution?.cloudReplica.phase).toBe('recovery');
  expect(result.current.resolution?.cloudReplica.capabilities.write).toBe(false);
  expect(result.current.error).toBe('缺少原任务回执，暂不能确认');
  act(() => result.current.refresh());
  await flush();
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(recover).toHaveBeenCalledOnce();
  expect(result.current.error).toBe('缺少原任务回执，暂不能确认');
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  await flush();
  expect(recover).toHaveBeenCalledTimes(2);
  expect(result.current.error).toBeNull();
  expect(result.current.resolution?.cloudReplica.capabilities.write).toBe(false);
});

test('replacement identity after recovery cannot inherit a completed task permission', async () => {
  vi.spyOn(api.workspaces, 'resolve').mockResolvedValueOnce(resolved()).mockResolvedValueOnce(resolved({ ...workspace, generation: 'new-generation' }));
  vi.spyOn(api.sshWorkspaces, 'recover').mockResolvedValueOnce(Response.json({ status: 'idle' }));
  const { result } = renderHook(() => useWorkspaceResolution('local'));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.error).toContain('本地工作区已变化');
  expect(result.current.resolution?.cloudReplica.generation).toBe('gen-one');
  expect(result.current.resolution?.cloudReplica.capabilities.write).toBe(false);
});

test('stale recovery responses from a prior project cannot refresh or overwrite a new selection', async () => {
  const old = deferred<Response>();
  const next = { ...workspace, projectId: 'other', workspaceId: 'other-workspace' };
  const resolve = vi.spyOn(api.workspaces, 'resolve').mockResolvedValueOnce(resolved()).mockResolvedValueOnce(resolved(next));
  const recover = vi.spyOn(api.sshWorkspaces, 'recover').mockReturnValueOnce(old.promise);
  const { result, rerender } = renderHook(({ projectId }) => useWorkspaceResolution(projectId), { initialProps: { projectId: 'local' } });
  await waitFor(() => expect(recover).toHaveBeenCalledOnce());
  const signal = recover.mock.calls[0][1]?.signal;
  rerender({ projectId: 'other' });
  await waitFor(() => expect(result.current.resolution?.cloudReplica.projectId).toBe('other'));
  expect(signal?.aborted).toBe(true);
  await act(async () => old.resolve(Response.json({ status: 'idle' })));
  expect(resolve).toHaveBeenCalledTimes(2);
  expect(result.current.resolution?.cloudReplica.workspaceId).toBe('other-workspace');
});

test('unmounted recovery cannot affect a remount or launch a stale follow-up resolution', async () => {
  const old = deferred<Response>();
  const fresh = deferred<Response>();
  const resolve = vi.spyOn(api.workspaces, 'resolve').mockResolvedValueOnce(resolved()).mockResolvedValueOnce(resolved()).mockResolvedValueOnce(resolved(workspace));
  const recover = vi.spyOn(api.sshWorkspaces, 'recover').mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
  const first = renderHook(() => useWorkspaceResolution('local'));
  await waitFor(() => expect(recover).toHaveBeenCalledOnce());
  const signal = recover.mock.calls[0][1]?.signal;
  first.unmount();
  expect(signal?.aborted).toBe(true);
  const next = renderHook(() => useWorkspaceResolution('local'));
  await waitFor(() => expect(recover).toHaveBeenCalledTimes(2));
  await act(async () => old.resolve(Response.json({ status: 'idle' })));
  expect(next.result.current.resolution).toBeNull();
  expect(resolve).toHaveBeenCalledTimes(2);
  await act(async () => fresh.resolve(Response.json({ status: 'idle' })));
  await waitFor(() => expect(next.result.current.resolution?.cloudReplica.capabilities.write).toBe(true));
  expect(resolve).toHaveBeenCalledTimes(3);
});

test('account changes during an automatic recovery cannot issue a stale follow-up read', async () => {
  const old = deferred<Response>();
  const resolve = vi.spyOn(api.workspaces, 'resolve').mockResolvedValueOnce(resolved());
  const recover = vi.spyOn(api.sshWorkspaces, 'recover').mockReturnValueOnce(old.promise);
  const { result } = renderHook(() => useWorkspaceResolution('local'));
  await waitFor(() => expect(recover).toHaveBeenCalledOnce());
  await act(async () => { await authenticateWorkspaceAccount('workspace-replacement-account'); });
  await act(async () => old.resolve(Response.json({ status: 'idle' })));
  expect(resolve).toHaveBeenCalledOnce();
  expect(result.current.resolution).toBeNull();
});

test('cloud integration recovery remains manual', async () => {
  const cloud = { ...recovery, sourceMode: 'cloud' as const };
  vi.spyOn(api.workspaces, 'resolve').mockResolvedValueOnce(resolved(cloud));
  const recover = vi.spyOn(api.sshWorkspaces, 'recover');
  const { result } = renderHook(() => useWorkspaceResolution('local'));
  await waitFor(() => expect(result.current.status).toBe('ready'));
  expect(result.current.resolution?.cloudReplica.phase).toBe('recovery');
  expect(recover).not.toHaveBeenCalled();
});
