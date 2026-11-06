import { request as httpRequest } from 'node:http';
import type { Duplex } from 'node:stream';
import path from 'node:path';

import type { WorkspaceBrokerEngine } from '@/shared/index.js';

/** Broker operator launcher uses this Unix-socket adapter. It exposes semantic
 * operations only, never a Docker URL/argv proxy, TCP daemon selector or host exec. */
export function createWorkspaceBrokerDockerAdapter(options: { socketPath: string; timeoutMs?: number }) : WorkspaceBrokerEngine {
  if (process.platform !== 'linux' || path.posix.resolve(options.socketPath) !== options.socketPath || !/^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(options.socketPath)) throw new Error('BROKER_DOCKER_REQUIRES_LINUX_SOCKET');
  const timeoutMs = options.timeoutMs ?? 15000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) throw new Error('BROKER_DOCKER_TIMEOUT');
  const id = (value: string) => { if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('BROKER_DOCKER_ID'); return value; };
  const lookup = (value: string) => { if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)) throw new Error('BROKER_DOCKER_LOOKUP'); return encodeURIComponent(value); };
  const api = '/v1.45';
  const call = async (method: string, route: string, body?: unknown, missing = false, maxBytes = 2 * 1024 * 1024, accepted: number[] = []): Promise<any> => {
    const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return new Promise((resolve,reject) => {
      const request = httpRequest({ socketPath: options.socketPath, path: api + route, method,
        headers: encoded ? { 'Content-Type': 'application/json', 'Content-Length': encoded.length } : {} }, response => {
        const chunks: Buffer[] = []; let bytes = 0;
        response.on('data',(chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > maxBytes) { response.destroy(new Error('BROKER_DOCKER_RESPONSE_LIMIT')); return; }
          chunks.push(chunk);
        });
        response.once('error',reject);
        response.once('aborted',() => reject(new Error('BROKER_DOCKER_RESPONSE_ABORTED')));
        response.once('end',() => {
          if (response.statusCode === 404 && missing) { resolve(null); return; }
          if (!response.statusCode || (!accepted.includes(response.statusCode) && (response.statusCode < 200 || response.statusCode >= 300))) { reject(Object.assign(new Error('BROKER_DOCKER_HTTP_' + response.statusCode),{ statusCode: response.statusCode })); return; }
          const buffer = Buffer.concat(chunks);
          if (['application/vnd.docker.raw-stream','application/vnd.docker.multiplexed-stream'].some(type => response.headers['content-type']?.startsWith(type))) { resolve(buffer); return; }
          try { resolve(buffer.length ? JSON.parse(buffer.toString('utf8')) : undefined); }
          catch { reject(new Error('BROKER_DOCKER_JSON')); }
        });
      });
      const timer = setTimeout(() => request.destroy(new Error('BROKER_DOCKER_TIMEOUT')),timeoutMs); timer.unref();
      request.once('close',() => clearTimeout(timer)); request.once('error',reject); request.end(encoded);
    });
  };
  const hijack = (route: string, body?: unknown): Promise<Duplex> => new Promise((resolve,reject) => {
    const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const request = httpRequest({ socketPath: options.socketPath, path: api + route, method: 'POST', headers: {
      Connection: 'Upgrade', Upgrade: 'tcp', ...(encoded ? { 'Content-Type': 'application/json', 'Content-Length': encoded.length } : {}),
    } });
    const timer = setTimeout(() => request.destroy(new Error('BROKER_DOCKER_ATTACH_TIMEOUT')),timeoutMs); timer.unref();
    request.once('error',error => { clearTimeout(timer); reject(error); });
    request.once('upgrade',(response,socket,head) => {
      clearTimeout(timer);
      if (response.statusCode !== 101) { socket.destroy(); reject(new Error('BROKER_DOCKER_ATTACH_REJECTED')); return; }
      // Stdin EOF is a writable half-close. Preserve readable output until the
      // daemon ends its half after the worker's final response/exit frames.
      if ('allowHalfOpen' in socket) socket.allowHalfOpen = true;
      if (head.length) socket.unshift(head);
      socket.pause(); socket.on('error',() => {}); resolve(socket);
    });
    request.once('response',response => { clearTimeout(timer); response.destroy(); reject(new Error('BROKER_DOCKER_ATTACH_NO_UPGRADE')); });
    request.end(encoded);
  });
  const networkInspection = (value: any) => {
    if (!value || typeof value !== 'object' || !/^[a-f0-9]{64}$/.test(value.Id ?? '') || typeof value.Name !== 'string') throw new Error('BROKER_DOCKER_NETWORK_SHAPE');
    return { id: value.Id, name: value.Name, driver: value.Driver, scope: value.Scope, internal: value.Internal,
      defaultBridge: value.Options?.['com.docker.network.bridge.default_bridge'] === 'true', labels: value.Labels ?? {} };
  };
  return {
    async createSandbox(input) {
      id(input.networkId);
      const created = await call('POST','/containers/create?name=' + lookup(input.name),{
        Image: input.imageDigest, Cmd: input.command, Entrypoint: [], WorkingDir: input.cwd,
        User: input.uid + ':' + input.gid, Env: Object.entries(input.environment).map(([key,value]) => key + '=' + value),
        Labels: input.labels, AttachStdin: true, AttachStdout: true, AttachStderr: true, OpenStdin: true, StdinOnce: false, Tty: false,
        HostConfig: {
          NetworkMode: input.networkId, Privileged: false, ReadonlyRootfs: true, CapDrop: ['ALL'], CapAdd: [], GroupAdd: [],
          SecurityOpt: ['no-new-privileges'], PidMode: '', IpcMode: 'private', CgroupnsMode: 'private',
          Memory: input.memoryBytes, MemorySwap: input.memoryBytes, NanoCpus: input.nanoCpus, PidsLimit: input.pidsLimit,
          RestartPolicy: { Name: 'no' }, AutoRemove: false, PublishAllPorts: false, PortBindings: {}, Devices: [], DeviceRequests: [],
          Mounts: input.mounts.map(mount => ({ Type: 'bind', Source: mount.source, Target: mount.target, ReadOnly: mount.readOnly,
            BindOptions: { Propagation: 'rprivate', NonRecursive: true } })),
          Tmpfs: { '/tmp': 'rw,nosuid,nodev,noexec,size=' + input.tmpfsBytes + ',uid=' + input.uid + ',gid=' + input.gid,
            '/home/chisa': 'rw,nosuid,nodev,size=' + input.tmpfsBytes + ',uid=' + input.uid + ',gid=' + input.gid },
          LogConfig: { Type: 'local', Config: { 'max-size': '10m', 'max-file': '2' } },
          Ulimits: [{ Name: 'nofile', Soft: 1024, Hard: 1024 }],
        },
        NetworkingConfig: { EndpointsConfig: { [input.networkId]: {} } },
      });
      return id(created?.Id);
    },
    async startContainer(resourceId) { await call('POST','/containers/' + id(resourceId) + '/start'); },
    async inspectContainer(target) {
      const value = await call('GET','/containers/' + lookup(target) + '/json',undefined,true);
      if (value === null) return null;
      if (!value || !/^[a-f0-9]{64}$/.test(value.Id ?? '') || !value.Config || !value.State || !value.HostConfig || !Array.isArray(value.Mounts)) throw new Error('BROKER_DOCKER_CONTAINER_SHAPE');
      const networks = Object.values(value.NetworkSettings?.Networks ?? {}) as any[];
      const network = networks.length === 1 ? networks[0] : undefined;
      // Config.Image alone is mutable metadata. Verify the immutable image object
      // reports the exact configured repo digest (or is that exact sha256 object).
      let digest = String(value.Config.Image ?? '');
      const image = await call('GET','/images/' + encodeURIComponent(String(value.Image)) + '/json');
      if (image?.Id !== value.Image || !(digest === image.Id || (Array.isArray(image.RepoDigests) && image.RepoDigests.includes(digest)))) digest = 'unverified';
      const host = value.HostConfig;
      const unsafe = !!host.Privileged || (host.CapAdd?.length ?? 0) > 0 || (host.GroupAdd?.length ?? 0) > 0 || (host.Devices?.length ?? 0) > 0 || (host.DeviceRequests?.length ?? 0) > 0 ||
        host.PublishAllPorts === true || Object.keys(host.PortBindings ?? {}).length > 0 || ['host','container'].some(mode => String(host.IpcMode ?? '').startsWith(mode)) || host.CgroupnsMode === 'host';
      return { id: value.Id, name: String(value.Name).replace(/^\//,''), imageDigest: digest, labels: value.Config.Labels ?? {},
        running: value.State.Running === true, restarting: value.State.Restarting === true, exitCode: value.State.ExitCode,
        networkId: networks.length > 1 ? 'invalid-network-topology' : network?.NetworkID || String(host.NetworkMode ?? ''), address: network?.IPAddress ?? '',
        uid: value.Config.User, privileged: unsafe, hostPid: !!host.PidMode, readOnlyRootfs: host.ReadonlyRootfs === true,
        capDrop: host.CapDrop ?? [], securityOpt: (host.SecurityOpt ?? []).map((entry: string) => entry === 'no-new-privileges=true' ? 'no-new-privileges' : entry),
        memoryBytes: host.Memory, nanoCpus: host.NanoCpus, pidsLimit: host.PidsLimit, restartPolicy: host.RestartPolicy?.Name ?? '',
        mounts: value.Mounts.filter((mount: any) => mount.Type !== 'tmpfs').map((mount: any) => ({ source: mount.Type === 'bind' ? mount.Source : 'invalid-mount-type', target: mount.Destination, readOnly: mount.RW === false })),
      };
    },
    async listWorkspaceContainers(key) {
      if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('BROKER_DOCKER_WORKSPACE_KEY');
      const values = await call('GET','/containers/json?all=true&filters=' + encodeURIComponent(JSON.stringify({ label: ['chisa.broker.workspace=' + key] })));
      if (!Array.isArray(values) || values.length > 10000) throw new Error('BROKER_DOCKER_INVENTORY_SHAPE');
      return values.map(value => id(value.Id));
    },
    async removeContainer(resourceId) { await call('DELETE','/containers/' + id(resourceId) + '?force=true&v=false',undefined,true); },
    async attachContainer(resourceId) { return hijack('/containers/' + id(resourceId) + '/attach?stream=true&stdin=true&stdout=true&stderr=true'); },
    async createExec(resourceId,input) {
      const created = await call('POST','/containers/' + id(resourceId) + '/exec',{ Cmd: input.command, WorkingDir: input.cwd, User: input.uid,
        Env: Object.entries(input.environment).map(([key,value]) => key + '=' + value), AttachStdin: true, AttachStdout: true, AttachStderr: true,
        Tty: false, Privileged: false });
      return id(created?.Id);
    },
    async startExec(execId) { return hijack('/exec/' + id(execId) + '/start',{ Detach: false, Tty: false }); },
    async inspectExec(execId) {
      const value = await call('GET','/exec/' + id(execId) + '/json');
      if (typeof value?.Running !== 'boolean' || !Number.isInteger(value.ExitCode)) throw new Error('BROKER_DOCKER_EXEC_SHAPE');
      return { running: value.Running, exitCode: value.ExitCode };
    },
    async logs(resourceId,maxBytes) {
      const value = await call('GET','/containers/' + id(resourceId) + '/logs?stdout=true&stderr=true&tail=100',undefined,false,maxBytes);
      if (!Buffer.isBuffer(value)) throw new Error('BROKER_DOCKER_LOG_SHAPE');
      return value;
    },
    async inspectNetwork(target) {
      const value = await call('GET','/networks/' + lookup(target),undefined,true);
      return value === null ? null : networkInspection(value);
    },
    async createNetwork(input) {
      const created = await call('POST','/networks/create',{ Name: input.name, Driver: 'bridge', Internal: input.internal, Attachable: false, Ingress: false,
        CheckDuplicate: true, Labels: input.labels, Options: { 'com.docker.network.bridge.enable_icc': 'false', 'com.docker.network.bridge.enable_ip_masquerade': input.internal ? 'false' : 'true' } });
      return id(created?.Id);
    },
    async retireContainer(resourceId) {
      await call('POST','/containers/' + id(resourceId) + '/update',{ RestartPolicy: { Name: 'no' } });
      await call('POST','/containers/' + id(resourceId) + '/stop?t=10',undefined,false,65536,[304]);
    },
  };
}
