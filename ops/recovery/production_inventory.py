"""Read-only metadata probe. Run via strict SSH stdin; never emit env/secret/user content.

Only fixed deployment paths, aggregate counts, public unit/container metadata and
hashes of non-secret unit/compose files leave the host. No provider/API task runs.
"""
import datetime
import hashlib
import json
import os
import pathlib
import shutil
import stat
import subprocess

BASE = pathlib.Path('/opt/chisacloudcode')


def run(argv, timeout=20):
    try:
        value = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
        return value.returncode, value.stdout
    except (OSError, subprocess.SubprocessError) as exc:
        return -1, type(exc).__name__


def meta(path):
    try:
        value = pathlib.Path(path).lstat()
        return dict(present=True, type=('symlink' if stat.S_ISLNK(value.st_mode) else
                    'directory' if stat.S_ISDIR(value.st_mode) else 'file'),
                    mode=oct(stat.S_IMODE(value.st_mode)), uid=value.st_uid,
                    gid=value.st_gid, bytes=value.st_size, device=value.st_dev,
                    nlink=value.st_nlink, mtime_utc=datetime.datetime.fromtimestamp(
                        value.st_mtime, datetime.timezone.utc).isoformat())
    except OSError as exc:
        return dict(present=False, error=type(exc).__name__)


def aggregate(path):
    """One level only; no user-provided names or file content in the output."""
    totals = dict(entries=0, files=0, directories=0, symlinks=0, apparent_file_bytes=0)
    try:
        for entry in os.scandir(path):
            info = entry.stat(follow_symlinks=False)
            totals['entries'] += 1
            if stat.S_ISLNK(info.st_mode):
                totals['symlinks'] += 1
            elif stat.S_ISDIR(info.st_mode):
                totals['directories'] += 1
            elif stat.S_ISREG(info.st_mode):
                totals['files'] += 1
                totals['apparent_file_bytes'] += info.st_size
        return totals
    except OSError as exc:
        return dict(error=type(exc).__name__)


def main():
    result = dict(sampled_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                  scope='read-only metadata; no secret values or real user contents')
    rc, units = run(['systemctl', 'show', 'chisa-workspace-api.service',
        'chisa-workspace-sync.service', 'opt-chisacloudcode-workspaces.mount',
        'docker.service', '-p', 'Id,ActiveState,SubState,MainPID,NRestarts,Restart,UnitFileState,Requires,After,BindsTo,FragmentPath'])
    result['units'] = dict(exit=rc, metadata=units if rc == 0 else None)
    rc, raw = run(['docker', 'ps', '-aq', '--no-trunc'])
    result['docker_list_exit'] = rc
    result['containers'] = []
    effective_jwt = None
    if rc == 0:
        for identity in raw.split():
            code, output = run(['docker', 'inspect', identity])
            if code != 0:
                result['containers'].append(dict(inspect_exit=code))
                continue
            item = json.loads(output)[0]
            mounts = item.get('Mounts', [])
            own = (item.get('Name', '').startswith('/chisa') or any(
                m.get('Source', '').startswith(str(BASE)) for m in mounts))
            if not own:
                continue
            cfg = item.get('Config', {})
            env = dict(v.split('=', 1) for v in cfg.get('Env', []) if '=' in v)
            if item.get('Name') == '/chisacloudcode-api':
                effective_jwt = env.get('JWT_SECRET')
            host = item.get('HostConfig', {})
            state = item.get('State', {})
            result['containers'].append(dict(id=item.get('Id'), name=item.get('Name'),
                image_id=item.get('Image'), configured_user=cfg.get('User'),
                status=state.get('Status'), pid=state.get('Pid'),
                started_at=state.get('StartedAt'), restart_count=item.get('RestartCount'),
                oom_killed=state.get('OOMKilled'), network_mode=host.get('NetworkMode'),
                restart_policy=host.get('RestartPolicy'), log_config=host.get('LogConfig'),
                mounts=[dict(type=m.get('Type'), source=m.get('Source'),
                    destination=m.get('Destination'), rw=m.get('RW')) for m in mounts],
                runtime_paths={k: env.get(k) for k in ['HOME', 'DATABASE_PATH', 'WORKSPACES_ROOT']},
                effective_jwt_source=('environment' if env.get('JWT_SECRET') else
                                      'database-fallback-not-inspected'),
                api_key_present=bool(env.get('API_KEY'))))
    paths = [BASE / p for p in ['data', 'data/auth.db', 'data/auth.db-wal',
        'data/auth.db-shm', 'home', 'home/.cloudcli', 'home/.cloudcli/assets',
        'home/.chisa-workspace-runtime', 'workspaces', 'backups', 'deploy',
        'deploy/.env', 'secrets', 'storage-50g-20261015/workspaces.img']]
    paths += [pathlib.Path('/root/.ssh/known_hosts'), pathlib.Path('/etc/letsencrypt')]
    result['path_metadata'] = {str(path): meta(path) for path in paths}
    result['aggregate_one_level'] = {str(BASE / p): aggregate(BASE / p) for p in [
        'data', 'home/.cloudcli/assets', 'home/.chisa-workspace-runtime', 'workspaces']}
    result['manual_database_backups'] = []
    try:
        for entry in (BASE / 'data').iterdir():
            if entry.name.startswith('auth.db.bak') and entry.is_file():
                result['manual_database_backups'].append(meta(entry))
        result['manual_database_backups'].sort(key=lambda value: value.get('mtime_utc', ''))
    except OSError as exc:
        result['manual_database_backups_error'] = type(exc).__name__
    result['effective_secret_source_candidates'] = []
    try:
        for entry in (BASE / 'secrets').iterdir():
            if not entry.is_file() or entry.stat().st_size > 1024 * 1024:
                continue
            # Content examined only to classify source, never returned or hashed.
            text = entry.read_text(errors='replace')
            result['effective_secret_source_candidates'].append(dict(
                jwt_assignment_present=bool(__import__('re').search(r'^\s*JWT_SECRET\s*=', text, __import__('re').M)),
                metadata=meta(entry)))
    except OSError as exc:
        result['secret_source_scan_error'] = type(exc).__name__
    result['effective_jwt_file_equality'] = []
    candidates = [BASE / 'secrets/runtime.env', BASE / 'secrets/jwt-secret', BASE / 'secrets/jwt.secret',
                  BASE / 'secrets/jwt_secret', BASE / 'deploy/.env']
    try:
        candidates.extend(entry for entry in (BASE / 'deploy').iterdir()
                          if entry.is_file() and (entry.suffix == '.env' or entry.name.startswith('.env')))
        candidates.extend(entry for entry in (BASE / 'secrets').iterdir() if entry.is_file())
    except OSError:
        pass
    import hmac
    for candidate in sorted(set(candidates)):
        try:
            if not candidate.is_file() or candidate.stat().st_size > 1024 * 1024:
                continue
            text = candidate.read_text(errors='replace')
            values = [line.split('=', 1)[1].strip().strip('\"\'') for line in text.splitlines()
                      if line.strip().startswith('JWT_SECRET=')]
            matches = bool(effective_jwt) and (any(hmac.compare_digest(value, effective_jwt) for value in values)
                       or hmac.compare_digest(text.strip(), effective_jwt))
            if matches:
                result['effective_jwt_file_equality'].append(dict(path=str(candidate), effective_value_matches=True))
        except OSError:
            continue
    result['backups'] = []
    try:
        for entry in (BASE / 'backups').iterdir():
            value = meta(entry)
            # Backup name deliberately omitted. Entries sorted only for reproducibility.
            result['backups'].append(value)
        result['backups'].sort(key=lambda value: value.get('mtime_utc', ''))
    except OSError as exc:
        result['backups_error'] = type(exc).__name__
    rc, raw = run(['findmnt', '--json', '--target', str(BASE / 'workspaces'),
                  '--output', 'TARGET,SOURCE,FSTYPE,OPTIONS,UUID,FSROOT,MAJ:MIN'])
    result['workspace_mount'] = dict(exit=rc, data=json.loads(raw) if rc == 0 else None)
    rc, raw = run(['losetup', '--json', '--output', 'NAME,BACK-FILE,AUTOCLEAR'])
    if rc == 0:
        loops = json.loads(raw).get('loopdevices', [])
        result['workspace_loops'] = [row for row in loops if str(row.get('back-file', '')).startswith(str(BASE))]
    else:
        result['losetup_exit'] = rc
    result['tools'] = {name: shutil.which(name) for name in [
        'python3', 'sqlite3', 'tar', 'age', 'restic', 'borg', 'rclone', 'gpg',
        'openssl', 'ssh', 'systemctl', 'findmnt', 'losetup', 'unshare', 'ip', 'lsof', 'fuser']}
    result['nonsecret_config_sha256'] = {}
    for path in ['/etc/systemd/system/chisa-workspace-api.service',
                 '/etc/systemd/system/chisa-workspace-sync.service',
                 '/etc/systemd/system/opt-chisacloudcode-workspaces.mount',
                 str(BASE / 'deploy/compose.yaml')]:
        try:
            result['nonsecret_config_sha256'][path] = hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()
        except OSError as exc:
            result['nonsecret_config_sha256'][path] = dict(error=type(exc).__name__)
    result['backup_schedule_candidates'] = []
    for folder in ['/etc/cron.d', '/etc/cron.daily', '/etc/systemd/system', str(BASE / 'deploy')]:
        try:
            for entry in pathlib.Path(folder).iterdir():
                if entry.is_file() and entry.stat().st_size < 200000:
                    import re
                    if re.search(r'chisa.*(backup|restic|borg|rclone)|(backup|restic|borg|rclone).*chisa',
                                 entry.read_text(errors='replace'), re.I):
                        result['backup_schedule_candidates'].append(str(entry))
        except OSError:
            pass
    result['capacity'] = {}
    for path in ['/', str(BASE / 'workspaces'), str(BASE / 'backups')]:
        try:
            disk = shutil.disk_usage(path)
            vfs = os.statvfs(path)
            result['capacity'][path] = dict(total=disk.total, used=disk.used, free=disk.free,
                                           inode_total=vfs.f_files, inode_available=vfs.f_favail)
        except OSError as exc:
            result['capacity'][path] = dict(error=type(exc).__name__)
    rc, timers = run(['systemctl', 'list-timers', '--all', '--no-pager', '--no-legend'])
    result['backup_timers'] = dict(exit=rc, rows=[row for row in timers.splitlines()
        if any(word in row.lower() for word in ['chisa', 'backup', 'restic', 'borg'])])
    result['reboot_required'] = pathlib.Path('/var/run/reboot-required').exists()
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
