// @ts-nocheck -- temporary while Git workflows are extracted into the injected service.
import path from 'path';

import express from 'express';

import type { ProviderRunFunction, WorkspaceGitFileSystem } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';
import { runWorkspaceCommand, workspaceRequestScope, workspaceRequestSignal } from '@/modules/workspace-bridge/index.js';

// cross-spawn: drop-in spawn with Windows .cmd/PATHEXT resolution.
import { parseGitLogWithStats, parseGitStatusOutput } from './git-parsing.service.js';
import { getDeletedFileContent, resolveRepositoryFilePath } from './git-read.service.js';
import { changeGitBranch } from './git-branch.service.js';
import { createGitOperationHandlers, gitOperationReadOnly } from './git-operation.service.js';

type GitRouterDependencies = {
  fileSystem: WorkspaceGitFileSystem;
  spawnProcess: typeof import('cross-spawn').default;
  resolveProjectPathById(projectId: string): string | null;
  queryClaude: ProviderRunFunction;
  queryCursor: ProviderRunFunction;
};

/** Creates Git routes around explicit repository, filesystem, subprocess, and AI adapters. */
export function createGitRouter(dependencies: GitRouterDependencies): express.Router {
const fs = dependencies.fileSystem;
const spawn = dependencies.spawnProcess;
const projectsDb = { getProjectPathById: dependencies.resolveProjectPathById };
const queryClaudeSDK = dependencies.queryClaude;
const spawnCursor = dependencies.queryCursor;
const router = express.Router();
const operations = createGitOperationHandlers(getActualProjectPath);
const routes = {
  get: (url, handler) => router.get(url, operations.read(handler)),
  post: (url, handler) => router.post(url, url === '/generate-commit-message' ? operations.read(handler) : ['/checkout', '/create-branch', '/delete-branch'].includes(url) ? operations.branch(handler) : operations.write(handler)),
};
router.use(workspaceRequestScope);
const COMMIT_DIFF_CHARACTER_LIMIT = 500_000;

async function spawnAsync(command, args, options = {}) {
  const signal = workspaceRequestSignal();
  if (options.cwd) {
    const result = await runWorkspaceCommand(options.cwd, command, args, { readOnly: gitOperationReadOnly() });
    if (result) {
      if (result.exitCode !== 0 || result.truncated) throw Object.assign(new Error(result.stderr || 'Workspace Git command failed'), { code: result.exitCode, stdout: result.stdout, stderr: result.stderr });
      return { stdout: result.stdout, stderr: result.stderr };
    }
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      env: { ...process.env, ...options.env, GIT_LITERAL_PATHSPECS: '1', ...(gitOperationReadOnly() ? { GIT_OPTIONAL_LOCKS: '0' } : {}) },
      shell: false,
      signal,
      killSignal: 'SIGKILL',
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    let processError;
    child.on('error', (error) => { processError = error; });

    child.on('close', (code) => {
      if (processError) { reject(processError); return; }
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      const error = new Error(stderr.trim() || `Git command failed with exit code ${code}`);
      error.code = code;
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
  });
}

// Input validation helpers (defense-in-depth)
function validateCommitRef(commit) {
  // Allow hex hashes, HEAD, HEAD~N, HEAD^N, tag names, branch names
  if (typeof commit !== 'string' || commit.startsWith('-') || !/^[a-zA-Z0-9._~^{}@\/-]+$/.test(commit)) {
    throw new AppError('Invalid commit reference', { code: 'GIT_INVALID_REF', statusCode: 400 });
  }
  return commit;
}

function validateBranchName(branch) {
  if (typeof branch !== 'string' || !branch || branch.startsWith('-') || branch === '@'
    || !/^[a-zA-Z0-9._\/-]+$/.test(branch) || branch.includes('..') || branch.includes('//')
    || branch.endsWith('.') || branch.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.lock'))) {
    throw new AppError('Invalid branch name', { code: 'GIT_INVALID_BRANCH', statusCode: 400 });
  }
  return branch;
}

function validateFilePath(file, projectPath) {
  if (typeof file !== 'string' || !file || /[\0\r\n]/.test(file) || path.isAbsolute(file) || /^[a-zA-Z]:/.test(file)
    || file.replace(/\\/g, '/').split('/').some(part => part === '..' || part.toLowerCase() === '.git') || file.startsWith(':')) {
    throw new AppError('Invalid file path: use a contained literal repository path', { code: 'GIT_INVALID_PATH', statusCode: 400 });
  }
  // Prevent path traversal: resolve the file relative to the project root
  // and ensure the result stays within the project directory
  if (projectPath) {
    const resolved = path.resolve(projectPath, file);
    const normalizedRoot = path.resolve(projectPath) + path.sep;
    if (!resolved.startsWith(normalizedRoot) && resolved !== path.resolve(projectPath)) {
      throw new Error('Invalid file path: path traversal detected');
    }
  }
  return file;
}

function validateRemoteName(remote) {
  if (!/^[a-zA-Z0-9._-]+$/.test(remote)) {
    throw new Error('Invalid remote name');
  }
  return remote;
}

function validateProjectPath(projectPath) {
  if (!projectPath || projectPath.includes('\0')) {
    throw new Error('Invalid project path');
  }
  const resolved = path.resolve(projectPath);
  // Must be an absolute path after resolution
  if (!path.isAbsolute(resolved)) {
    throw new Error('Invalid project path: must be absolute');
  }
  // Block obviously dangerous paths
  if (resolved === '/' || resolved === path.sep) {
    throw new Error('Invalid project path: root directory not allowed');
  }
  return resolved;
}

/**
 * Resolve the absolute project directory for a given DB `projectId`.
 *
 * After the projectName → projectId migration, every git endpoint receives
 * the DB primary key (`project` query/body param). The legacy filesystem
 * resolver that walked Claude's JSONL history is no longer used here; the
 * path comes straight from the `projects` table and is then sanity-checked
 * by `validateProjectPath` before any `git` command runs against it.
 */
async function getActualProjectPath(projectId) {
  const projectPath = await projectsDb.getProjectPathById(projectId);
  if (!projectPath) {
    throw new Error(`Unable to resolve project path for "${projectId}"`);
  }
  return validateProjectPath(projectPath);
}

// Helper function to strip git diff headers
function stripDiffHeaders(diff) {
  if (!diff) return '';

  const lines = diff.split('\n');
  const filteredLines = [];
  let startIncluding = false;

  for (const line of lines) {
    // Skip all header lines including diff --git, index, file mode, and --- / +++ file paths
    if (line.startsWith('diff --git') ||
        line.startsWith('index ') ||
        line.startsWith('new file mode') ||
        line.startsWith('deleted file mode') ||
        line.startsWith('---') ||
        line.startsWith('+++')) {
      continue;
    }

    // Start including lines from @@ hunk headers onwards
    if (line.startsWith('@@') || startIncluding) {
      startIncluding = true;
      filteredLines.push(line);
    }
  }

  return filteredLines.join('\n');
}

// Helper function to validate git repository
async function validateGitRepository(projectPath) {
  try {
    // Check if directory exists
    await fs.access(projectPath);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new AppError(`Project path not found: ${projectPath}`, { code: 'PROJECT_PATH_NOT_FOUND', statusCode: 404 });
    throw error;
  }

  try {
    // Allow any directory that is inside a work tree (repo root or nested folder).
    const { stdout: insideWorkTreeOutput } = await spawnAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: projectPath });
    const isInsideWorkTree = insideWorkTreeOutput.trim() === 'true';
    if (!isInsideWorkTree) {
      throw new AppError('Not a git repository', {
        code: 'NOT_A_GIT_REPOSITORY',
        statusCode: 400,
      });
    }

    // Ensure git can resolve the repository root for this directory.
    await spawnAsync('git', ['rev-parse', '--show-toplevel'], { cwd: projectPath });
  } catch (error) {
    if (
      error instanceof AppError
      && error.code === 'NOT_A_GIT_REPOSITORY'
    ) {
      throw error;
    }

    if (/not a git repository/i.test(getGitErrorDetails(error))) {
      throw new AppError('Not a git repository. Initialize a git repository with "git init" to use source control features.', {
        code: 'NOT_A_GIT_REPOSITORY',
        statusCode: 400,
      });
    }

    throw error;
  }
}

function getGitErrorDetails(error) {
  return `${error?.message || ''} ${error?.stderr || ''} ${error?.stdout || ''}`;
}

function preserveWorkspaceFailure(error) {
  workspaceRequestSignal();
  if (error instanceof AppError || error?.cleanupError || error?.workspaceCleanupError || error?.name === 'AbortError') throw error;
}

function isMissingHeadRevisionError(error) {
  const errorDetails = getGitErrorDetails(error).toLowerCase();
  return errorDetails.includes('unknown revision')
    || errorDetails.includes('ambiguous argument')
    || errorDetails.includes('needed a single revision')
    || errorDetails.includes('bad revision');
}

async function getCurrentBranchName(projectPath) {
  try {
    // The full ref stays unambiguous when a tag shadows the branch name, and
    // symbolic-ref also works before the repository's first commit.
    const { stdout } = await spawnAsync('git', ['symbolic-ref', 'HEAD'], { cwd: projectPath });
    const branchName = stdout.trim().replace(/^refs\/heads\//, '');
    if (branchName) {
      return branchName;
    }
  } catch (error) {
    preserveWorkspaceFailure(error);
    // Fall back to rev-parse for detached HEAD and older git edge cases.
  }

  const { stdout } = await spawnAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: projectPath });
  return stdout.trim();
}

async function repositoryHasCommits(projectPath) {
  try {
    await spawnAsync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: projectPath });
    return true;
  } catch (error) {
    if (isMissingHeadRevisionError(error)) {
      return false;
    }
    throw error;
  }
}

async function getRepositoryRootPath(projectPath) {
  const { stdout } = await spawnAsync('git', ['rev-parse', '--show-toplevel'], { cwd: projectPath });
  return stdout.trim();
}

// Get Git status for a project; parsing is isolated in git-parsing.service.ts.
routes.get('/status', async (req, res) => {
  const { project } = req.query;

  if (!project) {
    return res.status(400).json({ error: 'Project id is required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);

    // Validate git repository
    await validateGitRepository(projectPath);

    const branch = await getCurrentBranchName(projectPath);
    const hasCommits = await repositoryHasCommits(projectPath);

    const { stdout: statusOutput } = await spawnAsync('git', ['status', '--porcelain=v1', '-z'], { cwd: projectPath });
    const { modified, added, deleted, untracked, staged } = parseGitStatusOutput(statusOutput);

    res.json({
      branch,
      hasCommits,
      modified,
      added,
      deleted,
      untracked,
      staged
    });
  } catch (error) {
    // Case-insensitive so "Not a git repository..." from validateGitRepository
    // matches; `notGitRepository` lets the UI offer a one-click `git init`.
    const isNotGitRepository = error instanceof AppError && error.code === 'NOT_A_GIT_REPOSITORY';
    // A project without a repository is an expected state, not a failure.
    if (!isNotGitRepository) {
      console.error('Git status error:', error);
    }
    if (!isNotGitRepository) throw error;
    res.json({ error: error.message, code: error.code, details: error.message, notGitRepository: true });
  }
});

// Initialize a new git repository in the project directory
routes.post('/init', async (req, res) => {
  const { project } = req.body;

  if (!project) {
    return res.status(400).json({ error: 'Project id is required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);

    let isAlreadyRepository = false;
    try {
      await validateGitRepository(projectPath);
      isAlreadyRepository = true;
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'NOT_A_GIT_REPOSITORY') {
        throw error;
      }
      // Not a repository yet — proceed with git init.
    }

    if (isAlreadyRepository) {
      return res.json({ success: true, output: 'Repository already initialized' });
    }

    const { stdout, stderr } = await spawnAsync('git', ['init'], { cwd: projectPath });
    res.json({ success: true, output: stdout.trim() || stderr.trim() });
  } catch (error) {
    console.error('Git init error:', error);
    throw error;
  }
});

// Get diff for a specific file
routes.get('/diff', async (req, res) => {
  const { project, file } = req.query;
  
  if (!project || !file) {
    return res.status(400).json({ error: 'Project id and file path are required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);
    
    // Validate git repository
    await validateGitRepository(projectPath);

    const {
      repositoryRootPath,
      repositoryRelativeFilePath,
    } = await resolveRepositoryFilePath({
      projectPath,
      filePath: validateFilePath(file),
      repositoryRootPath: await getRepositoryRootPath(projectPath),
      runCommand: spawnAsync,
    });

    // Porcelain's XY columns report staged and worktree deletions independently.
    const { stdout: statusOutput } = await spawnAsync(
      'git',
      ['status', '--porcelain=v1', '-z', '--', repositoryRelativeFilePath],
      { cwd: repositoryRootPath },
    );
    const isUntracked = statusOutput.startsWith('??');
    const isDeleted = statusOutput[0] === 'D' || statusOutput[1] === 'D';

    let diff;
    if (isUntracked) {
      // For untracked files, show the entire file content as additions
      const filePath = path.join(repositoryRootPath, repositoryRelativeFilePath);
      const stats = await fs.stat(filePath);

      if (stats.isDirectory()) {
        // For directories, show a simple message
        diff = `Directory: ${repositoryRelativeFilePath}\n(Cannot show diff for directories)`;
      } else {
        const fileContent = await fs.readFile(filePath, 'utf-8');
        const lines = fileContent.split('\n');
        diff = `--- /dev/null\n+++ b/${repositoryRelativeFilePath}\n@@ -0,0 +1,${lines.length} @@\n` +
               lines.map(line => `+${line}`).join('\n');
      }
    } else if (isDeleted) {
      // Prefer committed content; staged additions only have content in the index.
      const { currentContent: fileContent } = await getDeletedFileContent({ repositoryRootPath, repositoryRelativeFilePath, statusOutput, runCommand: spawnAsync });
      const lines = fileContent.split('\n');
      diff = `--- a/${repositoryRelativeFilePath}\n+++ /dev/null\n@@ -1,${lines.length} +0,0 @@\n` +
             lines.map(line => `-${line}`).join('\n');
    } else {
      // Get diff for tracked files
      // First check for unstaged changes (working tree vs index)
      const { stdout: unstagedDiff } = await spawnAsync(
        'git',
        ['diff', '--', repositoryRelativeFilePath],
        { cwd: repositoryRootPath },
      );

      if (unstagedDiff) {
        // Show unstaged changes if they exist
        diff = stripDiffHeaders(unstagedDiff);
      } else {
        // If no unstaged changes, check for staged changes (index vs HEAD)
        const { stdout: stagedDiff } = await spawnAsync(
          'git',
          ['diff', '--cached', '--', repositoryRelativeFilePath],
          { cwd: repositoryRootPath },
        );
        diff = stripDiffHeaders(stagedDiff) || '';
      }
    }

    res.json({ diff });
  } catch (error) {
    console.error('Git diff error:', error);
    throw error;
  }
});

// Get file content with diff information for CodeEditor
routes.get('/file-with-diff', async (req, res) => {
  const { project, file } = req.query;

  if (!project || !file) {
    return res.status(400).json({ error: 'Project id and file path are required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);

    // Validate git repository
    await validateGitRepository(projectPath);

    const {
      repositoryRootPath,
      repositoryRelativeFilePath,
    } = await resolveRepositoryFilePath({
      projectPath,
      filePath: validateFilePath(file),
      repositoryRootPath: await getRepositoryRootPath(projectPath),
      runCommand: spawnAsync,
    });

    // Keep the XY columns intact: MD and AD also mean the worktree file is deleted.
    const { stdout: statusOutput } = await spawnAsync(
      'git',
      ['status', '--porcelain=v1', '-z', '--', repositoryRelativeFilePath],
      { cwd: repositoryRootPath },
    );
    const isUntracked = statusOutput.startsWith('??');
    const isDeleted = statusOutput[0] === 'D' || statusOutput[1] === 'D';

    let currentContent = '';
    let oldContent = '';

    if (isDeleted) {
      const deletedContent = await getDeletedFileContent({ repositoryRootPath, repositoryRelativeFilePath, statusOutput, runCommand: spawnAsync });
      oldContent = deletedContent.oldContent;
      currentContent = deletedContent.currentContent; // Show the deleted content in editor
    } else {
      // Get current file content
      const filePath = path.join(repositoryRootPath, repositoryRelativeFilePath);
      const stats = await fs.stat(filePath);

      if (stats.isDirectory()) {
        // Cannot show content for directories
        return res.status(400).json({ error: 'Cannot show diff for directories' });
      }

      currentContent = await fs.readFile(filePath, 'utf-8');

      if (!isUntracked) {
        // Get the old content from HEAD for tracked files
        try {
          const { stdout: headContent } = await spawnAsync(
            'git',
            ['show', `HEAD:${repositoryRelativeFilePath}`],
            { cwd: repositoryRootPath },
          );
          oldContent = headContent;
        } catch (error) {
          preserveWorkspaceFailure(error);
          // File might be newly added to git (staged but not committed)
          oldContent = '';
        }
      }
    }

    res.json({
      currentContent,
      oldContent,
      isDeleted,
      isUntracked
    });
  } catch (error) {
    console.error('Git file-with-diff error:', error);
    throw error;
  }
});

// Create initial commit
routes.post('/initial-commit', async (req, res) => {
  const { project } = req.body;

  if (!project) {
    return res.status(400).json({ error: 'Project id is required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);

    // Validate git repository
    await validateGitRepository(projectPath);

    // Check if there are already commits
    try {
      await spawnAsync('git', ['rev-parse', 'HEAD'], { cwd: projectPath });
      return res.status(400).json({ error: 'Repository already has commits. Use regular commit instead.' });
    } catch (error) {
      // No HEAD - this is good, we can create initial commit
      preserveWorkspaceFailure(error);
      if (!isMissingHeadRevisionError(error)) throw error;
    }

    // Add all files
    await spawnAsync('git', ['add', '.'], { cwd: projectPath });

    // Create initial commit
    const { stdout } = await spawnAsync('git', ['commit', '-m', 'Initial commit'], { cwd: projectPath });

    res.json({ success: true, output: stdout, message: 'Initial commit created successfully' });
  } catch (error) {
    console.error('Git initial commit error:', error);

    // Handle the case where there's nothing to commit
    if (error.message.includes('nothing to commit')) {
      return res.status(400).json({
        error: 'Nothing to commit',
        details: 'No files found in the repository. Add some files first.'
      });
    }

    throw error;
  }
});

// Commit changes
routes.post('/commit', async (req, res) => {
  const { project, message, files } = req.body;
  
  if (!project || typeof message !== 'string' || !message.trim() || (files !== undefined && !Array.isArray(files))) {
    return res.status(400).json({ error: 'Project id and commit message are required; files must be an array when provided' });
  }

  try {
    const projectPath = await getActualProjectPath(project);
    
    // Validate git repository
    await validateGitRepository(projectPath);
    const repositoryRootPath = await getRepositoryRootPath(projectPath);
    
    // The UI has already staged the actual index. Re-adding a selected file here
    // would silently include unstaged hunks from a partially staged file.
    // Commit the current index exactly as Git's staging controls left it.
    // Commit with message
    const { stdout } = await spawnAsync('git', ['commit', '-m', message], { cwd: repositoryRootPath });
    
    res.json({ success: true, output: stdout });
  } catch (error) {
    console.error('Git commit error:', error);
    throw error;
  }
});

// Stage files (git add). Mirrors what the UI shows as the "Staged" section,
// so the app's staging state and the real git index never drift apart.
routes.post('/stage', async (req, res) => {
  const { project, files } = req.body;

  if (!project || !Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ error: 'Project id and files are required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);
    await validateGitRepository(projectPath);
    const repositoryRootPath = await getRepositoryRootPath(projectPath);

    for (const file of files) {
      const { repositoryRelativeFilePath } = await resolveRepositoryFilePath({
        projectPath,
        filePath: validateFilePath(file),
        repositoryRootPath: await getRepositoryRootPath(projectPath),
        runCommand: spawnAsync,
      });
      await spawnAsync('git', ['add', '--', repositoryRelativeFilePath], { cwd: repositoryRootPath });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Git stage error:', error);
    throw error;
  }
});

// Unstage files (remove from the index, keep the worktree changes)
routes.post('/unstage', async (req, res) => {
  const { project, files } = req.body;

  if (!project || !Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ error: 'Project id and files are required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);
    await validateGitRepository(projectPath);
    const repositoryRootPath = await getRepositoryRootPath(projectPath);
    const hasCommits = await repositoryHasCommits(projectPath);

    for (const file of files) {
      const { repositoryRelativeFilePath } = await resolveRepositoryFilePath({
        projectPath,
        filePath: validateFilePath(file),
        repositoryRootPath: await getRepositoryRootPath(projectPath),
        runCommand: spawnAsync,
      });
      if (hasCommits) {
        await spawnAsync('git', ['reset', 'HEAD', '--', repositoryRelativeFilePath], { cwd: repositoryRootPath });
      } else {
        // No HEAD to reset against before the first commit; dropping the
        // index entry is the only way to unstage while keeping the file.
        await spawnAsync('git', ['rm', '--cached', '-r', '--force', '--', repositoryRelativeFilePath], { cwd: repositoryRootPath });
      }
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Git unstage error:', error);
    throw error;
  }
});

// Revert latest local commit (keeps changes staged)
routes.post('/revert-local-commit', async (req, res) => {
  const { project } = req.body;

  if (!project) {
    return res.status(400).json({ error: 'Project id is required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);
    await validateGitRepository(projectPath);

    try {
      await spawnAsync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: projectPath });
    } catch (error) {
      preserveWorkspaceFailure(error);
      if (!isMissingHeadRevisionError(error)) throw error;
      return res.status(400).json({
        error: 'No local commit to revert',
        details: 'This repository has no commit yet.',
      });
    }

    try {
      // Soft reset rewinds one commit while preserving all file changes in the index.
      await spawnAsync('git', ['reset', '--soft', 'HEAD~1'], { cwd: projectPath });
    } catch (error) {
      const errorDetails = `${error.stderr || ''} ${error.message || ''}`;
      const isInitialCommit = errorDetails.includes('HEAD~1') &&
        (errorDetails.includes('unknown revision') || errorDetails.includes('ambiguous argument'));

      if (!isInitialCommit) {
        throw error;
      }

      // Initial commit has no parent; deleting HEAD uncommits it and keeps files staged.
      await spawnAsync('git', ['update-ref', '-d', 'HEAD'], { cwd: projectPath });
    }

    res.json({
      success: true,
      output: 'Latest local commit reverted successfully. Changes were kept staged.',
    });
  } catch (error) {
    console.error('Git revert local commit error:', error);
    throw error;
  }
});

// Get list of branches
routes.get('/branches', async (req, res) => {
  const { project } = req.query;
  
  if (!project) {
    return res.status(400).json({ error: 'Project id is required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);
    
    // Validate git repository
    await validateGitRepository(projectPath);
    
    // Get all branches
    const { stdout } = await spawnAsync('git', ['branch', '-a'], { cwd: projectPath });

    const rawLines = stdout
      .split('\n')
      .map(b => b.trim())
      .filter(b => b && !b.includes('->'));

    // Strip only Git's display marker, preserving '+' when it belongs to the name.
    const localBranches = rawLines
      .filter(b => !b.startsWith('remotes/'))
      .map(b => b.replace(/^[*+] /, ''));

    // Remote branches — strip 'remotes/<remote>/' prefix
    const remoteBranches = rawLines
      .filter(b => b.startsWith('remotes/'))
      .map(b => b.replace(/^remotes\/[^/]+\//, ''))
      .filter(name => !localBranches.includes(name)); // skip if already a local branch

    // Backward-compat flat list (local + unique remotes, deduplicated)
    const branches = [...localBranches, ...remoteBranches]
      .filter((b, i, arr) => arr.indexOf(b) === i);

    res.json({ branches, localBranches, remoteBranches });
  } catch (error) {
    console.error('Git branches error:', error);
    throw error;
  }
});

// Checkout branch
routes.post('/checkout', async (req, res) => {
  const { project, branch } = req.body;
  
  if (!project || !branch) {
    return res.status(400).json({ error: 'Project id and branch are required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);
    
    validateBranchName(branch);
    const output = await changeGitBranch({ projectPath, action: 'checkout', branch, runCommand: spawnAsync, fileSystem: fs, validateRepository: validateGitRepository });
    res.json({ success: true, output });
  } catch (error) {
    console.error('Git checkout error:', error);
    throw error;
  }
});

// Create new branch
routes.post('/create-branch', async (req, res) => {
  const { project, branch } = req.body;
  
  if (!project || !branch) {
    return res.status(400).json({ error: 'Project id and branch name are required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);
    
    validateBranchName(branch);
    const output = await changeGitBranch({ projectPath, action: 'create', branch, runCommand: spawnAsync, fileSystem: fs, validateRepository: validateGitRepository });
    res.json({ success: true, output });
  } catch (error) {
    console.error('Git create branch error:', error);
    throw error;
  }
});

// Delete a local branch
routes.post('/delete-branch', async (req, res) => {
  const { project, branch, force = false } = req.body;

  if (!project || !branch) {
    return res.status(400).json({ error: 'Project id and branch name are required' });
  }

  if (typeof force !== 'boolean') {
    return res.status(400).json({ error: 'force must be a boolean' });
  }

  try {
    const projectPath = await getActualProjectPath(project);
    validateBranchName(branch);
    const output = await changeGitBranch({ projectPath, action: 'delete', branch, force, runCommand: spawnAsync, fileSystem: fs, validateRepository: validateGitRepository });
    res.json({ success: true, output });
  } catch (error) {
    console.error('Git delete branch error:', error);
    throw error;
  }
});

// Fields are joined with the ASCII unit separator so pipes (or anything else
// typed into a commit subject) cannot break parsing.
const GIT_LOG_PRETTY_FORMAT = '%H%x1f%P%x1f%D%x1f%an%x1f%ae%x1f%ad%x1f%s';

// Get recent commits (across all branches, in graph order)
routes.get('/commits', async (req, res) => {
  const { project, limit = 10 } = req.query;

  if (!project) {
    return res.status(400).json({ error: 'Project id is required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);
    await validateGitRepository(projectPath);
    const parsedLimit = Number.parseInt(String(limit), 10);
    const safeLimit = Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.min(parsedLimit, 100)
      : 10;

    // Branches/remotes/tags (not --all, which would drag in refs/stash) with
    // `--topo-order` guarantee children appear before their parents across
    // every branch, which the frontend lane-assignment relies on.
    // `--shortstat` replaces the previous per-commit `git show --stat` calls.
    const { stdout } = await spawnAsync(
      'git',
      [
        'log',
        '--branches',
        '--remotes',
        '--tags',
        '--topo-order',
        '--shortstat',
        `--pretty=format:${GIT_LOG_PRETTY_FORMAT}`,
        '--date=iso-strict',
        '-n', String(safeLimit)
      ],
      { cwd: projectPath },
    );

    res.json({ commits: parseGitLogWithStats(stdout) });
  } catch (error) {
    console.error('Git commits error:', error);
    throw error;
  }
});

// Get diff for a specific commit
routes.get('/commit-diff', async (req, res) => {
  const { project, commit } = req.query;
  
  if (!project || !commit) {
    return res.status(400).json({ error: 'Project id and commit hash are required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);

    // Validate commit reference (defense-in-depth)
    validateCommitRef(commit);

    // Get diff for the commit
    const { stdout } = await spawnAsync(
      'git', ['show', commit],
      { cwd: projectPath }
    );

    const isTruncated = stdout.length > COMMIT_DIFF_CHARACTER_LIMIT;
    const diff = isTruncated
      ? `${stdout.slice(0, COMMIT_DIFF_CHARACTER_LIMIT)}\n\n... Diff truncated to keep the UI responsive ...`
      : stdout;

    res.json({ diff, isTruncated });
  } catch (error) {
    console.error('Git commit diff error:', error);
    throw error;
  }
});

// Generate commit message based on staged changes using AI
routes.post('/generate-commit-message', async (req, res) => {
  const { project, files, provider = 'claude' } = req.body;

  if (!project || !files || files.length === 0) {
    return res.status(400).json({ error: 'Project id and files are required' });
  }

  // Validate provider
  if (!['claude', 'cursor'].includes(provider)) {
    return res.status(400).json({ error: 'provider must be "claude" or "cursor"' });
  }

  try {
    const projectPath = await getActualProjectPath(project);
    await validateGitRepository(projectPath);
    const repositoryRootPath = await getRepositoryRootPath(projectPath);

    // Get diff for selected files
    let diffContext = '';
    for (const file of files) {
      try {
        const { repositoryRelativeFilePath } = await resolveRepositoryFilePath({
          projectPath,
          filePath: validateFilePath(file),
          repositoryRootPath: await getRepositoryRootPath(projectPath),
          runCommand: spawnAsync,
        });
        const { stdout } = await spawnAsync(
          'git', ['diff', 'HEAD', '--', repositoryRelativeFilePath],
          { cwd: repositoryRootPath }
        );
        if (stdout) {
          diffContext += `\n--- ${repositoryRelativeFilePath} ---\n${stdout}`;
        }
      } catch (error) {
        preserveWorkspaceFailure(error);
        console.error(`Error getting diff for ${file}:`, error);
      }
    }

    // If no diff found, might be untracked files
    if (!diffContext.trim()) {
      // Try to get content of untracked files
      for (const file of files) {
        try {
          const { repositoryRelativeFilePath } = await resolveRepositoryFilePath({
            projectPath,
            filePath: validateFilePath(file),
            repositoryRootPath: await getRepositoryRootPath(projectPath),
            runCommand: spawnAsync,
          });
          const filePath = path.join(repositoryRootPath, repositoryRelativeFilePath);
          const stats = await fs.stat(filePath);

          if (!stats.isDirectory()) {
            const content = await fs.readFile(filePath, 'utf-8');
            diffContext += `\n--- ${repositoryRelativeFilePath} (new file) ---\n${content.substring(0, 1000)}\n`;
          } else {
            diffContext += `\n--- ${repositoryRelativeFilePath} (new directory) ---\n`;
          }
        } catch (error) {
          preserveWorkspaceFailure(error);
          console.error(`Error reading file ${file}:`, error);
        }
      }
    }

    // Generate commit message using AI
    const message = await generateCommitMessageWithAI(files, diffContext, provider, projectPath, req.user?.id);

    res.json({ message });
  } catch (error) {
    console.error('Generate commit message error:', error);
    throw error;
  }
});

/**
 * Generates a commit message using AI (Claude SDK or Cursor CLI)
 * @param {Array<string>} files - List of changed files
 * @param {string} diffContext - Git diff content
 * @param {string} provider - 'claude' or 'cursor'
 * @param {string} projectPath - Project directory path
 * @returns {Promise<string>} Generated commit message
 */
async function generateCommitMessageWithAI(files, diffContext, provider, projectPath, userId) {
  // Create the prompt
  const prompt = `Generate a conventional commit message for these changes.

REQUIREMENTS:
- Format: type(scope): subject
- Include body explaining what changed and why
- Types: feat, fix, docs, style, refactor, perf, test, build, ci, chore
- Subject under 50 chars, body wrapped at 72 chars
- Focus on user-facing changes, not implementation details
- Consider what's being added AND removed
- Return ONLY the commit message (no markdown, explanations, or code blocks)

FILES CHANGED:
${files.map(f => `- ${f}`).join('\n')}

DIFFS:
${diffContext.substring(0, 4000)}

Generate the commit message:`;

  try {
    // Create a simple writer that collects the response
    let responseText = '';
    let providerError = null;
    const writer = {
      // Carry the authenticated caller into per-user provider routing.
      userId,
      send: (data) => {
        try {
          const parsed = typeof data === 'string' ? JSON.parse(data) : data;
          if (parsed.kind === 'error') providerError = new AppError(parsed.content || 'Commit message generation failed', { code: 'PROVIDER_RUN_FAILED', statusCode: 503 });
          console.log('🔍 Writer received message type:', parsed.type);

          // Handle different message formats from Claude SDK and Cursor CLI
          // Claude SDK sends: {type: 'claude-response', data: {message: {content: [...]}}}
          if (parsed.type === 'claude-response' && parsed.data) {
            const message = parsed.data.message || parsed.data;
            console.log('📦 Claude response message:', JSON.stringify(message, null, 2).substring(0, 500));
            if (message.content && Array.isArray(message.content)) {
              // Extract text from content array
              for (const item of message.content) {
                if (item.type === 'text' && item.text) {
                  console.log('✅ Extracted text chunk:', item.text.substring(0, 100));
                  responseText += item.text;
                }
              }
            }
          }
          // Cursor CLI sends: {type: 'cursor-output', output: '...'}
          else if (parsed.type === 'cursor-output' && parsed.output) {
            console.log('✅ Cursor output:', parsed.output.substring(0, 100));
            responseText += parsed.output;
          }
          // Also handle direct text messages
          else if (parsed.type === 'text' && parsed.text) {
            console.log('✅ Direct text:', parsed.text.substring(0, 100));
            responseText += parsed.text;
          }
        } catch (e) {
          // Ignore parse errors
          console.error('Error parsing writer data:', e);
        }
      },
      setSessionId: () => {}, // No-op for this use case
    };

    console.log('🚀 Calling AI agent with provider:', provider);
    console.log('📝 Prompt length:', prompt.length);

    // Call the appropriate agent
    if (provider === 'claude') {
      await queryClaudeSDK(prompt, {
        cwd: projectPath,
        permissionMode: 'bypassPermissions',
        model: 'sonnet',
        abortSignal: workspaceRequestSignal(),
      }, writer);
    } else if (provider === 'cursor') {
      await spawnCursor(prompt, {
        cwd: projectPath,
        skipPermissions: true,
        abortSignal: workspaceRequestSignal(),
      }, writer);
    }
    workspaceRequestSignal();
    if (providerError) throw providerError;

    console.log('📊 Total response text collected:', responseText.length, 'characters');
    console.log('📄 Response preview:', responseText.substring(0, 200));

    // Clean up the response
    const cleanedMessage = cleanCommitMessage(responseText);
    console.log('🧹 Cleaned message:', cleanedMessage.substring(0, 200));

    return cleanedMessage || 'chore: update files';
  } catch (error) {
    preserveWorkspaceFailure(error);
    console.error('Error generating commit message with AI:', error);
    // Fallback to simple message
    return `chore: update ${files.length} file${files.length !== 1 ? 's' : ''}`;
  }
}

/**
 * Cleans the AI-generated commit message by removing markdown, code blocks, and extra formatting
 * @param {string} text - Raw AI response
 * @returns {string} Clean commit message
 */
function cleanCommitMessage(text) {
  if (!text || !text.trim()) {
    return '';
  }

  let cleaned = text.trim();

  // Remove markdown code blocks
  cleaned = cleaned.replace(/```[a-z]*\n/g, '');
  cleaned = cleaned.replace(/```/g, '');

  // Remove markdown headers
  cleaned = cleaned.replace(/^#+\s*/gm, '');

  // Remove leading/trailing quotes
  cleaned = cleaned.replace(/^["']|["']$/g, '');

  // If there are multiple lines, take everything (subject + body)
  // Just clean up extra blank lines
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

  // Remove any explanatory text before the actual commit message
  // Look for conventional commit pattern and start from there
  const conventionalCommitMatch = cleaned.match(/(feat|fix|docs|style|refactor|perf|test|build|ci|chore)(\(.+?\))?:.+/s);
  if (conventionalCommitMatch) {
    cleaned = cleaned.substring(cleaned.indexOf(conventionalCommitMatch[0]));
  }

  return cleaned.trim();
}

// Get remote status (ahead/behind commits with smart remote detection)
routes.get('/remote-status', async (req, res) => {
  const { project } = req.query;
  
  if (!project) {
    return res.status(400).json({ error: 'Project id is required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);
    await validateGitRepository(projectPath);

    const branch = await getCurrentBranchName(projectPath);
    const hasCommits = await repositoryHasCommits(projectPath);

    const { stdout: remoteOutput } = await spawnAsync('git', ['remote'], { cwd: projectPath });
    const remotes = remoteOutput.trim().split('\n').filter(r => r.trim());
    const hasRemote = remotes.length > 0;
    const fallbackRemoteName = hasRemote
      ? (remotes.includes('origin') ? 'origin' : remotes[0])
      : null;

    // Repositories initialized with `git init` can have a branch but no commits.
    // Return a non-error state so the UI can show the initial-commit workflow.
    if (!hasCommits) {
      return res.json({
        hasRemote,
        hasUpstream: false,
        branch,
        remoteName: fallbackRemoteName,
        ahead: 0,
        behind: 0,
        isUpToDate: false,
        message: 'Repository has no commits yet'
      });
    }

    // Check if there's a remote tracking branch (smart detection)
    let trackingBranch;
    let remoteName;
    try {
      const { stdout } = await spawnAsync('git', ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], { cwd: projectPath });
      trackingBranch = stdout.trim();
      remoteName = trackingBranch.split('/')[0]; // Extract remote name (e.g., "origin/main" -> "origin")
    } catch (error) {
      preserveWorkspaceFailure(error);
      return res.json({
        hasRemote,
        hasUpstream: false,
        branch,
        remoteName: fallbackRemoteName,
        message: 'No remote tracking branch configured'
      });
    }

    // Get ahead/behind counts
    const { stdout: countOutput } = await spawnAsync(
      'git', ['rev-list', '--count', '--left-right', `${trackingBranch}...HEAD`],
      { cwd: projectPath }
    );
    
    const [behind, ahead] = countOutput.trim().split('\t').map(Number);

    res.json({
      hasRemote: true,
      hasUpstream: true,
      branch,
      remoteBranch: trackingBranch,
      remoteName,
      ahead: ahead || 0,
      behind: behind || 0,
      isUpToDate: ahead === 0 && behind === 0
    });
  } catch (error) {
    console.error('Git remote status error:', error);
    throw error;
  }
});

// Fetch from remote (using smart remote detection)
routes.post('/fetch', async (req, res) => {
  const { project } = req.body;
  
  if (!project) {
    return res.status(400).json({ error: 'Project id is required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);
    await validateGitRepository(projectPath);

    // Get current branch and its upstream remote
    const branch = await getCurrentBranchName(projectPath);

    let remoteName = 'origin'; // fallback
    try {
      const { stdout } = await spawnAsync('git', ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], { cwd: projectPath });
      remoteName = stdout.trim().split('/')[0]; // Extract remote name
    } catch (error) {
      preserveWorkspaceFailure(error);
      // No upstream, try to fetch from origin anyway
      console.log('No upstream configured, using origin as fallback');
    }

    validateRemoteName(remoteName);
    const { stdout } = await spawnAsync('git', ['fetch', remoteName], { cwd: projectPath });

    res.json({ success: true, output: stdout || 'Fetch completed successfully', remoteName });
  } catch (error) {
    console.error('Git fetch error:', error);
    throw error;
  }
});

// Pull from remote (fetch + merge using smart remote detection)
routes.post('/pull', async (req, res) => {
  const { project } = req.body;
  
  if (!project) {
    return res.status(400).json({ error: 'Project id is required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);
    await validateGitRepository(projectPath);

    // Get current branch and its upstream remote
    const branch = await getCurrentBranchName(projectPath);

    let remoteName = 'origin'; // fallback
    let remoteBranch = branch; // fallback
    try {
      const { stdout } = await spawnAsync('git', ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], { cwd: projectPath });
      const tracking = stdout.trim();
      remoteName = tracking.split('/')[0]; // Extract remote name
      remoteBranch = tracking.split('/').slice(1).join('/'); // Extract branch name
    } catch (error) {
      preserveWorkspaceFailure(error);
      // No upstream, use fallback
      console.log('No upstream configured, using origin/branch as fallback');
    }

    validateRemoteName(remoteName);
    validateBranchName(remoteBranch);
    const { stdout } = await spawnAsync('git', ['pull', remoteName, remoteBranch], { cwd: projectPath });

    res.json({
      success: true,
      output: stdout || 'Pull completed successfully',
      remoteName,
      remoteBranch
    });
  } catch (error) {
    console.error('Git pull error:', error);
    throw error;
  }
});

// Push commits to remote repository
routes.post('/push', async (req, res) => {
  const { project } = req.body;
  
  if (!project) {
    return res.status(400).json({ error: 'Project id is required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);
    await validateGitRepository(projectPath);

    // Get current branch and its upstream remote
    const branch = await getCurrentBranchName(projectPath);

    let remoteName = 'origin'; // fallback
    let remoteBranch = branch; // fallback
    try {
      const { stdout } = await spawnAsync('git', ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], { cwd: projectPath });
      const tracking = stdout.trim();
      remoteName = tracking.split('/')[0]; // Extract remote name
      remoteBranch = tracking.split('/').slice(1).join('/'); // Extract branch name
    } catch (error) {
      preserveWorkspaceFailure(error);
      // No upstream, use fallback
      console.log('No upstream configured, using origin/branch as fallback');
    }

    validateRemoteName(remoteName);
    validateBranchName(remoteBranch);
    const { stdout } = await spawnAsync('git', ['push', remoteName, remoteBranch], { cwd: projectPath });

    res.json({
      success: true,
      output: stdout || 'Push completed successfully',
      remoteName,
      remoteBranch
    });
  } catch (error) {
    console.error('Git push error:', error);
    throw error;
  }
});

// Publish branch to remote (set upstream and push)
routes.post('/publish', async (req, res) => {
  const { project, branch } = req.body;
  
  if (!project || !branch) {
    return res.status(400).json({ error: 'Project id and branch are required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);
    await validateGitRepository(projectPath);

    // Validate branch name
    validateBranchName(branch);

    // Get current branch to verify it matches the requested branch
    const currentBranchName = await getCurrentBranchName(projectPath);

    if (currentBranchName !== branch) {
      return res.status(400).json({
        error: `Branch mismatch. Current branch is ${currentBranchName}, but trying to publish ${branch}`
      });
    }

    // Check if remote exists
    let remoteName = 'origin';
    try {
      const { stdout } = await spawnAsync('git', ['remote'], { cwd: projectPath });
      const remotes = stdout.trim().split('\n').filter(r => r.trim());
      if (remotes.length === 0) {
        return res.status(400).json({
          error: 'No remote repository configured. Add a remote with: git remote add origin <url>'
        });
      }
      remoteName = remotes.includes('origin') ? 'origin' : remotes[0];
    } catch (error) {
      preserveWorkspaceFailure(error);
      return res.status(400).json({
        error: 'No remote repository configured. Add a remote with: git remote add origin <url>'
      });
    }

    // Publish the branch (set upstream and push)
    validateRemoteName(remoteName);
    const { stdout } = await spawnAsync('git', ['push', '--set-upstream', remoteName, branch], { cwd: projectPath });
    
    res.json({ 
      success: true, 
      output: stdout || 'Branch published successfully', 
      remoteName,
      branch
    });
  } catch (error) {
    console.error('Git publish error:', error);
    throw error;
  }
});

// Discard changes for a specific file
routes.post('/discard', async (req, res) => {
  const { project, file } = req.body;
  
  if (!project || !file) {
    return res.status(400).json({ error: 'Project id and file path are required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);
    await validateGitRepository(projectPath);
    const {
      repositoryRootPath,
      repositoryRelativeFilePath,
    } = await resolveRepositoryFilePath({
      projectPath,
      filePath: validateFilePath(file),
      repositoryRootPath: await getRepositoryRootPath(projectPath),
      runCommand: spawnAsync,
    });

    // Check file status to determine correct discard command
    const { stdout: statusOutput } = await spawnAsync(
      'git',
      ['status', '--porcelain', '--', repositoryRelativeFilePath],
      { cwd: repositoryRootPath },
    );

    if (!statusOutput.trim()) {
      return res.status(400).json({ error: 'No changes to discard for this file' });
    }

    const status = statusOutput.substring(0, 2);

    if (status === '??') {
      // Untracked file or directory - delete it
      const filePath = path.join(repositoryRootPath, repositoryRelativeFilePath);
      const stats = await fs.stat(filePath);

      if (stats.isDirectory()) {
        await fs.rm(filePath, { recursive: true, force: true });
      } else {
        await fs.unlink(filePath);
      }
    } else if (status.includes('M') || status.includes('D')) {
      // Modified or deleted file - restore from HEAD
      await spawnAsync('git', ['restore', '--', repositoryRelativeFilePath], { cwd: repositoryRootPath });
    } else if (status.includes('A')) {
      // Added file - unstage it
      await spawnAsync('git', ['reset', 'HEAD', '--', repositoryRelativeFilePath], { cwd: repositoryRootPath });
    }
    
    res.json({ success: true, message: `Changes discarded for ${repositoryRelativeFilePath}` });
  } catch (error) {
    console.error('Git discard error:', error);
    throw error;
  }
});

// Delete untracked file
routes.post('/delete-untracked', async (req, res) => {
  const { project, file } = req.body;
  
  if (!project || !file) {
    return res.status(400).json({ error: 'Project id and file path are required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);
    await validateGitRepository(projectPath);
    const {
      repositoryRootPath,
      repositoryRelativeFilePath,
    } = await resolveRepositoryFilePath({
      projectPath,
      filePath: validateFilePath(file),
      repositoryRootPath: await getRepositoryRootPath(projectPath),
      runCommand: spawnAsync,
    });

    // Check if file is actually untracked
    const { stdout: statusOutput } = await spawnAsync(
      'git',
      ['status', '--porcelain', '--', repositoryRelativeFilePath],
      { cwd: repositoryRootPath },
    );
    
    if (!statusOutput.trim()) {
      return res.status(400).json({ error: 'File is not untracked or does not exist' });
    }

    const status = statusOutput.substring(0, 2);
    
    if (status !== '??') {
      return res.status(400).json({ error: 'File is not untracked. Use discard for tracked files.' });
    }

    // Delete the untracked file or directory
    const filePath = path.join(repositoryRootPath, repositoryRelativeFilePath);
    const stats = await fs.stat(filePath);

    if (stats.isDirectory()) {
      // Use rm with recursive option for directories
      await fs.rm(filePath, { recursive: true, force: true });
      res.json({ success: true, message: `Untracked directory ${repositoryRelativeFilePath} deleted successfully` });
    } else {
      await fs.unlink(filePath);
      res.json({ success: true, message: `Untracked file ${repositoryRelativeFilePath} deleted successfully` });
    }
  } catch (error) {
    console.error('Git delete untracked error:', error);
    throw error;
  }
});

return router;
}
