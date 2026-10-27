import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';

import { recoverStoppedWorkspacePreview } from '@/modules/workspace-bridge/index.js';
import { AppError, WORKSPACES_ROOT, getWorkspaceSyncNetwork, type WorkspaceRuntimePreviewReservation } from '@/shared/index.js';

import { createWorkspaceRuntimeService, getWorkspaceRuntimeIdentity } from './workspace-runtime.service.js';
import { createWorkspaceRuntimePreviewAccess, getWorkspaceRuntimePreviewUrl, revokeWorkspaceRuntimePreviewAccess } from './workspace-runtime-preview-access.service.js';
import { listWorkspaceRuntimePreviewWitnesses, persistWorkspaceRuntimePreviewWitness, readWorkspaceRuntimePreviewWitness, removeWorkspaceRuntimePreviewWitness } from './workspace-runtime-preview-witness.service.js';

const execute = promisify(execFile);
const activePreviews = new Map<string, { userId: string; reservation: WorkspaceRuntimePreviewReservation; startupFinished: boolean; finishPending: boolean; containerAbsent: boolean; cleanupConfirmed: boolean }>();
const previewCleanups = new Map<string, Promise<void>>();
const privatePreviewAddress = (address: string | undefined): address is string =>
  !!address && isIP(address) === 4 && /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(address);

/** Server-owned Docker previews; callers provide an exact workspace reservation. */
export function createWorkspaceRuntimePreviewService() {
  const run = (args: string[], timeout = 15_000, signal?: AbortSignal) => new Promise<string>((resolve, reject) => {
    let failure: unknown;
    let output = '';
    const child = execFile('docker', args, { timeout, maxBuffer: 1024 * 1024, encoding: 'utf8', signal }, (error, stdout, stderr) => {
      if (error) failure = Object.assign(error, { stderr });
      output = stdout;
    });
    child.once('error', error => { failure = error; });
    // Abort can reject execFile before the Docker client exits; cleanup waits for close.
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
    const key = userId + '\0' + id;
    const current = previewCleanups.get(key);
    if (current) return current;
    const cleanup = (async () => {
      const active = activePreviews.get(id);
      if (active?.userId === userId) revokeWorkspaceRuntimePreviewAccess(id);
      try {
        if (await requireOwned(userId, id, missingAllowed)) {
          revokeWorkspaceRuntimePreviewAccess(id);
          await run(['rm', '--force', id]);
          if (await requireOwned(userId, id, true)) throw new AppError('预览容器清理未确认', { code: 'PREVIEW_CLEANUP_FAILED', statusCode: 503 });
        }
      } catch (error) {
        if (active?.userId === userId) await active.reservation.release(id, false);
        throw error;
      }
      if (active?.userId === userId) {
        active.containerAbsent = true;
        await active.reservation.release(id, true);
        active.cleanupConfirmed = true;
        // Startup settlement can still fail after container removal. Keep its
        // witness and callback until both halves of the reservation are settled.
        if (active.startupFinished) {
          if (active.finishPending) {
            await active.reservation.finish(true);
            active.finishPending = false;
          }
          await removeWorkspaceRuntimePreviewWitness(userId, id, active.reservation.root);
          if (activePreviews.get(id) === active) activePreviews.delete(id);
        }
      } else {
        const witness = await readWorkspaceRuntimePreviewWitness(userId, id);
        if (witness) {
          await recoverStoppedWorkspacePreview({ userId, accountRoot: witness.accountRoot, root: witness.root, previewId: id });
          await removeWorkspaceRuntimePreviewWitness(userId, id, witness.root);
        }
      }
    })();
    // Browser stop and session close may race; one removal releases the exact
    // retained lease once, while later recovery retries remain possible.
    previewCleanups.set(key, cleanup);
    try { await cleanup; }
    finally { if (previewCleanups.get(key) === cleanup) previewCleanups.delete(key); }
  };

  return {
    discard,
    async start(userId: string, bindingEpoch: string, command: string, cwd: string, port: number, reservation: WorkspaceRuntimePreviewReservation, signal?: AbortSignal) {
      const { root } = reservation;
      const id = 'chisa-account-preview-' + owner(userId) + '-' + randomBytes(8).toString('hex');
      let containerRequested = false;
      const finishStartup = async (cleanupConfirmed = true) => {
        const active = activePreviews.get(id);
        try { await reservation.finish(cleanupConfirmed, cleanupConfirmed ? undefined : id); }
        finally { if (active?.reservation === reservation) active.startupFinished = true; }
        if (active?.reservation === reservation) {
          active.finishPending = false;
          if (active.cleanupConfirmed) {
            await removeWorkspaceRuntimePreviewWitness(userId, id, root);
            if (activePreviews.get(id) === active) activePreviews.delete(id);
          }
        }
      };
      try {
        const network = getWorkspaceSyncNetwork(root);
        if (!network) throw new AppError('Workspace runtime network is not ready', { code: 'WORKSPACE_SYNC_UNAVAILABLE', statusCode: 503 });
        const metadataMounts: string[] = [];
        const sessionMetadata = path.join(root, '.chisa-session.json');
        const sessionFile = await lstat(sessionMetadata).catch(error => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
          throw error;
        });
        if (sessionFile) {
          if (!sessionFile.isFile() || sessionFile.isSymbolicLink()) throw new AppError('Session metadata is not canonical', { code: 'STALE_BINDING', statusCode: 409 });
          metadataMounts.push('--mount', 'type=bind,src=/dev/null,dst=/workspace/.chisa-session.json,readonly');
          const gitPointer = path.join(root, '.git');
          const gitFile = await lstat(gitPointer).catch(error => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
            throw error;
          });
          if (gitFile) {
            if (gitFile.isSymbolicLink() || await realpath(gitPointer) !== gitPointer) throw new AppError('Session Git pointer is not canonical', { code: 'STALE_BINDING', statusCode: 409 });
            metadataMounts.push('--mount', 'type=bind,src=' + gitPointer + ',dst=/workspace/.git,readonly');
          }
        }
        signal?.throwIfAborted();
        // Persist the exact container before spawning Docker. Session close and
        // crash recovery must account for it even if startup never returns.
        reservation.retain(id, () => discard(userId, id));
        activePreviews.set(id, { userId, reservation, startupFinished: false, finishPending: true, containerAbsent: false, cleanupConfirmed: false });
        containerRequested = true;
        await persistWorkspaceRuntimePreviewWitness(userId, id, reservation);
        signal?.throwIfAborted();
        const url = createWorkspaceRuntimePreviewAccess(userId, id, root, bindingEpoch, port, network);
        await run(['run', '--detach', '--name', id, '--label', 'chisa.sync-preview.owner=' + owner(userId),
          '--label', 'chisa.sync-preview.epoch=' + bindingEpoch, '--label', 'chisa.sync-preview.port=' + port,
          '--label', 'chisa.workspace-root=' + createHash('sha256').update(root).digest('hex'), '--network=' + network,
          '--user=1000:1000', '--cap-drop=ALL', '--security-opt=no-new-privileges',
          '--pids-limit=256', '--memory=2g', '--hostname=workspace', '--read-only',
          '--tmpfs=/tmp:rw,size=512m', '--tmpfs=/home/chisa:rw,size=512m', '--volume', root + ':/workspace:rw',
          '--mount', 'type=bind,src=/dev/null,dst=/workspace/.chisa-bridge.json,readonly', ...metadataMounts,
          '--env=HOME=/home/chisa', '--env=TZ=UTC', '--env=CHISA_PREVIEW_BASE=' + url, '--workdir', cwd,
          'localhost/chisa-workspace:3', 'bash', '-c', command], 30_000, signal);
        signal?.throwIfAborted();
        const remoteHost = (await run(['inspect', '--format', '{{(index .NetworkSettings.Networks "' + network + '").IPAddress}}', id], 15_000, signal)).trim();
        if (!privatePreviewAddress(remoteHost)) throw new Error('Invalid preview address');
        signal?.throwIfAborted();
        let delivery: Promise<void> | undefined;
        const finishDelivery = (accepted: boolean): Promise<void> => delivery ??= (async () => {
          if (!accepted) {
            try { await discard(userId, id); }
            catch (cleanupError) {
              await finishStartup(activePreviews.get(id)?.containerAbsent === true);
              throw Object.assign(new AppError('预览响应中断，且容器清理未确认', { code: 'PREVIEW_CLEANUP_FAILED', statusCode: 503 }), { cleanupError });
            }
          }
          await finishStartup();
        })();
        return { id, remoteHost, remotePort: port, url, finishDelivery };
      } catch (error) {
        try { if (containerRequested) await discard(userId, id); }
        catch (cleanupError) {
          await finishStartup(activePreviews.get(id)?.containerAbsent === true);
          throw Object.assign(new AppError('预览启动失败，且容器清理未确认', { code: 'PREVIEW_CLEANUP_FAILED', statusCode: 503 }), { cause: error, cleanupError });
        }
        await finishStartup();
        throw error;
      }
    },
    async list(userId: string) {
      const ids = (await run(['ps', '--all', '--quiet', '--filter', 'label=chisa.sync-preview.owner=' + owner(userId)])).trim().split(/\s+/).filter(Boolean);
      const containers = (ids.length ? JSON.parse(await run(['inspect', ...ids])) : []) as Array<{
        Name: string; Config: { Labels: Record<string, string> };
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
        const address = network ? container.NetworkSettings.Networks[network]?.IPAddress : undefined;
        const remoteHost = privatePreviewAddress(address) ? address : '';
        return [{ id, serverPath, bindingEpoch: labels['chisa.sync-preview.epoch'] ?? '', remoteHost, remotePort: Number(labels['chisa.sync-preview.port'] ?? 0) }];
      });
      for (const witness of await listWorkspaceRuntimePreviewWitnesses(userId)) {
        if (!previews.some(preview => preview.id === witness.previewId)) previews.push({ id: witness.previewId, serverPath: witness.root,
          bindingEpoch: witness.lease.epoch, remoteHost: '', remotePort: 0 });
      }
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
    async remove(userId: string, id: string) { await discard(userId, id); return { ok: true }; },
  };
}

/** Bridge preview RPCs execute locally using a verified account runtime, without a desktop callback. */
export async function executeWorkspaceRuntimePreview(root: string, bindingEpoch: string, request: Record<string, unknown>, reservation?: WorkspaceRuntimePreviewReservation, signal?: AbortSignal) {
  const identity = getWorkspaceRuntimeIdentity(root);
  const service = createWorkspaceRuntimePreviewService();
  if (request.op === 'preview_start') {
    const cwd = request.path === undefined ? '/workspace' : request.path;
    try {
      if (!identity || path.resolve(root) === identity.root) throw new AppError('Workspace runtime is unavailable', { code: 'WORKSPACE_RUNTIME_UNAVAILABLE', statusCode: 503 });
      if (!reservation || reservation.root !== root || typeof request.command !== 'string' || !request.command.trim() || request.command.length > 64_000 ||
        typeof cwd !== 'string' || (cwd !== '/workspace' && !cwd.startsWith('/workspace/')) || cwd.includes('\0') || cwd.split('/').includes('..') ||
        !Number.isInteger(request.port) || Number(request.port) < 1024 || Number(request.port) > 65535) {
        throw new AppError('无效的预览命令、目录或端口', { code: 'INVALID_REQUEST', statusCode: 400 });
      }
      signal?.throwIfAborted();
      // Revalidate before mounting RW; the registry is an identity hint, not a
      // substitute for verifying persistent ownership and the Docker network.
      await createWorkspaceRuntimeService().restore(identity.userId);
      signal?.throwIfAborted();
    } catch (error) { await reservation?.finish(true); throw error; }
    const started = await service.start(identity!.userId, bindingEpoch, request.command as string, cwd as string, Number(request.port), reservation!, signal);
    try { signal?.throwIfAborted(); }
    catch (error) { await started.finishDelivery(false); throw error; }
    try {
      await started.finishDelivery(true);
      return { ok: true, previewId: started.id, status: 'starting', url: started.url, basePath: started.url };
    } catch (error) { await service.discard(identity!.userId, started.id); throw error; }
  }
  if (!identity || path.resolve(root) === identity.root) throw new AppError('Workspace runtime is unavailable', { code: 'WORKSPACE_RUNTIME_UNAVAILABLE', statusCode: 503 });
  if (request.op !== 'preview_stop' && request.op !== 'preview_status') throw new AppError('不支持的预览操作', { code: 'INVALID_REQUEST', statusCode: 400 });
  if (typeof request.previewId !== 'string') throw new AppError('无效的预览标识', { code: 'INVALID_REQUEST', statusCode: 400 });
  const previews = await service.list(identity.userId);
  const preview = previews.previews.find(item => item.id === request.previewId && item.serverPath === root && item.bindingEpoch === bindingEpoch);
  if (!preview) throw new AppError('预览不存在或绑定已失效', { code: 'PREVIEW_NOT_FOUND', statusCode: 404 });
  if (request.op === 'preview_stop') { await service.remove(identity.userId, preview.id); return { ok: true, status: 'stopped' }; }
  const state = await service.inspect(identity.userId, preview.id);
  const logs = await service.logs(identity.userId, preview.id);
  const url = getWorkspaceRuntimePreviewUrl(preview.id);
  let ready = false;
  if (state.Running === true && url && preview.remoteHost && Number.isInteger(preview.remotePort) && preview.remotePort >= 1024 && preview.remotePort <= 65535) {
    try {
      const response = await fetch('http://' + preview.remoteHost + ':' + preview.remotePort + url, {
        redirect: 'manual', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(2_000)]) : AbortSignal.timeout(2_000),
      });
      ready = response.status >= 200 && response.status < 400;
      await response.body?.cancel();
    } catch (error) { if (signal?.aborted) throw error; }
  }
  return { ok: true, running: state.Running === true, ready, exitCode: typeof state.ExitCode === 'number' ? state.ExitCode : undefined, url: getWorkspaceRuntimePreviewUrl(preview.id), ...logs };
}
