import express from 'express';

import { AppError } from '@/shared/index.js';
import type { UserPreferenceTransaction } from '@/shared/index.js';

import type { createUserService } from './user.service.js';

type AuthenticatedRequest = express.Request & { user?: { id?: number | string } };

function readUserId(request: express.Request): number {
  const rawUserId = (request as AuthenticatedRequest).user?.id;
  return Number(rawUserId);
}

/** Transport-only parsing; the repository independently checks persistence and CAS invariants. */
function readPreferenceTransaction(body: unknown): UserPreferenceTransaction {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError('A preference transaction object is required', {
      code: 'INVALID_PREFERENCE_TRANSACTION', statusCode: 400,
    });
  }
  const fields = Object.keys(body);
  const payload = body as Record<string, unknown>;
  if (fields.length !== 3 || fields.some((key) => (
    key !== 'operationId' && key !== 'updates' && key !== 'expectedRevisions'
  ))) {
    throw new AppError('Only operationId, updates and expectedRevisions are accepted', {
      code: 'INVALID_PREFERENCE_TRANSACTION', statusCode: 400,
    });
  }
  if (typeof payload.operationId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.operationId)) {
    throw new AppError('A UUIDv7 preference operation ID is required', {
      code: 'INVALID_PREFERENCE_OPERATION_ID', statusCode: 400,
    });
  }
  if (!payload.updates || typeof payload.updates !== 'object' || Array.isArray(payload.updates)) {
    throw new AppError('Preferences must be sent as an object', {
      code: 'INVALID_PREFERENCES', statusCode: 400,
    });
  }
  if (!payload.expectedRevisions || typeof payload.expectedRevisions !== 'object'
    || Array.isArray(payload.expectedRevisions)) {
    throw new AppError('Expected revisions must be an object', {
      code: 'INVALID_PREFERENCE_REVISIONS', statusCode: 400,
    });
  }
  const updates = payload.updates as Record<string, unknown>;
  const revisions = payload.expectedRevisions as Record<string, unknown>;
  const keys = Object.keys(updates);
  if (keys.length === 0 || keys.length > 128) {
    throw new AppError('A preference transaction must contain 1-128 fields', {
      code: 'INVALID_PREFERENCE_TRANSACTION', statusCode: 400,
    });
  }
  if (keys.some((key) => !key || key.length > 200)) {
    throw new AppError('Preference keys must be 1-200 characters', {
      code: 'INVALID_PREFERENCE_KEY', statusCode: 400,
    });
  }
  if (Object.keys(revisions).length !== keys.length || keys.some((key) => (
    !Object.hasOwn(revisions, key) || !Number.isSafeInteger(revisions[key]) || (revisions[key] as number) < 0
  ))) {
    throw new AppError('Expected revisions must match all updated fields and be nonnegative safe integers', {
      code: 'INVALID_PREFERENCE_REVISIONS', statusCode: 400,
    });
  }
  return {
    operationId: payload.operationId.toLowerCase(), updates,
    expectedRevisions: revisions as Record<string, number>,
  };
}

/** The User module mounts these thin routes to parse authenticated input and call its service. */
export function createUserRouter(service: ReturnType<typeof createUserService>): express.Router {
  const router = express.Router();

  router.get('/git-config', async (req, res, next) => {
    try {
      res.json(await service.getGitConfig(readUserId(req)));
    } catch (error) {
      next(error);
    }
  });

  router.post('/git-config', async (req, res, next) => {
    try {
      const body = req.body as { gitName?: unknown; gitEmail?: unknown };
      res.json(await service.updateGitConfig(readUserId(req), body.gitName, body.gitEmail));
    } catch (error) {
      next(error);
    }
  });

  router.post('/complete-onboarding', (req, res, next) => {
    try {
      res.json(service.completeOnboarding(readUserId(req)));
    } catch (error) {
      next(error);
    }
  });

  router.get('/onboarding-status', (req, res, next) => {
    try {
      res.json(service.getOnboardingStatus(readUserId(req)));
    } catch (error) {
      next(error);
    }
  });

  router.get('/preferences', (req, res, next) => {
    try {
      res.json(service.getPreferences(readUserId(req)));
    } catch (error) {
      next(error);
    }
  });

  // A delayed unversioned client must never overwrite a newer successful CAS transaction.
  router.patch('/preferences', (_req, res) => {
    res.status(410).json({
      success: false,
      code: 'PREFERENCE_TRANSACTION_REQUIRED',
      message: 'Upgrade the client. GET /api/user/preferences for current values and revisions, then PATCH /api/user/preferences/transactions with a UUIDv7 operationId, updates and matching expectedRevisions.',
    });
  });

  router.patch('/preferences/transactions', (req, res, next) => {
    try {
      const transaction = readPreferenceTransaction(req.body);
      const result = service.savePreferenceTransaction(readUserId(req), transaction);
      const status = result.success ? 200 : result.code === 'PREFERENCE_OPERATION_CAPACITY' ? 429 : 409;
      res.status(status).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get('/drafts', (req, res, next) => {
    try {
      res.json(service.getDrafts(readUserId(req)));
    } catch (error) {
      next(error);
    }
  });

  // The scope is a session id or `project:<id>`, so it is read from the body
  // rather than the path: neither form is guaranteed to be URL-path-safe.
  router.put('/drafts', (req, res, next) => {
    try {
      const body = req.body as { scope?: unknown };
      res.json(service.saveDraft(readUserId(req), body?.scope, req.body));
    } catch (error) {
      next(error);
    }
  });

  router.delete('/drafts', (req, res, next) => {
    try {
      const body = req.body as { scope?: unknown };
      res.json(service.deleteDraft(readUserId(req), body?.scope));
    } catch (error) {
      next(error);
    }
  });

  // Queueing appends to the scope's queued message on the server, so the merge
  // is made against what is stored rather than against a page's possibly stale
  // copy of it.
  router.post('/drafts/queued-message', (req, res, next) => {
    try {
      const body = req.body as { scope?: unknown; queuedMessage?: unknown };
      res.json(service.appendQueuedMessage(readUserId(req), body?.scope, body?.queuedMessage));
    } catch (error) {
      next(error);
    }
  });

  router.delete('/drafts/queued-message', (req, res, next) => {
    try {
      const body = req.body as { scope?: unknown };
      res.json(service.clearQueuedMessage(readUserId(req), body?.scope));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
