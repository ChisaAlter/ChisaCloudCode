import { randomBytes } from 'node:crypto';

import { AppError } from '@/shared/index.js';
import type { AuthSessionContext, AuthenticatedWebSocketUser } from '@/shared/index.js';

type TicketDependencies = {
  isSessionActive(id: string, userId: number, version: number): boolean;
  getUser(userId: number): { id: number; username: string } | undefined;
  now?: () => number;
  capacity?: number;
  sessionCapacity?: number;
};
type PendingTicket = { path: string; session: AuthSessionContext; expiresAt: number };
const allowedPath = (path: unknown): path is string => typeof path === 'string' && path.length <= 256
  && path === path.trim() && /^\/(?:ws|shell|desktop-notifications|plugin-ws\/[A-Za-z0-9_-]+)$/.test(path);
function invalid(): never {
  throw new AppError('Invalid token', { code: 'AUTH_TOKEN_INVALID', statusCode: 401 });
}

/** Auth composition exchanges Bearer-authenticated HTTP sessions for bounded, path-bound, one-use WS credentials. */
export function createWebSocketTicketService(dependencies: TicketDependencies) {
  const now = dependencies.now ?? (() => Math.floor(Date.now() / 1000));
  const capacity = dependencies.capacity ?? 4096;
  const sessionCapacity = dependencies.sessionCapacity ?? 8;
  if (![capacity, sessionCapacity].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new Error('Invalid WebSocket ticket capacity');
  }
  const pending = new Map<string, PendingTicket>();
  function prune(instant: number) {
    for (const [ticket, stored] of pending) if (stored.expiresAt <= instant) pending.delete(ticket);
  }

  return {
    issue(session: AuthSessionContext | undefined, path: unknown) {
      if (!session || !dependencies.isSessionActive(session.id, session.userId, session.version)) invalid();
      if (!allowedPath(path)) throw new AppError('Invalid WebSocket path', { code: 'AUTH_WS_PATH_INVALID', statusCode: 400 });
      const instant = now(); prune(instant);
      const expiresAt = Math.min(instant + 30, session.expiresAt);
      if (expiresAt <= instant) invalid();
      let perSession = 0;
      for (const stored of pending.values()) if (stored.session.id === session.id) perSession += 1;
      if (pending.size >= capacity || perSession >= sessionCapacity) {
        throw new AppError('WebSocket authentication is busy. Try again shortly.', {
          code: 'AUTH_WS_TICKETS_BUSY', statusCode: 503, details: { retryAfterSeconds: 1 },
        });
      }
      const ticket = randomBytes(32).toString('base64url');
      pending.set(ticket, { path, session: { ...session }, expiresAt });
      return { ticket, expiresAt };
    },

    consume(ticket: unknown, path: string): AuthenticatedWebSocketUser | null {
      if (typeof ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(ticket)) return null;
      const stored = pending.get(ticket);
      // Claim exactly once before any policy/DB checks, including a mismatched-path or failed attempt.
      pending.delete(ticket);
      const instant = now(); prune(instant);
      if (!stored || !allowedPath(path) || stored.path !== path || stored.expiresAt <= instant) return null;
      const { session } = stored;
      try {
        if (!dependencies.isSessionActive(session.id, session.userId, session.version) || session.expiresAt <= instant) return null;
        const user = dependencies.getUser(session.userId);
        if (!user || user.id !== session.userId) return null;
        return { id: user.id, userId: user.id, username: user.username,
          sessionId: session.id, sessionVersion: session.version, sessionExpiresAt: session.expiresAt };
      } catch { return null; }
    },
  };
}
