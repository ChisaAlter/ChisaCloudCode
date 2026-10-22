// Used by the Claude runtime and filesystem/Git composition roots to route
// workspace operations through the authenticated project capability.
export { admitWorkspaceExecution, workspaceQuery, bridgeFileSystem, bridgeGitFileSystem, runWorkspaceCommand, runWorkspaceGitBranchOperation, withWorkspaceGitReadOperation, withWorkspaceWriteOperation, withWorkspaceMutation, workspaceRequestScope, workspaceRequestSignal, isActiveWorkspaceLease, isWorkspaceBindingRoot } from './workspace-bridge.service.js';
// Account sync transport reuses the same isolated execution environment as other workspace operations.
export { executeSyncTransportWorker, prepareSyncTransportPreview } from './workspace-bridge.service.js';
