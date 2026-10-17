"""Exercise clear-result evidence against real temporary files; no VPS access."""
import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SOURCE = (Path(__file__).resolve().parents[1] / 'resources' / 'confirm_empty.py').read_text(encoding='utf-8')


class ConfirmEmptyContracts(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = (Path(self.temp.name) / 'project').resolve()
        self.root.mkdir()
        (self.root / 'a.txt').write_bytes(b'original a')
        (self.root / 'b.txt').write_bytes(b'original b')

    def call(self, request):
        output = io.StringIO()
        with patch('sys.stdin', io.StringIO(json.dumps({'root': str(self.root), **request}))), contextlib.redirect_stdout(output):
            exec(compile(SOURCE, 'confirm_empty.py', 'exec'), {})
        return json.loads(output.getvalue())

    def plan(self):
        inventory = self.call({'op': 'list', 'directories': ['']})
        return {'op': 'move', 'id': 'a123', 'epoch': 'binding', **inventory}

    def test_changed_file_reports_not_started_without_backup(self):
        request = self.plan()
        (self.root / 'a.txt').write_bytes(b'new contents after scan')
        result = self.call(request)
        self.assertEqual(result['clearState'], 'not-started')
        self.assertEqual(result['backupPath'], '')
        self.assertEqual((self.root / 'b.txt').read_bytes(), b'original b')
        self.assertFalse(Path(str(self.root) + '.chisa-sync-backups').exists())

    def test_new_file_after_scan_prevents_clearing(self):
        request = self.plan()
        (self.root / 'new.txt').write_bytes(b'keep')
        result = self.call(request)
        self.assertEqual(result['clearState'], 'not-started')
        self.assertEqual(result['backupPath'], '')
        self.assertEqual(len(list(self.root.iterdir())), 3)

    def test_backup_creation_failure_never_reports_a_recovery_path(self):
        request = self.plan()
        Path(str(self.root) + '.chisa-sync-backups').write_bytes(b'not a directory')
        result = self.call(request)
        self.assertEqual(result['clearState'], 'not-started')
        self.assertEqual(result['backupPath'], '')
        self.assertTrue((self.root / 'a.txt').exists())

    def test_partial_failure_identifies_only_actual_moved_files(self):
        request = self.plan()
        rename = os.rename

        def fail_second(source, destination):
            if Path(source).name == 'b.txt':
                raise OSError('simulated second move failure')
            return rename(source, destination)

        with patch('os.rename', side_effect=fail_second):
            result = self.call(request)
        self.assertEqual(result['clearState'], 'partial')
        backup = Path(result['backupPath'])
        self.assertEqual((backup / 'files' / 'a.txt').read_bytes(), b'original a')
        self.assertFalse((backup / 'files' / 'b.txt').exists())
        self.assertEqual((self.root / 'b.txt').read_bytes(), b'original b')
        self.assertTrue((backup / 'manifest.json').is_file())

    def test_complete_clear_preserves_bytes_and_ignored_files(self):
        (self.root / '.env').write_bytes(b'ignored secret')
        request = self.plan()
        request['entries'] = [entry for entry in request['entries'] if entry['path'] != '.env']
        result = self.call(request)
        self.assertEqual(result['clearState'], 'completed')
        backup = Path(result['backupPath']) / 'files'
        self.assertEqual((backup / 'a.txt').read_bytes(), b'original a')
        self.assertEqual((backup / 'b.txt').read_bytes(), b'original b')
        self.assertEqual([p.name for p in self.root.iterdir()], ['.env'])

    def test_new_file_during_movement_reports_partial(self):
        request = self.plan()
        rename = os.rename

        def concurrent_write(source, destination):
            rename(source, destination)
            (self.root / 'new.txt').write_bytes(b'concurrent change')

        with patch('os.rename', side_effect=concurrent_write):
            result = self.call(request)
        self.assertEqual(result['clearState'], 'partial')
        self.assertEqual((self.root / 'new.txt').read_bytes(), b'concurrent change')
        self.assertTrue((Path(result['backupPath']) / 'files' / 'a.txt').exists())

    def test_empty_directories_are_available_for_recovery(self):
        (self.root / 'empty').mkdir()
        request = self.plan()
        result = self.call(request)
        self.assertEqual(result['clearState'], 'completed')
        self.assertTrue((Path(result['backupPath']) / 'files' / 'empty').is_dir())
        self.assertFalse((self.root / 'empty').exists())


if __name__ == '__main__':
    unittest.main()
