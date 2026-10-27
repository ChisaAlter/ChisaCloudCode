import { exec } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import type { ProjectActionRow } from '@/modules/database/index.js';
import { runSshWorkspaceCommand, runWorkspaceCommand, workspaceRequestSignal } from '@/modules/workspace-bridge/index.js';
import type { WorkspaceDescriptor } from '@/shared/index.js';

const execAsync = promisify(exec);
const OUTPUT_LIMIT = 120_000;
const DEFAULT_TIMEOUT_MS = 120_000;

export type ProjectActionRunResult = {
  actionId: string;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
  workspaceMode: 'bridged' | 'direct';
};

function clip(value: string, limit = OUTPUT_LIMIT): { value: string; truncated: boolean } {
  return value.length > limit
    ? { value: value.slice(0, limit) + '\n… output truncated …', truncated: true }
    : { value, truncated: false };
}

function powershellCwd(command: string, cwd: string | null): string {
  if (!cwd) return command;
  return `Set-Location -LiteralPath '${cwd.replace(/'/g, "''")}'; ${command}`;
}

function normalizedExitCode(code: unknown): number {
  if (typeof code === 'number' && Number.isFinite(code)) return code;
  const parsed = Number(code);
  return Number.isFinite(parsed) ? parsed : 1;
}

/**
 * Executes one saved project action in the selected workspace. Bound projects
 * use the bridge's admission/RPC lifecycle; an unbound local install falls
 * back to a normal child process, never to a different project directory.
 */
export async function executeProjectAction(
  descriptor: WorkspaceDescriptor,
  action: ProjectActionRow,
): Promise<ProjectActionRunResult> {
  const startedAt = Date.now();
  const relativeCwd = action.cwd ?? null;
  const cwd = relativeCwd ? path.join(descriptor.rootPath, relativeCwd) : descriptor.rootPath;

  if (descriptor.sourceMode === 'ssh') {
    const result = await runSshWorkspaceCommand(
      descriptor,
      powershellCwd(action.command, relativeCwd),
      workspaceRequestSignal(),
    );
    const stdout = clip(result.stdout ?? '');
    const stderr = clip(result.stderr ?? '');
    return {
      actionId: action.id,
      command: action.command,
      exitCode: normalizedExitCode(result.exitCode),
      stdout: stdout.value,
      stderr: stderr.value,
      truncated: stdout.truncated || stderr.truncated || result.truncated === true,
      durationMs: Date.now() - startedAt,
      workspaceMode: 'bridged',
    };
  }

  const bridged = await runWorkspaceCommand(
    cwd,
    'bash',
    ['-lc', action.command],
    { readOnly: false, timeoutSeconds: 600 },
  );
  if (bridged) {
    const stdout = clip(bridged.stdout ?? '');
    const stderr = clip(bridged.stderr ?? '');
    return {
      actionId: action.id,
      command: action.command,
      exitCode: normalizedExitCode(bridged.exitCode),
      stdout: stdout.value,
      stderr: stderr.value,
      truncated: stdout.truncated || stderr.truncated || bridged.truncated === true,
      durationMs: Date.now() - startedAt,
      workspaceMode: 'bridged',
    };
  }

  // Unbound local install: run directly in the project directory. The command
  // is an explicit project setting, not model-generated input.
  const windows = process.platform === 'win32';
  const shell = windows ? 'powershell.exe' : 'bash';
  const args = windows ? ['-NoLogo', '-NoProfile', '-Command', action.command] : ['-lc', action.command];
  try {
    const result = await execAsync(`"${shell}" ${args.map((arg) => JSON.stringify(arg)).join(' ')}`, {
      cwd,
      timeout: DEFAULT_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    const stdout = clip(result.stdout);
    const stderr = clip(result.stderr);
    return {
      actionId: action.id,
      command: action.command,
      exitCode: 0,
      stdout: stdout.value,
      stderr: stderr.value,
      truncated: stdout.truncated || stderr.truncated,
      durationMs: Date.now() - startedAt,
      workspaceMode: 'direct',
    };
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: string; stderr?: string; killed?: boolean; signal?: string };
    const stdout = clip(failure.stdout ?? '');
    const stderr = clip(failure.stderr ?? '');
    return {
      actionId: action.id,
      command: action.command,
      exitCode: failure.killed ? 124 : normalizedExitCode(failure.code),
      stdout: stdout.value,
      stderr: stderr.value || (failure.killed ? 'Command timed out' : ''),
      truncated: stdout.truncated || stderr.truncated,
      durationMs: Date.now() - startedAt,
      workspaceMode: 'direct',
    };
  }
}
