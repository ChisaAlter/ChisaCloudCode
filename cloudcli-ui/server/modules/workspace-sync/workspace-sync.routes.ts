import express from 'express';

import { AppError } from '@/shared/index.js';

import { createWorkspaceSyncPreviewRouter } from './workspace-sync-preview.routes.js';
import { createWorkspaceSyncWorkerRouter } from './workspace-sync-worker.routes.js';
import { checkWorkspaceSyncLeaseRecovery } from './workspace-sync-recovery.service.js';
import { createWorkspaceSyncService } from './workspace-sync.service.js';

/** The server entrypoint mounts device enrollment and managed workspace operations after JWT authentication. */
export function createWorkspaceSyncRouter(service = createWorkspaceSyncService()) {
  const router = express.Router();
  router.use(async (request, _response, next) => {
    // Platform authentication bypasses JWTs; it cannot grant machine-level synchronization credentials.
    if (process.env.VITE_IS_PLATFORM === 'true' || !/^Bearer \S+$/i.test(request.get('authorization') ?? '')) {
      return next(new AppError('请先登录账号', { code: 'AUTH_TOKEN_INVALID', statusCode: 401 }));
    }
    try {
      const user = (request as express.Request & { user?: { id?: number | string | bigint } }).user;
      if (user?.id === undefined) throw new AppError('请先登录账号', { statusCode: 401 });
      // Existing reservations and previews must remain recoverable before an
      // idle transport can move to its isolated account network.
      const previewDrain = request.path === '/preview' && ['list', 'inspect', 'logs', 'remove'].includes(String(request.body?.op));
      if (request.path !== '/enroll' && request.path !== '/lease-recovery' && !previewDrain) {
        await service.restore(String(user.id));
      }
      next();
    } catch (error) { next(error); }
  });
  router.post('/enroll', async (request, response, next) => {
    try {
      const user = (request as express.Request & { user?: { id?: number | string | bigint } }).user;
      if (user?.id === undefined) throw new AppError('请先登录账号', { statusCode: 401 });
      const publicKey = (request.body as { publicKey?: unknown } | null)?.publicKey;
      if (typeof publicKey !== 'string' || publicKey.length > 1024 || publicKey.includes('\n') || publicKey.includes('\r')) {
        throw new AppError('同步设备公钥无效', { code: 'WORKSPACE_SYNC_KEY_INVALID', statusCode: 400 });
      }
      const serverUrl = request.protocol + '://' + request.get('host');
      response.json(await service.enroll(String(user.id), publicKey, serverUrl));
    } catch (error) { next(error); }
  });
  router.use('/worker', createWorkspaceSyncWorkerRouter());
  router.use('/preview', createWorkspaceSyncPreviewRouter());
  router.post('/lease-recovery', async (request, response, next) => {
    try {
      const body = request.body as { serverPath?: unknown; bindingEpoch?: unknown } | null;
      if (!body || typeof body.serverPath !== 'string' || typeof body.bindingEpoch !== 'string' || !body.bindingEpoch) {
        throw new AppError('工作区恢复请求无效', { statusCode: 400 });
      }
      response.json(await checkWorkspaceSyncLeaseRecovery(body.serverPath, body.bindingEpoch));
    } catch (error) { next(error); }
  });
  return router;
}
