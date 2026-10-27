import { claudeAccountsDb, claudeConnectionsDb, projectsDb, sessionsDb, userDb } from '@/modules/database/index.js';
import { getProjectRuntimeManifest, readProjectMemory, writeProjectMemory } from '@/modules/project-runtime/index.js';
import { assertWorkspaceDescriptor, describeWorkspaceSelection } from '@/modules/workspace-bridge/index.js';
import { AppError } from '@/shared/index.js';
import type { ProjectRuntimeManifest } from '@/shared/index.js';

import { assertProjectSshAccess } from './project-ssh-access.service.js';

function accountKey(userId: string): string {
  const id = Number(userId);
  const connection = claudeConnectionsDb.activeId(id);
  if (connection) return 'api:' + connection;
  const account = claudeAccountsDb.activeId(id);
  return account ? 'subscription:' + account : userDb.getActiveUserIds().length === 1 ? 'subscription:default' : 'app';
}

/** Projects context routes return only the current authenticated user's exact project generation and selected Claude account provenance. */
export function getCurrentProjectRuntimeManifest(userId: string, projectId: string): ProjectRuntimeManifest | null {
  assertProjectSshAccess(projectId, userId);
  const project = projectsDb.getProjectById(projectId);
  if (!project) return null;
  const manifest = getProjectRuntimeManifest(userId, projectId, { accountKey: accountKey(userId) });
  if (!manifest) return null;
  const session = manifest.sessionId ? sessionsDb.getSessionById(manifest.sessionId) : null;
  if (manifest.sessionId && (!session || session.project_path !== project.project_path)) return null;
  try {
    const resolution = describeWorkspaceSelection({ projectId, sourceRoot: project.project_path,
      ...(manifest.sessionId ? { sessionId: manifest.sessionId, requestedMode: session?.workspace_mode } : {}) });
    const selected = manifest.sessionId ? resolution.session : resolution.cloudReplica;
    if (!selected || selected.projectId !== projectId || selected.sourceRoot !== project.project_path
      || selected.sessionId !== manifest.sessionId || selected.kind !== (manifest.sessionId ? 'session' : 'cloudReplica')
      || selected.workspaceId !== manifest.workspaceId || selected.generation !== manifest.generation) return null;
    assertWorkspaceDescriptor(selected);
    return manifest;
  } catch (error) {
    // Binding replacement, deleted worktrees and stale session pins invalidate this report.
    // Database and unexpected runtime failures still surface instead of looking like an empty context.
    if (error instanceof AppError && [
      'WORKSPACE_SELECTION_MISMATCH', 'WORKSPACE_GENERATION_CHANGED', 'WORKSPACE_SESSION_NOT_READY',
      'WORKSPACE_SESSION_NOT_FOUND', 'WORKSPACE_WORKTREE_CONFLICT', 'WORKSPACE_NOT_FOUND',
      'SSH_WORKSPACE_NOT_FOUND', 'SSH_WORKSPACE_CHANGED', 'STALE_BINDING',
    ].includes(error.code)) return null;
    throw error;
  }
}

/** The project memory API shares cloud storage with context tools; project ownership is checked before reading, never inferred from a provider HOME. */
export function getCurrentProjectMemory(userId: string, projectId: string) {
  assertProjectSshAccess(projectId, userId);
  if (!projectsDb.getProjectById(projectId)) throw new AppError('Project not found', { code: 'PROJECT_NOT_FOUND', statusCode: 404 });
  return readProjectMemory(userId, projectId);
}

/** A user edit uses the exact last-read hash, preserving concurrent model or browser edits. Clearing writes the empty string with the same CAS contract. */
export function saveCurrentProjectMemory(userId: string, projectId: string, content: string, expectedHash: string) {
  assertProjectSshAccess(projectId, userId);
  if (!projectsDb.getProjectById(projectId)) throw new AppError('Project not found', { code: 'PROJECT_NOT_FOUND', statusCode: 404 });
  return writeProjectMemory(userId, projectId, content, expectedHash);
}
