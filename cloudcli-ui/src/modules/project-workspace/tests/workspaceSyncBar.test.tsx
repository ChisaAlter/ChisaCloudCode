import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { PaletteOpsProvider, usePaletteOpsRegister } from '@/modules/command-palette';
import { WorkspaceSyncBar } from '@/modules/project-workspace/WorkspaceSyncBar';
import type { ChisaGitRecoveryResponse, ChisaSyncInfo, ChisaWorkspaceSyncEvent } from '@/shared/types';

const native = vi.hoisted(() => ({
  desktop: true,
  connectionVersion: 0,
  authVersion: 0,
  getProjectSync: vi.fn<(serverPath: string) => Promise<ChisaSyncInfo>>(),
  syncProject: vi.fn<(serverPath: string) => Promise<Record<string, unknown>>>(),
  confirmProjectEmpty: vi.fn<(serverPath: string, bindingEpoch: string) => Promise<Record<string, unknown>>>(),
  getProjectGitRecovery: vi.fn<() => Promise<ChisaGitRecoveryResponse>>(),
  recoverProjectGit: vi.fn<() => Promise<Record<string, unknown>>>(),
  listeners: new Set<(info: ChisaSyncInfo) => void>(),
  operationListeners: new Set<(event: ChisaWorkspaceSyncEvent) => void>(),
}));

vi.mock('@/shared/hooks/useComponentVersions', () => ({ useComponentVersions: () => ({ client: {}, frontend: {}, server: {}, refresh: vi.fn(), loading: false }) }));

vi.mock('@/shared/authToken', () => ({ AUTH_IDENTITY_CHANGED_EVENT: 'auth-identity-changed', getAuthSessionVersion: () => native.authVersion }));

vi.mock('@/shared/chisa', () => ({
  SERVER_CONNECTION_CHANGED_EVENT: 'server-connection-changed',
  getServerConnectionVersion: () => native.connectionVersion,
  isDesktop: () => native.desktop,
  FrontendBridge: { getProjectSync: native.getProjectSync, syncProject: native.syncProject, confirmProjectEmpty: native.confirmProjectEmpty, getProjectGitRecovery: native.getProjectGitRecovery, recoverProjectGit: native.recoverProjectGit },
  onWorkspaceSyncStateChanged: (listener: (info: ChisaSyncInfo) => void) => {
    native.listeners.add(listener);
    return () => native.listeners.delete(listener);
  },
  onWorkspaceSyncChanged: (listener: (event: ChisaWorkspaceSyncEvent) => void) => {
    native.operationListeners.add(listener);
    return () => native.operationListeners.delete(listener);
  },
}));

const PROJECT = '/srv/project-a';
let sequence = 0;

function observation(status: string, serverPath = PROJECT, version = ++sequence): ChisaSyncInfo {
  return { status, serverPath, bindingEpoch: 'binding-a', sequence: version, localPath: 'C:\\work\\project', checkedAt: '2026-10-06T04:00:00Z' };
}

function emptyObservation(bindingEpoch = 'binding-a'): ChisaSyncInfo {
  return { ...observation('blocked'), bindingEpoch, engineStatus: 'halted-on-root-emptied', emptySide: 'local' };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function syncButton() {
  return screen.getByRole<HTMLButtonElement>('button', { name: /立即同步|同步中/ });
}

function statusText() {
  return screen.getByRole('status').textContent;
}

function emit(info: ChisaSyncInfo) {
  act(() => native.listeners.forEach(listener => listener(info)));
}

async function settle() {
  await act(async () => {});
}

async function tick(milliseconds: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  native.desktop = true;
  native.connectionVersion = 0;
  native.authVersion = 0;
  sequence = 0;
  native.listeners.clear();
  native.operationListeners.clear();
  native.getProjectSync.mockImplementation(async serverPath => observation('ready', serverPath));
  native.syncProject.mockResolvedValue({ ok: true });
  native.confirmProjectEmpty.mockResolvedValue({ ok: true });
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

test('completed manual sync releases its busy state while the follow-up snapshot is still pending', async () => {
  const snapshot = deferred<ChisaSyncInfo>();
  native.getProjectSync.mockResolvedValueOnce(observation('ready')).mockReturnValueOnce(snapshot.promise);
  render(<WorkspaceSyncBar serverPath={PROJECT} />);
  await settle();
  fireEvent.click(syncButton());
  await settle();
  expect(native.syncProject).toHaveBeenCalledExactlyOnceWith(PROJECT);
  expect(syncButton().disabled).toBe(false);
  expect(statusText()).toBe('已同步');
  await act(async () => { snapshot.resolve(observation('ready')); });
});

test('multiline synchronization failures stay in details and the banner shows a concise summary', async () => {
  const detail = '同步确认已中断: Traceback (most recent call last):\nRuntimeError: docs/example.md: unmerged\nfatal: git-write-tree: error building trees';
  native.getProjectSync.mockResolvedValueOnce({ ...observation('blocked'), detail });
  render(<WorkspaceSyncBar serverPath={PROJECT} />);
  await settle();
  expect(screen.getByRole('alert').textContent).toBe('Git 合并冲突导致同步未完成，请查看详情。当前修改已保留。');
  expect(screen.getByRole('alert').textContent).not.toContain('Traceback');
  expect(screen.getByText(/RuntimeError:/).closest('details')).not.toBeNull();
});

test('the browser-only workspace does not expose native synchronization or call the bridge', async () => {
  native.desktop = false;
  const view = render(<WorkspaceSyncBar serverPath={PROJECT} />);
  await tick(10000);
  expect(view.container.childElementCount).toBe(0);
  expect(native.getProjectSync).not.toHaveBeenCalled();
  expect(native.syncProject).not.toHaveBeenCalled();
  expect(native.listeners.size).toBe(0);
});

test('a cached ready operation event cannot turn green without an authoritative engine observation', async () => {
  native.getProjectSync.mockResolvedValueOnce(observation('syncing'));
  render(<WorkspaceSyncBar serverPath={PROJECT} />);
  await settle();
  expect(statusText()).toBe('处理同步');

  act(() => native.operationListeners.forEach(listener => listener({ serverPath: PROJECT, status: 'ready' })));
  expect(statusText()).toBe('处理同步');
  expect(native.getProjectSync).toHaveBeenCalledTimes(1);
  emit(observation('ready'));
  expect(statusText()).toBe('已同步');
  expect(syncButton().disabled).toBe(false);
  expect(screen.queryByText('状态检查于', { exact: false })).toBeNull();
});

test('manual synchronization targets the selected project and releases busy before engine confirmation', async () => {
  const transfer = deferred<Record<string, unknown>>();
  const confirmed = deferred<ChisaSyncInfo>();
  native.getProjectSync.mockResolvedValueOnce(observation('needs-sync'));
  native.getProjectSync.mockReturnValueOnce(confirmed.promise);
  native.syncProject.mockReturnValueOnce(transfer.promise);
  render(<WorkspaceSyncBar serverPath={PROJECT} />);
  await settle();

  fireEvent.click(syncButton());
  expect(native.syncProject).toHaveBeenCalledWith(PROJECT);
  expect(syncButton().disabled).toBe(true);
  expect(syncButton().getAttribute('aria-busy')).toBe('true');
  fireEvent.click(syncButton());
  expect(native.syncProject).toHaveBeenCalledTimes(1);

  await act(async () => { transfer.resolve({ ok: true }); });
  expect(native.getProjectSync).toHaveBeenLastCalledWith(PROJECT);
  expect(statusText()).toBe('需要同步');
  expect(syncButton().disabled).toBe(false);
  await act(async () => { confirmed.resolve(observation('ready')); });
  expect(statusText()).toBe('已同步');
  expect(syncButton().disabled).toBe(false);
});

test('a manual failure opens details without masking a new reservation or a recovered engine', async () => {
  native.syncProject.mockResolvedValueOnce({ ok: false, error: 'Transfer failed' });
  render(<WorkspaceSyncBar serverPath={PROJECT} />);
  await settle();
  fireEvent.click(syncButton());
  await settle();
  expect(statusText()).toBe('已同步');
  expect(screen.getByText('上次手动同步失败：Transfer failed')).toBeDefined();
  expect(screen.getByText('详情').closest('details')?.open).toBe(true);
  expect(screen.getByRole('alert').textContent).toContain('Transfer failed');
  expect(syncButton().disabled).toBe(false);

  emit(observation('reserved'));
  expect(statusText()).toBe('云端任务执行中');
  expect(syncButton().disabled).toBe(true);

  fireEvent.focus(window);
  await settle();
  expect(statusText()).toBe('已同步');
  expect(syncButton().disabled).toBe(false);
  expect(screen.getByText('上次手动同步失败：Transfer failed')).toBeDefined();
});

test('an unavailable engine query reports uncertainty rather than retaining green', async () => {
  native.getProjectSync.mockRejectedValueOnce(new Error('Daemon unavailable'));
  render(<WorkspaceSyncBar serverPath={PROJECT} />);
  await settle();
  expect(statusText()).toBe('状态连接已中断');
  expect(screen.getByRole('alert').textContent).toBe('Daemon unavailable');
});

test.each(['claude', 'pi'] as const)('the %s task prevents a manual transfer while explaining that automatic sync continues', async taskOwner => {
  native.getProjectSync.mockResolvedValueOnce({ ...observation('reserved'), taskOwner });
  render(<WorkspaceSyncBar serverPath={PROJECT} />);
  await settle();
  expect(statusText()).toBe(taskOwner === 'pi' ? 'Pi 正在操作项目' : '云端任务执行中');
  expect(syncButton().disabled).toBe(true);
  expect(syncButton().title).toBe('任务正在使用工作区，自动同步继续运行；任务结束后可手动同步');
  expect(screen.getByText('任务正在使用工作区，自动同步继续运行；任务结束后可手动同步。').closest('details')).not.toBeNull();
  expect(screen.queryByText(/暂停自动同步/)).toBeNull();
  fireEvent.click(syncButton());
  expect(native.syncProject).not.toHaveBeenCalled();
});

test('an unbound project opens the registered sync settings without implying that a folder picker binds it', async () => {
  const openSettings = vi.fn();
  function RegisteredSyncBar() {
    usePaletteOpsRegister({ openSettings });
    return <WorkspaceSyncBar serverPath={PROJECT} />;
  }
  native.getProjectSync.mockResolvedValueOnce({ ...observation('unbound'), bindingEpoch: '', localPath: undefined });
  render(<PaletteOpsProvider><RegisteredSyncBar /></PaletteOpsProvider>);
  await settle();

  expect(statusText()).toBe('未绑定本地目录');
  expect(screen.queryByRole('button', { name: '立即同步' })).toBeNull();
  expect(screen.getByText('当前 VPS 项目尚未绑定本地目录。打开本地目录会进入其对应项目。').closest('details')).toBeNull();
  expect(screen.getByText(/此操作不会把本地目录绑定到当前 VPS 项目/).closest('details')).not.toBeNull();
  const settings = screen.getByRole<HTMLButtonElement>('button', { name: '查看同步设置' });
  expect(settings.disabled).toBe(false);
  fireEvent.click(settings);
  expect(openSettings).toHaveBeenCalledExactlyOnceWith('chisa');
  expect(native.syncProject).not.toHaveBeenCalled();
  expect(native.confirmProjectEmpty).not.toHaveBeenCalled();

  emit(observation('ready'));
  expect(screen.queryByRole('button', { name: '查看同步设置' })).toBeNull();
  expect(screen.queryByText(/当前 VPS 项目尚未绑定本地目录/)).toBeNull();
  expect(syncButton().disabled).toBe(false);
});

test('a newer reservation observation defeats a slow ready snapshot without launching another query', async () => {
  const stale = deferred<ChisaSyncInfo>();
  const staleReady = observation('ready');
  native.getProjectSync.mockReturnValueOnce(stale.promise);
  render(<WorkspaceSyncBar serverPath={PROJECT} />);
  emit(observation('reserved'));
  expect(statusText()).toBe('云端任务执行中');

  await act(async () => { stale.resolve(staleReady); });
  expect(native.getProjectSync).toHaveBeenCalledTimes(1);
  expect(statusText()).toBe('云端任务执行中');
  expect(syncButton().disabled).toBe(true);
});

test('a slow manual ready snapshot cannot overwrite a newer engine observation', async () => {
  const staleManual = deferred<ChisaSyncInfo>();
  const initialReady = observation('ready');
  const staleReady = observation('ready');
  native.getProjectSync.mockResolvedValueOnce(initialReady)
    .mockReturnValueOnce(staleManual.promise);
  render(<WorkspaceSyncBar serverPath={PROJECT} />);
  await settle();
  fireEvent.click(syncButton());
  await settle();
  expect(native.getProjectSync).toHaveBeenCalledTimes(2);

  emit(observation('syncing'));
  expect(native.getProjectSync).toHaveBeenCalledTimes(2);
  await act(async () => { staleManual.resolve(staleReady); });
  expect(statusText()).toBe('处理同步');
  expect(syncButton().getAttribute('aria-busy')).toBe('false');
});

test('a slow focus snapshot cannot overwrite a newer manual reservation confirmation', async () => {
  const staleFocus = deferred<ChisaSyncInfo>();
  const initialReady = observation('ready');
  const staleReady = observation('ready');
  native.getProjectSync.mockResolvedValueOnce(initialReady)
    .mockReturnValueOnce(staleFocus.promise)
    .mockImplementationOnce(async () => observation('reserved'));
  render(<WorkspaceSyncBar serverPath={PROJECT} />);
  await settle();
  fireEvent.focus(window);
  fireEvent.click(syncButton());
  await settle();
  expect(native.getProjectSync).toHaveBeenCalledTimes(2);

  emit(observation('reserved'));
  await act(async () => { staleFocus.resolve(staleReady); });
  expect(native.getProjectSync).toHaveBeenCalledTimes(3);
  expect(statusText()).toBe('云端任务执行中');
  expect(syncButton().disabled).toBe(true);
});

test('switching projects isolates old query replies and events from the visible project', async () => {
  const stale = deferred<ChisaSyncInfo>();
  native.getProjectSync.mockReturnValueOnce(stale.promise);
  const view = render(<WorkspaceSyncBar key={PROJECT} serverPath={PROJECT} />);
  const nextProject = '/srv/project-b';
  view.rerender(<WorkspaceSyncBar key={nextProject} serverPath={nextProject} />);
  await settle();
  expect(statusText()).toBe('已同步');
  expect(screen.getByText(nextProject).closest('details')).not.toBeNull();

  emit(observation('reserved', PROJECT));
  await act(async () => { stale.resolve(observation('blocked')); });
  expect(statusText()).toBe('已同步');
  expect(native.getProjectSync).toHaveBeenCalledTimes(2);
  fireEvent.focus(window);
  await settle();
  expect(native.getProjectSync).toHaveBeenLastCalledWith(nextProject);
});

test('completing the former project manual action cannot alter the newly selected project', async () => {
  const transfer = deferred<Record<string, unknown>>();
  native.syncProject.mockReturnValueOnce(transfer.promise);
  native.getProjectSync.mockImplementation(async serverPath => observation(serverPath === PROJECT ? 'needs-sync' : 'ready', serverPath));
  const view = render(<WorkspaceSyncBar key={PROJECT} serverPath={PROJECT} />);
  await settle();
  fireEvent.click(syncButton());
  const nextProject = '/srv/project-b';
  view.rerender(<WorkspaceSyncBar key={nextProject} serverPath={nextProject} />);
  await settle();

  await act(async () => { transfer.resolve({ ok: false, error: 'Old project failed' }); });
  expect(statusText()).toBe('已同步');
  expect(screen.queryByRole('alert')).toBeNull();
  fireEvent.click(syncButton());
  expect(native.syncProject).toHaveBeenLastCalledWith(nextProject);
  await settle();
});

test('hidden windows skip snapshots and a visible return refreshes without a transient checking state', async () => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get');
  render(<WorkspaceSyncBar serverPath={PROJECT} />);
  await settle();
  expect(statusText()).toBe('已同步');
  visibility.mockReturnValue('hidden');
  fireEvent(document, new Event('visibilitychange'));
  await tick(10000);
  expect(native.getProjectSync).toHaveBeenCalledTimes(1);

  const confirmed = deferred<ChisaSyncInfo>();
  native.getProjectSync.mockReturnValueOnce(confirmed.promise);
  visibility.mockReturnValue('visible');
  fireEvent(document, new Event('visibilitychange'));
  expect(statusText()).toBe('已同步');
  expect(syncButton().disabled).toBe(false);
  await act(async () => { confirmed.resolve(observation('syncing')); });
  expect(statusText()).toBe('处理同步');
  expect(native.getProjectSync).toHaveBeenCalledTimes(2);
});

test('idle ready state remains quiet for ten seconds without bridge queries or changing inspection time', async () => {
  render(<WorkspaceSyncBar serverPath={PROJECT} />);
  await settle();
  await tick(10000);
  expect(statusText()).toBe('已同步');
  expect(native.getProjectSync).toHaveBeenCalledTimes(1);
  expect(native.syncProject).not.toHaveBeenCalled();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByText(/状态检查于|04:00:00/)).toBeNull();
  expect(screen.getByText('详情').closest('details')?.open).toBe(false);
});

test('normal change checking keeps diagnostics folded and does not become a warning or disable manual sync', async () => {
  const checking = { ...observation('checking'), detail: 'Scanning project changes' };
  native.getProjectSync.mockResolvedValueOnce(checking);
  render(<WorkspaceSyncBar serverPath={PROJECT} />);
  await settle();
  expect(statusText()).toBe('检查变更');
  expect(screen.queryByRole('alert')).toBeNull();
  expect(syncButton().disabled).toBe(false);
  const details = screen.getByText('详情').closest('details');
  expect(details?.open).toBe(false);
  expect(screen.getByText(checking.localPath!).closest('details')).toBe(details);
  expect(screen.getByText(PROJECT).closest('details')).toBe(details);
  expect(screen.getByText(checking.detail).closest('details')).toBe(details);
  fireEvent.click(screen.getByText('详情'));
  expect(details?.open).toBe(true);
});

test('old and duplicate events cannot hide a failed refresh and leave obsolete green', async () => {
  const ready = observation('ready', PROJECT, 10);
  const snapshot = deferred<ChisaSyncInfo>();
  native.getProjectSync.mockResolvedValueOnce(ready).mockReturnValueOnce(snapshot.promise);
  render(<WorkspaceSyncBar serverPath={PROJECT} />);
  await settle();
  fireEvent.focus(window);
  emit(observation('ready', PROJECT, 9));
  emit(ready);
  await act(async () => { snapshot.reject(new Error('State stream lost')); });
  expect(statusText()).toBe('状态连接已中断');
  expect(screen.getByRole('alert').textContent).toBe('State stream lost');
});

test.each(['claude', 'pi'] as const)('a failed refresh does not release the %s workspace reservation', async taskOwner => {
  native.getProjectSync.mockResolvedValueOnce({ ...observation('reserved'), taskOwner })
    .mockRejectedValueOnce(new Error('State query failed'));
  render(<WorkspaceSyncBar serverPath={PROJECT} />);
  await settle();
  expect(statusText()).toBe(taskOwner === 'pi' ? 'Pi 正在操作项目' : '云端任务执行中');
  fireEvent.focus(window);
  await settle();
  expect(statusText()).toBe('状态连接已中断');
  expect(syncButton().disabled).toBe(true);
  fireEvent.click(syncButton());
  expect(native.syncProject).not.toHaveBeenCalled();
});

test.each(['claude', 'pi'] as const)('a new unavailable engine observation retains the %s workspace owner and button lock', async taskOwner => {
  native.getProjectSync.mockResolvedValueOnce({ ...observation('reserved'), taskOwner });
  render(<WorkspaceSyncBar serverPath={PROJECT} />);
  await settle();
  emit({ ...observation('unavailable'), taskOwner, detail: 'Engine state stream disconnected' });
  expect(statusText()).toBe('状态连接已中断');
  expect(screen.getByRole('alert').textContent).toBe('Engine state stream disconnected');
  expect(syncButton().disabled).toBe(true);
  fireEvent.click(syncButton());
  expect(native.syncProject).not.toHaveBeenCalled();
});

test('a disconnected engine is not green and preserves an explicit manual recovery action', async () => {
  native.getProjectSync.mockResolvedValueOnce({ ...observation('disconnected'), detail: 'VPS endpoint disconnected' });
  render(<WorkspaceSyncBar serverPath={PROJECT} />);
  await settle();
  expect(statusText()).toBe('连接已断开');
  expect(screen.getByRole('alert').textContent).toBe('VPS endpoint disconnected');
  expect(syncButton().disabled).toBe(false);
  fireEvent.click(syncButton());
  await settle();
  expect(native.syncProject).toHaveBeenCalledWith(PROJECT);
  expect(statusText()).toBe('已同步');
});

test('a late old binding ready event cannot replace a newer binding snapshot', async () => {
  const oldReady = observation('ready');
  const focus = deferred<ChisaSyncInfo>();
  native.getProjectSync.mockResolvedValueOnce(oldReady).mockReturnValueOnce(focus.promise);
  render(<WorkspaceSyncBar serverPath={PROJECT} />);
  await settle();
  fireEvent.focus(window);
  const replacedBinding = { ...observation('reserved'), bindingEpoch: 'binding-b' };
  await act(async () => { focus.resolve(replacedBinding); });
  expect(statusText()).toBe('云端任务执行中');
  emit(oldReady);
  expect(statusText()).toBe('云端任务执行中');
  expect(syncButton().disabled).toBe(true);
});

test('empty-root synchronization requires an explicit VPS confirmation and cancellation leaves files untouched', async () => {
  native.getProjectSync.mockResolvedValueOnce(emptyObservation());
  render(<WorkspaceSyncBar serverPath={PROJECT} />);
  await settle();

  fireEvent.click(screen.getByRole('button', { name: '确认同步清空' }));
  const confirmation = screen.getByRole('group', { name: '确认同步清空 VPS' });
  expect(confirmation.textContent).toContain(PROJECT);
  expect(confirmation.textContent).toContain('忽略文件保留');
  expect(native.syncProject).not.toHaveBeenCalled();
  expect(native.confirmProjectEmpty).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(screen.queryByRole('group', { name: '确认同步清空 VPS' })).toBeNull();
  expect(native.syncProject).not.toHaveBeenCalled();
  expect(native.confirmProjectEmpty).not.toHaveBeenCalled();
});

test('confirmed VPS clearing sends the displayed project binding once and waits for the native result', async () => {
  const clearing = deferred<Record<string, unknown>>();
  native.getProjectSync.mockResolvedValueOnce(emptyObservation('binding-current'));
  native.confirmProjectEmpty.mockReturnValueOnce(clearing.promise);
  render(<WorkspaceSyncBar serverPath={PROJECT} />);
  await settle();

  fireEvent.click(screen.getByRole('button', { name: '确认同步清空' }));
  fireEvent.click(screen.getByRole('button', { name: '确认清空 VPS' }));
  expect(native.confirmProjectEmpty).toHaveBeenCalledExactlyOnceWith(PROJECT, 'binding-current');
  expect(native.syncProject).not.toHaveBeenCalled();
  expect(screen.queryByRole('group', { name: '确认同步清空 VPS' })).toBeNull();
  expect(syncButton().disabled).toBe(true);
  fireEvent.click(syncButton());
  expect(native.confirmProjectEmpty).toHaveBeenCalledTimes(1);

  await act(async () => { clearing.resolve({ ok: true, clearState: 'completed', backupPath: '/srv/project-a.chisa-sync-backups/backup-1' }); });
  expect(native.getProjectSync).toHaveBeenLastCalledWith(PROJECT);
  expect(syncButton().disabled).toBe(false);
});

test('a replacement binding closes old consent and a stale observation cannot authorize the old binding', async () => {
  const oldBinding = emptyObservation();
  native.getProjectSync.mockResolvedValueOnce(oldBinding);
  render(<WorkspaceSyncBar serverPath={PROJECT} />);
  await settle();
  fireEvent.click(screen.getByRole('button', { name: '确认同步清空' }));

  emit(emptyObservation('binding-b'));
  expect(screen.queryByRole('group', { name: '确认同步清空 VPS' })).toBeNull();
  emit(oldBinding);
  expect(screen.queryByRole('group', { name: '确认同步清空 VPS' })).toBeNull();
  expect(native.confirmProjectEmpty).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: '确认同步清空' }));
  fireEvent.click(screen.getByRole('button', { name: '确认清空 VPS' }));
  expect(native.confirmProjectEmpty).toHaveBeenCalledExactlyOnceWith(PROJECT, 'binding-b');
  await settle();
});

test.each(['claude', 'pi'] as const)('a new %s owner closes empty-root consent and prevents destructive synchronization', async taskOwner => {
  native.getProjectSync.mockResolvedValueOnce(emptyObservation());
  render(<WorkspaceSyncBar serverPath={PROJECT} />);
  await settle();
  fireEvent.click(screen.getByRole('button', { name: '确认同步清空' }));

  emit({ ...emptyObservation(), taskOwner });
  expect(screen.queryByRole('group', { name: '确认同步清空 VPS' })).toBeNull();
  const button = screen.getByRole<HTMLButtonElement>('button', { name: '确认同步清空' });
  expect(button.disabled).toBe(true);
  fireEvent.click(button);
  expect(native.confirmProjectEmpty).not.toHaveBeenCalled();
  expect(native.syncProject).not.toHaveBeenCalled();
});

test('a failed native clear retains the recoverable VPS backup location alongside the error', async () => {
  const backupPath = '/srv/project-a.chisa-sync-backups/recoverable-backup';
  native.getProjectSync.mockResolvedValueOnce(emptyObservation());
  native.confirmProjectEmpty.mockResolvedValueOnce({ ok: false, clearState: 'completed', error: 'Synchronization restart failed', backupPath });
  render(<WorkspaceSyncBar serverPath={PROJECT} />);
  await settle();

  fireEvent.click(screen.getByRole('button', { name: '确认同步清空' }));
  fireEvent.click(screen.getByRole('button', { name: '确认清空 VPS' }));
  await settle();

  expect(screen.getByText(`VPS 可同步文件已移入备份：${backupPath}`)).toBeDefined();
  expect(screen.getByRole('alert')).toBeDefined();
  expect(screen.getByText('详情').closest('details')?.open).toBe(true);
  expect(native.confirmProjectEmpty).toHaveBeenCalledExactlyOnceWith(PROJECT, 'binding-a');
});


test.each(['not-started', 'unknown'] as const)('a %s clear never advertises an unconfirmed backup', async clearState => {
  native.getProjectSync.mockResolvedValueOnce(emptyObservation());
  native.confirmProjectEmpty.mockResolvedValueOnce({ ok: false, clearState, backupPath: '/predicted-only', error: 'worker failed' });
  render(<WorkspaceSyncBar serverPath={PROJECT} />);
  await settle();
  fireEvent.click(screen.getByRole('button', { name: '确认同步清空' }));
  fireEvent.click(screen.getByRole('button', { name: '确认清空 VPS' }));
  await settle();
  expect(screen.queryByText('/predicted-only', { exact: false })).toBeNull();
  expect(screen.getByRole('alert').textContent).toContain(clearState === 'not-started' ? '未移动文件' : '结果未知');
});

test('partial clearing describes only the moved files as recoverable', async () => {
  native.getProjectSync.mockResolvedValueOnce(emptyObservation());
  native.confirmProjectEmpty.mockResolvedValueOnce({ ok: false, clearState: 'partial', backupPath: '/actual-backup', error: 'move failed' });
  render(<WorkspaceSyncBar serverPath={PROJECT} />);
  await settle();
  fireEvent.click(screen.getByRole('button', { name: '确认同步清空' }));
  fireEvent.click(screen.getByRole('button', { name: '确认清空 VPS' }));
  await settle();
  expect(screen.getByText('已移动的部分文件可在此恢复：/actual-backup')).toBeDefined();
  expect(screen.getByRole('alert').textContent).toContain('仅完成部分清空');
});

test.each(['account', 'connection', 'binding', 'project'] as const)('late clear results cannot cross a %s replacement', async replacement => {
  const clearing = deferred<Record<string, unknown>>();
  native.getProjectSync.mockResolvedValueOnce(emptyObservation());
  native.confirmProjectEmpty.mockReturnValueOnce(clearing.promise);
  const view = render(<WorkspaceSyncBar serverPath={PROJECT} />);
  await settle();
  fireEvent.click(screen.getByRole('button', { name: '确认同步清空' }));
  fireEvent.click(screen.getByRole('button', { name: '确认清空 VPS' }));
  if (replacement === 'account') native.authVersion++;
  if (replacement === 'connection') native.connectionVersion++;
  if (replacement === 'binding') emit({ ...observation('ready'), bindingEpoch: 'replacement' });
  if (replacement === 'project') { view.rerender(<WorkspaceSyncBar serverPath="/new-project" />); await settle(); }
  const reads = native.getProjectSync.mock.calls.length;
  await act(async () => clearing.resolve({ ok: false, clearState: 'partial', backupPath: '/old-account-backup', error: 'old error' }));
  expect(screen.queryByText('/old-account-backup', { exact: false })).toBeNull();
  expect(screen.queryByText('old error', { exact: false })).toBeNull();
  expect(native.getProjectSync).toHaveBeenCalledTimes(reads);
});


test('account replacement clears action and snapshot, then accepts new observations at the same path', async () => {
  const pending = deferred<Record<string, unknown>>();
  native.syncProject.mockReturnValueOnce(pending.promise);
  render(<WorkspaceSyncBar serverPath={PROJECT} />);
  await settle();
  fireEvent.click(syncButton());
  expect(syncButton().disabled).toBe(true);
  native.getProjectSync.mockImplementation(async serverPath => observation('paused', serverPath));
  act(() => { native.authVersion++; window.dispatchEvent(new Event('auth-identity-changed')); });
  await settle();
  expect(statusText()).toBe('同步已暂停');
  expect(syncButton().disabled).toBe(false);
  emit(observation('ready'));
  expect(statusText()).toBe('已同步');
  await act(async () => pending.reject(new Error('old account failure')));
  expect(screen.queryByText(/old account failure/)).toBeNull();
});

test('connection replacement clears clear-results and receives events for the new connection', async () => {
  native.getProjectSync.mockImplementation(async () => emptyObservation());
  native.confirmProjectEmpty.mockResolvedValueOnce({ ok: true, clearState: 'completed', backupPath: '/srv/private/old-backup' });
  render(<WorkspaceSyncBar serverPath={PROJECT} />);
  await settle();
  fireEvent.click(screen.getByRole('button', { name: '确认同步清空' }));
  fireEvent.click(screen.getByRole('button', { name: '确认清空 VPS' }));
  await settle();
  expect(screen.getByText(/old-backup/)).toBeTruthy();
  act(() => { native.connectionVersion++; window.dispatchEvent(new Event('server-connection-changed')); });
  await settle();
  expect(screen.queryByText(/old-backup/)).toBeNull();
  emit(observation('ready'));
  expect(statusText()).toBe('已同步');
});

test('Git recovery is available from an authoritative blocked state and refreshes status without another sync', async () => {
  native.getProjectSync.mockResolvedValueOnce({ ...observation('blocked'), gitRecoveryRequired: true });
  native.getProjectGitRecovery.mockResolvedValueOnce({ ok: true, recovery: {
    token: 'bar-review', serverPath: PROJECT, bindingEpoch: 'binding-a',
    local: { branch: 'feature', head: 'local-head', staged: true, operation: '' },
    remote: { branch: 'main', head: 'remote-head', staged: false, operation: '' },
    localAllowed: true, localReason: '', remoteAllowed: true, remoteReason: '',
  } });
  native.recoverProjectGit.mockResolvedValueOnce({ ok: true });
  render(<WorkspaceSyncBar serverPath={PROJECT} />);
  await settle();
  expect(native.getProjectGitRecovery).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '恢复 Git 状态' }));
  await settle();
  expect(native.getProjectGitRecovery).toHaveBeenCalledExactlyOnceWith(PROJECT, 'binding-a');
  fireEvent.click(screen.getByRole('radio', { name: '以本地 Git 状态为准' }));
  fireEvent.click(screen.getByRole('button', { name: '确认恢复 Git 状态' }));
  await settle();
  expect(native.recoverProjectGit).toHaveBeenCalledExactlyOnceWith(PROJECT, 'binding-a', 'bar-review', 'local');
  expect(native.getProjectSync).toHaveBeenCalledTimes(2);
  expect(statusText()).toBe('已同步');
  expect(native.syncProject).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('a native connection failure revokes the Git recovery entry backed by cached blocked state', async () => {
  native.getProjectSync.mockResolvedValueOnce({ ...observation('blocked'), gitRecoveryRequired: true });
  render(<WorkspaceSyncBar serverPath={PROJECT} />);
  await settle();
  expect(screen.getByRole('button', { name: '恢复 Git 状态' })).toBeDefined();
  native.getProjectSync.mockRejectedValueOnce(new Error('native transport disconnected'));
  fireEvent.focus(window);
  await settle();
  expect(screen.queryByRole('button', { name: '恢复 Git 状态' })).toBeNull();
  expect(native.getProjectGitRecovery).not.toHaveBeenCalled();
});
