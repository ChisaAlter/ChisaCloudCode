import { projectsDb, sshProjectTargetsDb, userDb } from '@/modules/database/index.js';
import { assertCloudWorkspaceOwner } from '@/modules/workspace-runtime/index.js';
import { AppError } from '@/shared/index.js';

/** Project routes authorize both saved SSH targets and existing cloud account bindings before reading or changing project metadata. */
export function assertProjectSshAccess(projectId: string, ownerId: string): void {
  const target = sshProjectTargetsDb.getByProjectId(projectId);
  if (target) {
    if (target.ownerId !== ownerId) throw new AppError('Project not found', { code: 'PROJECT_NOT_FOUND', statusCode: 404 });
    return;
  }
  const project = projectsDb.getProjectById(projectId);
  if (project) assertCloudWorkspaceOwner(project.project_path, ownerId, userDb.getActiveUserIds());
}

/** Catalog services filter before display-name filesystem reads and pagination, using the same authorization as direct project routes. */
export function canReadProject(projectId: string, ownerId: string): boolean {
  try { assertProjectSshAccess(projectId, ownerId); return true; }
  catch { return false; }
}
