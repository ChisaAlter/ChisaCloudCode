import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';

import { WebSocket, WebSocketServer, type VerifyClientCallbackSync } from 'ws';

import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { isWebSocketSessionActive, verifyWebSocketClient } from '@/modules/websocket/services/websocket-auth.service.js';
import { handlePluginWsProxy } from '@/modules/websocket/services/plugin-websocket-proxy.service.js';
import { handleShellConnection } from '@/modules/websocket/services/shell-websocket.service.js';
import { handleDesktopNotificationsConnection } from '@/modules/notifications/index.js';
import type { AuthenticatedWebSocketRequest } from '@/shared/index.js';

type WebSocketServerDependencies = {
  verifyClient: Parameters<typeof verifyWebSocketClient>[1];
  chat: Parameters<typeof handleChatConnection>[2];
  shell: Parameters<typeof handleShellConnection>[1];
  getPluginPort: (pluginName: string) => number | null;
  authorizePluginAccess: (pluginName: string, userId: number, resource: 'websocket') => unknown;
  handlePreviewUpgrade?: (request: IncomingMessage, socket: Duplex, head: Buffer) => boolean;
  authorizePreviewUpgrade?: (request: IncomingMessage) => boolean;
  /** Bounded protocol budgets may be narrowed by isolated integration tests. */
  limits?: { maxPayload?: number; maxConnections?: number; maxConnectionsPerSession?: number; messagesPerSecond?: number; revalidateMs?: number; idleMs?: number };
};

/**
 * Used by this module's websocket gateway to keep active transports alive and
 * close half-open connections so their route-specific clients can reconnect.
 */
export function attachWebSocketHeartbeat(
  ws: WebSocket,
  intervalMs = 30_000,
  scheduler = {
    setInterval,
    clearInterval,
  },
): () => void {
  let isAlive = true;
  let stopped = false;

  const markAlive = () => {
    isAlive = true;
  };

  const stopHeartbeat = () => {
    if (stopped) {
      return;
    }

    stopped = true;
    scheduler.clearInterval(heartbeat);
    ws.off('pong', markAlive);
    ws.off('close', stopHeartbeat);
    ws.off('error', stopHeartbeat);
  };

  ws.on('pong', markAlive);
  ws.on('close', stopHeartbeat);
  ws.on('error', stopHeartbeat);

  const heartbeat = scheduler.setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) {
      return;
    }

    // A socket that did not answer the previous ping is half-open from the
    // server's perspective. Terminating it emits close and lets clients resume.
    if (!isAlive) {
      stopHeartbeat();
      ws.terminate();
      return;
    }

    isAlive = false;
    try {
      ws.ping();
    } catch {
      stopHeartbeat();
      ws.terminate();
    }
  }, intervalMs);

  return stopHeartbeat;
}

function budget(value: number | undefined, fallback: number, maximum: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;
}

function installSessionGuard(
  ws: WebSocket,
  request: AuthenticatedWebSocketRequest,
  check: WebSocketServerDependencies['verifyClient']['isAuthSessionActive'],
  limits: WebSocketServerDependencies['limits'],
): () => boolean {
  let stopped = false;
  const active = () => !stopped && ws.readyState === WebSocket.OPEN && isWebSocketSessionActive(request, check);
  let lastActivity = Date.now();
  let windowStart = lastActivity;
  let frames = 0;
  const frameLimit = budget(limits?.messagesPerSecond, 120, 1000);
  const idleMs = budget(limits?.idleMs, 10 * 60_000, 60 * 60_000);
  const close = (code: number, reason: string) => {
    if (stopped) return;
    stopped = true;
    clearInterval(sweep);
    ws.close(code, reason);
    const force = setTimeout(() => ws.terminate(), 1000);
    force.unref();
    ws.once('close', () => clearTimeout(force));
  };
  // EventEmitter listeners cannot stop subsequent listeners. Gate emit itself before any business handler is registered.
  const emit = ws.emit;
  ws.emit = function (this: WebSocket, event: string | symbol, ...args: unknown[]): boolean {
    if (event === 'message') {
      if (!active()) { close(4401, 'Authentication session ended'); return false; }
      const now = Date.now();
      if (now - windowStart >= 1000) { windowStart = now; frames = 0; }
      if (++frames > frameLimit) { close(4429, 'Message rate exceeded'); return false; }
      lastActivity = now;
    }
    return emit.call(this, event, ...args);
  } as WebSocket['emit'];
  // Every outbound frame is protected too: a periodic notification or delayed handler cannot send after revocation.
  const send = ws.send;
  ws.send = function (...args: Parameters<WebSocket['send']>): void {
    if (!active()) { close(4401, 'Authentication session ended'); return; }
    if (ws.bufferedAmount > 1024 * 1024) { close(4408, 'Backpressure limit exceeded'); return; }
    lastActivity = Date.now();
    Reflect.apply(send, ws, args);
  } as WebSocket['send'];
  const sweep = setInterval(() => {
    if (!active()) close(4401, 'Authentication session ended');
    else if (Date.now() - lastActivity >= idleMs) close(4408, 'Idle timeout');
  }, budget(limits?.revalidateMs, 1000, 1000));
  sweep.unref();
  const cleanup = () => { stopped = true; clearInterval(sweep); };
  ws.once('close', cleanup);
  ws.once('error', cleanup);
  return active;
}

/**
 * Creates and wires the server-wide websocket gateway used for chat, shell,
 * notifications and plugin proxy routes. Exported through the websocket module for server startup.
 */
export function createWebSocketServer(
  server: HttpServer,
  dependencies: WebSocketServerDependencies
): WebSocketServer {
  const sessionConnections = new Map<string, number>();
  const maxConnections = budget(dependencies.limits?.maxConnections, 1024, 4096);
  const maxPerSession = budget(dependencies.limits?.maxConnectionsPerSession, 12, 64);
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: budget(dependencies.limits?.maxPayload, 256 * 1024, 1024 * 1024),
    perMessageDeflate: false,
    verifyClient: ((info: Parameters<VerifyClientCallbackSync<AuthenticatedWebSocketRequest>>[0]) => {
      if (wss.clients.size >= maxConnections || !verifyWebSocketClient(info, dependencies.verifyClient)) return false;
      const sid = (info.req as AuthenticatedWebSocketRequest).user?.sessionId;
      return typeof sid === 'string' && (sessionConnections.get(sid) ?? 0) < maxPerSession;
    }),
  });

  // One upgrade listener owns dispatch. Preview capability URLs authenticate
  // in their proxy; all remaining routes still pass verifyWebSocketClient.
  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const timeout = setTimeout(() => socket.destroy(), 5000);
    timeout.unref();
    const clearTimeoutOnClose = () => clearTimeout(timeout);
    socket.once('close', clearTimeoutOnClose);
    const route = async () => {
      if (request.url?.startsWith('/api/workspace-runtime/preview/')) {
        const authorizePreview = dependencies.authorizePreviewUpgrade ?? dependencies.verifyClient.authorizeUpgrade;
        if (!authorizePreview?.(request)) { socket.destroy(); return; }
        const handlePreview = dependencies.handlePreviewUpgrade
          ?? (await import('@/modules/workspace-runtime/index.js')).handleWorkspaceRuntimePreviewUpgrade;
        if (handlePreview(request, socket, head)) return;
      }
      wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request));
    };
    void route().catch(() => {
      // Never serialize upgrade errors: transport adapters may retain URL capabilities.
      console.error('[ERROR] WebSocket upgrade failed');
      socket.destroy();
    }).finally(() => { clearTimeout(timeout); socket.off('close', clearTimeoutOnClose); });
  };
  server.on('upgrade', onUpgrade);
  wss.once('close', () => server.off('upgrade', onUpgrade));

  wss.on('connection', (ws, request) => {
    const incomingRequest = request as AuthenticatedWebSocketRequest;
    const sessionId = incomingRequest.user?.sessionId;
    if (!sessionId || !isWebSocketSessionActive(incomingRequest, dependencies.verifyClient.isAuthSessionActive)) {
      ws.close(4401, 'Authentication session ended');
      return;
    }
    sessionConnections.set(sessionId, (sessionConnections.get(sessionId) ?? 0) + 1);
    ws.once('close', () => {
      const count = (sessionConnections.get(sessionId) ?? 1) - 1;
      if (count > 0) sessionConnections.set(sessionId, count); else sessionConnections.delete(sessionId);
    });
    const isSessionActive = installSessionGuard(ws, incomingRequest, dependencies.verifyClient.isAuthSessionActive, dependencies.limits);
    attachWebSocketHeartbeat(ws);
    const url = incomingRequest.url ?? '/';
    const pathname = new URL(url, 'http://localhost').pathname;

    if (pathname === '/shell') {
      handleShellConnection(ws, { ...dependencies.shell, isSessionActive }, incomingRequest);
      return;
    }

    if (pathname === '/ws') {
      // Retained previews belong to this immutable login proof, independently
      // of the transport's heartbeat, readyState and reconnect lifetime.
      const capturedLogin = { user: Object.freeze({ ...incomingRequest.user }) } as AuthenticatedWebSocketRequest;
      const isAuthSessionActive = () => isWebSocketSessionActive(capturedLogin, dependencies.verifyClient.isAuthSessionActive);
      handleChatConnection(ws, incomingRequest, { ...dependencies.chat, isSessionActive, isAuthSessionActive });
      return;
    }

    if (pathname === '/desktop-notifications') {
      handleDesktopNotificationsConnection(ws, incomingRequest);
      return;
    }

    if (pathname.startsWith('/plugin-ws/')) {
      handlePluginWsProxy(ws, pathname, {
        getPluginPort: dependencies.getPluginPort,
        authorizePluginAccess: dependencies.authorizePluginAccess,
        userId: Number(incomingRequest.user?.id ?? incomingRequest.user?.userId),
        isSessionActive,
      });
      return;
    }

    console.log('[WARN] Unknown WebSocket path:', pathname);
    ws.close();
  });

  return wss;
}
