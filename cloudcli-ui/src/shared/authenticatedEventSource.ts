import { authenticatedFetch } from '@/shared/api';
import { dispatchWithAuthSession, getAuthSessionSnapshot, isCurrentAuthSession, subscribeToAuthSession } from '@/shared/authToken';
import { desktopHttpUrl, FrontendBridge, getServerTransportVersion, isDesktop, subscribeToServerConnection } from '@/shared/chisa';
import type { AuthSessionSnapshot } from '@/shared/types';
import { IS_PLATFORM } from '@/shared/utils';

const MAX_LINE_CHARS = 64 * 1024;
const MAX_EVENT_CHARS = 1024 * 1024;
const MAX_EVENT_LINES = 4096;
const MAX_STREAM_BYTES = 16 * 1024 * 1024;
const MAX_EVENTS = 10_000;
const CONNECT_TIMEOUT_MS = 15_000;
const BODY_TIMEOUT_MS = 30_000;
const CREDENTIAL_QUERY_KEYS = new Set(['token', 'access_token', 'accesstoken', 'authorization', 'auth', 'jwt', 'api_key', 'apikey']);

type StreamListener = (event: MessageEvent<string>) => void;

class EventStreamError extends Error {
  constructor(readonly code: string, readonly status?: number) { super(code); }
}

// Endpoint definitions remain in shared/api. Refuse pre-resolved capabilities or URL credentials.
function requireApiPath(path: string): string {
  const parsed = new URL(path, 'https://sse.invalid');
  if (!path.startsWith('/api/') || parsed.origin !== 'https://sse.invalid' || parsed.hash
    || path.includes('\\') || parsed.pathname !== path.split('?')[0]
    || [...parsed.searchParams.keys()].some(key => CREDENTIAL_QUERY_KEYS.has(key.toLowerCase()))) {
    throw new EventStreamError('SSE_INVALID_API_PATH');
  }
  return path;
}

// Streaming UTF-8 decoding happens outside this line parser; CRLF may be split across any two reads.
function createParser(deliver: (type: string, data: string, id: string) => boolean) {
  let fragments: string[] = [];
  let lineChars = 0;
  let skipLF = false;
  let eventType = '';
  let lastEventId = '';
  let data: string[] = [];
  let eventChars = 0;
  let eventLines = 0;
  let events = 0;

  const append = (part: string) => {
    lineChars += part.length;
    if (lineChars > MAX_LINE_CHARS) throw new EventStreamError('SSE_LINE_LIMIT');
    if (part) fragments.push(part);
  };
  const consumeLine = (): boolean => {
    const line = fragments.join('');
    fragments = [];
    lineChars = 0;
    if (line === '') {
      const type = eventType || 'message';
      const payload = data.join('\n');
      const hasData = data.length > 0;
      data = [];
      eventType = '';
      eventChars = 0;
      eventLines = 0;
      if (!hasData) return true;
      if (++events > MAX_EVENTS) throw new EventStreamError('SSE_EVENT_COUNT_LIMIT');
      return deliver(type, payload, lastEventId);
    }
    eventChars += line.length + 1;
    if (eventChars > MAX_EVENT_CHARS || ++eventLines > MAX_EVENT_LINES) throw new EventStreamError('SSE_EVENT_LIMIT');
    if (line.startsWith(':')) return true;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') eventType = value;
    else if (field === 'id' && !value.includes('\0')) lastEventId = value;
    // retry and unknown fields do not change this one-shot GET's no-replay policy.
    return true;
  };
  return (text: string): boolean => {
    let start = 0;
    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      if (skipLF) {
        skipLF = false;
        if (char === '\n') { start = index + 1; continue; }
      }
      if (char !== '\r' && char !== '\n') continue;
      append(text.slice(start, index));
      start = index + 1;
      skipLF = char === '\r';
      if (!consumeLine()) return false;
    }
    append(text.slice(start));
    return true;
  };
}

/** Sidebar and command-palette searches consume authenticated, cancellable SSE without URL bearer credentials or replay. */
export function createAuthenticatedEventSource(path: string, options: {
  expectedSession?: AuthSessionSnapshot;
  signal?: AbortSignal;
  connectTimeoutMs?: number;
  bodyTimeoutMs?: number;
} = {}) {
  const expected = options.expectedSession ?? getAuthSessionSnapshot();
  const native = isDesktop();
  const nativeHandle = expected.nativeHandle;
  const transport = getServerTransportVersion();
  const controller = new AbortController();
  const listeners = new Map<string, Set<StreamListener>>();
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let response: Response | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let readerCanceled = false;
  let stopAuth = () => {};
  let stopTransport = () => {};

  const current = () => !closed && !controller.signal.aborted && !options.signal?.aborted
    && isCurrentAuthSession(expected) && getServerTransportVersion() === transport
    && (getAuthSessionSnapshot().phase === 'ready' || (!native && IS_PLATFORM && getAuthSessionSnapshot().phase === 'signedOut'))
    && (!native || Boolean(nativeHandle && getAuthSessionSnapshot().nativeHandle === nativeHandle));
  const interrupted = () => new DOMException('Event stream canceled or account session changed', 'AbortError');
  const assertCurrent = () => { if (!current()) throw interrupted(); };
  const discard = (late: Response) => { if (late.body && !late.body.locked) void late.body.cancel().catch(() => {}); };
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    controller.abort(interrupted());
    stopAuth();
    stopTransport();
    options.signal?.removeEventListener('abort', close);
    listeners.clear();
    if (reader && !readerCanceled) {
      readerCanceled = true;
      void reader.cancel().catch(() => {});
    } else if (!reader && response) discard(response);
  };
  const deliver = (type: string, data: string, id = '') => {
    if (!current()) { close(); return false; }
    const event = new MessageEvent<string>(type, { data, lastEventId: id });
    for (const listener of [...(listeners.get(type) ?? [])]) {
      if (!current()) { close(); return false; }
      try { listener(event); } catch { /* A consumer exception must not restart or corrupt the stream. */ }
    }
    if (type === 'done' || type === 'error') close();
    return current();
  };
  const fail = (error: unknown) => {
    if (current()) {
      const failure = error instanceof EventStreamError ? error : new EventStreamError('SSE_CONNECTION_FAILED');
      deliver('error', JSON.stringify({ error: failure.code, ...(failure.status === undefined ? {} : { status: failure.status }) }));
    }
    close();
  };
  const armDeadline = (milliseconds: number | undefined, fallback: number, code: string) => {
    clearTimeout(timer);
    const duration = Number.isFinite(milliseconds) ? Math.max(1, Math.min(milliseconds!, 300_000)) : fallback;
    timer = setTimeout(() => fail(new EventStreamError(code)), duration);
  };
  // A bridge lookup or a custom fetch/reader may ignore abort; release the caller immediately anyway.
  const bounded = <T,>(operation: Promise<T>): Promise<T> => {
    if (!current()) { void operation.catch(() => {}); return Promise.reject(interrupted()); }
    return new Promise<T>((resolve, reject) => {
      const abort = () => { controller.signal.removeEventListener('abort', abort); reject(interrupted()); };
      controller.signal.addEventListener('abort', abort, { once: true });
      operation.then(value => { controller.signal.removeEventListener('abort', abort); resolve(value); }, error => {
        controller.signal.removeEventListener('abort', abort); reject(error);
      });
    });
  };
  const observeResponse = (pending: Promise<Response>): Promise<Response> => {
    // Retire late bodies even when abort won the race before headers became visible.
    void pending.then(late => {
      if (!current()) discard(late);
      else response = late; // Own the body even if admission is canceled before the awaiting continuation resumes.
    }, () => {});
    return pending;
  };

  stopAuth = subscribeToAuthSession(() => { if (!current()) close(); });
  stopTransport = subscribeToServerConnection(() => { if (!current()) close(); });
  options.signal?.addEventListener('abort', close, { once: true });

  const start = async () => {
    try {
      assertCurrent();
      const apiPath = requireApiPath(path);
      armDeadline(options.connectTimeoutMs, CONNECT_TIMEOUT_MS, 'SSE_CONNECT_TIMEOUT');
      if (native) {
        // Never use the buffered ServerRequest bridge for SSE. This lookup cannot upgrade the captured login.
        assertCurrent();
        const connection = await bounded(FrontendBridge.getApiConnection());
        assertCurrent();
        if (connection.sessionHandle !== nativeHandle || connection.serverKey !== expected.serverKey
          || connection.generation !== expected.nativeGeneration || !connection.authenticated || connection.switching) throw interrupted();
        assertCurrent();
        const capabilityUrl = desktopHttpUrl(apiPath);
        assertCurrent();
        const admission = await bounded(dispatchWithAuthSession(expected, () => {
          assertCurrent();
          // The immutable local capability injects the captured native bearer upstream, never a renderer token.
          return observeResponse(fetch(capabilityUrl, { method: 'GET', headers: { Accept: 'text/event-stream' },
            signal: controller.signal, cache: 'no-store', credentials: 'omit', redirect: 'error' }));
        }));
        assertCurrent();
        response = await bounded(admission.operation);
        assertCurrent();
      } else {
        response = await bounded(observeResponse(authenticatedFetch(apiPath, { expectedSession: expected,
          method: 'GET', headers: { Accept: 'text/event-stream' }, signal: controller.signal, redirect: 'error' })));
        assertCurrent();
      }
      if (!response.ok) throw new EventStreamError('SSE_HTTP_ERROR', response.status);
      if (response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'text/event-stream') {
        throw new EventStreamError('SSE_CONTENT_TYPE');
      }
      if (!response.body) throw new EventStreamError('SSE_MISSING_BODY');
      reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      const parse = createParser(deliver);
      let bytes = 0;
      while (current()) {
        armDeadline(options.bodyTimeoutMs, BODY_TIMEOUT_MS, 'SSE_BODY_TIMEOUT');
        const chunk = await bounded(reader.read());
        assertCurrent();
        if (chunk.done) {
          if (!parse(decoder.decode())) return;
          // No final delimiter means no final event; only an explicit done/error terminates normally.
          throw new EventStreamError('SSE_UNEXPECTED_EOF');
        }
        bytes += chunk.value.byteLength;
        if (bytes > MAX_STREAM_BYTES) throw new EventStreamError('SSE_STREAM_LIMIT');
        if (!parse(decoder.decode(chunk.value, { stream: true }))) return;
      }
    } catch (error) {
      fail(error);
    } finally {
      close();
      if (reader) {
        try { reader.releaseLock(); } catch { /* A canceled nonstandard reader may still have a pending read. */ }
        reader = null;
      }
    }
  };
  // Registration remains synchronous, including when validation fails before the first network await.
  queueMicrotask(() => { void start(); });
  return {
    addEventListener(type: string, listener: StreamListener) {
      if (closed) return;
      const registered = listeners.get(type) ?? new Set<StreamListener>();
      registered.add(listener);
      listeners.set(type, registered);
    },
    removeEventListener(type: string, listener: StreamListener) { listeners.get(type)?.delete(listener); },
    close,
  };
}
