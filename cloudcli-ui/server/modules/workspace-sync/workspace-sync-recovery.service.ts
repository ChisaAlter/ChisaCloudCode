import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readlink, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { AppError, WORKSPACES_ROOT } from '@/shared/index.js';
import { isActiveWorkspaceLease } from '@/modules/workspace-bridge/index.js';

const execute = promisify(execFile);
const cleanupName = /^(?:chisa-rpc-(?:[a-f0-9]{16}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})|chisa-account-preview-[a-f0-9]{20}-[a-f0-9]{16})$/;

type RecoverableLease = {
  id: string;
  epoch: string;
  owner: 'claude' | 'sync-needed';
  pid?: number;
  processStartTime?: string;
  bootId?: string;
  cleanupPending?: unknown[];
};

function changedLease() {
  return new AppError('工作区预约已变化，请重新同步', { code: 'STALE_BINDING', statusCode: 409 });
}

function claudeBusy() {
  return new AppError('Claude 仍在运行，请等待任务结束', { code: 'WORKSPACE_BUSY', statusCode: 409 });
}

function processGone(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
    throw error;
  }
}

async function confirmClaudeStopped(root: string, lease: RecoverableLease) {
  if (lease.owner !== 'claude') return;
  if (!Number.isInteger(lease.pid) || Number(lease.pid) <= 0) throw changedLease();
  if (isActiveWorkspaceLease(root, lease.id, lease.epoch)) {
    throw claudeBusy();
  }
  if (lease.processStartTime !== undefined || lease.bootId !== undefined) {
    if (typeof lease.processStartTime !== 'string' || !/^\d+$/.test(lease.processStartTime) ||
      typeof lease.bootId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(lease.bootId)) throw changedLease();
    let processState: string;
    try { processState = await readFile('/proc/' + lease.pid + '/stat', 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (processGone(Number(lease.pid))) return;
        throw claudeBusy();
      }
      throw error;
    }
    const fields = processState.slice(processState.lastIndexOf(')') + 1).trim().split(/\s+/);
    if (fields.length <= 19 || !/^\d+$/.test(fields[19])) throw changedLease();
    const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
    if (fields[0] === 'Z' || fields[19] !== lease.processStartTime || bootId !== lease.bootId) return;
  } else if (lease.pid === process.pid) {
    // An older lease without birth identity cannot belong to this process when
    // its exact reservation is absent from the authoritative active registry.
    return;
  } else {
    // Legacy leases have no birth token. Only an explicit non-Node system
    // executable proves that a reused PID cannot be the original Node host.
    // Unknown/custom executables remain reserved; wall-clock timestamps cannot
    // establish identity after a clock correction.
    if (processGone(Number(lease.pid))) return;
    let processState: string;
    try { processState = await readFile('/proc/' + lease.pid + '/stat', 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && processGone(Number(lease.pid))) return;
      throw claudeBusy();
    }
    const fields = processState.slice(processState.lastIndexOf(')') + 1).trim().split(/\s+/);
    if (fields.length <= 19 || !/^\d+$/.test(fields[19])) throw changedLease();
    if (fields[0] === 'Z') return;
    try {
      const executable = (await readlink('/proc/' + lease.pid + '/exe')).replace(/ \(deleted\)$/, '');
      if (/^\/(?:usr\/)?s?bin\/(?:sleep|sh|bash|dash|python(?:\d+(?:\.\d+)?)?|ssh|sshd|systemd)$/.test(executable)) return;
    } catch {
      // Permission restrictions or unknown process roles are not proof of exit.
    }
  }
  if (processGone(Number(lease.pid))) return;
  throw claudeBusy();
}

/** The authenticated workspace-sync router checks host ownership before the desktop recovers its lease in the transport container. */
export async function checkWorkspaceSyncLeaseRecovery(serverPath: string, bindingEpoch: string) {
  const boundary = await realpath(WORKSPACES_ROOT);
  const root = await realpath(serverPath);
  if (!root.startsWith(boundary + path.sep) || !(await stat(root)).isDirectory()) {
    throw new AppError('工作目录不属于当前实例', { code: 'WORKSPACE_UNAVAILABLE', statusCode: 403 });
  }
  const leaseDirectory = root + '.chisa-lease';
  const statePath = path.join(leaseDirectory, 'state.json');
  const readLease = async (): Promise<RecoverableLease | null> => {
    try {
      const directory = await lstat(leaseDirectory);
      const stateFile = await lstat(statePath);
      if (!directory.isDirectory() || directory.isSymbolicLink() || !stateFile.isFile() || stateFile.isSymbolicLink()) {
        throw changedLease();
      }
      const lease = JSON.parse(await readFile(statePath, 'utf8')) as RecoverableLease;
      if (!lease || lease.epoch !== bindingEpoch || typeof lease.id !== 'string' ||
        !['claude', 'sync-needed'].includes(lease.owner) ||
        (lease.cleanupPending !== undefined && !Array.isArray(lease.cleanupPending))) {
        throw changedLease();
      }
      return lease;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  };
  const current = await readLease();
  if (!current) return { ok: true, lease: null };
  await confirmClaudeStopped(root, current);
  const confirmCurrent = async () => {
    const latest = await readLease();
    if (!latest || latest.id !== current.id || latest.owner !== current.owner ||
      JSON.stringify(latest.cleanupPending ?? []) !== JSON.stringify(current.cleanupPending ?? [])) throw changedLease();
    await confirmClaudeStopped(root, latest);
  };
  const rootLabel = createHash('sha256').update(root).digest('hex');
  for (const name of current.cleanupPending ?? []) {
    if (typeof name !== 'string' || !cleanupName.test(name)) {
      throw new AppError('工作区清理记录无效', { code: 'WORKSPACE_CLEANUP_FAILED', statusCode: 409 });
    }
    await confirmCurrent();
    let existing: { Config?: { Labels?: Record<string, string> } } | null;
    try {
      const inspected = await execute('docker', ['container', 'inspect', name], { timeout: 10_000, maxBuffer: 1024 * 1024 });
      existing = (JSON.parse(inspected.stdout) as { Config?: { Labels?: Record<string, string> } }[])[0] ?? null;
    } catch (error) {
      if (!/No such (?:object|container)/i.test((error as Error & { stderr?: string }).stderr ?? '')) throw error;
      existing = null;
    }
    if (existing) {
      if (existing.Config?.Labels?.['chisa.workspace-root'] !== rootLabel) {
        throw new AppError('清理容器不属于当前工作目录', { code: 'WORKSPACE_CLEANUP_FAILED', statusCode: 403 });
      }
      await confirmCurrent();
      try { await execute('docker', ['rm', '--force', name], { timeout: 10_000, maxBuffer: 1024 * 1024 }); }
      catch {
        // The daemon query below distinguishes an already removed container from unconfirmed cleanup.
      }
    }
    const remaining = await execute('docker', ['ps', '--all', '--format', '{{.Names}}', '--filter', 'name=^/' + name + '$'], {
      timeout: 10_000, maxBuffer: 1024 * 1024,
    });
    if (remaining.stdout.trim()) {
      throw new AppError('容器清理尚未确认，请保留工作区预约', { code: 'WORKSPACE_CLEANUP_FAILED', statusCode: 503 });
    }
  }
  await confirmCurrent();
  // Only the desktop lease operation can replace state after its own synchronization-process checks.
  return { ok: true, lease: current };
}
