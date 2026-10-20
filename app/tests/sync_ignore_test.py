"""Run the shipped ignore inventory worker against disposable Git projects."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

WORKER = Path(__file__).resolve().parents[1] / 'resources' / 'sync_ignore.py'


class EffectiveProjectIgnoreTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='chisa-ignore-inventory-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / 'project'
        self.root.mkdir()
        self.env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
        self.env['HOME'] = self.temporary.name
        self.env['GIT_CONFIG_NOSYSTEM'] = '1'

    def git(self, *args):
        return subprocess.run(['git', '-C', str(self.root), *args], env=self.env,
                              capture_output=True, check=True)

    def write(self, path, content):
        file = self.root / path
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(content)

    def inventory(self, root=None):
        result = subprocess.run([sys.executable, str(WORKER)], env=self.env,
                                input=json.dumps({'root': str(root or self.root)}),
                                capture_output=True, text=True, check=True)
        return json.loads(result.stdout)

    def test_info_exclude_and_tracked_child_retain_parent_coverage(self):
        self.git('init', '-b', 'main')
        self.write('.git/info/exclude', '.local-node/\n')
        self.write('.local-node/assets/source.txt', 'tracked source')
        self.write('.local-node/bin/npm', 'runtime link or launcher')
        self.git('add', '-f', '.local-node/assets/source.txt')
        inventory = self.inventory()
        self.assertIn('.local-node/', inventory['ignored'])
        self.assertEqual(inventory['tracked'], ['.local-node/assets/source.txt'])

    def test_nested_ignore_rules_and_literal_names_use_git_semantics(self):
        self.git('init', '-b', 'main')
        self.write('nested/.gitignore', 'cache-*/\n!cache-keep/\n')
        self.write('nested/cache-new/run.txt', 'runtime')
        self.write('nested/cache-keep/source.txt', 'source')
        self.write('.gitignore', 'runtime\\[1\\]/\n')
        self.write('runtime[1]/bin/npm', 'runtime')
        self.write('runtime1/source.txt', 'source')
        inventory = self.inventory()
        self.assertIn('nested/cache-new/', inventory['ignored'])
        self.assertIn('runtime[1]/', inventory['ignored'])
        self.assertFalse(any('cache-keep' in p or 'runtime1/' in p for p in inventory['ignored']))

    def test_initial_non_repository_is_empty_but_nested_repository_is_rejected(self):
        self.assertEqual(self.inventory(), {'tracked': [], 'ignored': []})
        self.git('init', '-b', 'main')
        nested = self.root / 'nested'
        nested.mkdir()
        with self.assertRaises(subprocess.CalledProcessError):
            self.inventory(nested)


if __name__ == '__main__':
    unittest.main()
