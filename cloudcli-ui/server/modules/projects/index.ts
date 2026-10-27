export {
  generateDisplayName,
  getProjectsWithSessions,
} from './services/projects-with-sessions-fetch.service.js';
export { updateProjectDisplayName } from './services/project-management.service.js';
// Server composition and isolated authorization integration tests mount the project HTTP gateway.
export { default as projectsRoutes } from './projects.routes.js';
// projectSettingsService: project routes expose explicit defaults a new session inherits.
export { projectSettingsService } from './services/project-settings.service.js';
export type { ProjectDefaultSettings, ProjectSettingsView } from './services/project-settings.service.js';
// projectContextService: project routes expose the effective context-source policy for the read-only panel.
export { projectContextService } from './services/project-context.service.js';
export type { ProjectContextView } from './services/project-context.service.js';
// projectActionsService/projectActionExecution: workspace routes expose saved run/test/build commands.
export { projectActionsService } from './services/project-actions.service.js';
export { executeProjectAction } from './services/project-action-execution.service.js';
export type { ProjectActionRunResult } from './services/project-action-execution.service.js';
// createProject: used by the worktrees module to register a worktree directory as a switchable project.
export { createProject } from './services/project-management.service.js';
// Project creation and Workspaces probes reuse verified owner-local Windows roots without replacing their project history or target identity.
export { createSshProject, probeSshProjectDirectory } from './services/ssh-project-management.service.js';
// deleteOrArchiveProject: used by Projects routes and Worktrees cleanup to hide or permanently remove a project.
export { deleteOrArchiveProject, deleteSessionJsonlFilesForProjectPath } from './services/project-delete.service.js';
// restoreArchivedProject: used by the worktrees module to re-activate an archived project when its worktree is reopened.
export { restoreArchivedProject } from './services/project-delete.service.js';
