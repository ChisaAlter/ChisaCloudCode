import { getConnection } from '@/modules/database/connection.js';
import type { ClaudeAccountRecord } from '@/shared/types.js';

const columns = 'id, name, email, organization_uuid AS organizationUuid, organization_name AS organizationName, plan, created_at AS createdAt, updated_at AS updatedAt';

/** Providers owns subscription account metadata here. OAuth tokens and mutable paths are never stored in SQLite. */
export const claudeAccountsDb = {
  list(userId: number): ClaudeAccountRecord[] {
    return getConnection().prepare(`SELECT ${columns} FROM claude_subscription_accounts WHERE user_id = ? ORDER BY created_at, id`).all(userId) as ClaudeAccountRecord[];
  },
  listAll(): Array<ClaudeAccountRecord & { userId: number }> {
    return getConnection().prepare(`SELECT user_id AS userId, ${columns} FROM claude_subscription_accounts ORDER BY user_id, created_at`).all() as Array<ClaudeAccountRecord & { userId: number }>;
  },
  get(userId: number, id: string): ClaudeAccountRecord | null {
    return getConnection().prepare(`SELECT ${columns} FROM claude_subscription_accounts WHERE user_id = ? AND id = ?`).get(userId, id) as ClaudeAccountRecord | undefined ?? null;
  },
  activeId(userId: number): string | null {
    return (getConnection().prepare('SELECT account_id AS id FROM claude_active_subscription_accounts WHERE user_id = ?').get(userId) as { id: string } | undefined)?.id ?? null;
  },
  save(userId: number, account: ClaudeAccountRecord): void {
    getConnection().prepare(`INSERT INTO claude_subscription_accounts (user_id,id,name,email,organization_uuid,organization_name,plan,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(user_id,id) DO UPDATE SET name=excluded.name,email=excluded.email,organization_uuid=excluded.organization_uuid,organization_name=excluded.organization_name,plan=excluded.plan,updated_at=excluded.updated_at`)
      .run(userId, account.id, account.name, account.email, account.organizationUuid, account.organizationName, account.plan, account.createdAt, account.updatedAt);
  },
  activate(userId: number, accountId: string | null): void {
    const db = getConnection();
    if (accountId === null) db.prepare('DELETE FROM claude_active_subscription_accounts WHERE user_id = ?').run(userId);
    else db.prepare(`INSERT INTO claude_active_subscription_accounts (user_id,account_id) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET account_id=excluded.account_id`).run(userId, accountId);
  },
  delete(userId: number, id: string): void {
    const db = getConnection();
    db.transaction(() => {
      db.prepare('DELETE FROM claude_active_subscription_accounts WHERE user_id = ? AND account_id = ?').run(userId, id);
      db.prepare('DELETE FROM claude_subscription_accounts WHERE user_id = ? AND id = ?').run(userId, id);
    })();
  },
};
