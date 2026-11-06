import type { RealtimeClientConnection } from '@/shared/types.js';

/**
 * Numeric readyState for an open WebSocket connection.
 *
 * We keep this in module state so services that broadcast updates do not need
 * to import `ws` directly just to compare open/closed state.
 */
export const WS_OPEN_STATE = 1;

/**
 * Shared registry of active chat WebSocket connections.
 *
 * Project/session services publish realtime updates by iterating this set.
 */
export const connectedClients = new Set<RealtimeClientConnection>();

const connectedClientOwners = new WeakMap<RealtimeClientConnection, string>();

/** Chat handshake records authenticated identity for SSH-scoped realtime broadcasts. */
export function setConnectedClientUserId(client: RealtimeClientConnection, userId: string | number | null): void {
  if (userId === null) connectedClientOwners.delete(client);
  else connectedClientOwners.set(client, String(userId));
}

/** Missing identity never authorizes an SSH broadcast; legacy cloud broadcasts stay instance-wide. */
export function getConnectedClientUserId(client: RealtimeClientConnection): string | undefined {
  return connectedClientOwners.get(client);
}

/** Account-scoped realtime fan-out used by the SSH workspace event service; only the owner's open sockets receive the serialized frame. */
export function broadcastToUser(userId: string, payload: string): number {
  let delivered = 0;
  for (const client of connectedClients) {
    if (getConnectedClientUserId(client) !== userId || client.readyState !== WS_OPEN_STATE) continue;
    try {
      client.send(payload);
      delivered += 1;
    } catch { /* A closing socket simply misses this advisory update. */ }
  }
  return delivered;
}
