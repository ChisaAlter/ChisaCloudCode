// ChisaCloudCode 桌面桥客户端（手写，结构与 mygo generate 输出一致）

import { call, on } from "mygo-runtime";

import { beginBackgroundOperation, withBackgroundOperation, withBlockingOperation } from '@/shared/utils';
import { getAuthSessionVersion, getStoredAuthToken } from '@/shared/authToken';
import type { ComponentBuildIdentity, BridgeResponse, ChisaClearResult, ChisaApiConnection, ChisaProjectStorage, ChisaState, ChisaSyncInfo, ChisaWorkspaceBindingSelection, ChisaWorkspaceSwitchResult, ChisaWorkspaceSyncEvent, FrontendErrorReport, LocalSelection, PiAttachmentInput, PiBridgeResult, PiConfigInput, PiConfigView, PiSessionView } from "@/shared/types";

export function isDesktop(): boolean {
  try {
    return typeof globalThis !== "undefined" && (globalThis as any).mygo !== undefined;
  } catch {
    return false;
  }
}

// 最近一次「本机」选择成功的结果（确认页用它显示本地文件夹而非服务器路径）
let lastLocalSelection: LocalSelection | null = null;
let serverConnectionVersion = 0;
/** Identity observers invalidate account-bound snapshots on a connection replacement. */
export const SERVER_CONNECTION_CHANGED_EVENT = 'server-connection-changed';
let accountConnection: ChisaApiConnection | null = null;
let endingServerSession: Promise<void> | null = null;
// Connection attempts cannot admit work from the account whose destination is changing.
let serverConnectionAttempts = 0;
// A successful replacement retains this barrier until logout or an explicit new login.
let replacedAuthSessionVersion: number | null = null;
const workspaceConnectionListeners = new Set<() => void>();
const piConfigListeners = new Set<(config: PiConfigView) => void>();

/** Settings refreshes the workspace snapshot when the account-sync controls settle. */
export function onWorkspaceConnectionChanged(listener: () => void): () => void {
  workspaceConnectionListeners.add(listener);
  return () => { workspaceConnectionListeners.delete(listener); };
}

/** Both Pi configuration entry points publish the saved native model to mounted consumers. */
export function onPiConfigChanged(listener: (config: PiConfigView) => void): () => void {
  piConfigListeners.add(listener);
  return () => { piConfigListeners.delete(listener); };
}

/** Shared API URL builders use the native loopback proxy, whose remote side verifies HTTPS. */
export function desktopWebSocketUrl(path: string, token: string | null): string {
  if (!accountConnection) throw new Error('账号服务尚未初始化');
  assertServerRequestAllowed(false);
  return `${accountConnection.webSocketUrl}${path}${token ? `?token=${encodeURIComponent(token)}` : ''}`;
}

/** Streaming API requests and file uploads use the same account-bound native proxy as chat. */
export function desktopHttpUrl(path: string): string {
  if (!accountConnection) throw new Error('账号服务尚未初始化');
  assertServerRequestAllowed(false);
  return accountConnection.webSocketUrl.replace(/^ws:/, 'http:') + path;
}

/** API requests use this generation to discard replies from a replaced connection. */
export function getServerConnectionVersion(): number { return serverConnectionVersion; }
/** API transport checks this before metadata and again before reserving/sending a request. */
export function assertServerRequestAllowed(anonymous: boolean): void {
  if (serverConnectionAttempts > 0
    || (!anonymous && replacedAuthSessionVersion === getAuthSessionVersion())) {
    throw new DOMException('服务器连接正在切换，请重新登录后再操作', 'AbortError');
  }
}
export function recordLocalSelection(sel: LocalSelection): void {
  lastLocalSelection = sel;
}
export function getLocalSelectionForServerPath(serverPath: string): LocalSelection | null {
  if (lastLocalSelection && lastLocalSelection.serverPath === serverPath) {
    return lastLocalSelection;
  }
  return null;
}

/** Desktop settings, project creation and Pi use these native app capabilities. */

export const FrontendBridge = {
  getBuildIdentity(): Promise<ComponentBuildIdentity> { return call('FrontendBridge.GetBuildIdentity'); },
  connectServer(rawURL: string): Promise<Record<string, unknown>> {
    const hadAccountToken = getStoredAuthToken() !== null;
    const authVersion = getAuthSessionVersion();
    serverConnectionAttempts++;
    serverConnectionVersion++;
    window.dispatchEvent(new Event(SERVER_CONNECTION_CHANGED_EVENT));
    accountConnection = null;
    return withBackgroundOperation('正在连接服务器', '正在后台建立连接。', async () => {
      try {
        const result = await call<Record<string, unknown>>("FrontendBridge.ConnectServer", rawURL);
        if (result.ok === true && result.changed !== false && hadAccountToken) {
          replacedAuthSessionVersion = authVersion;
        }
        return result;
      } finally {
        serverConnectionAttempts--;
      }
    });
  },
  getState(): Promise<ChisaState> {
    return call("FrontendBridge.GetState");
  },
  refreshPreviews(): Promise<ChisaState> {
    return call('FrontendBridge.RefreshPreviews');
  },
  async getApiConnection(): Promise<ChisaApiConnection> {
    const startedVersion = serverConnectionVersion;
    if (endingServerSession) await endingServerSession;
    if (startedVersion !== serverConnectionVersion) {
      throw new DOMException('服务器连接已改变', 'AbortError');
    }
    const connection = await call<ChisaApiConnection>('FrontendBridge.GetApiConnection');
    const cachedVersion = accountConnection?.version;
    if (startedVersion !== serverConnectionVersion
      || (typeof cachedVersion === 'number' && typeof connection.version === 'number'
        && connection.version < cachedVersion)) {
      throw new DOMException('服务器连接已改变', 'AbortError');
    }
    const replaced = accountConnection !== null && accountConnection.version !== connection.version;
    accountConnection = connection;
    if (replaced) {
      serverConnectionVersion++;
      window.dispatchEvent(new Event(SERVER_CONNECTION_CHANGED_EVENT));
    }
    return connection;
  },
  recordConnectionVersion(version: string | null): void {
    if (accountConnection && version && Number(version) !== accountConnection.version) {
      accountConnection.version = Number(version);
      serverConnectionVersion++;
      window.dispatchEvent(new Event(SERVER_CONNECTION_CHANGED_EVENT));
    }
  },
  endServerSession(): Promise<void> {
    if (endingServerSession) return endingServerSession;
    const version = accountConnection?.version ?? 0;
    serverConnectionVersion++;
    accountConnection = null;
    window.dispatchEvent(new Event(SERVER_CONNECTION_CHANGED_EVENT));
    const ending = call<void>('FrontendBridge.EndServerSession', version);
    endingServerSession = ending;
    return ending.finally(() => {
      if (endingServerSession === ending) endingServerSession = null;
    });
  },
  connectAccountWorkspace(): Promise<Record<string, unknown>> {
    return withBackgroundOperation('正在连接文件同步', '正在使用当前账号连接本地文件同步。', () => call<Record<string, unknown>>('FrontendBridge.ConnectAccountWorkspace'))
      .finally(() => workspaceConnectionListeners.forEach(listener => listener()));
  },
  connectWorkspace(serverUrl: string, sshHost: string, sshUser: string, keyPath: string): Promise<Record<string, unknown>> {
    return withBackgroundOperation('正在连接文件同步', '正在建立独立的文件同步连接。', () => call('FrontendBridge.ConnectWorkspace', serverUrl, sshHost, sshUser, keyPath));
  },
  selectWorkspaceKey(): Promise<Record<string, unknown>> {
    return call('FrontendBridge.SelectWorkspaceKey');
  },
  getProjectSync(serverPath: string): Promise<ChisaSyncInfo> {
    return call("FrontendBridge.GetProjectSync", serverPath);
  },
  reportFrontendError(report: FrontendErrorReport): Promise<void> {
    return call("FrontendBridge.ReportFrontendError", report);
  },
  getProjectStorage(serverPath: string): Promise<Record<string, ChisaProjectStorage>> {
    return call("FrontendBridge.GetProjectStorage", serverPath);
  },
  selectLocalFolder(): Promise<Record<string, unknown>> {
    return withBlockingOperation('正在打开工作目录', '选择文件夹后，将完成同步并载入项目，请稍候…', () => call("FrontendBridge.SelectLocalFolder"));
  },
  serverRequest(
    requestId: string,
    method: string,
    path: string,
    headers: Record<string, string>,
    bodyB64: string,
  ): Promise<BridgeResponse> {
    return call("FrontendBridge.ServerRequest", requestId, method, path, headers, bodyB64);
  },
  beginServerRequest(): Promise<string> { return call("FrontendBridge.BeginServerRequest"); },
  cancelServerRequest(requestId: string): Promise<void> { return call("FrontendBridge.CancelServerRequest", requestId); },
  openPreview(id: string): Promise<Record<string, unknown>> {
    return call("FrontendBridge.OpenPreview", id);
  },
  stopPreview(id: string): Promise<Record<string, unknown>> {
    return call("FrontendBridge.StopPreview", id);
  },
  revoke(serverPath: string): Promise<Record<string, unknown>> {
    return withBackgroundOperation('正在移除工作目录', '正在后台停止同步并解除绑定。', () => call("FrontendBridge.Revoke", serverPath));
  },
  forgetMapping(serverPath: string, bindingEpoch: string): Promise<Record<string, unknown>> {
    return withBackgroundOperation('正在解除旧绑定', '停止本机同步并保留两端项目文件。', () => call('FrontendBridge.ForgetMapping', serverPath, bindingEpoch));
  },
  switchAccountWorkspace(bindings: ChisaWorkspaceBindingSelection[]): Promise<ChisaWorkspaceSwitchResult> {
    return withBackgroundOperation('正在切换所选项目', '仅为所选项目连接当前账号，其他项目保留原绑定。', () => call<ChisaWorkspaceSwitchResult>('FrontendBridge.SwitchAccountWorkspace', bindings))
      .finally(() => workspaceConnectionListeners.forEach(listener => listener()));
  },
  syncProject(serverPath: string): Promise<Record<string, unknown>> {
    return withBackgroundOperation('正在同步工作区', '后台同步中，可继续浏览和编辑消息。', () => call("FrontendBridge.SyncProject", serverPath));
  },
  confirmProjectEmpty(serverPath: string, bindingEpoch: string): Promise<ChisaClearResult> {
    return withBackgroundOperation('正在同步清空 VPS', '正在备份 VPS 可同步文件并确认空目录同步。', () => call('FrontendBridge.ConfirmProjectEmpty', serverPath, bindingEpoch));
  },
  piGetConfig(): Promise<PiConfigView> { return call("FrontendBridge.PiGetConfig"); },
  async piSaveConfig(input: PiConfigInput): Promise<PiConfigView> {
    const config = await call<PiConfigView>("FrontendBridge.PiSaveConfig", input);
    if (config.ok !== false) piConfigListeners.forEach(listener => listener(config));
    return config;
  },
  piInstall(): Promise<PiBridgeResult> { return call("FrontendBridge.PiInstall"); },
  piGetSession(serverPath: string, sessionId: string): Promise<PiSessionView> {
    return call("FrontendBridge.PiGetSession", serverPath, sessionId);
  },
  piPrompt(serverPath: string, sessionId: string, message: string, context: string, attachments: PiAttachmentInput[] = []): Promise<PiSessionView> {
    return call("FrontendBridge.PiPrompt", serverPath, sessionId, message, context, attachments);
  },
  piEvents(serverPath: string, sessionId: string, after: number): Promise<PiSessionView> {
    return call("FrontendBridge.PiEvents", serverPath, sessionId, after);
  },
  piAbort(serverPath: string, sessionId: string): Promise<PiSessionView> {
    return withBackgroundOperation('正在停止 Pi 任务', '后台停止中，可继续浏览和编辑消息。', () => call("FrontendBridge.PiAbort", serverPath, sessionId));
  },
  piRecoverSession(serverPath: string, sessionId: string): Promise<PiSessionView> {
    return withBackgroundOperation('正在交还 Pi 工作区', '只恢复文件同步与工作区交还，不重新运行任务。', () => call("FrontendBridge.PiRecoverSession", serverPath, sessionId));
  },
} as const;

/** Background-operation notices consume only explicit native synchronization actions, not file-watcher scans. */
export function onWorkspaceSyncChanged(listener: (event: ChisaWorkspaceSyncEvent) => void): () => void {
  return on<ChisaWorkspaceSyncEvent>('chisa:workspace-sync', listener);
}

/** The project bar and desktop settings receive authoritative engine state only when its meaning changes. */
export function onWorkspaceSyncStateChanged(listener: (info: ChisaSyncInfo) => void): () => void {
  return on<ChisaSyncInfo>('chisa:workspace-sync-state', listener);
}

function redactErrorText(text: string): string {
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
    .replace(/\b(token|api_?key|password|authorization)(=|:\s*)([^\s&#]+)/gi, '$1$2[redacted]');
}

/** App and chat error boundaries record failures locally without sending diagnostic data to the VPS. */
export function reportFrontendError(source: string, error: unknown, componentStack = ''): void {
  if (!isDesktop()) return;

  // Do not serialize rejection objects: they can contain requests, headers or messages.
  const message = error instanceof Error
    ? `${error.name}: ${error.message}`
    : typeof error === 'string' ? error : 'Unknown frontend error';

  void FrontendBridge.reportFrontendError({
    source,
    path: window.location.pathname,
    message: redactErrorText(message),
    stack: redactErrorText(error instanceof Error ? error.stack ?? '' : ''),
    componentStack,
  }).catch(() => {
    // A failed diagnostic write must not recursively report itself.
  });
}

/** main.tsx installs these before mounting React; normal browser error reporting remains enabled. */
export function installFrontendErrorReporting(): () => void {
  const handleError = (event: ErrorEvent) => reportFrontendError('window-error', event.error ?? event.message);
  const handleRejection = (event: PromiseRejectionEvent) => reportFrontendError('unhandled-rejection', event.reason);
  window.addEventListener('error', handleError);
  window.addEventListener('unhandledrejection', handleRejection);
  return () => {
    window.removeEventListener('error', handleError);
    window.removeEventListener('unhandledrejection', handleRejection);
  };
}

/** App shows nonblocking status for automatic handoffs and startup synchronization. */
export function subscribeWorkspaceSynchronization(): () => void {
  if (!isDesktop()) return () => {};
  const pending = new Map<string, () => void>();
  const seen = new Set<string>();
  const update = (serverPath: string, status: string) => {
    const busy = status === 'syncing' || status === 'migrating';
    if (busy && !pending.has(serverPath)) pending.set(serverPath, beginBackgroundOperation('正在同步工作区', '后台同步中，可继续浏览和编辑消息。'));
    else if (!busy) { pending.get(serverPath)?.(); pending.delete(serverPath); }
  };
  let disposed = false;
  const unsubscribe = onWorkspaceSyncChanged(event => {
    seen.add(event.serverPath);
    update(event.serverPath, event.status);
  });
  void FrontendBridge.getState().then(state => {
    if (!disposed) for (const [serverPath, info] of Object.entries(state.syncOperations ?? {})) {
      // Live events received since the request began take precedence over its snapshot.
      if (!seen.has(serverPath)) update(serverPath, info.status);
    }
  }).catch(() => {});
  return () => {
    disposed = true;
    unsubscribe();
    pending.forEach(finish => finish());
  };
}
