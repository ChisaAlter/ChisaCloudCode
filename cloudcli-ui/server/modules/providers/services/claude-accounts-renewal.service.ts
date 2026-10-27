import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';

import spawn from 'cross-spawn';

import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';
import type { ClaudeAccountCredentialRead } from '@/shared/types.js';

const RENEW_BEFORE_MS = 5 * 60_000;
const RETRY_MS = 30_000;
const MAX_RETRY_MS = 15 * 60_000;
const isolatedAuth = {
  ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_BASE_URL: '', ANTHROPIC_CUSTOM_HEADERS: '',
  CLAUDE_CODE_OAUTH_TOKEN: '', CLAUDE_CODE_OAUTH_REFRESH_TOKEN: '', CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '', CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: '',
  CLAUDE_CODE_HOST_CREDS_FILE: '', CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH: '', CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: '',
  CLAUDE_CODE_USE_BEDROCK: '0', CLAUDE_CODE_USE_VERTEX: '0', CLAUDE_CODE_USE_FOUNDRY: '0',
};
type RenewalOptions = {
  now?: () => number;
  env?: () => NodeJS.ProcessEnv;
  resolveExecutable?: () => string | undefined;
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  timeoutMs?: number;
};
type Running = { child: ChildProcess; done: Promise<void>; stop(): void };

function fingerprint(value: ClaudeAccountCredentialRead): string {
  return createHash('sha256').update(JSON.stringify([value.renewalFingerprint, value.accessToken, value.expiresAt, value.refreshable, value.email, value.organizationUuid])).digest('hex');
}
function due(value: ClaudeAccountCredentialRead, now: number): boolean {
  return !value.unavailable && value.refreshable && (!value.accessToken || value.expiresAt !== null && value.expiresAt <= now + RENEW_BEFORE_MS);
}

/** The account coordinator invokes official CLI initialization for silent renewal; the CLI owns token rotation, cross-process locks and CAS persistence. */
export class ClaudeAccountRenewalService {
  private readonly pending = new Map<string, Promise<void>>();
  private readonly failures = new Map<string, { fingerprint: string; count: number; retryAt: number }>();
  private readonly running = new Map<string, Running>();
  private disposed = false;

  constructor(private readonly options: RenewalOptions = {}) {}

  isBusy(key: string): boolean { return this.pending.has(key) || this.running.has(key); }
  evict(key: string): void { this.failures.delete(key); }

  async ensure(key: string, readCredentials: () => ClaudeAccountCredentialRead, paths: () => { configDir: string; authDir: string }): Promise<void> {
    if (this.disposed) return;
    const current = readCredentials();
    if (!due(current, this.now())) { this.failures.delete(key); return; }
    const pending = this.pending.get(key);
    if (pending) return pending;
    // A timed-out process that has not actually closed must never race a new renewal/login/removal.
    if (this.running.has(key)) return;
    const identity = fingerprint(current);
    const previous = this.failures.get(key);
    if (previous?.fingerprint === identity && previous.retryAt > this.now()) return;
    const directories = paths();
    const operation = this.run(key, directories).then(() => {
      const renewed = readCredentials();
      if (!due(renewed, this.now())) { this.failures.delete(key); return; }
      const count = previous?.fingerprint === identity ? Math.min(previous.count + 1, 8) : 1;
      this.failures.set(key, { fingerprint: fingerprint(renewed), count, retryAt: this.now() + Math.min(RETRY_MS * 2 ** (count - 1), MAX_RETRY_MS) });
    }).finally(() => { if (this.pending.get(key) === operation) this.pending.delete(key); });
    this.pending.set(key, operation);
    return operation;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const runs = [...this.running.values()];
    for (const run of runs) run.stop();
    await Promise.all(runs.map(run => run.done));
    await Promise.all([...this.pending.values()]);
  }

  private now(): number { return (this.options.now ?? Date.now)(); }

  private async run(key: string, directories: { configDir: string; authDir: string }): Promise<void> {
    const env: NodeJS.ProcessEnv = { ...(this.options.env ?? (() => process.env))(), ...isolatedAuth,
      CLAUDE_CONFIG_DIR: directories.configDir, CLAUDE_SECURESTORAGE_CONFIG_DIR: directories.authDir,
      DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    };
    const executable = (this.options.resolveExecutable ?? (() => resolveClaudeCodeExecutablePath(env.CLAUDE_CLI_PATH)))();
    if (!executable) return;
    const script = /\.(?:cjs|mjs|js|ts)$/i.test(executable);
    let child: ChildProcess;
    try {
      // Proven against the shipped official 2.1.303 binary: subcommand-root initialization refreshes expired OAuth,
      // takes .oauth_refresh.lock and the legacy lock, then CAS-saves rotating tokens. No prompt/model call occurs.
      child = (this.options.spawn ?? ((command, args, options) => spawn(command, args, options)))(script ? process.execPath : executable,
        [...(script ? [executable] : []), '--setting-sources', '', '--settings', JSON.stringify({ disableAllHooks: true, apiKeyHelper: '', env: isolatedAuth }), 'auth', 'status', '--json'],
        { cwd: directories.configDir, env, stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true, detached: process.platform !== 'win32' });
    } catch { return; }
    let settle: () => void = () => {};
    const done = new Promise<void>(resolve => { settle = resolve; });
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let force: ReturnType<typeof setTimeout> | null = null;
    let deadline: ReturnType<typeof setTimeout> | null = null;
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      if (process.platform === 'win32' && child.pid) {
        const killer = nodeSpawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        killer.once('error', () => { try { child.kill('SIGKILL'); } catch {} });
      } else {
        try { if (child.pid) process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
        force = setTimeout(() => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} } }, 800);
        force.unref?.();
      }
      // Keep the running guard until actual close, even if an abnormal OS/process failure exceeds the wait bound.
      deadline = setTimeout(settle, 5_000); deadline.unref?.();
    };
    const closed = () => {
      if (timeout) clearTimeout(timeout); if (force) clearTimeout(force); if (deadline) clearTimeout(deadline);
      if (this.running.get(key)?.child === child) this.running.delete(key);
      settle();
    };
    this.running.set(key, { child, done, stop });
    child.once('close', closed);
    child.once('error', () => { if (!child.pid) closed(); else stop(); });
    timeout = setTimeout(stop, this.options.timeoutMs ?? 45_000); timeout.unref?.();
    await done;
  }
}
