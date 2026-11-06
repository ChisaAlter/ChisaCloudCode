import { createHash } from 'node:crypto';
import { chownSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { chmod, chown, mkdir, open, readdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { AppError } from '@/shared/index.js';

import { isolatedSessionObjects } from './session-objects.service.js';

const stagedWriters = new Set<string>();
function invalid(message: string) { return new AppError(message,{ code: 'WORKSPACE_GIT_PUBLICATION_REQUIRED',statusCode: 409 }); }
function canonical(filename: string, directory: boolean, allowLinked = false) {
  if (path.resolve(filename)!==filename || realpathSync(filename)!==filename) throw invalid('Git staging requires canonical regular files and directories');
  let component=path.parse(filename).root;
  for (const part of filename.slice(component.length).split(path.sep)) {
    component=path.join(component,part);
    if (lstatSync(component).isSymbolicLink()) throw invalid('Git staging parent is redirected');
  }
  const value = lstatSync(filename);
  if ((directory ? !value.isDirectory() : !value.isFile() || (!allowLinked && value.nlink!==1))) throw invalid('Git staging requires single-link regular metadata');
  return value;
}
function digest(bytes: Buffer) { return createHash('sha256').update(bytes).digest('hex'); }
async function syncDirectory(folder: string) {
  if (process.platform==='win32') return;
  const handle = await open(folder,'r'); try { await handle.sync(); } finally { await handle.close(); }
}
async function atomic(filename: string, bytes: Buffer) {
  canonical(path.dirname(filename),true);
  const temporary = filename+'.broker-publication.tmp';
  const handle = await open(temporary,'wx',0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary,filename); await syncDirectory(path.dirname(filename));
}
async function snapshot(root: string, allow: (name: string) => boolean, budget = { bytes: 0,files: 0 }, allowLinked = false) {
  canonical(root,true); const result = new Map<string,Buffer>();
  const visit = async (folder: string,relative: string) => {
    for (const name of (await readdir(folder)).sort()) {
      const key = relative ? relative+'/'+name : name;
      if (!allow(key)) continue;
      const filename = path.join(folder,name); const stats = lstatSync(filename);
      if (stats.isSymbolicLink()) throw invalid('Git metadata cannot contain redirected staging entries');
      if (stats.isDirectory()) await visit(filename,key);
      else {
        canonical(filename,false,allowLinked);
        budget.files++; budget.bytes+=stats.size;
        if (budget.files>100000 || budget.bytes>512*1024*1024 || stats.size>128*1024*1024) throw invalid('Git staging exceeds its bounded snapshot budget');
        const before = lstatSync(filename); const bytes = await readFile(filename); const after = lstatSync(filename);
        if (before.dev!==after.dev || before.ino!==after.ino || before.size!==after.size || before.mtimeMs!==after.mtimeMs || before.ctimeMs!==after.ctimeMs) throw invalid('Git metadata changed while staging');
        result.set(key,bytes);
      }
    }
  };
  await visit(root,''); return result;
}
async function replaceContents(root: string, files: Map<string,Buffer>) {
  canonical(root,true);
  // Only the exact dedicated staging leaf is cleared, never user/project data.
  for (const name of await readdir(root)) {
    const target = path.resolve(root,name);
    if (path.dirname(target)!==root) throw invalid('Invalid staging entry');
    await rm(target,{ recursive: true,force: true });
  }
  for (const [relative,bytes] of files) {
    const filename = path.join(root,...relative.split('/'));
    await mkdir(path.dirname(filename),{ recursive: true }); await writeFile(filename,bytes,{ mode: 0o600 });
  }
}
function sameFiles(left: Map<string,Buffer>,right: Map<string,Buffer>) {
  return left.size===right.size && [...left].every(([name,bytes]) => right.get(name)?.equals(bytes));
}
function allowedMetadata(name: string) {
  if (name.endsWith('.lock')) throw invalid('Git is changing metadata; finish the operation before staging');
  return /^(?:HEAD|index|config|packed-refs|shallow|ORIG_HEAD|FETCH_HEAD|MERGE_HEAD|MERGE_MSG|AUTO_MERGE|COMMIT_EDITMSG|description|sharedindex\.[a-f0-9]+)$/.test(name) || /^(?:refs|logs)(?:\/|$)/.test(name);
}
function managedMetadata(name: string) { return name==='HEAD' || name==='index' || name==='packed-refs' || /^(?:refs|logs)(?:\/|$)/.test(name); }

/** Workspace-bridge's real RPC/provider callers stage Git under an independent
 * protected parent. Broker profiles mount only stable operator-enrolled leaves;
 * task-controlled workspace .git paths never become daemon bind sources. Exact
 * cleanup precedes verified object publication and recoverable metadata CAS. */
async function stageWorkspaceBrokerGitRuntime(input: { root: string; sourceRoot?: string; branch?: string; leaseDirectory: string; readOnly: boolean }) {
  const marker = path.join(input.root,'.git'); if (!existsSync(marker)) return undefined;
  const common = path.join(input.sourceRoot ?? input.root,'.git'); canonical(common,true);
  const leasePath = path.join(input.leaseDirectory,'state.json'); canonical(input.leaseDirectory,true);
  const lease = JSON.parse(readFileSync(leasePath,'utf8')) as { id?: string;epoch?: string;owner?: string };
  if (!lease.id || !lease.epoch || lease.owner!=='claude' || input.leaseDirectory!==input.root+'.chisa-lease') throw invalid('Git staging requires the exact admitted writer lease');
  let originalGit = common;
  if (input.branch) {
    const pointer = readFileSync(marker,'utf8').trim(); if (!pointer.startsWith('gitdir: ')) throw invalid('Session Git pointer changed');
    originalGit = realpathSync(path.resolve(input.root,pointer.slice(8)));
    if (path.dirname(originalGit)!==path.join(common,'worktrees') || realpathSync(path.resolve(originalGit,readFileSync(path.join(originalGit,'commondir'),'utf8').trim()))!==common ||
      realpathSync(path.resolve(originalGit,readFileSync(path.join(originalGit,'gitdir'),'utf8').trim()))!==marker || readFileSync(path.join(originalGit,'HEAD'),'utf8').trim()!=='ref: refs/heads/'+input.branch) throw invalid('Session Git identity changed before staging');
  }
  const state = input.root+'.chisa-state';
  if (existsSync(state)) canonical(state,true);
  else { canonical(path.dirname(state),true); mkdirSync(state,{ mode: 0o700 }); }
  canonical(state,true);
  const stage = path.join(state,'broker-git');
  if (!existsSync(stage)) mkdirSync(stage,{ mode: 0o700 });
  canonical(stage,true);
  const staging = path.join(stage,'private'); const base = path.join(stage,'base');
  for (const folder of [staging,base]) { if (!existsSync(folder)) mkdirSync(folder,{ mode: 0o755 }); canonical(folder,true); }
  // The supervisor/operator must enroll these fixed paths before first use. The
  // mount parent remains API/operator-owned; only private leaf receives sandbox writes.
  if (process.platform!=='win32' && process.getuid?.()===0) chownSync(staging,1000,1000);
  const pins = [input.root,common,originalGit,input.leaseDirectory,state,stage,staging,base].map(filename => { const stats=canonical(filename,true); return { filename,dev: stats.dev,ino: stats.ino }; });
  const assertPinned = () => {
    for (const original of pins) { const current=canonical(original.filename,true); if (current.dev!==original.dev || current.ino!==original.ino) throw invalid('Git publication root or enrolled staging inode changed'); }
    const current=JSON.parse(readFileSync(leasePath,'utf8')) as typeof lease;
    if (current.id!==lease.id || current.epoch!==lease.epoch || current.owner!==lease.owner) throw invalid('Git publication lease changed');
  };
  const journalPath = path.join(stage,'publication.json');
  const publicationPaths = (name: string) => input.branch ? name==='HEAD' || name==='index' || /^(?:logs\/HEAD)$/.test(name) : managedMetadata(name);
  const destination = (name: string) => name.startsWith('common/') ? path.join(common,...name.slice(7).split('/')) : path.join(originalGit,...name.split('/'));
  const recover = async (journal: { version: number; leaseId: string; bindingEpoch: string; files: Array<{ name: string; before: string|null; after: string|null }> }) => {
    if (journal.version!==1 || journal.leaseId!==lease.id || journal.bindingEpoch!==lease.epoch || !Array.isArray(journal.files)) throw invalid('Recover the prior exact Git publication before starting another writer');
    for (const file of journal.files) {
      if (!file || typeof file.name!=='string' || file.name.includes('..') || (!publicationPaths(file.name) && !(input.branch && file.name.startsWith('common/') && /^(?:refs|logs)\//.test(file.name.slice(7))))) throw invalid('Git publication journal contains an unexpected path');
      const target=destination(file.name); const current=existsSync(target) ? digest(await readFile(target)) : null;
      if (current!==file.before && current!==file.after) throw invalid('Git metadata changed before recoverable publication');
    }
    const held: Array<{ target: string; lock: string; handle: Awaited<ReturnType<typeof open>>; dev: number; ino: number }> = [];
    try {
      // Honor Git's own lock convention for every publication target. A foreign
      // lock is never removed; a partial multi-file commit remains journaled.
      for (const file of [...journal.files].sort((a,b) => a.name.localeCompare(b.name))) {
        const target=destination(file.name); await mkdir(path.dirname(target),{ recursive: true }); canonical(path.dirname(target),true);
        const lock=target+'.lock'; const handle=await open(lock,'wx',0o600); const stats=await handle.stat(); held.push({ target,lock,handle,dev: stats.dev,ino: stats.ino });
      }
      for (const file of journal.files) {
        assertPinned(); const target=destination(file.name); const current=existsSync(target) ? digest(await readFile(target)) : null;
        if (current===file.after) continue;
        if (current!==file.before) throw invalid('Git metadata changed while acquiring publication locks');
        const reservation=held.find(item => item.target===target)!;
        if (file.after===null) { await unlink(target); await syncDirectory(path.dirname(target)); }
        else {
          const bytes=await readFile(path.join(stage,'publication-files',...file.name.split('/')));
          if (digest(bytes)!==file.after) throw invalid('Retained publication bytes changed');
          await reservation.handle.writeFile(bytes); await reservation.handle.sync(); await reservation.handle.close();
          const named=lstatSync(reservation.lock); if (named.dev!==reservation.dev || named.ino!==reservation.ino || named.isSymbolicLink()) throw invalid('Git publication lock changed');
          const latest=existsSync(target) ? digest(await readFile(target)) : null;
          if (latest!==file.before) throw invalid('Git publication target changed before commit');
          await rename(reservation.lock,target); await syncDirectory(path.dirname(target));
        }
      }
      await unlink(journalPath); await syncDirectory(stage);
    } finally {
      for (const reservation of held) {
        await reservation.handle.close().catch(() => {});
        if (existsSync(reservation.lock)) {
          const named=lstatSync(reservation.lock);
          if (named.dev===reservation.dev && named.ino===reservation.ino && !named.isSymbolicLink()) await unlink(reservation.lock);
        }
      }
    }
  };
  if (existsSync(journalPath)) await recover(JSON.parse(await readFile(journalPath,'utf8')));
  const metadata = await snapshot(originalGit,allowedMetadata);
  const commonMetadata = input.branch ? await snapshot(common,name => /^(?:refs|logs)(?:\/|$)/.test(name) || name==='packed-refs') : metadata;
  const staged = new Map(metadata);
  if (input.branch) for (const [name,bytes] of commonMetadata) staged.set(name,bytes);
  // Hooks, includes, alternates and task-rewritten commondir pointers never
  // escape the sandbox. Preserve repository object format and index semantics.
  const config = metadata.get('config') ?? (existsSync(path.join(common,'config')) ? await readFile(path.join(common,'config')) : Buffer.alloc(0));
  const format = /objectformat\s*=\s*sha256/i.test(config.toString()) ? '\n[extensions]\nobjectFormat = sha256\n' : '';
  staged.set('config',Buffer.from('[core]\nrepositoryformatversion = '+(format ? '1' : '0')+'\nbare = false\nhooksPath = /dev/null\nfsmonitor = false\n'+format));
  await replaceContents(staging,staged);
  if (existsSync(path.join(common,'objects','info','alternates'))) throw invalid('Git alternates require a separately verified mapping');
  const objectFiles = await snapshot(path.join(common,'objects'),name => !name.startsWith('info/alternates'),{ bytes: 0,files: 0 },true);
  await replaceContents(base,objectFiles);
  for (const [folder,writable] of [[staging,true],[base,false]] as const) {
    const permissions = async (filename: string) => {
      const stats=canonical(filename,lstatSync(filename).isDirectory());
      if (process.platform!=='win32') {
        await chmod(filename,stats.isDirectory() ? 0o755 : writable ? 0o600 : 0o644);
        if (writable && process.getuid?.()===0) await chown(filename,1000,1000);
      }
      if (stats.isDirectory()) for (const name of await readdir(filename)) await permissions(path.join(filename,name));
    };
    await permissions(folder);
  }
  if (!sameFiles(metadata,await snapshot(originalGit,allowedMetadata)) || (input.branch && !sameFiles(commonMetadata,await snapshot(common,name => /^(?:refs|logs)(?:\/|$)/.test(name) || name==='packed-refs')))) throw invalid('Git metadata changed while staging its exact snapshot');
  assertPinned();
  const objects = isolatedSessionObjects(common,stage,assertPinned);
  const privateObjects = objects.directory;
  if (process.platform!=='win32' && process.getuid?.()===0) for (const folder of [privateObjects,path.join(privateObjects,'info'),path.join(privateObjects,'pack')]) chownSync(folder,1000,1000);
  const args = ['--volume',`${staging}:/runtime/git/private:${input.readOnly ? 'ro' : 'rw'}`,'--volume',`${base}:/runtime/git/base:ro`,'--volume',`${privateObjects}:/runtime/git/objects:${input.readOnly ? 'ro' : 'rw'}`,
    '--volume',`${staging}:/workspace/.git:${input.readOnly ? 'ro' : 'rw'}`];
  return { mounts: args,environment: { GIT_DIR: '/runtime/git/private',GIT_COMMON_DIR: '/runtime/git/private',GIT_WORK_TREE: '/workspace',GIT_OBJECT_DIRECTORY: '/runtime/git/objects',GIT_ALTERNATE_OBJECT_DIRECTORIES: '/runtime/git/base',GIT_CONFIG_NOSYSTEM: '1',GIT_CONFIG_GLOBAL: '/dev/null' },
    async publish() {
      assertPinned();
      if (!sameFiles(metadata,await snapshot(originalGit,allowedMetadata)) || (input.branch && !sameFiles(commonMetadata,await snapshot(common,name => /^(?:refs|logs)(?:\/|$)/.test(name) || name==='packed-refs')))) throw invalid('Original Git metadata changed before publication');
      const after=await snapshot(staging,allowedMetadata);
      if (input.branch && after.get('HEAD')?.toString().trim()!=='ref: refs/heads/'+input.branch) throw invalid('Isolated task changed its private branch');
      if (input.branch) for (const [name,bytes] of after) if (/^(?:refs|logs)\//.test(name) && name!=='logs/HEAD' && name!=='refs/heads/'+input.branch && name!=='logs/refs/heads/'+input.branch && !commonMetadata.get(name)?.equals(bytes)) throw invalid('Isolated task attempted to publish another Git ref');
      await objects.publish();
      // The immutable object verifier is phase one. Persist exact before/after
      // metadata and bytes before any ref/index publication for crash recovery.
      const changes: Array<{ name: string;before: string|null;after: string|null }> = [];
      const plan = new Map<string,Buffer>();
      const add = (name: string,before: Buffer|undefined,bytes: Buffer|undefined) => { if (before?.equals(bytes ?? Buffer.alloc(0)) && bytes!==undefined) return; if (!before && !bytes) return; changes.push({ name,before: before ? digest(before) : null,after: bytes ? digest(bytes) : null }); if (bytes) plan.set(name,bytes); };
      for (const name of new Set([...metadata.keys(),...after.keys()])) if (publicationPaths(name)) add(name,metadata.get(name),after.get(name));
      if (input.branch) for (const name of ['refs/heads/'+input.branch,'logs/refs/heads/'+input.branch]) add('common/'+name,commonMetadata.get(name),after.get(name));
      const retained=path.join(stage,'publication-files'); mkdirSync(retained,{ recursive: true,mode: 0o700 }); await replaceContents(retained,plan);
      // Bytes are fsynced before the journal can authorize a recovery commit.
      for (const name of plan.keys()) { const handle=await open(path.join(retained,...name.split('/')),'r+'); try { await handle.sync(); } finally { await handle.close(); } }
      await syncDirectory(retained); const journal={ version: 1,leaseId: lease.id!,bindingEpoch: lease.epoch!,files: changes };
      await atomic(journalPath,Buffer.from(JSON.stringify(journal))); await recover(journal);
    },
  };
}

/** The bridge's RPC/provider launcher serializes the exact stable Git staging
 * slot until daemon cleanup and publication finish. A cleanup failure retains
 * both the persistent writer fence and this in-process slot reservation. */
export async function prepareWorkspaceBrokerGitRuntime(input: Parameters<typeof stageWorkspaceBrokerGitRuntime>[0]) {
  if (!existsSync(path.join(input.root,'.git'))) return undefined;
  if (stagedWriters.has(input.root)) throw new AppError('Another admitted sandbox still owns the Git staging slot', { code: 'WORKSPACE_BUSY', statusCode: 409 });
  stagedWriters.add(input.root);
  try {
    const runtime = await stageWorkspaceBrokerGitRuntime(input);
    if (!runtime) { stagedWriters.delete(input.root); return undefined; }
    return { ...runtime,close() { stagedWriters.delete(input.root); } };
  } catch (error) { stagedWriters.delete(input.root); throw error; }
}
