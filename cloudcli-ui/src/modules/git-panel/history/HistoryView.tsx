import { History, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { GitDiffMap, GitCommitSummary } from '@/shared/types';
import { computeCommitGraph } from '@/modules/git-panel/utils/commitGraph';
import CommitHistoryItem from '@/modules/git-panel/history/CommitHistoryItem';
import GitRepositoryErrorState from '@/modules/git-panel/GitRepositoryErrorState';

type HistoryViewProps = {
  isMobile: boolean;
  isLoading: boolean;
  error: string | null;
  recentCommits: GitCommitSummary[];
  commitDiffs: GitDiffMap;
  commitDiffErrors: Record<string, string>;
  wrapText: boolean;
  onRetry: () => Promise<void>;
  onFetchCommitDiff: (commitHash: string, signal?: AbortSignal) => Promise<void>;
};

/** Rendered by GitPanel for the Commits tab, listing recent commits and their diffs. */
export default function HistoryView({
  isMobile,
  isLoading,
  error,
  recentCommits,
  commitDiffs,
  commitDiffErrors,
  wrapText,
  onRetry,
  onFetchCommitDiff,
}: HistoryViewProps) {
  const { t } = useTranslation();
  // Expansion owns each lazy diff request, allowing collapse to cancel its read.
  const [expandedCommits, setExpandedCommits] = useState<Set<string>>(new Set());
  // Completion triggers a render so an invalidated, still-expanded diff can reload.
  const [loadingCommitDiffs, setLoadingCommitDiffs] = useState<Set<string>>(new Set());
  const requestsRef = useRef(new Map<string, AbortController>());

  // Lane layout for the commit graph; rows align 1:1 with recentCommits.
  // Older API responses without `parents` degrade to plain rows (no strip).
  const graphRows = useMemo(() => {
    if (!recentCommits.some((commit) => commit.parents !== undefined)) return null;
    return computeCommitGraph(recentCommits);
  }, [recentCommits]);

  const loadCommitDiff = useCallback((commitHash: string) => {
    if (requestsRef.current.has(commitHash)) return;
    const controller = new AbortController();
    requestsRef.current.set(commitHash, controller);
    setLoadingCommitDiffs(previous => new Set(previous).add(commitHash));
    void onFetchCommitDiff(commitHash, controller.signal).finally(() => {
      if (requestsRef.current.get(commitHash) !== controller) return;
      requestsRef.current.delete(commitHash);
      setLoadingCommitDiffs(previous => {
        const next = new Set(previous);
        next.delete(commitHash);
        return next;
      });
    });
  }, [onFetchCommitDiff]);

  useEffect(() => {
    for (const [hash, controller] of requestsRef.current) {
      if (!expandedCommits.has(hash) || !recentCommits.some(commit => commit.hash === hash)) {
        controller.abort();
        requestsRef.current.delete(hash);
        setLoadingCommitDiffs(previous => {
          const next = new Set(previous);
          next.delete(hash);
          return next;
        });
      }
    }
    for (const hash of expandedCommits) {
      if (recentCommits.some(commit => commit.hash === hash)
        && !Object.prototype.hasOwnProperty.call(commitDiffs, hash) && !commitDiffErrors[hash]) {
        loadCommitDiff(hash);
      }
    }
  }, [commitDiffErrors, commitDiffs, expandedCommits, loadCommitDiff, loadingCommitDiffs, recentCommits]);

  useEffect(() => () => {
    requestsRef.current.forEach(controller => controller.abort());
    requestsRef.current.clear();
  }, []);

  const toggleCommitExpanded = useCallback((commitHash: string) => {
    if (expandedCommits.has(commitHash)) requestsRef.current.get(commitHash)?.abort();
    setExpandedCommits(previous => {
      const next = new Set(previous);
      if (next.has(commitHash)) next.delete(commitHash);
      else next.add(commitHash);
      return next;
    });
  }, [expandedCommits]);

  return (
    <div className="flex-1 overflow-y-auto">
      {error && <GitRepositoryErrorState error={error} onRetry={() => void onRetry()} />}
      {isLoading ? (
        <div className="flex h-32 items-center justify-center" role="status" aria-label={t('common:status.loading')}>
          <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : recentCommits.length === 0 ? (
        !error && <div className="flex h-32 flex-col items-center justify-center text-muted-foreground">
          <History className="mb-2 h-10 w-10 opacity-40" />
          <p className="text-sm">{t('git:history.noCommits')}</p>
        </div>
      ) : (
        <div className={isMobile ? 'pb-4' : ''}>
          {recentCommits.map((commit, index) => (
            <CommitHistoryItem
              key={commit.hash}
              commit={commit}
              isExpanded={expandedCommits.has(commit.hash)}
              diff={commitDiffs[commit.hash]}
              diffError={commitDiffErrors[commit.hash]}
              isDiffLoading={loadingCommitDiffs.has(commit.hash)}
              onRetryDiff={() => loadCommitDiff(commit.hash)}
              isMobile={isMobile}
              wrapText={wrapText}
              graphRow={graphRows?.[index]}
              onToggle={() => toggleCommitExpanded(commit.hash)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
