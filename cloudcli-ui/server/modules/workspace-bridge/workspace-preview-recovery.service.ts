import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import os from 'node:os';

import { AppError } from '@/shared/index.js';

// The runtime supplies account identity, never a caller-supplied cleanup verdict.
type RecoveryRequest = { userId: string; accountRoot: string; root: string; previewId: string };
type RecoveryReply = { ok?: boolean; released?: boolean; code?: string; error?: string };

const previewRecoveryScript = String.raw`
import datetime, errno, fcntl, hashlib, json, os, re, secrets, stat, subprocess, sys

class RecoveryError(Exception):
    def __init__(self,message,code='WORKSPACE_PREVIEW_RECOVERY_REQUIRED'):
        self.message,self.code=message,code
        super().__init__(message)
def fail(message,code='WORKSPACE_PREVIEW_RECOVERY_REQUIRED'): raise RecoveryError(message,code)
def same(a,b): return (a.st_dev,a.st_ino)==(b.st_dev,b.st_ino)
def text(value): return isinstance(value,str) and 0<len(value)<=256 and not any(c in value for c in '\x00\r\n')
def exists(parent,name):
    try: return os.stat(name,dir_fd=parent,follow_symlinks=False)
    except FileNotFoundError: return None
def regular(s,private=False):
    return stat.S_ISREG(s.st_mode) and s.st_nlink==1 and not s.st_mode&(0o077 if private else 0o022) and (not private or s.st_uid==os.getuid())
def read(parent,name,private=False):
    fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,dir_fd=parent)
    try:
        before=os.fstat(fd)
        if not regular(before,private) or before.st_size>65536: fail('Recovery metadata is not a bounded private regular file')
        with os.fdopen(fd,'rb',closefd=False) as stream: raw=stream.read(65537)
        after=os.fstat(fd); named=exists(parent,name)
        if len(raw)>65536 or named is None or not same(before,named) or (before.st_size,before.st_mtime_ns,before.st_ctime_ns)!=(after.st_size,after.st_mtime_ns,after.st_ctime_ns): fail('Recovery metadata changed during validation')
        value=json.loads(raw)
        if not isinstance(value,dict): fail('Recovery metadata must be an object')
        return value
    finally: os.close(fd)
def atomic(parent,name,value,previous,staging):
    temporary='.'+name+'.preview-'+secrets.token_hex(16)+'.tmp'
    fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600,dir_fd=staging)
    try:
        data=json.dumps(value,separators=(',',':'),sort_keys=True).encode()
        while data:
            count=os.write(fd,data)
            if count<=0: raise OSError('Metadata write did not advance')
            data=data[count:]
        os.fsync(fd)
    finally: os.close(fd)
    if read(parent,name)!=previous: fail('Recovery state changed before commit')
    os.replace(temporary,name,src_dir_fd=staging,dst_dir_fd=parent); os.fsync(parent)
    if parent!=staging: os.fsync(staging)
def validate_lease(value):
    if not isinstance(value,dict) or value.get('owner')!='claude' or value.get('writerGate') is not True or not text(value.get('id')) or not text(value.get('epoch')) or type(value.get('pid')) is not int or not 0<value['pid']<=2147483647 or not isinstance(value.get('processStartTime'),str) or not re.fullmatch(r'[0-9]+',value['processStartTime']) or not isinstance(value.get('bootId'),str) or not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}',value['bootId']): fail('Recovery requires an exact enrolled cloud lease and Linux birth identity')
    if 'mayWrite' in value and type(value['mayWrite']) is not bool: fail('Lease write state is invalid')
    for key in ('previews','cleanupPending'):
        values=value.get(key,[])
        if not isinstance(values,list) or any(not text(item) for item in values) or len(set(values))!=len(values): fail('Lease cleanup inventory is invalid')
    if 'integrationOperation' in value: fail('Integration reservation cannot be recovered as a preview')
def stopped(lease):
    with open('/proc/sys/kernel/random/boot_id') as stream: boot=stream.read().strip()
    if not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}',boot): fail('Current Linux boot identity cannot be verified')
    if boot!=lease['bootId']: return
    try:
        with open('/proc/'+str(lease['pid'])+'/stat') as stream: fields=stream.read().rsplit(')',1)[1].split()
    except FileNotFoundError:
        try: os.kill(lease['pid'],0)
        except ProcessLookupError: return
        fail('Lease process absence is not confirmed','WORKSPACE_BUSY')
    if len(fields)<=19 or not re.fullmatch(r'[0-9]+',fields[19]): fail('Lease process birth cannot be verified')
    if fields[0] in ('Z','X') or fields[19]!=lease['processStartTime']: return
    fail('The exact lease process is still alive','WORKSPACE_BUSY')
def absent_container(filter_value):
    result=subprocess.run(['docker','ps','--all','--filter',filter_value,'--format','{{.Names}}'],capture_output=True,text=True,timeout=2)
    if result.returncode!=0 or len(result.stdout)>65536 or len(result.stderr)>65536: fail('Docker absence could not be confirmed','WORKSPACE_CLEANUP_FAILED')
    if result.stdout.strip(): fail('Workspace containers are still reserved','WORKSPACE_CLEANUP_FAILED')
def operate(q):
    if not isinstance(q,dict): fail('Invalid recovery request')
    root,account,home,preview,user=[q.get(key) for key in ('root','accountRoot','home','previewId','userId')]
    if not text(user) or not isinstance(preview,str): fail('Invalid runtime preview identity')
    for location in (root,account,home):
        if not isinstance(location,str) or not location.startswith('/') or location=='/' or '\x00' in location or location!=os.path.normpath(location) or location!=os.path.realpath(location): fail('Recovery paths must be canonical directories')
    if root==account or os.path.commonpath([root,account])!=account: fail('Preview root does not belong to this runtime account')
    owner=hashlib.sha256((account+'\0'+user).encode()).hexdigest()[:20]
    if not re.fullmatch(r'chisa-account-preview-'+owner+r'-[a-f0-9]{16}',preview): fail('Preview identity does not belong to this runtime account')
    opened=[]; pinned=[]; evidence=[]
    try:
        def directory(location):
            fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC); opened.append(fd)
            for name in location.split('/')[1:]:
                parent=fd; fd=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=parent)
                opened.append(fd); pinned.append((parent,name,fd))
            return fd
        def private_directory(location):
            fd=directory(location); s=os.fstat(fd)
            if s.st_mode&0o077 or s.st_uid!=os.getuid(): fail('Runtime inventory directory is not private')
            return fd
        def observe(parent,name,private=False):
            value=read(parent,name,private); stamp=exists(parent,name)
            evidence.append((parent,name,stamp,value,private)); return value
        def check():
            for parent,name,fd in pinned:
                named=exists(parent,name)
                if named is None or not same(named,os.fstat(fd)): fail('Pinned recovery directory or guard changed')
            for parent,name,stamp,value,private in evidence:
                named=exists(parent,name)
                if named is None or not same(named,stamp) or read(parent,name,private)!=value: fail('Exact runtime recovery witness changed')
            if exists(parent_fd,base+'.chisa-integration.json') is not None: fail('Workspace integration must finish before preview recovery')
        account_fd=directory(account)
        root_fd=directory(root); parent_fd=directory(os.path.dirname(root)); base=os.path.basename(root)
        state_fd=private_directory(home+'/.chisa-workspace-runtime')
        inventory_fd=private_directory(home+'/.chisa-workspace-runtime/previews')
        if os.path.commonpath([home+'/.chisa-workspace-runtime',account])==account: fail('Runtime inventory cannot be inside the workspace account')
        runtime=observe(state_fd,hashlib.sha256(account.encode()).hexdigest()[:24]+'.json',True)
        if runtime!={'version':1,'root':account,'userId':user,'owner':hashlib.sha256((account+'\0'+user).encode()).hexdigest()[:24]} or type(runtime.get('version')) is not int: fail('Persistent runtime account owner does not match')
        witness=observe(inventory_fd,preview+'.json',True)
        if set(witness)!=set(('version','userId','accountRoot','root','previewId','lease')) or type(witness.get('version')) is not int or witness['version']!=1 or any(witness.get(key)!=q[key] for key in ('userId','accountRoot','root','previewId')): fail('Runtime inventory does not match the exact stopped preview')
        expected=witness['lease']; validate_lease(expected)
        stopped(expected)
        for suffix in ('.chisa-writer.guard','.chisa-lease.guard'):
            name=base+suffix
            fd=os.open(name,os.O_RDWR|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=parent_fd); opened.append(fd)
            if not regular(os.fstat(fd)): fail('Recovery guard is not a persistent regular file')
            try: fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
            except OSError as error:
                if error.errno in (errno.EAGAIN,errno.EACCES): fail('Workspace writer recovery is busy','WORKSPACE_BUSY')
                raise
            pinned.append((parent_fd,name,fd)); check()
        bridge=observe(root_fd,'.chisa-bridge.json')
        if bridge.get('bindingEpoch')!=expected['epoch'] or bridge.get('execution')=='isolated-worktree' or exists(root_fd,'.chisa-session.json') is not None: fail('Preview binding changed or is not an enrolled source workspace')
        cap=observe(parent_fd,base+'.chisa-writer-capability.json')
        cloud_only=cap.get('protocol')=='chisa-cloud-writer-v1'
        legacy=cap.get('protocol')=='chisa-writer-gate-v1' and cap.get('engineVersion')=='0.18.1-chisa.5'
        if type(cap.get('version')) is not int or cap['version']!=1 or cap.get('root')!=root or cap.get('bindingEpoch')!=expected['epoch'] or not (cloud_only or legacy): fail('Writer capability changed before preview recovery')
        generation_name=base+'.chisa-generation.json'
        generation=read(parent_fd,generation_name)
        if type(generation.get('version')) is not int or generation['version']!=1 or generation.get('root')!=root or generation.get('writer')!='cloud' or generation.get('bindingEpoch')!=expected['epoch'] or generation.get('leaseId')!=expected['id'] or generation.get('state') not in ('dirty','complete') or not isinstance(generation.get('generation'),str) or not re.fullmatch(r'[a-f0-9]{32,}',generation['generation']): fail('Cloud generation is not owned by this exact preview lease')
        timestamp=generation.get('updatedAt')
        try:
            if not isinstance(timestamp,str) or datetime.datetime.fromisoformat(timestamp.replace('Z','+00:00')).tzinfo is None: raise ValueError()
        except (ValueError,TypeError): fail('Cloud generation timestamp is invalid')
        lease_name=base+'.chisa-lease'; lease_fd=None; actual=None
        if exists(parent_fd,lease_name) is not None:
            lease_fd=directory(root+'.chisa-lease')
            s=os.fstat(lease_fd)
            if s.st_mode&0o077 or s.st_uid!=os.getuid(): fail('Cloud lease directory is not private')
            entries=sorted(os.listdir(lease_fd))
            if entries not in ([],['state.json']): fail('Workspace jobs or unconfirmed state are still reserved','WORKSPACE_BUSY')
            if entries:
                actual=read(lease_fd,'state.json',True); validate_lease(actual)
                if any(actual.get(key)!=expected.get(key) for key in ('owner','id','epoch','pid','processStartTime','bootId','writerGate')): fail('Workspace lease changed after runtime inventory was recorded','WORKSPACE_BUSY')
        if actual is None and generation['state']!='complete': fail('A partial dirty lease cannot confirm preview recovery')
        if generation['state']=='complete' and actual and (actual.get('previews') or actual.get('cleanupPending')): fail('Completed generation still has unconfirmed runtime work')
        # Docker is independently queried while both permanent guards are held.
        absent_container('name=^/'+preview+'$')
        stopped(expected); check()
        def check_state():
            check()
            if read(parent_fd,generation_name)!=generation: fail('Cloud generation changed during preview cleanup')
            if lease_fd is not None:
                entries=sorted(os.listdir(lease_fd))
                if entries!=(['state.json'] if actual is not None else []) or actual is not None and read(lease_fd,'state.json',True)!=actual: fail('Workspace reservation changed during preview cleanup')
        if actual is not None:
            remaining={**actual,'previews':[item for item in actual.get('previews',[]) if item!=preview],'cleanupPending':[item for item in actual.get('cleanupPending',[]) if item!=preview]}
            check_state()
            if remaining!=actual:
                atomic(lease_fd,'state.json',remaining,actual,parent_fd); actual=remaining
            if actual['previews'] or actual['cleanupPending']:
                # A prior helper may have replaced state and exited before its
                # directory fsync; confirm durability even on an unchanged retry.
                check_state(); os.fsync(lease_fd); os.fsync(parent_fd)
                return {'ok':True,'released':False}
        # No worker or preview container, even one missing from a damaged list,
        # may survive publication of this lease's complete cloud generation.
        absent_container('label=chisa.workspace-root='+hashlib.sha256(root.encode()).hexdigest())
        stopped(expected); check_state()
        if generation['state']!='complete':
            complete={'version':1,'root':root,'generation':secrets.token_hex(32),'state':'complete','writer':'cloud','bindingEpoch':expected['epoch'],'leaseId':expected['id'],'updatedAt':datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z')}
            atomic(parent_fd,generation_name,complete,generation,parent_fd); generation=complete
        check_state()
        # An interrupted previous call may have replaced a complete generation
        # before syncing its directory. Its publication must precede lease unlink.
        os.fsync(parent_fd)
        if actual is not None:
            os.unlink('state.json',dir_fd=lease_fd); os.fsync(lease_fd); actual=None
        check_state()
        if lease_fd is not None: os.rmdir(lease_name,dir_fd=parent_fd)
        # Also persists a prior call's successful rmdir whose reply was lost.
        os.fsync(parent_fd)
        # Keep the exact inventory witness until the runtime receives success.
        return {'ok':True,'released':True}
    finally:
        for fd in reversed(opened): os.close(fd)
try:
    response=operate(json.load(sys.stdin))
except RecoveryError as error:
    response={'ok':False,'code':error.code,'error':error.message}
except (OSError,ValueError,TypeError,KeyError,IndexError,subprocess.SubprocessError) as error:
    response={'ok':False,'code':'WORKSPACE_PREVIEW_RECOVERY_REQUIRED','error':'Stopped preview recovery could not be verified; keep the lease ('+type(error).__name__+')'}
print(json.dumps(response,separators=(',',':')))
`;

/** Workspace-runtime calls this only after stopping an orphan preview; it independently verifies the durable witness and Docker absence before releasing an enrolled writer. */
export function recoverStoppedWorkspacePreview(input: RecoveryRequest): { released: boolean } {
  if (os.platform() !== 'linux') throw new AppError('Stopped preview recovery requires Linux process birth verification', { code: 'WORKSPACE_PREVIEW_RECOVERY_UNAVAILABLE', statusCode: 503 });
  let reply: RecoveryReply;
  try {
    const result = spawnSync('python3', ['-I', '-c', previewRecoveryScript], {
      input: JSON.stringify({ ...input, home: realpathSync(os.homedir()) }), encoding: 'utf8', timeout: 8_000,
      killSignal: 'SIGKILL', maxBuffer: 65_536, windowsHide: true,
    });
    if (result.error || result.status !== 0 || result.signal) throw new Error('Recovery helper did not finish');
    reply = JSON.parse(result.stdout) as RecoveryReply;
  } catch {
    throw new AppError('Stopped preview recovery was not confirmed; keep its inventory and reservation', { code: 'WORKSPACE_PREVIEW_RECOVERY_REQUIRED', statusCode: 503 });
  }
  if (reply?.ok !== true || typeof reply.released !== 'boolean') {
    const code = typeof reply?.code === 'string' ? reply.code : 'WORKSPACE_PREVIEW_RECOVERY_REQUIRED';
    throw new AppError(typeof reply?.error === 'string' ? reply.error : 'Stopped preview recovery was not confirmed', { code, statusCode: code === 'WORKSPACE_BUSY' ? 409 : 503 });
  }
  return { released: reply.released };
}
