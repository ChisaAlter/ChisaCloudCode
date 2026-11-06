#!/usr/bin/env python3
"""Linux root integration: real Unix SO_PEERCRED and /proc birth observation."""
import http.client
import importlib.util
import json
import os
import pathlib
import shutil
import socket
import tempfile
import threading
import time
import unittest

SPEC = importlib.util.spec_from_file_location('authority_peer_front', pathlib.Path(__file__).with_name('peer-front.py'))
FRONT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(FRONT)


class UnixConnection(http.client.HTTPConnection):
    def __init__(self, location):
        super().__init__('localhost', timeout=5)
        self.location = location
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect(self.location)


@unittest.skipUnless(os.name == 'posix' and os.getuid() == 0 and hasattr(socket, 'SO_PEERCRED'), 'Linux root SO_PEERCRED required')
class FrontIdentityTest(unittest.TestCase):
    def setUp(self):
        self.base = tempfile.mkdtemp(prefix='chisa-authority-peer-')
        self.observed = []
        self.original = FRONT.private_request
        def capture(location, route, envelope):
            self.observed.append((location, route, envelope))
            return 200, {'received': True, 'route': route}
        FRONT.private_request = capture
        self.server = FRONT.FrontServer({'socketPath': self.base + '/front.sock', 'privateSocketPath': self.base + '/private.sock', 'previewSocketPath': self.base + '/preview.sock', 'apiUid': os.getuid()})
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        FRONT.private_request = self.original
        self.assertEqual(pathlib.Path(self.base).parent, pathlib.Path(tempfile.gettempdir()))
        shutil.rmtree(self.base)
    def request(self, route, body):
        connection = UnixConnection(self.base + '/front.sock')
        try:
            encoded = json.dumps(body).encode()
            connection.request('POST', route, encoded, {'Content-Type': 'application/json', 'Content-Length': str(len(encoded))})
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()
    def test_real_kernel_peer_and_birth_are_observed_without_api_pid(self):
        self.assertEqual(self.request('/v1/begin', {'ticket': 'a' * 64})[0], 200)
        observation = self.observed[0][2]['observation']
        self.assertEqual(observation['peer'], FRONT.birth(os.getpid())[0])
        self.assertNotIn('parent', observation)
    def test_caller_claimed_pid_or_birth_is_denied_before_private_authority(self):
        for field in ('peer', 'parent', 'pid', 'writer', 'proof', 'observation', 'register', 'mounts', 'image', 'uid'):
            self.assertEqual(self.request('/v1/begin', {'ticket': 'a' * 64, field: 1})[0], 403)
        self.assertEqual(self.observed, [])
    def test_native_release_parent_is_kernel_observed(self):
        self.assertEqual(self.request('/v1/release', {'purpose': 'live-writer-release'})[0], 200)
        self.assertEqual(self.observed[0][2]['observation']['parent'], FRONT.birth(os.getppid())[0])
    def test_incomplete_headers_are_bounded_before_handler_and_capacity_recovers(self):
        pending = []
        try:
            for _ in range(32):
                connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                connection.settimeout(2)
                connection.connect(self.base + '/front.sock')
                connection.sendall(b'POST /v1/begin HTTP/1.1\r\nX-Incomplete: ')
                pending.append(connection)
            limit = time.monotonic() + 2
            while self.server.capacity._value != 0 and time.monotonic() < limit:
                time.sleep(0.01)
            self.assertEqual(self.server.capacity._value, 0)
            rejected = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            rejected.settimeout(2)
            try:
                rejected.connect(self.base + '/front.sock')
                rejected.sendall(b'POST /v1/begin HTTP/1.1\r\n')
                try:
                    self.assertEqual(rejected.recv(1), b'')
                except ConnectionResetError:
                    pass
            finally:
                rejected.close()
            self.assertEqual(self.observed, [])
        finally:
            for connection in pending:
                connection.close()
        limit = time.monotonic() + 2
        while self.server.capacity._value != 32 and time.monotonic() < limit:
            time.sleep(0.01)
        self.assertEqual(self.server.capacity._value, 32)
        self.assertEqual(self.request('/v1/begin', {'ticket': 'a' * 64})[0], 200)
    def test_preview_public_routes_use_separate_fixed_private_signer(self):
        for public, private in (('/v1/preview-ticket', '/v1/ticket'), ('/v1/preview-close', '/v1/close')):
            self.assertEqual(self.request(public, {'operationId': 'operation'})[0], 200)
            location, route, envelope = self.observed[-1]
            self.assertEqual(location, self.base + '/preview.sock')
            self.assertEqual(route, private)
            self.assertEqual(envelope['observation']['peer'], FRONT.birth(os.getpid())[0])


if __name__ == '__main__':
    unittest.main()
