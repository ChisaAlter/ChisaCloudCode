import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { getDatabasePath } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

const INSTALLER_URL = 'https://hiroute.ai/install/standalone.py';
// SHA-256 of the official installer fetched and inspected on 2026-10-19.
const INSTALLER_SHA256 = 'a22592f40b805b38f71b8a0be0a17c57702785c484997c3e26e2b54116f986fd';
const MAX_OUTPUT = 8 * 1024 * 1024;

type HostDependencies = {
  spawn: typeof spawn;
  platform: NodeJS.Platform;
  databasePath: string;
  distro: string;
  wait: (milliseconds: number) => Promise<void>;
};

function hostError(code = 'HIROUTE_HOST_FAILED'): AppError {
  // Child errors, stderr and failed envelopes may contain credentials. Never attach them.
  return new AppError('The managed HiRoute host could not complete the request.', { code, statusCode: 502 });
}

const BOOTSTRAP = String.raw`
import hashlib, json, os, pathlib, pwd, stat, sys
os.umask(0o077)
home = pathlib.Path(pwd.getpwuid(os.getuid()).pw_dir)
root = home / '.local/share/chisacloudcode/hiroute' / sys.argv[1]
def private_directory(p):
    if p.is_symlink():
        raise ValueError('unsafe directory')
    p.mkdir(mode=0o700, parents=True, exist_ok=True)
    if not p.is_dir() or p.stat().st_uid != os.getuid():
        raise ValueError('unsafe directory')
    p.chmod(0o700)
# Check every ancestor before following a pre-existing path.
current = home
for part in root.relative_to(home).parts:
    current = current / part
    private_directory(current)
for name in ('home', 'state', 'bin'):
    private_directory(root / name)
runtime = root / 'runtime'
# Linux sockaddr_un is limited to 108 bytes and the daemon rejects symlink
# runtime roots. A private real short directory is required for long namespaces.
if len(os.fsencode(str(runtime / 'hiroute/agent-grant-v1.sock'))) >= 104:
    parent = pathlib.Path('/tmp') / ('chisa-hiroute-' + str(os.getuid()))
    private_directory(parent)
    short = parent / hashlib.sha256(os.fsencode(str(root))).hexdigest()[:32]
    private_directory(short)
    if os.path.lexists(runtime):
        if not runtime.is_symlink() or os.readlink(runtime) != str(short):
            raise ValueError('unsafe runtime alias')
    else:
        runtime.symlink_to(short, target_is_directory=True)
    runtime = short
else:
    private_directory(runtime)
print(json.dumps({'root': str(root), 'runtime': str(runtime)}))
`;

const ENVIRONMENT = String.raw`
set -euo pipefail
umask 077
root="$1"
runtime="$2"
shift 2
export HOME="$root/home"
export XDG_STATE_HOME="$root/state"
export XDG_RUNTIME_DIR="$runtime"
export XDG_CONFIG_HOME="$HOME/.config"
export XDG_DATA_HOME="$HOME/.local/share"
export PATH="$root/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
cd "$HOME"
`;

const INSTALL = String.raw`
import fcntl, hashlib, json, os, pathlib, platform, pwd, subprocess, sys, tempfile, urllib.request
url, expected = sys.argv[1:3]
home = pathlib.Path.home()
# Only immutable installation assets are shared; each generation retains its own
# marker, HOME, credentials, business state and runtime sockets.
cache = pathlib.Path(pwd.getpwuid(os.getuid()).pw_dir) / '.local/share/chisacloudcode/hiroute/install/0.3.1'
current = pathlib.Path(pwd.getpwuid(os.getuid()).pw_dir)
for part in cache.relative_to(current).parts:
    current = current / part
    if current.is_symlink():
        raise ValueError('unsafe installation directory')
    current.mkdir(mode=0o700, exist_ok=True)
    if current.stat().st_uid != os.getuid():
        raise ValueError('unsafe installation owner')
    current.chmod(0o700)
lockfd = os.open(cache / 'install.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
with os.fdopen(lockfd, 'w') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    cachehome = cache / 'home'
    cachehome.mkdir(mode=0o700, exist_ok=True)
    marker = cachehome / '.local/share/hiroute/standalone.json'
    try:
        facts = json.loads(marker.read_text())
        installed = (facts.get('version') == '0.3.1'
            and (cachehome / '.local/bin/hiroute').is_file()
            and (cachehome / '.local/bin/hirouted').is_file())
    except (OSError, ValueError):
        installed = False
    if not installed:
        target = {'x86_64': 'x86_64', 'aarch64': 'aarch64', 'arm64': 'aarch64'}.get(platform.machine())
        if target is None:
            raise ValueError('unsupported target')
        manifest = 'https://hiroute.ai/releases/0.3.1/hiroute-0.3.1-13856abd873d-' + target + '-unknown-linux-gnu.tar.gz.json'
        with urllib.request.urlopen(url, timeout=30) as response:
            if not response.geturl().startswith('https://hiroute.ai/'):
                raise ValueError('unsafe redirect')
            source = response.read(1024 * 1024 + 1)
        if len(source) > 1024 * 1024 or hashlib.sha256(source).hexdigest() != expected:
            raise ValueError('installer checksum mismatch')
        with tempfile.TemporaryDirectory(dir=cache) as temporary:
            script = pathlib.Path(temporary) / 'standalone.py'
            script.write_bytes(source)
            environment = dict(os.environ, HOME=str(cachehome), XDG_STATE_HOME=str(cache / 'state'),
                XDG_RUNTIME_DIR=str(cache / 'runtime'))
            # The verified installer checks the archive and every payload file against its manifest.
            subprocess.run([sys.executable, str(script), 'install', '--manifest-url', manifest],
                check=True, timeout=270, env=environment)
        facts = json.loads(marker.read_text())
    for name in ('hiroute', 'hirouted'):
        destination = home / '.local/bin' / name
        destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        if not destination.exists():
            destination.symlink_to(cachehome / '.local/bin' / name)
    # HiRoute probes the real CLI against its local loopback challenge. A
    # version shim cannot establish ingress authentication capabilities.
    import base64, io, tarfile
    architecture = {'x86_64': 'x64', 'aarch64': 'arm64', 'arm64': 'arm64'}.get(platform.machine())
    integrities = {
        'x64': 'Q31ekN28viVjgfDuZKXUR5vxIBgUYoLGe+cRmjx/f01omqFDMi6IrgmcK5pWMnRbu/cjsTA/zO+bVES5oY3XUg==',
        'arm64': 'MU3ReK1kjstDmjEOzhFZaphh2AVUKnPaik6lOV0WLs3/mOM7mE/mqkdcQ/Sv0KwHH5MnOhSkIjCEl0/8tr+vRg==',
    }
    if architecture not in integrities:
        raise ValueError('unsupported Claude target')
    claudedir = cache / ('claude-2.1.287-' + architecture)
    claudedir.mkdir(mode=0o700, exist_ok=True)
    binary = claudedir / 'claude'
    checksum = claudedir / 'sha256'
    if not binary.is_file() or not checksum.is_file() or hashlib.sha256(binary.read_bytes()).hexdigest() != checksum.read_text():
        package = 'claude-code-linux-' + architecture
        archive_url = 'https://registry.npmjs.org/@anthropic-ai/' + package + '/-/' + package + '-2.1.287.tgz'
        with urllib.request.urlopen(archive_url, timeout=60) as response:
            if not response.geturl().startswith('https://registry.npmjs.org/'):
                raise ValueError('unsafe Claude redirect')
            archive = response.read(180 * 1024 * 1024 + 1)
        if len(archive) > 180 * 1024 * 1024 or hashlib.sha512(archive).digest() != base64.b64decode(integrities[architecture]):
            raise ValueError('Claude package integrity mismatch')
        with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as package:
            member = package.getmember('package/claude')
            if not member.isfile() or member.size > 300 * 1024 * 1024:
                raise ValueError('invalid Claude binary')
            source = package.extractfile(member).read()
        fd, temporary = tempfile.mkstemp(dir=claudedir)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(source)
        os.chmod(temporary, 0o700)
        os.replace(temporary, binary)
        checksum.write_text(hashlib.sha256(source).hexdigest())
    destination = home.parent / 'bin/claude'
    fd, temporary = tempfile.mkstemp(dir=destination.parent)
    os.close(fd)
    os.unlink(temporary)
    os.symlink(binary, temporary)
    os.replace(temporary, destination)
    localmarker = home / '.local/share/hiroute/standalone.json'
    localmarker.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=localmarker.parent)
    with os.fdopen(fd, 'w') as stream:
        json.dump(facts, stream)
    os.replace(temporary, localmarker)
`;

const START_DAEMON = String.raw`
import hashlib, json, os, pathlib, stat, subprocess
home = pathlib.Path.home()
marker = json.loads((home / '.local/share/hiroute/standalone.json').read_text())
if marker.get('version') != '0.3.1':
    raise ValueError('unexpected version')
cpa = pathlib.Path(marker['cpa_binary'])
expected = marker.get('cpa_sha256', '')
if len(expected) != 64 or hashlib.sha256(cpa.read_bytes()).hexdigest() != expected:
    raise ValueError('CPA checksum mismatch')
log = pathlib.Path(os.environ['XDG_STATE_HOME']) / 'hirouted.log'
fd = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
if not stat.S_ISREG(os.fstat(fd).st_mode) or os.fstat(fd).st_nlink != 1:
    os.close(fd)
    raise ValueError('unsafe log')
os.fchmod(fd, 0o600)
with os.fdopen(fd, 'ab') as output:
    child = subprocess.Popen([str(home / '.local/bin/hirouted'), '--role', 'all', '--standalone',
        '--cpa-binary', str(cpa), '--cpa-sha256', expected],
        stdin=subprocess.DEVNULL, stdout=output, stderr=output, start_new_session=True, close_fds=True)
    pidfile = pathlib.Path(os.environ['XDG_STATE_HOME']) / 'hirouted.pid'
    pidfd = os.open(pidfile, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(pidfd, 'w') as stream:
        stream.write(str(child.pid))
`;

const DISPOSE = String.raw`
import os, pathlib, signal, time
pidfile = pathlib.Path(os.environ['XDG_STATE_HOME']) / 'hirouted.pid'
try:
    pid = int(pidfile.read_text())
    proc = pathlib.Path('/proc') / str(pid)
    command = (proc / 'cmdline').read_bytes().split(b'\0')
    environment = (proc / 'environ').read_bytes().split(b'\0')
    if command[0] != os.fsencode(str(pathlib.Path.home() / '.local/bin/hirouted')) or \
        os.fsencode('HOME=' + str(pathlib.Path.home())) not in environment:
        raise ValueError('daemon identity mismatch')
    os.kill(pid, signal.SIGTERM)
    for _ in range(50):
        if not proc.exists():
            break
        time.sleep(0.1)
except FileNotFoundError:
    pass
pidfile.unlink(missing_ok=True)
`;

const GRANT = String.raw`
import os, pathlib, socket, struct, sys
context = sys.stdin.read(65536)
connection = ('agent-connection/' + context).encode('utf-8')
if not context or len(connection) > 65535:
    raise ValueError('invalid context')
with socket.socket(socket.AF_UNIX) as sock:
    sock.settimeout(30)
    sock.connect(str(pathlib.Path(os.environ['XDG_RUNTIME_DIR']) / 'hiroute/agent-grant-v1.sock'))
    sock.sendall(b'HIRAGENT' + struct.pack('>HH', 1, len(connection)) + connection)
    sock.shutdown(socket.SHUT_WR)
    data = bytearray()
    while True:
        chunk = sock.recv(4096)
        if not chunk:
            break
        data.extend(chunk)
        if len(data) > 65536:
            raise ValueError('oversized grant')
    sys.stdout.buffer.write(data)
`;

const BRIDGE = String.raw`
import json, os, pathlib, sys, tempfile
raw = sys.stdin.read(1024 * 1024 + 1)
if len(raw.encode('utf-8')) > 1024 * 1024:
    raise ValueError('oversized credentials')
parent = pathlib.Path.home() / '.claude'
if parent.is_symlink():
    raise ValueError('unsafe credentials parent')
parent.mkdir(mode=0o700, exist_ok=True)
parent.chmod(0o700)
destination = parent / '.credentials.json'
if not raw:
    destination.unlink(missing_ok=True)
else:
    value = json.loads(raw)
    def access_only(item):
        if isinstance(item, dict):
            return all('refresh' not in key.lower() and access_only(val) for key, val in item.items())
        if isinstance(item, list):
            return all(access_only(val) for val in item)
        return True
    if not isinstance(value, dict) or not access_only(value):
        raise ValueError('credentials must be access only')
    fd, temporary = tempfile.mkstemp(dir=parent, prefix='.credentials-')
    try:
        with os.fdopen(fd, 'w') as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, destination)
    finally:
        if os.path.lexists(temporary):
            os.unlink(temporary)
`;

/** Providers' managed HiRoute orchestrator uses this private Linux host for isolated per-user execution. */
export async function createHiRouteHost(userId: number, generation = 'default', overrides: Partial<HostDependencies> = {}, signal?: AbortSignal) {
  if (!Number.isSafeInteger(userId) || userId <= 0 || typeof generation !== 'string' || generation.length > 4096) {
    throw hostError('HIROUTE_HOST_INVALID_ID');
  }
  const dependencies: HostDependencies = {
    spawn,
    platform: process.platform,
    databasePath: getDatabasePath(),
    distro: process.env.CHISA_WSL_DISTRO || 'ChisaCloudCode',
    wait: (milliseconds) => new Promise(resolve => setTimeout(resolve, milliseconds)),
    ...overrides,
  };
  if (dependencies.platform !== 'win32' && dependencies.platform !== 'linux') throw hostError('HIROUTE_HOST_UNSUPPORTED');
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  const namespace = `${digest(path.resolve(dependencies.databasePath))}/${userId}/${digest(generation)}`;

  async function execute(script: string, args: string[] = [], input = '', timeout = 120_000, cancellable = true): Promise<string> {
    if (cancellable && signal?.aborted) throw hostError('HIROUTE_HOST_ABORTED');
    return new Promise((resolve, reject) => {
      let settled = false;
      let output = '';
      let size = 0;
      let child: ReturnType<typeof spawn>;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: AppError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (cancellable) signal?.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve(output);
      };
      const terminate = () => {
        try {
          if (dependencies.platform === 'linux' && child.pid) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch { /* The child may already have exited. */ }
      };
      const abort = () => { terminate(); finish(hostError('HIROUTE_HOST_ABORTED')); };
      try {
        // No inherited provider credentials or Claude configuration overrides cross this boundary.
        const environment: NodeJS.ProcessEnv = {};
        for (const name of dependencies.platform === 'win32'
          ? ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA']
          : ['LANG']) {
          if (process.env[name]) environment[name] = process.env[name];
        }
        const shellArgs = ['/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', 'LANG=C.UTF-8',
          '/usr/bin/timeout', '--signal=KILL', `${Math.ceil(timeout / 1000)}s`,
          '/bin/bash', '--noprofile', '--norc', '-c', script, 'chisa-hiroute', ...args];
        child = dependencies.spawn(dependencies.platform === 'win32' ? 'wsl.exe' : shellArgs.shift()!,
          dependencies.platform === 'win32' ? ['--distribution', dependencies.distro, '--exec', ...shellArgs] : shellArgs,
          { env: environment, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: dependencies.platform === 'linux' });
        timer = setTimeout(() => { terminate(); finish(hostError('HIROUTE_HOST_TIMEOUT')); }, timeout);
        child.stdout!.setEncoding('utf8');
        child.stdout!.on('data', (chunk: string) => {
          size += Buffer.byteLength(chunk);
          if (size > MAX_OUTPUT) { terminate(); finish(hostError('HIROUTE_HOST_OUTPUT_LIMIT')); }
          else output += chunk;
        });
        // Drain, but never retain or expose stderr, even for malformed machine output.
        child.stderr!.resume();
        child.on('error', () => finish(hostError()));
        child.on('close', code => finish(code === 0 ? undefined : hostError()));
        child.stdin!.on('error', () => finish(hostError()));
        if (cancellable) signal?.addEventListener('abort', abort, { once: true });
        if (cancellable && signal?.aborted) abort();
        if (!settled) child.stdin!.end(input);
      } catch { finish(hostError()); }
    });
  }

  let locations: { root: string; runtime: string };
  try {
    locations = JSON.parse(await execute('exec python3 -c "$1" "$2"', [BOOTSTRAP, namespace]));
    if (!locations || !path.posix.isAbsolute(locations.root) || !path.posix.isAbsolute(locations.runtime)) throw hostError();
  } catch {
    if (signal?.aborted) throw hostError('HIROUTE_HOST_ABORTED');
    throw hostError();
  }

  const run = (script: string, args: string[] = [], input = '', timeout = 120_000, cancellable = true) =>
    execute(ENVIRONMENT + '\n' + script, [locations.root, locations.runtime, ...args], input, timeout, cancellable);

  function unwrap(output: string): any {
    let envelope: any;
    try { envelope = JSON.parse(output); } catch { throw hostError('HIROUTE_HOST_INVALID_RESPONSE'); }
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
      || envelope.schema_version?.major !== 2
      || !['succeeded', 'accepted'].includes(envelope.status)
      || !Object.hasOwn(envelope, 'data') || envelope.error) throw hostError('HIROUTE_HOST_INVALID_RESPONSE');
    if (envelope.operation !== undefined) {
      if (!envelope.data || typeof envelope.data !== 'object' || Array.isArray(envelope.data)
        || !envelope.operation || typeof envelope.operation !== 'object' || Array.isArray(envelope.operation)) {
        throw hostError('HIROUTE_HOST_INVALID_RESPONSE');
      }
      return { ...envelope.data, operation: envelope.operation };
    }
    return envelope.data;
  }

  async function cli(args: string[], data?: unknown): Promise<any> {
    if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw hostError();
    let input = '';
    if (data !== undefined) {
      try { input = JSON.stringify(data); } catch { throw hostError(); }
      if (typeof input !== 'string' || Buffer.byteLength(input) > MAX_OUTPUT) throw hostError();
    }
    return unwrap(await run('exec "$HOME/.local/bin/hiroute" "$@"',
      [...args, ...(data === undefined ? [] : ['--request-stdin']), '--output', 'json'], input));
  }

  let ensuring: Promise<void> | undefined;
  async function healthy(): Promise<boolean> {
    try {
      return unwrap(await run('exec "$HOME/.local/bin/hiroute" service status --output json', [], '', 5_000))?.local_control_ready === true;
    }
    catch { return false; }
  }

  return {
    namespace,
    cli,
    async secret(candidate: string, key: string): Promise<any> {
      if (typeof candidate !== 'string' || !/^candidate\/[A-Za-z0-9._/-]{1,512}$/.test(candidate)
        || typeof key !== 'string' || !key || Buffer.byteLength(key) > 512 || key.includes('\0')) throw hostError();
      // WSL stdin is a socket that Rust cannot reopen via /dev/fd. A local pipe
      // makes fd3 reopenable without writing credentials to disk.
      return unwrap(await run('cat | (exec 3<&0; exec "$HOME/.local/bin/hiroute" protected-input register --candidate "$1" --secret-fd 3 --output json)', [candidate], key));
    },
    async grant(contextId: string): Promise<string> {
      if (typeof contextId !== 'string' || !contextId || /[\s\x00-\x1f\x7f]/.test(contextId)
        || Buffer.byteLength(contextId) > 65000) throw hostError();
      const token = (await run('exec python3 -c "$1"', [GRANT], contextId)).trim();
      if (!token || /[\s\x00-\x1f\x7f]/.test(token) || Buffer.byteLength(token) > 65536) throw hostError();
      return token;
    },
    async bridgeCredentials(accessOnlyJson: string | null): Promise<void> {
      if (accessOnlyJson !== null && (typeof accessOnlyJson !== 'string' || !accessOnlyJson
        || Buffer.byteLength(accessOnlyJson) > 1024 * 1024)) throw hostError();
      await run('exec python3 -c "$1"', [BRIDGE], accessOnlyJson ?? '');
    },
    /** Application shutdown only: callers must let in-flight gateway sessions finish first. */
    async dispose(): Promise<void> {
      if (ensuring) await ensuring.catch(() => undefined);
      await run('exec python3 -c "$1"', [DISPOSE], '', 120_000, false);
    },
    async ensure(): Promise<void> {
      if (!ensuring) {
        ensuring = (async () => {
          await run('exec python3 -c "$1" "$2" "$3"', [INSTALL, INSTALLER_URL, INSTALLER_SHA256], '', 300_000);
          if (await healthy()) return;
          if (signal?.aborted) throw hostError('HIROUTE_HOST_ABORTED');
          await run('exec python3 -c "$1"', [START_DAEMON]);
          for (const delay of [100, 200, 400, 800, 1600, 2400, 3200, 4000, 5000]) {
            if (signal?.aborted) throw hostError('HIROUTE_HOST_ABORTED');
            await dependencies.wait(delay);
            if (signal?.aborted) throw hostError('HIROUTE_HOST_ABORTED');
            if (await healthy()) return;
          }
          throw hostError('HIROUTE_HOST_NOT_READY');
        })().finally(() => { ensuring = undefined; });
      }
      await ensuring;
    },
  };
}
