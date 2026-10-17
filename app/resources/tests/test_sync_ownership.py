"""Linux-only local resource regressions; every mutable path is a test temp path.

Run from the checkout with:
    python3 -B app/resources/tests/test_sync_ownership.py -v

F03 uses real flock, signals, /proc and child processes. F09 uses real Git refs,
indexes and linked worktrees. F25 uses real local bundle/clone/fetch/move/config;
its adapter strips setpriv and maps chown to the test user's uid/gid. These tests
do not validate production UID 1000 privilege separation, SSH or Mutagen.
"""
import json
import os
from pathlib import Path
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest

if sys.platform != 'linux':
    raise SystemExit('Linux with real fcntl and /proc is required; run this suite in the existing local WSL environment')

import fcntl

RESOURCES = Path(__file__).resolve().parents[1]

# Only the temp helper installs scheduling barriers. Product code is executed
# unchanged by runpy, with real locks/signals/processes and local Git commands.
ADAPTER = r'''
import fcntl, json, os, pathlib, runpy, shutil, signal, subprocess, sys, time
script, mode, root, ready, proceed = sys.argv[1:6]
sys.argv = [script] + sys.argv[6:]
root = pathlib.Path(root)
ready, proceed = pathlib.Path(ready), pathlib.Path(proceed)
lease = pathlib.Path(str(root) + '.chisa-lease')
guard = pathlib.Path(str(root) + '.chisa-lease.guard')
marker = lease / 'sync-job.json'

original_readlink = os.readlink
def readlink(path, *args, **kwargs):
    if mode.startswith('legacy-') and str(path) == '/proc/' + mode.rsplit(':', 1)[1] + '/exe':
        role = mode.split(':', 1)[0]
        if role == 'legacy-node-role': return '/usr/bin/node'
        if role == 'legacy-unknown-role': return '/opt/custom/bin/unknown-worker'
        if role == 'legacy-readlink-error': raise PermissionError('Test-owned executable identity is unreadable')
    return original_readlink(path, *args, **kwargs)
os.readlink = readlink

def checkpoint():
    ready.write_text('ready')
    until = time.monotonic() + 20
    while not proceed.exists():
        if time.monotonic() >= until: raise RuntimeError('Test scheduling barrier timed out')
        time.sleep(0.01)

original_flock = fcntl.flock
def flock(fd, operation):
    if mode == 'observe-admission' and operation & fcntl.LOCK_EX:
        if pathlib.Path(os.readlink('/proc/self/fd/' + str(fd.fileno() if hasattr(fd, 'fileno') else fd))) == guard:
            ready.write_text('admission requested')
    return original_flock(fd, operation)
fcntl.flock = flock

original_rmtree = shutil.rmtree
def rmtree(path, *args, **kwargs):
    if mode == 'release-before-remove' and pathlib.Path(path) == lease: checkpoint()
    return original_rmtree(path, *args, **kwargs)
shutil.rmtree = rmtree

original_replace = os.replace
def replace(src, dst, *args, **kwargs):
    result = original_replace(src, dst, *args, **kwargs)
    if mode == 'before-gate' and pathlib.Path(dst) == marker: checkpoint()
    return result
os.replace = replace

original_sigmask = signal.pthread_sigmask
def sigmask(how, values):
    result = original_sigmask(how, values)
    if mode == 'pending-gate' and how == signal.SIG_BLOCK: checkpoint()
    return result
signal.pthread_sigmask = sigmask

original_run = subprocess.run
def run(argv, *args, **kwargs):
    command = list(argv)
    if mode.startswith('seed-') and command[:1] == ['setpriv']:
        prefix = ['setpriv', '--reuid=1000', '--regid=1000', '--clear-groups', 'env', 'HOME=/nonexistent']
        if command[:len(prefix)] != prefix: raise RuntimeError('Unexpected setpriv contract in seed worker')
        command = command[len(prefix):]
    result = original_run(command, *args, **kwargs)
    if mode == 'seed-after-clone' and 'clone' in command and result.returncode == 0: checkpoint()
    if mode == 'seed-after-config' and 'config' in command and 'core.autocrlf' in command and result.returncode == 0: checkpoint()
    return result
subprocess.run = run

original_rename = os.rename
def rename(src, dst, *args, **kwargs):
    result = original_rename(src, dst, *args, **kwargs)
    if mode == 'seed-after-move' and pathlib.Path(dst) == root / '.git': checkpoint()
    return result
os.rename = rename

original_chown = os.chown
def chown(path, uid, gid, *args, **kwargs):
    candidate = pathlib.Path(path)
    if not candidate.is_relative_to(root): raise RuntimeError('Seed ownership escaped the test project')
    if (uid, gid) != (1000, 1000): raise RuntimeError('Unexpected production ownership contract')
    return original_chown(path, os.getuid(), os.getgid(), *args, **kwargs)
if mode.startswith('seed-'): os.chown = chown

runpy.run_path(script, run_name='__main__')
'''


class ResourceCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='chisa-sync-ownership-')
        self.base = Path(self.temp.name)
        self.root = self.base / 'project'
        self.root.mkdir()
        self.adapter = self.base / 'worker_adapter.py'
        self.adapter.write_text(ADAPTER)
        self.children = []
        self.counter = 0
        self.env = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
        self.env.update(HOME=str(self.base / 'home'), XDG_CONFIG_HOME=str(self.base / 'xdg'),
                        GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null', PYTHONDONTWRITEBYTECODE='1')

    def tearDown(self):
        for child in reversed(self.children):
            if child.poll() is None:
                child.terminate()
                try: child.communicate(timeout=2)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.communicate(timeout=5)
        self.temp.cleanup()

    def start(self, script, *, mode='', args=(), payload=None, root=None):
        self.counter += 1
        ready = self.base / ('ready-' + str(self.counter))
        proceed = self.base / ('proceed-' + str(self.counter))
        command = [sys.executable, '-B', str(self.adapter), str(RESOURCES / script), mode,
                   str(root or self.root), str(ready), str(proceed), *map(str, args)]
        if payload is None:
            child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, text=True, env=self.env)
        else:
            input_path = self.base / ('input-' + str(self.counter) + '.json')
            input_path.write_text(json.dumps(payload))
            with input_path.open('rb') as source:
                child = subprocess.Popen(command, stdin=source, stdout=subprocess.PIPE,
                                         stderr=subprocess.PIPE, text=True, env=self.env)
        self.children.append(child)
        return child, ready, proceed

    def finish(self, child, expected=0):
        output, error = child.communicate(timeout=20)
        self.assertEqual(child.returncode, expected, output + error)
        return output, error

    def wait_path(self, *paths, child=None):
        until = time.monotonic() + 10
        while time.monotonic() < until:
            for path in paths:
                if path.exists(): return path
            if child is not None and child.poll() is not None:
                output, error = child.communicate()
                self.fail('Worker exited before its checkpoint: ' + output + error)
            time.sleep(0.01)
        self.fail('Timed out waiting for test-owned paths: ' + ', '.join(map(str, paths)))

    def lease(self, operation, *, root=None, mode='', **values):
        request = dict(root=str(root or self.root), op=operation, owner='sync', id='exact-lease', epoch='test-epoch')
        request.update(values)
        return self.start('lease.py', payload=request, mode=mode, root=root)

    def claim(self, root=None):
        child, _, _ = self.lease('claim', root=root)
        self.assertTrue(json.loads(self.finish(child)[0])['ok'])

    def job(self, command, *, root=None, mode=''):
        root = root or self.root
        return self.start('sync_job.py', mode=mode, root=root,
                          args=(root, 'test-epoch', 'exact-lease', 'job-' + str(self.counter),
                                str(time.time() + 30), 'shell', command))

    def python_command(self, code):
        return 'exec ' + shlex.quote(sys.executable) + ' -c ' + shlex.quote(code)

    def git(self, directory, *args):
        command = ['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', str(directory), *args]
        result = subprocess.run(command, text=True, capture_output=True, env=self.env)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result.stdout.strip()

    def init_repo(self, directory):
        directory.mkdir(exist_ok=True)
        self.git(directory, 'init', '-b', 'main')
        self.git(directory, 'config', 'user.name', 'Local resource regression')
        self.git(directory, 'config', 'user.email', 'local-test@example.invalid')
        (directory / 'tracked.txt').write_text('base\n')
        self.git(directory, 'add', 'tracked.txt')
        self.git(directory, 'commit', '-m', 'base')
        return self.git(directory, 'rev-parse', 'HEAD')


class SynchronizationOwnershipTests(ResourceCase):
    def test_release_wins_before_delayed_job_admission(self):
        self.claim()
        guard = Path(str(self.root) + '.chisa-lease.guard')
        inode = guard.stat().st_ino
        release, paused, resume = self.lease('release', mode='release-before-remove')
        self.wait_path(paused, child=release)
        wrote = self.base / 'late-write'
        command = self.python_command('from pathlib import Path; Path(' + repr(str(wrote)) + ").write_text('late')")
        job, admitted, _ = self.job(command, mode='observe-admission')
        # If admission ignores the shared lock, the real child writes instead.
        self.assertEqual(self.wait_path(admitted, wrote, child=job), admitted)
        resume.touch()
        self.assertTrue(json.loads(self.finish(release)[0])['ok'])
        self.finish(job, 125)
        self.assertFalse(wrote.exists())
        self.assertFalse(Path(str(self.root) + '.chisa-lease').exists())
        self.assertEqual(guard.stat().st_ino, inode)

    def test_live_registered_job_blocks_release_until_writer_exits(self):
        self.claim()
        started, complete = self.base / 'writer-started', self.base / 'writer-complete'
        code = ('from pathlib import Path; import time; Path(' + repr(str(started)) + ").write_text('started'); "
                'done=Path(' + repr(str(complete)) + ')\nwhile not done.exists(): time.sleep(0.01)')
        job, _, _ = self.job(self.python_command(code))
        self.wait_path(started, child=job)
        marker = Path(str(self.root) + '.chisa-lease') / 'sync-job.json'
        observed = json.loads(marker.read_text())
        self.assertEqual(observed['leaseId'], 'exact-lease')
        release, _, _ = self.lease('release')
        result = json.loads(self.finish(release)[0])
        self.assertFalse(result['ok'])
        self.assertIn('still running', result['error'])
        self.assertEqual(json.loads(marker.read_text()), observed)
        complete.touch()
        self.finish(job)
        release, _, _ = self.lease('release')
        self.assertTrue(json.loads(self.finish(release)[0])['ok'])

    def test_cancel_while_waiting_for_admission_never_opens_gate(self):
        for event in (signal.SIGHUP, signal.SIGTERM):
            with self.subTest(signal=event):
                root = self.base / ('cancel-' + str(event))
                root.mkdir()
                self.claim(root)
                wrote = root / 'must-not-write'
                command = self.python_command('from pathlib import Path; Path(' + repr(str(wrote)) + ").write_text('late')")
                with Path(str(root) + '.chisa-lease.guard').open('a+b') as guard:
                    fcntl.flock(guard, fcntl.LOCK_EX)
                    job, waiting, _ = self.job(command, root=root, mode='observe-admission')
                    self.wait_path(waiting, child=job)
                    job.send_signal(event)
                    fcntl.flock(guard, fcntl.LOCK_UN)
                _, error = self.finish(job, 125)
                self.assertIn('Synchronization canceled', error)
                self.assertFalse(wrote.exists())
                self.assertFalse((Path(str(root) + '.chisa-lease') / 'sync-job.json').exists())

    def test_handled_and_pending_cancel_before_gate_never_execute_command(self):
        for mode in ('before-gate', 'pending-gate'):
            with self.subTest(mode=mode):
                root = self.base / mode
                root.mkdir()
                self.claim(root)
                wrote = root / 'must-not-write'
                command = self.python_command('from pathlib import Path; Path(' + repr(str(wrote)) + ").write_text('late')")
                job, paused, resume = self.job(command, root=root, mode=mode)
                self.wait_path(paused, child=job)
                job.send_signal(signal.SIGHUP)
                resume.touch()
                _, error = self.finish(job, 125)
                self.assertIn('Synchronization canceled', error)
                self.assertFalse(wrote.exists())
                release, _, _ = self.lease('release', root=root)
                self.assertTrue(json.loads(self.finish(release)[0])['ok'])


class GitApplySafetyTests(ResourceCase):
    def setUp(self):
        super().setUp()
        if not shutil.which('git'): self.fail('A local Git executable is required')
        self.head = self.init_repo(self.root)
        self.git(self.root, 'branch', 'feature')
        self.git(self.root, 'checkout', '-b', 'cloud-tip')
        (self.root / 'tracked.txt').write_text('cloud\n')
        self.git(self.root, 'commit', '-am', 'cloud')
        self.desired_head = self.git(self.root, 'rev-parse', 'HEAD')
        self.desired_tree = self.git(self.root, 'write-tree')
        self.git(self.root, 'checkout', 'main')
        (self.root / 'untracked.txt').write_text('keep untracked\n')

    def state(self):
        return dict(head=self.git(self.root, 'rev-parse', 'HEAD'),
                    branch=self.git(self.root, 'symbolic-ref', 'HEAD'),
                    index=self.git(self.root, 'write-tree'))

    def apply(self):
        desired = dict(head=self.desired_head, branch='refs/heads/feature', index=self.desired_tree)
        request = dict(root=str(self.root), before=self.state(), desired=desired, backup='refs/chisa/recovery/local-test')
        return self.start('sync_git_apply.py', payload=request)[0]

    def snapshot(self):
        self.git(self.root, 'write-tree')
        return dict(refs=self.git(self.root, 'for-each-ref', '--format=%(refname) %(objectname)'),
                    head=(self.root / '.git/HEAD').read_bytes(), index=(self.root / '.git/index').read_bytes(),
                    tracked=(self.root / 'tracked.txt').read_bytes(), untracked=(self.root / 'untracked.txt').read_bytes())

    def test_independent_inactive_branch_is_preserved(self):
        self.git(self.root, 'checkout', 'feature')
        (self.root / 'tracked.txt').write_text('independent\n')
        self.git(self.root, 'commit', '-am', 'independent')
        self.git(self.root, 'checkout', 'main')
        before = self.snapshot()
        worker = self.apply()
        _, error = worker.communicate(timeout=20)
        self.assertNotEqual(worker.returncode, 0)
        self.assertIn('independent commits', error)
        self.assertEqual(self.snapshot(), before)

    def test_branch_checked_out_in_linked_worktree_is_preserved(self):
        linked = self.base / 'linked'
        self.git(self.root, 'worktree', 'add', str(linked), 'feature')
        before = self.snapshot()
        linked_head = self.git(linked, 'rev-parse', 'HEAD')
        linked_index = Path(self.git(linked, 'rev-parse', '--git-path', 'index')).read_bytes()
        worker = self.apply()
        _, error = worker.communicate(timeout=20)
        self.assertNotEqual(worker.returncode, 0)
        self.assertIn('another worktree', error)
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.git(linked, 'rev-parse', 'HEAD'), linked_head)
        self.assertEqual(Path(self.git(linked, 'rev-parse', '--git-path', 'index')).read_bytes(), linked_index)

    def test_inactive_fast_forward_updates_metadata_without_checkout(self):
        before = self.snapshot()
        self.finish(self.apply())
        self.assertEqual(self.state(), dict(head=self.desired_head, branch='refs/heads/feature', index=self.desired_tree))
        self.assertEqual(self.git(self.root, 'rev-parse', 'main'), self.head)
        self.assertEqual((self.root / 'tracked.txt').read_bytes(), before['tracked'])
        self.assertEqual((self.root / 'untracked.txt').read_bytes(), before['untracked'])
        self.assertEqual(self.git(self.root, 'show', ':tracked.txt'), 'cloud')


class GitSeedRecoveryTests(ResourceCase):
    def setUp(self):
        super().setUp()
        if not shutil.which('git'): self.fail('A local Git executable is required')
        self.source = self.base / 'source'
        self.head = self.init_repo(self.source)
        self.bundle = Path(str(self.root) + '.bundle')
        self.seed = Path(str(self.root) + '.git-seed')
        self.journal = Path(str(self.root) + '.chisa-git-seed.json')
        self.git(self.source, 'bundle', 'create', str(self.bundle), '--all')
        self.request = dict(root=str(self.root), epoch='seed-epoch', head=self.head,
                            branch='refs/heads/main', origin=str(self.source))
        (self.root / 'tracked.txt').write_text('existing user worktree bytes\n')
        (self.root / 'untracked.txt').write_text('keep untracked\n')

    def run_seed(self, mode='seed-normal', request=None):
        return self.start('sync_git_seed.py', payload=request or self.request, mode=mode)[0]

    def interrupt_seed(self, mode):
        child, paused, _ = self.start('sync_git_seed.py', payload=self.request, mode=mode)
        self.wait_path(paused, child=child)
        child.kill()
        self.finish(child, -signal.SIGKILL)

    def assert_completed(self):
        self.assertEqual(self.git(self.root, 'rev-parse', 'HEAD'), self.head)
        self.assertEqual(self.git(self.root, 'symbolic-ref', 'HEAD'), 'refs/heads/main')
        self.assertEqual(self.git(self.root, 'write-tree'), self.git(self.source, 'write-tree'))
        for key, value in (('core.autocrlf', 'input'), ('core.filemode', 'false'), ('core.symlinks', 'false')):
            self.assertEqual(self.git(self.root, 'config', '--get', key), value)
        self.assertEqual(self.git(self.root, 'remote', 'get-url', 'origin'), str(self.source))
        self.assertIn('.chisa-bridge.json', (self.root / '.git/info/exclude').read_text().splitlines())
        self.assertEqual((self.root / 'tracked.txt').read_text(), 'existing user worktree bytes\n')
        self.assertEqual((self.root / 'untracked.txt').read_text(), 'keep untracked\n')
        self.assertFalse(self.seed.exists())
        self.assertFalse(self.journal.exists())
        self.assertFalse(self.bundle.exists())

    def test_clone_move_and_config_interruptions_resume_exact_owned_metadata(self):
        for mode in ('seed-after-clone', 'seed-after-move', 'seed-after-config'):
            with self.subTest(checkpoint=mode):
                # A fresh independent project keeps each interrupted phase real.
                root = self.base / mode
                root.mkdir()
                original = (self.root, self.bundle, self.seed, self.journal, self.request)
                self.root = root
                self.bundle = Path(str(root) + '.bundle')
                self.seed = Path(str(root) + '.git-seed')
                self.journal = Path(str(root) + '.chisa-git-seed.json')
                self.request = dict(self.request, root=str(root))
                self.git(self.source, 'bundle', 'create', str(self.bundle), '--all')
                (root / 'tracked.txt').write_text('existing user worktree bytes\n')
                (root / 'untracked.txt').write_text('keep untracked\n')
                try:
                    self.interrupt_seed(mode)
                    self.assertTrue(self.journal.exists())
                    metadata = (self.seed if mode == 'seed-after-clone' else root) / '.git'
                    before = metadata.stat()
                    self.finish(self.run_seed())
                    after = (root / '.git').stat()
                    self.assertEqual((before.st_dev, before.st_ino), (after.st_dev, after.st_ino))
                    self.assert_completed()
                finally:
                    self.root, self.bundle, self.seed, self.journal, self.request = original

    def test_legacy_exact_bundle_seed_is_adopted_without_replacing_its_objects(self):
        self.git(self.base, 'clone', '--no-checkout', str(self.bundle), str(self.seed))
        before = (self.seed / '.git').stat()
        self.finish(self.run_seed())
        after = (self.root / '.git').stat()
        self.assertEqual((before.st_dev, before.st_ino), (after.st_dev, after.st_ino))
        self.assert_completed()

    def test_foreign_seed_and_changed_epoch_are_preserved(self):
        self.seed.mkdir()
        sentinel = self.seed / 'user-file'
        sentinel.write_text('not an initialization allocation')
        self.finish(self.run_seed(), 125)
        self.assertEqual(sentinel.read_text(), 'not an initialization allocation')
        self.assertFalse(self.journal.exists())
        sentinel.unlink()
        self.seed.rmdir()
        self.interrupt_seed('seed-after-clone')
        before = (self.seed / '.git').stat()
        self.finish(self.run_seed(request=dict(self.request, epoch='another-binding')), 125)
        after = (self.seed / '.git').stat()
        self.assertEqual((before.st_dev, before.st_ino), (after.st_dev, after.st_ino))
        self.assertTrue(self.bundle.exists())
        self.assertTrue(self.journal.exists())
        self.assertFalse((self.root / '.git').exists())


class ManualLeaseIdentityTests(ResourceCase):
    def setUp(self):
        super().setUp()
        self.claim()
        self.state_file = Path(str(self.root) + '.chisa-lease') / 'state.json'
        fields = Path('/proc/self/stat').read_text().rsplit(')', 1)[1].split()
        self.identity = dict(owner='claude', id='exact-lease', epoch='test-epoch', pid=os.getpid(),
                             processStartTime=fields[19], bootId=Path('/proc/sys/kernel/random/boot_id').read_text().strip())

    def recover(self, identity, mode=''):
        self.state_file.write_text(json.dumps(identity))
        child, _, _ = self.lease('recover', mode=mode)
        return json.loads(self.finish(child)[0])

    def test_legacy_live_system_sleep_pid_can_be_recovered(self):
        sleeper = subprocess.Popen(['/usr/bin/sleep', '30'], stdin=subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=self.env)
        self.children.append(sleeper)
        legacy = {key: value for key, value in self.identity.items() if key not in ('processStartTime', 'bootId')}
        legacy['pid'] = sleeper.pid
        self.assertIsNone(sleeper.poll())
        self.assertTrue(self.recover(legacy)['ok'])
        self.assertEqual(json.loads(self.state_file.read_text())['owner'], 'sync')
        self.assertIsNone(sleeper.poll(), 'Recovery must not kill the unrelated live process')

    def test_legacy_node_unknown_or_unreadable_executable_stays_reserved(self):
        # This local WSL has no Node. Keep a real live PID for kill(0), and vary
        # only its exact /proc/<pid>/exe readlink result in the temp adapter.
        worker = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'],
                                  stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, text=True, env=self.env)
        self.children.append(worker)
        legacy = {key: value for key, value in self.identity.items() if key not in ('processStartTime', 'bootId')}
        legacy['pid'] = worker.pid
        for role in ('legacy-node-role', 'legacy-unknown-role', 'legacy-readlink-error'):
            with self.subTest(role=role):
                self.assertIsNone(worker.poll())
                result = self.recover(legacy, mode=role + ':' + str(worker.pid))
                self.assertFalse(result['ok'])
                self.assertIn('Claude is still running', result['error'])
                self.assertEqual(json.loads(self.state_file.read_text()), legacy)
                self.assertIsNone(worker.poll(), 'A protected legacy owner must remain alive')

    def test_live_exact_birth_identity_stays_reserved(self):
        result = self.recover(self.identity)
        self.assertFalse(result['ok'])
        self.assertIn('Claude is still running', result['error'])
        self.assertEqual(json.loads(self.state_file.read_text()), self.identity)

    def test_reused_pid_birth_identity_can_be_recovered(self):
        changed = dict(self.identity, processStartTime=str(int(self.identity['processStartTime']) + 1))
        self.assertTrue(self.recover(changed)['ok'])
        self.assertEqual(json.loads(self.state_file.read_text())['owner'], 'sync')

    def test_partial_or_malformed_birth_identity_is_not_recovered(self):
        partial = dict(self.identity)
        del partial['bootId']
        for identity in (partial, dict(self.identity, bootId='not-a-boot-id'), dict(self.identity, processStartTime=123)):
            with self.subTest(identity=identity):
                result = self.recover(identity)
                self.assertFalse(result['ok'])
                self.assertIn('identity is invalid', result['error'])
                self.assertEqual(json.loads(self.state_file.read_text()), identity)


if __name__ == '__main__':
    unittest.main()
