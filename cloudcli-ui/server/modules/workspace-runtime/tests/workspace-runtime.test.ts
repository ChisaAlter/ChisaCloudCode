import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

const fixture = await mkdtemp(path.join(os.tmpdir(),'chisa-runtime-broker-'));
const home = path.join(fixture,'home'); await mkdir(home);
const originalRoot = process.env.WORKSPACES_ROOT;
let root = ''; let authorized = true; let networkFailure = false; let retirementFailure = false; let issuerRequests = 0;
const calls: string[] = [];
mock.module('node:os',{ defaultExport: { ...os,homedir: () => home },namedExports: { ...os,homedir: () => home } });
mock.module('../workspace-runtime-broker.service.js',{ namedExports: {
  getWorkspaceBrokerAdmission: async (input: { userId: string; root: string }) => {
    issuerRequests++;
    if (!authorized || input.userId !== '17' || input.root !== root) throw Object.assign(new Error('authority denied'),{ code: 'WORKSPACE_FORBIDDEN' });
    return { async network() { calls.push('network'); if (networkFailure) throw new Error('broker daemon unavailable'); return { networkId: 'a'.repeat(64) }; },
      async retireLegacy() { calls.push('retire'); if (retirementFailure) throw new Error('legacy transport mismatch'); return { retired: true,resourceId: 'b'.repeat(64) }; } };
  },
} });
const { createWorkspaceRuntimeService,getWorkspaceRuntimeIdentity } = await import('../workspace-runtime.service.js');
const { getWorkspaceSyncNetwork } = await import('@/shared/index.js');
test.beforeEach(async () => { root = await mkdtemp(path.join(fixture,'account-')); process.env.WORKSPACES_ROOT = root; authorized = true; networkFailure = retirementFailure = false; issuerRequests = 0; calls.length = 0; });
test.after(async () => { if (originalRoot === undefined) delete process.env.WORKSPACES_ROOT; else process.env.WORKSPACES_ROOT = originalRoot; assert.equal(path.dirname(fixture),os.tmpdir()); await rm(fixture,{ recursive: true,force: true }); });

test('configured authority restores actual account catalog through broker network/retirement only',async () => {
  const result = await createWorkspaceRuntimeService().restore('17'); const owner = createHash('sha256').update(root+'\0'+'17').digest('hex').slice(0,24);
  assert.deepEqual(result,{ root,owner,network: 'a'.repeat(64) }); assert.deepEqual(calls,['retire','network']);
  assert.equal(getWorkspaceRuntimeIdentity(path.join(root,'project'))!.userId,'17'); assert.equal(getWorkspaceSyncNetwork(path.join(root,'project')),result.network);
  const file = path.join(home,'.chisa-workspace-runtime',createHash('sha256').update(root).digest('hex').slice(0,24)+'.json');
  assert.deepEqual(JSON.parse(await readFile(file,'utf8')),{ version: 1,root,userId: '17',owner });
  await createWorkspaceRuntimeService().restore('17'); assert.deepEqual(calls,['retire','network','retire','network']); assert.ok(issuerRequests >= 4);
});

test('missing trusted authority fails closed before a persistent account claim or network',async () => {
  authorized = false; await assert.rejects(createWorkspaceRuntimeService().restore('17'),/authority denied/); assert.deepEqual(calls,[]); assert.equal(getWorkspaceRuntimeIdentity(root),undefined);
  const file = path.join(home,'.chisa-workspace-runtime',createHash('sha256').update(root).digest('hex').slice(0,24)+'.json');
  await assert.rejects(readFile(file),{ code: 'ENOENT' });
});

test('foreign user cannot reuse catalog admission or persistent identity',async () => {
  await createWorkspaceRuntimeService().restore('17'); const count = calls.length;
  await assert.rejects(createWorkspaceRuntimeService().restore('18'),/authority denied/); assert.equal(calls.length,count);
});

test('daemon or legacy retirement failures revoke runtime admission and retry safely',async () => {
  const service = createWorkspaceRuntimeService(); await service.restore('17');
  retirementFailure = true; await assert.rejects(service.restore('17'),/legacy transport mismatch/); assert.equal(getWorkspaceRuntimeIdentity(root),undefined);
  retirementFailure = false; await service.restore('17'); networkFailure = true;
  await assert.rejects(service.restore('17'),/broker daemon unavailable/); assert.equal(getWorkspaceRuntimeIdentity(root),undefined);
  networkFailure = false; assert.equal((await service.restore('17')).network,'a'.repeat(64));
});

test('malformed saved owner identity is never silently replaced by broker success',async () => {
  await createWorkspaceRuntimeService().restore('17');
  const file = path.join(home,'.chisa-workspace-runtime',createHash('sha256').update(root).digest('hex').slice(0,24)+'.json'); await writeFile(file,'{broken');
  const before = calls.length; await assert.rejects(createWorkspaceRuntimeService().restore('17'),{ code: 'WORKSPACE_RUNTIME_MISMATCH' }); assert.equal(calls.length,before); assert.equal(await readFile(file,'utf8'),'{broken');
});
