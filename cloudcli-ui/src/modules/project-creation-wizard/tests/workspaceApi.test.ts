import assert from 'node:assert/strict';

import { afterEach, beforeEach, test, vi } from 'vitest';

import { cloneWorkspaceWithProgress, createCloneAttempt } from '@/modules/project-creation-wizard/utils/workspaceApi';

type RecordedRequest = { url: string; init?: RequestInit };
const requests: RecordedRequest[] = [];
const respondToStart = (status: number, body: Record<string, unknown>) => {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    requests.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }));
};
const cloneParams = () => ({
  workspacePath: '/workspace/root',
  githubUrl: 'https://github.com/example/repo.git',
  tokenMode: 'new' as const,
  selectedGithubToken: '',
  newGithubToken: 'private-test-token',
  attempt: createCloneAttempt(),
});

beforeEach(() => { localStorage.clear(); requests.length = 0; });
afterEach(() => { vi.unstubAllGlobals(); });

test('clone credentials stay in the POST body and job identity retains the accepted result', async () => {
  const project = { projectId: 'project-1' };
  respondToStart(200, { jobId: 'clone-123', status: 'complete', message: 'Imported', project });
  const params = cloneParams();
  assert.deepEqual(await cloneWorkspaceWithProgress(params, { onProgress: () => undefined }), project);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, '/api/projects/clone-jobs');
  assert.equal(requests[0]?.init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
    path: params.workspacePath, githubUrl: params.githubUrl,
    newGithubToken: params.newGithubToken, requestId: params.attempt.requestId,
  });
  assert.ok(!requests[0]!.url.includes(params.newGithubToken));
  assert.equal(params.attempt.jobId, 'clone-123');
});

test('stored clone credentials send only their numeric identifier', async () => {
  respondToStart(200, { jobId: 'clone-123', status: 'complete', message: 'Imported', project: { projectId: 'project-1' } });
  await cloneWorkspaceWithProgress({ ...cloneParams(), tokenMode: 'stored', selectedGithubToken: '12', newGithubToken: '' }, { onProgress: () => undefined });
  const body = JSON.parse(String(requests[0]?.init?.body)) as Record<string, unknown>;
  assert.equal(body.githubTokenId, 12);
  assert.equal('newGithubToken' in body, false);
});

test('a structured start rejection preserves the server message without observing a job', async () => {
  respondToStart(400, { success: false, error: { code: 'INVALID', message: 'Invalid githubUrl' } });
  await assert.rejects(cloneWorkspaceWithProgress(cloneParams(), { onProgress: () => undefined }), { message: 'Invalid githubUrl' });
  assert.equal(requests.length, 1);
});
