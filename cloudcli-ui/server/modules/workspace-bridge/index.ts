// Used by the Claude runtime and filesystem/Git composition roots to route
// workspace operations through the authenticated project capability.
export { isWorkspaceBound, describeWorkspaceSelection, assertWorkspaceDescriptor, integrateWorkspaceSession, admitWorkspaceExecution, workspaceQuery, bridgeFileSystem, bridgeGitFileSystem, runWorkspaceCommand, runWorkspaceGitBranchOperation, withWorkspaceGitReadOperation, withWorkspaceWriteOperation, workspaceRequestScope, workspaceRequestSignal } from './workspace-bridge.service.js';

// Managed account transport shares the bridge sandbox and lease lifecycle.
export { executeSyncTransportWorker, prepareSyncTransportPreview, isActiveWorkspaceLease } from './workspace-bridge.service.js';

// Runtime startup uses its private preview witness to recover only a confirmed stopped container.
export { recoverStoppedWorkspacePreview } from './workspace-preview-recovery.service.js';

// Project/catalog/transport routes authorize saved SSH targets without exposing credentials.
export { assertSshProjectOwner, resolveSshProjectTarget, recoverSshWorkspace, runSshWorkspaceCommand } from './ssh-workspace-execution.service.js';
