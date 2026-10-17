import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { AppError, registerWorkspaceSyncNetwork, registerWorkspaceSyncRecoveryTransport } from '@/shared/index.js';

const execute = promisify(execFile);
const transportImage = 'localhost/chisa-workspace-sync:1';
const ownerLabel = 'chisa.workspace-sync.owner';
const networkOwnerLabel = 'chisa.workspace-network.owner';
const sshPort = '2222/tcp';

type TransportContainer = {
  Name: string;
  Config: { Labels?: Record<string, string> };
  State: { Running: boolean };
  HostConfig: { NetworkMode: string; Privileged: boolean };
  Mounts: { Source: string; Destination: string; RW: boolean; Type: string }[];
  NetworkSettings: {
    Networks: Record<string, { IPAddress: string }>;
    Ports: Record<string, { HostIp: string; HostPort: string }[] | null>;
  };
};

async function run(command: string, args: string[]) {
  return execute(command, args, { timeout: 20_000, maxBuffer: 1024 * 1024 });
}

function publicKeyLine(input: string) {
  const match = /^ssh-ed25519 ([A-Za-z0-9+/]+={0,2})(?: [^\r\n]*)?$/.exec(input.trim());
  const blob = match ? Buffer.from(match[1], 'base64') : Buffer.alloc(0);
  // An OpenSSH Ed25519 public key contains one algorithm string and exactly 32 public bytes.
  if (!match || blob.length !== 51 || blob.readUInt32BE(0) !== 11 ||
    blob.subarray(4, 15).toString('ascii') !== 'ssh-ed25519' || blob.readUInt32BE(15) !== 32 ||
    blob.toString('base64') !== match[1]) {
    throw new AppError('同步设备公钥无效', { code: 'WORKSPACE_SYNC_KEY_INVALID', statusCode: 400 });
  }
  return 'ssh-ed25519 ' + match[1];
}

async function inspectContainer(name: string): Promise<TransportContainer | null> {
  try {
    const { stdout } = await run('docker', ['container', 'inspect', name]);
    return (JSON.parse(stdout) as TransportContainer[])[0] ?? null;
  } catch (error) {
    const failure = error as Error & { stderr?: string };
    if (/No such (?:object|container)/i.test(failure.stderr ?? '')) return null;
    throw error;
  }
}

async function readOptional(file: string) {
  try { return await readFile(file, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

function assertTransportOwnership(container: TransportContainer, owner: string, root: string, configDirectory: string) {
  const mounts = container.Mounts;
  const workspace = mounts.find((mount) => mount.Destination === root);
  const configuration = mounts.find((mount) => mount.Destination === '/etc/chisa-sync');
  const staging = mounts.find((mount) => mount.Destination === '/root/.mutagen/staging');
  // Existing transports keep their original two-mount contract until maintenance migrates them.
  const validStaging = staging === undefined ? mounts.length === 2 : mounts.length === 3 &&
    staging.Type === 'bind' && staging.Source === path.join(configDirectory, 'staging') && staging.RW;
  if (container.Name !== '/chisa-workspace-sync-' + owner || container.Config.Labels?.[ownerLabel] !== owner || container.HostConfig.Privileged ||
    !['bridge', 'chisa-workspace-network-' + owner].includes(container.HostConfig.NetworkMode) || !validStaging ||
    workspace?.Type !== 'bind' || workspace.Source !== root || !workspace.RW ||
    configuration?.Type !== 'bind' || configuration.Source !== configDirectory || configuration.RW) {
    throw new AppError('同步容器配置与当前账号不一致', { code: 'WORKSPACE_SYNC_TRANSPORT_MISMATCH', statusCode: 503 });
  }
}

async function requireAccountNetwork(owner: string): Promise<string> {
  const name = 'chisa-workspace-network-' + owner;
  let network: { Name: string; Driver: string; Labels?: Record<string, string> };
  try {
    const { stdout } = await run('docker', ['network', 'inspect', name]);
    network = JSON.parse(stdout)[0];
  } catch (error) {
    const stderr = (error as Error & { stderr?: string }).stderr ?? '';
    if (!/No such network/i.test(stderr) && !stderr.includes('network ' + name + ' not found')) throw error;
    await run('docker', ['network', 'create', '--driver=bridge', '--label', networkOwnerLabel + '=' + owner, name]);
    const { stdout } = await run('docker', ['network', 'inspect', name]);
    network = JSON.parse(stdout)[0];
  }
  if (network?.Name !== name || network.Driver !== 'bridge' || network.Labels?.[networkOwnerLabel] !== owner) {
    throw new AppError('同步网络配置与当前账号不一致', { code: 'WORKSPACE_SYNC_TRANSPORT_MISMATCH', statusCode: 503 });
  }
  return name;
}

async function restoreAccountNetwork(container: TransportContainer, owner: string, root: string, userId: string, allowRecoveryOnly = false): Promise<TransportContainer> {
  const network = await requireAccountNetwork(owner);
  const networks = Object.keys(container.NetworkSettings.Networks);
  if (networks.some(name => name !== 'bridge' && name !== network)) {
    throw new AppError('同步容器连接了其他账号网络', { code: 'WORKSPACE_SYNC_TRANSPORT_MISMATCH', statusCode: 503 });
  }
  if (networks.includes('bridge')) {
    // Preserve the existing container and device keys. Docker can reassign an
    // ephemeral SSH port, so clients re-enroll when reconnecting after migration.
    // A live task must finish before replacing its callback network address.
    try {
      const pending = [root];
      while (pending.length) {
        const directory = pending.pop()!;
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (entry.name.endsWith('.chisa-lease')) {
            throw new AppError('请先结束工作区任务，再重新连接文件同步网络', { code: 'WORKSPACE_BUSY', statusCode: 409 });
          }
          if (entry.isDirectory() && !entry.name.endsWith('.chisa-sync-backups')) {
            pending.push(path.join(directory, entry.name));
          }
        }
      }
      const previewOwner = createHash('sha256').update(root + '\0' + userId).digest('hex').slice(0, 20);
      const previews = await run('docker', ['ps', '--quiet', '--filter', 'label=chisa.sync-preview.owner=' + previewOwner]);
      if (previews.stdout.trim()) {
        throw new AppError('请先停止项目预览，再重新连接文件同步网络', { code: 'WORKSPACE_BUSY', statusCode: 409 });
      }
      const workers = await run('docker', ['ps', '--quiet', '--filter', 'name=^/chisa-rpc-']);
      if (workers.stdout.trim()) {
        const inspected = await run('docker', ['container', 'inspect', ...workers.stdout.trim().split(/\s+/)]);
        const active = JSON.parse(inspected.stdout) as TransportContainer[];
        if (active.some(worker => worker.State.Running && worker.Mounts.some(mount =>
          mount.Destination === '/workspace' && (mount.Source === root || mount.Source.startsWith(root + path.sep))))) {
          throw new AppError('请先结束工作区操作，再重新连接文件同步网络', { code: 'WORKSPACE_BUSY', statusCode: 409 });
        }
      }
    } catch (error) {
      if (!allowRecoveryOnly || !(error instanceof AppError) || error.code !== 'WORKSPACE_BUSY') throw error;
      // Enrollment must restore the original callback address before the desktop
      // can drain its exact leases. This does not register an isolated network.
      return container;
    }
    const name = container.Name.slice(1);
    if (!networks.includes(network)) await run('docker', ['network', 'connect', network, name]);
    await run('docker', ['network', 'disconnect', 'bridge', name]);
    const updated = await inspectContainer(name);
    if (!updated) throw new AppError('文件同步容器状态读取失败', { code: 'WORKSPACE_SYNC_UNAVAILABLE', statusCode: 503 });
    container = updated;
  }
  if (Object.keys(container.NetworkSettings.Networks).length !== 1 || !container.NetworkSettings.Networks[network]) {
    throw new AppError('文件同步网络隔离未确认', { code: 'WORKSPACE_SYNC_TRANSPORT_MISMATCH', statusCode: 503 });
  }
  if (container.State.Running) registerWorkspaceSyncNetwork(root, network, container.NetworkSettings.Networks[network].IPAddress);
  return container;
}

async function transportIdentity(userId: string) {
  const configuredRoot = process.env.WORKSPACES_ROOT;
  if (!configuredRoot || !path.isAbsolute(configuredRoot) || process.platform !== 'linux') {
    throw new AppError('服务器尚未配置独立工作目录', { code: 'WORKSPACE_SYNC_UNAVAILABLE', statusCode: 503 });
  }
  const root = await realpath(configuredRoot);
  const home = await realpath(os.homedir());
  if (root === path.parse(root).root || root === home || !(await stat(root)).isDirectory() || /[:,\r\n\0]/.test(root)) {
    throw new AppError('服务器同步目录必须是独立工作目录', { code: 'WORKSPACE_SYNC_UNAVAILABLE', statusCode: 503 });
  }
  const owner = createHash('sha256').update(root + '\0' + userId).digest('hex').slice(0, 24);
  const configDirectory = path.join(home, '.chisa-workspace-sync', owner);
  if (configDirectory.startsWith(root + path.sep)) {
    throw new AppError('同步配置不能位于工作目录内', { code: 'WORKSPACE_SYNC_UNAVAILABLE', statusCode: 503 });
  }
  return { root, owner, configDirectory };
}

async function requireTransportImage() {
  try { await run('docker', ['image', 'inspect', transportImage]); }
  catch {
    throw new AppError('服务器文件同步服务尚未安装，请联系管理员更新服务器', {
      code: 'WORKSPACE_SYNC_UNAVAILABLE', statusCode: 503,
    });
  }
}

/** The workspace-sync routes use this service to enroll public device keys in an instance-limited SSH transport. */
export function createWorkspaceSyncService() {
  const pending = new Map<string, Promise<unknown>>();
  const restorations = new Map<string, Promise<void>>();
  const restore = (userId: string) => {
    const current = restorations.get(userId);
    if (current) return current;
    const attempt = (async () => {
      const { root, owner, configDirectory } = await transportIdentity(userId);
      await requireTransportImage();
      const container = await inspectContainer('chisa-workspace-sync-' + owner);
      if (!container) return;
      assertTransportOwnership(container, owner, root, configDirectory);
      await restoreAccountNetwork(container, owner, root, userId);
    })().catch((error: unknown) => {
      if (restorations.get(userId) === attempt) restorations.delete(userId);
      throw error;
    });
    restorations.set(userId, attempt);
    return attempt;
  };

  return {
    restore,
    async enroll(userId: string, publicKey: string, requestedServerUrl: string) {
      const key = publicKeyLine(publicKey);
      try { await restore(userId); }
      catch (error) {
        // A busy legacy network still needs enrollment to recover; all ownership,
        // Docker and isolation failures retain their original failure contract.
        if (!(error instanceof AppError) || error.code !== 'WORKSPACE_BUSY') throw error;
      }
      const { root, owner, configDirectory } = await transportIdentity(userId);
      let serverUrl: URL;
      try { serverUrl = new URL(process.env.API_URL || requestedServerUrl); }
      catch {
        throw new AppError('服务器工作区地址配置无效', { code: 'WORKSPACE_SYNC_UNAVAILABLE', statusCode: 503 });
      }
      if (!['http:', 'https:'].includes(serverUrl.protocol) || serverUrl.username || serverUrl.password ||
        serverUrl.pathname !== '/' || serverUrl.search || serverUrl.hash) {
        throw new AppError('服务器工作区地址配置无效', { code: 'WORKSPACE_SYNC_UNAVAILABLE', statusCode: 503 });
      }
      const previous = pending.get(owner) ?? Promise.resolve();
      const attempt = previous.catch(() => undefined).then(async () => {
        await mkdir(configDirectory, { recursive: true, mode: 0o700 });
        await chmod(configDirectory, 0o700);
        const hostKeyPath = path.join(configDirectory, 'ssh_host_ed25519_key');
        if (!(await readOptional(hostKeyPath))) {
          await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'chisa-workspace-sync', '-f', hostKeyPath]);
        }
        const authorizedKeysPath = path.join(configDirectory, 'authorized_keys');
        const authorizedKeys = await readOptional(authorizedKeysPath);
        if (!authorizedKeys.split('\n').some((line) => line.endsWith(' ' + key))) {
          const next = authorizedKeys.trimEnd() + (authorizedKeys.trim() ? '\n' : '') +
            'no-agent-forwarding,no-X11-forwarding,no-user-rc ' + key + '\n';
          const temporary = authorizedKeysPath + '.next';
          await writeFile(temporary, next, { mode: 0o600 });
          await rename(temporary, authorizedKeysPath);
        }
        const name = 'chisa-workspace-sync-' + owner;
        const network = await requireAccountNetwork(owner);
        let container = await inspectContainer(name);
        if (!container) {
          const stagingDirectory = path.join(configDirectory, 'staging');
          await mkdir(stagingDirectory, { recursive: true, mode: 0o700 });
          await chmod(stagingDirectory, 0o700);
          await run('docker', ['run', '--detach', '--name', name, '--label', ownerLabel + '=' + owner,
            '--restart=unless-stopped', '--network=' + network, '--add-host=host.docker.internal:host-gateway',
            '--publish=0.0.0.0::2222', '--read-only', '--security-opt=no-new-privileges',
            '--cap-drop=ALL', '--cap-add=CHOWN', '--cap-add=DAC_OVERRIDE', '--cap-add=FOWNER',
            '--cap-add=SETGID', '--cap-add=SETUID', '--cap-add=SYS_CHROOT', '--cap-add=AUDIT_WRITE',
            '--pids-limit=128', '--memory=2g', '--tmpfs=/run:rw,size=16m,mode=0755',
            '--tmpfs=/tmp:rw,size=64m,mode=1777', '--tmpfs=/root:rw,exec,nosuid,nodev,size=128m,mode=0700',
            '--mount', 'type=bind,src=' + root + ',dst=' + root,
            '--mount', 'type=bind,src=' + configDirectory + ',dst=/etc/chisa-sync,readonly',
            '--mount', 'type=bind,src=' + stagingDirectory + ',dst=/root/.mutagen/staging', transportImage]);
          container = await inspectContainer(name);
        } else {
          assertTransportOwnership(container, owner, root, configDirectory);
          if (!container.State.Running) {
            await run('docker', ['start', name]);
            container = await inspectContainer(name);
          }
        }
        if (!container?.State.Running) {
          throw new AppError('文件同步服务未能启动', { code: 'WORKSPACE_SYNC_UNAVAILABLE', statusCode: 503 });
        }
        assertTransportOwnership(container, owner, root, configDirectory);
        container = await restoreAccountNetwork(container, owner, root, userId, true);
        const published = container.NetworkSettings.Ports[sshPort]?.find((port) => port.HostIp === '0.0.0.0');
        const remotePort = Number(published?.HostPort);
        if (!Number.isInteger(remotePort) || remotePort < 1024 || remotePort > 65535) {
          throw new AppError('文件同步端口未准备好', { code: 'WORKSPACE_SYNC_UNAVAILABLE', statusCode: 503 });
        }
        const recoveryOnly = Boolean(container.NetworkSettings.Networks.bridge);
        const controlHost = container.NetworkSettings.Networks[recoveryOnly ? 'bridge' : network]?.IPAddress ?? '';
        if (recoveryOnly) registerWorkspaceSyncRecoveryTransport(root, controlHost);
        else registerWorkspaceSyncNetwork(root, network, controlHost);
        const hostKey = publicKeyLine((await readFile(hostKeyPath + '.pub', 'utf8')).trim());
        return {
          sshHost: serverUrl.hostname,
          sshUser: 'root',
          sshPort: remotePort,
          workspaceServerUrl: serverUrl.origin,
          workspaceRoot: root,
          hostKey,
          controlHost,
          recoveryOnly,
        };
      });
      pending.set(owner, attempt);
      try { return await attempt; }
      finally { if (pending.get(owner) === attempt) pending.delete(owner); }
    },
  };
}
