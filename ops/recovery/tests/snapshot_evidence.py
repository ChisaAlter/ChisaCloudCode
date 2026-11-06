#!/usr/bin/env python3
"""Snapshot this candidate's code/evidence hashes and parse syntax; no execution.

Read only recovery sources, JSON and local evidence. Output must be a new file
inside the explicitly supplied existing W01 evidence directory.
"""
import argparse
import ast
import datetime as dt
import hashlib
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence-dir', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[3]
    recovery_dir = root / 'ops/recovery'
    evidence_dir = Path(args.evidence_dir).resolve()
    output = Path(args.output).resolve()
    assert evidence_dir == root / 'docs/remediation/2026-10-31/W01'
    assert output.parent == evidence_dir and not output.exists()
    assert not evidence_dir.is_symlink()
    sources = sorted(path for path in recovery_dir.rglob('*') if path.is_file())
    evidence = sorted(path for path in evidence_dir.iterdir() if path.is_file() and
                      (path.name.endswith(('.md', '.json', '.log'))))
    syntax = []
    for path in sources:
        if path.suffix == '.py':
            ast.parse(path.read_text(encoding='utf-8-sig'), filename=str(path))
            syntax.append(dict(path=path.relative_to(root).as_posix(), parser='python-ast', ok=True))
        elif path.suffix == '.json':
            json.loads(path.read_text(encoding='utf-8-sig'))
            syntax.append(dict(path=path.relative_to(root).as_posix(), parser='json', ok=True))
    result = dict(sampled_at=dt.datetime.now(dt.timezone.utc).isoformat(),
        scope=['ops/recovery', 'docs/remediation/2026-10-31/W01'],
        source_files=[dict(path=path.relative_to(root).as_posix(), bytes=path.stat().st_size, sha256=digest(path)) for path in sources],
        evidence_files=[dict(path=path.relative_to(root).as_posix(), bytes=path.stat().st_size, sha256=digest(path)) for path in evidence],
        syntax=syntax, exit_code=0, production_state_changed=False, production_drill_passed=False)
    with output.open('x', encoding='utf-8') as stream:
        json.dump(result, stream, indent=2)
        stream.write('\n')
    print(json.dumps(dict(output=output.relative_to(root).as_posix(), sha256=digest(output),
        source_files=len(sources), evidence_files=len(evidence), syntax_checks=len(syntax), exit_code=0)))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
