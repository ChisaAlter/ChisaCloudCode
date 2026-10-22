import fsSync from 'node:fs';
import type { ChildProcess } from 'node:child_process';

import crossSpawn from 'cross-spawn';
import Database from 'better-sqlite3';

import {
  appendFilesInputTag,
  appendImagesInputTag,
  createCompleteMessage,
  createNormalizedMessage,
  flattenPromptForWindowsShell,
  getOpenCodeDatabasePath,
  normalizeAttachmentDescriptors,
  terminateProviderProcess,
} from '@/shared/index.js';
import type { AnyRecord, ProviderRuntimeContext, ProviderRuntimeWriter } from '@/shared/index.js';
import { notifyRunFailed, notifyRunStopped } from '@/modules/notifications/index.js';

import { opencodeWorkspaceRuntime } from './opencode-workspace-runtime.provider.js';

// cross-spawn resolves .cmd shims/PATHEXT on Windows and delegates to
// child_process.spawn everywhere else.
const spawnFunction = crossSpawn;

type OpenCodeRun = {
  process: ChildProcess | null;
  cancelled: boolean;
  stopPromise: Promise<void> | null;
  stopConfirmed: Promise<void>;
  cancel(): Promise<void>;
  done: Promise<void>;
};

const activeOpenCodeRuns = new Map<string, OpenCodeRun>();

/**
 * Maps the UI permission mode onto OpenCode's non-interactive controls.
 *
 * OpenCode has no single "permission mode" flag; each mode uses a different
 * lever of the `opencode run` CLI (verified against v1.17.13):
 * - plan              → the built-in read-only `plan` agent (`--agent plan`).
 * - bypassPermissions → `--auto`, which auto-approves every permission that
 *                       is not explicitly denied in the user's config.
 * - acceptEdits       → the OPENCODE_PERMISSION env var, whose JSON body the
 *                       CLI merges into its permission config. Forcing
 *                       `edit: allow` guarantees file edits go through while
 *                       every other rule stays under the user's own config.
 * - default           → nothing; the user's opencode.json governs. In
 *                       non-interactive `run` mode any `ask` rule is denied.
 *
 * Used by this adapter and its permission-mode tests.
 */
export function resolveOpenCodePermissionOptions(
  permissionMode?: string,
): { args: string[]; env: NodeJS.ProcessEnv } {
  switch (permissionMode) {
    case 'plan':
      return { args: ['--agent', 'plan'], env: {} };
    case 'bypassPermissions':
      return { args: ['--auto'], env: {} };
    case 'acceptEdits':
      return { args: [], env: { OPENCODE_PERMISSION: JSON.stringify({ edit: 'allow' }) } };
    default:
      return { args: [], env: {} };
  }
}

function resolveOpenCodeEffort(
  model: string | undefined,
  effort: unknown,
  modelsDefinition: Awaited<ReturnType<ProviderRuntimeContext['getProviderModels']>> | null,
) {
  const selectedModel = modelsDefinition?.OPTIONS?.find((option) => option.value === model);
  const allowedEfforts = selectedModel?.effort?.values?.map((value) => value.value) || [];
  return typeof effort === 'string' && effort !== 'default' && allowedEfforts.includes(effort)
    ? effort
    : undefined;
}

function readOpenCodeSessionId(event: unknown): string | null {
  if (!event || typeof event !== 'object') {
    return null;
  }

  const record = event as Record<string, unknown>;
  const sessionId = record.sessionID || record.sessionId;
  return typeof sessionId === 'string' ? sessionId : null;
}

function readOpenCodeTokenUsage(sessionId: string | null) {
  const dbPath = getOpenCodeDatabasePath();
  if (!sessionId || !fsSync.existsSync(dbPath)) {
    return null;
  }

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const columns = db.prepare('PRAGMA table_info(session)').all() as { name: string }[];
    const columnNames = new Set(columns.map((column) => column.name));
    const requiredColumns = ['tokens_input', 'tokens_output', 'tokens_reasoning', 'tokens_cache_read', 'tokens_cache_write'];
    if (!requiredColumns.every((column) => columnNames.has(column))) {
      return null;
    }

    const row = db.prepare(`
      SELECT
        tokens_input AS inputTokens,
        tokens_output AS outputTokens,
        tokens_reasoning AS reasoningTokens,
        tokens_cache_read AS cacheReadTokens,
        tokens_cache_write AS cacheWriteTokens
      FROM session
      WHERE id = ?
    `).get(sessionId) as {
      inputTokens: number | null;
      outputTokens: number | null;
      reasoningTokens: number | null;
      cacheReadTokens: number | null;
      cacheWriteTokens: number | null;
    } | undefined;

    if (!row) {
      return null;
    }

    const inputTokens = Number(row.inputTokens || 0) + Number(row.cacheReadTokens || 0);
    const outputTokens = Number(row.outputTokens || 0);
    const used = Number(row.inputTokens || 0)
      + outputTokens
      + Number(row.reasoningTokens || 0)
      + Number(row.cacheReadTokens || 0)
      + Number(row.cacheWriteTokens || 0);
    if (used <= 0) {
      return null;
    }

    return {
      used,
      inputTokens,
      outputTokens,
      breakdown: {
        input: inputTokens,
        output: outputTokens,
      },
    };
  } catch {
    return null;
  } finally {
    if (db) {
      db.close();
    }
  }
}

async function spawnOpenCode(
  command: string,
  options: AnyRecord = {},
  ws: ProviderRuntimeWriter,
  context: ProviderRuntimeContext,
): Promise<void> {
  const { sessionId, projectPath, cwd, model, effort, sessionSummary, images, files, permissionMode } = options;
  const callerSignal = options.abortSignal as AbortSignal | undefined;
  const processKey: string = sessionId || Date.now().toString();
  if (activeOpenCodeRuns.has(processKey)) {
    throw new Error(`OpenCode session "${processKey}" is already running.`);
  }

  let finishRun!: () => void;
  let confirmStop!: () => void;
  const run: OpenCodeRun = {
    process: null,
    cancelled: false,
    stopPromise: null,
    stopConfirmed: new Promise<void>((resolve) => { confirmStop = resolve; }),
    done: new Promise<void>((resolve) => { finishRun = resolve; }),
    cancel() {
      run.cancelled = true;
      const child = run.process;
      if (!child) return Promise.resolve();
      if (!run.stopPromise) {
        const stopping = terminateProviderProcess(child);
        run.stopPromise = stopping;
        void stopping.then(confirmStop, () => {
          // Failure does not release this run or claim model exit. A later explicit
          // stop can retry termination while this lifecycle retains its ownership.
          if (run.stopPromise === stopping) run.stopPromise = null;
        });
      }
      return run.stopPromise;
    },
  };
  // Own the run before model discovery can yield, including its preparation phase.
  let activeKey = processKey;
  activeOpenCodeRuns.set(activeKey, run);
  const cancelFromCaller = () => {
    void run.cancel().catch((error: unknown) => {
      console.error('OpenCode process cancellation failed:', error);
    });
  };
  const releaseRun = () => {
    callerSignal?.removeEventListener('abort', cancelFromCaller);
    if (activeOpenCodeRuns.get(activeKey) === run) activeOpenCodeRuns.delete(activeKey);
  };
  callerSignal?.addEventListener('abort', cancelFromCaller, { once: true });
  if (callerSignal?.aborted) cancelFromCaller();

  let capturedSessionId: string | null = null;
  let sessionCreatedSent = false;
  let stdoutLineBuffer = '';
  let processError: Error | null = null;
  let exitCode: number | null | undefined;
  const finalSessionId = () => sessionId || capturedSessionId || processKey;

  try {
    if (run.cancelled) return;
    const providerSessionId = context.resolveProviderSessionId(sessionId);
    capturedSessionId = providerSessionId;
    const workingDir = cwd || projectPath || process.cwd();

    const registerSession = (nextSessionId: string | null) => {
      if (!nextSessionId || capturedSessionId === nextSessionId) return;
      capturedSessionId = nextSessionId;
      // Direct callers without an app id discover their abort key from CLI output.
      if (!sessionId && activeKey !== nextSessionId) {
        if (activeOpenCodeRuns.get(activeKey) === run) activeOpenCodeRuns.delete(activeKey);
        activeKey = nextSessionId;
        activeOpenCodeRuns.set(activeKey, run);
      }
      ws.setSessionId?.(nextSessionId);
      if (!providerSessionId && !sessionCreatedSent) {
        sessionCreatedSent = true;
        ws.send(createNormalizedMessage({
          kind: 'session_created',
          newSessionId: nextSessionId,
          sessionId: nextSessionId,
          provider: 'opencode',
        }));
      }
    };

    const processOpenCodeOutputLine = (line: string) => {
      if (!line.trim()) return;
      let response: unknown;
      try {
        response = JSON.parse(line);
      } catch {
        ws.send(createNormalizedMessage({
          kind: 'stream_delta',
          content: line,
          sessionId: capturedSessionId || sessionId || null,
          provider: 'opencode',
        }));
        return;
      }
      try {
        registerSession(readOpenCodeSessionId(response));
        for (const message of context.normalizeMessage(response, capturedSessionId || sessionId || null)) {
          ws.send(message);
        }
      } catch (error) {
        const content = error instanceof Error ? error.message : String(error);
        console.error('[OpenCode] Failed to process JSON output:', content);
        ws.send(createNormalizedMessage({
          kind: 'error', content, sessionId: capturedSessionId || sessionId || null, provider: 'opencode',
        }));
      }
    };

    const resolvedModel = await context.resolveResumeModel(sessionId, model);
    if (run.cancelled) return;
    let effortModels: Awaited<ReturnType<ProviderRuntimeContext['getProviderModels']>> | null = null;
    try {
      effortModels = await context.getProviderModels();
    } catch (error) {
      console.warn('[OpenCode] Unable to load provider models for effort validation:', error);
    }
    if (run.cancelled) return;

    const resolvedEffort = resolveOpenCodeEffort(resolvedModel, effort, effortModels);
    // OpenCode owns workspace selection through --dir, not just the process cwd.
    const args = ['run', '--format', 'json', '--dir', workingDir];
    if (providerSessionId) args.push('--session', providerSessionId);
    if (resolvedModel) args.push('--model', resolvedModel);
    if (resolvedEffort) args.push('--variant', resolvedEffort);
    const permissionOptions = resolveOpenCodePermissionOptions(permissionMode);
    args.push(...permissionOptions.args);
    const hasAttachments = normalizeAttachmentDescriptors(images).length > 0
      || normalizeAttachmentDescriptors(files).length > 0;
    if (command.trim() || hasAttachments) {
      // Windows .cmd shims require a newline-free prompt argument.
      const prompt = appendFilesInputTag(appendImagesInputTag(command.trim(), images), files);
      args.push(flattenPromptForWindowsShell(prompt));
    }

    // No asynchronous gap is allowed between the cancellation check and spawn.
    if (run.cancelled) return;
    const child = spawnFunction('opencode', args, {
      cwd: workingDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...permissionOptions.env },
      detached: process.platform !== 'win32',
    });
    run.process = child;
    const closed = new Promise<number | null>((resolve) => {
      // An error does not prove process exit; close is the lifecycle boundary.
      child.on('error', (error) => { processError = error; });
      child.once('close', resolve);
    });
    child.stdout!.on('data', (data: Buffer) => {
      stdoutLineBuffer += data.toString();
      const lines = stdoutLineBuffer.split(/\r?\n/);
      stdoutLineBuffer = lines.pop() || '';
      lines.forEach((line) => processOpenCodeOutputLine(line.trim()));
    });
    child.stderr!.on('data', (data: Buffer) => {
      const content = data.toString();
      if (content.trim()) {
        ws.send(createNormalizedMessage({
          kind: 'error', content, sessionId: capturedSessionId || sessionId || null, provider: 'opencode',
        }));
      }
    });
    child.stdin!.end();
    exitCode = await closed;
    if (stdoutLineBuffer.trim()) processOpenCodeOutputLine(stdoutLineBuffer.trim());
    if (run.cancelled) {
      // A closed CLI pipe is insufficient if a shell descendant still owns work.
      await run.stopConfirmed;
      return;
    }
    const tokenBudget = readOpenCodeTokenUsage(capturedSessionId);
    if (tokenBudget) {
      ws.send(createNormalizedMessage({
        kind: 'status', text: 'token_budget', tokenBudget, sessionId: finalSessionId(), provider: 'opencode',
      }));
    }
    if (processError) throw processError;
    if (exitCode !== 0) {
      throw new Error(exitCode === null ? 'OpenCode CLI process was terminated' : `OpenCode CLI exited with code ${exitCode}`);
    }
    notifyRunStopped({
      userId: ws.userId || null,
      provider: 'opencode', sessionId: finalSessionId(), sessionName: sessionSummary, stopReason: 'completed',
    });
    // A terminal event may immediately admit a queued successor on this session.
    releaseRun();
    ws.send(createCompleteMessage({ provider: 'opencode', sessionId: finalSessionId(), exitCode }));
  } catch (error) {
    if (run.cancelled) {
      if (run.process) await run.stopConfirmed;
      return;
    }
    let content = error instanceof Error ? error.message : String(error);
    if (processError || exitCode === 127 || exitCode === null) {
      if (!await context.isProviderInstalled()) {
        content = 'OpenCode CLI is not installed. Install it from https://opencode.ai/docs/';
      }
      if (run.cancelled) {
        if (run.process) await run.stopConfirmed;
        return;
      }
    }
    ws.send(createNormalizedMessage({
      kind: 'error', content, sessionId: finalSessionId(), provider: 'opencode',
    }));
    notifyRunFailed({
      userId: ws.userId || null,
      provider: 'opencode', sessionId: finalSessionId(), sessionName: sessionSummary, error: content,
    });
    releaseRun();
    ws.send(createCompleteMessage({ provider: 'opencode', sessionId: finalSessionId(), exitCode: exitCode ?? 1 }));
    throw error;
  } finally {
    try {
      if (run.cancelled) {
        // Model exit is separate from terminal completion, which belongs to chat.abort.
        ws.send(createNormalizedMessage({
          kind: 'status', text: 'model_stopped', canInterrupt: false,
          sessionId: finalSessionId(), provider: 'opencode',
        }));
      }
    } finally {
      releaseRun();
      finishRun();
    }
  }
}

async function abortOpenCodeSession(sessionId: string): Promise<boolean> {
  const run = activeOpenCodeRuns.get(sessionId);
  if (!run) return false;
  await run.cancel();
  // Preparation must settle without spawning, or the existing child must close.
  // Never look the session up again: a later run cannot satisfy this cancellation.
  await run.done;
  return true;
}

/** Consumed by OpenCodeProvider to run and cancel one CLI lifecycle per session. */
export const opencodeRuntime = {
  run: (command: string, options: AnyRecord, writer: ProviderRuntimeWriter, context: ProviderRuntimeContext) => context.runProcess
    ? opencodeWorkspaceRuntime.run(command, options, writer, context)
    : spawnOpenCode(command, options, writer, context),
  async abort(sessionId: string) {
    return await opencodeWorkspaceRuntime.abort(sessionId) || await abortOpenCodeSession(sessionId);
  },
};
