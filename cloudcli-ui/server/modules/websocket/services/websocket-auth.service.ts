import type { IncomingMessage } from 'node:http';

import type { VerifyClientCallbackSync } from 'ws';

import { createHttpIngressPolicy } from '@/modules/http-ingress/index.js';
import type { AuthenticatedWebSocketRequest } from '@/shared/index.js';

type WebSocketAuthDependencies = {
  isPlatform: boolean;
  authenticateWebSocket: (token: string | null) => AuthenticatedWebSocketRequest['user'] | null;
  consumeWebSocketTicket: (ticket: unknown, path: string) => AuthenticatedWebSocketRequest['user'] | null;
  isAuthSessionActive: (sessionId: string, userId: number, version: number) => boolean;
  authorizeUpgrade?: (request: IncomingMessage, nativeHeader?: boolean) => boolean;
};

/** Gateway and its lifetime guard use the same persistent login proof; a platform/user-only identity is insufficient. */
export function isWebSocketSessionActive(
  request: AuthenticatedWebSocketRequest,
  check: WebSocketAuthDependencies['isAuthSessionActive'],
): boolean {
  const user = request.user;
  const userId = Number(user?.id ?? user?.userId);
  if (!user || !Number.isSafeInteger(userId) || userId <= 0 || typeof user.sessionId !== 'string'
    || typeof user.sessionVersion !== 'number' || !Number.isSafeInteger(user.sessionVersion) || user.sessionVersion < 0
    || typeof user.sessionExpiresAt !== 'number' || !Number.isSafeInteger(user.sessionExpiresAt)
    || user.sessionExpiresAt <= Math.floor(Date.now() / 1000)) return false;
  try { return check(user.sessionId, userId, user.sessionVersion) === true; } catch { return false; }
}

/** The websocket gateway authenticates each exact path with a one-use ticket or a native Authorization header. */
export function verifyWebSocketClient(
  info: Parameters<VerifyClientCallbackSync<AuthenticatedWebSocketRequest>>[0],
  dependencies: WebSocketAuthDependencies,
): boolean {
  const request = info.req as AuthenticatedWebSocketRequest;
  delete request.user;
  try {
    const raw = request.url ?? '';
    if (!raw.startsWith('/') || raw.startsWith('//') || raw.length > 1024 || /[\\\r\n\0#]/.test(raw)) return false;
    const url = new URL(raw, 'http://websocket.invalid');
    if (raw.split('?')[0] !== url.pathname) return false;
    if (!['/ws', '/shell', '/desktop-notifications'].includes(url.pathname)
      && !/^\/plugin-ws\/[A-Za-z0-9_-]+$/.test(url.pathname)) return false;
    // A query JWT is never a fallback credential. Reject ambiguous tickets/headers and unexpected URL parameters.
    if ([...url.searchParams.keys()].some(key => key !== 'ticket') || url.searchParams.getAll('ticket').length > 1) return false;
    if (request.rawHeaders?.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'authorization').length > 1) return false;
    const authorization = request.headers.authorization;
    const bearer = typeof authorization === 'string' ? /^Bearer ([^\s]+)$/i.exec(authorization)?.[1] : undefined;
    const ticket = url.searchParams.get('ticket');
    if ((ticket !== null && authorization !== undefined) || (authorization !== undefined && !bearer)) return false;
    const authorize = dependencies.authorizeUpgrade ?? createHttpIngressPolicy().authorizeUpgrade;
    if (!authorize(request, Boolean(bearer))) return false;
    const user = ticket !== null
      ? dependencies.consumeWebSocketTicket(ticket, url.pathname)
      : bearer ? dependencies.authenticateWebSocket(bearer) : null;
    if (!user) return false;
    request.user = Object.freeze({ ...user });
    if (!isWebSocketSessionActive(request, dependencies.isAuthSessionActive)) { delete request.user; return false; }
    // No capability survives into application logging, downstream URLs, or route handlers.
    request.url = url.pathname;
    return true;
  } catch {
    delete request.user;
    return false;
  }
}
