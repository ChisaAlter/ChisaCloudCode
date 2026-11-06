import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir,mkdtemp,rename,rm,writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { getWorkspaceBrokerAdmission } from '../workspace-runtime-broker.service.js';

const oldConfig=process.env.CHISA_WORKSPACE_BROKER_CLIENT_CONFIG;
test.after(()=>{if(oldConfig===undefined)delete process.env.CHISA_WORKSPACE_BROKER_CLIENT_CONFIG;else process.env.CHISA_WORKSPACE_BROKER_CLIENT_CONFIG=oldConfig;});
test('normal configured authority renews independent grant per action and never signs in API',async t=>{
  const base=await mkdtemp(path.join(os.tmpdir(),'chisa-admission-'));const root=path.join(base,'project');await mkdir(root);const socketPath=process.platform==='win32'?'\\\\.\\pipe\\chisa-broker-issuer-'+path.basename(base):path.join(base,'issuer.sock');
  const brokerSocket=process.platform==='win32'?'\\\\.\\pipe\\chisa-broker-api-'+path.basename(base):path.join(base,'broker.sock');let calls=0;let deny=false;
  const server=createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const body=JSON.parse(Buffer.concat(chunks).toString());calls++;assert.equal(body.ticket,'a'.repeat(64));assert.equal(body.userId,'17');assert.equal(body.root,root);assert.equal(body.ownerId,undefined);assert.equal(req.url,'/v1/grant');res.writeHead(deny?403:200,{'Content-Type':'application/json'});res.end(JSON.stringify(deny?{error:'ISSUER_DENIED'}:{proof:'independently-signed-'+calls,expiresAt:Date.now()+120000,workspaceId:'workspace',generation:'generation',leaseId:'lease',bindingEpoch:'epoch',sessionId:'session',profileId:'worker'}));});
  await new Promise<void>(resolve=>server.listen(socketPath,resolve));
  t.after(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));assert.equal(path.dirname(base),os.tmpdir());await rm(base,{recursive:true,force:true});});
  const filename=path.join(base,'client.json');await writeFile(filename,JSON.stringify({version:1,brokerSocketPath:brokerSocket,issuerSocketPath:socketPath,accounts:[{userId:'17',accountRoot:base,maintenanceWorkspaceId:'workspace',workspaces:[{root,workspaceId:'workspace',generation:'generation',profileId:'worker',ticket:'a'.repeat(64)}]}]}),{mode:0o600});process.env.CHISA_WORKSPACE_BROKER_CLIENT_CONFIG=filename;
  const admission=await getWorkspaceBrokerAdmission({userId:'17',root,leaseId:'lease',bindingEpoch:'epoch'});assert.equal(admission.leaseId,'lease');const first=await admission.proof('run');const second=await admission.proof('run');assert.notEqual(first,second);assert.equal(calls,3);
  deny=true;await assert.rejects(admission.proof('cancel'),{code:'WORKSPACE_FORBIDDEN'});
  await assert.rejects(getWorkspaceBrokerAdmission({userId:'18',root}),{code:'WORKSPACE_FORBIDDEN'});
});
test('no trusted configuration never falls back to Docker or a signing secret',async()=>{delete process.env.CHISA_WORKSPACE_BROKER_CLIENT_CONFIG;await assert.rejects(getWorkspaceBrokerAdmission({userId:'17',root:os.tmpdir()}),{code:'WORKSPACE_BROKER_UNAVAILABLE'});});
