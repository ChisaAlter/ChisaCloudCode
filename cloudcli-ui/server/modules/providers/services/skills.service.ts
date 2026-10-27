import path from 'node:path';
import { realpathSync } from 'node:fs';

import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { assertWorkspaceDescriptor, isWorkspaceBound } from '@/modules/workspace-bridge/index.js';
import { resolveSelectedWorkspace } from '@/modules/workspaces/index.js';
import { AppError } from '@/shared/index.js';
import type { ProviderSkill, ProviderSkillCreateInput, ProviderSkillRemoveInput, WorkspaceDescriptor } from '@/shared/index.js';

import { currentClaudeProjectConfigScope, withClaudeProjectConfigScope } from './claude-project-config-scope.service.js';

type SkillsContext = {
  userId?: unknown;
  workspacePath?: string;
  projectId?: string;
  workspaceId?: string;
  generation?: string;
  sessionId?: string;
};

function resolveContext(context: SkillsContext): WorkspaceDescriptor | undefined {
  const hasSelector = ['projectId', 'workspaceId', 'generation', 'sessionId'].some(key => Object.hasOwn(context, key));
  if (!hasSelector) {
    if (context.workspacePath) {
      const candidate = path.resolve(context.workspacePath);
      let canonical = candidate;
      try { canonical = realpathSync(candidate); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (isWorkspaceBound(candidate) || isWorkspaceBound(canonical)) {
        throw new AppError('Bound workspace skills require projectId, workspaceId and generation.', { code: 'WORKSPACE_SELECTOR_REQUIRED', statusCode: 400 });
      }
    }
    return undefined;
  }
  if (!context.projectId || !context.workspaceId || !context.generation) {
    throw new AppError('Skills require a complete projectId, workspaceId and generation selector.', { code: 'INVALID_WORKSPACE_SELECTOR', statusCode: 400 });
  }
  return resolveSelectedWorkspace(context.projectId, {
    workspaceId: context.workspaceId,
    generation: context.generation,
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
  });
}

/** Provider routes resolve client selectors here before provider skill discovery. */
export const providerSkillsService = {
  /**
   * Lists normalized skills visible to one provider.
   */
  async listProviderSkills(
    providerName: string,
    options: SkillsContext = {},
  ): Promise<ProviderSkill[]> {
    const provider = providerRegistry.resolveProvider(providerName);
    // Copy the primitive selector once; no request object can retarget an await.
    const context = { ...options };
    if (providerName === 'claude' && context.userId !== undefined && !currentClaudeProjectConfigScope()) {
      return withClaudeProjectConfigScope(context, () => this.listProviderSkills(providerName, { ...context, userId: undefined }));
    }
    const descriptor = currentClaudeProjectConfigScope()?.descriptor ?? resolveContext(context);
    const assertCurrent = () => {
      currentClaudeProjectConfigScope()?.assertCurrent();
      const current = currentClaudeProjectConfigScope()?.descriptor ?? resolveContext(context);
      if (!descriptor) return;
      if (!current || current.workspaceId !== descriptor.workspaceId || current.generation !== descriptor.generation
        || current.projectId !== descriptor.projectId || current.rootPath !== descriptor.rootPath
        || current.sourceRoot !== descriptor.sourceRoot || current.sessionId !== descriptor.sessionId
        || current.kind !== descriptor.kind || current.effectiveMode !== descriptor.effectiveMode) {
        throw new AppError('Workspace changed while listing skills.', { code: 'WORKSPACE_SELECTION_MISMATCH', statusCode: 409 });
      }
      if (!current.capabilities.read) throw new AppError('This workspace cannot be read.', { code: 'WORKSPACE_READ_DENIED', statusCode: 403 });
      assertWorkspaceDescriptor(descriptor);
    };
    assertCurrent();
    try {
      return await provider.skills.listSkills({
        workspacePath: descriptor?.rootPath ?? context.workspacePath,
        workspaceDescriptor: descriptor,
        assertWorkspace: assertCurrent,
        globalOnly: !descriptor && !context.workspacePath,
      });
    } finally {
      assertCurrent();
    }
  },

  /**
   * Writes one or more global skills for one provider.
   */
  async addProviderSkills(
    providerName: string,
    input: ProviderSkillCreateInput,
    context: { userId?: unknown } = {},
  ): Promise<ProviderSkill[]> {
    const provider = providerRegistry.resolveProvider(providerName);
    if (providerName === 'claude') return withClaudeProjectConfigScope(context, () => provider.skills.addSkills(input));
    return provider.skills.addSkills(input);
  },

  async removeProviderSkill(
    providerName: string,
    input: ProviderSkillRemoveInput,
    context: { userId?: unknown } = {},
  ): Promise<{ removed: boolean; provider: string; directoryName: string }> {
    const provider = providerRegistry.resolveProvider(providerName);
    if (providerName === 'claude') return withClaudeProjectConfigScope(context, () => provider.skills.removeSkill(input));
    return provider.skills.removeSkill(input);
  },
};
