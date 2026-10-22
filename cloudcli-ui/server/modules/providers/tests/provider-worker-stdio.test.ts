import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// This runs only the real stdio worker + fixed fake CLI. Workspace namespaces
// and container cleanup are covered by the actual admitted VPS diagnostic.
test('stdio worker preserves UTF8 frames and exits when its parent input closes', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chisa-stdio-worker-'));
  const executable = path.join(root, 'fake.cjs');
  await writeFile(executable, "process.stdout.write('工具输出 🧪\\n'); process.stderr.write('诊断 🧪\\n');");
  const worker = fileURLToPath(new URL('../services/provider-process.worker.ts', import.meta.url));
  const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href;
  const child = spawn(process.execPath, ['--import', loader, worker, '--stdio'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, TSX_TSCONFIG_PATH: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)) } });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });
  child.stdout.on('data', (text: string) => { stdout += text; if (stdout.includes('"kind":"done"')) resolveDone(); });
  child.stderr.on('data', (text: string) => { stderr += text; });
  const closed = once(child, 'close');
  try {
    child.stdin.write(JSON.stringify({ kind: 'job', job: { kind: 'cli', command: process.execPath, args: [executable], cwd: root } }) + '\n');
    await Promise.race([done, closed.then(() => assert.fail(`Worker exited before done: ${stderr}`))]);
    const frames = stdout.trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(frames.filter((frame) => frame.kind === 'stdout').map((frame) => frame.text).join(''), '工具输出 🧪\n');
    assert.equal(frames.filter((frame) => frame.kind === 'stderr').map((frame) => frame.text).join(''), '诊断 🧪\n');
    assert.equal(frames.at(-1).code, 0);
    assert.equal(child.exitCode, null, 'Worker must stay alive until its owner cleans up');
    child.stdin.end();
    const [code] = await closed;
    assert.equal(code, 1);
  } finally {
    if (child.exitCode === null) { child.kill('SIGKILL'); await closed; }
    await rm(root, { recursive: true, force: true });
  }
});
