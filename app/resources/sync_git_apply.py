"""Replace Git metadata under the index lock; never checkout worktree files."""
import fcntl, json, os, pathlib, subprocess, sys, tempfile

q = json.load(sys.stdin)
root = pathlib.Path(q['root'])
before, desired = q.get('before'), q.get('desired')
base = ['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', str(root)]

def git(*args, env=None, missing=False):
    p = subprocess.run(base + list(args), env=env, capture_output=True, text=True)
    if missing and p.returncode == 1: return ''
    if p.returncode: raise RuntimeError(p.stderr.strip())
    return p.stdout.strip()

def is_ancestor(ancestor, descendant):
    p = subprocess.run(base + ['merge-base', '--is-ancestor', ancestor, descendant], capture_output=True, text=True)
    if p.returncode == 1: return False
    if p.returncode: raise RuntimeError(p.stderr.strip())
    return True

index = pathlib.Path(git('rev-parse', '--git-path', 'index'))
if not index.is_absolute(): index = root / index
lock = pathlib.Path(str(index) + '.lock')
owned = pathlib.Path(str(index) + '.chisa-owned')
temporary = None

def remove_owned_lock():
    if owned.exists():
        if lock.exists() and os.path.samefile(owned, lock): lock.unlink()
        owned.unlink()

# Kernel lifetime lock plus an inode-identical marker permits recovery after
# SIGKILL without ever guessing that an arbitrary Git lock is stale.
with pathlib.Path(str(index) + '.chisa-guard').open('a+b') as guard:
    fcntl.flock(guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
    remove_owned_lock()
    try:
        with owned.open('xb') as output:
            os.link(owned, lock)
            fd, temporary = tempfile.mkstemp(prefix='chisa-index-', dir=index.parent)
            with os.fdopen(fd, 'wb') as f: f.write(index.read_bytes())
            env = dict(os.environ, GIT_INDEX_FILE=temporary)
            actual = {'head': git('rev-parse', '--verify', 'HEAD^{commit}'),
                      'branch': git('symbolic-ref', '--quiet', 'HEAD', missing=True),
                      'index': git('write-tree', env=env)}
            if q.get('op') == 'read':
                print(json.dumps(actual))
                sys.exit(0)
            if actual != before: raise RuntimeError('Git state changed during synchronization; preserved new edits')
            old = ''
            if desired['branch']:
                for worktree in git('worktree', 'list', '--porcelain', '-z').split('\0\0'):
                    fields = dict(field.split(' ', 1) for field in worktree.split('\0') if ' ' in field)
                    if fields.get('branch') == desired['branch'] and pathlib.Path(fields['worktree']).resolve() != root.resolve():
                        raise RuntimeError('Target Git branch is checked out in another worktree; preserved its history')
                old = git('rev-parse', '--verify', '--quiet', desired['branch'], missing=True)
                if old and desired['branch'] != before['branch'] and old != desired['head'] and not is_ancestor(old, desired['head']):
                    raise RuntimeError('Target Git branch has independent commits; preserved its history')
            backup = q['backup']
            commit = git('-c', 'user.name=Chisa Sync', '-c', 'user.email=sync@localhost',
                         'commit-tree', before['index'], '-p', before['head'], '-m', 'Chisa sync recovery: ' + before['branch'])
            git('update-ref', backup, commit)
            git('read-tree', desired['index'], env=env)
            if desired['branch']:
                if old: git('update-ref', backup + '-branch', old)
                git('update-ref', desired['branch'], desired['head'], old or '0' * len(desired['head']))
                git('symbolic-ref', 'HEAD', desired['branch'])
            else:
                git('update-ref', '--no-deref', 'HEAD', desired['head'], before['head'])
            output.write(pathlib.Path(temporary).read_bytes())
            output.flush()
            os.fsync(output.fileno())
        os.replace(lock, index)
    finally:
        remove_owned_lock()
        if temporary is not None: pathlib.Path(temporary).unlink(missing_ok=True)
