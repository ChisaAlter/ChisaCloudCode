import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import express from 'express';

import { proxyWorkspaceRuntimePreview, proxyWorkspaceRuntimePreviewUpgrade } from './workspace-runtime-preview-proxy.service.js';

/** Server bootstrap mounts this capability-authenticated router at /api/workspace-runtime before JSON parsing. */
export function createWorkspaceRuntimePreviewRouter() {
  const router = express.Router();
  router.use('/preview/:token', async (request, response, next) => {
    try {
      const token = request.params.token;
      if (!/^[a-f0-9]{64}$/.test(token)) { response.sendStatus(404); return; }
      const origin = new URL(request.protocol + '://' + request.get('host')).origin;
      if (request.originalUrl === '/api/workspace-runtime/preview/' + token) {
        response.setHeader('Referrer-Policy', 'no-referrer');
        response.redirect(307, request.originalUrl + '/'); return;
      }
      await proxyWorkspaceRuntimePreview(request, response, token, origin);
    } catch (error) { if (response.headersSent) response.destroy(); else next(error); }
  });
  return router;
}

/** Bootstrap calls this before other upgrade handlers; true means this runtime route owns the socket. */
export function handleWorkspaceRuntimePreviewUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
  if (!request.url?.startsWith('/api/workspace-runtime/preview/')) return false;
  const token = /^\/api\/workspace-runtime\/preview\/([a-f0-9]{64})\//.exec(request.url)?.[1];
  if (!token) { socket.destroy(); return true; }
  void proxyWorkspaceRuntimePreviewUpgrade(request, socket, head, token).catch(() => socket.destroy());
  return true;
}
