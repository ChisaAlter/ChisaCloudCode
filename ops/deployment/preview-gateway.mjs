#!/usr/bin/env node
// Per-account candidate. No Docker capability, signing key, arbitrary URL, DNS
// target resolution or API-selected upstream. Existing runtime consumer is a gate.
import { createPublicKey, verify } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import http from 'node:http';
import { isIP } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const denied = (code = 'PREVIEW_GATEWAY_DENIED') => Object.assign(new Error(code), { code });
const ensure = (condition, code) => { if (!condition) throw denied(code); };
const exact = (object, names) => ensure(object && typeof object === 'object' && !Array.isArray(object) && Object.keys(object).every(name => names.includes(name)) && names.every(name => Object.hasOwn(object,name)), 'PREVIEW_SCHEMA');
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const resource = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const literalPath = value => typeof value === 'string' && /^\/[A-Za-z0-9_./-]+$/.test(value) && path.posix.normalize(value) === value && !value.split('/').includes('..');
const ipNumber = input => input.split('.').reduce((result,item) => (result*256+Number(item))>>>0,0);
function inSubnet(ip, cidr) {
  ensure(isIP(ip) === 4 && /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(cidr),'PREVIEW_ADDRESS');
  const [network,bits] = cidr.split('/'); const prefix = Number(bits);
  ensure(isIP(network) === 4 && prefix >= 16 && prefix <= 30,'PREVIEW_SUBNET');
  const mask = (0xffffffff << (32-prefix))>>>0;
  const value = ipNumber(ip); const base = ipNumber(network);
  ensure((base & mask)>>>0 === base,'PREVIEW_SUBNET');
  return ((value & mask)>>>0) === base && value !== base && value !== ((base | (~mask>>>0))>>>0);
}
export function validateGatewayConfig(configuration) {
  const names=['version','accountId','audience','keyId','publicKeyFile','brokerSocket','listenHost','listenPort','allowedClientAddress','accountSubnet','maxConnections','maxRequestBytes','maxSeconds'];
  exact(configuration,configuration.renewSocket === undefined ? names : [...names,'renewSocket']);
  if(configuration.renewSocket !== undefined)ensure(configuration.renewSocket === '/run/chisa-preview-renew/renew.sock','PREVIEW_RENEW_SOCKET');
  ensure(configuration.version === 1 && [configuration.accountId,configuration.audience,configuration.keyId].every(identifier),'PREVIEW_CONFIGURATION');
  ensure(literalPath(configuration.publicKeyFile) && configuration.publicKeyFile.startsWith('/etc/chisa-client/') && configuration.brokerSocket === '/run/chisa-broker/broker.sock','PREVIEW_UNIX_CHANNEL');
  ensure(configuration.listenHost === '0.0.0.0' && Number.isSafeInteger(configuration.listenPort) && configuration.listenPort >= 1024 && configuration.listenPort <= 65535,'PREVIEW_LISTEN');
  ensure(isIP(configuration.allowedClientAddress) === 4 && !inSubnet(configuration.allowedClientAddress,configuration.accountSubnet),'PREVIEW_CLIENT_NETWORK');
  ensure(Number.isSafeInteger(configuration.maxConnections) && configuration.maxConnections >= 1 && configuration.maxConnections <= 64 &&
    Number.isSafeInteger(configuration.maxRequestBytes) && configuration.maxRequestBytes > 0 && configuration.maxRequestBytes <= 16*1024*1024 &&
    Number.isSafeInteger(configuration.maxSeconds) && configuration.maxSeconds >= 1 && configuration.maxSeconds <= 300,'PREVIEW_LIMITS');
  return configuration;
}
async function trustedFile(filename) {
  ensure(literalPath(filename) && await realpath(filename) === filename,'PREVIEW_AUTHORITY_PATH');
  let component = '/';
  for (const part of filename.slice(1).split('/')) {
    component = path.join(component,part); const value = await lstat(component);
    ensure(!value.isSymbolicLink() && value.uid === 0 && (value.mode & 0o022) === 0,'PREVIEW_AUTHORITY_PERMISSIONS');
  }
  const file = await open(filename,constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat(); ensure(before.isFile() && before.nlink === 1 && before.size <= 65536,'PREVIEW_AUTHORITY_FILE');
    const data = await file.readFile(); const after = await lstat(filename);
    ensure(before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs,'PREVIEW_AUTHORITY_CHANGED'); return data;
  } finally { await file.close(); }
}
function decode(value) {
  ensure(typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value),'PREVIEW_TOKEN_ENCODING');
  const result = Buffer.from(value,'base64url'); ensure(result.toString('base64url') === value,'PREVIEW_TOKEN_ENCODING'); return result;
}
export function authorizeTicket(configuration, publicKey, ticket, pathname, clock = Date.now()) {
  ensure(typeof ticket === 'string' && ticket.length <= 16384,'PREVIEW_TOKEN_REQUIRED');
  const pieces = ticket.split('.'); ensure(pieces.length === 2,'PREVIEW_TOKEN_ENCODING');
  const payload = decode(pieces[0]); const signature = decode(pieces[1]);
  ensure(signature.length === 64 && verify(null,payload,publicKey,signature),'PREVIEW_SIGNATURE');
  let claims; try { claims = JSON.parse(payload.toString('utf8')); } catch { throw denied('PREVIEW_TOKEN_JSON'); }
  const fields=['version','audience','keyId','accountId','workspaceId','generation','leaseId','operationId','resourceId','host','port','base','issuedAt','expiresAt','brokerProof'];
  exact(claims,configuration.renewSocket === undefined ? fields : [...fields,'renewalHandle']);
  if(configuration.renewSocket !== undefined)ensure(typeof claims.renewalHandle === 'string'&&/^[a-f0-9]{64}$/.test(claims.renewalHandle),'PREVIEW_RENEW_HANDLE');
  ensure(claims.version === 1 && claims.audience === configuration.audience && claims.keyId === configuration.keyId && claims.accountId === configuration.accountId,'PREVIEW_ACCOUNT');
  ensure([claims.workspaceId,claims.generation,claims.leaseId,claims.operationId].every(identifier) && resource(claims.resourceId),'PREVIEW_RESOURCE');
  ensure(Number.isSafeInteger(claims.issuedAt) && Number.isSafeInteger(claims.expiresAt) && claims.issuedAt <= clock && claims.expiresAt > clock && claims.expiresAt-claims.issuedAt <= 120000,'PREVIEW_EXPIRY');
  ensure(inSubnet(claims.host,configuration.accountSubnet) && Number.isSafeInteger(claims.port) && claims.port >= 1024 && claims.port <= 65535,'PREVIEW_TARGET');
  ensure(typeof claims.brokerProof === 'string' && claims.brokerProof.length >= 32 && claims.brokerProof.length <= 8192,'PREVIEW_BROKER_PROOF');
  ensure(typeof claims.base === 'string' && /^\/api\/workspace-runtime\/preview\/[a-f0-9]{64}\/$/.test(claims.base),'PREVIEW_BASE');
  ensure(typeof pathname === 'string' && pathname.length <= 8192 && pathname.startsWith(claims.base) && !/[\\\r\n\x00]/.test(pathname) && !/%(?:2e|2f|5c|00|0a|0d)/i.test(pathname),'PREVIEW_PATH');
  const url = new URL(pathname,'http://preview.invalid');
  ensure(url.origin === 'http://preview.invalid' && url.pathname.startsWith(claims.base),'PREVIEW_PATH');
  return claims;
}
export function renewTicket(configuration,claims){
  return new Promise((resolve,reject)=>{const data=Buffer.from(JSON.stringify({renewalHandle:claims.renewalHandle}));const request=http.request({socketPath:configuration.renewSocket,path:'/v1/renew',method:'POST',headers:{'Content-Type':'application/json','Content-Length':data.length}},response=>{const parts=[];let bytes=0;response.on('data',part=>{bytes+=part.length;if(bytes>32768)response.destroy(denied('PREVIEW_RENEW_LIMIT'));else parts.push(part);});response.once('error',reject);response.once('end',()=>{try{ensure(response.statusCode===200,'PREVIEW_RENEW_DENIED');resolve(JSON.parse(Buffer.concat(parts).toString('utf8')));}catch(error){reject(error);}});});const timer=setTimeout(()=>request.destroy(denied('PREVIEW_RENEW_TIMEOUT')),5000);timer.unref();request.once('close',()=>clearTimeout(timer));request.once('error',reject);request.end(data);});
}
export function brokerTarget(configuration, claims) {
  return new Promise((resolve,reject) => {
    const data = Buffer.from(JSON.stringify({ operationId: claims.operationId }));
    const request = http.request({ socketPath: configuration.brokerSocket,path: '/v1/preview',method: 'POST',headers: { Authorization: 'Bearer '+claims.brokerProof,'Content-Type':'application/json','Content-Length':data.length } },response => {
      const chunks=[]; let bytes=0;
      response.on('data',chunk => { bytes+=chunk.length; if (bytes>16384) response.destroy(denied('PREVIEW_BROKER_LIMIT')); else chunks.push(chunk); }); response.once('error',reject);
      response.once('end',() => {
        try { ensure(response.statusCode === 200,'PREVIEW_BROKER_DENIED'); const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          ensure(result.resourceId === claims.resourceId && result.host === claims.host && result.port === claims.port,'PREVIEW_BROKER_REPLACED'); resolve(result);
        } catch (error) { reject(error); }
      });
    });
    const timer = setTimeout(() => request.destroy(denied('PREVIEW_BROKER_TIMEOUT')),5000); timer.unref(); request.once('close',() => clearTimeout(timer)); request.once('error',reject); request.end(data);
  });
}
const requestBlocked = new Set(['authorization','cookie','proxy-authorization','proxy-connection','forwarded','referer','origin','x-real-ip','host','connection','upgrade','keep-alive','te','trailer','transfer-encoding','x-chisa-preview-ticket']);
const responseBlocked = new Set(['set-cookie','clear-site-data','service-worker-allowed','content-security-policy','content-security-policy-report-only','access-control-allow-credentials','access-control-allow-origin','report-to','reporting-endpoints','nel','refresh','connection','upgrade','keep-alive','transfer-encoding','trailer']);
export function forwardedHeaders(headers, authority, upgrade=false) {
  const blocked = new Set([...requestBlocked,...String(headers.connection ?? '').toLowerCase().split(',').map(value => value.trim())]); const result={};
  for (const [name,value] of Object.entries(headers)) if (!blocked.has(name) && !name.startsWith('x-forwarded-') && !name.startsWith('proxy-') && !name.startsWith('sec-')) result[name]=value;
  result.host=authority;
  if (upgrade) { result.connection='Upgrade'; result.upgrade='websocket'; for (const name of ['sec-websocket-key','sec-websocket-version','sec-websocket-protocol','sec-websocket-extensions']) if (headers[name] !== undefined) result[name]=headers[name]; }
  return result;
}
export async function createGateway(configuration, publicKey, dependencies={}) {
  validateGatewayConfig(configuration); ensure(publicKey.asymmetricKeyType === 'ed25519','PREVIEW_KEY_TYPE');
  const inspect = dependencies.inspect ?? (claims => brokerTarget(configuration,claims));
  const connect = dependencies.connect ?? (options => http.request(options));
  const clock = dependencies.clock ?? Date.now;
  const later=dependencies.setTimeout??setTimeout;const clearLater=dependencies.clearTimeout??clearTimeout;
  const every=dependencies.setInterval??setInterval;const clearEvery=dependencies.clearInterval??clearInterval;
  const renew=dependencies.renew??(claims=>renewTicket(configuration,claims));
  let active=0; const sockets=new Set();
  function acquire(request,socket) {
    ensure(request.socket.remoteAddress?.replace(/^::ffff:/,'') === configuration.allowedClientAddress,'PREVIEW_CLIENT');
    ensure(active < configuration.maxConnections,'PREVIEW_CAPACITY');
    let claims=authorizeTicket(configuration,publicKey,request.headers['x-chisa-preview-ticket'],request.url,clock());
    active++; let ended=false; let refreshing=false; let expiry; let refresh;
    const release=() => { if (ended) return; ended=true; active--; if(expiry)clearLater(expiry); if(refresh)clearEvery(refresh); };
    const expire=()=>{socket.destroy();release();};
    const arm=()=>{if(expiry)clearLater(expiry);expiry=later(expire,Math.min(claims.expiresAt-clock(),configuration.maxSeconds*1000));expiry?.unref?.();};
    const recheck=async()=>{if(refreshing||ended)return;refreshing=true;try{
      if(configuration.renewSocket!==undefined&&claims.expiresAt-clock()<=30000){
        const receipt=await renew(claims);ensure(receipt&&typeof receipt.ticket==='string','PREVIEW_RENEW_RECEIPT');
        const next=authorizeTicket(configuration,publicKey,receipt.ticket,request.url,clock());
        const immutable=['version','audience','keyId','accountId','workspaceId','generation','leaseId','operationId','resourceId','host','port','base','renewalHandle'];
        ensure(immutable.every(field=>next[field]===claims[field])&&next.expiresAt>claims.expiresAt&&next.issuedAt>=claims.issuedAt,'PREVIEW_RENEW_REPLACED');
        ensure(receipt.operationId===claims.operationId&&receipt.resourceId===claims.resourceId&&receipt.base===claims.base&&receipt.leaseId===claims.leaseId,'PREVIEW_RENEW_RECEIPT');
        await inspect(next);if(ended)return;claims=next;arm();
      }else await inspect(claims);
    }catch{expire();}finally{refreshing=false;}};
    arm();refresh=every(recheck,5000);refresh?.unref?.();
    socket.once('close',release); return { get claims(){return claims;},release };
  }
  const server=http.createServer(async (request,response) => {
    let admitted; let upstream; const fail=() => { upstream?.destroy(); if (!response.headersSent) { response.writeHead(403,{ 'Content-Type':'application/json','Cache-Control':'no-store' }); response.end('{"error":"PREVIEW_GATEWAY_DENIED"}'); } else response.destroy(); admitted?.release(); };
    try {
      admitted=acquire(request,response); const { claims }=admitted;
      ensure(['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'].includes(request.method),'PREVIEW_METHOD');
      const target=await inspect(claims); if (request.aborted || response.destroyed) { admitted.release(); return; }
      const declared=request.headers['content-length']; ensure(declared === undefined || /^\d+$/.test(declared) && Number(declared)<=configuration.maxRequestBytes,'PREVIEW_BODY_LIMIT');
      upstream=connect({ host: target.host,port: target.port,path: request.url,method: request.method,headers: forwardedHeaders(request.headers,target.host+':'+target.port) });
      const stop=() => { upstream.destroy(); admitted.release(); }; request.once('aborted',stop); response.once('close',stop); response.once('finish',() => admitted.release()); upstream.once('error',fail);
      upstream.setTimeout(30000,() => upstream.destroy(denied('PREVIEW_IDLE_TIMEOUT')));
      let received=0; request.on('data',chunk => { received+=chunk.length; if (received>configuration.maxRequestBytes) { fail(); request.destroy(); } });
      upstream.once('response',incoming => {
        try {
          const blocked=new Set([...responseBlocked,...String(incoming.headers.connection ?? '').toLowerCase().split(',').map(value=>value.trim())]);
          for (const [name,value] of Object.entries(incoming.headers)) if (value!==undefined && !blocked.has(name) && name!=='location') response.setHeader(name,value);
          if (incoming.headers.location) { const location=new URL(incoming.headers.location,'http://'+target.host+':'+target.port+request.url); ensure(location.origin==='http://'+target.host+':'+target.port && location.pathname.startsWith(claims.base),'PREVIEW_REDIRECT'); response.setHeader('Location',location.pathname+location.search+location.hash); }
          response.setHeader('Cache-Control','no-store'); response.setHeader('X-Content-Type-Options','nosniff'); response.setHeader('Referrer-Policy','no-referrer');
          // Browser sandbox policy remains the runtime proxy's origin-bound job.
          // Direct gateway responses never receive app credentials/cookies.
          response.setHeader('Content-Security-Policy',"sandbox allow-scripts allow-forms; object-src 'none'; worker-src 'none'; frame-src 'none'; base-uri 'none'");
          response.writeHead(incoming.statusCode ?? 502); incoming.once('error',fail); incoming.pipe(response);
        } catch { incoming.destroy(); fail(); }
      }); request.pipe(upstream);
    } catch { fail(); }
  });
  server.on('upgrade',async (request,socket,head) => {
    let admitted; let upstream; let peer; const close=() => { peer?.destroy(); upstream?.destroy(); socket.destroy(); admitted?.release(); };
    try {
      admitted=acquire(request,socket); ensure(request.method==='GET' && request.headers.upgrade?.toLowerCase()==='websocket','PREVIEW_UPGRADE'); const { claims }=admitted; const target=await inspect(claims);
      if (socket.destroyed) { admitted.release(); return; }
      upstream=connect({ host: target.host,port: target.port,path: request.url,method:'GET',headers: forwardedHeaders(request.headers,target.host+':'+target.port,true) });
      socket.once('error',close); socket.once('close',close); socket.once('end',close); upstream.once('error',close); upstream.setTimeout(10000,close); upstream.once('response',incoming => { incoming.destroy(); close(); });
      upstream.once('upgrade',(incoming,connected,upstreamHead) => {
        peer=connected; if (incoming.statusCode!==101 || socket.destroyed) { close(); return; } upstream.setTimeout(0);
        const headers=['HTTP/1.1 101 Switching Protocols','Connection: Upgrade','Upgrade: websocket'];
        for (const name of ['sec-websocket-accept','sec-websocket-protocol','sec-websocket-extensions']) { const value=incoming.headers[name]; if (typeof value==='string') headers.push(name+': '+value); }
        socket.write(headers.join('\r\n')+'\r\n\r\n'); if (upstreamHead.length) socket.write(upstreamHead); if (head.length) connected.write(head);
        connected.once('error',close); connected.once('close',close); connected.once('end',close); connected.pipe(socket); socket.pipe(connected);
      }); upstream.end();
    } catch { close(); }
  });
  server.on('connection',socket => { sockets.add(socket); socket.once('close',() => sockets.delete(socket)); });
  server.on('clientError',(_error,socket) => socket.destroy()); server.requestTimeout=15000; server.headersTimeout=10000; server.keepAliveTimeout=1000; server.maxConnections=configuration.maxConnections;
  return { server,async close() { for (const socket of sockets) socket.destroy(); await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve())); } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  ensure(process.platform==='linux' && process.getuid?.()!==0,'PREVIEW_NONROOT_LINUX_REQUIRED');
  const configuration=validateGatewayConfig(JSON.parse((await trustedFile(process.argv[2])).toString('utf8')));
  const publicKey=createPublicKey(await trustedFile(configuration.publicKeyFile));
  for(const location of [configuration.brokerSocket,...(configuration.renewSocket?[configuration.renewSocket]:[])]){
    const parent=await lstat(path.dirname(location));ensure(parent.isDirectory()&&!parent.isSymbolicLink()&&parent.uid===0&&!(parent.mode&0o027),'PREVIEW_SOCKET_PARENT');
    const socket=await lstat(location); ensure(socket.isSocket() && !socket.isSymbolicLink() && socket.uid===0 && !(socket.mode&0o007),'PREVIEW_BROKER_SOCKET');
  }
  const gateway=await createGateway(configuration,publicKey); await new Promise((resolve,reject)=> { gateway.server.once('error',reject); gateway.server.listen(configuration.listenPort,configuration.listenHost,resolve); });
  let stopping=false; const stop=async()=> { if (stopping) return; stopping=true; await gateway.close(); };
  process.once('SIGTERM',()=>{ void stop(); }); process.once('SIGINT',()=>{ void stop(); });
  console.log(JSON.stringify({ event:'preview-gateway-listening',account:configuration.accountId,protocol:1 }));
}
