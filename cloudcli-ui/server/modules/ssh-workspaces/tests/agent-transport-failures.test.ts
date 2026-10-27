import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { AppError } from '@/shared/index.js';

import { createSshWorkspaceTransport, SshWorkspaceError } from '../index.js';

const token = 'a'.repeat(64);
const target = { connectionId: 'desktop', rootPath: 'D:\\Code\\中文 App', expectedRootIdentity: 'root-id', generation: 'generation', userId: 'owner' };
const success = { ok: true, protocol: 1, platform: 'win32', rootIdentity: target.expectedRootIdentity };
const endpoint = { id: 'desktop', name: 'Desktop', port: 18765, token };
const write = { op: 'write', path: '/workspace/file.txt', b64: 'YQ==', expectedHash: null };
function transport(agentFetch: (url: string, init: RequestInit) => Promise<Response>, requestTimeoutMs = 1000) {
  return createSshWorkspaceTransport({ env: {}, agentConnections: async () => [endpoint], agentFetch, requestTimeoutMs,
    spawn() { assert.fail('Agent failure must never use SSH'); } });
}
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status }); }
function abortFetch(_url: string, init: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => reject(new DOMException('mock aborted', 'AbortError')), { once: true });
  });
}

test('Agent fetch AbortError reaches interrupted/timeout classification for reads', async () => {
  const controller = new AbortController();
  const active = transport(async (url, init) => { queueMicrotask(() => controller.abort()); return abortFetch(url, init); });
  await assert.rejects(active.executeSshWorkspace({ ...target, signal: controller.signal, request: { op: 'read' } }),
    error => error instanceof SshWorkspaceError && error.code === 'SSH_WORKSPACE_INTERRUPTED' && error.statusCode === 499);
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(transport(abortFetch, 5).executeSshWorkspace({ ...target, request: { op: 'read' } }),
      error => error instanceof SshWorkspaceError && error.code === 'SSH_WORKSPACE_TIMEOUT' && error.statusCode === 504);
  } finally { clearTimeout(keepAlive); }
});

test('Agent abort before dispatch does not fetch or create a recovery receipt', async () => {
  const controller = new AbortController();
  controller.abort(new Error('cancelled before request'));
  let persisted = false;
  await assert.rejects(transport(async () => assert.fail('already aborted request dispatched')).executeSshWorkspace({ ...target,
    signal: controller.signal, request: write, onJobCreated() { persisted = true; } }), /cancelled before request/);
  assert.equal(persisted, false);
});

test('abort during catalog lookup creates no job and sends neither exec nor cleanup', async () => {
  const controller = new AbortController();
  let persisted = 0;
  let dispatched = 0;
  const active = createSshWorkspaceTransport({ env: {}, agentConnections: async () => {
    controller.abort(new Error('cancelled during catalog'));
    return [endpoint];
  }, agentFetch: async () => { dispatched++; throw new Error('closed transport'); } });
  await assert.rejects(active.executeSshWorkspace({ ...target, signal: controller.signal, request: { op: 'exec', argv: ['git', 'status'] },
    onJobCreated() { persisted++; } }), /cancelled during catalog/);
  assert.equal(persisted, 0);
  assert.equal(dispatched, 0);
});

test('abort from persisted-job callback is typed pre-dispatch and does not send exec or cleanup', async () => {
  for (const request of [{ op: 'exec', argv: ['git', 'status'] }, write]) {
    const controller = new AbortController();
    let persisted = 0;
    let dispatched = 0;
    const active = transport(async () => { dispatched++; throw new Error('closed transport'); });
    await assert.rejects(active.executeSshWorkspace({ ...target, signal: controller.signal, request,
      onJobCreated() { persisted++; controller.abort(new Error('cancel after persistence')); } }), error => {
      assert.ok(error instanceof SshWorkspaceError);
      assert.equal(error.code, 'SSH_WORKSPACE_INTERRUPTED');
      assert.equal(error.details?.requestDispatched, false);
      if (request.op === 'exec') assert.equal(error.details?.cleanupConfirmed, true);
      return true;
    });
    assert.equal(persisted, 1);
    assert.equal(dispatched, 0);
  }
});

test('unknown file outcomes retain one persisted operation ID and are never replayed', async () => {
  for (const failure of ['disconnect', 'abort', 'malformed', 'oversized', 'bootstrap', 'wrong-root', 'duplicate', 'no-root']) {
    let calls = 0;
    let saved = '';
    let operationId = '';
    const controller = new AbortController();
    const active = transport(async (url, init) => {
      calls++;
      const envelope = JSON.parse(String(init.body));
      operationId = envelope.operationId;
      assert.equal(saved, `operation:${operationId}`, 'receipt must persist before HTTP transmission');
      assert.match(operationId, /^[a-f0-9-]{36}$/);
      assert.equal(envelope.request.op, 'write');
      if (failure === 'disconnect') throw new Error(`network ${token}`);
      if (failure === 'abort') { queueMicrotask(() => controller.abort()); return abortFetch(url, init); }
      if (failure === 'malformed') return new Response('partial JSON');
      if (failure === 'oversized') return new Response('small', { headers: { 'content-length': String(16 * 1024 * 1024 + 1) } });
      if (failure === 'wrong-root') return json({ ...success, rootIdentity: 'different' });
      if (failure === 'no-root') return json({ ok: false, protocol: 1, platform: 'win32', code: 'EACCES', error: 'No root identity' });
      return json({ ok: false, protocol: 1, platform: 'win32', code: failure === 'duplicate' ? 'AGENT_OPERATION_DUPLICATE' : 'AGENT_HELPER_UNAVAILABLE', error: 'No final helper receipt' }, failure === 'duplicate' ? 409 : 502);
    });
    await assert.rejects(active.executeSshWorkspace({ ...target, signal: controller.signal, request: write, onJobCreated(id) { saved = id; } }), error => {
      assert.ok(error instanceof SshWorkspaceError);
      assert.equal(error.code, 'SSH_OPERATION_UNCONFIRMED', failure);
      assert.equal(error.details?.jobId, `operation:${operationId}`);
      assert.equal(error.details?.cleanupConfirmed, false);
      assert.equal(error.details?.originalCode, failure === 'abort' ? 'SSH_WORKSPACE_INTERRUPTED' : error.details?.originalCode);
      assert.equal(JSON.stringify(error).includes(token), false);
      assert.equal(error.message.includes(token), false);
      return true;
    });
    assert.equal(calls, 1, failure);
  }
});

test('typed Agent pre-dispatch refusals do not create uncertain operations or report an online helper', async () => {
  for (const [code, status] of [['AGENT_UNAUTHORIZED', 401], ['AGENT_REQUEST_TOO_LARGE', 413], ['AGENT_REQUEST_INVALID', 400], ['AGENT_ROOT_INVALID', 400], ['AGENT_BUSY', 503]] as const) {
    let calls = 0;
    const active = transport(async () => { calls++; return json({ ok: false, protocol: 1, platform: 'win32', code, error: 'Rejected before helper dispatch' }, status); });
    await assert.rejects(active.executeSshWorkspace({ ...target, request: write }), error => {
      assert.ok(error instanceof SshWorkspaceError);
      assert.equal(error.code, code);
      assert.equal(error.statusCode, status);
      assert.equal(error.details?.requestDispatched, false);
      assert.notEqual(error.details?.transportConfirmed, true);
      return true;
    });
    assert.equal(calls, 1);
  }
  const spoof = transport(async () => json({ ok: false, protocol: 1, platform: 'win32', code: 'AGENT_UNAUTHORIZED', error: 'Wrong HTTP status' }));
  await assert.rejects(spoof.executeSshWorkspace({ ...target, request: write }), { code: 'SSH_OPERATION_UNCONFIRMED' });
});

test('valid root-pinned helper refusal is typed and completed without replay', async () => {
  let calls = 0;
  const active = transport(async () => { calls++; return json({ ...success, ok: false, code: 'CONTENT_CONFLICT', error: 'File changed' }); });
  await assert.rejects(active.executeSshWorkspace({ ...target, request: write }), error => error instanceof SshWorkspaceError
    && error.code === 'CONTENT_CONFLICT' && error.statusCode === 409 && error.details?.transportConfirmed === true);
  assert.equal(calls, 1);
});

test('Agent credentials never appear in typed errors, injected network errors or successful public responses', async () => {
  const privateError = transport(async () => json({ ...success, ok: false, code: 'EACCES', error: `raw ${token} and ${'b'.repeat(64)}` }));
  await assert.rejects(privateError.executeSshWorkspace({ ...target, request: { op: 'read' } }), error => {
    assert.ok(error instanceof SshWorkspaceError);
    assert.equal(error.message.includes(token), false);
    assert.equal(error.message.includes('b'.repeat(64)), false);
    assert.match(error.message, /redacted/);
    return true;
  });
  const leakedCode = transport(async () => json({ ...success, ok: false, code: 'A'.repeat(64), error: 'unsafe code' }));
  await assert.rejects(leakedCode.executeSshWorkspace({ ...target, request: { op: 'read' } }), { code: 'SSH_WORKSPACE_OPERATION_FAILED' });
  const echoed = transport(async () => json({ ...success, token }));
  await assert.rejects(echoed.executeSshWorkspace({ ...target, request: { op: 'read' } }), error => error instanceof SshWorkspaceError
    && error.code === 'SSH_WORKSPACE_PROTOCOL_INVALID' && !error.message.includes(token));
  const escaped = transport(async () => new Response(JSON.stringify({ ...success, token: 'ESCAPED' }).replace('ESCAPED', '\\u0061'.repeat(64))));
  await assert.rejects(escaped.executeSshWorkspace({ ...target, request: { op: 'read' } }), { code: 'SSH_WORKSPACE_PROTOCOL_INVALID' });
  const rejected = transport(async () => { throw Object.assign(new Error(token), { cause: token }); });
  await assert.rejects(rejected.executeSshWorkspace({ ...target, request: { op: 'read' } }), error => error instanceof SshWorkspaceError
    && !error.message.includes(token) && !JSON.stringify(error).includes(token));
  const probe = await transport(async () => json({ ...success, rootPath: target.rootPath, username: 'user', helperVersion: '1.0.1', capabilities: { files: true, exec: true } })).probeSshWorkspace(target);
  assert.equal(JSON.stringify(probe).includes(token), false);
});

test('Agent validates token length/encoding and loopback topology before constructing headers', async () => {
  for (const invalid of ['', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'a'.repeat(63) + '\n', 'a'.repeat(64) + '\n', 'https://remote/']) {
    const active = createSshWorkspaceTransport({ env: {}, agentConnections: async () => [{ ...endpoint, token: invalid }],
      agentFetch: async () => assert.fail('invalid credential dispatched') });
    await assert.rejects(active.executeSshWorkspace({ ...target, request: { op: 'read' } }), error => error instanceof SshWorkspaceError
      && error.code === 'SSH_CONNECTION_CONFIG_INVALID' && !error.message.includes(invalid || 'missing-secret'));
  }
  for (const metadata of [{ id: token }, { name: `secret ${token}` }, { id: 'bad/id' }, { name: '\n' }]) {
    const active = createSshWorkspaceTransport({ env: {}, agentConnections: async () => [{ ...endpoint, ...metadata }] });
    await assert.rejects(active.listSshConnections('owner'), { code: 'SSH_CONNECTION_CONFIG_INVALID' });
  }
  for (const port of [22, 65536, NaN, '18765/remote']) {
    const active = createSshWorkspaceTransport({ env: {}, agentConnections: async () => [{ ...endpoint, port: port as number }],
      agentFetch: async () => assert.fail('invalid endpoint dispatched') });
    await assert.rejects(active.listSshConnections('owner'), { code: 'SSH_CONNECTION_CONFIG_INVALID' });
  }
  await transport(async (url, init) => {
    assert.equal(url, 'http://127.0.0.1:18765/v1/workspace');
    assert.equal(init.redirect, 'error');
    assert.equal(init.credentials, 'omit');
    assert.equal((init.headers as Record<string, string>)['X-Chisa-Agent-Token'].length, 64);
    return json(success);
  }).executeSshWorkspace({ ...target, request: { op: 'read' } });
});

test('bounded streaming rejects oversized responses before fully buffering and cancels its reader', async () => {
  let readChunks = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { readChunks++; controller.enqueue(new Uint8Array(1024 * 1024)); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(transport(async () => new Response(body)).executeSshWorkspace({ ...target, request: { op: 'read' } }),
    { code: 'SSH_WORKSPACE_RESPONSE_TOO_LARGE' });
  assert.equal(cancelled, true);
  assert.ok(readChunks <= 18, `stream read ${readChunks} chunks`);
});

test('relay catalog and execution reuse bounded protocol handling without loopback HTTP', async () => {
  let calls = 0;
  const active = createSshWorkspaceTransport({ env: {}, agentConnections: async () => [{ ...endpoint, delivery: 'relay' }],
    agentFetch: async () => assert.fail('relay selected direct HTTP'),
    agentRelayCall: async (owner, id, credential, payload, signal) => {
      calls++;
      assert.equal(owner, target.userId);
      assert.equal(id, target.connectionId);
      assert.equal(credential, token);
      assert.equal((payload.request as Record<string, unknown>).op, 'write');
      assert.match(String(payload.operationId), /^[a-f0-9-]{36}$/);
      assert.ok(signal);
      return { status: 200, body: JSON.stringify(success) };
    } });
  const catalog = await active.listSshConnections(target.userId);
  assert.equal(catalog[0]?.transport, 'agent');
  assert.equal((catalog[0] as unknown as { delivery: string }).delivery, 'relay');
  assert.equal(JSON.stringify(catalog).includes(token), false);
  await active.executeSshWorkspace({ ...target, request: write });
  assert.equal(calls, 1);
});

test('relay offline and cancellation preserve pre-delivery versus delivered uncertainty', async () => {
  for (const dispatched of [false, true]) {
    const controller = new AbortController();
    const active = createSshWorkspaceTransport({ env: {}, agentConnections: async () => [{ ...endpoint, delivery: 'relay' }],
      agentFetch: async () => assert.fail('relay fell back to direct'),
      agentRelayCall: async () => { controller.abort(); throw new AppError('Relay interrupted', {
        code: 'AGENT_RELAY_INTERRUPTED', statusCode: 499, details: { requestDispatched: dispatched },
      }); } });
    await assert.rejects(active.executeSshWorkspace({ ...target, signal: controller.signal, request: write }), error => {
      assert.ok(error instanceof SshWorkspaceError);
      assert.equal(error.code, dispatched ? 'SSH_OPERATION_UNCONFIRMED' : 'SSH_WORKSPACE_INTERRUPTED');
      if (!dispatched) assert.equal(error.details?.requestDispatched, false);
      return true;
    });
  }
  const offline = createSshWorkspaceTransport({ env: {}, agentConnections: async () => [{ ...endpoint, delivery: 'relay' }],
    agentRelayCall: async () => { throw new AppError('Desktop offline', { code: 'AGENT_RELAY_OFFLINE', statusCode: 503, details: { requestDispatched: false } }); } });
  await assert.rejects(offline.executeSshWorkspace({ ...target, request: write }), error => error instanceof SshWorkspaceError
    && error.code === 'AGENT_RELAY_OFFLINE' && error.details?.requestDispatched === false);
});

test('file recovery accepts only exact durable receipt identity and never resends mutation', async () => {
  const operationId = randomUUID();
  const receipt = { ...success, operationId, generation: target.generation, rootPath: target.rootPath, state: 'completed', cleanupConfirmed: true };
  for (const patch of [{}, { operationId: randomUUID() }, { generation: 'other' }, { rootPath: 'D:\\other' }, { state: 'not_found' }, { state: 'unknown' }, { cleanupConfirmed: 'true' }]) {
    let calls = 0;
    const active = transport(async (_url, init) => { calls++; const envelope = JSON.parse(String(init.body));
      assert.equal(envelope.operationId, undefined);
      assert.deepEqual(envelope.request, { op: 'operation_status', operationId });
      return json({ ...receipt, ...patch });
    });
    if (Object.keys(patch).length === 0) assert.equal((await active.executeSshWorkspace({ ...target, request: { op: 'operation_status', operationId } })).cleanupConfirmed, true);
    else await assert.rejects(active.executeSshWorkspace({ ...target, request: { op: 'operation_status', operationId } }), { code: 'SSH_WORKSPACE_PROTOCOL_INVALID' });
    assert.equal(calls, 1);
  }
  const missing = transport(async () => json({ ...receipt, state: 'not_found', cleanupConfirmed: false }));
  assert.equal((await missing.executeSshWorkspace({ ...target, request: { op: 'operation_cancel', operationId } })).cleanupConfirmed, false);
});
