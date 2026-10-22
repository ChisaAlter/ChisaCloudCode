"""Quarantine explicitly confirmed synchronized entries; never remove ignored content."""
import errno, json, os, stat, subprocess, sys
from pathlib import Path

q = json.load(sys.stdin)
root = Path(q['root'])
if not root.is_absolute() or root.is_symlink() or root.resolve() != root or not root.is_dir():
    raise RuntimeError('Project root is not the bound directory')

def entry(relative):
    parts = relative.split('/')
    if not relative or any(p in ('', '.', '..') for p in parts) or relative.startswith('/'):
        raise RuntimeError('Invalid project-relative path')
    p = root.joinpath(*parts)
    if p.parent.resolve() != p.parent:
        raise RuntimeError('Project path crosses a symlink')
    s = p.lstat()
    return {'path': relative, 'directory': stat.S_ISDIR(s.st_mode),
            'mode': s.st_mode, 'size': s.st_size, 'mtime': s.st_mtime_ns,
            'inode': s.st_ino, 'device': s.st_dev}

if q['op'] == 'list':
    entries = []
    directories = {}
    for relative_directory in q.get('directories', ['']):
        directory = root
        prefix = ''
        if relative_directory:
            item = entry(relative_directory)
            if not item['directory']:
                raise RuntimeError('Project directory changed while scanning')
            directory = root / relative_directory
            prefix = relative_directory + '/'
        children = sorted(os.scandir(directory), key=lambda e: e.name)
        directories[relative_directory] = [child.name for child in children]
        for child in children:
            relative = prefix + child.name
            item = entry(relative)
            entries.append(item)
    # Go evaluates the native ignore rules before requesting another directory level.
    print(json.dumps({'entries': entries, 'directories': directories, 'rootDevice': root.stat().st_dev}))
elif q['op'] == 'move':
    result = {'clearState': 'not-started', 'backupPath': ''}
    def policy_ignored():
        # Live engine rules are dynamic. Independently ask receiver Git about
        # every proposed path, including newly ignored files, just before any
        # quarantine. A one-sided force-track is the only user-rule exception;
        # runtime/security exclusions are unconditional even for tracked paths.
        if q.get('gitPolicy') is not True:
            return set()
        candidates = []
        for item in q['entries']:
            value = item['path'] + ('/' if item['directory'] else '')
            parts = item['path'].split('/')
            if any(p in ('node_modules', '.git', '.svn', '.hg', '.bzr', '_darcs', '.venv', 'venv', '__pycache__', '.chisa-bridge.json', '.chisa-session.json', '.chisa-sync-policy', '.chisa-lease', '.chisa-worktrees') or
                   (p == '.env' or p.startswith('.env.')) and p not in ('.env.example', '.env.sample') for p in parts):
                raise RuntimeError('Protected path entered clear plan; no files moved')
            candidates.append(value)
        env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_') or k in ('GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_COUNT') or k.startswith(('GIT_CONFIG_KEY_', 'GIT_CONFIG_VALUE_'))}
        env.update(GIT_OPTIONAL_LOCKS='0', GIT_NO_LAZY_FETCH='1', LC_ALL='C')
        base = ['git', '-C', str(root), '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null']
        def git(args, data=None):
            return subprocess.run(base + args, input=data, env=env, capture_output=True, timeout=15)
        probe = git(['rev-parse', '--show-toplevel'])
        if probe.returncode:
            if not (root / '.git').exists() and b'not a git repository' in probe.stderr:
                return set()
            raise RuntimeError('Git ignore policy could not be confirmed; no files moved')
        if Path(os.fsdecode(probe.stdout).rstrip('\r\n')).resolve() != root:
            # Selected repository subdirectories follow the explicit file-only
            # policy, exactly as the live engine; do not inspect the parent Git.
            return set()
        directories = git(['rev-parse', '--absolute-git-dir', '--git-common-dir'])
        if directories.returncode:
            raise RuntimeError('Git policy directories cannot be confirmed')
        for value in os.fsdecode(directories.stdout).splitlines():
            directory = Path(value)
            if not directory.is_absolute(): directory = root / directory
            if any((directory / name).exists() for name in ('index.lock', 'config.lock', 'config.worktree.lock')):
                raise RuntimeError('Git policy is locked; no files moved')
        tracked_result = git(['ls-files', '-z'])
        if tracked_result.returncode:
            raise RuntimeError('Git tracked paths cannot be confirmed')
        tracked = set(q.get('tracked', [])) | {os.fsdecode(p) for p in tracked_result.stdout.split(b'\0') if p}
        protected = set()
        if candidates:
            checked = git(['check-ignore', '--no-index', '-z', '--stdin'], b'\0'.join(os.fsencode(p) for p in candidates) + b'\0')
            if checked.returncode not in (0, 1):
                raise RuntimeError('Git ignore decisions cannot be confirmed')
            protected = {os.fsdecode(p).rstrip('/') for p in checked.stdout.split(b'\0') if p}
        tracked_prefixes = set(tracked)
        for value in tracked:
            parts = value.split('/')
            tracked_prefixes.update('/'.join(parts[:i]) for i in range(1, len(parts)))
        return protected - tracked_prefixes
    try:
        if policy_ignored():
            raise RuntimeError('Git policy now excludes clear-plan entries; no files moved')
        # Validate the selected entries and directory membership before any mutation.
        for directory, names in q['directories'].items():
            parent = root / directory
            if parent.is_symlink() or parent.resolve() != parent:
                raise RuntimeError('Project directory changed after confirmation; no files moved')
            if sorted(os.listdir(parent)) != names:
                raise RuntimeError('Project changed after confirmation; no files moved')
        for expected in q['entries']:
            if entry(expected['path']) != expected:
                raise RuntimeError('Project changed after confirmation; no files moved')
        identifier = q['id']
        if not identifier or any(c not in '0123456789abcdef' for c in identifier):
            raise RuntimeError('Invalid backup identifier')
        backup = Path(str(root) + '.chisa-sync-backups') / identifier
        backup.parent.mkdir(mode=0o700, exist_ok=True)
        if backup.parent.is_symlink() or backup.parent.resolve() != backup.parent:
            raise RuntimeError('Backup directory is not a private sibling directory')
        backup.mkdir(mode=0o700)
        files = backup / 'files'
        files.mkdir(mode=0o700)
        manifest = backup / 'manifest.json'
        with manifest.open('x', encoding='utf-8') as output:
            os.chmod(manifest, 0o600)
            json.dump({'root': str(root), 'epoch': q['epoch'], 'entries': q['entries']}, output)
            output.flush()
            os.fsync(output.fileno())
        removed = set()
        for item in q['entries']:
            if item['directory']:
                continue
            if entry(item['path']) != item:
                raise RuntimeError('Project changed while clearing; check the remaining files')
            if policy_ignored():
                raise RuntimeError('Git policy changed while clearing; preserved remaining files')
            target = files / item['path']
            target.parent.mkdir(parents=True, exist_ok=True)
            os.rename(root / item['path'], target)
            removed.add(item['path'])
            # Only advertise recovery after a file actually reached this backup.
            result.update(clearState='partial', backupPath=str(backup))
        for item in reversed(q['entries']):
            if item['directory']:
                # Preserve empty directory structure for recovery as well.
                (files / item['path']).mkdir(parents=True, exist_ok=True)
                try:
                    (root / item['path']).rmdir()
                    removed.add(item['path'])
                    result.update(clearState='partial', backupPath=str(backup))
                except OSError as error:
                    if error.errno != errno.ENOTEMPTY:
                        raise
        for directory, names in q['directories'].items():
            if directory in removed:
                continue
            remaining = [name for name in names if (directory + '/' + name).lstrip('/') not in removed]
            if sorted(os.listdir(root / directory)) != remaining:
                raise RuntimeError('Project changed while clearing; check the remaining files')
        result.update(clearState='completed', backupPath=str(backup))
    except Exception as error:
        result['error'] = str(error)
    print(json.dumps(result))

else:
    raise ValueError('Unknown confirmation operation')
