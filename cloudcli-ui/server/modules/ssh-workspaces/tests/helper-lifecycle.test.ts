import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { createSshWorkspaceTransport } from '../index.js';

const helper = fileURLToPath(new URL('../../../../../app/resources/ssh-workspace.ps1', import.meta.url));
const windows = process.platform === 'win32';

function begin(rootPath: string, request: Record<string, unknown>, deferInput = false) {
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const chunks: Buffer[] = [];
  let error = '';
  child.stdout.on('data', bytes => chunks.push(Buffer.from(bytes)));
  child.stderr.on('data', bytes => { error += bytes.toString(); });
  const completion = new Promise<Record<string, any>>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error(error || 'Helper emitted no result')); }
    });
  });
  const transmit = () => child.stdin.end(JSON.stringify({ protocol: 1, rootPath, request }), 'utf8');
  if (!deferInput) transmit();
  return { child, completion, transmit };
}

async function untilFile(file: string): Promise<string> {
  const end = Date.now() + 15_000;
  for (;;) {
    try { return await readFile(file, 'utf8'); } catch { if (Date.now() > end) throw new Error('Fixture command never started'); }
    await new Promise<void>(resolve => setTimeout(resolve, 50));
  }
}
async function isAlive(pid: number): Promise<boolean> {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test('real SSH bootstrap preserves stdin UTF-8 and helper probe output', { skip: !windows, timeout: 30_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chisa-ssh-bootstrap-'));
  try {
    const transport = createSshWorkspaceTransport({
      env: { CHISA_SSH_CONNECTIONS_FILE: 'C:\\fixture\\catalog.json' },
      readCatalog: async () => JSON.stringify([{ id: 'fixture', name: 'test', ownerId: 'owner', host: 'localhost', port: 22, username: 'worker', identityFile: 'C:\\fixture\\key', knownHostsFile: 'C:\\fixture\\hosts', helperPath: helper }]),
      spawn(_command, args, options) {
        const encoded = args.at(-1)!;
        return spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], options);
      },
    });
    const result = await transport.probeSshWorkspace({ connectionId: 'fixture', rootPath: root, userId: 'owner' });
    assert.equal(result.rootPath, root);
    assert.equal(result.helperVersion, '1.0.2');
    assert.ok(result.rootIdentity);
    const write = await transport.executeSshWorkspace({ connectionId: 'fixture', rootPath: root, userId: 'owner', expectedRootIdentity: result.rootIdentity, request: { op: 'write', path: '/workspace/中文.txt', b64: Buffer.from('中文 stdin').toString('base64'), expectedHash: null } });
    assert.equal(write.ok, true);
    assert.equal(await readFile(path.join(root, '中文.txt'), 'utf8'), '中文 stdin');
  } finally { assert.equal(path.dirname(root), os.tmpdir()); await rm(root, { recursive: true, force: true }); }
});

test('cancelling before a delayed helper request claims the ID and prevents any later command', { skip: !windows, timeout: 30_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chisa-ssh-prestart-'));
  const id = randomUUID();
  const marker = path.join(root, 'must-not-exist');
  const command = '[IO.File]::WriteAllText("' + marker.replaceAll('"', '`"') + '","executed")';
  const delayed = begin(root, { op: 'exec', jobId: id, command, timeoutSeconds: 10 }, true);
  try {
    const before = await begin(root, { op: 'job_status', jobId: id }).completion;
    assert.equal(before.state, 'not_found');
    assert.equal(before.cleanupConfirmed, false);
    const [cancelled, concurrentCancel] = await Promise.all([
      begin(root, { op: 'job_cancel', jobId: id }).completion,
      begin(root, { op: 'job_cancel', jobId: id }).completion,
    ]);
    const confirmed = [cancelled, concurrentCancel].filter(result => result.cleanupConfirmed === true);
    assert.ok(confirmed.length >= 1, JSON.stringify([cancelled, concurrentCancel]));
    assert.ok(confirmed.every(result => result.jobId === id && result.state === 'cancelled' && result.exitCode === 130));
    const status = await begin(root, { op: 'job_status', jobId: id }).completion;
    assert.equal(status.state, 'cancelled');
    assert.equal(status.cleanupConfirmed, true);
    delayed.transmit();
    const refused = await delayed.completion;
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'SSH_JOB_EXISTS');
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
    const after = await begin(root, { op: 'job_cancel', jobId: id }).completion;
    assert.equal(after.cleanupConfirmed, true);
    assert.equal(after.state, 'cancelled');
  } finally {
    delayed.child.kill();
    await delayed.completion.catch(() => {});
    assert.equal(path.dirname(root), os.tmpdir());
    await rm(root, { recursive: true, force: true });
  }
});

test('cancel preserves uncertainty when another executor claimed the ID but has not published state', { skip: !windows, timeout: 30_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chisa-ssh-claimed-'));
  const id = randomUUID();
  const localAppData = process.env.LOCALAPPDATA;
  assert.ok(localAppData, 'Windows local application data folder is required');
  const jobDirectory = path.join(localAppData, 'ChisaCloudCode', 'ssh-workspace-jobs', 'v1', id);
  const claim = path.join(jobDirectory, 'claimed');
  const marker = path.join(root, 'must-not-exist');
  try {
    await mkdir(jobDirectory, { recursive: true });
    await writeFile(claim, 'executor already reserved this ID', { flag: 'wx' });
    const cancelled = await begin(root, { op: 'job_cancel', jobId: id }).completion;
    assert.equal(cancelled.state, 'not_found');
    assert.equal(cancelled.cleanupConfirmed, false);
    assert.equal(await readFile(claim, 'utf8'), 'executor already reserved this ID');
    await assert.rejects(readFile(path.join(jobDirectory, 'state.json')), { code: 'ENOENT' });
    const refused = await begin(root, { op: 'exec', jobId: id, command: '[IO.File]::WriteAllText("' + marker.replaceAll('"', '`"') + '","executed")' }).completion;
    assert.equal(refused.code, 'SSH_JOB_EXISTS');
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
    const status = await begin(root, { op: 'job_status', jobId: id }).completion;
    assert.equal(status.cleanupConfirmed, false);
  } finally {
    assert.equal(path.dirname(root), os.tmpdir());
    await rm(root, { recursive: true, force: true });
  }
});

test('cancel stops a real child and yields confirmed cleanup; killing helper kills its owned job', { skip: !windows, timeout: 60_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chisa-ssh-cancel-'));
  try {
    for (const abrupt of [false, true]) {
      const id = randomUUID();
      const pidFile = path.join(root, abrupt ? 'abrupt-pid' : 'cancel-pid');
      const command = '[IO.File]::WriteAllText("' + pidFile.replaceAll('"', '`"') + '",[string]$PID);Start-Sleep -Seconds 30';
      const execution = begin(root, { op: 'exec', jobId: id, command, timeoutSeconds: 40 });
      const pid = Number(await untilFile(pidFile));
      assert.ok(pid > 0);
      try {
      if (abrupt) {
        execution.child.kill();
        await execution.completion.catch(() => {});
        const end = Date.now() + 5000;
        while (await isAlive(pid) && Date.now() < end) await new Promise<void>(resolve => setTimeout(resolve, 25));
        assert.equal(await isAlive(pid), false);
        const status = await begin(root, { op: 'job_status', jobId: id }).completion;
        assert.equal(status.cleanupConfirmed, true, JSON.stringify(status));
      } else {
        const cancelled = await begin(root, { op: 'job_cancel', jobId: id }).completion;
        assert.equal(cancelled.cleanupConfirmed, true, JSON.stringify(cancelled));
        const result = await execution.completion;
        assert.equal(result.cleanupConfirmed, true);
        assert.equal(await isAlive(pid), false);
      }
      } finally {
        execution.child.kill();
        await execution.completion.catch(() => {});
      }
    }
  } finally { assert.equal(path.dirname(root), os.tmpdir()); await rm(root, { recursive: true, force: true }); }
});
