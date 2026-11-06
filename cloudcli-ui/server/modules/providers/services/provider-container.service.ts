import path from 'node:path';

import type { admitWorkspaceExecution } from '@/modules/workspace-bridge/index.js';
import { prepareProviderCodeCache, stageProviderCli } from '@/modules/providers/services/provider-code-cache.service.js';
import { prepareProviderProfile } from '@/modules/providers/services/provider-profile.service.js';
import { AppError } from '@/shared/index.js';
import type { LLMProvider, ProviderProcessEvent, ProviderProcessJob, ProviderProcessRunner, ProviderTrustedSlot } from '@/shared/index.js';

import { bindProviderSlotOperation, prepareProviderSlot } from './provider-slot.service.js';

type RuntimeMount = { source: string; target: string; writable: boolean };
type WorkspaceExecution = Awaited<ReturnType<typeof admitWorkspaceExecution>>;
type ContainerRuntime = {
  mounts: RuntimeMount[];
  env: Record<string, string>;
  args: string[];
  cli?: string;
  command?: string;
  slot?: ProviderTrustedSlot;
  finish?(mode: 'publish' | 'discard' | 'retain'): Promise<void>;
};
type ContainerProviderDependencies = {
  sessionId?: string;
  userId?: string;
  /** Recheck the caller's captured session before any delayed provider launch. */
  assertActive?: () => void;
  resolveModelExecutable?(provider: Exclude<LLMProvider, 'claude'>, job: ProviderProcessJob): string | undefined;
  prepareRuntime(provider: Exclude<LLMProvider, 'claude'>, attachments: unknown, job: ProviderProcessJob, signal?: AbortSignal): ContainerRuntime | Promise<ContainerRuntime>;
  adaptJob(job: ProviderProcessJob, runtime: ContainerRuntime): ProviderProcessJob;
};

const CODE = '/runtime/provider-code';

function runtimeError(message: string) {
  return new AppError(message, { code: 'WORKSPACE_PROVIDER_RUNTIME_UNAVAILABLE', statusCode: 503 });
}

function workspacePath(value: string,execution: WorkspaceExecution): string {
  const root = path.resolve(execution.executionRoot ?? execution.cwd);
  const resolved = path.resolve(value);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) throw runtimeError('Provider paths must belong to the admitted execution root.');
  const relative = path.relative(root,resolved).split(path.sep).join('/');
  return relative ? '/workspace/' + relative : '/workspace';
}
function mappedText(text: string,runtime: ContainerRuntime,execution: WorkspaceExecution): string {
  let mapped = text;
  for (const asset of runtime.slot?.assets ?? []) {
    mapped = mapped.split(asset.originalPath).join(asset.target);
    mapped = mapped.split(asset.originalPath.split(path.sep).join('/')).join(asset.target);
  }
  const root = path.resolve(execution.executionRoot ?? execution.cwd);
  // CLI adapters include workspace and attachment paths in their final prompt
  // argument. Replace only the admitted root and exact verified attachment names.
  mapped = mapped.split(root + path.sep).join('/workspace/');
  mapped = mapped.split(root).join('/workspace');
  mapped = mapped.split(root.split(path.sep).join('/')).join('/workspace');
  return mapped;
}
function adaptSandboxJob(job: ProviderProcessJob,runtime: ContainerRuntime,execution: WorkspaceExecution): ProviderProcessJob {
  if (job.kind === 'codex') {
    const input = typeof job.input === 'string' ? mappedText(job.input,runtime,execution) : job.input.map(item => {
      if (item.type === 'text') return { ...item,text: mappedText(item.text,runtime,execution) };
      const asset = runtime.slot?.assets.find(asset => asset.originalPath === path.resolve(item.path));
      if (!asset) throw runtimeError('Codex image input is not a verified attachment in the selected slot.');
      return { ...item,path: asset.target };
    });
    return { ...job,executable: runtime.cli,env: undefined,threadOptions: { ...job.threadOptions,workingDirectory: workspacePath(typeof job.threadOptions.workingDirectory === 'string' ? job.threadOptions.workingDirectory : execution.cwd,execution) },input };
  }
  const args = job.args.map((argument,index) => ['--dir','--cwd','-C'].includes(job.args[index - 1]) ? workspacePath(argument,execution) : mappedText(argument,runtime,execution));
  return { ...job,command: runtime.cli!,cwd: workspacePath(job.cwd,execution),args,env: Object.fromEntries(Object.entries(job.env ?? {}).filter(([key]) => key === 'OPENCODE_PERMISSION')) };
}
async function workerRuntime(provider: Exclude<LLMProvider, 'claude'>,attachments: unknown,job: ProviderProcessJob,execution: WorkspaceExecution,dependencies: Partial<ContainerProviderDependencies>,signal?: AbortSignal): Promise<ContainerRuntime> {
  if (!dependencies.userId || !dependencies.sessionId) throw runtimeError('The admitted provider requires an authenticated owner and app session.');
  const slot = await prepareProviderSlot({ provider,userId: dependencies.userId,sessionId: dependencies.sessionId,root: execution.executionRoot ?? execution.cwd,attachments,signal,assertActive: dependencies.assertActive });
  try {
    prepareProviderCodeCache(slot);
    const cli = stageProviderCli(dependencies.resolveModelExecutable?.(provider,job),slot).executable;
    const profile = await prepareProviderProfile(provider,dependencies.sessionId,job,signal,slot);
    signal?.throwIfAborted();dependencies.assertActive?.();
    return { mounts: slot.mounts,env: slot.environment,args: slot.args,command: slot.command,cli,slot,finish: profile.finish };
  } catch (error) { await slot.finish('retain');throw error; }
}

/**
 * The provider dispatcher uses this trusted runner only for an admitted VPS
 * workspace. The workspace module owns container mounts, exact lease tracking,
 * cancellation and confirmed removal; no client option selects those controls.
 */
export function createContainerProviderRunner(execution: WorkspaceExecution, provider: Exclude<LLMProvider, 'claude'>, attachments: unknown, overrides: Partial<ContainerProviderDependencies> = {}): ProviderProcessRunner {
  const dependencies: ContainerProviderDependencies = {
    prepareRuntime: (selected,assets,job,signal) => workerRuntime(selected,assets,job,execution,overrides,signal),
    adaptJob: (job,runtime) => adaptSandboxJob(job,runtime,execution),
    ...overrides,
  };
  return async (job, handlers, signal) => {
    signal?.throwIfAborted();
    dependencies.assertActive?.();
    const runtime = await dependencies.prepareRuntime(provider, attachments, job, signal);
    let safeJob: ProviderProcessJob;
    try { signal?.throwIfAborted();dependencies.assertActive?.();safeJob = dependencies.adaptJob(job,runtime); }
    catch (error) { await runtime.finish?.('retain');throw error; }
    let child: Awaited<ReturnType<WorkspaceExecution['spawnProcess']>>;
    try {
      signal?.throwIfAborted();
      dependencies.assertActive?.();
      child = await execution.spawnProcess({ command: runtime.command ?? `${CODE}/node`, args: runtime.args, cwd: execution.cwd, env: runtime.env, runtimeMounts: runtime.mounts, signal });
    } catch (error) { await runtime.finish?.('retain'); throw error; }
    try { if (runtime.slot) bindProviderSlotOperation(runtime.slot,child.operationId); }
    catch (error) { try { await child.close(); } finally { await runtime.finish?.('retain'); } throw error; }
    // The launcher may yield while a session is revoked. Do not send the model
    // job or subscribe to its output until that captured proof is rechecked.
    try { signal?.throwIfAborted(); dependencies.assertActive?.(); }
    catch (error) {
      try { await child.close(); }
      catch (cleanupError) {
        await runtime.finish?.('retain');
        throw Object.assign(new Error('Provider sandbox cleanup was not confirmed.', { cause: cleanupError }), {
          processTeardownError: true, workspaceCleanupError: true, primaryError: error,
        });
      }
      await runtime.finish?.('discard');
      throw error;
    }
    let terminal: { code: number | null; error?: { name: string; message: string } } | undefined;
    let failure: unknown;
    let buffer = '';
    let stderr = '';
    let wake!: () => void;
    const ended = new Promise<void>((resolve) => { wake = resolve; });
    const onStreamError = (error: Error) => { failure = error; wake(); };
    child.stdout.on('error', onStreamError);
    child.stderr.on('error', onStreamError);
    const onFrame = (frame: ProviderProcessEvent) => {
      if (frame.kind === 'stdout') handlers.stdout?.(frame.text);
      else if (frame.kind === 'stderr') handlers.stderr?.(frame.text);
      else if (frame.kind === 'event') handlers.event?.(frame.event);
      else if (frame.kind === 'done') { terminal = { code: frame.code, ...(frame.error ? { error: frame.error } : {}) }; wake(); }
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (text: string) => {
      if (failure) return;
      buffer += text;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      if (Buffer.byteLength(buffer, 'utf8') > 8 * 1024 * 1024 || lines.some((line) => Buffer.byteLength(line, 'utf8') > 8 * 1024 * 1024)) {
        failure = runtimeError('The provider worker exceeded the maximum protocol frame size.');
        buffer = ''; wake(); return;
      }
      for (const line of lines) {
        if (!line.trim()) continue;
        try { onFrame(JSON.parse(line) as ProviderProcessEvent); }
        catch (error) { failure = error; wake(); break; }
      }
    });
    child.stderr.on('data', (text: string) => { stderr = (stderr + text).slice(-4000); });
    child.stdin.on('error', (error) => { failure = error; wake(); });
    void child.completion.then(wake, (error: unknown) => { failure = error; wake(); });
    child.stdin.write(JSON.stringify({ kind: 'job', job: safeJob }) + '\n');
    await ended;
    let cleanupFailure: unknown;
    try { await child.close(); }
    catch (error) {
      const expectedAbort = signal?.aborted && error instanceof Error && error.name === 'AbortError' && !(error as { workspaceCleanupError?: boolean }).workspaceCleanupError;
      if (!expectedAbort) {
        if ((error as { workspaceCleanupError?: boolean } | null)?.workspaceCleanupError) cleanupFailure = Object.assign(new Error('Provider sandbox cleanup was not confirmed.', { cause: error }), { processTeardownError: true, workspaceCleanupError: true });
        else failure ??= error; // Launcher errors are reported only after confirmed removal.
      }
    }
    if (cleanupFailure) { await runtime.finish?.('retain'); throw cleanupFailure; }
    await runtime.finish?.('publish');
    signal?.throwIfAborted();
    if (failure) throw failure;
    if (!terminal) throw runtimeError(`Provider sandbox exited before producing a result.${stderr ? ` ${stderr.trim()}` : ''}`);
    return terminal;
  };
}
