import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { FrontendBridge } from '@/shared/chisa';
import type { ChisaGitRecovery, ChisaGitRecoverySource, ChisaSyncInfo } from '@/shared/types';
import { Button, Dialog, DialogContent, DialogTitle, DialogTrigger } from '@/shared/ui';

type GitSyncRecoveryProps = {
  info: ChisaSyncInfo | null | undefined;
  unavailable?: boolean;
  // Refresh authoritative state after success or when the user checks progress after a failed attempt.
  onRecovered: () => void;
};

type RecoveryReview =
  | { phase: 'idle' | 'loading' | 'success' }
  | { phase: 'error' | 'stale' | 'retry'; error: string }
  | { phase: 'ready' | 'recovering'; recovery: ChisaGitRecovery; error?: string };

/** Project-workspace and settings use this entry to review paused or blocked bindings without opening the project. */
export function GitSyncRecovery({ info, unavailable = false, onRecovered }: GitSyncRecoveryProps) {
  // Paused sessions survive restarts, unlike an in-memory direction failure.
  // Offer an on-demand read; only its authoritative preview can enable recovery.
  if (!info || unavailable || (info.status !== 'paused' && (info.status !== 'blocked' || !info.gitRecoveryRequired)) || info.taskOwner || !info.bindingEpoch) return null;
  // Losing admission or changing bindings unmounts the review, so an old choice cannot be reused.
  return <RecoveryEntry key={`${info.serverPath}:${info.bindingEpoch}`} info={info} onRecovered={onRecovered} />;
}

function RecoveryEntry({ info, onRecovered }: { info: ChisaSyncInfo; onRecovered: () => void }) {
  // Opening is the only automatic trigger for reading the two Git states.
  const [open, setOpen] = useState(false);
  // A token and its error stay together so stale observations never remain confirmable.
  const [review, setReview] = useState<RecoveryReview>({ phase: 'idle' });
  // The user must explicitly choose an available authority for every fresh observation.
  const [source, setSource] = useState<ChisaGitRecoverySource | null>(null);
  const requestVersion = useRef(0);
  const requestBusy = useRef(false);
  const titleId = useId();
  const sourceName = useId();
  const { serverPath, bindingEpoch } = info;

  const load = useCallback(async () => {
    const version = ++requestVersion.current;
    requestBusy.current = true;
    setSource(null);
    setReview({ phase: 'loading' });
    try {
      const result = await FrontendBridge.getProjectGitRecovery(serverPath, bindingEpoch);
      if (version !== requestVersion.current) return;
      if (!result.ok) {
        setReview({ phase: result.code === 'GIT_RECOVERY_STALE' ? 'stale' : 'error', error: result.error || '无法查看 Git 恢复状态。' });
      } else if (!result.recovery?.token || result.recovery.serverPath !== serverPath || result.recovery.bindingEpoch !== bindingEpoch) {
        setReview({ phase: 'stale', error: '项目绑定或 Git 状态已变化。' });
      } else {
        setReview({ phase: 'ready', recovery: result.recovery });
      }
    } catch (error) {
      if (version === requestVersion.current) setReview({ phase: 'error', error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (version === requestVersion.current) requestBusy.current = false;
    }
  }, [serverPath, bindingEpoch]);

  const cancelRequest = useCallback(() => {
    // Reads and mutations completing after close/unmount cannot restore an old confirmation.
    requestVersion.current++;
    requestBusy.current = false;
  }, []);

  useEffect(() => cancelRequest, [cancelRequest]);

  const changeOpen = (next: boolean) => {
    if (review.phase === 'recovering') return;
    if (!next) {
      cancelRequest();
      setSource(null);
      setReview({ phase: 'idle' });
    } else if (!open) {
      void load();
    }
    setOpen(next);
  };

  const recover = async () => {
    if (review.phase !== 'ready' || !source || requestBusy.current) return;
    const { recovery } = review;
    if (source === 'local' ? !recovery.localAllowed : !recovery.remoteAllowed) return;
    const version = ++requestVersion.current;
    requestBusy.current = true;
    setReview({ phase: 'recovering', recovery });
    try {
      const result = await FrontendBridge.recoverProjectGit(serverPath, bindingEpoch, recovery.token, source);
      if (version !== requestVersion.current) return;
      if (result.ok) {
        setReview({ phase: 'success' });
        onRecovered();
      } else if (result.code === 'GIT_RECOVERY_STALE') {
        setSource(null);
        setReview({ phase: 'stale', error: String(result.error || '两端 Git 状态或项目绑定已变化。') });
      } else if (result.code === 'GIT_RECOVERY_RETRY') {
        setSource(null);
        setReview({ phase: 'retry', error: String(result.error || 'Git 状态恢复未完成，请刷新项目状态或重新查看。') });
      } else {
        setReview({ phase: 'ready', recovery, error: String(result.error || 'Git 状态恢复未完成，请重试。') });
      }
    } catch (error) {
      if (version === requestVersion.current) {
        // A lost response may follow token consumption or partial progress; never reuse that confirmation.
        setSource(null);
        setReview({ phase: 'retry', error: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      if (version === requestVersion.current) requestBusy.current = false;
    }
  };

  const recovery = review.phase === 'ready' || review.phase === 'recovering' ? review.recovery : null;
  const recovering = review.phase === 'recovering';
  const sourceAllowed = recovery && (source === 'local' ? recovery.localAllowed : source === 'remote' && recovery.remoteAllowed);

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger className="shrink-0 rounded-md border border-border px-2.5 py-1 text-xs font-medium outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">恢复 Git 状态</DialogTrigger>
      {open && (
        <DialogContent aria-labelledby={titleId} aria-busy={review.phase === 'loading' || recovering} wrapperClassName="z-[10000]" className="flex max-h-[calc(100dvh-2rem)] max-w-2xl flex-col overflow-hidden p-5">
          <DialogTitle id={titleId} className="not-sr-only text-base font-semibold">恢复 Git 同步状态</DialogTitle>
          <div className="mt-3 min-h-0 space-y-4 overflow-y-auto text-sm">
            <p className="break-all text-xs text-muted-foreground">VPS 项目：{serverPath}</p>
            <p className="text-muted-foreground">选择作为依据的一端，将其 Git 分支、提交和暂存状态同步到另一端。项目文件仍安全双向同步；文件冲突仍需处理。此操作不会推送到 GitHub。</p>
            {review.phase === 'loading' && <p role="status">正在查看两端 Git 状态…</p>}
            {recovery && (
              <fieldset disabled={recovering} className="grid min-w-0 gap-3 sm:grid-cols-2">
                <legend className="mb-2 font-medium">选择 Git 状态来源</legend>
                {(['local', 'remote'] as const).map(side => {
                  const git = recovery[side];
                  const allowed = side === 'local' ? recovery.localAllowed : recovery.remoteAllowed;
                  const reason = side === 'local' ? recovery.localReason : recovery.remoteReason;
                  const label = side === 'local' ? '本地' : 'VPS';
                  return (
                    <div key={side} role="group" aria-label={`${label} Git 状态`} className="min-w-0 space-y-3 rounded-lg border border-border p-3">
                      <h3 className="font-medium">{label}</h3>
                      <dl className="space-y-2 text-xs">
                        <div><dt className="text-muted-foreground">分支</dt><dd className="break-all">{git.branch || '无分支名称'}</dd></div>
                        <div><dt className="text-muted-foreground">提交（HEAD）</dt><dd className="break-all font-mono">{git.head || '未报告提交'}</dd></div>
                        <div><dt className="text-muted-foreground">暂存区</dt><dd>{git.staged ? '有暂存变更' : '无暂存变更'}</dd></div>
                        <div><dt className="text-muted-foreground">进行中的操作</dt><dd className="break-words">{git.operation || '无'}</dd></div>
                      </dl>
                      <label className="flex items-start gap-2 text-sm">
                        <input type="radio" name={sourceName} value={side} checked={source === side} disabled={!allowed || recovering} onChange={() => setSource(side)} className="mt-1 accent-primary" />
                        <span>以{label} Git 状态为准</span>
                      </label>
                      {(reason || !allowed) && <p className="break-words text-xs text-muted-foreground">{reason || '当前不能使用此端作为恢复来源。'}</p>}
                    </div>
                  );
                })}
              </fieldset>
            )}
            {'error' in review && <p role="alert" className="whitespace-pre-wrap break-words text-destructive">{review.error}</p>}
            {review.phase === 'stale' && <p className="text-muted-foreground">原确认已失效，请重新查看两端状态并选择来源。</p>}
            {review.phase === 'retry' && <p className="text-muted-foreground">本次恢复未确认完成，原确认不能再次使用。请刷新项目状态；若仍需恢复，请重新查看两端状态并选择来源。已恢复 Git 状态但文件同步未完成时，可继续普通同步。</p>}
            {recovering && <p role="status">正在恢复 Git 状态，请稍候…</p>}
            {review.phase === 'success' && <p role="status">Git 状态已恢复。项目文件继续安全双向同步。</p>}
          </div>
          <div className="mt-4 flex shrink-0 flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" size="sm" disabled={recovering} onClick={() => changeOpen(false)}>关闭</Button>
            {'error' in review && !recovery && <Button type="button" variant="outline" size="sm" onClick={onRecovered}>刷新项目状态</Button>}
            {(review.phase === 'error' || review.phase === 'stale' || review.phase === 'retry') && <Button type="button" size="sm" onClick={() => void load()}>{review.phase === 'error' ? '重试查看' : '重新查看'}</Button>}
            {recovery && <Button type="button" size="sm" disabled={recovering || !sourceAllowed} onClick={() => void recover()}>{recovering ? '恢复中…' : review.phase === 'ready' && review.error ? '重试恢复' : '确认恢复 Git 状态'}</Button>}
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
