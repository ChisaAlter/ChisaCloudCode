import readline from 'node:readline';

import crossSpawn from 'cross-spawn';
import { Codex } from '@openai/codex-sdk';
import type { Input, ThreadOptions } from '@openai/codex-sdk';

import type { ProviderProcessEvent, ProviderProcessJob } from '@/shared/index.js';

// The supervisor owns this worker's process group / Windows Job Object. Stay
// alive after `done` until it has confirmed that all descendant tools stopped.
const keepAlive = setInterval(() => {}, 60_000);
const cancellation = new AbortController();
let started = false;

const stdioTransport = process.argv.includes('--stdio');

function send(event: ProviderProcessEvent) {
  if (stdioTransport) process.stdout.write(JSON.stringify(event) + '\n');
  else if (process.connected) process.send?.(event);
}

async function execute(job: ProviderProcessJob) {
  try {
    cancellation.signal.throwIfAborted();
    if (job.kind === 'codex') {
      // Executable/env overrides are trusted composition dependencies (used by
      // process fixtures), never copied from chat options or transport input.
      const protectedGit = Object.fromEntries(['GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_INDEX_FILE'].flatMap((key) => process.env[key] ? [[key, process.env[key]!]] : []));
      const codex = new Codex({ codexPathOverride: job.executable, env: job.env ? { ...job.env, ...(stdioTransport ? protectedGit : {}) } : undefined });
      const thread = job.providerSessionId
        ? codex.resumeThread(job.providerSessionId, job.threadOptions as ThreadOptions)
        : codex.startThread(job.threadOptions as ThreadOptions);
      const turn = await thread.runStreamed(job.input as Input, { signal: cancellation.signal });
      for await (const event of turn.events) send({ kind: 'event', event });
      send({ kind: 'done', code: 0 });
      return;
    }

    const child = crossSpawn(job.command, job.args, {
      cwd: job.cwd,
      env: { ...process.env, ...job.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let spawnError: Error | undefined;
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (text: string) => send({ kind: 'stdout', text }));
    child.stderr?.on('data', (text: string) => send({ kind: 'stderr', text }));
    child.on('error', (error) => { spawnError = error; });
    child.once('close', (code) => send({
      kind: 'done', code,
      ...(spawnError ? { error: { name: spawnError.name, message: spawnError.message } } : {}),
    }));
    child.stdin?.on('error', () => {});
    child.stdin?.end();
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    send({ kind: 'done', code: 1, error: { name: failure.name, message: failure.message } });
  }
}

function receive(message: { kind?: string; job?: ProviderProcessJob }) {
  if (message.kind === 'cancel') {
    cancellation.abort();
  } else if (message.kind === 'job' && message.job && !started) {
    started = true;
    void execute(message.job);
  }
}

if (stdioTransport) {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', (line) => {
    try { receive(JSON.parse(line) as { kind?: string; job?: ProviderProcessJob }); }
    catch { send({ kind: 'done', code: 1, error: { name: 'ProtocolError', message: 'Invalid provider worker input frame.' } }); }
  });
  input.once('close', () => {
    cancellation.abort();
    clearInterval(keepAlive);
    // In stdio mode the worker is container PID 1. Losing its trusted parent
    // must exit the container and reap tools instead of leaving a live run.
    process.exit(1);
  });
} else process.on('message', receive);

// A lost supervisor must not leave a provider running. The supervisor also
// verifies teardown; this is only a final attempt when its IPC channel vanishes.
process.once('disconnect', () => {
  clearInterval(keepAlive);
  if (process.platform !== 'win32') {
    try { process.kill(-process.pid, 'SIGKILL'); } catch { process.exit(1); }
  } else {
    // The supervisor's Job Object handle closes on its exit and kills every
    // member, including tools whose immediate CLI parent has already exited.
    process.exit(1);
  }
});
