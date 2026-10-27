import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { getConnection } from '@/modules/database/connection.js';
import { AppError } from '@/shared/index.js';
import type { SshProjectTarget, SshSessionTarget } from '@/shared/index.js';

const targetColumns = `project_id AS projectId, owner_id AS ownerId, connection_id AS connectionId,
  connection_label AS connectionLabel, root_path AS rootPath, root_identity AS rootIdentity,
  generation, workspace_id AS workspaceId, anchor_path AS anchorPath, phase,
  active_run_id AS activeRunId, pending_job_id AS pendingJobId`;

type CreateSshProjectTarget = {
  projectId?: string;
  ownerId: string;
  connectionId: string;
  connectionLabel: string;
  rootPath: string;
  rootIdentity: string;
  anchorPath: string;
  displayName: string;
};

function required(value: string, name: string): string {
  if (typeof value !== 'string' || !value.trim() || /[\r\n\0]/.test(value)) {
    throw new AppError(`${name} is required`, { code: 'INVALID_SSH_PROJECT_TARGET', statusCode: 400 });
  }
  return value;
}

function exactTarget(projectId: string): SshProjectTarget {
  const target = sshProjectTargetsDb.getByProjectId(projectId);
  if (!target) throw new AppError('SSH project target was not found', { code: 'SSH_PROJECT_NOT_FOUND', statusCode: 404 });
  return target;
}

/** Projects and the workspace bridge persist verified SSH identity and exact writer ownership through this repository. */
export const sshProjectTargetsDb = {
  getByProjectId(projectId: string): SshProjectTarget | null {
    return getConnection().prepare(`SELECT ${targetColumns} FROM ssh_project_targets WHERE project_id = ?`)
      .get(projectId) as SshProjectTarget | undefined ?? null;
  },

  /** Projects probe/create reuse a physical Windows root only within its authenticated owner, including archived targets. */
  findByOwnerRootIdentity(ownerId: string, rootIdentity: string): SshProjectTarget | null {
    return getConnection().prepare(`SELECT ${targetColumns} FROM ssh_project_targets WHERE owner_id = ? AND root_identity = ?`)
      .get(ownerId, rootIdentity) as SshProjectTarget | undefined ?? null;
  },

  getByAnchor(anchorPath: string): SshProjectTarget | null {
    return getConnection().prepare(`SELECT ${targetColumns} FROM ssh_project_targets WHERE anchor_path = ?`)
      .get(path.resolve(anchorPath)) as SshProjectTarget | undefined ?? null;
  },

  /** The bridge resolves only VPS metadata anchors here; Windows roots are never passed to host path operations. */
  getByPath(candidatePath: string): SshProjectTarget | null {
    let candidate = path.resolve(candidatePath);
    for (;;) {
      const target = sshProjectTargetsDb.getByAnchor(candidate);
      if (target) return target;
      const parent = path.dirname(candidate);
      if (candidate === parent) return null;
      candidate = parent;
    }
  },

  /** The project row and verified target are committed together, so a duplicate physical target cannot leave a cloud-looking orphan. */
  createWithProject(input: CreateSshProjectTarget): SshProjectTarget {
    const projectId = input.projectId === undefined ? randomUUID() : required(input.projectId, 'projectId');
    const ownerId = required(input.ownerId, 'ownerId');
    const connectionId = required(input.connectionId, 'connectionId');
    const connectionLabel = required(input.connectionLabel, 'connectionLabel');
    const rootPath = required(input.rootPath, 'rootPath');
    const rootIdentity = required(input.rootIdentity, 'rootIdentity');
    const anchorPath = path.resolve(required(input.anchorPath, 'anchorPath'));
    const displayName = required(input.displayName, 'displayName').trim();
    const db = getConnection();
    try {
      return db.transaction(() => {
        const duplicate = db.prepare('SELECT project_id FROM ssh_project_targets WHERE owner_id = ? AND root_identity = ?')
          .get(ownerId, rootIdentity);
        if (duplicate) throw new AppError('This physical directory identity is already registered for this account', { code: 'SSH_PROJECT_ALREADY_EXISTS', statusCode: 409 });
        db.prepare('INSERT INTO projects (project_id, project_path, custom_project_name, isStarred, isArchived) VALUES (?, ?, ?, 0, 0)')
          .run(projectId, anchorPath, displayName);
        db.prepare(`INSERT INTO ssh_project_targets (project_id, owner_id, connection_id, connection_label,
          root_path, root_identity, generation, workspace_id, anchor_path)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(projectId, ownerId, connectionId, connectionLabel, rootPath, rootIdentity, randomUUID(), randomUUID(), anchorPath);
        return exactTarget(projectId);
      })();
    } catch (error) {
      if ((error as { code?: string })?.code?.startsWith('SQLITE_CONSTRAINT')) {
        const physicalDuplicate = (error as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE'
          && /UNIQUE constraint failed: ssh_project_targets\.owner_id, ssh_project_targets\.root_identity$/.test((error as Error).message);
        if (physicalDuplicate && sshProjectTargetsDb.findByOwnerRootIdentity(ownerId, rootIdentity)) {
          throw new AppError('This physical directory identity is already registered for this account', { code: 'SSH_PROJECT_ALREADY_EXISTS', statusCode: 409 });
        }
        throw new AppError('SSH project or metadata anchor conflicts with an existing record', { code: 'SSH_PROJECT_CONFLICT', statusCode: 409 });
      }
      throw error;
    }
  },

  getSessionTarget(sessionId: string): SshSessionTarget | null {
    return getConnection().prepare('SELECT session_id AS sessionId, project_id AS projectId, generation FROM ssh_session_targets WHERE session_id = ?')
      .get(sessionId) as SshSessionTarget | undefined ?? null;
  },

  /** Sessions can acquire their original target once; subsequent requests must prove the same durable project and generation. */
  pinSession(sessionId: string, target: SshProjectTarget): SshSessionTarget {
    const db = getConnection();
    return db.transaction(() => {
      const current = exactTarget(target.projectId);
      if (current.generation !== target.generation || current.anchorPath !== target.anchorPath || current.workspaceId !== target.workspaceId) {
        throw new AppError('SSH project binding changed', { code: 'WORKSPACE_GENERATION_CHANGED', statusCode: 409 });
      }
      const session = db.prepare('SELECT project_path FROM sessions WHERE session_id = ?').get(sessionId) as { project_path: string | null } | undefined;
      if (!session || session.project_path !== current.anchorPath) {
        throw new AppError('The session does not belong to this SSH project', { code: 'WORKSPACE_SELECTION_MISMATCH', statusCode: 409 });
      }
      const existing = sshProjectTargetsDb.getSessionTarget(sessionId);
      if (existing && (existing.projectId !== current.projectId || existing.generation !== current.generation)) {
        throw new AppError('The session is pinned to a different SSH project binding', { code: 'WORKSPACE_GENERATION_CHANGED', statusCode: 409 });
      }
      if (!existing) db.prepare('INSERT INTO ssh_session_targets (session_id, project_id, generation) VALUES (?, ?, ?)')
        .run(sessionId, current.projectId, current.generation);
      return { sessionId, projectId: current.projectId, generation: current.generation };
    })();
  },

  beginRun(projectId: string, runId: string): SshProjectTarget {
    required(runId, 'runId');
    const result = getConnection().prepare(`UPDATE ssh_project_targets SET phase = 'running', active_run_id = ?, pending_job_id = NULL,
      updated_at = CURRENT_TIMESTAMP WHERE project_id = ? AND phase = 'idle' AND active_run_id IS NULL`)
      .run(runId, projectId);
    if (!result.changes) {
      exactTarget(projectId);
      throw new AppError('The SSH project still has a running or unconfirmed task', { code: 'WORKSPACE_BUSY', statusCode: 409 });
    }
    return exactTarget(projectId);
  },

  /** The bridge records the remote job before dispatch and clears it only after a verified completion receipt. */
  setPendingJob(projectId: string, runId: string, jobId: string | null): SshProjectTarget {
    required(runId, 'runId');
    if (jobId !== null) required(jobId, 'jobId');
    const result = getConnection().prepare(`UPDATE ssh_project_targets SET pending_job_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE project_id = ? AND active_run_id = ? AND phase IN ('running', 'recovery')`).run(jobId, projectId, runId);
    if (!result.changes) {
      exactTarget(projectId);
      throw new AppError('The SSH task no longer owns this project', { code: 'WORKSPACE_SELECTION_MISMATCH', statusCode: 409 });
    }
    return exactTarget(projectId);
  },

  finishRun(projectId: string, runId: string, options: { uncertain?: boolean; pendingJobId?: string } = {}): SshProjectTarget {
    required(runId, 'runId');
    if (options.pendingJobId !== undefined) required(options.pendingJobId, 'pendingJobId');
    const uncertain = options.uncertain === true;
    const result = getConnection().prepare(`UPDATE ssh_project_targets SET phase = ?, active_run_id = ?,
      pending_job_id = CASE WHEN ? = 0 THEN NULL WHEN ? IS NULL THEN pending_job_id ELSE ? END,
      updated_at = CURRENT_TIMESTAMP WHERE project_id = ? AND active_run_id = ? AND phase IN ('running', 'recovery')`)
      .run(uncertain ? 'recovery' : 'idle', uncertain ? runId : null, uncertain ? 1 : 0,
        options.pendingJobId ?? null, options.pendingJobId ?? null, projectId, runId);
    if (!result.changes) {
      exactTarget(projectId);
      throw new AppError('The SSH task no longer owns this project', { code: 'WORKSPACE_SELECTION_MISMATCH', statusCode: 409 });
    }
    return exactTarget(projectId);
  },

  /** Recovery callers may clear only the run whose remote teardown they have confirmed. */
  recoverRun(projectId: string, runId: string): SshProjectTarget {
    return sshProjectTargetsDb.finishRun(projectId, runId);
  },

  getRun(projectId: string): { phase: SshProjectTarget['phase']; runId: string | null; pendingJobId: string | null } | null {
    const target = sshProjectTargetsDb.getByProjectId(projectId);
    return target ? { phase: target.phase, runId: target.activeRunId ?? null, pendingJobId: target.pendingJobId ?? null } : null;
  },
};
