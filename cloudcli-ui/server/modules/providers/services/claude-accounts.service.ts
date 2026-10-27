import { randomUUID } from 'node:crypto';

import type { Options } from '@anthropic-ai/claude-agent-sdk';

import { claudeAccountsDb, userDb } from '@/modules/database/index.js';
import { claudeConnectionsService } from '@/modules/providers/services/claude-connections.service.js';
import { ClaudeAccountProfiles } from '@/modules/providers/services/claude-accounts-profiles.service.js';
import { ClaudeAccountLoginService } from '@/modules/providers/services/claude-accounts-login.service.js';
import { ClaudeAccountQuotaService } from '@/modules/providers/services/claude-accounts-quota.service.js';
import { ClaudeAccountRenewalService } from '@/modules/providers/services/claude-accounts-renewal.service.js';
import type { ClaudeAccountCredentialRead, ClaudeAccountLaunchSnapshot, ClaudeAccountLoginTask, ClaudeAccountRecord, ClaudeAccountSubscription, ClaudeAccountSummary, ClaudeAccountsState } from '@/shared/types.js';
import { AppError, normalizeConnectionUserId, requireConnectionUserId } from '@/shared/utils.js';

type ServiceOptions = {
  profiles?: ClaudeAccountProfiles;
  quota?: ClaudeAccountQuotaService;
  renewal?: ClaudeAccountRenewalService;
  login?: Omit<ConstructorParameters<typeof ClaudeAccountLoginService>[0], 'assertHome' | 'onSuccess' | 'onAbandon'>;
  now?: () => number;
};
const notFound = () => new AppError('Claude account was not found.', { code: 'CLAUDE_ACCOUNT_NOT_FOUND', statusCode: 404 });
const busy = () => new AppError('This Claude account is being used by a running task or login. Try again after it finishes.', { code: 'CLAUDE_ACCOUNT_IN_USE', statusCode: 409 });
const authClears = {
  ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_BASE_URL: '', ANTHROPIC_CUSTOM_HEADERS: '',
  CLAUDE_CODE_OAUTH_TOKEN: '', CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '', CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: '',
  CLAUDE_CODE_USE_BEDROCK: '0', CLAUDE_CODE_USE_VERTEX: '0', CLAUDE_CODE_USE_FOUNDRY: '0',
};

/** Providers routes/runtime/auth and managed routing share this host-authoritative identity, login and quota coordinator. */
export class ClaudeAccountsService {
  private readonly profiles: ClaudeAccountProfiles;
  private readonly quota: ClaudeAccountQuotaService;
  private readonly renewal: ClaudeAccountRenewalService;
  private readonly login: ClaudeAccountLoginService;
  private readonly leases = new Map<string, number>();
  private readonly queues = new Map<number, Promise<unknown>>();

  constructor(private readonly options: ServiceOptions = {}) {
    this.profiles = options.profiles ?? new ClaudeAccountProfiles();
    this.quota = options.quota ?? new ClaudeAccountQuotaService({ now: options.now });
    this.renewal = options.renewal ?? new ClaudeAccountRenewalService({ now: options.now });
    this.login = new ClaudeAccountLoginService({ ...options.login, now: options.now,
      assertHome: (userId, id) => this.profiles.assertOwned(userId, id),
      onSuccess: input => {
        this.requireUser(input.userId);
        const credentials = this.profiles.read(input.userId, input.accountId, this.now());
        if (!credentials.email || !this.authenticated(credentials)) throw new Error('Incomplete subscription identity');
        const previous = claudeAccountsDb.get(input.userId, input.accountId);
        const duplicate = claudeAccountsDb.list(input.userId).find(account => account.id !== input.accountId && account.email?.trim().toLowerCase() === credentials.email!.trim().toLowerCase() && account.organizationUuid === credentials.organizationUuid);
        if (duplicate) throw new Error('Subscription account already exists');
        const now = this.now();
        claudeAccountsDb.save(input.userId, { id: input.accountId, name: previous?.name ?? (input.name || credentials.email), email: credentials.email,
          organizationUuid: credentials.organizationUuid, organizationName: credentials.organizationName, plan: credentials.plan,
          createdAt: previous?.createdAt ?? now, updatedAt: now });
        this.quota.evict(this.key(input.userId, input.accountId));
        this.renewal.evict(this.key(input.userId, input.accountId));
      },
      onAbandon: input => {
        if (!claudeAccountsDb.get(input.userId, input.accountId) && !this.leases.get(this.key(input.userId, input.accountId))) this.profiles.remove(input.userId, input.accountId);
      },
    });
  }

  async getState(userId: unknown): Promise<ClaudeAccountsState> {
    const id = this.requireUser(userId);
    const summaries = await Promise.all(claudeAccountsDb.list(id).map(account => this.summarize(id, account)));
    const defaultSnapshot = this.defaultAllowed(id) ? await this.defaultSummary(id) : null;
    // A second user or account removal can occur while an informational quota request is in flight.
    const accounts = summaries.filter(account => claudeAccountsDb.get(id, account.id) !== null);
    const defaultAccount = this.defaultAllowed(id) ? defaultSnapshot : null;
    const activeId = claudeAccountsDb.activeId(id);
    const active = accounts.find(account => account.id === activeId);
    const connection = claudeConnectionsService.getActiveConnection(id);
    const defaultRoute = defaultAccount && !active ? this.profiles.defaultRoute() : null;
    return { runtime: { id: 'server', label: '当前服务器' }, activeId, accounts, defaultAccount,
      route: connection ? { kind: 'api', label: connection.name, accountId: null }
        : active ? { kind: 'subscription', label: active.name || active.email || 'Claude 订阅', accountId: active.id }
          : defaultRoute ? { ...defaultRoute, accountId: 'default' } : { kind: 'default', label: '未选择 Claude 订阅账号', accountId: null } };
  }

  async startLogin(userId: unknown, input: { accountId?: string; name?: string }): Promise<ClaudeAccountLoginTask> {
    const id = this.requireUser(userId);
    return this.serialize(id, async () => {
      const account = input.accountId ? this.requireAccount(id, input.accountId) : null;
      if (account && ((this.leases.get(this.key(id, account.id)) ?? 0) > 0 || this.renewal.isBusy(this.key(id, account.id)))) throw busy();
      if (!account && claudeAccountsDb.list(id).length >= 25) throw new AppError('A maximum of 25 Claude subscription accounts can be saved.', { code: 'CLAUDE_ACCOUNT_LIMIT', statusCode: 409 });
      const accountId = account?.id ?? randomUUID();
      const home = this.profiles.create(id, accountId);
      return this.login.start({ userId: id, accountId, name: account?.name ?? input.name ?? '', home, newAccount: !account });
    });
  }

  getLogin(userId: unknown, loginId: string): ClaudeAccountLoginTask { return this.login.get(this.requireUser(userId), loginId); }
  submitCode(userId: unknown, loginId: string, code: string): ClaudeAccountLoginTask { return this.login.submitCode(this.requireUser(userId), loginId, code); }
  cancelLogin(userId: unknown, loginId: string): Promise<ClaudeAccountLoginTask> { return this.login.cancel(this.requireUser(userId), loginId); }

  async select(userId: unknown, accountId: string | null): Promise<ClaudeAccountsState> {
    const id = this.requireUser(userId);
    await this.serialize(id, async () => {
      if (accountId === null && !this.defaultAllowed(id)) throw new AppError('The server default login is available only to a single active Chisa user.', { code: 'CLAUDE_DEFAULT_ACCOUNT_UNAVAILABLE', statusCode: 409 });
      if (accountId !== null) {
        const account = this.requireAccount(id, accountId);
        if (this.login.hasAccount(id, account.id)) throw busy();
        const credentials = this.profiles.read(id, account.id, this.now());
        if (!this.authenticated(credentials)) throw new AppError('Sign in to this Claude account before selecting it.', { code: 'CLAUDE_ACCOUNT_SIGN_IN_REQUIRED', statusCode: 409 });
      }
      claudeAccountsDb.activate(id, accountId);
      // Choosing a subscription is explicit: ordinary runs must not remain on a saved API endpoint.
      claudeConnectionsService.activate(id, null);
    });
    return this.getState(id);
  }

  async rename(userId: unknown, accountId: string, name: string): Promise<ClaudeAccountsState> {
    const id = this.requireUser(userId);
    await this.serialize(id, async () => { const account = this.requireAccount(id, accountId); claudeAccountsDb.save(id, { ...account, name, updatedAt: this.now() }); });
    return this.getState(id);
  }

  async remove(userId: unknown, accountId: string): Promise<ClaudeAccountsState> {
    const id = this.requireUser(userId);
    await this.serialize(id, async () => {
      const account = this.requireAccount(id, accountId);
      if ((this.leases.get(this.key(id, account.id)) ?? 0) > 0 || this.login.hasAccount(id, account.id) || this.renewal.isBusy(this.key(id, account.id))) throw busy();
      this.profiles.remove(id, account.id);
      claudeAccountsDb.delete(id, account.id);
      this.quota.evict(this.key(id, account.id));
      this.renewal.evict(this.key(id, account.id));
    });
    return this.getState(id);
  }

  async refresh(userId: unknown, input: { id?: string | null; all?: boolean } = {}): Promise<ClaudeAccountsState> {
    const id = this.requireUser(userId);
    const requested = Object.prototype.hasOwnProperty.call(input, 'id') ? input.id ?? 'default' : claudeAccountsDb.activeId(id) ?? 'default';
    const targets = input.all ? [...claudeAccountsDb.list(id).map(account => account.id), ...(this.defaultAllowed(id) ? ['default'] : [])] : [requested];
    await Promise.all(targets.map(async accountId => {
      if (accountId === 'default') { if (!this.defaultAllowed(id)) return; }
      else this.requireAccount(id, accountId);
      await this.ensureRenewed(id, accountId);
      await this.quota.read(this.key(id, accountId), () => this.profiles.read(id, accountId, this.now()), true);
    }));
    return this.getState(id);
  }

  captureLaunch(userId: unknown): ClaudeAccountLaunchSnapshot | null {
    const normalized = normalizeConnectionUserId(userId);
    if (normalized === null) return null;
    const id = this.requireUser(normalized);
    const accountId = claudeAccountsDb.activeId(id);
    let configDir: string;
    let authDir: string;
    let email: string | null;
    if (accountId) {
      this.requireAccount(id, accountId);
      if (this.login.hasAccount(id, accountId)) throw busy();
      configDir = this.profiles.assertOwned(id, accountId);
      authDir = configDir;
      const credentials = this.profiles.read(id, accountId, this.now());
      if (!this.authenticated(credentials)) throw new AppError('Sign in to the selected Claude subscription account.', { code: 'CLAUDE_ACCOUNT_SIGN_IN_REQUIRED', statusCode: 409 });
      email = credentials.email;
    } else {
      if (!this.defaultAllowed(id)) return null;
      ({ configDir, authDir } = this.profiles.defaultPaths());
      email = this.profiles.read(id, 'default', this.now()).email;
    }
    const key = this.key(id, accountId ?? 'default');
    this.leases.set(key, (this.leases.get(key) ?? 0) + 1);
    let released = false;
    return Object.freeze({ userId: id, accountId: accountId ?? 'default', configDir, authDir, email,
      release: () => { if (released) return; released = true; const count = (this.leases.get(key) ?? 1) - 1; if (count <= 0) this.leases.delete(key); else this.leases.set(key, count); } });
  }

  applyToOptions(options: Options, snapshot: ClaudeAccountLaunchSnapshot | null): void {
    if (!snapshot) return;
    const env = { ...(snapshot.accountId === 'default' ? {} : authClears), CLAUDE_CONFIG_DIR: snapshot.configDir, CLAUDE_SECURESTORAGE_CONFIG_DIR: snapshot.authDir };
    options.env = { ...options.env, ...env };
    if (snapshot.accountId !== 'default') {
      const settings = typeof options.settings === 'object' ? options.settings : {};
      options.settings = { ...settings, apiKeyHelper: '', env: { ...settings.env, ...env } };
    }
  }

  async readSubscription(userId: unknown, snapshot?: ClaudeAccountLaunchSnapshot | null): Promise<ClaudeAccountSubscription | null> {
    const id = normalizeConnectionUserId(userId);
    if (id === null) return null;
    this.requireUser(id);
    if (snapshot && snapshot.userId !== id) throw notFound();
    const accountId = snapshot ? snapshot.accountId === 'default' ? null : snapshot.accountId : claudeAccountsDb.activeId(id);
    if (!accountId && !this.defaultAllowed(id) || accountId && this.login.hasAccount(id, accountId)) return null;
    if (accountId) this.requireAccount(id, accountId);
    await this.ensureRenewed(id, accountId ?? 'default');
    if (!accountId && !this.defaultAllowed(id)) return null;
    const credentials = this.profiles.read(id, accountId ?? 'default', this.now());
    if (!credentials.accessToken || credentials.unavailable) return null;
    return { accountId: accountId ?? 'default', email: credentials.email, accessToken: credentials.accessToken, expiresAt: credentials.expiresAt,
      refreshable: credentials.refreshable, subscriptionType: credentials.plan, rateLimitTier: credentials.tier };
  }

  async getSelectedAuthStatus(userId: unknown): Promise<{ authenticated: boolean; email: string | null; method: string | null; error?: string } | null> {
    const id = normalizeConnectionUserId(userId);
    if (id === null) return null;
    this.requireUser(id);
    const accountId = claudeAccountsDb.activeId(id);
    if (!accountId && !this.defaultAllowed(id)) return { authenticated: false, email: null, method: null, error: '请添加并选择当前用户的 Claude 订阅账号。' };
    // Authorized legacy API/Bedrock routes do not require a subscription credential file.
    if (!accountId && this.profiles.defaultRoute().kind === 'api') return { authenticated: true, email: null, method: 'api_key' };
    if (accountId) this.requireAccount(id, accountId);
    const credentials = this.profiles.read(id, accountId ?? 'default', this.now());
    const authenticated = !this.login.hasAccount(id, accountId ?? 'default') && this.authenticated(credentials);
    return { authenticated, email: credentials.email, method: authenticated ? accountId ? 'subscription_account' : 'credentials_file' : null,
      ...(authenticated ? {} : { error: credentials.unavailable ? '无法读取当前 Claude 登录。' : '请登录当前 Claude 订阅账号。' }) };
  }

  historyRoots(): Array<{ userId: number; home: string }> {
    return userDb.getActiveUserIds().flatMap(value => { const id = normalizeConnectionUserId(value); return id === null ? [] : [{ userId: id, home: this.profiles.historyHome(id) }]; });
  }

  async dispose(): Promise<void> { await Promise.all([this.login.dispose(), this.renewal.dispose()]); }

  private async ensureRenewed(userId: number, accountId: string): Promise<void> {
    if (accountId === 'default') { if (!this.defaultAllowed(userId)) return; }
    else { this.requireAccount(userId, accountId); if (this.login.hasAccount(userId, accountId)) return; }
    const key = this.key(userId, accountId);
    this.leases.set(key, (this.leases.get(key) ?? 0) + 1);
    const read = () => accountId === 'default' && !this.defaultAllowed(userId)
      ? { accessToken: null, expiresAt: null, refreshable: false, email: null, organizationUuid: null, organizationName: null, plan: null, tier: null, unavailable: true }
      : this.profiles.read(userId, accountId, this.now());
    try {
      await this.renewal.ensure(key, read, () => accountId === 'default' ? this.profiles.defaultPaths()
        : { configDir: this.profiles.assertOwned(userId, accountId), authDir: this.profiles.home(userId, accountId) });
    } finally {
      const count = (this.leases.get(key) ?? 1) - 1;
      if (count <= 0) this.leases.delete(key); else this.leases.set(key, count);
    }
  }

  private now(): number { return (this.options.now ?? Date.now)(); }
  private key(userId: number, accountId: string): string { return `${userId}:server:${accountId}`; }
  private requireUser(value: unknown): number {
    const userId = requireConnectionUserId(value);
    if (!userDb.getUserById(userId)) throw new AppError('Authentication is required.', { code: 'UNAUTHORIZED', statusCode: 401 });
    return userId;
  }
  private defaultAllowed(userId: number): boolean { const active = userDb.getActiveUserIds(); return active.length === 1 && active[0] === String(userId); }
  private requireAccount(userId: number, accountId: string): ClaudeAccountRecord { const account = claudeAccountsDb.get(userId, accountId); if (!account) throw notFound(); return account; }
  private authenticated(credentials: ClaudeAccountCredentialRead): boolean { return !credentials.unavailable && (credentials.refreshable || Boolean(credentials.accessToken && (credentials.expiresAt === null || credentials.expiresAt > this.now()))); }
  private async summarize(userId: number, account: ClaudeAccountRecord): Promise<ClaudeAccountSummary> {
    await this.ensureRenewed(userId, account.id);
    const credentials = this.profiles.read(userId, account.id, this.now());
    const { organizationUuid: _organizationUuid, ...metadata } = account;
    return { ...metadata, email: credentials.email ?? account.email, organizationName: credentials.organizationName ?? account.organizationName,
      plan: credentials.plan ?? account.plan, needsSignIn: !this.authenticated(credentials),
      usage: await this.quota.read(this.key(userId, account.id), () => this.profiles.read(userId, account.id, this.now())) };
  }
  private async defaultSummary(userId: number): Promise<ClaudeAccountSummary & { id: 'default' }> {
    await this.ensureRenewed(userId, 'default');
    const credentials = this.profiles.read(userId, 'default', this.now());
    return { id: 'default', name: '服务器默认登录', email: credentials.email, organizationName: credentials.organizationName, plan: credentials.plan,
      needsSignIn: !this.authenticated(credentials), createdAt: 0, updatedAt: 0,
      usage: await this.quota.read(this.key(userId, 'default'), () => this.defaultAllowed(userId) ? this.profiles.read(userId, 'default', this.now()) : { ...credentials, accessToken: null, refreshable: false, unavailable: true }) };
  }
  private serialize<T>(userId: number, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(userId) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    this.queues.set(userId, next);
    void next.finally(() => { if (this.queues.get(userId) === next) this.queues.delete(userId); }).catch(() => {});
    return next;
  }
}

/** Providers' runtime, auth, routing and HTTP adapter use the same process-scoped account coordinator and leases. */
export const claudeAccountsService = new ClaudeAccountsService();
