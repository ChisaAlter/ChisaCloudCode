"""Track only lease-owned synchronization writes until their process group ends."""
import fcntl, json, os, signal, subprocess, sys, time
from pathlib import Path

root, epoch, lease_id, job_id, deadline, mode, command = sys.argv[1:8]
lease_dir = Path(root + '.chisa-lease')
marker = lease_dir / 'sync-job.json'
guard_path = Path(root + '.chisa-lease.guard')
child = None
record = None
cancelled = False
cancellation_signals = {signal.SIGHUP, signal.SIGINT, signal.SIGTERM}

def process(pid):
    try:
        fields = Path('/proc/' + str(pid) + '/stat').read_text().rsplit(')', 1)[1].split()
        return fields[0], fields[2], fields[19]
    except FileNotFoundError:
        return None

def group_active(pid):
    for entry in Path('/proc').iterdir():
        if entry.name.isdigit():
            value = process(entry.name)
            if value and value[0] != 'Z' and value[1] == str(pid): return True
    return False

def stop_group(*_):
    if child is not None:
        try: os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError: pass

def cancel_job(*_):
    global cancelled
    cancelled = True
    stop_group()

def check_active():
    if cancelled or signal.sigpending() & cancellation_signals:
        raise RuntimeError('Synchronization canceled')
    if float(deadline) <= time.time(): raise RuntimeError('Synchronization deadline expired')

for event in cancellation_signals:
    signal.signal(event, cancel_job)

try:
    check_active()
    # Admission and lease removal must observe the same persistent lock inode.
    with guard_path.open('a+b') as guard:
        os.fchmod(guard.fileno(), 0o600)
        fcntl.flock(guard, fcntl.LOCK_EX)
        check_active()
        lease = json.loads((lease_dir / 'state.json').read_text())
        if lease.get('id') != lease_id or lease.get('epoch') != epoch:
            raise RuntimeError('Workspace reservation changed before synchronization')
        record = {'jobId': job_id, 'leaseId': lease_id, 'epoch': epoch,
                  'pid': os.getpid(), 'startTime': process(os.getpid())[2]}
        with marker.open('x') as output:
            os.chmod(marker, 0o600)
            json.dump(record, output)
    if mode == 'receive-pack':
        if command != root: raise RuntimeError('Git synchronization root changed')
        argv = ['setpriv', '--reuid=1000', '--regid=1000', '--clear-groups', 'env',
                'HOME=/nonexistent', 'git', '-c', 'core.hooksPath=/dev/null',
                '-c', 'core.fsmonitor=false', 'receive-pack', root]
    else:
        argv = ['bash', '-c', command]
    check_active()
    gate_in, gate_out = os.pipe()
    gate_worker = "import json,os,sys;fd=int(sys.argv[1]);ready=os.read(fd,1);os.close(fd);ready==b'1' or sys.exit(125);args=json.loads(sys.argv[2]);os.execvp(args[0],args)"
    child = subprocess.Popen(['python3', '-c', gate_worker, str(gate_in), json.dumps(argv)],
                             stdin=sys.stdin.buffer, start_new_session=True, pass_fds=(gate_in,))
    os.close(gate_in)
    child_state = process(child.pid)
    record.update(childPid=child.pid, childStartTime=child_state[2] if child_state else '')
    temporary = marker.with_suffix('.tmp')
    temporary.write_text(json.dumps(record))
    os.chmod(temporary, 0o600)
    os.replace(temporary, marker)
    # A cancellation already handled or pending cannot be followed by gate-open.
    previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, cancellation_signals)
    try:
        check_active()
        os.write(gate_out, b'1')
        os.close(gate_out)
    finally:
        signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
    try: code = child.wait(timeout=max(0.001, float(deadline) - time.time()))
    except subprocess.TimeoutExpired:
        stop_group()
        child.wait()
        code = 124
    stop_group()
    for _ in range(50):
        if not group_active(child.pid): break
        time.sleep(0.1)
    if group_active(child.pid):
        raise RuntimeError('Synchronization process cleanup is not confirmed')
    sys.exit(code)
except (OSError, ValueError, RuntimeError) as error:
    print(str(error), file=sys.stderr)
    sys.exit(125)
finally:
    stop_group()
    if child is not None:
        try: child.wait(timeout=5)
        except subprocess.TimeoutExpired: pass
    if record is not None:
        with guard_path.open('a+b') as guard:
            fcntl.flock(guard, fcntl.LOCK_EX)
            if marker.exists():
                current = json.loads(marker.read_text())
                if current.get('jobId') == job_id and (child is None or not group_active(child.pid)):
                    marker.unlink()
