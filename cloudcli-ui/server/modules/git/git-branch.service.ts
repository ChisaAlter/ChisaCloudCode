import path from 'node:path';

import { AppError } from '@/shared/index.js';
import type { WorkspaceGitFileSystem } from '@/shared/index.js';
import { runWorkspaceGitBranchOperation, withWorkspaceWriteOperation } from '@/modules/workspace-bridge/index.js';

type GitCommandResult = {
  stdout: string;
  stderr: string;
};

type GitCommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string },
) => Promise<GitCommandResult>;

type DeleteLocalBranchInput = {
  projectPath: string;
  branch: string;
  force: boolean;
  runCommand: GitCommandRunner;
};

/** Git routes use the owner's branch protocol or one local reservation through all checks and writes. */
export async function changeGitBranch(input: {
  projectPath: string;
  action: 'checkout' | 'create' | 'delete';
  branch: string;
  force?: boolean;
  runCommand: GitCommandRunner;
  fileSystem: WorkspaceGitFileSystem;
  validateRepository(projectPath: string): Promise<void>;
}): Promise<string> {
  const native = await runWorkspaceGitBranchOperation(input.projectPath, input.action, input.branch, input.force);
  if (native) return native.stdout ?? '';
  return withWorkspaceWriteOperation(input.projectPath, async () => {
    await input.validateRepository(input.projectPath);
    if (input.action === 'delete') return deleteLocalBranch({ ...input, force: input.force === true });
    const options = { cwd: input.projectPath };
    const { stdout } = await input.runCommand('git', ['ls-files', '--unmerged'], options);
    if (stdout.trim()) throw new AppError('Resolve the current Git conflicts before switching or creating a branch', { code: 'GIT_OPERATION_IN_PROGRESS', statusCode: 409 });
    for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer']) {
      const { stdout: markerPath } = await input.runCommand('git', ['rev-parse', '--git-path', marker], options);
      try { await input.fileSystem.access(path.resolve(input.projectPath, markerPath.trim())); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      throw new AppError('Finish or abort the current Git operation before switching or creating a branch', { code: 'GIT_OPERATION_IN_PROGRESS', statusCode: 409 });
    }
    const result = await input.runCommand('git', input.action === 'create' ? ['switch', '-c', input.branch] : ['switch', '--', input.branch], options);
    return result.stdout;
  });
}

/** Used by the Git routes module to safely delete a non-current local branch. */
export async function deleteLocalBranch(input: DeleteLocalBranchInput): Promise<string> {
  const { stdout: currentBranch } = await input.runCommand(
    'git',
    ['branch', '--show-current'],
    { cwd: input.projectPath },
  );

  if (currentBranch.trim() === input.branch) {
    throw new AppError('Cannot delete the currently checked-out branch', {
      code: 'GIT_CURRENT_BRANCH_DELETE',
      statusCode: 400,
    });
  }

  const deleteFlag = input.force ? '-D' : '-d';
  const { stdout } = await input.runCommand(
    'git',
    ['branch', deleteFlag, '--', input.branch],
    { cwd: input.projectPath },
  );
  return stdout;
}
