import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { WorkspaceBrokerEngine } from '@/shared/index.js';

import { createWorkspaceBrokerDockerAdapter } from '../index.js';

const linux = process.platform === 'linux';

test('Docker adapter rejects non-Linux, TCP sockets, path traversal and unbounded timeout',() => {
  if (!linux) assert.throws(() => createWorkspaceBrokerDockerAdapter({ socketPath: '/var/run/docker.sock' }),/LINUX_SOCKET/);
  assert.throws(() => createWorkspaceBrokerDockerAdapter({ socketPath: 'tcp://127.0.0.1:2375' }),/LINUX_SOCKET/);
  assert.throws(() => createWorkspaceBrokerDockerAdapter({ socketPath: '/tmp/../docker.sock' }),/LINUX_SOCKET/);
  if (linux) assert.throws(() => createWorkspaceBrokerDockerAdapter({ socketPath: '/tmp/broker.sock',timeoutMs: Infinity }),/TIMEOUT/);
});

test('Linux mock daemon receives fixed hardened create/exec/network/retirement requests and exact identity inspect', { skip: !linux },async t => {
  const base = await mkdtemp(path.join(os.tmpdir(),'chisa-broker-docker-test-'));
  const socketPath = path.join(base,'engine.sock'); const resourceId = 'a'.repeat(64); const networkId = 'b'.repeat(64); const execId = 'c'.repeat(64);
  const calls: Array<{ method: string; url: string; body: any }> = [];
  let mode: 'ok' | 'offline' | 'notfound' | 'foreignimage' | 'large' = 'ok';
  let container: any;
  const server = createServer(async (request,response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    calls.push({ method: request.method!,url: request.url!,body });
    const reply = (status: number, value: unknown) => { response.writeHead(status,{ 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
    if (mode === 'offline') { reply(500,{ message: 'daemon failed' }); return; }
    if (mode === 'notfound') { reply(404,{ message: 'No such object' }); return; }
    if (mode === 'large') { response.end(Buffer.alloc(3*1024*1024)); return; }
    if (request.url!.startsWith('/v1.45/containers/create')) {
      container = { Id: resourceId, Name: '/' + new URL('http://local' + request.url).searchParams.get('name'), Image: 'sha256:' + 'd'.repeat(64),
        Config: { Image: body.Image,User: body.User,Labels: body.Labels }, State: { Running: true,Restarting: false,ExitCode: 0 }, HostConfig: body.HostConfig,
        Mounts: body.HostConfig.Mounts.map((mount: any) => ({ Type: mount.Type,Source: mount.Source,Destination: mount.Target,RW: !mount.ReadOnly })),
        NetworkSettings: { Networks: { account: { NetworkID: networkId,IPAddress: '172.30.0.2' } } } };
      reply(201,{ Id: resourceId }); return;
    }
    if (request.url === '/v1.45/containers/' + resourceId + '/json') { reply(200,container); return; }
    if (request.url!.startsWith('/v1.45/images/')) { reply(200,{ Id: container.Image,RepoDigests: mode === 'foreignimage' ? [] : [container.Config.Image] }); return; }
    if (request.url!.startsWith('/v1.45/containers/json')) { reply(200,[{ Id: resourceId }]); return; }
    if (request.url === '/v1.45/containers/' + resourceId + '/exec') { reply(201,{ Id: execId }); return; }
    if (request.url === '/v1.45/exec/' + execId + '/json') { reply(200,{ Running: false,ExitCode: 7 }); return; }
    if (request.url === '/v1.45/networks/create') { reply(201,{ Id: networkId }); return; }
    if (request.url === '/v1.45/networks/' + networkId) { reply(200,{ Id: networkId,Name: 'chisa-broker-account',Driver: 'bridge',Scope: 'local',Internal: true,Labels: { owner: 'a' },Options: {} }); return; }
    if (request.url!.includes('/logs?')) { response.writeHead(200,{ 'Content-Type': 'application/vnd.docker.multiplexed-stream' }); response.end(Buffer.from([1,0,0,0,0,0,0,1,120])); return; }
    response.writeHead(204); response.end();
  });
  const upgraded = new Set<import('node:stream').Duplex>();
  server.on('upgrade',(request,socket) => {
    calls.push({ method: request.method!,url: request.url!,body: undefined }); upgraded.add(socket); socket.on('close',() => upgraded.delete(socket));
    socket.write('HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
    socket.write(Buffer.from([1,0,0,0,0,0,0,1,120]));
  });
  await new Promise<void>((resolve,reject) => { server.once('error',reject); server.listen(socketPath,resolve); });
  t.after(async () => {
    for (const socket of upgraded) socket.destroy();
    await new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve()));
    assert.equal(path.dirname(base),os.tmpdir()); assert.ok(path.basename(base).startsWith('chisa-broker-docker-test-')); await rm(base,{ recursive: true,force: true });
  });
  const adapter = createWorkspaceBrokerDockerAdapter({ socketPath });
  const input: Parameters<WorkspaceBrokerEngine['createSandbox']>[0] = {
    name: 'chisa-broker-test',imageDigest: 'repo/workspace@sha256:' + 'e'.repeat(64),labels: { owner: 'a' },networkId,
    uid: 1000,gid: 1000,memoryBytes: 1024**3,nanoCpus: 1e9,pidsLimit: 64,tmpfsBytes: 64*1024**2,
    mounts: [{ source: '/controlled/owner/workspace',target: '/workspace',readOnly: false }],command: ['sh','-c','echo ok'],cwd: '/workspace',environment: { HOME: '/home/chisa' },readOnlyWorkspace: false,
  };
  assert.equal(await adapter.createSandbox(input),resourceId);
  const create = calls[0].body; assert.equal(create.Image,input.imageDigest); assert.equal(create.User,'1000:1000'); assert.deepEqual(create.Entrypoint,[]);
  assert.equal(create.HostConfig.Privileged,false); assert.deepEqual(create.HostConfig.CapDrop,['ALL']); assert.deepEqual(create.HostConfig.GroupAdd,[]); assert.deepEqual(create.HostConfig.Devices,[]);
  assert.deepEqual(create.HostConfig.SecurityOpt,['no-new-privileges']); assert.equal(create.HostConfig.ReadonlyRootfs,true); assert.equal(create.HostConfig.NetworkMode,networkId);
  assert.equal(create.HostConfig.MemorySwap,input.memoryBytes); assert.equal(create.HostConfig.AutoRemove,false); assert.equal(create.HostConfig.RestartPolicy.Name,'no');
  assert.equal(create.HostConfig.PidMode,''); assert.equal(create.HostConfig.IpcMode,'private'); assert.equal(create.HostConfig.CgroupnsMode,'private');
  assert.equal((await adapter.inspectContainer(resourceId))!.imageDigest,input.imageDigest);
  mode = 'foreignimage'; assert.equal((await adapter.inspectContainer(resourceId))!.imageDigest,'unverified'); mode = 'ok';
  container.HostConfig.GroupAdd=['10105'];assert.equal((await adapter.inspectContainer(resourceId))!.privileged,true);container.HostConfig.GroupAdd=[];assert.equal((await adapter.inspectContainer(resourceId))!.privileged,false);
  await adapter.startContainer(resourceId);
  const attached = await adapter.attachContainer(resourceId); const first = await attached[Symbol.asyncIterator]().next(); assert.equal(first.value.length,9); attached.destroy();
  assert.deepEqual(await adapter.listWorkspaceContainers('f'.repeat(64)),[resourceId]);
  assert.equal(await adapter.createExec(resourceId,{ command: ['true'],cwd: '/workspace',environment: {},uid: '1000:1000' }),execId);
  const exec = await adapter.startExec(execId); exec.destroy(); assert.deepEqual(await adapter.inspectExec(execId),{ running: false,exitCode: 7 });
  assert.equal((await adapter.logs(resourceId,1024)).length,9);
  assert.equal(await adapter.createNetwork({ name: 'chisa-broker-account',labels: { owner: 'a' },internal: true }),networkId);
  assert.equal((await adapter.inspectNetwork(networkId))!.internal,true);
  await adapter.retireContainer(resourceId); await adapter.removeContainer(resourceId);
  assert.ok(calls.some(call => call.method === 'POST' && call.url === '/v1.45/containers/' + resourceId + '/update' && call.body.RestartPolicy.Name === 'no'));
  assert.ok(calls.some(call => call.method === 'DELETE' && call.url.includes('force=true&v=false')));
  const before = calls.length; await assert.rejects(adapter.removeContainer('foreign-name'),/BROKER_DOCKER_ID/); assert.equal(calls.length,before);
  mode = 'offline'; await assert.rejects(adapter.inspectContainer(resourceId),/HTTP_500/);
  mode = 'notfound'; assert.equal(await adapter.inspectContainer(resourceId),null);
  mode = 'large'; await assert.rejects(adapter.inspectContainer(resourceId),{ message: /^BROKER_DOCKER_RESPONSE_(?:LIMIT|ABORTED)$/ });
});

test('Linux attach stdin EOF preserves delayed daemon output until readable EOF',{skip:!linux},async t=>{
  const base=await mkdtemp(path.join(os.tmpdir(),'chisa-broker-docker-eof-'));const socketPath=path.join(base,'engine.sock');const sockets=new Set<import('node:net').Socket>();let received='';
  const server=createServer();
  server.on('upgrade',(_request,duplex)=>{
    const socket=duplex as import('node:net').Socket;socket.allowHalfOpen=true;sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});
    socket.write('HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
    socket.on('data',chunk=>{received+=chunk.toString('utf8');});
    socket.once('end',()=>{setTimeout(()=>{const body=Buffer.from('reply after stdin EOF');const header=Buffer.alloc(8);header[0]=1;header.writeUInt32BE(body.length,4);socket.end(Buffer.concat([header,body]));},25);});
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve);});t.after(async()=>{for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));assert.equal(path.dirname(base),os.tmpdir());await rm(base,{recursive:true,force:true});});
  const adapter=createWorkspaceBrokerDockerAdapter({socketPath});const attached=await adapter.attachContainer('a'.repeat(64));assert.equal((attached as import('node:net').Socket).allowHalfOpen,true);
  const timeout=setTimeout(()=>attached.destroy(new Error('delayed EOF reply timed out')),3000);t.after(()=>clearTimeout(timeout));const chunks:Buffer[]=[];
  attached.end('request bytes');for await(const chunk of attached)chunks.push(Buffer.from(chunk));assert.equal(received,'request bytes');const output=Buffer.concat(chunks);assert.equal(output.subarray(8).toString(),'reply after stdin EOF');assert.equal(output.readUInt32BE(4),output.length-8);
});
