import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const native = vi.hoisted(() => ({ call: vi.fn(), listen: vi.fn() }));
vi.mock('mygo-runtime', () => ({ call: native.call, on: native.listen }));
import { FrontendBridge, onWorkspaceConnectionChanged, subscribeWorkspaceSynchronization } from '@/shared/chisa';
import type { ChisaSyncInfo, ChisaWorkspaceSyncEvent } from '@/shared/types';
import { getBlockingOperations } from '@/shared/utils';

const PROJECT = '/work/new';
const listeners = new Map<string, (event: ChisaSyncInfo | ChisaWorkspaceSyncEvent) => void>();
const subscriptions = new Set<() => void>();

function observation(status: string, sequence: number, serverPath = PROJECT): ChisaSyncInfo {
  return { status, sequence, serverPath, bindingEpoch: 'binding-a', checkedAt: '' };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function subscribe() {
  const unsubscribe = subscribeWorkspaceSynchronization();
  subscriptions.add(unsubscribe);
  return () => { unsubscribe(); subscriptions.delete(unsubscribe); };
}

function operation(status: string, serverPath = PROJECT) {
  listeners.get('chisa:workspace-sync')?.({ status, serverPath });
}

function emit(info: ChisaSyncInfo) {
  listeners.get('chisa:workspace-sync-state')?.(info);
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('mygo', {});
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  listeners.clear();
  native.call.mockResolvedValue({});
  native.listen.mockImplementation((name, listener) => {
    listeners.set(name, listener);
    return () => { listeners.delete(name); };
  });
});
afterEach(() => {
  subscriptions.forEach(unsubscribe => unsubscribe());
  subscriptions.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('native directory loading and synchronization release only when their bridge call settles', async () => {
  let complete!: (value: Record<string, unknown>) => void;
  native.call.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  const folder = FrontendBridge.selectLocalFolder();
  expect(getBlockingOperations()[0]?.title).toBe('正在打开工作目录');
  expect(getBlockingOperations()[0]?.blocking).toBe(true);
  complete({ ok: true, serverPath: '/work/new' });
  await folder;
  expect(getBlockingOperations()).toEqual([]);
  const sync = FrontendBridge.syncProject('/work/new');
  expect(getBlockingOperations()[0]?.title).toBe('正在同步工作区');
  expect(getBlockingOperations()[0]?.blocking).toBe(false);
  complete({ ok: false, error: '同步冲突' });
  expect(await sync).toEqual({ ok: false, error: '同步冲突' });
  expect(getBlockingOperations()).toEqual([]);
});

test('legacy events still settle operations and outrank their unversioned startup activity', async () => {
  const startup = deferred<unknown>();
  native.call.mockReturnValue(startup.promise);
  subscribe();
  operation('syncing');
  expect(getBlockingOperations()).toHaveLength(1);
  expect(getBlockingOperations()[0]?.blocking).toBe(false);
  operation('ready');
  startup.resolve({ syncOperations: { [PROJECT]: { status: 'syncing' } } });
  await settle();
  expect(getBlockingOperations()).toEqual([]);
  operation('migrating');
  expect(getBlockingOperations()).toHaveLength(1);
  operation('blocked');
  expect(getBlockingOperations()).toEqual([]);
});

test('startup notices require explicit activity and a busy authoritative state', async () => {
  native.call.mockResolvedValue({
    sync: {
      '/work/engine-only': observation('syncing', 1, '/work/engine-only'),
      '/work/checking': observation('checking', 2, '/work/checking'),
      '/work/active': observation('migrating', 3, '/work/active'),
      '/work/cleanup': observation('blocked', 4, '/work/cleanup'),
    },
    syncOperations: { '/work/active': { status: 'migrating' }, '/work/cleanup': { status: 'syncing' } },
  });
  subscribe();
  await settle();
  expect(getBlockingOperations()).toHaveLength(1);
  expect(getBlockingOperations()[0]?.blocking).toBe(false);
  emit(observation('ready', 5, '/work/active'));
  operation('syncing', '/work/cleanup');
  expect(getBlockingOperations()).toEqual([]);
  expect(native.listen).toHaveBeenCalledWith('chisa:workspace-sync', expect.any(Function));
  expect(native.listen).toHaveBeenCalledWith('chisa:workspace-sync-state', expect.any(Function));
});

test.each(['ready', 'blocked', 'unavailable', 'disconnected', 'paused', 'unbound'])('authoritative %s closes a notice without its legacy completion and rejects stale resurrection', async status => {
  const startup = deferred<unknown>();
  native.call.mockReturnValue(startup.promise);
  subscribe();
  operation('syncing');
  emit(observation('syncing', 10));
  expect(getBlockingOperations()).toHaveLength(1);
  emit({ ...observation(status, 12), bindingEpoch: 'binding-b' });
  expect(getBlockingOperations()).toEqual([]);
  operation('migrating');
  emit(observation('syncing', 11));
  emit(observation('syncing', 12));
  startup.resolve({ sync: { [PROJECT]: observation('syncing', 9) }, syncOperations: { [PROJECT]: { status: 'syncing' } } });
  await settle();
  expect(getBlockingOperations()).toEqual([]);
  emit({ ...observation('syncing', 13), bindingEpoch: 'binding-b' });
  expect(getBlockingOperations()).toEqual([]);
  operation('ready');
  operation('syncing');
  emit({ ...observation('syncing', 14), bindingEpoch: 'binding-b' });
  expect(getBlockingOperations()).toHaveLength(1);
});

test('a late terminal startup snapshot cannot end a newer busy native observation', async () => {
  const startup = deferred<unknown>();
  native.call.mockReturnValue(startup.promise);
  subscribe();
  operation('migrating');
  emit(observation('migrating', 20));
  startup.resolve({ sync: { [PROJECT]: observation('ready', 19) } });
  await settle();
  expect(getBlockingOperations()).toHaveLength(1);
});

test('late startup activity cannot let watcher scans revive a completed project', async () => {
  const startup = deferred<unknown>();
  native.call.mockReturnValue(startup.promise);
  subscribe();
  emit(observation('ready', 5));
  startup.resolve({ sync: { [PROJECT]: observation('syncing', 4) }, syncOperations: { [PROJECT]: { status: 'syncing' } } });
  await settle();
  expect(getBlockingOperations()).toEqual([]);
  emit(observation('syncing', 6));
  expect(getBlockingOperations()).toEqual([]);
});

test('late startup activity cannot qualify a newer scan that followed an authoritative completion', async () => {
  const startup = deferred<unknown>();
  native.call.mockReturnValue(startup.promise);
  subscribe();
  emit(observation('ready', 5));
  emit(observation('syncing', 6));
  startup.resolve({ sync: { [PROJECT]: observation('syncing', 4) }, syncOperations: { [PROJECT]: { status: 'syncing' } } });
  await settle();
  expect(getBlockingOperations()).toEqual([]);
});

test('multiple explicit operations finish independently and engine-only events stay quiet', async () => {
  subscribe();
  await settle();
  emit(observation('syncing', 1, '/work/engine-only'));
  operation('syncing');
  operation('migrating', '/work/other');
  expect(getBlockingOperations()).toHaveLength(2);
  emit(observation('ready', 2));
  expect(getBlockingOperations()).toHaveLength(1);
  emit(observation('blocked', 3, '/work/other'));
  expect(getBlockingOperations()).toEqual([]);
});

test('focus reconciles a missed terminal event without polling idle projects or reloading state', async () => {
  vi.useFakeTimers();
  try {
    native.call.mockImplementation(async method => method === 'FrontendBridge.GetState' ? {} : observation('ready', 2));
    subscribe();
    await settle();
    await vi.advanceTimersByTimeAsync(10000);
    window.dispatchEvent(new Event('focus'));
    expect(native.call).toHaveBeenCalledTimes(1);
    operation('syncing');
    emit(observation('syncing', 1));
    window.dispatchEvent(new Event('focus'));
    await settle();
    expect(getBlockingOperations()).toEqual([]);
    expect(native.call.mock.calls).toEqual([['FrontendBridge.GetState'], ['FrontendBridge.GetProjectSync', PROJECT]]);
  } finally {
    vi.useRealTimers();
  }
});

test('hidden windows defer reconciliation until visible and coalesce focus and online requests', async () => {
  const first = deferred<ChisaSyncInfo>();
  const second = deferred<ChisaSyncInfo>();
  native.call.mockResolvedValueOnce({}).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  subscribe();
  await settle();
  operation('syncing');
  emit(observation('syncing', 1));
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  window.dispatchEvent(new Event('focus'));
  window.dispatchEvent(new Event('online'));
  document.dispatchEvent(new Event('visibilitychange'));
  expect(native.call).toHaveBeenCalledTimes(1);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  document.dispatchEvent(new Event('visibilitychange'));
  window.dispatchEvent(new Event('focus'));
  window.dispatchEvent(new Event('online'));
  expect(native.call).toHaveBeenCalledTimes(2);
  first.resolve(observation('syncing', 1));
  await settle();
  expect(native.call).toHaveBeenCalledTimes(3);
  second.resolve(observation('ready', 2));
  await settle();
  expect(getBlockingOperations()).toEqual([]);
});

test('a newer terminal event defeats a late busy focus snapshot', async () => {
  const snapshot = deferred<ChisaSyncInfo>();
  native.call.mockResolvedValueOnce({}).mockReturnValueOnce(snapshot.promise);
  subscribe();
  await settle();
  operation('syncing');
  emit(observation('syncing', 1));
  window.dispatchEvent(new Event('focus'));
  emit(observation('blocked', 3));
  snapshot.resolve(observation('syncing', 2));
  await settle();
  expect(getBlockingOperations()).toEqual([]);
});

test('failed reconciliation hides stale busy state until a successful read confirms even the same sequence', async () => {
  native.call.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('Bridge disconnected')).mockResolvedValueOnce(observation('syncing', 10));
  subscribe();
  await settle();
  operation('syncing');
  emit(observation('syncing', 10));
  window.dispatchEvent(new Event('focus'));
  await settle();
  expect(getBlockingOperations()).toEqual([]);
  operation('syncing');
  emit(observation('syncing', 9));
  emit(observation('syncing', 10));
  expect(getBlockingOperations()).toEqual([]);
  window.dispatchEvent(new Event('online'));
  await settle();
  expect(getBlockingOperations()).toHaveLength(1);
});

test('a failed read cannot suppress a newer busy event', async () => {
  const snapshot = deferred<ChisaSyncInfo>();
  native.call.mockResolvedValueOnce({}).mockReturnValueOnce(snapshot.promise);
  subscribe();
  await settle();
  operation('syncing');
  emit(observation('syncing', 1));
  window.dispatchEvent(new Event('focus'));
  emit(observation('migrating', 2));
  snapshot.reject(new Error('Earlier snapshot failed'));
  await settle();
  expect(getBlockingOperations()).toHaveLength(1);
});

test('workspace reconnection refreshes only active paths and invalidates earlier snapshots', async () => {
  const stale = deferred<ChisaSyncInfo>();
  const confirmed = deferred<ChisaSyncInfo>();
  native.call.mockResolvedValueOnce({}).mockReturnValueOnce(stale.promise).mockResolvedValueOnce({ ok: true }).mockReturnValueOnce(confirmed.promise);
  subscribe();
  await settle();
  emit(observation('syncing', 1, '/work/engine-only'));
  operation('syncing');
  emit(observation('syncing', 2));
  window.dispatchEvent(new Event('focus'));
  await FrontendBridge.connectWorkspace('https://workspace', 'host', 'user', 'key');
  stale.resolve(observation('ready', 20));
  await settle();
  expect(getBlockingOperations()).toHaveLength(1);
  confirmed.resolve(observation('blocked', 3));
  await settle();
  expect(getBlockingOperations()).toEqual([]);
  expect(native.call.mock.calls).toEqual([
    ['FrontendBridge.GetState'],
    ['FrontendBridge.GetProjectSync', PROJECT],
    ['FrontendBridge.ConnectWorkspace', 'https://workspace', 'host', 'user', 'key'],
    ['FrontendBridge.GetProjectSync', PROJECT],
  ]);
});

test('reads made during a workspace handshake cannot replace its post-reconnect state', async () => {
  const handshake = deferred<Record<string, unknown>>();
  const stale = deferred<ChisaSyncInfo>();
  const confirmed = deferred<ChisaSyncInfo>();
  native.call.mockResolvedValueOnce({}).mockReturnValueOnce(handshake.promise).mockReturnValueOnce(stale.promise).mockReturnValueOnce(confirmed.promise);
  subscribe();
  await settle();
  operation('syncing');
  emit(observation('syncing', 1));
  const connection = FrontendBridge.connectWorkspace('https://workspace', 'host', 'user', 'key');
  window.dispatchEvent(new Event('focus'));
  handshake.resolve({ ok: true });
  await connection;
  stale.resolve(observation('ready', 50));
  await settle();
  expect(getBlockingOperations()).toHaveLength(1);
  confirmed.resolve(observation('syncing', 2));
  await settle();
  expect(getBlockingOperations()).toHaveLength(1);
});

test('an account change discards pending startup and project snapshots', async () => {
  const startup = deferred<unknown>();
  const snapshot = deferred<ChisaSyncInfo>();
  native.call.mockReturnValueOnce(startup.promise).mockReturnValueOnce(snapshot.promise).mockResolvedValueOnce({ ok: true });
  subscribe();
  operation('syncing');
  emit(observation('syncing', 2));
  window.dispatchEvent(new Event('focus'));
  await FrontendBridge.connectServer('https://other-account');
  emit(observation('blocked', 3));
  startup.resolve({ sync: { [PROJECT]: observation('syncing', 50) }, syncOperations: { [PROJECT]: { status: 'syncing' } } });
  snapshot.resolve(observation('syncing', 51));
  await settle();
  expect(getBlockingOperations()).toEqual([]);
});

test('a reconnect without active projects makes no project queries', async () => {
  native.call.mockResolvedValue({ ok: true });
  subscribe();
  await settle();
  await FrontendBridge.connectWorkspace('https://workspace', 'host', 'user', 'key');
  expect(native.call.mock.calls).toEqual([
    ['FrontendBridge.GetState'],
    ['FrontendBridge.ConnectWorkspace', 'https://workspace', 'host', 'user', 'key'],
  ]);
});

test('disposing removes listeners, finishes notices and ignores late native responses', async () => {
  const startup = deferred<unknown>();
  const snapshot = deferred<ChisaSyncInfo>();
  native.call.mockReturnValueOnce(startup.promise).mockReturnValueOnce(snapshot.promise);
  const unsubscribe = subscribe();
  operation('syncing');
  const lateOperation = listeners.get('chisa:workspace-sync')!;
  const lateState = listeners.get('chisa:workspace-sync-state')!;
  window.dispatchEvent(new Event('focus'));
  unsubscribe();
  expect(getBlockingOperations()).toEqual([]);
  expect(listeners.size).toBe(0);
  startup.resolve({ syncOperations: { [PROJECT]: { status: 'syncing' } } });
  snapshot.resolve(observation('syncing', 2));
  lateOperation({ serverPath: PROJECT, status: 'syncing' });
  lateState(observation('syncing', 3));
  window.dispatchEvent(new Event('focus'));
  window.dispatchEvent(new Event('online'));
  document.dispatchEvent(new Event('visibilitychange'));
  await settle();
  expect(getBlockingOperations()).toEqual([]);
  expect(native.call).toHaveBeenCalledTimes(2);
});

test.each([
  ['connect', 'connected'], ['connect', 'failed'], ['switch', 'connected'], ['switch', 'failed'],
] as const)('%s workspace observers are notified only after a %s attempt settles', async (operation, outcome) => {
  const bindings = [
    { serverPath: '/srv/old-project-a', bindingEpoch: 'old-epoch-a' },
  ];
  const reply = operation === 'switch'
    ? { ok: true, projects: [{ localPath: 'C:\\work\\project-a', serverPath: '/work/current/project-a-12ab34' }], clearedMappings: 1, bindingsCleared: true }
    : { ok: true };
  const attempt = () => operation === 'switch' ? FrontendBridge.switchAccountWorkspace(bindings) : FrontendBridge.connectAccountWorkspace();
  let complete!: (value: Record<string, unknown>) => void;
  let fail!: (error: Error) => void;
  native.call.mockImplementationOnce(() => new Promise((resolve, reject) => { complete = resolve; fail = reject; }));
  const listener = vi.fn(() => { expect(getBlockingOperations()).toEqual([]); });
  const unsubscribe = onWorkspaceConnectionChanged(listener);
  try {
    const connection = attempt();
    if (operation === 'switch') {
      expect(native.call).toHaveBeenCalledExactlyOnceWith('FrontendBridge.SwitchAccountWorkspace', bindings);
    } else {
      expect(native.call).toHaveBeenCalledExactlyOnceWith('FrontendBridge.ConnectAccountWorkspace');
    }
    expect(listener).not.toHaveBeenCalled();
    if (outcome === 'connected') {
      complete(reply);
      await expect(connection).resolves.toEqual(reply);
    } else {
      fail(new Error('文件同步连接失败'));
      await expect(connection).rejects.toThrow('文件同步连接失败');
    }
    expect(listener).toHaveBeenCalledTimes(1);
  } finally {
    unsubscribe();
  }
  native.call.mockResolvedValueOnce(reply);
  await attempt();
  expect(listener).toHaveBeenCalledTimes(1);
});
