import express from 'express';
import type { RequestHandler, Response } from 'express';

import { AppError } from '@/shared/index.js';
import type { AuthenticatedHttpRequest } from '@/shared/index.js';

import type { createAuthService } from './auth.service.js';

function authFailure(error: unknown, res: Response): unknown {
  if (error instanceof AppError) {
    const details = error.details as { retryAfterSeconds?: unknown } | undefined;
    if (typeof details?.retryAfterSeconds === 'number') res.setHeader('Retry-After', String(details.retryAfterSeconds));
    if (error.code === 'AUTH_TOKEN_INVALID' || error.code === 'AUTH_TOKEN_EXPIRED') {
      res.setHeader('X-Auth-Error', error.code === 'AUTH_TOKEN_EXPIRED' ? 'session-expired' : 'invalid-token');
    }
    return error;
  }
  res.setHeader('Retry-After', '1');
  return new AppError('Authentication is temporarily unavailable', { code: 'AUTH_UNAVAILABLE', statusCode: 503 });
}

/** Auth composition uses this adapter for HTTP parsing, response headers and service delegation. */
export function createAuthRouter(service: ReturnType<typeof createAuthService>, authenticateToken: RequestHandler): express.Router {
  const router = express.Router();
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.get('/status', (_req, res) => res.json(service.getStatus()));

  router.post('/login', async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as { username?: unknown; password?: unknown };
      res.json(await service.login(body.username, body.password, req.socket.remoteAddress ?? 'unknown'));
    } catch (error) { next(authFailure(error, res)); }
  });

  router.get('/user', authenticateToken, (req, res) => {
    res.json(service.getCurrentUser((req as AuthenticatedHttpRequest).user));
  });

  router.patch('/profile', authenticateToken, (req, res, next) => {
    try {
      const body = (req.body ?? {}) as { displayName?: unknown; avatarDataUrl?: unknown };
      res.json(service.updateProfile((req as AuthenticatedHttpRequest).user, body.displayName, body.avatarDataUrl));
    } catch (error) { next(authFailure(error, res)); }
  });

  router.post('/refresh', authenticateToken, (req, res, next) => {
    try {
      const request = req as AuthenticatedHttpRequest;
      res.json(service.refreshSession(request.user, request.authSession));
    } catch (error) { next(authFailure(error, res)); }
  });

  router.post('/ws-ticket', authenticateToken, (req, res, next) => {
    try {
      const request = req as AuthenticatedHttpRequest;
      if (!/^Bearer [^\s]+$/i.test(req.headers.authorization ?? '') || !request.authSession) {
        throw new AppError('Invalid token', { code: 'AUTH_TOKEN_INVALID', statusCode: 401 });
      }
      const body = (req.body ?? {}) as { path?: unknown };
      res.json(service.issueWebSocketTicket(request.authSession, body.path));
    } catch (error) { next(authFailure(error, res)); }
  });

  router.post('/logout', authenticateToken, (req, res, next) => {
    try {
      res.json(service.logout((req as AuthenticatedHttpRequest).authSession));
    } catch (error) { next(authFailure(error, res)); }
  });
  return router;
}
