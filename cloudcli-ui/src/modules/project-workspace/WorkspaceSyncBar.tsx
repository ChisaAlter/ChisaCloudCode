import { AlertTriangle, CheckCircle2, CloudOff, Info, Loader2, PauseCircle, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { FrontendBridge, getServerConnectionVersion, isDesktop, onWorkspaceSyncStateChanged } from '@/shared/chisa';
import { getAuthSessionVersion } from '@/shared/authToken';
import { usePaletteOps } from '@/modules/command-palette';
import { GitSyncRecovery } from '@/modules/workspace-sync-recovery';
import type { ChisaSyncInfo } from '@/shared/types';
import { useConnectionIdentity } from '@/shared/hooks/useConnectionIdentity';
import { useComponentVersions } from '@/shared/hooks/useComponentVersions';
import { createSyncDiagnostic } from '@/modules/project-workspace/utils/syncDiagnostic';
import { Button } from '@/shared/ui';

const SYNC_LABELS: Record<string, string> = {
  ready: '已同步',
  checking: '检查变更',
  syncing: '处理同步',
  migrating: '准备工作区',
  reserved: '任务执行中',
  blocked: '同步受阻',
  'needs-sync': '需要同步',
  paused: '同步已暂停',
  disconnected: '连接已断开',
  unavailable: '状态连接已中断',
  unbound: '未绑定本地目录',
};

/** WorkspaceMain presents a quiet result and manual action; the native watcher pushes meaningful changes. */
export function WorkspaceSyncBar({ serverPath }: { serverPath: string }) {
  const identity = useConnectionIdentity();
  return <WorkspaceSyncObservation key={identity} serverPath={serverPath} />;
}

function WorkspaceSyncObservation({ serverPath }: { serverPath: string }) {
  // Copy feedback is scoped to the current project and binding, never a previous account.
  const [copyMessage, setCopyMessage] = useState('');
  const { openSettings } = usePaletteOps();
  // The latest versioned engine observation determines state, including invalidation on disconnect.
  const [info, setInfo] = useState<ChisaSyncInfo | null>(null);
  const versions = useComponentVersions(`${serverPath}:${info?.bindingEpoch ?? ''}`);
  // Keep the button busy only for this user-initiated synchronization, never for an idle state read.
  const [synchronizing, setSynchronizing] = useState(false);
  // A failed action remains available without hiding a subsequently recovered engine.
  const [actionError, setActionError] = useState<string | null>(null);
  // A failed snapshot request is separate from the last observation so stale green is not reused.
  const [connectionError, setConnectionError] = useState<string | null>(null);
  // Consent belongs to the exact workspace binding shown when the user opened the confirmation.
  const [emptyConfirmation, setEmptyConfirmation] = useState<{ serverPath: string; bindingEpoch: string } | null>(null);
  // Retain the completed action's backup location so the user can recover the cleared VPS files.
  const [emptyBackup, setEmptyBackup] = useState<{ serverPath: string; bindingEpoch: string; path: string; complete: boolean } | null>(null);
  const latestSequence = useRef(-1);
  const mounted = useRef(false);
  const actionGeneration = useRef(0);
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const refreshSnapshot = useRef<() => Promise<void>>(async () => {});
  const desktop = isDesktop();
  const localRootEmpty = info?.serverPath === serverPath && info?.emptySide === 'local' && info?.status === 'blocked';
  const taskBusy = Boolean(info?.taskOwner) || info?.status === 'reserved';

  useEffect(() => {
    actionGeneration.current++;
    setSynchronizing(false);
    setActionError(null);
    setEmptyConfirmation(null);
    setEmptyBackup(null);
    setCopyMessage('');
  }, [serverPath, info?.bindingEpoch]);

  useEffect(() => {
    if (!localRootEmpty || taskBusy || connectionError) setEmptyConfirmation(null);
  }, [localRootEmpty, taskBusy, connectionError]);

  useEffect(() => {
    if (!desktop) return;
    mounted.current = true;
    latestSequence.current = -1;
    setInfo(null);
    setConnectionError(null);
    const accountVersion = getAuthSessionVersion();
    const connectionVersion = getServerConnectionVersion();
    const currentConnection = () => accountVersion === getAuthSessionVersion() && connectionVersion === getServerConnectionVersion();
    let disposed = false;
    let querying = false;
    let refreshQueued = false;
    let eventRevision = 0;

    const accept = (next: ChisaSyncInfo) => {
      if (disposed || !currentConnection() || next.serverPath !== serverPath || next.sequence <= latestSequence.current) return;
      latestSequence.current = next.sequence;
      setInfo(next);
      setConnectionError(null);
    };
    const refresh = async () => {
      if (disposed || !currentConnection() || document.visibilityState === 'hidden') return;
      if (querying) {
        refreshQueued = true;
        return;
      }
      querying = true;
      const requestRevision = eventRevision;
      try {
        const next = await FrontendBridge.getProjectSync(serverPath);
        if (!disposed && currentConnection()) {
          accept(next);
          if (next.sequence === latestSequence.current) setConnectionError(null);
        }
      } catch (error) {
        if (!disposed && currentConnection() && requestRevision === eventRevision) {
          setConnectionError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        querying = false;
        if (refreshQueued && !disposed) {
          refreshQueued = false;
          await refresh();
        }
      }
    };

    refreshSnapshot.current = refresh;
    // Subscribe before the initial snapshot: a later native event outranks an older bridge reply.
    const unsubscribe = onWorkspaceSyncStateChanged(next => {
      if (!currentConnection() || next.serverPath !== serverPath || next.sequence <= latestSequence.current) return;
      eventRevision++;
      accept(next);
    });
    const refreshWhenVisible = () => {
      if (document.visibilityState !== 'hidden') void refresh();
    };
    void refresh();
    window.addEventListener('focus', refreshWhenVisible);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      disposed = true;
      mounted.current = false;
      refreshSnapshot.current = async () => {};
      unsubscribe();
      window.removeEventListener('focus', refreshWhenVisible);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [desktop, serverPath]);

  if (!desktop) return null;

  const status = synchronizing ? 'syncing' : connectionError ? 'unavailable' : info?.status ?? 'unknown';
  const problem = ['blocked', 'disconnected', 'unavailable'].includes(status);
  const disabled = synchronizing || taskBusy || info?.status === 'migrating' || info?.status === 'unbound'
    || (localRootEmpty && (Boolean(connectionError) || !info?.bindingEpoch));
  const confirmingEmpty = Boolean(emptyConfirmation && localRootEmpty && !connectionError && !taskBusy
    && emptyConfirmation.serverPath === serverPath && emptyConfirmation.bindingEpoch === info?.bindingEpoch);
  const label = synchronizing ? '正在同步'
    : status === 'reserved' ? info?.taskOwner === 'pi' ? 'Pi 正在操作项目' : '云端任务执行中'
      : status === 'unknown' ? '等待同步状态' : SYNC_LABELS[status] ?? '状态未确认';
  const Icon = problem ? status === 'disconnected' ? CloudOff : AlertTriangle
    : status === 'ready' ? CheckCircle2 : taskBusy || status === 'paused' ? PauseCircle
      : synchronizing || status === 'syncing' ? Loader2 : Info;
  const errorDetail = connectionError || info?.detail;
  // Native failures can include multiline Python/Git diagnostics; keep those in the scrollable details panel.
  const summarizeError = (detail: string) => /Traceback|\n|fatal:|<[^>]+>|^\s*[{[]/.test(detail) || detail.length > 180
    ? /unmerged|git-write-tree|合并冲突/.test(detail)
      ? 'Git 合并冲突导致同步未完成，请查看详情。当前修改已保留。'
      : '同步未完成，请查看详情后重试。'
    : detail;

  const actionScope = () => {
    const generation = actionGeneration.current;
    const account = getAuthSessionVersion();
    const connection = getServerConnectionVersion();
    return () => mounted.current && generation === actionGeneration.current
      && account === getAuthSessionVersion() && connection === getServerConnectionVersion();
  };

  const copyDiagnostic = async () => {
    const currentAction = actionScope();
    const text = createSyncDiagnostic({ status, info, actionFailed: Boolean(actionError), connectionFailed: Boolean(connectionError), versions });
    try {
      await navigator.clipboard.writeText(text);
      if (currentAction()) setCopyMessage('已复制脱敏诊断');
    } catch {
      if (currentAction()) setCopyMessage('复制失败，请允许剪贴板访问后重试');
    }
  };

  const synchronize = async () => {
    if (disabled) return;
    if (localRootEmpty && info) {
      setActionError(null);
      setEmptyConfirmation({ serverPath, bindingEpoch: info.bindingEpoch });
      if (detailsRef.current) detailsRef.current.open = false;
      return;
    }
    const currentAction = actionScope();
    setSynchronizing(true);
    setActionError(null);
    setEmptyBackup(null);
    try {
      const result = await FrontendBridge.syncProject(serverPath);
      if (!result.ok) throw new Error(String(result.error || '同步未完成'));
    } catch (error) {
      if (currentAction()) {
        setActionError(error instanceof Error ? error.message : String(error));
        if (detailsRef.current) detailsRef.current.open = true;
      }
    } finally {
      if (currentAction()) {
        setSynchronizing(false);
        void refreshSnapshot.current();
      }
    }
  };

  const confirmEmpty = async () => {
    if (disabled || !confirmingEmpty || !emptyConfirmation) return;
    const target = emptyConfirmation;
    setEmptyConfirmation(null);
    const currentAction = actionScope();
    setSynchronizing(true);
    setActionError(null);
    setEmptyBackup(null);
    try {
      const result = await FrontendBridge.confirmProjectEmpty(target.serverPath, target.bindingEpoch).catch(() => {
        throw new Error('清空结果未知，连接未返回确认；请联系维护者核对 VPS 原目录及备份，不要再次清空。');
      });
      if (!currentAction()) return;
      if ((result.clearState === 'completed' || result.clearState === 'partial') && result.backupPath) {
        setEmptyBackup({ ...target, path: result.backupPath, complete: result.clearState === 'completed' });
      }
      if (!result.ok) {
        const detail = result.clearState === 'not-started' ? '清空未开始，未移动文件。'
          : result.clearState === 'partial' ? '仅完成部分清空，请核对 VPS 原目录和备份中的文件后再操作。'
            : result.clearState === 'completed' ? '文件已移入备份，后续同步或工作区释放未完成；请刷新状态后重新同步。'
              : '清空结果未知，请先联系维护者核对 VPS 原目录及备份，不要再次清空。';
        throw new Error(`${detail}${result.error ? ` ${result.error}` : ''}`);
      }
    } catch (error) {
      if (currentAction()) {
        setActionError(error instanceof Error ? error.message : String(error));
        if (detailsRef.current) detailsRef.current.open = true;
      }
    } finally {
      if (currentAction()) {
        setSynchronizing(false);
        void refreshSnapshot.current();
      }
    }
  };

  return (
    <section aria-label="本地与 VPS 文件同步" data-sync-status={status} className="workspace-sync-bar relative shrink-0 border-b border-border/50 px-4 py-1.5 text-xs sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <span className="shrink-0 font-medium text-foreground">本地 ↔ VPS</span>
          <span role="status" className={`inline-flex items-center gap-1.5 ${status === 'ready' ? 'text-emerald-700 dark:text-emerald-400' : problem ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground'}`}>
            <Icon aria-hidden="true" className={`h-3.5 w-3.5 shrink-0 ${synchronizing || status === 'syncing' ? 'motion-safe:animate-spin' : ''}`} />
            {label}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {status === 'unavailable' && <button type="button" onClick={() => void refreshSnapshot.current()} className="rounded px-1.5 py-1 text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">重新连接状态</button>}
          <GitSyncRecovery info={info?.serverPath === serverPath ? info : null} unavailable={Boolean(connectionError) || synchronizing} onRecovered={() => void refreshSnapshot.current()} />
          {status === 'unbound' ? (
            <button type="button" onClick={() => openSettings('chisa')} className="rounded-md border border-border px-2.5 py-1 font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">查看同步设置</button>
          ) : (
            <button
              type="button"
              onClick={() => void synchronize()}
              disabled={disabled}
              aria-busy={synchronizing}
              title={taskBusy ? '任务正在使用工作区，自动同步继续运行；任务结束后可手动同步' : localRootEmpty ? '本地目录已清空，确认后将清空 VPS 可同步文件并保留备份' : '立即完成本地与 VPS 文件同步；不会推送到 GitHub'}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1 font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RefreshCw aria-hidden="true" className={`h-3.5 w-3.5 ${synchronizing ? 'motion-safe:animate-spin' : ''}`} />
              {synchronizing ? '同步中…' : localRootEmpty ? '确认同步清空' : '立即同步'}
            </button>
          )}
          <details ref={detailsRef} className="group">
            <summary className="cursor-pointer list-none rounded px-1.5 py-1 text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">详情</summary>
            <div className="absolute right-4 top-full z-40 mt-2 w-[calc(100%-2rem)] max-h-80 max-w-[22rem] space-y-2 overflow-y-auto rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-md">
              <div><span className="text-muted-foreground">本地目录</span><div className="break-all">{info?.localPath || '未绑定或尚未确认'}</div></div>
              <div><span className="text-muted-foreground">VPS 目录</span><div className="break-all">{serverPath}</div></div>
              <p className="text-muted-foreground">“已同步”表示引擎已完成最近一轮文件同步，不保证刚保存的改动已被发现。发送任务前会再同步确认。</p>
              <p className="text-muted-foreground">仅同步源码和资源；依赖、构建产物及忽略文件不包含在内。</p>
              {connectionError && <p className="whitespace-pre-wrap break-words">{connectionError}</p>}
              {info?.detail && <p className="whitespace-pre-wrap break-words">{info.detail}</p>}
              {taskBusy && <p className="text-muted-foreground">任务正在使用工作区，自动同步继续运行；任务结束后可手动同步。</p>}
              {status === 'unbound' && <p className="text-muted-foreground">可在侧栏打开本地目录，进入它对应的同步项目。此操作不会把本地目录绑定到当前 VPS 项目；同步设置用于查看和管理已有映射。</p>}
              {actionError && <p className="whitespace-pre-wrap break-words text-amber-700 dark:text-amber-400">上次手动同步失败：{actionError}</p>}
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => { void refreshSnapshot.current(); void versions.refresh(); }} className="rounded border border-border px-2 py-1 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">刷新状态与版本</button>
                <button type="button" onClick={() => void copyDiagnostic()} className="rounded border border-border px-2 py-1 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">复制脱敏诊断</button>
              </div>
              <p className="text-muted-foreground">诊断仅含时间、同步状态、组件版本和错误类别，不含账号、目录路径、文件内容或原始错误。未读取的版本记为未知。</p>
              {copyMessage && <p role="status">{copyMessage}</p>}
            </div>
          </details>
        </div>
      </div>
      {status === 'unbound' && <p className="mt-1.5 text-muted-foreground">当前 VPS 项目尚未绑定本地目录。打开本地目录会进入其对应项目。</p>}
      {confirmingEmpty && (
        <div role="group" aria-label="确认同步清空 VPS" className="mt-2 space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
          <p className="font-medium text-foreground">本地目录已清空，是否将此变更同步到 VPS？</p>
          <div className="break-all text-muted-foreground">VPS 目录：{emptyConfirmation?.serverPath}</div>
          <p className="text-muted-foreground">仅将可同步文件移入 VPS 备份，忽略文件保留；确认后 VPS 可同步文件为空。</p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setEmptyConfirmation(null)}>取消</Button>
            <Button type="button" variant="destructive" size="sm" disabled={disabled} onClick={() => void confirmEmpty()}>确认清空 VPS</Button>
          </div>
        </div>
      )}
      {emptyBackup?.serverPath === serverPath && emptyBackup.bindingEpoch === info?.bindingEpoch && <div role="status" className="mt-1.5 break-all text-muted-foreground">{emptyBackup.complete ? 'VPS 可同步文件已移入备份：' : '已移动的部分文件可在此恢复：'}{emptyBackup.path}</div>}
      {problem && errorDetail && <div role="alert" className="mt-1.5 break-words text-amber-700 dark:text-amber-400">{summarizeError(errorDetail)}</div>}
      {actionError && !problem && <div role="alert" className="mt-1.5 break-words text-amber-700 dark:text-amber-400">手动同步未完成：{summarizeError(actionError)}</div>}
    </section>
  );
}
