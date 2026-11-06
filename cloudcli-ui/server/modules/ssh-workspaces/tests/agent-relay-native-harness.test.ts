import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('standalone actual broker survives lost poll, ACK and result responses and fences a reset epoch', { timeout: 30_000 }, async () => {
  const qaDirectory = await mkdtemp(path.join(tmpdir(), 'chisa-native-broker-wire-'));
  const source = import.meta.url.endsWith('.ts');
  const harness = process.env.CHISA_RELAY_QA_HARNESS ?? fileURLToPath(new URL(source ? './agent-relay-native-harness.ts' : './agent-relay-native-harness.js', import.meta.url));
  const args = harness.endsWith('.ts') ? [path.resolve('node_modules/tsx/dist/cli.mjs'), '--tsconfig', 'server/tsconfig.json', harness] : [harness];
  const child = spawn(process.execPath, args, { env: { ...process.env, CHISA_RELAY_QA_DIR: qaDirectory, CHISA_RELAY_QA_STDIN: '0' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const exit = once(child, 'exit');
  const output = createInterface({ input: child.stdout });
  let origin = '';
  let currentEpoch = '';
  let executionCount = 0;
  const token = 'a'.repeat(64);
  const headers = { 'content-type': 'application/json', 'X-Chisa-Agent-Token': token };
  const post = (suffix: string, body: unknown) => fetch(origin + suffix, { method: 'POST', headers, body: JSON.stringify(body) });
  const poll = () => fetch(origin + '/api/ssh-workspaces/agent/relay/poll?connectionId=desktop-wire&protocol=2', { headers });
  const handshake = async () => {
    const result = await (await fetch(origin + '/api/ssh-workspaces/agent/relay/poll?connectionId=desktop-wire&protocol=2&wait=0', { headers })).json() as { epoch: string; protocol: number };
    assert.equal(result.protocol, 2); currentEpoch = result.epoch; return result;
  };
  try {
    origin = await new Promise<string>((resolve, reject) => {
      output.on('line', line => {
        const event = JSON.parse(line) as { event: string; origin?: string };
        if (event.event === 'ready' && event.origin) resolve(event.origin);
      });
      child.once('error', reject);
      child.once('exit', code => reject(new Error(`Broker harness exited before ready (${code}): ${stderr}`)));
    });
    assert.equal((await post('/api/ssh-workspaces/agent/connections', { id: 'desktop-wire', name: 'Wire test', token, port: 18766, delivery: 'relay' })).status, 200);
    await handshake();
    await post('/qa/faults', { poll: 1, ack: 1, result: 1 });
    const payload = { protocol: 1, rootPath: 'C:\\QA', request: { op: 'read', path: '/workspace/marker.txt' } };
    const call = post('/qa/enqueue', { connectionId: 'desktop-wire', label: 'lost-responses', timeoutMs: 15_000, payload });
    await assert.rejects(poll(), /fetch failed|terminated|socket|closed/i);
    const state = await (await fetch(origin + '/qa/state')).json() as { events: Array<{ event: string; requestIds?: string[] }> };
    const lostId = state.events.find(event => event.event === 'poll' && event.requestIds?.length)?.requestIds?.[0];
    assert.ok(lostId, 'the dropped HTTP receive must have offered actual broker work');
    const redelivery = await (await poll()).json() as { epoch: string; jobs: Array<{ requestId: string; payload: unknown; deadlineAt: number }> };
    assert.equal(redelivery.jobs[0].requestId, lostId);
    assert.deepEqual(redelivery.jobs[0].payload, payload);
    assert.equal(redelivery.epoch, currentEpoch);
    const receipt = { connectionId: 'desktop-wire', epoch: currentEpoch, requestId: lostId };
    await assert.rejects(post('/api/ssh-workspaces/agent/relay/ack', receipt), /fetch failed|terminated|socket|closed/i);
    const ack = await (await post('/api/ssh-workspaces/agent/relay/ack', receipt)).json() as { accepted: boolean };
    assert.equal(ack.accepted, true);
    executionCount++;
    const response = { status: 200, body: '{"ok":true,"marker":"once"}' };
    await assert.rejects(post('/api/ssh-workspaces/agent/relay/result', { ...receipt, response }), /fetch failed|terminated|socket|closed/i);
    assert.deepEqual((await (await call).json() as { response: unknown }).response, response);
    const duplicate = await (await post('/api/ssh-workspaces/agent/relay/result', { ...receipt, response })).json() as { ok: boolean; accepted: boolean };
    assert.equal(duplicate.ok, true); assert.equal(duplicate.accepted, false); assert.equal(executionCount, 1);

    const pendingCall = post('/qa/enqueue', { connectionId: 'desktop-wire', label: 'reset-epoch', timeoutMs: 10_000, payload });
    const activeJob = (await (await poll()).json() as { jobs: Array<{ requestId: string }> }).jobs[0];
    const oldEpoch = currentEpoch;
    await post('/api/ssh-workspaces/agent/relay/ack', { ...receipt, requestId: activeJob.requestId });
    await post('/qa/reset', { connectionId: 'desktop-wire' });
    assert.equal((await (await pendingCall).json() as { error: { code: string } }).error.code, 'AGENT_RELAY_REPLACED');
    const heartbeat = await (await post('/api/ssh-workspaces/agent/relay/heartbeat', { connectionId: 'desktop-wire', epoch: oldEpoch, activeRequestIds: [activeJob.requestId] })).json() as { epoch: string; obsoleteRequestIds: string[] };
    assert.notEqual(heartbeat.epoch, oldEpoch);
    assert.deepEqual(heartbeat.obsoleteRequestIds, [activeJob.requestId]);
    await handshake();
    assert.equal(currentEpoch, heartbeat.epoch);
    assert.deepEqual(await (await post('/api/ssh-workspaces/agent/relay/ack', { ...receipt, requestId: activeJob.requestId })).json(), { ok: true, accepted: false, epoch: currentEpoch });

    const rejectionCall = post('/qa/enqueue', { connectionId: 'desktop-wire', label: 'journal-refusal', timeoutMs: 10_000, payload });
    const rejected = (await (await poll()).json() as { jobs: Array<{ requestId: string }> }).jobs[0];
    const refusal = await (await post('/api/ssh-workspaces/agent/relay/reject', { connectionId: 'desktop-wire', epoch: currentEpoch, requestId: rejected.requestId })).json() as { accepted: boolean };
    assert.equal(refusal.accepted, true);
    const refusedResult = await (await rejectionCall).json() as { response: { status: number; body: string } };
    assert.equal(refusedResult.response.status, 503);
    assert.equal(JSON.parse(refusedResult.response.body).code, 'AGENT_BUSY');
  } finally {
    if (origin && child.exitCode === null) await post('/qa/shutdown', {}).catch(() => {});
    if (child.exitCode === null) {
      const timer = setTimeout(() => child.kill(), 2000); timer.unref();
      await exit;
      clearTimeout(timer);
    }
    output.close();
    assert.equal(path.dirname(qaDirectory), tmpdir());
    await rm(qaDirectory, { recursive: true, force: true });
  }
  assert.equal(child.exitCode, 0, stderr);
});
