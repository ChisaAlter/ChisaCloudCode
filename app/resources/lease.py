"""Desktop ownership operations; state lives beside, never inside, the project.

handle is called serially by the exact-binding persistent transport. The module
state is request-local in that serial execution model; it must not be threaded.
The CLI keeps its original one-request JSON stdin/stdout contract.
"""
import errno, fcntl, json, os, re, select, shutil, subprocess, sys, time
from pathlib import Path

class RecoveryStale(RuntimeError):
    pass


def check_deadline():
    if time.monotonic() >= _deadline:
        raise RuntimeError('Workspace lease operation deadline expired')
    if _identity_check is not None:
        _identity_check()


def state():
    if not lock.exists(): return None
    return json.loads(state_file.read_text())


def persist(value):
    # The caller checked its deadline before entering the small ownership commit.
    # Do not insert cancellation between retiring an old lease and publishing its
    # replacement: an unknown result must retain an exact recoverable reservation.
    temp = lock / 'state.tmp'
    temp.write_text(json.dumps(value))
    os.chmod(temp, 0o600)
    os.replace(temp, state_file)


def confirm_sync_finished(current):
    check_deadline()
    marker = lock / 'sync-job.json'
    if not marker.exists(): return
    job = json.loads(marker.read_text())
    if job.get('leaseId') != current['id'] or job.get('epoch') != current['epoch']:
        raise RuntimeError('Synchronization process belongs to another reservation')
    for pid_key, start_key in (('pid', 'startTime'), ('childPid', 'childStartTime')):
        pid = job.get(pid_key)
        if not pid: continue
        try: fields = Path('/proc/' + str(pid) + '/stat').read_text().rsplit(')', 1)[1].split()
        except FileNotFoundError: continue
        if fields[0] != 'Z' and fields[19] == str(job.get(start_key)):
            raise RuntimeError('Synchronization process is still running; keep the reservation')
    group = job.get('childPid')
    if group:
        for entry in Path('/proc').iterdir():
            check_deadline()
            if not entry.name.isdigit(): continue
            try: fields = (entry / 'stat').read_text().rsplit(')', 1)[1].split()
            except FileNotFoundError: continue
            if fields[0] != 'Z' and fields[2] == str(group):
                raise RuntimeError('Synchronization descendants are still running; keep the reservation')
    check_deadline()
    marker.unlink()


def operate():
    check_deadline()
    if op == 'claim':
        lock.mkdir(mode=0o700)
        persist({'owner': q['owner'], 'id': q['id'], 'epoch': q['epoch']})
        result = {'ok': True}
    elif op == 'read': result = {'ok': True, 'lease': state()}
    elif op == 'confirm':
        current = state()
        if not current or current['id'] != q['id'] or current['epoch'] != q['epoch']:
            raise RuntimeError('Workspace reservation changed')
        if current.get('cleanupPending'):
            raise RuntimeError('Workspace container cleanup is not confirmed; keep the reservation')
        confirm_sync_finished(current)
        result = {'ok': True, 'lease': current}
    elif op == 'recover':
        current = state()
        if 'recoveryLease' in q and current != q['recoveryLease']:
            raise RecoveryStale('Workspace reservation changed after Git recovery preview')
        if q.get('serverChecked') is True and current != q.get('checkedLease'):
            raise RuntimeError('Workspace reservation changed after server confirmation')
        if current and current['epoch'] != q['epoch']:
            raise RuntimeError('Workspace reservation belongs to a different binding')
        if current and current['owner'] == 'claude' and q.get('serverChecked') is not True:
            if 'processStartTime' in current or 'bootId' in current:
                start_time, boot_id, pid = current.get('processStartTime'), current.get('bootId'), current.get('pid')
                if (not isinstance(start_time, str) or not re.fullmatch(r'[0-9]+', start_time) or
                    not isinstance(boot_id, str) or not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', boot_id) or
                    type(pid) is not int or pid <= 0):
                    raise RuntimeError('Workspace process identity is invalid; keep the reservation')
                try: fields = Path('/proc/' + str(pid) + '/stat').read_text().rsplit(')', 1)[1].split()
                except FileNotFoundError: pass
                else:
                    if len(fields) <= 19 or not re.fullmatch(r'[0-9]+', fields[19]):
                        raise RuntimeError('Workspace process identity cannot be confirmed; keep the reservation')
                    actual_boot_id = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
                    if fields[0] != 'Z' and fields[19] == start_time and actual_boot_id == boot_id:
                        raise RuntimeError('Claude is still running; wait for the task to finish')
            else:
                pid = current.get('pid')
                if type(pid) is not int or pid <= 0:
                    raise RuntimeError('Workspace process identity is invalid; keep the reservation')
                try: os.kill(pid, 0)
                except ProcessLookupError: pass
                else:
                    # Old leases recorded no birth token. Only an explicit
                    # system non-Node role proves this is not the original host;
                    # unknown/custom executables remain reserved.
                    try: executable = re.sub(r' \(deleted\)$', '', os.readlink('/proc/' + str(pid) + '/exe'))
                    except OSError: executable = ''
                    if not re.fullmatch(r'/(?:usr/)?s?bin/(?:sleep|sh|bash|dash|python(?:\d+(?:\.\d+)?)?|ssh|sshd|systemd)', executable):
                        raise RuntimeError('Claude is still running; wait for the task to finish')
        if current and current['owner'] not in ('sync-needed', 'claude'):
            raise RuntimeError('Workspace is reserved by another task')
        if current:
            confirm_sync_finished(current)
            if q.get('serverChecked') is not True:
                for name in current.get('cleanupPending', []):
                    check_deadline()
                    if not isinstance(name, str) or not re.fullmatch(r'chisa-rpc-(?:[a-f0-9]{16}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})', name):
                        raise RuntimeError('Workspace cleanup record is invalid')
                    removed = subprocess.run(['docker', 'rm', '--force', name], capture_output=True, text=True, timeout=min(10, max(.001, _deadline - time.monotonic())))
                    if removed.returncode == 0: continue
                    check_deadline()
                    inspected = subprocess.run(['docker', 'ps', '--all', '--format', '{{.Names}}', '--filter', 'name=^/' + name + '$'], capture_output=True, text=True, timeout=min(10, max(.001, _deadline - time.monotonic())))
                    if inspected.returncode != 0 or inspected.stdout.strip():
                        raise RuntimeError('Workspace container cleanup is not confirmed; keep the reservation')
        check_deadline()
        if current: shutil.rmtree(lock)
        lock.mkdir(mode=0o700)
        persist({'owner': 'sync', 'id': q['id'], 'epoch': q['epoch'],
                 'gitSource': 'remote' if current and (current.get('owner') in ('sync-needed', 'claude') or current.get('gitSource') == 'remote') else ''})
        result = {'ok': True}
    elif op == 'release':
        current = state()
        if current and (current['id'] != q['id'] or current['epoch'] != q['epoch'] or
                        (q.get('owner') and current.get('owner') != q['owner'])):
            raise RuntimeError('Workspace reservation changed')
        if current and current.get('cleanupPending'):
            raise RuntimeError('Workspace container cleanup is not confirmed; keep the reservation')
        if current: confirm_sync_finished(current)
        check_deadline()
        if current: shutil.rmtree(lock)
        result = {'ok': True}
    else: raise ValueError('Unknown ownership operation')
    return result


def handle(request, deadline=None, identity_check=None):
    global q, root, lock, state_file, op, _deadline, _identity_check
    q = request
    root = Path(q['root'])
    lock = Path(str(root) + '.chisa-lease')
    state_file = lock / 'state.json'
    op = q['op']
    _deadline = min(time.monotonic() + 30, deadline) if deadline is not None else time.monotonic() + 30
    _identity_check = identity_check
    try:
        check_deadline()
        if op == 'read':
            # Atomic state replacement makes previews read-only: do not create a
            # guard or directory merely to discover an absent reservation.
            result = operate()
        else:
            # Keep this inode outside the directory that release/recover remove.
            with Path(str(root) + '.chisa-lease.guard').open('a+b') as guard:
                os.fchmod(guard.fileno(), 0o600)
                if hasattr(fcntl, 'LOCK_NB'):
                    while True:
                        check_deadline()
                        try:
                            fcntl.flock(guard.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                            break
                        except OSError as error:
                            if error.errno not in (errno.EAGAIN, errno.EACCES): raise
                            time.sleep(min(.02, max(0, _deadline - time.monotonic())))
                else:
                    # Windows test adapters implement the original CLI contract.
                    fcntl.flock(guard, fcntl.LOCK_EX)
                check_deadline()  # A late lock must never execute a stale write.
                result = operate()
    except RecoveryStale as error:
        result = {'ok': False, 'error': str(error), 'code': 'GIT_RECOVERY_STALE'}
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as error:
        result = {'ok': False, 'error': str(error)}
    return result


def serve(root_path, epoch, nonce):
    """Exact-root, exact-epoch serial protocol. Invalid frames end the stream."""
    root_path = os.path.abspath(root_path)
    original = os.stat(root_path)
    if not os.path.isdir(root_path) or os.path.realpath(root_path) != root_path:
        raise RuntimeError('Workspace lease root is not canonical')
    def identity_check():
        current = os.stat(root_path)
        if os.path.realpath(root_path) != root_path or (original.st_dev, original.st_ino) != (current.st_dev, current.st_ino):
            raise RuntimeError('Workspace lease root identity changed')
    sys.stdout.write(json.dumps({'version': 1, 'nonce': nonce, 'seq': 0, 'ready': True, 'clockMs': int(time.monotonic() * 1000)}, separators=(',', ':')) + '\n')
    sys.stdout.flush()
    expected = 1
    pending = b''
    while True:
        ready, _, _ = select.select([sys.stdin.fileno()], [], [], 90)
        if not ready: return
        chunk = os.read(sys.stdin.fileno(), 65537)
        if not chunk: return
        pending += chunk
        if len(pending) > 65536 and b'\n' not in pending[:65537]:
            raise ValueError('Workspace lease request exceeds limit')
        while b'\n' in pending:
            line, pending = pending.split(b'\n', 1)
            if len(line) > 65536: raise ValueError('Workspace lease request exceeds limit')
            frame = json.loads(line)
            if not isinstance(frame, dict) or set(frame) != {'version', 'nonce', 'seq', 'request', 'deadlineMs'}:
                raise ValueError('Invalid workspace lease frame')
            request = frame['request']
            if (frame['version'] != 1 or frame['nonce'] != nonce or type(frame['seq']) is not int or frame['seq'] != expected or
                type(frame['deadlineMs']) is not int or not time.monotonic() * 1000 - 30000 < frame['deadlineMs'] <= time.monotonic() * 1000 + 30000 or not isinstance(request, dict) or
                request.get('root') != root_path or request.get('epoch') != epoch or
                request.get('op') not in ('read', 'confirm', 'claim', 'recover', 'release') or
                not set(request).issubset({'root', 'epoch', 'op', 'owner', 'id', 'serverChecked', 'checkedLease', 'recoveryLease'}) or
                not isinstance(request.get('owner'), str) or not isinstance(request.get('id'), str)):
                raise ValueError('Workspace lease frame binding changed')
            identity_check()
            result = handle(request, frame['deadlineMs'] / 1000, identity_check)
            identity_check()
            response = json.dumps({'version': 1, 'nonce': nonce, 'seq': expected, 'clockMs': int(time.monotonic() * 1000), 'result': result}, separators=(',', ':'))
            if len(response.encode()) > 1024 * 1024: raise ValueError('Workspace lease response exceeds limit')
            sys.stdout.write(response + '\n')
            sys.stdout.flush()
            expected += 1


if __name__ == '__main__':
    print(json.dumps(handle(json.load(sys.stdin))))
