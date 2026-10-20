import path from 'node:path';

import { parseGitStatusOutput } from './git-parsing.service.js';

type GitReadContext = {
  repositoryRootPath: string;
  runCommand(command: 'git', args: string[], options: { cwd: string }): Promise<{ stdout: string }>;
};

function normalizeRepositoryRelativeFilePath(filePath: string): string {
  // Whitespace is part of the literal filename returned by NUL porcelain status.
  return String(filePath)
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '');
}

function parseStatusFilePaths(statusOutput: string): string[] {
  const { modified, added, deleted, untracked } = parseGitStatusOutput(statusOutput);
  return [...modified, ...added, ...deleted, ...untracked].map(normalizeRepositoryRelativeFilePath);
}

/** Git routes use the index or HEAD blob to display a deleted file without reading its missing worktree path. */
export async function getDeletedFileContent(input: GitReadContext & {
  repositoryRelativeFilePath: string;
  statusOutput: string;
}): Promise<{ currentContent: string; oldContent: string }> {
  // An added-then-deleted file has only an index blob, including before the first commit.
  const isStagedAddition = input.statusOutput[0] === 'A';
  const { stdout: content } = await input.runCommand(
    'git',
    ['show', `${isStagedAddition ? '' : 'HEAD'}:${input.repositoryRelativeFilePath}`],
    { cwd: input.repositoryRootPath },
  );
  return { currentContent: content, oldContent: isStagedAddition ? '' : content };
}

function buildFilePathCandidates(projectPath: string, repositoryRootPath: string, filePath: string): string[] {
  const normalizedFilePath = normalizeRepositoryRelativeFilePath(filePath);
  const projectRelativePath = normalizeRepositoryRelativeFilePath(path.relative(repositoryRootPath, projectPath));
  const candidates = [normalizedFilePath];

  if (
    projectRelativePath
    && projectRelativePath !== '.'
    && !normalizedFilePath.startsWith(`${projectRelativePath}/`)
  ) {
    candidates.push(`${projectRelativePath}/${normalizedFilePath}`);
  }

  return Array.from(new Set(candidates.filter(Boolean)));
}

/**
 * Git routes pass a validated literal path and resolved repository root to locate
 * changed files, including nested-project paths and unique bare-filename matches.
 */
export async function resolveRepositoryFilePath(input: GitReadContext & {
  projectPath: string;
  filePath: string;
}): Promise<{ repositoryRootPath: string; repositoryRelativeFilePath: string }> {
  const { projectPath, repositoryRootPath, filePath, runCommand } = input;
  const candidateFilePaths = buildFilePathCandidates(projectPath, repositoryRootPath, filePath);

  for (const candidateFilePath of candidateFilePaths) {
    const { stdout } = await runCommand('git', ['status', '--porcelain=v1', '-z', '--', candidateFilePath], { cwd: repositoryRootPath });
    if (stdout.trim()) {
      return {
        repositoryRootPath,
        repositoryRelativeFilePath: candidateFilePath,
      };
    }
  }

  // If the caller sent a bare filename (e.g. "hello.ts"), recover it from changed files.
  const normalizedFilePath = normalizeRepositoryRelativeFilePath(filePath);
  if (!normalizedFilePath.includes('/')) {
    const { stdout: repositoryStatusOutput } = await runCommand('git', ['status', '--porcelain=v1', '-z'], { cwd: repositoryRootPath });
    const changedFilePaths = parseStatusFilePaths(repositoryStatusOutput);
    const suffixMatches = changedFilePaths.filter(
      (changedFilePath) => changedFilePath === normalizedFilePath || changedFilePath.endsWith(`/${normalizedFilePath}`),
    );

    if (suffixMatches.length === 1) {
      return {
        repositoryRootPath,
        repositoryRelativeFilePath: suffixMatches[0],
      };
    }
  }

  return {
    repositoryRootPath,
    repositoryRelativeFilePath: candidateFilePaths[0],
  };
}
