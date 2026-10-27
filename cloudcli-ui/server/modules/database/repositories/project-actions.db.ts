import { randomUUID } from 'node:crypto';

import { getConnection } from '@/modules/database/connection.js';

/** Projects classifies explicit commands for run, test, build and custom actions. */
export type ProjectActionKind = 'run' | 'test' | 'build' | 'custom';

/** Projects consumes persisted commands scoped to one project and their display order. */
export type ProjectActionRow = {
  id: string;
  projectId: string;
  name: string;
  command: string;
  kind: ProjectActionKind;
  cwd: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

type DbRow = {
  id: string;
  project_id: string;
  name: string;
  command: string;
  kind: ProjectActionKind;
  cwd: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

const COLUMNS = 'id, project_id, name, command, kind, cwd, sort_order, created_at, updated_at';

function toRow(row: DbRow | undefined): ProjectActionRow | null {
  return row
    ? {
      id: row.id,
      projectId: row.project_id,
      name: row.name,
      command: row.command,
      kind: row.kind,
      cwd: row.cwd,
      sortOrder: row.sort_order,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
    : null;
}

/** Projects supplies validated command values; repository-owned ids and timestamps are generated separately. */
export type ProjectActionInput = {
  name: string;
  command: string;
  kind: ProjectActionKind;
  cwd: string | null;
  sortOrder: number;
};

/** Projects persists explicit project commands; the execution layer still owns admission and recovery. */
export const projectActionsDb = {
  list(projectId: string): ProjectActionRow[] {
    const rows = getConnection()
      .prepare(`SELECT ${COLUMNS} FROM project_actions WHERE project_id = ? ORDER BY sort_order ASC, created_at ASC`)
      .all(projectId) as DbRow[];
    return rows.map((row) => toRow(row)!);
  },

  get(projectId: string, id: string): ProjectActionRow | null {
    const row = getConnection()
      .prepare(`SELECT ${COLUMNS} FROM project_actions WHERE project_id = ? AND id = ?`)
      .get(projectId, id) as DbRow | undefined;
    return toRow(row);
  },

  create(projectId: string, input: ProjectActionInput): ProjectActionRow {
    const id = randomUUID();
    getConnection().prepare(
      `INSERT INTO project_actions (id, project_id, name, command, kind, cwd, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, projectId, input.name, input.command, input.kind, input.cwd, input.sortOrder);
    return projectActionsDb.get(projectId, id)!;
  },

  update(projectId: string, id: string, input: ProjectActionInput): ProjectActionRow | null {
    const result = getConnection().prepare(
      `UPDATE project_actions
       SET name = ?, command = ?, kind = ?, cwd = ?, sort_order = ?, updated_at = CURRENT_TIMESTAMP
       WHERE project_id = ? AND id = ?`,
    ).run(input.name, input.command, input.kind, input.cwd, input.sortOrder, projectId, id);
    return result.changes > 0 ? projectActionsDb.get(projectId, id) : null;
  },

  remove(projectId: string, id: string): boolean {
    const result = getConnection()
      .prepare('DELETE FROM project_actions WHERE project_id = ? AND id = ?')
      .run(projectId, id);
    return result.changes > 0;
  },
};
