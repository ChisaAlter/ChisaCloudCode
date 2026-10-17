import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { useAuth } from '@/modules/auth';
import { beginBackgroundOperation, IS_PLATFORM } from '@/shared/utils';
import { AUTH_IDENTITY_CHANGED_EVENT, expireAuthSession, isAuthTokenExpired } from '@/shared/authToken';
import type { ServerEvent } from '@/shared/types';
import { desktopWebSocketUrl } from '@/shared/chisa';


type ServerEventListener = (event: ServerEvent) => void;

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
  reconcileRunningSessions: (sessionIds: ReadonlySet<string>, snapshotRequestedAt: number, stoppedSessionIds?: ReadonlySet<string>) => boolean;
};

const WebSocketContext = createContext<WebSocketContextType | null>(null);

export const useWebSocket = () => {
  const context = useContext(WebSocketContext);
  if (!context) {
    throw new Error('useWebSocket must be used within a WebSocketProvider');
  }
  return context;
};

const buildWebSocketUrl = (token: string | null) => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (typeof globalThis !== 'undefined' && (globalThis as any).mygo !== undefined) {
    if (!token) return null;
    return desktopWebSocketUrl('/ws', token);
  }
  if (IS_PLATFORM) return `${protocol}//${window.location.host}/ws`; // Platform mode: Use same domain as the page (goes through proxy)
  if (!token) return null;
  if (isAuthTokenExpired(token)) {
    expireAuthSession();
    return null;
  }
  return `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`; // OSS mode: Use same host:port that served the page
};

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
  const [isConnected, setIsConnected] = useState(false);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const { isLoading: isAuthLoading, token, user } = useAuth();

  const dispatch = useCallback((event: ServerEvent) => {
    for (const listener of listenersRef.current) {
      try {
        listener(event);
      } catch (error) {
        console.error('WebSocket listener error:', error);
      }
    }
  }, []);

  const closeActiveSocket = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    const activeSocket = wsRef.current;
    if (!activeSocket) return;
    // A deliberately closed socket cannot deliver old-account frames or reconnect.
    activeSocket.onopen = null;
    activeSocket.onmessage = null;
    activeSocket.onclose = null;
    activeSocket.onerror = null;
    activeSocket.close();
    wsRef.current = null;
  }, []);

  useEffect(() => {
    const endIdentity = () => {
      // JWT rotation keeps the identity and its pending stops; login/logout do not.
      pendingStopsRef.current.forEach(stop => stop.finish());
      pendingStopsRef.current.clear();
      hasConnectedRef.current = false;
      closeActiveSocket();
      setIsConnected(false);
    };
    window.addEventListener(AUTH_IDENTITY_CHANGED_EVENT, endIdentity);
    return () => window.removeEventListener(AUTH_IDENTITY_CHANGED_EVENT, endIdentity);
  }, [closeActiveSocket]);

  // Named function expression so the reconnect timer below can call itself
  // without reading the `connect` binding while it is still initializing.
  const connect = useCallback(function connect() {
    if (unmountedRef.current) return; // Prevent connection if unmounted
    if (!IS_PLATFORM && (isAuthLoading || !user)) return;
    try {
      // Construct WebSocket URL
      const wsUrl = buildWebSocketUrl(token);

      if (!wsUrl) return console.warn('No authentication token found for WebSocket connection');

      const websocket = new WebSocket(wsUrl);
      // Store connecting sockets too, so a token refresh can close them before
      // their handshake completes with stale credentials.
      wsRef.current = websocket;

      websocket.onopen = () => {
        if (wsRef.current !== websocket) return;
        setIsConnected(true);
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
        try {
          const data = JSON.parse(event.data) as ServerEvent;
          if (data.sessionId && (data.kind === 'complete'
            || (data.kind === 'status' && data.text === 'model_stopped')
            || (data.kind === 'chat_subscribed' && data.modelStopped === true)
            || (data.kind === 'chat_subscribed' && data.isProcessing === false)
            || (data.kind === 'protocol_error' && ['CHAT_ABORT_FAILED', 'NO_ACTIVE_RUN'].includes(String(data.code))))) {
            pendingStopsRef.current.get(data.sessionId)?.finish();
            pendingStopsRef.current.delete(data.sessionId);
          }
          dispatch(data);
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      };

      websocket.onclose = () => {
        if (wsRef.current !== websocket) {
          return;
        }
        setIsConnected(false);
        wsRef.current = null;

        // Attempt to reconnect after 3 seconds
        reconnectTimeoutRef.current = setTimeout(() => {
          if (unmountedRef.current) return; // Prevent reconnection if unmounted
          connect();
        }, 3000);
      };

      websocket.onerror = (error) => {
        console.error('WebSocket error:', error);
      };

    } catch (error) {
      console.error('Error creating WebSocket connection:', error);
    }
  }, [dispatch, isAuthLoading, token, user]); // reconnect with current authentication state

  // Declared after `connect` so the effect body does not reference it before
  // initialization. `connect` is memoized on [dispatch, isAuthLoading, token,
  // user] and `dispatch` is stable, so depending on it reconnects on exactly
  // the same transitions as the previous [isAuthLoading, token, user] list.
  useEffect(() => {
    // The cleanup below sets unmountedRef = true. Without this reset, every
    // re-run of the effect (e.g. on token refresh) would short-circuit connect()
    // at its unmounted guard and leave the socket permanently disconnected.
    unmountedRef.current = false;
    setIsConnected(false);
    if (!IS_PLATFORM && (isAuthLoading || !user)) {
      return undefined;
    }
    connect();

    return () => {
      unmountedRef.current = true;
      closeActiveSocket();
    };
  }, [closeActiveSocket, connect, isAuthLoading, user]); // reconnect after authentication or token refresh

  const sendMessage = useCallback((message: unknown) => {
    const socket = wsRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('聊天连接已断开，请等待重新连接后重试。');
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
  }, []);

  useEffect(() => () => {
    pendingStopsRef.current.forEach(stop => stop.finish());
    pendingStopsRef.current.clear();
  }, []);

  const reconcileRunningSessions = useCallback((sessionIds: ReadonlySet<string>, snapshotRequestedAt: number, stoppedSessionIds?: ReadonlySet<string>) => {
    // Reject the same stale snapshot for both the busy map and the stop notice.
    if ([...pendingStopsRef.current.values()].some(stop => stop.requestedAt >= snapshotRequestedAt)) return false;
    for (const [sessionId, stop] of pendingStopsRef.current) {
      if (sessionIds.has(sessionId) && !stoppedSessionIds?.has(sessionId)) continue;
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
    isConnected,
    reconcileRunningSessions,
  }), [sendMessage, subscribe, isConnected, reconcileRunningSessions]);

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
