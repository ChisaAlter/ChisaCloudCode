import fsSync from 'node:fs';
import path from 'node:path';
import { resolveProviderHome } from '@/modules/providers/services/provider-state.service.js';

import Database from 'better-sqlite3';

import { runProviderProcess } from '@/modules/providers/services/provider-process.service.js';
import { notifyRunFailed, notifyRunStopped } from '@/modules/notifications/index.js';
import { appendFilesInputTag, appendImagesInputTag, normalizeAttachmentDescriptors, createCompleteMessage, createNormalizedMessage, flattenPromptForWindowsShell, getOpenCodeDatabasePath } from '@/shared/index.js';
import type { AnyRecord, ProviderModelsDefinition, ProviderRuntimeContext, ProviderRuntimeWriter } from '@/shared/index.js';

type OpenCodeRun = { controller: AbortController; completion: Promise<void>; cleanupError?: unknown };

/** Providers tests verify the CLI controls without consulting a live model. */
export function resolveOpenCodePermissionOptions(permissionMode?: string): { args: string[]; env: Record<string, string> } {
  switch (permissionMode) {
    case 'plan': return { args: ['--agent', 'plan'], env: {} };
    case 'bypassPermissions': return { args: ['--auto'], env: {} };
    case 'acceptEdits': return { args: [], env: { OPENCODE_PERMISSION: JSON.stringify({ edit: 'allow' }) } };
    default: return { args: [], env: {} };
  }
}

function resolveOpenCodeEffort(model: string | undefined, effort: unknown, catalog: ProviderModelsDefinition | null) {
  const allowed = catalog?.OPTIONS.find((option) => option.value === model)?.effort?.values.map((value) => value.value) || [];
  return typeof effort === 'string' && effort !== 'default' && allowed.includes(effort) ? effort : undefined;
}

function readOpenCodeTokenUsage(sessionId: string | null) {
  const dbPath = sessionId ? path.join(resolveProviderHome('opencode', sessionId), '.local', 'share', 'opencode', 'opencode.db') : getOpenCodeDatabasePath();
  if (!sessionId || !fsSync.existsSync(dbPath)) return null;
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const columns = db.prepare('PRAGMA table_info(session)').all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    if (!['tokens_input', 'tokens_output', 'tokens_reasoning', 'tokens_cache_read', 'tokens_cache_write'].every((column) => names.has(column))) return null;
    const row = db.prepare(`SELECT tokens_input AS inputTokens, tokens_output AS outputTokens,
      tokens_reasoning AS reasoningTokens, tokens_cache_read AS cacheReadTokens,
      tokens_cache_write AS cacheWriteTokens FROM session WHERE id = ?`).get(sessionId) as Record<string, number> | undefined;
    if (!row) return null;
    const inputTokens = Number(row.inputTokens || 0) + Number(row.cacheReadTokens || 0);
    const outputTokens = Number(row.outputTokens || 0);
    const used = inputTokens + outputTokens + Number(row.reasoningTokens || 0) + Number(row.cacheWriteTokens || 0);
    return used > 0 ? { used, inputTokens, outputTokens, breakdown: { input: inputTokens, output: outputTokens } } : null;
  } catch { return null; }
  finally { db?.close(); }
}

/** Providers and focused process tests use this factory without starting a model. */
export function createOpenCodeRuntime(runProcess: typeof runProviderProcess = runProviderProcess) {
  const active = new Map<string, OpenCodeRun>();

  const run = async (command: string, options: AnyRecord, ws: ProviderRuntimeWriter, context: ProviderRuntimeContext) => {
    const { sessionId, projectPath, cwd, model, effort, sessionSummary, images, files, permissionMode } = options;
    const controller = new AbortController();
    const externalSignal = options.abortSignal as AbortSignal | undefined;
    const cancel = () => controller.abort(externalSignal?.reason);
    externalSignal?.addEventListener('abort', cancel, { once: true });
    if (externalSignal?.aborted) cancel();
    let finish!: () => void;
    const entry: OpenCodeRun = { controller, completion: new Promise<void>((resolve) => { finish = resolve; }) };
    const processKey = sessionId || `opencode-${Date.now()}`;
    active.set(processKey, entry);
    let capturedSessionId = context.resolveProviderSessionId(sessionId);
    let sessionCreatedSent = false;
    let stdoutBuffer = '';
    try {
      const providerSessionId = capturedSessionId;
      const resolvedModel = await context.resolveResumeModel(sessionId, model);
      let catalog: ProviderModelsDefinition | null = null;
      try { catalog = await context.getProviderModels(); }
      catch (error) { console.warn('[OpenCode] Unable to load provider models for effort validation:', error); }
      controller.signal.throwIfAborted();
      const resolvedEffort = resolveOpenCodeEffort(resolvedModel, effort, catalog);
      const workingDir = cwd || projectPath || process.cwd();
      const args = ['run', '--format', 'json', '--dir', workingDir];
      if (providerSessionId) args.push('--session', providerSessionId);
      if (resolvedModel) args.push('--model', resolvedModel);
      if (resolvedEffort) args.push('--variant', resolvedEffort);
      const permissions = resolveOpenCodePermissionOptions(permissionMode);
      args.push(...permissions.args);
      const hasAttachments = normalizeAttachmentDescriptors(images).length > 0 || normalizeAttachmentDescriptors(files).length > 0;
      if (command?.trim() || hasAttachments) args.push(flattenPromptForWindowsShell(appendFilesInputTag(appendImagesInputTag(command?.trim() || '', images), files)));

      const processLine = (line: string) => {
        if (!line.trim() || controller.signal.aborted) return;
        let response: AnyRecord;
        try { response = JSON.parse(line); }
        catch {
          ws.send(createNormalizedMessage({ kind: 'stream_delta', content: line, sessionId: capturedSessionId || sessionId || null, provider: 'opencode' }));
          return;
        }
        try {
          const nextId = response.sessionID || response.sessionId;
          if (typeof nextId === 'string' && nextId && nextId !== capturedSessionId) {
            capturedSessionId = nextId;
            if (!sessionId) active.set(capturedSessionId, entry);
            ws.setSessionId?.(capturedSessionId);
            if (!providerSessionId && !sessionCreatedSent) {
              sessionCreatedSent = true;
              ws.send(createNormalizedMessage({ kind: 'session_created', newSessionId: capturedSessionId, sessionId: capturedSessionId, provider: 'opencode' }));
            }
          }
          for (const message of context.normalizeMessage(response, capturedSessionId || sessionId || null)) {
            if (message.kind !== 'complete') ws.send(message);
          }
        } catch (error) {
          ws.send(createNormalizedMessage({ kind: 'error', content: error instanceof Error ? error.message : String(error), sessionId: capturedSessionId || sessionId || null, provider: 'opencode' }));
        }
      };
      const result = await (context.runProcess ?? runProcess)({ kind: 'cli', command: 'opencode', args, cwd: workingDir, env: permissions.env }, {
        stdout(text) {
          stdoutBuffer += text;
          const lines = stdoutBuffer.split(/\r?\n/);
          stdoutBuffer = lines.pop() || '';
          for (const line of lines) processLine(line.trim());
        },
        stderr(text) {
          if (text.trim() && !controller.signal.aborted) ws.send(createNormalizedMessage({ kind: 'error', content: text, sessionId: capturedSessionId || sessionId || null, provider: 'opencode' }));
        },
      }, controller.signal);
      if (stdoutBuffer.trim()) processLine(stdoutBuffer.trim());
      if (result.error) throw Object.assign(new Error(result.error.message), { name: result.error.name });
      if (result.code !== 0) throw new Error(result.code === null ? 'OpenCode CLI process was terminated' : `OpenCode CLI exited with code ${result.code}`);
      const tokenBudget = readOpenCodeTokenUsage(capturedSessionId);
      if (tokenBudget) ws.send(createNormalizedMessage({ kind: 'status', text: 'token_budget', tokenBudget, sessionId: capturedSessionId || sessionId || null, provider: 'opencode' }));
      if (!controller.signal.aborted) {
        ws.send(createCompleteMessage({ provider: 'opencode', sessionId: capturedSessionId || sessionId || null, exitCode: 0 }));
        notifyRunStopped({ userId: ws.userId || null, provider: 'opencode', sessionId: sessionId || capturedSessionId || null, sessionName: sessionSummary, stopReason: 'completed' });
      }
    } catch (error) {
      if ((error as { processTeardownError?: boolean })?.processTeardownError) {
        entry.cleanupError = error;
        throw error;
      }
      if (!controller.signal.aborted) {
        const installed = await context.isProviderInstalled();
        const content = !installed ? 'OpenCode CLI is not installed. Install it from https://opencode.ai/docs/' : error instanceof Error ? error.message : String(error);
        ws.send(createNormalizedMessage({ kind: 'error', content, sessionId: capturedSessionId || sessionId || null, provider: 'opencode' }));
        ws.send(createCompleteMessage({ provider: 'opencode', sessionId: capturedSessionId || sessionId || null, exitCode: 1 }));
        notifyRunFailed({ userId: ws.userId || null, provider: 'opencode', sessionId: sessionId || capturedSessionId || null, sessionName: sessionSummary, error });
        throw error;
      }
    } finally {
      externalSignal?.removeEventListener('abort', cancel);
      for (const [key, candidate] of active) if (candidate === entry) active.delete(key);
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

/** Used by OpenCodeProvider; the dispatcher supplies workspace admission. */
export const opencodeRuntime = createOpenCodeRuntime();
