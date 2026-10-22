import { runProviderProcess } from '@/modules/providers/services/provider-process.service.js';
import { notifyRunFailed, notifyRunStopped } from '@/modules/notifications/index.js';
import { appendFilesInputTag, appendImagesInputTag, normalizeAttachmentDescriptors, createCompleteMessage, createNormalizedMessage, flattenPromptForWindowsShell } from '@/shared/index.js';
import type { AnyRecord, ProviderRuntimeContext, ProviderRuntimeWriter } from '@/shared/index.js';

type CursorRun = { controller: AbortController; completion: Promise<void>; cleanupError?: unknown };
const WORKSPACE_TRUST_PATTERNS = [
  /workspace trust required/i,
  /do you trust the contents of this directory/i,
  /working with untrusted contents/i,
  /pass --trust,\s*--yolo,\s*or -f/i,
];

/** Providers and focused process tests use this factory without starting a model. */
export function createCursorRuntime(runProcess: typeof runProviderProcess = runProviderProcess) {
  const active = new Map<string, CursorRun>();

  const run = async (command: string, options: AnyRecord, ws: ProviderRuntimeWriter, context: ProviderRuntimeContext) => {
    const { sessionId, projectPath, cwd, toolsSettings, skipPermissions, sessionSummary, images, files } = options;
    const controller = new AbortController();
    const externalSignal = options.abortSignal as AbortSignal | undefined;
    const cancel = () => controller.abort(externalSignal?.reason);
    externalSignal?.addEventListener('abort', cancel, { once: true });
    if (externalSignal?.aborted) cancel();
    let finish!: () => void;
    const entry: CursorRun = { controller, completion: new Promise<void>((resolve) => { finish = resolve; }) };
    let capturedSessionId: string | null = null;
    const processKey = sessionId || `cursor-${Date.now()}`;
    active.set(processKey, entry);
    let sessionCreatedSent = false;
    let terminalCode: number | null = 1;
    let failure: unknown;

    try {
      const providerSessionId = context.resolveProviderSessionId(sessionId);
      capturedSessionId = providerSessionId;
      const resolvedModel = await context.resolveResumeModel(sessionId, options.model);
      controller.signal.throwIfAborted();
      const settings = toolsSettings || { allowedShellCommands: [], skipPermissions: false };
      const args: string[] = [];
      if (providerSessionId) args.push(`--resume=${providerSessionId}`);
      const hasAttachments = normalizeAttachmentDescriptors(images).length > 0 || normalizeAttachmentDescriptors(files).length > 0;
      if (command?.trim() || hasAttachments) {
        const prompt = appendFilesInputTag(appendImagesInputTag(command || '', images), files);
        args.push('-p', flattenPromptForWindowsShell(prompt));
        if (resolvedModel) args.push('--model', resolvedModel);
        args.push('--output-format', 'stream-json');
      }
      if (options.permissionMode === 'plan') args.push('--mode', 'plan');
      else if (options.permissionMode === 'bypassPermissions' || skipPermissions || settings.skipPermissions) args.push('-f');
      const workingDir = cwd || projectPath || process.cwd();
      let retriedWithTrust = false;

      while (true) {
        controller.signal.throwIfAborted();
        let sawTrustPrompt = false;
        let stdoutBuffer = '';
        let resultCode: number | undefined;
        const suppressTrust = (text: string) => {
          if (retriedWithTrust || args.includes('--trust') || !WORKSPACE_TRUST_PATTERNS.some((pattern) => pattern.test(text))) return false;
          sawTrustPrompt = true;
          return true;
        };
        const processLine = (line: string) => {
          if (!line.trim() || controller.signal.aborted) return;
          let response: AnyRecord;
          try { response = JSON.parse(line); }
          catch {
            if (!suppressTrust(line)) for (const message of context.normalizeMessage(line, capturedSessionId || sessionId || null)) {
              if (message.kind !== 'complete') ws.send(message);
            }
            return;
          }
          if (response.type === 'system' && response.subtype === 'init') {
            if (response.session_id && !capturedSessionId) {
              capturedSessionId = response.session_id;
              if (!sessionId) active.set(capturedSessionId!, entry);
              ws.setSessionId?.(capturedSessionId!);
              if (!providerSessionId && !sessionCreatedSent) {
                sessionCreatedSent = true;
                ws.send(createNormalizedMessage({ kind: 'session_created', newSessionId: capturedSessionId!, model: response.model, cwd: response.cwd, sessionId: capturedSessionId, provider: 'cursor' }));
              }
            }
          } else if (response.type === 'assistant' && response.message?.content?.length) {
            for (const message of context.normalizeMessage(response, capturedSessionId || sessionId || null)) {
              if (message.kind !== 'complete') ws.send(message);
            }
          } else if (response.type === 'result') {
            // Cursor's result line precedes actual CLI/tool exit. Save its
            // outcome but never let it finish the outer workspace lifecycle.
            resultCode = response.subtype === 'success' ? 0 : 1;
          }
        };
        const result = await (context.runProcess ?? runProcess)({ kind: 'cli', command: 'cursor-agent', args, cwd: workingDir }, {
          stdout(text) {
            stdoutBuffer += text;
            const lines = stdoutBuffer.split(/\r?\n/);
            stdoutBuffer = lines.pop() || '';
            for (const line of lines) processLine(line.trim());
          },
          stderr(text) {
            if (!suppressTrust(text) && !controller.signal.aborted) ws.send(createNormalizedMessage({ kind: 'error', content: text, sessionId: capturedSessionId || sessionId || null, provider: 'cursor' }));
          },
        }, controller.signal);
        if (stdoutBuffer.trim()) processLine(stdoutBuffer.trim());
        if (sawTrustPrompt && result.code !== 0 && !retriedWithTrust && !args.includes('--trust')) {
          retriedWithTrust = true;
          args.push('--trust');
          continue;
        }
        if (result.error) throw Object.assign(new Error(result.error.message), { name: result.error.name });
        terminalCode = result.code === 0 ? resultCode ?? 0 : result.code;
        if (terminalCode !== 0) throw new Error(`Cursor CLI exited with code ${terminalCode}`);
        break;
      }
      if (!controller.signal.aborted) {
        ws.send(createCompleteMessage({ provider: 'cursor', sessionId: capturedSessionId || sessionId || null, exitCode: terminalCode }));
        notifyRunStopped({ userId: ws.userId || null, provider: 'cursor', sessionId: sessionId || capturedSessionId || null, sessionName: sessionSummary, stopReason: 'completed' });
      }
    } catch (error) {
      failure = error;
      if ((error as { processTeardownError?: boolean })?.processTeardownError) {
        entry.cleanupError = error;
        throw error;
      }
      if (!controller.signal.aborted) {
        const installed = await context.isProviderInstalled();
        const content = !installed ? 'Cursor CLI is not installed. Please install it from https://cursor.com' : error instanceof Error ? error.message : String(error);
        ws.send(createNormalizedMessage({ kind: 'error', content, sessionId: capturedSessionId || sessionId || null, provider: 'cursor' }));
        ws.send(createCompleteMessage({ provider: 'cursor', sessionId: capturedSessionId || sessionId || null, exitCode: 1 }));
        notifyRunFailed({ userId: ws.userId || null, provider: 'cursor', sessionId: sessionId || capturedSessionId || null, sessionName: sessionSummary, error });
        throw error;
      }
    } finally {
      if (controller.signal.aborted && !entry.cleanupError) ws.send(createNormalizedMessage({ kind: 'status', text: 'model_stopped', canInterrupt: false, sessionId: sessionId || capturedSessionId || null, provider: 'cursor' }));
      externalSignal?.removeEventListener('abort', cancel);
      for (const [key, candidate] of active) if (candidate === entry) active.delete(key);
      if ((failure as { processTeardownError?: boolean })?.processTeardownError) entry.cleanupError = failure;
      finish();
    }
  };

  return {
    run,
    async abort(sessionId: string) {
      const entry = active.get(sessionId);
      if (!entry) return false;
      entry.controller.abort();
      await entry.completion;
      if (entry.cleanupError) throw entry.cleanupError;
      return true;
    },
  };
}

/** Used by CursorProvider; the dispatcher supplies workspace admission. */
export const cursorWorkspaceRuntime = createCursorRuntime();
