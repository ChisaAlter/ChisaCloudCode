import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { GitSyncRecovery } from '@/modules/workspace-sync-recovery';
import type { ChisaGitRecovery, ChisaGitRecoveryResponse, ChisaSyncInfo } from '@/shared/types';

const native = vi.hoisted(() => ({
  getProjectGitRecovery: vi.fn<() => Promise<ChisaGitRecoveryResponse>>(),
  recoverProjectGit: vi.fn<() => Promise<Record<string, unknown>>>(),
  syncProject: vi.fn(),
}));

vi.mock('@/shared/chisa', () => ({ FrontendBridge: native }));

const PROJECT = '/srv/project-a';

function observation(overrides: Partial<ChisaSyncInfo> = {}): ChisaSyncInfo {
  return { serverPath: PROJECT, bindingEpoch: 'binding-a', sequence: 1, status: 'blocked', checkedAt: '', gitRecoveryRequired: true, ...overrides };
}

function snapshot(overrides: Partial<ChisaGitRecovery> = {}): ChisaGitRecovery {
  return {
    token: 'observation-a', serverPath: PROJECT, bindingEpoch: 'binding-a',
    local: { branch: 'feature/local', head: 'a'.repeat(40), staged: true, operation: 'merge' },
    remote: { branch: 'main', head: 'b'.repeat(40), staged: false, operation: '' },
    localAllowed: false, localReason: '本地仍有未解决的合并冲突。', remoteAllowed: true, remoteReason: '',
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function settle() {
  await act(async () => {});
}

async function open() {
  fireEvent.click(screen.getByRole('button', { name: '恢复 Git 状态' }));
  await settle();
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  native.getProjectGitRecovery.mockResolvedValue({ ok: true, recovery: snapshot() });
  native.recoverProjectGit.mockResolvedValue({ ok: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

test('the entry reads only on opening and neither polls nor starts a file transfer', async () => {
  render(<GitSyncRecovery info={observation()} onRecovered={vi.fn()} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  expect(native.getProjectGitRecovery).not.toHaveBeenCalled();
  await open();
  expect(native.getProjectGitRecovery).toHaveBeenCalledExactlyOnceWith(PROJECT, 'binding-a');
  const dialog = screen.getByRole('dialog', { name: '恢复 Git 同步状态' });
  expect(dialog).toBeDefined();
  // Settings already occupies layer 9999; its child review must render above it.
  expect(dialog.parentElement?.className).toContain('z-[10000]');
  await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  expect(native.getProjectGitRecovery).toHaveBeenCalledTimes(1);
  expect(native.recoverProjectGit).not.toHaveBeenCalled();
  expect(native.syncProject).not.toHaveBeenCalled();
});

test('a paused session after restart exposes an on-demand review without requiring a remembered failure', async () => {
  render(<GitSyncRecovery info={observation({ status: 'paused', gitRecoveryRequired: false })} onRecovered={vi.fn()} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  expect(screen.getByRole('button', { name: '恢复 Git 状态' })).toBeDefined();
  expect(native.getProjectGitRecovery).not.toHaveBeenCalled();
  await open();
  expect(native.getProjectGitRecovery).toHaveBeenCalledExactlyOnceWith(PROJECT, 'binding-a');
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '确认恢复 Git 状态' }).disabled).toBe(true);
  expect(screen.getAllByRole<HTMLInputElement>('radio').every(radio => !radio.checked)).toBe(true);
  expect(native.recoverProjectGit).not.toHaveBeenCalled();
  expect(native.syncProject).not.toHaveBeenCalled();
});

test('a paused project with an existing baseline shows the preview refusal without attempting synchronization', async () => {
  native.getProjectGitRecovery.mockResolvedValueOnce({ ok: false, error: '已有 Git 同步基线，请使用普通同步继续' });
  render(<GitSyncRecovery info={observation({ status: 'paused', gitRecoveryRequired: false })} onRecovered={vi.fn()} />);
  await open();
  expect(screen.getByRole('alert').textContent).toContain('请使用普通同步继续');
  expect(screen.queryByRole('radio')).toBeNull();
  expect(screen.queryByRole('button', { name: '确认恢复 Git 状态' })).toBeNull();
  expect(native.recoverProjectGit).not.toHaveBeenCalled();
  expect(native.syncProject).not.toHaveBeenCalled();
});

test.each(['task', 'connection'] as const)('a paused review is revoked by a new %s restriction', async restriction => {
  const paused = observation({ status: 'paused', gitRecoveryRequired: false });
  const view = render(<GitSyncRecovery info={paused} onRecovered={vi.fn()} />);
  await open();
  fireEvent.click(screen.getByRole('radio', { name: '以VPS Git 状态为准' }));
  view.rerender(<GitSyncRecovery info={restriction === 'task' ? { ...paused, taskOwner: 'pi' } : paused} unavailable={restriction === 'connection'} onRecovered={vi.fn()} />);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(native.recoverProjectGit).not.toHaveBeenCalled();
});

test('both observed Git states are shown and only an available explicitly chosen source can be confirmed', async () => {
  const onRecovered = vi.fn();
  render(<GitSyncRecovery info={observation()} onRecovered={onRecovered} />);
  await open();
  const local = within(screen.getByRole('group', { name: '本地 Git 状态' }));
  const remote = within(screen.getByRole('group', { name: 'VPS Git 状态' }));
  expect(local.getByText('feature/local')).toBeDefined();
  expect(local.getByText('a'.repeat(40))).toBeDefined();
  expect(local.getByText('有暂存变更')).toBeDefined();
  expect(local.getByText('merge')).toBeDefined();
  expect(remote.getByText('main')).toBeDefined();
  expect(remote.getByText('b'.repeat(40))).toBeDefined();
  expect(remote.getByText('无暂存变更')).toBeDefined();
  expect(remote.getByText('无', { exact: true })).toBeDefined();
  expect(local.getByText('本地仍有未解决的合并冲突。')).toBeDefined();
  expect(screen.getByText(/项目文件仍安全双向同步；文件冲突仍需处理/)).toBeDefined();

  const localChoice = screen.getByRole<HTMLInputElement>('radio', { name: '以本地 Git 状态为准' });
  const remoteChoice = screen.getByRole<HTMLInputElement>('radio', { name: '以VPS Git 状态为准' });
  const confirm = screen.getByRole<HTMLButtonElement>('button', { name: '确认恢复 Git 状态' });
  expect(localChoice.disabled).toBe(true);
  expect(remoteChoice.checked).toBe(false);
  expect(confirm.disabled).toBe(true);
  fireEvent.click(localChoice);
  fireEvent.click(confirm);
  expect(native.recoverProjectGit).not.toHaveBeenCalled();
  fireEvent.click(remoteChoice);
  fireEvent.click(confirm);
  await settle();
  expect(native.recoverProjectGit).toHaveBeenCalledExactlyOnceWith(PROJECT, 'binding-a', 'observation-a', 'remote');
  expect(onRecovered).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('status').textContent).toContain('Git 状态已恢复');
  expect(native.syncProject).not.toHaveBeenCalled();
});

test('neither unavailable source can be selected and both rejection reasons remain visible', async () => {
  native.getProjectGitRecovery.mockResolvedValueOnce({ ok: true, recovery: snapshot({ remoteAllowed: false, remoteReason: 'VPS Git 操作尚未结束。' }) });
  render(<GitSyncRecovery info={observation()} onRecovered={vi.fn()} />);
  await open();
  expect(screen.getAllByRole<HTMLInputElement>('radio').every(radio => radio.disabled)).toBe(true);
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '确认恢复 Git 状态' }).disabled).toBe(true);
  expect(screen.getByText('VPS Git 操作尚未结束。')).toBeDefined();
  expect(native.recoverProjectGit).not.toHaveBeenCalled();
});

test('a stale confirmation discards the choice and requires an explicit fresh review with its new token', async () => {
  native.recoverProjectGit.mockResolvedValueOnce({ ok: false, code: 'GIT_RECOVERY_STALE', error: 'Git HEAD 已发生变化' });
  native.getProjectGitRecovery.mockResolvedValueOnce({ ok: true, recovery: snapshot() })
    .mockResolvedValueOnce({ ok: true, recovery: snapshot({ token: 'observation-b', localAllowed: true }) });
  render(<GitSyncRecovery info={observation()} onRecovered={vi.fn()} />);
  await open();
  fireEvent.click(screen.getByRole('radio', { name: '以VPS Git 状态为准' }));
  fireEvent.click(screen.getByRole('button', { name: '确认恢复 Git 状态' }));
  await settle();
  expect(screen.getByRole('alert').textContent).toBe('Git HEAD 已发生变化');
  expect(screen.queryByRole('radio')).toBeNull();
  expect(screen.queryByRole('button', { name: '确认恢复 Git 状态' })).toBeNull();
  expect(native.getProjectGitRecovery).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: '重新查看' }));
  await settle();
  expect(screen.getAllByRole<HTMLInputElement>('radio').every(radio => !radio.checked)).toBe(true);
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '确认恢复 Git 状态' }).disabled).toBe(true);
  fireEvent.click(screen.getByRole('radio', { name: '以本地 Git 状态为准' }));
  fireEvent.click(screen.getByRole('button', { name: '确认恢复 Git 状态' }));
  await settle();
  expect(native.recoverProjectGit).toHaveBeenLastCalledWith(PROJECT, 'binding-a', 'observation-b', 'local');
});

test('a returned precondition failure permits retrying its unconsumed confirmation', async () => {
  native.recoverProjectGit.mockResolvedValueOnce({ ok: false, error: '任务正在使用工作区，请稍后重试。' });
  const onRecovered = vi.fn();
  render(<GitSyncRecovery info={observation()} onRecovered={onRecovered} />);
  await open();
  fireEvent.click(screen.getByRole('radio', { name: '以VPS Git 状态为准' }));
  fireEvent.click(screen.getByRole('button', { name: '确认恢复 Git 状态' }));
  await settle();
  expect(screen.getByRole('alert').textContent).toContain('重试');
  expect(screen.getByRole('group', { name: '本地 Git 状态' })).toBeDefined();
  expect(onRecovered).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '重试恢复' }));
  await settle();
  expect(native.getProjectGitRecovery).toHaveBeenCalledTimes(1);
  expect(native.recoverProjectGit).toHaveBeenCalledTimes(2);
  expect(native.recoverProjectGit).toHaveBeenLastCalledWith(PROJECT, 'binding-a', 'observation-a', 'remote');
  expect(onRecovered).toHaveBeenCalledTimes(1);
});

test.each(['consumed', 'disconnected'] as const)('a %s attempt discards its confirmation and requires a fresh observation and source choice', async mode => {
  const message = mode === 'consumed' ? 'Git 状态已写入，但文件同步未完成。' : '连接中断，恢复结果未知。';
  if (mode === 'consumed') native.recoverProjectGit.mockResolvedValueOnce({ ok: false, code: 'GIT_RECOVERY_RETRY', error: message });
  else native.recoverProjectGit.mockRejectedValueOnce(new Error(message));
  native.getProjectGitRecovery.mockResolvedValueOnce({ ok: true, recovery: snapshot() })
    .mockResolvedValueOnce({ ok: true, recovery: snapshot({ token: 'observation-b', localAllowed: true }) });
  const onRecovered = vi.fn();
  render(<GitSyncRecovery info={observation()} onRecovered={onRecovered} />);
  await open();
  fireEvent.click(screen.getByRole('radio', { name: '以VPS Git 状态为准' }));
  fireEvent.click(screen.getByRole('button', { name: '确认恢复 Git 状态' }));
  await settle();
  expect(screen.getByRole('alert').textContent).toBe(message);
  expect(screen.queryByRole('radio')).toBeNull();
  expect(screen.queryByRole('button', { name: /确认恢复|重试恢复/ })).toBeNull();
  expect(screen.queryByRole('status')).toBeNull();
  expect(onRecovered).not.toHaveBeenCalled();
  expect(native.getProjectGitRecovery).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: '刷新项目状态' }));
  await settle();
  expect(onRecovered).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('alert').textContent).toBe(message);
  expect(screen.queryByRole('status')).toBeNull();
  expect(native.recoverProjectGit).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: '重新查看' }));
  await settle();
  expect(native.getProjectGitRecovery).toHaveBeenCalledTimes(2);
  expect(screen.getAllByRole<HTMLInputElement>('radio').every(radio => !radio.checked)).toBe(true);
  const confirm = screen.getByRole<HTMLButtonElement>('button', { name: '确认恢复 Git 状态' });
  expect(confirm.disabled).toBe(true);
  fireEvent.click(confirm);
  expect(native.recoverProjectGit).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('radio', { name: '以本地 Git 状态为准' }));
  fireEvent.click(confirm);
  await settle();
  expect(native.recoverProjectGit).toHaveBeenLastCalledWith(PROJECT, 'binding-a', 'observation-b', 'local');
  expect(onRecovered).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('status').textContent).toContain('Git 状态已恢复');
  expect(native.syncProject).not.toHaveBeenCalled();
});

test('an incomplete file sync can return to ordinary synchronization after checking authoritative status', async () => {
  const message = '文件同步未完成，请继续普通同步。';
  native.recoverProjectGit.mockResolvedValueOnce({ ok: false, code: 'GIT_RECOVERY_RETRY', error: message });
  native.getProjectGitRecovery.mockResolvedValueOnce({ ok: true, recovery: snapshot() })
    .mockResolvedValueOnce({ ok: false, error: message });
  const onRecovered = vi.fn();
  const view = render(<GitSyncRecovery info={observation()} onRecovered={onRecovered} />);
  await open();
  fireEvent.click(screen.getByRole('radio', { name: '以VPS Git 状态为准' }));
  fireEvent.click(screen.getByRole('button', { name: '确认恢复 Git 状态' }));
  await settle();
  fireEvent.click(screen.getByRole('button', { name: '重新查看' }));
  await settle();
  expect(screen.getByRole('alert').textContent).toBe(message);
  expect(screen.queryByRole('radio')).toBeNull();
  expect(screen.queryByRole('status')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '刷新项目状态' }));
  expect(onRecovered).toHaveBeenCalledTimes(1);
  view.rerender(<GitSyncRecovery info={observation({ status: 'needs-sync', sequence: 2, gitRecoveryRequired: false })} onRecovered={onRecovered} />);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryByRole('button', { name: '恢复 Git 状态' })).toBeNull();
  expect(native.recoverProjectGit).toHaveBeenCalledTimes(1);
  expect(native.syncProject).not.toHaveBeenCalled();
});

test('an unavailable read can be retried explicitly without confirming anything', async () => {
  native.getProjectGitRecovery.mockRejectedValueOnce(new Error('连接不可用'));
  render(<GitSyncRecovery info={observation()} onRecovered={vi.fn()} />);
  await open();
  expect(screen.getByRole('alert').textContent).toBe('连接不可用');
  expect(screen.queryByRole('radio')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '重试查看' }));
  await settle();
  expect(native.getProjectGitRecovery).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('group', { name: 'VPS Git 状态' })).toBeDefined();
  expect(native.recoverProjectGit).not.toHaveBeenCalled();
});

test('closing during a read rejects its late response and reopening gets a fresh observation', async () => {
  const first = deferred<ChisaGitRecoveryResponse>();
  native.getProjectGitRecovery.mockReturnValueOnce(first.promise);
  render(<GitSyncRecovery info={observation()} onRecovered={vi.fn()} />);
  await open();
  fireEvent.click(screen.getByRole('button', { name: '关闭' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  await open();
  await act(async () => { first.resolve({ ok: true, recovery: snapshot({ token: 'late-token', remote: { branch: 'wrong-old-branch', head: '', staged: false, operation: '' } }) }); });
  expect(native.getProjectGitRecovery).toHaveBeenCalledTimes(2);
  expect(screen.queryByText('wrong-old-branch')).toBeNull();
  fireEvent.click(screen.getByRole('radio', { name: '以VPS Git 状态为准' }));
  fireEvent.click(screen.getByRole('button', { name: '确认恢复 Git 状态' }));
  await settle();
  expect(native.recoverProjectGit).toHaveBeenCalledWith(PROJECT, 'binding-a', 'observation-a', 'remote');
});

test('changing the binding invalidates the old dialog and binds the next confirmation to the new epoch', async () => {
  const view = render(<GitSyncRecovery info={observation()} onRecovered={vi.fn()} />);
  await open();
  fireEvent.click(screen.getByRole('radio', { name: '以VPS Git 状态为准' }));
  view.rerender(<GitSyncRecovery info={observation({ bindingEpoch: 'binding-b', sequence: 2 })} onRecovered={vi.fn()} />);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(native.recoverProjectGit).not.toHaveBeenCalled();
  native.getProjectGitRecovery.mockResolvedValueOnce({ ok: true, recovery: snapshot({ bindingEpoch: 'binding-b', token: 'binding-b-token' }) });
  await open();
  expect(native.getProjectGitRecovery).toHaveBeenLastCalledWith(PROJECT, 'binding-b');
  fireEvent.click(screen.getByRole('radio', { name: '以VPS Git 状态为准' }));
  fireEvent.click(screen.getByRole('button', { name: '确认恢复 Git 状态' }));
  await settle();
  expect(native.recoverProjectGit).toHaveBeenCalledExactlyOnceWith(PROJECT, 'binding-b', 'binding-b-token', 'remote');
});

test.each([
  { status: 'ready' }, { status: 'unavailable' }, { status: 'disconnected' }, { status: 'reserved' },
  { gitRecoveryRequired: false }, { taskOwner: 'claude' as const }, { taskOwner: 'pi' as const }, { bindingEpoch: '' },
])('recovery is absent for ineligible state %j', async overrides => {
  render(<GitSyncRecovery info={observation(overrides)} onRecovered={vi.fn()} />);
  await settle();
  expect(screen.queryByRole('button')).toBeNull();
  expect(native.getProjectGitRecovery).not.toHaveBeenCalled();
});

test.each(['task', 'connection'] as const)('a new %s restriction dismisses the review and revokes confirmation', async restriction => {
  const view = render(<GitSyncRecovery info={observation()} onRecovered={vi.fn()} />);
  await open();
  fireEvent.click(screen.getByRole('radio', { name: '以VPS Git 状态为准' }));
  view.rerender(<GitSyncRecovery info={observation(restriction === 'task' ? { taskOwner: 'pi' } : {})} unavailable={restriction === 'connection'} onRecovered={vi.fn()} />);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryByRole('button')).toBeNull();
  expect(native.recoverProjectGit).not.toHaveBeenCalled();
});

test.each(['project', 'epoch'] as const)('a recovery observation for another %s never becomes confirmable', async mismatch => {
  native.getProjectGitRecovery.mockResolvedValueOnce({ ok: true, recovery: snapshot(mismatch === 'project' ? { serverPath: '/srv/other' } : { bindingEpoch: 'old-binding' }) });
  render(<GitSyncRecovery info={observation()} onRecovered={vi.fn()} />);
  await open();
  expect(screen.queryByRole('radio')).toBeNull();
  expect(screen.getByRole('button', { name: '重新查看' })).toBeDefined();
  expect(native.recoverProjectGit).not.toHaveBeenCalled();
});

test('recovery submits once, locks the selection and keeps the dialog open until it finishes', async () => {
  const pending = deferred<Record<string, unknown>>();
  native.recoverProjectGit.mockReturnValueOnce(pending.promise);
  render(<GitSyncRecovery info={observation()} onRecovered={vi.fn()} />);
  await open();
  fireEvent.click(screen.getByRole('radio', { name: '以VPS Git 状态为准' }));
  fireEvent.click(screen.getByRole('button', { name: '确认恢复 Git 状态' }));
  fireEvent.click(screen.getByRole('button', { name: '恢复中…' }));
  fireEvent.click(screen.getByRole('button', { name: '关闭' }));
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(native.recoverProjectGit).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('dialog').getAttribute('aria-busy')).toBe('true');
  expect(screen.getAllByRole<HTMLInputElement>('radio').every(radio => radio.disabled)).toBe(true);
  await act(async () => { pending.resolve({ ok: true }); });
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '关闭' }).disabled).toBe(false);
});
