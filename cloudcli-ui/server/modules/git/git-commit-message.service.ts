import path from 'node:path';

import { AppError } from '@/shared/index.js';
import type { ProviderRunFunction, ProviderRuntimeWriter, WorkspaceGitFileSystem } from '@/shared/index.js';

import { withGitReadOperation } from './git-operation.service.js';
import { resolveRepositoryFilePath } from './git-read.service.js';

type CommitMessageDependencies = {
  resolveProjectPath(projectId: string): Promise<string>;
  validateRepository(projectPath: string): Promise<void>;
  repositoryHasCommits(projectPath: string): Promise<boolean>;
  runCommand(command: 'git', args: string[], options: { cwd: string }): Promise<{ stdout: string }>;
  fileSystem: Pick<WorkspaceGitFileSystem, 'stat' | 'readFile'>;
  queryClaude: ProviderRunFunction;
  queryCursor: ProviderRunFunction;
};

function cleanCommitMessage(text: string): string {
  let cleaned = text.trim()
    .replace(/```[a-z]*\r?\n/g, '')
    .replace(/```/g, '')
    .replace(/^#+\s*/gm, '')
    .replace(/^["']|["']$/g, '')
    .replace(/\n{3,}/g, '\n\n');
  const conventional = cleaned.match(/(feat|fix|docs|style|refactor|perf|test|build|ci|chore)(\(.+?\))?:.+/s);
  if (conventional) cleaned = cleaned.slice(cleaned.indexOf(conventional[0]));
  return cleaned.trim();
}

function createResponseCollector(userId: ProviderRuntimeWriter['userId']) {
  const finalized: string[] = [];
  const seenTextIds = new Set<string>();
  let pendingText = '';
  let failure: AppError | undefined;
  const fail = (record: Record<string, unknown>, fallback: string) => {
    const message = typeof record.content === 'string' ? record.content
      : typeof record.error === 'string' ? record.error : typeof record.message === 'string' ? record.message : fallback;
    failure ??= new AppError(message || fallback, {
      code: typeof record.code === 'string' ? record.code : 'PROVIDER_RUN_FAILED',
      statusCode: typeof record.statusCode === 'number' && record.statusCode >= 400 && record.statusCode <= 599 ? record.statusCode : 503,
    });
  };
  const acceptText = (text: string, id?: unknown) => {
    if (typeof id === 'string' && seenTextIds.has(id)) return;
    if (typeof id === 'string') seenTextIds.add(id);
    finalized.push(text);
    // Providers may send both the streaming deltas and the completed text block.
    pendingText = '';
  };
  const writer: ProviderRuntimeWriter = {
    userId,
    setSessionId() {},
    send(data) {
      let parsed: unknown;
      try { parsed = typeof data === 'string' ? JSON.parse(data) : data; }
      catch { fail({}, 'The provider returned an invalid response while generating the commit message.'); return; }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        fail({}, 'The provider returned an invalid response while generating the commit message.'); return;
      }
      const record = parsed as Record<string, unknown>;
      if (record.kind === 'error' || record.type === 'error' || record.type === 'claude-error' || record.type === 'cursor-error'
        || (record.kind === 'complete' && (record.isError === true || record.success === false || record.aborted === true || (typeof record.exitCode === 'number' && record.exitCode !== 0)))) {
        fail(record, 'Commit message generation failed.'); return;
      }
      if (record.role === 'user') return;
      if (record.kind === 'stream_delta' || record.kind === 'delta') {
        pendingText += typeof record.content === 'string' ? record.content : typeof record.text === 'string' ? record.text : '';
      } else if (record.kind === 'text') {
        const text = typeof record.content === 'string' ? record.content : typeof record.text === 'string' ? record.text : '';
        if (text) acceptText(text, record.id);
      } else if (record.type === 'claude-response' && record.data && typeof record.data === 'object') {
        const response = record.data as Record<string, unknown>;
        const message = response.message && typeof response.message === 'object' ? response.message as Record<string, unknown> : response;
        if (message.role === 'user' || !Array.isArray(message.content)) return;
        const text = message.content.filter(item => item && item.type === 'text' && typeof item.text === 'string').map(item => item.text).join('');
        if (text) acceptText(text, record.id);
      } else if (record.type === 'cursor-output' && typeof record.output === 'string') {
        pendingText += record.output;
      } else if (record.type === 'text' && typeof record.text === 'string') {
        acceptText(record.text, record.id);
      }
    },
  };
  return {
    writer,
    message() {
      if (failure) throw failure;
      const message = cleanCommitMessage(finalized.join('\n\n') + pendingText);
      if (!message) throw new AppError('The provider returned no commit message. Try generating it again.', { code: 'GIT_COMMIT_MESSAGE_EMPTY', statusCode: 502 });
      return message;
    },
  };
}

/** Git routes collect one protected diff snapshot, release it, then ask the provider to summarize with its own read-only admission. */
export function createGitCommitMessageService(dependencies: CommitMessageDependencies) {
  return {
    async generate(input: { projectId: string; files: string[]; provider: 'claude' | 'cursor'; userId?: string | number | null; signal?: AbortSignal }): Promise<string> {
      const { signal } = input;
      signal?.throwIfAborted();
      const projectPath = await dependencies.resolveProjectPath(input.projectId);
      const diffContext = await withGitReadOperation(projectPath, async () => {
        signal?.throwIfAborted();
        await dependencies.validateRepository(projectPath);
        const { stdout } = await dependencies.runCommand('git', ['rev-parse', '--show-toplevel'], { cwd: projectPath });
        const repositoryRootPath = stdout.trim();
        const hasCommits = await dependencies.repositoryHasCommits(projectPath);
        const fragments: string[] = [];
        for (const file of input.files) {
          signal?.throwIfAborted();
          const { repositoryRelativeFilePath } = await resolveRepositoryFilePath({
            projectPath, filePath: file, repositoryRootPath, runCommand: dependencies.runCommand,
          });
          const { stdout: diff } = await dependencies.runCommand('git',
            ['diff', ...(hasCommits ? ['HEAD'] : ['--cached']), '--', repositoryRelativeFilePath], { cwd: repositoryRootPath });
          if (diff) {
            fragments.push(`\n--- ${repositoryRelativeFilePath} ---\n${diff}`);
          } else {
            const filePath = path.join(repositoryRootPath, repositoryRelativeFilePath);
            const stats = await dependencies.fileSystem.stat(filePath);
            if (stats.isDirectory()) fragments.push(`\n--- ${repositoryRelativeFilePath} (new directory) ---\n`);
            else {
              const content = await dependencies.fileSystem.readFile(filePath, 'utf8');
              fragments.push(`\n--- ${repositoryRelativeFilePath} (new file) ---\n${content.slice(0, 1000)}\n`);
            }
          }
        }
        return fragments.join('');
      });
      // The provider must acquire its own workspace after the Git read has fully returned it.
      signal?.throwIfAborted();
      if (await dependencies.resolveProjectPath(input.projectId) !== projectPath) {
        throw new AppError('The selected Git project changed. Refresh it before generating a commit message.', { code: 'WORKSPACE_SELECTION_MISMATCH', statusCode: 409 });
      }
      const prompt = `Generate a conventional commit message for these changes.

REQUIREMENTS:
- Format: type(scope): subject
- Include body explaining what changed and why
- Types: feat, fix, docs, style, refactor, perf, test, build, ci, chore
- Subject under 50 chars, body wrapped at 72 chars
- Focus on user-facing changes
- Consider what is being added AND removed
- Use only the supplied file list and diff. Do not use tools or change files.
- Return ONLY the commit message (no markdown, explanations, or code blocks)

FILES CHANGED:
${input.files.map(file => `- ${file}`).join('\n')}

DIFFS:
${diffContext.slice(0, 4000)}

Generate the commit message:`;
      const collector = createResponseCollector(input.userId);
      const run = input.provider === 'claude' ? dependencies.queryClaude : dependencies.queryCursor;
      await run(prompt, { cwd: projectPath, permissionMode: 'plan', ...(input.provider === 'claude' ? { model: 'sonnet' } : {}), abortSignal: signal }, collector.writer);
      signal?.throwIfAborted();
      return collector.message();
    },
  };
}
