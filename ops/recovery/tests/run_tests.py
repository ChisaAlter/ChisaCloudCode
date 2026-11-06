"""Run fake-data unittest suite, persist a clean log and exact result JSON."""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import sys
import time
import unittest

sys.dont_write_bytecode = True


class Tee:
    def __init__(self, *streams):
        self.streams = streams

    def write(self, text):
        for stream in self.streams:
            stream.write(text)
        return len(text)

    def flush(self):
        for stream in self.streams:
            stream.flush()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--log', required=True)
    parser.add_argument('--result', help='Separate result path; keep Windows/root/nonroot evidence distinct')
    args = parser.parse_args()
    target = Path(args.log)
    result_path = Path(args.result) if args.result else target.with_name('fixture-test-result.json')
    if not target.parent.is_dir() or not result_path.parent.is_dir():
        parser.error('existing evidence directory required')
    started = dt.datetime.now(dt.timezone.utc).isoformat()
    monotonic = time.monotonic()
    source_paths = [Path(__file__).resolve(), Path(__file__).with_name('test_recovery.py').resolve(),
                    Path(__file__).resolve().parents[1] / 'recovery.py']
    hashes = {str(path.relative_to(Path(__file__).resolve().parents[3])): hashlib.sha256(path.read_bytes()).hexdigest()
              for path in source_paths}
    with target.open('w', encoding='utf-8') as log:
        stream = Tee(sys.stdout, log)
        euid = os.geteuid() if os.name == 'posix' else None
        stream.write(json.dumps(dict(started_at=started, python=sys.version.split()[0], platform=sys.platform,
            euid=euid, identity_model='real root and inode owner' if euid == 0 else 'unit fence only: matched modeled euid/owner; real private-path checks',
            source_sha256=hashes)) + '\n')
        runner = unittest.TextTestRunner(stream=stream, verbosity=2)
        suite = unittest.defaultTestLoader.discover(str(Path(__file__).parent), pattern='test_*.py')
        result = runner.run(suite)
        exit_code = 0 if result.wasSuccessful() else 1
        summary = dict(started_at=started, finished_at=dt.datetime.now(dt.timezone.utc).isoformat(),
            python=sys.version.split()[0], platform=sys.platform, euid=euid,
            environment='local temporary fake-data fixtures only', source_sha256=hashes,
            tests_run=result.testsRun, passed=result.testsRun-len(result.failures)-len(result.errors)-len(result.skipped),
            failures=len(result.failures), errors=len(result.errors), skipped=len(result.skipped),
            skip_reasons=[dict(test=str(test), reason=reason) for test, reason in result.skipped],
            exit_code=exit_code, duration_seconds=round(time.monotonic()-monotonic, 3),
            production_state_changed=False, production_drill_passed=False)
        stream.write(json.dumps(summary) + '\n')
    result_path.write_text(json.dumps(summary, indent=2) + '\n', encoding='utf-8')
    return exit_code


if __name__ == '__main__':
    raise SystemExit(main())
