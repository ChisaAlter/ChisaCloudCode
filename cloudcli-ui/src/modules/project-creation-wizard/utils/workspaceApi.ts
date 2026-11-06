import { api, readApiErrorMessage } from '@/shared/api';
import type { FolderSuggestion, GithubTokenCredential, TokenMode } from '@/shared/types';

type CredentialsResponse = {
  credentials?: GithubTokenCredential[];
  error?: string;
};

type BrowseFilesystemResponse = {
  path?: string;
  suggestions?: FolderSuggestion[];
  error?: string;
};

type CreateFolderResponse = {
  success?: boolean;
  path?: string;
  error?: string;
  details?: string;
};

type CreateProjectPayload = { path: string; customName?: string } | { sourceMode: 'ssh'; connectionId: string; rootPath: string; customName?: string };

type CreateProjectApiError = {
  code?: string;
  message?: string;
  details?: unknown;
};

type CreateProjectResponse = {
  success?: boolean;
  project?: Record<string, unknown>;
  error?: string | CreateProjectApiError;
  details?: string;
  message?: string;
};

type CloneJobSnapshot = {
  jobId: string;
  status: 'running' | 'complete' | 'error' | 'cancelled';
  message: string;
  project?: Record<string, unknown>;
  code?: string;
  targetPath?: string;
};

type CloneAttempt = {
  requestId: string;
  jobId?: string;
  snapshot?: CloneJobSnapshot;
  cancellation?: Promise<void>;
};

/** The wizard retains this per logical attempt, including when a POST response is lost. */
export const createCloneAttempt = (): CloneAttempt => ({ requestId: crypto.randomUUID() });

/** Observation failures do not imply the server operation failed and must retain the attempt. */
export class CloneJobObservationError extends Error {}

/** Only a definitive server rejection or terminal task error permits a new logical attempt. */
export class CloneJobOperationError extends Error {}

type CloneWorkspaceParams = {
  workspacePath: string;
  githubUrl: string;
  tokenMode: TokenMode;
  selectedGithubToken: string;
  newGithubToken: string;
  attempt: CloneAttempt;
  signal?: AbortSignal;
};

type CloneProgressHandlers = {
  onProgress: (message: string) => void;
};

const parseJson = async <T>(response: Response): Promise<T> => {
  const data = (await response.json()) as T;
  return data;
};

const resolveCreateProjectErrorMessage = (responseData: CreateProjectResponse): string | null => {
  if (typeof responseData.details === 'string' && responseData.details.trim().length > 0) {
    return responseData.details;
  }

  if (typeof responseData.error === 'string' && responseData.error.trim().length > 0) {
    return responseData.error;
  }

  if (responseData.error && typeof responseData.error === 'object') {
    const errorObject = responseData.error as { message?: unknown; details?: unknown };

    if (typeof errorObject.details === 'string' && errorObject.details.trim().length > 0) {
      return errorObject.details;
    }

    if (typeof errorObject.message === 'string' && errorObject.message.trim().length > 0) {
      return errorObject.message;
    }

    if (
      errorObject.details
      && typeof errorObject.details === 'object'
      && typeof (errorObject.details as { projectPath?: unknown }).projectPath === 'string'
    ) {
      return `Project path already exists: ${(errorObject.details as { projectPath: string }).projectPath}`;
    }
  }

  if (typeof responseData.message === 'string' && responseData.message.trim().length > 0) {
    return responseData.message;
  }

  return null;
};

export const fetchGithubTokenCredentials = async () => {
  const response = await api.settings.credentials('github_token');
  const data = await parseJson<CredentialsResponse>(response);

  if (!response.ok) {
    throw new Error(data.error || 'Failed to load GitHub tokens');
  }

  return (data.credentials || []).filter((credential) => credential.is_active);
};

export const browseFilesystemFolders = async (pathToBrowse: string) => {
  const response = await api.browseFilesystem(pathToBrowse);
  const data = await parseJson<BrowseFilesystemResponse>(response);

  if (!response.ok) {
    throw new Error(data.error || 'Failed to browse filesystem');
  }

  return {
    path: data.path || pathToBrowse,
    suggestions: (data.suggestions || []) as FolderSuggestion[],
  };
};

export const createFolderInFilesystem = async (folderPath: string) => {
  const response = await api.createFolder(folderPath);
  const data = await parseJson<CreateFolderResponse>(response);

  if (!response.ok) {
    throw new Error(data.error || 'Failed to create folder');
  }

  return data.path || folderPath;
};

export const createProjectRequest = async (payload: CreateProjectPayload) => {
  const response = await api.createProject(payload);
  const data = await parseJson<CreateProjectResponse>(response);

  if (!response.ok) {
    const message = resolveCreateProjectErrorMessage(data);
    const code = typeof data.error === 'object' ? data.error?.code : undefined;
    if ('sourceMode' in payload && response.status === 409 && (code === 'SSH_PROJECT_ALREADY_EXISTS' || /physical directory identity is already registered|project path already exists/i.test(message || ''))) {
      throw new Error('此目录已在当前账号中登记。请在项目列表打开已有项目；若项目已归档，请先恢复。刷新后重新验证目录也可获取已有项目信息。');
    }
    throw new Error(message || 'Failed to create project');
  }

  if (data.success === false || !data.project || typeof data.project.projectId !== 'string' || !data.project.projectId) {
    throw new Error(resolveCreateProjectErrorMessage(data) || '服务器未返回有效项目，创建结果尚未确认。');
  }
  return data.project;
};

const cloneObservationError = (error: unknown): CloneJobObservationError => new CloneJobObservationError(
  `Import status is unknown. Retry to check the same import task. ${error instanceof Error ? error.message : ''}`.trim(),
);

const readCloneSnapshot = async (response: Response, starting: boolean): Promise<CloneJobSnapshot> => {
  const data = await response.json();
  if (!response.ok) {
    const message = readApiErrorMessage(data) ?? `Request failed (${response.status})`;
    // A failed GET (including a proxy 404) never proves that the clone itself failed.
    if (starting && response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
      throw new CloneJobOperationError(message);
    }
    throw new Error(message);
  }
  if (typeof data.jobId !== 'string' || !['running', 'complete', 'error', 'cancelled'].includes(data.status)) {
    throw new Error('Invalid import task response');
  }
  return data as CloneJobSnapshot;
};

const waitForClonePoll = (signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  signal?.throwIfAborted();
  const abort = () => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    reject(signal?.reason ?? new DOMException('Import observation stopped', 'AbortError'));
  };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, 500);
  signal?.addEventListener('abort', abort, { once: true });
});

/** The wizard calls this only while the original auth/server identity still owns the task. */
export const cancelCloneWorkspace = async (attempt: CloneAttempt): Promise<void> => {
  if (attempt.cancellation) return attempt.cancellation;
  if (attempt.snapshot && attempt.snapshot.status !== 'running') return;
  const jobId = attempt.jobId;
  // Explicit cancel and unmount cleanup may overlap; only one DELETE is needed.
  attempt.cancellation = (async () => {
    try {
      const snapshot = await readCloneSnapshot(await (jobId ? api.cancelCloneJob(jobId) : api.cancelCloneRequest(attempt.requestId)), false);
      if (jobId && snapshot.jobId !== jobId) throw new Error('Import task identity changed unexpectedly');
      attempt.jobId = snapshot.jobId;
      attempt.snapshot = snapshot;
      if (snapshot.status === 'running') throw new Error('The server has not confirmed cancellation');
    } catch (error) {
      throw new CloneJobObservationError(`Cancellation status is unknown. Retry to check the same import task. ${error instanceof Error ? error.message : ''}`);
    }
  })();
  try { await attempt.cancellation; }
  finally { attempt.cancellation = undefined; }
};

/** Polls the authenticated task transport; a retry observes the retained job rather than cloning again. */
export const cloneWorkspaceWithProgress = async (
  params: CloneWorkspaceParams,
  handlers: CloneProgressHandlers,
): Promise<Record<string, unknown> | undefined> => {
  const { attempt, signal } = params;
  signal?.throwIfAborted();
  let snapshot = attempt.snapshot;
  // Recheck a retained running job immediately, but reuse a known completed result locally.
  if (!snapshot || snapshot.status === 'running') {
    try {
      const observing = !!attempt.jobId;
      const response = attempt.jobId
        ? await api.getCloneJob(attempt.jobId, { signal })
        : await api.startCloneJob({
          path: params.workspacePath.trim(),
          githubUrl: params.githubUrl.trim(),
          ...(params.tokenMode === 'stored' && params.selectedGithubToken ? { githubTokenId: Number(params.selectedGithubToken) } : {}),
          ...(params.tokenMode === 'new' && params.newGithubToken.trim() ? { newGithubToken: params.newGithubToken.trim() } : {}),
          requestId: attempt.requestId,
        }, { signal });
      snapshot = await readCloneSnapshot(response, !observing);
      if (observing) signal?.throwIfAborted();
      if (attempt.jobId && snapshot.jobId !== attempt.jobId) throw new Error('Import task identity changed unexpectedly');
      // Retain accepted task identity even if cancellation raced with the POST response.
      attempt.jobId = snapshot.jobId;
      attempt.snapshot = snapshot;
      signal?.throwIfAborted();
    } catch (error) {
      if (signal?.aborted || error instanceof CloneJobOperationError) throw error;
      throw cloneObservationError(error);
    }
  }
  for (;;) {
    signal?.throwIfAborted();
    handlers.onProgress(snapshot.message);
    if (snapshot.status === 'complete') {
      if (!snapshot.project || typeof snapshot.project.projectId !== 'string' || !snapshot.project.projectId) throw new CloneJobObservationError('导入任务已结束，但服务器未返回有效项目。请检查同一任务的状态。');
      return snapshot.project;
    }
    if (snapshot.status === 'error' || snapshot.status === 'cancelled') {
      throw new CloneJobOperationError(snapshot.message || (snapshot.status === 'cancelled' ? 'Import cancelled' : 'Failed to clone repository'));
    }
    await waitForClonePoll(signal);
    try {
      const observed = await readCloneSnapshot(await api.getCloneJob(attempt.jobId!, { signal }), false);
      signal?.throwIfAborted();
      if (observed.jobId !== attempt.jobId) throw new Error('Import task identity changed unexpectedly');
      snapshot = observed;
      attempt.snapshot = snapshot;
    } catch (error) {
      if (signal?.aborted) throw error;
      throw cloneObservationError(error);
    }
  }
};
