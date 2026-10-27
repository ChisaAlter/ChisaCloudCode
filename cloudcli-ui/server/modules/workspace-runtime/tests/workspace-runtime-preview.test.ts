import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';
import { promisify } from 'node:util';

import type { WorkspaceRuntimePreviewReservation } from '@/shared/index.js';

const fixture = await mkdtemp(path.join(os.tmpdir(), 'chisa-runtime-preview-'));
const project = path.join(fixture, 'project');
const witnessHome = await mkdtemp(path.join(os.tmpdir(), 'chisa-runtime-preview-home-'));
mock.module('node:os', { defaultExport: { ...os, homedir: () => witnessHome }, namedExports: { ...os, homedir: () => witnessHome } });
let recoveryFails = false;
const recoveries: Array<{ userId: string; accountRoot: string; root: string; previewId: string }> = [];
mock.module('@/modules/workspace-bridge/index.js', { namedExports: {
  recoverStoppedWorkspacePreview: async (input: { userId: string; accountRoot: string; root: string; previewId: string }) => {
    assert.equal(containers.has(input.previewId), false, 'runtime confirms container absence before orphan lease recovery');
    recoveries.push(input);
    if (recoveryFails) throw new Error('orphan lease recovery failed');
    return { released: true };
  },
} });
await mkdir(project);
process.env.WORKSPACES_ROOT = fixture;
const network = 'chisa-workspace-network-' + 'd'.repeat(24);
const identity = { userId: '17', root: fixture, network, owner: 'd'.repeat(24) };
let restores = 0;
let restoreFails = false;
let removeFails = false;
let startupFails = false;
const commands: string[][] = [];
const events: Array<[string, string | boolean | undefined]> = [];
const containers = new Map<string, {
  Name: string; State: { Running: boolean; ExitCode: number }; Config: { Labels: Record<string, string> };
  Mounts: Array<{ Source: string; Destination: string; Type: string; RW: boolean }>;
  NetworkSettings: { Networks: Record<string, { IPAddress: string }> };
}>();
let retainedCleanup: (() => Promise<void>) | undefined;
let onRun: (() => void | Promise<void>) | undefined;
const commandResult = async (args: string[]) => {
  commands.push(args);
  const id = args.at(-1)!;
  if (args[0] === 'run') {
    const name = args[args.indexOf('--name') + 1];
    assert.ok(events.some(([event, retained]) => event === 'retain' && retained === name), 'persist lifetime before Docker');
    const labels: Record<string, string> = {};
    args.forEach((argument, index) => { if (argument === '--label') { const [key, value] = args[index + 1].split('='); labels[key] = value; } });
    const mount = args[args.indexOf('--volume') + 1];
    containers.set(name, { Name: '/' + name, State: { Running: true, ExitCode: 0 }, Config: { Labels: labels },
      Mounts: [{ Source: mount.slice(0, -':/workspace:rw'.length), Destination: '/workspace', Type: 'bind', RW: true }],
      NetworkSettings: { Networks: { [network]: { IPAddress: '172.18.0.10' } } } });
    await onRun?.();
    if (startupFails) throw new Error('startup failed');
    return { stdout: name, stderr: '' };
  }
  if (args[0] === 'ps') return { stdout: [...containers.keys()].join('\n'), stderr: '' };
  if (args[0] === 'inspect') {
    if (args[1] !== '--format') return { stdout: JSON.stringify(args.slice(1).map(value => containers.get(value))), stderr: '' };
    const container = containers.get(id);
    if (!container) throw Object.assign(new Error('absent'), { stderr: 'Error: No such object: ' + id });
    const format = args[2];
    const stdout = format.includes('IPAddress') ? container.NetworkSettings.Networks[network]?.IPAddress ?? '' :
      format.includes('.State') ? JSON.stringify(container.State) : container.Config.Labels['chisa.sync-preview.owner'];
    return { stdout, stderr: '' };
  }
  if (args[0] === 'rm') {
    if (removeFails) throw new Error('remove failed');
    containers.delete(id); return { stdout: '', stderr: '' };
  }
  if (args[0] === 'logs') return { stdout: 'preview ready', stderr: '' };
  throw new Error('Unexpected Docker command ' + args.join(' '));
};
const fakeExec = Object.assign((_command: string, args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
  const child = new EventEmitter();
  queueMicrotask(() => { void commandResult(args).then(result => { callback(null, result.stdout, result.stderr); child.emit('close', 0); }, error => {
    callback(error, '', error.stderr ?? ''); child.emit('close', 1);
  }); });
  return child;
}, { [promisify.custom]: async (_command: string, args: string[]) => commandResult(args) });
mock.module('node:child_process', { namedExports: { ...childProcess, execFile: fakeExec } });
mock.module('../workspace-runtime.service.js', { namedExports: {
  getWorkspaceRuntimeIdentity: (root: string) => root === fixture || root.startsWith(fixture + path.sep) ? identity : undefined,
  createWorkspaceRuntimeService: () => ({ restore: async (userId: string) => {
    assert.equal(userId, '17'); restores++; if (restoreFails) throw new Error('runtime ownership unavailable'); return identity;
  } }),
} });
const { registerWorkspaceRuntimeNetwork } = await import('@/shared/index.js');
registerWorkspaceRuntimeNetwork(fixture, network, identity.owner);
const { createWorkspaceRuntimePreviewService, executeWorkspaceRuntimePreview } = await import('../workspace-runtime-preview.service.js');
const { resolveWorkspaceRuntimePreviewAccess, getWorkspaceRuntimePreviewUrl } = await import('../workspace-runtime-preview-access.service.js');
const service = createWorkspaceRuntimePreviewService();
const reservation = (root = project): WorkspaceRuntimePreviewReservation => ({
  root,
  retain(id, cleanup) { events.push(['retain', id]); retainedCleanup = cleanup; },
  async release(id, confirmed) { events.push(['release-' + confirmed, id]); },
  async finish(confirmed, id) { events.push(['finish-' + confirmed, id]); },
});
const startRequest = { op: 'preview_start', command: 'node preview.js', port: 3000 };

test.beforeEach(() => { restores = 0; restoreFails = false; removeFails = false; startupFails = false; recoveryFails = false; recoveries.length = 0; commands.length = 0; events.length = 0; retainedCleanup = undefined; onRun = undefined; });
test.afterEach(async () => { removeFails = false; for (const id of containers.keys()) await service.discard('17', id); });
test.after(() => Promise.all([rm(fixture, { recursive: true, force: true }), rm(witnessHome, { recursive: true, force: true })]));

test('direct cloud preview starts without desktop, supplies a browser base and retains writer until confirmed stop', async () => {
  const result = await executeWorkspaceRuntimePreview(project, 'epoch', startRequest, reservation());
  assert.equal(result.ok, true);
  assert.match(result.previewId!, /^chisa-account-preview-[a-f0-9]{20}-[a-f0-9]{16}$/);
  assert.match(result.url!, /^\/api\/workspace-runtime\/preview\/[a-f0-9]{64}\/$/);
  assert.equal(result.basePath, result.url);
  assert.equal(restores, 1);
  const run = commands.find(args => args[0] === 'run')!;
  assert.ok(run.includes('--env=CHISA_PREVIEW_BASE=' + result.url));
  assert.ok(run.includes('--network=' + network));
  assert.deepEqual(events, [['retain', result.previewId], ['finish-true', undefined]]);
  const token = result.url!.split('/').at(-2)!;
  assert.equal((await resolveWorkspaceRuntimePreviewAccess(token)).host, '172.18.0.10');
  const stopped = await executeWorkspaceRuntimePreview(project, 'epoch', { op: 'preview_stop', previewId: result.previewId });
  assert.equal(stopped.status, 'stopped');
  assert.ok(events.some(([event, id]) => event === 'release-true' && id === result.previewId));
  await assert.rejects(resolveWorkspaceRuntimePreviewAccess(token), { code: 'PREVIEW_NOT_FOUND' });
});

test('status checks exact root and epoch then reports the same browser URL', async () => {
  const started = await executeWorkspaceRuntimePreview(project, 'epoch', startRequest, reservation());
  const fetchMock = mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    assert.equal(String(url), 'http://172.18.0.10:3000' + started.url); return new Response('ready');
  });
  try {
    const status = await executeWorkspaceRuntimePreview(project, 'epoch', { op: 'preview_status', previewId: started.previewId });
    assert.ok('running' in status);
    assert.equal(status.url, started.url); assert.equal(status.running, true); assert.equal(status.ready, true);
    assert.equal(status.stdout, 'preview ready');
    for (const [root, epoch] of [[project, 'stale'], [path.join(fixture, 'other'), 'epoch']]) {
      await assert.rejects(executeWorkspaceRuntimePreview(root, epoch, { op: 'preview_stop', previewId: started.previewId }), { code: 'PREVIEW_NOT_FOUND' });
    }
    assert.equal(containers.size, 1);
  } finally { fetchMock.mock.restore(); }
});

test('a missing preview base route or failed application is never reported ready', async () => {
  const started = await executeWorkspaceRuntimePreview(project, 'epoch', startRequest, reservation());
  let httpStatus = 404;
  const fetchMock = mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    assert.equal(String(url), 'http://172.18.0.10:3000' + started.url);
    return new Response('not ready', { status: httpStatus });
  });
  try {
    for (const code of [404, 500]) {
      httpStatus = code;
      const status = await executeWorkspaceRuntimePreview(project, 'epoch', { op: 'preview_status', previewId: started.previewId });
      assert.ok('running' in status);
      assert.equal(status.running, true);
      assert.equal(status.ready, false);
    }
  } finally { fetchMock.mock.restore(); }
});

test('preflight rejects account root, foreign root, invalid command and changed runtime without Docker', async () => {
  await assert.rejects(executeWorkspaceRuntimePreview(fixture, 'epoch', startRequest, reservation(fixture)), { code: 'WORKSPACE_RUNTIME_UNAVAILABLE' });
  await assert.rejects(executeWorkspaceRuntimePreview(path.dirname(fixture), 'epoch', startRequest, reservation(path.dirname(fixture))), { code: 'WORKSPACE_RUNTIME_UNAVAILABLE' });
  await assert.rejects(executeWorkspaceRuntimePreview(project, 'epoch', { ...startRequest, path: '/workspace/../escape' }, reservation()), { code: 'INVALID_REQUEST' });
  restoreFails = true;
  await assert.rejects(executeWorkspaceRuntimePreview(project, 'epoch', startRequest, reservation()), /runtime ownership unavailable/);
  assert.equal(commands.length, 0);
  assert.deepEqual(events, Array.from({ length: 4 }, () => ['finish-true', undefined]));
});

test('cancellation after Docker starts removes its exact container before settling startup', async () => {
  const cancellation = new AbortController();
  onRun = () => cancellation.abort(new Error('cancelled'));
  await assert.rejects(executeWorkspaceRuntimePreview(project, 'epoch', startRequest, reservation(), cancellation.signal), /cancelled/);
  assert.equal(containers.size, 0);
  assert.deepEqual(events.map(([event]) => event), ['retain', 'release-true', 'finish-true']);
});

test('failed startup cleanup retains recovery identity and revokes browser access', async () => {
  startupFails = true; removeFails = true;
  await assert.rejects(executeWorkspaceRuntimePreview(project, 'epoch', startRequest, reservation()), { code: 'PREVIEW_CLEANUP_FAILED' });
  const [id] = containers.keys();
  assert.deepEqual(events.map(([event]) => event), ['retain', 'release-false', 'finish-false']);
  assert.equal(events.at(-1)![1], id);
  assert.equal(getWorkspaceRuntimePreviewUrl(id), undefined);
});

test('session-retained cleanup stops its container and releases its lifetime', async () => {
  const started = await executeWorkspaceRuntimePreview(project, 'epoch', startRequest, reservation());
  assert.ok(retainedCleanup);
  await retainedCleanup();
  assert.equal(containers.size, 0);
  assert.equal(getWorkspaceRuntimePreviewUrl(started.previewId!), undefined);
  assert.equal(events.at(-1)![0], 'release-true');
});

test('concurrent browser stop and session close remove and release the preview only once', async () => {
  const started = await executeWorkspaceRuntimePreview(project, 'epoch', startRequest, reservation());
  assert.ok(retainedCleanup);
  await Promise.all([service.remove('17', started.previewId!), retainedCleanup()]);
  assert.equal(containers.size, 0);
  assert.equal(commands.filter(args => args[0] === 'rm').length, 1);
  assert.equal(events.filter(([event]) => event === 'release-true').length, 1);
});

test('public stop retries exact reservation release after Docker is already absent', async () => {
  const captured = reservation();
  let attempts = 0;
  captured.release = async (_id, confirmed) => {
    assert.equal(confirmed, true);
    attempts++;
    if (attempts === 1) throw new Error('transient lease release');
  };
  const started = await executeWorkspaceRuntimePreview(project, 'epoch', startRequest, captured);
  await assert.rejects(service.remove('17', started.previewId!), /transient lease release/);
  assert.equal(containers.size, 0);
  await service.remove('17', started.previewId!);
  await service.remove('17', started.previewId!);
  assert.equal(attempts, 2);
  assert.equal(commands.filter(args => args[0] === 'rm').length, 1);
  await assert.rejects(service.remove('another-account', started.previewId!), { code: 'PREVIEW_NOT_FOUND' });
});

const witnessLease = { owner: 'claude' as const, id: 'exact-preview-run', epoch: 'epoch', pid: 654321,
  processStartTime: '12345', bootId: '11111111-2222-3333-4444-555555555555', writerGate: true as const };
const witnessPath = (id: string) => path.join(witnessHome, '.chisa-workspace-runtime', 'previews', id + '.json');

test('gate-backed preview persists its exact private witness before Docker and removes it after release', async () => {
  const captured = { ...reservation(), lease: witnessLease };
  onRun = async () => {
    const [id] = containers.keys();
    const witness = JSON.parse(await readFile(witnessPath(id), 'utf8'));
    assert.deepEqual(witness, { version: 1, userId: '17', accountRoot: fixture, root: project, previewId: id, lease: witnessLease });
  };
  const started = await executeWorkspaceRuntimePreview(project, 'epoch', startRequest, captured);
  await service.remove('17', started.previewId!);
  await assert.rejects(readFile(witnessPath(started.previewId!)), { code: 'ENOENT' });
  assert.equal(recoveries.length, 0, 'live exact reservation uses its existing callback');
});

test('cancelled startup keeps its witness across transient final settlement and retries without poisoning cleanup', async () => {
  const captured = { ...reservation(), lease: witnessLease };
  let finishes = 0;
  captured.finish = async confirmed => {
    assert.equal(confirmed, true, 'confirmed Docker cleanup must not become unconfirmed on release failure');
    finishes++;
    if (finishes === 1) throw new Error('transient startup settlement');
  };
  const cancellation = new AbortController();
  onRun = () => cancellation.abort(new Error('cancelled'));
  await assert.rejects(service.start('17', 'epoch', 'node preview.js', '/workspace', 3000, captured, cancellation.signal), /transient startup settlement/);
  const id = events.find(([event]) => event === 'retain')![1];
  assert.ok(typeof id === 'string');
  assert.equal(containers.size, 0);
  assert.ok(await readFile(witnessPath(id), 'utf8'));
  await service.remove('17', id);
  assert.equal(finishes, 2);
  await assert.rejects(readFile(witnessPath(id)), { code: 'ENOENT' });
  assert.equal(recoveries.length, 0);
});

test('restart inventory keeps stopped witnesses visible and retries orphan recovery without Docker', async () => {
  const owner = createHash('sha256').update(fixture + '\0' + '17').digest('hex').slice(0, 20);
  const id = 'chisa-account-preview-' + owner + '-' + 'e'.repeat(16);
  const directory = path.dirname(witnessPath(id));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(witnessPath(id), JSON.stringify({ version: 1, userId: '17', accountRoot: fixture, root: project, previewId: id, lease: witnessLease }), { mode: 0o600 });
  assert.deepEqual(await service.list('17'), { previews: [{ id, serverPath: project, bindingEpoch: 'epoch', remoteHost: '', remotePort: 0 }] });
  recoveryFails = true;
  await assert.rejects(service.remove('17', id), /orphan lease recovery failed/);
  assert.ok(await readFile(witnessPath(id), 'utf8'));
  recoveryFails = false;
  await executeWorkspaceRuntimePreview(project, 'epoch', { op: 'preview_stop', previewId: id });
  assert.deepEqual(recoveries, Array.from({ length: 2 }, () => ({ userId: '17', accountRoot: fixture, root: project, previewId: id })));
  await assert.rejects(readFile(witnessPath(id)), { code: 'ENOENT' });
  assert.equal(commands.filter(args => args[0] === 'rm').length, 0);
  assert.deepEqual(await service.list('17'), { previews: [] });
});

test('isolated previews cannot modify session identity or the worktree Git pointer', async () => {
  const isolated = path.join(fixture, 'project.chisa-worktrees', 'session');
  await mkdir(isolated, { recursive: true });
  await writeFile(path.join(isolated, '.chisa-session.json'), '{}');
  await writeFile(path.join(isolated, '.git'), 'gitdir: /hidden/worktree');
  await executeWorkspaceRuntimePreview(isolated, 'epoch', startRequest, reservation(isolated));
  const run = commands.find(args => args[0] === 'run')!;
  assert.ok(run.includes('type=bind,src=/dev/null,dst=/workspace/.chisa-session.json,readonly'));
  assert.ok(run.includes('type=bind,src=' + path.join(isolated, '.git') + ',dst=/workspace/.git,readonly'));
});
