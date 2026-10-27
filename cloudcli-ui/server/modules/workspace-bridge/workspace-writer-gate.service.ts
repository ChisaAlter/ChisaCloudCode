import { spawnSync } from 'node:child_process';
import os from 'node:os';

import { AppError } from '@/shared/index.js';

// This type stays private: the bridge passes its existing lease structurally.
type CloudWriterLease = {
  owner: string;
  id: string;
  epoch: string;
  pid?: number;
  processStartTime?: string;
  bootId?: string;
  mayWrite?: boolean;
  cleanupPending?: string[];
};

type GateReply = { ok?: boolean; available?: boolean; released?: boolean; code?: string; error?: string };

// The endpoint and cloud admission share this persistent flock inode. A helper
// holds it only for metadata commits; the durable lease fences the daemon after
// the helper exits. Never remove a guard or roll back a partly persisted claim.
const writerGateScript = String.raw`
import datetime, errno, fcntl, json, os, re, secrets, stat, sys

class GateError(Exception):
    def __init__(self, code, message):
        self.code, self.message = code, message
        super().__init__(message)

def fail(code, message):
    raise GateError(code, message)

def invalid(message):
    fail('WORKSPACE_WRITER_GATE_INVALID', message)

def same_inode(a, b):
    return (a.st_dev, a.st_ino) == (b.st_dev, b.st_ino)

def directory(name, parent=None):
    return os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)

def exists(parent, name):
    try: return os.stat(name, dir_fd=parent, follow_symlinks=False)
    except FileNotFoundError: return None

def regular(value):
    return stat.S_ISREG(value.st_mode) and value.st_nlink == 1 and not value.st_mode & 0o022

def read_json(parent, name, optional=False):
    try: fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=parent)
    except FileNotFoundError:
        if optional: return None
        invalid('Writer gate metadata is missing; keep the workspace reserved')
    try:
        before = os.fstat(fd)
        if not regular(before) or before.st_size > 65536:
            invalid('Writer gate metadata must be a private regular file')
        with os.fdopen(fd, 'rb', closefd=False) as stream: raw = stream.read(65537)
        if len(raw) > 65536: invalid('Writer gate metadata is too large')
        after = os.fstat(fd)
        named = exists(parent, name)
        if named is None or not same_inode(after, named) or (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            invalid('Writer gate metadata changed during validation')
        value = json.loads(raw)
        if not isinstance(value, dict): invalid('Writer gate metadata must be an object')
        return value
    finally: os.close(fd)

def atomic_json(parent, name, value):
    temporary = '.' + name + '.writer-' + secrets.token_hex(16) + '.tmp'
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=parent)
    try:
        data = json.dumps(value, separators=(',', ':'), sort_keys=True).encode('utf-8')
        while data:
            count = os.write(fd, data)
            if count <= 0: raise OSError('Unable to persist writer gate metadata')
            data = data[count:]
        os.fsync(fd)
    finally: os.close(fd)
    os.replace(temporary, name, src_dir_fd=parent, dst_dir_fd=parent)
    os.fsync(parent)

def acquire(parent, name, create=False):
    fd = os.open(name, os.O_RDWR | (os.O_CREAT if create else 0) | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=parent)
    try:
        if not regular(os.fstat(fd)): invalid('Writer guard is not a private persistent regular file')
        try: fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            if error.errno in (errno.EAGAIN, errno.EACCES):
                fail('WORKSPACE_BUSY', 'Workspace writer gate is busy; retry after the current transition')
            raise
        named = exists(parent, name)
        if named is None or not same_inode(os.fstat(fd), named): invalid('Writer guard changed during admission')
        os.fsync(parent)
        return fd
    except BaseException:
        os.close(fd)
        raise

def text(value):
    return isinstance(value, str) and 0 < len(value) <= 256 and not any(c in value for c in '\x00\r\n')

def validate_lease(value):
    if not isinstance(value, dict) or value.get('owner') != 'claude' or not text(value.get('id')) or not text(value.get('epoch')) or type(value.get('pid')) is not int or value['pid'] <= 0 or value['pid'] > 2147483647 or not isinstance(value.get('processStartTime'), str) or not re.fullmatch(r'[0-9]+', value['processStartTime']) or not isinstance(value.get('bootId'), str) or not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', value['bootId']):
        fail('WORKSPACE_LEASE_INVALID', 'Cloud writer lease requires the exact owner, run, epoch and Linux process birth identity')
    if 'mayWrite' in value and type(value['mayWrite']) is not bool:
        fail('WORKSPACE_LEASE_INVALID', 'Cloud writer lease has invalid write state')
    if 'cleanupPending' in value and (not isinstance(value['cleanupPending'], list) or any(not text(item) for item in value['cleanupPending'])):
        fail('WORKSPACE_LEASE_INVALID', 'Cloud writer lease has invalid cleanup state')

def generation_valid(value, root, epoch):
    if value is None or type(value.get('version')) is not int or value['version'] != 1 or value.get('root') != root or not isinstance(value.get('generation'), str) or not re.fullmatch(r'[a-f0-9]{32,}', value['generation']) or value.get('state') not in ('dirty', 'complete') or value.get('writer') not in ('mutagen', 'cloud'):
        invalid('Workspace generation is missing or invalid; synchronize or recover it before admission')
    stamp = value.get('updatedAt')
    try:
        if not isinstance(stamp, str) or datetime.datetime.fromisoformat(stamp.replace('Z', '+00:00')).tzinfo is None: raise ValueError()
    except (ValueError, TypeError): invalid('Workspace generation has an invalid timestamp')
    if 'bindingEpoch' in value and value['bindingEpoch'] != epoch:
        invalid('Workspace generation belongs to a different binding')
    if 'leaseId' in value and not text(value['leaseId']): invalid('Workspace generation has an invalid lease identity')

def new_generation(root, lease, state):
    return {'version': 1, 'root': root, 'generation': secrets.token_hex(32), 'state': state, 'writer': 'cloud', 'bindingEpoch': lease['epoch'], 'leaseId': lease['id'], 'updatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00', 'Z')}

def operate(q):
    root, epoch, action = q.get('root'), q.get('epoch'), q.get('action')
    if not isinstance(root, str) or not root.startswith('/') or root == '/' or '\x00' in root or root != os.path.normpath(root) or root != os.path.realpath(root) or not text(epoch) or action not in ('available', 'claim', 'release'):
        invalid('Writer gate requires a canonical, symlink-free project root and exact binding epoch')
    # Walk through pinned directory descriptors: no ancestor or final component
    # may redirect these metadata operations through a symlink.
    opened, parent, root_fd = [], None, None
    try:
        current = directory('/')
        opened.append(current)
        parts = root.split('/')[1:]
        for part in parts[:-1]:
            current = directory(part, current)
            opened.append(current)
        parent, base = current, parts[-1]
        root_fd = directory(base, parent)
        opened.append(root_fd)
        root_stat, parent_stat = os.fstat(root_fd), os.fstat(parent)
        def check_root():
            named = exists(parent, base)
            if named is None or not same_inode(named, root_stat) or root != os.path.realpath(root) or not same_inode(os.stat(os.path.dirname(root), follow_symlinks=False), parent_stat):
                invalid('Workspace root changed during writer admission')
        capability_name = base + '.chisa-writer-capability.json'
        generation_name = base + '.chisa-generation.json'
        lease_name = base + '.chisa-lease'
        # A never-enrolled workspace is the sole legacy fallback. Losing an
        # installed capability cannot erase the generation or authorize fallback.
        if exists(parent, capability_name) is None:
            if action == 'release' or exists(parent, generation_name) is not None or exists(parent, base + '.chisa-writer.guard') is not None:
                invalid('Installed writer capability is missing; preserve the reservation')
            return {'ok': True, 'available': False}
        writer_guard = acquire(parent, base + '.chisa-writer.guard')
        opened.append(writer_guard)
        check_root()
        cap = read_json(parent, capability_name)
        cloud_only = cap.get('protocol') == 'chisa-cloud-writer-v1'
        legacy = cap.get('protocol') == 'chisa-writer-gate-v1' and cap.get('engineVersion') == '0.18.1-chisa.5'
        if type(cap.get('version')) is not int or cap['version'] != 1 or cap.get('root') != root or not (cloud_only or legacy) or cap.get('bindingEpoch') != epoch:
            invalid('Installed writer capability does not match the cloud workspace identity')
        def check_binding():
            bridge = read_json(root_fd, '.chisa-bridge.json')
            if bridge.get('bindingEpoch') != epoch:
                invalid('Workspace binding changed after endpoint initialization')
        check_binding()
        gen = read_json(parent, generation_name)
        generation_valid(gen, root, epoch)
        if action == 'available': return {'ok': True, 'available': True}
        # Legacy sync-job admission/recovery uses this second guard. Always take
        # writer first, and never wait, so it cannot race lease removal or create
        # a lock-order deadlock with a daemon transition.
        lease_guard = acquire(parent, base + '.chisa-lease.guard', create=True)
        opened.append(lease_guard)
        check_root()
        expected = q.get('lease')
        validate_lease(expected)
        if expected['epoch'] != epoch: fail('WORKSPACE_LEASE_INVALID', 'Cloud lease and binding epoch differ')
        if action == 'claim':
            if exists(parent, lease_name) is not None:
                fail('WORKSPACE_BUSY', 'Workspace already has a reservation; preserve it')
            if gen['state'] != 'complete':
                fail('WORKSPACE_RECOVERY_REQUIRED', 'Workspace generation is dirty; confirm synchronization or exact cloud recovery first')
            if expected.get('cleanupPending'):
                fail('WORKSPACE_CLEANUP_FAILED', 'Cloud writer cleanup has not been confirmed')
            if expected['pid'] != os.getppid(): fail('WORKSPACE_LEASE_INVALID', 'Cloud lease does not belong to the admitting process')
            with open('/proc/' + str(expected['pid']) + '/stat') as handle: fields = handle.read().rsplit(')', 1)[1].split()
            with open('/proc/sys/kernel/random/boot_id') as handle: boot = handle.read().strip()
            if len(fields) <= 19 or fields[0] == 'Z' or fields[19] != expected['processStartTime'] or boot != expected['bootId']:
                fail('WORKSPACE_LEASE_INVALID', 'Cloud process birth identity changed before admission')
            os.mkdir(lease_name, 0o700, dir_fd=parent)
            os.fsync(parent)
            lease_fd = directory(lease_name, parent)
            opened.append(lease_fd)
            atomic_json(lease_fd, 'state.json', expected)
            atomic_json(parent, generation_name, new_generation(root, expected, 'dirty'))
            check_root()
            check_binding()
            return {'ok': True, 'available': True}
        lease_fd = directory(lease_name, parent)
        opened.append(lease_fd)
        lease_stat = os.fstat(lease_fd)
        actual = read_json(lease_fd, 'state.json')
        validate_lease(actual)
        if any(actual[key] != expected[key] for key in ('owner', 'id', 'epoch', 'pid', 'processStartTime', 'bootId')):
            fail('WORKSPACE_BUSY', 'Cloud writer reservation changed before release')
        if actual.get('cleanupPending'):
            fail('WORKSPACE_CLEANUP_FAILED', 'Cloud writer container cleanup is not confirmed')
        if exists(lease_fd, 'sync-job.json') is not None:
            fail('WORKSPACE_BUSY', 'Workspace synchronization job is still reserved')
        if sorted(os.listdir(lease_fd)) != ['state.json']:
            fail('WORKSPACE_RECOVERY_REQUIRED', 'Workspace reservation contains unconfirmed state; preserve it')
        if gen['writer'] != 'cloud' or gen.get('bindingEpoch') != epoch or gen.get('leaseId') != expected['id']:
            fail('WORKSPACE_RECOVERY_REQUIRED', 'Workspace generation does not belong to this exact cloud reservation')
        check_root()
        check_binding()
        # Publish completion first. Any interruption still leaves either a live
        # exact lease or an empty lease directory, both rejected by the daemon.
        # A retry after publication is allowed only for this same exact lease.
        atomic_json(parent, generation_name, new_generation(root, expected, 'complete'))
        actual_again = read_json(lease_fd, 'state.json')
        if actual_again != actual or sorted(os.listdir(lease_fd)) != ['state.json'] or not same_inode(os.stat(lease_name, dir_fd=parent, follow_symlinks=False), lease_stat):
            fail('WORKSPACE_BUSY', 'Cloud reservation changed while publishing completion')
        check_root()
        check_binding()
        os.unlink('state.json', dir_fd=lease_fd)
        os.fsync(lease_fd)
        os.rmdir(lease_name, dir_fd=parent)
        os.fsync(parent)
        return {'ok': True, 'released': True}
    finally:
        for fd in reversed(opened): os.close(fd)

try:
    request = json.load(sys.stdin)
    if not isinstance(request, dict): invalid('Invalid writer gate request')
    response = operate(request)
except GateError as error:
    response = {'ok': False, 'code': error.code, 'error': error.message}
except (OSError, ValueError, TypeError, KeyError) as error:
    response = {'ok': False, 'code': 'WORKSPACE_WRITER_GATE_INVALID', 'error': 'Writer gate state could not be safely verified; preserve the reservation (' + type(error).__name__ + ')'}
print(json.dumps(response, separators=(',', ':')))
`;

function runGate(action: 'available' | 'claim' | 'release', root: string, epoch: string, lease?: CloudWriterLease): GateReply {
  let reply;
  try {
    reply = spawnSync('python3', ['-I', '-c', writerGateScript], {
      input: JSON.stringify({ action, root, epoch, ...(lease ? { lease } : {}) }),
      encoding: 'utf8', timeout: 2500, killSignal: 'SIGKILL', maxBuffer: 65_536, windowsHide: true,
    });
  } catch {
    throw new AppError('Cloud writer gate could not run; preserve the workspace reservation', { code: 'WORKSPACE_WRITER_GATE_UNAVAILABLE', statusCode: 503 });
  }
  if (reply.error || reply.status !== 0 || reply.signal) {
    throw new AppError('Cloud writer gate did not confirm completion; preserve the workspace reservation', {
      code: 'WORKSPACE_WRITER_GATE_UNAVAILABLE', statusCode: 503,
      details: { transportCode: (reply.error as NodeJS.ErrnoException | undefined)?.code, exitCode: reply.status, signal: reply.signal },
    });
  }
  let value: GateReply;
  try {
    value = JSON.parse(reply.stdout) as GateReply;
    if (!value || typeof value !== 'object' || typeof value.ok !== 'boolean') throw new Error('Invalid helper result');
  } catch {
    throw new AppError('Cloud writer gate returned an unconfirmed result; preserve the workspace reservation', { code: 'WORKSPACE_WRITER_GATE_UNAVAILABLE', statusCode: 503 });
  }
  if (!value.ok) {
    const allowed = ['WORKSPACE_BUSY', 'WORKSPACE_RECOVERY_REQUIRED', 'WORKSPACE_CLEANUP_FAILED', 'WORKSPACE_LEASE_INVALID', 'WORKSPACE_WRITER_GATE_INVALID'];
    const code = value.code && allowed.includes(value.code) ? value.code : 'WORKSPACE_WRITER_GATE_INVALID';
    throw new AppError(typeof value.error === 'string' ? value.error : 'Cloud writer gate refused admission; preserve the reservation', {
      code, statusCode: code === 'WORKSPACE_LEASE_INVALID' ? 400 : code === 'WORKSPACE_WRITER_GATE_INVALID' || code === 'WORKSPACE_CLEANUP_FAILED' ? 503 : 409,
    });
  }
  if (action === 'release' ? value.released !== true : typeof value.available !== 'boolean') {
    throw new AppError('Cloud writer gate did not confirm the requested operation', { code: 'WORKSPACE_WRITER_GATE_UNAVAILABLE', statusCode: 503 });
  }
  return value;
}

/** The workspace bridge uses this capability probe; invalid installed metadata throws instead of selecting legacy admission. */
export function cloudWriterGateAvailable(root: string, epoch: string): boolean {
  return os.platform() === 'linux' && runGate('available', root, epoch).available === true;
}

/** The workspace bridge uses this atomic claim before cloud writes; false means only an unenrolled or non-Linux workspace. */
export function claimCloudWriterLease(root: string, lease: CloudWriterLease): boolean {
  return os.platform() === 'linux' && runGate('claim', root, lease.epoch, lease).available === true;
}

/** The workspace bridge releases its exact cloud lease only after all writers and cleanup have been confirmed stopped. */
export function releaseCloudWriterLease(root: string, expected: CloudWriterLease): void {
  if (os.platform() !== 'linux') throw new AppError('Cloud writer gate requires Linux', { code: 'WORKSPACE_WRITER_GATE_UNAVAILABLE', statusCode: 503 });
  runGate('release', root, expected.epoch, expected);
}
