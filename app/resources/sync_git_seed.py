"""Resume only this binding's first Git replica; never replace an unknown repo."""
import json, os, pathlib, shutil, subprocess, sys

q = json.load(sys.stdin)
root = pathlib.Path(q['root'])
seed = pathlib.Path(str(root) + '.git-seed')
bundle = pathlib.Path(str(root) + '.bundle')
journal = pathlib.Path(str(root) + '.chisa-git-seed.json')
destination = root / '.git'
identity = {'root': str(root), 'epoch': q['epoch'], 'source': str(bundle)}

def git(directory, *args, account=False, missing=False):
    prefix = ['setpriv', '--reuid=1000', '--regid=1000', '--clear-groups', 'env', 'HOME=/nonexistent'] if account else []
    result = subprocess.run(prefix + ['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
                                     '-C', str(directory)] + list(args), capture_output=True, text=True)
    if missing and result.returncode == 2: return ''
    if result.returncode: raise RuntimeError(result.stderr.strip())
    return result.stdout.strip()

def save(record):
    temporary = journal.with_suffix('.tmp')
    with temporary.open('w') as output:
        os.chmod(temporary, 0o600)
        json.dump(record, output)
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, journal)

def seed_contents():
    if seed.is_symlink() or not seed.is_dir():
        raise RuntimeError('Git initialization seed is not an owned directory')
    if any(item.name != '.git' for item in seed.iterdir()):
        raise RuntimeError('Git initialization seed contains other files; preserved its contents')
    if (seed / '.git').is_symlink() or ((seed / '.git').exists() and not (seed / '.git').is_dir()):
        raise RuntimeError('Git initialization seed metadata is not an owned directory')

try:
    record = None
    if journal.exists():
        if journal.is_symlink(): raise RuntimeError('Git initialization journal is not owned by this binding')
        record = json.loads(journal.read_text())
        if any(record.get(key) != value for key, value in identity.items()):
            raise RuntimeError('Git initialization journal belongs to another binding')
    else:
        if destination.exists() or destination.is_symlink():
            raise RuntimeError('Git metadata already exists; preserved the existing repository')
        if seed.exists() or seed.is_symlink():
            # Recognize the old implementation's interrupted no-checkout clone
            # only by its exact source and absence of any user worktree files.
            seed_contents()
            if (seed / '.git').exists() and git(seed, 'remote', 'get-url', 'origin') != str(bundle):
                raise RuntimeError('Existing Git seed has a different source; preserved its contents')
        else:
            seed.mkdir(mode=0o700)
        record = dict(identity)
        allocation = seed.stat(follow_symlinks=False)
        record.update(seedDevice=allocation.st_dev, seedInode=allocation.st_ino)
        save(record)

    if destination.exists() or destination.is_symlink():
        metadata = destination.stat(follow_symlinks=False)
        if destination.is_symlink() or not destination.is_dir() or record.get('device') != metadata.st_dev or record.get('inode') != metadata.st_ino:
            raise RuntimeError('Installed Git metadata changed during initialization; preserved the repository')
    else:
        if seed.exists() or seed.is_symlink():
            seed_contents()
            allocation = seed.stat(follow_symlinks=False)
            if record.get('seedDevice') != allocation.st_dev or record.get('seedInode') != allocation.st_ino:
                raise RuntimeError('Git seed directory changed during initialization; preserved its contents')
            try:
                origin = git(seed, 'remote', 'get-url', 'origin') if (seed / '.git').exists() else ''
            except RuntimeError:
                origin = ''
            if origin and origin != str(bundle):
                raise RuntimeError('Git seed source changed during initialization; preserved its contents')
            if not origin and (seed / '.git').exists():
                # The journal preceded creation of this otherwise empty seed.
                # Partial clone metadata can be replaced; worktree files cannot.
                shutil.rmtree(seed / '.git')
        if not seed.exists():
            seed.mkdir(mode=0o700)
            allocation = seed.stat(follow_symlinks=False)
            record.update(seedDevice=allocation.st_dev, seedInode=allocation.st_ino)
            save(record)
        if not (seed / '.git').exists():
            subprocess.run(['git', '-c', 'core.hooksPath=/dev/null', 'clone', '--no-checkout', str(bundle), str(seed)], check=True)
        else:
            git(seed, 'fetch', '--update-head-ok', '--no-tags', str(bundle), '+refs/*:refs/*')
        git(seed, 'cat-file', '-e', q['head'] + '^{commit}')
        metadata = (seed / '.git').stat(follow_symlinks=False)
        record.update(device=metadata.st_dev, inode=metadata.st_ino)
        save(record)
        os.rename(seed / '.git', destination)

    if seed.exists():
        seed_contents()
        seed.rmdir()
    for directory, names, files in os.walk(destination, followlinks=False):
        os.chown(directory, 1000, 1000, follow_symlinks=False)
        for name in names + files:
            os.chown(pathlib.Path(directory) / name, 1000, 1000, follow_symlinks=False)
    for name, value in [('core.autocrlf', 'input'), ('core.filemode', 'false'), ('core.symlinks', 'false')]:
        git(root, 'config', name, value, account=True)
    exclude = destination / 'info' / 'exclude'
    exclude.parent.mkdir(parents=True, exist_ok=True)
    contents = exclude.read_text() if exclude.exists() else ''
    if '.chisa-bridge.json' not in contents.splitlines():
        exclude.write_text(contents + '\n.chisa-bridge.json\n')
    os.chown(exclude, 1000, 1000)
    if git(root, 'remote', 'get-url', 'origin', account=True, missing=True) == str(bundle):
        if q.get('origin'): git(root, 'remote', 'set-url', 'origin', q['origin'], account=True)
        else: git(root, 'remote', 'remove', 'origin', account=True)
    if q['branch']:
        git(root, 'symbolic-ref', 'HEAD', q['branch'], account=True)
    else:
        git(root, 'update-ref', '--no-deref', 'HEAD', q['head'], account=True)
    git(root, 'reset', '--mixed', q['head'], account=True)
    bundle.unlink(missing_ok=True)
    journal.unlink()
    print(json.dumps({'ok': True}))
except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
    print(str(error), file=sys.stderr)
    sys.exit(125)
