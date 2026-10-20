import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import GitPanel from '@/modules/git-panel/GitPanel';
import { useRevertLocalCommit } from '@/modules/git-panel/hooks/useRevertLocalCommit';
import type { Project } from '@/shared/types';

const calls = vi.hoisted(() => ({
  status: vi.fn(), branches: vi.fn(), remoteStatus: vi.fn(), commits: vi.fn(), revertLocalCommit: vi.fn(),
}));
vi.mock('@/shared/api', () => ({ api: { git: calls } }));
vi.mock('@/shared/chisa', () => ({ isDesktop: () => false }));
vi.mock('@/modules/git-panel/hooks/useSelectedProvider', () => ({ useSelectedProvider: () => 'claude' }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));

const projectA: Project = { projectId: 'a', fullPath: '/a', displayName: 'A' };
const projectB: Project = { projectId: 'b', fullPath: '/b', displayName: 'B' };
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function settle() { await act(async () => {}); }
function requestRevert() {
  fireEvent.click(screen.getByTitle('git:header.revertTitle'));
  return screen.getByRole('dialog');
}

beforeEach(() => {
  vi.resetAllMocks();
  calls.status.mockImplementation(async () => response({ branch: 'main', modified: [], staged: [] }));
  calls.branches.mockImplementation(async () => response({ branches: ['main'] }));
  calls.remoteStatus.mockImplementation(async () => response({ hasRemote: true }));
  calls.commits.mockImplementation(async () => response({ commits: [] }));
  calls.revertLocalCommit.mockImplementation(async () => response({ success: true }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => cleanup());

test('revert confirmation blocks duplicates and dismissal until the operation and history refresh finish', async () => {
  const revert = deferred<Response>();
  const refreshedHistory = deferred<Response>();
  calls.revertLocalCommit.mockReturnValueOnce(revert.promise);
  render(<GitPanel selectedProject={projectA} />);
  await settle();
  fireEvent.click(screen.getByRole('tab', { name: 'git:tabs.history' }));
  await settle();
  calls.commits.mockReturnValueOnce(refreshedHistory.promise);
  const dialog = requestRevert();
  const confirm = within(dialog).getByRole('button', { name: 'git:confirm.action.revertLocalCommit' });
  fireEvent.click(confirm);
  fireEvent.click(confirm);
  expect(calls.revertLocalCommit).toHaveBeenCalledTimes(1);
  expect((confirm as HTMLButtonElement).disabled).toBe(true);
  expect((within(dialog).getByRole('button', { name: 'git:confirm.cancel' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.keyDown(document, { key: 'Escape' });
  fireEvent.click(dialog.parentElement!);
  expect(screen.getByRole('dialog')).toBeTruthy();
  await act(async () => { revert.resolve(response({ success: true })); });
  expect(calls.commits).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('dialog')).toBeTruthy();
  await act(async () => { refreshedHistory.resolve(response({ commits: [] })); });
  expect(screen.queryByRole('dialog')).toBeNull();
});

test.each([
  { name: 'business error', make: () => response({ success: false, error: { message: 'Revert denied', details: { privatePath: '/secret' } } }), message: 'Revert denied' },
  { name: 'HTTP failure despite success envelope', make: () => response({ success: true }, 503), message: 'Revert local commit failed (HTTP 503)' },
  { name: 'invalid JSON', make: () => new Response('<html>private proxy details</html>', { status: 502 }), message: 'Revert local commit failed (HTTP 502)' },
  { name: 'unknown error object', make: () => response({ error: { code: 'PRIVATE' } }, 500), message: 'Git operation failed' },
])('revert $name stays visible, exposes safe feedback and can retry successfully', async ({ make, message }) => {
  calls.revertLocalCommit.mockResolvedValueOnce(make());
  render(<GitPanel selectedProject={projectA} />);
  await settle();
  const dialog = requestRevert();
  fireEvent.click(within(dialog).getByRole('button', { name: 'git:confirm.action.revertLocalCommit' }));
  await settle();
  expect(within(screen.getByRole('dialog')).getByRole('alert').textContent).toBe(message);
  expect(screen.getAllByRole('alert')).toHaveLength(2);
  expect(document.body.textContent).not.toMatch(/privatePath|PRIVATE|private proxy details|\[object Object\]/);
  expect(calls.status).toHaveBeenCalledTimes(1);
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'git:confirm.action.revertLocalCommit' }));
  await settle();
  expect(calls.revertLocalCommit).toHaveBeenCalledTimes(2);
  expect(calls.status).toHaveBeenCalledTimes(2);
  expect(calls.commits).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
});

test.each([true, false])('a stale revert success=%s cannot refresh, fail or close the new project confirmation', async success => {
  const stale = deferred<Response>();
  calls.revertLocalCommit.mockReturnValueOnce(stale.promise);
  const panel = render(<GitPanel selectedProject={projectA} />);
  await settle();
  let dialog = requestRevert();
  fireEvent.click(within(dialog).getByRole('button', { name: 'git:confirm.action.revertLocalCommit' }));
  panel.rerender(<GitPanel selectedProject={projectB} />);
  await settle();
  expect(screen.queryByRole('dialog')).toBeNull();
  dialog = requestRevert();
  await act(async () => { stale.resolve(response({ success, error: success ? undefined : 'Stale error' }, success ? 200 : 500)); });
  expect(screen.getByRole('dialog')).toBe(dialog);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(calls.status).toHaveBeenCalledTimes(2);
  expect((within(dialog).getByRole('button', { name: 'git:confirm.action.revertLocalCommit' }) as HTMLButtonElement).disabled).toBe(false);
});

test('A to B to A also suppresses stale revert completions', async () => {
  const stale = deferred<Response>();
  calls.revertLocalCommit.mockReturnValueOnce(stale.promise);
  const onSuccess = vi.fn();
  const onError = vi.fn();
  const hook = renderHook(({ projectId }) => useRevertLocalCommit({ projectId, onSuccess, onError }), {
    initialProps: { projectId: 'a' },
  });
  let operation!: Promise<void>;
  act(() => { operation = hook.result.current.revertLatestLocalCommit(); });
  hook.rerender({ projectId: 'b' });
  hook.rerender({ projectId: 'a' });
  onError.mockClear();
  await act(async () => { stale.resolve(response({ success: false, error: 'Old failure' })); await operation; });
  expect(onSuccess).not.toHaveBeenCalled();
  expect(onError).not.toHaveBeenCalled();
  expect(hook.result.current.isRevertingLocalCommit).toBe(false);
});
