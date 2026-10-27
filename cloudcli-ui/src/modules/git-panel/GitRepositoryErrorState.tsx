import { GitBranch, Loader2, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

type GitRepositoryErrorStateProps = {
  error: string;
  details?: string;
  /** When true, the project directory has no repository and `git init` can fix it. */
  canInitRepository?: boolean;
  isInitializingRepository?: boolean;
  /** Failure from the last `git init` attempt, shown below the action. */
  initError?: string | null;
  onInitRepository?: () => void;
  /** Retries the failed repository or history read. */
  onRetry?: () => void;
};

/** Matches the server's WORKSPACE_UNAVAILABLE text and its connection-level variants. */
const WORKSPACE_UNAVAILABLE = /workspace (?:connection|binding) unavailable|workspace_unavailable|ECONNREFUSED|工作区(?:未绑定|连接不可用)/i;

/** Rendered by GitPanel and HistoryView for failed reads, with optional repository initialization. */
export default function GitRepositoryErrorState({
  error,
  details,
  canInitRepository = false,
  isInitializingRepository = false,
  initError,
  onInitRepository,
  onRetry,
}: GitRepositoryErrorStateProps) {
  const { t } = useTranslation();
  const showInitAction = canInitRepository && Boolean(onInitRepository);
  // A cloud workspace outage needs an actionable retry rather than only the raw transport failure.
  const workspaceUnavailable = !showInitAction && WORKSPACE_UNAVAILABLE.test(`${error} ${details ?? ''}`);

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 py-12 text-muted-foreground">
      <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-muted/50">
        <GitBranch className="h-8 w-8 opacity-40" />
      </div>
      {showInitAction ? (
        <>
          <h3 className="mb-3 text-center text-lg font-medium text-foreground">{t('git:errorState.noRepoTitle')}</h3>
          <p className="mb-6 max-w-md text-center text-sm leading-relaxed">
            {t('git:errorState.noRepoDescription')}
          </p>
          <button
            onClick={onInitRepository}
            disabled={isInitializingRepository}
            className="flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isInitializingRepository ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                {t('git:errorState.initializing')}
              </>
            ) : (
              <>
                <GitBranch className="h-4 w-4" />
                {t('git:errorState.runGitInit')}
              </>
            )}
          </button>
          {initError && (
            <p className="mt-4 max-w-md text-center text-sm leading-relaxed text-destructive">
              {initError}
            </p>
          )}
        </>
      ) : workspaceUnavailable ? (
        <>
          <h3 className="mb-3 text-center text-lg font-medium text-foreground">云端工作区暂不可用</h3>
          <p className="mb-6 max-w-md text-center text-sm leading-relaxed">
            请确认账号服务在线，并刷新云端工作区状态后重试。
          </p>
          {onRetry && (
            <button
              onClick={onRetry}
              className="flex items-center gap-2 rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
            >
              <RefreshCw className="h-4 w-4" />
              重试
            </button>
          )}
          <details className="mt-6 max-w-md text-center">
            <summary className="cursor-pointer text-xs text-muted-foreground">技术详情</summary>
            <p className="mt-2 break-words text-xs text-muted-foreground">
              {error}
              {details ? ` · ${details}` : ''}
            </p>
          </details>
        </>
      ) : (
        <>
          <h3 className="mb-3 text-center text-lg font-medium text-foreground">{error}</h3>
          {details && (
            <p className="max-w-md text-center text-sm leading-relaxed">{details}</p>
          )}
          {onRetry && (
            <button
              onClick={onRetry}
              className="mt-4 flex items-center gap-2 rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
            >
              <RefreshCw className="h-4 w-4" />
              {t('common:buttons.retry')}
            </button>
          )}
        </>
      )}
    </div>
  );
}
