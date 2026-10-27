import { AppError } from '@/shared/index.js';
import type { WorktreeServices } from '@/shared/index.js';

/** Worktrees production composition protects bridge-owned session roots before ordinary project/worktree management. */
export function createWorktreeManagementServices(
  services: WorktreeServices,
  hasSessionMarker: (rootPath: string) => Promise<boolean>,
): WorktreeServices {
  async function assertPublicRoot(rootPath: string): Promise<void> {
    if (await hasSessionMarker(rootPath)) {
      throw new AppError('This worktree belongs to an AI session; manage it through its workspace', {
        code: 'WORKSPACE_PRIVATE_SESSION', statusCode: 409,
      });
    }
  }

  return {
    resolveProjectPath: services.resolveProjectPath,
    async list(input) {
      await assertPublicRoot(input.projectPath);
      const result = await services.list(input);
      await assertPublicRoot(result.repositoryRoot);
      const visibility = await Promise.all(result.worktrees.map(async worktree => !(await hasSessionMarker(worktree.path))));
      return { ...result, worktrees: result.worktrees.filter((_worktree, index) => visibility[index]) };
    },
    async create(input) {
      await assertPublicRoot(input.projectPath);
      return services.create(input);
    },
    async createAndOpen(input) {
      await assertPublicRoot(input.projectPath);
      return services.createAndOpen(input);
    },
    async open(input) {
      await assertPublicRoot(input.projectPath);
      await assertPublicRoot(input.worktreePath);
      return services.open(input);
    },
    async merge(input) {
      await assertPublicRoot(input.projectPath);
      await assertPublicRoot(input.worktreePath);
      return services.merge(input);
    },
    async remove(input) {
      await assertPublicRoot(input.projectPath);
      await assertPublicRoot(input.worktreePath);
      return services.remove(input);
    },
  };
}
