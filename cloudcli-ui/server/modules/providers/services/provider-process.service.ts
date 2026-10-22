import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { ProviderProcessEvent, ProviderProcessJob } from '@/shared/index.js';

type ProcessHandlers = {
  stdout?(text: string): void;
  stderr?(text: string): void;
  event?(event: Record<string, any>): void;
};

const GRACEFUL_STOP_MS = 800;
const TEARDOWN_TIMEOUT_MS = 10_000;

// Assign the waiting worker before it can spawn a CLI. Job membership retains
// orphan tools after their immediate CLI parent exits; KILL_ON_JOB_CLOSE also
// covers a lost supervisor. Source is embedded because tsc copies no assets.
const WINDOWS_JOB_OWNER = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class ProviderProcessJob {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long ProcessTime, JobTime; public uint Flags; public UIntPtr Min, Max;
    public uint ActiveLimit; public UIntPtr Affinity; public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong A, B, C, D, E, F; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessMemory, JobMemory, PeakProcess, PeakJob;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long User, Kernel, PeriodUser, PeriodKernel; public uint Faults, Total, Active, Terminated;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attrs, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out Accounting info, uint size, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint rights, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  public static IntPtr Attach(int pid) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      ExtendedLimits limits = new ExtendedLimits(); limits.Basic.Flags = 0x2000;
      Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))));
      IntPtr process = OpenProcess(0x0100 | 0x0001, false, pid);
      if (process == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
      try { Check(AssignProcessToJobObject(job, process)); } finally { CloseHandle(process); }
      return job;
    } catch { CloseHandle(job); throw; }
  }
  public static void Stop(IntPtr job) { Check(TerminateJobObject(job, 1)); }
  public static uint Active(IntPtr job) {
    Accounting info; Check(QueryInformationJobObject(job, 1, out info, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
    return info.Active;
  }
  public static void Close(IntPtr job) { CloseHandle(job); }
}
'@
$jobHandle = [IntPtr]::Zero
try {
  $jobHandle = [ProviderProcessJob]::Attach([int]$env:CHISA_PROVIDER_WORKER_PID)
  [Console]::Out.WriteLine('READY')
  [Console]::Out.Flush()
  $null = [Console]::ReadLine()
  [ProviderProcessJob]::Stop($jobHandle)
  $deadline = [DateTime]::UtcNow.AddSeconds(8)
  while ([ProviderProcessJob]::Active($jobHandle) -gt 0) {
    if ([DateTime]::UtcNow -ge $deadline) { throw 'Provider job still contains active processes.' }
    Start-Sleep -Milliseconds 25
  }
  [Console]::Out.WriteLine('DRAINED')
  [Console]::Out.Flush()
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
} finally {
  if ($jobHandle -ne [IntPtr]::Zero) { [ProviderProcessJob]::Close($jobHandle) }
}
`;

function teardownError(message: string, cause?: unknown) {
  return Object.assign(new Error(message, { cause }), {
    code: 'PROVIDER_PROCESS_TEARDOWN_FAILED',
    processTeardownError: true,
    workspaceCleanupError: true,
  });
}

/**
 * Providers' Codex/Cursor/OpenCode adapters use this worker boundary to await
 * real CLI/tool-tree teardown. A finished stream is not proof of process exit.
 * The worker remains alive until the supervisor reaps its entire owned tree.
 */
export async function runProviderProcess(
  job: ProviderProcessJob,
  handlers: ProcessHandlers,
  signal?: AbortSignal,
): Promise<{ code: number | null; error?: { name: string; message: string } }> {
  signal?.throwIfAborted();
  const compiledWorker = new URL('./provider-process.worker.js', import.meta.url);
  const sourceWorker = new URL('./provider-process.worker.ts', import.meta.url);
  const sourceMode = !existsSync(compiledWorker);
  const workerPath = fileURLToPath(sourceMode ? sourceWorker : compiledWorker);
  // Use an explicit loader in source mode rather than inheriting --test and
  // accidentally turning the worker into a second test runner.
  const loader = sourceMode ? pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href : null;
  const child = spawn(process.execPath, [...(loader ? ['--import', loader] : []), workerPath], {
    cwd: job.kind === 'cli' ? job.cwd : job.threadOptions.workingDirectory,
    env: process.env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    windowsHide: true,
  });

  const windowsOwner = process.platform === 'win32' && child.pid ? spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_JOB_OWNER], {
    env: { ...process.env, CHISA_PROVIDER_WORKER_PID: String(child.pid) },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  }) : null;
  let ownerReady = false;
  let ownerDrained = false;
  let ownerOutput = '';
  let ownerFailure: unknown;
  let ownerExitCode: number | null = null;
  let ownerClosed = false;
  let readyTimeout: NodeJS.Timeout | undefined;
  let resolveOwnerReady!: () => void;
  let rejectOwnerReady!: (error: unknown) => void;
  const ownerReadyPromise = windowsOwner ? new Promise<void>((resolve, reject) => {
    resolveOwnerReady = resolve;
    rejectOwnerReady = reject;
    readyTimeout = setTimeout(() => reject(new Error('Provider process ownership was not established within 10 seconds.')), TEARDOWN_TIMEOUT_MS);
  }) : Promise.resolve();
  void ownerReadyPromise.catch(() => {});
  const ownerClosedPromise = windowsOwner ? new Promise<void>((resolve) => {
    windowsOwner.once('close', (code) => {
      ownerExitCode = code;
      ownerClosed = true;
      if (!ownerReady) rejectOwnerReady(ownerFailure ?? new Error('Provider process ownership could not be established.'));
      resolve();
    });
  }) : Promise.resolve();
  windowsOwner?.stdin?.on('error', (error) => { ownerFailure = error; });
  windowsOwner?.on('error', (error) => { ownerFailure = error; rejectOwnerReady(error); });
  windowsOwner?.stderr?.on('data', () => { ownerFailure ??= teardownError('Windows could not confirm provider process ownership.'); });
  windowsOwner?.stdout?.on('data', (chunk: Buffer) => {
    ownerOutput += chunk.toString();
    const lines = ownerOutput.split(/\r?\n/);
    ownerOutput = lines.pop() || '';
    for (const line of lines) {
      if (line.trim() === 'READY') {
        ownerReady = true;
        if (readyTimeout) clearTimeout(readyTimeout);
        resolveOwnerReady();
      } else if (line.trim() === 'DRAINED') ownerDrained = true;
    }
  });

  let spawnFailure: Error | undefined;
  let workerStderr = '';
  const closedPromise = new Promise<void>((resolve) => {
    child.once('close', () => { resolve(); });
  });
  child.stderr?.on('data', (chunk: Buffer) => { workerStderr = (workerStderr + chunk.toString()).slice(-4000); });
  child.on('error', (error) => { spawnFailure = error; });

  let terminal: { code: number | null; error?: { name: string; message: string } } | undefined;
  let handlerFailure: unknown;
  let stopPromise: Promise<void> | undefined;
  let stopFailure: unknown;
  let resolveTerminal!: () => void;
  const terminalPromise = new Promise<void>((resolve) => { resolveTerminal = resolve; });

  const stopTree = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      if (!child.pid) {
        await closedPromise;
        return;
      }
      const pid = child.pid;
      let timeout: NodeJS.Timeout | undefined;
      let escalation: NodeJS.Timeout | undefined;
      let observation: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          (async () => {
            if (process.platform === 'win32') {
              if (dispatched && ownerReady && windowsOwner) {
                windowsOwner.stdin.end('stop\n');
                await ownerClosedPromise;
                if (ownerExitCode !== 0 || !ownerDrained) throw teardownError('Windows did not confirm an empty provider process job.', ownerFailure);
              } else {
                // No job was dispatched before READY, so only our empty worker
                // exists. Never guess at or enumerate unrelated host processes.
                child.kill();
                windowsOwner?.stdin?.end();
                if (!ownerClosed) windowsOwner?.kill();
                await ownerClosedPromise;
              }
              await closedPromise;
              return;
            }

            const exists = () => {
              try { process.kill(-pid, 0); return true; }
              catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
                throw error;
              }
            };
            const kill = (name: NodeJS.Signals) => {
              try { process.kill(-pid, name); }
              catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
            };
            kill('SIGTERM');
            escalation = setTimeout(() => {
              try { kill('SIGKILL'); } catch (error) { stopFailure = error; }
            }, GRACEFUL_STOP_MS);
            await closedPromise;
            if (!exists()) return;
            await new Promise<void>((resolve, reject) => {
              observation = setInterval(() => {
                try { if (!exists()) resolve(); } catch (error) { reject(error); }
              }, 25);
            });
          })(),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => reject(teardownError('Provider process tree teardown was not confirmed within 10 seconds.')), TEARDOWN_TIMEOUT_MS);
          }),
        ]);
        if (stopFailure) throw stopFailure;
      } catch (error) {
        throw teardownError('Provider tools may still be running; workspace ownership is retained.', error);
      } finally {
        if (timeout) clearTimeout(timeout);
        if (escalation) clearTimeout(escalation);
        if (observation) clearInterval(observation);
      }
    })();
    // Cancellation listeners cannot return promises. Preserve any failure for
    // the awaiting run instead of turning it into an unhandled rejection.
    void stopPromise.catch((error: unknown) => { stopFailure = error; });
    return stopPromise;
  };

  let dispatched = false;
  const cancel = () => {
    if (dispatched && child.connected) child.send({ kind: 'cancel' }, () => {});
    void stopTree();
    resolveTerminal();
  };
  signal?.addEventListener('abort', cancel, { once: true });
  child.on('message', (event: ProviderProcessEvent) => {
    if (!event || typeof event !== 'object') return;
    try {
      if (event.kind === 'stdout') handlers.stdout?.(event.text);
      else if (event.kind === 'stderr') handlers.stderr?.(event.text);
      else if (event.kind === 'event') handlers.event?.(event.event);
      else if (event.kind === 'done' && !terminal) {
        terminal = { code: event.code, ...(event.error ? { error: event.error } : {}) };
        resolveTerminal();
      }
    } catch (error) {
      handlerFailure = error;
      resolveTerminal();
    }
  });
  child.once('close', resolveTerminal);

  try {
    if (signal?.aborted) cancel();
    await Promise.race([ownerReadyPromise, terminalPromise]);
    signal?.throwIfAborted();
    dispatched = true;
    child.send({ kind: 'job', job }, (error) => {
      if (error) { handlerFailure = error; resolveTerminal(); }
    });
    await terminalPromise;
  } finally {
    signal?.removeEventListener('abort', cancel);
    if (readyTimeout) clearTimeout(readyTimeout);
    await stopTree();
  }
  if (handlerFailure) throw handlerFailure;
  signal?.throwIfAborted();
  if (spawnFailure) throw spawnFailure;
  if (!terminal) throw new Error(`Provider worker exited without a result.${workerStderr ? ` ${workerStderr.trim()}` : ''}`);
  return terminal;
}
