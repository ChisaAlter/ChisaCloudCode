#!/usr/bin/env node
import { createHash, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, chown, lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const fail = code => Object.assign(new Error(code),{ code });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const fields = ['slotId','provider','userId','ownerId','sessionId','root','workspaceId','generation','leaseId','bindingEpoch','profileId'];
const hash = value => digest(Buffer.from(JSON.stringify(value)));
async function canonical(filename,kind='directory',allowWorker=false) {
  if (!path.isAbsolute(filename) || path.resolve(filename)!==filename || await realpath(filename)!==filename) throw fail('SLOT_PATH_INVALID');
  const metadata=await lstat(filename,{bigint:true});
  if(metadata.isSymbolicLink() || (kind==='file'?(!metadata.isFile()||metadata.nlink!==1n):!metadata.isDirectory())) throw fail('SLOT_PATH_INVALID');
  if(process.platform!=='win32') {
    if(!allowWorker && (metadata.uid!==BigInt(process.getuid()) || (metadata.mode&0o022n)!==0n)) throw fail('SLOT_PATH_UNTRUSTED');
    let current=path.dirname(filename);
    for(;;) { const parent=await lstat(current);const sticky=current===path.parse(current).root+'tmp'&&parent.uid===0&&(parent.mode&0o7777)===0o1777;
      if(parent.isSymbolicLink()||!parent.isDirectory()||(!sticky && (parent.mode&0o022)!==0)||parent.uid!==process.getuid()) throw fail('SLOT_PARENT_UNTRUSTED');
      if(path.dirname(current)===current)break;current=path.dirname(current);
    }
  }
  return {dev:metadata.dev.toString(),ino:metadata.ino.toString()};
}
async function workspaceRoot(slot,apiUid) {
  const native=slot.nativeAccountGroupId!==undefined||slot.rootUid!==undefined;
  if(!native){const pin=await canonical(slot.root,'directory',true);const parent=await lstat(path.dirname(slot.root));if(process.platform!=='win32'&&(parent.mode&0o022)!==0)throw fail('SLOT_NATIVE_NAMESPACE_REQUIRED');return pin;}
  if(!Number.isSafeInteger(slot.nativeAccountGroupId)||slot.nativeAccountGroupId<=0||!Number.isSafeInteger(slot.rootUid)||slot.rootUid<0||!Number.isSafeInteger(apiUid)||apiUid<=0||slot.rootUid===apiUid)throw fail('SLOT_NATIVE_NAMESPACE_INVALID');
  if(!path.isAbsolute(slot.root)||path.resolve(slot.root)!==slot.root||await realpath(slot.root)!==slot.root)throw fail('SLOT_PATH_INVALID');
  const parent=path.dirname(slot.root);if(parent===slot.root)throw fail('SLOT_NATIVE_NAMESPACE_INVALID');
  await canonical(path.dirname(parent));
  const account=await lstat(parent);const leaf=await lstat(slot.root,{bigint:true});
  if(account.isSymbolicLink()||!account.isDirectory()||leaf.isSymbolicLink()||!leaf.isDirectory())throw fail('SLOT_PATH_INVALID');
  if(process.platform!=='win32'&&(account.uid!==0||account.gid!==slot.nativeAccountGroupId||(account.mode&0o7777)!==0o1770||leaf.uid!==BigInt(slot.rootUid)))throw fail('SLOT_NATIVE_NAMESPACE_INVALID');
  return{dev:leaf.dev.toString(),ino:leaf.ino.toString()};
}
async function privateJson(filename,maximum=1024*1024) {
  await canonical(filename,'file');const handle=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {const before=await handle.stat();if(before.size>maximum)throw fail('SLOT_FILE_LIMIT');const value=JSON.parse(await handle.readFile('utf8'));const after=await handle.stat();const named=await lstat(filename);
    if(before.dev!==named.dev||before.ino!==named.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw fail('SLOT_FILE_CHANGED');return value;
  } finally {await handle.close();}
}
async function jsonRequest(socketPath,route,body,proof) {
  return new Promise((resolve,reject)=>{const data=Buffer.from(JSON.stringify(body));const request=httpRequest({socketPath,method:'POST',path:route,headers:{'Content-Type':'application/json','Content-Length':data.length,...(proof?{Authorization:'Bearer '+proof}:{})}},response=>{
    const chunks=[];let length=0;response.on('data',chunk=>{length+=chunk.length;if(length>65536)response.destroy(fail('SLOT_AUTHORITY_LIMIT'));else chunks.push(Buffer.from(chunk));});response.once('error',reject);response.once('end',()=>{if(response.statusCode!==200){reject(fail('SLOT_AUTHORITY_DENIED'));return;}try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{reject(fail('SLOT_AUTHORITY_INVALID'));}});
  });const timeout=setTimeout(()=>request.destroy(fail('SLOT_AUTHORITY_TIMEOUT')),5000);timeout.unref();request.once('error',reject);request.once('close',()=>clearTimeout(timeout));request.end(data);});
}
async function fileSnapshot(filename,pin) {
  const actual=await canonical(filename,'file');if(pin && (actual.dev!==pin.dev||actual.ino!==pin.ino))throw fail('SLOT_SOURCE_REPLACED');
  const handle=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);try {const metadata=await handle.stat({bigint:true});if(metadata.dev.toString()!==actual.dev||metadata.ino.toString()!==actual.ino||metadata.size>32n*1024n*1024n)throw fail('SLOT_SOURCE_CHANGED');return await handle.readFile();}finally{await handle.close();}
}
async function fileDigest(filename,pin) {
  const actual=await canonical(filename,'file');if(actual.dev!==pin.dev||actual.ino!==pin.ino)throw fail('SLOT_SOURCE_REPLACED');const handle=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const before=await handle.stat();if(before.size>512*1024*1024)throw fail('SLOT_CODE_FILE_LIMIT');const checksum=createHash('sha256');for await(const chunk of handle.createReadStream({autoClose:false}))checksum.update(chunk);const after=await handle.stat();const named=await lstat(filename);if(before.dev!==named.dev||before.ino!==named.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw fail('SLOT_SOURCE_CHANGED');return checksum.digest('hex');}finally{await handle.close();}
}

/** Operator starts this service with a private fixed catalog. It has no enroll-path
 * endpoint. All slot roots, binaries, credentials and asset file inodes preexist.
 * One lease seals one immutable snapshot; uncertain preparation never rewrites it. */
export async function createProviderSlotSupervisor(input) {
  const manifest=structuredClone(input);
  if(manifest.version!==1||!Array.isArray(manifest.slots)||!manifest.slots.length||manifest.slots.length>1024)throw fail('SLOT_MANIFEST_INVALID');
  await mkdir(manifest.registryDirectory,{recursive:true,mode:0o700});await canonical(manifest.registryDirectory);await canonical(manifest.witnessDirectory);
  for(const name of ['slots.sqlite','lock.sqlite']) {const target=path.join(manifest.registryDirectory,name);try{const handle=await open(target,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);await handle.sync();await handle.close();}catch(error){if(error.code!=='EEXIST')throw error;}await canonical(target,'file');}
  const lock=new DatabaseSync(path.join(manifest.registryDirectory,'lock.sqlite'));let database;
  const slots=new Map();
  try {
    lock.exec('PRAGMA busy_timeout=0;CREATE TABLE IF NOT EXISTS lock(id INTEGER);BEGIN EXCLUSIVE;');database=new DatabaseSync(path.join(manifest.registryDirectory,'slots.sqlite'));
    database.exec('PRAGMA synchronous=FULL;PRAGMA journal_mode=DELETE;CREATE TABLE IF NOT EXISTS metadata(id INTEGER PRIMARY KEY,hash TEXT NOT NULL);CREATE TABLE IF NOT EXISTS preparation(slot TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,state TEXT NOT NULL,value TEXT NOT NULL);');
    const fingerprint=hash(manifest);const saved=database.prepare('SELECT hash FROM metadata WHERE id=1').get();if(saved&&saved.hash!==fingerprint)throw fail('SLOT_MANIFEST_CHANGED');database.prepare('INSERT OR IGNORE INTO metadata VALUES(1,?)').run(fingerprint);
    const used=new Set();const homes=[];const credentialOwners=new Map();
    for(const slot of manifest.slots) {
      if(fields.filter(field=>!['root','provider',...(manifest.authoritySocketPath?['leaseId']:[])].includes(field)).some(field=>!id(slot[field]))||!['codex','cursor','opencode'].includes(slot.provider)||slots.has(slot.slotId)||!/^([a-f0-9]{64})$/.test(slot.ticketHash)||!Array.isArray(slot.assetFiles)||slot.assetFiles.length>32||!Array.isArray(slot.mounts)||!Array.isArray(slot.codeFiles)||!Array.isArray(slot.credentialFiles)||!Number.isSafeInteger(slot.expiresAt))throw fail('SLOT_MANIFEST_INVALID');
      await workspaceRoot(slot,manifest.apiUid);await canonical(slot.home,'directory',true);
      const homeOwner=JSON.stringify([slot.ownerId,slot.userId,slot.provider,slot.sessionId,slot.root,slot.workspaceId]);
      if(homes.some(previous=>(previous.home===slot.home||previous.home.startsWith(slot.home+path.sep)||slot.home.startsWith(previous.home+path.sep))&&(previous.home!==slot.home||previous.owner!==homeOwner))||slot.home===slot.root||slot.home.startsWith(slot.root+path.sep))throw fail('SLOT_HOME_ALIAS');homes.push({home:slot.home,owner:homeOwner});
      const targets=new Set();for(const mount of slot.mounts) {if(!mount||typeof mount.writable!=='boolean'||!path.posix.isAbsolute(mount.target)||path.posix.resolve(mount.target)!==mount.target||targets.has(mount.target))throw fail('SLOT_MOUNT_INVALID');targets.add(mount.target);await canonical(mount.source,(await lstat(mount.source)).isDirectory()?'directory':'file',mount.writable);}
      if(!slot.mounts.some(mount=>mount.source===slot.home && mount.target==='/runtime/provider-state/home'&&mount.writable)||slot.environment?.HOME!=='/runtime/provider-state/home'||slot.command!=='/runtime/provider-code/node'||!Array.isArray(slot.args)||slot.args[0]!=='/runtime/provider-code/app/provider-process.worker.js')throw fail('SLOT_RUNTIME_INVALID');
      for(const [index,asset] of slot.assetFiles.entries()) {
        if(asset.target!==`/runtime/provider-assets/attachment-${index}`||used.has(asset.source)||!slot.mounts.some(mount=>mount.source===asset.source&&mount.target===asset.target&&!mount.writable))throw fail('SLOT_ASSET_INVALID');used.add(asset.source);
        const pin=await canonical(asset.source,'file');if(pin.dev!==asset.dev||pin.ino!==asset.ino)throw fail('SLOT_SOURCE_REPLACED');
      }
      for(const file of slot.credentialFiles){const prior=credentialOwners.get(file.source);const owner=slot.ownerId+'\0'+slot.sessionId;if(prior!==undefined&&prior!==owner)throw fail('SLOT_CREDENTIAL_ALIAS');credentialOwners.set(file.source,owner);}
      for(const file of [...slot.codeFiles,...slot.credentialFiles]) {if(!/^[a-f0-9]{64}$/.test(file.sha256)||await fileDigest(file.source,file)!==file.sha256)throw fail('SLOT_IMMUTABLE_SOURCE_CHANGED');}
      const rootPin=await workspaceRoot(slot,manifest.apiUid);if(rootPin.dev!==slot.rootDev||rootPin.ino!==slot.rootIno)throw fail('SLOT_ROOT_REPLACED');slots.set(slot.slotId,slot);
    }
  } catch(error) {database?.close();lock.close();throw error;}
  let queue=Promise.resolve();let closed=false;
  const serialize=operation=>{const result=queue.then(()=>{if(closed)throw fail('SLOT_CLOSED');return operation();});queue=result.then(()=>{},()=>{});return result;};
  const authorize=async request=>{
    if(!request||Object.keys(request).some(key=>!['ticket',...fields,'assets','operationId','mode'].includes(key))||typeof request.ticket!=='string'||!/^[a-f0-9]{64,128}$/.test(request.ticket))throw fail('SLOT_DENIED');const slot=slots.get(request.slotId);
    if(!slot||!timingSafeEqual(Buffer.from(slot.ticketHash),Buffer.from(digest(Buffer.from(request.ticket))))||fields.filter(field=>!manifest.authoritySocketPath||field!=='leaseId').some(field=>slot[field]!==request[field])||slot.expiresAt<=Date.now())throw fail('SLOT_DENIED');
    if(manifest.authoritySocketPath){const pin=await workspaceRoot(slot,manifest.apiUid);if(pin.dev!==slot.rootDev||pin.ino!==slot.rootIno)throw fail('SLOT_ROOT_REPLACED');const binding=await jsonRequest(manifest.authoritySocketPath,'/v1/slot-binding',{slotId:slot.slotId});if(fields.some(field=>binding[field]!==request[field])||typeof binding.proof!=='string'||binding.state!=='active')throw fail('SLOT_AUTHORITY_INVALID');return {slot:{...slot,leaseId:binding.leaseId},grant:binding};}
    const rootPin=await workspaceRoot(slot,manifest.apiUid);if(rootPin.dev!==slot.rootDev||rootPin.ino!==slot.rootIno)throw fail('SLOT_ROOT_REPLACED');
    const grant=await jsonRequest(manifest.issuerSocketPath,'/v1/grant',{ticket:slot.brokerTicket,userId:slot.userId,root:slot.root,workspaceId:slot.workspaceId,generation:slot.generation,leaseId:slot.leaseId,sessionId:slot.sessionId,bindingEpoch:slot.bindingEpoch,profileId:slot.profileId,permission:'status'});
    if(!grant||fields.filter(field=>['workspaceId','generation','leaseId','sessionId','bindingEpoch','profileId'].includes(field)).some(field=>slot[field]!==grant[field])||!Number.isSafeInteger(grant.expiresAt)||grant.expiresAt<=Date.now())throw fail('SLOT_AUTHORITY_INVALID');
    return {slot,grant};
  };
  const readPreparation=slot=>database.prepare('SELECT * FROM preparation WHERE slot=?').get(slot.slotId);
  const verifySealed=async(slot,row)=>{
    if(!row||row.state!=='sealed')throw fail('SLOT_PREPARATION_UNCERTAIN');const value=JSON.parse(row.value);
    for(const [index,asset] of slot.assetFiles.entries()) {const bytes=await fileSnapshot(asset.source,asset);if(digest(bytes)!==value.hashes[index])throw fail('SLOT_SNAPSHOT_CHANGED');}
    for(const file of [...slot.codeFiles,...slot.credentialFiles])if(await fileDigest(file.source,file)!==file.sha256)throw fail('SLOT_IMMUTABLE_SOURCE_CHANGED');
    return value;
  };
  return {
    prepare(request) {return serialize(async()=>{
      const {slot}=await authorize(request);if(!Array.isArray(request.assets)||request.assets.length>slot.assetFiles.length)throw fail('SLOT_ASSET_LIMIT');let total=0;const originals=new Set();
      const assets=request.assets.map((asset,index)=>{if(!asset||Object.keys(asset).some(key=>!['originalPath','sha256','bytes'].includes(key))||typeof asset.originalPath!=='string'||asset.originalPath.length>4096||/[\0\r\n]/.test(asset.originalPath)||originals.has(asset.originalPath)||typeof asset.bytes!=='string'||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(asset.bytes)||!/^[a-f0-9]{64}$/.test(asset.sha256))throw fail('SLOT_ASSET_INVALID');originals.add(asset.originalPath);const bytes=Buffer.from(asset.bytes,'base64');total+=bytes.length;if(bytes.length>25*1024*1024||total>32*1024*1024||digest(bytes)!==asset.sha256)throw fail('SLOT_ASSET_DIGEST');return {originalPath:asset.originalPath,sha256:asset.sha256,target:slot.assetFiles[index].target,bytes};});
      const fingerprint=hash(assets.map(({originalPath,sha256,target})=>({originalPath,sha256,target})));let row=readPreparation(slot);
      if(row){if(row.fingerprint!==fingerprint)throw fail('SLOT_ALREADY_SEALED');const value=await verifySealed(slot,row);const witness=await privateJson(path.join(manifest.witnessDirectory,slot.slotId+'.json'),16384);if(witness.slotId!==slot.slotId||witness.fingerprint!==fingerprint||witness.prepared!==true)throw fail('SLOT_PREPARATION_UNCERTAIN');return {version:1,slotId:slot.slotId,profileId:slot.profileId,assets:value.assets,prepared:true};}
      const hashes=slot.assetFiles.map((_,index)=>assets[index]?.sha256??digest(Buffer.alloc(0)));const value={assets:assets.map(({originalPath,sha256,target})=>({originalPath,sha256,target})),hashes};
      // Durable uncertainty precedes even the first file write. On an interrupted
      // preparation a trusted operator reconciles; API retries cannot change it.
      database.prepare('INSERT INTO preparation VALUES(?,?,?,?)').run(slot.slotId,fingerprint,'pending',JSON.stringify(value));
      for(const [index,asset] of slot.assetFiles.entries()) {
        const pin=await canonical(asset.source,'file');if(pin.dev!==asset.dev||pin.ino!==asset.ino)throw fail('SLOT_SOURCE_REPLACED');const handle=await open(asset.source,constants.O_WRONLY|constants.O_NOFOLLOW);
        try{const actual=await handle.stat({bigint:true});if(actual.dev.toString()!==asset.dev||actual.ino.toString()!==asset.ino||actual.nlink!==1n)throw fail('SLOT_SOURCE_REPLACED');await handle.truncate(0);await handle.writeFile(assets[index]?.bytes??Buffer.alloc(0));await handle.sync();}finally{await handle.close();}
      }
      await verifySealed(slot,{state:'sealed',value:JSON.stringify(value)});
      database.prepare('UPDATE preparation SET state=? WHERE slot=?').run('sealed',slot.slotId);
      const witness={version:1,active:true,prepared:true,...Object.fromEntries(fields.map(field=>[field,slot[field]])),fingerprint,expiresAt:slot.expiresAt};
      const witnessFile=path.join(manifest.witnessDirectory,slot.slotId+'.json');const temporary=witnessFile+'.pending';const handle=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o640);
      try{await handle.writeFile(JSON.stringify(witness)+'\n');await handle.sync();}finally{await handle.close();}await rename(temporary,witnessFile);const parent=await open(manifest.witnessDirectory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{if(process.platform!=='win32')await parent.sync();}finally{await parent.close();}
      row=readPreparation(slot);await verifySealed(slot,row);
      return {version:1,slotId:slot.slotId,profileId:slot.profileId,assets:value.assets,prepared:true};
    });},
    finish(request) {return serialize(async()=>{
      const {slot,grant}=await authorize(request);await verifySealed(slot,readPreparation(slot));
      if(!['publish','discard','retain'].includes(request.mode))throw fail('SLOT_FINISH_INVALID');
      if(request.mode==='retain'||!request.operationId)return {retained:true,sealed:true};
      if(!id(request.operationId))throw fail('SLOT_FINISH_INVALID');const receipt=await jsonRequest(manifest.brokerSocketPath,'/v1/status',{operationId:request.operationId},grant.proof);
      if(!receipt||receipt.operationId!==request.operationId||receipt.workspaceId!==slot.workspaceId||receipt.generation!==slot.generation||receipt.leaseId!==slot.leaseId||receipt.profileId!==slot.profileId||receipt.kind!=='run'||receipt.cleanupConfirmed!==true||!/^[a-f0-9]{64}$/.test(receipt.resourceId))throw fail('SLOT_CLEANUP_UNCONFIRMED');
      // Slot stays sealed permanently for this lease, even after confirmed removal.
      return {retained:false,sealed:true,operationId:receipt.operationId,resourceId:receipt.resourceId};
    });},
    async close(){await queue;if(closed)return;closed=true;database.close();lock.exec('ROLLBACK');lock.close();},
  };
}
export async function createProviderSlotServer(supervisor,options) {
  if(process.platform!=='win32'){await canonical(path.dirname(options.socketPath));try{await lstat(options.socketPath);throw fail('SLOT_SOCKET_EXISTS');}catch(error){if(error.code!=='ENOENT')throw error;}}
  const server=createServer(async(request,response)=>{let sent=false;const finish=(status,body)=>{if(sent)return;sent=true;response.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});response.end(JSON.stringify(body));};try{
    if(request.method!=='POST'||!['/v1/prepare','/v1/finish'].includes(request.url)||request.headers['content-type']!=='application/json')throw fail('SLOT_DENIED');const chunks=[];let length=0;for await(const chunk of request){length+=chunk.length;if(length>46*1024*1024)throw fail('SLOT_REQUEST_LIMIT');chunks.push(Buffer.from(chunk));}const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));finish(200,await supervisor[request.url==='/v1/prepare'?'prepare':'finish'](body));
  }catch{finish(403,{error:'SLOT_DENIED'});}});server.requestTimeout=15000;server.headersTimeout=5000;server.maxConnections=8;server.on('clientError',(_error,socket)=>socket.destroy());await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(options.socketPath,resolve);});
  let pin;if(process.platform!=='win32'){if(options.clientGroupId!==undefined)await chown(options.socketPath,process.getuid(),options.clientGroupId);await chmod(options.socketPath,options.clientGroupId===undefined?0o600:0o660);pin=await lstat(options.socketPath);}
  return {async close(){server.closeAllConnections();await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));if(pin){const actual=await lstat(options.socketPath).catch(()=>undefined);if(actual?.isSocket()&&actual.dev===pin.dev&&actual.ino===pin.ino)await unlink(options.socketPath);}}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){if(process.platform!=='linux'||process.getuid()!==0)throw fail('SLOT_ROOT_SERVICE_REQUIRED');process.umask(0o027);const manifest=await privateJson(process.argv[2]);const supervisor=await createProviderSlotSupervisor(manifest);const server=await createProviderSlotServer(supervisor,manifest);const stop=async()=>{await server.close();await supervisor.close();};process.once('SIGTERM',()=>void stop());process.once('SIGINT',()=>void stop());console.log(JSON.stringify({event:'provider-slot-listening',version:1}));}
