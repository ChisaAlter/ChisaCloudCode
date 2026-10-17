import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { createServer } from 'node:net';
import type { AddressInfo, Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

test('gateway signal shutdown closes upgraded and unfinished HTTP connections within its deadline', { timeout: 15_000 }, async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'chisa-gateway-shutdown-'));
  const keyPath = path.join(fixture, 'key.pem');
  const certPath = path.join(fixture, 'cert.pem');
  const openssl = process.platform === 'win32' ? 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe' : 'openssl';
  await promisify(execFile)(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath,
    '-out', certPath, '-subj', '/CN=localhost', '-days', '1'], { timeout: 10_000 });
  const upstreamSockets = new Set<Socket>();
  const upstream = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/plain' });
    response.write('unfinished');
  });
  upstream.on('connection', socket => {
    upstreamSockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => upstreamSockets.delete(socket));
  });
  upstream.on('upgrade', (request, socket) => {
    const accept = createHash('sha1').update(String(request.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const reservation = createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = (reservation.address() as AddressInfo).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const configPath = path.join(fixture, 'gateway.json');
  await writeFile(configPath, JSON.stringify({ defaultInstance: 'main', accounts: {}, instances: {
    main: { port: (upstream.address() as AddressInfo).port, workspaceServerUrl: 'http://localhost' },
  } }));
  const sourceTest = new URL(import.meta.url).pathname.endsWith('.ts');
  const entry = process.env.GATEWAY_TEST_ENTRY ?? new URL(`../../../desktop-gateway.${sourceTest ? 'ts' : 'js'}`, import.meta.url).href;
  const loaderArguments = new URL(entry).pathname.endsWith('.ts') ? ['--import', 'tsx'] : [];
  // Windows cannot deliver POSIX signals to Node. IPC raises the same production
  // signal handler there; on Linux this test sends the actual OS SIGTERM.
  const child = spawn(process.execPath, [...loaderArguments, '--input-type=module', '-e',
    `process.on('message', signal => process.emit(signal)); await import(${JSON.stringify(entry)});`], {
    env: { ...process.env, CHISA_GATEWAY_CONFIG: configPath, CHISA_GATEWAY_KEY: keyPath, CHISA_GATEWAY_CERT: certPath,
      CHISA_GATEWAY_HOST: '127.0.0.1', CHISA_GATEWAY_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  });
  let webSocket: Socket | undefined;
  let unfinished: http.ClientRequest | undefined;
  let startupStderr = '';
  child.stderr!.on('data', chunk => { startupStderr = (startupStderr + String(chunk)).slice(-2048); });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => reject(new Error(`gateway exited before ready: ${code}\n${startupStderr}`)));
      child.stdout!.on('data', chunk => { if (String(chunk).includes('gateway is listening')) resolve(); });
    });
    webSocket = await new Promise<Socket>((resolve, reject) => {
      const request = https.get({ hostname: '127.0.0.1', port, path: '/ws', rejectUnauthorized: false,
        headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' } });
      request.on('upgrade', (response, socket) => { assert.equal(response.statusCode, 101); resolve(socket as Socket); });
      request.on('error', reject);
    });
    // A deadline closes a raw tunnel; TCP may report a reset before close.
    webSocket.on('error', () => {});
    const websocketClosed = new Promise<void>(resolve => webSocket!.once('close', resolve));
    const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
      unfinished = https.get({ hostname: '127.0.0.1', port, path: '/api/hang', rejectUnauthorized: false }, resolve);
      unfinished.on('error', reject);
    });
    response.on('error', () => {});
    response.resume();
    const responseClosed = new Promise<void>(resolve => response.once('close', resolve));
    const exited = once(child, 'exit');
    const started = Date.now();
    if (process.platform === 'win32') child.send('SIGTERM'); else child.kill('SIGTERM');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 4000);
    const [code, signal] = await exited;
    clearTimeout(timeout);
    assert.equal(code, 0, `gateway did not drain before forced termination (${signal})`);
    assert.ok(Date.now() - started < 3500, 'shutdown exceeded the bounded grace period');
    await Promise.all([websocketClosed, responseClosed]);
  } finally {
    webSocket?.destroy();
    unfinished?.destroy();
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
    for (const socket of upstreamSockets) socket.destroy();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    await rm(fixture, { recursive: true, force: true });
  }
});
