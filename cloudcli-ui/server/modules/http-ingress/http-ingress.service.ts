import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';

import type { Express, RequestHandler } from 'express';

function normalizedAddress(address: string | undefined): string {
  const value = (address ?? '').toLowerCase();
  return value.startsWith('::ffff:') && isIP(value.slice(7)) === 4 ? value.slice(7) : value;
}

function loopback(address: string | undefined): boolean {
  const value = normalizedAddress(address);
  return value === '::1' || (isIP(value) === 4 && value.startsWith('127.'));
}

function authority(value: string): string | null {
  if (!value || value !== value.trim() || /[\s,\\/@?#%]/.test(value)) return null;
  try {
    const parsed = new URL(`http://${value}`);
    if (parsed.pathname !== '/' || parsed.username || !parsed.hostname
      || parsed.hostname.endsWith('.') || !/^[a-z0-9.:[\]-]+$/i.test(parsed.host)) return null;
    return parsed.host === value.toLowerCase() ? parsed.host : null;
  } catch { return null; }
}

function origin(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username
      || parsed.pathname !== '/' || parsed.search || parsed.hash || !authority(parsed.host)) return null;
    // No alternate serializations, wildcards, null origins, or trailing slash matching.
    return parsed.origin === value ? parsed.origin : null;
  } catch { return null; }
}

function previewCapabilityPath(request: IncomingMessage): boolean {
  const raw = request.url ?? '';
  if (!/^\/api\/workspace-runtime\/preview\/[a-f0-9]{64}(?:\/[^#]*)?(?:\?[^#]*)?$/.test(raw) || /[\\\r\n\0]/.test(raw)) return false;
  try {
    const pathname = raw.split('?')[0]!;
    return !pathname.includes('//') && !/%(?:2f|5c|00|25)/i.test(pathname)
      && new URL(raw, 'http://preview.invalid').pathname === pathname;
  } catch { return false; }
}

function list(value: string | undefined): string[] {
  return value ? value.split(',').map(entry => entry.trim()).filter(Boolean) : [];
}

function singleHeader(request: IncomingMessage, name: string): string | undefined {
  const values = request.rawHeaders?.filter((_, index) => index % 2 === 0)
    .filter(header => header.toLowerCase() === name);
  if (values && values.length > 1) return undefined;
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}

/** HTTP startup and the websocket gateway share exact host/origin/proxy checks, without trusting client forwarding headers. */
export function createHttpIngressPolicy(env: NodeJS.ProcessEnv = process.env) {
  const port = env.SERVER_PORT ?? '3001';
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('Invalid SERVER_PORT');
  const bindHost = env.HOST ?? '0.0.0.0';
  const hostInputs = list(env.CHISA_ALLOWED_HOSTS);
  const hosts = new Set((hostInputs.length ? hostInputs : [
    `localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`,
    ...(isIP(bindHost) && !['0.0.0.0', '::'].includes(bindHost) ? [`${bindHost.includes(':') ? `[${bindHost}]` : bindHost}:${port}`] : []),
  ]).map(value => {
    const parsed = authority(value);
    if (!parsed) throw new Error('CHISA_ALLOWED_HOSTS must contain exact host[:port] authorities');
    return parsed;
  }));
  const origins = new Set(list(env.CHISA_ALLOWED_ORIGINS).map(value => {
    const parsed = origin(value);
    if (!parsed) throw new Error('CHISA_ALLOWED_ORIGINS must contain exact HTTP(S) origins');
    return parsed;
  }));
  const proxies = new Set(list(env.CHISA_TRUSTED_PROXIES).map(value => {
    const parsed = normalizedAddress(value);
    if (!isIP(parsed)) throw new Error('CHISA_TRUSTED_PROXIES must contain exact IP addresses');
    return parsed;
  }));
  const trustedProxy = (address: string | undefined) => proxies.has(normalizedAddress(address));
  const platformEnabled = env.VITE_IS_PLATFORM === 'true' || env.IS_PLATFORM === 'true';
  const allowNativeHeader = env.CHISA_ALLOW_NATIVE_HEADER_WS === '1';
  const allowPlatformLoopback = env.CHISA_ALLOW_PLATFORM_LOOPBACK === '1';

  function assertStartup(): void {
    if (platformEnabled && (!allowPlatformLoopback || !loopback(bindHost)
      || proxies.size > 0 || origins.size > 0 || [...hosts].some(host => {
        const hostname = new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, '');
        return hostname !== 'localhost' && !loopback(hostname);
      }))) {
      throw new Error('IS_PLATFORM requires explicit isolated loopback management (CHISA_ALLOW_PLATFORM_LOOPBACK=1); public/proxy bypass is forbidden');
    }
  }

  function requestOrigin(request: IncomingMessage): string | null {
    const host = singleHeader(request, 'host');
    const parsedHost = host && authority(host);
    if (!parsedHost || !hosts.has(parsedHost)) return null;
    let protocol = 'encrypted' in request.socket && request.socket.encrypted ? 'https' : 'http';
    const forwardedProtocol = singleHeader(request, 'x-forwarded-proto');
    if (trustedProxy(request.socket.remoteAddress) && request.headers['x-forwarded-proto'] !== undefined) {
      if (forwardedProtocol !== 'http' && forwardedProtocol !== 'https') return null;
      protocol = forwardedProtocol;
    }
    return new URL(`${protocol}://${parsedHost}`).origin;
  }

  function allowedOrigin(request: IncomingMessage, nativeHeader = false): boolean {
    if (platformEnabled && (!loopback(request.socket.remoteAddress) || trustedProxy(request.socket.remoteAddress))) return false;
    const expected = requestOrigin(request);
    if (!expected) return false;
    const supplied = singleHeader(request, 'origin');
    if (request.headers.origin !== undefined && supplied === undefined) return false;
    if (supplied === undefined) {
      // Browsers always send Origin on WS. Originless sockets require an explicit native loopback proxy policy and a bearer header.
      return nativeHeader && allowNativeHeader
        && trustedProxy(request.socket.remoteAddress) && loopback(request.socket.remoteAddress)
        && /^Bearer [^\s]+$/i.test(singleHeader(request, 'authorization') ?? '');
    }
    const parsed = origin(supplied);
    return parsed !== null && (parsed === expected || origins.has(parsed));
  }

  const middleware: RequestHandler = (request, response, next) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'SAMEORIGIN');
    response.setHeader('Permissions-Policy', 'camera=(), geolocation=(), payment=()');
    response.setHeader('Content-Security-Policy', "frame-ancestors 'self'; base-uri 'self'; object-src 'none'");
    // Keep report-only collection distinct from an enforced policy. Preview/iframe policy may be tightened by its own route.
    response.setHeader('Content-Security-Policy-Report-Only', "default-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'");
    if (!requestOrigin(request) || (platformEnabled && (!loopback(request.socket.remoteAddress) || trustedProxy(request.socket.remoteAddress)))) {
      response.status(403).json({ error: { code: 'HOST_NOT_ALLOWED', message: 'Request host is not allowed' } });
      return;
    }
    // Express must not derive redirects or hostname routing from an unchecked forwarded host.
    delete request.headers['x-forwarded-host'];
    const suppliedOrigin = request.headers.origin;
    // A CSP-sandboxed preview has an opaque Origin. Only its canonical capability namespace may reach the preview's own verifier.
    if (suppliedOrigin === 'null' && singleHeader(request, 'origin') === 'null' && previewCapabilityPath(request)) { next(); return; }
    if ((suppliedOrigin !== undefined && !allowedOrigin(request))
      || (request.headers['sec-fetch-site'] === 'cross-site' && suppliedOrigin === undefined)) {
      response.status(403).json({ error: { code: 'ORIGIN_NOT_ALLOWED', message: 'Request origin is not allowed' } });
      return;
    }
    if (typeof suppliedOrigin === 'string') {
      response.vary('Origin');
      response.setHeader('Access-Control-Allow-Origin', suppliedOrigin);
      response.setHeader('Access-Control-Expose-Headers', 'X-Refreshed-Token, X-Auth-Error, Retry-After');
      if (request.method === 'OPTIONS') {
        const method = request.headers['access-control-request-method'];
        const headers = String(request.headers['access-control-request-headers'] ?? '').toLowerCase().split(',').map(value => value.trim()).filter(Boolean);
        if (typeof method !== 'string' || !['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(method)
          || headers.some(value => !['authorization', 'content-type', 'x-api-key', 'x-request-id'].includes(value))) {
          response.status(403).end();
          return;
        }
        response.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
        response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Api-Key, X-Request-Id');
        response.setHeader('Access-Control-Max-Age', '600');
        response.status(204).end();
        return;
      }
    }
    next();
  };

  return {
    assertStartup,
    authorizeUpgrade: allowedOrigin,
    /** Preview sandbox handshakes retain exact Host policy, then defer only their scoped capability to the runtime proxy. */
    authorizePreviewUpgrade(request: IncomingMessage): boolean {
      return !(platformEnabled && !loopback(request.socket.remoteAddress))
        && requestOrigin(request) !== null && previewCapabilityPath(request)
        && (singleHeader(request, 'origin') === 'null' || allowedOrigin(request));
    },
    /** Entrypoint installs this before parsers, preview proxy, public routes and static files. */
    install(app: Express): void {
      app.disable('x-powered-by');
      app.set('trust proxy', (address: string, hop: number) => hop === 0 && trustedProxy(address));
      app.use(middleware);
    },
  };
}
