"""Portable worker contracts; Linux process-group acceptance remains separate."""
import base64
import builtins
from contextlib import nullcontext
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest import mock


SOURCE_PATH = Path(__file__).resolve().parents[1] / 'resources' / 'workspace.py'


class WorkspaceFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='chisa-worker-contract-')
        self.addCleanup(self.temp.cleanup)
        self.root = (Path(self.temp.name) / 'project').resolve()
        self.root.mkdir()
        self.output = Path(self.temp.name) / 'output'
        self.output.mkdir()
        source = SOURCE_PATH.read_text(encoding='utf-8')
        self.worker = {}
        exec(compile(source[:source.rindex('\ntry:\n')], str(SOURCE_PATH), 'exec'), self.worker)
        self.worker['ROOT'] = self.root
        self.call = self.worker['request_result']
        self.children = []
        self.addCleanup(self.reap_children)
        # Adapt only the worker's fixed Linux output files, never global open().
        self.worker['open'] = self.private_output
        self.worker['subprocess'] = SimpleNamespace(
            Popen=self.start_child, PIPE=subprocess.PIPE,
            TimeoutExpired=subprocess.TimeoutExpired)

    def private_output(self, path, *args, **kwargs):
        paths = {'/tmp/stdout': self.output / 'stdout', '/tmp/stderr': self.output / 'stderr'}
        return builtins.open(paths.get(path, path), *args, **kwargs)

    def start_child(self, *args, **kwargs):
        child = subprocess.Popen(*args, **kwargs)
        self.children.append(child)
        return child

    def reap_children(self):
        for child in self.children:
            if child.poll() is None:
                child.kill()
            child.communicate()

    def assert_ok(self, request):
        result = self.call(request)
        self.assertTrue(result.get('ok'), result)
        return result

    def python_request(self, source, **fields):
        return {'op': 'exec', 'argv': [sys.executable, '-c', source], **fields}


class WorkspacePathContracts(WorkspaceFixture):
    def test_remove_rejects_root_aliases_without_touching_contents(self):
        (self.root / 'subdir').mkdir()
        sentinel = self.root / 'keep.txt'
        sentinel.write_bytes(b'project bytes')
        marker = self.root / '.chisa-bridge.json'
        marker.write_bytes(b'private metadata')
        aliases = ('.', './', './.', 'subdir/..', 'subdir/../',
                   'subdir/../.', 'subdir/.././', str(self.root))
        for path in aliases:
            with self.subTest(path=path):
                result = self.call({'op': 'remove', 'path': path})
                self.assertFalse(result['ok'], result)
                self.assertEqual(sentinel.read_bytes(), b'project bytes')
                self.assertEqual(marker.read_bytes(), b'private metadata')
                self.assertTrue((self.root / 'subdir').is_dir())

    def test_remove_unlinks_final_directory_symlink_not_its_target(self):
        outside = Path(self.temp.name) / 'outside'
        outside.mkdir()
        sentinel = outside / 'keep.txt'
        sentinel.write_bytes(b'outside bytes')
        link = self.root / 'link'
        # A privilege error is a test failure, not a skipped green result.
        link.symlink_to(outside, target_is_directory=True)
        self.assert_ok({'op': 'remove', 'path': 'link'})
        self.assertFalse(link.is_symlink())
        self.assertEqual(sentinel.read_bytes(), b'outside bytes')

    def test_rename_moves_source_symlink_and_keeps_referent(self):
        target = self.root / 'data.txt'
        target.write_bytes(b'referent')
        source = self.root / 'alias.txt'
        source.symlink_to('data.txt')
        self.assert_ok({'op': 'rename', 'path': 'alias.txt', 'destination': 'renamed.txt'})
        renamed = self.root / 'renamed.txt'
        self.assertFalse(source.is_symlink())
        self.assertTrue(renamed.is_symlink())
        self.assertEqual(os.readlink(renamed), 'data.txt')
        self.assertEqual(target.read_bytes(), b'referent')

    def test_rename_moves_dangling_source_symlink(self):
        source = self.root / 'dangling'
        source.symlink_to('missing')
        self.assert_ok({'op': 'rename', 'path': 'dangling', 'destination': 'renamed'})
        self.assertFalse(source.is_symlink())
        self.assertTrue((self.root / 'renamed').is_symlink())
        self.assertFalse((self.root / 'missing').exists())

    def test_rename_replaces_destination_entry_not_its_symlink_target(self):
        source = self.root / 'source.txt'
        source.write_bytes(b'replacement')
        outside = Path(self.temp.name) / 'outside.txt'
        outside.write_bytes(b'outside bytes')
        destination = self.root / 'destination.txt'
        destination.symlink_to(outside)
        # Windows rename refuses existing targets; replace has the deployed
        # POSIX rename semantics while still operating on real directory entries.
        adapter = (mock.patch.object(Path, 'rename', lambda path, target: path.replace(target))
                   if os.name != 'posix' else nullcontext())
        with adapter:
            self.assert_ok({'op': 'rename', 'path': 'source.txt', 'destination': 'destination.txt'})
        self.assertFalse(source.exists())
        self.assertFalse(destination.is_symlink())
        self.assertEqual(destination.read_bytes(), b'replacement')
        self.assertEqual(outside.read_bytes(), b'outside bytes')

    def test_ordinary_rename_preserves_bytes(self):
        source = self.root / 'source.txt'
        source.write_bytes(b'ordinary bytes')
        self.assert_ok({'op': 'rename', 'path': 'source.txt', 'destination': 'renamed.txt'})
        self.assertFalse(source.exists())
        self.assertEqual((self.root / 'renamed.txt').read_bytes(), b'ordinary bytes')

    def test_read_write_copy_continue_to_follow_final_symlinks(self):
        target = self.root / 'data.txt'
        target.write_bytes(b'original')
        alias = self.root / 'alias.txt'
        alias.symlink_to('data.txt')
        read = self.assert_ok({'op': 'read', 'path': 'alias.txt'})
        self.assertEqual(base64.b64decode(read['b64']), b'original')
        self.assert_ok({'op': 'write', 'path': 'alias.txt', 'expectedHash': read['hash'],
                        'b64': base64.b64encode(b'updated').decode()})
        self.assertTrue(alias.is_symlink())
        self.assertEqual(target.read_bytes(), b'updated')
        copied_target = self.root / 'copy-target.txt'
        copied_target.write_bytes(b'old copy')
        (self.root / 'copy-alias.txt').symlink_to('copy-target.txt')
        self.assert_ok({'op': 'copy', 'path': 'alias.txt', 'destination': 'copy-alias.txt'})
        self.assertTrue((self.root / 'copy-alias.txt').is_symlink())
        self.assertEqual(copied_target.read_bytes(), b'updated')

    def test_rename_preserves_metadata_and_rejects_lexical_escape(self):
        (self.root / 'source.txt').write_bytes(b'source')
        marker = self.root / '.chisa-bridge.json'
        marker.write_bytes(b'metadata')
        requests = (
            {'path': '.chisa-bridge.json', 'destination': 'renamed'},
            {'path': 'source.txt', 'destination': '.chisa-bridge.json'},
            {'path': '../source.txt', 'destination': 'renamed'},
            {'path': 'source.txt', 'destination': '../renamed'},
        )
        for fields in requests:
            with self.subTest(fields=fields):
                self.assertFalse(self.call({'op': 'rename', **fields})['ok'])
                self.assertEqual(marker.read_bytes(), b'metadata')
                self.assertEqual((self.root / 'source.txt').read_bytes(), b'source')

    def test_rename_rejects_symlink_parent_escape(self):
        (self.root / 'source.txt').write_bytes(b'source')
        outside = Path(self.temp.name) / 'outside'
        outside.mkdir()
        (outside / 'source.txt').write_bytes(b'outside')
        (self.root / 'external').symlink_to(outside, target_is_directory=True)
        requests = (
            {'path': 'external/source.txt', 'destination': 'renamed'},
            {'path': 'source.txt', 'destination': 'external/renamed'},
            {'path': 'source.txt', 'destination': 'external/..'},
        )
        for fields in requests:
            with self.subTest(fields=fields):
                self.assertFalse(self.call({'op': 'rename', **fields})['ok'])
                self.assertEqual((self.root / 'source.txt').read_bytes(), b'source')
                self.assertEqual((outside / 'source.txt').read_bytes(), b'outside')


class WorkspaceExecContracts(WorkspaceFixture):
    def test_real_child_receives_utf8_literal_environment_and_stdin(self):
        (self.root / 'run-here').mkdir()
        literal = '空 格 "quoted" ; $(touch NEVER_EXECUTE)\nsecond line'
        stdin = '输入\r\nline two\x00end'
        source = (
            'import json,os,sys; '
            'value={"env":os.environ["CHISA_CONTRACT_LITERAL"],'
            '"inherited":os.environ["CHISA_CONTRACT_INHERITED"],'
            '"stdin":sys.stdin.buffer.read().decode("utf-8"),"cwd":os.getcwd()}; '
            'sys.stdout.buffer.write(json.dumps(value,ensure_ascii=False).encode("utf-8")); '
            'sys.stderr.buffer.write("错误".encode("utf-8"))')
        with mock.patch.dict(os.environ, {'CHISA_CONTRACT_INHERITED': 'existing'}):
            result = self.assert_ok(self.python_request(
                source, path='run-here', env={'CHISA_CONTRACT_LITERAL': literal}, stdin=stdin))
        output = json.loads(result['stdout'])
        self.assertEqual(output, {'env': literal, 'inherited': 'existing', 'stdin': stdin,
                                  'cwd': str(self.root / 'run-here')})
        self.assertEqual(result['stderr'], '错误')
        self.assertEqual(result['exitCode'], 0)
        self.assertFalse(result['timedOut'])
        self.assertFalse((self.root / 'run-here' / 'NEVER_EXECUTE').exists())

    def test_real_child_empty_stdin_is_eof_and_empty_env_keeps_inheritance(self):
        source = ('import os,sys; '
                  'sys.stdout.buffer.write(sys.stdin.buffer.read()+os.environ["CHISA_CONTRACT_INHERITED"].encode())')
        with mock.patch.dict(os.environ, {'CHISA_CONTRACT_INHERITED': 'inherited'}):
            result = self.assert_ok(self.python_request(source, env={}, stdin=''))
        self.assertEqual(result['stdout'], 'inherited')
        self.assertEqual(result['exitCode'], 0)

    def test_real_child_legacy_omitted_inputs_and_nonzero_exit(self):
        result = self.assert_ok(self.python_request(
            'import sys; sys.stdout.write("legacy"); sys.stderr.write("failure"); sys.exit(23)'))
        self.assertEqual(result['stdout'], 'legacy')
        self.assertEqual(result['stderr'], 'failure')
        self.assertEqual(result['exitCode'], 23)
        self.assertFalse(result['timedOut'])

    def test_mocked_legacy_shell_and_fractional_long_budgets_are_forwarded_exactly(self):
        for timeout in (None, 1, 1.25, 600.5, 2_146_999.75, 2_147_000):
            with self.subTest(timeout=timeout):
                child = mock.Mock(returncode=0)
                fields = {} if timeout is None else {'timeoutSeconds': timeout}
                with mock.patch.object(self.worker['subprocess'], 'Popen', return_value=child) as spawn:
                    result = self.assert_ok({'op': 'exec', 'command': 'printf legacy', **fields})
                self.assertEqual(result['exitCode'], 0)
                self.assertEqual(spawn.call_args.args[0], ['bash', '-c', 'printf legacy'])
                self.assertIsNone(spawn.call_args.kwargs['stdin'])
                self.assertTrue(spawn.call_args.kwargs['start_new_session'])
                child.communicate.assert_called_once_with(input=None, timeout=60 if timeout is None else timeout)

    def test_invalid_environment_stdin_and_timeouts_do_not_spawn(self):
        invalid = ([{'env': value} for value in ([], 'text', 1, {'KEY': 3}, {'KEY': None})]
                   + [{'stdin': value} for value in ([], {}, 1, True)]
                   + [{'timeoutSeconds': value} for value in
                      (None, True, '60', [], {}, 0, -1, 0.999, 2_147_000.01,
                       float('inf'), float('-inf'), float('nan'))])
        with mock.patch.object(self.worker['subprocess'], 'Popen') as spawn:
            for fields in invalid:
                with self.subTest(fields=fields):
                    result = self.call(self.python_request('pass', **fields))
                    self.assertFalse(result['ok'], result)
                    self.assertEqual(result['code'], 'INVALID_REQUEST')
            spawn.assert_not_called()

    def test_real_child_rejects_environment_names_and_values_invalid_for_popen(self):
        for environment in ({'BAD=KEY': 'value'}, {'BAD\x00KEY': 'value'}, {'KEY': 'bad\x00value'}):
            with self.subTest(environment=environment):
                result = self.call(self.python_request('pass', env=environment))
                self.assertFalse(result['ok'], result)
                self.assertEqual(result['code'], 'INVALID_REQUEST')

    def test_real_timeout_reaps_only_the_selected_test_child_with_windows_kill_adapter(self):
        kills = []

        def kill_selected(pid, sig):
            matches = [child for child in self.children if child.pid == pid]
            self.assertEqual(len(matches), 1)
            kills.append((pid, sig))
            matches[0].kill()

        # Exercise real communicate timeout/reaping on Windows without claiming
        # that this adapter proves Linux descendant process-group termination.
        self.worker['os'] = SimpleNamespace(environ=os.environ, killpg=kill_selected)
        started = time.monotonic()
        with mock.patch.object(signal, 'SIGKILL', getattr(signal, 'SIGKILL', 9), create=True):
            result = self.assert_ok(self.python_request('import time; time.sleep(30)', timeoutSeconds=1))
        self.assertTrue(result['timedOut'])
        self.assertNotEqual(result['exitCode'], 0)
        self.assertLess(time.monotonic() - started, 8)
        self.assertEqual(len(kills), 1)
        self.assertIsNotNone(self.children[0].poll())

    def test_mocked_timeout_targets_its_group_then_waits_for_output_and_exit(self):
        child = mock.Mock(pid=812345, returncode=-9)
        child.communicate.side_effect = [subprocess.TimeoutExpired('fixture', 1.5), None]
        killpg = mock.Mock()
        self.worker['os'] = SimpleNamespace(environ=os.environ, killpg=killpg)
        with mock.patch.object(self.worker['subprocess'], 'Popen', return_value=child), \
                mock.patch.object(signal, 'SIGKILL', getattr(signal, 'SIGKILL', 9), create=True):
            result = self.assert_ok(self.python_request('pass', stdin='输入', timeoutSeconds=1.5))
            killpg.assert_called_once_with(child.pid, signal.SIGKILL)
        self.assertEqual(child.communicate.call_args_list,
                         [mock.call(input='输入'.encode('utf-8'), timeout=1.5), mock.call()])
        self.assertTrue(result['timedOut'])
        self.assertEqual(result['exitCode'], -9)


if __name__ == '__main__':
    unittest.main()
