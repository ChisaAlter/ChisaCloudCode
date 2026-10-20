"""Resume only this binding's first Git replica; never replace an unknown repo."""
import hashlib, json, os, pathlib, re, shutil, subprocess, sys, uuid

q = json.load(sys.stdin)
root = pathlib.Path(q['root'])
seed = pathlib.Path(str(root) + '.git-seed')
bundle = pathlib.Path(str(root) + '.bundle')
journal = pathlib.Path(str(root) + '.chisa-git-seed.json')
destination = root / '.git'
identity = {'root': str(root), 'epoch': q['epoch'], 'source': str(bundle)}

def git(directory, *args, account=False, missing=False, index_file=None):
    prefix = ['setpriv', '--reuid=1000', '--regid=1000', '--clear-groups', 'env', 'HOME=/nonexistent'] if account else []
    result = subprocess.run(prefix + ['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
                                     '-C', str(directory)] + list(args), capture_output=True, text=True,
                            env=dict(os.environ, GIT_INDEX_FILE=str(index_file)) if index_file is not None else None)
    if missing and result.returncode == 2: return ''
    if result.returncode: raise RuntimeError(result.stderr.strip())
    return result.stdout.strip()

def metadata_state(directory):
    metadata = directory / '.git'
    return {name: hashlib.sha256((metadata / name).read_bytes()).hexdigest() if (metadata / name).exists() else None for name in ('HEAD', 'index')}

def index_entries(directory, index_file=None):
    return git(directory, 'ls-files', '--stage', '-z', account=True, index_file=index_file)

def reconcile_intent(record):
    intent = record.get('intent')
    if not intent: return
    actual = metadata_state(root)
    before = intent['before']
    acceptable = actual == before
    if intent['kind'] == 'head':
        acceptable = acceptable or (actual['index'] == before['index'] and actual['HEAD'] == intent['headAfter'])
    elif intent['kind'] == 'index':
        acceptable = acceptable or (actual['HEAD'] == before['HEAD'] and hashlib.sha256(index_entries(root).encode()).hexdigest() == intent['entriesAfter'])
    if not acceptable:
        raise RuntimeError('Installed HEAD or index changed during interrupted initialization; preserved the repository')
    record['state'] = actual
    del record['intent']
    save(record)

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

def import_refs(directory, account=False):
    manifest = {}
    detached = False
    for line in git(directory, 'bundle', 'list-heads', str(bundle)).splitlines():
        oid, name = line.split(' ', 1)
        if name.startswith('refs/'): manifest[name] = oid
        elif name == 'HEAD':
            detached = True
            if oid != q['head']:
                raise RuntimeError('Git bundle HEAD changed during initialization')
    if q['branch'] and manifest.get(q['branch']) != q['head']:
        raise RuntimeError('Git bundle branch changed during initialization')
    shallow = q.get('shallow', '')
    size = 64 if q.get('objectFormat', 'sha1') == 'sha256' else 40
    boundaries = shallow.splitlines()
    if any(not re.fullmatch('[a-f0-9]{%d}' % size, oid) for oid in boundaries):
        raise RuntimeError('Git shallow boundary is invalid')
    metadata = directory / '.git'
    target = metadata / 'shallow'
    if target.is_symlink(): raise RuntimeError('Git shallow metadata is not owned')
    if boundaries:
        temporary = metadata / ('shallow.chisa-' + uuid.uuid4().hex)
        with temporary.open('x') as output:
            output.write('\n'.join(boundaries) + '\n')
            output.flush()
            os.fsync(output.fileno())
        if account: os.chown(temporary, 1000, 1000)
        os.replace(temporary, target)
    elif target.exists():
        target.unlink()
    refspecs = ['+refs/*:refs/*'] + (['HEAD'] if detached else [])
    git(directory, 'fetch', '--update-head-ok', '--no-tags', str(bundle), *refspecs, account=account)
    # A legacy no-checkout clone created synthetic remote-tracking refs. Remove
    # only these owned-seed artifacts, never source refs or an unknown repository.
    for line in git(directory, 'for-each-ref', '--format=%(objectname) %(refname)', 'refs/remotes/origin/', account=account).splitlines():
        oid, name = line.split(' ', 1)
        if name not in manifest: git(directory, 'update-ref', '--no-deref', '-d', name, account=account)
    actual = dict(line.split(' ', 1)[::-1] for line in git(directory, 'for-each-ref', '--format=%(objectname) %(refname)', account=account).splitlines())
    if actual != manifest:
        raise RuntimeError('Git initialization did not preserve every source reference')
    # Stale shallow entries need not be reachable (or present in an --all bundle).
    # Git validates connectivity for the imported refs using the exact boundaries.
    git(directory, 'cat-file', '-e', q['head'] + '^{commit}', account=account)
    git(directory, 'fsck', '--connectivity-only', '--no-dangling', account=account)

try:
    with bundle.open('rb') as source:
        fingerprint = hashlib.file_digest(source, 'sha256').hexdigest()
    payload = {'refs': sorted(git(root, 'bundle', 'list-heads', str(bundle)).splitlines()), 'head': q['head'], 'branch': q['branch'], 'shallow': q.get('shallow', ''), 'objectFormat': q.get('objectFormat', 'sha1')}
    record = None
    if journal.exists():
        if journal.is_symlink(): raise RuntimeError('Git initialization journal is not owned by this binding')
        record = json.loads(journal.read_text())
        if any(record.get(key) != value for key, value in identity.items()):
            raise RuntimeError('Git initialization journal belongs to another binding')
        if record.get('payload') is not None and record['payload'] != payload:
            raise RuntimeError('Git initialization source changed; preserved the resumable repository')
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

    record['payload'] = payload
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
            if (seed / '.git').exists():
                metadata = (seed / '.git').stat(follow_symlinks=False)
                if record.get('seedGitDevice') is not None:
                    if record['seedGitDevice'] != metadata.st_dev or record['seedGitInode'] != metadata.st_ino:
                        raise RuntimeError('Git seed metadata changed during initialization; preserved its contents')
                elif not origin:
                    raise RuntimeError('Git seed metadata ownership cannot be confirmed; preserved its contents')
                record.update(seedGitDevice=metadata.st_dev, seedGitInode=metadata.st_ino)
                save(record)
        if not seed.exists():
            seed.mkdir(mode=0o700)
            allocation = seed.stat(follow_symlinks=False)
            record.update(seedDevice=allocation.st_dev, seedInode=allocation.st_ino)
            save(record)
        if not (seed / '.git').exists():
            (seed / '.git').mkdir(mode=0o700)
            metadata = (seed / '.git').stat(follow_symlinks=False)
            record.update(seedGitDevice=metadata.st_dev, seedGitInode=metadata.st_ino)
            save(record)
        git(seed, 'init', '--object-format=' + q.get('objectFormat', 'sha1'))
        if not git(seed, 'remote', 'get-url', 'origin', missing=True):
            git(seed, 'remote', 'add', 'origin', str(bundle))
        import_refs(seed)
        record['refsImported'] = fingerprint
        record['state'] = metadata_state(seed)
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
    # Installed-but-unfinished journals resume the same reference verification.
    reconcile_intent(record)
    if record.get('state') is not None and metadata_state(root) != record['state']:
        raise RuntimeError('Installed HEAD or index changed after interrupted initialization; preserved the repository')
    if record.get('refsImported') == fingerprint:
        expected = dict(line.split(' ', 1)[::-1] for line in payload['refs'] if line.split(' ', 1)[1].startswith('refs/'))
        present = dict(line.split(' ', 1)[::-1] for line in git(root, 'for-each-ref', '--format=%(objectname) %(refname)', account=True).splitlines())
        current_shallow = (destination / 'shallow').read_text() if (destination / 'shallow').exists() else ''
        if present != expected or current_shallow.splitlines() != q.get('shallow', '').splitlines():
            raise RuntimeError('Installed Git state changed after interrupted initialization; preserved the repository')
    else:
        import_refs(root, account=True)
        record['refsImported'] = fingerprint
        save(record)
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
        else: git(root, 'config', '--remove-section', 'remote.origin', account=True)
    desired_head = ('ref: ' + q['branch'] if q['branch'] else q['head']) + '\n'
    record['intent'] = {'kind': 'head', 'before': metadata_state(root), 'headAfter': hashlib.sha256(desired_head.encode()).hexdigest()}
    save(record)
    if q['branch']:
        git(root, 'symbolic-ref', 'HEAD', q['branch'], account=True)
    else:
        git(root, 'update-ref', '--no-deref', 'HEAD', q['head'], account=True)
    reconcile_intent(record)
    planned_index = destination / ('index.chisa-' + uuid.uuid4().hex)
    try:
        git(root, 'read-tree', q['head'], account=True, index_file=planned_index)
        entries_after = hashlib.sha256(index_entries(root, planned_index).encode()).hexdigest()
    finally:
        planned_index.unlink(missing_ok=True)
    record['intent'] = {'kind': 'index', 'before': metadata_state(root), 'entriesAfter': entries_after}
    save(record)
    git(root, 'reset', '--mixed', q['head'], account=True)
    reconcile_intent(record)
    expected = dict(line.split(' ', 1)[::-1] for line in payload['refs'] if line.split(' ', 1)[1].startswith('refs/'))
    actual = dict(line.split(' ', 1)[::-1] for line in git(root, 'for-each-ref', '--format=%(objectname) %(refname)', account=True).splitlines())
    if actual != expected:
        raise RuntimeError('Git references changed while completing initialization')
    bundle.unlink(missing_ok=True)
    journal.unlink()
    print(json.dumps({'ok': True}))
except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
    print(str(error), file=sys.stderr)
    sys.exit(125)
