import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Monitor } from 'lucide-react';

import { api, ApiRequestError, readApiJson } from '@/shared/api';
import type { ProjectSourceMode, WorkspaceDescriptor, WorkspaceSelector } from '@/shared/types';

type IntegrationPreview = {
  baselineId: string;
  previewId: string;
  sourceRevision: string;
  targetRevision: string;
  checkpointRevision: string;
  changes: unknown[];
  conflicts: unknown[];
  canApply: boolean;
};
type IntegrationResult = { status: 'applied' | 'conflict' | 'blocked' | 'idle'; operationId?: string; changedPaths?: string[]; conflicts?: unknown[] };
type IntegrationReview = {
  key: string;
  scope: WorkspaceSelector & { projectId: string };
  preview: IntegrationPreview;
  operationId: string;
  uncertain: boolean;
};

const storageKey = (key: string) => `workspace-integration:${key}`;
function loadReview(key: string): IntegrationReview | null {
  try {
    const review = JSON.parse(sessionStorage.getItem(storageKey(key)) || 'null') as IntegrationReview | null;
    return review?.operationId && review.scope?.workspaceId && review.scope.generation && review.scope.projectId
      && review.preview?.previewId && review.preview.sourceRevision && review.preview.targetRevision
      && Array.isArray(review.preview.changes) && Array.isArray(review.preview.conflicts) ? review : null;
  } catch { return null; }
}
function persistReview(key: string, review: IntegrationReview | null) {
  try {
    if (review) sessionStorage.setItem(storageKey(key), JSON.stringify(review));
    else sessionStorage.removeItem(storageKey(key));
  } catch { /* In-memory ownership still protects retries when browser storage is unavailable. */ }
}
function describeChange(change: unknown): string {
  if (typeof change === 'string') return change;
  if (change && typeof change === 'object') {
    const value = change as Record<string, unknown>;
    return [value.path ?? value.filePath, value.kind ?? value.type ?? value.reason].filter(Boolean).join(' · ') || JSON.stringify(change);
  }
  return String(change);
}

function LocalWorkspaceStatus({ label, warning, children }: { label: string; warning: boolean; children: ReactNode }) {
  // Keep workspace details off the canvas until the user opens this header control.
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const id = useId();
  useLayoutEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const trigger = triggerRef.current;
    if (!panel || !trigger) return;
    const position = () => {
      const bounds = trigger.getBoundingClientRect();
      const width = Math.min(320, window.innerWidth - 24);
      panel.style.width = `${width}px`;
      panel.style.left = `${Math.max(12, Math.min(bounds.left, window.innerWidth - width - 12))}px`;
      panel.style.top = `${Math.max(12, Math.min(bounds.bottom + 8, window.innerHeight - panel.offsetHeight - 12))}px`;
    };
    // Native auto-popovers stay above the desktop webview's stacking contexts and support light dismissal.
    panel.setAttribute('popover', 'auto');
    const native = panel as HTMLDivElement & { showPopover?: () => void; hidePopover?: () => void };
    native.showPopover?.();
    position();
    panel.querySelector<HTMLButtonElement>('button')?.focus();
    const closeOutside = (event: PointerEvent) => { if (!panel.contains(event.target as Node) && !trigger.contains(event.target as Node)) setOpen(false); };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setOpen(false); trigger.focus(); } };
    const onToggle = (event: Event) => { if ((event as Event & { newState?: string }).newState === 'closed') setOpen(false); };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    panel.addEventListener('toggle', onToggle);
    window.addEventListener('resize', position);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
      panel.removeEventListener('toggle', onToggle);
      window.removeEventListener('resize', position);
      if (panel.contains(document.activeElement)) trigger.focus();
      native.hidePopover?.();
    };
  }, [open]);
  return <>
    <button ref={triggerRef} type="button" aria-label="本地工作区状态" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(value => !value)}
      className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60" style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}>
      <Monitor className="h-3.5 w-3.5" aria-hidden="true" /><span className={`h-1.5 w-1.5 rounded-full ${warning ? 'bg-amber-500' : label === '本地' ? 'bg-emerald-500' : 'bg-muted-foreground'}`} aria-hidden="true" /><span aria-live="polite">{label}</span><ChevronDown className="h-3 w-3" aria-hidden="true" />
    </button>
    {open && createPortal(<div ref={panelRef} id={id} role="dialog" aria-label="本地工作区详情" className="fixed z-[100] m-0 max-h-[min(70vh,420px)] overflow-y-auto rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-lg" style={{ inset: 'auto', WebkitAppRegion: 'no-drag' } as CSSProperties}>{children}</div>, document.body)}
  </>;
}

/** WorkspaceMain places SSH status in its header; cloud projects retain the workspace selector and integration review. */
export function WorkspaceScopeBar({ selectionKey, workspace, session, kind, hasSession, loading, error, onSelect, onRefresh, sourceMode, displayPath, agentStatus }: {
  selectionKey: string;
  workspace: WorkspaceDescriptor | null;
  session: WorkspaceDescriptor | null;
  kind: WorkspaceDescriptor['kind'];
  hasSession: boolean;
  loading: boolean;
  error: string | null;
  onSelect: (kind: WorkspaceDescriptor['kind']) => void;
  onRefresh: () => void;
  sourceMode?: ProjectSourceMode;
  displayPath?: string;
  agentStatus?: ReactNode;
}) {
  const sessionKey = JSON.stringify([session?.workspaceId, session?.generation]);
  const sessionKeyRef = useRef(sessionKey);
  sessionKeyRef.current = sessionKey;
  // Keep the reviewed selector and operation through resolution outages, navigation and reloads.
  const [review, setReviewState] = useState<IntegrationReview | null>(() => loadReview(selectionKey));
  // Prevent overlapping integration requests and identify the operation shown as busy.
  const [pending, setPending] = useState<'preview' | 'apply' | 'recover' | null>(null);
  // Retain the last integration outcome or recovery instruction across status refreshes.
  const [integrationMessage, setIntegrationMessage] = useState<string | null>(null);
  const requestRef = useRef(0);
  const uncertain = review?.uncertain === true;
  const setReview = (value: IntegrationReview | null) => {
    persistReview(selectionKey, value);
    setReviewState(value);
  };
  useEffect(() => () => { ++requestRef.current; }, []);
  const currentReview = uncertain || review?.key === sessionKey ? review : null;
  const canIntegrate = Boolean(session?.capabilities.integrate);

  const preview = async () => {
    if (!session || !canIntegrate || pending || uncertain) return;
    const request = ++requestRef.current;
    setPending('preview');
    setIntegrationMessage(null);
    setReview(null);
    const scope = { projectId: session.projectId, workspaceId: session.workspaceId, generation: session.generation };
    try {
      const response = await api.workspaces.previewIntegration(scope);
      const data = await readApiJson<IntegrationPreview>(response);
      if (request !== requestRef.current || sessionKeyRef.current !== sessionKey) return;
      if (!data.previewId || !data.sourceRevision || !data.targetRevision || !Array.isArray(data.changes) || !Array.isArray(data.conflicts) || typeof data.canApply !== 'boolean') throw new Error('集成预览无效，请刷新后重试');
      setReview({ key: sessionKey, scope, preview: data, operationId: crypto.randomUUID(), uncertain: false });
    } catch (failure) {
      if (request === requestRef.current && sessionKeyRef.current === sessionKey) setIntegrationMessage(failure instanceof Error ? failure.message : String(failure));
    } finally { if (request === requestRef.current) setPending(null); }
  };
  const apply = async () => {
    if (!currentReview || pending || (!uncertain && (!canIntegrate || !currentReview.preview.canApply || currentReview.preview.conflicts.length > 0))) return;
    const request = ++requestRef.current;
    // Persist before dispatch: a dropped response must never generate a second operation.
    setReview({ ...currentReview, uncertain: true });
    setPending('apply');
    setIntegrationMessage(null);
    try {
      const response = await api.workspaces.applyIntegration({
        ...currentReview.scope,
        previewId: currentReview.preview.previewId, expectedSourceRevision: currentReview.preview.sourceRevision,
        expectedTargetRevision: currentReview.preview.targetRevision, operationId: currentReview.operationId,
      });
      const data = await readApiJson<IntegrationResult>(response);
      if (request !== requestRef.current) return;
      if (!['applied', 'conflict'].includes(data.status) || data.operationId !== currentReview.operationId) throw new Error('尚未确认集成结果，请恢复或重试同一操作');
      if (data.status === 'conflict' && currentReview.uncertain) throw new Error('当前预览存在冲突，但先前操作结果尚未确认，请检查恢复状态');
      setReview(null);
      setIntegrationMessage(data.status === 'applied'
        ? `已集成到主工作区（${data.changedPaths?.length ?? 0} 个路径）。`
        : `集成存在冲突：${(data.conflicts ?? []).map(describeChange).join('；') || '请重新预览并检查冲突。'}`);
      onRefresh();
    } catch (failure) {
      if (request !== requestRef.current) return;
      const beforeFirstWrite = !currentReview.uncertain && failure instanceof ApiRequestError
        && ['WORKSPACE_CHANGES_STALE', 'WORKSPACE_CHANGES_INPUT', 'WORKSPACE_BASELINE_UNAVAILABLE', 'INVALID_WORKSPACE_REQUEST'].includes(failure.code ?? '');
      if (beforeFirstWrite) setReview(null);
      setIntegrationMessage(`${failure instanceof Error ? failure.message : String(failure)}。${beforeFirstWrite ? '本次操作未写入，请重新预览。' : '结果尚未确认，重试将使用同一操作编号。'}`);
    } finally { if (request === requestRef.current) setPending(null); }
  };

  const recover = async () => {
    if (pending) return;
    const scope = currentReview?.scope ?? (session && { projectId: session.projectId, workspaceId: session.workspaceId, generation: session.generation });
    if (!scope) return;
    const request = ++requestRef.current;
    setPending('recover');
    setIntegrationMessage(null);
    try {
      const data = await readApiJson<IntegrationResult>(await api.workspaces.recoverIntegration(scope));
      if (request !== requestRef.current) return;
      if (data.status === 'applied') {
        if (currentReview && data.operationId !== currentReview.operationId) throw new Error('恢复返回了另一操作编号，仍需确认原操作');
        setReview(null);
        setIntegrationMessage(`已恢复并确认集成（${data.changedPaths?.length ?? 0} 个路径）。`);
      } else if (data.status === 'idle') {
        setIntegrationMessage(uncertain ? '当前没有待恢复日志；原集成结果仍未确认，请重试同一集成操作查询回执。' : '当前没有待恢复的集成日志。');
      } else if (data.status === 'blocked') {
        setIntegrationMessage(`恢复被阻止：${(data.conflicts ?? []).map(describeChange).join('；') || '目标工作区已变化，请处理后再恢复。'}`);
      } else throw new Error('恢复结果无效，原操作仍保留');
      onRefresh();
    } catch (failure) {
      if (request === requestRef.current) setIntegrationMessage(`${failure instanceof Error ? failure.message : String(failure)}。原操作编号仍保留。`);
    } finally { if (request === requestRef.current) setPending(null); }
  };

  const recoverLocal = async (cancel = false) => {
    const local = workspace ?? session;
    if (!local || pending) return;
    const request = ++requestRef.current;
    setPending('recover');
    setIntegrationMessage(null);
    try {
      const result = await readApiJson<{ status: 'idle' | 'running'; jobId?: string; inspectChanges?: boolean }>(await api.sshWorkspaces.recover({ projectId: local.projectId, generation: local.generation, ...(cancel ? { cancel: true } : {}) }));
      if (request !== requestRef.current) return;
      if (result.status !== 'idle' && result.status !== 'running') throw new Error('未收到有效的本地任务状态。');
      setIntegrationMessage(result.status === 'idle' ? result.inspectChanges ? '已恢复连接，请检查上次改动结果后继续。' : '已确认本地任务结束，可以继续操作。' : '原本地任务仍在运行；可以等待，或停止该任务后再继续。');
      onRefresh();
    } catch (failure) { if (request === requestRef.current) setIntegrationMessage(failure instanceof Error ? failure.message : '无法确认本地任务状态。'); }
    finally { if (request === requestRef.current) setPending(null); }
  };

  if (sourceMode === 'ssh' || workspace?.sourceMode === 'ssh' || session?.sourceMode === 'ssh') {
    const local = workspace ?? session;
    const connectionLabel = local?.connectionState === 'online' ? '在线' : local?.connectionState === 'recovery' ? '等待恢复' : local?.connectionState === 'offline' ? '离线' : '连接状态未确认';
    const accessLabel = !local ? '工作区尚未确认' : local.phase === 'recovery' || local.connectionState === 'recovery' ? '等待确认上次操作结果，暂时暂停写入' : local.connectionState === 'offline' ? '连接离线，等待桌面恢复' : local.phase === 'running' ? '任务运行或检查占用中，完成后可刷新状态' : !local.capabilities.write ? '只读：服务器未授予写入权限' : '可写';
    const needsRecovery = local?.phase === 'recovery' || local?.connectionState === 'recovery';
    const disconnected = Boolean(error) || local?.connectionState === 'offline';
    const label = needsRecovery ? '需恢复' : disconnected ? '连接断开' : loading ? '检查中' : !local ? '未连接' : local.phase === 'running' ? '运行中' : !local.capabilities.write ? '只读' : local.connectionState === 'online' ? '本地' : '待确认';
    return <LocalWorkspaceStatus label={label} warning={needsRecovery || disconnected}>
      <div className="space-y-3 text-sm">
        <div className="flex items-center justify-between gap-3"><span className="font-medium">本地工作区</span><button type="button" className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60" onClick={onRefresh}>刷新状态</button></div>
        <p className="break-all text-xs text-muted-foreground">{local?.displayPath || displayPath || '本地项目目录'}</p>
        <p role={error ? 'alert' : 'status'} className="text-xs text-muted-foreground">{error || (loading ? '正在检查本地工作区…' : `${connectionLabel} · ${accessLabel}`)}</p>
        {needsRecovery && <div className="flex flex-wrap gap-2"><button type="button" className="rounded-md border border-border px-2 py-1.5 text-xs disabled:opacity-50" disabled={Boolean(pending)} onClick={() => void recoverLocal()}>检查原任务</button><button type="button" className="rounded-md border border-border px-2 py-1.5 text-xs disabled:opacity-50" disabled={Boolean(pending)} onClick={() => void recoverLocal(true)}>停止原任务并恢复</button></div>}
        {integrationMessage && <p role="status" className="text-xs">{integrationMessage}</p>}
        <details className="border-t border-border pt-2"><summary className="cursor-pointer text-xs text-muted-foreground">连接详情</summary><div className="space-y-2 pt-3 text-xs text-muted-foreground"><p>Windows 共享目录 · Claude 在云端运行</p><p>当前仅支持 Claude；本地不提供独立会话工作区、改动集成和云端预览。Windows 命令逐行执行，不保留变量或目录切换。</p>{local?.connectionState !== 'online' && agentStatus}</div></details>
      </div>
    </LocalWorkspaceStatus>;
  }

  return <div className="shrink-0 border-b border-border bg-muted/20 px-3 py-2 text-xs">
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-muted-foreground">文件 / Git / 终端</span>
      <button type="button" className={`rounded border px-2 py-1 ${kind === 'cloudReplica' ? 'bg-accent font-medium' : ''}`} aria-pressed={kind === 'cloudReplica'} onClick={() => onSelect('cloudReplica')}>主工作区</button>
      <button type="button" className={`rounded border px-2 py-1 ${kind === 'session' ? 'bg-accent font-medium' : ''}`} aria-pressed={kind === 'session'} disabled={!hasSession} onClick={() => onSelect('session')}>会话工作区</button>
      <button type="button" className="rounded border px-2 py-1" onClick={onRefresh}>刷新状态</button>
      {session && <button type="button" className="rounded border px-2 py-1 disabled:opacity-50" disabled={!canIntegrate || Boolean(pending) || uncertain} onClick={() => void preview()}>{pending === 'preview' ? '正在预览…' : '预览并集成到云端'}</button>}
      {(uncertain || session?.phase === 'recovery') && <button type="button" className="rounded border px-2 py-1 disabled:opacity-50" disabled={Boolean(pending)} onClick={() => void recover()}>{pending === 'recover' ? '正在恢复…' : '检查并恢复集成'}</button>}
    </div>
    <div role="status" className="mt-1 break-all text-muted-foreground">
      {error || (loading ? '正在读取工作区状态…' : !workspace ? '工作区尚未准备好，请刷新状态或选择主工作区。' : `${workspace.rootPath} · ${workspace.effectiveMode === 'isolated' ? '隔离执行' : '共享执行'} · ${workspace.phase === 'running' ? '运行中' : workspace.phase === 'recovery' ? '等待恢复' : '空闲'} · ${workspace.publicationState === 'integrated' ? '已集成' : workspace.publicationState === 'conflicted' ? '存在冲突' : '尚未集成'}`)}
      {!loading && !error && workspace && !workspace.capabilities.write && (workspace.phase === 'running' ? ' · 任务运行或检查占用中，暂时暂停写入' : workspace.phase === 'recovery' ? ' · 等待确认上次操作结果，暂时暂停写入' : ' · 只读：服务器未授予写入权限')}
    </div>
    {currentReview && <section aria-label="集成预览" className="mt-2 rounded border border-border bg-background p-3">
      <p>将会话中的 {currentReview.preview.changes.length} 项变更集成到主工作区。目标变化后需要重新预览。</p>
      <ul className="my-2 max-h-36 overflow-auto">{currentReview.preview.changes.map((change, index) => <li key={index}>{describeChange(change)}</li>)}</ul>
      {currentReview.preview.conflicts.length > 0 && <div role="alert">冲突：{currentReview.preview.conflicts.map(describeChange).join('；')}</div>}
      {uncertain && <p role="status">上一次集成结果尚未确认，请重试同一操作。</p>}
      <div className="mt-2 flex gap-2">
        <button type="button" className="rounded border px-2 py-1 disabled:opacity-50" disabled={Boolean(pending) || (!uncertain && (!canIntegrate || !currentReview.preview.canApply || currentReview.preview.conflicts.length > 0))} onClick={() => void apply()}>{pending === 'apply' ? '正在确认结果…' : uncertain ? '重试同一集成操作' : '确认集成'}</button>
        <button type="button" className="rounded border px-2 py-1 disabled:opacity-50" disabled={Boolean(pending) || uncertain} onClick={() => setReview(null)}>取消</button>
      </div>
    </section>}
    {integrationMessage && <p role="status" className="mt-2 whitespace-pre-wrap">{integrationMessage}</p>}
  </div>;
}
