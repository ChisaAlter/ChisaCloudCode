import { request as httpRequest } from 'node:http';
import { createServer } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

type GatewayInstance = { port: number; workspaceServerUrl: string };
type GatewayConfiguration = {
  key: string | Buffer;
  cert: string | Buffer;
  instances: Record<string, GatewayInstance>;
  accounts: Record<string, string>;
  defaultInstance: string;
};

function sendError(response: ServerResponse, status: number, message: string) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ error: { message } }));
}

/** The standalone gateway entrypoint exposes isolated instances through one encrypted desktop service. */
export function createDesktopGateway(configuration: GatewayConfiguration) {
  if (!Object.hasOwn(configuration.instances, configuration.defaultInstance)) throw new Error('Default instance is missing');
  for (const [id, instance] of Object.entries(configuration.instances)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || !Number.isInteger(instance.port) || instance.port < 1 || instance.port > 65535) {
      throw new Error('Invalid gateway instance');
    }
  }
  for (const instance of Object.values(configuration.accounts)) {
    if (!Object.hasOwn(configuration.instances, instance)) throw new Error('Account instance is missing');
  }

  function resolveRoute(rawUrl: string) {
    let url: URL;
    try { url = new URL(rawUrl, 'https://gateway.invalid'); }
    catch { return null; }
    const match = /^\/instances\/([a-zA-Z0-9_-]+)(\/.*)$/.exec(url.pathname);
    const id = match?.[1] ?? configuration.defaultInstance;
    const pathname = match?.[2] ?? url.pathname;
    const instance = Object.hasOwn(configuration.instances, id) ? configuration.instances[id] : undefined;
    if (!instance || !(pathname.startsWith('/api/') || ['/ws', '/shell', '/desktop-notifications'].includes(pathname) || pathname.startsWith('/plugin-ws/'))) return null;
    return { id, instance, path: pathname + url.search };
  }

  async function login(request: IncomingMessage, response: ServerResponse) {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > 16_384) { sendError(response, 413, 'Login request is too large'); return; }
      chunks.push(bytes);
    }
    let credentials: { username?: unknown; password?: unknown };
    try { credentials = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { sendError(response, 400, 'Invalid login request'); return; }
    if (!credentials || typeof credentials.username !== 'string' || typeof credentials.password !== 'string') {
      sendError(response, 400, 'Username and password are required'); return;
    }
    const id = Object.hasOwn(configuration.accounts, credentials.username)
      ? configuration.accounts[credentials.username] : configuration.defaultInstance;
    const instance = configuration.instances[id];
    const body = Buffer.from(JSON.stringify(credentials));
    const upstream = httpRequest({ hostname: '127.0.0.1', port: instance.port, path: '/api/auth/login', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length }, timeout: 15_000 }, incoming => {
      const reply: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => reply.push(chunk));
      incoming.on('error', () => { if (!response.headersSent) sendError(response, 502, 'Account service is unavailable'); });
      incoming.on('end', () => {
        if (response.destroyed || response.headersSent) return;
        try {
          const payload = JSON.parse(Buffer.concat(reply).toString('utf8')) as Record<string, unknown>;
          if (incoming.statusCode === 200 && typeof payload.token === 'string' && payload.user) {
            payload.instancePath = `/instances/${id}`;
            payload.workspaceServerUrl = instance.workspaceServerUrl;
          }
          response.writeHead(incoming.statusCode ?? 502, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify(payload));
        } catch { sendError(response, 502, 'Account service returned an invalid response'); }
      });
    });
    upstream.on('timeout', () => upstream.destroy(new Error('Account service timed out')));
    upstream.on('error', () => { if (!response.headersSent && !response.destroyed) sendError(response, 502, 'Account service is unavailable'); });
    response.on('close', () => { if (!response.writableFinished) upstream.destroy(); });
    upstream.end(body);
  }

  const server = createServer({ key: configuration.key, cert: configuration.cert, minVersion: 'TLSv1.2' }, (request, response) => {
    if (request.url === '/api/auth/login' && request.method === 'POST') {
      void login(request, response).catch(() => { if (!response.headersSent && !response.destroyed) sendError(response, 400, 'Login request was interrupted'); });
      return;
    }
    const route = resolveRoute(request.url ?? '/');
    if (!route || !route.path.startsWith('/api/')) { sendError(response, 404, 'Unknown service path'); return; }
    const upstream = httpRequest({ hostname: '127.0.0.1', port: route.instance.port, path: route.path,
      method: request.method, headers: { ...request.headers, host: `127.0.0.1:${route.instance.port}` } }, incoming => {
      if (incoming.statusCode === 200 && route.path.split('?')[0] === '/api/workspace-sync/enroll') {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
        incoming.on('error', () => response.destroy());
        incoming.on('end', () => {
          try {
            const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
            payload.workspaceServerUrl = route.instance.workspaceServerUrl;
            payload.sshHost = new URL(route.instance.workspaceServerUrl).hostname;
            const body = Buffer.from(JSON.stringify(payload));
            response.writeHead(200, { ...incoming.headers, 'content-length': body.length });
            response.end(body);
          } catch { sendError(response, 502, 'File synchronization service returned an invalid response'); }
        });
        return;
      }
      if (incoming.statusCode === 200 && route.path.split('?')[0] === '/api/auth/user') {
        incoming.headers['x-chisa-instance-path'] = `/instances/${route.id}`;
        incoming.headers['x-chisa-workspace-server-url'] = route.instance.workspaceServerUrl;
      }
      response.writeHead(incoming.statusCode ?? 502, incoming.headers);
      incoming.pipe(response);
      incoming.on('error', () => response.destroy());
    });
    upstream.on('error', () => { if (response.headersSent) response.destroy(); else sendError(response, 502, 'Account service is unavailable'); });
    request.on('aborted', () => upstream.destroy());
    response.on('close', () => { if (!response.writableFinished) upstream.destroy(); });
    request.pipe(upstream);
  });

  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const route = resolveRoute(request.url ?? '/');
    if (!route || route.path.startsWith('/api/')) { socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return; }
    const upstream = httpRequest({ hostname: '127.0.0.1', port: route.instance.port, path: route.path,
      method: 'GET', headers: { ...request.headers, host: `127.0.0.1:${route.instance.port}` } });
    upstream.on('upgrade', (incoming, remote, remoteHead) => {
      socket.write(`HTTP/1.1 ${incoming.statusCode} ${incoming.statusMessage}\r\n`);
      for (let i = 0; i < incoming.rawHeaders.length; i += 2) socket.write(`${incoming.rawHeaders[i]}: ${incoming.rawHeaders[i + 1]}\r\n`);
      socket.write('\r\n');
      if (remoteHead.length) socket.write(remoteHead);
      if (head.length) remote.write(head);
      socket.pipe(remote).pipe(socket);
      socket.on('close', () => remote.destroy());
      remote.on('close', () => socket.destroy());
      remote.on('error', () => socket.destroy());
    });
    upstream.on('response', incoming => { socket.end(`HTTP/1.1 ${incoming.statusCode ?? 502} ${incoming.statusMessage}\r\nConnection: close\r\n\r\n`); incoming.resume(); });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
    upstream.end();
  });
  return server;
}
