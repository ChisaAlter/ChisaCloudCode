/**
 * WebSocket upgrade authorization.
 *
 * Extracted from server.ts for the same reason control-api.ts was: server.ts calls
 * server.listen() at import time, so a test that imports it boots a real listener.
 * The decision is a pure function of (peer address, Origin header, allowlist).
 */

// req.socket.remoteAddress spellings for a loopback peer. Node reports the
// IPv4-mapped form on a dual-stack socket, so all three are the same peer.
const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export interface UpgradeDecision {
  allow: boolean;
  /** Populated only when allow is false — logged, never sent to the client. */
  reason?: string;
}

/**
 * The Origin values a browser leg may present. CLOUDCLI_ORIGIN is how the operator
 * actually reaches CloudCLI; the two literals are the local-dev defaults.
 */
export function allowedOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    env.CLOUDCLI_ORIGIN ?? '',
    'http://localhost:3001',
    'http://127.0.0.1:3001',
  ].filter(Boolean);
}

/**
 * Gate on the peer, then on the Origin if one is present.
 *
 * The peer check is the real boundary: the server binds 127.0.0.1 on an ephemeral
 * port, so a non-loopback peer cannot legitimately occur and is refused outright.
 *
 * A loopback peer with NO Origin is CloudCLI's own plugin WS proxy — it uses the
 * `ws` client library, which sends no Origin header unless one is passed explicitly,
 * and that leg is already authenticated by CloudCLI's verifyClient before the proxy
 * is invoked. A loopback peer WITH an Origin is a browser reaching the port directly
 * and must still match the allowlist.
 */
export function evaluateUpgrade(
  peer: string | undefined,
  origin: string | undefined,
  allowed: string[],
): UpgradeDecision {
  if (!peer || !LOOPBACK_PEERS.has(peer)) {
    return { allow: false, reason: `non-loopback peer: ${peer ?? '<unknown>'}` };
  }
  if (origin && !allowed.includes(origin)) {
    return { allow: false, reason: `origin not allowed: ${origin}` };
  }
  return { allow: true };
}
