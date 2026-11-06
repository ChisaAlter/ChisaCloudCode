import { api } from '@/shared/api';
import { dispatchWithAuthSession, getAuthSessionSnapshot, isCurrentAuthSession, subscribeToAuthSession } from '@/modules/auth-session';
import type { AuthSessionSnapshot, Plugin } from '@/shared/types';

function interrupted(): DOMException { return new DOMException('Plugin account session changed', 'AbortError'); }
function safePath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096 || /[\\\x00-\x1f#]/.test(value)) throw new TypeError('Invalid plugin request path');
  const path = value.replace(/^\//, '');
  if (/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(path) || path.split('?')[0].split('/').some(part => decodeURIComponent(part) === '..')) throw new TypeError('Plugin requests must use a relative path');
  const parsed = new URL(path, 'https://plugin.invalid/');
  for (const key of parsed.searchParams.keys()) if (/^(?:token|authorization|api[_-]?key)$/i.test(key)) throw new TypeError('Credentials are not accepted in plugin URLs');
  return path;
}
function protectResponse(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(protectResponse);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key, child]) => typeof child === 'boolean' || !/(?:token$|api[_-]?key$|anthropic[_-]?key$|password$|secret$|authorization$|cookie$)/i.test(key))
    .map(([key, child]) => [key, protectResponse(child)]));
}

/** The frame host and deterministic tests use a revocable bridge; its API never contains a bearer or a socket URL. */
export function createPluginSessionBridge(plugin: Plugin, captured: AuthSessionSnapshot, host: {
  getSession?: typeof getAuthSessionSnapshot;
  isCurrent?: typeof isCurrentAuthSession;
  subscribe?: typeof subscribeToAuthSession;
  dispatch?: typeof dispatchWithAuthSession;
  rpc?: typeof api.plugins.rpc;
  socketUrl?: typeof api.plugins.webSocketUrl;
  WebSocket?: typeof WebSocket;
} = {}) {
  const current = host.isCurrent ?? isCurrentAuthSession;
  const getSession = host.getSession ?? getAuthSessionSnapshot;
  const subscribe = host.subscribe ?? subscribeToAuthSession;
  const dispatch = host.dispatch ?? dispatchWithAuthSession;
  const rpc = host.rpc ?? api.plugins.rpc;
  const socketUrl = host.socketUrl ?? api.plugins.webSocketUrl;
  const Socket = host.WebSocket ?? WebSocket;
  const controller = new AbortController();
  const sockets = new Set<WebSocket>();
  const security = plugin.security;
  function assert(permission: string) {
    if (controller.signal.aborted || captured.phase !== 'ready' || !captured.userId || !current(captured)
      || getSession().phase !== 'ready') throw interrupted();
    if (!plugin.enabled || security?.model !== 'trusted-only' || !security.trusted || !security.permitted
      || !security.permissions.includes(permission)) throw new Error('Plugin is not trusted and permitted for this host capability');
  }
  function dispose() {
    controller.abort(interrupted());
    for (const socket of sockets) socket.close(1000, 'Plugin session ended');
    sockets.clear();
  }
  const unsubscribe = subscribe(() => { if (!current(captured) || getSession().phase !== 'ready') dispose(); });
  async function request(method: unknown, path: unknown, body?: unknown) {
    assert('host:rpc');
    if (typeof method !== 'string' || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase())) throw new TypeError('Invalid plugin method');
    const relative = safePath(path);
    if (body !== undefined) {
      const encoded = JSON.stringify(body);
      if (encoded === undefined || encoded.length > 1024 * 1024) throw new TypeError('Plugin request exceeds the host budget');
    }
    const response = await rpc(plugin.name, method.toUpperCase(), relative, body, { expectedSession: captured, signal: controller.signal });
    assert('host:rpc');
    const data: unknown = await response.json();
    assert('host:rpc');
    if (!response.ok) {
      const error = data && typeof data === 'object' ? (data as { error?: unknown }).error : null;
      throw new Error(typeof error === 'string' ? error : error && typeof error === 'object' && 'message' in error ? String(error.message) : `Plugin RPC failed (${response.status})`);
    }
    return protectResponse(data);
  }
  return {
    request,
    assertCurrent() { assert('host:context'); },
    async fetch(input: unknown, init: RequestInit = {}) {
      if (typeof input !== 'string' || init.headers || init.credentials) throw new TypeError('Plugin fetch accepts only its relative RPC paths without credentials');
      let body: unknown;
      if (init.body !== undefined) {
        if (typeof init.body !== 'string') throw new TypeError('Plugin fetch body must be JSON');
        body = JSON.parse(init.body);
      }
      const data = await request(init.method ?? 'GET', input, body);
      return Response.json(data);
    },
    async openSocket(events: { open(): void; message(data: string | ArrayBuffer): void; close(code: number, reason: string): void; error(): void }) {
      assert('host:websocket');
      const url = await socketUrl(plugin.name);
      assert('host:websocket');
      const admission = await dispatch(captured, async () => {
        assert('host:websocket');
        const socket = new Socket(url);
        sockets.add(socket);
        socket.addEventListener('open', () => { try { assert('host:websocket'); events.open(); } catch { socket.close(); } });
        socket.addEventListener('message', event => { try { assert('host:websocket'); if (typeof event.data === 'string' || event.data instanceof ArrayBuffer) events.message(event.data); } catch { socket.close(); } });
        socket.addEventListener('close', event => { sockets.delete(socket); events.close(event.code, event.reason); });
        socket.addEventListener('error', () => { if (!controller.signal.aborted) events.error(); });
        return {
          send(data: unknown) {
            assert('host:websocket');
            if (typeof data !== 'string' || data.length > 1024 * 1024) throw new TypeError('Plugin socket accepts bounded text messages');
            if (socket.readyState !== Socket.OPEN) throw new Error('Plugin socket is not open');
            socket.send(data);
          },
          close(code = 1000, reason = '') {
            const validCode = typeof code === 'number' && Number.isInteger(code) && (code === 1000 || (code >= 3000 && code <= 4999)) ? code : 1000;
            socket.close(validCode, String(reason).slice(0, 120));
          },
        };
      });
      return admission.operation;
    },
    dispose() { dispose(); unsubscribe(); },
  };
}
