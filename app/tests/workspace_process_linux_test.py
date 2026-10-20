"""Real Linux worker process-group timeout, using only disposable test processes."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

from workspace_contract_test import WorkspaceFixture


def process_identity(pid):
    try:
        fields = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
    except FileNotFoundError:
        return None
    return {'state': fields[0], 'group': int(fields[2]), 'start': fields[19]}


class WorkspaceLinuxProcessContracts(WorkspaceFixture):
    def test_timeout_terminates_parent_and_descendant_but_not_separate_group(self):
        self.assertEqual(os.name, 'posix', 'Run this Linux contract in the existing WSL distro')
        marker = self.root / 'descendant.json'

        def cleanup_descendant():
            if not marker.exists():
                return
            expected = json.loads(marker.read_text())
            actual = process_identity(expected['pid'])
            if actual and actual['start'] == expected['start'] and actual['state'] != 'Z':
                os.kill(expected['pid'], signal.SIGKILL)

        self.addCleanup(cleanup_descendant)
        control = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'],
                                   cwd=self.root, stdin=subprocess.DEVNULL,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                   start_new_session=True)

        def cleanup_control():
            if control.poll() is None:
                control.kill()
            control.communicate()

        self.addCleanup(cleanup_control)
        descendant = (
            'import json,os,time; from pathlib import Path; '
            'fields=Path("/proc/self/stat").read_text().rsplit(")",1)[1].split(); '
            'Path("descendant.json").write_text(json.dumps('
            '{"pid":os.getpid(),"group":os.getpgrp(),"start":fields[19]})); '
            'time.sleep(30)')
        parent = ('import subprocess,sys,time; '
                  f'subprocess.Popen([sys.executable,"-c",{descendant!r}]); '
                  'time.sleep(30)')
        started = time.monotonic()
        result = self.assert_ok(self.python_request(parent, timeoutSeconds=1.25))
        self.assertTrue(result['timedOut'])
        self.assertEqual(result['exitCode'], -signal.SIGKILL)
        self.assertLess(time.monotonic() - started, 6)
        self.assertTrue(marker.exists(), 'The descendant must have started before the timeout')
        expected = json.loads(marker.read_text())
        owned_parent = self.children[0]
        self.assertEqual(expected['group'], owned_parent.pid)
        self.assertIsNotNone(owned_parent.poll(), 'The worker did not reap its direct child')
        descendant_state = process_identity(expected['pid'])
        self.assertTrue(descendant_state is None or descendant_state['state'] == 'Z',
                        f'The timed-out descendant is still executing: {descendant_state}')
        self.assertIsNone(control.poll(), 'Timeout terminated a process in a different test group')


if __name__ == '__main__':
    import unittest
    unittest.main()
