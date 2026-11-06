import { api, readApiJson } from '@/shared/api';
import { getAuthSessionVersion } from '@/shared/authToken';
import { getServerConnectionVersion } from '@/shared/chisa';
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
  options?: { signal?: AbortSignal; onStage?: (stage: string) => void },
): Promise<ExecutionSelector | undefined> {
  options?.signal?.throwIfAborted();
  if (captured === undefined) return undefined;
  if (!captured || captured.projectId !== projectId) throw new Error('工作区暂不可用，请刷新后重试');
  const authVersion = getAuthSessionVersion();
  const serverVersion = getServerConnectionVersion();
  const assertCurrent = () => {
    options?.signal?.throwIfAborted();
    if (authVersion !== getAuthSessionVersion() || serverVersion !== getServerConnectionVersion()) {
      throw new Error('工作区连接已变化，草稿已保留，请刷新后确认发送');
    }
  };
  const resolve = async () => {
    options?.onStage?.('正在确认工作区…');
    const response = await (options?.signal
      ? api.workspaces.resolve(projectId, sessionId, { signal: options.signal })
      : api.workspaces.resolve(projectId, sessionId));
    assertCurrent();
    const resolution = await readApiJson<WorkspaceResolution>(response);
    assertCurrent();
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
    if ((captured.sourceMode === 'ssh' || workspace.sourceMode === 'ssh') && captured.sourceMode !== workspace.sourceMode) {
      throw new Error('工作区已变化，草稿已保留，请刷新后确认发送');
    }
    return workspace;
  };
  let workspace = await resolve();
  if (workspace.sourceMode === 'ssh' && (workspace.phase === 'recovery' || workspace.connectionState === 'recovery')) {
    const original = workspace;
    // This only confirms the original operation; cancellation always requires an explicit user action.
    options?.onStage?.('正在确认上次本地任务…');
    const recovery = { projectId, generation: original.generation };
    const response = await (options?.signal
      ? api.sshWorkspaces.recover(recovery, { signal: options.signal })
      : api.sshWorkspaces.recover(recovery));
    assertCurrent();
    const result = await readApiJson<{ status: 'idle' | 'running' }>(response);
    assertCurrent();
    if (result.status === 'running') throw new Error('原本地任务仍在运行，请等待任务结束后重试，草稿已保留');
    if (result.status !== 'idle') throw new Error('无法确认上次本地任务状态，请检查本地工作区，草稿已保留');
    workspace = await resolve();
    if (workspace.workspaceId !== original.workspaceId || workspace.generation !== original.generation || workspace.kind !== original.kind) {
      throw new Error('工作区已变化，草稿已保留，请刷新后确认发送');
    }
  }
  if (workspace.sourceMode === 'ssh') {
    if (workspace.phase === 'recovery' || workspace.connectionState === 'recovery') throw new Error('本地工作区仍需确认上次操作结果，请检查原任务后重试，草稿已保留');
    if (workspace.connectionState === 'offline') throw new Error('本地工作区连接已断开，请恢复桌面连接后重试，草稿已保留');
    // A normal inspection can temporarily revoke writes; the backend owns FIFO admission for that case.
    if (workspace.phase !== 'running' && !workspace.capabilities.write) throw new Error('本地工作区暂不可写，请刷新工作区状态后重试，草稿已保留');
  } else if (workspace.phase === 'recovery') throw new Error('工作区需要恢复，请先完成集成恢复');
  return { projectId: workspace.projectId, workspaceId: workspace.workspaceId, generation: workspace.generation };
}
