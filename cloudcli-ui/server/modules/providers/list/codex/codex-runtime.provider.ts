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

import type { ModelReasoningEffort, ThreadOptions } from '@openai/codex-sdk';

import { runProviderProcess } from '@/modules/providers/services/provider-process.service.js';
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
  status: 'running' | 'aborted' | 'completed';
  abortController: AbortController;
  completion: Promise<void>;
  cleanupError?: unknown;
  startedAt: string;
};

const activeCodexSessions = new Map<string, ActiveCodexSession>();

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
    case 'plan':
      return { sandboxMode: 'read-only', approvalPolicy: 'never' };
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
  runProcess: typeof runProviderProcess,
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

  const resolvedModel = await context.resolveResumeModel(sessionId, model);

  const workingDirectory = cwd || projectPath || process.cwd();
  const { sandboxMode, approvalPolicy } = mapPermissionModeToCodexOptions(permissionMode);
  const catalog = await context.getProviderModels();
  const selectedModel = catalog.OPTIONS.find((option) => option.value === resolvedModel) || null;
  const allowedEfforts = selectedModel?.effort?.values?.map((value) => value.value) || [];
  const resolvedEffort = typeof effort === 'string' && effort !== 'default' && allowedEfforts.includes(effort)
    ? effort as ModelReasoningEffort
    : undefined;

  let resolveCompletion!: () => void;
  const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });
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
  const externalSignal = options.abortSignal as AbortSignal | undefined;
  const cancel = () => abortController.abort(externalSignal?.reason);
  externalSignal?.addEventListener('abort', cancel, { once: true });
  if (externalSignal?.aborted) cancel();
  // Session-map key: the app session id when the caller supplied one, else
  // the provider-native thread id once captured (legacy/direct API callers).
  const sessionKey = () => sessionId || capturedSessionId || null;

  try {
    abortController.signal.throwIfAborted();
    const threadOptions: ThreadOptions = {
      workingDirectory,
      skipGitRepoCheck: true,
      sandboxMode,
      approvalPolicy,
      model: resolvedModel,
      modelReasoningEffort: resolvedEffort,
    };

    const registerSession = (id: string | null) => {
      if (!id) {
        return;
      }
      activeCodexSessions.set(id, {
        status: 'running',
        abortController,
        completion,
        startedAt: new Date().toISOString()
      });
    };

    if (sessionKey()) {
      registerSession(sessionKey());
    }

    // Execute with streaming. Turns with image attachments send structured
    // input items so Codex reads the images from their local asset paths.
    const promptWithFiles = appendFilesInputTag(command, files);
    const turnInput = normalizeImageDescriptors(images).length > 0
      ? buildCodexInputItems(promptWithFiles, images, workingDirectory)
      : promptWithFiles;
    const result = await (context.runProcess ?? runProcess)({
      kind: 'codex', providerSessionId, threadOptions, input: turnInput,
    }, { event(event) {
      // Capture thread/session id lazily from the stream (Codex emits this asynchronously).
      if (event.type === 'thread.started') {
        const discoveredSessionId = event.thread_id || null;
        if (discoveredSessionId && !capturedSessionId) {
          capturedSessionId = discoveredSessionId;
          registerSession(sessionKey());

          if (ws.setSessionId && typeof ws.setSessionId === 'function') {
            ws.setSessionId(discoveredSessionId);
          }

          if (!providerSessionId && !sessionCreatedSent) {
            sessionCreatedSent = true;
            sendMessage(ws, createNormalizedMessage({ kind: 'session_created', newSessionId: capturedSessionId, sessionId: capturedSessionId, provider: 'codex' }));
          }
        }
      }

      // Check if session was aborted
      if (abortController.signal.aborted) return;
      if (sessionKey()) {
        const session = activeCodexSessions.get(sessionKey() || '');
        if (session?.status === 'aborted') return;
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
        return;
      }

      const transformed = transformCodexEvent(event);
      if (transformed.type === 'error' || transformed.itemType === 'error') {
        errorSurfaced = true;
      }

      // Normalize the transformed event into NormalizedMessage(s) via adapter
      const normalizedMsgs = context.normalizeMessage(transformed, capturedSessionId || sessionId || null);
      for (const msg of normalizedMsgs) {
        // turn.completed can precede CLI/tool exit. Only the terminal below is
        // allowed to finish the run after the supervisor has reaped its tree.
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
    } }, abortController.signal);
    if (result.error) throw Object.assign(new Error(result.error.message), { name: result.error.name });
    if (result.code !== 0) throw new Error(`Codex worker exited with code ${result.code}`);

    // Send the terminal completion event — skipped for aborted runs, whose
    // terminal `complete` (aborted: true) was already sent by abort-session.
    const runSession = activeCodexSessions.get(sessionKey() || '');
    const runAborted = runSession?.status === 'aborted' || abortController.signal.aborted;
    if (!runAborted) {
      sendMessage(ws, createCompleteMessage({
        provider: 'codex',
        sessionId: capturedSessionId || sessionId || null,
        actualSessionId: capturedSessionId || sessionId || null,
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
    const session = activeCodexSessions.get(sessionKey() || '');
    const runError = error instanceof Error ? error : new Error(String(error));
    // A failed teardown must retain workspace ownership and be visible to the
    // dispatcher. It is never an ordinary provider/model error or safe abort.
    if ((error as { processTeardownError?: boolean })?.processTeardownError) {
      if (session) session.cleanupError = error;
      throw error;
    }
    const wasAborted =
      session?.status === 'aborted' ||
      runError.name === 'AbortError' ||
      runError.message.toLowerCase().includes('aborted');

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
    externalSignal?.removeEventListener('abort', cancel);
    resolveCompletion();
    // Update session status
    if (sessionKey()) {
      const session = activeCodexSessions.get(sessionKey() || '');
      if (session) {
        session.status = session.status === 'aborted' ? 'aborted' : 'completed';
      }
    }
  }
}

/**
 * Abort an active Codex session
 * @param {string} sessionId - Session ID to abort
 * @returns {boolean} - Whether abort was successful
 */
async function abortCodexSession(sessionId: string) {
  const session = activeCodexSessions.get(sessionId);

  if (!session || session.status === 'completed') {
    return false;
  }

  session.status = 'aborted';
  try {
    session.abortController?.abort();
  } catch (error) {
    console.warn(`[Codex] Failed to abort session ${sessionId}:`, error);
  }

  await session.completion;
  if (session.cleanupError) throw session.cleanupError;
  return true;
}

/** Providers tests inject owned process events without invoking the SDK/model. */
export function createCodexRuntime(runProcess: typeof runProviderProcess = runProviderProcess) {
  return {
    run: (command: string, options: AnyRecord, writer: ProviderRuntimeWriter, context: ProviderRuntimeContext) => queryCodex(command, options, writer, context, runProcess),
    abort: abortCodexSession,
  };
}

/** Used by the providers module's CodexProvider to run and abort SDK turns. */
export const codexRuntime = createCodexRuntime();

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

// Clean up old completed sessions periodically
const completedSessionCleanupTimer = setInterval(() => {
  const now = Date.now();
  const maxAge = 30 * 60 * 1000; // 30 minutes

  for (const [id, session] of activeCodexSessions.entries()) {
    if (session.status !== 'running') {
      const startedAt = new Date(session.startedAt).getTime();
      if (now - startedAt > maxAge) {
        activeCodexSessions.delete(id);
      }
    }
  }
}, 5 * 60 * 1000); // Every 5 minutes

// Runtime cleanup should not keep focused tests or one-off scripts alive after
// their provider work has completed.
completedSessionCleanupTimer.unref?.();
