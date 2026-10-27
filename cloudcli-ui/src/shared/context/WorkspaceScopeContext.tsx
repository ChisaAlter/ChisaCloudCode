import { createContext, useContext, useMemo } from 'react';

import { api, createWorkspaceApi } from '@/shared/api';
import type { CodeEditorFile, WorkspaceDescriptor } from '@/shared/types';

/** Undefined supports callers outside the workspace UI; null is a known unavailable session. */
export const WorkspaceScopeContext = createContext<WorkspaceDescriptor | null | undefined>(undefined);

/** New chat turns can start from the replica before an isolated session exists; file access remains session-only. */
export const WorkspaceExecutionContext = createContext<WorkspaceDescriptor | null | undefined>(undefined);

export function useWorkspaceExecutionScope() {
  return useContext(WorkspaceExecutionContext);
}

export function useWorkspaceScope() {
  return useContext(WorkspaceScopeContext);
}

function useScopedApi(workspace: WorkspaceDescriptor | null | undefined, gitOnly = false) {
  const availability = workspace === undefined ? 'legacy' : workspace === null ? 'unavailable' : 'scoped';
  const projectId = workspace?.projectId;
  const workspaceId = workspace?.workspaceId;
  const generation = workspace?.generation;
  const kind = workspace?.kind;
  const sessionId = workspace?.sessionId;
  const sourceMode = workspace?.sourceMode;
  const read = !gitOnly && (workspace?.capabilities.read ?? false);
  const write = !gitOnly && (workspace?.capabilities.write ?? false);
  const git = workspace?.capabilities.git ?? false;

  // Polling may change status/path metadata; only request identity or guards replace the captured API.
  return useMemo(() => availability === 'legacy' ? api : createWorkspaceApi(availability === 'unavailable' ? null : {
    projectId: projectId!, workspaceId: workspaceId!, generation: generation!, kind: kind!, sessionId, sourceMode,
    capabilities: { read, write, git },
  }), [availability, projectId, workspaceId, generation, kind, sessionId, sourceMode, read, write, git]);
}

/** Each API captures an immutable identity and permissions; status-only polls preserve pending requests. */
export function useWorkspaceApi() {
  return useScopedApi(useWorkspaceScope());
}

/** Git observers and panels retain their own requests when a running task changes file-write permissions. */
export function useWorkspaceGitApi() {
  // Only the Git namespace escapes this snapshot; file capabilities must never be reused for writes.
  return useScopedApi(useWorkspaceScope(), true).git;
}

/** An editor document retains its opening scope even while the surrounding workspace selection changes. */
export function useEditorWorkspaceApi(file: CodeEditorFile) {
  return useScopedApi(file.workspace);
}

/** Editor saves refresh permissions only for the exact opening identity, without reloading its text or CAS hash. */
export function useEditorWorkspaceSaveFile(file: CodeEditorFile) {
  const current = useWorkspaceScope();
  const pinned = file.workspace;
  const matches = current && pinned && current.projectId === pinned.projectId && current.kind === pinned.kind
    && current.sessionId === pinned.sessionId && current.workspaceId === pinned.workspaceId
    && current.generation === pinned.generation && current.sourceMode === pinned.sourceMode;
  // An editor may belong to a session while the main view selects its replica; keep its original scope.
  return useScopedApi(matches ? current : pinned).saveFile;
}
