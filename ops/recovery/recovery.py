#!/usr/bin/env python3
"""Cold, coordinated encrypted recovery bundles; Python 3.11+, stdlib only.

Default actions are read-only dry runs. This program NEVER stops/starts services,
changes Docker resources, runs restored software, or deletes remote history.
Production backup requires externally fenced writers; verify uses Linux network
and mount namespaces. Fixture mode is restricted to temporary fake data.
"""
from __future__ import annotations

import argparse
import base64
import contextlib
import datetime as dt
import fnmatch
import hashlib
import hmac
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import socket
import sqlite3
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import uuid

VERSION = 1
ROLES = {'workspace', 'home', 'leases', 'attachments', 'configuration', 'secrets', 'ssh_trust'}
WRITER_CLASSES = {'api', 'worker', 'agent', 'shell', 'preview', 'legacy_sync', 'scheduled', 'host_manual'}
SAFE_ID = re.compile(r'^[a-z][a-z0-9_-]{0,47}$')
HEX = re.compile(r'^[0-9a-f]{64}$')


class GateError(Exception):
    """Only stable codes, never arbitrary external error strings, reach stdout."""
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def require(value, code):
    if not value:
        raise GateError(code)


def now():
    return dt.datetime.now(dt.timezone.utc)


def stamp():
    return now().isoformat()


def parse_time(value):
    try:
        parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
        require(parsed.tzinfo is not None, 'TIMESTAMP_REQUIRES_TIMEZONE')
        return parsed
    except (AttributeError, TypeError, ValueError):
        raise GateError('TIMESTAMP_INVALID') from None


def sha(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def jread(path):
    try:
        with Path(path).open('r', encoding='utf-8-sig') as stream:
            return json.load(stream)
    except (OSError, ValueError):
        raise GateError('JSON_INPUT_UNREADABLE') from None


def atomic_json(path, value):
    path = Path(path)
    require(path.parent.is_dir() and not path.parent.is_symlink(), 'OUTPUT_PARENT_INVALID')
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        with temporary.open('x', encoding='utf-8') as stream:
            os.chmod(temporary, 0o600)
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        sync_dir(path.parent)
    finally:
        temporary.unlink(missing_ok=True)


def sync_dir(path):
    if os.name == 'posix':
        descriptor = os.open(path, os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


def under(path, root):
    try:
        Path(path).relative_to(root)
        return True
    except ValueError:
        return False


def overlap(left, right):
    return under(left, right) or under(right, left)


def absolute(value):
    require(isinstance(value, str) and value and '\0' not in value and '\n' not in value and '\r' not in value,
            'PATH_INVALID')
    path = Path(value)
    require(path.is_absolute() and '..' not in path.parts, 'PATH_MUST_BE_ABSOLUTE')
    return path


def no_symlink_ancestors(path):
    for item in (path, *path.parents):
        require(not item.is_symlink(), 'PATH_SYMLINK_ANCESTOR')


def command(argv, timeout=30, input_bytes=None, environment=None):
    """Discard external stderr and never log arguments (may contain key locations)."""
    try:
        completed = subprocess.run(argv, input=input_bytes, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, timeout=timeout, env=environment)
    except (OSError, subprocess.SubprocessError):
        raise GateError('COMMAND_UNAVAILABLE_OR_TIMEOUT') from None
    require(completed.returncode == 0, 'COMMAND_FAILED')
    return completed.stdout


def json_command(argv):
    try:
        return json.loads(command(argv))
    except ValueError:
        raise GateError('COMMAND_INVALID_JSON') from None


def load_config(path):
    config = dict(path) if isinstance(path, dict) else jread(path)
    require(config.get('version') == VERSION, 'CONFIG_VERSION')
    require(config.get('profile') in {'production', 'fixture'}, 'CONFIG_PROFILE')
    sources = config.get('sources', [])
    require(isinstance(sources, list) and sources, 'SOURCES_REQUIRED')
    ids = set()
    for source in sources:
        identity = source.get('id', '')
        require(SAFE_ID.fullmatch(identity) and identity not in ids, 'SOURCE_ID_INVALID')
        ids.add(identity)
        source['root'] = absolute(source.get('path'))
        require(isinstance(source.get('sensitive'), bool), 'SOURCE_SENSITIVITY_REQUIRED')
        require(all(isinstance(item.get('glob'), str) and item.get('reason') for item in source.get('exclude', [])),
                'EXCLUSION_REQUIRES_REASON')
    for index, left in enumerate(sources):
        for right in sources[index + 1:]:
            require(not overlap(left['root'], right['root']), 'SOURCE_ROOTS_OVERLAP')
    config['db_path'] = absolute(config.get('database', {}).get('path'))
    require(any(under(config['db_path'], source['root']) for source in sources), 'DATABASE_NOT_COVERED')
    requirements = config.get('coverage', [])
    require(ROLES <= {item.get('role') for item in requirements}, 'COVERAGE_ROLES_MISSING')
    for entry in requirements:
        path_value = absolute(entry.get('path'))
        matches = [source for source in sources if source['id'] == entry.get('source') and under(path_value, source['root'])]
        require(len(matches) == 1, 'COVERAGE_NOT_IN_SOURCE')
        relative = path_value.relative_to(matches[0]['root']).as_posix()
        require(not excluded(matches[0], relative), 'REQUIRED_COVERAGE_EXCLUDED')
    config['spool_path'] = absolute(config.get('spool'))
    config['restore_base'] = absolute(config.get('restore_root'))
    for output in [config['spool_path'], config['restore_base']]:
        require(not any(overlap(output, source['root']) for source in sources), 'OUTPUT_OVERLAPS_SOURCE')
        require(not overlap(output, config['db_path']), 'OUTPUT_OVERLAPS_DATABASE')
    require(not overlap(config['spool_path'], config['restore_base']), 'SPOOL_OVERLAPS_RESTORE')
    if config['profile'] == 'fixture':
        root = absolute(config.get('fixture_root'))
        temporary = Path(tempfile.gettempdir()).resolve()
        require(under(root.resolve(), temporary) and root.resolve() != temporary, 'FIXTURE_MUST_USE_TEMP_DIRECTORY')
        require(all(under(source['root'].resolve(), root.resolve()) for source in sources), 'FIXTURE_SOURCE_OUTSIDE_TEMP')
        require(under(config['spool_path'].resolve(), root.resolve()) and
                under(config['restore_base'].resolve(), root.resolve()), 'FIXTURE_OUTPUT_OUTSIDE_TEMP')
        config['fixture_path'] = root
    else:
        require(sys.platform == 'linux', 'PRODUCTION_REQUIRES_LINUX')
    return config


def excluded(source, relative):
    return any(fnmatch.fnmatchcase(relative, item['glob']) or
        any(fnmatch.fnmatchcase('/'.join(relative.split('/')[:i]), item['glob'])
            for i in range(1, len(relative.split('/')))) for item in source.get('exclude', []))


def private_path(path):
    no_symlink_ancestors(path)
    info = path.stat()
    if os.name == 'posix':
        require(info.st_uid == os.geteuid() and stat.S_IMODE(info.st_mode) & 0o077 == 0,
                'PRIVATE_PATH_PERMISSION')


def source_metadata(config):
    summary = []
    for source in config['sources']:
        root = source['root']
        no_symlink_ancestors(root)
        require(root.exists() and (root.is_dir() or root.is_file()), 'SOURCE_MISSING_OR_TYPE')
        info = root.stat()
        summary.append(dict(id=source['id'], present=True, kind='directory' if root.is_dir() else 'file',
                            mode=oct(stat.S_IMODE(info.st_mode)), uid=info.st_uid, gid=info.st_gid,
                            sensitive=source['sensitive']))
    for entry in config['coverage']:
        require(absolute(entry['path']).exists(), 'REQUIRED_COVERAGE_MISSING')
    require(config['db_path'].is_file(), 'DATABASE_MISSING')
    return summary


def effective_credentials(config):
    """Check environment source matches a covered secret file; never hash/output key."""
    if config['profile'] == 'fixture':
        return dict(profile='fixture', production_credential_proven=False)
    settings = config.get('credentials', {})
    require(settings.get('jwt_source') == 'environment', 'JWT_SOURCE_REQUIRES_REVIEW')
    source = absolute(settings.get('jwt_file'))
    require(any(under(source, entry['root']) for entry in config['sources']), 'JWT_SOURCE_NOT_COVERED')
    private_path(source)
    require(source.is_file() and source.stat().st_size <= 1024 * 1024, 'JWT_SOURCE_FILE_INVALID')
    row = json_command(['docker', 'inspect', 'chisacloudcode-api'])[0]
    environment = dict(value.split('=', 1) for value in row.get('Config', {}).get('Env', []) if '=' in value)
    actual = environment.get('JWT_SECRET')
    require(bool(actual), 'JWT_EFFECTIVE_ENV_MISSING')
    text = source.read_text(encoding='utf-8')
    if settings.get('jwt_format') == 'raw':
        expected = text.strip()
    elif settings.get('jwt_format') == 'dotenv':
        candidates = [line.split('=', 1)[1].strip().strip('\"\'') for line in text.splitlines()
                      if re.match(r'^\s*JWT_SECRET=', line)]
        require(len(candidates) == 1, 'JWT_SOURCE_ASSIGNMENT_AMBIGUOUS')
        expected = candidates[0]
    else:
        raise GateError('JWT_SOURCE_FORMAT_REQUIRED')
    require(hmac.compare_digest(actual, expected), 'JWT_SOURCE_EFFECTIVE_MISMATCH')
    # Value and digest are deliberately excluded even from public metadata.
    return dict(source='environment', covered_file_matches=True, fingerprint_emitted=False)


def mount_identity(config):
    if config['profile'] == 'fixture':
        return {'profile': 'fixture', 'identity': 'temporary-fake-data-only'}
    spec = config.get('mount', {})
    target = str(absolute(spec.get('target')))
    values = json_command(['findmnt', '--json', '--target', target, '--output',
                           'TARGET,SOURCE,FSTYPE,OPTIONS,UUID,FSROOT,MAJ:MIN'])
    rows = values.get('filesystems', [])
    require(len(rows) == 1, 'MOUNT_NOT_UNIQUE')
    row = rows[0]
    require(row.get('target') == target, 'MOUNT_TARGET_MISMATCH')
    require(row.get('uuid') == spec.get('uuid') and bool(spec.get('uuid')), 'MOUNT_UUID_MISMATCH')
    require(row.get('fstype') == spec.get('fstype'), 'MOUNT_FSTYPE_MISMATCH')
    require(set(spec.get('required_options', ['nodev', 'nosuid'])) <= set(row.get('options', '').split(',')),
            'MOUNT_OPTIONS_MISSING')
    require(row.get('fsroot') == '/', 'MOUNT_FSROOT_MISMATCH')
    loops = json_command(['losetup', '--json', '--output', 'NAME,BACK-FILE']).get('loopdevices', [])
    backing = str(absolute(spec.get('backing_file')))
    require(any(value.get('name') == row.get('source') and value.get('back-file') == backing for value in loops),
            'LOOP_BACKING_MISMATCH')
    no_symlink_ancestors(Path(backing))
    return {key: row.get(key) for key in ['target', 'source', 'fstype', 'uuid', 'options', 'maj:min']}


def database_preflight(config):
    """Physical read-only: do not open SQLite (a ro connection can create WAL SHM)."""
    path = config['db_path']
    no_symlink_ancestors(path)
    with path.open('rb') as stream:
        require(stream.read(16) == b'SQLite format 3\x00', 'SQLITE_HEADER_INVALID')
    return dict(header='sqlite3', bytes=path.stat().st_size,
                wal_present=Path(str(path) + '-wal').exists(),
                integrity='deferred-to-fenced-backup-and-isolated-restore')


def sqlite_summary(path):
    uri = Path(path).resolve().as_uri() + '?mode=ro'
    try:
        with contextlib.closing(sqlite3.connect(uri, uri=True, timeout=3)) as connection:
            connection.execute('PRAGMA query_only=ON')
            require(connection.execute('PRAGMA integrity_check').fetchall() == [('ok',)], 'SQLITE_INTEGRITY')
            require(not connection.execute('PRAGMA foreign_key_check').fetchmany(1), 'SQLITE_FOREIGN_KEY')
            tables = [row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
            counts = {table: connection.execute('SELECT count(*) FROM "' + table.replace('"', '""') + '"').fetchone()[0]
                      for table in tables}
            schema = connection.execute('PRAGMA user_version').fetchone()[0]
            return dict(integrity='ok', foreign_keys='ok', user_version=schema, counts=counts)
    except sqlite3.Error:
        raise GateError('SQLITE_READ_FAILED') from None


def database_fingerprint(source):
    """Private consistency guard. No SQL open on production; these hashes never emit."""
    result = []
    for suffix in ['', '-wal', '-journal']:
        path = Path(str(source) + suffix)
        no_symlink_ancestors(path)
        if not path.exists():
            result.append(dict(suffix=suffix, present=False))
            continue
        info = path.stat()
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'DATABASE_SOURCE_TYPE')
        result.append(dict(suffix=suffix, present=True, size=info.st_size, mtime_ns=info.st_mtime_ns,
                           inode=info.st_ino, sha256=sha(path)))
    return result


def backup_sqlite(source, destination):
    """Copy fenced DB+WAL privately, then use SQLite API without touching source SHM."""
    state = database_fingerprint(source)
    try:
        with tempfile.TemporaryDirectory(prefix='.sqlite-input-', dir=destination.parent) as scratch:
            inputs = Path(scratch)
            os.chmod(inputs, 0o700)
            staged = inputs / 'input.sqlite'
            for entry in state:
                if not entry['present']:
                    continue
                original = Path(str(source) + entry['suffix'])
                info = original.stat()
                metadata = dict(inode=info.st_ino, device=info.st_dev, size=info.st_size, mtime_ns=info.st_mtime_ns)
                copied = safe_copy(original, Path(str(staged) + entry['suffix']), metadata)
                require(copied == entry['sha256'], 'DATABASE_CHANGED_DURING_STAGING')
            require(state == database_fingerprint(source), 'DATABASE_CHANGED_DURING_STAGING')
            with contextlib.closing(sqlite3.connect(staged.resolve().as_uri() + '?mode=ro', uri=True, timeout=3)) as src:
                src.execute('PRAGMA query_only=ON')
                with contextlib.closing(sqlite3.connect(destination)) as dst:
                    deadline = time.monotonic() + 60
                    def progress(_status, _remaining, _total):
                        require(time.monotonic() < deadline, 'SQLITE_BACKUP_TIMEOUT')
                    src.backup(dst, pages=256, progress=progress, sleep=0.05)
                    dst.commit()
            os.chmod(destination, 0o600)
            summary = sqlite_summary(destination)
            require(summary == sqlite_summary(staged), 'DATABASE_API_SUMMARY_MISMATCH')
            require(state == database_fingerprint(source), 'DATABASE_CHANGED_DURING_API_BACKUP')
            return summary
    except sqlite3.Error:
        raise GateError('SQLITE_BACKUP_FAILED') from None


def gpg_path(binary, path):
    """Git's MSYS GPG expects /c/... even when launched from native Python."""
    value = str(path)
    if os.name == 'nt' and '/git/' in str(binary).replace('\\', '/').lower():
        match = re.match(r'^([A-Za-z]):[/\\](.*)$', value)
        if match:
            return '/' + match.group(1).lower() + '/' + match.group(2).replace('\\', '/')
    return value


def encryption_preflight(config):
    """Inspect keyring metadata only; invoking GPG may create lock/trustdb files."""
    settings = config.get('encryption', {})
    require(shutil.which(settings.get('gpg', 'gpg')) is not None, 'GPG_MISSING')
    home = absolute(settings.get('public_key_home'))
    require(home.is_dir(), 'PUBLIC_KEYRING_MISSING')
    private_path(home)
    require(not any(overlap(home, source['root']) for source in config['sources']), 'KEYRING_WITHIN_SOURCE')
    fingerprint = str(settings.get('recipient_fingerprint', '')).upper()
    require(re.fullmatch(r'[0-9A-F]{40}|[0-9A-F]{64}', fingerprint), 'RECIPIENT_FINGERPRINT_MISSING')
    require((home / 'pubring.kbx').is_file() or (home / 'pubring.gpg').is_file(), 'PUBLIC_KEYRING_MISSING')
    require(not (home / 'secring.gpg').exists() and not any((home / 'private-keys-v1.d').glob('*')),
            'RECOVERY_PRIVATE_KEY_PRESENT_ON_BACKUP_HOST')
    return dict(recipient=fingerprint, private_key_on_source=False, key_validity='checked-on-execute')


def gpg(config):
    encryption_preflight(config)
    settings = config.get('encryption', {})
    binary = settings.get('gpg', 'gpg')
    require(shutil.which(binary) is not None, 'GPG_MISSING')
    home = absolute(settings.get('public_key_home'))
    require(home.is_dir(), 'PUBLIC_KEYRING_MISSING')
    private_path(home)
    require(not any(overlap(home, source['root']) for source in config['sources']), 'KEYRING_WITHIN_SOURCE')
    fingerprint = str(settings.get('recipient_fingerprint', '')).upper()
    require(re.fullmatch(r'[0-9A-F]{40}|[0-9A-F]{64}', fingerprint), 'RECIPIENT_FINGERPRINT_MISSING')
    base = [binary, '--no-options', '--homedir', gpg_path(binary, home), '--batch', '--no-tty', '--no-auto-key-retrieve',
            '--auto-key-locate', 'clear']
    public = command(base + ['--with-colons', '--list-keys', fingerprint]).decode('utf-8', 'replace')
    fingerprints = [line.split(':')[9] for line in public.splitlines() if line.startswith('fpr:')]
    require(fingerprint in fingerprints, 'RECIPIENT_KEY_MISSING')
    secret = command(base + ['--with-colons', '--list-secret-keys']).decode('utf-8', 'replace')
    require(not any(line.startswith('sec:') or line.startswith('ssb:') for line in secret.splitlines()),
            'RECOVERY_PRIVATE_KEY_PRESENT_ON_BACKUP_HOST')
    return base, fingerprint


def remote_settings(config):
    remote = config.get('offsite', {})
    if config['profile'] == 'fixture':
        path = absolute(remote.get('directory'))
        require(under(path.resolve(), config['fixture_path'].resolve()), 'FIXTURE_REMOTE_OUTSIDE_TEMP')
        return remote
    require(remote.get('transport') == 'sftp' and remote.get('destination') and remote.get('directory'),
            'OFFSITE_ENDPOINT_REQUIRED')
    require(re.fullmatch(r'[a-z_][a-z0-9_-]*@[A-Za-z0-9.-]+', str(remote.get('destination', ''))), 'OFFSITE_DESTINATION_INVALID')
    require(re.fullmatch(r'/[A-Za-z0-9_./-]+', str(remote.get('directory', ''))) and '..' not in remote['directory'].split('/'),
            'OFFSITE_DIRECTORY_INVALID')
    require(remote['destination'].split('@')[1] not in {socket.gethostname(), 'localhost', '127.0.0.1', '94.103.170.66'},
            'OFFSITE_MUST_BE_DIFFERENT_HOST')
    for name in ['identity_file', 'known_hosts']:
        keypath = absolute(remote.get(name))
        require(keypath.is_file(), 'OFFSITE_SSH_INPUT_MISSING')
        private_path(keypath)
    policy_path = absolute(remote.get('retention_evidence'))
    private_path(policy_path)
    require(HEX.fullmatch(str(remote.get('retention_evidence_sha256', ''))) and sha(policy_path) == remote['retention_evidence_sha256'],
            'RETENTION_EVIDENCE_HASH')
    policy = jread(policy_path)
    require(policy.get('destination') == remote['destination'] and policy.get('directory') == remote['directory'],
            'RETENTION_EVIDENCE_ENDPOINT')
    require(policy.get('writer_cannot_delete_history') is True and policy.get('independent_admin_verified') is True,
            'RETENTION_POLICY_UNVERIFIED')
    require(0 <= (now() - parse_time(policy.get('verified_at'))).total_seconds() <= 90 * 86400,
            'RETENTION_EVIDENCE_STALE')
    require(policy.get('hourly', 0) >= 48 and policy.get('daily', 0) >= 30 and policy.get('monthly', 0) >= 12,
            'RETENTION_POLICY_INSUFFICIENT')
    require(remote.get('known_hosts_hostkey_sha256'), 'OFFSITE_HOSTKEY_PIN_REQUIRED')
    # Pin the complete pre-reviewed trust file. StrictHostKeyChecking still verifies its host key.
    require(sha(remote['known_hosts']) == remote['known_hosts_hostkey_sha256'], 'OFFSITE_TRUST_FILE_CHANGED')
    return remote


def machine_identity():
    return dict(machine_id_sha256=sha('/etc/machine-id'), boot_id=Path('/proc/sys/kernel/random/boot_id').read_text().strip())


def host_writers(config):
    roots = [source['root'] for source in config['sources']]
    blockers = 0
    inspected = 0
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit() or int(entry.name) == os.getpid():
            continue
        try:
            # A cwd within the protected tree is conservatively treated as a writer.
            cwd = entry / 'cwd'
            try:
                if any(under(Path(os.readlink(cwd).removesuffix(' (deleted)')), root) for root in roots):
                    blockers += 1
            except FileNotFoundError:
                pass
            for fd in (entry / 'fd').iterdir():
                try:
                    target = Path(os.readlink(fd).removesuffix(' (deleted)'))
                    if not target.is_absolute() or not any(under(target, root) for root in roots):
                        continue
                    text = (entry / 'fdinfo' / fd.name).read_text()
                    flags = next(int(line.split()[1], 8) for line in text.splitlines() if line.startswith('flags:'))
                    if flags & os.O_ACCMODE in {os.O_WRONLY, os.O_RDWR}:
                        blockers += 1
                except FileNotFoundError:
                    continue
            maps = (entry / 'maps').read_text(errors='replace')
            for line in maps.splitlines():
                fields = line.split(None, 5)
                if len(fields) == 6 and len(fields[1]) >= 4 and fields[1][1] == 'w' and fields[1][3] == 's':
                    if any(under(Path(fields[5].removesuffix(' (deleted)')), root) for root in roots):
                        blockers += 1
            inspected += 1
        except (FileNotFoundError, ProcessLookupError):
            continue
        except (PermissionError, OSError, StopIteration, ValueError):
            raise GateError('HOST_WRITER_SCAN_INCOMPLETE') from None
    require(blockers == 0, 'HOST_WRITER_PRESENT')
    return dict(processes_inspected=inspected, writer_blockers=0)


def quiescence(config):
    if config['profile'] == 'fixture':
        require(config.get('fixture_writers', []) == [], 'FIXTURE_WRITER_PRESENT')
        return dict(profile='fixture', fenced=True, production_evidence=False)
    require(os.geteuid() == 0, 'WRITER_SCAN_REQUIRES_ROOT')
    fence_path = absolute(config.get('quiescence', {}).get('evidence'))
    require(fence_path.is_file(), 'FENCE_EVIDENCE_MISSING')
    private_path(fence_path)
    evidence = jread(fence_path)
    require(evidence.get('version') == 1 and evidence.get('admission_closed') is True and
            evidence.get('all_writers_fenced') is True, 'FENCE_NOT_GRANTED')
    require(WRITER_CLASSES <= set(evidence.get('writer_classes', [])), 'FENCE_WRITER_CLASSES_MISSING')
    require(evidence.get('machine') == machine_identity(), 'FENCE_HOST_BOOT_MISMATCH')
    require(0 <= (now() - parse_time(evidence.get('created_at'))).total_seconds() <= 3600 and
            now() < parse_time(evidence.get('expires_at')), 'FENCE_EXPIRED')
    require(evidence.get('change_id') and evidence.get('inventory_reviewed_by') and
            evidence.get('supervisors_and_schedulers_reviewed') is True, 'FENCE_REVIEW_MISSING')
    settings = config.get('quiescence', {})
    units = settings.get('writer_units', [])
    require({'chisa-workspace-api.service', 'chisa-workspace-sync.service'} <= set(units), 'WRITER_UNIT_COVERAGE_MISSING')
    inspected_units = []
    for unit in units + settings.get('writer_timers', []):
        require(re.fullmatch(r'[A-Za-z0-9_.@-]+\.(service|timer)', unit), 'WRITER_UNIT_INVALID')
        text = command(['systemctl', 'show', unit, '-p', 'ActiveState,SubState,UnitFileState,MainPID']).decode()
        values = dict(line.split('=', 1) for line in text.splitlines() if '=' in line)
        require(values.get('ActiveState') == 'inactive' and values.get('MainPID', '0') == '0' and
                values.get('UnitFileState') in {'masked', 'masked-runtime'}, 'WRITER_UNIT_NOT_FENCED')
        inspected_units.append(unit)
    containers = command(['docker', 'ps', '-aq', '--no-trunc']).decode().split()
    count = 0
    for identity in containers:
        row = json_command(['docker', 'inspect', identity])[0]
        relevant = any(mount.get('RW') and any(overlap(Path(mount.get('Source', '/')), source['root']) for source in config['sources'])
                       for mount in row.get('Mounts', []))
        if not relevant:
            continue
        state = row.get('State', {})
        require(state.get('Status') in {'exited', 'created', 'dead'} and state.get('Running') is False and
                state.get('Pid') == 0 and state.get('Paused') is False and state.get('Restarting') is False,
                'DOCKER_WRITER_STILL_ACTIVE')
        require(row.get('HostConfig', {}).get('RestartPolicy', {}).get('Name') == 'no', 'DOCKER_WRITER_CAN_RESTART')
        count += 1
    return dict(fence_sha256=sha(fence_path), inspected_units=inspected_units,
                stopped_overlapping_containers=count, host=host_writers(config))


def run_checks(config):
    checks = []
    results = {}
    functions = [('sources', source_metadata), ('effective_credentials', effective_credentials), ('mount', mount_identity),
                 ('database', database_preflight),
                 ('encryption', encryption_preflight),
                 ('offsite', lambda c: {'configured': bool(remote_settings(c))}),
                 ('independent_recovery_key', recovery_key_evidence), ('quiescence', quiescence)]
    for name, function in functions:
        try:
            results[name] = function(config)
            checks.append(dict(check=name, ok=True))
        except GateError as exc:
            checks.append(dict(check=name, ok=False, code=exc.code))
        except OSError:
            checks.append(dict(check=name, ok=False, code='FILESYSTEM_INPUT_UNAVAILABLE'))
    return dict(sampled_at=stamp(), profile=config['profile'], read_only=True,
                ready_to_backup=all(item['ok'] for item in checks), checks=checks, metadata=results)


def rel_ok(value):
    path = PurePosixPath(value)
    require(value and not path.is_absolute() and '\\' not in value and '\0' not in value and
            all(part not in {'.', '..', ''} for part in value.split('/')), 'ARCHIVE_PATH_UNSAFE')
    return path


def git_coverage(config, entries):
    """Refuse worktree/common-object pointers whose state would be absent on restore."""
    sources = {item['id']: item for item in config['sources']}
    references = 0
    for entry in entries:
        if entry['kind'] != 'file':
            continue
        source = sources[entry['source']]
        path = source['root'] / entry['relative'] if source['root'].is_dir() else source['root']
        parts = Path(entry['relative']).parts
        category = ('gitdir' if path.name == '.git' else
                    'commondir' if path.name == 'commondir' and any(part == '.git' for part in parts) else
                    'alternates' if tuple(parts[-3:]) == ('objects', 'info', 'alternates') else None)
        if not category:
            continue
        require(path.stat().st_size <= 1024 * 1024, 'GIT_REFERENCE_TOO_LARGE')
        try:
            lines = path.read_text(encoding='utf-8').splitlines()
        except (OSError, UnicodeError):
            raise GateError('GIT_REFERENCE_INVALID') from None
        if category == 'gitdir':
            require(len(lines) == 1 and lines[0].startswith('gitdir: '), 'GIT_WORKTREE_POINTER_INVALID')
            values = [lines[0][8:]]
            base = path.parent
        elif category == 'commondir':
            require(len(lines) == 1, 'GIT_COMMONDIR_POINTER_INVALID')
            values = lines
            base = path.parent
        else:
            values = [line for line in lines if line]
            base = path.parent.parent
        for value in values:
            target = (base / value).resolve()
            require(target.is_dir(), 'GIT_REFERENCED_STATE_MISSING')
            covered = [item for item in config['sources'] if under(target, item['root']) and
                       not excluded(item, target.relative_to(item['root']).as_posix())]
            require(covered, 'GIT_EXTERNAL_STATE_NOT_COVERED')
            references += 1
    return dict(external_references_checked=references, all_referenced_state_covered=True)


def list_entries(source, db_path):
    root = source['root']
    no_symlink_ancestors(root)
    entries = []
    def visit(path, relative):
        if excluded(source, relative):
            return
        if path == db_path or str(path) in {str(db_path) + '-wal', str(db_path) + '-shm', str(db_path) + '-journal'}:
            return
        no_symlink_ancestors(path.parent)
        info = path.lstat()
        common = dict(source=source['id'], relative=relative, mode=stat.S_IMODE(info.st_mode), uid=info.st_uid,
                      gid=info.st_gid, size=info.st_size, mtime_ns=info.st_mtime_ns,
                      inode=info.st_ino, device=info.st_dev, nlink=info.st_nlink)
        if stat.S_ISLNK(info.st_mode):
            target = os.readlink(path)
            require(not Path(target).is_absolute() and under((path.parent / target).resolve(), root.resolve()),
                    'EXTERNAL_SYMLINK_UNSUPPORTED')
            common.update(kind='symlink', link=target)
        elif stat.S_ISDIR(info.st_mode):
            common.update(kind='directory')
        elif stat.S_ISREG(info.st_mode):
            require(info.st_nlink == 1, 'HARDLINK_REQUIRES_REVIEWED_SNAPSHOT')
            common.update(kind='file')
        else:
            raise GateError('SPECIAL_FILE_UNSUPPORTED')
        if hasattr(os, 'listxattr') and common['kind'] != 'symlink':
            common['xattrs'] = {name: base64.b64encode(os.getxattr(path, name, follow_symlinks=False)).decode('ascii')
                               for name in os.listxattr(path, follow_symlinks=False)}
        entries.append(common)
        if common['kind'] == 'directory':
            for child in sorted(path.iterdir()):
                visit(child, relative + '/' + child.name if relative else child.name)
    if root.is_dir():
        # Root metadata is separate so archive names never contain dot components.
        root_info = root.stat()
        root_entry = dict(source=source['id'], relative='', kind='directory', mode=stat.S_IMODE(root_info.st_mode),
            uid=root_info.st_uid, gid=root_info.st_gid, size=root_info.st_size, mtime_ns=root_info.st_mtime_ns,
            inode=root_info.st_ino, device=root_info.st_dev, nlink=root_info.st_nlink)
        if hasattr(os, 'listxattr'):
            root_entry['xattrs'] = {name: base64.b64encode(os.getxattr(root, name, follow_symlinks=False)).decode('ascii')
                                    for name in os.listxattr(root, follow_symlinks=False)}
        entries.append(root_entry)
        for child in sorted(root.iterdir()):
            visit(child, child.name)
    else:
        visit(root, root.name)
    return entries


def safe_copy(source, destination, before):
    no_symlink_ancestors(source.parent)
    descriptor = os.open(source, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    try:
        info = os.fstat(descriptor)
        require(stat.S_ISREG(info.st_mode) and info.st_ino == before['inode'] and
                info.st_dev == before['device'] and info.st_size == before['size'] and
                info.st_mtime_ns == before['mtime_ns'], 'SOURCE_CHANGED_BEFORE_COPY')
        digest = hashlib.sha256()
        with os.fdopen(descriptor, 'rb', closefd=False) as src, destination.open('xb') as dst:
            os.chmod(destination, 0o600)
            while True:
                block = src.read(1024 * 1024)
                if not block:
                    break
                dst.write(block)
                digest.update(block)
            dst.flush()
            os.fsync(dst.fileno())
        after = os.fstat(descriptor)
        require((info.st_size, info.st_mtime_ns, info.st_ctime_ns) ==
                (after.st_size, after.st_mtime_ns, after.st_ctime_ns), 'SOURCE_CHANGED_DURING_COPY')
        return digest.hexdigest()
    finally:
        os.close(descriptor)


def sftp_base(config):
    remote = remote_settings(config)
    return ['sftp', '-q', '-oBatchMode=yes', '-oStrictHostKeyChecking=yes', '-oConnectTimeout=15',
            '-oIdentitiesOnly=yes', '-oUserKnownHostsFile=' + remote['known_hosts'],
            '-i', remote['identity_file'], '-P', str(int(remote.get('port', 22))), '-b', '-', remote['destination']]


def recovery_key_evidence(config):
    if config['profile'] == 'fixture':
        return dict(production_recovery_key_proven=False)
    settings = config.get('encryption', {})
    path = absolute(settings.get('recovery_key_evidence'))
    require(path.is_file(), 'RECOVERY_KEY_EVIDENCE_MISSING')
    private_path(path)
    require(HEX.fullmatch(str(settings.get('recovery_key_evidence_sha256', ''))) and
            sha(path) == settings['recovery_key_evidence_sha256'], 'RECOVERY_KEY_EVIDENCE_HASH')
    evidence = jread(path)
    require(evidence.get('recipient_fingerprint') == settings.get('recipient_fingerprint') and
            evidence.get('private_key_stored_off_source') is True and evidence.get('independent_custodian_verified') is True and
            evidence.get('decrypt_challenge_passed') is True and evidence.get('evidence_reference'),
            'RECOVERY_KEY_NOT_INDEPENDENTLY_VERIFIED')
    require(0 <= (now() - parse_time(evidence.get('verified_at'))).total_seconds() <= 90 * 86400,
            'RECOVERY_KEY_EVIDENCE_STALE')
    return dict(independent_custody_verified=True, evidence_sha256=sha(path))


def offsite_upload(config, encrypted, receipt, work):
    remote = remote_settings(config)
    identifier = receipt['bundle_id']
    if config['profile'] == 'fixture':
        destination = Path(remote['directory']) / identifier
        destination.mkdir(parents=True, exist_ok=False)
        shutil.copyfile(encrypted, destination / 'bundle.tar.gpg')
        atomic_json(destination / 'receipt.json', receipt)
        require(sha(destination / 'bundle.tar.gpg') == receipt['ciphertext_sha256'], 'OFFSITE_READBACK_HASH')
        return dict(transport='fixture-copy', readback_verified=True, production_offsite=False)
    require('"' not in str(encrypted) and '\n' not in str(encrypted), 'SFTP_LOCAL_PATH_INVALID')
    remote_path = remote['directory'].rstrip('/') + '/' + identifier
    local_receipt = work / 'receipt.json'
    atomic_json(local_receipt, receipt)
    readback = work / 'readback.gpg'
    batch = '\n'.join(['mkdir ' + remote_path,
        'put "' + str(encrypted).replace('\\', '/') + '" ' + remote_path + '/bundle.tar.gpg',
        'put "' + str(local_receipt).replace('\\', '/') + '" ' + remote_path + '/receipt.json',
        'get ' + remote_path + '/bundle.tar.gpg "' + str(readback).replace('\\', '/') + '"', 'bye', ''])
    command(sftp_base(config), timeout=int(remote.get('timeout_seconds', 7200)), input_bytes=batch.encode())
    require(sha(readback) == receipt['ciphertext_sha256'], 'OFFSITE_READBACK_HASH')
    return dict(transport='sftp', readback_verified=True, production_offsite=True)


def offsite_commit(config, receipt, work):
    """A remote directory without COMMITTED.json is always an incomplete upload."""
    remote = remote_settings(config)
    if config['profile'] == 'fixture':
        atomic_json(Path(remote['directory']) / receipt['bundle_id'] / 'COMMITTED.json', receipt)
        return
    commit = work / 'COMMITTED.json'
    atomic_json(commit, receipt)
    remote_path = remote['directory'].rstrip('/') + '/' + receipt['bundle_id']
    readback = work / 'commit-readback.json'
    batch = '\n'.join(['put "' + str(commit).replace('\\', '/') + '" ' + remote_path + '/COMMITTED.json',
        'get ' + remote_path + '/COMMITTED.json "' + str(readback).replace('\\', '/') + '"', 'bye', ''])
    command(sftp_base(config), timeout=int(remote.get('timeout_seconds', 7200)), input_bytes=batch.encode())
    require(sha(commit) == sha(readback), 'OFFSITE_COMMIT_READBACK')


@contextlib.contextmanager
def backup_lock(spool):
    lock = spool / 'backup.lock'
    descriptor = os.open(lock, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        if os.name == 'posix':
            import fcntl
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise GateError('BACKUP_ALREADY_RUNNING') from None
        else:
            import msvcrt
            try:
                msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
            except OSError:
                raise GateError('BACKUP_ALREADY_RUNNING') from None
        yield
    finally:
        os.close(descriptor)


def create_bundle(config):
    report = run_checks(config)
    require(report['ready_to_backup'], 'PREFLIGHT_FAILED')
    spool = config['spool_path']
    no_symlink_ancestors(spool)
    spool.mkdir(mode=0o700, parents=True, exist_ok=True)
    private_path(spool)
    with backup_lock(spool):
        identifier = now().strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex
        started = stamp()
        started_mono = time.monotonic()
        try:
            with tempfile.TemporaryDirectory(prefix='.plaintext-', dir=spool) as scratch:
                work = Path(scratch)
                os.chmod(work, 0o700)
                payload = work / 'payload'
                payload.mkdir(mode=0o700)
                fence = quiescence(config)
                mount = mount_identity(config)
                before = [item for source in config['sources'] for item in list_entries(source, config['db_path'])]
                git = git_coverage(config, before)
                source_by_id = {item['id']: item for item in config['sources']}
                free = shutil.disk_usage(spool).free
                required_space = sum(item['size'] for item in before if item['kind'] == 'file') + config['db_path'].stat().st_size
                require(free >= required_space * 3 + int(config.get('reserve_bytes', 128 * 1024 * 1024)), 'SPOOL_CAPACITY_INSUFFICIENT')
                entries = []
                for item in before:
                    source = source_by_id[item['source']]
                    source_path = source['root'] / item['relative'] if source['root'].is_dir() else source['root']
                    relative = item['source'] + ('/' + item['relative'] if item['relative'] else '')
                    rel_ok(relative)
                    destination = payload / relative
                    entry = {key: value for key, value in item.items() if key not in {'inode', 'device', 'nlink', 'size'}}
                    entry['archive'] = 'payload/' + relative
                    if item['kind'] == 'directory':
                        destination.mkdir(mode=0o700, parents=True, exist_ok=True)
                    elif item['kind'] == 'file':
                        destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                        entry['sha256'] = safe_copy(source_path, destination, item)
                        entry['size'] = destination.stat().st_size
                    else:
                        # Link is represented in the manifest, never followed while staging.
                        entry['size'] = 0
                    entries.append(entry)
                database_file = payload / '_sqlite' / 'database.sqlite'
                database_file.parent.mkdir(mode=0o700)
                database_state = database_fingerprint(config['db_path'])
                database = backup_sqlite(config['db_path'], database_file)
                require(database_state == database_fingerprint(config['db_path']), 'DATABASE_CHANGED_ACROSS_BACKUP')
                db_info = config['db_path'].stat()
                entries.append(dict(source='_sqlite', relative='database.sqlite', archive='payload/_sqlite/database.sqlite',
                    kind='file', mode=stat.S_IMODE(db_info.st_mode), uid=db_info.st_uid, gid=db_info.st_gid,
                    mtime_ns=db_info.st_mtime_ns, size=database_file.stat().st_size, sha256=sha(database_file)))
                after = [item for source in config['sources'] for item in list_entries(source, config['db_path'])]
                require(before == after, 'SOURCE_INVENTORY_CHANGED')
                require(database_state == database_fingerprint(config['db_path']), 'DATABASE_CHANGED_ACROSS_CAPTURE')
                # Rehash original regular files: catches same-size/mtime changes during DB/filesystem capture.
                for item in entries:
                    if item['kind'] == 'file' and item['source'] != '_sqlite':
                        src = source_by_id[item['source']]['root']
                        src = src / item['relative'] if src.is_dir() else src
                        require(sha(src) == item['sha256'], 'SOURCE_CONTENT_CHANGED')
                require(mount_identity(config) == mount, 'MOUNT_CHANGED_ACROSS_BACKUP')
                final_fence = quiescence(config)
                require(final_fence.get('fence_sha256') == fence.get('fence_sha256'), 'FENCE_CHANGED_ACROSS_BACKUP')
                manifest = dict(version=VERSION, bundle_id=identifier, started_at=started, captured_at=stamp(),
                    profile=config['profile'], source_machine=machine_identity() if config['profile'] == 'production' else None,
                    consistency='externally-fenced-cold-copy-plus-sqlite-backup-api',
                    database=database, git=git, mount=mount, quiescence=fence,
                    sources=[dict(id=source['id'], path=str(source['root']), sensitive=source['sensitive'],
                        kind='directory' if source['root'].is_dir() else 'file', exclusions=source.get('exclude', []))
                        for source in config['sources']],
                    database_original_path=str(config['db_path']),
                    coverage=config['coverage'], entries=entries,
                    limitations=['no application smoke/provider execution', 'old writer leases require fencing/reconciliation before promotion'])
                atomic_json(work / 'manifest.json', manifest)
                archive = work / 'bundle.tar'
                with tarfile.open(archive, 'w', format=tarfile.PAX_FORMAT) as tar:
                    tar.add(work / 'manifest.json', arcname='manifest.json', recursive=False)
                    for item in entries:
                        if item['kind'] != 'symlink':
                            tar.add(work / item['archive'], arcname=item['archive'], recursive=False)
                base, recipient = gpg(config)
                encrypted = work / 'bundle.tar.gpg'
                binary = config['encryption'].get('gpg', 'gpg')
                command(base + ['--trust-model', 'always', '--recipient', recipient, '--output', gpg_path(binary, encrypted),
                                '--encrypt', gpg_path(binary, archive)], timeout=int(config.get('encryption_timeout_seconds', 7200)))
                receipt = dict(version=VERSION, bundle_id=identifier, captured_at=manifest['captured_at'],
                    profile=config['profile'], ciphertext_sha256=sha(encrypted), ciphertext_bytes=encrypted.stat().st_size,
                    encrypted=True, source_count=len(config['sources']), entry_count=len(entries),
                    # No raw path, per-file hash, table name, env value or secret in this public receipt.
                    gpg_recipient=recipient)
                offsite = offsite_upload(config, encrypted, receipt, work)
                require(mount_identity(config) == mount, 'MOUNT_CHANGED_BEFORE_COMMIT')
                quiescence(config)
                receipt.update(offsite=offsite, completed_at=stamp(), duration_seconds=round(time.monotonic() - started_mono, 3),
                               consistent=True, application_recovery_proven=False)
                offsite_commit(config, receipt, work)
                final = spool / identifier
                final.mkdir(mode=0o700, exist_ok=False)
                os.replace(encrypted, final / 'bundle.tar.gpg')
                atomic_json(final / 'receipt.json', receipt)
                atomic_json(spool / 'latest-success.json', receipt)
                atomic_json(spool / 'latest-attempt.json', dict(ok=True, bundle_id=identifier, completed_at=stamp()))
                return receipt
        except BaseException as exc:
            code = exc.code if isinstance(exc, GateError) else type(exc).__name__
            atomic_json(spool / 'latest-attempt.json', dict(ok=False, completed_at=stamp(), code=code))
            raise


def offsite_fetch(config, bundle_id, target, expected_sha256):
    """Explicit download to a new local file; independent ciphertext digest required."""
    require(re.fullmatch(r'[0-9]{8}T[0-9]{6}Z-[0-9a-f]{32}', bundle_id or ''), 'BUNDLE_ID_INVALID')
    require(HEX.fullmatch(expected_sha256 or ''), 'EXPECTED_HASH_REQUIRED')
    target = absolute(str(target))
    require(under(target, config['restore_base']) and target != config['restore_base'], 'FETCH_TARGET_OUTSIDE_RESTORE_ROOT')
    no_symlink_ancestors(target)
    require(not target.exists(), 'FETCH_TARGET_ALREADY_EXISTS')
    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    no_symlink_ancestors(target.parent)
    remote = remote_settings(config)
    with tempfile.TemporaryDirectory(prefix='.fetch-', dir=target.parent) as scratch:
        work = Path(scratch)
        ciphertext = work / 'bundle.tar.gpg'
        committed = work / 'COMMITTED.json'
        if config['profile'] == 'fixture':
            remote_dir = Path(remote['directory']) / bundle_id
            require((remote_dir / 'COMMITTED.json').is_file(), 'OFFSITE_COMMIT_MISSING')
            shutil.copyfile(remote_dir / 'COMMITTED.json', committed)
            shutil.copyfile(remote_dir / 'bundle.tar.gpg', ciphertext)
        else:
            remote_dir = remote['directory'].rstrip('/') + '/' + bundle_id
            batch = '\n'.join(['get ' + remote_dir + '/COMMITTED.json "' + str(committed).replace('\\', '/') + '"',
                'get ' + remote_dir + '/bundle.tar.gpg "' + str(ciphertext).replace('\\', '/') + '"', 'bye', ''])
            command(sftp_base(config), timeout=int(remote.get('timeout_seconds', 7200)), input_bytes=batch.encode())
        receipt = jread(committed)
        require(receipt.get('consistent') is True and receipt.get('bundle_id') == bundle_id and
                receipt.get('ciphertext_sha256') == expected_sha256, 'OFFSITE_COMMIT_MISMATCH')
        require(sha(ciphertext) == expected_sha256, 'OFFSITE_FETCH_HASH')
        os.chmod(ciphertext, 0o600)
        os.replace(ciphertext, target)
        sync_dir(target.parent)
    return dict(ok=True, action='fetch', bundle_id=bundle_id, ciphertext_sha256=expected_sha256,
                offsite_commit_verified=True, production_drill_passed=False)


def isolated():
    require(sys.platform == 'linux', 'RESTORE_ISOLATION_REQUIRES_LINUX')
    # if_nameindex observes the current network namespace; a pre-existing sysfs
    # mount can still show the parent namespace's interface directory.
    interfaces = {name for _index, name in socket.if_nameindex()}
    require(interfaces <= {'lo'}, 'RESTORE_NETWORK_NOT_ISOLATED')
    routes = Path('/proc/net/route').read_text().splitlines()[1:]
    require(not [line for line in routes if line.strip()], 'RESTORE_NETWORK_HAS_ROUTE')
    ipv6_routes = Path('/proc/net/ipv6_route')
    if ipv6_routes.exists():
        require(not any(line.split() and line.split()[-1] != 'lo' for line in ipv6_routes.read_text().splitlines()),
                'RESTORE_IPV6_ROUTE_PRESENT')
    require(not Path('/var/run/docker.sock').exists() and not Path('/run/containerd/containerd.sock').exists(),
            'RESTORE_CONTAINER_SOCKET_EXPOSED')
    return dict(network='private-namespace-no-egress', docker_socket='hidden', provider_execution=False)


def restore_bundle(config, encrypted, target, expected_sha256, key_home, fixture=False):
    require(HEX.fullmatch(expected_sha256 or '') and sha(encrypted) == expected_sha256, 'CIPHERTEXT_HASH_MISMATCH')
    target = absolute(str(target))
    no_symlink_ancestors(target)
    require(under(target, config['restore_base']) and target != config['restore_base'], 'RESTORE_TARGET_OUTSIDE_ROOT')
    require(not target.exists(), 'RESTORE_TARGET_ALREADY_EXISTS')
    key_home = absolute(str(key_home))
    private_path(key_home)
    require(not any(overlap(key_home, source['root']) for source in config['sources']), 'RECOVERY_KEY_WITHIN_SOURCE')
    require(not overlap(target, key_home) and not overlap(target, Path(encrypted)), 'RESTORE_INPUT_OVERLAP')
    if fixture:
        require(config['profile'] == 'fixture' and under(key_home.resolve(), config['fixture_path'].resolve()),
                'FIXTURE_RESTORE_REQUIRES_FAKE_DATA')
        isolation = dict(network='fixture-data-only-no-app-execution', production_isolation_proven=False, provider_execution=False)
    else:
        isolation = isolated()
        if config['profile'] == 'fixture':
            require(under(key_home.resolve(), config['fixture_path'].resolve()),
                    'FIXTURE_RESTORE_REQUIRES_FAKE_DATA')
            isolation.update(test_only=True, production_isolation_proven=False)
    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    no_symlink_ancestors(target.parent)
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix='.verify-', dir=target.parent) as scratch:
        work = Path(scratch)
        os.chmod(work, 0o700)
        archive = work / 'decrypted.tar'
        binary = config['encryption'].get('gpg', 'gpg')
        command([binary, '--no-options', '--homedir', gpg_path(binary, key_home), '--batch', '--no-tty', '--no-auto-key-retrieve',
                 '--auto-key-locate', 'clear', '--output', gpg_path(binary, archive), '--decrypt', gpg_path(binary, encrypted)],
                timeout=int(config.get('encryption_timeout_seconds', 7200)))
        with tarfile.open(archive, 'r:') as tar:
            members = tar.getmembers()
            names = [item.name for item in members]
            require(len(names) == len(set(names)), 'ARCHIVE_DUPLICATE_MEMBER')
            require('manifest.json' in names and all(rel_ok(item.name) for item in members), 'ARCHIVE_INVALID_MEMBERS')
            meta = tar.getmember('manifest.json')
            require(meta.isfile() and meta.size < int(config.get('max_manifest_bytes', 64 * 1024 * 1024)), 'MANIFEST_TYPE_OR_SIZE')
            try:
                manifest = json.load(tar.extractfile(meta))
            except (ValueError, TypeError):
                raise GateError('MANIFEST_INVALID') from None
            require(manifest.get('version') == VERSION, 'MANIFEST_VERSION')
            require(manifest.get('profile') == config['profile'], 'MANIFEST_PROFILE_MISMATCH')
            if not fixture and config['profile'] == 'production':
                source_machine = manifest.get('source_machine')
                require(isinstance(source_machine, dict) and source_machine.get('machine_id_sha256'),
                        'RESTORE_SOURCE_MACHINE_MISSING')
                require(source_machine['machine_id_sha256'] != machine_identity()['machine_id_sha256'],
                        'RESTORE_MUST_USE_DIFFERENT_HOST')
            for item in manifest.get('sources', []):
                require(SAFE_ID.fullmatch(item.get('id', '')), 'MANIFEST_SOURCE_ID_INVALID')
            allowed_sources = {item['id'] for item in manifest.get('sources', [])} | {'_sqlite'}
            entries = manifest.get('entries', [])
            for entry in entries:
                require(entry.get('source') in allowed_sources, 'MANIFEST_UNKNOWN_SOURCE')
                expected_archive = 'payload/' + entry['source'] + ('/' + entry['relative'] if entry['relative'] else '')
                require(entry.get('archive') == expected_archive, 'MANIFEST_SOURCE_PATH_MISMATCH')
            expected = {'manifest.json'} | {entry['archive'] for entry in entries if entry['kind'] != 'symlink'}
            require(set(names) == expected, 'ARCHIVE_MANIFEST_MEMBER_MISMATCH')
            require(len({entry['archive'] for entry in entries}) == len(entries), 'MANIFEST_DUPLICATE_ENTRY')
            total_size = sum(item.size for item in members)
            require(total_size <= int(config.get('max_restore_bytes', 1024 ** 4)), 'RESTORE_SIZE_LIMIT')
            require(shutil.disk_usage(target.parent).free > total_size + int(config.get('reserve_bytes', 128 * 1024 * 1024)),
                    'RESTORE_CAPACITY_INSUFFICIENT')
            target.mkdir(mode=0o700, exist_ok=False)
            try:
                for entry in entries:
                    relative = rel_ok(entry['archive'])
                    require(relative.parts[0] == 'payload', 'MANIFEST_PATH_OUTSIDE_PAYLOAD')
                    destination = target.joinpath(*relative.parts)
                    no_symlink_ancestors(destination.parent)
                    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                    if entry['kind'] == 'directory':
                        require(tar.getmember(entry['archive']).isdir(), 'ARCHIVE_ENTRY_TYPE')
                        destination.mkdir(mode=0o700, exist_ok=True)
                    elif entry['kind'] == 'file':
                        member = tar.getmember(entry['archive'])
                        require(member.isfile() and member.size == entry.get('size'), 'ARCHIVE_ENTRY_TYPE_OR_SIZE')
                        with tar.extractfile(member) as src, destination.open('xb') as dst:
                            os.chmod(destination, 0o600)
                            shutil.copyfileobj(src, dst)
                            dst.flush()
                            os.fsync(dst.fileno())
                        require(sha(destination) == entry.get('sha256'), 'RESTORE_FILE_HASH_MISMATCH')
                    elif entry['kind'] != 'symlink':
                        raise GateError('MANIFEST_SPECIAL_FILE')
                # Create links last; an archived symlink can never redirect extraction.
                for entry in entries:
                    if entry['kind'] == 'symlink':
                        relative = rel_ok(entry['archive'])
                        destination = target.joinpath(*relative.parts)
                        link = entry.get('link', '')
                        require(isinstance(link, str) and link and not Path(link).is_absolute() and
                                under((destination.parent / link).resolve(), target / 'payload' / entry['source']),
                                'RESTORE_EXTERNAL_SYMLINK')
                        no_symlink_ancestors(destination.parent)
                        destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                        os.symlink(link, destination)
                # Source UID/GID and xattrs are evidence; do not apply active security attributes.
                # Preserve private modes; setuid/setgid bits never apply in verification copies.
                for entry in sorted(entries, key=lambda item: len(item['archive']), reverse=True):
                    destination = target / entry['archive']
                    if entry['kind'] != 'symlink':
                        os.chmod(destination, entry['mode'] & 0o777)
                        os.utime(destination, ns=(entry['mtime_ns'], entry['mtime_ns']))
                database = sqlite_summary(target / 'payload/_sqlite/database.sqlite')
                require(database == manifest.get('database'), 'RESTORE_DATABASE_COUNTS_MISMATCH')
                # An ephemeral write/read/unlink proves restored directory writability; no user file overwritten.
                probe = target / ('.write-check-' + uuid.uuid4().hex)
                probe.write_bytes(b'fixture-free-storage-probe')
                require(probe.read_bytes() == b'fixture-free-storage-probe', 'RESTORE_WRITE_CHECK')
                probe.unlink()
                atomic_json(target / 'manifest.private.json', manifest)
                result = dict(ok=True, profile=config['profile'], verified_at=stamp(),
                    bundle_id=manifest['bundle_id'], ciphertext_sha256=expected_sha256,
                    entries_verified=len(entries), sqlite_integrity='ok', sqlite_counts_match=True,
                    elapsed_seconds=round(time.monotonic() - started, 3),
                    recovery_point_age_seconds=max(0, round((now() - parse_time(manifest['captured_at'])).total_seconds())),
                    isolation=isolation, file_consistency_verified=True,
                    production_drill_passed=False, application_smoke_performed=False,
                    promotion_blockers=['independent key exercise/host evidence must be recorded',
                        'UID/GID/ACL/xattrs/path/lease generation reconciliation',
                        'test credentials and endpoints; login/project/git/attachment/shell/preview/crash smoke',
                        'RPO/RTO and second management session/console evidence'])
                atomic_json(target / 'verification.json', result)
                return result
            except BaseException:
                # Retain a visibly failed private target for diagnosis; never mark partial restore successful.
                atomic_json(target / 'FAILED.json', dict(ok=False, sampled_at=stamp(), code='RESTORE_INCOMPLETE'))
                raise


def verify_isolated(config_path, config, args):
    require(config['profile'] in {'production', 'fixture'} and sys.platform == 'linux', 'PRODUCTION_VERIFY_REQUIRES_LINUX')
    require(shutil.which('unshare') and shutil.which('mount'), 'NAMESPACE_TOOLS_MISSING')
    require(args.key_home and args.expect_sha256 and args.target and args.bundle, 'VERIFY_ARGUMENTS_MISSING')
    argv = ['unshare', '--net', '--mount', '--pid', '--fork', '--mount-proc', sys.executable,
            str(Path(__file__).resolve()), '_verify', '--execute', '--config', str(Path(config_path).resolve()),
            '--bundle', str(Path(args.bundle).resolve()), '--target', str(absolute(args.target)),
            '--expect-sha256', args.expect_sha256, '--key-home', str(absolute(args.key_home))]
    environment = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8', 'CHISA_RESTORE_PARENT_NETNS': os.readlink('/proc/self/ns/net')}
    # JSON result only; external failures are sanitized by command().
    return json.loads(command(argv, timeout=int(config.get('verify_timeout_seconds', 14400)), environment=environment))


def monitoring_dependency(config, kind):
    """Require fresh pinned local attestations; never contact a sink/exporter.

    These records must come from separately reviewed observation/delivery tests.
    Editing a JSON record is not an implementation of either dependency.
    """
    prefix = 'MONITOR_' + kind.upper()
    settings = config.get('monitor', {})
    spec = settings.get(kind)
    require(isinstance(spec, dict) and spec.get('evidence'), prefix + '_EVIDENCE_REQUIRED')
    path = absolute(spec['evidence'])
    require(path.is_file(), prefix + '_EVIDENCE_MISSING')
    private_path(path)
    require(path.stat().st_size <= 65536, prefix + '_EVIDENCE_SIZE')
    require(HEX.fullmatch(str(spec.get('sha256', ''))) and sha(path) == spec['sha256'], prefix + '_EVIDENCE_HASH')
    record = jread(path)
    require(isinstance(record, dict) and record.get('version') == 1 and record.get('kind') == kind and
            record.get('healthy') is True and record.get('evidence_reference'), prefix + '_NOT_VERIFIED')
    require(0 <= (now() - parse_time(record.get('checked_at'))).total_seconds() <=
            int(settings.get('dependency_max_age_seconds', 86400)), prefix + '_EVIDENCE_STALE')
    if config['profile'] == 'production':
        require(record.get('machine') == machine_identity(), prefix + '_HOST_BOOT_MISMATCH')
    if kind == 'exporter':
        require({'request_latency', 'authentication', 'websocket', 'lease', 'cleanup'} <=
                set(record.get('covered_signals', [])), prefix + '_SIGNALS_MISSING')
    else:
        require(record.get('delivery_test_passed') is True and record.get('independent_receiver_confirmed') is True,
                prefix + '_DELIVERY_UNVERIFIED')
    return dict(evidence_verified=True, live_dependency_checked_by_this_tool=False)


def systemd_observation(text):
    """Parse exact required units; successful systemctl alone is not health."""
    services = []
    for block in text.strip().split('\n\n'):
        fields = dict(line.split('=', 1) for line in block.splitlines() if '=' in line)
        if not fields:
            continue
        require(fields.get('Id') and fields.get('NRestarts', '').isdigit(), 'SYSTEMD_OBSERVATION_INVALID')
        services.append(dict(id=fields['Id'], active=fields.get('ActiveState'), substate=fields.get('SubState'),
                             restarts=int(fields['NRestarts'])))
    expected = {'chisa-workspace-api.service', 'chisa-workspace-sync.service'}
    require(len(services) == len(expected) and {item['id'] for item in services} == expected, 'SYSTEMD_OBSERVATION_INCOMPLETE')
    return services


def monitor(config):
    """Read-only readiness evidence; never calls a provider or changes admission."""
    findings = []
    metrics = {}
    for name, function in [('sources', source_metadata), ('mount', mount_identity),
                            ('database', database_preflight)]:
        try:
            function(config)
        except (GateError, OSError) as exc:
            findings.append(dict(signal=name, code=getattr(exc, 'code', 'READ_FAILED'), severity='critical'))
    for name, path in [('system', config['db_path'].parent), ('workspace', Path(config['coverage'][0]['path']))]:
        try:
            usage = shutil.disk_usage(path)
            metrics[name + '_free_bytes'] = usage.free
            require(usage.free / usage.total >= float(config.get('monitor', {}).get('minimum_free_ratio', 0.10)), 'DISK_LOW')
            if hasattr(os, 'statvfs'):
                vfs = os.statvfs(path)
                metrics[name + '_inode_free_ratio'] = vfs.f_favail / max(vfs.f_files, 1)
                require(vfs.f_favail / max(vfs.f_files, 1) >= 0.10, 'INODES_LOW')
        except (GateError, OSError) as exc:
            findings.append(dict(signal='capacity_' + name, code=getattr(exc, 'code', 'READ_FAILED'), severity='critical'))
    try:
        success = jread(config['spool_path'] / 'latest-success.json')
        age = (now() - parse_time(success['captured_at'])).total_seconds()
        metrics['consistent_backup_age_seconds'] = round(age)
        require(success.get('consistent') is True and success.get('offsite', {}).get('readback_verified') is True,
                'BACKUP_NOT_VERIFIED')
        require(0 <= age <= int(config.get('monitor', {}).get('rpo_seconds', 3600)), 'BACKUP_OVER_RPO')
        require(config['profile'] == 'fixture' or success.get('offsite', {}).get('production_offsite') is True,
                'NO_PRODUCTION_OFFSITE')
    except (GateError, KeyError, TypeError) as exc:
        findings.append(dict(signal='backup', code=getattr(exc, 'code', 'BACKUP_RECORD_INVALID'), severity='critical'))
    try:
        attempt = jread(config['spool_path'] / 'latest-attempt.json')
        require(attempt.get('ok') is True, 'LAST_BACKUP_ATTEMPT_FAILED')
    except GateError as exc:
        findings.append(dict(signal='backup_attempt', code=exc.code, severity='critical'))
    settings = config.get('monitor', {})
    for dependency in ['exporter', 'alert_sink']:
        try:
            metrics[dependency] = monitoring_dependency(config, dependency)
        except (GateError, OSError, TypeError, ValueError) as exc:
            findings.append(dict(signal=dependency, code=getattr(exc, 'code', 'MONITOR_DEPENDENCY_INVALID'), severity='critical'))
    try:
        restore = jread(absolute(settings.get('verified_drill_record')))
        age = (now() - parse_time(restore['verified_at'])).total_seconds()
        metrics['production_drill_age_seconds'] = round(age)
        require(restore.get('production_drill_passed') is True and 0 <= age <= int(settings.get('max_drill_age_seconds', 30 * 86400)),
                'NO_CURRENT_PRODUCTION_DRILL')
    except (GateError, KeyError, TypeError) as exc:
        findings.append(dict(signal='restore_drill', code=getattr(exc, 'code', 'DRILL_RECORD_INVALID'), severity='critical'))
    if config['profile'] == 'production':
        try:
            text = command(['systemctl', 'show', 'chisa-workspace-api.service', 'chisa-workspace-sync.service',
                            '-p', 'Id,ActiveState,SubState,NRestarts']).decode()
            metrics['systemd_services'] = text
            services = systemd_observation(text)
            metrics['systemd_states'] = services
            for service in services:
                if service['active'] != 'active' or service['substate'] != 'running':
                    findings.append(dict(signal='systemd_service', code='SYSTEMD_SERVICE_NOT_RUNNING',
                                         unit=service['id'], severity='critical'))
            ids = command(['docker', 'ps', '-aq', '--no-trunc']).decode().split()
            require(ids, 'DOCKER_OBSERVATION_EMPTY')
            metrics['containers'] = []
            for identity in ids:
                item = json_command(['docker', 'inspect', identity])[0]
                if not any(any(overlap(Path(mount.get('Source', '/')), source['root']) for source in config['sources']) for mount in item.get('Mounts', [])):
                    continue
                state = item.get('State', {})
                log = item.get('HostConfig', {}).get('LogConfig', {})
                metrics['containers'].append(dict(id=item['Id'], status=state.get('Status'),
                    running=state.get('Running') is True, paused=state.get('Paused') is True,
                    restart_count=item.get('RestartCount'), oom_killed=state.get('OOMKilled'), bounded_log=bool(log.get('Config', {}).get('max-size'))))
                health = state.get('Health', {}).get('Status')
                if (state.get('Restarting') is True or state.get('Dead') is True or state.get('Paused') is True or
                        state.get('Status') in {'restarting', 'dead', 'paused'} or health in {'unhealthy', 'starting'} or
                        state.get('Status') == 'running' and state.get('Running') is not True):
                    findings.append(dict(signal='container', code='CONTAINER_NOT_HEALTHY', severity='critical'))
                if state.get('OOMKilled'):
                    findings.append(dict(signal='container', code='CONTAINER_OOM', severity='critical'))
                if not log.get('Config', {}).get('max-size'):
                    findings.append(dict(signal='container_logs', code='LOG_ROTATION_UNBOUNDED', severity='warning'))
            require(any(item['status'] == 'running' and item['running'] and not item['paused']
                        for item in metrics['containers']), 'DOCKER_RELEVANT_RUNNING_CONTAINER_MISSING')
        except GateError as exc:
            findings.append(dict(signal='service_observation', code=exc.code, severity='critical'))
        certificate = settings.get('certificate_file')
        try:
            require(certificate, 'CERTIFICATE_PATH_REQUIRED')
            import ssl
            cert = ssl._ssl._test_decode_cert(str(absolute(certificate)))
            remaining = (ssl.cert_time_to_seconds(cert['notAfter']) - time.time()) / 86400
            metrics['certificate_days_remaining'] = round(remaining, 2)
            if remaining <= 30:
                findings.append(dict(signal='certificate', code='CERTIFICATE_EXPIRES_' + ('7D' if remaining <= 7 else '14D' if remaining <= 14 else '30D'),
                                     severity='critical' if remaining <= 7 else 'warning'))
        except (GateError, OSError, ValueError, KeyError):
            findings.append(dict(signal='certificate', code='CERTIFICATE_UNREADABLE', severity='critical'))
        metrics['reboot_required'] = Path('/var/run/reboot-required').exists()
        if metrics['reboot_required']:
            findings.append(dict(signal='maintenance', code='REBOOT_REQUIRED_NOT_AUTHORIZED', severity='warning'))
    return dict(sampled_at=stamp(), read_only=True, profile=config['profile'],
                stateful_change_ready=config['profile'] == 'production' and not any(item['severity'] == 'critical' for item in findings),
                findings=findings, metrics=metrics,
                limitations=['component storage checks are not application readiness',
                    'exporter/alert-sink records attest separately verified dependencies; this tool does not implement or contact them',
                    'fixture profile never authorizes production stateful changes'])


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['preflight', 'backup', 'fetch', 'verify', 'monitor', '_verify'])
    parser.add_argument('--config', required=True)
    parser.add_argument('--execute', action='store_true', help='Explicitly permit local bundle/restore writes; never stops writers')
    parser.add_argument('--bundle')
    parser.add_argument('--bundle-id')
    parser.add_argument('--target')
    parser.add_argument('--expect-sha256')
    parser.add_argument('--key-home', help='Independent private GPG home on isolated recovery host only')
    parser.add_argument('--fixture', action='store_true', help='Only temporary fake-data configuration; never production drill evidence')
    args = parser.parse_args(argv)
    try:
        config = load_config(args.config)
        if args.action == '_verify':
            require(args.execute and os.environ.get('CHISA_RESTORE_PARENT_NETNS') and
                    os.readlink('/proc/self/ns/net') != os.environ['CHISA_RESTORE_PARENT_NETNS'], 'RESTORE_NAMESPACE_NOT_NEW')
            command(['mount', '--make-rprivate', '/'])
            command(['mount', '-t', 'tmpfs', '-o', 'mode=0755,nosuid,nodev,noexec', 'tmpfs', '/run'])
            result = restore_bundle(config, args.bundle, args.target, args.expect_sha256, args.key_home)
        elif args.action == 'monitor':
            result = monitor(config)
        elif args.action == 'fetch':
            if args.execute:
                result = offsite_fetch(config, args.bundle_id, args.target, args.expect_sha256)
            else:
                result = dict(dry_run=True, action='fetch', writes_performed=False,
                    requirements=['--execute', '--bundle-id', '--target (new file under restore_root)',
                                  '--expect-sha256 (independent receipt)', 'remote COMMITTED.json'])
        elif args.action == 'verify':
            if args.execute:
                require(args.key_home and args.expect_sha256 and args.target and args.bundle, 'VERIFY_ARGUMENTS_MISSING')
            if not args.execute:
                result = dict(dry_run=True, action='verify', writes_performed=False,
                    requirements=['--execute', '--bundle', '--target (new isolated directory)', '--expect-sha256 (independent receipt)',
                        '--key-home (independent private keyring)', 'Linux network+mount namespace; no Docker socket'],
                    production_drill_passed=False)
            elif args.fixture:
                result = restore_bundle(config, args.bundle, args.target, args.expect_sha256, args.key_home, fixture=True)
            else:
                result = verify_isolated(args.config, config, args)
        else:
            result = run_checks(config)
            if args.action == 'backup' and args.execute:
                result = create_bundle(config)
            else:
                result.update(dry_run=args.action == 'backup', action=args.action, writes_performed=False)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        if result.get('ready_to_backup') is False or result.get('stateful_change_ready') is False:
            return 2
        return 0
    except (GateError, OSError, ValueError, KeyError, TypeError, tarfile.TarError) as exc:
        # Never print exception text/traceback: external contents and credentials are untrusted.
        code = exc.code if isinstance(exc, GateError) else type(exc).__name__.upper()
        print(json.dumps(dict(ok=False, code=code, action=args.action, production_drill_passed=False)))
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
