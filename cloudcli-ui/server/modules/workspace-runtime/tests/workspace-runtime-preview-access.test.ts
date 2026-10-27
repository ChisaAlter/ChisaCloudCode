import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import test, { mock } from 'node:test';
import { promisify } from 'node:util';

const root = '/workspaces/project';
const epoch = 'current-epoch';
const owner = 'b'.repeat(20);
const id = 'chisa-account-preview-' + owner + '-' + 'c'.repeat(16);
const network = 'chisa-workspace-network-' + 'd'.repeat(24);
const identity = { root: '/workspaces', owner: 'd'.repeat(24), userId: '17', network };
let registered = true;
let runtimeFailure = false;
let inspected = 0;
const original = () => ({
  Name: '/' + id, State: { Running: true },
  Config: { Labels: { 'chisa.sync-preview.owner': owner, 'chisa.sync-preview.epoch': epoch, 'chisa.sync-preview.port': '3000', 'chisa.workspace-root': createHash('sha256').update(root).digest('hex') } },
  Mounts: [{ Source: root, Destination: '/workspace', Type: 'bind', RW: true }],
  NetworkSettings: { Networks: { [network]: { IPAddress: '172.18.0.10' } } as Record<string, { IPAddress: string }> },
});
let container = original();
const fakeExec = Object.assign(() => undefined, { [promisify.custom]: async (_command: string, args: string[]) => {
  assert.deepEqual(args, ['inspect', id]); inspected++; return { stdout: JSON.stringify([container]), stderr: '' };
} });
mock.module('node:child_process', { namedExports: { ...childProcess, execFile: fakeExec } });
mock.module('../workspace-runtime.service.js', { namedExports: {
  getWorkspaceRuntimeIdentity: () => registered ? identity : undefined,
  createWorkspaceRuntimeService: () => ({ restore: async (userId: string) => {
    assert.equal(userId, '17'); if (runtimeFailure) throw new Error('foreign network'); return identity;
  } }),
} });
const { createWorkspaceRuntimePreviewAccess, getWorkspaceRuntimePreviewUrl, resolveWorkspaceRuntimePreviewAccess,
  retainWorkspaceRuntimePreviewConnection, revokeWorkspaceRuntimePreviewAccess } = await import('../workspace-runtime-preview-access.service.js');
let token = '';
test.beforeEach(() => {
  registered = true; runtimeFailure = false; inspected = 0; container = original();
  const url = createWorkspaceRuntimePreviewAccess('17', id, root, epoch, 3000, network);
  token = url.split('/').at(-2)!;
});
test.afterEach(() => revokeWorkspaceRuntimePreviewAccess(id));

test('browser capability resolves only an exact running preview on the verified account network', async () => {
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.equal(getWorkspaceRuntimePreviewUrl(id), '/api/workspace-runtime/preview/' + token + '/');
  assert.deepEqual(await resolveWorkspaceRuntimePreviewAccess(token), { host: '172.18.0.10', port: 3000, base: '/api/workspace-runtime/preview/' + token + '/' });
  assert.equal(inspected, 1);
});

for (const mismatch of ['name', 'owner', 'epoch', 'port', 'root-label', 'root-mount', 'mount-type', 'mount-ro', 'stopped', 'other-network', 'public-address'] as const) {
  test('browser access rejects changed ' + mismatch, async () => {
    switch (mismatch) {
      case 'name': container.Name += '-foreign'; break;
      case 'owner': container.Config.Labels['chisa.sync-preview.owner'] = 'other'; break;
      case 'epoch': container.Config.Labels['chisa.sync-preview.epoch'] = 'stale'; break;
      case 'port': container.Config.Labels['chisa.sync-preview.port'] = '4000'; break;
      case 'root-label': container.Config.Labels['chisa.workspace-root'] = 'other'; break;
      case 'root-mount': container.Mounts[0].Source = '/workspaces/other'; break;
      case 'mount-type': container.Mounts[0].Type = 'volume'; break;
      case 'mount-ro': container.Mounts[0].RW = false; break;
      case 'stopped': container.State.Running = false; break;
      case 'other-network': container.NetworkSettings.Networks = { unrelated: { IPAddress: '172.18.0.10' } }; break;
      case 'public-address': container.NetworkSettings.Networks[network].IPAddress = '198.51.100.1'; break;
    }
    await assert.rejects(resolveWorkspaceRuntimePreviewAccess(token), { code: 'PREVIEW_NOT_FOUND' });
  });
}

test('lost runtime identity or ownership verification prevents inspecting any preview', async () => {
  registered = false;
  await assert.rejects(resolveWorkspaceRuntimePreviewAccess(token), { code: 'PREVIEW_NOT_FOUND' });
  assert.equal(inspected, 0);
  registered = true; runtimeFailure = true;
  await assert.rejects(resolveWorkspaceRuntimePreviewAccess(token), /foreign network/);
  assert.equal(inspected, 0);
});

test('revocation closes live streams and removes both existing and future access', async () => {
  let closed = 0;
  const release = retainWorkspaceRuntimePreviewConnection(token, () => { closed++; });
  revokeWorkspaceRuntimePreviewAccess(id);
  assert.equal(closed, 1);
  assert.equal(getWorkspaceRuntimePreviewUrl(id), undefined);
  await assert.rejects(resolveWorkspaceRuntimePreviewAccess(token), { code: 'PREVIEW_NOT_FOUND' });
  assert.throws(() => retainWorkspaceRuntimePreviewConnection(token, () => {}), { code: 'PREVIEW_NOT_FOUND' });
  release(); revokeWorkspaceRuntimePreviewAccess(id);
  assert.equal(closed, 1);
});

test('malformed and unknown capabilities fail before Docker', async () => {
  await assert.rejects(resolveWorkspaceRuntimePreviewAccess('bad'), { code: 'PREVIEW_NOT_FOUND' });
  await assert.rejects(resolveWorkspaceRuntimePreviewAccess('e'.repeat(64)), { code: 'PREVIEW_NOT_FOUND' });
  assert.equal(inspected, 0);
});
