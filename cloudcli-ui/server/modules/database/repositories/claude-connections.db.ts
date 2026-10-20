import { getConnection } from '@/modules/database/connection.js';
import type { ClaudeModelConnectionSecret } from '@/shared/types.js';

const columns = 'id, name, base_url AS baseUrl, model, api_key AS apiKey, auth_type AS authType';

/** Providers persists per-user Messages connections here; secrets never enter generic credentials or preferences. */
export const claudeConnectionsDb = {
  list(userId: number): ClaudeModelConnectionSecret[] {
    return getConnection().prepare(`SELECT ${columns} FROM claude_model_connections WHERE user_id = ? ORDER BY rowid`).all(userId) as ClaudeModelConnectionSecret[];
  },
  get(userId: number, id: string): ClaudeModelConnectionSecret | null {
    return getConnection().prepare(`SELECT ${columns} FROM claude_model_connections WHERE user_id = ? AND id = ?`).get(userId, id) as ClaudeModelConnectionSecret | undefined ?? null;
  },
  activeId(userId: number): string | null {
    return (getConnection().prepare('SELECT connection_id AS id FROM claude_active_connections WHERE user_id = ?').get(userId) as { id: string } | undefined)?.id ?? null;
  },
  save(userId: number, connection: ClaudeModelConnectionSecret): void {
    getConnection().prepare(`INSERT INTO claude_model_connections (user_id, id, name, base_url, model, api_key, auth_type) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, id) DO UPDATE SET name = excluded.name, base_url = excluded.base_url, model = excluded.model, api_key = excluded.api_key, auth_type = excluded.auth_type`)
      .run(userId, connection.id, connection.name, connection.baseUrl, connection.model, connection.apiKey, connection.authType);
  },
  delete(userId: number, id: string): void {
    const db = getConnection();
    db.transaction(() => {
      db.prepare('DELETE FROM claude_active_connections WHERE user_id = ? AND connection_id = ?').run(userId, id);
      db.prepare('DELETE FROM claude_model_connections WHERE user_id = ? AND id = ?').run(userId, id);
    })();
  },
  /** Saved connection selection is independent of manually configured HiRoute settings. */
  activate(userId: number, id: string | null): void {
    const db = getConnection();
    db.transaction(() => {
      if (id === null) db.prepare('DELETE FROM claude_active_connections WHERE user_id = ?').run(userId);
      else {
        // The foreign key also rejects an absent or another user's connection.
        db.prepare(`INSERT INTO claude_active_connections (user_id, connection_id) VALUES (?, ?)
          ON CONFLICT(user_id) DO UPDATE SET connection_id = excluded.connection_id`).run(userId, id);
      }
    })();
  },
};
