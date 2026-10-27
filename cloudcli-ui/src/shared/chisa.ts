// ChisaCloudCode 桌面账号连接、API 代理和本地诊断客户端。

import { call } from 'mygo-runtime';

import { withBackgroundOperation } from '@/shared/utils';
import { getAuthSessionVersion } from '@/shared/authToken';
import type { BridgeResponse, ChisaApiConnection, ChisaState, FrontendErrorReport, SshAgentEnsureResult, SshDefaultsResult, SshHelperInstallResult, SshNativePathResult, SshPreflight, SshTunnelProfileInput, SshTunnelProfilesResult, SshTunnelSaveResult, SshTunnelStatusResult } from '@/shared/types';

export function isDesktop(): boolean {
  try {
    return typeof globalThis !== 'undefined' && (globalThis as any).mygo !== undefined;
  } catch {
    return false;
  }
}

// Account transport identity invalidates in-flight replies when the server changes.
let serverConnectionVersion = 0;
let accountConnection: ChisaApiConnection | null = null;
let accountConnectionAuthVersion = -1;
let apiConnectionRevision = 0;

/** Shared API URL builders use the native loopback proxy, whose remote side verifies HTTPS. */
export function desktopWebSocketUrl(path: string, token: string | null): string {
  if (!accountConnection || accountConnectionAuthVersion !== getAuthSessionVersion()) throw new Error('账号服务尚未初始化');
  return `${accountConnection.webSocketUrl}${path}${token ? `?token=${encodeURIComponent(token)}` : ''}`;
}

/** Streaming API requests and file uploads use the same account-bound native proxy as chat. */
export function desktopHttpUrl(path: string): string {
  if (!accountConnection || accountConnectionAuthVersion !== getAuthSessionVersion()) throw new Error('账号服务尚未初始化');
  return accountConnection.webSocketUrl.replace(/^ws:/, 'http:') + path;
}

/** API requests use this generation to discard replies from a replaced connection. */
export function getServerConnectionVersion(): number { return serverConnectionVersion; }

/** Auth, shared API transport and error reporting use only the native account-service capabilities. */
export const FrontendBridge = {
  connectServer(rawURL: string): Promise<Record<string, unknown>> {
    serverConnectionVersion++;
    accountConnection = null;
    return withBackgroundOperation('正在连接服务器', '正在后台建立连接。', () => call('FrontendBridge.ConnectServer', rawURL));
  },
  getState(): Promise<ChisaState> {
    return call('FrontendBridge.GetState');
  },
  async getApiConnection(): Promise<ChisaApiConnection> {
    const serverVersion = serverConnectionVersion;
    const authVersion = getAuthSessionVersion();
    const revision = ++apiConnectionRevision;
    const connection = await call<ChisaApiConnection>('FrontendBridge.GetApiConnection');
    if (serverVersion !== serverConnectionVersion || authVersion !== getAuthSessionVersion()) throw new DOMException('Account service connection changed', 'AbortError');
    // A late lookup cannot replace the newer URL or native connection generation.
    if (revision === apiConnectionRevision) { accountConnection = connection; accountConnectionAuthVersion = authVersion; }
    return connection;
  },
  recordConnectionVersion(version: string | null): void {
    if (accountConnection && version) accountConnection.version = Number(version);
  },
  endServerSession(): Promise<void> {
    const version = accountConnection?.version ?? 0;
    serverConnectionVersion++;
    accountConnection = null;
    return call('FrontendBridge.EndServerSession', version);
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
  beginServerRequest(): Promise<string> { return call('FrontendBridge.BeginServerRequest'); },
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
