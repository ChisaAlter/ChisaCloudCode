import assert from 'node:assert/strict';
import { execFile as realExecFile } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import * as realFiles from 'node:fs/promises';
import realOs from 'node:os';
import realPath from 'node:path';
import { promisify } from 'node:util';
import test, { mock } from 'node:test';

const root = '/srv/workspaces/account';
const fixture = await realFiles.mkdtemp(realPath.join(realOs.tmpdir(), 'chisa-enrollment-'));
const home = fixture.replaceAll('\\', '/');
process.env.HOME = fixture;
process.env.USERPROFILE = fixture;
process.env.DATABASE_PATH = realPath.join(fixture, 'auth.db');
process.env.WORKSPACES_ROOT = root;
process.env.VITE_IS_PLATFORM = 'false';
const files = new Map<string, string>();
const containers = new Map<string, {
  Name: string;
  Config: { Labels: Record<string, string> };
  State: { Running: boolean };
  HostConfig: { NetworkMode: string; Privileged: boolean };
  Mounts: { Source: string; Destination: string; RW: boolean; Type: string }[];
  NetworkSettings: { Networks: Record<string, { IPAddress: string }>; Ports: Record<string, { HostIp: string; HostPort: string }[]> };
}>();
const networks = new Map<string, { Name: string; Driver: string; Labels: Record<string, string> }>();
let migrationLease = false;
let migrationPreview = false;
let migrationWorker = false;
let networkInspectionError: string | undefined;
const commands: string[][] = [];
const newKey = () => {
  const publicBytes = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const wire = Buffer.alloc(51);
  wire.writeUInt32BE(11, 0);
  wire.write('ssh-ed25519', 4, 'ascii');
  wire.writeUInt32BE(32, 15);
  publicBytes.copy(wire, 19);
  return 'ssh-ed25519 ' + wire.toString('base64');
};
const hostKey = newKey();
const primaryDevice = newKey();
const fakeExec = Object.assign(() => undefined, {
  [promisify.custom]: async (command: string, args: string[]) => {
    commands.push([command, ...args]);
    if (command === 'ssh-keygen') {
      const filename = args[args.indexOf('-f') + 1];
      files.set(filename, 'fixture-host-key');
      files.set(filename + '.pub', hostKey + ' fixture\n');
    } else if (command === 'docker' && args[0] === 'container') {
      if (args.slice(2).includes('readonly-worker')) return { stdout: JSON.stringify([{
        State: { Running: true }, Mounts: [{ Destination: '/workspace', Source: root + '/local/project' }],
      }]), stderr: '' };
      const container = containers.get(args[2]);
      if (!container) throw Object.assign(new Error('absent'), { stderr: 'No such container' });
      return { stdout: JSON.stringify([container]), stderr: '' };
    } else if (command === 'docker' && args[0] === 'network') {
      if (args[1] === 'inspect') {
        if (networkInspectionError) throw Object.assign(new Error('inspection failed'), { stderr: networkInspectionError });
        const network = networks.get(args[2]);
        if (!network) throw Object.assign(new Error('absent'), { stderr: 'Error response from daemon: network ' + args[2] + ' not found' });
        return { stdout: JSON.stringify([network]), stderr: '' };
      }
      if (args[1] === 'create') {
        const label = args[args.indexOf('--label') + 1].split('=');
        networks.set(args.at(-1)!, { Name: args.at(-1)!, Driver: 'bridge', Labels: { [label[0]]: label[1] } });
      } else if (args[1] === 'connect') {
        containers.get(args[3])!.NetworkSettings.Networks[args[2]] = { IPAddress: '172.18.0.8' };
      } else if (args[1] === 'disconnect') {
        delete containers.get(args[3])!.NetworkSettings.Networks[args[2]];
      }
    } else if (command === 'docker' && args[0] === 'ps') {
      return { stdout: args.some(arg => arg.startsWith('label=')) ? (migrationPreview ? 'owned-preview\n' : '')
        : (migrationWorker ? 'readonly-worker\n' : ''), stderr: '' };
    } else if (command === 'docker' && args[0] === 'run') {
      const name = args[args.indexOf('--name') + 1];
      const label = args[args.indexOf('--label') + 1].split('=');
      const mounts = args.flatMap((arg, index) => arg === '--mount' ? [args[index + 1]] : []).map(value => {
        const items = Object.fromEntries(value.split(',').map(field => field.split('=')));
        return { Type: items.type, Source: items.src, Destination: items.dst, RW: !value.includes(',readonly') };
      });
      containers.set(name, {
        Name: '/' + name,
        Config: { Labels: { [label[0]]: label[1] } }, State: { Running: true },
        HostConfig: { NetworkMode: (args.find(arg => arg.startsWith('--network=')) ?? '').slice(10), Privileged: args.includes('--privileged') },
        Mounts: mounts,
        NetworkSettings: { Networks: { [(args.find(arg => arg.startsWith('--network=')) ?? '').slice(10)]: { IPAddress: '172.18.0.8' } }, Ports: { '2222/tcp': [{ HostIp: '0.0.0.0', HostPort: '32022' }] } },
      });
    } else if (command === 'docker' && args[0] === 'start') {
      containers.get(args[1])!.State.Running = true;
    }
    return { stdout: '', stderr: '' };
  },
});
mock.module('node:child_process', { namedExports: { execFile: fakeExec as unknown as typeof realExecFile } });
mock.module('node:path', { defaultExport: realPath.posix, namedExports: { ...realPath.posix } });
mock.module('node:os', { defaultExport: { ...realOs, homedir: () => home }, namedExports: { ...realOs, homedir: () => home } });
mock.module('node:fs/promises', { namedExports: {
  ...realFiles,
  mkdir: async () => undefined, chmod: async () => undefined,
  readdir: async () => migrationLease ? [{ name: 'project.chisa-lease', isDirectory: () => true }] : [],
  realpath: async (filename: string) => filename,
  stat: async () => ({ isDirectory: () => true }),
  readFile: async (filename: string) => {
    if (!files.has(filename)) throw Object.assign(new Error('absent'), { code: 'ENOENT' });
    return files.get(filename);
  },
  writeFile: async (filename: string, content: string) => { files.set(filename, content); },
  rename: async (source: string, target: string) => { files.set(target, files.get(source)!); files.delete(source); },
} });
const { createWorkspaceSyncService } = await import('../workspace-sync.service.js');
const { isWorkspaceSyncControlHost, getWorkspaceSyncNetwork, isWorkspaceSyncRecoveryOnly } = await import('@/shared/index.js');
const service = createWorkspaceSyncService();
const platform = process.platform;
test.before(() => Object.defineProperty(process, 'platform', { value: 'linux' }));
test.after(async () => {
  Object.defineProperty(process, 'platform', { value: platform });
  await realFiles.rm(fixture, { recursive: true, force: true });
});

test('enrollment retains device keys and reuses the running isolated transport', async () => {
  const device = primaryDevice;
  const first = await service.enroll('17', device, 'http://server.example:8792');
  assert.equal(first.sshHost, 'server.example');
  assert.equal(first.sshPort, 32022);
  assert.equal(first.workspaceRoot, root);
  assert.equal(first.hostKey, hostKey);
  assert.equal(first.recoveryOnly, false);
  assert.equal(isWorkspaceSyncControlHost(first.controlHost), true);
  const second = await service.enroll('17', device, 'http://server.example:8792');
  assert.deepEqual(second, first);
  assert.equal(commands.filter(args => args[0] === 'docker' && args[1] === 'run').length, 1);
  assert.equal(commands.filter(args => args[0] === 'docker' && args[1] === 'start').length, 0);
  const otherDevice = newKey();
  await service.enroll('17', otherDevice, 'http://server.example:8792');
  const authorized = [...files.entries()].find(([filename]) => filename.endsWith('/authorized_keys'))?.[1];
  assert.ok(authorized?.includes(device));
  assert.ok(authorized?.includes(otherDevice));
  assert.equal(authorized?.split('\n').filter(line => line.includes(device)).length, 1);
  const mounted = [...containers.values()][0].Mounts;
  assert.deepEqual(mounted, [
    { Type: 'bind', Source: root, Destination: root, RW: true },
    { Type: 'bind', Source: mounted[1].Source, Destination: '/etc/chisa-sync', RW: false },
    { Type: 'bind', Source: mounted[1].Source + '/staging', Destination: '/root/.mutagen/staging', RW: true },
  ]);
  assert.ok(commands.find(args => args[0] === 'docker' && args[1] === 'run')?.includes('--memory=2g'));
  assert.ok(mounted[1].Source.startsWith(home + '/.chisa-workspace-sync/'));
  assert.equal(networks.size, 1);
  assert.equal(getWorkspaceSyncNetwork(root + '/local/project'), [...networks.keys()][0]);
  assert.equal(getWorkspaceSyncNetwork(root + '-neighbor/project'), undefined);
});

test('reconnection preserves the deployed account staging transport and original two-mount transport', async () => {
  const container = [...containers.values()][0];
  const mounts = structuredClone(container.Mounts);
  const ports = structuredClone(container.NetworkSettings.Ports);
  const existingFiles = [...files.entries()];
  const start = commands.length;
  await createWorkspaceSyncService().restore('17');
  const enrolled = await createWorkspaceSyncService().enroll('17', primaryDevice, 'http://server.example:8792');
  assert.equal(enrolled.sshPort, 32022);
  assert.deepEqual(container.Mounts, mounts);
  assert.deepEqual(container.NetworkSettings.Ports, ports);
  assert.deepEqual([...files.entries()], existingFiles);
  assert.equal(commands.slice(start).some(args => ['stop', 'rm', 'run', 'start'].includes(args[1])), false);

  container.Mounts = container.Mounts.filter(mount => mount.Destination !== '/root/.mutagen/staging');
  try {
    const legacyStart = commands.length;
    await createWorkspaceSyncService().restore('17');
    await createWorkspaceSyncService().enroll('17', primaryDevice, 'http://server.example:8792');
    assert.equal(commands.slice(legacyStart).some(args => ['stop', 'rm', 'run', 'start'].includes(args[1])), false);
    assert.equal(container.Mounts.length, 2);
  } finally { container.Mounts = mounts; }
});

test('staging validation rejects foreign, read-only, non-bind, misplaced and extra mounts', async () => {
  const container = [...containers.values()][0];
  const original = structuredClone(container.Mounts);
  const invalid = [
    { Source: '/srv/another-account/staging' },
    { RW: false },
    { Type: 'volume' },
    { Destination: '/root/other-staging' },
  ];
  try {
    for (const change of invalid) {
      container.Mounts = structuredClone(original);
      Object.assign(container.Mounts.find(mount => mount.Destination === '/root/.mutagen/staging')!, change);
      const start = commands.length;
      await assert.rejects(createWorkspaceSyncService().restore('17'), { code: 'WORKSPACE_SYNC_TRANSPORT_MISMATCH' });
      await assert.rejects(createWorkspaceSyncService().enroll('17', primaryDevice, 'http://server.example:8792'), { code: 'WORKSPACE_SYNC_TRANSPORT_MISMATCH' });
      assert.equal(commands.slice(start).some(args => ['stop', 'rm', 'run', 'start', 'network'].includes(args[1])), false);
    }
    container.Mounts = [...structuredClone(original), { Type: 'bind', Source: '/srv/foreign', Destination: '/foreign', RW: true }];
    await assert.rejects(createWorkspaceSyncService().restore('17'), { code: 'WORKSPACE_SYNC_TRANSPORT_MISMATCH' });
    await assert.rejects(createWorkspaceSyncService().enroll('17', primaryDevice, 'http://server.example:8792'), { code: 'WORKSPACE_SYNC_TRANSPORT_MISMATCH' });
  } finally { container.Mounts = original; }
});

test('an existing transport with foreign mounts, account label, or host networking is rejected', async () => {
  const container = [...containers.values()][0];
  const mount = container.Mounts[0].Source;
  container.Mounts[0].Source = '/srv/workspaces/other-account';
  await assert.rejects(service.enroll('17', newKey(), 'http://server.example:8792'), { code: 'WORKSPACE_SYNC_TRANSPORT_MISMATCH' });
  container.Mounts[0].Source = mount;
  const owner = container.Config.Labels['chisa.workspace-sync.owner'];
  container.Config.Labels['chisa.workspace-sync.owner'] = 'other-account';
  await assert.rejects(service.enroll('17', newKey(), 'http://server.example:8792'), { code: 'WORKSPACE_SYNC_TRANSPORT_MISMATCH' });
  container.Config.Labels['chisa.workspace-sync.owner'] = owner;
  container.HostConfig.NetworkMode = 'host';
  await assert.rejects(service.enroll('17', newKey(), 'http://server.example:8792'), { code: 'WORKSPACE_SYNC_TRANSPORT_MISMATCH' });
  container.HostConfig.NetworkMode = Object.keys(container.NetworkSettings.Networks)[0];
});

test('account identities receive different transports and private keys never enroll', async () => {
  await service.enroll('18', newKey(), 'http://server.example:8792');
  assert.equal(containers.size, 2);
  assert.equal(networks.size, 2);
  const calls = commands.length;
  await assert.rejects(service.enroll('17', '-----BEGIN OPENSSH PRIVATE KEY-----', 'http://server.example:8792'), { code: 'WORKSPACE_SYNC_KEY_INVALID' });
  assert.equal(commands.length, calls);
  assert.equal([...files.keys()].filter(filename => filename.endsWith('/authorized_keys')).length, 2);
});

test('a restarted service restores only the owned running transport once before workspace requests', async () => {
  const container = [...containers.values()][0];
  const network = Object.keys(container.NetworkSettings.Networks)[0];
  container.NetworkSettings.Networks[network].IPAddress = '172.18.0.19';
  assert.equal(isWorkspaceSyncControlHost('172.18.0.19'), false);
  const restarted = createWorkspaceSyncService();
  const count = commands.length;
  await restarted.restore('17');
  assert.equal(isWorkspaceSyncControlHost('172.18.0.19'), true);
  assert.equal(commands.slice(count).filter(args => args[1] === 'container').length, 1);
  const restoredCount = commands.length;
  await restarted.restore('17');
  assert.equal(commands.length, restoredCount);
  const name = container.Name;
  container.Name = '/foreign-transport';
  const failed = createWorkspaceSyncService();
  await assert.rejects(failed.restore('17'), { code: 'WORKSPACE_SYNC_TRANSPORT_MISMATCH' });
  container.Name = name;
  await failed.restore('17');
  const reconnected = await failed.enroll('17', newKey(), 'http://server.example:8792');
  assert.equal(reconnected.controlHost, container.NetworkSettings.Networks[network].IPAddress);
});

test('busy legacy enrollment restores only its original recovery transport, then migrates after draining', async () => {
  const container = [...containers.values()][0];
  const network = Object.keys(container.NetworkSettings.Networks)[0];
  const originalPorts = structuredClone(container.NetworkSettings.Ports);
  const originalKeys = [...files.entries()].filter(([filename]) => filename.endsWith('/authorized_keys'));
  for (const blocker of ['lease', 'preview', 'worker'] as const) {
    container.HostConfig.NetworkMode = 'bridge';
    container.NetworkSettings.Networks = { bridge: { IPAddress: '172.17.0.8' } };
    const restarting = createWorkspaceSyncService();
    try {
      migrationLease = blocker === 'lease';
      migrationPreview = blocker === 'preview';
      migrationWorker = blocker === 'worker';
      const start = commands.length;
      await assert.rejects(restarting.restore('17'), { code: 'WORKSPACE_BUSY' });
      const recovered = await restarting.enroll('17', primaryDevice, 'http://server.example:8792');
      assert.equal(recovered.recoveryOnly, true, blocker);
      assert.equal(recovered.controlHost, '172.17.0.8', blocker);
      assert.equal(recovered.sshPort, Number(originalPorts['2222/tcp'][0].HostPort));
      assert.equal(recovered.hostKey, hostKey);
      assert.equal(isWorkspaceSyncControlHost(recovered.controlHost), true);
      assert.equal(isWorkspaceSyncRecoveryOnly(root + '/local/project'), true);
      assert.equal(isWorkspaceSyncRecoveryOnly(root + '-neighbor/project'), false);
      assert.equal([...containers.values()][0], container, 'enrollment must preserve the existing transport');
      assert.deepEqual(Object.keys(container.NetworkSettings.Networks), ['bridge']);
      assert.deepEqual(container.NetworkSettings.Ports, originalPorts);
      assert.deepEqual([...files.entries()].filter(([filename]) => filename.endsWith('/authorized_keys')), originalKeys);
      await assert.rejects(restarting.restore('17'), { code: 'WORKSPACE_BUSY' }, 'recovery enrollment must not cache normal restoration success');
      assert.equal(commands.slice(start).some(args => args[1] === 'network' && ['connect', 'disconnect'].includes(args[2])), false);
      assert.equal(commands.slice(start).some(args => ['stop', 'rm', 'run', 'start'].includes(args[1])), false);

      migrationLease = migrationPreview = migrationWorker = false;
      const drained = await restarting.enroll('17', primaryDevice, 'http://server.example:8792');
      assert.equal(drained.recoveryOnly, false, blocker);
      assert.equal(drained.controlHost, container.NetworkSettings.Networks[network].IPAddress);
      assert.equal(isWorkspaceSyncRecoveryOnly(root + '/local/project'), false);
      assert.deepEqual(Object.keys(container.NetworkSettings.Networks), [network]);
      assert.deepEqual(container.NetworkSettings.Ports, originalPorts);
      assert.deepEqual([...files.entries()].filter(([filename]) => filename.endsWith('/authorized_keys')), originalKeys);
      await restarting.restore('17');
      assert.equal(commands.slice(start).some(args => ['stop', 'rm', 'run', 'start'].includes(args[1])), false);
    } finally {
      migrationLease = migrationPreview = migrationWorker = false;
    }
  }
});

test('a foreign owned network is rejected without changing transport membership', async () => {
  const container = [...containers.values()][0];
  const networkName = Object.keys(container.NetworkSettings.Networks)[0];
  const network = networks.get(networkName)!;
  const owner = network.Labels['chisa.workspace-network.owner'];
  network.Labels['chisa.workspace-network.owner'] = 'foreign';
  await assert.rejects(createWorkspaceSyncService().restore('17'), { code: 'WORKSPACE_SYNC_TRANSPORT_MISMATCH' });
  assert.deepEqual(Object.keys(container.NetworkSettings.Networks), [networkName]);
  network.Labels['chisa.workspace-network.owner'] = owner;
});

test('Docker network inspection failures do not create or migrate account networks', async () => {
  const container = [...containers.values()][0];
  const membership = Object.keys(container.NetworkSettings.Networks);
  for (const stderr of ['permission denied', 'network foreign-network not found']) {
    networkInspectionError = stderr;
    const start = commands.length;
    try {
      await assert.rejects(createWorkspaceSyncService().restore('17'), { stderr });
      await assert.rejects(createWorkspaceSyncService().enroll('17', primaryDevice, 'http://server.example:8792'), { stderr });
      assert.equal(commands.slice(start).some(args => args[1] === 'network' && ['create', 'connect', 'disconnect'].includes(args[2])), false);
      assert.deepEqual(Object.keys(container.NetworkSettings.Networks), membership);
    } finally { networkInspectionError = undefined; }
  }
});
