import {
  expireAuthSession,
  getAuthSessionVersion,
  getStoredAuthToken,
  storeAuthToken,
} from '@/shared/authToken';
import { IS_PLATFORM } from '@/shared/utils';
import { readVoiceConfig, voiceConfigHeaders } from '@/shared/voiceConfig';
import type { BridgeResponse, WorkspaceDescriptor, WorkspaceSelector } from '@/shared/types';
import { desktopHttpUrl, desktopWebSocketUrl, FrontendBridge, getServerConnectionVersion } from '@/shared/chisa';

/** Auth distinguishes an actionable native service-connection failure from rejected credentials. */
export class ServiceConnectionError extends Error {}

// Headers are a plain record rather than the full `HeadersInit` union so the
// defaults below can be merged with a caller's headers by spreading.
export type ApiRequestOptions = Omit<RequestInit, 'headers'> & {
  headers?: Record<string, string>;
};

// Utility function for authenticated API calls
// Desktop APIs use the native verified HTTPS client to reach cloud services.
const isChisaDesktop = (): boolean => {
  try {
    return typeof globalThis !== 'undefined' && (globalThis as any).mygo !== undefined;
  } catch {
    return false;
  }
};

// UTF-8 字符串 → base64（btoa 只收 latin1，需先转字节）
const utf8ToB64 = (str: string): string => {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
};

const bytesToB64 = (bytes: Uint8Array): string => {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
};

// 把任意 BodyInit 转成桥需要的 base64；FormData 手工序列化为 multipart
// 把任意 BodyInit 转成桥需要的 base64；FormData 手工序列化为 multipart
const toBridgeBody = async (
  body: BodyInit | null | undefined,
): Promise<{ b64: string; contentType?: string }> => {
  if (body == null) return { b64: "" };
  if (typeof body === 'string') return { b64: utf8ToB64(body) };
  if (body instanceof URLSearchParams) return { b64: utf8ToB64(body.toString()), contentType: 'application/x-www-form-urlencoded;charset=UTF-8' };
  const enc = new TextEncoder();
  if (body instanceof FormData) {
    const boundary = '----ChisaBridge' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    const parts: Uint8Array[] = [];
    for (const [name, value] of body.entries()) {
      if (typeof value === 'string') {
        parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
      } else {
        parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${value.name}"\r\nContent-Type: ${value.type || 'application/octet-stream'}\r\n\r\n`));
        parts.push(new Uint8Array(await value.arrayBuffer()));
        parts.push(enc.encode('\r\n'));
      }
    }
    parts.push(enc.encode(`--${boundary}--\r\n`));
    const total = parts.reduce((n, u) => n + u.length, 0);
    const all = new Uint8Array(total);
    let off = 0;
    for (const u of parts) {
      all.set(u, off);
      off += u.length;
    }
    return { b64: bytesToB64(all), contentType: `multipart/form-data; boundary=${boundary}` };
  }
  if (body instanceof Blob) return { b64: bytesToB64(new Uint8Array(await body.arrayBuffer())), contentType: body.type || undefined };
  if (body instanceof ArrayBuffer) return { b64: bytesToB64(new Uint8Array(body)) };
  return { b64: utf8ToB64(String(body)) };
};

// 桥返回的 BridgeResponse → 标准 Response（headers.get / response.ok 可用）
const bridgeToResponse = (br: { status: number; headers: Record<string, string>; bodyB64: string }): Response => {
  const bytes = br.bodyB64 ? Uint8Array.from(atob(br.bodyB64), (c) => c.charCodeAt(0)) : new Uint8Array();
  const h = new Headers();
  for (const [k, v] of Object.entries(br.headers || {})) {
    try { h.set(k, v); } catch { /* skip invalid header */ }
  }
  const status = br.status || 502;
  return new Response([204, 205, 304].includes(status) ? null : bytes, { status, headers: h });
};

// Native lookups/reservations cannot consume AbortSignal; deadlines still release their JS caller.
function awaitNative<T>(operation: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return operation;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason ?? new DOMException('Request canceled', 'AbortError')); };
    signal.addEventListener('abort', abort, { once: true });
    operation.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

const chisaServerRequest = async (
  url: string,
  options: ApiRequestOptions,
): Promise<Response> => {
  options.signal?.throwIfAborted();
  const token = getStoredAuthToken();
  const authSessionVersion = getAuthSessionVersion();
  const connectionVersion = getServerConnectionVersion();
  const headers: Record<string, string> = { ...(options.headers || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const assertCurrent = () => {
    options.signal?.throwIfAborted();
    if (connectionVersion !== getServerConnectionVersion()) {
      throw new DOMException('Server connection changed', 'AbortError');
    }
    if (authSessionVersion !== getAuthSessionVersion()) {
      throw new DOMException('Account session changed', 'AbortError');
    }
  };
  const connection = await awaitNative(FrontendBridge.getApiConnection(), options.signal);
  assertCurrent();
  if (!connection.configured) throw new ServiceConnectionError('尚未设置账号服务，请打开账户设置填写 HTTPS 服务地址');
  const { b64, contentType } = await awaitNative(toBridgeBody(options.body), options.signal);
  assertCurrent();
  if (contentType && !headers['Content-Type']) headers['Content-Type'] = contentType;
  const reservation = FrontendBridge.beginServerRequest().then(id => {
    if (id && (options.signal?.aborted || connectionVersion !== getServerConnectionVersion() || authSessionVersion !== getAuthSessionVersion())) void FrontendBridge.cancelServerRequest(id).catch(() => {});
    return id;
  });
  const requestId = await awaitNative(reservation, options.signal);
  if (!requestId) throw new ServiceConnectionError('账号服务连接已断开，请重新连接服务');
  const cancel = () => { void FrontendBridge.cancelServerRequest(requestId).catch(() => {}); };
  try {
    assertCurrent();
    const br = await new Promise<BridgeResponse>((resolve, reject) => {
      const abort = () => {
        cancel();
        reject(options.signal?.reason ?? new DOMException('Request canceled', 'AbortError'));
      };
      options.signal?.addEventListener('abort', abort, { once: true });
      void FrontendBridge.serverRequest(requestId, (options.method || 'GET').toUpperCase(), url, headers, b64)
        .then(resolve, reject)
        .finally(() => options.signal?.removeEventListener('abort', abort));
    });
    assertCurrent();
    FrontendBridge.recordConnectionVersion(br.headers['X-Chisa-Connection-Version'] ?? null);
    return bridgeToResponse(br);
  } catch (error) {
    cancel();
    throw error;
  }
};

// 桌面模式下所有请求（含免认证接口）都必须走桥；否则落在 mygo:// 静态源上必失败
const desktopAwareFetch = (path: string, init: RequestInit = {}): Promise<Response> => {
  if (isChisaDesktop()) {
    return chisaServerRequest(path, {
      method: init.method,
      headers: init.headers as Record<string, string>,
      body: init.body as string,
      signal: init.signal,
    });
  }
  return fetch(path, init);
};

export const authenticatedFetch = (
  url: string,
  options: ApiRequestOptions = {},
): Promise<Response> => {
  const token = getStoredAuthToken();
  const authSessionVersion = getAuthSessionVersion();
  const acceptResponse = (response: Response): Response => {
    options.signal?.throwIfAborted();
    if (authSessionVersion !== getAuthSessionVersion()) {
      throw new DOMException('Account session changed', 'AbortError');
    }
    const refreshedToken = response.headers.get('X-Refreshed-Token');
    if (refreshedToken) storeAuthToken(refreshedToken);
    if (response.headers.get('X-Auth-Error')) expireAuthSession();
    return response;
  };

  const defaultHeaders: Record<string, string> = {};

  // Only set Content-Type for non-FormData requests
  if (!(options.body instanceof FormData)) {
    defaultHeaders['Content-Type'] = 'application/json';
  }

  if (!IS_PLATFORM && token) {
    defaultHeaders['Authorization'] = `Bearer ${token}`;
  }

  if (isChisaDesktop()) {
    return chisaServerRequest(url, { ...options, headers: { ...defaultHeaders, ...options.headers } }).then(acceptResponse);
  }
  return fetch(url, {
    ...options,
    headers: {
      ...defaultHeaders,
      ...options.headers,
    },
  }).then(acceptResponse);
};

// ─── Request helpers ────────────────────────────────────────────────────────
// Every endpoint below goes through these so verb, JSON encoding and query
// serialization stay consistent across the whole frontend.

type QueryValue = string | number | boolean | null | undefined;

// Serializes a query object into `?a=1&b=2` (or an empty string). Empty and
// `false` values are dropped so optional flags can be passed unconditionally.
const query = (params: Record<string, QueryValue>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '' || value === false) {
      continue;
    }
    search.set(key, String(value));
  }
  const serialized = search.toString();
  return serialized ? `?${serialized}` : '';
};

/**
 * Reads a `{ success, error, details }` envelope response, throwing the server's
 * message when the request failed.
 *
 * Endpoints return a bare Response, so call sites unwrap it themselves. Most do
 * so in ways that differ deliberately (bare casts where the caller inspects the
 * payload, abort-aware reads in the git panel); this is the shared form for
 * callers that want a failed request to throw.
 */
export class ApiRequestError extends Error {
  readonly code?: string;
  readonly details?: unknown;
  readonly status: number;

  constructor(message: string, options: { code?: string; details?: unknown; status: number }) {
    super(message);
    this.name = 'ApiRequestError';
    this.code = options.code;
    this.details = options.details;
    this.status = options.status;
  }
}

/**
 * Reads a `{ success, error, details }` envelope response, throwing an
 * ApiRequestError carrying the server's machine-readable error code when one
 * is present. Accepts both legacy string envelopes (`error: 'message'`) and
 * the structured AppError envelope (`error: { code, message, details }`).
 */
export async function readApiJson<T>(response: Response): Promise<T> {
  const data = await response.json();
  if (!response.ok || data.success === false) {
    const raw = data.error ?? data.details;
    const payload = raw && typeof raw === 'object' ? raw : {};
    const message = (typeof raw === 'string' ? raw : payload?.message) || data.details || `Request failed (${response.status})`;
    throw new ApiRequestError(message, {
      code: typeof payload?.code === 'string' ? payload.code : undefined,
      details: payload?.details ?? data.details,
      status: response.status,
    });
  }
  return data as T;
}

const PROVIDER_CONNECTION_CHANGED_EVENT = 'chisa:provider-connection-changed';

/** Account quota and model settings reread metadata after either surface changes the effective Claude route. */
export function subscribeToProviderConnectionChanges(listener: (source: 'connections' | 'accounts') => void): () => void {
  const handler = (event: Event) => listener((event as CustomEvent<'connections' | 'accounts'>).detail);
  window.addEventListener(PROVIDER_CONNECTION_CHANGED_EVENT, handler);
  return () => window.removeEventListener(PROVIDER_CONNECTION_CHANGED_EVENT, handler);
}

async function providerConnectionMutation(request: () => Promise<Response>, source: 'connections' | 'accounts'): Promise<Response> {
  const authVersion = getAuthSessionVersion();
  const serverVersion = getServerConnectionVersion();
  const response = await request();
  if (response.ok && authVersion === getAuthSessionVersion() && serverVersion === getServerConnectionVersion()) {
    // Inspect a clone so endpoint callers still own the original response and its normal error handling.
    const result = await response.clone().json().catch(() => null);
    if (result?.success === true) window.dispatchEvent(new CustomEvent(PROVIDER_CONNECTION_CHANGED_EVENT, { detail: source }));
  }
  return response;
}

// ─── URL builders ───────────────────────────────────────────────────────────
// Exported for the consumers that cannot go through `authenticatedFetch`:
// `EventSource` and `XMLHttpRequest` need a bare URL.

/**
 * Persisted messages for one session. Omitting `limit` requests the whole
 * transcript; passing one always pairs it with an explicit offset so automatic
 * refreshes can never accidentally become an unbounded transcript request.
 */
export const sessionMessagesUrl = (
  sessionId: string,
  { limit = null, offset = 0 }: { limit?: number | null; offset?: number } = {},
): string => {
  const base = `/api/providers/sessions/${encodeURIComponent(sessionId)}/messages`;
  return limit === null || limit === undefined
    ? base
    : `${base}${query({ limit, offset: offset ?? 0 })}`;
};

const fileContentPath = (projectId: string, filePath: string) =>
  `/api/file-tree/projects/${projectId}/files/content${query({ path: filePath })}`;

const pluginAssetPath = (pluginName: string, assetFile: string) =>
  `/api/plugins/${encodeURIComponent(pluginName)}/assets/${encodeURIComponent(assetFile)}`;

const streamingApiUrl = (path: string): string => isChisaDesktop() ? desktopHttpUrl(path) : path;

// ─── API endpoints ──────────────────────────────────────────────────────────
// Every `/api/...` path the frontend talks to is declared here; components
// import a named method instead of assembling URLs of their own.

/** Creates an immutable API bound to one workspace; null explicitly refuses workspace requests. */
export function createWorkspaceApi(workspace?: Pick<WorkspaceDescriptor, 'projectId' | 'workspaceId' | 'generation' | 'kind' | 'sessionId' | 'sourceMode'> & { capabilities: Pick<WorkspaceDescriptor['capabilities'], 'read' | 'write' | 'git'> } | null) {
  const isWorkspaceUrl = (url: string) => /^\/api\/(?:file-tree\/projects\/|git(?:\/|\?)|worktrees(?:\/|\?|$))/.test(url);
  const requireWorkspace = (url: string, method = 'GET') => {
    if (!isWorkspaceUrl(url) || workspace === undefined) return;
    if (!workspace) throw new Error('会话工作区尚未准备好，请刷新工作区状态');
    if (url.startsWith('/api/worktrees') && workspace.sourceMode === 'ssh') throw new Error('SSH 本地项目暂不支持独立工作树');
    if (url.startsWith('/api/worktrees') && workspace.kind !== 'cloudReplica') throw new Error('请切换到主工作区管理工作树');
    const capability = url.startsWith('/api/git') || url.startsWith('/api/worktrees') ? 'git' : method === 'GET' ? 'read' : 'write';
    if (!workspace.capabilities[capability]) throw new Error('当前工作区暂不允许此操作，请刷新状态');
  };
  const scopedUrl = (url: string) => {
    if (!workspace || !isWorkspaceUrl(url)) return url;
    const suffix = query({ workspaceId: workspace.workspaceId, generation: workspace.generation });
    return url + (url.includes('?') ? '&' + suffix.slice(1) : suffix);
  };
  const get = (url: string, options: ApiRequestOptions = {}) => {
    try { requireWorkspace(url); } catch (error) { return Promise.reject(error); }
    return authenticatedFetch(scopedUrl(url), options);
  };
  const withBody = (method: string) => (url: string, body?: unknown, options: ApiRequestOptions = {}) => {
    try { requireWorkspace(url, method); } catch (error) { return Promise.reject(error); }
    const scopedBody = workspace && isWorkspaceUrl(url)
      ? { ...(body as Record<string, unknown>), workspaceId: workspace.workspaceId, generation: workspace.generation }
      : body;
    return authenticatedFetch(scopedUrl(url), { method, ...(scopedBody === undefined ? {} : { body: JSON.stringify(scopedBody) }), ...options });
  };
  const post = withBody('POST');
  const put = withBody('PUT');
  const patch = withBody('PATCH');
  const del = withBody('DELETE');
  return {
  sshWorkspaces: {
    connections: (options: ApiRequestOptions = {}) => get('/api/ssh-workspaces/connections', options),
    probe: (body: { connectionId: string; rootPath: string }, options: ApiRequestOptions = {}) => post('/api/ssh-workspaces/probe', body, options),
    recover: (body: { projectId: string; generation: string; cancel?: boolean }, options: ApiRequestOptions = {}) => post('/api/ssh-workspaces/recover', body, options),
  },
  workspaces: {
    resolve: (projectId: string, sessionId?: string, options: ApiRequestOptions = {}) =>
      get(`/api/workspaces/resolve${query({ projectId, sessionId })}`, options),
    recoverIntegration: (scope: { projectId: string; workspaceId: string; generation: string }, options: ApiRequestOptions = {}) =>
      post('/api/workspaces/integration/recover', scope, options),
    previewIntegration: (scope: { projectId: string; workspaceId: string; generation: string }, options: ApiRequestOptions = {}) =>
      post('/api/workspaces/integration/preview', scope, options),
    applyIntegration: (body: { projectId: string; workspaceId: string; generation: string; previewId: string; expectedSourceRevision: string; expectedTargetRevision: string; operationId: string }, options: ApiRequestOptions = {}) =>
      post('/api/workspaces/integration/apply', body, options),
    runProjectAction: (body: {
      projectId: string;
      actionId: string;
      workspaceId?: string;
      generation?: string;
      sessionId?: string;
    }, options: ApiRequestOptions = {}) =>
      post('/api/workspaces/actions/run', body, options),
  },
  readArtifact: (url: string, options: ApiRequestOptions = {}) => get(url, options),
  // Auth endpoints (no token required)
  auth: {
    status: () => desktopAwareFetch('/api/auth/status', { signal: AbortSignal.timeout(15000) }),
    login: (username: string, password: string) => desktopAwareFetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }),
    refresh: () => post('/api/auth/refresh'),
    user: () => get('/api/auth/user', { signal: AbortSignal.timeout(15000) }),
    updateProfile: (displayName: string, avatarDataUrl: string | null) => authenticatedFetch('/api/auth/profile', {
      method: 'PATCH',
      body: JSON.stringify({ displayName, avatarDataUrl }),
    }),
  },

  // Protected endpoints
  // config endpoint removed - no longer needed (frontend uses window.location)
  // After the projectName → projectId migration the path/query identifier is
  // the DB-assigned `projectId`; parameter names reflect that for clarity.
  projects: () => get('/api/projects'),
  archivedProjects: () => get('/api/projects/archived'),
  projectSessions: (
    projectId: string,
    { limit = 20, offset = 0 }: { limit?: number; offset?: number } = {},
    options: ApiRequestOptions = {},
  ) =>
    get(
      `/api/projects/${encodeURIComponent(projectId)}/sessions${query({ limit, offset })}`,
      options,
    ),
  projectTaskmaster: (projectId: string) =>
    get(`/api/projects/${encodeURIComponent(projectId)}/taskmaster`),
  projectSettings: (projectId: string) =>
    get(`/api/projects/${encodeURIComponent(projectId)}/settings`),
  projectContext: (projectId: string, options: ApiRequestOptions = {}) =>
    get(`/api/projects/${encodeURIComponent(projectId)}/context`, options),
  projectMemory: (projectId: string, options: ApiRequestOptions = {}) =>
    get(`/api/projects/${encodeURIComponent(projectId)}/memory`, options),
  saveProjectMemory: (projectId: string, body: { content: string; expectedHash: string }, options: ApiRequestOptions = {}) =>
    put(`/api/projects/${encodeURIComponent(projectId)}/memory`, body, options),
  projectActions: (projectId: string) =>
    get(`/api/projects/${encodeURIComponent(projectId)}/actions`),
  createProjectAction: (projectId: string, action: unknown) =>
    post(`/api/projects/${encodeURIComponent(projectId)}/actions`, action),
  updateProjectAction: (projectId: string, actionId: string, action: unknown) =>
    put(`/api/projects/${encodeURIComponent(projectId)}/actions/${encodeURIComponent(actionId)}`, action),
  deleteProjectAction: (projectId: string, actionId: string) =>
    del(`/api/projects/${encodeURIComponent(projectId)}/actions/${encodeURIComponent(actionId)}`),
  saveProjectSettings: (projectId: string, settings: unknown) =>
    put(`/api/projects/${encodeURIComponent(projectId)}/settings`, settings),
  clearProjectSettings: (projectId: string) =>
    del(`/api/projects/${encodeURIComponent(projectId)}/settings`),
  renameProject: (projectId: string, displayName: string) =>
    put(`/api/projects/${projectId}/rename`, { displayName }),
  restoreProject: (projectId: string) =>
    post(`/api/projects/${encodeURIComponent(projectId)}/restore`),
  // `hardDelete` => server `?force=true` (remove DB row + Claude *.jsonl + sessions rows for path).
  deleteProject: (projectId: string, hardDelete = false) =>
    del(`/api/projects/${projectId}${query({ force: hardDelete })}`),
  createProject: (projectData: unknown) => post('/api/projects/create-project', projectData),
  migrateLegacyProjectStars: (projectIds: string[]) =>
    post('/api/projects/migrate-legacy-stars', { projectIds }),
  toggleProjectStar: (projectId: string) =>
    post(`/api/projects/${encodeURIComponent(projectId)}/toggle-star`),
  // EventSource cannot send an Authorization header, so the token rides along as
  // a query parameter on the streaming endpoints below.
  cloneProjectProgressUrl: (params: Record<string, QueryValue>) =>
    streamingApiUrl(`/api/projects/clone-progress${query({ ...params, token: getStoredAuthToken() })}`),
  searchConversationsUrl: (searchQuery: string, limit = 50) =>
    streamingApiUrl(`/api/providers/search/sessions${query({
      q: searchQuery,
      limit,
      token: getStoredAuthToken(),
    })}`),

  // Session endpoints. Provider/project metadata are resolved by the backend
  // from the session id.
  // Session deletion mirrors project deletion:
  // - default: archive only (`isArchived = 1`)
  // - hardDelete: remove the row and, by default, its persisted transcript file
  deleteSession: (sessionId: string, hardDelete = false, options: ApiRequestOptions = {}) =>
    del(`/api/providers/sessions/${encodeURIComponent(sessionId)}${query({ force: hardDelete })}`, undefined, options),
  getArchivedSessions: () => get('/api/providers/sessions/archived'),
  // Resolves one session (by app id or provider-native id) to its metadata and
  // owning project — used when a /session/<id> URL isn't in loaded payloads.
  sessionDetails: (sessionId: string) =>
    get(`/api/providers/sessions/${encodeURIComponent(sessionId)}`),
  runningSessions: () => get('/api/providers/sessions/running'),
  recentConversations: ({ limit = 40, offset = 0 }: { limit?: number; offset?: number } = {}) =>
    get(`/api/providers/sessions/recent${query({ limit, offset })}`),
  providerSessionId: (sessionId: string) =>
    get(`/api/providers/sessions/${encodeURIComponent(sessionId)}/provider-id`),
  restoreSession: (sessionId: string) => post(`/api/providers/sessions/${sessionId}/restore`),
  // Creates an independent session holding this one's conversation up to
  // `upToAnchorId` (all of it when omitted). The source is left untouched.
  forkSession: (sessionId: string, body: { upToAnchorId?: string; title?: string } = {}) =>
    post(`/api/providers/sessions/${encodeURIComponent(sessionId)}/fork`, body),
  renameSession: (sessionId: string, summary: string) =>
    put(`/api/providers/sessions/${sessionId}`, { summary }),

  // Scheduled messages: send a message to a session at a future time.
  scheduledMessages: {
    list: (sessionId?: string) =>
      get(`/api/scheduled-messages${sessionId ? query({ sessionId }) : ''}`),
    create: (body: { sessionId: string; content: string; scheduledFor: string; options?: unknown }) =>
      post('/api/scheduled-messages', body),
    cancel: (id: string) => del(`/api/scheduled-messages/${encodeURIComponent(id)}`),
  },

  // Workspace file tree
  readFile: (projectId: string, filePath: string, options: ApiRequestOptions = {}) =>
    get(`/api/file-tree/projects/${projectId}/file${query({ filePath })}`, options),
  // Raw bytes for a workspace file. The endpoint requires the auth header, so
  // media call sites fetch a blob through here instead of using a bare `src`.
  readFileBlob: (projectId: string, filePath: string, options: ApiRequestOptions = {}) =>
    get(fileContentPath(projectId, filePath), options),
  saveFile: (projectId: string, filePath: string, content: string, expectedHash?: string | null, options: ApiRequestOptions = {}) =>
    put(`/api/file-tree/projects/${projectId}/file`, { filePath, content, expectedHash }, options),
  getFiles: (
    projectId: string,
    { shallow, directoryPath, ...options }: ApiRequestOptions & { shallow?: boolean; directoryPath?: string } = {},
  ) => get(`/api/file-tree/projects/${projectId}/files${query({ respectGitignore: true, shallow, directoryPath })}`, options),

  // File operations
  createFile: (
    projectId: string,
    { path, type, name }: { path: string; type: string; name: string },
  ) => post(`/api/file-tree/projects/${projectId}/files/create`, { path, type, name }),

  renameFile: (projectId: string, { oldPath, newName }: { oldPath: string; newName: string }) =>
    put(`/api/file-tree/projects/${projectId}/files/rename`, { oldPath, newName }),

  deleteFile: (projectId: string, { path, type }: { path: string; type: string }) =>
    del(`/api/file-tree/projects/${projectId}/files`, { path, type }),

  // Uploads with a progress bar go through XMLHttpRequest, which needs the URL.
  uploadFilesUrl: (projectId: string) => {
    const url = `/api/file-tree/projects/${encodeURIComponent(projectId)}/files/upload`;
    requireWorkspace(url, 'POST');
    return streamingApiUrl(scopedUrl(url));
  },

  // Browse filesystem for project suggestions
  browseFilesystem: (dirPath: string | null = null) =>
    get(`/api/file-tree/browse-filesystem${query({ path: dirPath })}`),

  createFolder: (folderPath: string) => post('/api/file-tree/create-folder', { path: folderPath }),

  // Git endpoints. The `project` param carries the DB projectId post-migration.
  git: {
    status: (projectId: string, options: ApiRequestOptions = {}) =>
      get(`/api/git/status${query({ project: projectId })}`, options),
    diff: (projectId: string, filePath: string, options: ApiRequestOptions = {}) =>
      get(`/api/git/diff${query({ project: projectId, file: filePath })}`, options),
    commitDiff: (projectId: string, commit: string, options: ApiRequestOptions = {}) =>
      get(`/api/git/commit-diff${query({ project: projectId, commit })}`, options),
    fileWithDiff: (projectId: string, filePath: string) =>
      get(`/api/git/file-with-diff${query({ project: projectId, file: filePath })}`),
    branches: (projectId: string, options: ApiRequestOptions = {}) =>
      get(`/api/git/branches${query({ project: projectId })}`, options),
    remoteStatus: (projectId: string, options: ApiRequestOptions = {}) =>
      get(`/api/git/remote-status${query({ project: projectId })}`, options),
    commits: (
      projectId: string,
      { limit }: { limit?: number } = {},
      options: ApiRequestOptions = {},
    ) => get(`/api/git/commits${query({ project: projectId, limit })}`, options),
    checkout: (projectId: string, branch: string) =>
      post('/api/git/checkout', { project: projectId, branch }),
    createBranch: (projectId: string, branch: string) =>
      post('/api/git/create-branch', { project: projectId, branch }),
    deleteBranch: (projectId: string, branch: string, force = false) =>
      post('/api/git/delete-branch', { project: projectId, branch, force }),
    fetch: (projectId: string) => post('/api/git/fetch', { project: projectId }),
    pull: (projectId: string) => post('/api/git/pull', { project: projectId }),
    push: (projectId: string) => post('/api/git/push', { project: projectId }),
    publish: (projectId: string, branch: string) =>
      post('/api/git/publish', { project: projectId, branch }),
    discard: (projectId: string, file: string) =>
      post('/api/git/discard', { project: projectId, file }),
    deleteUntracked: (projectId: string, file: string) =>
      post('/api/git/delete-untracked', { project: projectId, file }),
    stage: (projectId: string, files: string[]) =>
      post('/api/git/stage', { project: projectId, files }),
    unstage: (projectId: string, files: string[]) =>
      post('/api/git/unstage', { project: projectId, files }),
    commit: (projectId: string, message: string, files: string[]) =>
      post('/api/git/commit', { project: projectId, message, files }),
    initialCommit: (projectId: string) => post('/api/git/initial-commit', { project: projectId }),
    init: (projectId: string) => post('/api/git/init', { project: projectId }),
    revertLocalCommit: (projectId: string) =>
      post('/api/git/revert-local-commit', { project: projectId }),
    generateCommitMessage: (projectId: string, files: string[], provider: string) =>
      post('/api/git/generate-commit-message', { project: projectId, files, provider }),
  },

  worktrees: {
    list: (projectId: string) => get(`/api/worktrees${query({ project: projectId })}`),
    create: (
      projectId: string,
      { branch, baseBranch }: { branch: string; baseBranch: string | null },
    ) => post('/api/worktrees/create', { project: projectId, branch, baseBranch }),
    open: (projectId: string, worktreePath: string) =>
      post('/api/worktrees/open', { project: projectId, worktreePath }),
    merge: (
      projectId: string,
      worktreePath: string,
      options: { squash?: boolean; message?: string; removeAfterMerge?: boolean },
    ) => post('/api/worktrees/merge', { project: projectId, worktreePath, ...options }),
    remove: (
      projectId: string,
      worktreePath: string,
      options: { force?: boolean; deleteBranch?: boolean },
    ) => post('/api/worktrees/remove', { project: projectId, worktreePath, ...options }),
  },

  // Provider (coding agent) endpoints — models, capabilities, sessions, MCP, skills.
  providers: {
    // Claude account management is owned by the execution server; responses never contain login tokens.
    claudeAccounts: {
      state: (options: ApiRequestOptions = {}) => get('/api/providers/claude/accounts', options),
      login: (input: { accountId?: string; name?: string } = {}, options: ApiRequestOptions = {}) =>
        post('/api/providers/claude/accounts/login', input, options),
      loginStatus: (id: string, options: ApiRequestOptions = {}) =>
        get(`/api/providers/claude/accounts/login/${encodeURIComponent(id)}`, options),
      submitCode: (id: string, code: string, options: ApiRequestOptions = {}) =>
        post(`/api/providers/claude/accounts/login/${encodeURIComponent(id)}/code`, { code }, options),
      cancelLogin: (id: string, options: ApiRequestOptions = {}) =>
        del(`/api/providers/claude/accounts/login/${encodeURIComponent(id)}`, undefined, options),
      activate: (id: string | null, options: ApiRequestOptions = {}) =>
        providerConnectionMutation(() => put('/api/providers/claude/accounts/active', { id }, options), 'accounts'),
      rename: (id: string, name: string, options: ApiRequestOptions = {}) =>
        put(`/api/providers/claude/accounts/${encodeURIComponent(id)}`, { name }, options),
      remove: (id: string, options: ApiRequestOptions = {}) =>
        del(`/api/providers/claude/accounts/${encodeURIComponent(id)}`, undefined, options),
      refresh: (input: { id?: string | null; all?: boolean } = {}, options: ApiRequestOptions = {}) =>
        post('/api/providers/claude/accounts/refresh', input, options),
    },
    connections: {
      list: (options: ApiRequestOptions = {}) => get('/api/providers/claude/connections', options),
      create: (input: unknown, options: ApiRequestOptions = {}) => providerConnectionMutation(() => post('/api/providers/claude/connections', input, options), 'connections'),
      update: (id: string, input: unknown, options: ApiRequestOptions = {}) => providerConnectionMutation(() => put(`/api/providers/claude/connections/${encodeURIComponent(id)}`, input, options), 'connections'),
      remove: (id: string, options: ApiRequestOptions = {}) => providerConnectionMutation(() => del(`/api/providers/claude/connections/${encodeURIComponent(id)}`, undefined, options), 'connections'),
      activate: (id: string | null, options: ApiRequestOptions = {}) => providerConnectionMutation(() => put('/api/providers/claude/connections/active', { id }, options), 'connections'),
    },
    hiroute: {
      settings: (options: ApiRequestOptions = {}) => get('/api/providers/claude/hiroute', options),
      saveSettings: (settings: unknown, options: ApiRequestOptions = {}) =>
        put('/api/providers/claude/hiroute', settings, options),
    },
    capabilities: () => get('/api/providers/capabilities'),
    authStatus: (provider: string) =>
      get(`/api/providers/${encodeURIComponent(provider)}/auth/status`),

    models: (provider: string) => get(`/api/providers/${provider}/models`),
    createModel: (provider: string, input: unknown) =>
      post(`/api/providers/${provider}/models`, input),
    updateModel: (provider: string, recordId: string | number, input: unknown) =>
      patch(`/api/providers/${provider}/models/${recordId}`, input),
    deleteModel: (provider: string, recordId: string | number) =>
      del(`/api/providers/${provider}/models/${recordId}`),

    createSession: (payload: {
      provider: string;
      projectPath: string;
      initialMessage?: unknown;
      /** Explicit project default; omitted keeps the backend's isolated default. */
      workspaceMode?: 'isolated' | 'shared';
    }) => post('/api/providers/sessions', payload),
    sessionMessages: (
      sessionId: string,
      pagination: { limit?: number | null; offset?: number } = {},
      options: ApiRequestOptions = {},
    ) => get(sessionMessagesUrl(sessionId, pagination), options),
    sessionTokenUsage: (sessionId: string) =>
      get(`/api/providers/sessions/${encodeURIComponent(sessionId)}/token-usage`),
    sessionActiveModel: (provider: string, sessionId: string) =>
      get(`/api/providers/${provider}/sessions/${encodeURIComponent(sessionId)}/active-model`),
    setSessionActiveModel: (provider: string, sessionId: string, model: string) =>
      post(`/api/providers/${provider}/sessions/${encodeURIComponent(sessionId)}/active-model`, {
        model,
      }),
    setSessionActiveEffort: (provider: string, sessionId: string, effort: string) =>
      post(`/api/providers/${provider}/sessions/${encodeURIComponent(sessionId)}/active-effort`, {
        effort,
      }),

    mcpServers: (
      provider: string,
      { scope, workspacePath }: { scope: string; workspacePath?: string },
    ) => get(`/api/providers/${provider}/mcp/servers${query({ scope, workspacePath })}`),
    saveMcpServer: (provider: string, payload: unknown) =>
      post(`/api/providers/${provider}/mcp/servers`, payload),
    deleteMcpServer: (
      provider: string,
      serverName: string,
      { scope, workspacePath }: { scope: string; workspacePath?: string },
    ) =>
      del(
        `/api/providers/${provider}/mcp/servers/${encodeURIComponent(serverName)}${query({ scope, workspacePath })}`,
      ),
    saveGlobalMcpServer: (payload: unknown) => post('/api/providers/mcp/servers/global', payload),

    skills: (provider: string, options: { workspacePath?: string; projectId?: string; workspaceId?: string; generation?: string; sessionId?: string } = {}, requestOptions: ApiRequestOptions = {}) =>
      get(`/api/providers/${encodeURIComponent(provider)}/skills${query(options)}`, requestOptions),
    saveSkills: (provider: string, payload: unknown) =>
      post(`/api/providers/${provider}/skills`, payload),
  },

  // Slash commands
  commands: {
    // `projectPath` stays optional: a workspace without a resolved path omits
    // the field entirely, which is what the server expects.
    list: (projectPath: string | undefined, workspace?: WorkspaceSelector & { projectId: string; sessionId?: string }, options: ApiRequestOptions = {}) =>
      post('/api/commands/list', { projectPath, ...workspace }, options),
    execute: (payload: unknown) => post('/api/commands/execute', payload),
  },

  // Chat attachments, stored globally under ~/.cloudcli/assets
  assets: {
    uploadFiles: (formData: FormData) =>
      authenticatedFetch('/api/assets/files', {
        method: 'POST',
        headers: {}, // Let browser set Content-Type for FormData
        body: formData,
      }),
    file: (storedName: string) => get(`/api/assets/files/${encodeURIComponent(storedName)}`),
    image: (filename: string, options: ApiRequestOptions = {}) =>
      get(`/api/assets/images/${encodeURIComponent(filename)}`, options),
  },

  // TaskMaster endpoints — all addressed by DB projectId post-migration.
  taskmaster: {
    // Update a task
    updateTask: (projectId: string, taskId: string | number, updates: unknown) =>
      put(`/api/taskmaster/update-task/${projectId}/${taskId}`, updates),

    tasks: (projectId: string) => get(`/api/taskmaster/tasks/${encodeURIComponent(projectId)}`),
    mcpStatus: () => get('/api/taskmaster/mcp-status'),
    installationStatus: () => get('/api/taskmaster/installation-status'),

    prdFiles: (projectId: string) => get(`/api/taskmaster/prd/${encodeURIComponent(projectId)}`),
    prdFile: (projectId: string, fileName: string) =>
      get(`/api/taskmaster/prd/${encodeURIComponent(projectId)}/${encodeURIComponent(fileName)}`),
    savePrd: (projectId: string, { fileName, content }: { fileName: string; content: string }) =>
      post(`/api/taskmaster/prd/${encodeURIComponent(projectId)}`, { fileName, content }),
  },

  // User endpoints
  user: {
    gitConfig: () => get('/api/user/git-config'),
    updateGitConfig: (gitName: string, gitEmail: string) =>
      post('/api/user/git-config', { gitName, gitEmail }),
    onboardingStatus: () => get('/api/user/onboarding-status', { signal: AbortSignal.timeout(15000) }),
    completeOnboarding: () => post('/api/user/complete-onboarding'),

    // Preferences and chat drafts live server-side so they follow the user
    // from one device to another. `savePreferences` is a merge-patch: only the
    // keys it is given are written.
    preferences: () => get('/api/user/preferences'),
    savePreferences: (updates: Record<string, unknown>) =>
      patch('/api/user/preferences', updates),
    drafts: () => get('/api/user/drafts'),
    saveDraft: (scope: string, draft: { text: string; queuedMessage?: unknown }) =>
      put('/api/user/drafts', { scope, ...draft }),
    deleteDraft: (scope: string) => del('/api/user/drafts', { scope }),
  },

  // Server-side settings: API keys, stored credentials, notifications, web push
  settings: {
    apiKeys: () => get('/api/settings/api-keys'),
    createApiKey: (keyName: string) => post('/api/settings/api-keys', { keyName }),
    deleteApiKey: (keyId: string) => del(`/api/settings/api-keys/${keyId}`),
    toggleApiKey: (keyId: string, isActive: boolean) =>
      patch(`/api/settings/api-keys/${keyId}/toggle`, { isActive }),

    credentials: (type: string) => get(`/api/settings/credentials${query({ type })}`),
    createCredential: (payload: {
      credentialName: string;
      credentialType: string;
      credentialValue: string;
      description?: string;
    }) => post('/api/settings/credentials', payload),
    deleteCredential: (credentialId: string) => del(`/api/settings/credentials/${credentialId}`),
    toggleCredential: (credentialId: string, isActive: boolean) =>
      patch(`/api/settings/credentials/${credentialId}/toggle`, { isActive }),

    notificationPreferences: () => get('/api/settings/notification-preferences'),
    saveNotificationPreferences: (preferences: unknown) =>
      put('/api/settings/notification-preferences', preferences),

    push: {
      vapidPublicKey: () => get('/api/settings/push/vapid-public-key'),
      subscribe: (subscription: { endpoint?: string; keys?: unknown }) =>
        post('/api/settings/push/subscribe', subscription),
      unsubscribe: (endpoint: string) => post('/api/settings/push/unsubscribe', { endpoint }),
    },
  },

  plugins: {
    list: () => get('/api/plugins'),
    install: (url: string) => post('/api/plugins/install', { url }),
    uninstall: (name: string) => del(`/api/plugins/${encodeURIComponent(name)}`),
    update: (name: string) => post(`/api/plugins/${encodeURIComponent(name)}/update`),
    toggle: (name: string, enabled: boolean) =>
      put(`/api/plugins/${encodeURIComponent(name)}/enable`, { enabled }),
    // Plugin bundles/icons are fetched with auth headers and handed to the
    // browser as blobs, so a bare asset URL is never requested unauthenticated.
    asset: (pluginName: string, assetFile: string) => get(pluginAssetPath(pluginName, assetFile)),
    // Exposed so the icon cache can key on the resolved asset path.
    assetUrl: pluginAssetPath,
    // Plugin frames and chat use the same authenticated account service.
    webSocketUrl: (pluginName: string) => {
      const token = getStoredAuthToken();
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      if (isChisaDesktop()) return desktopWebSocketUrl(`/plugin-ws/${encodeURIComponent(pluginName)}`, token);
      const origin = `${protocol}//${window.location.host}`;
      return `${origin}/plugin-ws/${encodeURIComponent(pluginName)}${token ? `?token=${encodeURIComponent(token)}` : ''}`;
    },
    rpc: (pluginName: string, method: string, path: string, body?: unknown) =>
      authenticatedFetch(
        `/api/plugins/${encodeURIComponent(pluginName)}/rpc/${String(path).replace(/^\//, '')}`,
        {
          method: method || 'GET',
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        },
      ),
  },

  browserUse: {
    status: () => get('/api/browser-use/status'),
    settings: () => get('/api/browser-use/settings'),
    saveSettings: (settings: unknown) => put('/api/browser-use/settings', settings),
    sessions: () => get('/api/browser-use/sessions'),
    stopSession: (sessionId: string) => post(`/api/browser-use/sessions/${sessionId}/stop`),
    deleteSession: (sessionId: string) => del(`/api/browser-use/sessions/${sessionId}`),
    installRuntime: () => post('/api/browser-use/runtime/install'),
  },

  voice: {
    health: () => get('/api/voice/health'),
    transcribe: (formData: FormData, headers: Record<string, string> = {}) =>
      authenticatedFetch('/api/voice/transcribe', {
        method: 'POST',
        headers,
        body: formData,
      }),
    tts: (text: string, options: ApiRequestOptions = {}) => post('/api/voice/tts', { text }, options),
  },

  system: {
    update: () => post('/api/system/update'),
  },
  };
}

export const api = createWorkspaceApi();

// ---------------------------

//----------------- VOICE TRANSCRIPTION AND SPEECH ------------

/**
 * Builds a URL against the user's own OpenAI-compatible voice endpoint. Private to the
 * voice helpers below, which bypass the CloudCLI proxy when a base URL is configured.
 */
function voiceDirectUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, '')}${path}`;
}

/**
 * Serializes the active voice configuration so callers can detect a settings change and
 * drop cached synthesized audio.
 */
export function voiceConfigSignature(): string {
  return JSON.stringify(readVoiceConfig());
}

/**
 * Transcribes recorded audio, posting directly to the user's configured OpenAI-compatible
 * endpoint when one is set and otherwise going through the CloudCLI voice proxy.
 */
export function transcribeVoice(blob: Blob, filename: string): Promise<Response> {
  const config = readVoiceConfig();
  const body = new FormData();

  if (config.baseUrl.trim()) {
    body.append('file', blob, filename);
    body.append('model', config.sttModel || 'whisper-1');
    return fetch(voiceDirectUrl(config.baseUrl.trim(), '/audio/transcriptions'), {
      method: 'POST',
      headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
      body,
    });
  }

  body.append('audio', blob, filename);
  return api.voice.transcribe(body, voiceConfigHeaders());
}

/**
 * Synthesizes speech for the given text, using the user's configured OpenAI-compatible
 * endpoint when one is set and otherwise the CloudCLI voice proxy.
 */
export function synthesizeVoice(text: string, signal: AbortSignal): Promise<Response> {
  const config = readVoiceConfig();

  if (config.baseUrl.trim()) {
    return fetch(voiceDirectUrl(config.baseUrl.trim(), '/audio/speech'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.ttsModel || 'tts-1',
        voice: config.ttsVoice || 'alloy',
        input: text,
        ...(config.ttsFormat.trim() ? { response_format: config.ttsFormat.trim() } : {}),
      }),
      signal,
    });
  }

  return api.voice.tts(text, { headers: voiceConfigHeaders(), signal });
}
