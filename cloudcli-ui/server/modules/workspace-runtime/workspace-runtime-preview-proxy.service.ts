import http from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

import { AppError } from '@/shared/index.js';

import { resolveWorkspaceRuntimePreviewAccess, retainWorkspaceRuntimePreviewConnection } from './workspace-runtime-preview-access.service.js';

const blockedRequestHeaders = new Set(['authorization', 'cookie', 'proxy-authorization', 'proxy-connection', 'forwarded', 'referer', 'origin',
  'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'host', 'connection', 'upgrade', 'keep-alive', 'te', 'trailer', 'transfer-encoding']);
const blockedResponseHeaders = new Set(['set-cookie', 'clear-site-data', 'service-worker-allowed', 'content-security-policy', 'content-security-policy-report-only',
  'access-control-allow-credentials', 'access-control-allow-origin', 'report-to', 'reporting-endpoints', 'nel', 'refresh', 'connection', 'upgrade', 'keep-alive', 'transfer-encoding', 'trailer']);

function upstreamHeaders(request: IncomingMessage, authority: string, upgrade: boolean) {
  const blocked = new Set([...blockedRequestHeaders, ...(request.headers.connection ?? '').toLowerCase().split(',').map(value => value.trim())]);
  const headers: IncomingHttpHeaders = {};
  for (const [key, value] of Object.entries(request.headers)) {
    if (!blocked.has(key) && !key.startsWith('x-forwarded-') && !key.startsWith('proxy-') && !key.startsWith('sec-')) headers[key] = value;
  }
  headers.host = authority;
  if (upgrade) {
    headers.connection = 'Upgrade'; headers.upgrade = 'websocket';
    for (const name of ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions']) {
      if (request.headers[name] !== undefined) headers[name] = request.headers[name];
    }
  }
  return headers;
}

function previewPath(request: IncomingMessage, base: string) {
  const original = 'originalUrl' in request && typeof request.originalUrl === 'string' ? request.originalUrl : request.url ?? '/';
  const url = new URL(original, 'http://preview.invalid');
  if (!url.pathname.startsWith(base) || url.pathname.includes('\\')) throw new AppError('Invalid preview path', { statusCode: 400 });
  // Applications use CHISA_PREVIEW_BASE as their public base and receive that
  // same path; do not rewrite HTML/JS or guess framework-specific base routes.
  return url.pathname + url.search;
}

function browserPolicy(response: ServerResponse, origin: string, base: string) {
  const resource = origin + base;
  const websocket = origin.replace(/^http/, 'ws') + base;
  response.setHeader('Content-Security-Policy', "sandbox allow-scripts allow-forms; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' " + resource +
    "; style-src 'unsafe-inline' " + resource + '; img-src data: blob: ' + resource + '; font-src data: ' + resource + '; media-src blob: ' + resource +
    '; connect-src ' + resource + ' ' + websocket + "; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action " + resource + "; frame-ancestors 'self'");
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
}

/** The runtime router proxies a token-bound preview while removing main-application credentials and browser privileges. */
export async function proxyWorkspaceRuntimePreview(request: IncomingMessage, response: ServerResponse, token: string, origin: string) {
  const target = await resolveWorkspaceRuntimePreviewAccess(token);
  if (request.aborted || response.destroyed) return;
  const upstreamPath = previewPath(request, target.base);
  browserPolicy(response, origin, target.base);
  if (request.method === 'OPTIONS') {
    response.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS');
    const requested = request.headers['access-control-request-headers'];
    if (requested) response.setHeader('Access-Control-Allow-Headers', requested);
    response.writeHead(204); response.end(); return;
  }
  await new Promise<void>((resolve, reject) => {
    const cancellation = new AbortController();
    let completed = false;
    const close = () => { cancellation.abort(); if (!response.writableFinished) response.destroy(); };
    // Acquire the live capability before allocating a network request: revocation
    // can happen while the asynchronous access check is resolving.
    const release = retainWorkspaceRuntimePreviewConnection(token, close);
    const finish = (error?: unknown) => {
      if (completed) return;
      completed = true; release(); request.off('aborted', close); response.off('close', close);
      if (error) reject(error); else resolve();
    };
    let upstream: http.ClientRequest;
    try {
      upstream = http.request({ host: target.host, port: target.port, method: request.method, path: upstreamPath,
        headers: upstreamHeaders(request, target.host + ':' + target.port, false), signal: cancellation.signal });
    } catch (error) { finish(error); return; }
    request.once('aborted', close); response.once('close', close);
    response.once('finish', () => finish());
    response.once('close', () => finish());
    upstream.setTimeout(30_000, () => upstream.destroy(new Error('Preview response timed out')));
    upstream.once('error', error => finish(error));
    upstream.once('response', incoming => {
      const blocked = new Set([...blockedResponseHeaders, ...(incoming.headers.connection ?? '').toLowerCase().split(',').map(value => value.trim())]);
      for (const [key, value] of Object.entries(incoming.headers)) if (value !== undefined && !blocked.has(key) && key !== 'location') response.setHeader(key, value);
      const location = incoming.headers.location;
      if (location) {
        let absolute: URL;
        try {
          absolute = new URL(location, 'http://' + target.host + ':' + target.port + upstreamPath);
          if (absolute.origin !== 'http://' + target.host + ':' + target.port || !absolute.pathname.startsWith(target.base)) throw new Error('Redirect outside preview');
        } catch {
          incoming.destroy(); upstream.destroy(); finish(new AppError('Preview redirect leaves its base path', { code: 'PREVIEW_REDIRECT_INVALID', statusCode: 502 })); return;
        }
        response.setHeader('Location', absolute.pathname + absolute.search + absolute.hash);
      }
      browserPolicy(response, origin, target.base);
      response.writeHead(incoming.statusCode ?? 502);
      incoming.once('error', error => { response.destroy(); finish(error); });
      incoming.pipe(response);
    });
    request.pipe(upstream);
  });
}

/** The runtime upgrade hook forwards WebSockets only after the same live-preview checks as HTTP. */
export async function proxyWorkspaceRuntimePreviewUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, token: string) {
  const target = await resolveWorkspaceRuntimePreviewAccess(token);
  if (socket.destroyed) return;
  const upstreamPath = previewPath(request, target.base);
  if (request.method !== 'GET' || request.headers.upgrade?.toLowerCase() !== 'websocket') throw new AppError('Invalid preview upgrade', { statusCode: 400 });
  const cancellation = new AbortController();
  let peer: Duplex | undefined;
  const close = () => { cancellation.abort(); peer?.destroy(); socket.destroy(); };
  const release = retainWorkspaceRuntimePreviewConnection(token, close);
  let upstream: http.ClientRequest;
  try {
    upstream = http.request({ host: target.host, port: target.port, method: 'GET', path: upstreamPath,
      headers: upstreamHeaders(request, target.host + ':' + target.port, true), signal: cancellation.signal });
  } catch (error) { release(); throw error; }
  socket.once('close', () => { close(); release(); });
  socket.once('error', close);
  upstream.setTimeout(10_000, close);
  upstream.once('error', close);
  upstream.once('response', incoming => { incoming.destroy(); close(); });
  upstream.once('upgrade', (incoming, connected, upstreamHead) => {
    peer = connected;
    if (incoming.statusCode !== 101 || socket.destroyed) { close(); return; }
    upstream.setTimeout(0);
    const headers = ['HTTP/1.1 101 Switching Protocols', 'Connection: Upgrade', 'Upgrade: websocket'];
    for (const name of ['sec-websocket-accept', 'sec-websocket-protocol', 'sec-websocket-extensions']) {
      const value = incoming.headers[name];
      if (typeof value === 'string') headers.push(name + ': ' + value);
    }
    socket.write(headers.join('\r\n') + '\r\n\r\n');
    if (upstreamHead.length) socket.write(upstreamHead);
    if (head.length) connected.write(head);
    connected.once('error', close); connected.once('close', close);
    connected.pipe(socket); socket.pipe(connected);
  });
  upstream.end();
}
