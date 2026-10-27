export { initializeDatabase } from '@/modules/database/init-db.js';
export { closeConnection, getConnection, getDatabasePath } from '@/modules/database/connection.js';
export { apiKeysDb } from '@/modules/database/repositories/api-keys.js';
export { appConfigDb } from '@/modules/database/repositories/app-config.js';
export { credentialsDb } from '@/modules/database/repositories/credentials.js';
// Providers persists private per-user Messages endpoints and HiRoute connections.
export { claudeConnectionsDb } from '@/modules/database/repositories/claude-connections.db.js';
// Providers owns profile-backed subscription metadata and per-user selections.
export { claudeAccountsDb } from '@/modules/database/repositories/claude-accounts.db.js';
export { hirouteDb } from '@/modules/database/repositories/hiroute.db.js';
export { githubTokensDb } from '@/modules/database/repositories/github-tokens.js';
export { notificationChannelEndpointsDb } from '@/modules/database/repositories/notification-channel-endpoints.js';
export { notificationPreferencesDb } from '@/modules/database/repositories/notification-preferences.js';
// providerModelsDb: used by Providers to persist user-managed custom model rows.
export { providerModelsDb } from '@/modules/database/repositories/provider-models.js';
// agentWorkspaceConnectionsDb: SSH-local agent mode stores account-scoped loopback endpoints.
export { agentWorkspaceConnectionsDb } from '@/modules/database/repositories/agent-workspace-connections.db.js';
export type { AgentWorkspaceConnectionRow } from '@/modules/database/repositories/agent-workspace-connections.db.js';
// projectActionsDb: Projects persists explicit run/test/build commands.
export { projectActionsDb } from '@/modules/database/repositories/project-actions.db.js';
export type { ProjectActionInput, ProjectActionKind, ProjectActionRow } from '@/modules/database/repositories/project-actions.db.js';
// projectSettingsDb: Projects persists explicit defaults a new session inherits.
export { projectSettingsDb } from '@/modules/database/repositories/project-settings.db.js';
export type { ProjectSettingsPatch, ProjectSettingsRow } from '@/modules/database/repositories/project-settings.db.js';
// projectsDb: used by Projects, Worktrees, Git, WebSocket, and notification modules to persist and resolve project records.
export { projectsDb } from '@/modules/database/repositories/projects.db.js';
// sshProjectTargetsDb: Projects, Workspaces and Providers persist verified local targets, session pins and writer ownership.
export { sshProjectTargetsDb } from '@/modules/database/repositories/ssh-project-targets.db.js';
export { pushSubscriptionsDb } from '@/modules/database/repositories/push-subscriptions.js';
export { scanStateDb } from '@/modules/database/repositories/scan-state.db.js';
// sessionDraftsDb: used by User for drafts, Scheduled Messages for queued turns, and WebSocket for terminal queue suspension.
export { sessionDraftsDb } from '@/modules/database/repositories/session-drafts.db.js';
export type {
  QueuedSessionMessageRecord,
  SessionDraftRecord,
} from '@/modules/database/repositories/session-drafts.db.js';
export { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
export { userDb } from '@/modules/database/repositories/users.js';
// userPreferencesDb: used by the User module to persist the settings that used to live in browser localStorage.
export { userPreferencesDb } from '@/modules/database/repositories/user-preferences.db.js';
export { vapidKeysDb } from '@/modules/database/repositories/vapid-keys.js';
export { scheduledMessagesDb } from './repositories/scheduled-messages.db.js';
export type { ScheduledMessageRow, ScheduledMessageStatus } from './repositories/scheduled-messages.db.js';
