import express from 'express';
import multer from 'multer';

import { AssetError, createImageAssetService, imageAssetService } from './services/image-assets.service.js';

/** Injectable storage keeps route security tests isolated from the user's real upload directory. */
export function createAssetsRouter(service: ReturnType<typeof createImageAssetService> = imageAssetService) {
  const router = express.Router();
  // Busboy emits partsLimit when the boundary ending that many parts arrives.
  // Leave one boundary of headroom; the separate file/field limits enforce actual counts.
  const imagesUpload = multer({ storage: service.uploadStorage,
    limits: { fileSize: 5 * 1024 * 1024, files: 5, fields: 0, parts: 6 } }).array('images', 5);
  const filesUpload = multer({ storage: service.uploadStorage,
    limits: { fileSize: 10 * 1024 * 1024, files: 10, fields: 0, parts: 11 } }).array('files', 10);

  function owner(request: express.Request) {
    const userId = (request as express.Request & { user?: { id?: unknown } }).user?.id;
    return typeof userId === 'string' && /^[0-9]+$/.test(userId) ? Number(userId) : userId;
  }

  function respondError(response: express.Response, error: unknown) {
    if (response.destroyed || response.headersSent) return;
    if (error instanceof AssetError) { response.status(error.statusCode).json({ error: error.message }); return; }
    if (error instanceof multer.MulterError) {
      response.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: error.message });
      return;
    }
    console.error('[Assets] Storage operation failed:', error instanceof Error ? error.message : 'Unknown error');
    response.status(500).json({ error: 'Unable to process attachment' });
  }

  // The parent mount authenticates JWTs. This local guard keeps every router operation fail-closed.
  router.use((request, response, next) => {
    const userId = owner(request);
    if (typeof userId !== 'number' || !Number.isSafeInteger(userId) || userId <= 0) {
      response.status(401).json({ error: 'Authentication is required' });
      return;
    }
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });

  for (const mode of ['images', 'files'] as const) {
    const upload = mode === 'images' ? imagesUpload : filesUpload;
    router.post(`/${mode}`, (request, response) => {
      upload(request, response, error => {
        if (error) { respondError(response, error); return; }
        const files = (request.files as Express.Multer.File[] | undefined) ?? [];
        const controller = new AbortController();
        const abort = () => controller.abort();
        request.once('aborted', abort);
        response.once('close', abort);
        if (request.aborted || response.destroyed) controller.abort();
        void service.saveUploads(files, owner(request), mode, controller.signal)
          .then(records => { if (!response.destroyed) response.json({ [mode]: records }); })
          .catch(failure => respondError(response, failure))
          .finally(() => { request.removeListener('aborted', abort); response.removeListener('close', abort); });
      });
    });
    router.get(`/${mode}/:filename`, (request, response) => {
      void service.openStoredAsset(request.params.filename, owner(request), mode).then(asset => {
        response.setHeader('Content-Type', asset.contentType);
        response.setHeader('Content-Disposition', asset.contentDisposition);
        response.setHeader('Content-Length', String(asset.size));
        response.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
        response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        asset.stream.on('error', error => {
          if (response.headersSent) response.destroy(error); else respondError(response, error);
        });
        response.once('close', () => asset.stream.destroy());
        asset.stream.pipe(response);
      }).catch(error => respondError(response, error));
    });
  }
  return router;
}

export default createAssetsRouter();
