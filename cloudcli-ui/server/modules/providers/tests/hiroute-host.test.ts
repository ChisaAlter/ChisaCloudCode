import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { createHiRouteHost } from '@/modules/providers/services/hiroute-host.service.js';

type Invocation = { command: string; args: string[]; options: any; input: string; killed: boolean };
const locations = { root: '/home/test/.local/share/chisacloudcode/hiroute/test/7/generation', runtime: '/tmp/chisa-hiroute-1000/test' };
const envelope = (data: unknown, extra = {}) => JSON.stringify({ schema_version: { major: 2, minor: 0 }, status: 'succeeded', data, ...extra });

function harness(responses: (string | { output?: string; code?: number; stderr?: string; error?: string; pending?: boolean })[] = []) {
  const calls: Invocation[] = [];
  const replies = [JSON.stringify(locations), ...responses];
  const fakeSpawn = ((command: string, args: string[], options: any) => {
    const call = { command, args, options, input: '', killed: false };
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      kill() { call.killed = true; return true; },
    });
    calls.push(call);
    child.stdin.on('data', chunk => { call.input += chunk.toString(); });
    child.stdin.on('finish', () => queueMicrotask(() => {
      const response = replies.shift() ?? '';
      const reply = typeof response === 'string' ? { output: response } : response;
      if (reply.pending) return;
      if (reply.error) { child.emit('error', new Error(reply.error)); return; }
      child.stdout.end(reply.output ?? '');
      child.stderr.end(reply.stderr ?? '');
      child.emit('close', reply.code ?? 0);
    }));
    return child;
  }) as unknown as typeof spawn;
  const waits: number[] = [];
  const create = (id = 7, generation = 'configuration-a', platform: NodeJS.Platform = 'win32', signal?: AbortSignal) => createHiRouteHost(id, generation, {
    spawn: fakeSpawn, platform, databasePath: 'C:/fixtures/host.db', distro: 'FixtureDistro',
    wait: async delay => { waits.push(delay); },
  }, signal);
  return { calls, waits, create };
}

test('isolates database/user/generation namespaces and uses WSL positional arguments with clean environments', async () => {
  const fixture = harness([envelope({ agents: [] })]);
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = 'must-not-cross';
  try {
    const host = await fixture.create();
    assert.match(host.namespace, /^[a-f0-9]{64}\/7\/[a-f0-9]{64}$/);
    assert.deepEqual(await host.cli(['agents', 'scan']), { agents: [] });
    const call = fixture.calls[1]!;
    assert.equal(call.command, 'wsl.exe');
    assert.deepEqual(call.args.slice(0, 3), ['--distribution', 'FixtureDistro', '--exec']);
    assert.ok(call.args.includes('-i'));
    assert.equal(call.options.stdio.join(','), 'pipe,pipe,pipe');
    assert.equal(call.options.env.CLAUDE_CONFIG_DIR, undefined);
    assert.ok(call.args.some(arg => arg.includes('export HOME="$root/home"')));
    assert.ok(call.args.some(arg => arg.includes('export XDG_STATE_HOME="$root/state"')));
    assert.ok(call.args.some(arg => arg.includes('export PATH="$root/bin:')));
    assert.deepEqual(call.args.slice(-6), [locations.root, locations.runtime, 'agents', 'scan', '--output', 'json']);
    const other = harness();
    assert.notEqual((await other.create(8)).namespace, host.namespace);
    const changed = harness();
    assert.notEqual((await changed.create(7, 'configuration-b')).namespace, host.namespace);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  }
});

test('passes request JSON on stdin and preserves accepted operation metadata', async () => {
  const operation = { operation_id: 'op_fixture', state: 'succeeded' };
  const fixture = harness([envelope({ state: 'succeeded' }, { status: 'accepted', operation })]);
  const host = await fixture.create(7, 'generation', 'linux');
  const request = { text: 'literal $(touch /tmp/injected); `false` "$HOME"' };
  assert.deepEqual(await host.cli(['compute', 'connection', 'apply'], request), { state: 'succeeded', operation });
  const call = fixture.calls[1]!;
  assert.equal(call.command, '/usr/bin/env');
  assert.equal(call.input, JSON.stringify(request));
  assert.ok(call.args.includes('--request-stdin'));
  assert.equal(call.args.some(arg => arg.includes(request.text)), false);
  assert.ok(call.args.includes('120s'));
});

test('registers secrets only through stdin duplicated to fd3 and trims private grant output', async () => {
  const fixture = harness([envelope({ candidate_revision: 1 }), '  fixture-grant-token\n']);
  const host = await fixture.create();
  const secret = 'key-with-$(shell)-and-`syntax`';
  assert.deepEqual(await host.secret('candidate/native/fixture', secret), { candidate_revision: 1 });
  const registration = fixture.calls[1]!;
  assert.equal(registration.input, secret);
  assert.equal(registration.args.some(arg => arg.includes(secret)), false);
  assert.equal(JSON.stringify(registration.options).includes(secret), false);
  assert.ok(registration.args.some(arg => arg.includes('exec 3<&0')));
  assert.ok(registration.args.some(arg => arg.includes('--secret-fd 3')));
  const context = 'agent-context/claude/sha256:fixture';
  assert.equal(await host.grant(context), 'fixture-grant-token');
  const grant = fixture.calls[2]!;
  assert.equal(grant.input, context);
  assert.equal(grant.args.some(arg => arg.includes(context)), false);
  assert.ok(grant.args.some(arg => arg.includes("struct.pack('>HH', 1, len(connection))")));
  assert.ok(grant.args.some(arg => arg.includes("('agent-connection/' + context)")));
});

test('bridges supplied credential JSON through stdin with atomic private writes and removes stale bridge on null', async () => {
  const fixture = harness(['', '']);
  const host = await fixture.create();
  const accessOnly = '{"claudeAiOauth":{"accessToken":"fixture-access","expiresAt":1234}}';
  await host.bridgeCredentials(accessOnly);
  await host.bridgeCredentials(null);
  assert.equal(fixture.calls[1]!.input, accessOnly);
  assert.equal(fixture.calls[2]!.input, '');
  assert.equal(fixture.calls[1]!.args.some(arg => arg.includes(accessOnly)), false);
  const bridge = fixture.calls[1]!.args.find(arg => arg.includes('access_only(item)'))!;
  assert.ok(bridge.includes("'refresh' not in key.lower()"));
  assert.ok(bridge.includes('os.chmod(temporary, 0o600)'));
  assert.ok(bridge.includes('os.replace(temporary, destination)'));
  assert.ok(bridge.includes('destination.unlink(missing_ok=True)'));
});

test('sanitizes failed child output, malformed envelopes, unsuccessful envelopes, and spawn exceptions', async () => {
  for (const response of [
    { code: 1, output: 'fixture-secret', stderr: 'fixture-secret' },
    'fixture-secret',
    envelope({ token: 'fixture-secret' }, { status: 'failed', error: { message: 'fixture-secret' } }),
    JSON.stringify({ status: 'succeeded', data: 'fixture-secret' }),
    { error: 'fixture-secret' },
  ]) {
    const fixture = harness([response]);
    const host = await fixture.create();
    await assert.rejects(host.cli(['agents', 'scan']), error => {
      assert.ok(error instanceof Error);
      assert.equal(JSON.stringify(error).includes('fixture-secret'), false);
      assert.equal(error.message.includes('fixture-secret'), false);
      assert.equal('cause' in error, false);
      return true;
    });
  }
});

test('ensure coalesces callers, pins installer before execution, and launches daemon with bounded health backoff', async () => {
  const fixture = harness(['', envelope({ local_control_ready: false }), '',
    envelope({ local_control_ready: false }), envelope({ local_control_ready: true })]);
  const host = await fixture.create();
  await Promise.all([host.ensure(), host.ensure()]);
  assert.equal(fixture.calls.length, 6);
  const install = fixture.calls[1]!;
  assert.ok(install.args.includes('300s'));
  assert.ok(install.args.includes('https://hiroute.ai/install/standalone.py'));
  assert.ok(install.args.includes('a22592f40b805b38f71b8a0be0a17c57702785c484997c3e26e2b54116f986fd'));
  const installer = install.args.find(arg => arg.includes('installer checksum mismatch'))!;
  assert.ok(installer.indexOf('hashlib.sha256(source)') < installer.indexOf('subprocess.run('));
  assert.ok(installer.includes('hiroute-0.3.1-13856abd873d-'));
  const daemon = fixture.calls[3]!.args.find(arg => arg.includes('start_new_session=True'))!;
  assert.ok(daemon.includes("'--role', 'all', '--standalone'"));
  assert.ok(daemon.includes('os.fchmod(fd, 0o600)'));
  assert.ok(daemon.includes('stdin=subprocess.DEVNULL'));
  assert.deepEqual(fixture.waits, [100, 200]);
});

test('ensure does not launch an already healthy daemon, and fails after bounded unhealthy retries', async () => {
  const ready = harness(['', envelope({ local_control_ready: true })]);
  await (await ready.create()).ensure();
  assert.equal(ready.calls.length, 3);
  const unhealthy = harness(['', envelope({ local_control_ready: false }), '',
    ...Array.from({ length: 9 }, () => envelope({ local_control_ready: false }))]);
  await assert.rejects((await unhealthy.create()).ensure(), { code: 'HIROUTE_HOST_NOT_READY' });
  assert.equal(unhealthy.waits.length, 9);
});

test('uses a real private short runtime directory and a pinned official Claude executable for capability probes', async () => {
  const fixture = harness(['', envelope({ local_control_ready: true })]);
  const host = await fixture.create();
  await host.ensure();
  const bootstrap = fixture.calls[0]!.args.find(arg => arg.includes('unsafe runtime alias'))!;
  assert.ok(bootstrap.includes("'chisa-hiroute-' + str(os.getuid())"));
  assert.ok(bootstrap.includes('runtime.symlink_to(short'));
  const installer = fixture.calls[1]!.args.find(arg => arg.includes('Claude package integrity mismatch'))!;
  assert.ok(installer.includes('hashlib.sha512(archive).digest()'));
  assert.ok(installer.includes("package.getmember('package/claude')"));
  assert.ok(installer.includes('https://registry.npmjs.org/@anthropic-ai/'));
  assert.ok(installer.includes('fcntl.LOCK_EX'));
});

test('cancels CLI operations while allowing shutdown to verify daemon identity and stop it', async () => {
  const fixture = harness(['']);
  const controller = new AbortController();
  const host = await fixture.create(7, 'abort-fixture', 'win32', controller.signal);
  controller.abort();
  await assert.rejects(host.cli(['agents', 'scan']), { code: 'HIROUTE_HOST_ABORTED' });
  await host.dispose();
  assert.equal(fixture.calls.length, 2);
  const cleanup = fixture.calls[1]!.args.find(arg => arg.includes('daemon identity mismatch'))!;
  assert.ok(cleanup.includes("proc / 'cmdline'"));
  assert.ok(cleanup.includes("proc / 'environ'"));
  assert.ok(cleanup.includes('signal.SIGTERM'));
});

test('kills an in-flight child immediately on abort without exposing its output', async () => {
  const fixture = harness([{ pending: true }]);
  const controller = new AbortController();
  const host = await fixture.create(7, 'abort-active', 'win32', controller.signal);
  const operation = host.cli(['agents', 'scan']);
  controller.abort();
  await assert.rejects(operation, { code: 'HIROUTE_HOST_ABORTED' });
  assert.equal(fixture.calls[1]!.killed, true);
});

test('rejects invalid host ids and input before starting unsafe processes', async () => {
  for (const id of [0, -1, 1.5, Number.NaN]) {
    const fixture = harness();
    await assert.rejects(fixture.create(id));
    assert.equal(fixture.calls.length, 0);
  }
  const fixture = harness();
  const host = await fixture.create();
  await assert.rejects(host.secret('candidate/ok', ''));
  await assert.rejects(host.secret('$(inject)', 'fixture'));
  await assert.rejects(host.grant('context\ninvalid'));
  await assert.rejects(host.cli(['unsafe\0arg']));
  await assert.rejects(host.bridgeCredentials(''));
  assert.equal(fixture.calls.length, 1);
});
