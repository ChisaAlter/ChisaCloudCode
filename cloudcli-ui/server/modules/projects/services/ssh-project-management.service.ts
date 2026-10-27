import { randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath, rmdir } from 'node:fs/promises';
import path from 'node:path';

import { projectsDb, sshProjectTargetsDb } from '@/modules/database/index.js';
import { probeSshWorkspace } from '@/modules/ssh-workspaces/index.js';
import { AppError, WORKSPACES_ROOT } from '@/shared/index.js';
import type { SshProjectTarget } from '@/shared/index.js';

const anchorsDirectoryName = '.chisa-ssh-projects';
type CreateSshProjectInput = { ownerId: string; connectionId: string; rootPath: string; customName?: string | null };
type SshProjectDependencies = {
  probe: typeof probeSshWorkspace;
  workspaceRoot: string;
  makeId(): string;
  prepareAnchor(anchorPath: string): Promise<void>;
  removeEmptyAnchor(anchorPath: string): Promise<void>;
  persist: typeof sshProjectTargetsDb.createWithProject;
  findExisting: typeof sshProjectTargetsDb.findByOwnerRootIdentity;
  getProject: typeof projectsDb.getProjectById;
  setArchived: typeof projectsDb.updateProjectIsArchivedById;
};

async function prepareAnchor(anchorPath: string): Promise<void> {
  const root = path.resolve(WORKSPACES_ROOT);
  const parent = path.dirname(anchorPath);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentStats = await lstat(parent);
  if (!parentStats.isDirectory() || parentStats.isSymbolicLink() || await realpath(parent) !== parent || path.dirname(parent) !== root) {
    throw new AppError('SSH metadata directory must be a real workspace child directory', { code: 'SSH_ANCHOR_INVALID', statusCode: 503 });
  }
  await mkdir(anchorPath, { mode: 0o700 });
  const actual = await lstat(anchorPath);
  if (!actual.isDirectory() || actual.isSymbolicLink() || await realpath(anchorPath) !== anchorPath) {
    throw new AppError('SSH metadata anchor is invalid', { code: 'SSH_ANCHOR_INVALID', statusCode: 503 });
  }
}

const defaultDependencies: SshProjectDependencies = {
  probe: probeSshWorkspace,
  workspaceRoot: WORKSPACES_ROOT,
  makeId: randomUUID,
  prepareAnchor,
  removeEmptyAnchor: async anchorPath => { await rmdir(anchorPath); },
  persist: input => sshProjectTargetsDb.createWithProject(input),
  findExisting: (owner, identity) => sshProjectTargetsDb.findByOwnerRootIdentity(owner, identity),
  getProject: id => projectsDb.getProjectById(id),
  setArchived: (id, archived) => projectsDb.updateProjectIsArchivedById(id, archived),
};

async function verifiedDirectory(input: CreateSshProjectInput, dependencies: SshProjectDependencies) {
  if (typeof input.ownerId !== 'string' || !input.ownerId.trim()) {
    throw new AppError('Authentication is required for SSH projects', { code: 'UNAUTHORIZED', statusCode: 401 });
  }
  if (typeof input.connectionId !== 'string' || !input.connectionId.trim() || typeof input.rootPath !== 'string' || !input.rootPath.trim()) {
    throw new AppError('connectionId and rootPath are required', { code: 'SSH_PROJECT_INPUT_REQUIRED', statusCode: 400 });
  }
  const probe = await dependencies.probe({ connectionId: input.connectionId, rootPath: input.rootPath, userId: input.ownerId });
  if (!probe.ok || !probe.rootPath || !probe.rootIdentity || probe.connectionId !== input.connectionId || !probe.connectionLabel || probe.platform !== 'win32') {
    throw new AppError('SSH directory verification returned incomplete identity', { code: 'SSH_WORKSPACE_PROBE_INVALID', statusCode: 503 });
  }
  return probe;
}

function descriptor(target: SshProjectTarget, dependencies: SshProjectDependencies) {
  const row = dependencies.getProject(target.projectId);
  if (!row || row.project_path !== target.anchorPath) throw new AppError('SSH project metadata is unavailable', { code: 'SSH_PROJECT_NOT_FOUND', statusCode: 404 });
  const displayName = row.custom_project_name?.trim() || path.win32.basename(target.rootPath) || target.rootPath;
  return {
    projectId: target.projectId, path: target.anchorPath, fullPath: target.anchorPath,
    displayPath: target.rootPath, displayName, customName: displayName, sourceMode: 'ssh' as const,
    connectionLabel: target.connectionLabel, sshConnectionId: target.connectionId,
    isArchived: Boolean(row.isArchived), isStarred: Boolean(row.isStarred),
    sessions: [], sessionMeta: { hasMore: false, total: 0 },
  };
}

function ownedExisting(ownerId: string, rootIdentity: string, dependencies: SshProjectDependencies) {
  const target = dependencies.findExisting(ownerId, rootIdentity);
  // Do not expose a foreign row even if a test adapter or damaged registry
  // violates the repository's owner/root query contract.
  return target?.ownerId === ownerId && target.rootIdentity === rootIdentity ? target : null;
}

function reuseProject(target: SshProjectTarget, dependencies: SshProjectDependencies) {
  const project = descriptor(target, dependencies);
  if (project.isArchived) {
    // Only an explicit create/open POST restores visibility. Target identity,
    // connection, generation, writer/recovery state and history remain intact.
    dependencies.setArchived(target.projectId, false);
    return { outcome: 'reactivated_archived' as const, project: descriptor(target, dependencies) };
  }
  return { outcome: 'existing' as const, project };
}

/** Workspaces probe routes verify the selected endpoint and identify an existing owner project without restoring or changing it. */
export async function probeSshProjectDirectory(input: CreateSshProjectInput, dependencies: SshProjectDependencies = defaultDependencies) {
  const probe = await verifiedDirectory(input, dependencies);
  const existing = ownedExisting(input.ownerId, probe.rootIdentity, dependencies);
  return { ...probe, ...(existing ? { existingProject: descriptor(existing, dependencies) } : {}) };
}

/** Projects routes create or reopen one verified physical Windows directory while preserving its original project and target state. */
export async function createSshProject(input: CreateSshProjectInput, dependencies: SshProjectDependencies = defaultDependencies) {
  // Re-probe on every explicit POST; the browser's earlier probe cannot authorize
  // a later create/reopen after the endpoint or physical directory has changed.
  const probe = await verifiedDirectory(input, dependencies);
  const existing = ownedExisting(input.ownerId, probe.rootIdentity, dependencies);
  if (existing) return reuseProject(existing, dependencies);
  const projectId = dependencies.makeId();
  const anchorPath = path.join(path.resolve(dependencies.workspaceRoot), anchorsDirectoryName, projectId);
  const displayName = input.customName?.trim() || path.win32.basename(probe.rootPath) || probe.rootPath;
  await dependencies.prepareAnchor(anchorPath);
  let target;
  try {
    target = dependencies.persist({ projectId, ownerId: input.ownerId, connectionId: probe.connectionId,
      connectionLabel: probe.connectionLabel, rootPath: probe.rootPath, rootIdentity: probe.rootIdentity,
      anchorPath, displayName });
  } catch (error) {
    // Delete only the newly created empty anchor; never recurse into a source or
    // pre-existing directory. An unrelated constraint is never an open-existing result.
    try { await dependencies.removeEmptyAnchor(anchorPath); } catch { /* Preserve any concurrent file for inspection. */ }
    if ((error as { code?: string }).code === 'SSH_PROJECT_ALREADY_EXISTS') {
      const winner = ownedExisting(input.ownerId, probe.rootIdentity, dependencies);
      if (winner) return reuseProject(winner, dependencies);
    }
    throw error;
  }
  return { outcome: 'created' as const, project: descriptor(target, dependencies) };
}
