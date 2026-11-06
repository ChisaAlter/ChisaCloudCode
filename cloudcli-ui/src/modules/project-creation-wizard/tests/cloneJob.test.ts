import { afterEach, expect, test, vi } from 'vitest';

import { api } from '@/shared/api';
import { cancelCloneWorkspace, CloneJobObservationError, CloneJobOperationError, cloneWorkspaceWithProgress, createCloneAttempt } from '@/modules/project-creation-wizard/utils/workspaceApi';

const parameters = () => ({ workspacePath: ' /cloud/project ', githubUrl: ' https://github.com/example/project ', tokenMode: 'new' as const, selectedGithubToken: '', newGithubToken: ' secret-token ', attempt: createCloneAttempt() });
const running = { jobId: 'job-1', status: 'running', message: 'Receiving objects 50%' };
const project = { projectId: 'project-1', fullPath: '/cloud/project' };
const complete = { ...running, status: 'complete', message: 'Imported', project };
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

test('POST contains credentials and request id, then authenticated polling reports progress', async () => {
  vi.useFakeTimers();
  const start = vi.spyOn(api, 'startCloneJob').mockResolvedValue(Response.json(running));
  const get = vi.spyOn(api, 'getCloneJob').mockResolvedValue(Response.json(complete));
  const progress = vi.fn();
  const params = parameters();
  const result = cloneWorkspaceWithProgress(params, { onProgress: progress });
  await vi.advanceTimersByTimeAsync(500);
  expect(await result).toEqual(project);
  expect(start).toHaveBeenCalledExactlyOnceWith({ path: '/cloud/project', githubUrl: 'https://github.com/example/project', newGithubToken: 'secret-token', requestId: params.attempt.requestId }, { signal: undefined });
  expect(get).toHaveBeenCalledExactlyOnceWith('job-1', { signal: undefined });
  expect(progress.mock.calls.map(call => call[0])).toEqual(['Receiving objects 50%', 'Imported']);
});

test('unknown POST transport outcome retries with the same logical request id', async () => {
  const start = vi.spyOn(api, 'startCloneJob').mockRejectedValueOnce(new TypeError('Network unavailable')).mockResolvedValueOnce(Response.json(complete));
  const params = parameters();
  await expect(cloneWorkspaceWithProgress(params, { onProgress: vi.fn() })).rejects.toBeInstanceOf(CloneJobObservationError);
  expect(await cloneWorkspaceWithProgress(params, { onProgress: vi.fn() })).toEqual(project);
  expect(start).toHaveBeenCalledTimes(2);
  expect(start.mock.calls[0][0].requestId).toBe(start.mock.calls[1][0].requestId);
});

test('GET failure retains job id and retry resumes GET without a second POST', async () => {
  vi.useFakeTimers();
  const start = vi.spyOn(api, 'startCloneJob').mockResolvedValue(Response.json(running));
  const get = vi.spyOn(api, 'getCloneJob').mockRejectedValueOnce(new TypeError('Offline')).mockResolvedValueOnce(Response.json(complete));
  const params = parameters();
  const result = cloneWorkspaceWithProgress(params, { onProgress: vi.fn() });
  const rejection = expect(result).rejects.toThrow('Import status is unknown');
  await vi.advanceTimersByTimeAsync(500);
  await rejection;
  expect(params.attempt.jobId).toBe('job-1');
  expect(await cloneWorkspaceWithProgress(params, { onProgress: vi.fn() })).toEqual(project);
  expect(start).toHaveBeenCalledOnce();
  expect(get).toHaveBeenCalledTimes(2);
});

test('cancel before POST response uses request identity and missing complete project is not success', async () => {
  const params = parameters();
  const cancel = vi.spyOn(api, 'cancelCloneRequest').mockResolvedValue(Response.json({ ...running, status: 'cancelled' }));
  await cancelCloneWorkspace(params.attempt);
  expect(cancel).toHaveBeenCalledWith(params.attempt.requestId);
  expect(params.attempt.snapshot?.status).toBe('cancelled');
  vi.spyOn(api, 'startCloneJob').mockResolvedValue(Response.json({ ...running, status: 'complete' }));
  await expect(cloneWorkspaceWithProgress(parameters(), { onProgress: vi.fn() })).rejects.toBeInstanceOf(CloneJobObservationError);
});

test('completed task is reused locally when opening the returned project is retried', async () => {
  const start = vi.spyOn(api, 'startCloneJob').mockResolvedValue(Response.json(complete));
  const get = vi.spyOn(api, 'getCloneJob');
  const params = parameters();
  expect(await cloneWorkspaceWithProgress(params, { onProgress: vi.fn() })).toEqual(project);
  expect(await cloneWorkspaceWithProgress(params, { onProgress: vi.fn() })).toEqual(project);
  expect(start).toHaveBeenCalledOnce();
  expect(get).not.toHaveBeenCalled();
});

test('terminal task errors differ from observation failures', async () => {
  vi.spyOn(api, 'startCloneJob').mockResolvedValue(Response.json({ ...running, status: 'error', message: 'Repository does not exist' }));
  await expect(cloneWorkspaceWithProgress(parameters(), { onProgress: vi.fn() })).rejects.toBeInstanceOf(CloneJobOperationError);
});

test('abort stops polling and explicit cancel uses the retained job id', async () => {
  vi.useFakeTimers();
  vi.spyOn(api, 'startCloneJob').mockResolvedValue(Response.json(running));
  const get = vi.spyOn(api, 'getCloneJob');
  const cancel = vi.spyOn(api, 'cancelCloneJob').mockResolvedValue(Response.json({ ...running, status: 'cancelled', message: 'Cancelled' }));
  const params = parameters();
  const controller = new AbortController();
  const result = cloneWorkspaceWithProgress({ ...params, signal: controller.signal }, { onProgress: vi.fn() });
  const rejection = expect(result).rejects.toMatchObject({ name: 'AbortError' });
  await vi.advanceTimersByTimeAsync(0);
  controller.abort();
  await rejection;
  await cancelCloneWorkspace(params.attempt);
  await vi.advanceTimersByTimeAsync(1000);
  expect(cancel).toHaveBeenCalledExactlyOnceWith('job-1');
  expect(get).not.toHaveBeenCalled();
});

test('a stale poll resolving after abort cannot overwrite a confirmed cancellation', async () => {
  vi.useFakeTimers();
  vi.spyOn(api, 'startCloneJob').mockResolvedValue(Response.json(running));
  let finishPoll!: (response: Response) => void;
  vi.spyOn(api, 'getCloneJob').mockImplementation(() => new Promise(resolve => { finishPoll = resolve; }));
  vi.spyOn(api, 'cancelCloneJob').mockResolvedValue(Response.json({ ...running, status: 'cancelled', message: 'Cancelled' }));
  const params = parameters();
  const controller = new AbortController();
  const result = cloneWorkspaceWithProgress({ ...params, signal: controller.signal }, { onProgress: vi.fn() });
  const rejection = expect(result).rejects.toMatchObject({ name: 'AbortError' });
  await vi.advanceTimersByTimeAsync(500);
  controller.abort();
  await cancelCloneWorkspace(params.attempt);
  finishPoll(Response.json(complete));
  await rejection;
  expect(params.attempt.snapshot?.status).toBe('cancelled');
});

test('an HTTP failure observing an accepted job never permits re-creation', async () => {
  const start = vi.spyOn(api, 'startCloneJob').mockResolvedValue(Response.json(complete));
  const get = vi.spyOn(api, 'getCloneJob').mockResolvedValue(Response.json({ error: 'Temporarily unavailable' }, { status: 404 }));
  const params = parameters();
  params.attempt.jobId = 'job-1';
  await expect(cloneWorkspaceWithProgress(params, { onProgress: vi.fn() })).rejects.toBeInstanceOf(CloneJobObservationError);
  expect(get).toHaveBeenCalledOnce();
  expect(start).not.toHaveBeenCalled();
});
