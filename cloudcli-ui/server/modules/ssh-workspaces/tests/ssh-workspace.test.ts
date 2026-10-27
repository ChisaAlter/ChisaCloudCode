import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { createSshWorkspaceTransport, SshWorkspaceError } from '../index.js';

const entry = { id: 'windows-one', name: 'Work laptop', host: '127.0.0.1', port: 22022, username: 'cc-worker', identityFile: `${process.platform === 'win32' ? 'C:' : ''}/private/execute-key`, knownHostsFile: `${process.platform === 'win32' ? 'C:' : ''}/private/known-hosts`, helperPath: "C:\\Program Files\\Chisa\\helper ' $().ps1", ownerId: 'user-1', hostKeyAlias: 'device-1' };
const env = { CHISA_SSH_CONNECTIONS_FILE: `${process.platform === 'win32' ? 'C:' : ''}/protected/connections.json` };
const target = { connectionId: entry.id, rootPath: 'D:\\Projects\\中文 space', userId: 'user-1', expectedRootIdentity: 'root-id' };
const success = { ok: true, protocol: 1, platform: 'win32', rootIdentity: 'root-id' };

type FakeChild = EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill(): boolean };
function child(): FakeChild {
  const fake = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
  return fake;
}
function finish(fake: FakeChild, value: unknown, code = 0): void {
  queueMicrotask(() => { fake.stdout.end(JSON.stringify(value)); fake.emit('close', code); });
}
function fixture(action: (data: Record<string, any>, fake: FakeChild, args: string[], options: unknown) => void, rows: unknown = [entry], customEnv: Record<string, string> = env) {
  const calls: Array<{ command: string; args: string[]; data: Record<string, any>; options: unknown }> = [];
  const transport = createSshWorkspaceTransport({
    env: customEnv,
    readCatalog: async () => JSON.stringify(rows),
    requestTimeoutMs: 1000,
    cleanupTimeoutMs: 100,
    spawn(command, args, options) {
      const fake = child();
      let input = '';
      fake.stdin.on('data', chunk => { input += chunk.toString('utf8'); });
      fake.stdin.once('finish', () => {
        const data = JSON.parse(input);
        calls.push({ command, args, data, options });
        action(data, fake, args, options);
      });
      return fake as never;
    },
  });
  return { transport, calls };
}

test('safe owner-filtered catalog has no credential/helper paths and forbids unowned wildcard', async () => {
  const { transport, calls } = fixture(() => assert.fail('listing cannot connect'), [entry, { ...entry, id: 'other', ownerId: 'user-2' }]);
  assert.deepEqual(await transport.listSshConnections('user-1'), [{ id: entry.id, name: entry.name, host: entry.host, port: entry.port, username: entry.username, platform: 'win32', transport: 'ssh' }]);
  assert.equal(calls.length, 0);
  await assert.rejects(transport.executeSshWorkspace({ ...target, userId: 'user-2', request: { op: 'list' } }), error => error instanceof SshWorkspaceError && error.code === 'SSH_CONNECTION_NOT_FOUND');
  await assert.rejects(fixture(() => {}, [{ ...entry, ownerId: '*' }]).transport.listSshConnections('user-1'), /Shared SSH/);
  assert.equal((await fixture(() => {}, [{ ...entry, ownerId: '*' }], { ...env, CHISA_SSH_ALLOW_SHARED_CONNECTIONS: '1' }).transport.listSshConnections('user-7')).length, 1);
  await assert.rejects(fixture(() => {}, [{ ...entry, ownerId: '*' }], { ...env, CHISA_SSH_ALLOW_SHARED_CONNECTIONS: '1', VITE_IS_PLATFORM: 'true' }).transport.listSshConnections('user-7'), /Shared SSH/);
  await assert.rejects(fixture(() => {}, [{ ...entry, ownerId: undefined }]).transport.listSshConnections('user-1'), /ownerId/);
});

test('probe runs a pinned system SSH command and only sends operation data on stdin', async () => {
  const { transport, calls } = fixture((data, fake) => finish(fake, { ...success, rootPath: target.rootPath, username: 'MACHINE\\cc-worker', helperVersion: '1.0.0', capabilities: { files: true, exec: true, terminal: false } }));
  const result = await transport.probeSshWorkspace(target);
  assert.equal(result.connectionLabel, entry.name);
  assert.equal(result.rootIdentity, 'root-id');
  const call = calls[0]!;
  assert.equal(call.command, 'ssh');
  assert.ok(call.args.includes('StrictHostKeyChecking=yes'));
  assert.ok(call.args.includes('BatchMode=yes'));
  assert.ok(call.args.includes('IdentityAgent=none'));
  assert.ok(call.args.includes('HostKeyAlias=device-1'));
  assert.ok(call.args.includes('-EncodedCommand'));
  assert.equal(call.args.some(arg => arg.includes('中文')), false);
  const bootstrap = Buffer.from(call.args.at(-1)!, 'base64').toString('utf16le');
  assert.ok(bootstrap.includes(Buffer.from(entry.helperPath).toString('base64')));
  assert.equal(bootstrap.includes(entry.helperPath), false);
  assert.equal(call.data.rootPath, target.rootPath);
  assert.equal(call.data.expectedRootIdentity, 'root-id');
});

test('catalog rejects command-injection fields and duplicate IDs before spawning', async () => {
  for (const invalid of [{ ...entry, host: '-oProxyCommand=bad' }, { ...entry, username: 'user -o bad' }, { ...entry, helperPath: 'relative.ps1' }, { ...entry, hostKeyAlias: 'bad\nname' }, { ...entry, identityFile: 'relative-key' }]) {
    const { transport, calls } = fixture(() => assert.fail('invalid config connected'), [invalid]);
    await assert.rejects(transport.listSshConnections('user-1'), error => error instanceof SshWorkspaceError && error.code === 'SSH_CONNECTION_CONFIG_INVALID');
    assert.equal(calls.length, 0);
  }
  await assert.rejects(fixture(() => {}, [entry, entry]).transport.listSshConnections('user-1'), /unique/);
});

test('remote errors and changed roots never return null or replay operations', async () => {
  const denied = fixture((data, fake) => finish(fake, { ok: false, protocol: 1, platform: 'win32', rootIdentity: 'root-id', code: 'CONTENT_CONFLICT', error: 'File changed' }, 1));
  await assert.rejects(denied.transport.executeSshWorkspace({ ...target, request: { op: 'write', path: '/workspace/a', b64: 'YQ==', expectedHash: '0'.repeat(64) } }), error => error instanceof SshWorkspaceError && error.code === 'CONTENT_CONFLICT' && error.statusCode === 409);
  assert.equal(denied.calls.length, 1);
  const changed = fixture((data, fake) => finish(fake, { ...success, rootIdentity: 'new-root' }));
  await assert.rejects(changed.transport.executeSshWorkspace({ ...target, request: { op: 'read', path: '/workspace/a' } }), error => error instanceof SshWorkspaceError && error.code === 'SSH_WORKSPACE_CHANGED');
});

test('valid helper file errors confirm transport without trusting malformed or mismatched responses', async () => {
  for (const code of ['CONTENT_CONFLICT', 'ENOENT', 'EACCES']) {
    const current = fixture((_data, fake) => finish(fake, { ok: false, protocol: 1, platform: 'win32', rootIdentity: 'root-id', code, error: 'Expected file operation error' }, 1));
    await assert.rejects(current.transport.executeSshWorkspace({ ...target, request: { op: 'read', path: '/workspace/target' } }),
      error => error instanceof SshWorkspaceError && error.code === code && error.details?.transportConfirmed === true);
    assert.equal(current.calls.length, 1);
  }
  const valid = { ok: false, protocol: 1, platform: 'win32', rootIdentity: 'root-id', code: 'ENOENT', error: 'Missing file' };
  const unconfirmed = [
    { response: { ok: false, code: 'SSH_HELPER_UNAVAILABLE', error: 'Bootstrap failed' }, exitCode: 1 },
    { response: { ...valid, protocol: 2 }, exitCode: 1 },
    { response: { ...valid, platform: 'linux' }, exitCode: 1 },
    { response: { ...valid, ok: null }, exitCode: 1 },
    { response: { ...valid, code: 'invalid-code' }, exitCode: 1 },
    { response: { ...valid, error: null }, exitCode: 1 },
    { response: { ...valid, rootIdentity: 'changed-root' }, exitCode: 1 },
    { response: { ...valid, rootIdentity: undefined }, exitCode: 1 },
    { response: { ...valid, code: 'SSH_WORKSPACE_CHANGED' }, exitCode: 1 },
    { response: { ...valid, code: 'SSH_WORKSPACE_PROTOCOL_INVALID' }, exitCode: 1 },
    { response: valid, exitCode: 255 },
  ];
  for (const { response, exitCode } of unconfirmed) {
    const current = fixture((_data, fake) => finish(fake, response, exitCode));
    await assert.rejects(current.transport.executeSshWorkspace({ ...target, request: { op: 'read', path: '/workspace/target' } }),
      error => error instanceof SshWorkspaceError && error.details?.transportConfirmed !== true);
  }
});

test('readonly exec and malformed batch are rejected before spawning', async () => {
  const { transport, calls } = fixture(() => assert.fail('invalid request connected'));
  await assert.rejects(transport.executeSshWorkspace({ ...target, request: { op: 'exec', command: 'delete files', readOnly: true } }), error => error instanceof SshWorkspaceError && error.code === 'SSH_READ_ONLY_COMMAND_UNSUPPORTED');
  await assert.rejects(transport.executeSshWorkspace({ ...target, request: { op: 'batch', requests: [{ op: 'exec', command: 'bad' }] } }));
  await assert.rejects(transport.executeSshWorkspace({ ...target, request: { op: 'batch', requests: [{ op: 'write', path: '/workspace/a', b64: '', expectedHash: null }] } }), /inspection only/);
  assert.equal(calls.length, 0);
});

test('command completion needs matching job ID and confirmed remote teardown', async () => {
  const complete = fixture((data, fake) => finish(fake, { ...success, jobId: data.request.jobId, exitCode: 7, stdout: 'actual', stderr: 'failure', cleanupConfirmed: true }));
  const result = await complete.transport.executeSshWorkspace({ ...target, request: { op: 'exec', command: 'exit 7' } });
  assert.equal(result.exitCode, 7);
  assert.equal(result.stdout, 'actual');
  assert.equal(complete.calls.length, 1);
  assert.match(complete.calls[0]!.data.request.jobId, /^[a-f0-9-]{36}$/);
  const uncertain = fixture((data, fake) => {
    if (data.request.op === 'exec') { fake.stderr.write('Connection reset'); fake.emit('close', 255); }
    else finish(fake, { ...success, jobId: data.request.jobId, state: 'not_found', cleanupConfirmed: false });
  });
  await assert.rejects(uncertain.transport.executeSshWorkspace({ ...target, request: { op: 'exec', command: 'may write' } }), error => error instanceof SshWorkspaceError && error.code === 'SSH_EXECUTION_UNCONFIRMED' && typeof error.details?.jobId === 'string');
  assert.deepEqual(uncertain.calls.map(call => call.data.request.op), ['exec', 'job_cancel']);
});

test('abort attempts independent cancellation and preserves whether cleanup is confirmed', async () => {
  const abort = new AbortController();
  const { transport, calls } = fixture((data, fake) => {
    if (data.request.op === 'exec') queueMicrotask(() => abort.abort());
    else finish(fake, { ...success, jobId: data.request.jobId, state: 'cancelled', cleanupConfirmed: true });
  });
  await assert.rejects(transport.executeSshWorkspace({ ...target, signal: abort.signal, request: { op: 'exec', command: 'wait' } }), error => error instanceof SshWorkspaceError && error.code === 'SSH_WORKSPACE_INTERRUPTED' && error.details?.cleanupConfirmed === true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.data.request.jobId, calls[0]!.data.request.jobId);
});

test('a different cancellation job receipt cannot release uncertain command execution', async () => {
  const current = fixture((data, fake) => {
    if (data.request.op === 'exec') fake.emit('close', 255);
    else finish(fake, { ...success, jobId: '00000000-0000-4000-8000-000000000000', cleanupConfirmed: true });
  });
  await assert.rejects(current.transport.executeSshWorkspace({ ...target, request: { op: 'exec', command: 'may mutate' } }),
    { code: 'SSH_EXECUTION_UNCONFIRMED' });
  assert.deepEqual(current.calls.map(call => call.data.request.op), ['exec', 'job_cancel']);
});

test('unknown direct-SSH file mutation is fenced while local spawn refusal remains safe', async () => {
  const current = fixture((_data, fake) => fake.emit('close', 255));
  await assert.rejects(current.transport.executeSshWorkspace({ ...target, request: { op: 'mkdir', path: '/workspace/new' } }),
    { code: 'SSH_OPERATION_UNCONFIRMED' });
  assert.equal(current.calls.length, 1);
  const local = createSshWorkspaceTransport({ env, readCatalog: async () => JSON.stringify([entry]),
    spawn() { throw new Error('client missing'); } });
  await assert.rejects(local.executeSshWorkspace({ ...target, request: { op: 'mkdir', path: '/workspace/new' } }), error => error instanceof SshWorkspaceError
    && error.code === 'SSH_WORKSPACE_UNAVAILABLE' && error.details?.requestDispatched === false);
});

test('job persistence callback runs before transmission and may veto execution', async () => {
  const { transport, calls } = fixture((data, fake) => finish(fake, { ...success, jobId: data.request.jobId, cleanupConfirmed: true, exitCode: 0 }));
  let recorded = '';
  await transport.executeSshWorkspace({ ...target, request: { op: 'exec', command: 'exit 0' }, onJobCreated(id) { assert.equal(calls.length, 0); recorded = id; } });
  assert.equal(recorded, calls[0]!.data.request.jobId);
  await assert.rejects(transport.executeSshWorkspace({ ...target, request: { op: 'exec', command: 'must not run' }, onJobCreated() { throw new Error('persistence failed'); } }), /persistence failed/);
  assert.equal(calls.length, 1);
});

test('direct SSH cancellation at catalog and persisted-job boundaries never starts a child or cleanup job', async () => {
  for (const boundary of ['catalog', 'persisted']) {
    const controller = new AbortController();
    let jobs = 0;
    let children = 0;
    const active = createSshWorkspaceTransport({ env, readCatalog: async () => {
      if (boundary === 'catalog') controller.abort(new Error('cancelled catalog'));
      return JSON.stringify([entry]);
    }, agentConnections: async () => [], spawn() { children++; assert.fail('cancelled request spawned SSH'); } });
    await assert.rejects(active.executeSshWorkspace({ ...target, signal: controller.signal, request: { op: 'exec', argv: ['git', 'status'] },
      onJobCreated() { jobs++; controller.abort(new Error('cancelled persisted')); } }), error => {
      if (boundary === 'catalog') return error instanceof Error && error.message === 'cancelled catalog';
      assert.ok(error instanceof SshWorkspaceError);
      assert.equal(error.code, 'SSH_WORKSPACE_INTERRUPTED');
      assert.equal(error.details?.requestDispatched, false);
      assert.equal(error.details?.cleanupConfirmed, true);
      return true;
    });
    assert.equal(jobs, boundary === 'catalog' ? 0 : 1);
    assert.equal(children, 0);
  }
});

test('host-key diagnostics do not leak SSH stderr or private paths', async () => {
  const { transport } = fixture((data, fake) => { fake.stderr.write(`Host key verification failed ${entry.identityFile}`); fake.emit('close', 255); });
  await assert.rejects(transport.executeSshWorkspace({ ...target, request: { op: 'list' } }), error => error instanceof SshWorkspaceError && error.code === 'SSH_HOST_KEY_MISMATCH' && !error.message.includes(entry.identityFile));
});

test('agent connections use loopback HTTP instead of spawning the system SSH client', async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const transport = createSshWorkspaceTransport({
    agentConnections: async () => [{ id: 'desktop-agent', name: 'Windows desktop', port: 18765, token: 'a'.repeat(64) }],
    agentFetch: async (url, init) => {
      calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      assert.equal((init.headers as Record<string, string>)['X-Chisa-Agent-Token'], 'a'.repeat(64));
      return new Response(JSON.stringify({ ok: true, protocol: 1, platform: 'win32', rootIdentity: 'physical-root', rootPath: 'C:\\work\\app', username: 'DESKTOP\\user', helperVersion: '1.0.1', capabilities: { files: true, exec: true } }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const connections = await transport.listSshConnections('owner');
  assert.deepEqual(connections, [{ id: 'desktop-agent', name: 'Windows desktop', host: '127.0.0.1', port: 18765, username: 'desktop-agent', platform: 'win32', transport: 'agent' }]);
  const probe = await transport.probeSshWorkspace({ connectionId: 'desktop-agent', rootPath: 'C:\\work\\app', userId: 'owner' });
  assert.equal(probe.rootIdentity, 'physical-root');
  assert.equal(calls[0]?.url, 'http://127.0.0.1:18765/v1/workspace');
  assert.equal(calls[0]?.body.protocol, 1);
  assert.equal((calls[0]!.body.request as Record<string, unknown>).op, 'probe');
});

test('agent refusals retain typed file errors and never fall back to SSH', async () => {
  const transport = createSshWorkspaceTransport({
    agentConnections: async () => [{ id: 'desktop-agent', name: 'Windows desktop', port: 18765, token: 'b'.repeat(64) }],
    agentFetch: async () => new Response(JSON.stringify({ ok: false, protocol: 1, platform: 'win32', rootIdentity: 'root-id', code: 'ENOENT', error: 'Missing file' }), { status: 200 }),
  });
  await assert.rejects(transport.executeSshWorkspace({ connectionId: 'desktop-agent', rootPath: 'C:\\work\\app', userId: 'owner', request: { op: 'read', path: '/workspace/missing' } }), (error: unknown) => {
    assert.ok(error instanceof SshWorkspaceError);
    assert.equal(error.code, 'ENOENT');
    assert.equal(error.statusCode, 404);
    assert.equal(error.details?.transportConfirmed, true);
    return true;
  });
});
