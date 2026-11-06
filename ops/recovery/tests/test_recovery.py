"""Deterministic fake-data tests. No network/provider/production access.

Run: python -B -m unittest discover -s ops/recovery/tests -v
Set CHISA_TEST_GPG to an existing GPG executable if not on PATH.
All data and test keys are created in TemporaryDirectory and destroyed at teardown.
"""
import contextlib
import copy
import datetime as dt
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import sqlite3
import stat
import subprocess
import sys
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

sys.dont_write_bytecode = True
MODULE = Path(__file__).resolve().parents[1] / 'recovery.py'
spec = importlib.util.spec_from_file_location('chisa_recovery', MODULE)
recovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recovery)


class RecoveryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sandbox = tempfile.TemporaryDirectory(prefix='chisa-recovery-tests-')
        cls.root = Path(cls.sandbox.name)
        cls.gpg = os.environ.get('CHISA_TEST_GPG') or shutil.which('gpg')
        if not cls.gpg:
            raise RuntimeError('GPG required for real encryption tests; set CHISA_TEST_GPG')
        cls.private_home = cls.root / 'private-key-home'
        cls.private_home.mkdir(mode=0o700)
        cls.public_home = cls.root / 'public-key-home'
        cls.public_home.mkdir(mode=0o700)
        key_request = '\n'.join(['Key-Type: RSA', 'Key-Length: 2048', 'Key-Usage: encrypt',
            'Name-Real: Recovery Fixture Only', 'Name-Email: fixture@invalid.example',
            'Expire-Date: 1d', '%no-protection', '%commit', ''])
        cls.run_gpg(cls.private_home, ['--generate-key'], key_request.encode())
        listing = cls.run_gpg(cls.private_home, ['--with-colons', '--list-keys']).decode()
        cls.fingerprint = next(line.split(':')[9] for line in listing.splitlines() if line.startswith('fpr:'))
        exported = cls.run_gpg(cls.private_home, ['--export', cls.fingerprint])
        cls.run_gpg(cls.public_home, ['--import'], exported)
        # Create a fully initialized public keyring before read-only preflight.
        cls.run_gpg(cls.public_home, ['--list-keys'])

    @classmethod
    def run_gpg(cls, home, args, data=None):
        output = subprocess.run([cls.gpg, '--no-options', '--homedir', recovery.gpg_path(cls.gpg, home), '--batch', '--no-tty', *args],
            input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
        if output.returncode:
            raise RuntimeError('fixture GPG command failed (output deliberately not logged)')
        return output.stdout

    @classmethod
    def tearDownClass(cls):
        # gpg-agent may hold sockets in temp; terminate only these fixture homes.
        binary = str(Path(cls.gpg).with_name('gpgconf.exe' if os.name == 'nt' else 'gpgconf'))
        if Path(binary).exists():
            for home in [cls.private_home, cls.public_home]:
                subprocess.run([binary, '--homedir', recovery.gpg_path(cls.gpg, home), '--kill', 'gpg-agent'],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
        cls.sandbox.cleanup()

    def setUp(self):
        self.case = self.root / self._testMethodName
        self.case.mkdir(mode=0o700)
        self.workspace = self.case / 'workspace'
        self.home = self.case / 'home'
        self.data = self.case / 'data'
        self.config_dir = self.case / 'configuration'
        self.secret_dir = self.case / 'secrets'
        for path in [self.workspace, self.home, self.data, self.config_dir, self.secret_dir]:
            path.mkdir(mode=0o700)
        (self.home / '.chisa-workspace-runtime').mkdir(mode=0o700)
        (self.home / '.chisa-workspace-runtime/owner.json').write_text('{"generation":7,"owner":"fake-user"}')
        (self.home / '.cloudcli/assets').mkdir(parents=True)
        (self.home / '.cloudcli/assets/image.bin').write_bytes(b'fake-png-content')
        (self.home / '.ssh').mkdir(mode=0o700)
        (self.home / '.ssh/known_hosts').write_text('test trust data')
        (self.workspace / '.git/objects').mkdir(parents=True)
        (self.workspace / '.git/objects/fixture-object').write_bytes(b'fake-git-object')
        (self.workspace / 'project.txt').write_text('fake-project-generation-7')
        (self.config_dir / 'compose.json').write_text('{"image":"fake-image"}')
        (self.secret_dir / 'runtime.env').write_text('JWT_SECRET=fixture-secret-canary-not-real\n')
        (self.secret_dir / 'DO_NOT_BACK_UP.tmp').write_text('excluded-canary')
        self.database = self.data / 'auth.db'
        with contextlib.closing(sqlite3.connect(self.database)) as connection:
            connection.executescript('''
                PRAGMA foreign_keys=ON;
                PRAGMA user_version=7;
                CREATE TABLE users(id INTEGER PRIMARY KEY);
                CREATE TABLE projects(id INTEGER PRIMARY KEY, owner INTEGER REFERENCES users(id));
                CREATE TABLE sessions(id INTEGER PRIMARY KEY, project INTEGER REFERENCES projects(id));
                INSERT INTO users VALUES(1);
                INSERT INTO projects VALUES(7,1);
                INSERT INTO sessions VALUES(11,7);
            ''')
        self.config_path = self.case / 'config.json'
        sources = [dict(id='workspace', path=str(self.workspace), sensitive=True),
            dict(id='home', path=str(self.home), sensitive=True),
            dict(id='data', path=str(self.data), sensitive=True),
            dict(id='configuration', path=str(self.config_dir), sensitive=True),
            dict(id='secrets', path=str(self.secret_dir), sensitive=True,
                 exclude=[dict(glob='*.tmp', reason='fixture transient canary not needed for recovery')])]
        coverage = [dict(role='workspace', path=str(self.workspace), source='workspace'),
            dict(role='home', path=str(self.home), source='home'),
            dict(role='leases', path=str(self.home / '.chisa-workspace-runtime'), source='home'),
            dict(role='attachments', path=str(self.home / '.cloudcli/assets'), source='home'),
            dict(role='configuration', path=str(self.config_dir), source='configuration'),
            dict(role='secrets', path=str(self.secret_dir), source='secrets'),
            dict(role='ssh_trust', path=str(self.home / '.ssh'), source='home')]
        self.raw = dict(version=1, profile='fixture', fixture_root=str(self.root),
            sources=sources, coverage=coverage, database=dict(path=str(self.database)),
            spool=str(self.case / 'spool'), restore_root=str(self.case / 'restore'),
            reserve_bytes=0, fixture_writers=[],
            encryption=dict(gpg=self.gpg, public_key_home=str(self.public_home), recipient_fingerprint=self.fingerprint),
            offsite=dict(transport='fixture-copy', directory=str(self.case / 'offsite')),
            monitor=dict(rpo_seconds=3600, verified_drill_record=str(self.case / 'missing-production-drill.json')))
        self.save()

    def save(self):
        self.config_path.write_text(json.dumps(self.raw), encoding='utf-8')
        self.config = recovery.load_config(self.config_path)

    def assert_gate(self, code, function, *args, **kwargs):
        with self.assertRaises(recovery.GateError) as exception:
            function(*args, **kwargs)
        self.assertEqual(exception.exception.code, code)

    def backup(self):
        receipt = recovery.create_bundle(self.config)
        bundle = self.config['spool_path'] / receipt['bundle_id'] / 'bundle.tar.gpg'
        return receipt, bundle

    def restore(self, receipt, bundle, suffix='case'):
        target = self.config['restore_base'] / suffix
        result = recovery.restore_bundle(self.config, bundle, target, receipt['ciphertext_sha256'],
                                          self.private_home, fixture=True)
        return result, target

    def test_default_backup_is_read_only_dry_run(self):
        before = {str(path.relative_to(self.case)): (path.stat().st_size, path.stat().st_mtime_ns)
                  for path in self.case.rglob('*') if path.is_file()}
        captured = io.StringIO()
        with contextlib.redirect_stdout(captured):
            status = recovery.main(['backup', '--config', str(self.config_path)])
        self.assertEqual(status, 0)
        result = json.loads(captured.getvalue())
        self.assertTrue(result['dry_run'])
        self.assertFalse(result['writes_performed'])
        self.assertFalse(self.config['spool_path'].exists())
        after = {str(path.relative_to(self.case)): (path.stat().st_size, path.stat().st_mtime_ns)
                 for path in self.case.rglob('*') if path.is_file()}
        self.assertEqual(before, after)

    def test_real_gpg_backup_restore_scope_and_secret_exclusion(self):
        receipt, bundle = self.backup()
        text = json.dumps(receipt)
        self.assertNotIn('fixture-secret-canary', text)
        self.assertNotIn('runtime.env', text)
        self.assertNotIn('project.txt', text)
        self.assertNotIn('fake-user', text)
        self.assertNotIn(b'fixture-secret-canary', bundle.read_bytes())
        self.assertFalse(list(self.config['spool_path'].glob('.plaintext-*')))
        result, restored = self.restore(receipt, bundle)
        self.assertTrue(result['sqlite_counts_match'])
        self.assertFalse(result['production_drill_passed'])
        self.assertFalse(result['application_smoke_performed'])
        self.assertEqual((restored / 'payload/workspace/project.txt').read_text(), 'fake-project-generation-7')
        self.assertTrue((restored / 'payload/workspace/.git/objects/fixture-object').exists())
        self.assertTrue((restored / 'payload/home/.chisa-workspace-runtime/owner.json').exists())
        self.assertTrue((restored / 'payload/home/.cloudcli/assets/image.bin').exists())
        self.assertTrue((restored / 'payload/home/.ssh/known_hosts').exists())
        self.assertIn('fixture-secret-canary', (restored / 'payload/secrets/runtime.env').read_text())
        self.assertFalse((restored / 'payload/secrets/DO_NOT_BACK_UP.tmp').exists())
        self.assertFalse((restored / 'payload/data/auth.db').exists())
        summary = recovery.sqlite_summary(restored / 'payload/_sqlite/database.sqlite')
        self.assertEqual(summary['counts'], {'projects': 1, 'sessions': 1, 'users': 1})
        self.assertEqual(summary['user_version'], 7)
        offsite = self.case / 'offsite' / receipt['bundle_id'] / 'bundle.tar.gpg'
        self.assertEqual(recovery.sha(bundle), recovery.sha(offsite))

    def test_fetch_requires_committed_offsite_bundle_and_independent_hash(self):
        receipt, bundle = self.backup()
        destination = self.config['restore_base'] / 'download' / 'bundle.tar.gpg'
        result = recovery.offsite_fetch(self.config, receipt['bundle_id'], destination, receipt['ciphertext_sha256'])
        self.assertTrue(result['offsite_commit_verified'])
        self.assertEqual(recovery.sha(bundle), recovery.sha(destination))
        (self.case / 'offsite' / receipt['bundle_id'] / 'COMMITTED.json').unlink()
        self.assert_gate('OFFSITE_COMMIT_MISSING', recovery.offsite_fetch, self.config, receipt['bundle_id'],
                         self.config['restore_base'] / 'download2.gpg', receipt['ciphertext_sha256'])
        self.assertFalse((self.config['restore_base'] / 'download2.gpg').exists())

    def test_sqlite_backup_includes_committed_wal(self):
        connection = sqlite3.connect(self.database)
        connection.execute('PRAGMA journal_mode=WAL')
        connection.execute('INSERT INTO users VALUES(2)')
        connection.commit()
        self.assertTrue(Path(str(self.database) + '-wal').exists())
        try:
            receipt, bundle = self.backup()
            _, restored = self.restore(receipt, bundle)
            self.assertEqual(recovery.sqlite_summary(restored / 'payload/_sqlite/database.sqlite')['counts']['users'], 2)
            self.assertFalse(list((restored / 'payload/data').glob('*-wal')))
        finally:
            connection.close()

    def test_sqlite_api_never_opens_production_source_database(self):
        original = recovery.sqlite3.connect
        opened = []
        def track(database, *args, **kwargs):
            opened.append(str(database))
            return original(database, *args, **kwargs)
        with mock.patch.object(recovery.sqlite3, 'connect', side_effect=track):
            self.backup()
        self.assertTrue(opened)
        self.assertFalse(any(str(self.database.resolve().as_uri()) in value for value in opened))
        self.assertTrue(any('input.sqlite' in value for value in opened))

    def test_active_writer_blocks_execution_and_no_bundle_is_created(self):
        self.raw['fixture_writers'] = ['preview-process']
        self.save()
        report = recovery.run_checks(self.config)
        self.assertFalse(report['ready_to_backup'])
        self.assert_gate('PREFLIGHT_FAILED', recovery.create_bundle, self.config)
        self.assertFalse(self.config['spool_path'].exists())

    def test_missing_required_home_attachment_blocks_preflight(self):
        shutil.rmtree(self.home / '.cloudcli/assets')
        report = recovery.run_checks(self.config)
        self.assertFalse(report['ready_to_backup'])
        self.assertTrue(any(item.get('code') == 'REQUIRED_COVERAGE_MISSING' for item in report['checks']))

    def test_missing_encryption_endpoint_and_invalid_fixture_roots_fail_closed(self):
        self.raw['encryption']['recipient_fingerprint'] = ''
        self.save()
        self.assertFalse(recovery.run_checks(self.config)['ready_to_backup'])
        self.raw['fixture_root'] = str(Path.cwd())
        self.config_path.write_text(json.dumps(self.raw))
        self.assert_gate('FIXTURE_MUST_USE_TEMP_DIRECTORY', recovery.load_config, self.config_path)

    def test_private_recovery_keyring_is_rejected_on_backup_host(self):
        self.raw['encryption']['public_key_home'] = str(self.private_home)
        self.save()
        self.assertFalse(recovery.run_checks(self.config)['ready_to_backup'])
        self.assert_gate('RECOVERY_PRIVATE_KEY_PRESENT_ON_BACKUP_HOST', recovery.encryption_preflight, self.config)

    def test_database_fk_corruption_fails_and_plaintext_is_removed(self):
        with contextlib.closing(sqlite3.connect(self.database)) as connection:
            connection.execute('INSERT INTO projects VALUES(8,999)')
            connection.commit()
        self.assert_gate('SQLITE_FOREIGN_KEY', recovery.create_bundle, self.config)
        self.assertFalse((self.config['spool_path'] / 'latest-success.json').exists())
        self.assertFalse(list(self.config['spool_path'].glob('.plaintext-*')))
        self.assertFalse(recovery.jread(self.config['spool_path'] / 'latest-attempt.json')['ok'])

    def test_mutation_during_snapshot_fails_without_success_receipt(self):
        original = recovery.backup_sqlite
        def change_file(source, destination):
            result = original(source, destination)
            (self.workspace / 'project.txt').write_text('changed-while-snapshotting')
            return result
        with mock.patch.object(recovery, 'backup_sqlite', side_effect=change_file):
            self.assert_gate('SOURCE_INVENTORY_CHANGED', recovery.create_bundle, self.config)
        self.assertFalse((self.config['spool_path'] / 'latest-success.json').exists())
        self.assertFalse(list(self.config['spool_path'].glob('.plaintext-*')))

    def test_git_worktree_and_alternate_objects_must_be_in_covered_sources(self):
        project = self.workspace / 'linked-project'
        project.mkdir()
        outside = self.case / 'external-git-state'
        outside.mkdir()
        (project / '.git').write_text('gitdir: ' + str(outside))
        self.assert_gate('GIT_EXTERNAL_STATE_NOT_COVERED', recovery.create_bundle, self.config)
        internal = self.workspace / '.git/worktrees/linked-project'
        internal.mkdir(parents=True)
        (project / '.git').write_text('gitdir: ../.git/worktrees/linked-project')
        (internal / 'commondir').write_text('../..')
        receipt, _ = self.backup()
        self.assertTrue(receipt['consistent'])
        info = self.workspace / '.git/objects/info'
        info.mkdir()
        (info / 'alternates').write_text(str(outside))
        self.assert_gate('GIT_EXTERNAL_STATE_NOT_COVERED', recovery.create_bundle, self.config)

    def test_transfer_failure_has_no_completed_recovery_point(self):
        with mock.patch.object(recovery, 'offsite_upload', side_effect=recovery.GateError('OFFSITE_READBACK_HASH')):
            self.assert_gate('OFFSITE_READBACK_HASH', recovery.create_bundle, self.config)
        self.assertFalse((self.config['spool_path'] / 'latest-success.json').exists())
        self.assertFalse(list(self.config['spool_path'].glob('.plaintext-*')))

    def test_ciphertext_tamper_wrong_key_and_existing_target_are_rejected(self):
        receipt, bundle = self.backup()
        altered = self.case / 'tampered.gpg'
        altered.write_bytes(bundle.read_bytes() + b'tampered')
        self.assert_gate('CIPHERTEXT_HASH_MISMATCH', recovery.restore_bundle, self.config, altered,
            self.config['restore_base'] / 'tampered', receipt['ciphertext_sha256'], self.private_home, fixture=True)
        self.assert_gate('COMMAND_FAILED', recovery.restore_bundle, self.config, bundle,
            self.config['restore_base'] / 'wrong-key', receipt['ciphertext_sha256'], self.public_home, fixture=True)
        _, target = self.restore(receipt, bundle)
        self.assert_gate('RESTORE_TARGET_ALREADY_EXISTS', recovery.restore_bundle, self.config, bundle,
            target, receipt['ciphertext_sha256'], self.private_home, fixture=True)

    def test_archive_path_traversal_and_external_symlink_are_rejected(self):
        for unsafe in ['../escape', '/absolute', 'payload/a/../../escape', 'payload\\escape', 'payload//a']:
            self.assert_gate('ARCHIVE_PATH_UNSAFE', recovery.rel_ok, unsafe)
        external = self.case / 'outside.txt'
        external.write_text('must-never-be-collected')
        try:
            (self.workspace / 'escape-link').symlink_to(external)
        except OSError:
            # Windows native symlink privileges unavailable: exercise lstat/readlink
            # refusal deterministically on fake file metadata; no real path followed.
            link_path = self.workspace / 'escape-link'
            link_path.write_text('fake-symlink-metadata')
            original = Path.lstat
            def symlink_metadata(path):
                value = original(path)
                if path == link_path:
                    import stat
                    fields = list(value)
                    fields[0] = stat.S_IFLNK | 0o777
                    return os.stat_result(fields)
                return value
            with mock.patch.object(Path, 'lstat', symlink_metadata), mock.patch.object(recovery.os, 'readlink', return_value=str(external)):
                self.assert_gate('EXTERNAL_SYMLINK_UNSUPPORTED', recovery.list_entries, self.config['sources'][0], self.config['db_path'])
        else:
            self.assert_gate('EXTERNAL_SYMLINK_UNSUPPORTED', recovery.create_bundle, self.config)

    def test_restore_production_mode_requires_real_namespace(self):
        receipt, bundle = self.backup()
        code = 'RESTORE_ISOLATION_REQUIRES_LINUX' if sys.platform != 'linux' else 'RESTORE_NETWORK_NOT_ISOLATED'
        self.assert_gate(code, recovery.restore_bundle, self.config, bundle,
            self.config['restore_base'] / 'not-isolated', receipt['ciphertext_sha256'], self.private_home)

    def test_production_restore_keeps_same_host_and_missing_identity_gates(self):
        config = copy.deepcopy(self.config)
        config['profile'] = 'production'
        identity = {'machine_id_sha256': 'test-only-same-host'}
        for index, (source_machine, code) in enumerate([
                (None, 'RESTORE_SOURCE_MACHINE_MISSING'),
                (identity, 'RESTORE_MUST_USE_DIFFERENT_HOST')]):
            with self.subTest(code=code):
                archive = self.case / ('production-gate-' + str(index) + '.tar')
                with tarfile.open(archive, 'w') as tar:
                    raw = json.dumps(dict(version=1, profile='production', source_machine=source_machine)).encode()
                    member = tarfile.TarInfo('manifest.json')
                    member.size = len(raw)
                    tar.addfile(member, io.BytesIO(raw))
                encrypted = archive.with_suffix('.gpg')
                base, recipient = recovery.gpg(self.config)
                recovery.command(base + ['--trust-model', 'always', '--recipient', recipient,
                    '--output', recovery.gpg_path(self.gpg, encrypted), '--encrypt', recovery.gpg_path(self.gpg, archive)])
                target = config['restore_base'] / ('production-gate-' + str(index))
                with mock.patch.object(recovery, 'isolated', return_value={'test_only_unit_isolation_model': True}), \
                        mock.patch.object(recovery, 'machine_identity', return_value=identity):
                    self.assert_gate(code, recovery.restore_bundle, config, encrypted, target,
                                     recovery.sha(encrypted), self.private_home)
                self.assertFalse(target.exists())

    def test_stale_missing_and_fixture_drill_never_mark_gate_ready(self):
        missing = recovery.monitor(self.config)
        self.assertFalse(missing['stateful_change_ready'])
        self.assertTrue(any(item['signal'] == 'backup' for item in missing['findings']))
        receipt, _ = self.backup()
        current = recovery.monitor(self.config)
        self.assertFalse(current['stateful_change_ready'])
        self.assertTrue(any(item['signal'] == 'restore_drill' for item in current['findings']))
        receipt['captured_at'] = (recovery.now() - dt.timedelta(hours=2)).isoformat()
        recovery.atomic_json(self.config['spool_path'] / 'latest-success.json', receipt)
        stale = recovery.monitor(self.config)
        self.assertTrue(any(item['code'] == 'BACKUP_OVER_RPO' for item in stale['findings']))

    @contextlib.contextmanager
    def healthy_monitor_fixture(self, services=None, containers=None):
        """Test-only complete observation records; external commands stay fake."""
        import ssl
        identity = dict(machine_id_sha256='fixture-machine', boot_id='fixture-boot')
        self.config['profile'] = 'production'
        spool = self.config['spool_path']
        spool.mkdir(mode=0o700)
        recovery.atomic_json(spool / 'latest-success.json', dict(captured_at=recovery.stamp(), consistent=True,
            offsite=dict(readback_verified=True, production_offsite=True)))
        recovery.atomic_json(spool / 'latest-attempt.json', dict(ok=True))
        settings = self.config['monitor']
        drill = self.case / 'test-only-drill.json'
        recovery.atomic_json(drill, dict(verified_at=recovery.stamp(), production_drill_passed=True))
        settings['verified_drill_record'] = str(drill)
        settings['certificate_file'] = str(self.case / 'fake-certificate.pem')
        for kind in ['exporter', 'alert_sink']:
            evidence = self.case / (kind + '.json')
            recovery.atomic_json(evidence, dict(version=1, kind=kind, checked_at=recovery.stamp(),
                healthy=True, machine=identity, evidence_reference='fixture-only-no-production-evidence',
                covered_signals=['request_latency', 'authentication', 'websocket', 'lease', 'cleanup'],
                delivery_test_passed=True, independent_receiver_confirmed=True))
            settings[kind] = dict(evidence=str(evidence), sha256=recovery.sha(evidence))
        if services is None:
            services = '\n\n'.join('Id=' + unit + '\nActiveState=active\nSubState=running\nNRestarts=0'
                for unit in ['chisa-workspace-api.service', 'chisa-workspace-sync.service']) + '\n'
        if containers is None:
            containers = [dict(Id='fake-container', Mounts=[dict(Source=str(self.workspace), RW=True)],
                State=dict(Status='running', Running=True, OOMKilled=False, Restarting=False, Dead=False),
                RestartCount=0, HostConfig=dict(LogConfig=dict(Config={'max-size': '10m'})))]
        def fake_command(argv, **kwargs):
            if argv[0] == 'systemctl':
                return services.encode()
            if argv[:3] == ['docker', 'ps', '-aq']:
                return ('\n'.join(item['Id'] for item in containers) + '\n').encode()
            raise AssertionError('unexpected monitor external command')
        def fake_inspect(argv):
            self.assertEqual(argv[:2], ['docker', 'inspect'])
            return [next(item for item in containers if item['Id'] == argv[2])]
        future = (recovery.now() + dt.timedelta(days=60)).strftime('%b %d %H:%M:%S %Y GMT')
        with mock.patch.object(recovery.sys, 'platform', 'linux'), \
                mock.patch.object(recovery, 'mount_identity', return_value={'fixture_only': True}), \
                mock.patch.object(recovery, 'machine_identity', return_value=identity), \
                mock.patch.object(recovery, 'command', side_effect=fake_command), \
                mock.patch.object(recovery, 'json_command', side_effect=fake_inspect), \
                mock.patch.object(recovery.shutil, 'disk_usage', return_value=SimpleNamespace(total=1000000, free=500000, used=500000)), \
                mock.patch.object(ssl._ssl, '_test_decode_cert', return_value={'notAfter': future}):
            yield self.config

    def assert_monitor_cli_blocked(self, config, codes):
        captured = io.StringIO()
        with mock.patch.object(recovery, 'load_config', return_value=config), contextlib.redirect_stdout(captured):
            status = recovery.main(['monitor', '--config', str(self.config_path)])
        report = json.loads(captured.getvalue())
        self.assertEqual(status, 2)
        self.assertFalse(report['stateful_change_ready'])
        self.assertTrue(set(codes) <= {item['code'] for item in report['findings']})

    def test_monitor_missing_exporter_and_alert_sink_are_explicit_cli_failures(self):
        with self.healthy_monitor_fixture() as config:
            baseline = recovery.monitor(config)
            self.assertTrue(baseline['stateful_change_ready'], baseline['findings'])
            for kind in ['exporter', 'alert_sink']:
                saved = config['monitor'].pop(kind)
                self.assert_monitor_cli_blocked(config, ['MONITOR_' + kind.upper() + '_EVIDENCE_REQUIRED'])
                config['monitor'][kind] = saved
            config['monitor'].pop('exporter')
            config['monitor'].pop('alert_sink')
            self.assert_monitor_cli_blocked(config, ['MONITOR_EXPORTER_EVIDENCE_REQUIRED', 'MONITOR_ALERT_SINK_EVIDENCE_REQUIRED'])

    def test_monitor_stale_unhealthy_or_unconfirmed_dependency_cannot_be_green(self):
        with self.healthy_monitor_fixture() as config:
            for kind, changes, code in [
                    ('exporter', {'healthy': False}, 'MONITOR_EXPORTER_NOT_VERIFIED'),
                    ('exporter', {'checked_at': (recovery.now() - dt.timedelta(days=2)).isoformat()}, 'MONITOR_EXPORTER_EVIDENCE_STALE'),
                    ('exporter', {'covered_signals': ['request_latency']}, 'MONITOR_EXPORTER_SIGNALS_MISSING'),
                    ('alert_sink', {'delivery_test_passed': False}, 'MONITOR_ALERT_SINK_DELIVERY_UNVERIFIED'),
                    ('alert_sink', {'independent_receiver_confirmed': False}, 'MONITOR_ALERT_SINK_DELIVERY_UNVERIFIED'),
                    ('alert_sink', {'machine': {'boot_id': 'other'}}, 'MONITOR_ALERT_SINK_HOST_BOOT_MISMATCH')]:
                with self.subTest(code=code):
                    spec = config['monitor'][kind]
                    path = Path(spec['evidence'])
                    original = recovery.jread(path)
                    recovery.atomic_json(path, dict(original, **changes))
                    spec['sha256'] = recovery.sha(path)
                    self.assert_monitor_cli_blocked(config, [code])
                    recovery.atomic_json(path, original)
                    spec['sha256'] = recovery.sha(path)
            config['monitor']['exporter']['sha256'] = '0' * 64
            self.assert_monitor_cli_blocked(config, ['MONITOR_EXPORTER_EVIDENCE_HASH'])

    def test_monitor_failed_or_inactive_systemd_state_cannot_be_green(self):
        for state in ['failed', 'inactive', 'activating']:
            with self.subTest(state=state):
                services = '\n\n'.join('Id=' + unit + '\nActiveState=' + state + '\nSubState=dead\nNRestarts=4'
                    for unit in ['chisa-workspace-api.service', 'chisa-workspace-sync.service'])
                # Each subcase gets fresh fake observation files under its own case directory.
                original_case, original_config = self.case, self.config
                self.case = original_case / state
                self.case.mkdir(mode=0o700)
                self.config = copy.deepcopy(original_config)
                self.config['spool_path'] = self.case / 'spool'
                try:
                    with self.healthy_monitor_fixture(services=services) as config:
                        self.assert_monitor_cli_blocked(config, ['SYSTEMD_SERVICE_NOT_RUNNING'])
                finally:
                    self.case, self.config = original_case, original_config

    def test_monitor_empty_or_partial_service_observation_cannot_be_green(self):
        with self.healthy_monitor_fixture(services='') as config:
            self.assert_monitor_cli_blocked(config, ['SYSTEMD_OBSERVATION_INCOMPLETE'])
        self.assert_gate('SYSTEMD_OBSERVATION_INCOMPLETE', recovery.systemd_observation,
                         'Id=chisa-workspace-api.service\nActiveState=active\nSubState=running\nNRestarts=0\n')

    def test_monitor_empty_container_observation_cannot_be_green(self):
        with self.healthy_monitor_fixture(containers=[]) as config:
            self.assert_monitor_cli_blocked(config, ['DOCKER_OBSERVATION_EMPTY'])

    def test_monitor_low_capacity_still_blocks_with_healthy_dependencies(self):
        with self.healthy_monitor_fixture() as config:
            with mock.patch.object(recovery.shutil, 'disk_usage',
                                   return_value=SimpleNamespace(total=1000000, free=99999, used=900001)):
                self.assert_monitor_cli_blocked(config, ['DISK_LOW'])

    def test_monitor_container_restarting_oom_and_health_fail_closed(self):
        with self.healthy_monitor_fixture() as config:
            for state, code in [
                    (dict(Status='restarting', Restarting=True), 'CONTAINER_NOT_HEALTHY'),
                    (dict(Status='running', Running=True, OOMKilled=True), 'CONTAINER_OOM'),
                    (dict(Status='running', Running=True, Health={'Status': 'unhealthy'}), 'CONTAINER_NOT_HEALTHY'),
                    (dict(Status='paused', Running=True, Paused=True), 'CONTAINER_NOT_HEALTHY'),
                    (dict(Status='running', Running=False), 'CONTAINER_NOT_HEALTHY'),
                    (dict(Status='exited'), 'DOCKER_RELEVANT_RUNNING_CONTAINER_MISSING')]:
                with self.subTest(code=code):
                    container = dict(Id='fake-container', Mounts=[dict(Source=str(self.workspace), RW=True)],
                        State=state, RestartCount=0, HostConfig=dict(LogConfig=dict(Config={'max-size': '10m'})))
                    with mock.patch.object(recovery, 'json_command', return_value=[container]):
                        self.assert_monitor_cli_blocked(config, [code])

    def test_fixture_monitor_never_authorizes_production_stateful_change(self):
        with self.healthy_monitor_fixture() as config:
            config['profile'] = 'fixture'
            self.assertFalse(recovery.monitor(config)['stateful_change_ready'])

    def test_config_overlap_and_excluded_required_state_rejected(self):
        bad = copy.deepcopy(self.raw)
        bad['spool'] = str(self.workspace / 'backups')
        self.config_path.write_text(json.dumps(bad))
        self.assert_gate('OUTPUT_OVERLAPS_SOURCE', recovery.load_config, self.config_path)
        bad = copy.deepcopy(self.raw)
        bad['sources'][1]['exclude'] = [dict(glob='.chisa-workspace-runtime*', reason='invalid exclusion')]
        self.config_path.write_text(json.dumps(bad))
        self.assert_gate('REQUIRED_COVERAGE_EXCLUDED', recovery.load_config, self.config_path)

    def test_hardlinks_fail_closed_instead_of_losing_runtime_identity_contract(self):
        os.link(self.workspace / 'project.txt', self.workspace / 'project-hardlink.txt')
        self.assert_gate('HARDLINK_REQUIRES_REVIEWED_SNAPSHOT', recovery.create_bundle, self.config)
        self.assertFalse((self.config['spool_path'] / 'latest-success.json').exists())

    def test_isolation_checks_current_namespace_interfaces_and_both_ip_families(self):
        original_exists = Path.exists
        def read_routes(path, *args, **kwargs):
            if str(path).endswith('ipv6_route'):
                return '00000000000000000000000000000000 00 00000000000000000000000000000000 00 00000000000000000000000000000000 00000000 00000000 00000000 00000000 lo\n'
            if str(path).endswith('/proc/net/route') or str(path).endswith('proc\\net\\route'):
                return 'Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT\n'
            return ''
        def exists(path):
            return str(path).endswith('ipv6_route')
        with mock.patch.object(recovery.sys, 'platform', 'linux'), mock.patch.object(recovery.socket, 'if_nameindex', return_value=[(1, 'lo')]), mock.patch.object(Path, 'read_text', read_routes), mock.patch.object(Path, 'exists', exists):
            self.assertEqual(recovery.isolated()['network'], 'private-namespace-no-egress')
        with mock.patch.object(recovery.sys, 'platform', 'linux'), mock.patch.object(recovery.socket, 'if_nameindex', return_value=[(1, 'lo'), (2, 'eth0')]):
            self.assert_gate('RESTORE_NETWORK_NOT_ISOLATED', recovery.isolated)

    def test_mount_identity_rejects_uuid_options_and_loop_backing_mismatch(self):
        config = copy.deepcopy(self.config)
        config['profile'] = 'production'
        backing = self.case / 'fake-loop.img'
        backing.write_bytes(b'not-a-real-disk')
        config['mount'] = dict(target=str(self.workspace), uuid='fake-uuid', fstype='ext4',
                               backing_file=str(backing), required_options=['nodev', 'nosuid'])
        row = dict(target=str(self.workspace), source='/dev/loop9', uuid='fake-uuid', fstype='ext4',
                   options='rw,nodev,nosuid', fsroot='/', **{'maj:min': '7:9'})
        loops = {'loopdevices': [{'name': '/dev/loop9', 'back-file': str(backing)}]}
        for key, value, expected in [('uuid', 'wrong', 'MOUNT_UUID_MISMATCH'),
                ('options', 'rw,nosuid', 'MOUNT_OPTIONS_MISSING'), ('target', '/', 'MOUNT_TARGET_MISMATCH')]:
            bad = dict(row)
            bad[key] = value
            with mock.patch.object(recovery, 'json_command', side_effect=[{'filesystems': [bad]}, loops]):
                self.assert_gate(expected, recovery.mount_identity, config)
        wrong = {'loopdevices': [{'name': '/dev/loop9', 'back-file': '/different.img'}]}
        with mock.patch.object(recovery, 'json_command', side_effect=[{'filesystems': [row]}, wrong]):
            self.assert_gate('LOOP_BACKING_MISMATCH', recovery.mount_identity, config)
        with mock.patch.object(recovery, 'json_command', side_effect=[{'filesystems': [row]}, loops]):
            self.assertEqual(recovery.mount_identity(config)['uuid'], 'fake-uuid')

    @contextlib.contextmanager
    def production_fixture_identity(self, fence):
        """Model root+root-owned fence together; retain real mode/link checks.

        Root Linux runs use the real euid and real inode ownership without mocks.
        Nonroot unit runs model only this one inode's owner alongside euid=0;
        every other stat field and every other path still comes from the OS.
        Real ownership rejection is covered separately with a root-only chown.
        """
        if os.name == 'posix' and os.geteuid() == 0:
            self.assertEqual(fence.stat().st_uid, 0)
            yield
            return
        original = Path.stat
        fixture_info = original(fence)
        if os.name == 'posix':
            self.assertEqual(fixture_info.st_uid, os.geteuid())
        def fixture_stat(path, *args, **kwargs):
            info = original(path, *args, **kwargs)
            if path == fence:
                self.assertEqual((info.st_dev, info.st_ino), (fixture_info.st_dev, fixture_info.st_ino))
                fields = list(info)
                fields[4] = 0
                return os.stat_result(fields)
            return info
        with mock.patch.object(recovery.os, 'geteuid', return_value=0, create=True), \
                mock.patch.object(Path, 'stat', fixture_stat):
            yield

    @unittest.skipUnless(os.name == 'posix', 'requires real POSIX permission bits')
    def test_private_path_rejects_real_group_world_modes(self):
        path = self.case / 'private.json'
        path.write_text('fixture-only')
        os.chmod(path, 0o600)
        recovery.private_path(path)
        for mode in [0o640, 0o604, 0o660, 0o606, 0o644]:
            with self.subTest(mode=oct(mode)):
                os.chmod(path, mode)
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), mode)
                self.assert_gate('PRIVATE_PATH_PERMISSION', recovery.private_path, path)
        directory = self.case / 'private-directory'
        directory.mkdir(mode=0o700)
        recovery.private_path(directory)
        os.chmod(directory, 0o750)
        self.assert_gate('PRIVATE_PATH_PERMISSION', recovery.private_path, directory)

    @unittest.skipUnless(os.name == 'posix', 'requires real POSIX symlinks')
    def test_private_path_rejects_real_leaf_and_ancestor_symlinks(self):
        private = self.case / 'private-target'
        private.mkdir(mode=0o700)
        path = private / 'evidence.json'
        path.write_text('fixture-only')
        os.chmod(path, 0o600)
        leaf = self.case / 'private-link.json'
        leaf.symlink_to(path)
        self.assert_gate('PATH_SYMLINK_ANCESTOR', recovery.private_path, leaf)
        parent = self.case / 'directory-link'
        parent.symlink_to(private, target_is_directory=True)
        self.assert_gate('PATH_SYMLINK_ANCESTOR', recovery.private_path, parent / path.name)

    @unittest.skipUnless(os.name == 'posix' and getattr(os, 'geteuid', lambda: -1)() == 0,
                         'real foreign-owner chown requires root; root suite is mandatory')
    def test_private_path_rejects_real_foreign_owner(self):
        path = self.case / 'foreign-owner.json'
        path.write_text('fixture-only')
        os.chmod(path, 0o600)
        os.chown(path, 65534, -1)
        try:
            self.assertEqual(path.stat().st_uid, 65534)
            self.assert_gate('PRIVATE_PATH_PERMISSION', recovery.private_path, path)
        finally:
            os.chown(path, 0, -1)
        recovery.private_path(path)

    def test_production_fence_requires_all_classes_host_boot_mask_and_no_restart(self):
        config = copy.deepcopy(self.config)
        config['profile'] = 'production'
        fence = self.case / 'fence.json'
        config['quiescence'] = dict(evidence=str(fence),
            writer_units=['chisa-workspace-api.service', 'chisa-workspace-sync.service'], writer_timers=[])
        identity = dict(machine_id_sha256='fake-machine', boot_id='fake-boot')
        evidence = dict(version=1, admission_closed=True, all_writers_fenced=True,
            writer_classes=list(recovery.WRITER_CLASSES), machine=identity,
            created_at=recovery.stamp(), expires_at=(recovery.now() + dt.timedelta(minutes=30)).isoformat(),
            change_id='fixture-change', inventory_reviewed_by='fixture-operator',
            supervisors_and_schedulers_reviewed=True)
        def save(value):
            fence.write_text(json.dumps(value))
            os.chmod(fence, 0o600)
        save(dict(evidence, writer_classes=['api']))
        with mock.patch.object(recovery.os, 'geteuid', return_value=1000, create=True):
            self.assert_gate('WRITER_SCAN_REQUIRES_ROOT', recovery.quiescence, config)
        with self.production_fixture_identity(fence), mock.patch.object(recovery, 'machine_identity', return_value=identity):
            if os.name == 'posix':
                os.chmod(fence, 0o644)
                self.assert_gate('PRIVATE_PATH_PERMISSION', recovery.quiescence, config)
                os.chmod(fence, 0o600)
            self.assert_gate('FENCE_WRITER_CLASSES_MISSING', recovery.quiescence, config)
            save(dict(evidence, machine=dict(identity, boot_id='old-boot')))
            self.assert_gate('FENCE_HOST_BOOT_MISMATCH', recovery.quiescence, config)
            save(evidence)
            with mock.patch.object(recovery, 'command', return_value=b'ActiveState=active\nMainPID=11\nUnitFileState=enabled\n'):
                self.assert_gate('WRITER_UNIT_NOT_FENCED', recovery.quiescence, config)
            stopped = b'ActiveState=inactive\nMainPID=0\nUnitFileState=masked-runtime\n'
            container = dict(Mounts=[dict(Source=str(self.workspace), RW=True)],
                State=dict(Status='exited', Running=False, Pid=0, Paused=False, Restarting=False),
                HostConfig=dict(RestartPolicy=dict(Name='unless-stopped')))
            with mock.patch.object(recovery, 'command', side_effect=[stopped, stopped, b'fake-container-id\n']), mock.patch.object(recovery, 'json_command', return_value=[container]):
                self.assert_gate('DOCKER_WRITER_CAN_RESTART', recovery.quiescence, config)
            container['HostConfig']['RestartPolicy']['Name'] = 'no'
            container['State']['Status'] = 'running'
            container['State']['Running'] = True
            container['State']['Pid'] = 22
            with mock.patch.object(recovery, 'command', side_effect=[stopped, stopped, b'fake-container-id\n']), mock.patch.object(recovery, 'json_command', return_value=[container]):
                self.assert_gate('DOCKER_WRITER_STILL_ACTIVE', recovery.quiescence, config)

    def test_effective_jwt_must_match_covered_private_file_without_output(self):
        config = copy.deepcopy(self.config)
        config['profile'] = 'production'
        credential_file = self.secret_dir / 'effective.env'
        credential_file.write_text('JWT_SECRET="fake-runtime-secret"\n')
        os.chmod(credential_file, 0o600)
        config['credentials'] = dict(jwt_source='environment', jwt_file=str(credential_file), jwt_format='dotenv')
        row = [{'Config': {'Env': ['JWT_SECRET=fake-runtime-secret']}}]
        with mock.patch.object(recovery, 'json_command', return_value=row):
            report = recovery.effective_credentials(config)
            self.assertTrue(report['covered_file_matches'])
            self.assertNotIn('fake-runtime-secret', json.dumps(report))
            self.assertFalse(report['fingerprint_emitted'])
        with mock.patch.object(recovery, 'json_command', return_value=[{'Config': {'Env': ['JWT_SECRET=other-fake-value']}}]):
            self.assert_gate('JWT_SOURCE_EFFECTIVE_MISMATCH', recovery.effective_credentials, config)

    def test_sftp_argv_always_uses_strict_hostkey_and_batch_mode(self):
        remote = dict(identity_file='/fixture/key', known_hosts='/fixture/trust', port=22, destination='fixture@offsite.invalid')
        with mock.patch.object(recovery, 'remote_settings', return_value=remote):
            argv = recovery.sftp_base(self.config)
        self.assertIn('-oBatchMode=yes', argv)
        self.assertIn('-oStrictHostKeyChecking=yes', argv)
        self.assertIn('-oIdentitiesOnly=yes', argv)
        self.assertFalse(any('accept-new' in item or 'password' in item.lower() for item in argv))

    def test_cli_errors_do_not_print_secret_exception_text(self):
        captured = io.StringIO()
        with mock.patch.object(recovery, 'run_checks', side_effect=OSError('fixture-secret-canary')), contextlib.redirect_stdout(captured):
            status = recovery.main(['preflight', '--config', str(self.config_path)])
        self.assertEqual(status, 2)
        self.assertNotIn('fixture-secret-canary', captured.getvalue())
        self.assertEqual(json.loads(captured.getvalue())['code'], 'OSERROR')


if __name__ == '__main__':
    unittest.main()
