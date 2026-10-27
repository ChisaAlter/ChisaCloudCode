import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import test, { mock } from 'node:test';

const realSpawnSync = childProcess.spawnSync;
let launch: (command: string, args: readonly string[], options: childProcess.SpawnSyncOptionsWithStringEncoding) => childProcess.SpawnSyncReturns<string>;
const spawnMock = mock.method(childProcess, 'spawnSync', (command: string, args: readonly string[], options: childProcess.SpawnSyncOptionsWithStringEncoding) => launch(command, args, options));
syncBuiltinESMExports();
test.after(() => { spawnMock.mock.restore(); syncBuiltinESMExports(); });
const { cloudWriterGateAvailable, claimCloudWriterLease, releaseCloudWriterLease } = await import('../workspace-writer-gate.service.js');
const lease = { owner: 'claude', id: 'run-1', epoch: 'epoch-1', pid: 123, processStartTime: '456', bootId: 'd3c6d7f8-71aa-4d99-b321-bb6321d8f3a0', mayWrite: false };
let helperScript = '';
function reply(value: unknown, extras: Partial<childProcess.SpawnSyncReturns<string>> = {}): childProcess.SpawnSyncReturns<string> {
  const stdout = JSON.stringify(value);
  return { pid: 1, status: 0, signal: null, output: [null, stdout, ''], stdout, stderr: '', ...extras };
}

test('writer gate wrappers are Linux-only and never select legacy admission after an unconfirmed result', async t => {
  const platform = mock.method(os, 'platform', () => 'linux' as NodeJS.Platform);
  try {
    await t.test('passes exact lease as JSON and bounds the synchronous helper without shell evaluation', () => {
      const calls: Array<Record<string, unknown>> = [];
      launch = (command, args, options) => {
        assert.equal(command, 'python3');
        assert.deepEqual(args.slice(0, 2), ['-I', '-c']);
        assert.equal(options.timeout, 2500);
        assert.equal(options.killSignal, 'SIGKILL');
        assert.equal(options.maxBuffer, 65_536);
        assert.equal(options.shell, undefined);
        helperScript = args[2];
        const input = JSON.parse(String(options.input));
        calls.push(input);
        return reply(input.action === 'release' ? { ok: true, released: true } : { ok: true, available: true });
      };
      const root = '/workspace/a path;$(untouched)';
      assert.equal(cloudWriterGateAvailable(root, lease.epoch), true);
      assert.equal(claimCloudWriterLease(root, lease), true);
      releaseCloudWriterLease(root, lease);
      assert.deepEqual(calls, [
        { action: 'available', root, epoch: lease.epoch },
        { action: 'claim', root, epoch: lease.epoch, lease },
        { action: 'release', root, epoch: lease.epoch, lease },
      ]);
    });
    await t.test('returns false only for an explicit unavailable capability', () => {
      launch = () => reply({ ok: true, available: false });
      assert.equal(cloudWriterGateAvailable('/workspace', lease.epoch), false);
      assert.equal(claimCloudWriterLease('/workspace', lease), false);
      assert.throws(() => releaseCloudWriterLease('/workspace', lease), { code: 'WORKSPACE_WRITER_GATE_UNAVAILABLE' });
    });
    await t.test('retains structured busy, dirty-generation, cleanup and damaged-capability failures', () => {
      for (const [code, statusCode] of [
        ['WORKSPACE_BUSY', 409], ['WORKSPACE_RECOVERY_REQUIRED', 409], ['WORKSPACE_CLEANUP_FAILED', 503],
        ['WORKSPACE_LEASE_INVALID', 400], ['WORKSPACE_WRITER_GATE_INVALID', 503],
      ] as const) {
        launch = () => reply({ ok: false, code, error: 'retained barrier' });
        assert.throws(() => cloudWriterGateAvailable('/workspace', lease.epoch), { code, statusCode });
        assert.throws(() => claimCloudWriterLease('/workspace', lease), { code, statusCode });
        assert.throws(() => releaseCloudWriterLease('/workspace', lease), { code, statusCode });
      }
    });
    await t.test('timeout, failed process, malformed output and incomplete success all fail closed', () => {
      for (const result of [
        reply({ ok: true, available: true }, { error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }), signal: 'SIGKILL', status: null }),
        reply({ ok: true, available: true }, { status: 1 }),
        reply({}, { stdout: 'not json' }), reply(null), reply({ ok: true }),
      ]) {
        launch = () => result;
        assert.throws(() => cloudWriterGateAvailable('/workspace', lease.epoch), { code: 'WORKSPACE_WRITER_GATE_UNAVAILABLE' });
        assert.throws(() => claimCloudWriterLease('/workspace', lease), { code: 'WORKSPACE_WRITER_GATE_UNAVAILABLE' });
      }
      launch = () => { throw new Error('spawn failed'); };
      assert.throws(() => claimCloudWriterLease('/workspace', lease), { code: 'WORKSPACE_WRITER_GATE_UNAVAILABLE' });
    });
    await t.test('non-Linux hosts cannot advertise or release cloud writer support', () => {
      platform.mock.mockImplementation(() => 'win32');
      launch = () => { throw new Error('must not start Python on non-Linux'); };
      assert.equal(cloudWriterGateAvailable('/workspace', lease.epoch), false);
      assert.equal(claimCloudWriterLease('/workspace', lease), false);
      assert.throws(() => releaseCloudWriterLease('/workspace', lease), { code: 'WORKSPACE_WRITER_GATE_UNAVAILABLE' });
    });
  } finally { platform.mock.restore(); }
});

// Kept in this test so Linux CI exercises the exact embedded helper, real flock,
// durable filesystem state, and process birth checks without a Python mock.
// The same script can be run directly under WSL when the host Node is Windows.
const pythonIntegrationScript = String.raw`
import contextlib, fcntl, json, os, pathlib, stat, subprocess, sys, tempfile, unittest
GATE = sys.stdin.read()
EPOCH = 'fixture-epoch'
BOOT = pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()
BIRTH = pathlib.Path('/proc/self/stat').read_text().rsplit(')', 1)[1].split()[19]

def write_json(file, value):
    file.write_text(json.dumps(value))
    file.chmod(0o600)

def call(root, action='available', lease=None, epoch=EPOCH, script=GATE):
    request = {'root': str(root), 'action': action, 'epoch': epoch}
    if lease is not None: request['lease'] = lease
    result = subprocess.run([sys.executable, '-I', '-c', script], input=json.dumps(request), capture_output=True, text=True, timeout=5)
    if result.returncode != 0: raise AssertionError('helper failed: ' + result.stderr)
    return json.loads(result.stdout)

@contextlib.contextmanager
def fixture():
    with tempfile.TemporaryDirectory(prefix='chisa-writer-gate-') as temporary:
        parent = pathlib.Path(temporary).resolve()
        root = parent / 'project'
        root.mkdir()
        cap = pathlib.Path(str(root) + '.chisa-writer-capability.json')
        gen = pathlib.Path(str(root) + '.chisa-generation.json')
        guard = pathlib.Path(str(root) + '.chisa-writer.guard')
        write_json(root / '.chisa-bridge.json', {'bindingEpoch': EPOCH})
        write_json(cap, {'version': 1, 'root': str(root), 'protocol': 'chisa-writer-gate-v1', 'engineVersion': '0.18.1-chisa.5', 'bindingEpoch': EPOCH})
        write_json(gen, {'version': 1, 'root': str(root), 'generation': 'a' * 64, 'state': 'complete', 'writer': 'mutagen', 'updatedAt': '2026-10-22T12:00:00Z'})
        guard.touch(mode=0o600)
        lease = {'owner': 'claude', 'id': 'fixture-run', 'epoch': EPOCH, 'pid': os.getpid(), 'processStartTime': BIRTH, 'bootId': BOOT, 'mayWrite': False}
        yield root, cap, gen, guard, lease

def state_path(root): return pathlib.Path(str(root) + '.chisa-lease') / 'state.json'

class GateTests(unittest.TestCase):
    def error(self, response, code):
        self.assertFalse(response.get('ok'), response)
        self.assertEqual(response.get('code'), code, response)

    def test_claim_release_keeps_guard_inode_and_publishes_fresh_complete_generation(self):
        with fixture() as (root, cap, gen, guard, lease):
            inode = guard.stat().st_ino
            self.assertTrue(call(root)['available'])
            self.assertTrue(call(root, 'claim', lease)['available'])
            self.assertEqual(json.loads(state_path(root).read_text()), lease)
            dirty = json.loads(gen.read_text())
            self.assertEqual((dirty['state'], dirty['writer'], dirty['leaseId'], dirty['bindingEpoch']), ('dirty', 'cloud', lease['id'], EPOCH))
            self.assertEqual(stat.S_IMODE(state_path(root).stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(state_path(root).parent.stat().st_mode), 0o700)
            self.assertTrue(call(root)['available'])
            self.error(call(root, 'claim', lease), 'WORKSPACE_BUSY')
            (root / 'edited.txt').write_text('cloud edit')
            self.assertTrue(call(root, 'release', lease)['released'])
            complete = json.loads(gen.read_text())
            self.assertEqual(complete['state'], 'complete')
            self.assertNotEqual(dirty['generation'], complete['generation'])
            self.assertFalse(state_path(root).parent.exists())
            self.assertEqual(guard.stat().st_ino, inode)
            lease['id'] = 'second-run'
            self.assertTrue(call(root, 'claim', lease)['available'])
            self.assertTrue(call(root, 'release', lease)['released'])
            self.assertEqual(guard.stat().st_ino, inode)

    def test_server_owned_cloud_capability_claims_and_releases_without_native_engine(self):
        with fixture() as (root, cap, gen, guard, lease):
            write_json(root / '.chisa-bridge.json', {'protocol': 3, 'root': str(root), 'owner': 'cloud-fixture', 'bindingEpoch': EPOCH})
            write_json(cap, {'version': 1, 'root': str(root), 'protocol': 'chisa-cloud-writer-v1', 'bindingEpoch': EPOCH})
            generation = json.loads(gen.read_text()); generation['writer'] = 'cloud'; write_json(gen, generation)
            inode = guard.stat().st_ino
            self.assertTrue(call(root)['available'])
            self.assertTrue(call(root, 'claim', lease)['available'])
            self.assertEqual(json.loads(state_path(root).read_text()), lease)
            self.assertEqual(json.loads(gen.read_text())['state'], 'dirty')
            self.assertTrue(call(root, 'release', lease)['released'])
            self.assertEqual(json.loads(gen.read_text())['state'], 'complete')
            self.assertFalse(state_path(root).parent.exists())
            self.assertEqual(guard.stat().st_ino, inode)

    def test_legacy_fallback_only_when_gate_metadata_has_never_been_installed(self):
        with fixture() as (root, cap, gen, guard, lease):
            cap.unlink()
            self.error(call(root), 'WORKSPACE_WRITER_GATE_INVALID')
            gen.unlink()
            self.error(call(root), 'WORKSPACE_WRITER_GATE_INVALID')
            guard.unlink()
            self.assertEqual(call(root), {'ok': True, 'available': False})
            self.assertEqual(call(root, 'claim', lease), {'ok': True, 'available': False})
            self.assertFalse(state_path(root).parent.exists())
            self.error(call(root, 'release', lease), 'WORKSPACE_WRITER_GATE_INVALID')

    def test_missing_guard_or_generation_cannot_be_recreated_by_cloud(self):
        for suffix in ('guard', 'generation'):
            with self.subTest(suffix=suffix), fixture() as (root, cap, gen, guard, lease):
                target = guard if suffix == 'guard' else gen
                target.unlink()
                self.error(call(root, 'claim', lease), 'WORKSPACE_WRITER_GATE_INVALID')
                self.assertFalse(target.exists())
                self.assertFalse(state_path(root).parent.exists())

    def test_invalid_capability_epoch_binding_and_generation_never_fall_back(self):
        for key, value in [('version', 2), ('version', True), ('root', '/wrong'), ('protocol', 'wrong'), ('engineVersion', '0.18.1-chisa.3'), ('engineVersion', '0.18.1-chisa.4'), ('bindingEpoch', 'old')]:
            with self.subTest(key=key, value=value), fixture() as (root, cap, gen, guard, lease):
                data = json.loads(cap.read_text()); data[key] = value; write_json(cap, data)
                self.error(call(root), 'WORKSPACE_WRITER_GATE_INVALID')
                self.error(call(root, 'claim', lease), 'WORKSPACE_WRITER_GATE_INVALID')
        with fixture() as (root, cap, gen, guard, lease):
            write_json(root / '.chisa-bridge.json', {'bindingEpoch': 'rebound'})
            self.error(call(root), 'WORKSPACE_WRITER_GATE_INVALID')
        for replacement in [None, {}, {'state': 'dirty'}, {'version': True}, {'generation': 'bad'}, {'updatedAt': 'not-a-date'}, {'bindingEpoch': 'old'}]:
            with self.subTest(replacement=replacement), fixture() as (root, cap, gen, guard, lease):
                data = json.loads(gen.read_text())
                if replacement is None: gen.write_text('{broken')
                elif not replacement: write_json(gen, [])
                else:
                    data.update(replacement)
                    if replacement == {'state': 'dirty'}:
                        write_json(gen, data)
                        self.assertTrue(call(root)['available'])
                        self.error(call(root, 'claim', lease), 'WORKSPACE_RECOVERY_REQUIRED')
                        continue
                    write_json(gen, data)
                self.error(call(root, 'claim', lease), 'WORKSPACE_WRITER_GATE_INVALID')

    def test_symlinks_hardlinks_and_nonprivate_metadata_are_rejected(self):
        for selected in ('cap', 'generation', 'guard', 'bridge'):
            with self.subTest(selected=selected), fixture() as (root, cap, gen, guard, lease):
                target = {'cap': cap, 'generation': gen, 'guard': guard, 'bridge': root / '.chisa-bridge.json'}[selected]
                saved = target.with_name(target.name + '.saved')
                target.rename(saved); target.symlink_to(saved)
                self.error(call(root, 'claim', lease), 'WORKSPACE_WRITER_GATE_INVALID')
                self.assertFalse(state_path(root).parent.exists())
        with fixture() as (root, cap, gen, guard, lease):
            os.link(cap, cap.with_name('hardlink'))
            self.error(call(root), 'WORKSPACE_WRITER_GATE_INVALID')
        with fixture() as (root, cap, gen, guard, lease):
            cap.chmod(0o666)
            self.error(call(root), 'WORKSPACE_WRITER_GATE_INVALID')
        with fixture() as (root, cap, gen, guard, lease):
            alias = root.parent / 'alias'; alias.symlink_to(root, target_is_directory=True)
            self.error(call(alias, 'claim', lease), 'WORKSPACE_WRITER_GATE_INVALID')
            parent_alias = root.parent / 'parent-alias'; parent_alias.symlink_to(root.parent, target_is_directory=True)
            self.error(call(parent_alias / root.name, 'claim', lease), 'WORKSPACE_WRITER_GATE_INVALID')

    def test_nonblocking_writer_and_legacy_guard_contention(self):
        for name in ('writer', 'lease'):
            with self.subTest(name=name), fixture() as (root, cap, gen, guard, lease):
                selected = guard if name == 'writer' else pathlib.Path(str(root) + '.chisa-lease.guard')
                with selected.open('a+b') as held:
                    selected.chmod(0o600)
                    fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    self.error(call(root, 'claim', lease), 'WORKSPACE_BUSY')
                    self.assertFalse(state_path(root).parent.exists())
                self.assertTrue(call(root, 'claim', lease)['available'])
                with selected.open('a+b') as held:
                    fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    self.error(call(root, 'release', lease), 'WORKSPACE_BUSY')
                    self.assertTrue(state_path(root).exists())
                self.assertTrue(call(root, 'release', lease)['released'])

    def test_claim_validates_process_birth_and_never_reclaims_partial_leases(self):
        for key, value in [('owner', 'sync'), ('pid', 0), ('pid', os.getpid() + 100000), ('processStartTime', '0'), ('bootId', '00000000-0000-0000-0000-000000000000')]:
            with self.subTest(key=key), fixture() as (root, cap, gen, guard, lease):
                lease[key] = value
                self.error(call(root, 'claim', lease), 'WORKSPACE_LEASE_INVALID')
                self.assertFalse(state_path(root).parent.exists())
        with fixture() as (root, cap, gen, guard, lease):
            state_path(root).parent.mkdir(mode=0o700)
            self.error(call(root, 'claim', lease), 'WORKSPACE_BUSY')
            self.assertTrue(state_path(root).parent.is_dir())
        with fixture() as (root, cap, gen, guard, lease):
            state_path(root).parent.symlink_to(root, target_is_directory=True)
            self.error(call(root, 'claim', lease), 'WORKSPACE_BUSY')
            self.error(call(root, 'release', lease), 'WORKSPACE_WRITER_GATE_INVALID')

    def test_release_requires_exact_owner_run_epoch_and_process_birth(self):
        for key, value in [('owner', 'sync-needed'), ('id', 'other-run'), ('epoch', 'other-epoch'), ('pid', os.getpid() + 1), ('processStartTime', '0'), ('bootId', '00000000-0000-0000-0000-000000000000')]:
            with self.subTest(key=key), fixture() as (root, cap, gen, guard, lease):
                self.assertTrue(call(root, 'claim', lease)['available'])
                expected = dict(lease); expected[key] = value
                result = call(root, 'release', expected)
                self.assertFalse(result['ok'], result)
                self.assertEqual(json.loads(gen.read_text())['state'], 'dirty')
                self.assertEqual(json.loads(state_path(root).read_text()), lease)

    def test_cleanup_jobs_unknown_state_and_rebinding_preserve_lease(self):
        for kind in ('cleanup', 'job', 'unknown', 'rebound', 'generation-owner'):
            with self.subTest(kind=kind), fixture() as (root, cap, gen, guard, lease):
                self.assertTrue(call(root, 'claim', lease)['available'])
                state = state_path(root)
                if kind == 'cleanup': write_json(state, {**lease, 'cleanupPending': ['container-1']})
                elif kind == 'job': write_json(state.parent / 'sync-job.json', {'leaseId': lease['id']})
                elif kind == 'unknown': (state.parent / 'unknown.tmp').write_text('pending')
                elif kind == 'rebound': write_json(root / '.chisa-bridge.json', {'bindingEpoch': 'new-binding'})
                else:
                    data = json.loads(gen.read_text()); data['leaseId'] = 'other'; write_json(gen, data)
                self.assertFalse(call(root, 'release', lease)['ok'])
                self.assertTrue(state.exists())
                self.assertEqual(json.loads(gen.read_text())['state'], 'dirty')

    def test_claim_failure_after_lease_persisted_retains_fence(self):
        with fixture() as (root, cap, gen, guard, lease):
            needle = "atomic_json(parent, generation_name, new_generation(root, expected, 'dirty'))"
            self.assertEqual(GATE.count(needle), 1)
            failed = GATE.replace(needle, "raise OSError('injected generation persistence failure')")
            self.error(call(root, 'claim', lease, script=failed), 'WORKSPACE_WRITER_GATE_INVALID')
            self.assertEqual(json.loads(state_path(root).read_text()), lease)
            self.error(call(root, 'claim', lease), 'WORKSPACE_BUSY')
            self.assertEqual(json.loads(gen.read_text())['state'], 'complete')
            self.assertFalse(call(root, 'release', lease)['ok'])

    def test_release_crash_windows_keep_barrier_and_exact_retry_can_finish(self):
        with fixture() as (root, cap, gen, guard, lease):
            self.assertTrue(call(root, 'claim', lease)['available'])
            needle = "actual_again = read_json(lease_fd, 'state.json')"
            self.assertEqual(GATE.count(needle), 1)
            failed = GATE.replace(needle, "raise OSError('injected crash after complete generation')")
            self.error(call(root, 'release', lease, script=failed), 'WORKSPACE_WRITER_GATE_INVALID')
            self.assertEqual(json.loads(gen.read_text())['state'], 'complete')
            self.assertEqual(json.loads(state_path(root).read_text()), lease)
            self.error(call(root, 'claim', lease), 'WORKSPACE_BUSY')
            self.assertTrue(call(root, 'release', lease)['released'])
        with fixture() as (root, cap, gen, guard, lease):
            self.assertTrue(call(root, 'claim', lease)['available'])
            needle = "os.rmdir(lease_name, dir_fd=parent)"
            self.assertEqual(GATE.count(needle), 1)
            failed = GATE.replace(needle, "raise OSError('injected crash after state removal')")
            self.error(call(root, 'release', lease, script=failed), 'WORKSPACE_WRITER_GATE_INVALID')
            self.assertEqual(json.loads(gen.read_text())['state'], 'complete')
            self.assertTrue(state_path(root).parent.is_dir())
            self.assertFalse(state_path(root).exists())
            self.error(call(root, 'claim', lease), 'WORKSPACE_BUSY')
            self.assertFalse(call(root, 'release', lease)['ok'])

unittest.main(argv=['writer-gate'], verbosity=2)
`;

test('real Linux Python writer gate preserves exclusion, exact identity and crash barriers', { skip: process.platform !== 'linux' }, () => {
  assert.ok(helperScript, 'wrapper test captures the real embedded helper');
  const result = realSpawnSync('python3', ['-I', '-c', pythonIntegrationScript], {
    input: helperScript, encoding: 'utf8', timeout: 30_000, maxBuffer: 1_048_576,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
