import { createInterface } from 'node:readline';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

import express from 'express';

import { AppError, asyncHandler } from '@/shared/index.js';

import { createAgentRelayBroker } from '../agent-relay.service.js';

// Standalone loopback fixture for real Go-native/Node-broker compatibility
// tests. Never import it from application startup or supply a production token.
const qaDirectory = process.env.CHISA_RELAY_QA_DIR;
if (!qaDirectory || !path.isAbsolute(qaDirectory)) throw new Error('CHISA_RELAY_QA_DIR must name an absolute isolated test directory.');
mkdirSync(qaDirectory, { recursive: true });
const owner = 'relay-native-qa';
const registry = new Map<string, { token: string; delivery: 'relay'; name: string; port: number }>();
const broker = createAgentRelayBroker({ lookup: (account, id) => account === owner ? registry.get(id) ?? null : null });
const calls = new Map<string, { controller: AbortController; connectionId: string; state: 'pending' | 'completed' | 'failed'; result?: unknown; code?: string }>();
const events: Array<Record<string, unknown>> = [];
const faults = { poll: 0, ack: 0, result: 0 };
let sequence = 0;
let stopping = false;
let origin = '';
const app = express();
app.use(express.json({ limit: '50mb' }));

function record(event: string, details: Record<string, unknown> = {}) {
  const entry = { event, at: Date.now(), ...details };
  events.push(entry);
  if (events.length > 2048) events.shift();
  writeFileSync(path.join(qaDirectory!, 'reports.json'), JSON.stringify({ origin, events, requests: [...calls].map(([label, call]) => ({ label, connectionId: call.connectionId, state: call.state, result: call.result, code: call.code })) }));
  process.stdout.write(JSON.stringify(entry) + '\n');
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new AppError('A string value is required.', { code: 'INVALID_REQUEST', statusCode: 400 });
  return value;
}
function body(request: express.Request): Record<string, unknown> { return (request.body ?? {}) as Record<string, unknown>; }
function credential(request: express.Request): string { return request.get('X-Chisa-Agent-Token') ?? ''; }
function sendOrDrop(kind: keyof typeof faults, response: express.Response, value: unknown) {
  if (faults[kind] > 0) {
    faults[kind]--;
    record('response-dropped', { kind });
    response.destroy();
  } else response.set('Cache-Control', 'no-store').json(value);
}
function state() {
  return { ok: true, origin, faults, connections: [...registry.keys()].map(id => ({ id, ...broker.status(owner, id) })),
    requests: [...calls].map(([label, call]) => ({ label, connectionId: call.connectionId, state: call.state, code: call.code })), events };
}
async function enqueue(input: Record<string, unknown>) {
  const connectionId = text(input.connectionId);
  const registration = registry.get(connectionId);
  if (!registration) throw new AppError('Register the native Agent before enqueueing.', { code: 'QA_CONNECTION_MISSING', statusCode: 409 });
  if (!input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload)) throw new AppError('payload is required.', { code: 'INVALID_REQUEST', statusCode: 400 });
  const timeoutMs = input.timeoutMs === undefined ? 10_000 : Number(input.timeoutMs);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 650_000) throw new AppError('timeoutMs must be 1 to 650000.', { code: 'INVALID_REQUEST', statusCode: 400 });
  const label = input.label === undefined ? 'request-' + ++sequence : text(input.label);
  if (calls.has(label)) throw new AppError('A test label must be unique.', { code: 'QA_LABEL_EXISTS', statusCode: 409 });
  const call = { controller: new AbortController(), connectionId, state: 'pending' as const } as {
    controller: AbortController; connectionId: string; state: 'pending' | 'completed' | 'failed'; result?: unknown; code?: string;
  };
  calls.set(label, call);
  record('enqueued', { label, connectionId, deadlineAt: Date.now() + timeoutMs });
  try {
    const reply = await broker.call(owner, connectionId, registration.token, input.payload as Record<string, unknown>, call.controller.signal, { deadlineAt: Date.now() + timeoutMs });
    call.state = 'completed'; call.result = reply;
    record('call-completed', { label, status: reply.status });
    return { ok: true, label, response: reply };
  } catch (error) {
    call.state = 'failed'; call.code = error instanceof AppError ? error.code : 'QA_UNEXPECTED_ERROR';
    record('call-failed', { label, code: call.code, details: error instanceof AppError ? error.details : undefined });
    throw error;
  }
}
function shutdown() {
  if (stopping) return;
  stopping = true;
  for (const call of calls.values()) call.controller.abort();
  for (const id of registry.keys()) broker.invalidate(owner, id);
  record('shutdown');
  server.closeAllConnections();
  server.close(() => { process.exitCode = 0; });
}

app.post('/api/ssh-workspaces/agent/connections', asyncHandler(async (request, response) => {
  const input = body(request), id = text(input.id), token = text(input.token), name = text(input.name), port = Number(input.port);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id) || !/^[a-f0-9]{64}$/.test(token) || !Number.isInteger(port) || port < 1024 || port > 65535 || input.delivery !== 'relay') {
    throw new AppError('A relay registration is required.', { code: 'INVALID_AGENT_CONNECTION', statusCode: 400 });
  }
  const previous = registry.get(id);
  registry.set(id, { token, delivery: 'relay', name, port });
  if (previous && previous.token !== token) broker.invalidate(owner, id);
  record('registered', { connectionId: id });
  response.json({ ok: true, connection: { id, name, port, transport: 'agent', delivery: 'relay' } });
}));
app.get('/api/ssh-workspaces/agent/relay/poll', asyncHandler(async (request, response) => {
  const controller = new AbortController();
  const cancel = () => { if (!response.writableEnded) controller.abort(); };
  response.once('close', cancel);
  try {
    const result = await broker.poll(owner, text(request.query.connectionId), credential(request), controller.signal,
      request.query.wait === '0' ? 0 : 25_000, request.query.protocol === '2' ? 2 : 1);
    record('poll', { connectionId: request.query.connectionId, handshake: request.query.wait === '0', requestIds: result.jobs.map(job => job.requestId) });
    if (!response.destroyed) {
      // Inject loss only after the broker actually offered work, never during
      // negotiation or empty long polls; this reproduces the real loss window.
      if (result.jobs.length) sendOrDrop('poll', response, result);
      else response.set('Cache-Control', 'no-store').json(result);
    }
  } finally { response.removeListener('close', cancel); }
}));
app.post('/api/ssh-workspaces/agent/relay/ack', asyncHandler(async (request, response) => {
  const input = body(request);
  const result = broker.acknowledge(owner, text(input.connectionId), credential(request), input.requestId, input.epoch);
  record('ack', { requestId: input.requestId, accepted: result.accepted });
  sendOrDrop('ack', response, result);
}));
app.post('/api/ssh-workspaces/agent/relay/reject', asyncHandler(async (request, response) => {
  const input = body(request);
  const result = broker.rejectReceipt(owner, text(input.connectionId), credential(request), input.requestId, input.epoch);
  record('rejected', { requestId: input.requestId, accepted: result.accepted });
  response.set('Cache-Control', 'no-store').json(result);
}));
app.post('/api/ssh-workspaces/agent/relay/heartbeat', asyncHandler(async (request, response) => {
  const input = body(request);
  const result = broker.heartbeat(owner, text(input.connectionId), credential(request), input.epoch, input.activeRequestIds);
  record('heartbeat', { activeRequestIds: input.activeRequestIds, obsoleteRequestIds: result.obsoleteRequestIds });
  response.set('Cache-Control', 'no-store').json(result);
}));
app.post('/api/ssh-workspaces/agent/relay/result', asyncHandler(async (request, response) => {
  const input = body(request);
  const result = broker.settle(owner, text(input.connectionId), credential(request), input.requestId, input.response, input.epoch);
  record('result', { requestId: input.requestId, accepted: result.accepted });
  sendOrDrop('result', response, result);
}));
app.post('/qa/enqueue', asyncHandler(async (request, response) => { response.json(await enqueue(body(request))); }));
app.get('/qa/state', (_request, response) => response.json(state()));
app.post('/qa/abort', (request, response) => {
  const label = String(body(request).label ?? '');
  const call = calls.get(label);
  call?.controller.abort();
  response.json({ ok: true, found: Boolean(call) });
});
app.post('/qa/faults', (request, response) => {
  const input = body(request);
  for (const key of ['poll', 'ack', 'result'] as const) if (input[key] !== undefined) faults[key] = Math.max(0, Math.min(100, Number(input[key]) || 0));
  response.json({ ok: true, faults });
});
app.post('/qa/reset', (request, response) => {
  const id = String(body(request).connectionId ?? '');
  broker.invalidate(owner, id);
  record('epoch-reset', { connectionId: id });
  response.json({ ok: true });
});
app.post('/qa/shutdown', (_request, response) => {
  response.json({ ok: true });
  response.once('finish', shutdown);
});
app.use(((error, _request, response, _next) => {
  response.status(error instanceof AppError ? error.statusCode : 500).json({ error: { code: error instanceof AppError ? error.code : 'QA_UNEXPECTED_ERROR' } });
}) as express.ErrorRequestHandler);

const server = app.listen(Number(process.env.CHISA_RELAY_QA_PORT ?? 0), '127.0.0.1', () => {
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  writeFileSync(path.join(qaDirectory!, 'ready.json'), JSON.stringify({ origin, owner, pid: process.pid, protocol: 2 }));
  record('ready', { origin });
});
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
if (process.env.CHISA_RELAY_QA_STDIN === '1') {
  const input = createInterface({ input: process.stdin });
  input.on('line', line => {
    try {
      const command = JSON.parse(line) as Record<string, unknown>;
      if (command.action === 'shutdown') { input.close(); shutdown(); }
      else if (command.action === 'status') process.stdout.write(JSON.stringify({ event: 'status', ...state() }) + '\n');
      else if (command.action === 'enqueue') void enqueue(command).catch(() => {});
    } catch { record('stdin-invalid'); }
  });
}
