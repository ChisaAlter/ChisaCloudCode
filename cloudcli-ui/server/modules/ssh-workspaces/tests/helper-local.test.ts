import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, mkdir, symlink, link } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const helper = fileURLToPath(new URL('../../../../../app/resources/ssh-workspace.ps1', import.meta.url));
// Source-mode tests are five directories beneath cloudcli-ui, while app is its sibling.
const actualHelper = path.resolve(path.dirname(helper), 'ssh-workspace.ps1');
const windows = process.platform === 'win32';

function run(root: string, request: Record<string, unknown>, expectedRootIdentity?: string): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', actualHelper], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CHISA_SSH_HELPER_DIAGNOSTICS: '1' } });
    const chunks: Buffer[] = [];
    let stderr = '';
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Helper fixture timed out')); }, 25_000);
    child.stdout.on('data', chunk => chunks.push(Buffer.from(chunk)));
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', () => {
      clearTimeout(timeout);
      const raw = Buffer.concat(chunks).toString('utf8');
      try { const parsed = JSON.parse(raw); if (!parsed.ok && stderr) parsed.diagnostic = stderr; resolve(parsed); }
      catch { reject(new Error(`Invalid helper response: ${raw} stderr: ${stderr}`)); }
    });
    child.stdin.end(JSON.stringify({ protocol: 1, rootPath: root, expectedRootIdentity, request }), 'utf8');
  });
}

test('Windows helper handles real files, CAS conflicts, path restrictions and root identities', { skip: !windows, timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chisa-ssh-real-'));
  try {
    const probe = await run(root, { op: 'probe' });
    assert.equal(probe.ok, true, JSON.stringify(probe));
    assert.equal(probe.protocol, 1);
    assert.equal(probe.platform, 'win32');
    assert.ok(probe.rootIdentity);
    const text = 'hello 世界\r\nsecond line\n';
    const filename = "/workspace/中文 quote ' $` file.txt";
    const created = await run(root, { op: 'write', path: filename, b64: Buffer.from(text).toString('base64'), expectedHash: null }, probe.rootIdentity);
    assert.equal(created.ok, true, JSON.stringify(created));
    const read = await run(root, { op: 'read', path: filename }, probe.rootIdentity);
    assert.equal(Buffer.from(read.b64, 'base64').toString(), text);
    assert.equal(read.hash, created.hash);
    const conflict = await run(root, { op: 'write', path: filename, b64: Buffer.from('stale').toString('base64'), expectedHash: '0'.repeat(64) });
    assert.equal(conflict.code, 'CONTENT_CONFLICT');
    assert.equal(await readFile(path.join(root, "中文 quote ' $` file.txt"), 'utf8'), text);
    const collision = await run(root, { op: 'write', path: filename, b64: '', expectedHash: null });
    assert.equal(collision.code, 'CONTENT_CONFLICT');
    const writes = await Promise.all(['first', 'second'].map(value => run(root, { op: 'write', path: filename, b64: Buffer.from(value).toString('base64'), expectedHash: read.hash })));
    assert.equal(writes.filter(value => value.ok).length, 1);
    assert.ok(writes.some(value => value.code === 'CONTENT_CONFLICT' || value.code === 'SSH_WORKSPACE_PATH_UNSAFE'));
    const current = await run(root, { op: 'read', path: filename });
    const restore = await run(root, { op: 'write', path: filename, b64: Buffer.from(text).toString('base64'), expectedHash: current.hash });
    assert.equal(restore.ok, true);
    const list = await run(root, { op: 'list', includeStats: true });
    assert.equal(list.entries.length, 1);
    assert.equal(list.entries[0].stats.dir, false);
    const grep = await run(root, { op: 'grep', query: '世界' });
    assert.equal(grep.matches[0].line, 1);
    const changed = await run(root, { op: 'list' }, 'different-directory');
    assert.equal(changed.code, 'SSH_WORKSPACE_CHANGED');
    for (const unsafe of ['/workspace/../outside', 'C:/other', '//server/share', '/workspace/file:stream', '/workspace/NUL.txt', '/workspace/trailing.']) {
      const denied = await run(root, { op: 'read', path: unsafe });
      assert.equal(denied.ok, false, unsafe);
      assert.equal(denied.code, 'SSH_WORKSPACE_PATH_INVALID', unsafe);
    }
    const binary = Buffer.from([0, 1, 2, 255, 128, 42]);
    const binaryWrite = await run(root, { op: 'write', path: '/workspace/binary.bin', expectedHash: null, b64: binary.toString('base64') });
    assert.equal(binaryWrite.ok, true);
    assert.deepEqual(Buffer.from((await run(root, { op: 'read', path: '/workspace/binary.bin' })).b64, 'base64'), binary);
    await mkdir(path.join(root, 'outside'));
    await writeFile(path.join(root, 'outside', 'secret'), 'secret');
    await symlink(path.join(root, 'outside'), path.join(root, 'junction'), 'junction');
    assert.equal((await run(root, { op: 'read', path: '/workspace/junction/secret' })).code, 'SSH_WORKSPACE_PATH_UNSAFE');
    await link(path.join(root, 'outside', 'secret'), path.join(root, 'hardlink'));
    assert.equal((await run(root, { op: 'read', path: '/workspace/hardlink' })).code, 'SSH_WORKSPACE_PATH_UNSAFE');
    assert.equal((await run(root, { op: 'mkdir', path: '/workspace/new/deep/dir', recursive: true })).ok, true);
    assert.equal((await run(root, { op: 'copy', path: '/workspace/binary.bin', destination: '/workspace/copied.bin' })).ok, true);
    assert.equal((await run(root, { op: 'rename', path: '/workspace/copied.bin', destination: '/workspace/renamed.bin' })).ok, true);
    assert.equal((await run(root, { op: 'remove', path: '/workspace/renamed.bin' })).ok, true);
    assert.equal((await run(root, { op: 'remove', path: '/workspace/new', recursive: true })).ok, true);
    const batch = await run(root, { op: 'batch', requests: [{ op: 'stat', path: '/workspace/binary.bin' }, { op: 'realpath', path: '/workspace/binary.bin' }] });
    assert.equal(batch.results.length, 2);
    assert.equal(batch.results[1].path, '/workspace/binary.bin');
    const batchMutation = await run(root, { op: 'batch', requests: [{ op: 'remove', path: '/workspace/binary.bin' }] });
    assert.equal(batchMutation.code, 'SSH_WORKSPACE_REQUEST_INVALID');
    const rootRemove = await run(root, { op: 'remove' });
    assert.equal(rootRemove.code, 'SSH_WORKSPACE_PATH_INVALID');
  } finally { assert.equal(path.dirname(root), os.tmpdir()); await rm(root, { recursive: true, force: true }); }
});

test('Windows helper reports real command exits, argv data, timeout cleanup and nonreplayable jobs', { skip: !windows, timeout: 90_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chisa-ssh-exec-'));
  try {
    const id = randomUUID();
    const result = await run(root, { op: 'exec', jobId: id, path: '/workspace', timeoutSeconds: 10, command: '[Console]::Out.Write("hello stdout");[Console]::Error.Write("hello stderr");exit 7' });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.exitCode, 7);
    assert.equal(result.stdout, 'hello stdout');
    assert.equal(result.stderr, 'hello stderr');
    assert.equal(result.cleanupConfirmed, true);
    assert.equal((await run(root, { op: 'job_status', jobId: id })).cleanupConfirmed, true);
    assert.equal((await run(root, { op: 'exec', jobId: id, command: 'exit 0' })).code, 'SSH_JOB_EXISTS');
    const readOnly = await run(root, { op: 'exec', jobId: randomUUID(), command: 'exit 0', readOnly: true });
    assert.equal(readOnly.code, 'SSH_READ_ONLY_COMMAND_UNSUPPORTED');
    const timeout = await run(root, { op: 'exec', jobId: randomUUID(), command: 'Start-Sleep -Seconds 20', timeoutSeconds: 1 });
    assert.equal(timeout.ok, true, JSON.stringify(timeout));
    assert.equal(timeout.exitCode, 124);
    assert.equal(timeout.timedOut, true);
    assert.equal(timeout.cleanupConfirmed, true);
    const argument = "中文 space quote ' $()` value";
    const argv = await run(root, { op: 'exec', jobId: randomUUID(), argv: ['cmd.exe', '/d', '/c', 'exit', '3'], timeoutSeconds: 5 });
    assert.equal(argv.exitCode, 3, argument + JSON.stringify(argv));
    await writeFile(path.join(root, 'argument.ps1'), '[Console]::Out.Write($args[0]+"|"+$args[1])', 'utf8');
    const mapped = await run(root, { op: 'exec', jobId: randomUUID(), argv: ['powershell.exe', '-NoProfile', '-File', '/workspace/argument.ps1', '/workspace', argument], timeoutSeconds: 5 });
    assert.equal(mapped.stdout, root + '|' + argument, JSON.stringify(mapped));
  } finally { assert.equal(path.dirname(root), os.tmpdir()); await rm(root, { recursive: true, force: true }); }
});
