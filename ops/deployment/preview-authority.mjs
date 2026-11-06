#!/usr/bin/env node
// Independent root service. Public API reaches only the trusted SO_PEERCRED
// front. Private signing/enrollment/database paths are never mounted into API.
import { createHash, createPrivateKey, createPublicKey, randomBytes, sign } from 'node:crypto';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import http from 'node:http';
import { isIP } from 'node:net';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath,pathToFileURL } from 'node:url';

const fault=code=>Object.assign(new Error(code),{code});
const ensure=(condition,code)=>{if(!condition)throw fault(code);};
const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const hash=value=>createHash('sha256').update(value).digest('hex');
const selectors=['ticket','userId','root','workspaceId','generation','sessionId','bindingEpoch','legacyReservationId','leaseId','operationId','base'];
const mapping=['userId','root','workspaceId','generation','sessionId','bindingEpoch','legacyReservationId','leaseId','operationId','base'];
const peerFields=['pid','uid','gid','processStartTime','bootId','pidNamespace'];
const samePeer=(left,right)=>left&&right&&peerFields.every(field=>left[field]===right[field]);
const exact=(value,fields)=>ensure(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===fields.length&&fields.every(field=>Object.hasOwn(value,field)),'PREVIEW_AUTHORITY_SCHEMA');
const validPath=value=>typeof value==='string'&&path.isAbsolute(value)&&path.resolve(value)===value&&!/[\0\r\n,]/.test(value);
const validBase=value=>typeof value==='string'&&/^\/api\/workspace-runtime\/preview\/[a-f0-9]{64}\/$/.test(value);
const ipNumber=value=>value.split('.').reduce((out,item)=>(out*256+Number(item))>>>0,0);
function accountAddress(address,cidr){
  ensure(isIP(address)===4&&typeof cidr==='string','PREVIEW_AUTHORITY_TARGET');const [network,prefixText]=cidr.split('/');const prefix=Number(prefixText);
  ensure(isIP(network)===4&&prefix>=16&&prefix<=28,'PREVIEW_AUTHORITY_NETWORK');const mask=(0xffffffff<<(32-prefix))>>>0;const value=ipNumber(address);const base=ipNumber(network);
  return ((base&mask)>>>0)===base&&((value&mask)>>>0)===base&&value!==base&&value!==((base|(~mask>>>0))>>>0);
}
async function protectedPath(filename,kind='file',privateOnly=false){
  ensure(validPath(filename)&&await realpath(filename)===filename,'PREVIEW_AUTHORITY_PATH');let current=filename;
  for(;;){const item=await lstat(current);const final=current===filename;const sticky=!final&&item.uid===0&&(item.mode&0o1000)!==0;
    ensure(!item.isSymbolicLink()&&(final?(kind==='directory'?item.isDirectory():kind==='socket'?item.isSocket():item.isFile()&&item.nlink===1):item.isDirectory()),'PREVIEW_AUTHORITY_PATH');
    if(process.platform!=='win32')ensure(item.uid===0&&((item.mode&(final&&privateOnly?0o077:0o022))===0||sticky||final&&kind==='socket'),'PREVIEW_AUTHORITY_PERMISSIONS');
    if(path.dirname(current)===current)break;current=path.dirname(current);
  }
}
export async function observePeer(pid){
  ensure(Number.isSafeInteger(pid)&&pid>0,'PREVIEW_AUTHORITY_PEER');
  const self=await readFile('/proc/self/stat','utf8');ensure(Number(self.slice(0,self.indexOf(' ')))===process.pid,'PREVIEW_AUTHORITY_PROC_VIEW');
  const sample=async()=>{const [record,status,boot]=await Promise.all([readFile('/proc/'+pid+'/stat','utf8'),readFile('/proc/'+pid+'/status','utf8'),readFile('/proc/sys/kernel/random/boot_id','utf8')]);const fields=record.slice(record.lastIndexOf(')')+2).trim().split(/\s+/);ensure(Number(record.slice(0,record.indexOf(' ')))===pid&&fields.length>19&&!['Z','X'].includes(fields[0]),'PREVIEW_AUTHORITY_PEER');const uid=Number(/^Uid:\s+\d+\s+(\d+)/m.exec(status)?.[1]);const gid=Number(/^Gid:\s+\d+\s+(\d+)/m.exec(status)?.[1]);ensure(Number.isSafeInteger(uid)&&uid>=0&&Number.isSafeInteger(gid)&&gid>=0,'PREVIEW_AUTHORITY_PEER');return{pid,uid,gid,processStartTime:fields[19],bootId:boot.trim()};};
  const first=await sample();let namespace;
  if(first.uid===process.getuid()){const {readlink}=await import('node:fs/promises');namespace=await readlink('/proc/'+pid+'/ns/pid');}
  else{const helper=fileURLToPath(new URL('../workspace-broker/authority/read-peer-namespace.py',import.meta.url));await protectedPath(helper);namespace=await new Promise((resolve,reject)=>execFile('/usr/bin/python3',['-I','-S',helper,String(pid),String(first.uid),String(first.gid)],{timeout:1000,maxBuffer:128,encoding:'utf8',cwd:'/',env:{LANG:'C'}},(error,stdout)=>error?reject(fault('PREVIEW_AUTHORITY_PEER_NAMESPACE')):resolve(stdout.trim())));}
  ensure(/^pid:\[\d+\]$/.test(namespace),'PREVIEW_AUTHORITY_PEER_NAMESPACE');const second=await sample();ensure(Object.keys(first).every(field=>first[field]===second[field]),'PREVIEW_AUTHORITY_PEER_CHANGED');return{...first,pidNamespace:namespace};
}
export async function unixJson(socketPath,route,body,proof){
  if(process.platform==='linux'){
    await protectedPath(socketPath,'socket');const socket=await lstat(socketPath);
    const privateChannel=['/v1/preview-authorization','/v1/ticket','/v1/close','/v1/begin','/v1/grant','/v1/end'].includes(route);
    ensure((socket.mode&(privateChannel?0o077:0o007))===0,'PREVIEW_AUTHORITY_UNIX_PERMISSIONS');
  }
  return new Promise((resolve,reject)=>{const bytes=Buffer.from(JSON.stringify(body));ensure(bytes.length<=32768,'PREVIEW_AUTHORITY_REQUEST_LIMIT');
    const request=http.request({socketPath,method:'POST',path:route,headers:{'Content-Type':'application/json','Content-Length':bytes.length,...(proof?{Authorization:'Bearer '+proof}:{})}},response=>{const chunks=[];let total=0;
      response.on('data',chunk=>{total+=chunk.length;if(total>65536)response.destroy(fault('PREVIEW_AUTHORITY_RESPONSE_LIMIT'));else chunks.push(chunk);});response.once('error',reject);response.once('end',()=>{try{ensure(response.statusCode===200,'PREVIEW_AUTHORITY_UPSTREAM_DENIED');resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch(error){reject(error);}});
    });const timer=setTimeout(()=>request.destroy(fault('PREVIEW_AUTHORITY_TIMEOUT')),5000);timer.unref();request.once('error',reject);request.once('close',()=>clearTimeout(timer));request.end(bytes);
  });
}
export async function createPreviewAuthority(input,dependencies={}){
  const config=structuredClone(input);exact(config,['version','audience','keyId','privateKey','registryDirectory','authoritySocket','brokerSocket','privateSocket','renewSocket','gatewayGroupId','apiUid','entries']);
  ensure(config.version===1&&id(config.audience)&&id(config.keyId)&&Number.isSafeInteger(config.apiUid)&&config.apiUid>=0&&Number.isSafeInteger(config.gatewayGroupId)&&config.gatewayGroupId>0,'PREVIEW_AUTHORITY_CONFIGURATION');
  for(const field of ['registryDirectory','authoritySocket','brokerSocket','privateSocket','renewSocket'])ensure(validPath(config[field]),'PREVIEW_AUTHORITY_PATH');
  const key=createPrivateKey(config.privateKey);ensure(key.asymmetricKeyType==='ed25519','PREVIEW_AUTHORITY_KEY');
  ensure(Array.isArray(config.entries)&&config.entries.length>0,'PREVIEW_AUTHORITY_ENTRIES');const entries=new Map();
  for(const entry of config.entries){exact(entry,['ownerId','userId','root','workspaceId','generation','sessionId','bindingEpoch','gatewayHost','gatewayPort','accountSubnet']);
    ensure(['ownerId','userId','workspaceId','generation','sessionId','bindingEpoch'].every(field=>id(entry[field]))&&validPath(entry.root)&&isIP(entry.gatewayHost)===4&&Number.isSafeInteger(entry.gatewayPort)&&entry.gatewayPort>=1024&&entry.gatewayPort<=65535,'PREVIEW_AUTHORITY_ENTRY');
    ensure(!entries.has(entry.workspaceId)&&!accountAddress(entry.gatewayHost,entry.accountSubnet),'PREVIEW_AUTHORITY_NETWORK');entries.set(entry.workspaceId,entry);
  }
  const clock=dependencies.clock??Date.now;const observe=dependencies.observePeer??observePeer;
  const authorize=dependencies.authorize??(envelope=>unixJson(config.authoritySocket,'/v1/preview-authorization',envelope));
  const broker=dependencies.broker??((route,proof,body)=>unixJson(config.brokerSocket,route,body,proof));
  await mkdir(config.registryDirectory,{mode:0o700,recursive:true});await protectedPath(config.registryDirectory,'directory',true);
  for(const name of ['preview.sqlite','lock.sqlite']){const location=path.join(config.registryDirectory,name);try{const file=await open(location,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);await file.sync();await file.close();}catch(error){if(error.code!=='EEXIST')throw error;}await protectedPath(location,'file',true);}
  const lock=new DatabaseSync(path.join(config.registryDirectory,'lock.sqlite'));let database;
  try{lock.exec('PRAGMA busy_timeout=0;CREATE TABLE IF NOT EXISTS lock(id INTEGER);BEGIN EXCLUSIVE;');database=new DatabaseSync(path.join(config.registryDirectory,'preview.sqlite'));database.exec('PRAGMA synchronous=FULL;PRAGMA journal_mode=DELETE;CREATE TABLE IF NOT EXISTS metadata(id INTEGER PRIMARY KEY,value TEXT NOT NULL);CREATE TABLE IF NOT EXISTS previews(operation TEXT PRIMARY KEY,base TEXT NOT NULL,value TEXT NOT NULL);');
    const fingerprint=hash(JSON.stringify({...config,privateKey:createPublicKey(key).export({type:'spki',format:'pem'}).toString()}));const old=database.prepare('SELECT value FROM metadata WHERE id=1').get();ensure(!old||old.value===fingerprint,'PREVIEW_AUTHORITY_MANIFEST_CHANGED');database.prepare('INSERT OR IGNORE INTO metadata VALUES(1,?)').run(fingerprint);
    // Restart never silently continues a previous stream's refresh authority.
    for(const row of database.prepare('SELECT operation,value FROM previews').all()){const record=JSON.parse(row.value);record.closed=true;database.prepare('UPDATE previews SET value=? WHERE operation=?').run(JSON.stringify(record),row.operation);}
  }catch(error){database?.close();lock.close();throw error;}
  let queue=Promise.resolve();let closed=false;const serialize=action=>{const next=queue.then(()=>{ensure(!closed,'PREVIEW_AUTHORITY_CLOSED');return action();});queue=next.catch(()=>{});return next;};
  const save=record=>database.prepare('UPDATE previews SET value=? WHERE operation=?').run(JSON.stringify(record),record.key);
  const load=operation=>{const row=database.prepare('SELECT value FROM previews WHERE operation=?').get(operation);return row?JSON.parse(row.value):null;};
  const operationKey=request=>JSON.stringify([request.workspaceId,request.generation,request.leaseId,request.operationId]);
  async function issue(record){
    ensure(!record.closed,'PREVIEW_AUTHORITY_REVOKED');ensure(record.expiresAt===undefined||record.expiresAt>clock(),'PREVIEW_AUTHORITY_RENEWAL_EXPIRED');ensure(samePeer(record.observation.peer,await observe(record.observation.peer.pid)),'PREVIEW_AUTHORITY_PEER_CHANGED');
    const receipt=await authorize({request:record.request,observation:record.observation});const entry=entries.get(record.request.workspaceId);
    ensure(entry&&receipt.version===1&&receipt.ownerId===entry.ownerId&&mapping.every(field=>receipt[field]===record.request[field])&&id(receipt.profileId)&&typeof receipt.statusProof==='string'&&typeof receipt.previewProof==='string','PREVIEW_AUTHORITY_MAPPING');
    const status=await broker('/v1/status',receipt.statusProof,{operationId:record.request.operationId});
    ensure(status.operationId===record.request.operationId&&status.workspaceId===record.request.workspaceId&&status.generation===record.request.generation&&status.leaseId===record.request.leaseId&&status.profileId===receipt.profileId&&status.kind==='run'&&status.state==='running'&&status.cleanupConfirmed===false&&/^[a-f0-9]{64}$/.test(status.resourceId),'PREVIEW_AUTHORITY_OPERATION');
    const target=await broker('/v1/preview',receipt.previewProof,{operationId:record.request.operationId});
    ensure(target.resourceId===status.resourceId&&accountAddress(target.host,entry.accountSubnet)&&Number.isSafeInteger(target.port)&&target.port>=1024&&target.port<=65535,'PREVIEW_AUTHORITY_TARGET');
    const immutable={resourceId:target.resourceId,host:target.host,port:target.port,profileId:receipt.profileId};
    if(record.immutable)ensure(Object.keys(immutable).every(field=>record.immutable[field]===immutable[field]),'PREVIEW_AUTHORITY_RESOURCE_REPLACED');
    const issuedAt=clock();const expiresAt=Math.min(issuedAt+60000,receipt.expiresAt);ensure(Number.isSafeInteger(expiresAt)&&expiresAt>issuedAt+1000,'PREVIEW_AUTHORITY_EXPIRING');
    record.immutable=immutable;record.lastIssuedAt=issuedAt;record.expiresAt=expiresAt;save(record);
    const claims={version:1,audience:config.audience,keyId:config.keyId,accountId:entry.ownerId,workspaceId:record.request.workspaceId,generation:record.request.generation,leaseId:record.request.leaseId,operationId:record.request.operationId,resourceId:target.resourceId,host:target.host,port:target.port,base:record.request.base,issuedAt,expiresAt,brokerProof:receipt.previewProof,renewalHandle:record.handle};
    const bytes=Buffer.from(JSON.stringify(claims));const ticket=bytes.toString('base64url')+'.'+sign(null,bytes,key).toString('base64url');
    return{version:1,ticket,issuedAt,expiresAt,gateway:{accountId:entry.ownerId,host:entry.gatewayHost,port:entry.gatewayPort},workspaceId:claims.workspaceId,generation:claims.generation,leaseId:claims.leaseId,operationId:claims.operationId,resourceId:claims.resourceId,base:claims.base};
  }
  return{
    ticket(envelope){return serialize(async()=>{exact(envelope,['request','observation']);exact(envelope.request,selectors);exact(envelope.observation,['peer']);const request=envelope.request;const peer=envelope.observation.peer;const entry=entries.get(request.workspaceId);
      ensure(entry&&peer?.uid===config.apiUid&&validBase(request.base)&&typeof request.ticket==='string'&&/^[a-f0-9]{64,128}$/.test(request.ticket)&&['userId','root','workspaceId','generation','sessionId','bindingEpoch'].every(field=>entry[field]===request[field])&&['legacyReservationId','leaseId','operationId'].every(field=>id(request[field])),'PREVIEW_AUTHORITY_DENIED');
      const key=operationKey(request);let record=load(key);
      if(record){ensure(mapping.every(field=>record.request[field]===request[field])&&record.request.ticket===request.ticket&&samePeer(record.observation.peer,peer),'PREVIEW_AUTHORITY_BASE_REBOUND');
        ensure(!record.closed,'PREVIEW_AUTHORITY_REVOKED');
        if(record.expiresAt<=clock()){
          // Only a fresh trusted request may replace an idle open handle. Keep
          // the old row unchanged until issue rechecks authority/current broker
          // and saves the same immutable resource with this new handle.
          record={...record,handle:randomBytes(32).toString('hex')};delete record.expiresAt;
        }
      }
      else{ensure(samePeer(peer,await observe(peer.pid)),'PREVIEW_AUTHORITY_PEER_CHANGED');record={key,request,observation:envelope.observation,handle:randomBytes(32).toString('hex'),closed:false};database.prepare('INSERT INTO previews VALUES(?,?,?)').run(key,request.base,JSON.stringify(record));}
      try{return await issue(record);}catch(error){record.closed=true;save(record);throw error;}
    });},
    renew(body){return serialize(async()=>{exact(body,['renewalHandle']);ensure(typeof body.renewalHandle==='string'&&/^[a-f0-9]{64}$/.test(body.renewalHandle),'PREVIEW_AUTHORITY_RENEWAL');const records=database.prepare('SELECT value FROM previews').all().map(row=>JSON.parse(row.value));const matches=records.filter(record=>record.handle===body.renewalHandle);ensure(matches.length===1,'PREVIEW_AUTHORITY_RENEWAL');const record=matches[0];try{return await issue(record);}catch(error){record.closed=true;save(record);throw error;}});},
    revoke(envelope){return serialize(async()=>{exact(envelope,['request','observation']);exact(envelope.request,selectors);exact(envelope.observation,['peer']);const request=envelope.request;const peer=envelope.observation.peer;const entry=entries.get(request.workspaceId);
      ensure(entry&&peer?.uid===config.apiUid&&validBase(request.base)&&typeof request.ticket==='string'&&/^[a-f0-9]{64,128}$/.test(request.ticket)&&['userId','root','workspaceId','generation','sessionId','bindingEpoch'].every(field=>entry[field]===request[field])&&['legacyReservationId','leaseId','operationId'].every(field=>id(request[field])),'PREVIEW_AUTHORITY_DENIED');
      const key=operationKey(request);let record=load(key);
      if(record)ensure(samePeer(record.observation.peer,peer)&&mapping.every(field=>record.request[field]===request[field])&&record.request.ticket===request.ticket,'PREVIEW_AUTHORITY_DENIED');
      else{ensure(samePeer(peer,await observe(peer.pid)),'PREVIEW_AUTHORITY_PEER_CHANGED');record={key,request,observation:envelope.observation,handle:randomBytes(32).toString('hex'),closed:true};database.prepare('INSERT INTO previews VALUES(?,?,?)').run(key,request.base,JSON.stringify(record));}
      record.closed=true;save(record);return{closed:true,operationId:record.request.operationId,base:record.request.base};});},
    async close(){await queue;if(closed)return;closed=true;database.close();lock.exec('ROLLBACK');lock.close();},
  };
}
export async function createPreviewAuthorityServer(authority,{socketPath,renew=false,clientGroupId}){
  if(process.platform!=='win32'){await protectedPath(path.dirname(socketPath),'directory',!renew);const directory=await lstat(path.dirname(socketPath));ensure(renew?directory.gid===clientGroupId&&(directory.mode&0o777)===0o750:(directory.mode&0o777)===0o700,'PREVIEW_AUTHORITY_SOCKET_DIRECTORY');try{await lstat(socketPath);throw fault('PREVIEW_AUTHORITY_SOCKET_EXISTS');}catch(error){if(error.code!=='ENOENT')throw error;}}
  const server=http.createServer(async(request,response)=>{try{ensure(request.method==='POST'&&request.headers['content-type']==='application/json'&&!request.headers['transfer-encoding'],'PREVIEW_AUTHORITY_ROUTE');const chunks=[];let total=0;for await(const chunk of request){total+=chunk.length;ensure(total<=32768,'PREVIEW_AUTHORITY_LIMIT');chunks.push(chunk);}const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));let value;
    if(renew){ensure(request.url==='/v1/renew','PREVIEW_AUTHORITY_ROUTE');value=await authority.renew(body);}else if(request.url==='/v1/ticket')value=await authority.ticket(body);else if(request.url==='/v1/close')value=await authority.revoke(body);else throw fault('PREVIEW_AUTHORITY_ROUTE');
    response.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});response.end(JSON.stringify(value));
  }catch(error){response.writeHead(403,{'Content-Type':'application/json','Cache-Control':'no-store'});response.end(JSON.stringify({error:/^PREVIEW_AUTHORITY_[A-Z_]+$/.test(error.code)?error.code:'PREVIEW_AUTHORITY_UNAVAILABLE'}));}});
  server.requestTimeout=10000;server.headersTimeout=5000;server.maxConnections=64;server.on('clientError',(_error,socket)=>socket.destroy());await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve);});
  if(process.platform!=='win32'){if(renew){ensure(Number.isInteger(clientGroupId)&&clientGroupId>0,'PREVIEW_AUTHORITY_GROUP');const {chown}=await import('node:fs/promises');await chown(socketPath,0,clientGroupId);}await chmod(socketPath,renew?0o660:0o600);}
  const pin=process.platform==='win32'?null:await lstat(socketPath);return{server,async close(){server.closeAllConnections();await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));if(pin){const item=await lstat(socketPath).catch(()=>null);if(item?.isSocket()&&item.dev===pin.dev&&item.ino===pin.ino)await unlink(socketPath);}}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){ensure(process.platform==='linux'&&process.getuid()===0,'PREVIEW_AUTHORITY_ROOT_REQUIRED');process.umask(0o077);await protectedPath(process.argv[2],'file',true);const manifest=await open(process.argv[2],constants.O_RDONLY|constants.O_NOFOLLOW);let config;try{const before=await manifest.stat();ensure(before.size<=1024*1024,'PREVIEW_AUTHORITY_MANIFEST_LIMIT');config=JSON.parse(await manifest.readFile('utf8'));const after=await lstat(process.argv[2]);ensure(before.dev===after.dev&&before.ino===after.ino&&before.size===after.size&&before.mtimeMs===after.mtimeMs,'PREVIEW_AUTHORITY_MANIFEST_CHANGED');}finally{await manifest.close();}const authority=await createPreviewAuthority(config);const privateServer=await createPreviewAuthorityServer(authority,{socketPath:config.privateSocket});const renewServer=await createPreviewAuthorityServer(authority,{socketPath:config.renewSocket,renew:true,clientGroupId:config.gatewayGroupId});let stopping=false;const stop=async()=>{if(stopping)return;stopping=true;await privateServer.close();await renewServer.close();await authority.close();};process.once('SIGTERM',()=>void stop());process.once('SIGINT',()=>void stop());console.log(JSON.stringify({event:'preview-authority-listening',version:1}));}
