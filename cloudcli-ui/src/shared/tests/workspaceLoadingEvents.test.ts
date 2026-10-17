import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const native = vi.hoisted(() => ({ call: vi.fn(), listen: vi.fn() }));
vi.mock('mygo-runtime', () => ({ call: native.call, on: native.listen }));
import { FrontendBridge, onWorkspaceConnectionChanged, subscribeWorkspaceSynchronization } from '@/shared/chisa';
import { getBlockingOperations } from '@/shared/utils';

beforeEach(() => { vi.resetAllMocks(); });
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

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

test('live synchronization events override a stale startup snapshot and unblock on failure', async () => {
  vi.stubGlobal('mygo', {});
  let snapshot!: (value: unknown) => void;
  let receive!: (event: { serverPath: string; status: string }) => void;
  native.call.mockImplementation(() => new Promise(resolve => { snapshot = resolve; }));
  native.listen.mockImplementation((_name, listener) => { receive = listener; return () => {}; });
  const unsubscribe = subscribeWorkspaceSynchronization();
  receive({ serverPath: '/work/new', status: 'syncing' });
  expect(getBlockingOperations()).toHaveLength(1);
  expect(getBlockingOperations()[0]?.blocking).toBe(false);
  receive({ serverPath: '/work/new', status: 'ready' });
  snapshot({ syncOperations: { '/work/new': { status: 'syncing' } } });
  await Promise.resolve();
  expect(getBlockingOperations()).toEqual([]);
  receive({ serverPath: '/work/new', status: 'migrating' });
  expect(getBlockingOperations()).toHaveLength(1);
  receive({ serverPath: '/work/new', status: 'blocked' });
  expect(getBlockingOperations()).toEqual([]);
  unsubscribe();
});

test('startup notices track explicit active operations but never routine synchronization-engine scans', async () => {
  vi.stubGlobal('mygo', {});
  let receive!: (event: { serverPath: string; status: string }) => void;
  native.call.mockResolvedValue({
    sync: {
      '/work/engine-only': { status: 'syncing' },
      '/work/checking': { status: 'checking' },
      '/work/active': { status: 'ready' },
    },
    syncOperations: { '/work/active': { status: 'migrating' } },
  });
  native.listen.mockImplementation((_name, listener) => { receive = listener; return () => {}; });
  const unsubscribe = subscribeWorkspaceSynchronization();
  await Promise.resolve();
  expect(getBlockingOperations()).toHaveLength(1);
  expect(getBlockingOperations()[0]?.blocking).toBe(false);
  receive({ serverPath: '/work/active', status: 'ready' });
  expect(getBlockingOperations()).toEqual([]);
  expect(native.listen).toHaveBeenCalledWith('chisa:workspace-sync', expect.any(Function));
  unsubscribe();
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
