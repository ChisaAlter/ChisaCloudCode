import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import GitPanel from '@/modules/git-panel/GitPanel';
import HistoryView from '@/modules/git-panel/history/HistoryView';
import { useGitPanelController } from '@/modules/git-panel/hooks/useGitPanelController';
import type { GitCommitSummary, GitPanelView, Project } from '@/shared/types';

const calls = vi.hoisted(() => ({
  status: vi.fn(), branches: vi.fn(), remoteStatus: vi.fn(), commits: vi.fn(), commitDiff: vi.fn(),
  checkout: vi.fn(), pull: vi.fn(), fetch: vi.fn(), commit: vi.fn(), revertLocalCommit: vi.fn(),
  listeners: new Set<(info: { serverPath: string; status: string }) => void>(),
}));
vi.mock('@/shared/api', () => ({ api: { git: calls } }));
vi.mock('@/shared/chisa', () => ({
  isDesktop: () => true,
  onWorkspaceSyncStateChanged: (listener: (info: { serverPath: string; status: string }) => void) => {
    calls.listeners.add(listener);
    return () => calls.listeners.delete(listener);
  },
}));
vi.mock('@/modules/git-panel/hooks/useSelectedProvider', () => ({ useSelectedProvider: () => 'claude' }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));

const projectA: Project = { projectId: 'a', fullPath: '/a', displayName: 'A' };
const projectB: Project = { projectId: 'b', fullPath: '/b', displayName: 'B' };
const commit = (hash: string): GitCommitSummary => ({ hash, author: 'Author', date: '2026-10-01', message: `Commit ${hash}` });
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function settle() { await act(async () => {}); }

beforeEach(() => {
  vi.resetAllMocks();
  calls.listeners.clear();
  calls.status.mockImplementation(async () => response({ branch: 'main', modified: [], staged: [] }));
  calls.branches.mockImplementation(async () => response({ branches: ['main', 'feature'], localBranches: ['main', 'feature'] }));
  calls.remoteStatus.mockImplementation(async () => response({ hasRemote: true, ahead: 1, behind: 1 }));
  calls.commits.mockImplementation(async () => response({ commits: [commit('initial')] }));
  calls.commitDiff.mockImplementation(async () => response({ diff: '' }));
  for (const operation of [calls.checkout, calls.pull, calls.fetch, calls.commit, calls.revertLocalCommit]) {
    operation.mockImplementation(async () => response({ success: true }));
  }
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => cleanup());

test('changes stays lazy through refreshes and mutations; entering history always reads fresh commits', async () => {
  const hook = renderHook(({ view }: { view: GitPanelView }) => useGitPanelController({ selectedProject: projectA, activeView: view }), {
    initialProps: { view: 'changes' as GitPanelView },
  });
  await settle();
  await act(async () => {
    await hook.result.current.switchBranch('feature');
    await hook.result.current.handlePull();
    await hook.result.current.refreshAll();
    calls.listeners.forEach(listener => listener({ serverPath: '/a', status: 'ready' }));
    window.dispatchEvent(new Event('focus'));
  });
  expect(calls.commits).not.toHaveBeenCalled();
  expect(calls.commitDiff).not.toHaveBeenCalled();
  hook.rerender({ view: 'history' });
  await settle();
  expect(calls.commits).toHaveBeenCalledTimes(1);
  hook.rerender({ view: 'changes' });
  calls.commits.mockResolvedValueOnce(response({ commits: [commit('returned')] }));
  hook.rerender({ view: 'history' });
  await settle();
  expect(calls.commits).toHaveBeenCalledTimes(2);
  expect(hook.result.current.recentCommits).toEqual([commit('returned')]);
});

test.each(['manual', 'branch', 'pull', 'fetch', 'commit', 'ready', 'focus'])(
  '%s refresh replaces visible history and invalidates cached commit diffs', async trigger => {
    const hook = renderHook(() => useGitPanelController({ selectedProject: projectA, activeView: 'history' }));
    await settle();
    expect(calls.commits).toHaveBeenCalledTimes(1);
    await act(async () => { await hook.result.current.fetchCommitDiff('initial'); });
    expect(hook.result.current.commitDiffs).toEqual({ initial: '' });
    calls.commits.mockResolvedValueOnce(response({ commits: [commit('updated')] }));
    await act(async () => {
      if (trigger === 'manual') await hook.result.current.refreshAll();
      if (trigger === 'branch') await hook.result.current.switchBranch('feature');
      if (trigger === 'pull') await hook.result.current.handlePull();
      if (trigger === 'fetch') await hook.result.current.handleFetch();
      if (trigger === 'commit') await hook.result.current.commitChanges('message', ['file.txt']);
      if (trigger === 'ready') calls.listeners.forEach(listener => listener({ serverPath: '/a', status: 'ready' }));
      if (trigger === 'focus') window.dispatchEvent(new Event('focus'));
    });
    expect(calls.commits).toHaveBeenCalledTimes(2);
    expect(hook.result.current.recentCommits).toEqual([commit('updated')]);
    expect(hook.result.current.commitDiffs).toEqual({});
  },
);

test('A to B to A ignores both old projects and never clears the new history loading state', async () => {
  const oldA = deferred<Response>();
  const pendingB = deferred<Response>();
  const newA = deferred<Response>();
  calls.commits.mockReturnValueOnce(oldA.promise).mockReturnValueOnce(pendingB.promise).mockReturnValueOnce(newA.promise);
  const hook = renderHook(({ project }) => useGitPanelController({ selectedProject: project, activeView: 'history' }), {
    initialProps: { project: projectA },
  });
  const oldSignal = calls.commits.mock.calls[0][2].signal as AbortSignal;
  hook.rerender({ project: projectB });
  hook.rerender({ project: projectA });
  expect(oldSignal.aborted).toBe(true);
  expect(calls.commits).toHaveBeenCalledTimes(3);
  await act(async () => {
    oldA.resolve(response({ commits: [commit('stale-a')] }));
    pendingB.resolve(response({ error: 'stale B error' }, 503));
  });
  expect(hook.result.current.recentCommits).toEqual([]);
  expect(hook.result.current.commitsError).toBeNull();
  expect(hook.result.current.isLoadingCommits).toBe(true);
  await act(async () => { newA.resolve(response({ commits: [commit('fresh-a')] })); });
  expect(hook.result.current.recentCommits).toEqual([commit('fresh-a')]);
  expect(hook.result.current.isLoadingCommits).toBe(false);
});

test('a same-project retry supersedes an older read even when cancellation is ignored by transport', async () => {
  const stale = deferred<Response>();
  const latest = deferred<Response>();
  calls.commits.mockReturnValueOnce(stale.promise).mockReturnValueOnce(latest.promise);
  const hook = renderHook(() => useGitPanelController({ selectedProject: projectA, activeView: 'history' }));
  let retry!: Promise<void>;
  act(() => { retry = hook.result.current.retryCommits(); });
  await act(async () => { latest.resolve(response({ commits: [commit('newest')] })); await retry; });
  await act(async () => { stale.resolve(response({ commits: [commit('outdated')] })); });
  expect(hook.result.current.recentCommits).toEqual([commit('newest')]);
});

test('history failure shows a retry instead of an empty list and recovers in the panel', async () => {
  calls.commits.mockResolvedValueOnce(response({ error: { message: 'History unavailable', details: { transportCode: 'PRIVATE' } } }, 503));
  render(<GitPanel selectedProject={projectA} />);
  await settle();
  fireEvent.click(screen.getByRole('tab', { name: 'git:tabs.history' }));
  await settle();
  expect(screen.getByRole('heading', { name: 'History unavailable' })).toBeTruthy();
  expect(screen.queryByText('git:history.noCommits')).toBeNull();
  expect(screen.queryByRole('status')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'common:buttons.retry' }));
  await settle();
  expect(screen.queryByText('History unavailable')).toBeNull();
  expect(screen.getByText('Commit initial')).toBeTruthy();
});

test('commit diff ownership permits concurrent hashes and rejects collapsed, superseded and old-project results', async () => {
  const collapsed = deferred<Response>();
  const oldA = deferred<Response>();
  const latestA = deferred<Response>();
  const different = deferred<Response>();
  const staleProject = deferred<Response>();
  calls.commitDiff.mockReturnValueOnce(collapsed.promise).mockReturnValueOnce(oldA.promise)
    .mockReturnValueOnce(latestA.promise).mockReturnValueOnce(different.promise).mockReturnValueOnce(staleProject.promise);
  const hook = renderHook(({ project }) => useGitPanelController({ selectedProject: project, activeView: 'history' }), {
    initialProps: { project: projectA },
  });
  await settle();
  const collapseController = new AbortController();
  act(() => { void hook.result.current.fetchCommitDiff('collapsed', collapseController.signal); });
  collapseController.abort();
  act(() => {
    void hook.result.current.fetchCommitDiff('a');
    void hook.result.current.fetchCommitDiff('a');
    void hook.result.current.fetchCommitDiff('b');
  });
  await act(async () => {
    collapsed.resolve(response({ diff: '+collapsed' }));
    oldA.resolve(response({ diff: '+stale' }));
    latestA.resolve(response({ diff: '+latest' }));
    different.resolve(response({ diff: '' }));
  });
  expect(hook.result.current.commitDiffs).toEqual({ a: '+latest', b: '' });
  act(() => { void hook.result.current.fetchCommitDiff('cross-project'); });
  hook.rerender({ project: projectB });
  hook.rerender({ project: projectA });
  await act(async () => { staleProject.resolve(response({ diff: '+hidden' })); });
  expect(hook.result.current.commitDiffs).toEqual({});
});

test('expanding is lazy, collapse aborts, diff errors retry, and empty successful diffs remain cached', async () => {
  const pending = deferred<Response>();
  calls.commitDiff.mockReturnValueOnce(pending.promise);
  function HistoryHarness() {
    const controller = useGitPanelController({ selectedProject: projectA, activeView: 'history' });
    return <HistoryView
      isMobile={false} isLoading={controller.isLoadingCommits} error={controller.commitsError} recentCommits={controller.recentCommits}
      commitDiffs={controller.commitDiffs} commitDiffErrors={controller.commitDiffErrors}
      wrapText onRetry={controller.retryCommits} onFetchCommitDiff={controller.fetchCommitDiff}
    />;
  }
  render(<HistoryHarness />);
  await settle();
  expect(calls.commitDiff).not.toHaveBeenCalled();
  const toggle = screen.getByRole('button', { name: /Commit initial/ });
  fireEvent.click(toggle);
  expect(calls.commitDiff).toHaveBeenCalledTimes(1);
  fireEvent.click(toggle);
  expect((calls.commitDiff.mock.calls[0][2].signal as AbortSignal).aborted).toBe(true);
  calls.commitDiff.mockResolvedValueOnce(response({ error: 'Diff unavailable' }, 503));
  fireEvent.click(toggle);
  await settle();
  expect(screen.getByRole('alert').textContent).toContain('Diff unavailable');
  fireEvent.click(screen.getByRole('button', { name: 'common:buttons.retry' }));
  await settle();
  expect(screen.getByText('No diff available')).toBeTruthy();
  fireEvent.click(toggle);
  fireEvent.click(toggle);
  await settle();
  expect(calls.commitDiff).toHaveBeenCalledTimes(3);
  await act(async () => { pending.resolve(response({ diff: '+discarded' })); });
  expect(screen.queryByText('+discarded')).toBeNull();
});

test('refreshing an expanded diff immediately reloads it when the old transport ignores abort', async () => {
  const stale = deferred<Response>();
  calls.commitDiff.mockReturnValueOnce(stale.promise).mockResolvedValueOnce(response({ diff: '+new contents' }));
  render(<GitPanel selectedProject={projectA} />);
  await settle();
  fireEvent.click(screen.getByRole('tab', { name: 'git:tabs.history' }));
  await settle();
  fireEvent.click(screen.getByRole('button', { name: /Commit initial/ }));
  expect(calls.commitDiff).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByTitle('git:header.refreshTitle'));
  await settle();
  expect((calls.commitDiff.mock.calls[0][2].signal as AbortSignal).aborted).toBe(true);
  expect(calls.commitDiff).toHaveBeenCalledTimes(2);
  expect(screen.getByText('+new contents')).toBeTruthy();
  await act(async () => { stale.resolve(response({ diff: '+old contents' })); });
  expect(screen.queryByText('+old contents')).toBeNull();
  expect(screen.getByText('+new contents')).toBeTruthy();
});
