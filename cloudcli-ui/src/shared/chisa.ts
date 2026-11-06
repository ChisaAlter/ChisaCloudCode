// ChisaCloudCode 桌面账号连接、API 代理和本地诊断客户端。

import { call } from 'mygo-runtime';

import { withBackgroundOperation } from '@/shared/utils';
import { beginAuthServerSwitch, finishAuthServerSwitch, getAuthSessionSnapshot, isCurrentAuthSession, observeNativeAuthSession } from '@/shared/authToken';
import type { BridgeResponse, ChisaApiConnection, ChisaRequestReservation, ChisaServerConnectionResult, ChisaSessionEndResult, ChisaState, FrontendErrorReport, SshAgentEnsureResult, SshDefaultsResult, SshHelperInstallResult, SshNativePathResult, SshPreflight, SshTunnelProfileInput, SshTunnelProfilesResult, SshTunnelSaveResult, SshTunnelStatusResult } from '@/shared/types';

export function isDesktop(): boolean {
  try {
    return typeof globalThis !== 'undefined' && (globalThis as any).mygo !== undefined;
  } catch {
    return false;
  }
}

// A transport attempt is observable independently of committed native identity, including failed/no-op probes.
let serverConnectionVersion = 0;
let serverTransportVersion = 0;
let accountConnection: ChisaApiConnection | null = null;
let apiConnectionRevision = 0;
const connectionListeners = new Set<() => void>();

function announceConnection(identityChanged = false): void {
  if (identityChanged) serverConnectionVersion++;
  serverTransportVersion++;
  for (const listener of connectionListeners) listener();
}
function interrupted(): DOMException { return new DOMException('Account service connection changed', 'AbortError'); }
function validateConnection(connection: ChisaApiConnection): void {
  if (connection.protocolVersion !== 2 || (connection.configured && (!connection.sessionHandle || !connection.serverKey))
    || !Number.isSafeInteger(connection.tokenRevision) || !Number.isSafeInteger(connection.generation)) {
    throw new Error('桌面连接协议需要升级，请安装支持安全会话的客户端');
  }
}
function publishConnection(connection: ChisaApiConnection): ChisaApiConnection {
  validateConnection(connection);
  const previous = accountConnection;
  accountConnection = Object.freeze({ ...connection });
  observeNativeAuthSession({ sessionInstanceId: connection.sessionHandle, nativeHandle: connection.sessionHandle,
    serverKey: connection.serverKey, userId: null, token: connection.authenticated ? connection.accessToken : null,
    tokenRevision: connection.tokenRevision, nativeGeneration: connection.generation,
    phase: connection.switching ? 'switching' : connection.authenticated ? 'ready' : 'signedOut', storageMode: 'window' });
  if (!previous || previous.sessionHandle !== connection.sessionHandle || previous.tokenRevision !== connection.tokenRevision
    || previous.switching !== connection.switching || previous.webSocketUrl !== connection.webSocketUrl) announceConnection(!previous || previous.sessionHandle !== connection.sessionHandle);
  return accountConnection;
}
function currentProxyConnection(token?: string | null): ChisaApiConnection {
  const snapshot = getAuthSessionSnapshot();
  if (!accountConnection || accountConnection.switching || !accountConnection.authenticated
    || snapshot.phase !== 'ready' || snapshot.nativeHandle !== accountConnection.sessionHandle
    || !isCurrentAuthSession(snapshot, true) || (token != null && token !== accountConnection.accessToken)) {
    throw new Error('账号服务尚未初始化或会话已改变');
  }
  return accountConnection;
}

/** URL capabilities already bind native identity; a caller-supplied token is never appended or forwarded. */
export function desktopWebSocketUrl(path: string, token: string | null): string {
  return currentProxyConnection(token).webSocketUrl + path;
}

/** Stream/upload capabilities fail closed on stale identity and never resolve against a later target. */
export function desktopHttpUrl(path: string): string {
  const parsed = new URL(path, 'https://native.invalid');
  parsed.searchParams.delete('token');
  return currentProxyConnection().httpProxyUrl + parsed.pathname + parsed.search;
}

/** Account-scoped feature results keep this observable transport incarnation fence. */
export function getServerConnectionVersion(): number { return serverConnectionVersion; }
/** Sockets react to token/probe transport changes without remounting the account workspace. */
export function getServerTransportVersion(): number { return serverTransportVersion; }
/** Sockets and auth subscribe to attempt/resume transitions even if the service address does not change. */
export function subscribeToServerConnection(listener: () => void): () => void {
  connectionListeners.add(listener);
  return () => { connectionListeners.delete(listener); };
}

/** API accepts an authentication handoff only for the exact native request predecessor. */
export function acceptNativeSessionTransition(response: BridgeResponse, previous: ChisaApiConnection): void {
  const transition = response.sessionTransition;
  if (!transition) return;
  if (!accountConnection || accountConnection.sessionHandle !== previous.sessionHandle
    || accountConnection.tokenRevision !== previous.tokenRevision
    || transition.previousSessionHandle !== previous.sessionHandle || transition.previousTokenRevision !== previous.tokenRevision) throw interrupted();
  ++apiConnectionRevision;
  publishConnection(transition.connection);
}

/** Auth, shared API transport and error reporting use only the native account-service capabilities. */
export const FrontendBridge = {
  async connectServer(rawURL: string): Promise<ChisaServerConnectionResult> {
    const attempt = beginAuthServerSwitch();
    ++apiConnectionRevision;
    announceConnection();
    try {
      const result = await withBackgroundOperation('正在连接服务器', '正在后台建立连接。',
        () => call<ChisaServerConnectionResult>('FrontendBridge.ConnectServer', rawURL));
      if (result.connection) publishConnection(result.connection);
      else throw new Error('桌面连接协议需要升级，未收到绑定会话');
      await finishAuthServerSwitch(attempt, false);
      return result;
    } catch (error) {
      await finishAuthServerSwitch(attempt, false);
      throw error;
    } finally { announceConnection(); }
  },
  getState(): Promise<ChisaState> {
    return call('FrontendBridge.GetState');
  },
  async getApiConnection(): Promise<ChisaApiConnection> {
    if (getAuthSessionSnapshot().phase === 'switching') throw interrupted();
    const revision = apiConnectionRevision;
    const connection = await call<ChisaApiConnection>('FrontendBridge.GetApiConnection');
    if (revision !== apiConnectionRevision) {
      if (accountConnection && connection.sessionHandle === accountConnection.sessionHandle
        && connection.tokenRevision <= accountConnection.tokenRevision && getAuthSessionSnapshot().phase !== 'switching') return accountConnection;
      throw interrupted();
    }
    // Concurrent lookups may complete out of order. Never roll back a newer generation/token revision.
    if (accountConnection && (connection.generation < accountConnection.generation
      || (connection.sessionHandle === accountConnection.sessionHandle && connection.tokenRevision < accountConnection.tokenRevision))) throw interrupted();
    return publishConnection(connection);
  },
  async endServerSession(): Promise<ChisaSessionEndResult> {
    const predecessor = accountConnection;
    const captured = getAuthSessionSnapshot();
    // Auth retains its committed handle independently of the URL cache; no zero/wildcard logout is ever sent.
    const handle = predecessor?.sessionHandle ?? captured.nativeHandle;
    if (!handle) return { ok: false, code: 'STALE_SERVER_SESSION' };
    const attempt = beginAuthServerSwitch();
    ++apiConnectionRevision;
    announceConnection();
    try {
      let revision = predecessor?.tokenRevision ?? captured.tokenRevision;
      let result = await call<ChisaSessionEndResult>('FrontendBridge.EndServerSessionV2', handle, revision);
      if (!result.ok && result.code === 'STALE_SERVER_SESSION') {
        const current = await call<ChisaApiConnection>('FrontendBridge.GetApiConnection');
        validateConnection(current);
        // Refresh may race logout. Retry only the unsent conditional revoke for the same login, never another handle.
        if (current.sessionHandle === handle) {
          revision = current.tokenRevision;
          result = await call<ChisaSessionEndResult>('FrontendBridge.EndServerSessionV2', handle, revision);
        }
      }
      if (result.connection && getAuthSessionSnapshot().nativeHandle === handle) publishConnection(result.connection);
      if (!result.ok) throw new Error('账号会话未能安全关闭，请重试注销');
      return result;
    } finally { await finishAuthServerSwitch(attempt, false); announceConnection(); }
  },
  reportFrontendError(report: FrontendErrorReport): Promise<void> {
    return call('FrontendBridge.ReportFrontendError', report);
  },
  serverRequest(
    requestId: string,
    method: string,
    path: string,
    headers: Record<string, string>,
    bodyB64: string,
  ): Promise<BridgeResponse> {
    return call('FrontendBridge.ServerRequest', requestId, method, path, headers, bodyB64);
  },
  beginServerRequest(connection: ChisaApiConnection, purpose: 'api' | 'login' | 'restore' | 'public-status', token = connection.accessToken): Promise<ChisaRequestReservation> {
    return call('FrontendBridge.BeginServerRequestV2', connection.sessionHandle, token, connection.tokenRevision, purpose, connection.serverKey);
  },
  cancelServerRequest(requestId: string): Promise<void> { return call('FrontendBridge.CancelServerRequest', requestId); },
  selectSshLocalFolder(): Promise<SshNativePathResult> { return call('FrontendBridge.SelectSshLocalFolder'); },
  selectSshIdentityFile(): Promise<SshNativePathResult> { return call('FrontendBridge.SelectSshIdentityFile'); },
  selectSshKnownHostsFile(): Promise<SshNativePathResult> { return call('FrontendBridge.SelectSshKnownHostsFile'); },
  getSshPreflight(): Promise<SshPreflight> { return call('FrontendBridge.GetSshPreflight'); },
  getSshDefaults(): Promise<SshDefaultsResult> { return call('FrontendBridge.GetSshDefaults'); },
  getSshTunnelProfiles(): Promise<SshTunnelProfilesResult> { return call('FrontendBridge.GetSshTunnelProfiles'); },
  saveSshTunnelProfile(profile: SshTunnelProfileInput): Promise<SshTunnelSaveResult> { return call('FrontendBridge.SaveSshTunnelProfile', profile); },
  ensureSshAgent(profileId = ''): Promise<SshAgentEnsureResult> { return call('FrontendBridge.EnsureSshAgent', profileId); },
  startSshTunnel(profileId: string): Promise<SshTunnelStatusResult> { return call('FrontendBridge.StartSshTunnel', profileId); },
  stopSshTunnel(profileId: string): Promise<SshTunnelStatusResult> { return call('FrontendBridge.StopSshTunnel', profileId); },
  getSshTunnelStatus(profileId: string): Promise<SshTunnelStatusResult> { return call('FrontendBridge.GetSshTunnelStatus', profileId); },
  installSshWorkspaceHelper(): Promise<SshHelperInstallResult> { return call('FrontendBridge.InstallSshWorkspaceHelper'); },
} as const;

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
