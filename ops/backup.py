#!/usr/bin/env python3
"""Private, per-file-consistent backups; restore only into a new directory."""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import tarfile
import tempfile


def digest(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def verify(snapshot):
    manifest = json.loads((snapshot / 'manifest.json').read_text())
    archive = snapshot / 'data.tar.gz'
    if manifest.get('format') != 'chisa-data-backup-v1' or digest(archive) != manifest['sha256']:
        raise RuntimeError('Backup integrity check failed')
    return manifest


def backup(config_path):
    config = json.loads(config_path.read_text())
    destination = Path(config['destination']).resolve()
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    if destination.stat().st_mode & 0o077:
        raise RuntimeError('Backup directory must be private (chmod 700)')
    if shutil.disk_usage(destination).free < 2 * 1024 ** 3:
        raise RuntimeError('Less than 2 GiB free; preserve existing backups and investigate disk usage')
    retain = config.get('retainSnapshots', 3)
    if not isinstance(retain, int) or retain < 1:
        raise RuntimeError('retainSnapshots must be a positive integer')
    roots = [Path(value).resolve(strict=True) for value in config['sources']]
    if any(root == destination or root in destination.parents for root in roots):
        raise RuntimeError('Backup destination must be outside every source')
    excluded = set(config.get('excludeDirectoryNames', []))
    databases = {Path(value).resolve(strict=True) for value in config.get('sqliteDatabases', [])}
    if any(not any(db == root or root in db.parents for root in roots) for db in databases):
        raise RuntimeError('Every database must belong to a configured source')
    def required_bytes(path):
        if path.is_symlink():
            return 4096
        if path.is_dir():
            return 0 if path.name in excluded else sum(required_bytes(child) for child in path.iterdir())
        return path.stat().st_size + 1024
    if sum(required_bytes(root) for root in roots) + 2 * 1024 ** 3 > shutil.disk_usage(destination).free:
        raise RuntimeError('Not enough space for a conservative full backup estimate plus 2 GiB reserve')
    stamp = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    snapshot = destination / stamp
    snapshot.mkdir(mode=0o700)
    partial = snapshot / 'data.tar.gz.partial'
    files = 0
    external_links = []
    special_files = []
    # A partial archive is deliberately retained on failure, never advertised as a backup.
    with tempfile.TemporaryDirectory(prefix='chisa-db-', dir=snapshot) as temporary:
        with tarfile.open(partial, 'w:gz', compresslevel=3) as archive:
            def add(path, name):
                nonlocal files
                if path.name.endswith('.chisa-lease') or path.name == '.chisa-bridge.json' or any(
                    str(path) == str(db) + suffix for db in databases for suffix in ('-wal', '-shm')
                ):
                    return
                if path.is_dir() and not path.is_symlink() and path.name in excluded:
                    return
                if path in databases:
                    target = Path(temporary) / str(files)
                    with sqlite3.connect(path.as_uri() + '?mode=ro', uri=True) as source:
                        with sqlite3.connect(target) as copy:
                            source.backup(copy)
                            if copy.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                                raise RuntimeError('Database backup failed integrity check')
                    archive.add(target, arcname=name, recursive=False)
                    files += 1
                    return
                before = path.lstat()
                info = archive.gettarinfo(path, arcname=name)
                if info is None:
                    special_files.append(name)
                    return
                try:
                    tarfile.data_filter(info, str(snapshot / 'restore-validation'))
                except (tarfile.AbsoluteLinkError, tarfile.LinkOutsideDestinationError):
                    external_links.append({'archivePath': name, 'target': info.linkname})
                    return
                except tarfile.SpecialFileError:
                    special_files.append(name)
                    return
                if info.isfile():
                    with path.open('rb') as source:
                        opened = os.fstat(source.fileno())
                        if (opened.st_ino, opened.st_mode) != (before.st_ino, before.st_mode):
                            raise RuntimeError('A source was replaced while being opened')
                        archive.addfile(info, source)
                else:
                    archive.addfile(info)
                if info.isdir():
                    for child in sorted(path.iterdir()):
                        add(child, name + '/' + child.name)
                elif info.isfile():
                    after = path.stat()
                    if (before.st_size, before.st_mtime_ns, before.st_ino) != (after.st_size, after.st_mtime_ns, after.st_ino):
                        raise RuntimeError('A source changed while being copied; backup is incomplete')
                    files += 1
            for index, root in enumerate(roots):
                add(root, f'sources/{index}')
    final = snapshot / 'data.tar.gz'
    partial.rename(final)
    manifest = {'format': 'chisa-data-backup-v1', 'createdAt': stamp, 'sources': [str(root) for root in roots],
                'excludedDirectoryNames': sorted(excluded), 'files': files,
                'sqliteDatabases': [str(db) for db in sorted(databases)],
                'externalLinks': external_links,
                'specialFilesNotRestored': special_files,
                'consistency': 'Stable individual file reads and SQLite online backups; not an atomic workspace snapshot',
                'sha256': digest(final)}
    (snapshot / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    managed = []
    for candidate in destination.iterdir():
        if candidate.is_symlink() or not re.fullmatch(r'\d{8}T\d{12}Z', candidate.name):
            continue
        marker = candidate / 'manifest.json'
        if marker.is_file():
            previous = json.loads(marker.read_text())
            if previous.get('format') == manifest['format'] and previous.get('sources') == manifest['sources']:
                managed.append(candidate)
    for obsolete in sorted(managed, reverse=True)[retain:]:
        if obsolete.resolve().parent != destination or obsolete == snapshot:
            raise RuntimeError('Refusing to remove an unexpected backup path')
        shutil.rmtree(obsolete)
    print(json.dumps({'status': 'complete', 'snapshot': str(snapshot), 'files': files,
                      'externalLinksNotActivatedOnRestore': len(external_links)}))


def restore(snapshot, target):
    manifest = verify(snapshot)
    if target.exists():
        raise RuntimeError('Restore destination must not exist; production paths cannot be overwritten')
    target.mkdir(parents=True, mode=0o700)
    with tarfile.open(snapshot / 'data.tar.gz', 'r:gz') as archive:
        # Python data filtering refuses traversal and links escaping the restore root.
        archive.extractall(target, filter='data')
    (target / 'source-map.json').write_text(json.dumps(manifest['sources'], indent=2) + '\n')
    if manifest.get('externalLinks'):
        (target / 'external-links.json').write_text(json.dumps(manifest['externalLinks'], indent=2) + '\n')
    if manifest.get('specialFilesNotRestored'):
        (target / 'special-files.json').write_text(json.dumps(manifest['specialFilesNotRestored'], indent=2) + '\n')
    print(json.dumps({'status': 'restored-for-inspection', 'destination': str(target)}))


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('backup').add_argument('--config', type=Path, required=True)
    commands.add_parser('verify').add_argument('--snapshot', type=Path, required=True)
    restore_parser = commands.add_parser('restore')
    restore_parser.add_argument('--snapshot', type=Path, required=True)
    restore_parser.add_argument('--to', type=Path, required=True)
    args = parser.parse_args()
    if args.command == 'backup':
        backup(args.config)
    elif args.command == 'verify':
        verify(args.snapshot)
        print('Backup integrity verified')
    else:
        restore(args.snapshot, args.to)


if __name__ == '__main__':
    main()
