export { appendFilesInputTag, appendImagesInputTag, buildCodexInputItems, getGlobalImageAssetsDir, isImageAttachmentDescriptor, normalizeAttachmentDescriptors, normalizeImageDescriptors } from './image-attachments.js';
export type { ChatAttachmentDescriptor } from './image-attachments.js';
export { AppError, WORKSPACES_ROOT, parseIncomingJsonObject, normalizeProjectPath, createCompleteMessage, createNormalizedMessage, validateWorkspacePath, flattenPromptForWindowsShell, getOpenCodeDatabasePath, findApplicationRoot, getModuleDirectory } from './utils.js';
export { parseFrontMatter } from './frontmatter.js';
export type { SshWorkspaceConnection, SshWorkspaceRpcResult, SshWorkspaceProbeResult, SshProjectTarget, SshSessionTarget, AnyRecord, AuthenticatedWebSocketRequest, FileTreeFileSystem, WorkspaceGitFileSystem, ProviderRuntimeContext, ProviderRuntimeWriter, ProviderProcessRunner, SessionWorkspaceMode, WorkspaceDescriptor, WorkspaceSelector, WorkspaceResolution, WorkspaceRuntimePreviewReservation, ProviderProcessJob, ProviderProcessEvent, ProviderModelsDefinition, ProviderPermissionDecision, ProviderRunFunction, LLMProvider, WorktreeFileSystem, WorktreeProjectGateway, WorktreeServices } from './types.js';
export type { IProvider, IProviderRuntime } from './interfaces.js';

// Provider skill discovery shares these transport-neutral records and markdown readers.
export type { ProviderSkill, ProviderSkillCreateInput, ProviderSkillCreateFile, ProviderSkillListOptions, ProviderSkillRemoveInput, ProviderSkillSource, CustomProviderModelInput, McpScope, McpTransport, UpsertProviderMcpServerInput } from './types.js';
export type { IProviderSkills } from './interfaces.js';
export { findProviderSkillMarkdownFiles, readOptionalString, readProviderSkillMarkdownDefinitionFromContent, readProviderSkillMarkdownDefinition, asyncHandler, createApiSuccessResponse } from './utils.js';

// Project runtime provenance and private launch identity are shared by Providers, bridge and Projects.
export type { ProjectRuntimeManifest, ProjectRuntimeLaunchContext } from './types.js';

// Runtime version observation shared by Claude provider consumers.
export { extractClaudeResolvedModel } from '@/shared/utils.js';

// Account transport addresses, isolated networks and recovery admission shared by sync and bridge.
export { registerWorkspaceRuntimeNetwork, registerWorkspaceSyncControlHost, isWorkspaceSyncControlHost, registerWorkspaceSyncNetwork, getWorkspaceSyncNetwork, registerWorkspaceSyncRecoveryTransport, isWorkspaceSyncRecoveryOnly } from './utils.js';
