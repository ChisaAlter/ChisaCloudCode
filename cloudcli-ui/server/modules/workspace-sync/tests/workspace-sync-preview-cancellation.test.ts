import assert from 'node:assert/strict';
import { execFile as realExecFile } from 'node:child_process';
import * as childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import express from 'express';

const fixture = await mkdtemp(path.join(os.tmpdir(), 'chisa-preview-cancel-'));
const project = path.join(fixture, 'project');
await mkdir(project);
await writeFile(path.join(project, '.chisa-bridge.json'), JSON.stringify({ protocol: 2, port: 18082, token: 'fixture', bindingEpoch: 'preview-epoch' }));
process.env.WORKSPACES_ROOT = fixture;
const { registerWorkspaceSyncNetwork } = await import('@/shared/index.js');
const network = 'chisa-workspace-network-' + 'c'.repeat(24);
registerWorkspaceSyncNetwork(fixture, network, '172.18.0.2');

type Invocation = {
  mode: 'running' | 'delivery';
  containers: Map<string, string>;
  sequence: string[];
  started: () => void;
  inspectFailure?: { error: Error; stderr: string };
  inventory?: unknown[];
};
let invocation: Invocation;
const fakeExec = (_command: string, args: string[], options: { signal?: AbortSignal },
  callback: (error: Error | null, stdout: string, stderr: string) => void) => {
  const child = new EventEmitter();
  const complete = (error: Error | null, stdout = '', stderr = '') => queueMicrotask(() => {
    callback(error, stdout, stderr);
    child.emit('close', error ? 1 : 0, null);
  });
  if (args[0] === 'run') {
    assert.ok(args.includes('--network=' + network));
    const id = args[args.indexOf('--name') + 1];
    const label = args[args.indexOf('--label') + 1].split('=')[1];
    invocation.containers.set(id, label);
    invocation.sequence.push('created');
    invocation.started();
    if (invocation.mode === 'running') {
      options.signal?.addEventListener('abort', () => {
        const error = Object.assign(new Error('cancelled'), { name: 'AbortError' });
        callback(error, '', '');
        child.emit('error', error);
        setImmediate(() => {
          invocation.sequence.push('docker-client-exited');
          child.emit('close', 1, null);
        });
      }, { once: true });
    } else complete(null, id);
  } else if (args[0] === 'ps') {
    invocation.sequence.push('listed');
    complete(null, [...invocation.containers.keys()].join('\n'));
  } else if (args[0] === 'inspect' && !args.includes('--format')) {
    invocation.sequence.push('inventory');
    complete(null, JSON.stringify(invocation.inventory ?? []));
  } else if (args[0] === 'inspect') {
    invocation.sequence.push('inspected');
    const id = args.at(-1)!;
    const label = invocation.containers.get(id);
    if (invocation.inspectFailure) complete(invocation.inspectFailure.error, '', invocation.inspectFailure.stderr);
    else if (!label) complete(new Error('absent'), '', 'Error: No such object: ' + id);
    else complete(null, args.some(argument => argument.includes('.IPAddress')) ? '172.18.0.19\n' : label + '\n');
  } else if (args[0] === 'rm') {
    invocation.sequence.push('removed');
    invocation.containers.delete(args.at(-1)!);
    complete(null);
  } else complete(new Error('Unexpected Docker command'));
  return child;
};
mock.module('node:child_process', { namedExports: { ...childProcess, execFile: fakeExec as unknown as typeof realExecFile } });
const { createWorkspaceSyncPreviewRouter } = await import('../workspace-sync-preview.routes.js');
const { createWorkspaceSyncPreviewService } = await import('../workspace-sync-preview.service.js');
test.after(() => rm(fixture, { recursive: true, force: true }));

for (const mode of ['running', 'delivery'] as const) {
  test(mode === 'running' ? 'disconnect during Docker preview start waits for the client to exit and removes its owned container'
    : 'disconnect while delivering the preview id removes the unaccepted owned container', { timeout: 5_000 }, async () => {
    let started!: () => void;
    const runStarted = new Promise<void>(resolve => { started = resolve; });
    let finished!: (error: unknown) => void;
    const routeFinished = new Promise<unknown>(resolve => { finished = resolve; });
    invocation = { mode, containers: new Map(), sequence: [], started };
    const app = express();
    app.use(express.json());
    app.use((request, response, next) => {
      (request as express.Request & { user: { id: string } }).user = { id: '1' };
      if (mode === 'delivery') response.json = () => { response.destroy(); return response; };
      next();
    });
    app.use('/preview', createWorkspaceSyncPreviewRouter());
    const errorHandler: express.ErrorRequestHandler = (error, _request, response, _next) => {
      finished(error);
      if (!response.destroyed) response.status(500).end();
    };
    app.use(errorHandler);
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const payload = JSON.stringify({ op: 'start', serverPath: project, bindingEpoch: 'preview-epoch', command: 'node preview.js', cwd: '/workspace', port: 3000 });
    const outgoing = http.request({ host: '127.0.0.1', port: (server.address() as AddressInfo).port, path: '/preview',
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } });
    outgoing.on('error', () => {});
    outgoing.end(payload);
    try {
      await runStarted;
      if (mode === 'running') outgoing.destroy();
      const error = await routeFinished;
      assert.equal((error as Error).name, 'AbortError');
      assert.equal(invocation.containers.size, 0, 'cancelled request must leave no preview running');
      assert.equal(invocation.sequence.filter(item => item === 'removed').length, 1);
      if (mode === 'running') assert.ok(invocation.sequence.indexOf('docker-client-exited') < invocation.sequence.indexOf('removed'));
    } finally {
      outgoing.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
}

const ownedId = 'chisa-account-preview-' + createHash('sha256').update(path.resolve(fixture) + '\0' + '1').digest('hex').slice(0, 20) + '-' + '1'.repeat(16);
const previewOperations = ['inspect', 'logs', 'remove'] as const;

for (const operation of previewOperations) {
  test(`missing account-owned preview ${operation} returns PREVIEW_NOT_FOUND 404 without starting another Docker action`, async () => {
    invocation = { mode: 'delivery', containers: new Map(), sequence: [], started: () => {} };
    await assert.rejects(createWorkspaceSyncPreviewService()[operation]('1', ownedId), { code: 'PREVIEW_NOT_FOUND', statusCode: 404 });
    assert.deepEqual(invocation.sequence, ['inspected']);
  });
}

test('foreign account preview operations reject before Docker inspect', async () => {
  invocation = { mode: 'delivery', containers: new Map(), sequence: [], started: () => {} };
  const foreignId = 'chisa-account-preview-' + createHash('sha256').update(path.resolve(fixture) + '\0' + '2').digest('hex').slice(0, 20) + '-' + '2'.repeat(16);
  const service = createWorkspaceSyncPreviewService();
  for (const operation of previewOperations) {
    await assert.rejects(service[operation]('1', foreignId), { code: 'PREVIEW_NOT_FOUND', statusCode: 404 });
  }
  assert.deepEqual(invocation.sequence, []);
});

for (const [kind, stderr] of [
  ['permission', 'permission denied while trying to connect to the Docker daemon socket'],
  ['unknown', 'Error response from daemon: failed to query container metadata'],
] as const) {
  test(`Docker ${kind} failure remains the original error instead of being masked as a missing preview`, async () => {
    const failure = new Error(kind + ' Docker failure');
    const service = createWorkspaceSyncPreviewService();
    for (const operation of [...previewOperations, 'discard'] as const) {
      invocation = { mode: 'delivery', containers: new Map(), sequence: [], started: () => {}, inspectFailure: { error: failure, stderr } };
      await assert.rejects(service[operation]('1', ownedId), error => error === failure);
      assert.deepEqual(invocation.sequence, ['inspected']);
    }
  });
}

test('discard of a missing account-owned container remains a safe no-op', async () => {
  invocation = { mode: 'delivery', containers: new Map(), sequence: [], started: () => {},
    inspectFailure: { error: new Error('absent'), stderr: 'Error response from daemon: No such container: ' + ownedId } };
  await createWorkspaceSyncPreviewService().discard('1', ownedId);
  assert.deepEqual(invocation.sequence, ['inspected']);
});

test('a fresh service discovers detached owned previews from Docker and retains recovery metadata', async () => {
  const owner = createHash('sha256').update(path.resolve(fixture) + '\0' + '1').digest('hex').slice(0, 20);
  const container = (id: string, root = project) => ({
    Name: '/' + id,
    Config: { Labels: { 'chisa.sync-preview.owner': owner, 'chisa.sync-preview.epoch': 'preview-epoch',
      'chisa.sync-preview.port': '3000', 'chisa.workspace-root': createHash('sha256').update(path.resolve(root)).digest('hex') } },
    Mounts: [{ Source: root, Destination: '/workspace' }],
    NetworkSettings: { Networks: { [network]: { IPAddress: '172.18.0.19' } } },
  });
  const foreign = container(ownedId.replace(/1{16}$/, '2'.repeat(16)));
  foreign.Config.Labels['chisa.sync-preview.owner'] = 'foreign-owner';
  const outside = container(ownedId.replace(/1{16}$/, '3'.repeat(16)), path.dirname(fixture));
  const forged = container(ownedId.replace(/1{16}$/, '4'.repeat(16)));
  forged.Config.Labels['chisa.workspace-root'] = 'wrong-root';
  invocation = { mode: 'delivery', containers: new Map([[ownedId, owner]]), sequence: [], started: () => {},
    inventory: [container(ownedId), foreign, outside, forged] };
  assert.deepEqual(await createWorkspaceSyncPreviewService().list('1'), { previews: [{ id: ownedId, serverPath: path.resolve(project),
    bindingEpoch: 'preview-epoch', remoteHost: '172.18.0.19', remotePort: 3000 }] });
  assert.deepEqual(invocation.sequence, ['listed', 'inventory']);
});

test('discovery without a process-local transport registration keeps legacy previews stoppable', async () => {
  const owner = createHash('sha256').update(path.resolve(fixture) + '\0' + '1').digest('hex').slice(0, 20);
  invocation = { mode: 'delivery', containers: new Map([[ownedId, owner]]), sequence: [], started: () => {}, inventory: [{
    Name: '/' + ownedId, Config: { Labels: { 'chisa.sync-preview.owner': owner,
      'chisa.workspace-root': createHash('sha256').update(path.resolve(project)).digest('hex') } },
    Mounts: [{ Source: project, Destination: '/workspace' }],
    NetworkSettings: { Networks: { 'old-detached-network': { IPAddress: '172.19.0.8' } } },
  }] };
  const service = createWorkspaceSyncPreviewService();
  const result = await service.list('1');
  assert.equal(result.previews[0]?.bindingEpoch, '');
  assert.equal(result.previews[0]?.remotePort, 0);
  assert.equal(result.previews[0]?.remoteHost, '172.19.0.8');
  assert.deepEqual(await service.remove('1', ownedId), { ok: true });
  assert.equal(invocation.containers.size, 0);
});
