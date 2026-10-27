import path from 'node:path';

import { userDb } from '@/modules/database/index.js';
import { assertSshProjectOwner, resolveSshProjectTarget } from '@/modules/workspace-bridge/index.js';
import { assertCloudWorkspaceOwner } from '@/modules/workspace-runtime/index.js';
import { AppError, normalizeProjectPath } from '@/shared/index.js';

type AgentProjectTargetInput = {
  projectPath: unknown;
  provider: string;
  userId: string | number | null | undefined;
  cloneRepository: boolean;
  manageGit: boolean;
};

/** Agent HTTP routes authorize saved SSH anchors before credentials, cloning, filesystem access or project registration. */
export function resolveAgentProjectTarget(input: AgentProjectTargetInput): { projectPath: string; sourceMode: 'cloud' | 'ssh' } {
  if (typeof input.projectPath !== 'string' || !input.projectPath.trim()) {
    throw new AppError('projectPath must be a non-empty string', { code: 'INVALID_PROJECT_PATH', statusCode: 400 });
  }
  const projectPath = normalizeProjectPath(path.resolve(input.projectPath.trim()));
  const target = resolveSshProjectTarget(projectPath);
  if (!target) {
    assertCloudWorkspaceOwner(projectPath, input.userId, userDb.getActiveUserIds());
    return { projectPath, sourceMode: 'cloud' };
  }

  assertSshProjectOwner(target, input.userId);
  if (input.provider !== 'claude') {
    throw new AppError('SSH 本地项目目前仅支持 VPS Claude Code。', { code: 'WORKSPACE_PROVIDER_UNSUPPORTED', statusCode: 409 });
  }
  // The anchor contains VPS metadata only. Local clone/Git flows must never use
  // it as a checkout, even when the requester owns the remote Windows project.
  if (input.cloneRepository || input.manageGit) {
    throw new AppError('SSH 项目不支持外部 Agent 的本地克隆或 GitHub 分支/PR 操作。', { code: 'SSH_WORKSPACE_UNSUPPORTED', statusCode: 409 });
  }
  return { projectPath: target.anchorPath, sourceMode: 'ssh' };
}
