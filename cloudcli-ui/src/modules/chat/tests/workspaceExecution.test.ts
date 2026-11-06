import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { assertQueuedExecutionWorkspace, resolveExecutionWorkspace } from '@/modules/chat/utils/workspaceExecution';
import { api, ApiRequestError } from '@/shared/api';
import { acknowledgeAuthSession, clearAuthToken, getAuthSessionSnapshot, initializeAuthSession, startAuthSession } from '@/shared/authToken';
import type { WorkspaceDescriptor } from '@/shared/types';

const local: WorkspaceDescriptor = {
  projectId: 'local', workspaceId: 'local-one', generation: 'gen-one', kind: 'cloudReplica', sourceMode: 'ssh', rootPath: '/meta/local', sourceRoot: '/meta/local',
  requestedMode: 'shared', effectiveMode: 'shared', phase: 'idle', publicationState: 'unpublished', connectionState: 'online',
  capabilities: { read: true, write: true, git: true, shell: true, preview: false, integrate: false, cloudExecutionIndependentOfDesktop: false },
};
const recovery: WorkspaceDescriptor = { ...local, phase: 'recovery', connectionState: 'recovery', capabilities: { ...local.capabilities, write: false } };
const resolution = (workspace: WorkspaceDescriptor, session: WorkspaceDescriptor | null = null) => Response.json({ cloudReplica: workspace, session });
const selector = { projectId: local.projectId, workspaceId: local.workspaceId, generation: local.generation };
function accountToken(userId: string): string {
  const payload = btoa(JSON.stringify({ userId, exp: Math.floor(Date.now() / 1000) + 600 })).replace(/=/g, '');
  return `header.${payload}.signature`;
}

beforeEach(async () => {
  await initializeAuthSession();
  const session = await startAuthSession(accountToken('workspace-owner'), getAuthSessionSnapshot());
  expect(session).not.toBeNull();
  acknowledgeAuthSession(session!);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await clearAuthToken();
});

test('a terminal local task is safely recovered once and its same identity re-resolved before sending', async () => {
  const resolve = vi.spyOn(api.workspaces, 'resolve').mockResolvedValueOnce(resolution(recovery)).mockResolvedValueOnce(resolution(local));
  const recover = vi.spyOn(api.sshWorkspaces, 'recover').mockResolvedValueOnce(Response.json({ status: 'idle' }));
  await expect(resolveExecutionWorkspace(recovery, 'local', 'conversation')).resolves.toEqual(selector);
  expect(resolve).toHaveBeenCalledTimes(2);
  expect(resolve).toHaveBeenNthCalledWith(2, 'local', 'conversation');
  expect(recover).toHaveBeenCalledExactlyOnceWith({ projectId: 'local', generation: 'gen-one' });
});

test('a still running original task blocks sending without cancellation or a repeated attempt', async () => {
  const resolve = vi.spyOn(api.workspaces, 'resolve').mockResolvedValueOnce(resolution(recovery));
  const recover = vi.spyOn(api.sshWorkspaces, 'recover').mockResolvedValueOnce(Response.json({ status: 'running' }));
  await expect(resolveExecutionWorkspace(recovery, 'local')).rejects.toThrow('原本地任务仍在运行');
  expect(resolve).toHaveBeenCalledOnce();
  expect(recover).toHaveBeenCalledExactlyOnceWith({ projectId: 'local', generation: 'gen-one' });
});

test('a typed recovery failure preserves its specific reason and prevents dispatch', async () => {
  vi.spyOn(api.workspaces, 'resolve').mockResolvedValueOnce(resolution(recovery));
  vi.spyOn(api.sshWorkspaces, 'recover').mockResolvedValueOnce(Response.json({ error: { code: 'SSH_RECOVERY_RECEIPT_MISSING', message: '原操作缺少回执，暂不能确认' } }, { status: 409 }));
  const error = await resolveExecutionWorkspace(recovery, 'local').catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(ApiRequestError);
  expect(error).toMatchObject({ code: 'SSH_RECOVERY_RECEIPT_MISSING', message: '原操作缺少回执，暂不能确认' });
});

test.each([
  { ...local, generation: 'replacement-generation' },
  { ...local, workspaceId: 'replacement-workspace' },
  { ...local, sourceMode: 'cloud' as const },
])('a replacement workspace after recovery cannot inherit the original send permission: %s', async replacement => {
  vi.spyOn(api.workspaces, 'resolve').mockResolvedValueOnce(resolution(recovery)).mockResolvedValueOnce(resolution(replacement));
  const recover = vi.spyOn(api.sshWorkspaces, 'recover').mockResolvedValueOnce(Response.json({ status: 'idle' }));
  await expect(resolveExecutionWorkspace(recovery, 'local')).rejects.toThrow('工作区已变化，草稿已保留');
  expect(recover).toHaveBeenCalledOnce();
});

test('a changed generation before recovery never checks the replacement task', async () => {
  vi.spyOn(api.workspaces, 'resolve').mockResolvedValueOnce(resolution({ ...recovery, generation: 'replacement' }));
  const recover = vi.spyOn(api.sshWorkspaces, 'recover');
  await expect(resolveExecutionWorkspace(recovery, 'local')).rejects.toThrow('工作区已变化');
  expect(recover).not.toHaveBeenCalled();
});

test('an idle receipt alone cannot clear a remaining recovery descriptor', async () => {
  vi.spyOn(api.workspaces, 'resolve').mockImplementation(async () => resolution(recovery));
  const recover = vi.spyOn(api.sshWorkspaces, 'recover').mockResolvedValueOnce(Response.json({ status: 'idle', inspectChanges: true }));
  await expect(resolveExecutionWorkspace(recovery, 'local')).rejects.toThrow('本地工作区仍需确认上次操作结果');
  expect(recover).toHaveBeenCalledOnce();
});

test.each([
  [{ ...local, connectionState: 'offline' as const }, '本地工作区连接已断开'],
  [{ ...local, capabilities: { ...local.capabilities, write: false } }, '本地工作区暂不可写'],
])('local access failures keep SSH-specific draft-preserving messages: %s', async (workspace, message) => {
  vi.spyOn(api.workspaces, 'resolve').mockResolvedValueOnce(resolution(workspace));
  const recover = vi.spyOn(api.sshWorkspaces, 'recover');
  await expect(resolveExecutionWorkspace(workspace, 'local')).rejects.toThrow(message);
  expect(recover).not.toHaveBeenCalled();
});

test('ordinary local inspection occupancy still defers FIFO admission to the backend', async () => {
  const inspecting: WorkspaceDescriptor = { ...local, phase: 'running', capabilities: { ...local.capabilities, write: false } };
  vi.spyOn(api.workspaces, 'resolve').mockResolvedValueOnce(resolution(inspecting));
  const recover = vi.spyOn(api.sshWorkspaces, 'recover');
  await expect(resolveExecutionWorkspace(inspecting, 'local')).resolves.toEqual(selector);
  expect(recover).not.toHaveBeenCalled();
});

test('an account change while confirming recovery cannot continue resolving or sending', async () => {
  const captured = getAuthSessionSnapshot();
  let finish!: (response: Response) => void;
  // Use the real authenticated transport so its immutable request capture, not a permissive API spy, rejects the old owner.
  const fetchMock = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(resolution(recovery))
    .mockImplementationOnce(() => new Promise<Response>(done => { finish = done; }));
  vi.stubGlobal('fetch', fetchMock);
  const resolve = vi.spyOn(api.workspaces, 'resolve');
  const recover = vi.spyOn(api.sshWorkspaces, 'recover');
  const dispatch = vi.fn();
  const draft = { text: 'Keep this unsent recovery message' };
  const result = (async () => {
    const workspace = await resolveExecutionWorkspace(recovery, 'local');
    dispatch({ workspace, text: draft.text });
    draft.text = '';
  })();
  const failure = result.catch((error: unknown) => error);
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  expect(new Headers(fetchMock.mock.calls[1][1]?.headers).get('Authorization')).toBe(`Bearer ${captured.token}`);
  const replacement = await startAuthSession(accountToken('replacement-owner'), captured);
  expect(replacement).not.toBeNull();
  acknowledgeAuthSession(replacement!);
  expect(getAuthSessionSnapshot().sessionInstanceId).not.toBe(captured.sessionInstanceId);
  finish(Response.json({ status: 'idle' }));
  expect(await failure).toMatchObject({ name: 'AbortError', message: 'Account session changed' });
  expect(resolve).toHaveBeenCalledOnce();
  expect(recover).toHaveBeenCalledExactlyOnceWith({ projectId: 'local', generation: 'gen-one' });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(dispatch).not.toHaveBeenCalled();
  expect(draft.text).toBe('Keep this unsent recovery message');
});

test('cloud recovery and the first isolated session retain their original behavior', async () => {
  const cloud: WorkspaceDescriptor = { ...local, sourceMode: 'cloud' };
  const session: WorkspaceDescriptor = { ...cloud, kind: 'session', sessionId: 'conversation', workspaceId: 'session-one', generation: 'session-gen', rootPath: '/isolated/session' };
  vi.spyOn(api.workspaces, 'resolve').mockResolvedValueOnce(resolution({ ...cloud, phase: 'recovery' })).mockResolvedValueOnce(resolution(cloud, session));
  const recover = vi.spyOn(api.sshWorkspaces, 'recover');
  await expect(resolveExecutionWorkspace(cloud, 'local')).rejects.toThrow('请先完成集成恢复');
  await expect(resolveExecutionWorkspace(cloud, 'local', 'conversation')).resolves.toEqual({ projectId: 'local', workspaceId: 'session-one', generation: 'session-gen' });
  expect(recover).not.toHaveBeenCalled();
});

test('durable queued workspace identity and legacy undefined contexts remain unchanged', async () => {
  const resolve = vi.spyOn(api.workspaces, 'resolve');
  await expect(resolveExecutionWorkspace(undefined, 'local')).resolves.toBeUndefined();
  expect(resolve).not.toHaveBeenCalled();
  expect(() => assertQueuedExecutionWorkspace(selector, selector)).not.toThrow();
  expect(() => assertQueuedExecutionWorkspace({ ...selector, generation: 'previous' }, selector)).toThrow('排队消息的工作区已变化');
});
