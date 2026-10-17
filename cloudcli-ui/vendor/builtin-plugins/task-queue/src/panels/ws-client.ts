/**
 * WebSocket client with auto-reconnect for live task queue updates.
 * Connects through CloudCLI's plugin WebSocket proxy at /plugin-ws/task-queue.
 */

export type WsEvent = {
  type: string;
  [key: string]: unknown;
};

export type WsListener = (event: WsEvent) => void;

/**
 * Reconnect backoff: 5s, 10s, 30s, then 30s forever. Reset to the first step on a
 * successful open.
 *
 * A fixed 5s retry against a persistent outage is what produced 2239 identical
 * "WS proxy error" lines in cloudcli-error.log over three weeks — enough noise to
 * bury anything else in that log.
 *
 * Exported for tests: the schedule is the behaviour, and it is not observable
 * through the client without waiting real seconds.
 */
export const RECONNECT_DELAYS_MS = [5000, 10000, 30000] as const;

export function reconnectDelayMs(attempt: number): number {
  const i = Math.min(Math.max(attempt, 0), RECONNECT_DELAYS_MS.length - 1);
  return RECONNECT_DELAYS_MS[i];
}

export interface WsClient {
  readonly connected: boolean;
  onEvent(listener: WsListener): () => void;
  close(): void;
}

export function createWsClient(): WsClient {
  const listeners = new Set<WsListener>();
  let ws: WebSocket | null = null;
  let connected = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let reconnectAttempt = 0;

  function getWsUrl(): string {
    return (window as any).chisaPluginWebSocketUrl('task-queue');
  }

  function emit(event: WsEvent): void {
    for (const l of listeners) {
      try { l(event); } catch { /* skip */ }
    }
  }

  function connect(): void {
    if (closed) return;
    try {
      ws = new WebSocket(getWsUrl());

      ws.onopen = () => {
        connected = true;
        reconnectAttempt = 0;   // a real connect resets the backoff
        emit({ type: '_connected' });
      };

      ws.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data as string) as WsEvent;
          emit(data);
        } catch { /* skip unparseable */ }
      };

      ws.onclose = () => {
        connected = false;
        emit({ type: '_disconnected' });
        scheduleReconnect();
      };

      ws.onerror = () => {
        // onclose will fire after onerror
      };
    } catch {
      scheduleReconnect();
    }
  }

  function scheduleReconnect(): void {
    if (closed || reconnectTimer) return;
    const delay = reconnectDelayMs(reconnectAttempt);
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  connect();

  return {
    get connected() { return connected; },

    onEvent(listener: WsListener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    close(): void {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) ws.close();
    },
  };
}
