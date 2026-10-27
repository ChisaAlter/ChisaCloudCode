import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, realpathSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AppError } from '@/shared/index.js';

// These contracts stay private: the bridge passes its descriptor and lease structurally.
type IntegrationIntent = {
  workspaceId: string; generation: string; baseRevision: string;
  sourceRoot: string; executionRoot: string; sessionId: string; bindingEpoch: string;
  operationId: string; previewId: string; expectedSourceRevision: string; expectedTargetRevision: string;
};
type IntegrationLease = {
  owner: string; id: string; epoch: string; pid?: number; processStartTime?: string; bootId?: string;
  mayWrite?: boolean; cleanupPending?: string[]; previews?: string[]; integrationOperation?: string; writerGate?: boolean;
};
type LeaseIdentity = Pick<IntegrationLease, 'owner' | 'id' | 'epoch' | 'pid' | 'processStartTime' | 'bootId'>;
type Marker = { version: 1; intent: IntegrationIntent; roots: Record<string, { stamp: string; leases: LeaseIdentity[] }> };
const fields = ['workspaceId', 'generation', 'baseRevision', 'sourceRoot', 'executionRoot', 'sessionId', 'bindingEpoch', 'operationId', 'previewId', 'expectedSourceRevision', 'expectedTargetRevision'] as const;
const identityFields = ['owner', 'id', 'epoch', 'pid', 'processStartTime', 'bootId'] as const;
const suffix = '.chisa-integration.json';

function fail(message: string, code = 'WORKSPACE_INTEGRATION_INVALID'): never {
  throw new AppError(message, { code, statusCode: code === 'WORKSPACE_BUSY' || code === 'WORKSPACE_RECOVERY_REQUIRED' ? 409 : 503 });
}
function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\0\r\n]/.test(value); }
function exists(file: string): boolean {
  try { lstatSync(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
function rootStamp(root: string): string {
  const stats = lstatSync(root, { bigint: true });
  if (!stats.isDirectory() || stats.isSymbolicLink() || realpathSync(root) !== root || path.resolve(root) !== root) fail('Integration requires canonical real workspace directories');
  return `${stats.dev}:${stats.ino}`;
}
function intent(value: IntegrationIntent): IntegrationIntent {
  if (!value || fields.some(key => !text(value[key])) || fields.filter(key => key !== 'sourceRoot' && key !== 'executionRoot').some(key => value[key].length > 256)) fail('Integration operation identity is incomplete');
  rootStamp(value.sourceRoot); rootStamp(value.executionRoot);
  if (value.sourceRoot === value.executionRoot || value.sourceRoot.startsWith(value.executionRoot + path.sep) || value.executionRoot.startsWith(value.sourceRoot + path.sep)) fail('Integration source and execution roots must be disjoint');
  return Object.fromEntries(fields.map(key => [key, value[key]])) as IntegrationIntent;
}
function sameIntent(a: IntegrationIntent, b: IntegrationIntent): boolean { return fields.every(key => a[key] === b[key]); }
function tuple(value: IntegrationLease): LeaseIdentity { return Object.fromEntries(identityFields.filter(key => value[key] !== undefined).map(key => [key, value[key]])) as LeaseIdentity; }
function sameLease(a: IntegrationLease, b: IntegrationLease): boolean { return identityFields.every(key => a[key] === b[key]); }
function validLease(value: IntegrationLease, expected: IntegrationIntent): void {
  if (!value || value.owner !== 'claude' || !text(value.id) || value.epoch !== expected.bindingEpoch || !Number.isInteger(value.pid) || Number(value.pid) <= 0 || (value.integrationOperation !== undefined && value.integrationOperation !== expected.operationId)) fail('Integration reservation identity changed');
  for (const key of ['cleanupPending', 'previews'] as const) if (value[key] !== undefined && (!Array.isArray(value[key]) || value[key]!.length !== 0)) fail('Integration reservation has unconfirmed writers or cleanup', 'WORKSPACE_RECOVERY_REQUIRED');
}
function readJson(file: string): Record<string, unknown> | null {
  if (!exists(file)) return null;
  const initial = lstatSync(file);
  if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1) fail('Integration metadata is not a private regular file');
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = fstatSync(fd);
    const named = lstatSync(file);
    if (!before.isFile() || before.nlink !== 1 || named.isSymbolicLink() || before.dev !== initial.dev || before.ino !== initial.ino || before.dev !== named.dev || before.ino !== named.ino || before.size > 65_536 || (process.platform !== 'win32' && (before.mode & 0o022) !== 0)) fail('Integration metadata is not a private regular file');
    const data = Buffer.alloc(65_537); let size = 0;
    while (size < data.length) { const count = readSync(fd, data, size, data.length - size, null); if (!count) break; size += count; }
    const after = fstatSync(fd); const current = lstatSync(file);
    if (size > 65_536 || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || after.dev !== current.dev || after.ino !== current.ino) fail('Integration metadata changed during validation');
    const value: unknown = JSON.parse(data.subarray(0, size).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Integration metadata must be an object');
    return value as Record<string, unknown>;
  } finally { closeSync(fd); }
}
function marker(root: string): Marker | null {
  const value = readJson(root + suffix) as Marker | null;
  if (!value) return null;
  if (value.version !== 1 || !value.roots || typeof value.roots !== 'object' || !value.intent || Object.keys(value.intent).length !== fields.length) fail('Integration marker is damaged');
  const expected = intent(value.intent);
  if (root !== expected.sourceRoot && root !== expected.executionRoot) fail('Integration marker belongs to another root');
  if (Object.keys(value.roots).length !== 2) fail('Integration marker root pair is invalid');
  for (const candidate of [expected.sourceRoot, expected.executionRoot]) {
    const entry = value.roots[candidate];
    if (!entry || entry.stamp !== rootStamp(candidate) || !Array.isArray(entry.leases) || entry.leases.length < 1 || entry.leases.length > 2) fail('Integration workspace or lease witness was replaced');
    for (const lease of entry.leases) {
      validLease(lease, expected);
      if (os.platform() === 'linux' && (typeof lease.processStartTime !== 'string' || !/^\d+$/.test(lease.processStartTime) || typeof lease.bootId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(lease.bootId))) fail('Integration witness lacks Linux process birth identity');
    }
  }
  return value;
}
function matchingMarkers(expected: IntegrationIntent): Marker | null {
  const source = marker(expected.sourceRoot); const execution = marker(expected.executionRoot);
  if (source && !sameIntent(source.intent, expected) || execution && !sameIntent(execution.intent, expected)) fail('Another exact integration operation owns this workspace', 'WORKSPACE_RECOVERY_REQUIRED');
  if (!source && execution) fail('Integration source witness is missing; preserve the session barrier');
  return source;
}
function currentLease(root: string, expected: IntegrationIntent): IntegrationLease | null {
  const directory = root + '.chisa-lease';
  if (!exists(directory)) return null;
  rootStamp(directory);
  if (readdirSync(directory).some(name => name !== 'state.json')) fail('Integration reservation contains an unconfirmed job', 'WORKSPACE_RECOVERY_REQUIRED');
  const lease = readJson(path.join(directory, 'state.json')) as IntegrationLease | null;
  if (!lease) fail('Integration reservation is incomplete; preserve it');
  validLease(lease, expected);
  return lease;
}
function checkBinding(expected: IntegrationIntent): void {
  for (const root of [expected.sourceRoot, expected.executionRoot]) if (readJson(path.join(root, '.chisa-bridge.json'))?.bindingEpoch !== expected.bindingEpoch) fail('Integration binding changed');
}
function atomic(file: string, value: unknown, temporaryParent = path.dirname(file)): void {
  const before = JSON.stringify(readJson(file));
  // Keep interrupted lease temporaries outside the reservation directory: its
  // entries are an exact inventory of active writers, not a recovery trash bin.
  const temporary = path.join(temporaryParent, '.' + path.basename(file) + '.' + randomUUID() + '.tmp');
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  if (JSON.stringify(readJson(file)) !== before) fail('Integration metadata changed during commit');
  renameSync(temporary, file);
}
function persistPair(value: Marker): void {
  // The source is the authoritative witness. A stale/missing mirror is repaired
  // only while both exact reservations are held by the bridge.
  atomic(value.intent.sourceRoot + suffix, value);
  atomic(value.intent.executionRoot + suffix, value);
}

// Windows supports only leases owned by this process. The bridge holds both
// in-process scopes; production Linux mutations use persistent flock guards below.
function windows(action: 'begin' | 'recover' | 'clear', expected: IntegrationIntent, leases?: Record<string, IntegrationLease>, root?: string, inactiveLeaseId?: string): IntegrationLease | null {
  checkBinding(expected);
  for (const candidate of [expected.sourceRoot, expected.executionRoot]) if (['.chisa-writer-capability.json', '.chisa-generation.json', '.chisa-writer.guard'].some(ending => exists(candidate + ending))) fail('An installed cloud writer gate requires Linux');
  let previous = matchingMarkers(expected);
  if (action === 'begin') {
    const roots: Marker['roots'] = {};
    const actual: Record<string, IntegrationLease> = {};
    for (const candidate of [expected.sourceRoot, expected.executionRoot]) {
      const lease = currentLease(candidate, expected); const wanted = leases?.[candidate];
      if (!lease || !wanted || !sameLease(lease, wanted) || lease.pid !== process.pid) fail('Integration begin requires both exact caller-owned reservations', 'WORKSPACE_BUSY');
      actual[candidate] = lease; roots[candidate] = { stamp: rootStamp(candidate), leases: [tuple(lease)] };
    }
    previous = { version: 1, intent: expected, roots };
    persistPair(previous);
    for (const candidate of [expected.sourceRoot, expected.executionRoot]) {
      if (!sameLease(currentLease(candidate, expected)!, actual[candidate])) fail('Integration reservation changed during tagging', 'WORKSPACE_BUSY');
      atomic(path.join(candidate + '.chisa-lease', 'state.json'), { ...actual[candidate], integrationOperation: expected.operationId }, path.dirname(candidate));
    }
    return null;
  }
  if (!previous) { if (action === 'clear') return null; fail('Exact integration barrier is required for lease recovery'); }
  if (action === 'recover') {
    if (root !== expected.sourceRoot && root !== expected.executionRoot) fail('Recovery root does not belong to the integration');
    const lease = currentLease(root, expected);
    if (!lease) return null;
    if (!previous.roots[root].leases.some(witness => sameLease(witness, lease)) || lease.pid !== process.pid || inactiveLeaseId !== lease.id) fail('Integration lease is still active or has a different owner', 'WORKSPACE_BUSY');
    const adopted = { ...lease, integrationOperation: expected.operationId };
    persistPair(previous);
    atomic(path.join(root + '.chisa-lease', 'state.json'), adopted, path.dirname(root));
    return adopted;
  }
  for (const candidate of [expected.sourceRoot, expected.executionRoot]) {
    const lease = currentLease(candidate, expected);
    if (!lease || lease.pid !== process.pid || lease.integrationOperation !== expected.operationId || !previous.roots[candidate].leases.some(witness => sameLease(witness, lease))) fail('Clearing integration requires both exact caller-owned reservations', 'WORKSPACE_BUSY');
  }
  // Remove the mirror first; a crash always leaves the authoritative source marker.
  for (const candidate of [expected.executionRoot, expected.sourceRoot]) if (exists(candidate + suffix)) unlinkSync(candidate + suffix);
  return null;
}

const integrationScript = String.raw`
import datetime, errno, fcntl, json, os, re, secrets, stat, sys
FIELDS = ('workspaceId','generation','baseRevision','sourceRoot','executionRoot','sessionId','bindingEpoch','operationId','previewId','expectedSourceRevision','expectedTargetRevision')
IDENTITY = ('owner','id','epoch','pid','processStartTime','bootId')
SUFFIX = '.chisa-integration.json'
class GuardError(Exception):
    def __init__(self, message, code='WORKSPACE_INTEGRATION_INVALID'):
        self.code, self.message = code, message
        super().__init__(message)
def fail(message, code='WORKSPACE_INTEGRATION_INVALID'): raise GuardError(message, code)
def text(value): return isinstance(value,str) and 0 < len(value) <= 4096 and not any(c in value for c in '\x00\r\n')
def same(a,b): return (a.st_dev,a.st_ino) == (b.st_dev,b.st_ino)
def stamp(value): return str(value.st_dev)+':'+str(value.st_ino)
def exists(parent,name):
    try: return os.stat(name,dir_fd=parent,follow_symlinks=False)
    except FileNotFoundError: return None
def regular(value): return stat.S_ISREG(value.st_mode) and value.st_nlink == 1 and not value.st_mode & 0o022
def read(parent,name,optional=False):
    if exists(parent,name) is None:
        if optional: return None
        fail('Integration metadata is missing; preserve the barrier')
    fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,dir_fd=parent)
    try:
        before=os.fstat(fd)
        if not regular(before) or before.st_size>65536: fail('Integration metadata is not a private regular file')
        with os.fdopen(fd,'rb',closefd=False) as stream: raw=stream.read(65537)
        after=os.fstat(fd); named=exists(parent,name)
        if len(raw)>65536 or named is None or not same(after,named) or (before.st_size,before.st_mtime_ns,before.st_ctime_ns)!=(after.st_size,after.st_mtime_ns,after.st_ctime_ns): fail('Integration metadata changed during validation')
        value=json.loads(raw)
        if not isinstance(value,dict): fail('Integration metadata must be an object')
        return value
    finally: os.close(fd)
def atomic(parent,name,value,temporary_parent=None):
    before=read(parent,name,True)
    staging=parent if temporary_parent is None else temporary_parent
    temporary='.'+name+'.integration-'+secrets.token_hex(16)+'.tmp'
    fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600,dir_fd=staging)
    try:
        data=json.dumps(value,separators=(',',':'),sort_keys=True).encode()
        while data:
            written=os.write(fd,data)
            if written<=0: raise OSError('Metadata write failed')
            data=data[written:]
        os.fsync(fd)
    finally: os.close(fd)
    if read(parent,name,True)!=before: fail('Integration metadata changed during commit')
    os.replace(temporary,name,src_dir_fd=staging,dst_dir_fd=parent); os.fsync(parent)
    if staging!=parent: os.fsync(staging)
def acquire(parent,name,create=False):
    fd=os.open(name,os.O_RDWR|os.O_NOFOLLOW|os.O_CLOEXEC|(os.O_CREAT if create else 0),0o600,dir_fd=parent)
    try:
        if not regular(os.fstat(fd)): fail('Integration guard is not a private persistent regular file')
        try: fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except OSError as error:
            if error.errno in (errno.EAGAIN,errno.EACCES): fail('Workspace writer gate is busy','WORKSPACE_BUSY')
            raise
        named=exists(parent,name)
        if named is None or not same(named,os.fstat(fd)): fail('Integration guard changed')
        os.fsync(parent); return fd
    except BaseException: os.close(fd); raise
def tuple_of(value): return {key:value[key] for key in IDENTITY}
def equal_lease(a,b): return all(a.get(key)==b.get(key) for key in IDENTITY)
def lease_valid(value,intent):
    if not isinstance(value,dict) or value.get('owner')!='claude' or not text(value.get('id')) or value.get('epoch')!=intent['bindingEpoch'] or type(value.get('pid')) is not int or not 0<value['pid']<=2147483647 or not isinstance(value.get('processStartTime'),str) or not re.fullmatch(r'[0-9]+',value['processStartTime']) or not isinstance(value.get('bootId'),str) or not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}',value['bootId']): fail('Integration lease lacks exact Linux process birth identity')
    if value.get('integrationOperation') not in (None,intent['operationId']): fail('Lease belongs to another integration','WORKSPACE_BUSY')
    for key in ('cleanupPending','previews'):
        if key in value and value[key]!=[]: fail('Integration has unconfirmed writers or cleanup','WORKSPACE_RECOVERY_REQUIRED')
def birth(pid):
    with open('/proc/'+str(pid)+'/stat') as handle: fields=handle.read().rsplit(')',1)[1].split()
    if len(fields)<=19 or not re.fullmatch(r'[0-9]+',fields[19]): fail('Linux process identity cannot be verified')
    with open('/proc/sys/kernel/random/boot_id') as handle: boot=handle.read().strip()
    return fields[0],fields[19],boot
def caller_identity():
    pid=os.getppid(); state,start,boot=birth(pid)
    if state=='Z': fail('Admitting process has exited')
    return {'owner':'claude','pid':pid,'processStartTime':start,'bootId':boot}
def owned(value,caller): return all(value.get(key)==caller[key] for key in ('owner','pid','processStartTime','bootId'))
def stopped(value,caller,inactive):
    if owned(value,caller):
        if inactive!=value['id']: fail('Exact in-process integration lease is still active','WORKSPACE_BUSY')
        return
    try: state,start,boot=birth(value['pid'])
    except FileNotFoundError:
        try: os.kill(value['pid'],0)
        except ProcessLookupError: return
        fail('Integration owner exit could not be proved','WORKSPACE_BUSY')
    if state=='Z' or start!=value['processStartTime'] or boot!=value['bootId']: return
    fail('Integration lease owner is still alive','WORKSPACE_BUSY')
def operate(q):
    intent=q.get('intent'); action=q.get('action')
    if not isinstance(intent,dict) or set(intent)!=set(FIELDS) or any(not text(intent.get(key)) or (key not in ('sourceRoot','executionRoot') and len(intent[key])>256) for key in FIELDS) or action not in ('begin','recover','clear'): fail('Invalid integration operation identity')
    source,execution=intent['sourceRoot'],intent['executionRoot']
    if source==execution or source.startswith(execution+'/') or execution.startswith(source+'/'): fail('Integration roots must be disjoint')
    opened=[]; stores={}; pinned=[]
    try:
        for root in sorted((source,execution)):
            if not root.startswith('/') or root=='/' or os.path.normpath(root)!=root or os.path.realpath(root)!=root: fail('Integration requires canonical real roots')
            current=os.open('/',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC); opened.append(current)
            for part in root.split('/')[1:-1]:
                previous=current
                current=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=previous); opened.append(current); pinned.append((previous,part,current))
            parent,base=current,root.split('/')[-1]
            fd=os.open(base,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=parent); opened.append(fd)
            stores[root]={'parent':parent,'base':base,'fd':fd,'stamp':stamp(os.fstat(fd))}
        def check():
            for parent,name,fd in pinned:
                named=exists(parent,name)
                if named is None or not same(named,os.fstat(fd)): fail('Pinned integration ancestor or guard changed')
            for root,s in stores.items():
                named=exists(s['parent'],s['base'])
                if named is None or stamp(named)!=s['stamp'] or os.path.realpath(root)!=root: fail('Integration root identity changed')
                if read(s['fd'],'.chisa-bridge.json').get('bindingEpoch')!=intent['bindingEpoch']: fail('Integration binding changed')
        def get_marker(root):
            s=stores[root]; value=read(s['parent'],s['base']+SUFFIX,True)
            if value is None: return None
            if type(value.get('version')) is not int or value['version']!=1 or value.get('intent')!=intent or not isinstance(value.get('roots'),dict) or set(value['roots'])!=set(stores): fail('Integration marker belongs to another exact operation','WORKSPACE_RECOVERY_REQUIRED')
            for candidate,entry in value['roots'].items():
                if not isinstance(entry,dict) or entry.get('stamp')!=stores[candidate]['stamp'] or not isinstance(entry.get('leases'),list) or not 1<=len(entry['leases'])<=2: fail('Integration witness is damaged or its root was replaced')
                for lease in entry['leases']: lease_valid(lease,intent)
            return value
        def pair():
            primary,mirror=get_marker(source),get_marker(execution)
            if primary is None and mirror is not None: fail('Integration source witness is missing')
            return primary
        def persist(value):
            check()
            for candidate in (source,execution):
                s=stores[candidate]; get_marker(candidate)
                atomic(s['parent'],s['base']+SUFFIX,value)
            check()
        def get_lease(root):
            s=stores[root]; name=s['base']+'.chisa-lease'
            if exists(s['parent'],name) is None: return None,None
            fd=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=s['parent']); opened.append(fd)
            if sorted(os.listdir(fd))!=['state.json']: fail('Integration reservation contains an unconfirmed job or partial state','WORKSPACE_RECOVERY_REQUIRED')
            value=read(fd,'state.json'); lease_valid(value,intent)
            named=exists(s['parent'],name)
            if named is None or not same(named,os.fstat(fd)): fail('Integration reservation was replaced')
            pinned.append((s['parent'],name,fd))
            return value,fd
        def verify_generation(root,lease):
            s=stores[root]
            if not s['enrolled']: return
            value=read(s['parent'],s['base']+'.chisa-generation.json')
            if type(value.get('version')) is not int or value['version']!=1 or value.get('root')!=root or value.get('state')!='dirty' or value.get('writer')!='cloud' or value.get('bindingEpoch')!=intent['bindingEpoch'] or value.get('leaseId')!=lease['id'] or not isinstance(value.get('generation'),str) or not re.fullmatch(r'[a-f0-9]{32,}',value['generation']): fail('Cloud generation does not belong to the exact integration lease')
            timestamp=value.get('updatedAt')
            try:
                if not isinstance(timestamp,str) or datetime.datetime.fromisoformat(timestamp.replace('Z','+00:00')).tzinfo is None: raise ValueError()
            except (ValueError,TypeError): fail('Cloud generation timestamp is invalid')
        check()
        for root,s in stores.items():
            parent,base=s['parent'],s['base']; cap=read(parent,base+'.chisa-writer-capability.json',True)
            if cap is None:
                if exists(parent,base+'.chisa-generation.json') is not None or exists(parent,base+'.chisa-writer.guard') is not None: fail('Installed cloud writer capability is missing')
                s['enrolled']=False
            else:
                guard=acquire(parent,base+'.chisa-writer.guard'); opened.append(guard); pinned.append((parent,base+'.chisa-writer.guard',guard))
                cap=read(parent,base+'.chisa-writer-capability.json')
                if type(cap.get('version')) is not int or cap['version']!=1 or cap.get('root')!=root or cap.get('bindingEpoch')!=intent['bindingEpoch'] or cap.get('protocol')!='chisa-writer-gate-v1' or cap.get('engineVersion')!='0.18.1-chisa.5': fail('Cloud writer capability changed')
                s['enrolled']=True
            guard=acquire(parent,base+'.chisa-lease.guard',True); opened.append(guard); pinned.append((parent,base+'.chisa-lease.guard',guard))
        check(); previous=pair(); caller=caller_identity()
        if action=='begin':
            supplied=q.get('leasesByRoot'); actual={}; roots={}
            for root,s in stores.items():
                lease,fd=get_lease(root)
                wanted=supplied.get(root) if isinstance(supplied,dict) else None
                if lease is None or not isinstance(wanted,dict) or not equal_lease(lease,wanted) or not owned(lease,caller): fail('Integration begin requires both exact caller-owned reservations','WORKSPACE_BUSY')
                verify_generation(root,lease); actual[root]=(lease,fd); roots[root]={'stamp':s['stamp'],'leases':[tuple_of(lease)]}
            value={'version':1,'intent':intent,'roots':roots}; persist(value)
            for root,(lease,fd) in actual.items():
                current,_=get_lease(root)
                if current!=lease: fail('Integration lease changed before tagging','WORKSPACE_BUSY')
                check(); atomic(fd,'state.json',{**lease,'integrationOperation':intent['operationId']},stores[root]['parent'])
            check(); return {'ok':True}
        if previous is None:
            if action=='clear': return {'ok':True}
            fail('Exact integration barrier is required for recovery')
        if action=='recover':
            root=q.get('root')
            if root not in stores: fail('Recovery root does not belong to the integration')
            lease,fd=get_lease(root)
            if lease is None: return {'ok':True,'lease':None}
            if not any(equal_lease(lease,w) for w in previous['roots'][root]['leases']): fail('Integration lease no longer matches the durable witness','WORKSPACE_BUSY')
            verify_generation(root,lease); stopped(lease,caller,q.get('inactiveLeaseId'))
            adopted={**lease,**caller,'integrationOperation':intent['operationId']}
            witnesses=[tuple_of(lease)]
            if not equal_lease(lease,adopted): witnesses.append(tuple_of(adopted))
            previous['roots'][root]['leases']=witnesses; persist(previous)
            current,_=get_lease(root)
            if current!=lease: fail('Integration lease changed during adoption','WORKSPACE_BUSY')
            stopped(current,caller,q.get('inactiveLeaseId')); check(); atomic(fd,'state.json',adopted,stores[root]['parent']); check()
            return {'ok':True,'lease':adopted}
        for root in stores:
            lease,_=get_lease(root)
            if lease is None or not owned(lease,caller) or lease.get('integrationOperation')!=intent['operationId'] or not any(equal_lease(lease,w) for w in previous['roots'][root]['leases']): fail('Clearing integration requires both exact caller-owned reservations','WORKSPACE_BUSY')
            verify_generation(root,lease)
        for root in (execution,source):
            check(); s=stores[root]
            if get_marker(root) is not None:
                os.unlink(s['base']+SUFFIX,dir_fd=s['parent']); os.fsync(s['parent'])
        return {'ok':True}
    finally:
        for fd in reversed(opened): os.close(fd)
try:
    request=json.load(sys.stdin)
    if not isinstance(request,dict): fail('Invalid integration guard request')
    response=operate(request)
except GuardError as error: response={'ok':False,'code':error.code,'error':error.message}
except (OSError,ValueError,TypeError,KeyError,AttributeError) as error: response={'ok':False,'code':'WORKSPACE_INTEGRATION_INVALID','error':'Integration state could not be safely verified; preserve the barrier ('+type(error).__name__+')'}
print(json.dumps(response,separators=(',',':')))
`;

function run(action: 'begin' | 'recover' | 'clear', expected: IntegrationIntent, leasesByRoot?: Record<string, IntegrationLease>, root?: string, inactiveLeaseId?: string): IntegrationLease | null {
  const normalized = intent(expected);
  if (os.platform() === 'win32') return windows(action, normalized, leasesByRoot, root, inactiveLeaseId);
  if (os.platform() !== 'linux') fail('Integration mutations require Linux or a same-process Windows reservation');
  let result;
  try { result = spawnSync('python3', ['-I', '-c', integrationScript], { input: JSON.stringify({ action, intent: normalized, leasesByRoot, root, inactiveLeaseId }), encoding: 'utf8', timeout: 2500, killSignal: 'SIGKILL', maxBuffer: 65_536, windowsHide: true }); }
  catch { fail('Integration helper could not start; preserve the barrier'); }
  if (result.error || result.status !== 0 || result.signal) fail('Integration helper did not confirm completion; preserve the barrier');
  let value: { ok?: boolean; error?: string; code?: string; lease?: IntegrationLease | null };
  try { value = JSON.parse(result.stdout); } catch { fail('Integration helper returned an unconfirmed result'); }
  if (!value || typeof value.ok !== 'boolean') fail('Integration helper returned an unconfirmed result');
  if (!value.ok) fail(value.error ?? 'Integration helper refused the operation', value.code && ['WORKSPACE_BUSY', 'WORKSPACE_RECOVERY_REQUIRED'].includes(value.code) ? value.code : 'WORKSPACE_INTEGRATION_INVALID');
  if (action === 'recover') {
    if (value.lease === undefined) fail('Integration helper did not confirm the recovered reservation');
    if (value.lease !== null) validLease(value.lease, normalized);
    return value.lease;
  }
  return null;
}

/** Bridge admission reads this exact persistent intent; malformed or redirected markers never count as absence. */
export function readWorkspaceIntegration(root: string): IntegrationIntent | null {
  try { return marker(path.resolve(root))?.intent ?? null; }
  catch (error) { if (error instanceof AppError) throw error; return fail('Integration marker could not be safely read; preserve the barrier'); }
}

/** The bridge begins under both writer scopes, recording exact lease witnesses before tagging either reservation. */
export function beginWorkspaceIntegration(expected: IntegrationIntent, leasesByRoot: Record<string, IntegrationLease>): void {
  run('begin', expected, leasesByRoot);
}

/** Bridge recovery adopts the same run only after exact dead-process proof, or an explicit locally inactive lease ID. */
export function recoverWorkspaceIntegrationLease(root: string, expected: IntegrationIntent, options: { inactiveLeaseId?: string } = {}): IntegrationLease | null {
  return run('recover', expected, undefined, root, options.inactiveLeaseId);
}

/** The bridge clears under both scopes after committed-journal publication, or exact inspection proving no journal and no target mutation. */
export function clearWorkspaceIntegration(expected: IntegrationIntent): void {
  run('clear', expected);
}
