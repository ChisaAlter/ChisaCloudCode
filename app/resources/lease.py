"""Desktop ownership operations; state lives beside, never inside, the project."""
import fcntl, json, os, re, shutil, subprocess, sys
from pathlib import Path

q = json.load(sys.stdin)
root = Path(q['root'])
lock = Path(str(root) + '.chisa-lease')
state_file = lock / 'state.json'
op = q['op']

class RecoveryStale(RuntimeError):
    pass

def state():
    if not lock.exists(): return None
    return json.loads(state_file.read_text())

def persist(value):
    temp = lock / 'state.tmp'
    temp.write_text(json.dumps(value))
    os.chmod(temp, 0o600)
    os.replace(temp, state_file)

def confirm_sync_finished(current):
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
            if not entry.name.isdigit(): continue
            try: fields = (entry / 'stat').read_text().rsplit(')', 1)[1].split()
            except FileNotFoundError: continue
            if fields[0] != 'Z' and fields[2] == str(group):
                raise RuntimeError('Synchronization descendants are still running; keep the reservation')
    marker.unlink()

def operate():
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
                    if not isinstance(name, str) or not re.fullmatch(r'chisa-rpc-(?:[a-f0-9]{16}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})', name):
                        raise RuntimeError('Workspace cleanup record is invalid')
                    removed = subprocess.run(['docker', 'rm', '--force', name], capture_output=True, text=True, timeout=10)
                    if removed.returncode == 0: continue
                    inspected = subprocess.run(['docker', 'ps', '--all', '--format', '{{.Names}}', '--filter', 'name=^/' + name + '$'], capture_output=True, text=True, timeout=10)
                    if inspected.returncode != 0 or inspected.stdout.strip():
                        raise RuntimeError('Workspace container cleanup is not confirmed; keep the reservation')
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
        if current: shutil.rmtree(lock)
        result = {'ok': True}
    else: raise ValueError('Unknown ownership operation')
    return result

try:
    if op == 'read':
        # state.json is atomically replaced. Metadata previews never create a
        # lease directory/guard or mutate another task's ownership record.
        result = operate()
    else:
        # Keep this inode outside the directory that release/recover remove.
        with Path(str(root) + '.chisa-lease.guard').open('a+b') as guard:
            os.fchmod(guard.fileno(), 0o600)
            fcntl.flock(guard, fcntl.LOCK_EX)
            result = operate()
except RecoveryStale as error:
    result = {'ok': False, 'error': str(error), 'code': 'GIT_RECOVERY_STALE'}
except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as error:
    result = {'ok': False, 'error': str(error)}
print(json.dumps(result))
