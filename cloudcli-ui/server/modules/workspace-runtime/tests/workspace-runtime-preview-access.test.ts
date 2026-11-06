import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

const root = '/workspaces/project'; const epoch = 'epoch'; const id = 'chisa-account-preview-'+ 'b'.repeat(20)+'-'+ 'c'.repeat(16);
const identity = { root: '/workspaces',owner: 'd'.repeat(24),userId: '17',network: 'a'.repeat(64) };
let registered = true; let runtimeFailure = false; let authorityFailure = false; let inspected = 0;let loginActive=true;let closeAttempts=0;let closeUnavailable=false;
let entry: Record<string,unknown>; let target: { host: string; port: number; resourceId: string; ticket:string };
mock.module('../workspace-runtime.service.js',{ namedExports: {
  getWorkspaceRuntimeIdentity: () => registered ? identity : undefined,
  createWorkspaceRuntimeService: () => ({ async restore() { if (runtimeFailure) throw new Error('foreign network'); return identity; } }),
} });
mock.module('../workspace-runtime-preview-inventory.repository.js',{ namedExports: {
  createWorkspacePreviewInventory: async () => ({ read: async () => entry }),
} });
mock.module('../workspace-runtime-broker.service.js',{ namedExports: {
  getWorkspaceBrokerAdmission: async (input: Record<string,unknown>) => {
    if (authorityFailure) throw new Error('authority denied'); assert.deepEqual(input,{ userId: '17',root,leaseId: entry.legacyReservationId,brokerLeaseId:'lease',sessionId:'session',bindingEpoch: epoch });
    return { workspaceId: 'workspace',generation: 'generation',leaseId:'lease',legacyReservationId:'legacy',async previewGateway() { inspected++; return target; } };
  },
} });
const { createWorkspaceRuntimePreviewAccess,getWorkspaceRuntimePreviewUrl,resolveWorkspaceRuntimePreviewAccess,retainWorkspaceRuntimePreviewConnection,revokeWorkspaceRuntimePreviewAccess,sweepWorkspaceRuntimePreviewAccess } = await import('../workspace-runtime-preview-access.service.js');
let token = '';
const settle=()=>new Promise<void>(resolve=>setImmediate(resolve));
test.beforeEach(() => {
  registered = loginActive = true; runtimeFailure = authorityFailure = closeUnavailable = false; inspected = closeAttempts = 0;
  entry = { root,bindingEpoch: epoch,port: 3000,leaseId: 'lease',legacyReservationId:'legacy',sessionId:'session',workspaceId: 'workspace',generation: 'generation',profileId: 'preview',resourceId: 'f'.repeat(64) };
  target = { host: '172.18.0.1',port: 4010,resourceId: 'f'.repeat(64),ticket:'independent-ticket' };
  entry.base=createWorkspaceRuntimePreviewAccess('17',id,root,epoch,3000,identity.network,()=>{if(!loginActive)throw new Error('login revoked');},async()=>{closeAttempts++;if(closeUnavailable)throw new Error('signer unavailable');});
  token = String(entry.base).split('/').at(-2)!;
});
test.afterEach(async () => {closeUnavailable=false;revokeWorkspaceRuntimePreviewAccess(id);await sweepWorkspaceRuntimePreviewAccess();await settle();});
test('browser HTTP/WS capability resolves only to independently selected account gateway',async () => { assert.match(token,/^[a-f0-9]{64}$/); assert.deepEqual(await resolveWorkspaceRuntimePreviewAccess(token),{ host:'172.18.0.1',port:4010,ticket:'independent-ticket',base:getWorkspaceRuntimePreviewUrl(id) }); assert.equal(inspected,1); });
for (const field of ['root','bindingEpoch','port','workspaceId','generation','base','legacyReservationId'] as const) test('inventory drift rejects '+field,async () => { entry[field] = field === 'port' ? 4000 : 'foreign'; await assert.rejects(resolveWorkspaceRuntimePreviewAccess(token),{ code:'PREVIEW_NOT_FOUND' }); assert.equal(inspected,0); });
for (const host of ['::1','not-an-ip']) test('gateway rejects invalid address '+host,async () => { target.host = host; await assert.rejects(resolveWorkspaceRuntimePreviewAccess(token),{ code:'PREVIEW_NOT_FOUND' }); });
test('different immutable resource fails closed',async () => { target.resourceId = 'e'.repeat(64); await assert.rejects(resolveWorkspaceRuntimePreviewAccess(token),{ code:'PREVIEW_NOT_FOUND' }); });
test('missing runtime/issuer identity prevents any gateway query',async () => { registered=false;await assert.rejects(resolveWorkspaceRuntimePreviewAccess(token),{ code:'PREVIEW_NOT_FOUND' });registered=true;runtimeFailure=true;await assert.rejects(resolveWorkspaceRuntimePreviewAccess(token),/foreign network/);runtimeFailure=false;authorityFailure=true;await assert.rejects(resolveWorkspaceRuntimePreviewAccess(token),/authority denied/);assert.equal(inspected,0); });
test('revocation closes retained HTTP/WS streams and all future access',async () => { let count=0;const release=retainWorkspaceRuntimePreviewConnection(token,()=>count++);revokeWorkspaceRuntimePreviewAccess(id);assert.equal(count,1);await assert.rejects(resolveWorkspaceRuntimePreviewAccess(token),{code:'PREVIEW_NOT_FOUND'});release(); });
test('captured login revocation closes retained streams and retries independent close without releasing the writer',async()=>{
  let closed=0;retainWorkspaceRuntimePreviewConnection(token,()=>closed++);closeUnavailable=true;loginActive=false;
  await sweepWorkspaceRuntimePreviewAccess();await settle();assert.equal(closed,1);assert.equal(closeAttempts,1);assert.equal(getWorkspaceRuntimePreviewUrl(id),undefined);await assert.rejects(resolveWorkspaceRuntimePreviewAccess(token),{code:'PREVIEW_NOT_FOUND'});
  closeUnavailable=false;await sweepWorkspaceRuntimePreviewAccess();await settle();assert.equal(closeAttempts,2);
  loginActive=true;await assert.rejects(resolveWorkspaceRuntimePreviewAccess(token),{code:'PREVIEW_NOT_FOUND'},'a fresh login cannot restore an old capability');
});
test('missing captured login proof prevents access allocation',()=>{assert.throws(()=>createWorkspaceRuntimePreviewAccess('17','missing',root,epoch,3000,identity.network,undefined as never,async()=>{}),{code:'PREVIEW_AUTH_REQUIRED'});});
test('malformed/unknown capability fails before authority or target',async () => { await assert.rejects(resolveWorkspaceRuntimePreviewAccess('bad'),{code:'PREVIEW_NOT_FOUND'});await assert.rejects(resolveWorkspaceRuntimePreviewAccess('e'.repeat(64)),{code:'PREVIEW_NOT_FOUND'});assert.equal(inspected,0); });
