import http from 'node:http';

import { CodexAppServerClient } from './codex-client.js';
import { normalizeActivity, normalizeRateLimits } from './usage.js';

export type UsageClient = {
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  close(): void;
};

/** Create the plugin HTTP server; exported so routing can be tested independently. */
export function createUsageServer(client: UsageClient = new CodexAppServerClient()): http.Server {
  return http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/rate-limits') {
        const result = await client.request('account/rateLimits/read');
        response.end(JSON.stringify(normalizeRateLimits(result)));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/activity') {
        const requestedDays = Number(url.searchParams.get('days')) || 30;
        const days = Math.min(Math.max(Math.trunc(requestedDays), 1), 365);
        const result = await client.request('account/usage/read');
        response.end(JSON.stringify(normalizeActivity(result, days, Date.now())));
        return;
      }
      response.writeHead(404);
      response.end(JSON.stringify({ error: 'Not found' }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Codex usage is unavailable.';
      response.writeHead(502);
      response.end(JSON.stringify({ error: message }));
    }
  }).on('close', () => client.close());
}
