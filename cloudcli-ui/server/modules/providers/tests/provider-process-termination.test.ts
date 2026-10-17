import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';

import { terminateProviderProcess } from '@/shared/index.js';

function isRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

async function waitUntilGone(pid: number): Promise<void> {
  const deadline = Date.now() + 3000;
  while (isRunning(pid)) {
    assert.ok(Date.now() < deadline, `Owned fixture process ${pid} is still running after termination confirmation`);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

test('terminateProviderProcess confirms a real owned CLI and its spawned descendant have stopped', { timeout: 15000 }, async (t) => {
  const source = `
    const { spawn } = require('node:child_process');
    const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
    descendant.once('spawn', () => process.stdout.write(JSON.stringify({ descendantPid: descendant.pid }) + '\\n'));
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['-e', source], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  let descendantPid: number | undefined;
  t.after(() => {
    // Only this test's two known children are eligible for cleanup.
    for (const pid of [descendantPid, child.pid]) {
      if (pid && isRunning(pid)) process.kill(pid, 'SIGKILL');
    }
  });
  const [data] = await once(child.stdout!, 'data');
  descendantPid = JSON.parse(String(data).trim()).descendantPid as number;
  assert.ok(child.pid);
  assert.ok(descendantPid);
  assert.equal(isRunning(child.pid), true);
  assert.equal(isRunning(descendantPid), true);
  let childClosed = false;
  child.once('close', () => { childClosed = true; });
  await terminateProviderProcess(child);
  assert.equal(childClosed, true, 'Termination must not resolve from signal delivery alone');
  await waitUntilGone(child.pid);
  await waitUntilGone(descendantPid);
});

test('terminateProviderProcess accepts an owned process whose exit is already confirmed', { timeout: 5000 }, async () => {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore', detached: process.platform !== 'win32', windowsHide: true });
  await once(child, 'close');
  await terminateProviderProcess(child);
  assert.equal(child.exitCode, 0);
});
