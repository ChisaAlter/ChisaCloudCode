import express from 'express';

import { AppError } from '@/shared/index.js';
import { executeSyncTransportWorker } from '@/modules/workspace-bridge/index.js';

/** The authenticated workspace-sync router exposes the existing sandbox worker to managed desktop connections. */
export function createWorkspaceSyncWorkerRouter() {
  const router = express.Router();
  router.post('/', async (request, response, next) => {
    const cancellation = new AbortController();
    const disconnected = () => { if (!response.writableFinished) cancellation.abort(); };
    request.once('aborted', disconnected);
    response.once('close', disconnected);
    if (request.aborted || response.destroyed) cancellation.abort();
    try {
      const body = request.body as Record<string, unknown>;
      if (!body || typeof body.serverPath !== 'string' || typeof body.bindingEpoch !== 'string' ||
        !body.request || typeof body.request !== 'object' || Array.isArray(body.request)) {
        throw new AppError('无效的工作区请求', { statusCode: 400 });
      }
      response.json(await executeSyncTransportWorker(body.serverPath, body.bindingEpoch, body.request as Record<string, unknown>, cancellation.signal));
    } catch (error) { next(error); }
    finally {
      request.off('aborted', disconnected);
      response.off('close', disconnected);
    }
  });
  return router;
}
