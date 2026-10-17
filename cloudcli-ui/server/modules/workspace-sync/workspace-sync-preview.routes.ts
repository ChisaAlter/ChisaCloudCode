import express from 'express';

import { AppError } from '@/shared/index.js';

import { createWorkspaceSyncPreviewService } from './workspace-sync-preview.service.js';

/** The workspace-sync router mounts these account-bound preview operations behind authentication. */
export function createWorkspaceSyncPreviewRouter() {
  const router = express.Router();
  const service = createWorkspaceSyncPreviewService();
  router.post('/', async (request, response, next) => {
    const cancellation = new AbortController();
    const disconnected = () => { if (!response.writableFinished) cancellation.abort(); };
    request.once('aborted', disconnected);
    response.once('close', disconnected);
    if (request.aborted || response.destroyed) cancellation.abort();
    let undelivered: { userId: string; id: string } | undefined;
    try {
      const user = (request as express.Request & { user?: { id?: number | string } }).user;
      if (user?.id === undefined) throw new AppError('请先登录账号', { statusCode: 401 });
      const userId = String(user.id);
      const body = request.body as Record<string, unknown>;
      if (!body || typeof body.op !== 'string') throw new AppError('无效的预览操作', { statusCode: 400 });
      if (body.op === 'start') {
        const { serverPath, bindingEpoch, command, cwd, port } = body;
        if (typeof serverPath !== 'string' || typeof bindingEpoch !== 'string' || !bindingEpoch || typeof command !== 'string' || !command.trim() || command.length > 64_000 ||
          typeof cwd !== 'string' || !cwd.startsWith('/workspace') || (cwd !== '/workspace' && !cwd.startsWith('/workspace/')) ||
          pathEscapesWorkspace(cwd) || !Number.isInteger(port) || Number(port) < 1024 || Number(port) > 65535) {
          throw new AppError('无效的预览命令、目录或端口', { statusCode: 400 });
        }
        const result = await service.start(userId, serverPath, bindingEpoch, command, cwd, Number(port), cancellation.signal);
        undelivered = { userId, id: result.id };
        cancellation.signal.throwIfAborted();
        await new Promise<void>((resolve, reject) => {
          const delivered = () => { finish(); resolve(); };
          const aborted = () => { finish(); reject(cancellation.signal.reason); };
          const finish = () => {
            response.off('finish', delivered);
            cancellation.signal.removeEventListener('abort', aborted);
          };
          response.once('finish', delivered);
          cancellation.signal.addEventListener('abort', aborted, { once: true });
          try { response.json(result); }
          catch (error) { finish(); reject(error); }
        });
        undelivered = undefined;
      } else if (body.op === 'list') {
        response.json(await service.list(userId));
      } else {
        if (typeof body.id !== 'string') throw new AppError('无效的预览标识', { statusCode: 400 });
        switch (body.op) {
          case 'inspect': response.json(await service.inspect(userId, body.id)); break;
          case 'logs': response.json(await service.logs(userId, body.id)); break;
          case 'remove': response.json(await service.remove(userId, body.id)); break;
          default: throw new AppError('无效的预览操作', { statusCode: 400 });
        }
      }
    } catch (error) {
      if (undelivered) {
        try { await service.discard(undelivered.userId, undelivered.id); }
        catch (cleanupError) {
          return next(Object.assign(new AppError('预览响应中断，且容器清理未确认', { code: 'PREVIEW_CLEANUP_FAILED', statusCode: 503 }), { cause: error, cleanupError }));
        }
      }
      next(error);
    } finally {
      request.off('aborted', disconnected);
      response.off('close', disconnected);
    }
  });
  return router;
}

function pathEscapesWorkspace(cwd: string) {
  return cwd.includes('\0') || cwd.split('/').includes('..');
}
