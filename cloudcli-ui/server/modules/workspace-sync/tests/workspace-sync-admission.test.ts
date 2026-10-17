import assert from 'node:assert/strict';
import { execFile as realExecFile, spawn as realSpawn } from 'node:child_process';
import * as childProcess from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import express from 'express';

const fixture = await mkdtemp(path.join(os.tmpdir(), 'chisa-preview-admission-'));
const project = path.join(fixture, 'project');
await mkdir(project);
process.env.WORKSPACES_ROOT = fixture;
const epoch = 'preview-epoch';
const marker = (protocol = 2) => ({ protocol, port: 18082, token: 'fixture', bindingEpoch: epoch });
const writeMarker = (protocol = 2) => writeFile(path.join(project, '.chisa-bridge.json'), JSON.stringify(marker(protocol)));
await writeMarker();

let commands: string[][] = [];
const containers = new Map<string, string>();
let runCompleted: (() => Promise<void>) | undefined;
let startupFails = false;
let removalFails = false;
const fakeExec = (_command: string, args: string[], _options: object, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
  commands.push(args);
  const child = new EventEmitter();
  const complete = (error: Error | null, stdout = '', stderr = '') => queueMicrotask(() => {
    callback(error, stdout, stderr);
    child.emit('close', error ? 1 : 0, null);
  });
  if (args[0] === 'run') {
    const id = args[args.indexOf('--name') + 1];
    containers.set(id, args[args.indexOf('--label') + 1].split('=')[1]);
    if (runCompleted) void runCompleted().then(() => complete(null, id));
    else complete(startupFails ? new Error('startup failed') : null, id);
  } else if (args[0] === 'inspect') {
    const id = args.at(-1)!;
    if (!containers.has(id)) complete(new Error('absent'), '', 'No such container');
    else complete(null, args.some(argument => argument.includes('.IPAddress')) ? '172.18.0.19' : containers.get(id));
  } else if (args[0] === 'rm') {
    if (removalFails) complete(new Error('cleanup unavailable'));
    else { containers.delete(args.at(-1)!); complete(null); }
  } else complete(new Error('unexpected command'));
  return child;
};
mock.module('node:child_process', { namedExports: {
  ...childProcess,
  execFile: fakeExec as unknown as typeof realExecFile,
  spawn: ((_command: string, args: string[]) => { commands.push(args); throw new Error('Unexpected worker spawn'); }) as unknown as typeof realSpawn,
} });
const { registerWorkspaceSyncNetwork } = await import('@/shared/index.js');
const network = 'chisa-workspace-network-' + 'd'.repeat(24);
registerWorkspaceSyncNetwork(project, network, '172.18.0.2');
const { createWorkspaceSyncPreviewService } = await import('../workspace-sync-preview.service.js');
const { createWorkspaceSyncRouter } = await import('../workspace-sync.routes.js');
const { workspaceQuery } = await import('@/modules/workspace-bridge/index.js');
const service = createWorkspaceSyncPreviewService();
const statePath = path.join(project + '.chisa-lease', 'state.json');
const saveLease = async (value: object) => {
  await mkdir(project + '.chisa-lease', { recursive: true });
  await writeFile(statePath, JSON.stringify(value));
};
test.beforeEach(() => { commands = []; containers.clear(); runCompleted = undefined; startupFails = false; removalFails = false; });
test.afterEach(async () => { await rm(project + '.chisa-lease', { recursive: true, force: true }); await writeMarker(); });
test.after(() => rm(fixture, { recursive: true, force: true }));

for (const owner of ['pi', 'sync', 'sync-needed']) {
  test(`preview startup rejects ${owner} before Docker and preserves its lease`, async () => {
    const lease = { id: 'foreign', epoch, owner };
    await saveLease(lease);
    await assert.rejects(service.start('1', project, epoch, 'node server.js', '/workspace', 3000), { code: 'WORKSPACE_BUSY' });
    assert.deepEqual(JSON.parse(readFileSync(statePath, 'utf8')), lease);
    assert.equal(commands.length, 0);
  });
}

test('preview startup rejects stale epoch and protocol 1 before Docker', async () => {
  await assert.rejects(service.start('1', project, 'previous', 'node server.js', '/workspace', 3000), { code: 'STALE_BINDING' });
  await writeMarker(1);
  await assert.rejects(service.start('1', project, epoch, 'node server.js', '/workspace', 3000), { code: 'STALE_BINDING' });
  await writeMarker();
  await saveLease({ id: 'old', epoch: 'previous', owner: 'claude' });
  await assert.rejects(service.start('1', project, epoch, 'node server.js', '/workspace', 3000), { code: 'WORKSPACE_BUSY' });
  assert.equal(commands.length, 0);
});

test('preview startup rejects cleanup barriers without creating a container', async () => {
  await saveLease({ id: 'model', epoch, owner: 'claude', cleanupPending: ['chisa-rpc-pending'] });
  await assert.rejects(service.start('1', project, epoch, 'node server.js', '/workspace', 3000), { code: 'WORKSPACE_CLEANUP_FAILED' });
  assert.equal(commands.length, 0);
});

test('managed preview fails closed without a registered account network', async () => {
  const unregistered = path.join(fixture, 'unregistered');
  await mkdir(unregistered);
  await writeFile(path.join(unregistered, '.chisa-bridge.json'), JSON.stringify(marker()));
  await assert.rejects(service.start('1', unregistered, epoch, 'node server.js', '/workspace', 3000), { code: 'WORKSPACE_SYNC_UNAVAILABLE' });
  assert.equal(commands.length, 0);
  assert.equal(existsSync(unregistered + '.chisa-lease'), false);
});

test('idle preview startup holds a temporary lease until delivery and blocks a new model', async () => {
  let started!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  let complete!: () => void;
  const released = new Promise<void>(resolve => { complete = resolve; });
  runCompleted = async () => { started(); await released; };
  const preview = service.start('1', project, epoch, 'node server.js', '/workspace', 3000);
  await running;
  const lease = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(lease.owner, 'claude');
  assert.equal(lease.epoch, epoch);
  assert.equal(lease.mayWrite, true);
  await assert.rejects(workspaceQuery({ prompt: 'must not overlap', options: { cwd: project } }).next(), { code: 'WORKSPACE_BUSY' });
  complete();
  const startedPreview = await preview;
  assert.equal(existsSync(project + '.chisa-lease'), false);
  await service.remove('1', startedPreview.id);
});

test('preview ordinary startup failure releases its temporary lease only after confirmed removal', async () => {
  startupFails = true;
  await assert.rejects(service.start('1', project, epoch, 'node server.js', '/workspace', 3000), /startup failed/);
  assert.equal(existsSync(project + '.chisa-lease'), false);
  assert.equal(containers.size, 0);
});

test('preview cleanup failure retains its precise container recovery barrier', async () => {
  startupFails = true;
  removalFails = true;
  await assert.rejects(service.start('1', project, epoch, 'node server.js', '/workspace', 3000), { code: 'PREVIEW_CLEANUP_FAILED' });
  const lease = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(lease.owner, 'sync-needed');
  assert.equal(lease.epoch, epoch);
  assert.deepEqual(lease.cleanupPending, [...containers.keys()]);
  assert.match(lease.cleanupPending[0], /^chisa-account-preview-[a-f0-9]{20}-[a-f0-9]{16}$/);
});

test('current Claude preview uses its account network, leaves ownership unchanged and removes only the created container', async () => {
  const lease = { id: 'model', epoch, owner: 'claude', mayWrite: true };
  await saveLease(lease);
  const started = await service.start('1', project, epoch, 'node server.js', '/workspace', 3000);
  assert.ok(commands[0].includes('--network=' + network));
  assert.ok(commands.some(args => args.includes('{{(index .NetworkSettings.Networks "' + network + '").IPAddress}}')));
  assert.deepEqual(JSON.parse(readFileSync(statePath, 'utf8')), lease);
  await service.remove('1', started.id);
  assert.equal(containers.size, 0);
});

test('a worker request disconnected during parent restoration never enters Docker', { timeout: 5_000 }, async () => {
  let restored!: () => void;
  const restoration = new Promise<void>(resolve => { restored = resolve; });
  let entered!: () => void;
  const restoring = new Promise<void>(resolve => { entered = resolve; });
  let finished!: (error: unknown) => void;
  const result = new Promise<unknown>(resolve => { finished = resolve; });
  let responseClosed!: () => void;
  const closed = new Promise<void>(resolve => { responseClosed = resolve; });
  const app = express();
  app.use(express.json());
  app.use((request, response, next) => {
    (request as express.Request & { user: { id: string } }).user = { id: '1' };
    response.once('close', responseClosed);
    next();
  });
  app.use('/sync', createWorkspaceSyncRouter({
    restore: async () => { entered(); await restoration; },
    enroll: async () => { throw new Error('enrollment must not run'); },
  }));
  const errorHandler: express.ErrorRequestHandler = (error, _request, response, _next) => {
    finished(error);
    if (!response.destroyed) response.status(500).end();
  };
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const payload = JSON.stringify({ serverPath: project, bindingEpoch: epoch, request: { op: 'write' } });
  const outgoing = http.request({ host: '127.0.0.1', port: (server.address() as AddressInfo).port, path: '/sync/worker', method: 'POST',
    headers: { Authorization: 'Bearer fixture', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } });
  outgoing.on('error', () => {});
  outgoing.end(payload);
  try {
    await restoring;
    outgoing.destroy();
    await closed;
    restored();
    assert.equal((await result as Error).name, 'AbortError');
    assert.equal(commands.length, 0);
  } finally {
    restored();
    outgoing.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
