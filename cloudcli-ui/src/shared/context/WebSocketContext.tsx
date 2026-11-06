import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { useAuth } from '@/modules/auth';
import { beginBackgroundOperation } from '@/shared/utils';
import { dispatchWithAuthSession, getAuthSessionSnapshot, isCurrentAuthSession, subscribeToAuthSession } from '@/shared/authToken';
import type { ServerEvent } from '@/shared/types';
import { getServerTransportVersion, subscribeToServerConnection } from '@/shared/chisa';
import { resolveWebSocketAdmissionUrl } from '@/shared/webSocketAdmission';


type ServerEventListener = (event: ServerEvent) => void;

/**
 * Where the chat socket stands. `connecting` covers a handshake the provider
 * started on purpose (after sign-in, or with a refreshed token) and the time
 * signed out; `disconnected` a socket that closed on its own (it dropped, or an
 * attempt failed) until a reconnect opens again.
 */
type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

type WebSocketContextType = {
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  /**
   * Subscribes to every websocket frame. Returns an unsubscribe function.
   *
   * This is the primary consumption API: events are dispatched synchronously
   * to every listener, so rapid back-to-back frames cannot be coalesced or
   * dropped. Frames are deliberately not copied into React state; each
   * listener updates only the state owned by the feature that handles it.
   */
  subscribe: (listener: ServerEventListener) => () => void;
  isConnected: boolean;
  /** Uses an already-fetched authoritative snapshot to settle stops whose terminal frame was lost. */
  reconcileRunningSessions: (sessionIds: ReadonlySet<string>, snapshotRequestedAt: number) => boolean;
  /** Distinguishes an unexpected drop from the initial or refreshed-token handshake. */
  connectionStatus: ConnectionStatus;
};

const WebSocketContext = createContext<WebSocketContextType | null>(null);

export const useWebSocket = () => {
  const context = useContext(WebSocketContext);
  if (!context) {
    throw new Error('useWebSocket must be used within a WebSocketProvider');
  }
  return context;
};

/** Features that also render outside the provider (isolated tests, embeds) opt into live updates only when a socket exists. */
export const useOptionalWebSocket = () => useContext(WebSocketContext);

const useWebSocketProviderState = (): WebSocketContextType => {
  const wsRef = useRef<WebSocket | null>(null);
  const unmountedRef = useRef(false); // Track if component is unmounted
  const hasConnectedRef = useRef(false); // Track if we've ever connected (to detect reconnects)
  /**
   * Listener registry for the subscribe API. A ref (not state) because the
   * set must be readable synchronously inside `onmessage` and never trigger
   * re-renders of the provider tree.
   */
  const listenersRef = useRef(new Set<ServerEventListener>());
  // Stop status lasts until this session's acknowledgement without locking other conversations.
  const pendingStopsRef = useRef(new Map<string, { finish: () => void; requestedAt: number }>());
  // Distinguishes a dropped connection from an intentional new handshake in the workspace header.
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('connecting');
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  // Each effect incarnation owns its lookup and socket; a refreshed account invalidates both.
  const connectionGeneration = useRef(0);
  const { isLoading: isAuthLoading, user } = useAuth();
  // Both failed/no-op probes and committed identity changes must resume or invalidate this transport.
  const transportVersion = useSyncExternalStore(subscribeToServerConnection, getServerTransportVersion, getServerTransportVersion);
  const authSnapshot = useSyncExternalStore(subscribeToAuthSession, getAuthSessionSnapshot, getAuthSessionSnapshot);
  // Each send remains bound to the socket's creation identity, even before React has processed a notification.
  const socketIdentityRef = useRef<{ session: typeof authSnapshot; transport: number; generation: number } | null>(null);

  const dispatch = useCallback((event: ServerEvent) => {
    for (const listener of listenersRef.current) {
      try {
        listener(event);
      } catch (error) {
        console.error('WebSocket listener error:', error);
      }
    }
  }, []);

  // Named function expression so the reconnect timer below can call itself
  // without reading the `connect` binding while it is still initializing.
  const connect = useCallback(async function connect() {
    if (unmountedRef.current) return;
    if (isAuthLoading || !user || authSnapshot.phase !== 'ready') return;
    const generation = connectionGeneration.current;
    const expected = getAuthSessionSnapshot();
    if (expected.sessionInstanceId !== authSnapshot.sessionInstanceId || expected.serverKey !== authSnapshot.serverKey
      || expected.tokenRevision !== authSnapshot.tokenRevision) return;
    let serverVersion = transportVersion;
    const current = () => !unmountedRef.current && generation === connectionGeneration.current
      && isCurrentAuthSession(expected) && expected.phase === 'ready' && serverVersion === getServerTransportVersion();
    try {
      if (!current()) return;
      const wsUrl = await resolveWebSocketAdmissionUrl('/ws', expected);
      // Native lookup can publish its legitimate capability revision while preserving the captured login.
      serverVersion = getServerTransportVersion();
      if (!current()) return;
      const admitted = await dispatchWithAuthSession(expected, () => {
        if (!current()) throw new DOMException('WebSocket identity changed', 'AbortError');
        return Promise.resolve(new WebSocket(wsUrl));
      });
      const websocket = await admitted.operation;
      if (!current()) { websocket.close(); return; }
      socketIdentityRef.current = { session: admitted.snapshot, transport: serverVersion, generation };
      // Store connecting sockets too, so a token refresh can close them before
      // their handshake completes with stale credentials.
      wsRef.current = websocket;

      websocket.onopen = () => {
        if (wsRef.current !== websocket || !current()) return;
        setConnectionStatus('connected');
        if (pendingStopsRef.current.size) websocket.send(JSON.stringify({
          type: 'chat.subscribe', sessions: [...pendingStopsRef.current.keys()].map(sessionId => ({ sessionId })),
        }));
        if (hasConnectedRef.current) {
          // This is a reconnect — signal so components can catch up on missed messages
          dispatch({ kind: 'websocket_reconnected', timestamp: Date.now() });
        }
        hasConnectedRef.current = true;
      };

      websocket.onmessage = (event) => {
        if (wsRef.current !== websocket || !current()) return;
        try {
          const data = JSON.parse(event.data) as ServerEvent;
          if (data.sessionId && (data.kind === 'complete'
            || (data.kind === 'chat_subscribed' && data.isProcessing === false)
            || (data.kind === 'protocol_error' && ['CHAT_ABORT_FAILED', 'NO_ACTIVE_RUN'].includes(String(data.code))))) {
            pendingStopsRef.current.get(data.sessionId)?.finish();
            pendingStopsRef.current.delete(data.sessionId);
          }
          dispatch(data);
        } catch {
          console.error('Error parsing WebSocket message');
        }
      };

      websocket.onclose = () => {
        if (wsRef.current !== websocket || !current()) {
          return;
        }
        // Also reached when the very first attempt fails, which is a lost
        // connection too. The effect cleanup detaches this handler before
        // closing a socket on purpose, so a token refresh never gets here.
        setConnectionStatus('disconnected');
        wsRef.current = null;

        // Attempt to reconnect after 3 seconds
        reconnectTimeoutRef.current = setTimeout(() => {
          if (current()) void connect();
        }, 3000);
      };

      websocket.onerror = () => {
        // Browser error events expose target.url; never log an admission ticket or native capability.
        console.error('WebSocket transport error');
      };

    } catch {
      if (!current()) return;
      setConnectionStatus('disconnected');
      console.error('WebSocket admission failed');
      reconnectTimeoutRef.current = setTimeout(() => { if (current()) void connect(); }, 3000);
    }
  }, [dispatch, isAuthLoading, user, authSnapshot.phase, authSnapshot.sessionInstanceId, authSnapshot.serverKey, authSnapshot.tokenRevision, transportVersion]);

  // Declared after `connect` so the effect body does not reference it before
  // initialization. `connect` is memoized on [dispatch, isAuthLoading, token,
  // user] and `dispatch` is stable, so depending on it reconnects on exactly
  // the same transitions as the previous [isAuthLoading, token, user] list.
  useEffect(() => {
    // The cleanup below sets unmountedRef = true. Without this reset, every
    // re-run of the effect (e.g. on token refresh) would short-circuit connect()
    // at its unmounted guard and leave the socket permanently disconnected.
    unmountedRef.current = false;
    ++connectionGeneration.current;
    setConnectionStatus('connecting');
    if (isAuthLoading || !user || authSnapshot.phase !== 'ready') {
      return undefined;
    }
    connect();

    return () => {
      unmountedRef.current = true;
      ++connectionGeneration.current;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      const activeSocket = wsRef.current;
      if (activeSocket) {
        // Prevent the intentionally closed, old-token socket from scheduling
        // a reconnect after the refreshed-token effect has already started.
        activeSocket.onopen = null;
        activeSocket.onmessage = null;
        activeSocket.onclose = null;
        activeSocket.onerror = null;
        activeSocket.close();
        wsRef.current = null;
      }
      // What comes next is a socket with a refreshed token, or none after a
      // sign-out or session expiry. Either way it starts from a fresh
      // handshake: the socket closed here is no longer live, and a drop seen
      // before must not show as "Reconnecting" after the next sign-in.
      socketIdentityRef.current = null;
      setConnectionStatus('connecting');
    };
  }, [connect, isAuthLoading, user, authSnapshot.phase]);

  const sendMessage = useCallback((message: unknown) => {
    const socket = wsRef.current;
    const identity = socketIdentityRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || !identity
      || identity.generation !== connectionGeneration.current || !isCurrentAuthSession(identity.session)
      || authSnapshot.sessionInstanceId !== identity.session.sessionInstanceId || authSnapshot.serverKey !== identity.session.serverKey
      || getAuthSessionSnapshot().phase !== 'ready' || identity.transport !== getServerTransportVersion()) {
      throw new Error('聊天连接已断开或账号正在切换，请等待重新连接后重试。');
    }
    socket.send(JSON.stringify(message));
    const frame = message as { type?: string; sessionId?: string } | null;
    // Only a stop handed to the socket is pending; a failed retry must not
    // clear the acknowledgement tracking of an earlier accepted stop.
    if (frame?.type === 'chat.abort' && frame.sessionId && !pendingStopsRef.current.has(frame.sessionId)) {
      pendingStopsRef.current.set(frame.sessionId, {
        finish: beginBackgroundOperation('正在停止任务', '后台停止中，可继续浏览和编辑下一条消息。'),
        requestedAt: performance.now(),
      });
    }
  }, [authSnapshot.sessionInstanceId, authSnapshot.serverKey]);

  useEffect(() => {
    hasConnectedRef.current = false;
    pendingStopsRef.current.forEach(stop => stop.finish());
    pendingStopsRef.current.clear();
    return () => {
      pendingStopsRef.current.forEach(stop => stop.finish());
      pendingStopsRef.current.clear();
    };
  }, [authSnapshot.sessionInstanceId]);

  const reconcileRunningSessions = useCallback((sessionIds: ReadonlySet<string>, snapshotRequestedAt: number) => {
    // Reject the same stale snapshot for both the busy map and the stop notice.
    if ([...pendingStopsRef.current.values()].some(stop => stop.requestedAt >= snapshotRequestedAt)) return false;
    for (const [sessionId, stop] of pendingStopsRef.current) {
      if (sessionIds.has(sessionId)) continue;
      stop.finish();
      pendingStopsRef.current.delete(sessionId);
    }
    return true;
  }, []);

  const subscribe = useCallback((listener: ServerEventListener) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  const value: WebSocketContextType = useMemo(() =>
  ({
    ws: wsRef.current,
    sendMessage,
    subscribe,
    isConnected: connectionStatus === 'connected',
    connectionStatus,
    reconcileRunningSessions,
  }), [sendMessage, subscribe, connectionStatus, reconcileRunningSessions]);

  return value;
};

/** Mounted once by App; owns the single chat websocket that the chat, project-workspace and task-master modules subscribe to. */
export const WebSocketProvider = ({ children }: { children: React.ReactNode }) => {
  const webSocketData = useWebSocketProviderState();

  return (
    <WebSocketContext.Provider value={webSocketData}>
      {children}
    </WebSocketContext.Provider>
  );
};

export default WebSocketContext;
