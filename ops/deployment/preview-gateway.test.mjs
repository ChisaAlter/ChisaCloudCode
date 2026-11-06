import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';
import { authorizeTicket, createGateway, forwardedHeaders, validateGatewayConfig } from './preview-gateway.mjs';

const keys=generateKeyPairSync('ed25519');
const config={ version:1,accountId:'account_a',audience:'preview',keyId:'key_a',publicKeyFile:'/etc/chisa-client/preview-public.pem',brokerSocket:'/run/chisa-broker/broker.sock',listenHost:'0.0.0.0',listenPort:8792,allowedClientAddress:'127.0.0.1',accountSubnet:'172.30.241.0/24',maxConnections:16,maxRequestBytes:1024,maxSeconds:20 };
const base='/api/workspace-runtime/preview/'+'1'.repeat(64)+'/';
function claims(changes={}) { return { version:1,accountId:config.accountId,audience:config.audience,keyId:config.keyId,workspaceId:'workspace',generation:'generation',leaseId:'lease',operationId:'operation',resourceId:'a'.repeat(64),host:'172.30.241.10',port:3000,base,issuedAt:Date.now()-1000,expiresAt:Date.now()+60000,brokerProof:'independent-broker-proof-not-an-api-cleanup-flag',...changes }; }
function ticket(value,privateKey=keys.privateKey) { const payload=Buffer.from(JSON.stringify(value)); return payload.toString('base64url')+'.'+sign(null,payload,privateKey).toString('base64url'); }
const listen=server=>new Promise((resolve,reject)=>{ server.once('error',reject); server.listen(0,'127.0.0.1',()=>resolve(server.address().port)); });
const close=server=>new Promise(resolve=>server.close(resolve));
function request(port,path=base,headers={},body='') { return new Promise((resolve,reject)=> { const req=http.request({host:'127.0.0.1',port,path,method:body?'POST':'GET',headers,agent:false},res=> { const chunks=[]; res.on('data',chunk=>chunks.push(chunk)); res.once('error',reject); res.once('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()})); }); req.once('error',reject); req.end(body); }); }
async function fixture(callback,{inspect,configuration={}}={}) {
  const seen=[]; const upstream=http.createServer((req,res)=> { seen.push({url:req.url,headers:req.headers}); const parts=[]; req.on('data',part=>parts.push(part)); req.once('end',()=> { if (req.url.endsWith('/redirect')) { res.writeHead(302,{Location:'http://other-account.invalid/'}); res.end(); return; } res.writeHead(200,{'Content-Type':'text/plain','Set-Cookie':'app=stolen','Service-Worker-Allowed':'/','X-Test':'allowed'}); res.write('first-'); setImmediate(()=>res.end('second:'+Buffer.concat(parts).toString())); }); });
  const upstreamPort=await listen(upstream); let inspections=0;
  const gateway=await createGateway({...config,...configuration},keys.publicKey,{inspect:async value=> { inspections++; if(inspect) return inspect(value,inspections); return {host:value.host,port:value.port,resourceId:value.resourceId}; },connect:options=>http.request({...options,host:'127.0.0.1',port:upstreamPort,agent:false})}); const port=await listen(gateway.server);
  try { await callback({port,seen,get inspections(){return inspections;},upstream,upstreamPort}); } finally { await gateway.close(); await close(upstream); }
}

test('valid account-bound signed preview ticket pins scope, literal upstream and base',()=> {
  validateGatewayConfig(config); const value=claims(); assert.deepEqual(authorizeTicket(config,keys.publicKey,ticket(value),base+'page?q=yes'),value);
  assert.throws(()=>validateGatewayConfig({...config,brokerSocket:'/var/run/docker.sock'})); assert.throws(()=>validateGatewayConfig({...config,allowedClientAddress:'172.30.241.2'}));
});
test('forged expired cross-account replaced host broad path and unknown claim are denied',()=> {
  const bad=[{accountId:'account_b'},{host:'127.0.0.1'},{host:'169.254.169.254'},{host:'172.30.242.2'},{host:'172.30.241.0'},{port:22},{expiresAt:Date.now()-1},{issuedAt:Date.now()+10000},{expiresAt:Date.now()+1000000},{resourceId:'container-name'},{extra:'must-not-be-accepted'}];
  for (const change of bad) assert.throws(()=>authorizeTicket(config,keys.publicKey,ticket(claims(change)),base));
  const foreign=generateKeyPairSync('ed25519'); assert.throws(()=>authorizeTicket(config,keys.publicKey,ticket(claims(),foreign.privateKey),base));
  for (const pathname of ['http://metadata.invalid/','//metadata.invalid/',base+'../escape',base+'%2e%2e/escape',base+'%2Fescape','/_chisa/preview/other/']) assert.throws(()=>authorizeTicket(config,keys.publicKey,ticket(claims()),pathname));
});
test('HTTP SSE-like streaming upload strips all application credentials and leaves only allowed response headers',async()=>fixture(async f=> {
  const result=await request(f.port,base+'stream?x=1',{'x-chisa-preview-ticket':ticket(claims()),Authorization:'Bearer APPSECRET',Cookie:'session=APPSECRET','Proxy-Authorization':'PROXYSECRET',Origin:'https://app.invalid',Forwarded:'for=other','X-Forwarded-For':'198.51.100.10','X-Test':'safe'},'upload-body');
  assert.equal(result.status,200); assert.equal(result.body,'first-second:upload-body'); assert.equal(f.inspections,1); assert.equal(f.seen.length,1);
  for (const name of ['authorization','cookie','proxy-authorization','origin','forwarded','x-forwarded-for','x-chisa-preview-ticket']) assert.equal(f.seen[0].headers[name],undefined,name);
  assert.equal(f.seen[0].headers['x-test'],'safe'); assert.equal(result.headers['set-cookie'],undefined); assert.equal(result.headers['service-worker-allowed'],undefined); assert.equal(result.headers['x-test'],'allowed'); assert.equal(result.headers['cache-control'],'no-store'); assert.match(result.headers['content-security-policy'],/sandbox/);
}));
test('missing authority, cross-account ticket or broker changed resource has no upstream side effect',async()=>fixture(async f=> {
  assert.equal((await request(f.port)).status,403); assert.equal((await request(f.port,base,{'x-chisa-preview-ticket':ticket(claims({accountId:'other'}))})).status,403); assert.equal(f.seen.length,0); assert.equal(f.inspections,0);
}));
test('independent broker denial retains no upstream connection',async()=>fixture(async f=> { assert.equal((await request(f.port,base,{'x-chisa-preview-ticket':ticket(claims())})).status,403); assert.equal(f.seen.length,0); },{inspect:async()=> { throw new Error('daemon unavailable or resource replaced'); }}));
test('external redirects and over-budget upload do not reach another target',async()=>fixture(async f=> {
  assert.equal((await request(f.port,base+'redirect',{'x-chisa-preview-ticket':ticket(claims())})).status,403);
  assert.equal((await request(f.port,base,{'x-chisa-preview-ticket':ticket(claims()),'Content-Length':'2048'},'x'.repeat(2048))).status,403); assert.equal(f.seen.length,1);
}));
test('per-account gateway client source is exact even for a valid signed ticket',async()=>fixture(async f=> { assert.equal((await request(f.port,base,{'x-chisa-preview-ticket':ticket(claims())})).status,403); assert.equal(f.seen.length,0); },{configuration:{allowedClientAddress:'127.0.0.2'}}));
test('websocket upgrade preserves frame bytes but strips application headers',async()=> {
  const upstream=http.createServer(); let receivedHeaders; const peers=new Set();
  upstream.on('upgrade',(req,socket,head)=> { peers.add(socket); socket.once('close',()=>peers.delete(socket)); receivedHeaders=req.headers; socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: test\r\n\r\n'); if(head.length)socket.write(head); socket.on('data',data=>socket.write(data)); }); const upstreamPort=await listen(upstream);
  const gateway=await createGateway(config,keys.publicKey,{inspect:async value=>({host:value.host,port:value.port,resourceId:value.resourceId}),connect:options=>http.request({...options,host:'127.0.0.1',port:upstreamPort})}); const port=await listen(gateway.server);
  try {
    await new Promise((resolve,reject)=> { const client=net.connect(port,'127.0.0.1'); let phase=0; let bytes=Buffer.alloc(0); const timer=setTimeout(()=> {client.destroy();reject(new Error('upgrade timeout'));},2000);
      client.once('connect',()=>client.write('GET '+base+'ws HTTP/1.1\r\nHost: gateway\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: test\r\nSec-WebSocket-Version: 13\r\nAuthorization: SECRET\r\nCookie: SECRET\r\nX-Chisa-Preview-Ticket: '+ticket(claims())+'\r\n\r\n'));
      client.on('data',chunk=> { bytes=Buffer.concat([bytes,chunk]); if(phase===0 && bytes.includes(Buffer.from('\r\n\r\n'))) {assert.match(bytes.toString(),/101 Switching/);phase=1;bytes=Buffer.alloc(0);client.write('frame-bytes');} else if(phase===1 && bytes.toString()==='frame-bytes') {clearTimeout(timer);client.destroy();resolve();} }); client.once('error',reject);
    });
    assert.equal(receivedHeaders.authorization,undefined); assert.equal(receivedHeaders.cookie,undefined); assert.equal(receivedHeaders['x-chisa-preview-ticket'],undefined); assert.equal(receivedHeaders['sec-websocket-key'],'test');
  } finally { await gateway.close(); for (const peer of peers) peer.destroy(); await close(upstream); }
});
function fakeScheduler(){
  let time=1900000000000;let next=0;const events=new Map();
  const schedule=(fn,delay,repeat)=>{const handle={id:++next,unref(){}};events.set(handle.id,{handle,fn,due:time+delay,repeat});return handle;};
  return{clock:()=>time,setTimeout:(fn,delay)=>schedule(fn,delay,0),clearTimeout:handle=>events.delete(handle.id),setInterval:(fn,delay)=>schedule(fn,delay,delay),clearInterval:handle=>events.delete(handle.id),async advance(ms){const end=time+ms;for(;;){const event=[...events.values()].filter(item=>item.due<=end).sort((a,b)=>a.due-b.due)[0];if(!event)break;time=event.due;if(event.repeat)event.due+=event.repeat;else events.delete(event.handle.id);await event.fn();}time=end;}};
}
async function retainedStream(kind){
  const scheduler=fakeScheduler();const upstream=http.createServer();const peers=new Set();let response;let renewals=0;let revoked=false;let current;
  upstream.on('request',(_request,res)=>{response=res;res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: before\n\n');});
  upstream.on('upgrade',(_request,socket)=>{peers.add(socket);socket.once('close',()=>peers.delete(socket));socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');socket.on('data',bytes=>socket.write(bytes));});const upstreamPort=await listen(upstream);
  const renewable={...config,maxSeconds:300,renewSocket:'/run/chisa-preview-renew/renew.sock'};
  current=claims({issuedAt:scheduler.clock()-1000,expiresAt:scheduler.clock()+60000,renewalHandle:'f'.repeat(64)});
  const gateway=await createGateway(renewable,keys.publicKey,{...scheduler,inspect:async value=>{if(revoked)throw new Error('revoked broker resource');return{host:value.host,port:value.port,resourceId:value.resourceId};},renew:async previous=>{if(revoked)throw new Error('authority revoked');renewals++;assert.equal(previous.resourceId,current.resourceId);current={...previous,issuedAt:scheduler.clock(),expiresAt:scheduler.clock()+60000};return{ticket:ticket(current),operationId:current.operationId,resourceId:current.resourceId,leaseId:current.leaseId,base:current.base};},connect:options=>http.request({...options,host:'127.0.0.1',port:upstreamPort,agent:false})});const port=await listen(gateway.server);let client;let incoming;const received=[];
  try{
    if(kind==='http')await new Promise((resolve,reject)=>{client=http.get({host:'127.0.0.1',port,path:base+'events',headers:{'x-chisa-preview-ticket':ticket(current)},agent:false},res=>{incoming=res;res.on('error',()=>{});res.on('data',bytes=>{received.push(bytes.toString());resolve();});});client.once('error',reject);});
    else await new Promise((resolve,reject)=>{client=net.connect(port,'127.0.0.1');client.once('error',reject);client.once('connect',()=>client.write('GET '+base+'ws HTTP/1.1\r\nHost: gateway\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nX-Chisa-Preview-Ticket: '+ticket(current)+'\r\n\r\n'));client.once('data',bytes=>{assert.match(bytes.toString(),/101 Switching/);client.on('data',data=>received.push(data.toString()));resolve();});});
    await scheduler.advance(151000);assert.ok(renewals>=4);assert.equal(kind==='http'?incoming.destroyed:client.destroyed,false);
    if(kind==='http'){const arrived=new Promise(resolve=>incoming.once('data',resolve));response.write('data: after-original-expiry\n\n');await arrived;assert.ok(received.join('').includes('after-original-expiry'));}
    else{const echoed=new Promise(resolve=>client.once('data',resolve));client.write('frame-after-original-expiry');assert.equal((await echoed).toString(),'frame-after-original-expiry');}
    const closed=new Promise(resolve=>(kind==='http'?incoming:client).once('close',resolve));revoked=true;await scheduler.advance(5000);await closed;
  }finally{client?.destroy();await gateway.close();for(const peer of peers)peer.destroy();response?.destroy();await close(upstream);}
}
test('HTTP SSE survives original120s ticket limit through fresh same-resource authority renewal then closes on revoke',{timeout:5000},()=>retainedStream('http'));
test('WebSocket survives original120s ticket limit with real frame transport and deterministic renewal barriers',{timeout:5000},()=>retainedStream('ws'));
test('headers named through Connection are removed as hop-by-hop fields',()=> { const value=forwardedHeaders({connection:'X-Secret','x-secret':'sensitive','x-normal':'ok',authorization:'secret'},'172.30.241.10:3000'); assert.equal(value['x-secret'],undefined); assert.equal(value['x-normal'],'ok'); });
