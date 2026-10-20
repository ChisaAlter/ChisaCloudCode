import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@/shared/api';
import { isDesktop, onWorkspaceSyncStateChanged } from '@/shared/chisa';
import type { FileOpenHandler, GitApiErrorResponse, GitCommitSummary, GitDiffMap, GitOperationResponse, GitPanelView, GitRemoteStatus, GitStatusResponse, Project } from '@/shared/types';
import { GIT_STATUS_OBSERVED_EVENT } from '@/shared/constants';
import { useSelectedProvider } from '@/modules/git-panel/hooks/useSelectedProvider';

const DEFAULT_BRANCH = 'main';
// High enough for the commit graph to show meaningful branch structure.
const RECENT_COMMITS_LIMIT = 50;

type UseGitPanelControllerOptions = {
  selectedProject: Project | null;
  activeView: GitPanelView;
  onFileOpen?: FileOpenHandler;
};

type GitPanelController = {
  gitStatus: GitStatusResponse | null;
  gitDiff: GitDiffMap;
  isLoading: boolean;
  isLoadingCommits: boolean;
  commitsError: string | null;
  retryCommits: () => Promise<void>;
  currentBranch: string;
  branches: string[];
  localBranches: string[];
  remoteBranches: string[];
  recentCommits: GitCommitSummary[];
  commitDiffs: GitDiffMap;
  commitDiffErrors: Record<string, string>;
  remoteStatus: GitRemoteStatus | null;
  isCreatingBranch: boolean;
  isBranchBusy: boolean;
  isFetching: boolean;
  isPulling: boolean;
  isPushing: boolean;
  isPublishing: boolean;
  isCreatingInitialCommit: boolean;
  isInitializingRepository: boolean;
  operationError: string | null;
  clearOperationError: () => void;
  reportOperationError: (error: unknown) => void;
  refreshAll: () => Promise<void>;
  switchBranch: (branchName: string) => Promise<boolean>;
  createBranch: (branchName: string) => Promise<boolean>;
  deleteBranch: (branchName: string, force?: boolean) => Promise<boolean>;
  handleFetch: () => Promise<void>;
  handlePull: () => Promise<void>;
  handlePush: () => Promise<void>;
  handlePublish: () => Promise<void>;
  discardChanges: (filePath: string) => Promise<void>;
  deleteUntrackedFile: (filePath: string) => Promise<void>;
  stageFiles: (files: string[]) => Promise<boolean>;
  unstageFiles: (files: string[]) => Promise<boolean>;
  fetchCommitDiff: (commitHash: string, signal?: AbortSignal) => Promise<void>;
  fetchFileDiff: (filePath: string, signal?: AbortSignal) => Promise<void>;
  generateCommitMessage: (files: string[]) => Promise<string | null>;
  commitChanges: (message: string, files: string[]) => Promise<boolean>;
  createInitialCommit: () => Promise<boolean>;
  initRepository: () => Promise<boolean>;
  openFile: (filePath: string) => Promise<void>;
};

type GitDiffResponse = GitApiErrorResponse & {
  diff?: string;
};

type GitBranchesResponse = GitApiErrorResponse & {
  branches?: string[];
  localBranches?: string[];
  remoteBranches?: string[];
};

type GitCommitsResponse = GitApiErrorResponse & {
  commits?: GitCommitSummary[];
};

type GitGenerateMessageResponse = GitApiErrorResponse & {
  message?: string;
};

type GitFileWithDiffResponse = GitApiErrorResponse & {
  oldContent?: string;
  currentContent?: string;
  isDeleted?: boolean;
  isUntracked?: boolean;
};

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

async function readWithAbort<T>(read: () => Promise<T>, signal: AbortSignal): Promise<T> {
  // Release the UI's request ownership immediately even if a transport ignores cancellation.
  let cancel!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    cancel = () => reject(new DOMException('Request aborted', 'AbortError'));
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  });
  try {
    return await Promise.race([read(), aborted]);
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

function readErrorText(value: unknown): string | undefined {
  const message = value && typeof value === 'object' && 'message' in value ? value.message : value;
  if (typeof message !== 'string') return undefined;
  const normalized = message.trim().replace(/\s+/g, ' ');
  // Keep the actionable prefix while hiding embedded native/SSH stack traces.
  const text = normalized.split(/Traceback \(most recent call last\):|\bexit status \d+:|\b(?:RuntimeError|TypeError|SyntaxError|ReferenceError):|<!doctype|<html\b/i, 1)[0].trim().replace(/[:：]\s*$/, '');
  // Transport diagnostics, serialized JSON and proxy HTML are not user-facing text.
  if (!text || /^(?:\{|\[|<)/.test(text)) return undefined;
  return text.length > 240 ? `${text.slice(0, 239)}…` : text;
}

async function readJson<T>(response: Response, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) {
    throw new DOMException('Request aborted', 'AbortError');
  }

  const invalidResponse = response.ok
    ? 'Git returned an invalid response. Please try again.'
    : `Git request failed (HTTP ${response.status})`;
  let raw: unknown;
  try {
    raw = await response.json();
  } catch (error) {
    if (signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
    if (isAbortError(error)) throw error;
    throw new Error(invalidResponse);
  }

  if (signal?.aborted) {
    throw new DOMException('Request aborted', 'AbortError');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(invalidResponse);
  }

  const data = raw as Record<string, unknown>;
  const envelopeError = data.error && typeof data.error === 'object'
    ? data.error as Record<string, unknown>
    : undefined;
  const failed = !response.ok || data.success === false || Boolean(data.error);
  // Keep the controller's renderable state string-only even when the backend
  // sends a structured AppError or a native transport diagnostics object.
  return {
    ...data,
    error: failed
      ? readErrorText(data.error) ?? readErrorText(data.message) ?? (response.ok ? 'Git operation failed' : invalidResponse)
      : undefined,
    details: readErrorText(data.details) ?? readErrorText(envelopeError?.details),
    ...(failed ? { success: false } : {}),
  } as T;
}

export function useGitPanelController({
  selectedProject,
  activeView,
  onFileOpen,
}: UseGitPanelControllerOptions): GitPanelController {
  const [gitStatus, setGitStatus] = useState<GitStatusResponse | null>(null);
  const [gitDiff, setGitDiff] = useState<GitDiffMap>({});
  const [isLoading, setIsLoading] = useState(false);
  const [currentBranch, setCurrentBranch] = useState('');
  const [branches, setBranches] = useState<string[]>([]);
  const [recentCommits, setRecentCommits] = useState<GitCommitSummary[]>([]);
  // Separate from `isLoading` (status) so History never flashes "No commits
  // found" while the commits request is still in flight.
  const [isLoadingCommits, setIsLoadingCommits] = useState(false);
  const [hasLoadedCommits, setHasLoadedCommits] = useState(false);
  // A failed history read must remain distinguishable from a successful empty list.
  const [commitsError, setCommitsError] = useState<string | null>(null);
  const [commitDiffs, setCommitDiffs] = useState<GitDiffMap>({});
  // Expanded commits surface their own read failures without replacing the history list.
  const [commitDiffErrors, setCommitDiffErrors] = useState<Record<string, string>>({});
  const [remoteStatus, setRemoteStatus] = useState<GitRemoteStatus | null>(null);
  const [localBranches, setLocalBranches] = useState<string[]>([]);
  const [remoteBranches, setRemoteBranches] = useState<string[]>([]);
  const [isCreatingBranch, setIsCreatingBranch] = useState(false);
  // The branch list and header share one pending indicator until the native handback finishes.
  const [isBranchBusy, setIsBranchBusy] = useState(false);
  const branchOperationRef = useRef(false);
  const [isFetching, setIsFetching] = useState(false);
  const [isPulling, setIsPulling] = useState(false);
  const [isPushing, setIsPushing] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);
  const [isCreatingInitialCommit, setIsCreatingInitialCommit] = useState(false);
  const [isInitializingRepository, setIsInitializingRepository] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);

  const clearOperationError = useCallback(() => setOperationError(null), []);
  // Tracks the DB projectId so async requests can detect stale responses when
  // the user switches projects mid-flight.
  const selectedProjectIdRef = useRef<string | null>(selectedProject?.projectId ?? null);

  useEffect(() => {
    selectedProjectIdRef.current = selectedProject?.projectId ?? null;
  }, [selectedProject]);

  // Later refreshes take precedence over older requests for the same project.
  const statusRequestRef = useRef(0);
  const branchesRequestRef = useRef(0);
  const remoteRequestRef = useRef(0);
  const commitsRequestRef = useRef(0);
  const commitsControllerRef = useRef<AbortController | null>(null);
  // Per-hash ownership allows different expanded commits to load concurrently.
  const commitDiffControllersRef = useRef(new Map<string, AbortController>());
  // Each repository refresh owns a signal so recovery can supersede reads from before synchronization.
  const refreshControllerRef = useRef<AbortController | null>(null);
  const activeViewRef = useRef(activeView);
  useEffect(() => { activeViewRef.current = activeView; }, [activeView]);

  const invalidateHistoryRequests = useCallback(() => {
    ++commitsRequestRef.current;
    commitsControllerRef.current?.abort();
    commitsControllerRef.current = null;
    commitDiffControllersRef.current.forEach(controller => controller.abort());
    commitDiffControllersRef.current.clear();
  }, []);

  const reportOperationError = useCallback((error: unknown) => {
    if (selectedProjectIdRef.current === selectedProject?.projectId) {
      setOperationError(error === null ? null : readErrorText(error) ?? 'Git operation failed');
    }
  }, [selectedProject?.projectId]);

  const provider = useSelectedProvider();

  const fetchFileDiff = useCallback(
    async (filePath: string, signal?: AbortSignal) => {
      if (!selectedProject) {
        return;
      }

      // Git endpoints receive the DB projectId via the `project` query param.
      const projectId = selectedProject.projectId;

      try {
        const response = await api.git.diff(projectId, filePath, { signal });
        const data = await readJson<GitDiffResponse>(response, signal);

        if (
          signal?.aborted ||
          selectedProjectIdRef.current !== projectId
        ) {
          return;
        }

        if (!data.error && typeof data.diff === 'string') {
          setGitDiff((previous) => ({
            ...previous,
            [filePath]: data.diff as string,
          }));
        }
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) {
          return;
        }

        console.error('Error fetching file diff:', error);
      }
    },
    [selectedProject],
  );

  const fetchGitStatus = useCallback(async (signal?: AbortSignal) => {
    if (!selectedProject || selectedProjectIdRef.current !== selectedProject.projectId) return;

    // `project` query param carries the DB projectId everywhere now.
    const projectId = selectedProject.projectId;

    const request = ++statusRequestRef.current;
    setIsLoading(true);
    try {
      const response = await api.git.status(projectId, { signal });
      const data = await readJson<GitStatusResponse>(response, signal);

      if (signal?.aborted || selectedProjectIdRef.current !== projectId || request !== statusRequestRef.current) return;

      window.dispatchEvent(new CustomEvent(GIT_STATUS_OBSERVED_EVENT, { detail: { projectId, status: data } }));
      // Expanded files refetch against this observation; closed files never request a diff.
      setGitDiff({});
      if (data.error) {
        // A missing repository is an expected state, not an error.
        if (!data.notGitRepository) {
          console.error('Git status error:', data.error);
        }
        setGitStatus({
          error: data.error,
          details: data.details,
          notGitRepository: data.notGitRepository,
        });
        setCurrentBranch('');
        return;
      }

      setGitStatus(data);
      setCurrentBranch(data.branch || DEFAULT_BRANCH);

    } catch (error) {
      if (signal?.aborted || isAbortError(error)) {
        return;
      }

      if (selectedProjectIdRef.current !== projectId || request !== statusRequestRef.current) return;

      console.error('Error fetching git status:', error);
      setGitStatus({ error: 'Git operation failed', details: readErrorText(error) });
      setCurrentBranch('');
    } finally {
      if (!signal?.aborted && selectedProjectIdRef.current === projectId && request === statusRequestRef.current) setIsLoading(false);
    }
  }, [selectedProject]);

  const fetchBranches = useCallback(async (signal?: AbortSignal) => {
    if (!selectedProject || selectedProjectIdRef.current !== selectedProject.projectId) return;
    const projectId = selectedProject.projectId;
    const request = ++branchesRequestRef.current;
    try {
      const response = await api.git.branches(projectId, { signal });
      const data = await readJson<GitBranchesResponse>(response, signal);
      if (signal?.aborted || selectedProjectIdRef.current !== projectId || request !== branchesRequestRef.current) return;

      if (!data.error && data.branches) {
        setBranches(data.branches);
        setLocalBranches(data.localBranches ?? data.branches);
        setRemoteBranches(data.remoteBranches ?? []);
        return;
      }

      setBranches([]);
      setLocalBranches([]);
      setRemoteBranches([]);
    } catch (error) {
      if (signal?.aborted || isAbortError(error) || selectedProjectIdRef.current !== projectId || request !== branchesRequestRef.current) return;
      console.error('Error fetching branches:', error);
      setBranches([]);
      setLocalBranches([]);
      setRemoteBranches([]);
    }
  }, [selectedProject]);

  const fetchRemoteStatus = useCallback(async (signal?: AbortSignal) => {
    if (!selectedProject || selectedProjectIdRef.current !== selectedProject.projectId) return;
    const projectId = selectedProject.projectId;
    const request = ++remoteRequestRef.current;
    try {
      const response = await api.git.remoteStatus(projectId, { signal });
      const data = await readJson<GitRemoteStatus | GitApiErrorResponse>(response, signal);
      if (signal?.aborted || selectedProjectIdRef.current !== projectId || request !== remoteRequestRef.current) return;

      if (!data.error) {
        setRemoteStatus(data as GitRemoteStatus);
        return;
      }

      setRemoteStatus(null);
    } catch (error) {
      if (signal?.aborted || isAbortError(error) || selectedProjectIdRef.current !== projectId || request !== remoteRequestRef.current) return;
      console.error('Error fetching remote status:', error);
      setRemoteStatus(null);
    }
  }, [selectedProject]);

  const fetchRecentCommits = useCallback(async () => {
    if (!selectedProject || selectedProjectIdRef.current !== selectedProject.projectId) return;
    const projectId = selectedProject.projectId;
    const request = ++commitsRequestRef.current;
    commitsControllerRef.current?.abort();
    const controller = new AbortController();
    commitsControllerRef.current = controller;
    const isCurrent = () => !controller.signal.aborted && request === commitsRequestRef.current
      && selectedProjectIdRef.current === projectId;

    setIsLoadingCommits(true);
    setCommitsError(null);
    try {
      const data = await readWithAbort(async () => {
        const response = await api.git.commits(projectId, { limit: RECENT_COMMITS_LIMIT }, { signal: controller.signal });
        return readJson<GitCommitsResponse>(response, controller.signal);
      }, controller.signal);
      if (!isCurrent()) return;
      if (data.error || !Array.isArray(data.commits)) {
        throw new Error(data.error ?? 'Git returned an invalid commit history. Please try again.');
      }
      setRecentCommits(data.commits);
      setHasLoadedCommits(true);
    } catch (error) {
      if (!isCurrent() || isAbortError(error)) return;
      setCommitsError(readErrorText(error) ?? 'Failed to load commit history. Please try again.');
    } finally {
      // Superseded reads must not clear the newer request's loading state.
      if (isCurrent()) {
        commitsControllerRef.current = null;
        setIsLoadingCommits(false);
      }
    }
  }, [selectedProject]);

  const fetchCommitDiff = useCallback(async (commitHash: string, signal?: AbortSignal) => {
    if (!selectedProject || signal?.aborted || selectedProjectIdRef.current !== selectedProject.projectId) return;
    const projectId = selectedProject.projectId;
    const requests = commitDiffControllersRef.current;
    requests.get(commitHash)?.abort();
    const controller = new AbortController();
    requests.set(commitHash, controller);
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    const isCurrent = () => !controller.signal.aborted && requests.get(commitHash) === controller
      && selectedProjectIdRef.current === projectId;
    setCommitDiffErrors(previous => {
      const next = { ...previous };
      delete next[commitHash];
      return next;
    });

    try {
      const data = await readWithAbort(async () => {
        const response = await api.git.commitDiff(projectId, commitHash, { signal: controller.signal });
        return readJson<GitDiffResponse>(response, controller.signal);
      }, controller.signal);
      if (!isCurrent()) return;
      if (data.error || typeof data.diff !== 'string') {
        throw new Error(data.error ?? 'Git returned an invalid commit diff. Please try again.');
      }
      setCommitDiffs(previous => ({ ...previous, [commitHash]: data.diff as string }));
    } catch (error) {
      if (!isCurrent() || isAbortError(error)) return;
      setCommitDiffErrors(previous => ({
        ...previous,
        [commitHash]: readErrorText(error) ?? 'Failed to load commit diff. Please try again.',
      }));
    } finally {
      signal?.removeEventListener('abort', cancel);
      if (requests.get(commitHash) === controller) requests.delete(commitHash);
    }
  }, [selectedProject]);

  const refreshAll = useCallback(async () => {
    if (!selectedProject || selectedProjectIdRef.current !== selectedProject.projectId) return;
    refreshControllerRef.current?.abort();
    const controller = new AbortController();
    refreshControllerRef.current = controller;
    invalidateHistoryRequests();
    setIsLoadingCommits(false);
    setHasLoadedCommits(false);
    setCommitsError(null);
    setCommitDiffs({});
    setCommitDiffErrors({});
    // The changes view stays cheap; returning to History obtains a fresh list.
    const historyRead = activeViewRef.current === 'history' ? fetchRecentCommits() : undefined;
    await Promise.all([
      fetchGitStatus(controller.signal),
      fetchBranches(controller.signal),
      fetchRemoteStatus(controller.signal),
      historyRead,
    ]);
  }, [fetchBranches, fetchGitStatus, fetchRecentCommits, fetchRemoteStatus, invalidateHistoryRequests, selectedProject]);

  const runBranchOperation = useCallback(async (
    operation: (projectId: string) => Promise<Response>,
    fallbackError: string,
    creating = false,
  ): Promise<boolean> => {
    if (!selectedProject || branchOperationRef.current) return false;
    const projectId = selectedProject.projectId;
    branchOperationRef.current = true;
    setIsBranchBusy(true);
    setIsCreatingBranch(creating);
    setOperationError(null);
    try {
      // The response includes native synchronization and the workspace handback.
      const response = await operation(projectId);
      const data = await readJson<GitOperationResponse>(response);
      if (selectedProjectIdRef.current !== projectId) return false;
      if (!response.ok || !data.success) {
        setOperationError(data.error || fallbackError);
        return false;
      }
      await refreshAll();
      return selectedProjectIdRef.current === projectId;
    } catch (error) {
      if (selectedProjectIdRef.current === projectId) {
        setOperationError(error instanceof Error ? error.message : fallbackError);
      }
      return false;
    } finally {
      branchOperationRef.current = false;
      setIsBranchBusy(false);
      setIsCreatingBranch(false);
    }
  }, [refreshAll, selectedProject]);

  const switchBranch = useCallback((branchName: string) => runBranchOperation(
    projectId => api.git.checkout(projectId, branchName), 'Switch branch failed',
  ), [runBranchOperation]);

  const createBranch = useCallback((branchName: string) => {
    const trimmed = branchName.trim();
    if (!trimmed) return Promise.resolve(false);
    return runBranchOperation(projectId => api.git.createBranch(projectId, trimmed), 'Create branch failed', true);
  }, [runBranchOperation]);

  const deleteBranch = useCallback((branchName: string, force = false) => runBranchOperation(
    projectId => api.git.deleteBranch(projectId, branchName, force), 'Delete branch failed',
  ), [runBranchOperation]);

  const handleFetch = useCallback(async () => {
    if (!selectedProject) {
      return;
    }

    setIsFetching(true);
    try {
      const response = await api.git.fetch(selectedProject.projectId);

      const data = await readJson<GitOperationResponse>(response);
      if (data.success) {
        void refreshAll();
        return;
      }

      reportOperationError(data.error ?? 'Fetch failed');
    } catch (error) {
      reportOperationError(error instanceof Error ? error.message : 'Fetch failed');
    } finally {
      setIsFetching(false);
    }
  }, [refreshAll, reportOperationError, selectedProject]);

  const handlePull = useCallback(async () => {
    if (!selectedProject) {
      return;
    }

    setIsPulling(true);
    try {
      const response = await api.git.pull(selectedProject.projectId);

      const data = await readJson<GitOperationResponse>(response);
      if (data.success) {
        void refreshAll();
        return;
      }

      reportOperationError(data.error ?? 'Pull failed');
    } catch (error) {
      reportOperationError(error instanceof Error ? error.message : 'Pull failed');
    } finally {
      setIsPulling(false);
    }
  }, [refreshAll, reportOperationError, selectedProject]);

  const handlePush = useCallback(async () => {
    if (!selectedProject) {
      return;
    }

    setIsPushing(true);
    try {
      const response = await api.git.push(selectedProject.projectId);

      const data = await readJson<GitOperationResponse>(response);
      if (data.success) {
        void refreshAll();
        return;
      }

      reportOperationError(data.error ?? 'Push failed');
    } catch (error) {
      reportOperationError(error instanceof Error ? error.message : 'Push failed');
    } finally {
      setIsPushing(false);
    }
  }, [refreshAll, reportOperationError, selectedProject]);

  const handlePublish = useCallback(async () => {
    if (!selectedProject) {
      return;
    }

    setIsPublishing(true);
    try {
      const response = await api.git.publish(selectedProject.projectId, currentBranch);

      const data = await readJson<GitOperationResponse>(response);
      if (data.success) {
        void refreshAll();
        return;
      }

      reportOperationError(data.error || 'Publish failed');
    } catch (error) {
      reportOperationError(error instanceof Error ? error.message : 'Publish failed');
    } finally {
      setIsPublishing(false);
    }
  }, [currentBranch, refreshAll, reportOperationError, selectedProject]);

  const discardChanges = useCallback(
    async (filePath: string) => {
      if (!selectedProject) {
        return;
      }

      try {
        const response = await api.git.discard(selectedProject.projectId, filePath);

        const data = await readJson<GitOperationResponse>(response);
        if (data.success) {
          void fetchGitStatus();
          return;
        }

        reportOperationError(data.error || 'Discard failed');
      } catch (error) {
        reportOperationError(error instanceof Error ? error.message : 'Discard failed');
      }
    },
    [fetchGitStatus, reportOperationError, selectedProject],
  );

  const deleteUntrackedFile = useCallback(
    async (filePath: string) => {
      if (!selectedProject) {
        return;
      }

      try {
        const response = await api.git.deleteUntracked(selectedProject.projectId, filePath);

        const data = await readJson<GitOperationResponse>(response);
        if (data.success) {
          void fetchGitStatus();
          return;
        }

        reportOperationError(data.error || 'Delete failed');
      } catch (error) {
        reportOperationError(error instanceof Error ? error.message : 'Delete failed');
      }
    },
    [fetchGitStatus, reportOperationError, selectedProject],
  );

  const stageFiles = useCallback(
    async (files: string[]) => {
      if (!selectedProject || files.length === 0) {
        return false;
      }

      try {
        const response = await api.git.stage(selectedProject.projectId, files);

        const data = await readJson<GitOperationResponse>(response);
        if (!data.success) {
          reportOperationError(data.error ?? 'Stage failed');
          return false;
        }

        // Refresh so the Staged section re-syncs from the real index.
        await fetchGitStatus();
        return true;
      } catch (error) {
        reportOperationError(error instanceof Error ? error.message : 'Stage failed');
        return false;
      }
    },
    [fetchGitStatus, reportOperationError, selectedProject],
  );

  const unstageFiles = useCallback(
    async (files: string[]) => {
      if (!selectedProject || files.length === 0) {
        return false;
      }

      try {
        const response = await api.git.unstage(selectedProject.projectId, files);

        const data = await readJson<GitOperationResponse>(response);
        if (!data.success) {
          reportOperationError(data.error ?? 'Unstage failed');
          return false;
        }

        await fetchGitStatus();
        return true;
      } catch (error) {
        reportOperationError(error instanceof Error ? error.message : 'Unstage failed');
        return false;
      }
    },
    [fetchGitStatus, reportOperationError, selectedProject],
  );

  const generateCommitMessage = useCallback(
    async (files: string[]) => {
      if (!selectedProject || files.length === 0) {
        return null;
      }

      try {
        const response = await api.git.generateCommitMessage(
          selectedProject.projectId,
          files,
          provider,
        );

        const data = await readJson<GitGenerateMessageResponse>(response);
        if (data.message) {
          return data.message;
        }

        console.error('Failed to generate commit message:', data.error);
        return null;
      } catch (error) {
        console.error('Error generating commit message:', error);
        return null;
      }
    },
    [provider, selectedProject],
  );

  const commitChanges = useCallback(
    async (message: string, files: string[]) => {
      if (!selectedProject || !message.trim() || files.length === 0) {
        return false;
      }

      try {
        const response = await api.git.commit(selectedProject.projectId, message, files);

        const data = await readJson<GitOperationResponse>(response);
        if (data.success) {
          void refreshAll();
          return true;
        }

        reportOperationError(data.error || 'Commit failed');
        return false;
      } catch (error) {
        reportOperationError(error instanceof Error ? error.message : 'Commit failed');
        return false;
      }
    },
    [refreshAll, reportOperationError, selectedProject],
  );

  const createInitialCommit = useCallback(async () => {
    if (!selectedProject) return false;

    setIsCreatingInitialCommit(true);
    try {
      const response = await api.git.initialCommit(selectedProject.projectId);

      const data = await readJson<GitOperationResponse>(response);
      if (data.success) {
        void refreshAll();
        return true;
      }

      reportOperationError(data.error || 'Failed to create initial commit');
      return false;
    } catch (error) {
      reportOperationError(error instanceof Error ? error.message : 'Failed to create initial commit');
      return false;
    } finally {
      setIsCreatingInitialCommit(false);
    }
  }, [refreshAll, reportOperationError, selectedProject]);

  const initRepository = useCallback(async () => {
    if (!selectedProject) {
      return false;
    }
    const projectId = selectedProject.projectId;

    setIsInitializingRepository(true);
    try {
      const response = await api.git.init(projectId);

      const data = await readJson<GitOperationResponse>(response);
      if (selectedProjectIdRef.current !== projectId) {
        return false;
      }
      if (!data.success) {
        setOperationError(data.error ?? 'Failed to initialize repository');
        return false;
      }

      void refreshAll();
      return true;
    } catch (error) {
      if (selectedProjectIdRef.current === projectId) {
        setOperationError(error instanceof Error ? error.message : 'Failed to initialize repository');
      }
      return false;
    } finally {
      setIsInitializingRepository(false);
    }
  }, [refreshAll, selectedProject]);

  const openFile = useCallback(
    async (filePath: string) => {
      if (!onFileOpen) {
        return;
      }

      if (!selectedProject) {
        onFileOpen(filePath);
        return;
      }

      try {
        const response = await api.git.fileWithDiff(selectedProject.projectId, filePath);
        const data = await readJson<GitFileWithDiffResponse>(response);
        if (selectedProjectIdRef.current !== selectedProject.projectId) return;

        if (data.error) {
          console.error('Error fetching file with diff:', data.error);
          onFileOpen(filePath);
          return;
        }

        onFileOpen(filePath, {
          old_string: data.oldContent || '',
          new_string: data.currentContent || '',
        });
      } catch (error) {
        if (selectedProjectIdRef.current !== selectedProject.projectId) return;
        console.error('Error opening file:', error);
        onFileOpen(filePath);
      }
    },
    [onFileOpen, selectedProject],
  );

  useEffect(() => {
    // Reset repository-scoped state when project changes to avoid stale UI.
    setCurrentBranch('');
    setBranches([]);
    setLocalBranches([]);
    setRemoteBranches([]);
    setGitStatus(null);
    setRemoteStatus(null);
    setGitDiff({});
    setRecentCommits([]);
    setCommitDiffs({});
    setIsLoading(false);
    setIsLoadingCommits(false);
    setHasLoadedCommits(false);
    setCommitsError(null);
    setCommitDiffErrors({});
    setOperationError(null);

    if (selectedProject) refreshAll();

    return () => {
      refreshControllerRef.current?.abort();
      refreshControllerRef.current = null;
      invalidateHistoryRequests();
    };
  }, [invalidateHistoryRequests, refreshAll, selectedProject]);

  useEffect(() => {
    if (!selectedProject) return;
    const serverPath = selectedProject.fullPath ?? selectedProject.path;
    const refreshWhenVisible = () => {
      if (document.visibilityState !== 'hidden') refreshAll();
    };
    const unsubscribe = isDesktop() ? onWorkspaceSyncStateChanged(info => {
      // A ready event confirms that native synchronization and workspace handback finished.
      if (info.serverPath === serverPath && info.status === 'ready') refreshWhenVisible();
    }) : undefined;
    window.addEventListener('focus', refreshWhenVisible);
    return () => {
      unsubscribe?.();
      window.removeEventListener('focus', refreshWhenVisible);
    };
  }, [refreshAll, selectedProject]);

  useEffect(() => {
    // Project initialization already starts this read when History is visible.
    if (selectedProject && activeView === 'history' && !commitsControllerRef.current) {
      void fetchRecentCommits();
    }
    return invalidateHistoryRequests;
  }, [activeView, fetchRecentCommits, invalidateHistoryRequests, selectedProject]);

  return {
    gitStatus,
    gitDiff,
    isLoading,
    // History is "loading" until the first commits response for this project
    // lands, so an empty list never renders before the data exists.
    isLoadingCommits: isLoadingCommits || (!hasLoadedCommits && !commitsError),
    commitsError,
    retryCommits: fetchRecentCommits,
    currentBranch,
    branches,
    localBranches,
    remoteBranches,
    recentCommits,
    commitDiffs,
    commitDiffErrors,
    remoteStatus,
    isCreatingBranch,
    isBranchBusy,
    isFetching,
    isPulling,
    isPushing,
    isPublishing,
    isCreatingInitialCommit,
    isInitializingRepository,
    operationError,
    clearOperationError,
    reportOperationError,
    refreshAll,
    switchBranch,
    createBranch,
    deleteBranch,
    handleFetch,
    handlePull,
    handlePush,
    handlePublish,
    discardChanges,
    deleteUntrackedFile,
    stageFiles,
    unstageFiles,
    fetchCommitDiff,
    fetchFileDiff,
    generateCommitMessage,
    commitChanges,
    createInitialCommit,
    initRepository,
    openFile,
  };
}
