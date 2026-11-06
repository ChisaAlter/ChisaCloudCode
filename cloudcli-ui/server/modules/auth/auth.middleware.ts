import type { RequestHandler } from 'express';

import { userDb, appConfigDb, authSessionsDb } from '@/modules/database/index.js';
import { AppError, IS_PLATFORM } from '@/shared/index.js';
import type { AuthenticatedHttpRequest } from '@/shared/index.js';

import { createAuthSessionService } from './auth-session.service.js';

// Resolve lazily so import-time bootstrap does not open or mutate account data.
const sessions = createAuthSessionService({
  sessions: authSessionsDb, users: userDb,
  secret: () => process.env.JWT_SECRET || appConfigDb.getOrCreateJwtSecret(),
  legacyCutoff: () => process.env.CHISA_LEGACY_TOKEN_ACCEPT_UNTIL,
});

/** Optional API-wide key middleware, composed by the server entrypoint. */
export const validateApiKey: RequestHandler = (req, res, next) => {
  if (!process.env.API_KEY) return next();
  if (req.headers['x-api-key'] !== process.env.API_KEY) {
    res.status(401).json({ error: 'Invalid API key' });
    return;
  }
  next();
};

/** Auth service creates a fresh persistent login only after bcrypt verification. */
export const generateToken = sessions.generateToken;
/** Auth service and middleware refresh the same absolute-lifetime session. */
export const refreshToken = sessions.refreshToken;
/** Auth service persists logout before returning success. */
export const revokeSession = sessions.revokeSession;
/** HTTP and WS share this verifier; consumers never decode unverified identities. */
export const verifyAuthToken = sessions.verifyAuthToken;
/** Ticket issuance uses throwing checks so database outages become HTTP 503 without a credential-invalid signal. */
export const requireActiveAuthSession = sessions.requireActiveSession;
/** Existing WS transports recheck the database before messages and during their periodic sweep. */
export const isAuthSessionActive = sessions.isAuthSessionActive;

/** Validates token identity, DB ownership/version/revocation and absolute expiry before protected HTTP routes. */
export const authenticateToken: RequestHandler = (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (IS_PLATFORM && req.headers.authorization === undefined) {
    try {
      const user = userDb.getFirstUser();
      if (!user) { res.status(503).json({ error: 'Platform account is unavailable', code: 'AUTH_UNAVAILABLE' }); return; }
      (req as AuthenticatedHttpRequest).user = user;
    } catch {
      res.setHeader('Retry-After', '1');
      res.status(503).json({ error: 'Authentication is temporarily unavailable', code: 'AUTH_UNAVAILABLE' });
      return;
    }
    next();
    return;
  }
  const authorization = req.headers.authorization;
  // URL credentials leak to histories and logs; protected HTTP accepts only an explicit Bearer header.
  const token = typeof authorization === 'string' ? /^Bearer ([^\s]+)$/i.exec(authorization)?.[1] : undefined;
  try {
    const verified = verifyAuthToken(token);
    (req as AuthenticatedHttpRequest).user = verified.user;
    (req as AuthenticatedHttpRequest).authSession = verified.session;
    const now = Math.floor(Date.now() / 1000);
    if (now > verified.issuedAt + (verified.session.expiresAt - verified.issuedAt) / 2) {
      res.setHeader('X-Refreshed-Token', refreshToken(verified.user, verified.session));
    }
  } catch (error) {
    if (error instanceof AppError && error.statusCode === 401) {
      const expired = error.code === 'AUTH_TOKEN_EXPIRED';
      res.setHeader('X-Auth-Error', expired ? 'session-expired' : 'invalid-token');
      res.status(401).json({ error: error.message, code: error.code });
    } else {
      // An unavailable DB must not tell native/web clients to destroy a valid credential.
      res.setHeader('Retry-After', '1');
      res.status(503).json({ error: 'Authentication is temporarily unavailable', code: 'AUTH_UNAVAILABLE' });
    }
    return;
  }
  next();
};

/** WebSocket upgrade uses the same claims and persistence checks as HTTP; null preserves the existing rejection contract. */
export function authenticateWebSocket(token: unknown) {
  try {
    const { user, session } = verifyAuthToken(token);
    return { id: user.id, userId: user.id, username: user.username,
      sessionId: session.id, sessionVersion: session.version, sessionExpiresAt: session.expiresAt };
  } catch { return null; }
}
