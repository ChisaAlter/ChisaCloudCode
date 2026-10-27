import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { GitWorkspaceButton } from '@/modules/git-panel/GitWorkspaceButton';
import { useGitPanelController } from '@/modules/git-panel/hooks/useGitPanelController';
import { GIT_STATUS_OBSERVED_EVENT } from '@/shared/constants';
import type { Project } from '@/shared/types';

const calls = vi.hoisted(() => ({
  status: vi.fn(), branches: vi.fn(), remoteStatus: vi.fn(), diff: vi.fn(),
  checkout: vi.fn(), createBranch: vi.fn(), deleteBranch: vi.fn(), commit: vi.fn(),
  nativeSubscribe: vi.fn(),
}));
vi.mock('@/shared/api', () => ({ api: { git: calls } }));
vi.mock('mygo-runtime', () => ({ on: calls.nativeSubscribe, call: vi.fn() }));
vi.mock('@/modules/git-panel/hooks/useSelectedProvider', () => ({ useSelectedProvider: () => 'claude' }));

const projectA: Project = { projectId: 'a', fullPath: '/a', displayName: 'A' };
const projectB: Project = { projectId: 'b', fullPath: '/b', displayName: 'B' };
function response(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status }); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function settle() { await act(async () => {}); }

beforeEach(() => {
  vi.resetAllMocks();
  calls.status.mockImplementation(async (id: string) => response({ branch: id, modified: ['first.txt', 'second.txt'] }));
  calls.branches.mockImplementation(async (id: string) => response({ branches: [id], localBranches: [id] }));
  calls.remoteStatus.mockImplementation(async () => response({ hasRemote: false }));
  calls.diff.mockResolvedValue(response({ diff: '' }));
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
});
afterEach(() => cleanup());

test('a project status read never eagerly fetches file diffs', async () => {
  const hook = renderHook(() => useGitPanelController({ selectedProject: projectA, activeView: 'changes' }));
  await settle();
  expect(calls.diff).not.toHaveBeenCalled();
  await act(async () => { await hook.result.current.fetchFileDiff('first.txt'); });
  expect(calls.diff).toHaveBeenCalledExactlyOnceWith('a', 'first.txt', { signal: undefined });
  expect(hook.result.current.gitDiff).toEqual({ 'first.txt': '' });
});

test('focus refreshes the selected cloud workspace and replaces stale repository state', async () => {
  calls.status.mockResolvedValueOnce(response({ branch: 'main', modified: ['old.txt'] }));
  calls.branches.mockResolvedValueOnce(response({ branches: ['main'], localBranches: ['main'] }));
  const hook = renderHook(() => useGitPanelController({ selectedProject: projectA, activeView: 'changes' }));
  await settle();
  await act(async () => { await hook.result.current.fetchFileDiff('old.txt'); });
  expect(hook.result.current.gitDiff).toEqual({ 'old.txt': '' });

  act(() => {
    window.dispatchEvent(new CustomEvent('chisa:workspace-sync-state', { detail: { serverPath: '/a', status: 'ready' } }));
  });
  await settle();
  expect(calls.status).toHaveBeenCalledTimes(1);
  expect(calls.branches).toHaveBeenCalledTimes(1);
  expect(calls.remoteStatus).toHaveBeenCalledTimes(1);

  calls.status.mockResolvedValueOnce(response({ branch: 'feature/desktop-check', modified: [] }));
  calls.branches.mockResolvedValueOnce(response({ branches: ['main', 'feature/desktop-check'], localBranches: ['main', 'feature/desktop-check'] }));
  calls.remoteStatus.mockResolvedValueOnce(response({ hasRemote: true, remoteName: 'origin' }));
  act(() => window.dispatchEvent(new Event('focus')));
  await settle();

  expect(calls.status).toHaveBeenCalledTimes(2);
  expect(calls.branches).toHaveBeenCalledTimes(2);
  expect(calls.remoteStatus).toHaveBeenCalledTimes(2);
  expect(hook.result.current.currentBranch).toBe('feature/desktop-check');
  expect(hook.result.current.gitStatus?.modified).toEqual([]);
  expect(hook.result.current.localBranches).toEqual(['main', 'feature/desktop-check']);
  expect(hook.result.current.remoteStatus).toMatchObject({ hasRemote: true, remoteName: 'origin' });
  expect(hook.result.current.gitDiff).toEqual({});
  expect(calls.diff).toHaveBeenCalledTimes(1);
  expect(hook.result.current.isLoading).toBe(false);
});

test('focus aborts old cloud reads and ignores their late responses', async () => {
  const status = deferred<Response>();
  const branch = deferred<Response>();
  const remote = deferred<Response>();
  calls.status.mockReturnValueOnce(status.promise);
  calls.branches.mockReturnValueOnce(branch.promise);
  calls.remoteStatus.mockReturnValueOnce(remote.promise);
  const hook = renderHook(() => useGitPanelController({ selectedProject: projectA, activeView: 'changes' }));
  const staleSignal = calls.status.mock.calls[0][1].signal as AbortSignal;
  expect(calls.branches.mock.calls[0][1].signal).toBe(staleSignal);
  expect(calls.remoteStatus.mock.calls[0][1].signal).toBe(staleSignal);

  act(() => window.dispatchEvent(new Event('focus')));
  await settle();
  const recoveredSignal = calls.status.mock.calls[1][1].signal as AbortSignal;
  expect(staleSignal.aborted).toBe(true);
  expect(recoveredSignal.aborted).toBe(false);
  expect(recoveredSignal).not.toBe(staleSignal);
  expect(calls.branches.mock.calls[1][1].signal).toBe(recoveredSignal);
  expect(calls.remoteStatus.mock.calls[1][1].signal).toBe(recoveredSignal);

  await act(async () => {
    status.resolve(response({ branch: 'stale', modified: ['old.txt'] }));
    branch.resolve(response({ branches: ['stale'], localBranches: ['stale'] }));
    remote.resolve(response({ hasRemote: true, remoteName: 'stale' }));
  });
  expect(hook.result.current.currentBranch).toBe('a');
  expect(hook.result.current.branches).toEqual(['a']);
  expect(hook.result.current.remoteStatus).toEqual({ hasRemote: false });
  expect(hook.result.current.isLoading).toBe(false);
});

test('manual refresh supersedes a focus refresh without accepting its stale response', async () => {
  const stale = deferred<Response>();
  const hook = renderHook(() => useGitPanelController({ selectedProject: projectA, activeView: 'changes' }));
  await settle();
  calls.status.mockReturnValueOnce(stale.promise);
  act(() => window.dispatchEvent(new Event('focus')));
  const recoverySignal = calls.status.mock.calls[1][1].signal as AbortSignal;
  calls.status.mockResolvedValueOnce(response({ branch: 'latest', modified: [] }));
  await act(async () => { hook.result.current.refreshAll(); });
  expect(recoverySignal.aborted).toBe(true);
  await act(async () => { stale.resolve(response({ branch: 'stale', modified: ['old.txt'] })); });
  expect(hook.result.current.currentBranch).toBe('latest');
  expect(hook.result.current.gitStatus?.modified).toEqual([]);
  expect(hook.result.current.isLoading).toBe(false);
});

test('visible focus refreshes all repository reads while hidden focus waits', async () => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get');
  const hook = renderHook(() => useGitPanelController({ selectedProject: projectA, activeView: 'changes' }));
  await settle();
  visibility.mockReturnValue('hidden');
  act(() => {
    window.dispatchEvent(new Event('focus'));
  });
  await settle();
  expect(calls.status).toHaveBeenCalledTimes(1);

  visibility.mockReturnValue('visible');
  calls.status.mockResolvedValueOnce(response({ branch: 'after-focus', modified: [] }));
  act(() => window.dispatchEvent(new Event('focus')));
  await settle();
  expect(calls.status).toHaveBeenCalledTimes(2);
  expect(calls.branches).toHaveBeenCalledTimes(2);
  expect(calls.remoteStatus).toHaveBeenCalledTimes(2);
  expect(hook.result.current.currentBranch).toBe('after-focus');
  expect(hook.result.current.gitStatus?.modified).toEqual([]);
});

test('cloud panels refresh on focus without subscribing to a native bridge', async () => {
  const hook = renderHook(() => useGitPanelController({ selectedProject: projectA, activeView: 'changes' }));
  await settle();
  expect(calls.nativeSubscribe).not.toHaveBeenCalled();
  act(() => window.dispatchEvent(new Event('focus')));
  await settle();
  expect(calls.status).toHaveBeenCalledTimes(2);
  expect(hook.result.current.currentBranch).toBe('a');
});

test('late branch and remote responses from another project cannot overwrite the selection', async () => {
  const branch = deferred<Response>();
  const remote = deferred<Response>();
  calls.branches.mockReturnValueOnce(branch.promise);
  calls.remoteStatus.mockReturnValueOnce(remote.promise);
  const hook = renderHook(({ project }) => useGitPanelController({ selectedProject: project, activeView: 'changes' }), { initialProps: { project: projectA } });
  await settle();
  hook.rerender({ project: projectB });
  await settle();
  await act(async () => {
    branch.resolve(response({ branches: ['wrong'], localBranches: ['wrong'] }));
    remote.resolve(response({ hasRemote: true, remoteName: 'wrong' }));
  });
  expect(hook.result.current.currentBranch).toBe('b');
  expect(hook.result.current.branches).toEqual(['b']);
  expect(hook.result.current.remoteStatus).toEqual({ hasRemote: false });
});

test('branch writes show server failures, reject double submission, and await fresh state', async () => {
  const write = deferred<Response>();
  calls.checkout.mockReturnValueOnce(write.promise);
  const hook = renderHook(() => useGitPanelController({ selectedProject: projectA, activeView: 'changes' }));
  await settle();
  let first!: Promise<boolean>;
  act(() => { first = hook.result.current.switchBranch('feature'); });
  expect(hook.result.current.isBranchBusy).toBe(true);
  await act(async () => { expect(await hook.result.current.createBranch('other')).toBe(false); });
  expect(calls.createBranch).not.toHaveBeenCalled();
  await act(async () => { write.resolve(response({ error: 'Workspace is busy; wait for the task' }, 409)); await first; });
  expect(hook.result.current.operationError).toBe('Workspace is busy; wait for the task');
  expect(hook.result.current.currentBranch).toBe('a');
  expect(hook.result.current.isBranchBusy).toBe(false);

  const status = deferred<Response>();
  calls.checkout.mockResolvedValueOnce(response({ success: true }));
  calls.status.mockReturnValueOnce(status.promise);
  act(() => { first = hook.result.current.switchBranch('feature'); });
  await settle();
  expect(hook.result.current.isBranchBusy).toBe(true);
  expect(hook.result.current.operationError).toBeNull();
  await act(async () => { status.resolve(response({ branch: 'feature' })); expect(await first).toBe(true); });
  expect(hook.result.current.currentBranch).toBe('feature');
  expect(hook.result.current.isBranchBusy).toBe(false);
});

test('the cloud branch entry rejects stale observations and refreshes after an in-flight focus', async () => {
  const first = deferred<Response>();
  calls.status.mockReturnValueOnce(first.promise).mockResolvedValueOnce(response({ branch: 'after-focus' }));
  const view = render(<GitWorkspaceButton projectId="a" active={false} onClick={() => {}} />);
  act(() => window.dispatchEvent(new Event('focus')));
  await act(async () => { first.resolve(response({ branch: 'stale' })); });
  expect(calls.status).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('button', { name: 'Git' }).title).toBe('Git · after-focus');
  act(() => window.dispatchEvent(new CustomEvent(GIT_STATUS_OBSERVED_EVENT, { detail: { projectId: 'a', status: { branch: 'observed' } } })));
  expect(screen.getByRole('button', { name: 'Git' }).title).toBe('Git · observed');
  view.rerender(<GitWorkspaceButton projectId="b" active onClick={() => {}} />);
  expect(screen.getByRole('button', { name: 'Git' }).title).toBe('Git');
  await settle();
  expect(screen.getByRole('button', { name: 'Git' }).title).toBe('Git · b');
});
