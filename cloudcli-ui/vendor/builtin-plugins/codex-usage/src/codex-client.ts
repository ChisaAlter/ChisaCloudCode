import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

type RpcResponse = {
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
};

const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_SERVER_MAX_AGE_MS = 10 * 60_000;

type FileStat = {
  dev: number | bigint;
  ino: number | bigint;
  size: number;
  mtimeMs: number;
};

type CodexAppServerClientOptions = {
  authPath?: string;
  maxServerAgeMs?: number;
  now?: () => number;
  readStat?: (filePath: string) => Promise<FileStat>;
  spawnAppServer?: () => ChildProcessWithoutNullStreams;
};

function fingerprint(fileStat: FileStat): string {
  return `${fileStat.dev}:${fileStat.ino}:${fileStat.size}:${fileStat.mtimeMs}`;
}

/** Small JSON-RPC client for the official `codex app-server` stdio transport. */
export class CodexAppServerClient {
  private process: ChildProcessWithoutNullStreams | null = null;
  private startPromise: Promise<void> | null = null;
  private freshnessQueue: Promise<unknown> = Promise.resolve();
  private initialized = false;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private stderrTail = '';
  private authFingerprint: string | null = null;
  private startedAt = 0;
  private readonly authPath: string;
  private readonly maxServerAgeMs: number;
  private readonly now: () => number;
  private readonly readStat: (filePath: string) => Promise<FileStat>;
  private readonly spawnAppServer: () => ChildProcessWithoutNullStreams;

  constructor(options: CodexAppServerClientOptions = {}) {
    this.authPath = options.authPath ?? path.join(os.homedir(), '.codex', 'auth.json');
    this.maxServerAgeMs = options.maxServerAgeMs ?? DEFAULT_SERVER_MAX_AGE_MS;
    this.now = options.now ?? Date.now;
    this.readStat = options.readStat ?? stat;
    this.spawnAppServer = options.spawnAppServer ?? (() => spawn('codex', ['app-server', '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    }));
  }

  async request(method: string, params: JsonRecord = {}): Promise<unknown> {
    // Serialize only auth/server freshness checks. Account reads are safe to
    // run concurrently and can each take several seconds inside Codex; putting
    // the full requests in one queue made the tab wait for their combined time.
    const ready = this.freshnessQueue.then(
      () => this.ensureFreshServer(),
      () => this.ensureFreshServer(),
    );
    this.freshnessQueue = ready.catch(() => undefined);
    await ready;
    return this.sendRequest(method, params);
  }

  close(): void {
    const process = this.process;
    this.process = null;
    this.initialized = false;
    this.authFingerprint = null;
    this.startedAt = 0;
    if (process && !process.killed) process.kill('SIGTERM');
    this.rejectPending(new Error('Codex app-server stopped.'));
  }

  private async authFileFingerprint(): Promise<string> {
    try {
      return fingerprint(await this.readStat(this.authPath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return 'missing';
      throw error;
    }
  }

  private async ensureFreshServer(): Promise<void> {
    const beforeStart = await this.authFileFingerprint();
    const authChanged = this.authFingerprint !== null && this.authFingerprint !== beforeStart;
    const expired = this.startedAt > 0 && this.now() - this.startedAt >= this.maxServerAgeMs;
    if (authChanged || expired) this.stopForRestart();

    await this.ensureStarted();

    // If auth.json changed while app-server was starting, restart once more so
    // the process cannot retain the account that was current before the swap.
    const afterStart = await this.authFileFingerprint();
    if (afterStart !== beforeStart) {
      this.stopForRestart();
      await this.ensureStarted();
    }
    this.authFingerprint = afterStart;
  }

  private stopForRestart(): void {
    const process = this.process;
    this.process = null;
    this.initialized = false;
    this.startedAt = 0;
    if (process && !process.killed) process.kill('SIGTERM');
    this.rejectPending(new Error('Codex app-server restarted after authentication changed.'));
  }

  private async ensureStarted(): Promise<void> {
    if (this.process && this.initialized && !this.process.killed) return;
    if (!this.startPromise) {
      this.startPromise = this.start().finally(() => {
        this.startPromise = null;
      });
    }
    await this.startPromise;
  }

  private async start(): Promise<void> {
    const child = this.spawnAppServer();
    this.process = child;
    this.initialized = false;
    this.stderrTail = '';

    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => this.handleLine(line));
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString('utf8')}`.slice(-8_000);
    });
    child.once('error', (error) => {
      this.handleExit(child, new Error(`Unable to start Codex CLI: ${error.message}`));
    });
    child.once('exit', (code, signal) => {
      const detail = this.stderrTail.trim();
      const suffix = detail ? ` ${detail}` : '';
      this.handleExit(child, new Error(`Codex app-server exited (${signal ?? code ?? 'unknown'}).${suffix}`));
    });

    await this.sendRequest('initialize', {
      clientInfo: {
        name: 'cloudcli_codex_usage',
        title: 'ChisaCloudCode Codex Usage',
        version: '1.0.0',
      },
      capabilities: {
        optOutNotificationMethods: ['account/rateLimits/updated'],
      },
    });
    this.sendNotification('initialized', {});
    this.initialized = true;
    this.startedAt = this.now();
  }

  private sendRequest(method: string, params: JsonRecord): Promise<unknown> {
    const child = this.process;
    if (!child || child.killed || !child.stdin.writable) {
      return Promise.reject(new Error('Codex app-server is not running.'));
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ method, id, params })}\n`, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(error);
      });
    });
  }

  private sendNotification(method: string, params: JsonRecord): void {
    const child = this.process;
    if (child && !child.killed && child.stdin.writable) {
      child.stdin.write(`${JSON.stringify({ method, params })}\n`);
    }
  }

  private handleLine(line: string): void {
    let message: RpcResponse;
    try {
      message = JSON.parse(line) as RpcResponse;
    } catch {
      return;
    }
    if (typeof message.id !== 'number') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.message ?? `Codex app-server error ${message.error.code ?? ''}`.trim()));
    } else {
      pending.resolve(message.result);
    }
  }

  private handleExit(child: ChildProcessWithoutNullStreams, error: Error): void {
    // A deliberately stopped process can exit after its replacement starts.
    // Ignore that stale exit instead of clearing the replacement connection.
    if (this.process !== child) return;
    this.process = null;
    this.initialized = false;
    this.startedAt = 0;
    this.rejectPending(error);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

type JsonRecord = Record<string, unknown>;
