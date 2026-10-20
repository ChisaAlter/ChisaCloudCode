"""Project operations inside the isolated Linux workspace container."""
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path('/workspace')
MAX_FILE = 8 * 1024 * 1024

def resolve(value='.', follow=True):
    p = Path(value)
    if p.is_absolute(): p = p.relative_to(ROOT)
    candidate = ROOT / p
    if not follow and candidate.name == '..': raise PermissionError('Path must name a workspace entry')
    target = candidate.resolve() if follow else candidate.parent.resolve() / candidate.name
    if target != ROOT and ROOT not in target.parents: raise PermissionError('Path is outside the workspace')
    if '.chisa-bridge.json' in target.parts: raise PermissionError('Reserved workspace metadata')
    return target

def read_bytes(p):
    if p.stat().st_size > MAX_FILE: raise ValueError('File exceeds the 8 MiB workspace limit')
    return p.read_bytes()

def digest(p):
    return hashlib.sha256(read_bytes(p)).hexdigest() if p.exists() else None

def path_stats(p, follow=True):
    s = p.stat() if follow else p.lstat()
    return {'size': s.st_size, 'mtime': s.st_mtime, 'mode': s.st_mode, 'dir': p.is_dir(), 'symlink': p.is_symlink()}

def main(q):
    op = q.get('op')
    if op == 'batch':
        requests = q.get('requests')
        if not isinstance(requests, list) or not 1 <= len(requests) <= 64:
            raise ValueError('Batch requires 1 to 64 read-only requests')
        for request in requests:
            if not isinstance(request, dict) or request.get('op') not in ('stat', 'lstat', 'list') or not isinstance(request.get('path', '.'), str):
                raise ValueError('Batch requests must use stat, lstat or list with a string path')
        return {'results': [request_result(request) for request in requests]}
    p = resolve(q.get('path', '.'), op not in ('lstat', 'remove', 'rename'))
    if op == 'list':
        if q.get('includeStats') is not True:
            return {'entries': [{'name': e.name, 'dir': e.is_dir()} for e in sorted(p.iterdir()) if e.name != '.chisa-bridge.json']}
        entries = []
        for e in sorted(p.iterdir()):
            if e.name == '.chisa-bridge.json': continue
            try: directory = e.is_dir()
            except OSError: directory = False
            entry = {'name': e.name, 'dir': directory}
            try: entry['stats'] = path_stats(e, False)
            except OSError: pass
            entries.append(entry)
        return {'entries': entries}
    if op in ('stat', 'lstat'):
        if op == 'lstat': p = resolve(q.get('path', '.'), False)
        return path_stats(p, op == 'stat')
    if op == 'realpath': return {'path': str(p)}
    if op == 'read':
        data = read_bytes(p)
        return {'b64': base64.b64encode(data).decode(), 'hash': hashlib.sha256(data).hexdigest()}
    if op == 'write':
        expected = q.get('expectedHash')
        if 'expectedHash' not in q or digest(p) != expected: return {'error': 'File changed since it was read; read it again', 'code': 'CONTENT_CONFLICT'}
        data = base64.b64decode(q['b64'], validate=True)
        if len(data) > MAX_FILE: raise ValueError('File exceeds the 8 MiB workspace limit')
        p.parent.mkdir(parents=True, exist_ok=True)
        temp = p.with_name(p.name + '.chisa-' + os.urandom(8).hex())
        try:
            temp.write_bytes(data)
            if p.exists(): os.chmod(temp, p.stat().st_mode & 0o777)
            if digest(p) != expected: return {'error': 'File changed during writing', 'code': 'CONTENT_CONFLICT'}
            os.replace(temp, p)
        finally: temp.unlink(missing_ok=True)
        return {'hash': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}
    if op == 'mkdir': p.mkdir(parents=q.get('recursive', True), exist_ok=True); return {}
    if op in ('rename', 'copy'):
        dst = resolve(q['destination'], op != 'rename')
        if op == 'rename': p.rename(dst)
        else: shutil.copyfile(p, dst)
        return {}
    if op == 'remove':
        p = resolve(q['path'], False)
        if p == ROOT: raise PermissionError('Cannot remove the workspace root')
        if p.is_dir() and not p.is_symlink(): shutil.rmtree(p)
        else: p.unlink()
        return {}
    if op in ('search', 'grep'):
        query = q['query']; matches = []
        for directory, dirs, names in os.walk(p, followlinks=False):
            dirs[:] = [d for d in dirs if d not in ('.git', 'node_modules', '.venv', 'dist', 'build')]
            for name in names:
                try: f = resolve(str(Path(directory) / name))
                except (PermissionError, ValueError): continue
                if op == 'search' and query.lower() in name.lower(): matches.append(str(f))
                if op == 'grep' and f.is_file() and f.stat().st_size <= MAX_FILE:
                    try:
                        for i, line in enumerate(f.read_text().splitlines(), 1):
                            if query.lower() in line.lower(): matches.append({'path': str(f), 'line': i, 'text': line})
                    except UnicodeError: pass
                if len(matches) >= 200: return {'matches': matches[:200], 'truncated': True}
        return {'matches': matches, 'truncated': False}
    if op == 'exec':
        command = q.get('command', '')
        if not command.strip() and not q.get('argv'): raise ValueError('Command is empty')
        timeout = q.get('timeoutSeconds', 60)
        if type(timeout) not in (int, float) or not 1 <= timeout <= 2_147_000:
            raise ValueError('Command timeout must be a finite number between 1 and 2147000 seconds')
        argv = q.get('argv') or ['bash', '-c', command]
        environment = q.get('env')
        if environment is not None and (not isinstance(environment, dict) or any(not isinstance(value, str) for value in environment.values())):
            raise ValueError('Command environment must map names to strings')
        stdin = q.get('stdin')
        if stdin is not None and not isinstance(stdin, str): raise ValueError('Command stdin must be a string')
        child_environment = os.environ.copy()
        if environment is not None: child_environment.update(environment)
        with open('/tmp/stdout', 'w+b') as out, open('/tmp/stderr', 'w+b') as err:
            process = subprocess.Popen(argv, cwd=p, env=child_environment, stdin=subprocess.PIPE if stdin is not None else None,
                                       stdout=out, stderr=err, start_new_session=True)
            timed_out = False
            try: process.communicate(input=stdin.encode('utf-8') if stdin is not None else None, timeout=timeout)
            except subprocess.TimeoutExpired:
                import signal
                timed_out = True; os.killpg(process.pid, signal.SIGKILL); process.communicate()
            out.seek(0); err.seek(0)
            stdout = out.read(MAX_FILE + 1); stderr = err.read(MAX_FILE + 1)
            return {'stdout': stdout[:MAX_FILE].decode(errors='replace'), 'stderr': stderr[:MAX_FILE].decode(errors='replace'), 'exitCode': process.returncode, 'timedOut': timed_out, 'truncated': len(stdout) > MAX_FILE or len(stderr) > MAX_FILE}
    raise ValueError('Unsupported workspace operation')

def request_error(e):
    if isinstance(e, OSError):
        import errno
        return {'ok': False, 'error': os.strerror(e.errno) if e.errno else 'Workspace access denied', 'code': errno.errorcode.get(e.errno, 'EACCES')}
    return {'ok': False, 'error': str(e), 'code': 'INVALID_REQUEST'}

def request_result(q):
    try:
        result = main(q); result.setdefault('ok', 'error' not in result)
        return result
    except (OSError, ValueError, KeyError) as e:
        return request_error(e)

try:
    result = request_result(json.load(sys.stdin))
except (OSError, ValueError, KeyError) as e:
    result = request_error(e)
print(json.dumps(result, ensure_ascii=False))
