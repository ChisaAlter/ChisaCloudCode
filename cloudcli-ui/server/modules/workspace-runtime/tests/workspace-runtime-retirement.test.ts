import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

const root = path.join(os.tmpdir(),'runtime-retirement-selector'); const userId = '17';
const owner = createHash('sha256').update(root+'\0'+userId).digest('hex').slice(0,24);
let failure: Error | undefined; let admissions = 0; let mutations = 0;
mock.module('../workspace-runtime-broker.service.js',{ namedExports: {
  getWorkspaceBrokerAdmission: async (input: { userId: string; root: string }) => {
    admissions++; assert.deepEqual(input,{ userId,root });
    return { async retireLegacy() { mutations++; if (failure) throw failure; return { retired: true,resourceId: 'a'.repeat(64) }; } };
  },
} });
const { retireWorkspaceSyncTransport } = await import('../workspace-runtime-retirement.service.js');
test.beforeEach(() => { failure = undefined; admissions = mutations = 0; });
test('retirement delegates exact enrolled resource management to broker with trusted identity',async () => { await retireWorkspaceSyncTransport(root,owner,userId); assert.equal(admissions,1); assert.equal(mutations,1); });
test('missing/foreign user or root owner rejects before admission',async () => {
  await assert.rejects(retireWorkspaceSyncTransport(root,owner),{ code: 'WORKSPACE_RUNTIME_MISMATCH' });
  await assert.rejects(retireWorkspaceSyncTransport(root,'foreign',userId),{ code: 'WORKSPACE_RUNTIME_MISMATCH' }); assert.equal(admissions,0);
});
test('fresh installation relies on broker manifest result, never an API error-string bypass',async () => { failure = new Error('BROKER_LEGACY_NOT_ENROLLED'); await assert.rejects(retireWorkspaceSyncTransport(root,owner,userId),/BROKER_LEGACY_NOT_ENROLLED/); assert.equal(mutations,1); });
for (const code of ['BROKER_LEGACY_MISMATCH','BROKER_LEGACY_NOT_STOPPED','BROKER_DOCKER_TIMEOUT','BROKER_UNAUTHORIZED']) test('retirement blocks on '+code,async () => { failure = new Error(code); await assert.rejects(retireWorkspaceSyncTransport(root,owner,userId),new RegExp(code)); });
