#!/usr/bin/env python3
"""Root-only Unix peer boundary. No supplied PID, proof or host registration is trusted."""
import argparse
import grp
import http.client
import http.server
import json
import os
import re
import socket
import socketserver
import stat
import struct
import subprocess
import threading


def protected(location, kind='file'):
    if not isinstance(location, str) or not location.startswith('/') or os.path.normpath(location) != location or os.path.realpath(location) != location:
        raise ValueError('AUTHORITY_FRONT_PATH')
    current = '/'
    for part in location.split('/')[1:]:
        current = os.path.join(current, part)
        info = os.lstat(current)
        final = current == location
        sticky = not final and info.st_uid == 0 and stat.S_ISDIR(info.st_mode) and info.st_mode & stat.S_ISVTX
        if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or (info.st_mode & 0o022 and not sticky and not (final and kind == 'socket')):
            raise ValueError('AUTHORITY_FRONT_UNTRUSTED')
        if not final and not stat.S_ISDIR(info.st_mode):
            raise ValueError('AUTHORITY_FRONT_PARENT')
    if kind == 'file' and (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 1048576):
        raise ValueError('AUTHORITY_FRONT_FILE')
    if kind == 'socket' and not stat.S_ISSOCK(info.st_mode):
        raise ValueError('AUTHORITY_FRONT_SOCKET')
    if kind == 'directory' and not stat.S_ISDIR(info.st_mode):
        raise ValueError('AUTHORITY_FRONT_DIRECTORY')
    return info


def read_config(filename):
    original = protected(filename)
    fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        before = os.fstat(fd)
        if (before.st_dev, before.st_ino) != (original.st_dev, original.st_ino):
            raise ValueError('AUTHORITY_FRONT_REPLACED')
        with os.fdopen(fd, 'rb', closefd=False) as source:
            data = source.read(1048577)
        after = os.fstat(fd)
        named = protected(filename)
        if len(data) > 1048576 or (before.st_dev, before.st_ino) != (named.st_dev, named.st_ino) or (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise ValueError('AUTHORITY_FRONT_CHANGED')
        value = json.loads(data)
        if value.get('version') != 1 or type(value.get('apiUid')) is not int or value['apiUid'] < 0:
            raise ValueError('AUTHORITY_FRONT_CONFIG')
        return value
    finally:
        os.close(fd)


def peer_namespace(pid, uid, gid):
    # The fixed child adopts the kernel-observed peer credentials. It needs no
    # SYS_PTRACE capability and cannot select another command, file or action.
    helper = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'read-peer-namespace.py')
    protected(helper)
    result = subprocess.run(['/usr/bin/python3', '-I', '-S', helper, str(pid), str(uid), str(gid)],
                            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            timeout=1, check=True, cwd='/', env={'LANG': 'C'})
    if len(result.stdout) > 128 or not re.fullmatch(rb'pid:\[[0-9]{1,20}\]\n', result.stdout):
        raise ValueError('AUTHORITY_FRONT_NAMESPACE')
    return result.stdout.decode('ascii').strip()


def birth(pid):
    if type(pid) is not int or pid <= 0:
        raise ValueError('AUTHORITY_FRONT_PID')
    with open('/proc/self/stat', encoding='utf-8') as stream:
        if int(stream.read().split(' ', 1)[0]) != os.getpid():
            raise ValueError('AUTHORITY_FRONT_PROC_VIEW')
    def sample():
        with open('/proc/' + str(pid) + '/stat', encoding='utf-8') as stream:
            fields = stream.read().rsplit(')', 1)[1].split()
        if len(fields) <= 19 or fields[0] in ('Z', 'X'):
            raise ValueError('AUTHORITY_FRONT_DEAD_PEER')
        with open('/proc/' + str(pid) + '/status', encoding='utf-8') as stream:
            status = stream.read()
        uid = int(re.search(r'^Uid:\s+\d+\s+(\d+)\s', status, re.M).group(1))
        gid = int(re.search(r'^Gid:\s+\d+\s+(\d+)\s', status, re.M).group(1))
        with open('/proc/sys/kernel/random/boot_id', encoding='utf-8') as stream:
            boot = stream.read().strip()
        return {'pid': pid, 'uid': uid, 'gid': gid, 'processStartTime': fields[19], 'bootId': boot,
                'pidNamespace': os.readlink('/proc/' + str(pid) + '/ns/pid') if uid == os.geteuid() else peer_namespace(pid, uid, gid)}, int(fields[1])
    first = sample()
    if sample() != first:
        raise ValueError('AUTHORITY_FRONT_BIRTH_CHANGED')
    return first


def private_request(location, route, body):
    pin = protected(location, 'socket')
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    connection.settimeout(25)
    try:
        connection.connect(location)
        _, uid, _ = struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i')))
        if uid != 0:
            raise ValueError('AUTHORITY_FRONT_PEER')
        encoded = json.dumps(body, separators=(',', ':')).encode()
        connection.sendall(('POST ' + route + ' HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ' + str(len(encoded)) + '\r\n\r\n').encode() + encoded)
        response = http.client.HTTPResponse(connection)
        response.begin()
        data = response.read(1048577)
        named = protected(location, 'socket')
        if len(data) > 1048576 or (pin.st_dev, pin.st_ino) != (named.st_dev, named.st_ino):
            raise ValueError('AUTHORITY_FRONT_RESPONSE')
        value = json.loads(data)
        return response.status, value
    finally:
        connection.close()


class FrontServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    request_queue_size = 32
    def __init__(self, config):
        self.config = config
        self.capacity = threading.BoundedSemaphore(32)
        super().__init__(config['socketPath'], FrontHandler)
    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(5)
        return connection, address
    def process_request(self, request, client_address):
        # Reserve before BaseHTTPRequestHandler reads even its first header.
        if not self.capacity.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.capacity.release()
            self.shutdown_request(request)
            raise
    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.capacity.release()


class FrontHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def log_message(self, *_args):
        return
    def do_POST(self):
        try:
            if self.path not in ('/v1/begin', '/v1/lookup', '/v1/grant', '/v1/end', '/v1/release', '/v1/preview-ticket', '/v1/preview-close') or self.headers.get('Content-Type') != 'application/json' or self.headers.get('Transfer-Encoding') is not None:
                raise ValueError('AUTHORITY_FRONT_REQUEST')
            if len(self.headers.get_all('Content-Length', [])) != 1:
                raise ValueError('AUTHORITY_FRONT_LENGTH')
            length = int(self.headers['Content-Length'])
            if not 0 < length <= 16384:
                raise ValueError('AUTHORITY_FRONT_LIMIT')
            self.connection.settimeout(25)
            pid, uid, gid = struct.unpack('3i', self.connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i')))
            observed, parent_pid = birth(pid)
            if uid != self.server.config['apiUid'] or observed['uid'] != uid or observed['gid'] != gid:
                raise ValueError('AUTHORITY_FRONT_IDENTITY')
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise ValueError('AUTHORITY_FRONT_TRUNCATED')
            body = json.loads(raw)
            if not isinstance(body, dict) or any(key in body for key in ('peer', 'parent', 'pid', 'writer', 'proof', 'observation', 'register', 'mounts', 'image', 'uid')):
                raise ValueError('AUTHORITY_FRONT_UNTRUSTED_INPUT')
            observation = {'peer': observed}
            if self.path == '/v1/release':
                parent, _ = birth(parent_pid)
                observation['parent'] = parent
            if birth(pid)[0] != observed:
                raise ValueError('AUTHORITY_FRONT_BIRTH_CHANGED')
            if self.path in ('/v1/preview-ticket', '/v1/preview-close'):
                route = '/v1/ticket' if self.path == '/v1/preview-ticket' else '/v1/close'
                status, result = private_request(self.server.config['previewSocketPath'], route, {'request': body, 'observation': observation})
            else:
                status, result = private_request(self.server.config['privateSocketPath'], self.path, {'request': body, 'observation': observation})
            self.finish_json(status, result)
        except Exception:
            self.finish_json(403, {'error': 'AUTHORITY_PEER_DENIED'})
    def finish_json(self, status, value):
        encoded = json.dumps(value, separators=(',', ':')).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(encoded)))
        self.send_header('Connection', 'close')
        self.end_headers()
        self.wfile.write(encoded)
        self.close_connection = True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('config')
    arguments = parser.parse_args()
    if os.name != 'posix' or os.getuid() != 0 or not hasattr(socket, 'SO_PEERCRED'):
        raise ValueError('AUTHORITY_FRONT_LINUX_ROOT_REQUIRED')
    os.umask(0o077)
    config = read_config(arguments.config)
    protected(os.path.dirname(config['socketPath']), 'directory')
    protected(config['privateSocketPath'], 'socket')
    if os.path.lexists(config['socketPath']):
        raise ValueError('AUTHORITY_FRONT_SOCKET_EXISTS')
    server = FrontServer(config)
    group = config.get('clientGroupId')
    if group is not None:
        if type(group) is not int or group < 0:
            raise ValueError('AUTHORITY_FRONT_GROUP')
        os.chown(config['socketPath'], 0, group)
    os.chmod(config['socketPath'], 0o600 if group is None else 0o660)
    pin = os.lstat(config['socketPath'])
    try:
        print(json.dumps({'event': 'workspace-authority-front-listening', 'version': 1}), flush=True)
        server.serve_forever()
    finally:
        server.server_close()
        named = os.lstat(config['socketPath'])
        if stat.S_ISSOCK(named.st_mode) and (pin.st_dev, pin.st_ino) == (named.st_dev, named.st_ino):
            os.unlink(config['socketPath'])


if __name__ == '__main__':
    main()
