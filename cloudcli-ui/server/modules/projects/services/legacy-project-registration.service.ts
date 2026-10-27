import fs from 'node:fs/promises';
import path from 'node:path';

import { projectsDb } from '@/modules/database/index.js';
import type { CreateProjectPathResult, WorkspacePathValidationResult } from '@/shared/types.js';
import { WORKSPACES_ROOT, normalizeProjectPath, validateWorkspacePath } from '@/shared/index.js';

/**
 * Register project paths that already exist on the workspace volume.
 *
 * This is the migration path for synchronization-era projects: the desktop knew
 * the server path but the project list is built from the `projects` table, so a
 * path that was never registered has no entry. Registration here deliberately
 * differs from `createProject`:
 *
 * - it never creates a directory (an absent path is rejected, not cloned or
 *   materialized, so an unmounted or wrong-server path can never turn into a
 *   bogus local directory),
 * - it never copies or uploads files,
 * - it never changes an existing row's display name or archive state beyond the
 *   reactivation `createProjectPath` already performs,
 * - it is idempotent: an active path returns the existing row unchanged.
 */
export type LegacyProjectPathOutcome = 'registered' | 'existing' | 'reactivated_archived' | 'rejected';

export type LegacyProjectPathResult = {
  path: string;
  outcome: LegacyProjectPathOutcome;
  projectId?: string;
  reason?: string;
};

export type LegacyProjectRegistrationDependencies = {
  validatePath: (projectPath: string) => Promise<WorkspacePathValidationResult>;
  isExistingDirectory: (projectPath: string) => Promise<boolean>;
  persistProjectPath: (projectPath: string, customName: string | null) => CreateProjectPathResult;
  /** Canonical workspace volume root; defaults to WORKSPACES_ROOT. */
  workspaceRoot?: string;
};

/** A bounded batch keeps a hostile or accidental payload from scanning the volume. */
export const LEGACY_PROJECT_PATH_LIMIT = 200;

const defaultDependencies: LegacyProjectRegistrationDependencies = {
  validatePath: validateWorkspacePath,
  isExistingDirectory: async (projectPath: string): Promise<boolean> => {
    try {
      const stats = await fs.stat(projectPath);
      return stats.isDirectory();
    } catch {
      return false;
    }
  },
  persistProjectPath: (projectPath: string, customName: string | null): CreateProjectPathResult =>
    projectsDb.createProjectPath(projectPath, customName),
};

function rejected(rawPath: string, reason: string): LegacyProjectPathResult {
  return { path: rawPath, outcome: 'rejected', reason };
}

export async function registerExistingProjectPaths(
  input: unknown,
  dependencies: LegacyProjectRegistrationDependencies = defaultDependencies,
): Promise<{ results: LegacyProjectPathResult[] }> {
  const requested = Array.isArray(input) ? input.slice(0, LEGACY_PROJECT_PATH_LIMIT) : [];
  const results: LegacyProjectPathResult[] = [];
  const accepted = new Set<string>();
  const workspaceRoot = normalizeProjectPath(path.resolve(dependencies.workspaceRoot ?? WORKSPACES_ROOT));

  for (const candidate of requested) {
    if (typeof candidate !== 'string') {
      results.push(rejected('', 'path must be a string'));
      continue;
    }

    const normalized = normalizeProjectPath(candidate);
    if (!normalized || !path.isAbsolute(normalized)) {
      results.push(rejected(normalized, 'path must be absolute'));
      continue;
    }

    // Reuses the same containment/symlink/system-directory guard as project
    // creation so a legacy record cannot point at the backend host outside the
    // account workspace volume.
    const validation = await dependencies.validatePath(normalized);
    if (!validation.valid || !validation.resolvedPath) {
      results.push(rejected(normalized, 'path is not inside the account workspace'));
      continue;
    }

    const resolvedPath = normalizeProjectPath(path.resolve(validation.resolvedPath));
    const reservedAnchors = path.join(workspaceRoot, '.chisa-ssh-projects');
    if (resolvedPath === reservedAnchors || resolvedPath.startsWith(reservedAnchors + path.sep)) {
      results.push(rejected(resolvedPath, 'SSH metadata anchors are not cloud project sources'));
      continue;
    }
    if (resolvedPath === workspaceRoot) {
      results.push(rejected(resolvedPath, 'the workspace root itself is not a project'));
      continue;
    }
    if (accepted.has(resolvedPath)) {
      results.push(rejected(resolvedPath, 'duplicate path in request'));
      continue;
    }

    // Absence must stay a report, never a mutation.
    if (!(await dependencies.isExistingDirectory(resolvedPath))) {
      results.push(rejected(resolvedPath, 'path does not exist as a directory'));
      continue;
    }
    accepted.add(resolvedPath);

    const persisted = dependencies.persistProjectPath(resolvedPath, null);
    const projectRow = persisted.project;
    if (!projectRow) {
      results.push(rejected(resolvedPath, 'project row could not be resolved'));
      continue;
    }

    results.push({
      path: resolvedPath,
      outcome:
        persisted.outcome === 'active_conflict'
          ? 'existing'
          : persisted.outcome === 'created'
            ? 'registered'
            : 'reactivated_archived',
      projectId: projectRow.project_id,
    });
  }

  return { results };
}
