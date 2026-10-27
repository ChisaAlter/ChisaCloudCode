import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getDatabasePath } from '@/modules/database/index.js';
import type { ClaudeAccountCredentialRead } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

const accountPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const historyLinks = new Set(['projects', 'file-history', 'session-env', 'shell-snapshots', 'todos', 'paste-cache', 'tasks', 'plans', 'transcripts']);
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;
const timestamp = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

function unsafePath(): never {
  throw new AppError('The Claude account folder is unavailable or has unexpected ownership.', { code: 'CLAUDE_ACCOUNT_PROFILE_UNSAFE', statusCode: 409 });
}

/** Check ancestors before creating their children; recursive mkdir would follow an attacker-controlled parent link. */
function checkedDirectory(directory: string, create: boolean): void {
  const target = path.resolve(directory);
  const parsed = path.parse(target);
  let current = parsed.root;
  for (const part of target.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if (!missing(error) || !create) throw error;
      fs.mkdirSync(current, { mode: 0o700 });
      stat = fs.lstatSync(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) unsafePath();
  }
}

function readObject(file: string, maximumBytes: number): Record<string, unknown> | null {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size > maximumBytes) throw new Error('Invalid account file');
    return object(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

/** Providers' account coordinator exclusively owns these derived profile paths; tests inject an isolated database directory. */
export class ClaudeAccountProfiles {
  constructor(private readonly options: { databasePath?: () => string; home?: () => string; env?: () => NodeJS.ProcessEnv } = {}) {}

  root(): string {
    return path.join(path.dirname(path.resolve((this.options.databasePath ?? getDatabasePath)())), 'claude-accounts');
  }

  home(userId: number, accountId: string): string {
    if (!Number.isSafeInteger(userId) || userId <= 0 || !accountPattern.test(accountId)) unsafePath();
    return path.join(this.root(), 'users', String(userId), 'profiles', accountId, 'home');
  }

  historyHome(userId: number): string {
    if (!Number.isSafeInteger(userId) || userId <= 0) unsafePath();
    return path.join(this.root(), 'users', String(userId), 'history');
  }

  create(userId: number, accountId: string = randomUUID()): string {
    const home = this.home(userId, accountId);
    const folder = path.dirname(home);
    checkedDirectory(folder, true);
    const marker = path.join(folder, 'owner.json');
    const expected = { version: 1, userId, accountId };
    const saved = readObject(marker, 1024);
    if (saved) {
      if (saved.version !== 1 || saved.userId !== userId || saved.accountId !== accountId) unsafePath();
    } else {
      // Never adopt pre-existing content by installing a marker over it.
      if (fs.readdirSync(folder).length !== 0) unsafePath();
      fs.writeFileSync(marker, JSON.stringify(expected), { flag: 'wx', mode: 0o600 });
    }
    checkedDirectory(home, true);
    return home;
  }

  assertOwned(userId: number, accountId: string): string {
    const home = this.home(userId, accountId);
    checkedDirectory(home, false);
    const marker = readObject(path.join(path.dirname(home), 'owner.json'), 1024);
    if (!marker || marker.version !== 1 || marker.userId !== userId || marker.accountId !== accountId) unsafePath();
    return home;
  }

  remove(userId: number, accountId: string): void {
    const home = this.assertOwned(userId, accountId);
    // Detach only known shared-history links. rm never follows symlinks, but unlink first documents and tests that boundary.
    for (const name of fs.readdirSync(home)) {
      const entry = path.join(home, name);
      if (historyLinks.has(name) && fs.lstatSync(entry).isSymbolicLink()) fs.unlinkSync(entry);
    }
    const folder = path.dirname(home);
    const expected = path.join(this.root(), 'users', String(userId), 'profiles', accountId);
    if (folder !== expected) unsafePath();
    checkedDirectory(folder, false);
    fs.rmSync(folder, { recursive: true, force: false });
  }

  defaultPaths(): { configDir: string; authDir: string } {
    const env = (this.options.env ?? (() => process.env))();
    const defaultHome = path.join((this.options.home ?? os.homedir)(), '.claude');
    const configDir = path.resolve(env.CLAUDE_CONFIG_DIR || defaultHome);
    const authDir = path.resolve(env.CLAUDE_SECURESTORAGE_CONFIG_DIR !== undefined ? env.CLAUDE_SECURESTORAGE_CONFIG_DIR || defaultHome : configDir);
    return { configDir, authDir };
  }

  defaultRoute(): { kind: 'api' | 'default'; label: string } {
    const env = (this.options.env ?? (() => process.env))();
    let settingsEnv: Record<string, unknown> | null = null;
    try { settingsEnv = object(readObject(path.join(this.defaultPaths().configDir, 'settings.json'), 1024 * 1024)?.env); } catch { /* Bad optional settings do not disclose or repair credentials. */ }
    const api = Boolean(text(env.ANTHROPIC_API_KEY) || text(env.ANTHROPIC_AUTH_TOKEN) || text(settingsEnv?.ANTHROPIC_API_KEY) || text(settingsEnv?.ANTHROPIC_AUTH_TOKEN)
      || env.CLAUDE_CODE_USE_BEDROCK === '1' || env.CLAUDE_CODE_USE_VERTEX === '1' || env.CLAUDE_CODE_USE_FOUNDRY === '1');
    return api ? { kind: 'api', label: '服务器 API 线路' } : { kind: 'default', label: '服务器默认登录' };
  }

  read(userId: number, accountId: string, now: number): ClaudeAccountCredentialRead {
    const empty: ClaudeAccountCredentialRead = { accessToken: null, expiresAt: null, refreshable: false, email: null, organizationUuid: null, organizationName: null, plan: null, tier: null, unavailable: false };
    try {
      const paths = accountId === 'default' ? this.defaultPaths() : { configDir: this.assertOwned(userId, accountId), authDir: this.home(userId, accountId) };
      let credentials: Record<string, unknown> | null = null;
      let environmentToken: string | null = null;
      if (accountId === 'default') {
        const env = (this.options.env ?? (() => process.env))();
        let settingsEnv: Record<string, unknown> | null = null;
        try { settingsEnv = object(readObject(path.join(paths.configDir, 'settings.json'), 1024 * 1024)?.env); } catch { /* Environment OAuth can still authenticate when optional settings are unreadable. */ }
        environmentToken = text(env.CLAUDE_CODE_OAUTH_TOKEN) ?? text(settingsEnv?.CLAUDE_CODE_OAUTH_TOKEN);
      }
      try { credentials = readObject(path.join(paths.authDir, '.credentials.json'), 1024 * 1024); }
      catch (error) { if (!environmentToken) throw error; }
      const oauth = object(credentials?.claudeAiOauth);
      let state = readObject(path.join(paths.configDir, '.claude.json'), 8 * 1024 * 1024);
      if (!state && accountId === 'default' && paths.configDir === path.join((this.options.home ?? os.homedir)(), '.claude')) state = readObject(path.join((this.options.home ?? os.homedir)(), '.claude.json'), 8 * 1024 * 1024);
      const identity = object(state?.oauthAccount);
      const refreshExpiry = timestamp(oauth?.refreshTokenExpiresAt);
      return {
        accessToken: environmentToken ?? text(oauth?.accessToken),
        expiresAt: environmentToken ? null : timestamp(oauth?.expiresAt),
        refreshable: !environmentToken && Boolean(text(oauth?.refreshToken) && (refreshExpiry === null || refreshExpiry > now)),
        email: text(identity?.emailAddress) ?? text(credentials?.email) ?? text(credentials?.user),
        organizationUuid: text(identity?.organizationUuid),
        organizationName: text(identity?.organizationName),
        plan: text(oauth?.subscriptionType),
        tier: text(oauth?.rateLimitTier),
        unavailable: false,
        renewalFingerprint: createHash('sha256').update(JSON.stringify(oauth ?? {})).digest('hex'),
      };
    } catch {
      return { ...empty, unavailable: true };
    }
  }
}
