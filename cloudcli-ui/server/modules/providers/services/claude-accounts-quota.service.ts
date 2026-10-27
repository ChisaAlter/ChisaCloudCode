import { createHash } from 'node:crypto';

import type { ClaudeAccountCredentialRead, ClaudeAccountUsage } from '@/shared/types.js';

import { normalizeClaudeExtraUsage, normalizeClaudeQuota } from '../../../../shared/claude-quota.js';

const CACHE_MS = 15 * 60_000;
const FAILURE_MS = 30_000;
const MAX_FAILURE_MS = 15 * 60_000;
const STALE_MS = 30 * 60_000;
const LONG_STALE_MS = 24 * 60 * 60_000;
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
type CacheEntry = { usage: ClaudeAccountUsage; failures: number; nextAt: number; fingerprint: string };

function fingerprint(credentials: ClaudeAccountCredentialRead): string {
  return createHash('sha256').update(`${credentials.accessToken ?? ''}\0${credentials.email ?? ''}\0${credentials.organizationUuid ?? ''}`).digest('hex');
}

function empty(now: number, error: string, failureKind: string, status: 'error' | 'unavailable' = 'error'): ClaudeAccountUsage {
  return { status, windows: [], updatedAt: null, checkedAt: now, error, failureKind, stale: false };
}

function currentWindows(usage: ClaudeAccountUsage, now: number): ClaudeAccountUsage {
  const windows = usage.windows.filter(window => window.resetsAt === null || window.resetsAt > now);
  if (windows.length === usage.windows.length) return usage;
  if (windows.length === 0 && usage.status === 'ok') return { ...usage, status: 'unavailable', windows, error: '额度周期已重置，等待下次更新。', failureKind: 'reset-pending', stale: false };
  return { ...usage, windows };
}

function retryAfter(value: string | null, now: number): number | null {
  if (!value) return null;
  const seconds = Number(value);
  const when = Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(value);
  return Number.isFinite(when) && when > now ? Math.min(when, now + 24 * 60 * 60_000) : null;
}

/** Providers' account coordinator owns this per-user/account cache; quota reads never refresh or rewrite Claude credentials. */
export class ClaudeAccountQuotaService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly generations = new Map<string, number>();
  private readonly inFlight = new Map<string, { fingerprint: string; promise: Promise<ClaudeAccountUsage> }>();

  constructor(private readonly options: { now?: () => number; fetch?: typeof fetch } = {}) {}

  evict(key: string): void {
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
    this.cache.delete(key);
    this.inFlight.delete(key);
  }

  async read(key: string, readCredentials: () => ClaudeAccountCredentialRead, force = false): Promise<ClaudeAccountUsage> {
    const now = (this.options.now ?? Date.now)();
    const credentials = readCredentials();
    const identity = fingerprint(credentials);
    const cached = this.cache.get(key);
    // A changed credential can denote reauthentication; never return the old login's figures under it.
    const previous = cached?.fingerprint === identity ? cached : undefined;
    if (previous && (!force && now < previous.nextAt || (previous.usage.retryAt ?? 0) > now)) return currentWindows(previous.usage, now);
    const pending = this.inFlight.get(key);
    if (pending?.fingerprint === identity) return pending.promise;
    const generation = this.generations.get(key) ?? 0;
    const promise = this.fetch(credentials, now).then(fresh => {
      const completedAt = (this.options.now ?? Date.now)();
      // Relogin/removal and credential replacement invalidate both a pending HTTP result and its caller's display.
      if ((this.generations.get(key) ?? 0) !== generation || fingerprint(readCredentials()) !== identity) {
        const latest = this.cache.get(key);
        return latest ? currentWindows(latest.usage, completedAt) : empty(completedAt, '账号状态已变化，请重新刷新。', 'account-changed', 'unavailable');
      }
      const failures = fresh.status === 'error' ? Math.min((previous?.failures ?? 0) + 1, 8) : 0;
      let usage = fresh;
      if (fresh.status === 'error' && previous?.usage.updatedAt !== null && previous?.usage.updatedAt !== undefined) {
        const threshold = fresh.failureKind === 'rate-limited' || fresh.failureKind === 'stale-token' ? LONG_STALE_MS : STALE_MS;
        const retained = currentWindows(previous.usage, completedAt);
        if (completedAt - previous.usage.updatedAt <= threshold && retained.windows.length > 0) usage = { ...fresh, windows: retained.windows, updatedAt: previous.usage.updatedAt, stale: true, extraUsage: previous.usage.extraUsage };
      }
      const nextAt = fresh.status === 'ok' ? completedAt + CACHE_MS : Math.max(fresh.retryAt ?? 0, completedAt + Math.min(FAILURE_MS * 2 ** Math.max(0, failures - 1), MAX_FAILURE_MS));
      this.cache.set(key, { usage, fingerprint: identity, failures, nextAt });
      return usage;
    }).finally(() => {
      if (this.inFlight.get(key)?.promise === promise) this.inFlight.delete(key);
    });
    this.inFlight.set(key, { fingerprint: identity, promise });
    return promise;
  }

  private async fetch(credentials: ClaudeAccountCredentialRead, now: number): Promise<ClaudeAccountUsage> {
    if (credentials.unavailable) return empty(now, '无法读取此账号的凭据。', 'credentials-unavailable');
    if (!credentials.accessToken) return credentials.refreshable
      ? empty(now, '登录仍可自动续期，正在等待后台重试后更新额度。', 'stale-token')
      : empty(now, '请登录此 Claude 订阅账号。', 'missing-credentials', 'unavailable');
    if (credentials.expiresAt !== null && credentials.expiresAt <= now) return empty(now, credentials.refreshable ? '登录仍可自动续期，正在等待后台重试后更新额度。' : 'Claude 登录已过期，请重新登录。', credentials.refreshable ? 'stale-token' : 'missing-credentials');
    try {
      const response = await (this.options.fetch ?? globalThis.fetch)(USAGE_URL, {
        headers: { Authorization: `Bearer ${credentials.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'claude-code/2.1.0', Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      const checkedAt = (this.options.now ?? Date.now)();
      if (!response.ok) {
        if (response.status === 429) return { ...empty(checkedAt, 'Claude 额度查询暂时限流，稍后自动重试。', 'rate-limited'), retryAt: retryAfter(response.headers.get('retry-after'), checkedAt) ?? checkedAt + FAILURE_MS };
        if (response.status === 401) return empty(checkedAt, credentials.refreshable ? '登录可自动续期，后台将重试并更新额度。' : 'Claude 登录无效，请重新登录。', credentials.refreshable ? 'stale-token' : 'missing-credentials');
        if (response.status === 403) return empty(checkedAt, '此登录缺少查询额度的权限，请重新登录订阅账号。', 'missing-scope');
        return empty(checkedAt, 'Claude 额度服务暂不可用。', 'server');
      }
      const content = await response.text();
      if (content.length > 1024 * 1024) return empty(checkedAt, 'Claude 额度返回的数据过大。', 'parse');
      const data: unknown = JSON.parse(content);
      const windows = normalizeClaudeQuota(data).filter(window => window.resetsAt === null || window.resetsAt > checkedAt);
      if (windows.length === 0) return empty(checkedAt, '此账号暂未提供套餐额度数据。', 'no-usage-data', 'unavailable');
      return { status: 'ok', windows, updatedAt: checkedAt, checkedAt, error: null, stale: false, extraUsage: normalizeClaudeExtraUsage(data) };
    } catch (error) {
      return empty((this.options.now ?? Date.now)(), error instanceof SyntaxError ? 'Claude 额度响应无法解析。' : '暂时无法连接 Claude 额度服务。', error instanceof SyntaxError ? 'parse' : 'network');
    }
  }
}
