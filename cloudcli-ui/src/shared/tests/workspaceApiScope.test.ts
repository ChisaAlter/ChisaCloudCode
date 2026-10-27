import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { api as globalApi, createWorkspaceApi } from '@/shared/api';
import type { WorkspaceDescriptor } from '@/shared/types';

const workspace: WorkspaceDescriptor = {
  workspaceId: 'session:one', generation: 'generation/one', projectId: 'project', kind: 'session', sessionId: 'one',
  rootPath: '/isolated/one', sourceRoot: '/cloud/project', requestedMode: 'isolated', effectiveMode: 'isolated',
  phase: 'idle', publicationState: 'unpublished',
  capabilities: { read: true, write: true, git: true, shell: true, preview: true, integrate: true, cloudExecutionIndependentOfDesktop: true },
};
const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.stubGlobal('mygo', undefined);
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset().mockImplementation(async () => Response.json({}));
});
afterEach(() => vi.unstubAllGlobals());
const requestUrl = (index: number) => new URL(String(fetchMock.mock.calls[index][0]), 'http://localhost');

test('file reads, CAS writes, Git, and uploads preserve the captured workspace pair', async () => {
  const api = createWorkspaceApi(workspace);
  await api.readFile('project', '/isolated/one/a.ts');
  await api.saveFile('project', '/isolated/one/a.ts', 'edited', 'observed-hash');
  await api.git.status('project');
  for (let index = 0; index < 3; index++) {
    expect(requestUrl(index).searchParams.get('workspaceId')).toBe(workspace.workspaceId);
    expect(requestUrl(index).searchParams.get('generation')).toBe(workspace.generation);
  }
  expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({
    workspaceId: workspace.workspaceId, generation: workspace.generation, expectedHash: 'observed-hash', content: 'edited', filePath: '/isolated/one/a.ts',
  });
  const upload = new URL(api.uploadFilesUrl('project'), 'http://localhost');
  expect(upload.searchParams.get('workspaceId')).toBe(workspace.workspaceId);
  expect(upload.searchParams.get('generation')).toBe(workspace.generation);
  const replica = createWorkspaceApi({ ...workspace, kind: 'cloudReplica', workspaceId: 'replica', generation: 'replica-gen', sessionId: undefined });
  await replica.readFile('project', 'a.ts');
  await api.readFile('project', 'a.ts');
  expect(requestUrl(3).searchParams.get('workspaceId')).toBe('replica');
  expect(requestUrl(4).searchParams.get('workspaceId')).toBe(workspace.workspaceId);
});

test('provider skills carries the immutable session selector and preserves global settings discovery', async () => {
  await globalApi.providers.skills('claude', {
    projectId: workspace.projectId, workspaceId: workspace.workspaceId, generation: workspace.generation, sessionId: workspace.sessionId,
  });
  expect(Object.fromEntries(requestUrl(0).searchParams)).toEqual({
    projectId: workspace.projectId, workspaceId: workspace.workspaceId, generation: workspace.generation, sessionId: workspace.sessionId,
  });
  await globalApi.providers.skills('claude');
  expect(requestUrl(1).search).toBe('');
});

test('an unavailable workspace refuses reads, writes, Git, artifacts and uploads without legacy fallback', async () => {
  const api = createWorkspaceApi(null);
  await expect(api.readFile('project', 'a.ts')).rejects.toThrow('尚未准备好');
  await expect(api.saveFile('project', 'a.ts', 'bad')).rejects.toThrow('尚未准备好');
  await expect(api.git.status('project')).rejects.toThrow('尚未准备好');
  await expect(api.readArtifact('/api/file-tree/projects/project/files/content?path=a.png')).rejects.toThrow('尚未准备好');
  expect(() => api.uploadFilesUrl('project')).toThrow('尚未准备好');
  expect(fetchMock).not.toHaveBeenCalled();
});

test('capability refusal and session worktree restriction happen before network dispatch', async () => {
  const api = createWorkspaceApi({ ...workspace, capabilities: { ...workspace.capabilities, write: false, git: false } });
  await expect(api.saveFile('project', 'a.ts', 'bad')).rejects.toThrow('暂不允许');
  await expect(api.git.status('project')).rejects.toThrow('暂不允许');
  expect(() => api.uploadFilesUrl('project')).toThrow('暂不允许');
  await expect(createWorkspaceApi(workspace).worktrees.list('project')).rejects.toThrow('主工作区');
  expect(fetchMock).not.toHaveBeenCalled();
  await api.readFile('project', 'a.ts');
  expect(fetchMock).toHaveBeenCalledOnce();
});
