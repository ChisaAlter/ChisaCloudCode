import { sessionsDb, userDb } from '@/modules/database/index.js';
import { authorizeStoredAttachmentPaths } from '@/modules/assets/index.js';
import { admitWorkspaceExecution, assertSshProjectOwner, getWorkspaceAttachmentMode, resolveSshProjectTarget } from '@/modules/workspace-bridge/index.js';
import { assertCloudWorkspaceOwner } from '@/modules/workspace-runtime/index.js';
import { assertSshSessionAccess } from './ssh-session-access.service.js';
import { providerRegistry } from '../provider.registry.js';
import { providerModelsService } from './provider-models.service.js';
import { sessionsService } from './sessions.service.js';
import { createContainerProviderRunner } from './provider-container.service.js';
import { registerManagedProviderProfile } from './provider-state.service.js';
import { AppError, createCompleteMessage, isImageAttachmentDescriptor, normalizeAttachmentDescriptors } from '@/shared/index.js';
import type { AnyRecord, IProvider, LLMProvider, ProviderPermissionDecision, ProviderRunFunction, ProviderRuntimeContext, ProviderRuntimeWriter } from '@/shared/index.js';

type ProviderRuntimeServiceDependencies = {
  listProviders(): IProvider[];
  resolveProvider(provider: string): IProvider;
  resolveProviderSessionId(sessionId: string | null | undefined): string | null;
  resolveResumeModel(provider: LLMProvider, sessionId: string | undefined, requestedModel?: string | null): Promise<string | undefined>;
  getProviderModels: typeof providerModelsService.getProviderModels;
  getSessionSource(sessionId: string): { project_path: string | null; workspace_mode: 'shared' | 'isolated'; provider: string } | null;
  authorizeRun(options: AnyRecord, writer: ProviderRuntimeWriter): void | Promise<void>;
  getWorkspaceAttachmentMode: typeof getWorkspaceAttachmentMode;
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
  async authorizeRun(options, writer) {
    const userId = writer.userId;
    if ((typeof userId !== 'string' && typeof userId !== 'number') ||
        (typeof userId === 'string' && (!userId.trim() || /[\r\n\0]/.test(userId))) ||
        (typeof userId === 'number' && !Number.isFinite(userId))) {
      throw new AppError('Authentication is required', { code: 'UNAUTHORIZED', statusCode: 401 });
    }
    const assertOwner = () => {
      if (typeof options.sessionId === 'string' && options.sessionId) assertSshSessionAccess(options.sessionId, userId);
      const candidate = options.cwd || options.projectPath;
      if (typeof candidate !== 'string' || !candidate) return;
      const ssh = resolveSshProjectTarget(candidate);
      if (ssh) assertSshProjectOwner(ssh, userId);
      else assertCloudWorkspaceOwner(candidate, userId, userDb.getActiveUserIds());
    };
    assertOwner();
    const candidates = [
      ...normalizeAttachmentDescriptors(options.images),
      ...normalizeAttachmentDescriptors(options.files),
      ...normalizeAttachmentDescriptors(options.attachments),
    ];
    if (candidates.length) {
      const verified = await authorizeStoredAttachmentPaths(candidates, writer.userId);
      const unique = verified.filter((item, index, all) => all.findIndex(candidate => candidate.path === item.path) === index);
      options.attachments = unique;
      options.images = unique.filter(isImageAttachmentDescriptor);
      options.files = unique.filter(item => !isImageAttachmentDescriptor(item));
      // Asset verification yields; session and workspace ownership must still hold.
      assertOwner();
    }
  },
  getWorkspaceAttachmentMode,
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
    options = { ...options };
    if (providerName === 'claude') return Promise.resolve().then(async () => {
      writer.assertActive?.();
      (options.abortSignal as AbortSignal | undefined)?.throwIfAborted();
      await dependencies.authorizeRun(options, writer);
      writer.assertActive?.();
      (options.abortSignal as AbortSignal | undefined)?.throwIfAborted();
      const provider = dependencies.resolveProvider(providerName);
      if (provider.id !== providerName) throw new Error('Selected provider does not match the runtime.');
      const sessionId = typeof options.sessionId === 'string' ? options.sessionId : null;
      const stored = sessionId ? dependencies.getSessionSource(sessionId) : null;
      if (stored && stored.provider !== provider.id) throw new Error('Session provider does not match the selected runtime.');
      const sourceCwd = stored?.project_path || options.cwd || options.projectPath || process.cwd();
      const context = createRuntimeContext(provider);
      context.attachmentMode = dependencies.getWorkspaceAttachmentMode(sourceCwd);
      writer.assertActive?.();
      (options.abortSignal as AbortSignal | undefined)?.throwIfAborted();
      return provider.runtime.run(command, options, writer, context);
    });
    const sessionId = typeof options.sessionId === 'string' ? options.sessionId : null;
    const key = sessionId ? keyFor(providerName, sessionId) : null;
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
      if (!sessionId) managedRuns.set(keyFor(providerName, id), entry);
    };
    const assertCapturedLogin = writer.assertAuthSessionActive?.bind(writer);
    const guardedWriter: ProviderRuntimeWriter = {
      ...writer,
      // Class writers may keep trusted identity, guards and getters on the prototype.
      userId: writer.userId,
      isWebSocketWriter: writer.isWebSocketWriter,
      assertActive: () => writer.assertActive?.(),
      ...(assertCapturedLogin ? { assertAuthSessionActive: assertCapturedLogin } : {}),
      getSessionId: () => writer.getSessionId?.() ?? null,
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
        writer.assertActive?.();
        await dependencies.authorizeRun(options, writer);
        controller.signal.throwIfAborted();
        writer.assertActive?.();
        const provider = dependencies.resolveProvider(providerName);
        if (provider.id !== providerName) throw new Error('Selected provider does not match the runtime.');
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
          assertActive: () => writer.assertActive?.(),
          ...(assertCapturedLogin ? { assertAuthActive: assertCapturedLogin } : {}),
          expectedWorkspace: options.workspaceDescriptor,
        });
        controller.signal.throwIfAborted();
        writer.assertActive?.();
        await dependencies.authorizeRun(options, writer);
        controller.signal.throwIfAborted();
        writer.assertActive?.();
        const context = createRuntimeContext(provider);
        context.attachmentMode = lease.bindingKind === 'vps' ? 'slot' : 'host';
        if (lease.bindingKind === 'vps') {
          const userId = writer.userId == null ? '' : String(writer.userId);
          if (!userId.trim() || /[\r\n\0]/.test(userId) || (typeof writer.userId === 'number' && !Number.isFinite(writer.userId))) {
            throw new AppError('Authentication is required', { code: 'UNAUTHORIZED', statusCode: 401 });
          }
          if (sessionId) dependencies.registerManagedProviderProfile(provider.id, sessionId);
          context.runProcess = dependencies.createContainerProviderRunner(lease, provider.id, [
            ...normalizeAttachmentDescriptors(options.images),
            ...normalizeAttachmentDescriptors(options.files),
            ...normalizeAttachmentDescriptors(options.attachments),
          ], { sessionId: sessionId ?? undefined, userId, assertActive: () => writer.assertActive?.() });
        }
        writer.assertActive?.();
        lease.assertCurrent();
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
        if (pendingComplete && !entry.cleanupError && !controller.signal.aborted) writer.send(createCompleteMessage({ provider: providerName, sessionId: sessionId || capturedSessionId, actualSessionId: capturedSessionId || sessionId, exitCode: 1 }));
        throw primary;
      }
      if (!controller.signal.aborted) writer.send(pendingComplete ?? createCompleteMessage({ provider: providerName, sessionId: sessionId || capturedSessionId, actualSessionId: capturedSessionId || sessionId, exitCode: 0 }));
      return result;
    });
    void entry.completion.catch(() => {});
    return entry.completion;
  };

  const resolveBackgroundTaskRuntime = (providerName: LLMProvider, sessionId: string, taskId: string) => {
    if (!sessionId || !taskId) return null;
    try {
      const provider = dependencies.resolveProvider(providerName);
      // Registry fallback must never turn an unknown provider into Claude authority.
      if (provider.id !== providerName) return null;
      return (provider.runtime.listBackgroundWork?.() ?? []).some(entry =>
        entry.sessionId === sessionId && entry.tasks.some(task => task.taskId === taskId)) ? provider.runtime : null;
    } catch { return null; }
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

    hasBackgroundTask(providerName: LLMProvider, sessionId: string, taskId: string): boolean {
      return resolveBackgroundTaskRuntime(providerName, sessionId, taskId) !== null;
    },
    async stopBackgroundTask(providerName: LLMProvider, sessionId: string, taskId: string): Promise<boolean> {
      // Recheck at dispatch as tasks can finish between gateway preflight and stop.
      const runtime = resolveBackgroundTaskRuntime(providerName, sessionId, taskId);
      return Boolean(await runtime?.stopBackgroundTask?.(sessionId, taskId));
    },

    hasBackgroundWork(sessionId: string): boolean {
      return dependencies.listProviders().some((provider) =>
        (provider.runtime.listBackgroundWork?.() ?? []).some((entry) => entry.sessionId === sessionId));
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
