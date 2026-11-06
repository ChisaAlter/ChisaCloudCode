import type { AuthSessionContext } from '@/shared/index.js';

import { getConnection } from '../connection.js';

type StoredSession = AuthSessionContext & { revokedAt: number | null };
type SessionInput = AuthSessionContext & { expectedPasswordHash?: string };

const sessionProjection = `sid AS id, user_id AS userId, session_version AS version,
  created_at AS createdAt, expires_at AS expiresAt, revoked_at AS revokedAt`;

/** Auth uses this repository for persistent login proof; every call obtains the current connection, including after a reopen. */
export const authSessionsDb = {
  getSession(id: string): StoredSession | undefined {
    return getConnection().prepare(`SELECT ${sessionProjection} FROM auth_sessions WHERE sid = ?`).get(id) as StoredSession | undefined;
  },

  getUserAuthState(userId: number): { userId: number; sessionVersion: number; isActive: boolean } | undefined {
    const row = getConnection().prepare('SELECT id AS userId, auth_version AS sessionVersion, is_active AS isActive FROM users WHERE id = ?')
      .get(userId) as { userId: number; sessionVersion: number; isActive: number } | undefined;
    return row ? { ...row, isActive: row.isActive === 1 } : undefined;
  },

  createSession(input: SessionInput): StoredSession | undefined {
    if (!Number.isSafeInteger(input.userId) || input.userId <= 0 || !Number.isSafeInteger(input.version) || input.version < 0
      || !Number.isSafeInteger(input.createdAt) || input.createdAt <= 0 || !Number.isSafeInteger(input.expiresAt)
      || input.expiresAt <= input.createdAt || !/^(?:[a-f0-9-]{36}|legacy-[a-f0-9]{64})$/.test(input.id)) {
      throw new Error('Invalid authentication session');
    }
    const db = getConnection();
    return db.transaction(() => {
      // CAS prevents a login whose password was replaced during bcrypt from publishing a session.
      // IGNORE is only for a repeat legacy digest: never REPLACE a revoked tombstone.
      db.prepare(`INSERT OR IGNORE INTO auth_sessions (sid, user_id, session_version, created_at, expires_at)
        SELECT ?, id, auth_version, ?, ? FROM users WHERE id = ? AND is_active = 1 AND auth_version = ?
        AND (? IS NULL OR password_hash = ?)`).run(input.id, input.createdAt, input.expiresAt, input.userId, input.version,
          input.expectedPasswordHash ?? null, input.expectedPasswordHash ?? null);
      const row = this.getSession(input.id);
      if (!row || row.userId !== input.userId || row.version !== input.version || row.createdAt !== input.createdAt
        || row.expiresAt !== input.expiresAt) return undefined;
      return row;
    })();
  },

  revokeSession(id: string, userId: number, now: number): void {
    getConnection().prepare('UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE sid = ? AND user_id = ?')
      .run(now, id, userId);
  },

  revokeUserSessions(userId: number, now: number): void {
    const db = getConnection();
    db.transaction(() => {
      db.prepare('UPDATE users SET auth_version = auth_version + 1 WHERE id = ?').run(userId);
      db.prepare('UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE user_id = ?').run(now, userId);
    })();
  },

  /** A fixed activation time and non-increasing cutoff survive restarts; malformed stored state closes compatibility. */
  legacyWindow(now: number, configuredCutoff: number): { enabledAt: number; cutoff: number } | undefined {
    if (!Number.isSafeInteger(now) || now <= 0 || !Number.isSafeInteger(configuredCutoff)) return undefined;
    const db = getConnection();
    return db.transaction(() => {
      const key = 'auth_legacy_token_window_v1';
      const saved = db.prepare('SELECT value FROM app_config WHERE key = ?').get(key) as { value: string } | undefined;
      if (saved) {
        let parsed: { enabledAt?: unknown; cutoff?: unknown };
        try { parsed = JSON.parse(saved.value) as typeof parsed; } catch { return undefined; }
        if (!parsed || typeof parsed !== 'object' || typeof parsed.enabledAt !== 'number' || typeof parsed.cutoff !== 'number'
          || !Number.isSafeInteger(parsed.enabledAt) || !Number.isSafeInteger(parsed.cutoff)
          || parsed.enabledAt <= 0 || parsed.cutoff <= parsed.enabledAt || parsed.cutoff - parsed.enabledAt > 7 * 86400) return undefined;
        const cutoff = Math.min(configuredCutoff, parsed.cutoff);
        // Persist shortening even when the deadline has just passed; re-enabling must not restore the former window.
        if (cutoff < parsed.cutoff) db.prepare('UPDATE app_config SET value = ? WHERE key = ?')
          .run(JSON.stringify({ enabledAt: parsed.enabledAt, cutoff }), key);
        if (cutoff <= now) return undefined;
        return { enabledAt: parsed.enabledAt, cutoff };
      }
      // Reject expired or unbounded first activation rather than silently moving its deadline.
      if (configuredCutoff <= now || configuredCutoff - now > 7 * 86400) return undefined;
      const window = { enabledAt: now, cutoff: configuredCutoff };
      db.prepare('INSERT INTO app_config (key, value) VALUES (?, ?)').run(key, JSON.stringify(window));
      return window;
    })();
  },
};
