import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('backup', Path(__file__).with_name('backup.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class BackupBehavior(unittest.TestCase):
    def test_round_trip_database_retention_and_refuse_overwrite(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'source'
            source.mkdir()
            (source / '文档.txt').write_text('真实文件\n', encoding='utf-8')
            (source / 'empty').mkdir()
            (source / '.chisa-lease').write_text('stale owner')
            (source / 'project.chisa-lease').mkdir()
            (source / 'project.chisa-lease' / 'state.json').write_text('stale owner')
            (source / 'external-sdk').symlink_to('/external/not-backed-up')
            (source / 'relative-link').symlink_to('文档.txt')
            os.mkfifo(source / 'runtime.fifo')
            (source / 'node_modules').mkdir()
            (source / 'node_modules' / 'cache').write_text('regenerable')
            db = source / 'auth.db'
            with sqlite3.connect(db) as connection:
                connection.execute('CREATE TABLE data(value TEXT)')
                connection.execute('INSERT INTO data VALUES (?)', ('preserved account',))
            config = root / 'config.json'
            destination = root / 'backups'
            config.write_text(json.dumps({'sources': [str(source)], 'destination': str(destination),
                'sqliteDatabases': [str(db)], 'excludeDirectoryNames': ['node_modules'], 'retainSnapshots': 1}))
            module.backup(config)
            module.backup(config)
            snapshots = list(destination.iterdir())
            self.assertEqual(len(snapshots), 1)
            snapshot = snapshots[0]
            module.verify(snapshot)
            restored = root / 'restored'
            module.restore(snapshot, restored)
            result = restored / 'sources' / '0'
            self.assertEqual((result / '文档.txt').read_text(encoding='utf-8'), '真实文件\n')
            self.assertTrue((result / 'empty').is_dir())
            self.assertFalse((result / '.chisa-lease').exists())
            self.assertFalse((result / 'project.chisa-lease').exists())
            self.assertFalse((result / 'external-sdk').is_symlink())
            self.assertEqual((result / 'relative-link').read_text(encoding='utf-8'), '真实文件\n')
            self.assertEqual(json.loads((restored / 'external-links.json').read_text())[0]['target'], '/external/not-backed-up')
            self.assertFalse((result / 'runtime.fifo').exists())
            self.assertEqual(json.loads((restored / 'special-files.json').read_text()), ['sources/0/runtime.fifo'])
            self.assertFalse((result / 'node_modules').exists())
            with sqlite3.connect(result / 'auth.db') as connection:
                self.assertEqual(connection.execute('SELECT value FROM data').fetchone()[0], 'preserved account')
            with self.assertRaisesRegex(RuntimeError, 'must not exist'):
                module.restore(snapshot, restored)
            with (snapshot / 'data.tar.gz').open('ab') as archive:
                archive.write(b'tampered')
            with self.assertRaisesRegex(RuntimeError, 'integrity'):
                module.verify(snapshot)


if __name__ == '__main__':
    os.umask(0o077)
    unittest.main()
