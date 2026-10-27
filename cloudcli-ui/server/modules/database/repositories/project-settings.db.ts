import { getConnection } from '@/modules/database/connection.js';

/** One project's nullable overrides; NULL means the field inherits. */
export type ProjectSettingsRow = {
  projectId: string;
  provider: string | null;
  model: string | null;
  effort: string | null;
  permissionMode: string | null;
  workspaceMode: string | null;
  updatedAt: string | null;
};

type ProjectSettingsDbRow = {
  project_id: string;
  provider: string | null;
  model: string | null;
  effort: string | null;
  permission_mode: string | null;
  workspace_mode: string | null;
  updated_at: string | null;
};

/** Projects supplies only changed overrides; undefined inherits the stored value and null clears it. */
export type ProjectSettingsPatch = {
  provider?: string | null;
  model?: string | null;
  effort?: string | null;
  permissionMode?: string | null;
  workspaceMode?: string | null;
};

const SETTINGS_COLUMNS =
  'project_id, provider, model, effort, permission_mode, workspace_mode, updated_at';

function toRow(row: ProjectSettingsDbRow | undefined): ProjectSettingsRow | null {
  return row
    ? {
      projectId: row.project_id,
      provider: row.provider,
      model: row.model,
      effort: row.effort,
      permissionMode: row.permission_mode,
      workspaceMode: row.workspace_mode,
      updatedAt: row.updated_at,
    }
    : null;
}

/**
 * Projects persists explicit project overrides only.
 *
 * `undefined` leaves a field untouched, `null` clears it so the project follows
 * its account or built-in default again. A row whose fields are all NULL is
 * deleted rather than kept as an empty override record.
 */
export const projectSettingsDb = {
  get(projectId: string): ProjectSettingsRow | null {
    const row = getConnection()
      .prepare(`SELECT ${SETTINGS_COLUMNS} FROM project_settings WHERE project_id = ?`)
      .get(projectId) as ProjectSettingsDbRow | undefined;
    return toRow(row);
  },

  save(projectId: string, patch: ProjectSettingsPatch): ProjectSettingsRow | null {
    const db = getConnection();
    return db.transaction(() => {
      const existing = projectSettingsDb.get(projectId);
      const next = {
        provider: patch.provider === undefined ? existing?.provider ?? null : patch.provider,
        model: patch.model === undefined ? existing?.model ?? null : patch.model,
        effort: patch.effort === undefined ? existing?.effort ?? null : patch.effort,
        permissionMode: patch.permissionMode === undefined ? existing?.permissionMode ?? null : patch.permissionMode,
        workspaceMode: patch.workspaceMode === undefined ? existing?.workspaceMode ?? null : patch.workspaceMode,
      };
      const isEmpty = Object.values(next).every((value) => value === null);

      if (isEmpty) {
        db.prepare('DELETE FROM project_settings WHERE project_id = ?').run(projectId);
        return null;
      }

      db.prepare(
        `INSERT INTO project_settings
           (project_id, provider, model, effort, permission_mode, workspace_mode, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(project_id) DO UPDATE SET
           provider = excluded.provider,
           model = excluded.model,
           effort = excluded.effort,
           permission_mode = excluded.permission_mode,
           workspace_mode = excluded.workspace_mode,
           updated_at = CURRENT_TIMESTAMP`
      ).run(
        projectId,
        next.provider,
        next.model,
        next.effort,
        next.permissionMode,
        next.workspaceMode,
      );

      return projectSettingsDb.get(projectId);
    })();
  },

  clear(projectId: string): void {
    getConnection().prepare('DELETE FROM project_settings WHERE project_id = ?').run(projectId);
  },
};
