import type { AuthenticatedWebSocketRequest } from '@/shared/index.js';

/** Chat and Shell capture only the authenticated handshake's account id, never payload fields or usernames. */
export function readWebSocketUserId(request: AuthenticatedWebSocketRequest | undefined): string | number | null {
  const value = request?.user?.id ?? request?.user?.userId;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() && !/[\r\n\0]/.test(value)) return value;
  return null;
}
