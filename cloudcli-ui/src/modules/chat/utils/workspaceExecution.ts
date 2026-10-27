import { api, readApiJson } from '@/shared/api';
import type { WorkspaceDescriptor, WorkspaceResolution, WorkspaceSelector } from '@/shared/types';

type ExecutionSelector = WorkspaceSelector & { projectId: string };

/** A durable queued turn keeps its original identity, including after reload or generation replacement. */
export function assertQueuedExecutionWorkspace(saved: unknown, current: ExecutionSelector | undefined) {
  if (!current) return;
  const snapshot = saved as Partial<ExecutionSelector> | null;
  if (!snapshot || snapshot.projectId !== current.projectId || snapshot.workspaceId !== current.workspaceId || snapshot.generation !== current.generation) {
    throw new Error('排队消息的工作区已变化，请保留内容并确认后重新排队');
  }
}

/** Recheck immediately before dispatch; a replica may become this session's first isolated workspace. */
export async function resolveExecutionWorkspace(
  captured: WorkspaceDescriptor | null | undefined,
  projectId: string,
  sessionId?: string,
): Promise<ExecutionSelector | undefined> {
  if (captured === undefined) return undefined;
  if (!captured || captured.projectId !== projectId) throw new Error('工作区暂不可用，请刷新后重试');
  const resolution = await readApiJson<WorkspaceResolution>(await api.workspaces.resolve(projectId, sessionId));
  const workspace = sessionId ? resolution.session ?? resolution.cloudReplica : resolution.cloudReplica;
  if (!workspace || workspace.projectId !== projectId || !workspace.workspaceId || !workspace.generation
    || !['session', 'cloudReplica'].includes(workspace.kind)
    || (workspace.kind === 'session' && workspace.sessionId !== sessionId)) {
    throw new Error('工作区身份无效，请刷新后重试');
  }
  if (captured.kind === 'session' || workspace.kind === 'cloudReplica') {
    if (captured.workspaceId !== workspace.workspaceId || captured.generation !== workspace.generation) {
      throw new Error('工作区已变化，草稿已保留，请刷新后确认发送');
    }
  } else if (workspace.sourceRoot !== captured.rootPath || resolution.cloudReplica?.workspaceId !== captured.workspaceId
    || resolution.cloudReplica?.generation !== captured.generation) {
    throw new Error('会话来源已变化，草稿已保留，请刷新后确认发送');
  }
  if (workspace.phase === 'recovery') throw new Error('工作区需要恢复，请先完成集成恢复');
  return { projectId: workspace.projectId, workspaceId: workspace.workspaceId, generation: workspace.generation };
}
