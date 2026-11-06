#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod,chown,lstat,mkdir,open,readdir,readFile,realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const fail=code=>Object.assign(new Error(code),{code});
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
async function trusted(filename,allowWorker=false) {
  if(!path.isAbsolute(filename)||path.resolve(filename)!==filename||await realpath(filename)!==filename)throw fail('SLOT_INSTALL_PATH');
  let current=filename;
  for(;;){const metadata=await lstat(current);const sticky=metadata.uid===0&&(metadata.mode&0o1000)!==0;
    if(metadata.isSymbolicLink()||(!metadata.isDirectory()&&(!metadata.isFile()||metadata.nlink!==1))||process.platform!=='win32'&&((current!==filename||!allowWorker)&&(metadata.uid!==process.getuid()||(!sticky&&(metadata.mode&0o022)!==0))))throw fail('SLOT_INSTALL_UNTRUSTED');
    if(path.dirname(current)===current)break;current=path.dirname(current);
  }
}
async function pin(source){const metadata=await lstat(source,{bigint:true});return{source,dev:metadata.dev.toString(),ino:metadata.ino.toString()};}
async function snapshot(source,target,files,budget,uid) {
  await trusted(source);const metadata=await lstat(source);
  if(metadata.isDirectory()){await mkdir(target,{mode:0o755});for(const entry of await readdir(source)){if(entry==='.git')continue;await snapshot(path.join(source,entry),path.join(target,entry),files,budget,uid);}if(uid!==undefined&&process.platform!=='win32')await chown(target,uid,uid);return;}
  budget.files++;budget.bytes+=metadata.size;if(budget.files>50000||metadata.size>512*1024*1024||budget.bytes>2*1024**3)throw fail('SLOT_INSTALL_BUDGET');
  const reader=await open(source,constants.O_RDONLY|constants.O_NOFOLLOW);const writer=await open(target,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);const checksum=createHash('sha256');
  try{const before=await reader.stat();if(before.dev!==metadata.dev||before.ino!==metadata.ino||before.nlink!==1||!before.isFile())throw fail('SLOT_INSTALL_SOURCE_CHANGED');for await(const chunk of reader.createReadStream({autoClose:false})){checksum.update(chunk);await writer.writeFile(chunk);}await writer.sync();const after=await reader.stat();const named=await lstat(source);if(before.dev!==named.dev||before.ino!==named.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw fail('SLOT_INSTALL_SOURCE_CHANGED');}
  finally{await reader.close();await writer.close();}
  await chmod(target,uid===undefined?(metadata.mode&0o111?0o755:0o644):0o600);if(uid!==undefined&&process.platform!=='win32')await chown(target,uid,uid);
  if(uid===undefined)files.push({...await pin(target),sha256:checksum.digest('hex')});
}
async function workerParents(home,target,uid) {
  const relative=path.relative(home,target);let current=home;
  for(const part of relative.split(path.sep)){if(!part)continue;current=path.join(current,part);try{await mkdir(current,{mode:0o755});}catch(error){if(error.code!=='EEXIST')throw error;}const metadata=await lstat(current);if(!metadata.isDirectory()||metadata.isSymbolicLink())throw fail('SLOT_INSTALL_HOME_PARENT');if(process.platform!=='win32')await chown(current,uid,uid);}
}
async function save(filename,value,mode=0o600){const handle=await open(filename,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,mode);try{await handle.writeFile(JSON.stringify(value,null,2)+'\n');await handle.sync();}finally{await handle.close();}}

/** Offline operator enrollment only. The API receives the readonly client fragment
 * and cannot execute this entry point or modify its protected slot namespace.
 * Runtime code is a prebuilt self-contained Node/worker/dependency tree; credential
 * imports are explicit root-selected snapshots, never API-supplied source paths. */
export async function enrollProviderSlot(spec) {
  const required=['slotId','provider','userId','ownerId','sessionId','workspaceId','generation','leaseId','bindingEpoch','profileId','witnessId'];
  if(spec.version!==1||required.some(field=>!id(spec[field]))||!['codex','cursor','opencode'].includes(spec.provider)||!Number.isSafeInteger(spec.expiresAt)||spec.expiresAt<=Date.now()||!Number.isInteger(spec.uid)||spec.uid<1000||spec.uid>65534||!Number.isInteger(spec.assetCount)||spec.assetCount<0||spec.assetCount>32||!/^[a-f0-9]{64,128}$/.test(spec.ticket)||!/^[a-f0-9]{64,128}$/.test(spec.brokerTicket)||!Array.isArray(spec.credentials)||!Array.isArray(spec.stateImports??[]))throw fail('SLOT_INSTALL_SPEC');
  await trusted(spec.root,true);await trusted(spec.slotParent);await trusted(spec.codeSource);const destination=path.join(spec.slotParent,spec.slotId);await mkdir(destination,{mode:0o755});
  // mkdir is exclusive and no cleanup occurs on uncertainty. A partial root is
  // operator-visible evidence, never a candidate that another API run can adopt.
  const budget={files:0,bytes:0};const codeFiles=[];const credentialFiles=[];const code=path.join(destination,'code');const home=spec.persistentHome??path.join(destination,'home');const assetsRoot=path.join(destination,'assets');const credentialRoot=path.join(destination,'credentials');
  await snapshot(spec.codeSource,code,codeFiles,budget);for(const filename of ['node','app/provider-process.worker.js']){const metadata=await lstat(path.join(code,filename));if(!metadata.isFile())throw fail('SLOT_INSTALL_CODE_INCOMPLETE');}
  const cli=spec.cliRelative;
  if(typeof cli!=='string'||!cli||cli.includes('..')||path.posix.isAbsolute(cli)||cli.includes('\\')||! (await lstat(path.join(code,cli))).isFile())throw fail('SLOT_INSTALL_CLI');
  if(spec.persistentHome!==undefined){await trusted(home,true);if(!home.startsWith(spec.slotParent+path.sep))throw fail('SLOT_INSTALL_PERSISTENT_HOME');await trusted(home+'.owner.json');const registration=JSON.parse(await readFile(home+'.owner.json','utf8'));if(['ownerId','userId','provider','sessionId','root','workspaceId'].some(field=>registration[field]!==spec[field]))throw fail('SLOT_INSTALL_HOME_OWNER');}
  else{await mkdir(home,{mode:0o755});await save(home+'.owner.json',Object.fromEntries(['ownerId','userId','provider','sessionId','root','workspaceId'].map(field=>[field,spec[field]])));}
  await mkdir(assetsRoot,{mode:0o755});await mkdir(credentialRoot,{mode:0o755});const mounts=[{source:home,target:'/runtime/provider-state/home',writable:true},{source:code,target:'/runtime/provider-code',writable:false}];
  // Only the leaf HOME is worker owned. Its source namespace parent remains root
  // protected so a worker cannot swap the broker's pinned source by rename.
  if(process.platform!=='win32')await chown(home,spec.uid,spec.uid);
  for(const imported of spec.stateImports??[]) {
    if(!imported||typeof imported.relativePath!=='string'||!imported.relativePath||imported.relativePath.split('/').some(part=>!part||part==='..'||part==='.')||imported.relativePath.includes('\\')||path.posix.isAbsolute(imported.relativePath))throw fail('SLOT_INSTALL_IMPORT');
    const target=path.join(home,imported.relativePath);await workerParents(home,path.dirname(target),spec.uid);await snapshot(imported.source,target,[],budget,spec.uid);
  }
  for(const [index,credential] of spec.credentials.entries()) {
    if(!credential||typeof credential.relativePath!=='string'||!credential.relativePath||credential.relativePath.split('/').some(part=>!part||part==='..'||part==='.')||credential.relativePath.includes('\\')||path.posix.isAbsolute(credential.relativePath))throw fail('SLOT_INSTALL_CREDENTIAL');
    const target=path.join(credentialRoot,'credential-'+index);await snapshot(credential.source,target,credentialFiles,budget);const homeTarget=path.join(home,credential.relativePath);await workerParents(home,path.dirname(homeTarget),spec.uid);let existing;try{existing=await lstat(homeTarget);}catch(error){if(error.code!=='ENOENT')throw error;}if(existing){if(existing.isSymbolicLink()||(!existing.isFile()&&!existing.isDirectory())||(existing.isFile()&&existing.nlink!==1))throw fail('SLOT_INSTALL_CREDENTIAL_TARGET');}else if((await lstat(target)).isDirectory())await mkdir(homeTarget,{mode:0o755});else{const placeholder=await open(homeTarget,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL,0o644);await placeholder.close();}
    mounts.push({source:target,target:'/runtime/provider-state/home/'+credential.relativePath,writable:false});
  }
  const assetFiles=[];
  for(let index=0;index<spec.assetCount;index++){const source=path.join(assetsRoot,'attachment-'+index);const handle=await open(source,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o644);await handle.sync();await handle.close();const target='/runtime/provider-assets/attachment-'+index;assetFiles.push({...await pin(source),target});mounts.push({source,target,writable:false});}
  const environment={HOME:'/runtime/provider-state/home',PATH:'/runtime/provider-code:/usr/local/bin:/usr/bin:/bin',TMPDIR:'/tmp',LANG:'C.UTF-8',...(spec.provider==='codex'?{CODEX_HOME:'/runtime/provider-state/home/.codex'}:{}),...(spec.provider==='opencode'?{XDG_DATA_HOME:'/runtime/provider-state/home/.local/share',XDG_CONFIG_HOME:'/runtime/provider-state/home/.config'}:{})};
  const rootPin=await pin(spec.root);const identity=Object.fromEntries(required.filter(field=>field!=='witnessId').map(field=>[field,spec[field]]));
  const publicSlot={version:1,...identity,root:spec.root,home,mounts,environment,command:'/runtime/provider-code/node',args:['/runtime/provider-code/app/provider-process.worker.js','--stdio'],cli:'/runtime/provider-code/'+cli,...(spec.executableSource?{executableSource:spec.executableSource}:{}),ticket:spec.ticket};
  const privateSlot={...publicSlot,ticket:undefined,ticketHash:digest(spec.ticket),brokerTicket:spec.brokerTicket,rootDev:rootPin.dev,rootIno:rootPin.ino,assetFiles,codeFiles,credentialFiles,expiresAt:spec.expiresAt};
  const brokerMounts=mounts.map(mount=>({rootId:spec.controlledRootId,relativePath:path.relative(spec.slotParent,mount.source).split(path.sep).join('/'),target:mount.target,readOnly:!mount.writable}));
  const issuerEntry={ticketHash:digest(spec.brokerTicket),ownerId:spec.ownerId,userId:spec.userId,root:spec.root,rootDev:rootPin.dev,rootIno:rootPin.ino,workspaceId:spec.workspaceId,generation:spec.generation,sessionId:spec.sessionId,leaseId:spec.leaseId,bindingEpoch:spec.bindingEpoch,witnessId:spec.witnessId,providerSlotId:spec.slotId,profiles:[spec.profileId],permissions:['status','run','exec','stdin','stream','cancel','reconcile','logs'],expiresAt:spec.expiresAt};
  await save(path.join(destination,'supervisor-slot.json'),privateSlot);await save(path.join(destination,'client-slot.json'),publicSlot,0o640);await save(path.join(destination,'broker-profile-mounts.json'),{id:spec.profileId,mounts:brokerMounts,environment});await save(path.join(destination,'bridge-profile.json'),{workspaceId:spec.workspaceId,generation:spec.generation,root:spec.root,profileId:spec.profileId,purpose:'provider',readOnly:spec.readOnly===true,runtimeMounts:mounts,gitMounts:spec.gitMounts??[],environment});await save(path.join(destination,'issuer-entry.json'),issuerEntry);
  const directory=await open(destination,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{if(process.platform!=='win32')await directory.sync();}finally{await directory.close();}
  return {slotRoot:destination,slot:publicSlot,privateSlot,issuerEntry};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){if(process.platform!=='linux'||process.getuid()!==0)throw fail('SLOT_INSTALL_ROOT_REQUIRED');process.umask(0o027);await trusted(process.argv[2]);const spec=JSON.parse(await readFile(process.argv[2],'utf8'));const result=await enrollProviderSlot(spec);console.log(JSON.stringify({event:'provider-slot-enrolled',slotId:result.slot.slotId,slotRoot:result.slotRoot}));}
