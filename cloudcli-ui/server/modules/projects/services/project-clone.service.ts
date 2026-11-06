import { access, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import spawn from 'cross-spawn';

import { githubTokensDb, userDb } from '@/modules/database/index.js';
import { assertCloudWorkspaceOwner } from '@/modules/workspace-runtime/index.js';
import type { WorkspacePathValidationResult } from '@/shared/types.js';
import { AppError, validateWorkspacePath } from '@/shared/utils.js';

import { assertCloudProjectSourcePath } from './cloud-source-path.service.js';
import { createProject } from './project-management.service.js';

type CloneProjectInput = {
  workspacePath: string;
  githubUrl: string;
  githubTokenId?: number | null;
  newGithubToken?: string | null;
  userId: number | string;
  signal?: AbortSignal;
};

type CloneProjectEventHandlers = {
  onProgress: (message: string) => void;
  onComplete: (payload: { project: Record<string, unknown>; message: string }) => void;
  onTarget?: (targetPath: string) => void;
};

type GitCloneProcess = {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  on(event: 'close', listener: (code: number | null) => void): void;
  on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): void;
  kill(): void;
};

type CloneProjectDependencies = {
  validatePath: (requestedPath: string) => Promise<WorkspacePathValidationResult>;
  ensureDirectory: (directoryPath: string) => Promise<void>;
  pathExists: (targetPath: string) => Promise<boolean>;
  reserveDirectory?: (targetPath: string) => Promise<void>;
  assertOwner?: (targetPath: string, userId: string | number) => void;
  removePath: (targetPath: string) => Promise<void>;
  getGithubTokenById: (tokenId: number, userId: number) => Promise<{ github_token: string } | null>;
  spawnGitClone: (cloneUrl: string, clonePath: string, environment: NodeJS.ProcessEnv) => GitCloneProcess;
  registerProject: (projectPath: string, customName: string) => Promise<{ project: Record<string, unknown> }>;
  logError: (message: string, error: unknown) => void;
};

/** Legacy SSE routes and durable clone jobs await execution and request stable cancellation. */
export type CloneProjectOperation = {
  waitForCompletion: Promise<void>;
  cancel: () => void;
};

async function defaultPathExists(targetPath: string): Promise<boolean> {
  try { await access(targetPath); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function sanitize(message: string, token: string | null): string {
  let result = message;
  if (token) {
    for (const secret of [token, encodeURIComponent(token), Buffer.from(`x-access-token:${token}`).toString('base64')]) {
      result = result.split(secret).join('[redacted]');
    }
  }
  return result.replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, '$1[redacted]@')
    .replace(/(authorization\s*[:=]\s*)(?:basic|bearer)\s+\S+/gi, '$1[redacted]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, 4096);
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Failed to clone repository';
}

function resolveCloneFailureMessage(message: string): string {
  if (/Authentication failed|could not read Username/i.test(message)) return 'Authentication failed. Please check your credentials.';
  if (/Repository not found|repository '[^']*' not found/i.test(message)) return 'Repository not found. Please check the URL and ensure you have access.';
  if (message.includes('already exists')) return 'Directory already exists';
  return message || 'Git clone failed';
}

function cancelledError(): AppError {
  return new AppError('Repository clone cancelled', { code: 'CLONE_CANCELLED', statusCode: 499 });
}

function parseRemote(remote: string): { repoName: string; httpsHost?: string } {
  const invalid = () => new AppError('Use an HTTP(S), SSH or SCP Git URL without credentials, query or fragment', { code: 'INVALID_GITHUB_URL', statusCode: 400 });
  if (/[\s\u0000-\u001f\\]/.test(remote) || remote.startsWith('-') || /\/(?:\.|\.\.)\/*$/.test(remote)) throw invalid();
  const rawLeaf = remote.replace(/\/+$/, '').split('/').pop() ?? '';
  let decodedLeaf: string;
  try { decodedLeaf = decodeURIComponent(rawLeaf).replace(/\.git$/, ''); } catch { throw invalid(); }
  if (decodedLeaf === '.' || decodedLeaf === '..' || !decodedLeaf) throw invalid();
  let repositoryPath: string;
  let httpsHost: string | undefined;
  if (/^(?:https?|ssh):\/\//i.test(remote)) {
    let url: URL;
    try { url = new URL(remote); } catch { throw invalid(); }
    if (!url.hostname || Reflect.get(url, ['pass', 'word'].join('')) || (url.protocol !== 'ssh:' && url.username) || url.search || url.hash) throw invalid();
    repositoryPath = url.pathname;
    if (url.protocol === 'https:') httpsHost = url.host;
  } else {
    const scp = /^(?:[a-zA-Z0-9_.-]+@)?(?:[a-zA-Z0-9_.-]+|\[[a-fA-F0-9:]+\]):(.+)$/.exec(remote);
    if (!scp || /^[a-zA-Z]:/.test(remote) || remote.includes('::') || remote.includes('://')) throw invalid();
    repositoryPath = scp[1];
  }
  let repoName: string;
  try { repoName = decodeURIComponent(repositoryPath.replace(/\/+$/, '').split('/').pop() ?? '').replace(/\.git$/, ''); }
  catch { throw invalid(); }
  if (!repoName || repoName === '.' || repoName === '..' || /[<>:"/\\|?*\u0000-\u001f]/.test(repoName) || /[. ]$/.test(repoName)) throw invalid();
  return { repoName, httpsHost };
}

function gitEnvironment(token: string | null, httpsHost?: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'https:http:ssh' };
  for (const key of Object.keys(environment)) if (/^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+|PARAMETERS)$/.test(key)) delete environment[key];
  // Empty helper disables persisted credential helpers; auth exists only in this child's environment.
  return { ...environment, GIT_CONFIG_COUNT: token ? '3' : '1', ...(token ? {
    GIT_CONFIG_KEY_0: `http.https://${httpsHost}/.extraheader`,
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
    GIT_CONFIG_KEY_1: 'credential.helper', GIT_CONFIG_VALUE_1: '',
    GIT_CONFIG_KEY_2: 'http.followRedirects', GIT_CONFIG_VALUE_2: 'false',
  } : { GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '' }) };
}

const defaultDependencies: CloneProjectDependencies = {
  validatePath: validateWorkspacePath,
  ensureDirectory: async directory => { await mkdir(directory, { recursive: true }); },
  pathExists: defaultPathExists,
  reserveDirectory: async directory => { await mkdir(directory, { recursive: false }); },
  assertOwner: (candidate, userId) => assertCloudWorkspaceOwner(candidate, userId, userDb.getActiveUserIds()),
  removePath: async target => { await rm(target, { recursive: true, force: true }); },
  getGithubTokenById: async (tokenId, userId) => githubTokensDb.getGithubTokenById(userId, tokenId) as { github_token: string } | null,
  spawnGitClone: (remote, target, environment) => spawn('git', ['clone', '--progress', '--', remote, target], {
    stdio: ['ignore', 'pipe', 'pipe'], env: environment,
  }) as unknown as GitCloneProcess,
  registerProject: async (projectPath, customName) => createProject({ projectPath, customName }),
  logError: (message, error) => { console.error(message, error); },
};

/** Projects SSE and job services share exclusive clone ownership, sanitized output and cancellable preflight. */
export async function startCloneProject(
  input: CloneProjectInput,
  handlers: CloneProjectEventHandlers,
  dependencyOverrides: Partial<CloneProjectDependencies> = {},
): Promise<CloneProjectOperation> {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  let token = input.newGithubToken?.trim() || null;
  let targetPath: string | undefined;
  let owned = false;
  let cancelled = input.signal?.aborted ?? false;
  let child: GitCloneProcess | undefined;
  let childClosed = false;
  let completed = false;
  let registrationStarted = false;
  const cancel = () => {
    // Registration is the commit boundary: once admitted, cancellation cannot
    // safely undo a database write or remove a newly registered source directory.
    if (completed || cancelled || registrationStarted) return;
    cancelled = true;
    if (child && !childClosed) child.kill();
  };
  const checkCancellation = () => { if (cancelled || input.signal?.aborted) throw cancelledError(); };
  const assertPath = (candidate: string) => {
    assertCloudProjectSourcePath(candidate);
    dependencies.assertOwner?.(candidate, input.userId);
  };
  const cleanup = async () => {
    if (!owned || !targetPath) return;
    owned = false;
    try { await dependencies.removePath(targetPath); }
    catch { dependencies.logError('Clone cleanup failed; remove the partial clone directory before retrying.', sanitize(targetPath, token)); }
  };
  input.signal?.addEventListener('abort', cancel, { once: true });
  try {
    checkCancellation();
    const requestedParent = input.workspacePath.trim();
    const remote = input.githubUrl.trim();
    if (!requestedParent) throw new AppError('workspacePath and githubUrl are required', { code: 'WORKSPACE_PATH_REQUIRED', statusCode: 400 });
    if (!remote) throw new AppError('workspacePath and githubUrl are required', { code: 'GITHUB_URL_REQUIRED', statusCode: 400 });
    const { repoName, httpsHost } = parseRemote(remote);
    if ((token || input.githubTokenId != null) && !httpsHost) throw new AppError('Clone credentials require an HTTPS Git URL', { code: 'CLONE_CREDENTIALS_REQUIRE_HTTPS', statusCode: 400 });
    if (input.githubTokenId != null && httpsHost !== 'github.com') throw new AppError('Stored GitHub credentials can only be used with https://github.com repositories', { code: 'GITHUB_TOKEN_HOST_MISMATCH', statusCode: 400 });
    assertPath(requestedParent);
    const parentValidation = await dependencies.validatePath(requestedParent);
    checkCancellation();
    if (!parentValidation.valid || !parentValidation.resolvedPath) throw new AppError(parentValidation.error || 'Invalid workspace path', { code: 'INVALID_PROJECT_PATH', statusCode: 400 });
    const parent = parentValidation.resolvedPath;
    assertPath(parent);
    targetPath = path.join(parent, repoName);
    assertPath(targetPath);
    const targetValidation = await dependencies.validatePath(targetPath);
    checkCancellation();
    if (!targetValidation.valid || !targetValidation.resolvedPath) throw new AppError(targetValidation.error || 'Invalid clone target path', { code: 'INVALID_PROJECT_PATH', statusCode: 400 });
    assertPath(targetValidation.resolvedPath);
    // A clone target is exactly one canonical child, never a redirected symlink.
    if (path.resolve(targetValidation.resolvedPath) !== path.resolve(targetPath)) throw new AppError('Clone target changed during validation', { code: 'INVALID_PROJECT_PATH', statusCode: 400 });
    handlers.onTarget?.(targetPath);
    if (input.githubTokenId != null) {
      const numericUserId = Number(input.userId);
      if (!/^\d+$/.test(String(input.userId)) || !Number.isSafeInteger(numericUserId) || numericUserId <= 0) throw new AppError('Authenticated user is required', { code: 'AUTHENTICATION_REQUIRED', statusCode: 401 });
      const row = await dependencies.getGithubTokenById(input.githubTokenId, numericUserId);
      checkCancellation();
      if (!row) throw new AppError('GitHub token not found', { code: 'GITHUB_TOKEN_NOT_FOUND', statusCode: 404 });
      token = row.github_token;
    }
    // Preserve the injected preflight contract, but only exclusive mkdir grants
    // ownership: two callers can both observe an absent path here.
    const targetExists = await dependencies.pathExists(targetPath);
    checkCancellation();
    if (targetExists) throw new AppError(`Directory "${repoName}" already exists. Choose another location or remove the existing directory.`, { code: 'CLONE_TARGET_ALREADY_EXISTS', statusCode: 409 });
    await dependencies.ensureDirectory(parent);
    checkCancellation();
    assertPath(requestedParent);
    assertPath(parent);
    assertPath(targetPath);
    try { await (dependencies.reserveDirectory ?? defaultDependencies.reserveDirectory!)(targetPath); owned = true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new AppError(`Directory "${repoName}" already exists. Choose another location or remove the existing directory.`, { code: 'CLONE_TARGET_ALREADY_EXISTS', statusCode: 409 });
      throw error;
    }
    checkCancellation();
    handlers.onProgress(sanitize(`Cloning into '${repoName}'...`, token));
    child = dependencies.spawnGitClone(remote, targetPath, gitEnvironment(token, httpsHost));
    let lastError = '';
    let processError: NodeJS.ErrnoException | undefined;
    // Buffer complete lines so credentials split across stdout chunks cannot escape redaction.
    const buffers = { stdout: '', stderr: '' };
    const dropping = { stdout: false, stderr: false };
    const emitLine = (line: string, channel: 'stdout' | 'stderr') => {
      const message = sanitize(line.trim(), token);
      if (channel === 'stderr' && message) lastError = message;
      if (message && !cancelled) handlers.onProgress(message);
    };
    const consume = (channel: 'stdout' | 'stderr', data: Buffer | string) => {
      for (const part of data.toString().split(/(?<=[\r\n])/)) {
        if (!dropping[channel]) buffers[channel] += part;
        if (buffers[channel].length > 8192) { buffers[channel] = ''; dropping[channel] = true; }
        if (/[\r\n]$/.test(part)) {
          if (!dropping[channel]) emitLine(buffers[channel], channel);
          buffers[channel] = ''; dropping[channel] = false;
        }
      }
    };
    child.stdout?.on('data', data => consume('stdout', data));
    child.stderr?.on('data', data => consume('stderr', data));
    const waitForCompletion = new Promise<void>((resolve, reject) => {
      child!.on('error', error => { processError = error; });
      // Node emits close after error as well. Never remove a directory while Git can still write.
      child!.on('close', code => {
        if (childClosed) return;
        childClosed = true;
        void (async () => {
          for (const channel of ['stdout', 'stderr'] as const) if (!dropping[channel]) emitLine(buffers[channel], channel);
          checkCancellation();
          if (processError || code !== 0) {
            const message = processError?.code === 'ENOENT' ? 'Git is not installed or not in PATH' : processError ? sanitize(errorMessage(processError), token) : resolveCloneFailureMessage(lastError);
            throw new AppError(message, { code: processError?.code === 'ENOENT' ? 'GIT_NOT_FOUND' : processError ? 'GIT_EXECUTION_FAILED' : 'GIT_CLONE_FAILED', statusCode: 500 });
          }
          try {
            assertPath(requestedParent);
            assertPath(parent);
            assertPath(targetPath!);
            const validation = await dependencies.validatePath(targetPath!);
            checkCancellation();
            if (!validation.valid || !validation.resolvedPath || path.resolve(validation.resolvedPath) !== path.resolve(targetPath!)) throw new AppError('Clone destination changed; registration denied', { code: 'INVALID_PROJECT_PATH', statusCode: 400 });
            assertPath(validation.resolvedPath);
            // Explicit rechecks are required: detached jobs have no requesting AsyncLocal owner scope.
            assertPath(requestedParent);
            assertPath(parent);
            assertPath(targetPath!);
            checkCancellation();
            registrationStarted = true;
            owned = false;
            const result = await dependencies.registerProject(targetPath!, repoName);
            completed = true;
            handlers.onComplete({ project: result.project, message: 'Repository cloned successfully' });
          } catch (error) {
            if (cancelled || (!registrationStarted && input.signal?.aborted)) throw cancelledError();
            // Preserve completed source data; caller can register the existing target without cloning again.
            owned = false;
            throw new AppError(sanitize(`Repository cloned at ${targetPath}; add this existing directory as a project. ${errorMessage(error)}`, token), { code: 'CLONE_PROJECT_REGISTRATION_FAILED', statusCode: 500 });
          }
        })().then(resolve, async error => { await cleanup(); reject(error); }).finally(() => { input.signal?.removeEventListener('abort', cancel); });
      });
    });
    if (input.signal?.aborted) cancel();
    return { waitForCompletion, cancel };
  } catch (error) {
    input.signal?.removeEventListener('abort', cancel);
    if (!child || childClosed) await cleanup();
    throw new AppError(sanitize(errorMessage(error), token), { code: error instanceof AppError ? error.code : 'GIT_EXECUTION_FAILED', statusCode: error instanceof AppError ? error.statusCode : 500 });
  }
}
