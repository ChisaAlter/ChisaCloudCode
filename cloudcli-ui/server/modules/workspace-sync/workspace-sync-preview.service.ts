import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import { isIP } from 'node:net';

import { AppError, WORKSPACES_ROOT, getWorkspaceSyncNetwork } from '@/shared/index.js';
import { prepareSyncTransportPreview } from '@/modules/workspace-bridge/index.js';

const execute = promisify(execFile);

/** The authenticated sync preview router runs previews on the server, without exposing its container socket to SSH clients. */
export function createWorkspaceSyncPreviewService() {
  const run = (args: string[], timeout = 15_000, signal?: AbortSignal) => new Promise<string>((resolve, reject) => {
    let failure: unknown;
    let output = '';
    const child = execFile('docker', args, { timeout, maxBuffer: 1024 * 1024, encoding: 'utf8', signal }, (error, stdout, stderr) => {
      if (error) failure = Object.assign(error, { stderr });
      output = stdout;
    });
    child.once('error', error => { failure = error; });
    // Abort can reject execFile before the Docker client exits; wait before removing its known container.
    child.once('close', () => { if (failure) reject(failure); else resolve(output); });
  });
  const owner = (userId: string) => createHash('sha256').update(path.resolve(WORKSPACES_ROOT) + '\0' + userId).digest('hex').slice(0, 20);
  const requireOwned = async (userId: string, id: string, missingAllowed = false) => {
    if (!new RegExp('^chisa-account-preview-' + owner(userId) + '-[a-f0-9]{16}$').test(id)) {
      throw new AppError('预览不属于当前账号', { code: 'PREVIEW_NOT_FOUND', statusCode: 404 });
    }
    let label: string;
    try { label = (await run(['inspect', '--format', '{{index .Config.Labels "chisa.sync-preview.owner"}}', id])).trim(); }
    catch (error) {
      if (/No such (?:object|container)/i.test((error as Error & { stderr?: string }).stderr ?? '')) {
        if (missingAllowed) return false;
        throw new AppError('预览不存在', { code: 'PREVIEW_NOT_FOUND', statusCode: 404 });
      }
      throw error;
    }
    if (label !== owner(userId)) throw new AppError('预览不属于当前账号', { code: 'PREVIEW_NOT_FOUND', statusCode: 404 });
    return true;
  };
  const discard = async (userId: string, id: string, missingAllowed = true) => {
    if (!(await requireOwned(userId, id, missingAllowed))) return;
    await run(['rm', '--force', id]);
    if (await requireOwned(userId, id, true)) {
      throw new AppError('预览容器清理未确认', { code: 'PREVIEW_CLEANUP_FAILED', statusCode: 503 });
    }
  };

  return {
    discard,
    async start(userId: string, serverPath: string, bindingEpoch: string, command: string, cwd: string, port: number, signal?: AbortSignal) {
      signal?.throwIfAborted();
      const reservation = prepareSyncTransportPreview(serverPath, bindingEpoch);
      const { root } = reservation;
      const id = 'chisa-account-preview-' + owner(userId) + '-' + randomBytes(8).toString('hex');
      let containerRequested = false;
      try {
        const network = getWorkspaceSyncNetwork(root);
        if (!network) {
          throw new AppError('Workspace synchronization network is not ready', { code: 'WORKSPACE_SYNC_UNAVAILABLE', statusCode: 503 });
        }
        signal?.throwIfAborted();
        containerRequested = true;
        await run(['run', '--detach', '--name', id, '--label', 'chisa.sync-preview.owner=' + owner(userId),
        '--label', 'chisa.sync-preview.epoch=' + bindingEpoch, '--label', 'chisa.sync-preview.port=' + port,
        '--label', 'chisa.workspace-root=' + createHash('sha256').update(root).digest('hex'), '--network=' + network,
        '--user=1000:1000', '--cap-drop=ALL', '--security-opt=no-new-privileges',
        '--pids-limit=256', '--memory=2g', '--hostname=workspace', '--read-only',
        '--tmpfs=/tmp:rw,size=512m', '--tmpfs=/home/chisa:rw,size=512m', '--volume', root + ':/workspace:rw',
        '--mount', 'type=bind,src=' + path.join(root, '.chisa-bridge.json') + ',dst=/workspace/.chisa-bridge.json,readonly',
        '--env=HOME=/home/chisa', '--env=TZ=UTC', '--workdir', cwd,
          'localhost/chisa-workspace:2', 'bash', '-c', command], 30_000, signal);
        signal?.throwIfAborted();
        const remoteHost = (await run(['inspect', '--format', '{{(index .NetworkSettings.Networks "' + network + '").IPAddress}}', id], 15_000, signal)).trim();
        if (isIP(remoteHost) !== 4) throw new Error('Invalid preview address');
        signal?.throwIfAborted();
        await reservation.finish(true);
        return { id, remoteHost, remotePort: port };
      } catch (error) {
        try { if (containerRequested) await discard(userId, id); }
        catch (cleanupError) {
          await reservation.finish(false, id);
          throw Object.assign(new AppError('预览启动失败，且容器清理未确认', { code: 'PREVIEW_CLEANUP_FAILED', statusCode: 503 }), { cause: error, cleanupError });
        }
        try { await reservation.finish(true); }
        catch (releaseError) { await reservation.finish(false); throw releaseError; }
        throw error;
      }
    },
    async list(userId: string) {
      const ids = (await run(['ps', '--all', '--quiet', '--filter', 'label=chisa.sync-preview.owner=' + owner(userId)])).trim().split(/\s+/).filter(Boolean);
      if (ids.length === 0) return { previews: [] };
      const containers = JSON.parse(await run(['inspect', ...ids])) as Array<{
        Name: string;
        Config: { Labels: Record<string, string> };
        Mounts: Array<{ Source: string; Destination: string }>;
        NetworkSettings: { Networks: Record<string, { IPAddress?: string }> };
      }>;
      const boundary = path.resolve(WORKSPACES_ROOT) + path.sep;
      const previews = containers.flatMap(container => {
        const id = container.Name.replace(/^\//, '');
        const labels = container.Config.Labels;
        if (!new RegExp('^chisa-account-preview-' + owner(userId) + '-[a-f0-9]{16}$').test(id) || labels['chisa.sync-preview.owner'] !== owner(userId)) return [];
        const mount = container.Mounts.find(entry => entry.Destination === '/workspace');
        if (!mount) return [];
        const serverPath = path.resolve(mount.Source);
        if (!serverPath.startsWith(boundary) || labels['chisa.workspace-root'] !== createHash('sha256').update(serverPath).digest('hex')) return [];
        const network = getWorkspaceSyncNetwork(serverPath);
        const remoteHost = (network ? container.NetworkSettings.Networks[network]?.IPAddress : undefined)
          ?? Object.values(container.NetworkSettings.Networks).find(entry => isIP(entry.IPAddress ?? '') === 4)?.IPAddress ?? '';
        return [{ id, serverPath, bindingEpoch: labels['chisa.sync-preview.epoch'] ?? '', remoteHost,
          remotePort: Number(labels['chisa.sync-preview.port'] ?? 0) }];
      });
      return { previews };
    },
    async inspect(userId: string, id: string) {
      await requireOwned(userId, id);
      return JSON.parse(await run(['inspect', '--format', '{{json .State}}', id])) as Record<string, unknown>;
    },
    async logs(userId: string, id: string) {
      await requireOwned(userId, id);
      const result = await execute('docker', ['logs', '--tail', '100', id], { timeout: 10_000, maxBuffer: 1024 * 1024 });
      return { stdout: result.stdout, stderr: result.stderr };
    },
    async remove(userId: string, id: string) {
      await discard(userId, id, false);
      return { ok: true };
    },
  };
}
