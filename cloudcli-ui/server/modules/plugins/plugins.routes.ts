import fs from 'node:fs';
import http from 'node:http';

import express from 'express';

import { resolveClaudeUsagePluginScope } from '@/modules/providers/index.js';

import type { createPluginsService } from './plugins.service.js';

function wildcardPath(req: express.Request): string {
  return ((req.params as Record<string, string>)['0'] ?? '').trim();
}

function routeParameter(value: string | string[]): string {
  return Array.isArray(value) ? value[0] ?? '' : value;
}

/** Creates plugin routes; transport streaming remains here while decisions live in the service. */
export function createPluginsRouter(service: ReturnType<typeof createPluginsService>, resolveUsageScope = resolveClaudeUsagePluginScope): express.Router {
  const router = express.Router();
  const respond = (operation: (req: express.Request) => unknown | Promise<unknown>) =>
    async (req: express.Request, res: express.Response, next: express.NextFunction) => {
      try { res.json(await operation(req)); } catch (error) { next(error); }
    };

  router.get('/', respond(() => service.list()));
  router.get('/:name/manifest', respond((req) => service.getManifest(routeParameter(req.params.name))));
  router.get('/:name/assets/*', async (req, res, next) => {
    try {
      const asset = service.resolveAsset(routeParameter(req.params.name), wildcardPath(req));
      res.setHeader('Content-Type', asset.contentType);
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      const stream = fs.createReadStream(asset.path);
      stream.on('error', next);
      stream.pipe(res);
    } catch (error) { next(error); }
  });
  router.put('/:name/enable', respond((req) => service.setEnabled(routeParameter(req.params.name), req.body?.enabled)));
  router.post('/install', respond((req) => service.install(req.body?.url)));
  router.post('/:name/update', respond((req) => service.update(routeParameter(req.params.name))));
  router.all('/:name/rpc/*', async (req, res, next) => {
    let scope: Awaited<ReturnType<typeof resolveUsageScope>> | null = null;
    let proxyRequest: http.ClientRequest | null = null;
    let proxyResponse: http.IncomingMessage | null = null;
    let released = false;
    let disconnected = false;
    const releaseScope = () => { if (released) return; released = true; scope?.release(); };
    const disconnect = () => {
      disconnected = true;
      proxyResponse?.destroy();
      proxyRequest?.destroy();
      releaseScope();
    };
    // Observe disconnects before either async preparation; close may precede the eventual lease acquisition.
    res.once('close', disconnect);
    res.once('finish', releaseScope);
    req.once('aborted', disconnect);
    try {
      const name = routeParameter(req.params.name);
      const { port, secrets } = await service.prepareRpc(name);
      if (disconnected || res.destroyed) return;
      scope = name === 'claude-usage' ? await resolveUsageScope((req as express.Request & { user?: { id?: string | number; userId?: string | number } }).user?.id
        ?? (req as express.Request & { user?: { userId?: string | number } }).user?.userId) : null;
      if (disconnected || res.destroyed) { scope?.release(); return; }
      const headers: Record<string, string> = { 'content-type': String(req.headers['content-type'] ?? 'application/json') };
      for (const [key, value] of Object.entries(secrets)) headers[`x-plugin-secret-${key.toLowerCase()}`] = String(value);
      if (scope) {
        // These private headers are derived from JWT ownership, never caller-provided paths.
        headers['x-chisa-claude-config-dir'] = Buffer.from(scope.configDir).toString('base64');
        headers['x-chisa-claude-auth-dir'] = Buffer.from(scope.authDir).toString('base64');
      }
      const query = req.url.includes('?') ? `?${req.url.split('?').slice(1).join('?')}` : '';
      proxyRequest = http.request({ hostname: '127.0.0.1', port, path: `/${wildcardPath(req)}${query}`, method: req.method, headers }, (response) => {
        proxyResponse = response;
        if (disconnected || res.destroyed) { response.destroy(); releaseScope(); return; }
        response.once('error', (error) => {
          releaseScope();
          if (!res.destroyed) res.destroy(error);
        });
        response.once('aborted', () => { releaseScope(); if (!res.destroyed) res.destroy(); });
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
      });
      proxyRequest.once('error', (error) => {
        releaseScope();
        if (disconnected || res.destroyed) return;
        if (res.headersSent) res.destroy(error); else next(error);
      });
      if (name === 'claude-usage') proxyRequest.setTimeout(30_000, () => proxyRequest?.destroy(new Error('Plugin request timed out.')));
      if (req.headers['content-length'] && req.body !== undefined) {
        const body = JSON.stringify(req.body);
        proxyRequest.setHeader('content-length', Buffer.byteLength(body));
        proxyRequest.write(body);
      }
      proxyRequest.end();
    } catch (error) { releaseScope(); if (!disconnected && !res.destroyed) next(error); }
  });
  router.delete('/:name', respond((req) => service.uninstall(routeParameter(req.params.name))));
  return router;
}
