import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import crossSpawn from 'cross-spawn';

import { notifyRunFailed, notifyRunStopped } from '@/modules/notifications/index.js';
import {
  appendFilesInputTag,
  appendImagesInputTag,
  createCompleteMessage,
  createNormalizedMessage,
  flattenPromptForWindowsShell,
  normalizeAttachmentDescriptors,
  terminateProviderProcess,
} from '@/shared/index.js';
import type { AnyRecord, ProviderRuntimeContext, ProviderRuntimeWriter } from '@/shared/index.js';

import { cursorWorkspaceRuntime } from './cursor-workspace-runtime.provider.js';

type CursorRun = {
  key: string;
  process: ChildProcessWithoutNullStreams | null;
  cancelled: boolean;
  cancel(): Promise<void>;
  done: Promise<void>;
};

type CursorProcessExit = {
  code: number | null;
  error: Error | null;
  resultExitCode: number | null;
  sawWorkspaceTrustPrompt: boolean;
};

// A run is registered before model lookup and retained until its last process
// actually closes, including a possible workspace-trust retry.
const activeCursorRuns = new Map<string, CursorRun>();

const WORKSPACE_TRUST_PATTERNS = [
  /workspace trust required/i,
  /do you trust the contents of this directory/i,
  /working with untrusted contents/i,
  /pass --trust,\s*--yolo,\s*or -f/i,
];

function isWorkspaceTrustPrompt(text: string): boolean {
  return WORKSPACE_TRUST_PATTERNS.some((pattern) => pattern.test(text));
}

async function spawnCursor(
  command: string,
  options: AnyRecord,
  ws: ProviderRuntimeWriter,
  context: ProviderRuntimeContext,
): Promise<void> {
  const {
    sessionId,
    projectPath,
    cwd,
    toolsSettings,
    skipPermissions,
    sessionSummary,
    images,
    files,
  } = options;
  const callerSignal = options.abortSignal as AbortSignal | undefined;
  const processKey: string = sessionId || randomUUID();
  if (activeCursorRuns.has(processKey)) {
    throw new Error(`Cursor session ${processKey} is still running or stopping`);
  }

  let capturedSessionId: string | null = null;
  let sessionCreatedSent = false;
  let modelStoppedSent = false;
  let resolveDone!: () => void;
  let resolveStopped!: () => void;
  const stopped = new Promise<void>((resolve) => { resolveStopped = resolve; });
  let stopAttempt: Promise<void> | null = null;
  const run: CursorRun = {
    key: processKey,
    process: null,
    cancelled: false,
    cancel() {
      run.cancelled = true;
      if (stopAttempt) return stopAttempt;
      const cursorProcess = run.process;
      stopAttempt = (cursorProcess ? terminateProviderProcess(cursorProcess) : Promise.resolve())
        .then(() => {
          resolveStopped();
          // Before spawning, preparation must settle before finally can
          // confirm that this cancelled run will never start a process.
          if (cursorProcess) publishModelStopped();
        })
        .catch((error: unknown) => {
          // Keep this run occupied if termination failed. Another explicit
          // abort can retry against the same CLI/group rather than a new run.
          stopAttempt = null;
          throw error;
        });
      return stopAttempt;
    },
    done: new Promise<void>((resolve) => { resolveDone = resolve; }),
  };
  activeCursorRuns.set(run.key, run);
  const publishModelStopped = (): void => {
    if (modelStoppedSent) return;
    modelStoppedSent = true;
    ws.send(createNormalizedMessage({
      kind: 'status',
      text: 'model_stopped',
      canInterrupt: false,
      sessionId: sessionId || capturedSessionId || run.key,
      provider: 'cursor',
    }));
  };
  const cancelFromCaller = () => {
    void run.cancel().catch((error: unknown) => {
      console.error('Cursor process cancellation failed:', error);
    });
  };
  callerSignal?.addEventListener('abort', cancelFromCaller, { once: true });
  if (callerSignal?.aborted) cancelFromCaller();

  try {
    if (run.cancelled) return;
    capturedSessionId = context.resolveProviderSessionId(sessionId);
    const resolvedModel = await context.resolveResumeModel(sessionId, options.model);
    if (run.cancelled) return;

    const settings = toolsSettings || { skipPermissions: false };
    const baseArgs: string[] = [];
    if (capturedSessionId) baseArgs.push(`--resume=${capturedSessionId}`);

    const hasAttachments = normalizeAttachmentDescriptors(images).length > 0
      || normalizeAttachmentDescriptors(files).length > 0;
    if (command.trim() || hasAttachments) {
      // cursor-agent is a .cmd shim on Windows: multiline prompt arguments
      // would otherwise be truncated by cmd.exe.
      const promptWithAttachments = appendFilesInputTag(
        appendImagesInputTag(command, images),
        files,
      );
      baseArgs.push('-p', flattenPromptForWindowsShell(promptWithAttachments));
      if (resolvedModel) baseArgs.push('--model', resolvedModel);
      baseArgs.push('--output-format', 'stream-json');
    }
    if (skipPermissions || settings.skipPermissions) baseArgs.push('-f');

    const workingDir = cwd || projectPath || process.cwd();
    const providerSessionId = capturedSessionId;
    let args = baseArgs;
    let hasRetriedWithTrust = false;

    while (!run.cancelled) {
      const outcome = await new Promise<CursorProcessExit>((resolve) => {
        // cross-spawn resolves Windows .cmd shims; stdio is explicitly piped.
        const cursorProcess = crossSpawn('cursor-agent', args, {
          cwd: workingDir,
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
          env: { ...process.env },
        }) as ChildProcessWithoutNullStreams;
        run.process = cursorProcess;
        let stdoutLineBuffer = '';
        let processError: Error | null = null;
        let resultExitCode: number | null = null;
        let sawWorkspaceTrustPrompt = false;

        const suppressForTrustRetry = (text: string): boolean => {
          if (hasRetriedWithTrust || args.includes('--trust') || !isWorkspaceTrustPrompt(text)) {
            return false;
          }
          sawWorkspaceTrustPrompt = true;
          return true;
        };

        const processOutputLine = (line: string): void => {
          if (!line.trim()) return;
          let response: AnyRecord;
          try {
            response = JSON.parse(line) as AnyRecord;
          } catch {
            if (!suppressForTrustRetry(line)) {
              for (const message of context.normalizeMessage(line, capturedSessionId || sessionId || null)) {
                ws.send(message);
              }
            }
            return;
          }

          switch (response?.type) {
            case 'system':
              if (response.subtype === 'init' && response.session_id && !capturedSessionId) {
                capturedSessionId = response.session_id as string;
                // Direct callers without an app id learn their abort key from
                // the CLI; only this run may remove its previous key.
                if (!sessionId && run.key !== capturedSessionId) {
                  if (activeCursorRuns.get(run.key) === run) activeCursorRuns.delete(run.key);
                  run.key = capturedSessionId;
                  activeCursorRuns.set(run.key, run);
                }
                ws.setSessionId?.(capturedSessionId);
                if (!providerSessionId && !sessionCreatedSent) {
                  sessionCreatedSent = true;
                  ws.send(createNormalizedMessage({
                    kind: 'session_created',
                    newSessionId: capturedSessionId,
                    model: response.model,
                    cwd: response.cwd,
                    sessionId: capturedSessionId,
                    provider: 'cursor',
                  }));
                }
              }
              break;
            case 'assistant':
              if (response.message?.content?.length) {
                for (const message of context.normalizeMessage(response, capturedSessionId || sessionId || null)) {
                  ws.send(message);
                }
              }
              break;
            case 'result':
              // A result is not process exit. Keep the session occupied and
              // cancellable until close, rather than admitting another run.
              resultExitCode = response.subtype === 'success' ? 0 : 1;
              break;
            default:
              break;
          }
        };

        cursorProcess.stdout.on('data', (data: Buffer) => {
          if (run.process !== cursorProcess) return;
          stdoutLineBuffer += data.toString();
          const lines = stdoutLineBuffer.split(/\r?\n/);
          stdoutLineBuffer = lines.pop() || '';
          for (const line of lines) processOutputLine(line.trim());
        });
        cursorProcess.stderr.on('data', (data: Buffer) => {
          if (run.process !== cursorProcess) return;
          const text = data.toString();
          console.error('Cursor CLI stderr:', text);
          if (!suppressForTrustRetry(text)) {
            ws.send(createNormalizedMessage({
              kind: 'error',
              content: text,
              sessionId: capturedSessionId || sessionId || null,
              provider: 'cursor',
            }));
          }
        });
        cursorProcess.on('error', (error: Error) => {
          // An error can also describe a failed kill. It does not prove exit;
          // only close settles this process and releases its run.
          if (run.process === cursorProcess) processError = error;
        });
        cursorProcess.on('close', (code: number | null) => {
          // Keep the last process handle until final settlement: cancellation
          // may still need to terminate its tool group after the CLI closes.
          if (run.process !== cursorProcess) return;
          if (stdoutLineBuffer.trim()) processOutputLine(stdoutLineBuffer.trim());
          resolve({ code, error: processError, resultExitCode, sawWorkspaceTrustPrompt });
        });
        cursorProcess.stdin.end();
      });

      if (run.cancelled) return;
      if (outcome.sawWorkspaceTrustPrompt && outcome.code !== 0
        && !hasRetriedWithTrust && !args.includes('--trust')) {
        hasRetriedWithTrust = true;
        args = [...baseArgs, '--trust'];
        console.log('Retrying Cursor CLI with --trust after workspace trust prompt');
        continue;
      }

      const finalSessionId = sessionId || capturedSessionId || run.key;
      if (outcome.error) {
        const installed = await context.isProviderInstalled();
        if (run.cancelled) return;
        const errorContent = installed
          ? outcome.error.message
          : 'Cursor CLI is not installed. Please install it from https://cursor.com';
        ws.send(createNormalizedMessage({
          kind: 'error', content: errorContent, sessionId: finalSessionId, provider: 'cursor',
        }));
      }

      const exitCode = outcome.error || outcome.resultExitCode === 1 ? 1 : outcome.code;
      // The CLI is closed and preparation has settled. Release before the
      // terminal event so its consumer can immediately start the next turn.
      if (activeCursorRuns.get(run.key) === run) activeCursorRuns.delete(run.key);
      ws.send(createCompleteMessage({ provider: 'cursor', sessionId: finalSessionId, exitCode }));
      if (exitCode === 0) {
        notifyRunStopped({
          userId: ws.userId || null,
          provider: 'cursor',
          sessionId: finalSessionId,
          sessionName: sessionSummary,
          stopReason: 'completed',
        });
        return;
      }
      const failure = outcome.error || new Error(`Cursor CLI exited with code ${outcome.code}`);
      notifyRunFailed({
        userId: ws.userId || null,
        provider: 'cursor',
        sessionId: finalSessionId,
        sessionName: sessionSummary,
        error: failure,
      });
      throw failure;
    }
  } finally {
    try {
      if (run.cancelled) {
        // A failed termination attempt leaves this pending and the run
        // reserved; abort reports the failure and can retry the same group.
        await stopped;
        // This point follows the last process close (or cancellation before
        // spawning). The gateway still owns the terminal aborted complete.
        publishModelStopped();
        notifyRunStopped({
          userId: ws.userId || null,
          provider: 'cursor',
          sessionId: sessionId || capturedSessionId || run.key,
          sessionName: sessionSummary,
          stopReason: 'aborted',
        });
      }
    } finally {
      callerSignal?.removeEventListener('abort', cancelFromCaller);
      if (activeCursorRuns.get(run.key) === run) activeCursorRuns.delete(run.key);
      resolveDone();
    }
  }
}

async function abortCursorSession(sessionId: string): Promise<boolean> {
  const run = activeCursorRuns.get(sessionId);
  if (!run) return false;
  await run.cancel();
  // Capture this run before waiting: a later session run must never be the
  // target of an earlier stop or be removed by its completion.
  await run.done;
  return true;
}

/** Used by CursorProvider to execute and cancel one app-session run. */
export const cursorRuntime = {
  run: (command: string, options: AnyRecord, writer: ProviderRuntimeWriter, context: ProviderRuntimeContext) => context.runProcess
    ? cursorWorkspaceRuntime.run(command, options, writer, context)
    : spawnCursor(command, options, writer, context),
  async abort(sessionId: string) {
    return await cursorWorkspaceRuntime.abort(sessionId) || await abortCursorSession(sessionId);
  },
};
