"""Read-only metadata observations over a persistent JSON-lines stdin/stdout pipe.

Only initial registration, newly arrived directories, and lost inotify evidence
walk the project. Ordinary queries hash Git metadata, never run Git or scan the
worktree. An error deliberately asks the caller to use its full safe reader.
"""
import ctypes
import errno
import hashlib
import json
import os
import re
import select
import stat
import struct
import sys
import time

VERSION = b'chisa-sync-observe-v1'
OPERATION_FILES = ('ORIG_HEAD', 'MERGE_HEAD', 'MERGE_MSG', 'MERGE_MODE', 'MERGE_RR',
                   'MERGE_AUTOSTASH', 'AUTO_MERGE', 'CHERRY_PICK_HEAD', 'REVERT_HEAD',
                   'REBASE_HEAD', 'SQUASH_MSG')
OPERATION_DIRECTORIES = ('rebase-merge', 'rebase-apply', 'sequencer', 'refs/rewritten')
# These directories are excluded unconditionally by the engine policy. Generated
# names are root-only: a nested src/build may contain effective .gitignore files.
DEPENDENCIES = frozenset(('node_modules', '.venv', 'venv', '__pycache__'))
GENERATED = frozenset(('dist', 'build', 'out', '.next', 'coverage', '.cache', 'cache',
                       '.tmp', '.dev', '.nodetmp'))
MAX_METADATA_BYTES = 512 * 1024 * 1024
MAX_METADATA_ENTRIES = 100000
MAX_WATCHES = 100000
MAX_REQUEST_BYTES = 4096
IDLE_SECONDS = 180


class ObservationError(RuntimeError):
    pass


def identity(info):
    return (info.st_dev, info.st_ino, stat.S_IFMT(info.st_mode))


def stamp(info):
    # Windows Python exposes creation time through stat(path).st_ctime but the
    # change time through fstat(handle).st_ctime. Linux's ctime is consistent and
    # remains part of the production race check.
    times = (info.st_size, info.st_mtime_ns)
    if sys.platform.startswith('linux'):
        times += (info.st_ctime_ns,)
    return identity(info) + times


def lstat(path):
    try:
        return os.lstat(path)
    except FileNotFoundError:
        return None


def add_hash(digest, tag, value):
    tag = os.fsencode(tag)
    if not isinstance(value, bytes):
        value = str(value).encode('ascii')
    digest.update(struct.pack('!Q', len(tag)))
    digest.update(tag)
    digest.update(struct.pack('!Q', len(value)))
    digest.update(value)


class Metadata:
    def __init__(self, root):
        self.root = os.path.abspath(root)
        self.git = hashlib.sha256(VERSION)
        self.policy = hashlib.sha256(VERSION)
        self.watch_dirs = set()
        self.bytes = 0
        self.entries = 0

    def directory(self, path, tag, policy=False):
        info = lstat(path)
        if info is None or not stat.S_ISDIR(info.st_mode):
            raise ObservationError('Git metadata directory is missing or unsupported')
        value = os.fsencode(os.path.realpath(path)) + b'\0' + str(identity(info)).encode('ascii')
        add_hash(self.git, tag, value)
        if policy:
            add_hash(self.policy, tag, value)
        self.watch_dirs.add(path)
        return info

    def file(self, path, tag, policy=False, capture=False, presence=False, record=True, capture_limit=1024 * 1024):
        self.entries += 1
        if self.entries > MAX_METADATA_ENTRIES:
            raise ObservationError('Git metadata inventory exceeds observation limit')
        before = lstat(path)
        if before is None:
            value, data = b'missing', None
        elif not stat.S_ISREG(before.st_mode):
            raise ObservationError('Git metadata file type is unsupported')
        elif presence:
            value, data = b'present', None
        else:
            if capture and before.st_size > capture_limit:
                raise ObservationError('Git control file exceeds observation limit')
            flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0)
            descriptor = os.open(path, flags)
            chunks = [] if capture else None
            captured = 0
            digest = hashlib.sha256()
            try:
                opened = os.fstat(descriptor)
                if not stat.S_ISREG(opened.st_mode) or stamp(opened) != stamp(before):
                    raise ObservationError('Git metadata changed while opening')
                while True:
                    chunk = os.read(descriptor, 256 * 1024)
                    if not chunk:
                        break
                    self.bytes += len(chunk)
                    if self.bytes > MAX_METADATA_BYTES:
                        raise ObservationError('Git metadata exceeds observation limit')
                    digest.update(chunk)
                    if chunks is not None:
                        captured += len(chunk)
                        if captured > capture_limit:
                            raise ObservationError('Git control file exceeds observation limit')
                        chunks.append(chunk)
                after = os.fstat(descriptor)
                current = lstat(path)
                if stamp(after) != stamp(before) or current is None or stamp(current) != stamp(before):
                    raise ObservationError('Git metadata changed while reading')
            finally:
                os.close(descriptor)
            value = b'file\0' + digest.digest()
            data = b''.join(chunks) if chunks is not None else None
        if record:
            add_hash(self.git, tag, value)
        if policy:
            add_hash(self.policy, tag, value)
        return data

    def parent_watch(self, path, boundary):
        current = os.path.dirname(path)
        while True:
            info = lstat(current)
            if info is not None:
                if not stat.S_ISDIR(info.st_mode):
                    raise ObservationError('Git metadata parent type is unsupported')
                self.watch_dirs.add(current)
                return
            if current == boundary or os.path.dirname(current) == current:
                raise ObservationError('Git metadata parent is missing')
            current = os.path.dirname(current)

    def tree(self, path, tag):
        info = lstat(path)
        if info is None:
            add_hash(self.git, tag, b'missing')
            return
        if not stat.S_ISDIR(info.st_mode):
            raise ObservationError('Git operation directory type is unsupported')
        self.entries += 1
        if self.entries > MAX_METADATA_ENTRIES:
            raise ObservationError('Git metadata inventory exceeds observation limit')
        self.directory(path, tag)
        before = stamp(info)
        with os.scandir(path) as iterator:
            names = sorted(entry.name for entry in iterator)
        for name in names:
            child = os.path.join(path, name)
            child_tag = tag + '/' + name
            child_info = lstat(child)
            if child_info is None:
                raise ObservationError('Git operation directory changed while reading')
            if stat.S_ISDIR(child_info.st_mode):
                self.tree(child, child_tag)
            else:
                self.file(child, child_tag)
        current = lstat(path)
        if current is None or stamp(current) != before:
            raise ObservationError('Git operation directory changed while reading')

    def packed_refs(self, path):
        # Private recovery/transfer refs must not invalidate a warm observation.
        # Preserve every other packed ref, including peeled lines and comments.
        data = self.file(path, 'packed-refs-raw', capture=True, record=False, capture_limit=32 * 1024 * 1024)
        lines, skip_peeled = [], False
        for line in (data or b'').splitlines():
            if not line or line.startswith(b'#'):
                continue
            if line.startswith(b'^'):
                if not skip_peeled:
                    lines.append(line)
                continue
            fields = line.split(b' ', 1)
            if len(fields) == 2 and fields[1].startswith(b'refs/replace/'):
                raise ObservationError('Git replace references require full observation')
            skip_peeled = len(fields) == 2 and fields[1].startswith((b'refs/chisa/recovery/', b'refs/chisa/transfer/'))
            if not skip_peeled:
                lines.append(line)
        add_hash(self.git, 'packed-refs', b'\n'.join(lines))

    def config(self, path, tag):
        data = self.file(path, tag, policy=True, capture=True)
        if data and (re.search(rb'(?im)^\s*\[\s*include(?:if)?(?:\s|\.|\])', data) or
                     re.search(rb'(?i)(?:excludesfile|refstorage)\s*=', data)):
            # Following arbitrary config includes/excludes or reftables without
            # Git would risk a false unchanged result. The full reader handles it.
            raise ObservationError('External Git includes, excludes, or ref storage require full observation')

    def observe(self):
        root_info = lstat(self.root)
        if root_info is None or not stat.S_ISDIR(root_info.st_mode):
            raise ObservationError('Workspace root is missing or unsupported')
        add_hash(self.git, 'root-identity', str(identity(root_info)))
        marker = os.path.join(self.root, '.git')
        marker_info = lstat(marker)
        if marker_info is None:
            # A missing marker inside another repository must not be mistaken for
            # a nonrepository workspace; the full reader verifies its bound root.
            absent = [marker]
            ancestor = self.root
            while True:
                candidate = os.path.join(ancestor, '.git')
                if lstat(candidate) is not None:
                    raise ObservationError('Workspace inherits a parent Git repository')
                absent.append(candidate)
                self.watch_dirs.add(ancestor)
                head, objects = os.path.join(ancestor, 'HEAD'), os.path.join(ancestor, 'objects')
                head_info, object_info = lstat(head), lstat(objects)
                if head_info and object_info:
                    raise ObservationError('Bare Git repository requires full observation')
                absent.extend(path for path, info in ((head, head_info), (objects, object_info)) if info is None)
                if ancestor == os.path.dirname(ancestor):
                    break
                ancestor = os.path.dirname(ancestor)
            if any(lstat(path) is not None for path in absent):
                raise ObservationError('Git endpoint changed during observation')
            current_root = lstat(self.root)
            if current_root is None or identity(current_root) != identity(root_info):
                raise ObservationError('Workspace root changed during observation')
            self.watch_dirs.add(self.root)
            add_hash(self.git, 'marker', b'missing')
            return self.result(False, ('absent', identity(root_info)))
        if stat.S_ISDIR(marker_info.st_mode):
            gitdir = marker
            add_hash(self.git, 'marker', b'directory')
        elif stat.S_ISREG(marker_info.st_mode):
            pointer = self.file(marker, 'marker', policy=True, capture=True)
            if not pointer.startswith(b'gitdir: ') or b'\0' in pointer:
                raise ObservationError('Git directory pointer is unsupported')
            value = os.fsdecode(pointer[8:].rstrip(b'\r\n'))
            if not value:
                raise ObservationError('Git directory pointer is empty')
            gitdir = os.path.realpath(os.path.join(self.root, value))
        else:
            raise ObservationError('Git marker type is unsupported')
        git_identity = identity(self.directory(gitdir, 'gitdir-identity', policy=True))
        common_pointer = self.file(os.path.join(gitdir, 'commondir'), 'commondir', policy=True, capture=True)
        common = gitdir
        if common_pointer is not None:
            value = os.fsdecode(common_pointer.rstrip(b'\r\n'))
            if not value or '\0' in value:
                raise ObservationError('Git common directory pointer is unsupported')
            common = os.path.realpath(os.path.join(gitdir, value))
        common_identity = identity(self.directory(common, 'common-identity', policy=True))
        roots = list(dict.fromkeys((gitdir, common)))
        for number, directory in enumerate(roots):
            if lstat(os.path.join(directory, 'index.lock')) is not None:
                raise ObservationError('Git index.lock is present; full safe reader required')
            before = lstat(directory)
            with os.scandir(directory) as iterator:
                names = sorted(entry.name for entry in iterator)
            for name in names:
                if name.startswith('sharedindex.'):
                    self.file(os.path.join(directory, name), str(number) + '/' + name, policy=True)
                elif name.endswith('.lock'):
                    self.file(os.path.join(directory, name), str(number) + '/lock/' + name, presence=True)
            current = lstat(directory)
            if current is None or stamp(before) != stamp(current):
                raise ObservationError('Git metadata directory changed while reading')
            for name in ('config', 'config.worktree'):
                self.config(os.path.join(directory, name), str(number) + '/' + name)
            self.file(os.path.join(directory, 'shallow'), str(number) + '/shallow')
            exclude = os.path.join(directory, 'info', 'exclude')
            self.file(exclude, str(number) + '/info/exclude', policy=True)
            self.parent_watch(exclude, directory)
            if lstat(os.path.join(directory, 'reftable')) is not None:
                raise ObservationError('Git reftable requires full observation')
        # The inventory worker runs with HOME=/nonexistent. Track the remaining
        # standard Linux config sources too, and fall back for external includes.
        external = ['/etc/gitconfig', '/nonexistent/.gitconfig', '/nonexistent/.config/git/config']
        xdg = os.environ.get('XDG_CONFIG_HOME')
        if xdg:
            external.append(os.path.join(xdg, 'git', 'config'))
        for number, path in enumerate(dict.fromkeys(external)):
            self.config(path, 'external-config/' + str(number))
        excludes = ['/nonexistent/.config/git/ignore']
        if xdg:
            excludes.append(os.path.join(xdg, 'git', 'ignore'))
        for number, path in enumerate(dict.fromkeys(excludes)):
            self.file(path, 'external-ignore/' + str(number), policy=True)
        self.file(os.path.join(gitdir, 'index'), 'index', policy=True)
        self.packed_refs(os.path.join(common, 'packed-refs'))
        self.file(os.path.join(common, 'objects', 'info', 'alternates'), 'objects/info/alternates')
        self.parent_watch(os.path.join(common, 'objects', 'info', 'alternates'), common)
        self.file(os.path.join(common, 'info', 'grafts'), 'info/grafts')
        replace = os.path.join(common, 'refs', 'replace')
        if lstat(replace) is not None:
            with os.scandir(replace) as iterator:
                if next(iterator, None) is not None:
                    raise ObservationError('Git replace references require full observation')
        self.file(os.path.join(common, 'packed-refs.lock'), 'packed-refs.lock', presence=True)
        active = 'HEAD'
        seen = set()
        for _ in range(32):
            if active in seen:
                raise ObservationError('Git symbolic ref cycle requires full observation')
            seen.add(active)
            per_worktree = active == 'HEAD' or active.startswith(('refs/bisect/', 'refs/worktree/', 'refs/rewritten/'))
            directory = gitdir if per_worktree else common
            path = os.path.join(directory, active)
            value = self.file(path, 'active/' + active, capture=True)
            self.file(path + '.lock', 'active/' + active + '.lock', presence=True)
            self.parent_watch(path, directory)
            if value is None:
                if active == 'HEAD':
                    raise ObservationError('Git HEAD is missing')
                break  # Unborn or packed; packed-refs is always fingerprinted.
            value = value.strip()
            if not value.startswith(b'ref: '):
                if re.fullmatch(rb'(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})', value) is None:
                    raise ObservationError('Git reference format requires full observation')
                break
            active = os.fsdecode(value[5:])
            if (not active.startswith('refs/') or any(p in ('', '.', '..') for p in active.split('/')) or
                    re.search(r'[\x00-\x20\x7f~^:?*\[\\]', active) or '..' in active or '@{' in active or
                    active.endswith(('/', '.', '.lock'))):
                raise ObservationError('Git symbolic reference is unsupported')
        else:
            raise ObservationError('Git symbolic reference chain exceeds observation limit')
        for name in OPERATION_FILES:
            self.file(os.path.join(gitdir, name), 'operation/' + name)
        for name in OPERATION_DIRECTORIES:
            self.tree(os.path.join(gitdir, name), 'operation/' + name)
            self.parent_watch(os.path.join(gitdir, name), gitdir)
        for directory in roots:
            if lstat(os.path.join(directory, 'index.lock')) is not None:
                raise ObservationError('Git index.lock is present; full safe reader required')
        return self.result(True, (gitdir, git_identity, common, common_identity))

    def result(self, repository, layout):
        return {'git': self.git.hexdigest(), 'repository': repository,
                'policy': self.policy.hexdigest(), 'layout': layout,
                'watch_dirs': self.watch_dirs}


def fingerprint(root):
    return Metadata(root).observe()


# Linux ABI constants are stable across architectures.
IN_MODIFY, IN_ATTRIB, IN_CLOSE_WRITE = 0x2, 0x4, 0x8
IN_MOVED_FROM, IN_MOVED_TO, IN_CREATE, IN_DELETE = 0x40, 0x80, 0x100, 0x200
IN_DELETE_SELF, IN_MOVE_SELF, IN_UNMOUNT = 0x400, 0x800, 0x2000
IN_Q_OVERFLOW, IN_IGNORED, IN_ISDIR = 0x4000, 0x8000, 0x40000000
IN_ONLYDIR, IN_DONT_FOLLOW = 0x01000000, 0x02000000
NAME_EVENTS = IN_MOVED_FROM | IN_MOVED_TO | IN_CREATE | IN_DELETE
WATCH_MASK = (IN_MODIFY | IN_ATTRIB | IN_CLOSE_WRITE | NAME_EVENTS | IN_DELETE_SELF |
              IN_MOVE_SELF | IN_UNMOUNT | IN_ONLYDIR | IN_DONT_FOLLOW)
EVENT = struct.Struct('iIII')


class Observer:
    def __init__(self, root):
        if not sys.platform.startswith('linux'):
            raise ObservationError('Persistent sync observation requires Linux inotify')
        self.root = os.path.abspath(root)
        self.libc = ctypes.CDLL(None, use_errno=True)
        self.libc.inotify_init1.argtypes = [ctypes.c_int]
        self.libc.inotify_init1.restype = ctypes.c_int
        self.libc.inotify_add_watch.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_uint32]
        self.libc.inotify_add_watch.restype = ctypes.c_int
        self.fd = -1
        self.lost = True
        self.layout = None
        self.git_revision = 0
        self.revision = 0
        self.nonce = ''
        self.watches = {}
        self.paths = {}

    def close(self):
        if self.fd >= 0:
            os.close(self.fd)
            self.fd = -1

    def prune(self, path):
        relative = os.path.relpath(path, self.root)
        parts = relative.split(os.sep)
        return (parts[-1] == '.git' or parts[-1] in DEPENDENCIES or
                (len(parts) == 1 and parts[0] in GENERATED))

    def add_watch(self, path, kind):
        if path in self.paths:
            self.watches[self.paths[path]][1].add(kind)
            return False
        if len(self.watches) >= MAX_WATCHES:
            raise ObservationError('inotify directory inventory exceeds observation limit')
        before = lstat(path)
        if before is None or not stat.S_ISDIR(before.st_mode):
            raise ObservationError('inotify directory disappeared or is unsupported')
        wd = self.libc.inotify_add_watch(self.fd, os.fsencode(path), WATCH_MASK)
        if wd < 0:
            raise ObservationError('inotify watch registration failed; full observation required')
        after = lstat(path)
        if after is None or identity(before) != identity(after):
            raise ObservationError('inotify directory identity changed during registration')
        if wd in self.watches and self.watches[wd][0] != path:
            raise ObservationError('Aliased inotify directories require full observation')
        self.paths[path] = wd
        self.watches[wd] = [path, {kind}]
        return True

    def add_tree(self, start):
        stack = [start]
        while stack:
            path = stack.pop()
            if path != self.root and self.prune(path):
                continue
            self.add_watch(path, 'project')  # Register before enumerating children.
            with os.scandir(path) as iterator:
                for entry in iterator:
                    if entry.is_dir(follow_symlinks=False) and not self.prune(entry.path):
                        stack.append(entry.path)

    def rebuild(self):
        self.close()
        self.fd = self.libc.inotify_init1(os.O_NONBLOCK | os.O_CLOEXEC)
        if self.fd < 0:
            raise ObservationError('inotify initialization failed; full observation required')
        self.watches, self.paths = {}, {}
        self.nonce = os.urandom(16).hex()
        self.revision = 0
        self.git_revision += 1
        self.layout = None
        self.lost = True
        self.add_tree(self.root)
        self.lost = False

    def event(self, wd, mask, name):
        if mask & IN_Q_OVERFLOW:
            self.lost = True
            return
        watched = self.watches.get(wd)
        if watched is None or mask & (IN_IGNORED | IN_UNMOUNT | IN_DELETE_SELF | IN_MOVE_SELF):
            # Paths attached to moved/deleted watch descriptors are no longer
            # trustworthy. Renew the nonce and register a fresh tree next query.
            self.lost = True
            return
        path, kinds = watched
        if 'metadata' in kinds:
            self.git_revision += 1
        if 'project' not in kinds:
            return
        if mask & NAME_EVENTS or (mask & IN_ISDIR and mask & IN_ATTRIB):
            self.revision += 1
        if name == '.gitignore' and mask & (IN_MODIFY | IN_ATTRIB | IN_CLOSE_WRITE):
            self.revision += 1
        if name == '.git' and mask & (IN_MODIFY | IN_ATTRIB | IN_CLOSE_WRITE):
            self.lost = True
        if mask & IN_ISDIR:
            if mask & (IN_MOVED_FROM | IN_DELETE):
                self.lost = True
            elif mask & (IN_CREATE | IN_MOVED_TO):
                child = os.path.join(path, name)
                if not self.prune(child):
                    try:
                        self.add_tree(child)
                    except (OSError, ObservationError):
                        self.lost = True

    def drain(self):
        # Never depend on a background thread noticing an event before a query.
        # Drain to EAGAIN, including events produced while adding new watches.
        drained = 0
        while True:
            try:
                data = os.read(self.fd, 256 * 1024)
            except BlockingIOError:
                return
            except InterruptedError:
                continue
            if not data:
                self.lost = True
                return
            drained += len(data)
            if drained > 64 * 1024 * 1024:
                self.lost = True
                return
            offset = 0
            while offset < len(data):
                if len(data) - offset < EVENT.size:
                    self.lost = True
                    return
                wd, mask, cookie, length = EVENT.unpack_from(data, offset)
                offset += EVENT.size
                if length > len(data) - offset:
                    self.lost = True
                    return
                name = os.fsdecode(data[offset:offset + length].split(b'\0', 1)[0])
                offset += length
                self.event(wd, mask, name)

    def observe(self):
        for _ in range(4):
            if self.lost:
                self.rebuild()
            self.drain()
            if self.lost:
                continue
            generation = self.git_revision
            result = fingerprint(self.root)
            added = False
            for path in sorted(result['watch_dirs']):
                added = self.add_watch(path, 'metadata') or added
            self.drain()
            if self.lost:
                continue
            if self.layout is not None and self.layout != result['layout']:
                self.lost = True
                continue
            self.layout = result['layout']
            if added or self.git_revision != generation:
                continue  # Hash again with every metadata watch already armed.
            digest = hashlib.sha256(VERSION)
            add_hash(digest, 'nonce', self.nonce)
            add_hash(digest, 'revision', str(self.revision))
            add_hash(digest, 'policy-metadata', result['policy'])
            return {'git': result['git'], 'ignore': digest.hexdigest(),
                    'repository': result['repository']}
        raise ObservationError('Filesystem evidence changed during observation; full reader required')


def main(root):
    observer = None
    try:
        observer = Observer(root)
        # Unbuffered protocol input avoids read-ahead hiding a second JSON line
        # from select, and the timeout bounds an orphan even after SSH disconnects.
        pending = b''
        last = time.monotonic()
        while True:
            remaining = IDLE_SECONDS - (time.monotonic() - last)
            if remaining <= 0:
                return
            ready, _, _ = select.select([sys.stdin.fileno()], [], [], remaining)
            if not ready:
                return
            data = os.read(sys.stdin.fileno(), MAX_REQUEST_BYTES + 1)
            if not data:
                return
            pending += data
            if len(pending) > MAX_REQUEST_BYTES and b'\n' not in pending[:MAX_REQUEST_BYTES + 1]:
                raise ObservationError('Observation request exceeds limit')
            while b'\n' in pending:
                line, pending = pending.split(b'\n', 1)
                if len(line) > MAX_REQUEST_BYTES:
                    raise ObservationError('Observation request exceeds limit')
                try:
                    request = json.loads(line)
                    if not isinstance(request, dict):
                        raise ObservationError('Observation request must be a JSON object')
                    result = observer.observe()
                except ObservationError as error:
                    observer.lost = True
                    result = {'error': str(error)}
                except (OSError, ValueError, RecursionError):
                    observer.lost = True
                    result = {'error': 'Filesystem metadata could not be observed safely'}
                sys.stdout.write(json.dumps(result, separators=(',', ':')) + '\n')
                sys.stdout.flush()
                last = time.monotonic()
    except ObservationError as error:
        sys.stdout.write(json.dumps({'error': str(error)}, separators=(',', ':')) + '\n')
        sys.stdout.flush()
    finally:
        if observer is not None:
            observer.close()


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('Expected one workspace root')
    main(sys.argv[1])
