import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { mkdir,mkdtemp,rm,writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AddressInfo } from 'node:net';

import express from 'express';

// Runtime consumes only the server-captured closure. This test uses actual public
// login/logout routes and the persistent auth database rather than a broker close
// or a mutable boolean as a substitute for authentication-session revocation.
test('real HTTP logout revokes preview streams and independent renewal without reviving the old capability on login',async()=>{
  const base=await mkdtemp(path.join(os.tmpdir(),'chisa-preview-login-'));const database=path.join(base,'account.sqlite');await writeFile(database,'');await mkdir(path.join(base,'home'));
  const previousDatabase=process.env.DATABASE_PATH;const previousPlatform=process.env.VITE_IS_PLATFORM;process.env.DATABASE_PATH=database;process.env.VITE_IS_PLATFORM='false';
  const { initializeDatabase,closeConnection,userDb }=await import('@/modules/database/index.js');await initializeDatabase();
  const { authRoutes,verifyAuthToken,isAuthSessionActive }=await import('@/modules/auth/index.js');
  const { createWorkspaceRuntimePreviewAccess,retainWorkspaceRuntimePreviewConnection,sweepWorkspaceRuntimePreviewAccess,getWorkspaceRuntimePreviewUrl,revokeWorkspaceRuntimePreviewAccess }=await import('../workspace-runtime-preview-access.service.js');
  const app=express();app.use(express.json());app.use('/api/auth',authRoutes);const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  const origin='http://127.0.0.1:'+(server.address() as AddressInfo).port;
  const request=(endpoint:string,body?:unknown,token?:string)=>fetch(origin+'/api/auth/'+endpoint,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body??{})});
  const loginSecret='preview-fixture-login-123';const require=createRequire(import.meta.url);const bcrypt=require('bcrypt') as {hash(value:string,cost:number):Promise<string>};
  let streamClosed=0;let signerCloses=0;let capturedProof:ReturnType<typeof verifyAuthToken>['session']|undefined;
  try{
    userDb.createUser('preview-login-fixture',await bcrypt.hash(loginSecret,4));
    const login=await request('login',{username:'preview-login-fixture',password:loginSecret});assert.equal(login.status,200);const {token}=await login.json() as {token:string};capturedProof=verifyAuthToken(token).session;const proof={...capturedProof};
    const assertAuthActive=()=>{if(!isAuthSessionActive(proof.id,proof.userId,proof.version))throw new Error('captured login revoked');};
    const url=createWorkspaceRuntimePreviewAccess(String(proof.userId),'preview-auth-fixture',base,'epoch',3000,'network',assertAuthActive,async()=>{signerCloses++;});
    retainWorkspaceRuntimePreviewConnection(url.split('/').at(-2)!,()=>streamClosed++);assert.ok(getWorkspaceRuntimePreviewUrl('preview-auth-fixture'));
    const logout=await request('logout',undefined,token);assert.equal(logout.status,200);assert.equal(isAuthSessionActive(proof.id,proof.userId,proof.version),false);
    await sweepWorkspaceRuntimePreviewAccess();await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(streamClosed,1);assert.equal(signerCloses,1);assert.equal(getWorkspaceRuntimePreviewUrl('preview-auth-fixture'),undefined);
    const next=await request('login',{username:'preview-login-fixture',password:loginSecret});assert.equal(next.status,200);const nextToken=(await next.json() as {token:string}).token;const nextProof=verifyAuthToken(nextToken).session;assert.notEqual(nextProof.id,proof.id);assert.equal(isAuthSessionActive(nextProof.id,nextProof.userId,nextProof.version),true);assert.equal(getWorkspaceRuntimePreviewUrl('preview-auth-fixture'),undefined);
  }finally{
    revokeWorkspaceRuntimePreviewAccess('preview-auth-fixture');await sweepWorkspaceRuntimePreviewAccess();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));closeConnection();if(previousDatabase===undefined)delete process.env.DATABASE_PATH;else process.env.DATABASE_PATH=previousDatabase;if(previousPlatform===undefined)delete process.env.VITE_IS_PLATFORM;else process.env.VITE_IS_PLATFORM=previousPlatform;assert.equal(path.dirname(base),os.tmpdir());await rm(base,{recursive:true,force:true});
  }
});
