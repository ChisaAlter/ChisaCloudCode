import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';

import SettingsSection from '@/modules/settings/SettingsSection';
import { PiAgentSettings } from '@/modules/local-agent';
import { AccountServerConnection } from '@/modules/auth';
import { usePaletteOps } from '@/modules/command-palette';
import { api } from '@/shared/api';
import { FrontendBridge, getServerConnectionVersion, isDesktop, onWorkspaceConnectionChanged, onWorkspaceSyncStateChanged, recordLocalSelection } from '@/shared/chisa';
import type { ChisaMapping, ChisaProjectStorage, ChisaState, ChisaSyncInfo } from '@/shared/types';
import { getAuthSessionVersion } from '@/shared/authToken';
import { useConnectionIdentity } from '@/shared/hooks/useConnectionIdentity';
import { beginBackgroundOperation } from '@/shared/utils';

const { getState } = FrontendBridge;
const SYNC_STATUS_LABELS: Record<string, string> = { ready: '已同步', checking: '检查变更', syncing: '处理同步', migrating: '准备工作区', reserved: '任务执行中', blocked: '同步受阻', 'needs-sync': '需要同步', paused: '同步已暂停', disconnected: '连接已断开', unavailable: '状态连接已中断', unbound: '未绑定本地目录' };

function formatStorage(bytes: number | null | undefined): string {
  if (bytes == null) return '不可用';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const unit = bytes > 0 ? Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1) : 0;
  return `${(bytes / 1024 ** unit).toLocaleString('zh-CN', { maximumFractionDigits: unit === 0 ? 0 : 1 })} ${units[unit]}`;
}

/** Settings consumes this desktop-only tab for connections, workspace setup and previews. */
export default function ChisaSettingsTab() {
  const identity = useConnectionIdentity();
  return <ChisaSettingsContent key={identity} />;
}

function ChisaSettingsContent() {
  const paletteOps = usePaletteOps();
  // The current native snapshot supplies connection and workspace status.
  const [state, setState] = useState<ChisaState | null>(null);
  const receivedSync = useRef<Record<string, ChisaSyncInfo>>({});
  // Keep the result of connection and synchronization actions visible.
  const [message, setMessage] = useState<string | null>(null);
  // The initial migration may take time; keep its project button disabled until it settles.
  const [syncingProject, setSyncingProject] = useState<string | null>(null);
  // Keep progress attached to the selected project while its binding and project entry change.
  const [switchingProject, setSwitchingProject] = useState<string | null>(null);
  // File allocation is measured only for the project the user explicitly selects.
  const [storage, setStorage] = useState<Record<string, ChisaProjectStorage & { localPath: string; bindingEpoch?: string }>>({});
  // Distinguish a running measurement from an unavailable result.
  const [storageBusy, setStorageBusy] = useState<string | null>(null);
  const mounted = useRef(false);
  const previewRefresh = useRef(0);
  const latestState = useRef(state);
  latestState.current = state;
  const available = isDesktop();

  const refresh = useCallback(async () => {
    if (!isDesktop()) return;
    const account = getAuthSessionVersion();
    const connection = getServerConnectionVersion();
    try {
      const s = (await getState()) as ChisaState;
      if (!mounted.current || account !== getAuthSessionVersion() || connection !== getServerConnectionVersion()) return;
      setState(current => {
        const sync = { ...s.sync };
        for (const [path, info] of Object.entries({ ...current?.sync, ...receivedSync.current })) {
          if (s.mappings.some(mapping => mapping.serverPath === path) && info.sequence > (sync[path]?.sequence ?? -1)) sync[path] = info;
        }
        return { ...s, sync };
      });
    } catch {
      /* ignore */
    }
  }, []);

  const refreshPreviews = useCallback(async () => {
    if (!isDesktop()) return;
    const revision = ++previewRefresh.current;
    const account = getAuthSessionVersion();
    const connection = getServerConnectionVersion();
    const current = () => mounted.current && revision === previewRefresh.current
      && account === getAuthSessionVersion() && connection === getServerConnectionVersion();
    try {
      const result = await FrontendBridge.refreshPreviews();
      if (current()) setState(previous => previous ? { ...previous, previews: result.previews, previewRecoveryError: result.previewRecoveryError } : result);
    } catch (error) {
      if (current()) setState(previous => previous ? { ...previous, previewRecoveryError: error instanceof Error ? error.message : '无法恢复远端预览，请刷新重试。' } : previous);
    }
  }, []);

  useEffect(() => {
    if (!available) return;
    mounted.current = true;
    const unsubscribe = onWorkspaceSyncStateChanged(info => {
      if (info.sequence > (receivedSync.current[info.serverPath]?.sequence ?? -1)) receivedSync.current[info.serverPath] = info;
      setState(current => {
        if (!current || !current.mappings.some(mapping => mapping.serverPath === info.serverPath)) return current;
        if (info.sequence <= (current.sync?.[info.serverPath]?.sequence ?? -1)) return current;
        return { ...current, sync: { ...current.sync, [info.serverPath]: info } };
      });
    });
    const unsubscribeConnection = onWorkspaceConnectionChanged(() => { void refresh(); });
    void refresh();
    void refreshPreviews();
    return () => { mounted.current = false; unsubscribe(); unsubscribeConnection(); };
  }, [available, refresh, refreshPreviews]);

  const measureStorage = async (serverPath: string) => {
    if (storageBusy) return;
    const account = getAuthSessionVersion();
    const connection = getServerConnectionVersion();
    const mapping = state?.mappings.find(item => item.serverPath === serverPath);
    const epoch = state?.sync?.[serverPath]?.bindingEpoch;
    const current = () => mounted.current && account === getAuthSessionVersion() && connection === getServerConnectionVersion()
      && latestState.current?.mappings.some(item => item.serverPath === serverPath && item.localPath === mapping?.localPath)
      && latestState.current?.sync?.[serverPath]?.bindingEpoch === epoch;
    setStorageBusy(serverPath);
    setMessage(null);
    try {
      const result = await FrontendBridge.getProjectStorage(serverPath);
      if (current()) setStorage(previous => ({ ...previous, [serverPath]: {
        ...(result[serverPath] ?? { localBytes: null, serverBytes: null, localError: '项目绑定或连接已改变，请刷新状态后重新统计。' }),
        localPath: mapping!.localPath, bindingEpoch: epoch,
      } }));
    } catch (error) {
      if (current()) setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      if (mounted.current) setStorageBusy(null);
    }
  };

  const measuredStorage = (serverPath: string) => {
    const result = storage[serverPath];
    return result?.bindingEpoch === state?.sync?.[serverPath]?.bindingEpoch
      && state?.mappings.some(item => item.serverPath === serverPath && item.localPath === result?.localPath) ? result : undefined;
  };

  const removeMapping = useCallback(async (serverPath: string) => {
    const finish = beginBackgroundOperation('正在移除工作目录', '正在后台解除绑定并刷新项目状态。');
    try {
      const result = await FrontendBridge.revoke(serverPath);
      if (!result.ok) throw new Error(String(result.error || '撤销失败'));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      await refresh();
      finish();
    }
  }, [refresh]);

  const switchProject = async (mapping: ChisaMapping) => {
    if (switchingProject || !mapping.bindingEpoch) return;
    const account = getAuthSessionVersion();
    const connection = getServerConnectionVersion();
    const current = () => mounted.current && account === getAuthSessionVersion() && connection === getServerConnectionVersion();
    setSwitchingProject(mapping.bindingEpoch);
    setMessage(null);
    let rebound = false;
    try {
      const result = await FrontendBridge.switchAccountWorkspace([{ serverPath: mapping.serverPath, bindingEpoch: mapping.bindingEpoch }]);
      if (!result.ok) throw new Error(String(result.error || '切换项目账号失败'));
      rebound = true;
      if (!current()) return;
      for (const project of result.projects!) {
        const name = project.serverPath.split('/').filter(Boolean).pop() || 'local-project';
        const response = await api.createProject({ name, path: project.serverPath, customName: name.replace(/-[a-f0-9]{6}$/, '') });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error?.details || data.details || data.error?.message || data.error || '保存项目列表失败');
        if (!current()) return;
        recordLocalSelection(project);
      }
      await paletteOps.refreshProjects();
      if (current()) setMessage('所选项目已切换到当前账号，其他项目保留原绑定。两端项目文件已保留。');
    } catch (error) {
      if (current()) setMessage((rebound ? '项目已切换，但更新项目列表失败：' : '') + (error instanceof Error ? error.message : String(error)));
    } finally {
      if (current()) {
        await refresh();
        setSwitchingProject(null);
      }
    }
  };

  const synchronize = useCallback(async (serverPath: string) => {
    const finish = beginBackgroundOperation('正在同步工作区', '后台同步中，可继续浏览和编辑消息。');
    setSyncingProject(serverPath);
    setMessage(null);
    try {
      const result = await FrontendBridge.syncProject(serverPath);
      if (!result.ok) throw new Error(String(result.error || '同步未完成'));
      setMessage('项目已完成 VPS 同步。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSyncingProject(null);
      await refresh();
      finish();
    }
  }, [refresh]);

  if (!available) {
    return (
      <SettingsSection title="ChisaCloudCode" description="此页面仅在 ChisaCloudCode 桌面应用中可用。">
        <div className="text-sm text-muted-foreground">未检测到桌面环境。</div>
      </SettingsSection>
    );
  }

  return (
    <>
      <PiAgentSettings />
      <SettingsSection title="账号服务与文件同步" description="账号服务和本地文件同步分别连接。Claude Code 始终在服务器上运行。">
        <AccountServerConnection />
      </SettingsSection>

      <SettingsSection title="项目同步" description="源码和项目资源增量同步到 VPS，依赖和临时产物留在各自环境。文件占用包含各端的依赖和构建产物，不跟随符号链接；点击工程的“统计空间”后单独统计。移除会停止同步，保留两端项目文件。">
        {message && <p role="status" className="mb-3 text-sm text-muted-foreground">{message}</p>}
        {Boolean(state?.inactiveMappings?.length) && (
          <div className="mb-4 space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
            <h3 className="text-sm font-medium">其他账号的项目</h3>
            <p className="text-xs leading-relaxed text-muted-foreground">按项目选择要切换到当前账号的目录，其他项目保留原账号绑定。两端文件都会保留；当前只启用当前账号的同步，其他账号的项目保持暂停。</p>
            {state!.inactiveMappings!.map(mapping => (
              <div key={mapping.bindingEpoch || mapping.serverPath} className="grid min-w-0 grid-cols-1 gap-2 rounded-md border bg-background p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                <div className="min-w-0 text-xs">
                  <div className="break-all font-medium" title={mapping.localPath}>{mapping.localPath}</div>
                  <div className="mt-1 break-all text-muted-foreground" title={mapping.serverPath}>{mapping.serverPath}</div>
                </div>
                <button type="button" onClick={() => void switchProject(mapping)} disabled={switchingProject !== null || !mapping.bindingEpoch} aria-label={`切换此项目：${mapping.localPath}`} className="min-h-9 w-28 justify-self-end rounded-md border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50">
                  {switchingProject === mapping.bindingEpoch ? '正在切换…' : '切换此项目'}
                </button>
              </div>
            ))}
          </div>
        )}
        {state?.mappings?.length ? (
          <div className="space-y-2">
            {state.mappings.map((m) => (
              <div key={m.serverPath} className="grid grid-cols-1 gap-3 rounded-lg border p-3 text-sm sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                <div className="min-w-0">
                  <div title={m.localPath} className="truncate font-medium">{m.localPath}</div>
                  <div title={m.serverPath} className="truncate text-xs text-muted-foreground">{m.serverPath}</div>
                  <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground tabular-nums">
                    <span title={measuredStorage(m.serverPath)?.localError}>本地：{storageBusy === m.serverPath ? '统计中…' : measuredStorage(m.serverPath) ? formatStorage(measuredStorage(m.serverPath)?.localBytes) : '未统计'}</span>
                    <span title={measuredStorage(m.serverPath)?.serverError}>服务器：{storageBusy === m.serverPath ? '统计中…' : measuredStorage(m.serverPath) ? formatStorage(measuredStorage(m.serverPath)?.serverBytes) : '未统计'}</span>
                    <button type="button" onClick={() => void measureStorage(m.serverPath)} disabled={storageBusy !== null} aria-label={`统计空间：${m.localPath}`} className="shrink-0 rounded-md border px-2 py-0.5 text-xs hover:bg-accent disabled:opacity-50">
                      {storageBusy === m.serverPath ? '统计中…' : '统计空间'}
                    </button>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground" role="status">
                    {SYNC_STATUS_LABELS[state.sync?.[m.serverPath]?.status || 'needs-sync'] || '需要同步'}
                  </div>
                  {state.sync?.[m.serverPath]?.detail && <div className="mt-1 break-all text-xs text-amber-600">{state.sync?.[m.serverPath]?.detail}</div>}
                </div>
                <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                <button type="button" onClick={() => void synchronize(m.serverPath)} disabled={syncingProject !== null || Boolean(state.sync?.[m.serverPath]?.taskOwner) || ['syncing', 'migrating', 'reserved'].includes(state.sync?.[m.serverPath]?.status || '')} className="w-24 shrink-0 rounded-md border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50">
                  {syncingProject === m.serverPath ? '同步中…' : m.mode === 'vps' ? '同步' : '迁移到 VPS'}
                </button>
                <button
                  type="button"
                  onClick={() => void removeMapping(m.serverPath)}
                  className="w-16 shrink-0 rounded-md border px-3 py-1.5 text-xs hover:bg-accent"
                >
                  移除
                </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-sm text-muted-foreground">{state?.inactiveMappings?.length ? '当前账号尚未绑定本机目录。可切换上方的指定项目，也可以从侧栏打开其他本机目录。' : '还没有打开过本地目录。在侧栏「＋ 打开本地目录」或新建项目时选择。'}</div>
        )}
      </SettingsSection>

      <SettingsSection title="工作区执行环境" description="Claude 的文件操作、命令和网页预览在 VPS 的 Linux 容器执行。Pi 在 Windows 本地执行，可用于原生构建和桌面验证。">
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm">
            <span className={`inline-block h-2 w-2 rounded-full ${state?.tunnel ? 'bg-emerald-500' : 'bg-amber-500'}`} />
            <span className="text-muted-foreground">
              当前后端：
              {state?.tunnel ? 'VPS Linux' : 'VPS 尚未连接'}
            </span>
          </div>

        </div>
      </SettingsSection>

      <SettingsSection title="运行预览" description="Claude 启动的网页预览可在本机浏览器打开；关闭预览会释放对应进程和端口。">
        {state?.previewRecoveryError && <p role="alert" className="mb-2 text-sm text-destructive">{state.previewRecoveryError}</p>}
        {state?.previews?.length ? state.previews.map(preview => (
          <div key={preview.id} className="mb-2 flex items-center gap-3 rounded-lg border p-3 text-sm">
            <span className="min-w-0 flex-1 truncate">{preview.localUrl || '已恢复的远端预览'}</span>
            <button type="button" className="rounded border px-3 py-1" onClick={() => void FrontendBridge.openPreview(preview.id).then(result => { if (!result.ok) setMessage(String(result.error)); })}>打开</button>
            <button type="button" className="rounded border px-3 py-1" onClick={() => { previewRefresh.current++; void FrontendBridge.stopPreview(preview.id).then(async result => { if (!result.ok) setMessage(String(result.error)); await refresh(); }); }}>停止</button>
          </div>
        )) : <div className="text-sm text-muted-foreground">暂无预览。可让 Claude 启动项目的网页预览。</div>}
      </SettingsSection>

      <SettingsSection title="状态刷新" description="">
        <button
          type="button"
          onClick={() => { void refresh(); void refreshPreviews(); }}
          className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm hover:bg-accent disabled:opacity-50"
        >
          <RefreshCw className="h-4 w-4" />
          刷新状态
        </button>
      </SettingsSection>
    </>
  );
}
