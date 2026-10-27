"""Replay the complete Chisa source patch; never builds or starts a binary."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import stat
import subprocess


def lf_hash(path):
    if not path.exists():
        return None
    return hashlib.sha256(path.read_text(encoding='utf-8').replace('\r\n', '\n').encode()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--upstream-source', required=True, type=Path)
    parser.add_argument('--destination', required=True, type=Path)
    args = parser.parse_args()
    upstream, destination = args.upstream_source.resolve(strict=True), args.destination.resolve()
    if destination.exists():
        raise RuntimeError('destination must not exist; existing files are never overwritten')
    directory = Path(__file__).resolve().parent
    manifest = json.loads((directory / 'source-manifest.json').read_text(encoding='utf-8'))
    patch = directory / 'chisa-dynamic-git.patch'
    if hashlib.sha256(patch.read_bytes()).hexdigest() != manifest['patchSha256']:
        raise RuntimeError('patch digest mismatch')
    for entry in manifest['files']:
        if lf_hash(upstream / entry['path']) != entry['beforeSha256LF']:
            raise RuntimeError('upstream source mismatch: ' + entry['path'])
    shutil.copytree(upstream, destination)
    for item in destination.rglob('*'):
        if item.is_file():
            item.chmod(item.stat().st_mode | stat.S_IWRITE)
    for extra in (['--check'], []):
        subprocess.run(['git', '-c', 'core.autocrlf=false', 'apply', *extra, '--whitespace=nowarn', str(patch)], cwd=destination, check=True)
    for entry in manifest['files']:
        if lf_hash(destination / entry['path']) != entry['afterSha256LF']:
            raise RuntimeError('replayed source mismatch: ' + entry['path'])
    print(f"Replayed {manifest['version']}, {len(manifest['files'])} changed source files; no binaries built.")


if __name__ == '__main__':
    main()
