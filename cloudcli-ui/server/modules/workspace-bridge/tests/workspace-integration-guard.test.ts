import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs, { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import { beginWorkspaceIntegration, clearWorkspaceIntegration, readWorkspaceIntegration, recoverWorkspaceIntegrationLease } from '../workspace-integration-guard.service.js';

const realSpawnSync = childProcess.spawnSync;
const markerPath = (root: string) => root + '.chisa-integration.json';
const leasePath = (root: string) => path.join(root + '.chisa-lease', 'state.json');
function json(file: string, value: unknown): void { writeFileSync(file, JSON.stringify(value), { mode: 0o600 }); }
function read(file: string): Record<string, any> { return JSON.parse(readFileSync(file, 'utf8')); }
function fixture(operation: (f: ReturnType<typeof createFixture>) => void): void {
  const f = createFixture();
  try { operation(f); } finally {
    assert.ok(path.basename(f.directory).startsWith('chisa-integration-'));
    assert.equal(path.dirname(f.directory), realpathSync(os.tmpdir()));
    rmSync(f.directory, { recursive: true, force: true });
  }
}
function createFixture() {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'chisa-integration-')));
  const source = path.join(directory, 'source'); const execution = path.join(directory, 'execution');
  mkdirSync(source); mkdirSync(execution);
  const intent = { workspaceId: randomUUID(), generation: randomUUID(), baseRevision: 'baseline-1', sourceRoot: source, executionRoot: execution, sessionId: 'session-1', bindingEpoch: 'epoch-1', operationId: 'operation-1', previewId: randomUUID(), expectedSourceRevision: 'source-revision', expectedTargetRevision: 'target-revision' };
  const leases = Object.fromEntries([source, execution].map((root, index) => {
    json(path.join(root, '.chisa-bridge.json'), { bindingEpoch: intent.bindingEpoch });
    mkdirSync(root + '.chisa-lease', { mode: 0o700 });
    const lease = { owner: 'claude', id: 'lease-' + index, epoch: intent.bindingEpoch, pid: process.pid, mayWrite: true };
    json(leasePath(root), lease);
    return [root, lease];
  }));
  return { directory, source, execution, intent, leases };
}

// The Windows branch is intentionally same-process only. Its fixtures also run
// on Linux, where real fcntl and dead-owner adoption are tested separately below.
test('integration markers and same-process lease adoption retain exact operation identity', async t => {
  const platform = mock.method(os, 'platform', () => 'win32' as NodeJS.Platform);
  try {
    await t.test('durable pair precedes tags, exact begin is idempotent, and inactive adoption preserves run IDs', () => fixture(f => {
      assert.equal(readWorkspaceIntegration(f.source), null);
      beginWorkspaceIntegration(f.intent, f.leases);
      assert.deepEqual(readWorkspaceIntegration(f.source), f.intent);
      assert.deepEqual(readWorkspaceIntegration(f.execution), f.intent);
      beginWorkspaceIntegration(f.intent, f.leases);
      for (const root of [f.source, f.execution]) {
        const lease = read(leasePath(root));
        assert.equal(lease.integrationOperation, f.intent.operationId);
        assert.equal(lease.id, f.leases[root].id);
        assert.throws(() => recoverWorkspaceIntegrationLease(root, f.intent), { code: 'WORKSPACE_BUSY' });
        const adopted = recoverWorkspaceIntegrationLease(root, f.intent, { inactiveLeaseId: lease.id });
        assert.equal(adopted?.id, lease.id); assert.equal(adopted?.pid, process.pid);
        assert.ok(existsSync(markerPath(root)));
      }
      clearWorkspaceIntegration(f.intent);
      assert.equal(readWorkspaceIntegration(f.source), null); assert.equal(readWorkspaceIntegration(f.execution), null);
      assert.ok(existsSync(leasePath(f.source))); assert.ok(existsSync(leasePath(f.execution)));
      clearWorkspaceIntegration(f.intent);
    }));
    await t.test('operation IDs cannot be rebound to different preview, roots, generation or revisions', () => fixture(f => {
      beginWorkspaceIntegration(f.intent, f.leases);
      for (const key of ['operationId', 'previewId', 'workspaceId', 'generation', 'baseRevision', 'sessionId', 'expectedSourceRevision', 'expectedTargetRevision'] as const) {
        const changed = { ...f.intent, [key]: 'different-value' };
        assert.throws(() => beginWorkspaceIntegration(changed, f.leases));
        assert.throws(() => recoverWorkspaceIntegrationLease(f.source, changed, { inactiveLeaseId: f.leases[f.source].id }));
        assert.throws(() => clearWorkspaceIntegration(changed));
        assert.deepEqual(readWorkspaceIntegration(f.source), f.intent);
      }
    }));
    await t.test('partial source-first creation and execution-first clear remain retryable', () => fixture(f => {
      const original = fs.renameSync; let interrupted = false;
      const replacement = mock.method(fs, 'renameSync', (...args: Parameters<typeof fs.renameSync>) => {
        if (String(args[1]) === markerPath(f.execution) && !interrupted) { interrupted = true; throw new Error('interrupted mirror publication'); }
        return original(...args);
      });
      syncBuiltinESMExports();
      try { assert.throws(() => beginWorkspaceIntegration(f.intent, f.leases), /interrupted/); }
      finally { replacement.mock.restore(); syncBuiltinESMExports(); }
      assert.equal(read(leasePath(f.source)).integrationOperation, undefined);
      assert.deepEqual(readWorkspaceIntegration(f.source), f.intent); assert.equal(readWorkspaceIntegration(f.execution), null);
      assert.equal(recoverWorkspaceIntegrationLease(f.execution, f.intent, { inactiveLeaseId: f.leases[f.execution].id })?.id, f.leases[f.execution].id);
      beginWorkspaceIntegration(f.intent, f.leases);
      const originalUnlink = fs.unlinkSync;
      const removal = mock.method(fs, 'unlinkSync', (filename: fs.PathLike) => {
        if (String(filename) === markerPath(f.source)) throw new Error('interrupted source removal');
        return originalUnlink(filename);
      });
      syncBuiltinESMExports();
      try { assert.throws(() => clearWorkspaceIntegration(f.intent), /interrupted/); }
      finally { removal.mock.restore(); syncBuiltinESMExports(); }
      assert.equal(readWorkspaceIntegration(f.execution), null); assert.deepEqual(readWorkspaceIntegration(f.source), f.intent);
      clearWorkspaceIntegration(f.intent);
      assert.equal(readWorkspaceIntegration(f.source), null);
    }));
    await t.test('tag write interruption leaves only exact lease state and can be retried', () => fixture(f => {
      const original = fs.renameSync; let interrupted = false;
      const replacement = mock.method(fs, 'renameSync', (...args: Parameters<typeof fs.renameSync>) => {
        if (String(args[1]) === leasePath(f.source) && !interrupted) { interrupted = true; throw new Error('interrupted lease tag'); }
        return original(...args);
      });
      syncBuiltinESMExports();
      try { assert.throws(() => beginWorkspaceIntegration(f.intent, f.leases), /interrupted/); }
      finally { replacement.mock.restore(); syncBuiltinESMExports(); }
      assert.deepEqual(fs.readdirSync(f.source + '.chisa-lease'), ['state.json']);
      assert.equal(read(leasePath(f.source)).integrationOperation, undefined);
      assert.deepEqual(readWorkspaceIntegration(f.source), f.intent);
      assert.equal(recoverWorkspaceIntegrationLease(f.source, f.intent, { inactiveLeaseId: f.leases[f.source].id })?.id, f.leases[f.source].id);
      beginWorkspaceIntegration(f.intent, f.leases); clearWorkspaceIntegration(f.intent);
    }));
    await t.test('metadata CAS refuses a marker changed during fsync', () => fixture(f => {
      beginWorkspaceIntegration(f.intent, f.leases);
      const original = fs.fsyncSync; let changed = false;
      const replacement = mock.method(fs, 'fsyncSync', (fd: number) => {
        original(fd);
        if (!changed) {
          changed = true;
          const value = read(markerPath(f.source)); value.intent.previewId = 'concurrent-preview'; json(markerPath(f.source), value);
        }
      });
      syncBuiltinESMExports();
      try { assert.throws(() => beginWorkspaceIntegration(f.intent, f.leases), /changed during commit/); }
      finally { replacement.mock.restore(); syncBuiltinESMExports(); }
      assert.equal(read(markerPath(f.source)).intent.previewId, 'concurrent-preview');
      assert.throws(() => clearWorkspaceIntegration(f.intent));
    }));
    await t.test('a fresh caller-owned lease can replace an old witness only for the same exact intent', () => fixture(f => {
      beginWorkspaceIntegration(f.intent, f.leases);
      const lease = { ...f.leases[f.source], id: 'new-reservation' };
      json(leasePath(f.source), lease);
      assert.throws(() => recoverWorkspaceIntegrationLease(f.source, f.intent, { inactiveLeaseId: lease.id }), { code: 'WORKSPACE_BUSY' });
      assert.throws(() => beginWorkspaceIntegration(f.intent, f.leases), { code: 'WORKSPACE_BUSY' });
      beginWorkspaceIntegration(f.intent, { ...f.leases, [f.source]: lease });
      assert.equal(recoverWorkspaceIntegrationLease(f.source, f.intent, { inactiveLeaseId: lease.id })?.id, lease.id);
      clearWorkspaceIntegration(f.intent);
    }));
    await t.test('unknown jobs, previews, cleanup and a different or active process remain reserved', () => {
      for (const patch of [{ cleanupPending: ['container'] }, { previews: ['preview'] }, { integrationOperation: 'other-op' }, { pid: process.pid + 100_000 }]) fixture(f => {
        beginWorkspaceIntegration(f.intent, f.leases);
        json(leasePath(f.source), { ...read(leasePath(f.source)), ...patch });
        assert.throws(() => recoverWorkspaceIntegrationLease(f.source, f.intent, { inactiveLeaseId: f.leases[f.source].id }));
        assert.throws(() => clearWorkspaceIntegration(f.intent));
        assert.ok(existsSync(markerPath(f.source))); assert.ok(existsSync(leasePath(f.source)));
      });
      fixture(f => {
        beginWorkspaceIntegration(f.intent, f.leases); json(path.join(f.source + '.chisa-lease', 'sync-job.json'), {});
        assert.throws(() => recoverWorkspaceIntegrationLease(f.source, f.intent, { inactiveLeaseId: f.leases[f.source].id }), { code: 'WORKSPACE_RECOVERY_REQUIRED' });
      });
    });
    await t.test('malformed, hardlinked or redirected markers and replaced roots fail closed', () => {
      for (const content of ['{', 'null', '[]', '{}']) fixture(f => {
        writeFileSync(markerPath(f.source), content);
        assert.throws(() => readWorkspaceIntegration(f.source));
        assert.throws(() => beginWorkspaceIntegration(f.intent, f.leases));
        assert.equal(readFileSync(markerPath(f.source), 'utf8'), content);
      });
      fixture(f => {
        beginWorkspaceIntegration(f.intent, f.leases);
        linkSync(markerPath(f.source), path.join(f.directory, 'marker-hardlink'));
        assert.throws(() => readWorkspaceIntegration(f.source)); assert.throws(() => clearWorkspaceIntegration(f.intent));
      });
      fixture(f => {
        beginWorkspaceIntegration(f.intent, f.leases);
        const moved = path.join(f.directory, 'original-source');
        assert.equal(path.dirname(moved), f.directory); renameSync(f.source, moved); mkdirSync(f.source);
        json(path.join(f.source, '.chisa-bridge.json'), { bindingEpoch: f.intent.bindingEpoch });
        assert.throws(() => readWorkspaceIntegration(f.source)); assert.throws(() => clearWorkspaceIntegration(f.intent));
      });
      fixture(f => {
        const alias = path.join(f.directory, 'alias'); symlinkSync(f.source, alias, process.platform === 'win32' ? 'junction' : 'dir');
        assert.throws(() => beginWorkspaceIntegration({ ...f.intent, sourceRoot: alias }, f.leases));
      });
    });
    await t.test('missing lease is not guessed and orphan execution witness never authorizes recovery', () => fixture(f => {
      beginWorkspaceIntegration(f.intent, f.leases);
      const leaseDirectory = f.execution + '.chisa-lease';
      assert.equal(path.dirname(leaseDirectory), f.directory); rmSync(leaseDirectory, { recursive: true });
      assert.equal(recoverWorkspaceIntegrationLease(f.execution, f.intent), null);
      assert.throws(() => clearWorkspaceIntegration(f.intent));
      unlinkSync(markerPath(f.source));
      assert.throws(() => recoverWorkspaceIntegrationLease(f.execution, f.intent));
      assert.ok(existsSync(markerPath(f.execution)));
    }));
  } finally { platform.mock.restore(); }
});

let helperScript = '';
test('Linux helper requests are bounded and incomplete output never confirms adoption', () => fixture(f => {
  const platform = mock.method(os, 'platform', () => 'linux' as NodeJS.Platform);
  let response: unknown = { ok: true };
  const launch = mock.method(childProcess, 'spawnSync', (command: string, args: readonly string[], options: childProcess.SpawnSyncOptionsWithStringEncoding) => {
    assert.equal(command, 'python3'); assert.deepEqual(args.slice(0, 2), ['-I', '-c']);
    assert.equal(options.timeout, 2500); assert.equal(options.maxBuffer, 65_536); assert.equal(options.shell, undefined);
    helperScript = args[2];
    assert.deepEqual(JSON.parse(String(options.input)).intent, f.intent);
    const stdout = JSON.stringify(response);
    return { pid: 1, status: 0, signal: null, stdout, stderr: '', output: [null, stdout, ''] };
  });
  syncBuiltinESMExports();
  try {
    beginWorkspaceIntegration(f.intent, f.leases);
    assert.throws(() => recoverWorkspaceIntegrationLease(f.source, f.intent), { code: 'WORKSPACE_INTEGRATION_INVALID' });
    response = { ok: false, code: 'WORKSPACE_BUSY', error: 'owner live' };
    assert.throws(() => recoverWorkspaceIntegrationLease(f.source, f.intent), { code: 'WORKSPACE_BUSY' });
    response = { ok: true, lease: null };
    assert.equal(recoverWorkspaceIntegrationLease(f.source, f.intent), null);
    response = { ok: true, lease: {} };
    assert.throws(() => recoverWorkspaceIntegrationLease(f.source, f.intent));
  } finally { platform.mock.restore(); launch.mock.restore(); syncBuiltinESMExports(); }
}));

const pythonIntegrationScript = String.raw`
import contextlib, fcntl, json, os, pathlib, secrets, subprocess, sys, tempfile, unittest
SCRIPT=json.load(sys.stdin)['script']
EPOCH='epoch-1'
def birth(pid):
    fields=pathlib.Path('/proc/'+str(pid)+'/stat').read_text().rsplit(')',1)[1].split()
    return fields[19],pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()
def put(path,value):
    path.write_text(json.dumps(value)); path.chmod(0o600)
def state(root): return pathlib.Path(str(root)+'.chisa-lease/state.json')
def marker(root): return pathlib.Path(str(root)+'.chisa-integration.json')
def call(intent,action,**extra):
    result=subprocess.run([sys.executable,'-I','-c',SCRIPT],input=json.dumps({'intent':intent,'action':action,**extra}),text=True,capture_output=True,timeout=8)
    if result.returncode: raise AssertionError(result.stderr)
    return json.loads(result.stdout)
@contextlib.contextmanager
def fixture(enrolled=True):
    with tempfile.TemporaryDirectory(prefix='integration-linux-') as folder:
        source=pathlib.Path(folder)/'source'; execution=pathlib.Path(folder)/'execution'
        source.mkdir(); execution.mkdir(); start,boot=birth(os.getpid())
        intent={'workspaceId':'workspace-1','generation':'generation-1','baseRevision':'baseline-1','sourceRoot':str(source),'executionRoot':str(execution),'sessionId':'session-1','bindingEpoch':EPOCH,'operationId':'op-1','previewId':'preview-1','expectedSourceRevision':'source-revision','expectedTargetRevision':'target-revision'}
        leases={}
        for index,root in enumerate((source,execution)):
            put(root/'.chisa-bridge.json',{'bindingEpoch':EPOCH})
            state(root).parent.mkdir(mode=0o700)
            lease={'owner':'claude','id':'lease-'+str(index),'epoch':EPOCH,'pid':os.getpid(),'processStartTime':start,'bootId':boot,'mayWrite':True}
            if root==source and enrolled:
                lease['writerGate']=True
                put(pathlib.Path(str(root)+'.chisa-writer-capability.json'),{'version':1,'protocol':'chisa-writer-gate-v1','engineVersion':'0.18.1-chisa.5','root':str(root),'bindingEpoch':EPOCH})
                put(pathlib.Path(str(root)+'.chisa-generation.json'),{'version':1,'root':str(root),'generation':secrets.token_hex(32),'state':'dirty','writer':'cloud','bindingEpoch':EPOCH,'leaseId':lease['id'],'updatedAt':'2026-10-22T00:00:00Z'})
                guard=pathlib.Path(str(root)+'.chisa-writer.guard'); guard.touch(mode=0o600)
            put(state(root),lease); leases[str(root)]=lease
        yield source,execution,intent,leases
class Integration(unittest.TestCase):
    def success(self,value): self.assertTrue(value.get('ok'),value); return value
    def failure(self,value,code=None):
        self.assertFalse(value.get('ok'),value)
        if code: self.assertEqual(value.get('code'),code,value)
    def begin(self,intent,leases): return self.success(call(intent,'begin',leasesByRoot=leases))
    def test_gate_and_legacy_adoption_preserve_run_and_dirty_generation(self):
        for enrolled in (False,True):
            with fixture(enrolled) as (source,execution,intent,leases):
                self.begin(intent,leases)
                original=pathlib.Path(str(source)+'.chisa-generation.json').read_bytes() if enrolled else None
                for root in (source,execution):
                    self.failure(call(intent,'recover',root=str(root)),'WORKSPACE_BUSY')
                    adopted=self.success(call(intent,'recover',root=str(root),inactiveLeaseId=leases[str(root)]['id']))['lease']
                    self.assertEqual(adopted['id'],leases[str(root)]['id']); self.assertEqual(adopted['pid'],os.getpid()); self.assertEqual(adopted['integrationOperation'],intent['operationId'])
                if enrolled: self.assertEqual(pathlib.Path(str(source)+'.chisa-generation.json').read_bytes(),original)
                self.success(call(intent,'clear'))
                self.assertFalse(marker(source).exists()); self.assertFalse(marker(execution).exists()); self.assertTrue(state(source).exists())
    def test_dead_exact_owner_adopts_same_run_with_new_process_birth(self):
        with fixture() as (source,execution,intent,leases):
            self.begin(intent,leases)
            child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)'])
            try:
                start,boot=birth(child.pid); old={**json.loads(state(source).read_text()),'pid':child.pid,'processStartTime':start,'bootId':boot}
                put(state(source),old)
                for root in (source,execution):
                    value=json.loads(marker(root).read_text()); value['roots'][str(source)]['leases']=[{key:old[key] for key in ('owner','id','epoch','pid','processStartTime','bootId')}]; put(marker(root),value)
                self.failure(call(intent,'recover',root=str(source)),'WORKSPACE_BUSY')
            finally: child.terminate(); child.wait(timeout=5)
            adopted=self.success(call(intent,'recover',root=str(source)))['lease']
            self.assertEqual(adopted['id'],old['id']); self.assertEqual(adopted['pid'],os.getpid()); self.assertNotEqual(adopted['processStartTime'],old['processStartTime'])
            self.success(call(intent,'clear'))
    def test_partial_pair_and_old_witness_before_tag_are_recoverable(self):
        with fixture() as (source,execution,intent,leases):
            self.begin(intent,leases); marker(execution).unlink(); put(state(execution),leases[str(execution)])
            recovered=self.success(call(intent,'recover',root=str(execution),inactiveLeaseId=leases[str(execution)]['id']))['lease']
            self.assertEqual(recovered['integrationOperation'],intent['operationId']); self.assertTrue(marker(execution).exists())
            marker(execution).unlink(); self.success(call(intent,'clear')); self.assertFalse(marker(source).exists())
    def test_interrupted_adoption_accepts_only_old_or_new_witness(self):
        with fixture() as (source,execution,intent,leases):
            self.begin(intent,leases)
            old={**leases[str(source)],'pid':2147483647,'processStartTime':'1'}
            for root in (source,execution):
                value=json.loads(marker(root).read_text()); value['roots'][str(source)]['leases']=[{key:old[key] for key in ('owner','id','epoch','pid','processStartTime','bootId')},value['roots'][str(source)]['leases'][0]]; put(marker(root),value)
            put(state(source),old)
            adopted=self.success(call(intent,'recover',root=str(source)))['lease']; self.assertEqual(adopted['id'],old['id'])
            self.success(call(intent,'recover',root=str(source),inactiveLeaseId=old['id']))
    def test_writer_and_lease_flocks_exclude_every_mutation(self):
        for ending in ('.chisa-writer.guard','.chisa-lease.guard'):
            with fixture() as (source,execution,intent,leases):
                self.begin(intent,leases)
                with open(str(source)+ending,'r+') as guard:
                    fcntl.flock(guard,fcntl.LOCK_EX)
                    for action,extra in (('begin',{'leasesByRoot':leases}),('recover',{'root':str(source),'inactiveLeaseId':leases[str(source)]['id']}),('clear',{})):
                        self.failure(call(intent,action,**extra),'WORKSPACE_BUSY')
                self.assertTrue(marker(source).exists()); self.assertTrue(state(source).exists())
    def test_jobs_cleanup_previews_and_mismatched_generation_preserve_barrier(self):
        for patch in ({'cleanupPending':['container']},{'previews':['preview']},{'integrationOperation':'other'},{'processStartTime':'bad'}):
            with fixture() as (source,execution,intent,leases):
                self.begin(intent,leases); put(state(source),{**json.loads(state(source).read_text()),**patch})
                self.failure(call(intent,'recover',root=str(source),inactiveLeaseId=leases[str(source)]['id'])); self.assertTrue(marker(source).exists())
        with fixture() as (source,execution,intent,leases):
            self.begin(intent,leases); put(state(source).parent/'sync-job.json',{})
            self.failure(call(intent,'recover',root=str(source),inactiveLeaseId=leases[str(source)]['id']))
        with fixture() as (source,execution,intent,leases):
            self.begin(intent,leases); gen=pathlib.Path(str(source)+'.chisa-generation.json'); value=json.loads(gen.read_text()); value['leaseId']='other'; put(gen,value)
            self.failure(call(intent,'recover',root=str(source),inactiveLeaseId=leases[str(source)]['id'])); self.failure(call(intent,'clear'))
    def test_hardlinks_symlinks_permissions_and_bad_markers_are_never_absence(self):
        for kind in ('symlink','hardlink','writable','json','array','version','roots','witness'):
            with fixture() as (source,execution,intent,leases):
                self.begin(intent,leases); target=marker(source)
                if kind=='symlink': target.unlink(); target.symlink_to(target.parent/'missing')
                elif kind=='hardlink': os.link(target,target.parent/'alias')
                elif kind=='writable': target.chmod(0o666)
                elif kind=='json': target.write_text('{')
                elif kind=='array': target.write_text('[]')
                else:
                    value=json.loads(target.read_text())
                    if kind=='version': value['version']=True
                    elif kind=='roots': value['roots']=[]
                    else: value['roots'][str(source)]['leases']=[{}]
                    put(target,value)
                self.failure(call(intent,'begin',leasesByRoot=leases)); self.failure(call(intent,'recover',root=str(source),inactiveLeaseId=leases[str(source)]['id'])); self.failure(call(intent,'clear'))
                self.assertTrue(os.path.lexists(target)); self.assertTrue(state(source).exists())
    def test_rebind_and_different_operation_never_recover_previous_reservation(self):
        with fixture() as (source,execution,intent,leases):
            self.begin(intent,leases)
            self.failure(call({**intent,'previewId':'other'},'recover',root=str(source),inactiveLeaseId=leases[str(source)]['id']))
            put(source/'.chisa-bridge.json',{'bindingEpoch':'new-epoch'})
            self.failure(call(intent,'recover',root=str(source),inactiveLeaseId=leases[str(source)]['id'])); self.assertTrue(marker(source).exists())
    def test_absent_lease_returns_null_but_partial_state_cannot_be_adopted(self):
        with fixture(False) as (source,execution,intent,leases):
            self.begin(intent,leases); state(execution).unlink()
            self.failure(call(intent,'recover',root=str(execution),inactiveLeaseId=leases[str(execution)]['id']))
            state(execution).parent.rmdir(); self.assertIsNone(self.success(call(intent,'recover',root=str(execution)))['lease'])
            self.failure(call(intent,'clear')); self.assertTrue(marker(source).exists())
unittest.main(argv=['integration-guard'],verbosity=2)
`;

test('real Linux integration guard preserves dead-owner adoption, exact witnesses and durable barriers', { skip: process.platform !== 'linux' }, () => {
  assert.ok(helperScript.length > 1000);
  const result = realSpawnSync('python3', ['-I', '-c', pythonIntegrationScript], { input: JSON.stringify({ script: helperScript }), encoding: 'utf8', timeout: 60_000, maxBuffer: 2 * 1024 * 1024 });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stdout + result.stderr);
});
