import json
import os
import pathlib
import subprocess
import sys

q = json.load(sys.stdin)
root = pathlib.Path(q['root']).resolve(strict=True)
base = ['git', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', str(root)]
env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
probe = subprocess.run(base + ['rev-parse', '--show-toplevel'], env=env, capture_output=True)
if probe.returncode:
    if not (root / '.git').exists() and b'not a git repository' in probe.stderr:
        print(json.dumps({'tracked': [], 'ignored': []}))
        sys.exit(0)
    raise RuntimeError(probe.stderr.decode(errors='replace'))
if pathlib.Path(os.fsdecode(probe.stdout).rstrip('\r\n')).resolve() != root:
    raise RuntimeError('Git root is not the bound workspace')

def paths(args):
    result = subprocess.run(base + args, env=env, capture_output=True, check=True)
    return [os.fsdecode(value) for value in result.stdout.split(b'\0') if value]

# A directory that holds a force-tracked child still needs its ignored ancestors
# honoured. The Go side drops any ancestor that covers too many tracked files,
# because each one would otherwise need a re-include exception of its own.
ignored = paths(['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'])
candidates = set()
for item in ignored:
    parts = item.rstrip('/').split('/')
    for i in range(len(parts)):
        candidate = '/'.join(parts[:i + 1])
        if i < len(parts) - 1 or item.endswith('/'):
            candidate += '/'
        candidates.add(candidate)
if candidates:
    result = subprocess.run(base + ['check-ignore', '--no-index', '-z', '--stdin'], env=env,
                            input=b'\0'.join(os.fsencode(p) for p in sorted(candidates)) + b'\0', capture_output=True)
    if result.returncode not in (0, 1):
        raise RuntimeError(result.stderr.decode(errors='replace'))
    ignored = [os.fsdecode(value) for value in result.stdout.split(b'\0') if value]
print(json.dumps({'tracked': paths(['ls-files', '-z']), 'ignored': ignored}))
