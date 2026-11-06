import { api, readApiJson } from '@/shared/api';
import { expireAuthSession, getAuthSessionSnapshot, isAuthTokenExpired, isCurrentAuthSession } from '@/shared/authToken';
import { desktopWebSocketUrl, FrontendBridge, getServerTransportVersion, isDesktop } from '@/shared/chisa';
import type { AuthSessionSnapshot } from '@/shared/types';

/** Chat, shell and plugin transports obtain one-use path-bound tickets; desktop uses the native session capability. */
export async function resolveWebSocketAdmissionUrl(path: string, expected: AuthSessionSnapshot = getAuthSessionSnapshot()): Promise<string> {
  if (!['/ws', '/shell', '/desktop-notifications'].includes(path) && !/^\/plugin-ws\/[A-Za-z0-9_-]+$/.test(path)) {
    throw new Error('Unsupported WebSocket path');
  }
  const current = () => isCurrentAuthSession(expected) && getAuthSessionSnapshot().phase === 'ready';
  const interrupted = () => new DOMException('Account session changed before WebSocket admission', 'AbortError');
  if (!current() || !expected.token) throw interrupted();
  if (isAuthTokenExpired(expected.token)) {
    await expireAuthSession(expected);
    throw interrupted();
  }
  if (isDesktop()) {
    await FrontendBridge.getApiConnection();
    if (!current()) throw interrupted();
    // Native checks the same immutable identity and injects its captured Authorization upstream.
    return desktopWebSocketUrl(path, getAuthSessionSnapshot().token);
  }
  const transport = getServerTransportVersion();
  const result = await readApiJson<{ ticket: string; expiresAt: number }>(await api.auth.webSocketTicket(path, { expectedSession: expected }));
  if (!current() || transport !== getServerTransportVersion()) throw interrupted();
  if (typeof result.ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(result.ticket)
    || !Number.isSafeInteger(result.expiresAt) || result.expiresAt <= Math.floor(Date.now() / 1000)
    || result.expiresAt > Math.floor(Date.now() / 1000) + 30) throw new Error('Invalid WebSocket admission ticket');
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = new URL(path, `${protocol}//${window.location.host}`);
  url.searchParams.set('ticket', result.ticket);
  return url.toString();
}
