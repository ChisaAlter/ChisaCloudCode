import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import { once } from 'node:events';
import type { Duplex } from 'node:stream';

import type { WorkspaceBrokerConfiguration, WorkspaceBrokerEngine, WorkspaceBrokerRunRequest, WorkspaceBrokerExecRequest } from '@/shared/index.js';

import { openWorkspaceBrokerRegistry } from './workspace-broker-registry.repository.js';

type Operation = {
  id: string; ownerId: string; workspaceId: string; generation: string; leaseId: string; kind: 'run' | 'exec';
  requestHash: string; profileId: string; state: 'prepared' | 'creating' | 'starting' | 'running' | 'pending-cleanup' | 'complete';
  name: string; resourceId?: string; execId?: string; parentId?: string; networkId: string; previewPort?: number;
  mounts: Array<{ source: string; target: string; readOnly: boolean }>;
  cleanupConfirmed: boolean; exitCode?: number; reason?: string; stdinSequence: number; stdinHash?: string; stdinEnded: boolean; stdinBytes: number;
  createdAt: number; deadline: number;
};
type Document = {
  version: 1; instanceId: string; manifestHash: string;
  pins: Record<string, { dev: number; ino: number; canonical: string }>;
  networks: Record<string,string>; leases: Record<string,string>; operations: Record<string,Operation>;
  closedLeases?: Record<string,{ workspaceId: string; generation: string; leaseId: string; requestedAt: number; confirmedAt?: number }>;
};

function fault(code: string) { return Object.assign(new Error(code), { code }); }
function object(value: unknown): value is Record<string,unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function keys(value: unknown, allowed: string[]) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) throw fault('BROKER_INVALID_REQUEST');
}
function identifier(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value); }
function stable(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (object(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function hash(value: unknown) { return createHash('sha256').update(stable(value)).digest('hex'); }
function below(root: string, value: string) { return value === root || value.startsWith(root + path.sep); }
function relative(value: unknown, empty = true): value is string {
  return typeof value === 'string' && (empty || !!value) && value.length <= 2048 && !path.isAbsolute(value) &&
    !/[\\\0\r\n:,]/.test(value) && value.split('/').every(part => part !== '..' && part !== '.' && (part !== '' || value === ''));
}
function argv(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || !value.length || value.length > 256 || value.some(item => typeof item !== 'string' || item.includes('\0')) ||
    !value[0] || Buffer.byteLength(JSON.stringify(value)) > 65536) throw fault('BROKER_COMMAND_INVALID');
}

/** The operator launcher and future workspace-runtime/bridge integration use this semantic
 * service. API requests never enroll paths or supply daemon policy. The injected engine is
 * broker-private; deploy only the restricted Docker adapter, never an API fallback. */
export async function createWorkspaceBroker(configuration: WorkspaceBrokerConfiguration, engine: WorkspaceBrokerEngine) {
  const config = structuredClone(configuration);
  if (!identifier(config.audience) || !config.authorityKeys.length || !config.controlledRoots.length || !config.workspaces.length || !config.profiles.length) throw fault('BROKER_CONFIG_INVALID');
  const unique = (values: string[]) => values.length === new Set(values).size;
  if (![config.workspaces.map(item => item.id), config.controlledRoots.map(item => item.id), config.profiles.map(item => item.id), config.authorityKeys.map(item => item.keyId)].every(values => values.every(identifier) && unique(values))) throw fault('BROKER_CONFIG_DUPLICATE');
  const profiles = new Map(config.profiles.map(profile => {
    if (!/^([a-z0-9][a-z0-9./:_-]*@)?sha256:[a-f0-9]{64}$/.test(profile.imageDigest) ||
      ![profile.uid,profile.gid,profile.memoryBytes,profile.nanoCpus,profile.pidsLimit,profile.tmpfsBytes,profile.timeoutMs,profile.maxOutputBytes,profile.maxStdinBytes].every(value => Number.isSafeInteger(value) && value > 0) ||
      profile.uid < 1000 || profile.gid < 1000 || profile.memoryBytes > 8 * 1024 ** 3 || profile.nanoCpus > 8e9 || profile.pidsLimit > 1024 ||
      profile.tmpfsBytes > 1024 ** 3 || profile.timeoutMs > 24 * 3600_000 || profile.maxOutputBytes > 64 * 1024 ** 2 || profile.maxStdinBytes > 16 * 1024 ** 2 ||
      typeof profile.readOnlyWorkspace !== 'boolean' || !Array.isArray(profile.environmentKeys) || profile.environmentKeys.some(key => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /^(?:LD_|DOCKER_|HOME$|PATH$|TMPDIR$)/.test(key))) throw fault('BROKER_PROFILE_INVALID');
    return [profile.id,profile] as const;
  }));
  const issuers = new Map(config.authorityKeys.map(issuer => {
    const key = createPublicKey(issuer.publicKey);
    if (key.asymmetricKeyType !== 'ed25519' || !issuer.owners.length || !issuer.owners.every(identifier)) throw fault('BROKER_ISSUER_INVALID');
    return [issuer.keyId,{ key, owners: issuer.owners }] as const;
  }));
  const roots = new Map(config.controlledRoots.map(root => [root.id,root]));
  const workspaces = new Map(config.workspaces.map(workspace => [workspace.id,workspace]));
  const registry = await openWorkspaceBrokerRegistry<Document>(config.registryDirectory, {
    version: 1, instanceId: randomUUID(), manifestHash: hash(config), pins: {}, networks: {}, leases: {}, operations: {},
  });
  let state: Document;
  try {
    state = await registry.read();
    if (state.version !== 1 || state.manifestHash !== hash(config) || !identifier(state.instanceId) || !object(state.operations) || !object(state.pins) || !object(state.leases) || !object(state.networks)) throw fault('BROKER_MANIFEST_CHANGED');
  } catch (error) { registry.close(); throw error; }
  state.closedLeases ??= {};
  if (!object(state.closedLeases)) { registry.close(); throw fault('BROKER_REGISTRY_CORRUPT'); }
  const leaseKey = (workspaceId: string,generation: string,leaseId: string) => hash([workspaceId,generation,leaseId]);
  const requireOpenLease = (workspaceId: string,generation: string,leaseId: string) => {
    if (state.closedLeases![leaseKey(workspaceId,generation,leaseId)]) throw fault('BROKER_LEASE_QUIESCED');
  };
  let queue = Promise.resolve();
  let closed = false;
  let poisoned = false;
  const sessions = new Map<string, { socket: Duplex; claimed: boolean }>();
  const timers = new Map<string,ReturnType<typeof setTimeout>>();
  const abortListeners = new Map<string,() => void>();
  const serialize = <T>(run: () => Promise<T>): Promise<T> => {
    const pending = queue.then(async () => {
      if (closed || poisoned) throw fault('BROKER_NOT_AVAILABLE');
      return run();
    });
    queue = pending.then(() => {}, () => {});
    return pending;
  };
  const save = async () => {
    try { await registry.write(state); }
    catch (error) { poisoned = true; throw error; }
  };
  const pinPath = async (location: string, allowFile = false) => {
    if (!path.isAbsolute(location) || path.resolve(location) !== location || location === path.parse(location).root || /[\0\r\n,]/.test(location) || await realpath(location) !== location) throw fault('BROKER_PATH_INVALID');
    let current = path.parse(location).root;
    for (const part of location.slice(current.length).split(path.sep)) {
      current = path.join(current, part);
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !(allowFile && current === location && metadata.isFile() && metadata.nlink === 1))) throw fault('BROKER_PATH_SYMLINK');
    }
    const metadata = await lstat(location);
    if (process.platform === 'linux') {
      // The daemon resolves bind sources by path. Every source namespace must be
      // protected against sandbox renames, including registered provider mounts.
      let folder = path.dirname(location);let child = location;
      for (;;) {
        const ancestor = await lstat(folder);const childMetadata = await lstat(child);
        const stickyRoot = ancestor.uid === 0 && (ancestor.mode & 0o1000) !== 0;
        if (((ancestor.mode & 0o022) !== 0 && !stickyRoot) || config.profiles.some(profile => profile.uid === ancestor.uid) ||
          (stickyRoot && (((ancestor.mode & 0o002) !== 0 && config.profiles.some(profile => profile.uid === childMetadata.uid)) || ((ancestor.mode & 0o020) !== 0 && config.profiles.some(profile => profile.gid === ancestor.gid || profile.uid === ancestor.gid))))) throw fault('BROKER_PATH_PARENT_WRITABLE');
        const parent = path.dirname(folder);
        if (parent === folder) break;
        child = folder;folder = parent;
      }
    }
    const previous = state.pins[location];
    if (previous && (previous.dev !== metadata.dev || previous.ino !== metadata.ino || previous.canonical !== location)) throw fault('BROKER_PATH_REPLACED');
    if (!previous) state.pins[location] = { dev: metadata.dev, ino: metadata.ino, canonical: location };
  };
  const workspacePath = (id: string) => {
    const workspace = workspaces.get(id);
    const root = workspace && roots.get(workspace.rootId);
    if (!workspace || !root || root.ownerId !== workspace.ownerId || !relative(workspace.relativePath,false)) throw fault('BROKER_WORKSPACE_INVALID');
    return path.join(root.path, workspace.relativePath);
  };
  const checkPaths = async (id: string, profileId?: string) => {
    const workspace = workspaces.get(id)!;
    const root = roots.get(workspace.rootId)!;
    await pinPath(root.path); await pinPath(workspacePath(id));
    if (workspace.nativeAccountGroupId !== undefined || workspace.rootUid !== undefined) {
      if (!Number.isSafeInteger(workspace.nativeAccountGroupId) || workspace.nativeAccountGroupId! <= 0 || !Number.isSafeInteger(workspace.rootUid) || workspace.rootUid! < 0 ||
        config.profiles.some(profile => profile.uid === workspace.nativeAccountGroupId || profile.gid === workspace.nativeAccountGroupId)) throw fault('BROKER_NATIVE_NAMESPACE_INVALID');
      const account = await lstat(path.dirname(workspacePath(id)));const leaf = await lstat(workspacePath(id));
      if (process.platform === 'linux' && (account.uid !== 0 || account.gid !== workspace.nativeAccountGroupId || (account.mode & 0o7777) !== 0o1770 || leaf.uid !== workspace.rootUid)) throw fault('BROKER_NATIVE_NAMESPACE_INVALID');
    } else if (process.platform === 'linux' && ((await lstat(path.dirname(workspacePath(id)))).mode & 0o022) !== 0) throw fault('BROKER_NATIVE_NAMESPACE_REQUIRED');
    const mounts = [{ source: workspacePath(id), target: '/workspace', readOnly: false }];
    for (const name of ['.chisa-bridge.json','.chisa-session.json']) {
      const location = path.join(workspacePath(id),name);
      const metadata = await lstat(location).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; });
      if (!metadata) continue;
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || await realpath(location) !== location) throw fault('BROKER_CONTROL_FILE_INVALID');
      mounts.push({ source: '/dev/null', target: '/workspace/' + name, readOnly: true });
      // Session Git control is supplied only by a fixed protected profile mount;
      // never let a writable worktree pointer select host Git administration.
      if (name === '.chisa-session.json' && ![...(workspace.mounts ?? []),...(profileId ? profiles.get(profileId)?.mounts ?? [] : [])].some(mount => mount.target === '/workspace/.git')) mounts.push({ source: '/dev/null',target: '/workspace/.git',readOnly: true });
    }
    for (const mount of [...(workspace.mounts ?? []),...(profileId ? profiles.get(profileId)?.mounts ?? [] : [])]) {
      const allowed = roots.get(mount.rootId);
      if (!allowed || allowed.ownerId !== workspace.ownerId || !relative(mount.relativePath) || !path.posix.isAbsolute(mount.target) || path.posix.resolve(mount.target) !== mount.target ||
        /^\/(?:proc|sys|dev|run|var\/run|etc|bin|sbin|usr|lib|lib64)(?:\/|$)/.test(mount.target) || mount.target === '/' || mount.target === '/workspace' ||
        /^\/workspace\/\.chisa-/.test(mount.target) || /[\0\r\n,]/.test(mount.target) || mounts.some(item => item.target === mount.target)) throw fault('BROKER_MOUNT_INVALID');
      const source = path.join(allowed.path,mount.relativePath);
      if (!below(allowed.path,source) || below(workspacePath(id),source) || below(source,workspacePath(id)) ||
        /(?:^|[\\/])(?:docker\.sock|\.ssh|\.chisa-workspace-runtime|\.chisa-workspace-sync)(?:[\\/]|$)/.test(source) || /\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm))?$/.test(source)) throw fault('BROKER_MOUNT_OVERLAP');
      await pinPath(allowed.path); await pinPath(source,true);
      mounts.push({ source, target: mount.target, readOnly: mount.readOnly });
    }
    return mounts;
  };
  try {
    for (const root of config.controlledRoots) {
      if (!identifier(root.ownerId) || below(root.path,config.registryDirectory) || below(config.registryDirectory,root.path)) throw fault('BROKER_ROOT_INVALID');
      await pinPath(root.path);
    }
    for (const workspace of config.workspaces) {
      if (!identifier(workspace.ownerId) || !identifier(workspace.generation) || !workspace.profiles.length || workspace.profiles.some(id => !profiles.has(id)) ||
        !/^chisa-broker-[a-z0-9-]{1,80}$/.test(workspace.network.name) || typeof workspace.network.internal !== 'boolean') throw fault('BROKER_WORKSPACE_INVALID');
      for (const profileId of workspace.profiles) await checkPaths(workspace.id,profileId);
    }
    // One real workspace has exactly one broker lease gate. Alias ids sharing a
    // root would otherwise bypass the writer fence even for the same owner.
    const registeredPaths = config.workspaces.map(workspace => workspacePath(workspace.id));
    for (let index = 0; index < registeredPaths.length; index++) for (const other of registeredPaths.slice(index+1)) {
      if (below(registeredPaths[index],other) || below(other,registeredPaths[index])) throw fault('BROKER_WORKSPACE_ROOT_OVERLAP');
    }
    // Owners never share overlapping workspace roots or provider-state roots.
    for (let index = 0; index < config.controlledRoots.length; index++) for (const other of config.controlledRoots.slice(index + 1)) {
      const root = config.controlledRoots[index];
      if (root.ownerId !== other.ownerId && (below(root.path,other.path) || below(other.path,root.path))) throw fault('BROKER_ROOT_OWNER_OVERLAP');
    }
    await save();
  } catch (error) { registry.close(); throw error; }

  const authorize = (proof: string, permission: string, workspaceId: string, operation?: Operation) => {
    if (typeof proof !== 'string' || proof.length > 8192) throw fault('BROKER_UNAUTHORIZED');
    const segments = proof.split('.');
    if (segments.length !== 2 || segments.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw fault('BROKER_UNAUTHORIZED');
    let claims: Record<string,unknown>;
    try { claims = JSON.parse(Buffer.from(segments[0],'base64url').toString('utf8')) as Record<string,unknown>; }
    catch { throw fault('BROKER_UNAUTHORIZED'); }
    keys(claims,['version','keyId','audience','ownerId','workspaceId','generation','leaseId','profiles','permissions','issuedAt','expiresAt','grantId']);
    const issuer = typeof claims.keyId === 'string' ? issuers.get(claims.keyId) : undefined;
    const workspace = workspaces.get(workspaceId);
    const now = Date.now();
    if (!issuer || !workspace || claims.version !== 1 || claims.audience !== config.audience || claims.ownerId !== workspace.ownerId ||
      !issuer.owners.includes(workspace.ownerId) || claims.workspaceId !== workspaceId || claims.generation !== workspace.generation || !identifier(claims.leaseId) || !identifier(claims.grantId) ||
      !Array.isArray(claims.permissions) || !claims.permissions.includes(permission) || !claims.permissions.every(identifier) ||
      !Array.isArray(claims.profiles) || !claims.profiles.length || !claims.profiles.every(id => typeof id === 'string' && workspace.profiles.includes(id)) ||
      !Number.isSafeInteger(claims.issuedAt) || !Number.isSafeInteger(claims.expiresAt) || Number(claims.issuedAt) > now || Number(claims.expiresAt) <= now ||
      Number(claims.expiresAt) - Number(claims.issuedAt) > 300_000 || Number(claims.expiresAt) <= Number(claims.issuedAt) ||
      !verify(null,Buffer.from(segments[0]),issuer.key,Buffer.from(segments[1],'base64url'))) throw fault('BROKER_UNAUTHORIZED');
    if (operation && (operation.ownerId !== claims.ownerId || operation.workspaceId !== claims.workspaceId || operation.generation !== claims.generation || operation.leaseId !== claims.leaseId || !claims.profiles.includes(operation.profileId))) throw fault('BROKER_UNAUTHORIZED');
    return { leaseId: claims.leaseId, profiles: claims.profiles as string[] };
  };
  const requireOperation = (proof: string, permission: string, id: string) => {
    const operation = identifier(id) ? state.operations[id] : undefined;
    if (!operation) throw fault('BROKER_UNAUTHORIZED');
    authorize(proof,permission,operation.workspaceId,operation);
    return operation;
  };
  const workspaceKey = (id: string) => hash([config.audience,workspaces.get(id)!.ownerId,id,workspaces.get(id)!.generation]);
  const labels = (operation: Operation) => ({ 'chisa.broker.instance': state.instanceId, 'chisa.broker.workspace': workspaceKey(operation.workspaceId),
    'chisa.broker.owner': operation.ownerId, 'chisa.broker.operation': operation.id, 'chisa.broker.generation': operation.generation, 'chisa.broker.lease': operation.leaseId });
  const ensureNetwork = async (id: string) => {
    const workspace = workspaces.get(id)!;
    const expected = { 'chisa.broker.owner': workspace.ownerId, 'chisa.broker.account': hash([config.audience,workspace.ownerId,workspace.rootId]), 'chisa.broker.instance': state.instanceId };
    const stored = state.networks[id];
    let network = await engine.inspectNetwork(stored ?? workspace.network.name);
    if (!network) {
      if (stored) throw fault('BROKER_NETWORK_REPLACED');
      const created = await engine.createNetwork({ name: workspace.network.name, labels: expected, internal: workspace.network.internal });
      network = await engine.inspectNetwork(created);
    }
    if (!network || !/^[a-f0-9]{64}$/.test(network.id) || network.name !== workspace.network.name || network.driver !== 'bridge' || network.scope !== 'local' || network.defaultBridge ||
      network.internal !== workspace.network.internal || (stored && network.id !== stored) || Object.entries(expected).some(([key,value]) => network!.labels[key] !== value)) throw fault('BROKER_NETWORK_INVALID');
    if (!stored) { state.networks[id] = network.id; await save(); }
    return network.id;
  };
  const verifyContainer = async (operation: Operation, target = operation.resourceId ?? operation.name) => {
    const inspected = await engine.inspectContainer(target);
    if (!inspected) return null;
    const profile = profiles.get(operation.profileId)!;
    if (!/^[a-f0-9]{64}$/.test(inspected.id) || (operation.resourceId && inspected.id !== operation.resourceId) || inspected.name !== operation.name || inspected.imageDigest !== profile.imageDigest ||
      Object.entries(labels(operation)).some(([key,value]) => inspected.labels[key] !== value) || inspected.networkId !== operation.networkId ||
      inspected.uid !== profile.uid + ':' + profile.gid || inspected.privileged || inspected.hostPid || !inspected.readOnlyRootfs ||
      !inspected.capDrop.includes('ALL') || !inspected.securityOpt.includes('no-new-privileges') || inspected.securityOpt.includes('seccomp=unconfined') ||
      inspected.memoryBytes !== profile.memoryBytes || inspected.nanoCpus !== profile.nanoCpus || inspected.pidsLimit !== profile.pidsLimit || inspected.restartPolicy !== 'no' ||
      stable([...inspected.mounts].sort((a,b) => a.target.localeCompare(b.target))) !== stable([...operation.mounts].sort((a,b) => a.target.localeCompare(b.target)))) throw fault('BROKER_RESOURCE_MISMATCH');
    return inspected;
  };
  const receipt = (operation: Operation) => ({ operationId: operation.id, workspaceId: operation.workspaceId, generation: operation.generation, leaseId: operation.leaseId, profileId: operation.profileId, kind: operation.kind,
    state: operation.state, resourceId: operation.resourceId, execId: operation.execId, exitCode: operation.exitCode, cleanupConfirmed: operation.cleanupConfirmed,
    writerLeaseHeld: state.leases[operation.workspaceId] === operation.leaseId, reason: operation.reason });
  const clearSession = (id: string) => {
    sessions.get(id)?.socket.destroy(); sessions.delete(id);
    abortListeners.get(id)?.(); abortListeners.delete(id);
    const timer = timers.get(id); if (timer) clearTimeout(timer); timers.delete(id);
  };
  const finishExec = async (operation: Operation, exitCode: number) => {
    operation.exitCode = exitCode; operation.state = 'complete'; operation.cleanupConfirmed = true;
    delete operation.reason; clearSession(operation.id); await save();
    // Background descendants are still contained by the parent's retained lease.
    // An exec exit never releases the parent writer or proves its sandbox absent.
  };
  const clean = async (operation: Operation) => {
    if (operation.cleanupConfirmed) return receipt(operation);
    const parent = operation.parentId ? state.operations[operation.parentId] : operation;
    if (!parent) throw fault('BROKER_REGISTRY_CORRUPT');
    const related = Object.values(state.operations).filter(item => item.id === parent.id || item.parentId === parent.id);
    for (const item of related) { item.state = 'pending-cleanup'; item.reason = 'daemon-absence-required'; clearSession(item.id); }
    await save();
    try {
      let inspected = await verifyContainer(parent);
      if (!parent.resourceId && inspected) { parent.resourceId = inspected.id; await save(); }
      // A pending POST create can still commit after a timeout. Empty inventory
      // without an immutable recorded id cannot prove that request is finished.
      if (!parent.resourceId) throw fault('BROKER_CREATE_OUTCOME_UNKNOWN');
      if (inspected) {
        await engine.removeContainer(parent.resourceId);
        inspected = await verifyContainer(parent,parent.resourceId);
        if (inspected) throw fault('BROKER_CONTAINER_STILL_PRESENT');
      }
      // Detect same-name replacement without treating a foreign name as authority.
      const replacement = await engine.inspectContainer(parent.name);
      if (replacement) throw fault('BROKER_NAME_REPLACED');
      const inventory = await engine.listWorkspaceContainers(workspaceKey(parent.workspaceId));
      const known = new Set(Object.values(state.operations).filter(item => item.workspaceId === parent.workspaceId && item.kind === 'run' && !related.includes(item) && !item.cleanupConfirmed).map(item => item.resourceId));
      if (inventory.some(id => !/^[a-f0-9]{64}$/.test(id) || !known.has(id))) throw fault('BROKER_ORPHAN_PRESENT');
      for (const item of related) { item.state = 'complete'; item.cleanupConfirmed = true; delete item.reason; }
      const remaining = Object.values(state.operations).some(item => item.workspaceId === parent.workspaceId && item.leaseId === parent.leaseId && !item.cleanupConfirmed);
      if (!remaining && state.leases[parent.workspaceId] === parent.leaseId) delete state.leases[parent.workspaceId];
      await save();
    } catch (error) {
      if (poisoned) throw error;
      for (const item of related) item.reason = error instanceof Error ? error.message.slice(0,120) : 'BROKER_CLEANUP_UNCONFIRMED';
      await save();
    }
    return receipt(operation);
  };
  const watchAbort = (operation: Operation, signal?: AbortSignal) => {
    if (!signal) return;
    const abort = () => { void serialize(() => clean(operation)).catch(() => {}); };
    signal.addEventListener('abort',abort,{ once: true });
    abortListeners.set(operation.id,() => signal.removeEventListener('abort',abort));
  };
  const arm = (operation: Operation) => {
    if (operation.cleanupConfirmed) return;
    const timer = setTimeout(() => { void serialize(() => clean(operation)).catch(() => {}); }, Math.max(1,operation.deadline - Date.now()));
    timer.unref(); timers.set(operation.id,timer);
  };
  const sanitize = (command: string[], cwd: string | undefined, environment: Record<string,string> | undefined, profileId: string) => {
    argv(command);
    if (!relative(cwd ?? '')) throw fault('BROKER_CWD_INVALID');
    const profile = profiles.get(profileId)!;
    const env: Record<string,string> = { HOME: '/home/chisa', TMPDIR: '/tmp', TZ: 'UTC', ...profile.environment };
    if (Object.entries(env).some(([key,value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes('\0') || value.length > 32768)) throw fault('BROKER_PROFILE_ENV_INVALID');
    if (environment !== undefined && (!object(environment) || Object.keys(environment).length > 64 || Object.entries(environment).some(([key,value]) => (Object.hasOwn(env,key) ? value !== env[key] : !profile.environmentKeys.includes(key)) || typeof value !== 'string' || value.includes('\0') || value.length > 32768))) throw fault('BROKER_ENV_INVALID');
    if (Buffer.byteLength(JSON.stringify(environment ?? {})) > 65536) throw fault('BROKER_ENV_INVALID');
    return { command: [...command], cwd: '/workspace' + (cwd ? '/' + cwd : ''), environment: { ...env, ...environment } };
  };
  const dedupe = (operationId: string, requestHash: string, ownerId: string) => {
    if (!identifier(operationId)) throw fault('BROKER_OPERATION_INVALID');
    const existing = state.operations[operationId];
    if (existing && (existing.requestHash !== requestHash || existing.ownerId !== ownerId)) throw fault('BROKER_OPERATION_CONFLICT');
    if (!existing && Object.keys(state.operations).length >= (config.maxOperations ?? 10000)) throw fault('BROKER_REGISTRY_FULL');
    return existing;
  };
  // Restart never resumes a non-idempotent launch. Reconciliation only removes
  // proven registered resources; no /proc, caller cleanup verdict or name prefix.
  for (const operation of Object.values(state.operations)) {
    if (!operation.cleanupConfirmed) { operation.state = 'pending-cleanup'; operation.reason = 'broker-restart-reconciliation'; }
  }
  await save();
  for (const operation of Object.values(state.operations).filter(item => item.kind === 'run' && !item.cleanupConfirmed)) await clean(operation);

  return {
    async run(proof: string, request: WorkspaceBrokerRunRequest, options: { signal?: AbortSignal } = {}) {
      return serialize(async () => {
        options.signal?.throwIfAborted();
        keys(request,['operationId','workspaceId','generation','leaseId','profileId','command','cwd','environment','previewPort']);
        const grant = authorize(proof,'run',request.workspaceId);
        const workspace = workspaces.get(request.workspaceId)!;
        if (request.generation !== workspace.generation || request.leaseId !== grant.leaseId || !grant.profiles.includes(request.profileId)) throw fault('BROKER_UNAUTHORIZED');
        requireOpenLease(workspace.id,workspace.generation,request.leaseId);
        const profile = profiles.get(request.profileId)!;
        const payload = sanitize(request.command,request.cwd,request.environment,request.profileId);
        if (request.previewPort !== undefined && (!Number.isInteger(request.previewPort) || request.previewPort < 1024 || request.previewPort > 65535)) throw fault('BROKER_PREVIEW_PORT');
        const requestHash = hash(request);
        const existing = dedupe(request.operationId,requestHash,workspace.ownerId);
        if (existing) { authorize(proof,'run',request.workspaceId,existing); return receipt(existing); }
        const activeRuns = Object.values(state.operations).filter(item => item.kind === 'run' && !item.cleanupConfirmed);
        if (activeRuns.length >= 16 || activeRuns.filter(item => item.ownerId === workspace.ownerId).length >= 4) throw fault('BROKER_RESOURCE_BUDGET');
        if (state.leases[request.workspaceId] && state.leases[request.workspaceId] !== request.leaseId) throw fault('BROKER_WORKSPACE_BUSY');
        const mounts = await checkPaths(workspace.id,profile.id); mounts[0].readOnly = profile.readOnlyWorkspace;
        const networkId = await ensureNetwork(workspace.id);
        const inventory = await engine.listWorkspaceContainers(workspaceKey(workspace.id));
        const registered = new Set(activeRuns.filter(item => item.workspaceId === workspace.id).map(item => item.resourceId));
        if (inventory.some(id => !/^[a-f0-9]{64}$/.test(id) || !registered.has(id))) throw fault('BROKER_ORPHAN_PRESENT');
        const operation: Operation = { id: request.operationId, ownerId: workspace.ownerId, workspaceId: workspace.id, generation: workspace.generation,
          leaseId: request.leaseId, kind: 'run', requestHash, profileId: profile.id, state: 'prepared',
          name: 'chisa-broker-' + randomUUID(), networkId, mounts, previewPort: request.previewPort,
          cleanupConfirmed: false, stdinSequence: 0, stdinEnded: false, stdinBytes: 0, createdAt: Date.now(), deadline: Date.now() + profile.timeoutMs };
        state.operations[operation.id] = operation; state.leases[workspace.id] = request.leaseId; await save();
        watchAbort(operation,options.signal);
        try {
          options.signal?.throwIfAborted();
          operation.state = 'creating'; await save();
          const resourceId = await engine.createSandbox({ name: operation.name, imageDigest: profile.imageDigest, labels: labels(operation), networkId,
            uid: profile.uid, gid: profile.gid, memoryBytes: profile.memoryBytes, nanoCpus: profile.nanoCpus, pidsLimit: profile.pidsLimit, tmpfsBytes: profile.tmpfsBytes,
            mounts, ...payload, readOnlyWorkspace: profile.readOnlyWorkspace });
          if (!/^[a-f0-9]{64}$/.test(resourceId)) throw fault('BROKER_RESOURCE_ID_INVALID');
          operation.resourceId = resourceId; operation.state = 'starting'; await save();
          options.signal?.throwIfAborted();
          await checkPaths(workspace.id,profile.id); await ensureNetwork(workspace.id); await verifyContainer(operation);
          const socket = await engine.attachContainer(resourceId);
          socket.on('error', () => {}); sessions.set(operation.id,{ socket, claimed: false });
          options.signal?.throwIfAborted();
          await engine.startContainer(resourceId);
          options.signal?.throwIfAborted();
          const inspected = await verifyContainer(operation);
          if (!inspected) throw fault('BROKER_START_OUTCOME_UNKNOWN');
          operation.state = 'running'; await save(); arm(operation);
        } catch (error) {
          if (poisoned) throw error;
          operation.reason = error instanceof Error ? error.message.slice(0,120) : 'BROKER_START_FAILED';
          await clean(operation);
        }
        return receipt(operation);
      });
    },
    async exec(proof: string, request: WorkspaceBrokerExecRequest, options: { signal?: AbortSignal } = {}) {
      return serialize(async () => {
        options.signal?.throwIfAborted();
        keys(request,['operationId','parentOperationId','command','cwd','environment']);
        const parent = requireOperation(proof,'exec',request.parentOperationId);
        if (parent.kind !== 'run') throw fault('BROKER_EXEC_PARENT_INVALID');
        requireOpenLease(parent.workspaceId,parent.generation,parent.leaseId);
        const requestHash = hash(request);
        const existing = dedupe(request.operationId,requestHash,parent.ownerId);
        if (existing) { authorize(proof,'exec',existing.workspaceId,existing); return receipt(existing); }
        if (Object.values(state.operations).filter(item => item.parentId === parent.id && !item.cleanupConfirmed).length >= 4) throw fault('BROKER_RESOURCE_BUDGET');
        const inspected = await verifyContainer(parent);
        if (parent.state !== 'running' || !inspected?.running || !parent.resourceId) throw fault('BROKER_EXEC_PARENT_STOPPED');
        await checkPaths(parent.workspaceId,parent.profileId); await ensureNetwork(parent.workspaceId);
        const payload = sanitize(request.command,request.cwd,request.environment,parent.profileId);
        const operation: Operation = { ...structuredClone(parent), id: request.operationId, kind: 'exec', parentId: parent.id, requestHash,
          state: 'prepared', stdinSequence: 0, stdinEnded: false, stdinBytes: 0, createdAt: Date.now() };
        delete operation.execId; delete operation.stdinHash; delete operation.exitCode; delete operation.previewPort;
        state.operations[operation.id] = operation; await save();
        watchAbort(operation,options.signal);
        try {
          options.signal?.throwIfAborted();
          operation.state = 'creating'; await save();
          const profile = profiles.get(parent.profileId)!;
          operation.execId = await engine.createExec(parent.resourceId,{ ...payload, uid: profile.uid + ':' + profile.gid });
          if (!/^[a-f0-9]{64}$/.test(operation.execId)) throw fault('BROKER_EXEC_ID_INVALID');
          operation.state = 'starting'; await save();
          options.signal?.throwIfAborted();
          const socket = await engine.startExec(operation.execId);
          socket.on('error', () => {}); sessions.set(operation.id,{ socket, claimed: false });
          options.signal?.throwIfAborted();
          operation.state = 'running'; await save(); arm(operation);
        } catch (error) { if (poisoned) throw error; await clean(operation); }
        return receipt(operation);
      });
    },
    async status(proof: string, operationId: string) {
      return serialize(async () => {
        const operation = requireOperation(proof,'status',operationId);
        if (!operation.cleanupConfirmed) {
          if (operation.kind === 'exec' && operation.execId) {
            const result = await engine.inspectExec(operation.execId);
            if (!result.running) await finishExec(operation,result.exitCode);
          } else {
            const result = await verifyContainer(operation);
            if (!result || !result.running) { if (result) operation.exitCode = result.exitCode; await clean(operation); }
          }
        }
        return receipt(operation);
      });
    },
    async cancel(proof: string, operationId: string) { return serialize(() => clean(requireOperation(proof,'cancel',operationId))); },
    async reconcile(proof: string, operationId: string) { return serialize(() => clean(requireOperation(proof,'reconcile',operationId))); },
    async quiesceLease(proof: string, request: { workspaceId: string; generation: string; leaseId: string }) {
      return serialize(async () => {
        keys(request,['workspaceId','generation','leaseId']);
        const grant = authorize(proof,'quiesce',request.workspaceId);
        const workspace = workspaces.get(request.workspaceId)!;
        if (workspace.generation !== request.generation || grant.leaseId !== request.leaseId) throw fault('BROKER_UNAUTHORIZED');
        const key = leaseKey(request.workspaceId,request.generation,request.leaseId);
        const closed = state.closedLeases![key] ??= { ...request,requestedAt: Date.now() };
        // Publish the permanent fence before any async daemon cleanup. Even a new
        // independently signed grant can never reopen this exact generation/lease.
        await save();
        const operations = Object.values(state.operations).filter(item => item.workspaceId === request.workspaceId && item.generation === request.generation && item.leaseId === request.leaseId);
        for (const operation of operations.filter(item => item.kind === 'run' && !item.cleanupConfirmed)) await clean(operation);
        let reason: string | undefined;
        try {
          if (operations.some(item => !item.cleanupConfirmed || !item.resourceId)) throw fault('BROKER_LEASE_CLEANUP_PENDING');
          for (const operation of operations.filter(item => item.kind === 'run')) {
            if (await engine.inspectContainer(operation.resourceId!) || await engine.inspectContainer(operation.name)) throw fault('BROKER_LEASE_RESOURCE_PRESENT');
          }
          if ((await engine.listWorkspaceContainers(workspaceKey(workspace.id))).length) throw fault('BROKER_ORPHAN_PRESENT');
          closed.confirmedAt = Date.now(); await save();
        } catch (error) { if (poisoned) throw error; reason = error instanceof Error ? error.message.slice(0,120) : 'BROKER_LEASE_UNCONFIRMED'; }
        return { workspaceId: workspace.id,generation: workspace.generation,leaseId: request.leaseId,
          quiescent: reason === undefined,cleanupConfirmed: reason === undefined,resourceInventoryComplete: reason === undefined,closedAt: closed.requestedAt,confirmedAt: reason ? undefined : closed.confirmedAt,
          brokerInstanceId: state.instanceId,resources: operations.map(item => ({ operationId: item.id,resourceId: item.resourceId })),reason };
      });
    },
    async network(proof: string, workspaceId: string) {
      return serialize(async () => { authorize(proof,'network',workspaceId); await checkPaths(workspaceId); return { networkId: await ensureNetwork(workspaceId) }; });
    },
    async logs(proof: string, operationId: string) {
      return serialize(async () => {
        const operation = requireOperation(proof,'logs',operationId);
        if (operation.kind === 'exec') throw fault('BROKER_EXEC_LOGS_UNAVAILABLE');
        if (!operation.resourceId || !await verifyContainer(operation)) throw fault('BROKER_RESOURCE_ABSENT');
        const buffer = await engine.logs(operation.resourceId,profiles.get(operation.profileId)!.maxOutputBytes);
        return { multiplexed: buffer };
      });
    },
    async previewTarget(proof: string, operationId: string) {
      return serialize(async () => {
        const operation = requireOperation(proof,'preview',operationId);
        if (operation.kind !== 'run' || !operation.previewPort || operation.state !== 'running') throw fault('BROKER_PREVIEW_UNAVAILABLE');
        await checkPaths(operation.workspaceId,operation.profileId); await ensureNetwork(operation.workspaceId);
        const inspected = await verifyContainer(operation);
        if (!inspected?.running || isIP(inspected.address) !== 4 || !/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(inspected.address)) throw fault('BROKER_PREVIEW_UNAVAILABLE');
        return { host: inspected.address, port: operation.previewPort, resourceId: inspected.id };
      });
    },
    async writeStdin(proof: string, operationId: string, input: { sequence: number; data: Buffer; end?: boolean }) {
      return serialize(async () => {
        keys(input,['sequence','data','end']);
        const operation = requireOperation(proof,'stdin',operationId);
        if (!Buffer.isBuffer(input.data) || input.data.length > profiles.get(operation.profileId)!.maxStdinBytes || !Number.isSafeInteger(input.sequence) || input.sequence < 1 || (input.end !== undefined && typeof input.end !== 'boolean')) throw fault('BROKER_STDIN_INVALID');
        const digest = hash([input.data.toString('base64'),!!input.end]);
        if (input.sequence === operation.stdinSequence && digest === operation.stdinHash) return { sequence: input.sequence, replay: true };
        const session = sessions.get(operationId);
        if (operation.state !== 'running' || operation.stdinEnded || !session || input.sequence !== operation.stdinSequence + 1) throw fault('BROKER_STDIN_STATE');
        // Persist before sending: a lost reply may not repeat bytes. This is at-most-
        // once delivery, not proof that the sandbox consumed bytes after a crash.
        if (operation.stdinBytes + input.data.length > profiles.get(operation.profileId)!.maxStdinBytes) throw fault('BROKER_STDIN_LIMIT');
        operation.stdinSequence = input.sequence; operation.stdinHash = digest; operation.stdinEnded = !!input.end; operation.stdinBytes += input.data.length; await save();
        const socket = session.socket;
        if (socket.destroyed || !socket.writable) { await clean(operation); throw fault('BROKER_STDIN_CLOSED'); }
        if (!socket.write(input.data)) {
          const timeout = AbortSignal.timeout(5000);
          try { await once(socket,'drain',{ signal: timeout }); }
          catch { await clean(operation); throw fault('BROKER_STDIN_UNCONFIRMED'); }
        }
        if (input.end) socket.end();
        return { sequence: input.sequence, replay: false };
      });
    },
    async stream(proof: string, operationId: string, options: { signal?: AbortSignal } = {}) {
      const admitted = await serialize(async () => {
        const operation = requireOperation(proof,'stream',operationId);
        const session = sessions.get(operationId);
        if (!session || session.claimed || operation.state !== 'running') throw fault('BROKER_STREAM_UNAVAILABLE');
        session.claimed = true;
        return { operation, socket: session.socket, budget: profiles.get(operation.profileId)!.maxOutputBytes };
      });
      const { operation, socket, budget } = admitted;
      let finished = false;
      let stopping: Promise<void> | undefined;
      const stop = async () => {
        if (stopping) return stopping;
        if (finished) return;
        finished = true; socket.destroy();
        stopping = serialize(async () => { await clean(operation); });
        return stopping;
      };
      const abort = () => { void stop().catch(() => {}); };
      options.signal?.addEventListener('abort',abort,{ once: true });
      if (options.signal?.aborted) await stop();
      const iterator = (async function* () {
        let pending = Buffer.alloc(0); let total = 0;
        try {
          options.signal?.throwIfAborted();
          for await (const chunk of socket) {
            pending = Buffer.concat([pending,Buffer.from(chunk as Uint8Array)]);
            while (pending.length >= 8) {
              const length = pending.readUInt32BE(4);
              if (![1,2].includes(pending[0]) || pending[1] || pending[2] || pending[3] || length > 1024 * 1024 || total + length > budget) throw fault('BROKER_OUTPUT_LIMIT');
              if (pending.length < length + 8) break;
              total += length;
              const frame = { channel: pending[0] === 1 ? 'stdout' as const : 'stderr' as const, data: Buffer.from(pending.subarray(8,8+length)) };
              pending = pending.subarray(8+length); yield frame;
              options.signal?.throwIfAborted();
            }
            if (pending.length > 1024 * 1024 + 8) throw fault('BROKER_OUTPUT_LIMIT');
          }
          if (pending.length) throw fault('BROKER_STREAM_TRUNCATED');
          if (operation.kind === 'exec' && operation.execId) {
            const result = await engine.inspectExec(operation.execId);
            if (!result.running) {
              await serialize(async () => { await finishExec(operation,result.exitCode); });
              finished = true;
            }
          } else {
            const result = await verifyContainer(operation);
            if (result && !result.running) operation.exitCode = result.exitCode;
          }
        } finally { options.signal?.removeEventListener('abort',abort); await stop(); }
        return await serialize(async () => receipt(operation));
      })();
      return {
        [Symbol.asyncIterator]() { return this; },
        next() { return iterator.next(); },
        async return() { await stop(); return iterator.return(await serialize(async () => receipt(operation))); },
        async throw(error: unknown) { await stop(); return iterator.throw(error); },
      };
    },
    async retireLegacy(proof: string, workspaceId: string) {
      return serialize(async () => {
        authorize(proof,'retire',workspaceId); await checkPaths(workspaceId);
        const workspace = workspaces.get(workspaceId)!;
        const legacy = workspace.legacy;
        if (!legacy) return { retired: true,resourceId: '' }; // Operator manifest explicitly enrolls no legacy transport.
        if (!/^[a-f0-9]{64}$/.test(legacy.resourceId)) throw fault('BROKER_LEGACY_NOT_ENROLLED');
        for (const mount of legacy.mounts) {
          if (!path.isAbsolute(mount.source) || path.resolve(mount.source) !== mount.source || await realpath(mount.source) !== mount.source) throw fault('BROKER_LEGACY_PATH');
        }
        const inspected = await engine.inspectContainer(legacy.resourceId);
        if (!inspected) return { retired: true, resourceId: legacy.resourceId };
        const expectedMounts = legacy.mounts.map(mount => ({ ...mount }));
        if (inspected.id !== legacy.resourceId || inspected.name !== legacy.name || inspected.labels['chisa.workspace-sync.owner'] !== workspace.ownerId || inspected.privileged || inspected.hostPid ||
          inspected.networkId !== legacy.network || stable([...inspected.mounts].sort((a,b) => a.target.localeCompare(b.target))) !== stable(expectedMounts.sort((a,b) => a.target.localeCompare(b.target)))) throw fault('BROKER_LEGACY_MISMATCH');
        await engine.retireContainer(legacy.resourceId);
        const result = await engine.inspectContainer(legacy.resourceId);
        if (result && (result.id !== legacy.resourceId || result.running || result.restarting || result.restartPolicy !== 'no')) throw fault('BROKER_LEGACY_NOT_STOPPED');
        return { retired: true, resourceId: legacy.resourceId };
      });
    },
    async close() {
      await queue;
      closed = true;
      for (const id of sessions.keys()) clearSession(id);
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear(); registry.close();
    },
  };
}
