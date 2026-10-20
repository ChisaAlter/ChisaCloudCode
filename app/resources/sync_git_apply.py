"""Replace portable Git metadata under the index lock; never checkout files."""
import base64, fcntl, json, os, pathlib, re, subprocess, sys, tempfile

q = json.load(sys.stdin)
root = pathlib.Path(q['root'])
before, desired = q.get('before'), q.get('desired')
base = ['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', str(root)]
stages_prefix, operations_prefix = 'stages-v1:', 'files-v1:'
operation_files = ('ORIG_HEAD', 'MERGE_HEAD', 'MERGE_MSG', 'MERGE_MODE', 'MERGE_RR', 'MERGE_AUTOSTASH', 'AUTO_MERGE',
                   'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD', 'SQUASH_MSG')
operation_directories = ('rebase-merge', 'rebase-apply', 'sequencer', 'refs/rewritten')
oid_pattern = re.compile(rb'(?:[a-f0-9]{40}|[a-f0-9]{64})\Z')


def git(*args, env=None, missing=False, data=None, raw=False):
    p = subprocess.run(base + list(args), env=env, input=data, capture_output=True)
    if missing and p.returncode == 1: return b'' if raw else ''
    if p.returncode: raise RuntimeError(os.fsdecode(p.stderr).strip())
    return p.stdout if raw else os.fsdecode(p.stdout).strip()


def is_ancestor(ancestor, descendant):
    p = subprocess.run(base + ['merge-base', '--is-ancestor', ancestor, descendant], capture_output=True)
    if p.returncode == 1: return False
    if p.returncode: raise RuntimeError(os.fsdecode(p.stderr).strip())
    return True


def normalize(state):
    return dict(state, operations=state.get('operations', ''))


def index_entries(value):
    if not value.startswith(stages_prefix): return None, None
    data = base64.b64decode(value[len(stages_prefix):], validate=True)
    if not data or not data.endswith(b'\0'): raise RuntimeError('Invalid Git stage listing')
    entries = []
    for record in data[:-1].split(b'\0'):
        metadata, name = record.split(b'\t', 1)
        mode, oid, stage = metadata.split(b' ')
        if mode not in (b'100644', b'100755', b'120000', b'160000') or not oid_pattern.fullmatch(oid) or stage not in (b'0', b'1', b'2', b'3'):
            raise RuntimeError('Invalid Git index entry')
        if not name or b'\\' in name or any(part in (b'', b'.', b'..', b'.git') for part in name.lower().split(b'/')):
            raise RuntimeError('Invalid Git index path')
        entries.append((mode, oid, stage, name))
    if not any(entry[2] != b'0' for entry in entries): raise RuntimeError('Git stage listing is not unmerged')
    return entries, data


def read_index(env, preview=False):
    # Sparse directories are stage zero. Expanding them can write cache trees
    # through alternates, so inspect stages without expanding during preview.
    listing = git('ls-files', '--stage', '-z', *(['--sparse'] if preview else []), env=env, raw=True)
    if any(record.split(b'\t', 1)[0].endswith((b' 1', b' 2', b' 3')) for record in listing.split(b'\0')):
        return stages_prefix + base64.b64encode(listing).decode('ascii')
    if preview:
        # Even an alternate object can be freshened by write-tree. The index
        # contains blob IDs, so write trees only in the private database without
        # opening or touching any source object.
        private = dict(env, GIT_ALTERNATE_OBJECT_DIRECTORIES='')
        return git('write-tree', '--missing-ok', env=private)
    return git('write-tree', env=env)


def install_index(value, env):
    _, listing = index_entries(value)
    if listing is None:
        git('read-tree', value, env=env)
    else:
        git('read-tree', '--empty', env=env)
        git('update-index', '-z', '--index-info', env=env, data=listing)
        if read_index(env) != value: raise RuntimeError('Reconstructed Git index does not match; preserved index')


def operation_top(name):
    if not name or any(c in name for c in '\\:\0\r\n') or any(part in ('', '.', '..') for part in name.split('/')):
        raise RuntimeError('Unsafe Git operation metadata path')
    if name in operation_files: return name
    for top in operation_directories:
        if name == top or name.startswith(top + '/'): return top
    raise RuntimeError('Unknown Git operation metadata path')


def encode_operations(entries):
    if not entries: return ''
    lines = []
    for name, value in entries.items():
        content = 'd' if value is None else 'f' + base64.b64encode(value).decode('ascii')
        lines.append(base64.b64encode(name.encode('utf-8')).decode('ascii') + ' ' + content)
    return operations_prefix + '\n'.join(sorted(lines))


def decode_operations(value):
    if not value: return {}
    if not value.startswith(operations_prefix): raise RuntimeError('Unknown Git operation metadata version')
    entries = {}
    for line in value[len(operations_prefix):].split('\n'):
        encoded, content = line.split(' ', 1)
        name = base64.b64decode(encoded, validate=True).decode('utf-8')
        top = operation_top(name)
        if name in entries: raise RuntimeError('Duplicate Git operation metadata path')
        if content == 'd':
            if name == top and top not in operation_directories: raise RuntimeError('Invalid Git operation directory')
            entries[name] = None
        elif content.startswith('f'):
            if name == top and top in operation_directories: raise RuntimeError('Invalid Git operation file')
            entries[name] = base64.b64decode(content[1:], validate=True)
        else: raise RuntimeError('Invalid Git operation metadata entry')
    for name in entries:
        top = operation_top(name)
        parent = pathlib.PurePosixPath(name).parent
        while str(parent) != '.' and str(parent) != str(pathlib.PurePosixPath(top).parent):
            if str(parent) not in entries or entries[str(parent)] is not None: raise RuntimeError('Missing Git operation directory')
            parent = parent.parent
    if encode_operations(entries) != value: raise RuntimeError('Non-canonical Git operation metadata')
    if 'rebase-merge/update-refs' in entries and (entries['rebase-merge/update-refs'] is None or entries['rebase-merge/update-refs'].strip()):
        raise RuntimeError('Active rebase --update-refs synchronization is not supported; finish or abort rebase on its current owner first; preserved both sides')
    return entries


def rebase_original(state):
    if state['branch']: return '', ''
    entries = decode_operations(state['operations'])
    for directory in ('rebase-merge', 'rebase-apply'):
        if directory not in entries or entries[directory] is not None: continue
        name = (entries.get(directory + '/head-name') or b'').strip()
        original = (entries.get(directory + '/orig-head') or b'').strip()
        if not name: continue  # A recorded interruption may not have copied it yet.
        if name == b'detached HEAD': return '', ''
        if not original: continue  # The original-tip file may be copied next.
        if not name.startswith(b'refs/heads/') or not oid_pattern.fullmatch(original): raise RuntimeError('Invalid Git rebase original branch')
        return name.decode('utf-8'), original.decode('ascii')
    return '', ''


def rebase_owns_target(state, branch, old):
    name, original = rebase_original(state)
    return bool(name) and name == branch and original == old


def target_tip(before, branch, head):
    for worktree in git('worktree', 'list', '--porcelain', '-z').split('\0\0'):
        fields = dict(field.split(' ', 1) for field in worktree.split('\0') if ' ' in field)
        if fields.get('branch') == branch and pathlib.Path(fields['worktree']).resolve() != root.resolve():
            raise RuntimeError('Target Git branch is checked out in another worktree; preserved its history')
    old = git('rev-parse', '--verify', '--quiet', branch, missing=True)
    if old and branch != before['branch'] and old != head and not rebase_owns_target(before, branch, old) and not is_ancestor(old, head):
        raise RuntimeError('Target Git branch has independent commits; preserved its history')
    return old


def operation_paths():
    result = {}
    for name in operation_files + operation_directories:
        path = pathlib.Path(git('rev-parse', '--git-path', name))
        result[name] = path if path.is_absolute() else root / path
    return result


def read_operations(paths):
    entries = {}
    def visit(name, path):
        operation_top(name)
        if path.is_symlink(): raise RuntimeError('Unsafe Git operation metadata symlink; preserved')
        if not path.exists(): return
        if path.is_dir():
            entries[name] = None
            for child in sorted(path.iterdir()): visit(name + '/' + child.name, child)
        elif path.is_file(): entries[name] = path.read_bytes()
        else: raise RuntimeError('Unsafe Git operation metadata type; preserved')
    for name, path in paths.items(): visit(name, path)
    value = encode_operations(entries)
    decode_operations(value)
    return value


def apply_operations(paths, before, desired):
    if read_operations(paths) != before: raise RuntimeError('Git operation state changed; preserved new edits')
    old, next_state = decode_operations(before), decode_operations(desired)
    def path_of(name):
        top = operation_top(name)
        return paths[top] / name[len(top) + 1:] if name != top else paths[top]
    for name in sorted(old, reverse=True):
        if name in next_state and (old[name] is None) == (next_state[name] is None): continue
        if old[name] is None: path_of(name).rmdir()
        else: path_of(name).unlink()
    for name in sorted(next_state):
        value = next_state[name]
        if name in old and old[name] == value: continue
        path = path_of(name)
        if value is None:
            path.mkdir(exist_ok=True, mode=0o700)
            continue
        # Outside rebase/sequencer directories: an interrupted temporary file
        # must not appear to be a new, independently edited operation entry.
        fd, pending = tempfile.mkstemp(prefix='.chisa-operation-', dir=paths['MERGE_HEAD'].parent)
        try:
            with os.fdopen(fd, 'wb') as output:
                output.write(value)
                output.flush()
                os.fsync(output.fileno())
            os.replace(pending, path)
        finally:
            pathlib.Path(pending).unlink(missing_ok=True)


def validate_head_states(before, desired):
    for state in (before, desired):
        if not oid_pattern.fullmatch(state['head'].encode('ascii')):
            raise RuntimeError('Invalid Git HEAD commit')
        branch = state['branch']
        if branch:
            if not branch.startswith('refs/heads/'): raise RuntimeError('Invalid Git HEAD branch')
            git('check-ref-format', branch)


def head_matches(raw, state):
    value = raw.removesuffix(b'\n').removesuffix(b'\r')
    expected = ('ref: ' + state['branch'] if state['branch'] else state['head']).encode('utf-8')
    return value == expected


def apply_head(before, desired, old):
    validate_head_states(before, desired)
    old = old or '0' * len(desired['head'])
    if desired['branch'] and (not oid_pattern.fullmatch(old.encode('ascii')) or len(old) != len(desired['head'])):
        raise RuntimeError('Invalid Git target branch expectation')
    if not desired['branch'] and git('cat-file', '-t', desired['head']) != 'commit':
        raise RuntimeError('Git HEAD target is not a commit')
    head = pathlib.Path(git('rev-parse', '--git-path', 'HEAD'))
    if not head.is_absolute(): head = root / head
    observed = head.read_bytes()
    if not head_matches(observed, before): raise RuntimeError('Git HEAD changed during synchronization; preserved new edits')
    # A ref expectation checks raw symbolic identity, not merely its OID.
    # The checked-out-branch case cannot include both HEAD and its referent:
    # Git's automatic HEAD reflog update would duplicate HEAD in the transaction.
    if before['branch'] and desired['branch'] and before['branch'] != desired['branch']:
        transaction = ('start\0symref-update HEAD\0' + desired['branch'] + '\0ref\0' + before['branch'] +
                       '\0update ' + desired['branch'] + '\0' + desired['head'] + '\0' + old + '\0prepare\0commit\0')
        try:
            git('update-ref', '--no-deref', '--stdin', '-z', data=transaction.encode('utf-8'))
            return
        except RuntimeError as error:
            # Git 2.48 added symref-update. Only an unsupported command permits
            # fallback; a real failed CAS or another writer's lock must fail.
            if 'unknown command: symref-update' not in str(error): raise
    head_lock = pathlib.Path(str(head) + '.lock')
    output = head_lock.open('xb')  # Never take ownership of a foreign lock.
    owned_head = os.fstat(output.fileno())
    try:
        current = head.read_bytes()
        if current != observed or not head_matches(current, before):
            raise RuntimeError('Git HEAD changed during synchronization; preserved new edits')
        if git('rev-parse', '--verify', 'HEAD^{commit}') != before['head']:
            raise RuntimeError('Git HEAD commit changed during synchronization; preserved new edits')
        value = 'ref: ' + desired['branch'] if desired['branch'] else desired['head']
        output.write((value + '\n').encode('utf-8'))
        output.flush()
        os.fsync(output.fileno())
        if desired['branch']:
            # Updating the checked-out branch normally reacquires HEAD.lock.
            # A private detached Git dir shares the actual common refs/objects
            # and lets update-ref do its exact OID CAS under our real HEAD lock.
            common = pathlib.Path(git('rev-parse', '--git-common-dir'))
            if not common.is_absolute(): common = root / common
            with tempfile.TemporaryDirectory(prefix='chisa-head-', dir=head.parent) as directory:
                private = pathlib.Path(directory)
                (private / 'HEAD').write_bytes((before['head'] + '\n').encode('ascii'))
                (private / 'commondir').write_bytes((common.resolve().as_posix() + '\n').encode('utf-8'))
                git('--git-dir=' + str(private), 'update-ref', '--no-deref', desired['branch'], desired['head'], old)
        output.close()
        if not os.path.samestat(owned_head, head_lock.lstat()): raise RuntimeError('Git HEAD lock owner changed; preserved lock')
        os.replace(head_lock, head)
    finally:
        output.close()
        try:
            if os.path.samestat(owned_head, head_lock.lstat()): head_lock.unlink()
        except FileNotFoundError:
            pass


def snapshot(state, ref):
    state = normalize(state)
    parents = [state['head']]
    if not state['index'].startswith(stages_prefix) and not state['operations']:
        tree = state['index']
    else:
        entries, _ = index_entries(state['index'])
        operations = decode_operations(state['operations'])
        blob = git('hash-object', '-w', '--stdin', data=json.dumps(state, ensure_ascii=True).encode('ascii'))
        listing = ('100644 blob ' + blob + '\tstate.json\0').encode('ascii')
        if entries is None: listing += ('040000 tree ' + state['index'] + '\tindex\0').encode('ascii')
        else:
            for number, (mode, oid, _, _) in enumerate(entries):
                if mode != b'160000': listing += b'100644 blob ' + oid + ('\tstage-%08d\0' % number).encode('ascii')
        seen = set(parents)
        for value in operations.values():
            for oid in re.findall(rb'\b(?:[a-f0-9]{64}|[a-f0-9]{40})\b', value or b''):
                oid = oid.decode('ascii')
                if oid in seen: continue
                seen.add(oid)
                result = subprocess.run(base + ['cat-file', '-t', oid], capture_output=True)
                if result.returncode: continue  # Commit message/todo comments can mention absent objects.
                kind = result.stdout.strip().decode('ascii')
                if kind == 'commit': parents.append(oid)
                elif kind in ('tree', 'blob'):
                    mode = '040000' if kind == 'tree' else '100644'
                    listing += (mode + ' ' + kind + ' ' + oid + '\toperation-' + oid + '\0').encode('ascii')
        tree = git('mktree', '-z', data=listing)
    arguments = ['-c', 'user.name=Chisa Sync', '-c', 'user.email=sync@localhost', 'commit-tree', tree]
    for parent in parents: arguments += ['-p', parent]
    commit = git(*arguments, '-m', 'Chisa sync recovery: ' + state['branch'])
    git('update-ref', ref, commit)
    return commit


if q.get('op') == 'snapshot':
    print(snapshot(q['state'], q['backup']))
    sys.exit(0)

if q.get('op') == 'preflight':
    before, desired = normalize(before), normalize(desired)
    validate_head_states(before, desired)
    index_entries(desired['index'])
    decode_operations(before['operations'])
    decode_operations(desired['operations'])
    if desired['branch']: target_tip(before, desired['branch'], desired['head'])
    rebase_branch, rebase_head = rebase_original(desired)
    if rebase_branch: target_tip(before, rebase_branch, rebase_head)
    print('{}')
    sys.exit(0)

index = pathlib.Path(git('rev-parse', '--git-path', 'index'))
if not index.is_absolute(): index = root / index
lock = pathlib.Path(str(index) + '.lock')
owned = pathlib.Path(str(index) + '.chisa-owned')
temporary = None

# Preview has no lease and must not create/remove repository lock files. The
# caller brackets this read with stable metadata evidence and revalidates at
# confirmation. write-tree runs against a private index, never the real one.
if q.get('op') == 'preview':
    if lock.exists(): raise RuntimeError('Git index is being written; retry after the operation completes')
    fd, preview_index = tempfile.mkstemp(prefix='chisa-preview-index-')
    try:
        try:
            with os.fdopen(fd, 'wb') as output: output.write(index.read_bytes())
        except FileNotFoundError:
            pathlib.Path(preview_index).unlink()
        # write-tree may need new tree objects. Resolve existing objects through
        # alternates while discarding preview-only trees outside the repository.
        source_objects = pathlib.Path(git('rev-parse', '--git-path', 'objects'))
        if not source_objects.is_absolute(): source_objects = root / source_objects
        alternates = json.dumps(str(source_objects.resolve()), ensure_ascii=False)
        if os.environ.get('GIT_ALTERNATE_OBJECT_DIRECTORIES'):
            alternates += os.pathsep + os.environ['GIT_ALTERNATE_OBJECT_DIRECTORIES']
        # Split-index readers freshen sharedindex files in GIT_DIR. Isolate the
        # repository used only by index commands, including copies of shared
        # bases, rather than exposing original index extensions to Git writes.
        with tempfile.TemporaryDirectory(prefix='chisa-preview-objects-') as objects, tempfile.TemporaryDirectory(prefix='chisa-preview-git-') as private:
            gitdir = pathlib.Path(private)
            (gitdir / 'objects').mkdir()
            (gitdir / 'refs').mkdir()
            (gitdir / 'HEAD').write_text('ref: refs/heads/chisa-preview\n', encoding='utf-8')
            object_format = git('rev-parse', '--show-object-format')
            if object_format not in ('sha1', 'sha256'): raise RuntimeError('Unsupported Git object format')
            config = '[core]\nrepositoryformatversion = 1\nbare = false\n[extensions]\nobjectformat = ' + object_format + '\n[index]\nsparse = true\n'
            source_patterns = pathlib.Path(git('rev-parse', '--path-format=absolute', '--git-path', 'info/sparse-checkout'))
            try:
                patterns = source_patterns.read_bytes()
            except FileNotFoundError:
                patterns = None
            if patterns is not None:
                (gitdir / 'info').mkdir()
                (gitdir / 'info' / 'sparse-checkout').write_bytes(patterns)
                config += '[core]\nsparseCheckout = true\nsparseCheckoutCone = true\n'
            (gitdir / 'config').write_text(config, encoding='utf-8')
            source_gitdir = pathlib.Path(git('rev-parse', '--absolute-git-dir'))
            for shared in source_gitdir.glob('sharedindex.*'):
                (gitdir / shared.name).write_bytes(shared.read_bytes())
            preview_env = dict(os.environ, GIT_INDEX_FILE=preview_index, GIT_OPTIONAL_LOCKS='0', GIT_NO_LAZY_FETCH='1',
                               GIT_DIR=private, GIT_COMMON_DIR=private, GIT_WORK_TREE=str(root.resolve()),
                               GIT_OBJECT_DIRECTORY=objects, GIT_ALTERNATE_OBJECT_DIRECTORIES=alternates)
            actual = {'head': git('rev-parse', '--verify', 'HEAD^{commit}'),
                      'branch': git('symbolic-ref', '--quiet', 'HEAD', missing=True),
                      'index': read_index(preview_env, preview=True), 'operations': read_operations(operation_paths())}
            if lock.exists(): raise RuntimeError('Git index changed while reading; retry')
            print(json.dumps(actual))
    finally:
        pathlib.Path(preview_index).unlink(missing_ok=True)
    sys.exit(0)


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
            try:
                with os.fdopen(fd, 'wb') as f: f.write(index.read_bytes())
            except FileNotFoundError:
                pathlib.Path(temporary).unlink()
            env = dict(os.environ, GIT_INDEX_FILE=temporary)
            paths = operation_paths()
            actual = {'head': git('rev-parse', '--verify', 'HEAD^{commit}'),
                      'branch': git('symbolic-ref', '--quiet', 'HEAD', missing=True),
                      'index': read_index(env), 'operations': read_operations(paths)}
            if q.get('op') == 'read':
                print(json.dumps(actual))
                sys.exit(0)
            before, desired = normalize(before), normalize(desired)
            if actual != before: raise RuntimeError('Git state changed during synchronization; preserved new edits')
            old = target_tip(before, desired['branch'], desired['head']) if desired['branch'] else ''
            rebase_branch, rebase_head = rebase_original(desired)
            rebase_old = target_tip(before, rebase_branch, rebase_head) if rebase_branch else ''
            install_index(desired['index'], env)
            decode_operations(desired['operations'])
            backup = q['backup']
            snapshot(before, backup)
            if desired['branch'] and old: git('update-ref', backup + '-branch', old)
            apply_head(before, desired, old)
            # Detach first so restoring the original branch cannot move HEAD.
            if rebase_branch:
                if rebase_old and rebase_old != rebase_head: git('update-ref', backup + '-rebase-branch', rebase_old)
                git('update-ref', rebase_branch, rebase_head, rebase_old or '0' * len(rebase_head))
            apply_operations(paths, before['operations'], desired['operations'])
            output.write(pathlib.Path(temporary).read_bytes())
            output.flush()
            os.fsync(output.fileno())
        os.replace(lock, index)
    finally:
        remove_owned_lock()
        if temporary is not None: pathlib.Path(temporary).unlink(missing_ok=True)
