"""Focused worker contracts; run on Linux, separate from VPS/container acceptance."""
import base64
import hashlib
import os
from pathlib import Path
import tempfile
import unittest

source = (Path(__file__).resolve().parents[1] / 'resources' / 'workspace.py').read_text()
worker = {}
exec(source[:source.rindex('\ntry:\n')], worker)

@unittest.skipUnless(os.name == 'posix', 'Linux file and process contracts require Linux')
class WorkspaceContracts(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / 'project'
        self.root.mkdir()
        worker['ROOT'] = self.root
        self.call = worker['main']

    def tearDown(self):
        self.temp.cleanup()

    def test_original_bytes_and_stale_write(self):
        p = self.root / 'original.bin'
        original = b'C:\\Users\\real-owner\x00\xff\r\n'
        p.write_bytes(original)
        read = self.call({'op': 'read', 'path': 'original.bin'})
        self.assertEqual(base64.b64decode(read['b64']), original)
        self.assertEqual(read['hash'], hashlib.sha256(original).hexdigest())
        p.write_bytes(b'external editor update')
        changed = self.call({'op': 'write', 'path': 'original.bin', 'expectedHash': read['hash'], 'b64': base64.b64encode(b'agent update').decode()})
        self.assertEqual(changed['code'], 'CONTENT_CONFLICT')
        self.assertEqual(p.read_bytes(), b'external editor update')
        current = self.call({'op': 'read', 'path': 'original.bin'})
        self.call({'op': 'write', 'path': 'original.bin', 'expectedHash': current['hash'], 'b64': base64.b64encode(original).decode()})
        self.assertEqual(p.read_bytes(), original)

    def test_traversal_and_external_symlink(self):
        outside = Path(self.temp.name) / 'outside.txt'
        outside.write_text('private')
        (self.root / 'link').symlink_to(outside)
        for candidate in ('../outside.txt', str(outside), 'link'):
            with self.assertRaises((PermissionError, ValueError)):
                self.call({'op': 'read', 'path': candidate})
        self.call({'op': 'remove', 'path': 'link'})
        self.assertEqual(outside.read_text(), 'private')

    def test_process_failure_and_timeout(self):
        failed = self.call({'op': 'exec', 'command': "printf 'real output'; printf 'real error' >&2; exit 23"})
        self.assertEqual(failed['exitCode'], 23)
        self.assertEqual(failed['stdout'], 'real output')
        self.assertEqual(failed['stderr'], 'real error')
        timed = self.call({'op': 'exec', 'command': 'sleep 20', 'timeoutSeconds': 1})
        self.assertTrue(timed['timedOut'])
        self.assertNotEqual(timed['exitCode'], 0)

if __name__ == '__main__':
    unittest.main()
