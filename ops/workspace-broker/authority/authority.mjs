#!/usr/bin/env node
import { createHash,createPrivateKey,createPublicKey,randomUUID,sign,timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod,lstat,mkdir,open,realpath,unlink } from 'node:fs/promises';
import { createServer,request as httpRequest } from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const fault=code=>Object.assign(new Error(code),{code});
const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const sha=value=>createHash('sha256').update(value).digest('hex');
const selectorFields=['userId','root','workspaceId','generation','bindingEpoch','sessionId'];
const peerFields=['pid','uid','gid','processStartTime','bootId','pidNamespace'];
const samePeer=(a,b)=>!!a&&!!b&&peerFields.every(field=>a[field]===b[field]);
const validPeer=peer=>peer&&Number.isSafeInteger(peer.pid)&&peer.pid>0&&Number.isSafeInteger(peer.uid)&&peer.uid>=0&&Number.isSafeInteger(peer.gid)&&peer.gid>=0&&/^\d+$/.test(peer.processStartTime)&&/^[a-f0-9-]{36}$/.test(peer.bootId)&&/^pid:\[\d+\]$/.test(peer.pidNamespace);
async function protectedPath(filename,kind='directory',privateOnly=false,leafWritable=false){
  if(!path.isAbsolute(filename)||path.resolve(filename)!==filename||await realpath(filename)!==filename)throw fault('AUTHORITY_PATH_INVALID');
  let current=filename;
  for(;;){const metadata=await lstat(current);const final=current===filename;const sticky=!final&&current===path.parse(current).root+'tmp'&&metadata.uid===0&&(metadata.mode&0o7777)===0o1777;
    if(metadata.isSymbolicLink()||(final&&kind==='file'?(!metadata.isFile()||metadata.nlink!==1):!metadata.isDirectory())&&final||!final&&!metadata.isDirectory())throw fault('AUTHORITY_PATH_INVALID');
    if(process.platform!=='win32'&&(!final||!leafWritable)&&(metadata.uid!==process.getuid()||((metadata.mode&(final&&privateOnly?0o077:0o022))!==0&&!sticky)))throw fault('AUTHORITY_PATH_UNTRUSTED');
    if(path.dirname(current)===current)break;current=path.dirname(current);
  }
  const metadata=await lstat(filename,{bigint:true});return{dev:metadata.dev.toString(),ino:metadata.ino.toString()};
}
async function workspaceRoot(entry,apiUid){
  const native=entry.nativeAccountGroupId!==undefined||entry.rootUid!==undefined;
  if(!native){const pin=await protectedPath(entry.root,'directory',false,true);const parent=await lstat(path.dirname(entry.root));if(process.platform!=='win32'&&(parent.mode&0o022)!==0)throw fault('AUTHORITY_NATIVE_NAMESPACE_REQUIRED');return pin;}
  if(!Number.isSafeInteger(entry.nativeAccountGroupId)||entry.nativeAccountGroupId<=0||!Number.isSafeInteger(entry.rootUid)||entry.rootUid<0||!Number.isSafeInteger(apiUid)||apiUid<=0||entry.rootUid===apiUid)throw fault('AUTHORITY_NATIVE_NAMESPACE_INVALID');
  if(!path.isAbsolute(entry.root)||path.resolve(entry.root)!==entry.root||await realpath(entry.root)!==entry.root)throw fault('AUTHORITY_PATH_INVALID');
  const parent=path.dirname(entry.root);if(parent===entry.root)throw fault('AUTHORITY_NATIVE_NAMESPACE_INVALID');
  await protectedPath(path.dirname(parent));
  const account=await lstat(parent);const leaf=await lstat(entry.root,{bigint:true});
  if(account.isSymbolicLink()||!account.isDirectory()||leaf.isSymbolicLink()||!leaf.isDirectory())throw fault('AUTHORITY_PATH_INVALID');
  if(process.platform!=='win32'&&(account.uid!==0||account.gid!==entry.nativeAccountGroupId||(account.mode&0o7777)!==0o1770||leaf.uid!==BigInt(entry.rootUid)))throw fault('AUTHORITY_NATIVE_NAMESPACE_INVALID');
  return{dev:leaf.dev.toString(),ino:leaf.ino.toString()};
}
async function jsonFile(filename,maximum=16384,privateOnly=false){await protectedPath(filename,'file',privateOnly);const handle=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);try{const before=await handle.stat();if(before.size>maximum)throw fault('AUTHORITY_FILE_LIMIT');const value=JSON.parse(await handle.readFile('utf8'));const after=await handle.stat();const named=await lstat(filename);if(before.dev!==named.dev||before.ino!==named.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw fault('AUTHORITY_FILE_CHANGED');return value;}finally{await handle.close();}}
async function brokerRequest(socketPath,proof,scope,route='/v1/quiesce'){return new Promise((resolve,reject)=>{const bytes=Buffer.from(JSON.stringify(scope));const request=httpRequest({socketPath,method:'POST',path:route,headers:{'Content-Type':'application/json','Content-Length':bytes.length,Authorization:'Bearer '+proof}},response=>{const chunks=[];let total=0;response.on('data',chunk=>{total+=chunk.length;if(total>1024*1024)response.destroy(fault('AUTHORITY_BROKER_LIMIT'));else chunks.push(Buffer.from(chunk));});response.once('error',reject);response.once('end',()=>{try{if(response.statusCode!==200)throw fault('AUTHORITY_CLEANUP_PENDING');resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch(error){reject(error);}});});const timer=setTimeout(()=>request.destroy(fault('AUTHORITY_BROKER_TIMEOUT')),20000);timer.unref();request.once('error',reject);request.once('close',()=>clearTimeout(timer));request.end(bytes);});}

/** Independent root authority owns every broker lease. The API supplies an
 * existing catalog selector and a legacy reservation label, never enrollment.
 * begin peer identity must come exclusively from the protected SO_PEERCRED front. */
export async function createWorkspaceLeaseAuthority(input){
  const config=structuredClone(input);
  if(config.version!==1||!id(config.audience)||!id(config.keyId)||!Array.isArray(config.entries)||!config.entries.length||!Number.isInteger(config.apiUid)||config.apiUid<0)throw fault('AUTHORITY_CONFIG_INVALID');
  const key=createPrivateKey(config.privateKey);if(key.asymmetricKeyType!=='ed25519')throw fault('AUTHORITY_KEY_INVALID');
  await mkdir(config.registryDirectory,{recursive:true,mode:0o700});await protectedPath(config.registryDirectory,'directory',true);
  if(config.preparedDirectory)await protectedPath(config.preparedDirectory);if(config.stopWitnessDirectory)await protectedPath(config.stopWitnessDirectory);
  for(const name of['authority.sqlite','lock.sqlite']){const target=path.join(config.registryDirectory,name);try{const handle=await open(target,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);await handle.sync();await handle.close();}catch(error){if(error.code!=='EEXIST')throw error;}await protectedPath(target,'file',true);}
  const lock=new DatabaseSync(path.join(config.registryDirectory,'lock.sqlite'));let database;const entries=new Map();const slots=new Map();
  try{lock.exec('PRAGMA busy_timeout=0;CREATE TABLE IF NOT EXISTS lock(id INTEGER);BEGIN EXCLUSIVE;');database=new DatabaseSync(path.join(config.registryDirectory,'authority.sqlite'));
    database.exec('PRAGMA synchronous=FULL;PRAGMA journal_mode=DELETE;CREATE TABLE IF NOT EXISTS metadata(id INTEGER PRIMARY KEY,value TEXT NOT NULL);CREATE TABLE IF NOT EXISTS leases(id TEXT PRIMARY KEY,entry TEXT NOT NULL,reservation TEXT NOT NULL,value TEXT NOT NULL,UNIQUE(entry,reservation));CREATE TABLE IF NOT EXISTS slots(id TEXT PRIMARY KEY,lease TEXT NOT NULL);CREATE TABLE IF NOT EXISTS preview_bases(operation TEXT PRIMARY KEY,base TEXT NOT NULL,lease TEXT NOT NULL);');
    const fingerprint=sha(JSON.stringify({...config,privateKey:createPublicKey(key).export({type:'spki',format:'pem'}).toString()}));const saved=database.prepare('SELECT value FROM metadata WHERE id=1').get();if(saved&&saved.value!==fingerprint)throw fault('AUTHORITY_MANIFEST_CHANGED');database.prepare('INSERT OR IGNORE INTO metadata VALUES(1,?)').run(fingerprint);
    for(const entry of config.entries){if(!entry||!id(entry.id)||entries.has(entry.id)||!/^[a-f0-9]{64}$/.test(entry.ticketHash)||selectorFields.filter(field=>field!=='root').some(field=>!id(entry[field]))||!id(entry.ownerId)||!Number.isSafeInteger(entry.expiresAt)||!Array.isArray(entry.permissions)||!entry.permissions.every(id)||!Array.isArray(entry.slots)||(entry.maintenance!==undefined&&entry.maintenance!==true)||(!entry.maintenance&&!entry.slots.length)||(entry.maintenance&&(!id(entry.profileId)||entry.slots.length!==0||entry.permissions.some(permission=>!['network','retire','status'].includes(permission)))))throw fault('AUTHORITY_ENTRY_INVALID');const root=await workspaceRoot(entry,config.apiUid);if(root.dev!==String(entry.rootDev)||root.ino!==String(entry.rootIno))throw fault('AUTHORITY_ROOT_REPLACED');
      for(const slot of entry.slots){if(!id(slot.slotId)||!id(slot.profileId)||slots.has(slot.slotId)||(slot.profiles!==undefined&&(!Array.isArray(slot.profiles)||!slot.profiles.every(id)||!slot.profiles.includes(slot.profileId)))||(slot.preparedProfiles!==undefined&&(!Array.isArray(slot.preparedProfiles)||slot.preparedProfiles.some(profile=>!(slot.profiles??[slot.profileId]).includes(profile)))))throw fault('AUTHORITY_SLOT_INVALID');slots.set(slot.slotId,{entry,slot});}entries.set(entry.id,entry);
    }
  }catch(error){database?.close();lock.close();throw error;}
  let closed=false;let queue=Promise.resolve();
  const serialize=fn=>{const next=queue.then(()=>{if(closed)throw fault('AUTHORITY_CLOSED');return fn();});queue=next.then(()=>{},()=>{});return next;};
  const save=lease=>database.prepare('UPDATE leases SET value=? WHERE id=?').run(JSON.stringify(lease),lease.leaseId);
  const load=(entry,reservation)=>{const row=database.prepare('SELECT value FROM leases WHERE entry=? AND reservation=?').get(entry.id,reservation);return row?JSON.parse(row.value):undefined;};
  const byId=leaseId=>{const row=database.prepare('SELECT value FROM leases WHERE id=?').get(leaseId);return row?JSON.parse(row.value):undefined;};
  const entryFor=async request=>{
    if(!request||typeof request.ticket!=='string'||!/^[a-f0-9]{64,128}$/.test(request.ticket))throw fault('AUTHORITY_DENIED');const hashed=sha(request.ticket);const matches=[...entries.values()].filter(entry=>timingSafeEqual(Buffer.from(entry.ticketHash),Buffer.from(hashed)));
    if(matches.length!==1)throw fault('AUTHORITY_DENIED');const entry=matches[0];if(entry.expiresAt<=Date.now()||selectorFields.some(field=>request[field]!==undefined&&request[field]!==entry[field])||request.userId!==entry.userId||request.root!==entry.root||request.workspaceId!==entry.workspaceId||request.generation!==entry.generation)throw fault('AUTHORITY_DENIED');const pin=await workspaceRoot(entry,config.apiUid);if(pin.dev!==String(entry.rootDev)||pin.ino!==String(entry.rootIno))throw fault('AUTHORITY_ROOT_REPLACED');return entry;
  };
  const response=lease=>Object.fromEntries(['leaseId','legacyReservationId','slotId','profileId','state','ownerId',...selectorFields].map(field=>[field,lease[field]]));
  const signProof=(entry,lease,permission,profileId=lease.profileId,preparedExpiresAt=Infinity)=>{const now=Date.now();const claims={version:1,keyId:config.keyId,audience:config.audience,ownerId:entry.ownerId,workspaceId:entry.workspaceId,generation:entry.generation,leaseId:lease.leaseId,profiles:Array.isArray(profileId)?profileId:[profileId],permissions:[permission],issuedAt:now,expiresAt:Math.min(now+120000,entry.expiresAt,preparedExpiresAt),grantId:randomUUID()};if(claims.expiresAt<=now+1000)throw fault('AUTHORITY_AUTHORIZATION_EXPIRING');const payload=Buffer.from(JSON.stringify(claims)).toString('base64url');return{proof:payload+'.'+sign(null,Buffer.from(payload),key).toString('base64url'),expiresAt:claims.expiresAt,...response(lease),profileId};};
  const prepared=async(lease,profileId)=>{const selected=slots.get(lease.slotId)?.slot;if(!selected||selected.requirePrepared===false||!(selected.preparedProfiles??[selected.profileId]).includes(profileId))return Infinity;const witness=await jsonFile(path.join(config.preparedDirectory,lease.slotId+'.json'));if(witness.version!==1||witness.prepared!==true||witness.active!==true||!Number.isSafeInteger(witness.expiresAt)||witness.expiresAt<=Date.now()||['slotId','ownerId','leaseId',...selectorFields].some(field=>witness[field]!==lease[field])||witness.profileId!==selected.profileId||!/^[a-f0-9]{64}$/.test(witness.fingerprint))throw fault('AUTHORITY_SLOT_UNPREPARED');return witness.expiresAt;};
  const finish=async(entry,lease)=>{
    if(lease.state==='closed'){if(lease.receipt?.resourceInventoryComplete!==true)throw fault('AUTHORITY_CLEANUP_PENDING');return{...response(lease),...lease.receipt};}
    if(lease.state!=='stopping'){lease.state='stopping';lease.stoppingAt=Date.now();save(lease);}
    const scope={workspaceId:entry.workspaceId,generation:entry.generation,leaseId:lease.leaseId};const receipt=await brokerRequest(config.brokerSocketPath,signProof(entry,lease,'quiesce').proof,scope);
    if(!receipt||Object.entries(scope).some(([field,value])=>receipt[field]!==value)||receipt.quiescent!==true||receipt.cleanupConfirmed!==true||receipt.resourceInventoryComplete!==true||!Array.isArray(receipt.resources)||receipt.resources.some(resource=>!resource||!id(resource.operationId)||!/^[a-f0-9]{64}$/.test(resource.resourceId))||new Set(receipt.resources.map(resource=>resource.operationId)).size!==receipt.resources.length||!Number.isSafeInteger(receipt.closedAt)||!Number.isSafeInteger(receipt.confirmedAt)||receipt.closedAt<=0||receipt.closedAt>receipt.confirmedAt||receipt.confirmedAt>Date.now()+1000||!id(receipt.brokerInstanceId))throw fault('AUTHORITY_CLEANUP_PENDING');
    lease.state='closed';lease.closedAt=Date.now();lease.receipt=receipt;save(lease);return{...response(lease),...receipt,state:'closed'};
  };
  return{
    dispatch(route,request,observation){return serialize(async()=>{
      if(!observation||!validPeer(observation.peer)||observation.peer.uid!==config.apiUid||!request||Object.keys(request).some(field=>!['ticket',...selectorFields,'legacyReservationId','leaseId','slotId','profileId','permission','purpose','operationId'].includes(field)))throw fault('AUTHORITY_PEER_DENIED');
      const entry=await entryFor(request);const peer=observation.peer;
      if(route==='/v1/begin'){
        if(entry.maintenance){const maintenance={...Object.fromEntries(selectorFields.map(field=>[field,entry[field]])),ownerId:entry.ownerId,leaseId:'maintenance-'+entry.id,legacyReservationId:'maintenance',profileId:entry.profileId,state:'active'};return response(maintenance);}
        if(request.legacyReservationId===undefined){const current=database.prepare('SELECT value FROM leases WHERE entry=?').all(entry.id).map(row=>JSON.parse(row.value)).filter(lease=>lease.state!=='closed'&&samePeer(lease.peer,peer));if(current.length!==1)throw fault('AUTHORITY_ACTIVE_LEASE_REQUIRED');return response(current[0]);}
        if(!id(request.legacyReservationId))throw fault('AUTHORITY_RESERVATION_INVALID');const previous=load(entry,request.legacyReservationId);
        if(previous){if(!samePeer(previous.peer,peer))throw fault('AUTHORITY_PEER_CHANGED');return response(previous);}
        const active=database.prepare('SELECT value FROM leases').all().map(row=>JSON.parse(row.value)).find(lease=>lease.workspaceId===entry.workspaceId&&lease.state!=='closed');if(active)throw fault('AUTHORITY_WORKSPACE_BUSY');
        const slot=entry.slots.find(slot=>!database.prepare('SELECT 1 FROM slots WHERE id=?').get(slot.slotId));if(!slot)throw fault('AUTHORITY_SLOT_POOL_EXHAUSTED');
        const lease={...Object.fromEntries(selectorFields.map(field=>[field,entry[field]])),entryId:entry.id,ownerId:entry.ownerId,leaseId:randomUUID(),legacyReservationId:request.legacyReservationId,slotId:slot.slotId,profileId:slot.profileId,state:'active',peer,createdAt:Date.now()};
        database.exec('BEGIN IMMEDIATE');try{database.prepare('INSERT INTO leases VALUES(?,?,?,?)').run(lease.leaseId,entry.id,lease.legacyReservationId,JSON.stringify(lease));database.prepare('INSERT INTO slots VALUES(?,?)').run(slot.slotId,lease.leaseId);database.exec('COMMIT');}catch(error){database.exec('ROLLBACK');throw error;}return response(lease);
      }
      let lease=request.leaseId?byId(request.leaseId):load(entry,request.legacyReservationId);
      if(entry.maintenance)lease={...Object.fromEntries(selectorFields.map(field=>[field,entry[field]])),ownerId:entry.ownerId,leaseId:'maintenance-'+entry.id,legacyReservationId:'maintenance',profileId:entry.profileId,state:'active',peer};
      if(!lease||lease.entryId!==undefined&&lease.entryId!==entry.id||request.legacyReservationId!==undefined&&request.legacyReservationId!==lease.legacyReservationId||request.slotId!==undefined&&request.slotId!==lease.slotId)throw fault('AUTHORITY_MAPPING_INVALID');
      if(route==='/v1/lookup'){if(!samePeer(lease.peer,peer))throw fault('AUTHORITY_PEER_CHANGED');return response(lease);}
      if(route==='/v1/grant'){
        if(!samePeer(lease.peer,peer)||!entry.permissions.includes(request.permission)||!(slots.get(lease.slotId)?.slot.profiles??[lease.profileId]).includes(request.profileId)||entry.maintenance&&!['network','retire','status'].includes(request.permission))throw fault('AUTHORITY_DENIED');
        if(['run','exec','stdin'].includes(request.permission)&&lease.state!=='active')throw fault('AUTHORITY_LEASE_CLOSED');const preparedExpiresAt=['run','exec'].includes(request.permission)?await prepared(lease,request.profileId):Infinity;return signProof(entry,lease,request.permission,request.profileId,preparedExpiresAt);
      }
      if(!['/v1/end','/v1/release'].includes(route)||entry.maintenance)throw fault('AUTHORITY_ROUTE_DENIED');
      if(route==='/v1/end'){if(!samePeer(lease.peer,peer))throw fault('AUTHORITY_PEER_CHANGED');}
      else if(request.purpose==='live-writer-release'){if(!validPeer(observation.parent)||!samePeer(lease.peer,observation.parent))throw fault('AUTHORITY_LIVE_WRITER_MISMATCH');}
      else if(request.purpose==='legacy-writer-release'){
        const stopped=await jsonFile(path.join(config.stopWitnessDirectory,lease.leaseId+'.json'));if(stopped.version!==1||stopped.stopped!==true||stopped.leaseId!==lease.leaseId||stopped.legacyReservationId!==lease.legacyReservationId||!samePeer(stopped.writer,lease.peer)||!id(stopped.stopId)||stopped.root!==entry.root||stopped.bindingEpoch!==entry.bindingEpoch)throw fault('AUTHORITY_STOP_WITNESS_REQUIRED');
      }else throw fault('AUTHORITY_PURPOSE_DENIED');
      // Complete broker quiescence attests both the immutable resources present
      // and the absence of an operation that was reserved before dispatch.
      // Native stop evidence remains mandatory above, even for an empty list.
      return finish(entry,lease);
    });},
    authorizePreview(request,observation){return serialize(async()=>{
      const fields=['ticket',...selectorFields,'legacyReservationId','leaseId','operationId','base'];
      if(!request||Object.keys(request).length!==fields.length||fields.some(field=>!Object.hasOwn(request,field))||!validPeer(observation?.peer)||observation.peer.uid!==config.apiUid||!id(request.operationId)||!/^\/api\/workspace-runtime\/preview\/[a-f0-9]{64}\/$/.test(request.base))throw fault('AUTHORITY_PREVIEW_DENIED');
      const entry=await entryFor(request);const lease=byId(request.leaseId);
      if(!lease||lease.entryId!==entry.id||lease.state!=='active'||lease.legacyReservationId!==request.legacyReservationId||!samePeer(lease.peer,observation.peer))throw fault('AUTHORITY_PREVIEW_DENIED');
      const selected=slots.get(lease.slotId)?.slot;const permitted=selected?.profiles??[lease.profileId];
      if(!entry.permissions.includes('preview')||!entry.permissions.includes('status'))throw fault('AUTHORITY_PREVIEW_DENIED');
      const operation=await brokerRequest(config.brokerSocketPath,signProof(entry,lease,'status',permitted).proof,{operationId:request.operationId},'/v1/status');
      if(!operation||operation.operationId!==request.operationId||operation.workspaceId!==lease.workspaceId||operation.generation!==lease.generation||operation.leaseId!==lease.leaseId||operation.kind!=='run'||operation.state!=='running'||operation.cleanupConfirmed!==false||!permitted.includes(operation.profileId)||!/^[a-f0-9]{64}$/.test(operation.resourceId))throw fault('AUTHORITY_PREVIEW_OPERATION_INVALID');
      const key=JSON.stringify([lease.workspaceId,lease.generation,lease.leaseId,request.operationId]);const existing=database.prepare('SELECT base,lease FROM preview_bases WHERE operation=?').get(key);
      if(existing&&(existing.base!==request.base||existing.lease!==lease.leaseId))throw fault('AUTHORITY_PREVIEW_BASE_REBOUND');database.prepare('INSERT OR IGNORE INTO preview_bases VALUES(?,?,?)').run(key,request.base,lease.leaseId);
      const status=signProof(entry,lease,'status',operation.profileId);const preview=signProof(entry,lease,'preview',operation.profileId);
      return{version:1,...Object.fromEntries([...selectorFields,'legacyReservationId','leaseId','operationId','base'].map(field=>[field,request[field]])),ownerId:entry.ownerId,profileId:operation.profileId,expiresAt:Math.min(Date.now()+60000,status.expiresAt,preview.expiresAt),statusProof:status.proof,previewProof:preview.proof};
    });},
    slotBinding(slotId){return serialize(async()=>{const selected=slots.get(slotId);const used=database.prepare('SELECT lease FROM slots WHERE id=?').get(slotId);const lease=used&&byId(used.lease);if(!selected||!lease||lease.state!=='active')throw fault('AUTHORITY_SLOT_INACTIVE');return{...response(lease),ownerId:selected.entry.ownerId,provider:selected.slot.provider,proof:signProof(selected.entry,lease,'status').proof,expiresAt:Math.min(Date.now()+120000,selected.entry.expiresAt)};});},
    async close(){await queue;if(closed)return;closed=true;database.close();lock.exec('ROLLBACK');lock.close();},
  };
}

/** This socket is root-only. Only the SO_PEERCRED front and the independent slot
 * service may connect; public API identities never reach this trusted envelope. */
export async function createWorkspaceAuthorityPrivateServer(authority,options){
  if(process.platform!=='win32'){await protectedPath(path.dirname(options.socketPath));try{await lstat(options.socketPath);throw fault('AUTHORITY_SOCKET_EXISTS');}catch(error){if(error.code!=='ENOENT')throw error;}}
  const server=createServer(async(req,res)=>{try{const chunks=[];let length=0;for await(const chunk of req){length+=chunk.length;if(length>65536)throw fault('AUTHORITY_REQUEST_LIMIT');chunks.push(Buffer.from(chunk));}if(req.method!=='POST'||req.headers['content-type']!=='application/json')throw fault('AUTHORITY_ROUTE_DENIED');const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));const result=req.url==='/v1/slot-binding'?await authority.slotBinding(body.slotId):req.url==='/v1/preview-authorization'?await authority.authorizePreview(body.request,body.observation):await authority.dispatch(req.url,body.request,body.observation);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(result));}catch(error){res.writeHead(403,{'Content-Type':'application/json'});res.end(JSON.stringify({error:/^AUTHORITY_[A-Z_]+$/.test(error.code)?error.code:'AUTHORITY_UNAVAILABLE'}));}});server.requestTimeout=15000;server.headersTimeout=5000;server.maxConnections=32;server.on('clientError',(_error,socket)=>socket.destroy());await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(options.socketPath,resolve);});if(process.platform!=='win32')await chmod(options.socketPath,0o600);const pin=process.platform==='win32'?undefined:await lstat(options.socketPath);return{async close(){server.closeAllConnections();await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));if(pin){const named=await lstat(options.socketPath).catch(()=>undefined);if(named?.isSocket()&&named.dev===pin.dev&&named.ino===pin.ino)await unlink(options.socketPath);}}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){if(process.platform!=='linux'||process.getuid()!==0)throw fault('AUTHORITY_ROOT_REQUIRED');process.umask(0o077);const config=await jsonFile(process.argv[2],1024*1024,true);const authority=await createWorkspaceLeaseAuthority(config);const server=await createWorkspaceAuthorityPrivateServer(authority,{socketPath:config.privateSocketPath});const stop=async()=>{await server.close();await authority.close();};process.once('SIGTERM',()=>void stop());process.once('SIGINT',()=>void stop());console.log(JSON.stringify({event:'workspace-authority-listening',version:1}));}
