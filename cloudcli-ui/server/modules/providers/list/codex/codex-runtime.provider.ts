/**
 * OpenAI Codex SDK Integration
 * =============================
 *
 * This module provides integration with the OpenAI Codex SDK for non-interactive
 * chat sessions. It mirrors the Claude runtime adapter for consistency.
 *
 * ## Usage
 *
 * - codexRuntime.run(command, options, writer, context) - Execute a streamed prompt
 * - codexRuntime.abort(sessionId) - Cancel an active session
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { ChildProcess } from 'node:child_process';
import { channel } from 'node:diagnostics_channel';

import { Codex } from '@openai/codex-sdk';
import type { ModelReasoningEffort, Thread, ThreadEvent, ThreadOptions } from '@openai/codex-sdk';

import {
  appendFilesInputTag,
  buildCodexInputItems,
  normalizeImageDescriptors,
  createCompleteMessage,
  createNormalizedMessage,
} from '@/shared/index.js';
import { notifyRunFailed, notifyRunStopped } from '@/modules/notifications/index.js';
import type { AnyRecord, ProviderRuntimeContext, ProviderRuntimeWriter } from '@/shared/index.js';

type ActiveCodexSession = {
  status: 'running' | 'stopping' | 'completed';
  abortController: AbortController;
  abortRequested: boolean;
  processes: ChildProcess[];
  done: Promise<void>;
};

const activeCodexSessions = new Map<string, ActiveCodexSession>();
const codexSpawnScope = new AsyncLocalStorage<ActiveCodexSession>();

// The SDK exposes no spawn callback. Node's public channel observes only the
// child created while advancing this run's SDK iterator, without replacing spawn.
channel('child_process').subscribe((message) => {
  const session = codexSpawnScope.getStore();
  if (session) session.processes.push((message as { process: ChildProcess }).process);
});

async function waitForCodexProcesses(session: ActiveCodexSession): Promise<void> {
  await Promise.all(session.processes.map(async (child) => {
    // SDK cleanup removes every listener, so attach this waiter only after its
    // iterator has settled. An exit code/signal already proves OS process exit;
    // a missing pid means spawn failed before a process was created.
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const onClose = () => { child.off('error', onError); resolve(); };
      // A failed signal is not exit: retain the close barrier and its run.
      const onError = (error: Error) => { console.error('[Codex] Process did not confirm exit:', error); };
      child.once('close', onClose);
      child.on('error', onError);
    });
  }));
}

/**
 * Item types whose in-flight updates are worth showing. These are the ones a
 * user waits on — a shell command's output, an MCP call, and the running plan.
 */
const PROGRESSIVE_CODEX_ITEM_TYPES = new Set(['command_execution', 'mcp_tool_call', 'todo_list']);

function readUsageNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function extractCodexTokenBudget(event: AnyRecord) {
  const info = event?.info || event?.payload?.info || event?.usage?.info;
  const usage = info?.total_token_usage || event?.usage?.total_token_usage || event?.usage;
  if (!usage || typeof usage !== 'object') {
    return null;
  }

  const inputTokens = readUsageNumber(usage.input_tokens);
  const outputTokens = readUsageNumber(usage.output_tokens);
  const used = readUsageNumber(usage.total_tokens) || inputTokens + outputTokens;

  return {
    used,
    total: readUsageNumber(info?.model_context_window || event?.usage?.model_context_window) || 200000,
    inputTokens,
    outputTokens,
    breakdown: {
      input: inputTokens,
      output: outputTokens,
    },
  };
}

/**
 * Transform Codex SDK event to WebSocket message format
 * @param {object} event - SDK event
 * @returns {object} - Transformed event for WebSocket
 */
function transformCodexEvent(event: AnyRecord): AnyRecord {
  // Map SDK event types to a consistent format
  switch (event.type) {
    case 'item.started':
    case 'item.updated':
    case 'item.completed':
      const item = event.item;
      if (!item) {
        return { type: event.type, item: null };
      }

      // `itemId` is the SDK's stable per-item id. Carrying it through means an
      // in-progress row and its later completion normalize to the same message
      // id, so the client updates one transcript entry instead of appending a
      // new one for every progress tick.
      switch (item.type) {
        case 'agent_message':
          return {
            type: 'item',
            itemType: 'agent_message',
            itemId: item.id,
            message: {
              role: 'assistant',
              content: item.text
            }
          };

        case 'reasoning':
          return {
            type: 'item',
            itemType: 'reasoning',
            itemId: item.id,
            message: {
              role: 'assistant',
              content: item.text,
              isReasoning: true
            }
          };

        case 'command_execution':
          return {
            type: 'item',
            itemType: 'command_execution',
            itemId: item.id,
            command: item.command,
            output: item.aggregated_output,
            exitCode: item.exit_code,
            status: item.status
          };

        case 'file_change':
          return {
            type: 'item',
            itemType: 'file_change',
            itemId: item.id,
            changes: item.changes,
            status: item.status
          };

        case 'mcp_tool_call':
          return {
            type: 'item',
            itemType: 'mcp_tool_call',
            itemId: item.id,
            server: item.server,
            tool: item.tool,
            arguments: item.arguments,
            result: item.result,
            error: item.error,
            status: item.status
          };

        case 'web_search':
          return {
            type: 'item',
            itemType: 'web_search',
            itemId: item.id,
            query: item.query
          };

        case 'todo_list':
          return {
            type: 'item',
            itemType: 'todo_list',
            itemId: item.id,
            items: item.items
          };

        case 'error':
          return {
            type: 'item',
            itemType: 'error',
            itemId: item.id,
            message: {
              role: 'error',
              content: item.message
            }
          };

        default:
          return {
            type: 'item',
            itemType: item.type,
            itemId: item.id,
            item: item
          };
      }

    case 'turn.started':
      return {
        type: 'turn_started'
      };

    case 'turn.completed':
      return {
        type: 'turn_complete',
        usage: event.usage
      };

    case 'turn.failed':
      return {
        type: 'turn_failed',
        error: event.error
      };

    case 'thread.started':
      return {
        type: 'thread_started',
        threadId: event.thread_id || event.id
      };

    case 'error':
      return {
        type: 'error',
        message: event.message
      };

    default:
      return {
        type: event.type,
        data: event
      };
  }
}

/**
 * Map permission mode to Codex SDK options
 * @param {string} permissionMode - 'default', 'acceptEdits', or 'bypassPermissions'
 * @returns {object} - { sandboxMode, approvalPolicy }
 */
function mapPermissionModeToCodexOptions(permissionMode: string): Pick<ThreadOptions, 'sandboxMode' | 'approvalPolicy'> {
  switch (permissionMode) {
    case 'acceptEdits':
      return {
        sandboxMode: 'workspace-write',
        approvalPolicy: 'never'
      };
    case 'bypassPermissions':
      return {
        sandboxMode: 'danger-full-access',
        approvalPolicy: 'never'
      };
    case 'default':
    default:
      return {
        sandboxMode: 'workspace-write',
        // Current Codex CLI versions reject the retired `untrusted` policy.
        // Keep sandboxing enabled; exec cannot grant interactive approval requests.
        approvalPolicy: 'on-request'
      };
  }
}

/**
 * Execute a Codex query with streaming
 * @param {string} command - The prompt to send
 * @param {object} options - Options including cwd, sessionId, model, permissionMode
 * @param {WebSocket|object} ws - WebSocket connection or response writer
 */
async function queryCodex(
  command: string,
  options: AnyRecord = {},
  ws: ProviderRuntimeWriter,
  context: ProviderRuntimeContext,
) {
  const {
    sessionId,
    sessionSummary,
    cwd,
    projectPath,
    model,
    effort,
    images,
    files,
    permissionMode = 'default'
  } = options;

  // Callers pass the stable app session id; the SDK resumes threads with the
  // provider-native id recorded on the session row.
  const providerSessionId = context.resolveProviderSessionId(sessionId);

  const workingDirectory = cwd || projectPath || process.cwd();
  const { sandboxMode, approvalPolicy } = mapPermissionModeToCodexOptions(permissionMode);

  let thread: Thread | null = null;
  let events: AsyncGenerator<ThreadEvent> | null = null;
  // Provider-native thread id (starts as the resume id, or is captured from
  // the stream for brand-new sessions).
  let capturedSessionId = providerSessionId;
  let sessionCreatedSent = false;
  let terminalFailure: { message: string } | null = null;
  // Codex surfaces API failures as streamed error items/turn.failed events, and
  // then the SDK also throws "Codex Exec exited with code N: <stderr>" once the
  // process dies. Showing both means the rendered error is followed by a raw
  // stderr dump of unrelated CLI log lines, so the thrown wrapper is dropped
  // when the stream already reported the failure.
  let errorSurfaced = false;
  const abortController = new AbortController();
  let finishRun!: () => void;
  const lifecycle: ActiveCodexSession = {
    status: 'running',
    abortController,
    abortRequested: false,
    processes: [],
    done: new Promise<void>((resolve) => { finishRun = resolve; }),
  };
  // Session-map key: the app session id when the caller supplied one, else
  // the provider-native thread id once captured (legacy/direct API callers).
  const sessionKey = () => sessionId || capturedSessionId || null;
  const registerSession = () => {
    const key = sessionKey();
    if (!key) return;
    const previous = activeCodexSessions.get(key);
    if (previous && previous !== lifecycle && previous.status !== 'completed') {
      throw new Error(`Codex session "${key}" is still running or stopping.`);
    }
    activeCodexSessions.set(key, lifecycle);
  };
  registerSession();
  const callerSignal = options.abortSignal as AbortSignal | undefined;
  const cancelFromCaller = () => {
    lifecycle.status = 'stopping';
    abortController.abort(callerSignal?.reason);
  };
  if (callerSignal?.aborted) cancelFromCaller();
  else callerSignal?.addEventListener('abort', cancelFromCaller, { once: true });

  let stoppedExecution: Promise<Error | null> | null = null;
  const settleExecution = () => stoppedExecution ??= (async () => {
    let iteratorError: Error | null = null;
    try {
      if (events) await codexSpawnScope.run(lifecycle, () => events!.return(undefined));
    } catch (error) {
      // Iterator rejection (including AbortError) is separate from process
      // exit. Preserve it as a run result, not a rejected cleanup barrier.
      iteratorError = error instanceof Error ? error : new Error(String(error));
    }
    await waitForCodexProcesses(lifecycle);
    return iteratorError;
  })();

  try {
    abortController.signal.throwIfAborted();
    const resolvedModel = await context.resolveResumeModel(sessionId, model);
    abortController.signal.throwIfAborted();
    const catalog = await context.getProviderModels();
    abortController.signal.throwIfAborted();
    const selectedModel = catalog.OPTIONS.find((option) => option.value === resolvedModel) || null;
    const allowedEfforts = selectedModel?.effort?.values?.map((value) => value.value) || [];
    const resolvedEffort = typeof effort === 'string' && effort !== 'default' && allowedEfforts.includes(effort)
      ? effort as ModelReasoningEffort
      : undefined;
    const codex = new Codex();

    const threadOptions: ThreadOptions = {
      workingDirectory,
      skipGitRepoCheck: true,
      sandboxMode,
      approvalPolicy,
      model: resolvedModel,
      modelReasoningEffort: resolvedEffort,
    };

    if (providerSessionId) {
      thread = codex.resumeThread(providerSessionId, threadOptions);
    } else {
      thread = codex.startThread(threadOptions);
    }

    // Execute with streaming. Turns with image attachments send structured
    // input items so Codex reads the images from their local asset paths.
    const promptWithFiles = appendFilesInputTag(command, files);
    const turnInput = normalizeImageDescriptors(images).length > 0
      ? buildCodexInputItems(promptWithFiles, images, workingDirectory)
      : promptWithFiles;
    const streamedTurn = await thread.runStreamed(turnInput, {
      signal: abortController.signal
    });
    events = streamedTurn.events;
    abortController.signal.throwIfAborted();

    for (;;) {
      const next = await codexSpawnScope.run(lifecycle, () => events!.next());
      if (next.done) break;
      const event = next.value;
      // Capture thread/session id lazily from the stream (Codex emits this asynchronously).
      if (event.type === 'thread.started') {
        const discoveredSessionId = event.thread_id || null;
        if (discoveredSessionId && !capturedSessionId) {
          capturedSessionId = discoveredSessionId;
          registerSession();

          if (ws.setSessionId && typeof ws.setSessionId === 'function') {
            ws.setSessionId(capturedSessionId);
          }

          if (!providerSessionId && !sessionCreatedSent) {
            sessionCreatedSent = true;
            sendMessage(ws, createNormalizedMessage({ kind: 'session_created', newSessionId: capturedSessionId, sessionId: capturedSessionId, provider: 'codex' }));
          }
        }
      }

      // Drain the SDK after cancellation instead of returning from its iterator
      // early: cancellation is not confirmed until the real process also exits.
      if (abortController.signal.aborted) {
        continue;
      }

      // Progress events used to be dropped, so a long shell command or a
      // growing plan showed nothing until it finished. They are forwarded now;
      // every item carries a stable id, so the client replaces the row it
      // already has rather than stacking a new one per tick. Text items are
      // still skipped mid-flight because assistant prose arrives through the
      // separate streaming path.
      if (
        (event.type === 'item.started' || event.type === 'item.updated')
        && !PROGRESSIVE_CODEX_ITEM_TYPES.has(event.item?.type)
      ) {
        continue;
      }

      const transformed = transformCodexEvent(event);
      if (transformed.type === 'error' || transformed.itemType === 'error') {
        errorSurfaced = true;
      }

      // Normalize the transformed event into NormalizedMessage(s) via adapter
      const normalizedMsgs = context.normalizeMessage(transformed, capturedSessionId || sessionId || null);
      for (const msg of normalizedMsgs) {
        // turn.completed is a protocol event, not OS process exit. The runtime
        // emits its one terminal complete only after the SDK/child settle.
        if (msg.kind !== 'complete') sendMessage(ws, msg);
      }

      if (event.type === 'turn.failed' && !terminalFailure) {
        terminalFailure = event.error || new Error('Turn failed');
        errorSurfaced = true;
        // Notifications are app-facing, so they carry the app session id.
        notifyRunFailed({
          userId: ws?.userId || null,
          provider: 'codex',
          sessionId: sessionId || capturedSessionId || null,
          sessionName: sessionSummary,
          error: terminalFailure
        });
      }

      // Extract and send token usage if available (normalized to match Claude format)
      if (event.type === 'turn.completed') {
        const tokenBudget = extractCodexTokenBudget(event);
        if (tokenBudget) {
          sendMessage(ws, createNormalizedMessage({ kind: 'status', text: 'token_budget', tokenBudget, sessionId: capturedSessionId || sessionId || null, provider: 'codex' }));
        }
      }
    }

    // The gateway owns aborted completion and awaits this run's done barrier.
    const iteratorError = await settleExecution();
    if (iteratorError && !abortController.signal.aborted) throw iteratorError;
    lifecycle.status = 'completed';
    const runAborted = abortController.signal.aborted;
    if (!runAborted) {
      sendMessage(ws, createCompleteMessage({
        provider: 'codex',
        sessionId: capturedSessionId || sessionId || null,
        actualSessionId: capturedSessionId || thread?.id || sessionId || null,
        exitCode: terminalFailure ? 1 : 0,
      }));
      if (!terminalFailure) {
        notifyRunStopped({
          userId: ws?.userId || null,
          provider: 'codex',
          sessionId: sessionId || capturedSessionId || null,
          sessionName: sessionSummary,
          stopReason: 'completed'
        });
      }
    }

  } catch (error) {
    const runError = error instanceof Error ? error : new Error(String(error));
    await settleExecution();
    lifecycle.status = 'completed';
    const wasAborted = abortController.signal.aborted;

    if (!wasAborted) {
      console.error('[Codex] Error:', error);

      if (!errorSurfaced) {
        // Check if Codex SDK is available for a clearer error message
        const installed = await context.isProviderInstalled();
        const errorContent = !installed
          ? 'Codex CLI is not configured. Please set up authentication first.'
          : runError.message;

        sendMessage(ws, createNormalizedMessage({ kind: 'error', content: errorContent, sessionId: capturedSessionId || sessionId || null, provider: 'codex' }));
      }
      sendMessage(ws, createCompleteMessage({
        provider: 'codex',
        sessionId: capturedSessionId || sessionId || null,
        exitCode: 1,
      }));
      if (!terminalFailure) {
        notifyRunFailed({
          userId: ws?.userId || null,
          provider: 'codex',
          sessionId: sessionId || capturedSessionId || null,
          sessionName: sessionSummary,
          error
        });
      }
    }

  } finally {
    await settleExecution();
    lifecycle.status = 'completed';
    if (abortController.signal.aborted) {
      sendMessage(ws, createNormalizedMessage({
        kind: 'status', text: 'model_stopped', canInterrupt: false,
        provider: 'codex', sessionId: capturedSessionId || sessionId || null,
      }));
    }
    callerSignal?.removeEventListener('abort', cancelFromCaller);
    const key = sessionKey();
    if (key && activeCodexSessions.get(key) === lifecycle) activeCodexSessions.delete(key);
    finishRun();
  }
}

/**
 * Abort an active Codex session
 * @param {string} sessionId - Session ID to abort
 * Resolves true only after this run's SDK iterator and CLI have exited.
 */
async function abortCodexSession(sessionId: string) {
  const session = activeCodexSessions.get(sessionId);

  if (!session || session.status === 'completed') {
    return false;
  }

  session.status = 'stopping';
  const retryRequested = session.abortRequested;
  session.abortRequested = true;
  session.abortController.abort();
  if (retryRequested) {
    // AbortController only dispatches once. A later explicit stop must still
    // be able to target a CLI that has not exited after the earlier request.
    for (const child of session.processes) {
      if (child.pid && child.exitCode === null && child.signalCode === null && !child.kill('SIGTERM')) {
        throw new Error('Codex CLI did not accept the cancellation signal; the task is still reserved.');
      }
    }
  }
  await session.done;
  return true;
}

/** Used by the providers module's CodexProvider to run and abort SDK turns. */
export const codexRuntime = {
  run: queryCodex,
  abort: abortCodexSession,
};

/**
 * Helper to send message via WebSocket or writer
 * @param {WebSocket|object} ws - WebSocket or response writer
 * @param {object} data - Data to send
 */
function sendMessage(ws: ProviderRuntimeWriter, data: unknown) {
  try {
    if (ws.isSSEStreamWriter || ws.isWebSocketWriter) {
      // Writer handles stringification (SSEStreamWriter or WebSocketWriter)
      ws.send(data);
    } else if (typeof ws.send === 'function') {
      // Raw WebSocket - stringify here
      ws.send(JSON.stringify(data));
    }
  } catch (error) {
    console.error('[Codex] Error sending message:', error);
  }
}
