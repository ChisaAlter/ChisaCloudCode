import { sessionsDb } from '@/modules/database/index.js';
import { admitWorkspaceExecution } from '@/modules/workspace-bridge/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { providerModelsService } from '@/modules/providers/services/provider-models.service.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import { createContainerProviderRunner } from '@/modules/providers/services/provider-container.service.js';
import { registerManagedProviderProfile } from '@/modules/providers/services/provider-state.service.js';
import { createCompleteMessage, normalizeAttachmentDescriptors } from '@/shared/index.js';
import type { AnyRecord, IProvider, LLMProvider, ProviderPermissionDecision, ProviderRunFunction, ProviderRuntimeContext, ProviderRuntimeWriter } from '@/shared/index.js';

type ProviderRuntimeServiceDependencies = {
  listProviders(): IProvider[];
  resolveProvider(provider: string): IProvider;
  resolveProviderSessionId(sessionId: string | null | undefined): string | null;
  resolveResumeModel(provider: LLMProvider, sessionId: string | undefined, requestedModel?: string | null): Promise<string | undefined>;
  getProviderModels: typeof providerModelsService.getProviderModels;
  getSessionSource(sessionId: string): { project_path: string | null; workspace_mode: 'shared' | 'isolated'; provider: string } | null;
  admitWorkspaceExecution: typeof admitWorkspaceExecution;
  createContainerProviderRunner: typeof createContainerProviderRunner;
  registerManagedProviderProfile: typeof registerManagedProviderProfile;
};

type ManagedRun = {
  controller: AbortController;
  completion: Promise<unknown>;
  cleanupError?: unknown;
};

const defaultDependencies: ProviderRuntimeServiceDependencies = {
  listProviders: () => providerRegistry.listProviders(),
  resolveProvider: (provider) => providerRegistry.resolveProvider(provider),
  resolveProviderSessionId: (sessionId) => sessionsService.resolveProviderSessionId(sessionId),
  resolveResumeModel: (provider, sessionId, requestedModel) => providerModelsService.resolveResumeModel(provider, sessionId, requestedModel),
  getProviderModels: (provider) => providerModelsService.getProviderModels(provider),
  getSessionSource: (sessionId) => sessionsDb.getSessionById(sessionId),
  admitWorkspaceExecution,
  createContainerProviderRunner,
  registerManagedProviderProfile,
};

/**
 * WebSocket, agent and Git callers use this dispatcher. NonClaude runtimes own
 * their process teardown; this service owns admission, cancellation through
 * admission/finalization, and terminal completion after confirmed handback.
 * Claude already owns the same lifecycle through workspaceQuery.
 */
export function createProviderRuntimeService(dependencyOverrides: Partial<ProviderRuntimeServiceDependencies> = {}) {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  const managedRuns = new Map<string, ManagedRun>();
  const keyFor = (provider: LLMProvider, sessionId: string) => `${provider}:${sessionId}`;
  const createRuntimeContext = (provider: IProvider): ProviderRuntimeContext => ({
    resolveProviderSessionId: dependencies.resolveProviderSessionId,
    resolveResumeModel: (sessionId, requestedModel) => dependencies.resolveResumeModel(provider.id, sessionId, requestedModel),
    getProviderModels: async () => dependencies.getProviderModels(provider.id),
    normalizeMessage: (raw, sessionId) => provider.sessions.normalizeMessage(raw, sessionId),
    async isProviderInstalled() {
      try { return (await provider.auth.getStatus()).installed; }
      catch { return true; }
    },
  });

  const run = (providerName: LLMProvider, command: string, options: AnyRecord, writer: ProviderRuntimeWriter): Promise<unknown> => {
    const provider = dependencies.resolveProvider(providerName);
    if (provider.id === 'claude') return provider.runtime.run(command, options, writer, createRuntimeContext(provider));
    const sessionId = typeof options.sessionId === 'string' ? options.sessionId : null;
    const key = sessionId ? keyFor(provider.id, sessionId) : null;
    if (key && managedRuns.has(key)) return Promise.reject(Object.assign(new Error('This session is still running or returning its workspace.'), { code: 'RUN_IN_PROGRESS' }));
    const controller = new AbortController();
    const externalSignal = options.abortSignal as AbortSignal | undefined;
    const cancel = () => controller.abort(externalSignal?.reason);
    externalSignal?.addEventListener('abort', cancel, { once: true });
    if (externalSignal?.aborted) cancel();
    const entry: ManagedRun = { controller, completion: Promise.resolve() };
    if (key) managedRuns.set(key, entry);
    let pendingComplete: unknown;
    let capturedSessionId: string | null = null;
    const registerProviderId = (id: string) => {
      capturedSessionId = id;
      if (!sessionId) managedRuns.set(keyFor(provider.id, id), entry);
    };
    const guardedWriter: ProviderRuntimeWriter = {
      ...writer,
      send(data) {
        let message: unknown = data;
        if (typeof data === 'string') {
          try { message = JSON.parse(data); } catch { /* Raw non-JSON output stays unchanged. */ }
        }
        const envelope = message as { kind?: string; newSessionId?: string } | null;
        if (envelope?.kind === 'session_created' && typeof envelope.newSessionId === 'string') registerProviderId(envelope.newSessionId);
        if (envelope?.kind === 'complete') { pendingComplete = data; return; }
        writer.send(data);
      },
      setSessionId(id) { registerProviderId(id); writer.setSessionId?.(id); },
    };
    // Schedule after registration so an immediate abort can cancel admission.
    entry.completion = Promise.resolve().then(async () => {
      let lease: Awaited<ReturnType<typeof admitWorkspaceExecution>> | undefined;
      let result: unknown;
      let primary: unknown;
      let failed = false;
      try {
        controller.signal.throwIfAborted();
        const stored = sessionId ? dependencies.getSessionSource(sessionId) : null;
        if (stored && stored.provider !== provider.id) throw new Error('Session provider does not match the selected runtime.');
        const sourceCwd = stored?.project_path || options.cwd || options.projectPath || process.cwd();
        lease = await dependencies.admitWorkspaceExecution({
          cwd: sourceCwd,
          sessionId,
          workspaceMode: stored?.workspace_mode ?? options.workspaceMode,
          readOnly: options.permissionMode === 'plan',
          signal: controller.signal,
          directExecution: true,
        });
        controller.signal.throwIfAborted();
        const context = createRuntimeContext(provider);
        if (lease.bindingKind === 'vps' && sessionId && provider.id !== 'claude') dependencies.registerManagedProviderProfile(provider.id, sessionId);
        if (lease.bindingKind === 'vps' && provider.id !== 'claude') context.runProcess = dependencies.createContainerProviderRunner(lease, provider.id, [
          ...normalizeAttachmentDescriptors(options.images),
          ...normalizeAttachmentDescriptors(options.files),
          ...normalizeAttachmentDescriptors(options.attachments),
        ], { sessionId: sessionId ?? undefined });
        result = await provider.runtime.run(command, {
          ...options,
          cwd: lease.cwd,
          projectPath: lease.sourceCwd,
          sourceCwd: lease.sourceCwd,
          workspaceMode: stored?.workspace_mode ?? options.workspaceMode,
          abortSignal: controller.signal,
        }, guardedWriter, context);
      } catch (error) {
        primary = error;
        failed = true;
      } finally {
        const processTeardownUnconfirmed = Boolean((primary as { processTeardownError?: boolean })?.processTeardownError);
        try {
          // Unknown process state is not a handback. Retain the exact durable
          // lease so later admissions remain blocked for explicit recovery.
          if (processTeardownUnconfirmed) {
            lease?.revoke();
            entry.cleanupError = primary;
            if (primary instanceof Error) Object.assign(primary, { workspaceCleanupError: true });
          } else {
            await lease?.close();
          }
        } catch (cleanupError) {
          const failure = Object.assign(new Error('Workspace handback was not confirmed.', { cause: cleanupError }), {
            code: (cleanupError as { code?: string })?.code,
            workspaceCleanupError: true,
            cleanupError,
            ...(failed ? { primaryError: primary } : {}),
          });
          entry.cleanupError = failure;
          primary = failure;
          failed = true;
        }
        externalSignal?.removeEventListener('abort', cancel);
        // Once processes are confirmed stopped, the durable workspace barrier
        // owns recovery. Keep its error for this caller, but let future attempts
        // reach admission after exact native recovery removes that barrier.
        if (!processTeardownUnconfirmed) for (const [runKey, candidate] of managedRuns) if (candidate === entry) managedRuns.delete(runKey);
      }
      if (failed) {
        if (pendingComplete && !entry.cleanupError && !controller.signal.aborted) writer.send(createCompleteMessage({ provider: provider.id, sessionId: sessionId || capturedSessionId, actualSessionId: capturedSessionId || sessionId, exitCode: 1 }));
        throw primary;
      }
      if (!controller.signal.aborted) writer.send(pendingComplete ?? createCompleteMessage({ provider: provider.id, sessionId: sessionId || capturedSessionId, actualSessionId: capturedSessionId || sessionId, exitCode: 0 }));
      return result;
    });
    void entry.completion.catch(() => {});
    return entry.completion;
  };

  return {
    run,
    hasRuntime(providerName: string): boolean {
      try { return Boolean(dependencies.resolveProvider(providerName).runtime); }
      catch { return false; }
    },
    getRunner(provider: LLMProvider): ProviderRunFunction {
      return (command, options, writer) => run(provider, command, options, writer);
    },
    async abort(providerName: LLMProvider, sessionId: string): Promise<boolean> {
      const entry = managedRuns.get(keyFor(providerName, sessionId));
      if (entry) {
        entry.controller.abort();
        try { await entry.completion; }
        catch (error) {
          if (entry.cleanupError || (error as { workspaceCleanupError?: boolean })?.workspaceCleanupError) throw error;
          // Cancellation before admission or a concurrently failed provider is
          // safe only because completion already awaited the successful close.
        }
        if (entry.cleanupError) throw entry.cleanupError;
        return true;
      }
      return Boolean(await dependencies.resolveProvider(providerName).runtime.abort(sessionId));
    },
    resolveToolApproval(requestId: string, decision: ProviderPermissionDecision): void {
      for (const provider of dependencies.listProviders()) provider.runtime.permissions?.resolve(requestId, decision);
    },
    getPendingApprovalsForSession(sessionId: string): unknown[] {
      return dependencies.listProviders().flatMap((provider) => provider.runtime.permissions?.listPending(sessionId) ?? []);
    },
  };
}

/** Used by websocket/agent/Git modules through the Providers public barrel. */
export const providerRuntimeService = createProviderRuntimeService();
