import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { AppError } from '@/shared/index.js';

const execute = promisify(execFile);

type LegacyTransport = {
  Id?: string;
  Name?: string;
  Config?: { Labels?: Record<string, string> };
  HostConfig?: { Privileged?: boolean; NetworkMode?: string; RestartPolicy?: { Name?: string } };
  State?: { Running?: boolean; Restarting?: boolean };
  Mounts?: Array<{ Type?: string; Source?: string; Destination?: string; RW?: boolean }>;
};

/** Runtime restoration retires only its verified former sync transport, retaining the container and all project files. */
export async function retireWorkspaceSyncTransport(root: string, owner: string): Promise<void> {
  const name = 'chisa-workspace-sync-' + owner;
  const run = (args: string[]) => execute('docker', args, { timeout: 25_000, maxBuffer: 1024 * 1024 });
  const inspect = async (target: string): Promise<LegacyTransport | null> => {
    let output: string;
    try { output = (await run(['container', 'inspect', target])).stdout; }
    catch (error) {
      const diagnostic = ((error as Error & { stderr?: string }).stderr ?? '').trim();
      if (diagnostic.split('\n').some(line => new RegExp('^(?:Error(?: response from daemon)?: )?No such (?:object|container): ' + target + '\\s*$', 'i').test(line))) return null;
      throw error;
    }
    const values: unknown = JSON.parse(output);
    if (!Array.isArray(values) || values.length !== 1 || !values[0] || typeof values[0] !== 'object') {
      throw new AppError('旧同步容器状态无效，尚未接管云端工作区', { code: 'WORKSPACE_RUNTIME_MISMATCH', statusCode: 503 });
    }
    return values[0] as LegacyTransport;
  };
  const container = await inspect(name);
  if (!container) return;
  const configuration = path.join(os.homedir(), '.chisa-workspace-sync', owner);
  const mounts = container.Mounts ?? [];
  const project = mounts.find(mount => mount.Destination === root);
  const config = mounts.find(mount => mount.Destination === '/etc/chisa-sync');
  const staging = mounts.find(mount => mount.Destination === '/root/.mutagen/staging');
  if (!/^[a-f0-9]{64}$/.test(container.Id ?? '') || container.Name !== '/' + name
    || container.Config?.Labels?.['chisa.workspace-sync.owner'] !== owner || container.HostConfig?.Privileged !== false
    || !['bridge', 'chisa-workspace-network-' + owner].includes(container.HostConfig?.NetworkMode ?? '')
    || project?.Type !== 'bind' || project.Source !== root || project.RW !== true
    || config?.Type !== 'bind' || config.Source !== configuration || config.RW !== false
    || (staging ? mounts.length !== 3 || staging.Type !== 'bind' || staging.Source !== path.join(configuration, 'staging') || staging.RW !== true : mounts.length !== 2)) {
    throw new AppError('旧同步容器不属于当前账号，未停止该容器', { code: 'WORKSPACE_RUNTIME_MISMATCH', statusCode: 503 });
  }
  // Pin the immutable Docker id so a concurrent name replacement cannot select another container.
  const id = container.Id!;
  if (container.HostConfig?.RestartPolicy?.Name !== 'no') await run(['update', '--restart=no', id]);
  if (container.State?.Running || container.State?.Restarting) await run(['stop', '--time', '10', id]);
  const retired = await inspect(id);
  if (retired && (retired.Id !== id || retired.State?.Running !== false || retired.State.Restarting === true || retired.HostConfig?.RestartPolicy?.Name !== 'no')) {
    throw new AppError('旧同步进程停止尚未确认，云端工作区暂不可用', { code: 'WORKSPACE_RUNTIME_UNAVAILABLE', statusCode: 503 });
  }
}
