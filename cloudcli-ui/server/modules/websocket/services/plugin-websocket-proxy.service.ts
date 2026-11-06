import { WebSocket, type RawData } from 'ws';

type PluginProxyDependencies = {
  getPluginPort: (pluginName: string) => number | null;
  authorizePluginAccess: (pluginName: string, userId: number, resource: 'websocket') => unknown;
  userId: number;
  isSessionActive: () => boolean;
};

function payloadBytes(data: RawData): number {
  return Array.isArray(data) ? data.reduce((sum, chunk) => sum + chunk.byteLength, 0) : data.byteLength;
}

/** Gateway exposes only an approved owner's plugin, with bounded pending frames, backpressure and bidirectional cleanup. */
export function handlePluginWsProxy(clientWs: WebSocket, pathname: string, dependencies: PluginProxyDependencies): void {
  const match = /^\/plugin-ws\/([A-Za-z0-9_-]+)$/.exec(pathname);
  if (!match || !Number.isSafeInteger(dependencies.userId) || dependencies.userId <= 0) {
    clientWs.close(4400, 'Invalid plugin request');
    return;
  }
  const pluginName = match[1];
  const maxBytes = 256 * 1024;
  const maxQueueBytes = 512 * 1024;
  const maxQueueFrames = 16;
  const highWater = 512 * 1024;
  const queue: { data: RawData; binary: boolean }[] = [];
  let queuedBytes = 0;
  let upstream: WebSocket | null = null;
  let stopped = false;
  let lastActivity = Date.now();
  const terminators = new Set<NodeJS.Timeout>();

  const stop = (code: number, reason: string) => {
    if (stopped) return;
    stopped = true;
    clearInterval(sweep);
    queue.length = 0;
    queuedBytes = 0;
    for (const socket of [clientWs, upstream]) {
      if (!socket || socket.readyState === WebSocket.CLOSED) continue;
      if (socket.readyState === WebSocket.CONNECTING) { socket.terminate(); continue; }
      socket.close(code, reason);
      const timer = setTimeout(() => { terminators.delete(timer); socket.terminate(); }, 1000);
      timer.unref();
      terminators.add(timer);
      socket.once('close', () => { clearTimeout(timer); terminators.delete(timer); });
    }
  };
  const allowed = () => {
    if (stopped || !dependencies.isSessionActive()) return false;
    try {
      // The plugins contract is synchronous: no network/fs work or user-controlled wait may open an authorization race.
      const result = dependencies.authorizePluginAccess(pluginName, dependencies.userId, 'websocket');
      if (result instanceof Promise) { void result.catch(() => {}); return false; }
      return result !== false;
    } catch { return false; }
  };
  const forward = (target: WebSocket, data: RawData, binary: boolean) => {
    if (!allowed()) { stop(4403, 'Plugin access ended'); return; }
    const bytes = payloadBytes(data);
    if (bytes > maxBytes || target.bufferedAmount + bytes > highWater) { stop(4408, 'Proxy buffer limit exceeded'); return; }
    if (target.readyState !== WebSocket.OPEN) { stop(4502, 'Upstream unavailable'); return; }
    lastActivity = Date.now();
    target.send(data, { binary }, error => { if (error) stop(4502, 'Proxy send failed'); });
  };
  const sweep = setInterval(() => {
    if (!allowed()) stop(4403, 'Plugin access ended');
    else if (Date.now() - lastActivity >= 60_000) stop(4408, 'Proxy idle timeout');
  }, 1000);
  sweep.unref();

  clientWs.on('message', (data: RawData, binary: boolean) => {
    if (!allowed()) { stop(4403, 'Plugin access ended'); return; }
    const bytes = payloadBytes(data);
    if (bytes > maxBytes) { stop(4408, 'Proxy frame limit exceeded'); return; }
    if (upstream?.readyState === WebSocket.OPEN) { forward(upstream, data, binary); return; }
    if (queue.length >= maxQueueFrames || queuedBytes + bytes > maxQueueBytes) { stop(4408, 'Proxy queue limit exceeded'); return; }
    queue.push({ data, binary });
    queuedBytes += bytes;
    lastActivity = Date.now();
  });
  clientWs.once('close', () => stop(1000, 'Client closed'));
  clientWs.once('error', () => stop(1011, 'Client error'));

  // Authorize before looking up or opening any upstream process/port.
  if (!allowed()) { stop(4403, 'Plugin access denied'); return; }
  let port: number | null;
  try { port = dependencies.getPluginPort(pluginName); } catch { stop(4502, 'Plugin unavailable'); return; }
  if (!Number.isSafeInteger(port) || !port || port < 1 || port > 65535) { stop(4404, 'Plugin not running'); return; }
  try { upstream = new WebSocket(`ws://127.0.0.1:${port}/ws`, { maxPayload: maxBytes, handshakeTimeout: 5000, perMessageDeflate: false }); }
  catch { stop(4502, 'Upstream unavailable'); return; }
  upstream.on('open', () => {
    if (!allowed() || !upstream) { stop(4403, 'Plugin access ended'); return; }
    for (const frame of queue.splice(0)) {
      if (stopped) break;
      forward(upstream, frame.data, frame.binary);
    }
    queuedBytes = 0;
  });
  upstream.on('message', (data, binary) => forward(clientWs, data, binary));
  upstream.once('close', () => stop(1000, 'Upstream closed'));
  upstream.once('error', () => stop(4502, 'Upstream error'));
}
