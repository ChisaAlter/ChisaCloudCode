import { existsSync, lstatSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { admitWorkspaceExecution } from '@/modules/workspace-bridge/index.js';
import { prepareProviderCodeCache, stageProviderCli } from '@/modules/providers/services/provider-code-cache.service.js';
import { prepareProviderProfile } from '@/modules/providers/services/provider-profile.service.js';
import { AppError, normalizeAttachmentDescriptors } from '@/shared/index.js';
import type { LLMProvider, ProviderProcessEvent, ProviderProcessJob, ProviderProcessRunner } from '@/shared/index.js';

type RuntimeMount = { source: string; target: string; writable: boolean };
type WorkspaceExecution = Awaited<ReturnType<typeof admitWorkspaceExecution>>;
type ContainerRuntime = {
  mounts: RuntimeMount[];
  env: Record<string, string>;
  args: string[];
  cli?: string;
  finish?(mode: 'publish' | 'discard' | 'retain'): Promise<void>;
};
type ContainerProviderDependencies = {
  sessionId?: string;
  resolveModelExecutable?(provider: Exclude<LLMProvider, 'claude'>, job: ProviderProcessJob): string | undefined;
  prepareRuntime(provider: Exclude<LLMProvider, 'claude'>, attachments: unknown, job: ProviderProcessJob, signal?: AbortSignal): ContainerRuntime | Promise<ContainerRuntime>;
  adaptJob(job: ProviderProcessJob, runtime: ContainerRuntime): ProviderProcessJob;
};

const CODE = '/runtime/provider-code';
const HOME = '/runtime/provider-state/home';
const PROVIDER_ENV_KEYS = new Set([
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY', 'CODEX_BASE_URL',
  'CURSOR_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL',
  'GOOGLE_GENERATIVE_AI_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY',
  'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT', 'AWS_REGION', 'AWS_DEFAULT_REGION',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
]);

function runtimeError(message: string) {
  return new AppError(message, { code: 'WORKSPACE_PROVIDER_RUNTIME_UNAVAILABLE', statusCode: 503 });
}

function canonical(filename: string) {
  const resolved = path.resolve(filename);
  if (!existsSync(resolved) || realpathSync(resolved) !== resolved || lstatSync(resolved).isSymbolicLink()) throw runtimeError('The provider runtime path is not a canonical installed file.');
  return resolved;
}

function addMount(mounts: RuntimeMount[], source: string, target: string, writable = false) {
  if (!existsSync(source)) return;
  const mount = { source: canonical(source), target, writable };
  if (mounts.some((existing) => existing.target === target)) throw runtimeError('The provider runtime has overlapping mount destinations.');
  mounts.push(mount);
}

function executableOnPath(command: string) {
  for (const directory of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, command);
    if (!existsSync(candidate)) continue;
    const resolved = realpathSync(candidate);
    if (!lstatSync(resolved).isFile()) continue;
    return resolved;
  }
  throw runtimeError('The selected provider CLI is not installed in the sandbox runtime.');
}

function providerCliMount(provider: Exclude<LLMProvider, 'claude' | 'codex'>, mounts: RuntimeMount[]) {
  const executable = executableOnPath(provider === 'cursor' ? 'cursor-agent' : 'opencode');
  const staged = stageProviderCli(executable);
  mounts.push(staged.mount);
  return staged.executable;
}

async function workerRuntime(provider: Exclude<LLMProvider, 'claude'>, attachments: unknown, job: ProviderProcessJob, signal?: AbortSignal, sessionId?: string, modelExecutable?: string): Promise<ContainerRuntime> {
  if (process.platform !== 'linux') throw runtimeError('Bound VPS provider execution requires the Linux container runtime.');
  const mounts: RuntimeMount[] = [prepareProviderCodeCache()];
  const env: Record<string, string> = { HOME, PATH: `${CODE}:/usr/local/bin:/usr/bin:/bin`, LANG: 'C.UTF-8' };
  for (const [key, value] of Object.entries(process.env)) if (PROVIDER_ENV_KEYS.has(key) && typeof value === 'string') env[key] = value;
  if (provider === 'codex') env.CODEX_HOME = `${HOME}/.codex`;
  if (provider === 'opencode') { env.XDG_DATA_HOME = `${HOME}/.local/share`; env.XDG_CONFIG_HOME = `${HOME}/.config`; }
  // Assets keep their verified original paths so persisted provider transcripts
  // retain clickable upload references and Codex image validation stays intact.
  const assets = path.join(os.homedir(), '.cloudcli', 'assets');
  for (const item of normalizeAttachmentDescriptors(attachments)) {
    const filename = path.resolve(item.path);
    if (path.dirname(filename) !== assets || !existsSync(filename) || !lstatSync(filename).isFile()) throw runtimeError('Only verified uploaded attachment files may enter the provider sandbox.');
    if (!mounts.some((mount) => mount.target === filename)) addMount(mounts, filename, filename);
  }
  const cli = modelExecutable ? (() => { const staged = stageProviderCli(modelExecutable); mounts.push(staged.mount); return staged.executable; })() : provider === 'codex' ? undefined : providerCliMount(provider, mounts);
  const args = [`${CODE}/app/provider-process.worker.js`, '--stdio'];
  const profile = await prepareProviderProfile(provider, sessionId ?? (job.kind === 'codex' ? job.providerSessionId ?? 'direct' : 'direct'), job, signal);
  mounts.push(...profile.mounts);
  return { mounts, env, args, cli, finish: profile.finish };
}

/**
 * The provider dispatcher uses this trusted runner only for an admitted VPS
 * workspace. The workspace module owns container mounts, exact lease tracking,
 * cancellation and confirmed removal; no client option selects those controls.
 */
export function createContainerProviderRunner(execution: WorkspaceExecution, provider: Exclude<LLMProvider, 'claude'>, attachments: unknown, overrides: Partial<ContainerProviderDependencies> = {}): ProviderProcessRunner {
  const dependencies: ContainerProviderDependencies = {
    prepareRuntime: (selected, assets, job, signal) => workerRuntime(selected, assets, job, signal, overrides.sessionId, overrides.resolveModelExecutable?.(selected, job)),
    adaptJob: (job, runtime) => job.kind === 'codex'
      ? { ...job, executable: runtime.cli, env: undefined }
      : { ...job, command: runtime.cli!, env: Object.fromEntries(Object.entries(job.env ?? {}).filter(([key]) => key === 'OPENCODE_PERMISSION')) },
    ...overrides,
  };
  return async (job, handlers, signal) => {
    signal?.throwIfAborted();
    const runtime = await dependencies.prepareRuntime(provider, attachments, job, signal);
    const safeJob = dependencies.adaptJob(job, runtime);
    let child: Awaited<ReturnType<WorkspaceExecution['spawnProcess']>>;
    try { child = await execution.spawnProcess({ command: `${CODE}/node`, args: runtime.args, cwd: execution.cwd, env: runtime.env, runtimeMounts: runtime.mounts, signal }); }
    catch (error) { await runtime.finish?.('discard'); throw error; }
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
