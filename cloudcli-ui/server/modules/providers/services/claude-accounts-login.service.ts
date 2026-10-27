import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import spawn from 'cross-spawn';

import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';
import type { ClaudeAccountLoginTask } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

type LoginStart = { userId: number; accountId: string; name: string; home: string; newAccount: boolean };
type InternalLogin = LoginStart & { dto: ClaudeAccountLoginTask; child: ChildProcess | null; closed: boolean; timer: ReturnType<typeof setTimeout> | null; finishedAt: number | null; teardown: Promise<void> | null; abandoned: boolean };
type LoginOptions = {
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  now?: () => number;
  timeoutMs?: number;
  env?: () => NodeJS.ProcessEnv;
  resolveExecutable?: () => string | undefined;
  assertHome: (userId: number, accountId: string) => string;
  onSuccess: (input: LoginStart) => void;
  onAbandon: (input: LoginStart) => void;
};
const finished = (status: ClaudeAccountLoginTask['status']) => ['succeeded', 'failed', 'cancelled'].includes(status);
const authorizeHosts = new Set(['claude.ai', 'claude.com']);

function loginUrl(scanned: string): string | null {
  for (const match of scanned.matchAll(/https:\/\/[^\s<>"'\x00-\x1f\x7f]+[\t\r\n ]/g)) {
    try {
      const url = new URL(match[0].trim().replace(/[),.;\]}]+$/, ''));
      const redirect = new URL(url.searchParams.get('redirect_uri') ?? '');
      // Only publish Claude's non-local manual-code authorization flow, never an arbitrary URL from child output.
      if (authorizeHosts.has(url.hostname) && !url.username && !url.password && url.port === '' && /^\/(?:(?:cai\/)?oauth\/)?authorize\/?$/.test(url.pathname)
        && url.searchParams.get('code') === 'true' && redirect.protocol === 'https:' && new Set(['claude.ai', 'claude.com', 'platform.claude.com', 'console.anthropic.com']).has(redirect.hostname) && !redirect.username && !redirect.password && !redirect.port) return url.toString();
    } catch { /* Incomplete/chunked URLs remain private until a following output chunk completes them. */ }
  }
  return null;
}

/** Providers creates bounded, caller-owned CLI login tasks; process output is scanned privately and never returned or logged. */
export class ClaudeAccountLoginService {
  private readonly tasks = new Map<string, InternalLogin>();
  private readonly byUser = new Map<number, string>();

  constructor(private readonly options: LoginOptions) {}

  async start(input: LoginStart): Promise<ClaudeAccountLoginTask> {
    const previousId = this.byUser.get(input.userId);
    if (previousId) {
      const previous = this.tasks.get(previousId);
      if (previous) {
        await this.cancel(input.userId, previousId);
        if (previous.child && !previous.closed) await this.stop(previous);
      }
    }
    this.prune();
    const now = this.now();
    const task: InternalLogin = { ...input, dto: { id: randomUUID(), accountId: input.accountId, status: 'starting', url: null, error: null, expiresAt: now + (this.options.timeoutMs ?? 600_000) }, child: null, closed: false, timer: null, finishedAt: null, teardown: null, abandoned: false };
    this.tasks.set(task.dto.id, task);
    this.byUser.set(input.userId, task.dto.id);
    try {
      const home = this.options.assertHome(input.userId, input.accountId);
      if (home !== input.home) throw new Error('Mismatched login home');
      const helper = path.join(home, process.platform === 'win32' ? '.chisa-login-browser.cmd' : '.chisa-login-browser');
      if (fs.existsSync(helper) && (!fs.lstatSync(helper).isFile() || fs.lstatSync(helper).isSymbolicLink() || fs.lstatSync(helper).nlink > 1)) throw new Error('Unsafe browser helper');
      fs.writeFileSync(helper, process.platform === 'win32' ? '@exit /b 0\r\n' : '#!/bin/sh\nexit 0\n', { mode: 0o700 });
      const env: NodeJS.ProcessEnv = { ...(this.options.env ?? (() => process.env))(), CLAUDE_CONFIG_DIR: home, CLAUDE_SECURESTORAGE_CONFIG_DIR: home, BROWSER: helper,
        ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_BASE_URL: '', CLAUDE_CODE_OAUTH_TOKEN: '', CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '', CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: '',
        CLAUDE_CODE_USE_BEDROCK: '0', CLAUDE_CODE_USE_VERTEX: '0', CLAUDE_CODE_USE_FOUNDRY: '0' };
      const executable = (this.options.resolveExecutable ?? (() => resolveClaudeCodeExecutablePath(env.CLAUDE_CLI_PATH)))();
      if (!executable) {
        this.fail(task, '当前服务器未找到 Claude CLI，请安装 Claude Code 或配置 CLAUDE_CLI_PATH。');
        await this.abandon(task);
        return this.public(task);
      }
      const script = /\.(?:cjs|mjs|js|ts)$/i.test(executable);
      const child = (this.options.spawn ?? ((command, args, options) => spawn(command, args, options)))(script ? process.execPath : executable, [...(script ? [executable] : []), 'auth', 'login', '--claudeai'], {
        cwd: home, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32',
      });
      task.child = child;
      const scanned = { stdout: '', stderr: '' };
      const scan = (stream: keyof typeof scanned, chunk: Buffer | string) => {
        if (finished(task.dto.status)) return;
        // Reparse each stream's bounded raw tail so split escapes remain complete; stderr cannot finish a stdout URL.
        scanned[stream] = `${scanned[stream]}${String(chunk)}`.slice(-16_384);
        const cleaned = scanned[stream].replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\u001b\](?:[^\u0007\u001b]|\u001b(?!\\))*(?:\u0007|\u001b\\)/g, '');
        if (!task.dto.url) {
          const url = loginUrl(cleaned);
          if (url) { task.dto.url = url; task.dto.status = 'waiting_code'; }
        }
        // The CLI keeps its stdin open after rejecting manual input; allow a corrected code on the same task.
        if (task.dto.status === 'completing' && /Invalid code\. Please make sure the full code was copied\.|That code is not from this sign-in\./.test(cleaned)) {
          task.dto.status = 'waiting_code';
          task.dto.error = '授权码未被接受，请重新复制当前授权页面显示的授权码后再提交。';
          scanned.stdout = scanned.stderr = '';
        }
      };
      child.stdout?.on('data', chunk => scan('stdout', chunk));
      child.stderr?.on('data', chunk => scan('stderr', chunk));
      child.once('error', () => {
        if (!finished(task.dto.status)) this.fail(task, '无法启动 Claude CLI；请检查安装位置或 CLAUDE_CLI_PATH。');
        void this.stop(task).then(() => this.abandon(task)).catch(() => {});
      });
      child.once('close', code => {
        task.closed = true;
        if (task.timer) clearTimeout(task.timer);
        task.timer = null;
        if (!finished(task.dto.status)) {
          if (code === 0) {
            try {
              this.options.assertHome(task.userId, task.accountId);
              this.options.onSuccess(task);
              task.dto.status = 'succeeded';
              task.dto.url = null;
              task.finishedAt = this.now();
            } catch {
              this.fail(task, 'Claude 登录已结束，但未找到完整订阅身份；请重试登录。');
            }
          } else this.fail(task, task.dto.status === 'completing' ? 'Claude 未接受该授权码，请重新登录。' : 'Claude 登录未完成，请重新开始。');
        }
        if (task.dto.status !== 'succeeded') void this.abandon(task).catch(() => {});
        scanned.stdout = scanned.stderr = '';
        this.removeHelper(task);
      });
      task.timer = setTimeout(() => {
        if (finished(task.dto.status)) return;
        this.fail(task, 'Claude 登录已超时，请重新开始。');
        void this.stop(task).then(() => this.abandon(task)).catch(() => {});
      }, Math.max(1, task.dto.expiresAt - now));
      task.timer.unref?.();
    } catch {
      this.fail(task, '无法准备 Claude 账号登录，请重试。');
      await this.abandon(task).catch(() => {});
    }
    return this.public(task);
  }

  get(userId: number, id: string): ClaudeAccountLoginTask {
    return this.public(this.require(userId, id));
  }

  submitCode(userId: number, id: string, code: string): ClaudeAccountLoginTask {
    const task = this.require(userId, id);
    if (task.dto.expiresAt <= this.now() || task.dto.status !== 'waiting_code' || !task.child?.stdin?.writable) throw new AppError('此次授权已到期或正在处理中，请查看登录状态后重试。', { code: 'CLAUDE_LOGIN_NOT_WAITING', statusCode: 409 });
    // Browser copying can insert wrapping whitespace. Keep code/state contents opaque and never log them.
    const compact = code.replace(/[\s\u200b-\u200d\u2060\ufeff]+/g, '');
    const invalidCode = () => new AppError('授权码格式不正确，请复制当前 Claude 授权页面显示的完整授权码。', { code: 'CLAUDE_LOGIN_CODE_INVALID', statusCode: 400 });
    if (!compact || compact.length > 4096 || !/^[A-Za-z0-9._~+/%=#-]+$/.test(compact)) throw invalidCode();
    const parts = compact.split('#');
    let expectedState: string | null;
    try { expectedState = new URL(task.dto.url ?? '').searchParams.get('state'); } catch { throw invalidCode(); }
    if (!parts[0] || parts.length > 2 || parts.length === 2 && !parts[1]) throw invalidCode();
    if (!expectedState) throw new AppError('本次授权缺少状态信息，请取消后重新开始登录。', { code: 'CLAUDE_LOGIN_NOT_WAITING', statusCode: 409 });
    // Preserve the official manual callback verbatim. Claude owns state/PKCE and validates the code at token exchange;
    // its auth-login manual callback does not compare the pasted suffix with the displayed URL's state.
    const fullCode = parts.length === 2 ? compact : `${parts[0]}#${expectedState}`;
    task.dto.status = 'completing';
    task.dto.error = null;
    task.child.stdin.write(`${fullCode}\n`, error => {
      if (!error || finished(task.dto.status)) return;
      this.fail(task, '授权码未能提交，请重新登录。');
      void this.stop(task).then(() => this.abandon(task)).catch(() => {});
    });
    return this.public(task);
  }

  async cancel(userId: number, id: string): Promise<ClaudeAccountLoginTask> {
    const task = this.require(userId, id);
    if (finished(task.dto.status)) {
      if (task.child && !task.closed) await this.stop(task);
      if (task.dto.status !== 'succeeded') await this.abandon(task);
      return this.public(task);
    }
    task.dto.status = 'cancelled';
    task.dto.url = null;
    task.dto.error = null;
    task.finishedAt = this.now();
    if (task.timer) clearTimeout(task.timer);
    task.timer = null;
    await this.stop(task);
    await this.abandon(task);
    this.removeHelper(task);
    return this.public(task);
  }

  hasAccount(userId: number, accountId: string): boolean {
    return [...this.tasks.values()].some(task => task.userId === userId && task.accountId === accountId && (!finished(task.dto.status) || task.child !== null && !task.closed));
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.tasks.values()].map(task => this.cancel(task.userId, task.dto.id).catch(() => {})));
  }

  private now(): number { return (this.options.now ?? Date.now)(); }
  private public(task: InternalLogin): ClaudeAccountLoginTask { return { ...task.dto }; }
  private require(userId: number, id: string): InternalLogin {
    const task = this.tasks.get(id);
    if (!task || task.userId !== userId) throw new AppError('Claude login was not found.', { code: 'CLAUDE_LOGIN_NOT_FOUND', statusCode: 404 });
    return task;
  }
  private fail(task: InternalLogin, message: string): void {
    task.dto.status = 'failed'; task.dto.url = null; task.dto.error = message; task.finishedAt = this.now();
  }
  private async abandon(task: InternalLogin): Promise<void> {
    if (!task.newAccount || task.abandoned || task.child !== null && !task.closed) return;
    this.options.onAbandon(task);
    task.abandoned = true;
  }
  private removeHelper(task: InternalLogin): void {
    if (task.child !== null && !task.closed) return;
    try {
      const home = this.options.assertHome(task.userId, task.accountId);
      const helper = path.join(home, process.platform === 'win32' ? '.chisa-login-browser.cmd' : '.chisa-login-browser');
      if (fs.existsSync(helper) && fs.lstatSync(helper).isFile() && !fs.lstatSync(helper).isSymbolicLink()) fs.unlinkSync(helper);
    } catch { /* Failed/cancelled new profile may already be removed. */ }
  }
  private stop(task: InternalLogin): Promise<void> {
    if (task.teardown) return task.teardown;
    if (!task.child || task.closed) return Promise.resolve();
    task.teardown = new Promise<void>((resolve, reject) => {
      const child = task.child!;
      let timer: ReturnType<typeof setTimeout>;
      let forceTimer: ReturnType<typeof setTimeout> | null = null;
      const done = () => { clearTimeout(timer); if (forceTimer) clearTimeout(forceTimer); resolve(); };
      child.once('close', done);
      timer = setTimeout(() => {
        child.removeListener('close', done);
        reject(new AppError('Claude login is still shutting down; retry cancellation.', { code: 'CLAUDE_LOGIN_STOPPING', statusCode: 409 }));
      }, 5_000);
      timer.unref?.();
      try {
        if (child.pid && process.platform !== 'win32') {
          process.kill(-child.pid, 'SIGTERM');
          forceTimer = setTimeout(() => { if (!task.closed) { try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); } } }, 800);
          forceTimer.unref?.();
        }
        else if (child.pid && process.platform === 'win32') nodeSpawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).once('error', () => child.kill());
        else child.kill();
      } catch { child.kill(); }
    }).finally(() => { task.teardown = null; });
    return task.teardown;
  }
  private prune(): void {
    const before = this.now() - 10 * 60_000;
    for (const [id, task] of this.tasks) if (task.finishedAt !== null && task.finishedAt < before && (task.child === null || task.closed)) this.tasks.delete(id);
  }
}
