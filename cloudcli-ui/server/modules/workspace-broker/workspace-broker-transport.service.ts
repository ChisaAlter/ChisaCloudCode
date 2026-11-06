import { createServer, request as httpRequest } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { once } from 'node:events';
import { chmod, chown, lstat, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';

import type { createWorkspaceBroker } from './workspace-broker.service.js';

function validSocket(socketPath: string) {
  if (process.platform === 'win32') return /^\\\\\.\\pipe\\chisa-broker-[A-Za-z0-9_-]+$/.test(socketPath);
  return path.isAbsolute(socketPath) && path.resolve(socketPath) === socketPath && !/[\0\r\n]/.test(socketPath);
}
function failure(code: string) { return Object.assign(new Error(code),{ code }); }

/** The independent operator launcher exposes only these business methods on a
 * private Unix socket. The business API cannot enroll paths or forward Docker URLs. */
export async function createWorkspaceBrokerServer(broker: Awaited<ReturnType<typeof createWorkspaceBroker>>, options: { socketPath: string; maxRequestsPerMinute?: number; clientGroupId?: number }) {
  if (!validSocket(options.socketPath)) throw failure('BROKER_SOCKET_INVALID');
  if (process.platform !== 'win32') {
    const parent = path.dirname(options.socketPath);
    const metadata = await lstat(parent);
    if (await realpath(parent) !== parent || !metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o027) !== 0 ||
      (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) ||
      (options.clientGroupId !== undefined && (!Number.isInteger(options.clientGroupId) || options.clientGroupId <= 0 || metadata.gid !== options.clientGroupId))) throw failure('BROKER_SOCKET_DIRECTORY');
    // A stale socket is an operator decision. Never unlink a path selected by an
    // API process or assume a failed connection proves no broker is running.
    const exists = await lstat(options.socketPath).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; });
    if (exists) throw failure('BROKER_SOCKET_EXISTS');
  }
  let windowStart = Date.now(); let requestCount = 0; let active = 0;
  const responses = new Set<ServerResponse>();
  const server = createServer(async (request,response) => {
    responses.add(response);
    response.once('close',() => responses.delete(response));
    const controller = new AbortController();
    let counted = false;
    response.once('close',() => { if (!response.writableFinished) controller.abort(failure('BROKER_CLIENT_DISCONNECTED')); });
    const send = (status: number, body: unknown) => {
      if (response.destroyed) return;
      response.writeHead(status,{ 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      response.end(JSON.stringify(body));
    };
    try {
      if (Date.now() - windowStart >= 60000) { windowStart = Date.now(); requestCount = 0; }
      if (++requestCount > (options.maxRequestsPerMinute ?? 600) || active >= 64) { send(429,{ error: 'BROKER_RATE_LIMIT' }); return; }
      active++; counted = true;
      if (request.method !== 'POST' || !/^\/v1\/(?:run|exec|status|cancel|reconcile|network|logs|preview|stdin|stream|retire|quiesce)$/.test(request.url ?? '') || request.headers['content-type'] !== 'application/json') throw failure('BROKER_ROUTE_INVALID');
      const authorization = request.headers.authorization;
      if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ') || authorization.length > 8200) throw failure('BROKER_UNAUTHORIZED');
      const proof = authorization.slice(7);
      const chunks: Buffer[] = []; let length = 0;
      if (Number(request.headers['content-length'] ?? 0) > 256 * 1024) throw failure('BROKER_BODY_LIMIT');
      for await (const chunk of request) {
        length += chunk.length;
        if (length > 256 * 1024) throw failure('BROKER_BODY_LIMIT');
        chunks.push(Buffer.from(chunk));
      }
      let body: any;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw failure('BROKER_JSON_INVALID'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw failure('BROKER_INVALID_REQUEST');
      const route = request.url!.slice(4);
      if (route === 'run') { send(200,await broker.run(proof,body,{ signal: controller.signal })); return; }
      if (route === 'exec') { send(200,await broker.exec(proof,body,{ signal: controller.signal })); return; }
      const allowed = route === 'quiesce' ? ['workspaceId','generation','leaseId'] : route === 'stdin' ? ['operationId','sequence','data','end'] : route === 'network' || route === 'retire' ? ['workspaceId'] : ['operationId'];
      if (Object.keys(body).some(key => !allowed.includes(key))) throw failure('BROKER_INVALID_REQUEST');
      if (route === 'stream') {
        const stream = await broker.stream(proof,body.operationId,{ signal: controller.signal });
        response.writeHead(200,{ 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        response.flushHeaders();
        try {
          let result;
          for (;;) {
            const next = await stream.next();
            if (next.done) { result = next.value; break; }
            const frame = next.value;
            if (!response.write(JSON.stringify({ channel: frame.channel, data: frame.data.toString('base64') }) + '\n')) await once(response,'drain',{ signal: controller.signal });
          }
          // The stream's already-authorized lifetime provides its final receipt;
          // a short grant expiring during a long run must not erase exit status.
          response.end(JSON.stringify({ complete: true, result }) + '\n');
        } finally { await stream.return(); }
        return;
      }
      if (route === 'stdin') {
        if (typeof body.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.data)) throw failure('BROKER_STDIN_INVALID');
        send(200,await broker.writeStdin(proof,body.operationId,{ sequence: body.sequence, data: Buffer.from(body.data,'base64'), end: body.end })); return;
      }
      if (route === 'logs') {
        const result = await broker.logs(proof,body.operationId);
        send(200,{ multiplexed: result.multiplexed.toString('base64') }); return;
      }
      const result = route === 'quiesce' ? await broker.quiesceLease(proof,body) : route === 'status' ? await broker.status(proof,body.operationId) : route === 'cancel' ? await broker.cancel(proof,body.operationId) :
        route === 'reconcile' ? await broker.reconcile(proof,body.operationId) : route === 'network' ? await broker.network(proof,body.workspaceId) :
        route === 'preview' ? await broker.previewTarget(proof,body.operationId) : await broker.retireLegacy(proof,body.workspaceId);
      send(200,result);
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^BROKER_[A-Z_]+$/.test(error.code) ? error.code : 'BROKER_UNAVAILABLE';
      send(code === 'BROKER_UNAUTHORIZED' ? 403 : code.includes('INVALID') || code.includes('LIMIT') ? 400 : 503,{ error: code });
    } finally { if (counted) active--; }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.keepAliveTimeout = 1000; server.maxConnections = 64;
  server.on('clientError',(_error,socket) => socket.destroy());
  await new Promise<void>((resolve,reject) => { server.once('error',reject); server.listen(options.socketPath,() => { server.off('error',reject); resolve(); }); });
  if (process.platform !== 'win32') {
    if (options.clientGroupId !== undefined) await chown(options.socketPath,process.getuid!(),options.clientGroupId);
    await chmod(options.socketPath,options.clientGroupId === undefined ? 0o600 : 0o660);
  }
  const socketPin = process.platform === 'win32' ? undefined : await lstat(options.socketPath);
  return {
    async close() {
      for (const response of responses) response.destroy();
      await new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve()));
      if (socketPin) {
        const current = await lstat(options.socketPath).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; });
        if (current?.isSocket() && current.dev === socketPin.dev && current.ino === socketPin.ino) await unlink(options.socketPath);
      }
    },
  };
}

/** Workspace-runtime/bridge consumers use this Unix-socket client after obtaining
 * an independent issuer proof. It has no Docker CLI/socket fallback. No call is
 * automatically retried; run/exec replay must use the original operationId. */
export function createWorkspaceBrokerClient(options: { socketPath: string; timeoutMs?: number }) {
  if (!validSocket(options.socketPath)) throw failure('BROKER_SOCKET_INVALID');
  const send = (route: string, proof: string, body: unknown, signal?: AbortSignal): Promise<IncomingMessage> => new Promise((resolve,reject) => {
    const encoded = Buffer.from(JSON.stringify(body));
    if (encoded.length > 256 * 1024 || !proof || proof.length > 8192) { reject(failure('BROKER_REQUEST_LIMIT')); return; }
    const request = httpRequest({ socketPath: options.socketPath, method: 'POST', path: '/v1/' + route, signal,
      headers: { Authorization: 'Bearer ' + proof, 'Content-Type': 'application/json', 'Content-Length': encoded.length } },response => {
      if (response.statusCode !== 200) {
        const chunks: Buffer[] = []; let bytes = 0;
        response.on('data',(chunk: Buffer) => { bytes += chunk.length; if (bytes > 65536) response.destroy(failure('BROKER_RESPONSE_LIMIT')); else chunks.push(chunk); });
        response.on('error',reject);
        response.on('end',() => {
          let code = 'BROKER_REQUEST_FAILED';
          try { const body = JSON.parse(Buffer.concat(chunks).toString()); if (/^BROKER_[A-Z_]+$/.test(body.error)) code = body.error; } catch { /* Fixed safe error. */ }
          reject(failure(code));
        });
      } else resolve(response);
    });
    const timer = setTimeout(() => request.destroy(failure('BROKER_REQUEST_TIMEOUT')),options.timeoutMs ?? 20000); timer.unref();
    request.on('error',reject);
    request.once('response',() => clearTimeout(timer));
    request.once('close',() => clearTimeout(timer)); request.end(encoded);
  });
  const json = async <T>(route: string, proof: string, body: unknown, signal?: AbortSignal): Promise<T> => {
    const response = await send(route,proof,body,signal);
    const chunks: Buffer[] = []; let bytes = 0;
    const timer = setTimeout(() => response.destroy(failure('BROKER_RESPONSE_TIMEOUT')),options.timeoutMs ?? 20000); timer.unref();
    try {
      for await (const chunk of response) {
        bytes += chunk.length; if (bytes > 90 * 1024 * 1024) throw failure('BROKER_RESPONSE_LIMIT'); chunks.push(Buffer.from(chunk));
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
    } finally { clearTimeout(timer); }
  };
  type Broker = Awaited<ReturnType<typeof createWorkspaceBroker>>;
  type Result = Awaited<ReturnType<Broker['run']>>;
  return {
    run(proof: string, request: Parameters<Broker['run']>[1], options: { signal?: AbortSignal } = {}) { return json<Result>('run',proof,request,options.signal); },
    exec(proof: string, request: Parameters<Broker['exec']>[1], options: { signal?: AbortSignal } = {}) { return json<Result>('exec',proof,request,options.signal); },
    status(proof: string, operationId: string) { return json<Result>('status',proof,{ operationId }); },
    cancel(proof: string, operationId: string) { return json<Result>('cancel',proof,{ operationId }); },
    reconcile(proof: string, operationId: string) { return json<Result>('reconcile',proof,{ operationId }); },
    network(proof: string, workspaceId: string) { return json<{ networkId: string }>('network',proof,{ workspaceId }); },
    quiesceLease(proof: string, input: Parameters<Broker['quiesceLease']>[1]) { return json<Awaited<ReturnType<Broker['quiesceLease']>>>('quiesce',proof,input); },
    previewTarget(proof: string, operationId: string) { return json<{ host: string; port: number; resourceId: string }>('preview',proof,{ operationId }); },
    retireLegacy(proof: string, workspaceId: string) { return json<{ retired: boolean; resourceId: string }>('retire',proof,{ workspaceId }); },
    async logs(proof: string, operationId: string) { const result = await json<{ multiplexed: string }>('logs',proof,{ operationId }); return { multiplexed: Buffer.from(result.multiplexed,'base64') }; },
    writeStdin(proof: string, operationId: string, input: Parameters<Broker['writeStdin']>[2]) {
      return json<{ sequence: number; replay: boolean }>('stdin',proof,{ operationId, sequence: input.sequence, data: input.data.toString('base64'), end: input.end });
    },
    async stream(proof: string, operationId: string, options: { signal?: AbortSignal } = {}) {
      const response = await send('stream',proof,{ operationId },options.signal);
      const iterator = (async function* () {
        let pending = ''; let bytes = 0;
        try {
          for await (const chunk of response) {
            bytes += chunk.length; if (bytes > 90 * 1024 * 1024) throw failure('BROKER_RESPONSE_LIMIT');
            pending += chunk.toString('utf8');
            let index: number;
            while ((index = pending.indexOf('\n')) >= 0) {
              const line = pending.slice(0,index); pending = pending.slice(index+1);
              if (line.length > 1500000) throw failure('BROKER_FRAME_LIMIT');
              const frame = JSON.parse(line);
              if (frame.complete === true) return frame.result as Result;
              if (!['stdout','stderr'].includes(frame.channel) || typeof frame.data !== 'string') throw failure('BROKER_FRAME_INVALID');
              yield { channel: frame.channel as 'stdout' | 'stderr', data: Buffer.from(frame.data,'base64') };
            }
            if (pending.length > 1500000) throw failure('BROKER_FRAME_LIMIT');
          }
          throw failure('BROKER_STREAM_LOST');
        } finally { response.destroy(); }
      })();
      return {
        [Symbol.asyncIterator]() { return this; }, next() { return iterator.next(); },
        async return() { response.destroy(); return iterator.return(undefined as never); },
        async throw(error: unknown) { response.destroy(); return iterator.throw(error); },
      };
    },
  };
}
