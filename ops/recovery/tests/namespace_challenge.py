#!/usr/bin/env python3
"""TEST ONLY: real namespaces and fake-data restore; never production G1.

Run as root in an isolated Linux/WSL test distro. All inputs/keys are generated
under tempfile; no production config, secret, Docker or offsite endpoint is used.
This is deliberately separate from unittest so a skipped namespace test cannot
be counted as acceptance. Evidence output directories must already exist.
"""
from __future__ import annotations

import argparse
import contextlib
import errno
import fcntl
import http.client
import http.server
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import stat
import struct
import subprocess
import sys
import threading
import time
import traceback

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve()
spec = importlib.util.spec_from_file_location('recovery_fixture_tests', HERE.with_name('test_recovery.py'))
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)
recovery = fixtures.recovery


class Tee:
    def __init__(self, *streams):
        self.streams = streams

    def write(self, text):
        for stream in self.streams:
            stream.write(text)
            stream.flush()
        return len(text)

    def flush(self):
        for stream in self.streams:
            stream.flush()


def namespaces():
    return {name: os.readlink('/proc/self/ns/' + name) for name in ['net', 'mnt', 'pid']}


def run(argv, environment=None):
    completed = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               text=True, timeout=120, env=environment)
    print(json.dumps(dict(command=argv, exit_code=completed.returncode,
                         stdout=completed.stdout, stderr=completed.stderr)), flush=True)
    assert completed.returncode == 0, 'test-only subprocess failed'
    return json.loads(completed.stdout)


def no_egress():
    results = []
    for family, address in [(socket.AF_INET, ('192.0.2.1', 443)),
                             (socket.AF_INET6, ('2001:db8::1', 443, 0, 0))]:
        with socket.socket(family, socket.SOCK_STREAM) as stream:
            stream.settimeout(0.3)
            try:
                stream.connect(address)
            except OSError as exc:
                assert exc.errno in {errno.ENETUNREACH, errno.EHOSTUNREACH, errno.ENETDOWN,
                                     errno.EADDRNOTAVAIL}, 'expected kernel no-route refusal'
                results.append(dict(family='ipv4' if family == socket.AF_INET else 'ipv6',
                                    refused=True, errno=exc.errno, error=errno.errorcode[exc.errno]))
            else:
                raise AssertionError('isolated namespace unexpectedly reached an external address')
    return results


def fake_business(target, manifest):
    """Trusted test harness operations, never execute restored code or providers."""
    payload = target / 'payload'
    summary = recovery.sqlite_summary(payload / '_sqlite/database.sqlite')
    assert summary['counts'] == {'projects': 1, 'sessions': 1, 'users': 1}
    with contextlib.closing(fixtures.sqlite3.connect(payload / '_sqlite/database.sqlite')) as connection:
        relations = connection.execute('SELECT s.id,p.id,u.id FROM sessions s JOIN projects p ON s.project=p.id JOIN users u ON p.owner=u.id').fetchall()
        assert relations == [(11, 7, 1)]
    assert (payload / 'workspace/.git/objects/fixture-object').read_bytes() == b'fake-git-object'
    assert (payload / 'home/.cloudcli/assets/image.bin').read_bytes() == b'fake-png-content'
    assert recovery.jread(payload / 'home/.chisa-workspace-runtime/owner.json')['generation'] == 7
    assert (payload / 'home/.ssh/known_hosts').read_text() == 'test trust data'
    assert (payload / 'configuration/compose.json').read_text() == '{"image":"fake-image"}'
    assert (payload / 'secrets/runtime.env').is_file()
    assert not (payload / 'secrets/DO_NOT_BACK_UP.tmp').exists()
    modes = []
    for entry in manifest['entries']:
        path = target / entry['archive']
        if entry['kind'] != 'symlink':
            assert stat.S_IMODE(path.stat().st_mode) == entry['mode'] & 0o777
            modes.append(True)
    fixed_shell = subprocess.run([sys.executable, '-B', '-c',
        'from pathlib import Path; import sys; p=Path(sys.argv[1]); assert (p/"project.txt").read_text()=="fake-project-generation-7"; (p/"test-only-shell.txt").write_text("fixture-shell-ok")',
        str(payload / 'workspace')], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=5)
    assert fixed_shell.returncode == 0 and not fixed_shell.stdout and not fixed_shell.stderr
    assert (payload / 'workspace/test-only-shell.txt').read_text() == 'fixture-shell-ok'
    # Raise only this fresh namespace's loopback, using a fixed interface ioctl.
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as control:
        current = fcntl.ioctl(control.fileno(), 0x8913, struct.pack('16sH14s', b'lo', 0, b''))
        flags = struct.unpack('16sH14s', current)[1]
        fcntl.ioctl(control.fileno(), 0x8914, struct.pack('16sH14s', b'lo', flags | 1, b''))
    token = 'test-only-preview-token'
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            if self.headers.get('Authorization') != 'Bearer ' + token:
                self.send_response(403)
                self.end_headers()
                return
            self.send_response(200)
            self.end_headers()
            self.wfile.write((payload / 'workspace/project.txt').read_bytes())

        def log_message(self, *args):
            pass
    server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
    port = server.server_port
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with contextlib.closing(http.client.HTTPConnection('127.0.0.1', port, timeout=2)) as client:
            client.request('GET', '/fixture-preview')
            response = client.getresponse()
            assert response.status == 403
            response.read()
            client.request('GET', '/fixture-preview', headers={'Authorization': 'Bearer ' + token})
            response = client.getresponse()
            assert response.status == 200 and response.read() == b'fake-project-generation-7'
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
    with socket.socket() as stream:
        assert stream.connect_ex(('127.0.0.1', port)) != 0
    crashed = subprocess.run([sys.executable, '-B', '-c', 'import os; os._exit(7)'],
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5)
    assert crashed.returncode == 7
    assert recovery.sqlite_summary(payload / '_sqlite/database.sqlite')['integrity'] == 'ok'
    return dict(sqlite_relations_match=True, git_object=True, attachment=True, lease_generation=True,
                ssh_trust=True, configuration=True, fake_secret_file_restored=True,
                transient_excluded=True, permission_bits_verified=len(modes), trusted_fake_shell=True,
                local_preview_authorization_and_cancel=True, fake_child_crash_and_sqlite_recheck=True,
                real_application_smoke=False, provider_execution=False)


def namespace_child(request_path):
    request = recovery.jread(request_path)
    before = namespaces()
    assert all(before[name] != request['parent_namespaces'][name] for name in before)
    assert os.getpid() == 1
    pids_before = sorted(int(path.name) for path in Path('/proc').iterdir() if path.name.isdigit())
    assert pids_before == [1], 'private proc must initially expose only namespace init'
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        status = recovery.main(['_verify', '--execute', '--config', request['config'],
            '--bundle', request['bundle'], '--target', request['target'],
            '--expect-sha256', request['ciphertext_sha256'], '--key-home', request['key_home']])
    verification = json.loads(output.getvalue())
    assert status == 0 and verification['profile'] == 'fixture'
    assert verification['production_drill_passed'] is False
    assert verification['isolation']['production_isolation_proven'] is False
    assert not Path('/run/docker.sock').exists() and not Path('/run/containerd/containerd.sock').exists()
    isolation = recovery.isolated()
    egress_before = no_egress()
    target = Path(request['target'])
    business = fake_business(target, recovery.jread(target / 'manifest.private.json'))
    recovery.isolated()
    egress_after = no_egress()
    result = dict(test_only=True, production_drill_passed=False, production_offsite=False,
        parent_namespaces=request['parent_namespaces'], child_namespaces=before,
        namespace_pid=os.getpid(), proc_visible_pids_before_restore=pids_before,
        proc_visible_processes_after=[dict(pid=int(path.name), comm=(path / 'comm').read_text().strip())
            for path in Path('/proc').iterdir() if path.name.isdigit()],
        interfaces=[name for _, name in socket.if_nameindex()],
        ipv4_routes=Path('/proc/net/route').read_text().splitlines()[1:],
        ipv6_routes=Path('/proc/net/ipv6_route').read_text().splitlines(),
        run_mount=[line for line in Path('/proc/self/mountinfo').read_text().splitlines() if line.split()[4] == '/run'],
        isolation=isolation, no_egress_before=egress_before, no_egress_after=egress_after,
        verification=verification, fake_business=business, exit_code=0)
    recovery.atomic_json(Path(request['child_result']), result)
    print(json.dumps(result, indent=2), flush=True)
    return 0


def exercise():
    assert sys.platform == 'linux' and os.geteuid() == 0, 'root Linux test distro required'
    started = time.monotonic()
    parent_namespaces = namespaces()
    run_mount_before = [line for line in Path('/proc/self/mountinfo').read_text().splitlines() if line.split()[4] == '/run']
    source_hashes = {str(path.relative_to(HERE.parents[3])): recovery.sha(path) for path in
                     [HERE, HERE.with_name('test_recovery.py'), HERE.parents[1] / 'recovery.py']}
    fixtures.RecoveryTests.setUpClass()
    try:
        case = fixtures.RecoveryTests('test_real_gpg_backup_restore_scope_and_secret_exclusion')
        case.setUp()
        os.chmod(case.workspace / 'project.txt', 0o640)
        os.chmod(case.secret_dir / 'runtime.env', 0o600)
        receipt, bundle = case.backup()
        assert receipt['offsite']['production_offsite'] is False
        fetched = case.config['restore_base'] / 'fetched/bundle.tar.gpg'
        fetch = recovery.offsite_fetch(case.config, receipt['bundle_id'], fetched, receipt['ciphertext_sha256'])
        assert recovery.sha(bundle) == recovery.sha(fetched)
        # Stop only the newly generated fixture agent; restore starts one in its private PID namespace.
        gpgconf = str(Path(case.gpg).with_name('gpgconf'))
        for home in [case.private_home, case.public_home]:
            completed = subprocess.run([gpgconf, '--homedir', str(home), '--kill', 'gpg-agent'],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=10)
            assert completed.returncode == 0
        cli_verify = run([sys.executable, '-B', str(HERE.parents[1] / 'recovery.py'), 'verify',
            '--execute', '--config', str(case.config_path), '--bundle', str(fetched),
            '--target', str(case.config['restore_base'] / 'cli-verify'),
            '--expect-sha256', receipt['ciphertext_sha256'], '--key-home', str(case.private_home)])
        request = dict(parent_namespaces=parent_namespaces, config=str(case.config_path),
            bundle=str(fetched), target=str(case.config['restore_base'] / 'namespace-business'),
            ciphertext_sha256=receipt['ciphertext_sha256'], key_home=str(case.private_home),
            child_result=str(case.case / 'namespace-child-result.json'))
        request_path = case.case / 'namespace-request.json'
        recovery.atomic_json(request_path, request)
        environment = dict(PATH='/usr/sbin:/usr/bin:/sbin:/bin', LANG='C.UTF-8',
                           CHISA_RESTORE_PARENT_NETNS=parent_namespaces['net'])
        child = run(['unshare', '--net', '--mount', '--pid', '--fork', '--mount-proc',
            sys.executable, '-B', str(HERE), '--namespace-child', str(request_path)], environment)
        assert namespaces() == parent_namespaces
        run_mount_after = [line for line in Path('/proc/self/mountinfo').read_text().splitlines() if line.split()[4] == '/run']
        assert run_mount_before == run_mount_after
        # Retain a concrete CLI monitor failure with all other observations healthy.
        monitor_case = fixtures.RecoveryTests('test_monitor_missing_exporter_and_alert_sink_are_explicit_cli_failures')
        monitor_case.setUp()
        with monitor_case.healthy_monitor_fixture() as config:
            config['monitor'].pop('exporter')
            config['monitor'].pop('alert_sink')
            captured = io.StringIO()
            with fixtures.mock.patch.object(recovery, 'load_config', return_value=config), contextlib.redirect_stdout(captured):
                monitor_exit = recovery.main(['monitor', '--config', str(monitor_case.config_path)])
            monitor = json.loads(captured.getvalue())
            assert monitor_exit == 2 and monitor['stateful_change_ready'] is False
            print(json.dumps(dict(scenario='test-only healthy fake observations except missing exporter/alert sink',
                                  exit_code=monitor_exit, stdout=monitor), indent=2), flush=True)
        return dict(sampled_at=recovery.stamp(), test_only=True, python=sys.version.split()[0], euid=os.geteuid(),
            source_sha256=source_hashes, fixture_root_was_os_temp=True, all_fixture_files_removed_on_exit=True,
            scope_roles=sorted({item['role'] for item in case.config['coverage']}),
            receipt=receipt, fetch=fetch, cli_verify=cli_verify, namespace_challenge=child,
            w16_missing_dependency_exit=monitor_exit, w16_missing_dependency_report=monitor,
            parent_namespaces_unchanged=True, parent_run_mount_unchanged=True,
            elapsed_seconds=round(time.monotonic()-started, 3), exit_code=0,
            production_state_changed=False, production_drill_passed=False, production_offsite=False,
            remaining_g1=['real independent offsite endpoint/hostkey/retention',
                'public key and off-source private key custody/decrypt evidence',
                'second admin/sudo/console', 'real exporter and independently confirmed alert target',
                'coordinated production writer fence and real full-scope off-host recovery/business/RPO/RTO'])
    finally:
        fixtures.RecoveryTests.tearDownClass()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--namespace-child')
    parser.add_argument('--log')
    parser.add_argument('--result')
    args = parser.parse_args()
    if args.namespace_child:
        return namespace_child(args.namespace_child)
    assert args.log and args.result, '--log and --result required'
    log_path, result_path = Path(args.log), Path(args.result)
    assert log_path.parent.is_dir() and result_path.parent.is_dir()
    with log_path.open('w', encoding='utf-8') as log:
        with contextlib.redirect_stdout(Tee(sys.stdout, log)), contextlib.redirect_stderr(Tee(sys.stderr, log)):
            try:
                result = exercise()
            except BaseException as exc:
                traceback.print_exc()
                result = dict(test_only=True, ok=False, code=type(exc).__name__, exit_code=1,
                              production_state_changed=False, production_drill_passed=False)
            print(json.dumps(result, indent=2), flush=True)
    result_path.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    return result['exit_code']


if __name__ == '__main__':
    raise SystemExit(main())
