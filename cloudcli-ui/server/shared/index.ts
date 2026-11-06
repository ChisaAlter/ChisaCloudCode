export { appendFilesInputTag, appendImagesInputTag, buildClaudeUserContent, buildCodexInputItems, getGlobalImageAssetsDir, isImageAttachmentDescriptor, normalizeAttachmentDescriptors, normalizeImageDescriptors } from './image-attachments.js';
export type { ChatAttachmentDescriptor } from './image-attachments.js';
export { AppError, IS_PLATFORM, WORKSPACES_ROOT, parseIncomingJsonObject, normalizeProjectPath, createCompleteMessage, createNormalizedMessage, validateWorkspacePath, flattenPromptForWindowsShell, getOpenCodeDatabasePath, findApplicationRoot, getModuleDirectory, stripAnsiSequences, resolveReadOnlyRootPath, getGitErrorDetails } from './utils.js';
export { parseFrontMatter } from './frontmatter.js';
export type { SshWorkspaceConnection, SshWorkspaceRpcResult, SshWorkspaceProbeResult, SshProjectTarget, SshSessionTarget, AnyRecord, AuthenticatedWebSocketRequest, AuthenticatedWebSocketUser, FileTreeFileSystem, FileTreeWorkspaceGateway, GitProcessRunner, WorkspaceGitFileSystem, ProviderRuntimeContext, ProviderRuntimeWriter, ProviderProcessRunner, SessionWorkspaceMode, WorkspaceDescriptor, WorkspaceSelector, WorkspaceResolution, WorkspaceRuntimePreviewReservation, ProviderProcessJob, ProviderProcessEvent, ProviderModelsDefinition, ProviderPermissionDecision, ProviderRunFunction, LLMProvider, WorktreeFileSystem, WorktreeProjectGateway, WorktreeServices } from './types.js';
export type { IProvider, IProviderRuntime } from './interfaces.js';
// Auth and transport gateways share the verified persistent login-session proof.
export type { QueuedChatMessage, UserPreferenceSnapshot, UserPreferenceTransaction, UserPreferenceTransactionResult, AuthSessionContext, AuthenticatedHttpRequest, VerifiedImageAttachment, PreparedImageAttachment } from './types.js';
// Independent workspace broker, its restricted daemon adapter and trusted launcher share the semantic protocol.
export type { ProviderTrustedSlot, WorkspaceBrokerConfiguration, WorkspaceBrokerLeaseReceipt, WorkspaceBrokerEngine, WorkspaceBrokerRunRequest, WorkspaceBrokerExecRequest } from './types.js';

// Provider skill discovery shares these transport-neutral records and markdown readers.
export type { ProviderSkill, ProviderSkillCreateInput, ProviderSkillCreateFile, ProviderSkillListOptions, ProviderSkillRemoveInput, ProviderSkillSource, CustomProviderModelInput, CustomProviderModelEffort, McpScope, McpTransport, UpsertProviderMcpServerInput } from './types.js';
export type { IProviderSkills } from './interfaces.js';
export { findProviderSkillMarkdownFiles, readOptionalString, readProviderSkillMarkdownDefinitionFromContent, readProviderSkillMarkdownDefinition, asyncHandler, createApiSuccessResponse } from './utils.js';

// Project runtime provenance and private launch identity are shared by Providers, bridge and Projects.
export type { ProjectRuntimeManifest, ProjectRuntimeLaunchContext } from './types.js';

// Runtime version observation shared by Claude provider consumers.
export { extractClaudeResolvedModel } from '@/shared/utils.js';

// Account transport addresses, isolated networks and recovery admission shared by sync and bridge.
export { registerWorkspaceRuntimeNetwork, registerWorkspaceSyncControlHost, isWorkspaceSyncControlHost, registerWorkspaceSyncNetwork, getWorkspaceSyncNetwork, registerWorkspaceSyncRecoveryTransport, isWorkspaceSyncRecoveryOnly } from './utils.js';
