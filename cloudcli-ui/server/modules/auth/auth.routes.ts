import express from 'express';
import type { RequestHandler } from 'express';

import type { createAuthService } from './auth.service.js';

type AuthenticatedRequest = express.Request & { user?: unknown };

/**
 * Used by auth.module to create the transport adapter. Handlers only parse
 * request data and delegate behavior to the injected application service.
 */
export function createAuthRouter(
  service: ReturnType<typeof createAuthService>,
  authenticateToken: RequestHandler,
): express.Router {
  const router = express.Router();

  router.get('/status', (_req, res, next) => {
    try {
      res.json(service.getStatus());
    } catch (error) {
      next(error);
    }
  });

  router.post('/login', async (req, res, next) => {
    try {
      const body = req.body as { username?: unknown; password?: unknown };
      res.json(await service.login(body.username, body.password));
    } catch (error) {
      next(error);
    }
  });

  router.get('/user', authenticateToken, (req, res) => {
    res.json(service.getCurrentUser((req as AuthenticatedRequest).user));
  });

  router.patch('/profile', authenticateToken, (req, res, next) => {
    try {
      const body = req.body as { displayName?: unknown; avatarDataUrl?: unknown };
      res.json(service.updateProfile((req as AuthenticatedRequest).user, body.displayName, body.avatarDataUrl));
    } catch (error) {
      next(error);
    }
  });

  router.post('/refresh', authenticateToken, (req, res) => {
    res.json(service.refreshSession((req as AuthenticatedRequest).user));
  });

  router.post('/logout', authenticateToken, (_req, res) => {
    res.json(service.logout());
  });

  return router;
}
