import { AppError, normalizeProjectPath } from '@/shared/index.js';
import type { SessionWorkspaceMode, WorkspaceDescriptor, WorkspaceResolution, WorkspaceSelector } from '@/shared/index.js';

// Catalog records use app session ids, never provider transcript/session ids.
type CatalogSession = {
  session_id: string;
  project_path: string | null;
  workspace_mode: SessionWorkspaceMode;
};

type WorkspaceCatalogDependencies = {
  getProjectPathById(projectId: string): string | null;
  getSessionById(sessionId: string): CatalogSession | null;
  getSessionsByProjectPath(projectPath: string): CatalogSession[];
  describeWorkspaceSelection(input: { projectId: string; sourceRoot: string; sessionId?: string; requestedMode?: SessionWorkspaceMode }): WorkspaceResolution;
  assertWorkspaceDescriptor(descriptor: WorkspaceDescriptor): void;
  isWorkspaceBound(sourceRoot: string): boolean;
};

function selectionError(message: string, code = 'WORKSPACE_SELECTION_MISMATCH', statusCode = 409): AppError {
  return new AppError(message, { code, statusCode });
}

/** Workspaces composition and catalog tests use durable project/session ownership before bridge resolution. */
export function createWorkspaceCatalog(dependencies: WorkspaceCatalogDependencies) {
  function projectRoot(projectId: string): string {
    if (typeof projectId !== 'string' || !projectId.trim()) {
      throw selectionError('projectId is required', 'PROJECT_ID_REQUIRED', 400);
    }
    const root = dependencies.getProjectPathById(projectId);
    if (!root) throw selectionError('Project not found', 'PROJECT_NOT_FOUND', 404);
    const normalizedRoot = normalizeProjectPath(root);
    if (!normalizedRoot) throw selectionError('Project path is invalid', 'PROJECT_PATH_NOT_FOUND', 404);
    return normalizedRoot;
  }

  function validateSession(session: CatalogSession | null, sourceRoot: string, sessionId: string): CatalogSession {
    if (!session || session.session_id !== sessionId) {
      throw selectionError('App session not found', 'WORKSPACE_SESSION_NOT_FOUND', 404);
    }
    if (!session.project_path || normalizeProjectPath(session.project_path) !== sourceRoot) {
      throw selectionError('The selected session does not belong to this project');
    }
    return session;
  }

  function validateDescriptor(descriptor: WorkspaceDescriptor, projectId: string, sourceRoot: string, sessionId?: string): void {
    if (descriptor.projectId !== projectId || normalizeProjectPath(descriptor.sourceRoot) !== sourceRoot
      || descriptor.kind !== (sessionId ? 'session' : 'cloudReplica')
      || descriptor.sessionId !== sessionId) {
      throw selectionError('The workspace descriptor no longer matches its durable owner');
    }
  }

  function describe(projectId: string, sourceRoot: string, session?: CatalogSession): WorkspaceResolution {
    const resolution = dependencies.describeWorkspaceSelection({
      projectId,
      sourceRoot,
      ...(session ? { sessionId: session.session_id, requestedMode: session.workspace_mode } : {}),
    });
    validateDescriptor(resolution.cloudReplica, projectId, sourceRoot);
    if (resolution.session) {
      if (!session) throw selectionError('An unrequested session workspace was returned');
      validateDescriptor(resolution.session, projectId, sourceRoot, session.session_id);
    }
    return resolution;
  }

  function resolve(projectId: string, sessionId?: string): WorkspaceResolution {
    const sourceRoot = projectRoot(projectId);
    const session = sessionId ? validateSession(dependencies.getSessionById(sessionId), sourceRoot, sessionId) : undefined;
    const resolution = describe(projectId, sourceRoot, session);
    dependencies.assertWorkspaceDescriptor(resolution.cloudReplica);
    if (resolution.session) dependencies.assertWorkspaceDescriptor(resolution.session);
    return resolution;
  }

  function resolveSelectedWorkspace(projectId: string, selector?: WorkspaceSelector | null): WorkspaceDescriptor {
    const sourceRoot = projectRoot(projectId);
    if (!selector) {
      if (dependencies.isWorkspaceBound(sourceRoot)) {
        throw selectionError('workspaceId and generation are required for a bound project', 'WORKSPACE_SELECTOR_REQUIRED', 400);
      }
      const descriptor = describe(projectId, sourceRoot).cloudReplica;
      dependencies.assertWorkspaceDescriptor(descriptor);
      return descriptor;
    }
    if (typeof selector.workspaceId !== 'string' || !selector.workspaceId.trim()
      || typeof selector.generation !== 'string' || !selector.generation.trim()
      || (selector.sessionId !== undefined && (typeof selector.sessionId !== 'string' || !selector.sessionId.trim()))) {
      throw selectionError('Invalid workspace selector', 'INVALID_WORKSPACE_SELECTOR', 400);
    }

    let descriptor: WorkspaceDescriptor | null = null;
    if (selector.sessionId) {
      const session = validateSession(dependencies.getSessionById(selector.sessionId), sourceRoot, selector.sessionId);
      descriptor = describe(projectId, sourceRoot, session).session;
      if (!descriptor) {
        throw selectionError('The selected session workspace has not been created', 'WORKSPACE_SESSION_NOT_READY');
      }
    } else {
      const cloudReplica = describe(projectId, sourceRoot).cloudReplica;
      if (cloudReplica.workspaceId === selector.workspaceId) descriptor = cloudReplica;
      else {
        // A selector may omit the app session id, but it can only identify an
        // already-materialized workspace owned by a persisted project session.
        for (const row of dependencies.getSessionsByProjectPath(sourceRoot)) {
          const session = validateSession(dependencies.getSessionById(row.session_id), sourceRoot, row.session_id);
          const candidate = describe(projectId, sourceRoot, session).session;
          if (candidate?.workspaceId !== selector.workspaceId) continue;
          if (descriptor) throw selectionError('Workspace identity matches multiple sessions');
          descriptor = candidate;
        }
      }
    }
    if (!descriptor || descriptor.workspaceId !== selector.workspaceId) {
      throw selectionError('The selected workspace does not belong to this project or session');
    }
    if (descriptor.generation !== selector.generation) {
      throw selectionError('The workspace generation changed; resolve it again before continuing', 'WORKSPACE_GENERATION_CHANGED');
    }
    dependencies.assertWorkspaceDescriptor(descriptor);
    return descriptor;
  }

  return { resolve, resolveSelectedWorkspace };
}
