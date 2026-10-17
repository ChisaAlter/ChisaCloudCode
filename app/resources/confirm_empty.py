"""Quarantine explicitly confirmed synchronized entries; never remove ignored content."""
import errno, json, os, stat, sys
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
    try:
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
