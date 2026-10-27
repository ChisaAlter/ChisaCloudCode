import { getConnection } from '@/modules/database/connection.js';

/** SSH-workspaces consumes private account-owned endpoints; transport/API callers must omit the token from public output. */
export type AgentWorkspaceConnectionRow = {
  id: string;
  ownerId: string;
  name: string;
  port: number;
  token: string | null;
  delivery: 'direct' | 'relay';
  createdAt: string;
  updatedAt: string;
};

type DbRow = {
  id: string;
  owner_id: string;
  name: string;
  port: number;
  token: string | null;
  delivery: 'direct' | 'relay';
  created_at: string;
  updated_at: string;
};

const COLUMNS = 'id, owner_id, name, port, token, delivery, created_at, updated_at';

function toRow(row: DbRow | undefined): AgentWorkspaceConnectionRow | null {
  return row
    ? {
      id: row.id,
      ownerId: row.owner_id,
      name: row.name,
      port: row.port,
      token: row.token,
      delivery: row.delivery,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
    : null;
}

/** Stores account-scoped desktop loopback endpoints; credentials and project roots stay outside this table. */
export const agentWorkspaceConnectionsDb = {
  list(ownerId: string): AgentWorkspaceConnectionRow[] {
    const rows = getConnection()
      .prepare(`SELECT ${COLUMNS} FROM agent_workspace_connections WHERE owner_id = ? ORDER BY updated_at DESC, id ASC`)
      .all(ownerId) as DbRow[];
    return rows.map((row) => toRow(row)!);
  },

  get(ownerId: string, id: string): AgentWorkspaceConnectionRow | null {
    const row = getConnection()
      .prepare(`SELECT ${COLUMNS} FROM agent_workspace_connections WHERE owner_id = ? AND id = ?`)
      .get(ownerId, id) as DbRow | undefined;
    return toRow(row);
  },

  upsert(ownerId: string, id: string, name: string, port: number, token: string, delivery: 'direct' | 'relay' = 'direct'): AgentWorkspaceConnectionRow {
    getConnection().prepare(
      `INSERT INTO agent_workspace_connections (id, owner_id, name, port, token, delivery) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(owner_id, id) DO UPDATE SET name = excluded.name, port = excluded.port,
         token = excluded.token, delivery = excluded.delivery, updated_at = CURRENT_TIMESTAMP`,
    ).run(id, ownerId, name, port, token, delivery);
    return agentWorkspaceConnectionsDb.get(ownerId, id)!;
  },

  remove(ownerId: string, id: string): boolean {
    return getConnection()
      .prepare('DELETE FROM agent_workspace_connections WHERE owner_id = ? AND id = ?')
      .run(ownerId, id).changes > 0;
  },
};
