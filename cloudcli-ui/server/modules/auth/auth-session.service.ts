import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

import type { authSessionsDb, userDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/index.js';
import type { AuthSessionContext } from '@/shared/index.js';

type JwtAdapter = {
  sign(payload: Record<string, unknown>, secret: string, options: { algorithm: 'HS256' }): string;
  verify(token: string, secret: string, options: { algorithms: ['HS256']; clockTimestamp: number; ignoreExpiration: true }): unknown;
};
const require = createRequire(import.meta.url);
const jwt = require('jsonwebtoken') as JwtAdapter;
const lifetime = 7 * 86400;
const issuer = 'chisa-cloud-code';
const audience = 'chisa-ui';

type SessionDependencies = {
  sessions: typeof authSessionsDb;
  users: Pick<typeof userDb, 'getUserById'>;
  secret(): string;
  now?: () => number;
  legacyCutoff?: () => string | undefined;
};

function invalid(expired = false): never {
  throw new AppError(expired ? 'Session expired. Please log in again.' : 'Invalid token', {
    code: expired ? 'AUTH_TOKEN_EXPIRED' : 'AUTH_TOKEN_INVALID', statusCode: 401,
  });
}

/** Auth middleware and integration tests share one strict verifier for HTTP, WS, refresh, and persistent revocation. */
export function createAuthSessionService(dependencies: SessionDependencies) {
  const now = dependencies.now ?? (() => Math.floor(Date.now() / 1000));

  function legacyWindow() {
    const configured = dependencies.legacyCutoff?.();
    if (!configured || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(configured)) invalid();
    const window = dependencies.sessions.legacyWindow(now(), Math.floor(Date.parse(configured) / 1000));
    if (!window) invalid();
    return window;
  }

  function activeSession(id: string, userId: number, version: number): AuthSessionContext {
    const row = dependencies.sessions.getSession(id);
    const state = dependencies.sessions.getUserAuthState(userId);
    if (!row || row.userId !== userId || row.version !== version || row.revokedAt !== null
      || !state?.isActive || state.sessionVersion !== version) invalid();
    if (row.expiresAt <= now()) invalid(true);
    // Converted legacy tokens and existing WS connections retain the same bounded compatibility policy.
    if (id.startsWith('legacy-')) {
      const window = legacyWindow();
      if (version !== 0 || row.createdAt > window.enabledAt || row.expiresAt > window.cutoff) invalid();
    }
    return { id: row.id, userId: row.userId, version: row.version, createdAt: row.createdAt, expiresAt: row.expiresAt };
  }

  function sign(user: { id: number | bigint; username: string }, session: AuthSessionContext): string {
    const issuedAt = now();
    if (session.expiresAt <= issuedAt) invalid(true);
    return jwt.sign({ iss: issuer, aud: audience, sub: String(user.id), userId: Number(user.id), username: user.username,
      sid: session.id, sv: session.version, iat: issuedAt, exp: session.expiresAt }, dependencies.secret(), { algorithm: 'HS256' });
  }

  function verifyAuthToken(token: unknown) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 8192) invalid();
    const currentTime = now();
    let decoded: unknown;
    // Secret/storage failures are operational errors, not evidence that the caller's credentials are bad.
    const secret = dependencies.secret();
    try { decoded = jwt.verify(token, secret, { algorithms: ['HS256'], clockTimestamp: currentTime, ignoreExpiration: true }); }
    catch { invalid(); }
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) invalid();
    const claims = decoded as Record<string, unknown>;
    const { userId, username, iat, exp } = claims;
    if (typeof userId !== 'number' || !Number.isSafeInteger(userId) || userId <= 0 || typeof username !== 'string' || !username
      || typeof iat !== 'number' || !Number.isSafeInteger(iat) || iat <= 0 || iat > currentTime
      || typeof exp !== 'number' || !Number.isSafeInteger(exp) || exp <= iat || exp - iat > lifetime) invalid();
    if (exp <= currentTime) invalid(true);
    let session: AuthSessionContext;
    if (!Object.hasOwn(claims, 'sid')) {
      // Legacy is deliberately narrower than arbitrary JWTs missing a sid.
      if (Object.keys(claims).some(key => !['userId', 'username', 'iat', 'exp'].includes(key))) invalid();
      const window = legacyWindow();
      if (iat > window.enabledAt) invalid();
      const state = dependencies.sessions.getUserAuthState(userId);
      if (!state?.isActive || state.sessionVersion !== 0) invalid();
      const id = `legacy-${createHash('sha256').update(token).digest('hex')}`;
      const existing = dependencies.sessions.getSession(id);
      // Keep the original cutoff of an admitted token; a shorter current window is enforced below.
      if (!existing) dependencies.sessions.createSession({ id, userId, version: 0, createdAt: iat, expiresAt: Math.min(exp, window.cutoff) });
      session = activeSession(id, userId, 0);
      if (session.expiresAt > Math.min(exp, window.cutoff)) invalid();
    } else {
      if (claims.iss !== issuer || claims.aud !== audience || claims.sub !== String(userId)
        || typeof claims.sid !== 'string' || !/^(?:[a-f0-9-]{36}|legacy-[a-f0-9]{64})$/.test(claims.sid)
        || typeof claims.sv !== 'number' || !Number.isSafeInteger(claims.sv) || claims.sv < 0) invalid();
      session = activeSession(claims.sid, userId, claims.sv);
      if (exp !== session.expiresAt || iat < session.createdAt || session.expiresAt - session.createdAt > lifetime) invalid();
    }
    const user = dependencies.users.getUserById(userId);
    if (!user) invalid();
    return { user, session, issuedAt: iat };
  }

  return {
    verifyAuthToken,
    generateToken(user: { id: number | bigint; username: string; auth_version: number; password_hash: string }) {
      const userId = Number(user.id);
      const createdAt = now();
      const session = dependencies.sessions.createSession({ id: randomUUID(), userId, version: user.auth_version,
        createdAt, expiresAt: createdAt + lifetime, expectedPasswordHash: user.password_hash });
      if (!session || session.revokedAt !== null) invalid();
      return sign(user, activeSession(session.id, userId, session.version));
    },
    refreshToken(user: { id: number | bigint; username: string }, session: AuthSessionContext) {
      if (Number(user.id) !== session.userId) invalid();
      const current = activeSession(session.id, session.userId, session.version);
      if (current.createdAt !== session.createdAt || current.expiresAt !== session.expiresAt) invalid();
      return sign(user, current);
    },
    revokeSession(session: AuthSessionContext) {
      dependencies.sessions.revokeSession(session.id, session.userId, now());
    },
    requireActiveSession(id: string, userId: number, version: number) {
      return activeSession(id, userId, version);
    },
    isAuthSessionActive(id: unknown, userId: unknown, version: unknown): boolean {
      if (typeof id !== 'string' || typeof userId !== 'number' || !Number.isSafeInteger(userId)
        || typeof version !== 'number' || !Number.isSafeInteger(version)) return false;
      try { activeSession(id, userId, version); return true; } catch { return false; }
    },
  };
}
