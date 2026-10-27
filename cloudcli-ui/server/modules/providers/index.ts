export { sessionSynchronizerService } from './services/session-synchronizer.service.js';
export { providerSkillsService } from './services/skills.service.js';
export { providerMcpService } from './services/mcp.service.js';
export { providerRuntimeService } from './services/provider-runtime.service.js';

// providerModelsService: used by Commands to list models and resolve the active session model.
export { providerModelsService } from './services/provider-models.service.js';

// sessionsService: used by the websocket module's chat gateway to resolve an
// edited message's resume point, which only the providers module can read.
export { sessionsService } from './services/sessions.service.js';
// Chat and scheduling validate persisted project ownership before reading or running a session.
export { assertSshSessionAccess, canReadSshSession } from './services/ssh-session-access.service.js';

export { initializeSessionsWatcher } from './services/sessions-watcher.service.js';
export { closeSessionsWatcher } from './services/sessions-watcher.service.js';
// The bundled usage plugin reads only the requesting user's execution-host scope.
export { resolveClaudeUsagePluginScope } from './services/claude-usage-plugin-scope.service.js';
// Server shutdown cancels pending CLI sign-ins before the process exits.
export { closeClaudeAccountLogins } from './services/claude-usage-plugin-scope.service.js';
