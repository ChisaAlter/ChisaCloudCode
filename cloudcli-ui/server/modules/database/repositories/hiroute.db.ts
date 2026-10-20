import { getConnection } from '@/modules/database/connection.js';
import type { HiRouteConnection } from '@/shared/types.js';

/** Providers uses this repository to read and atomically replace a user's private HiRoute connection. */
export const hirouteDb = {
  get(userId: number): HiRouteConnection | null {
    const row = getConnection().prepare(
      'SELECT connection_json FROM hiroute_connections WHERE user_id = ?',
    ).get(userId) as { connection_json: string } | undefined;
    if (!row) return null;
    // Corrupt settings must fail explicitly rather than silently sending traffic to another destination.
    const value = JSON.parse(row.connection_json) as Partial<HiRouteConnection> | null;
    if (!value || typeof value.enabled !== 'boolean' || typeof value.baseUrl !== 'string'
      || typeof value.routeModel !== 'string' || typeof value.authToken !== 'string') {
      throw new Error('Stored HiRoute configuration is invalid. Save the connection again.');
    }
    return value as HiRouteConnection;
  },

  save(userId: number, connection: HiRouteConnection): void {
    const db = getConnection();
    db.transaction(() => {
      db.prepare('INSERT INTO hiroute_connections (user_id, connection_json) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET connection_json = excluded.connection_json')
        .run(userId, JSON.stringify(connection));
    })();
  },
};
