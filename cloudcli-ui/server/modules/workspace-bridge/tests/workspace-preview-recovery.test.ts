import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import test, { mock } from 'node:test';

import { recoverStoppedWorkspacePreview } from '../workspace-preview-recovery.service.js';

const request = { userId: 'fixture-user', accountRoot: '/srv/workspaces', root: '/srv/workspaces/project', previewId: 'fixture-preview' };
let helperScript = '';

test('orphan preview recovery is Linux-only, bounded and accepts only complete structured replies', () => {
  const platform = mock.method(os, 'platform', () => 'linux' as NodeJS.Platform);
  let response: Partial<childProcess.SpawnSyncReturns<string>> = { status: 0, stdout: '{"ok":true,"released":false}', stderr: '' };
  const spawn = mock.method(childProcess, 'spawnSync', (command: string, args: string[], options: childProcess.SpawnSyncOptionsWithStringEncoding) => {
    assert.equal(command, 'python3'); assert.deepEqual(args.slice(0, 2), ['-I', '-c']); helperScript = args[2];
    assert.equal(options.timeout, 8_000); assert.equal(options.maxBuffer, 65_536); assert.equal(options.killSignal, 'SIGKILL'); assert.equal(options.shell, undefined);
    assert.deepEqual(JSON.parse(String(options.input)), { ...request, home: os.homedir() });
    return response as childProcess.SpawnSyncReturns<string>;
  });
  syncBuiltinESMExports();
  try {
    assert.deepEqual(recoverStoppedWorkspacePreview(request), { released: false });
    response.stdout = '{"ok":true,"released":true}'; assert.deepEqual(recoverStoppedWorkspacePreview(request), { released: true });
    for (const stdout of ['{}', 'null', '{"ok":true}', '{"ok":true,"released":"yes"}', '{']) {
      response.stdout = stdout; assert.throws(() => recoverStoppedWorkspacePreview(request), { code: 'WORKSPACE_PREVIEW_RECOVERY_REQUIRED' });
    }
    response = { status: null, signal: 'SIGKILL', stdout: '{"ok":true,"released":true}' };
    assert.throws(() => recoverStoppedWorkspacePreview(request), { code: 'WORKSPACE_PREVIEW_RECOVERY_REQUIRED' });
    response = { status: 0, stdout: '{"ok":false,"code":"WORKSPACE_BUSY","error":"owner alive"}' };
    assert.throws(() => recoverStoppedWorkspacePreview(request), { code: 'WORKSPACE_BUSY' });
    platform.mock.mockImplementation(() => 'win32');
    assert.throws(() => recoverStoppedWorkspacePreview(request), { code: 'WORKSPACE_PREVIEW_RECOVERY_UNAVAILABLE' });
  } finally { spawn.mock.restore(); platform.mock.restore(); syncBuiltinESMExports(); }
});

const pythonPreviewRecoveryTests = String.raw`
import contextlib, fcntl, hashlib, json, os, pathlib, subprocess, sys, tempfile, unittest
SCRIPT=sys.stdin.read()
BOOT=pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()
EPOCH='fixture-epoch'
USER='fixture-user'

def put(file,value):
    file.write_text(json.dumps(value)); file.chmod(0o600)
def load(file): return json.loads(file.read_text())
def birth(pid): return pathlib.Path('/proc/'+str(pid)+'/stat').read_text().rsplit(')',1)[1].split()[19]

@contextlib.contextmanager
def fixture():
    with tempfile.TemporaryDirectory(prefix='chisa-preview-recovery-') as temporary:
        base=pathlib.Path(temporary).resolve(); home=base/'home'; home.mkdir(mode=0o700)
        account=base/'workspaces'; account.mkdir(); root=account/'project'; root.mkdir()
        state=home/'.chisa-workspace-runtime'; state.mkdir(mode=0o700); inventory=state/'previews'; inventory.mkdir(mode=0o700)
        owner=hashlib.sha256((str(account)+'\0'+USER).encode()).hexdigest()
        preview='chisa-account-preview-'+owner[:20]+'-'+'b'*16
        runtime=state/(hashlib.sha256(str(account).encode()).hexdigest()[:24]+'.json')
        put(runtime,{'version':1,'root':str(account),'userId':USER,'owner':owner[:24]})
        child=subprocess.Popen([sys.executable,'-I','-c','import time; time.sleep(60)'])
        lease={'owner':'claude','id':'fixture-run','epoch':EPOCH,'pid':child.pid,'processStartTime':birth(child.pid),'bootId':BOOT,'writerGate':True,'mayWrite':True,'previews':[preview],'cleanupPending':[]}
        child.terminate(); child.wait(timeout=5)
        put(root/'.chisa-bridge.json',{'bindingEpoch':EPOCH})
        cap=pathlib.Path(str(root)+'.chisa-writer-capability.json')
        put(cap,{'version':1,'root':str(root),'bindingEpoch':EPOCH,'protocol':'chisa-writer-gate-v1','engineVersion':'0.18.1-chisa.5'})
        generation=pathlib.Path(str(root)+'.chisa-generation.json')
        put(generation,{'version':1,'root':str(root),'state':'dirty','writer':'cloud','generation':'a'*64,'bindingEpoch':EPOCH,'leaseId':lease['id'],'updatedAt':'2026-10-22T12:00:00Z'})
        guards=[pathlib.Path(str(root)+'.chisa-'+name+'.guard') for name in ('writer','lease')]
        for guard in guards: guard.touch(mode=0o600)
        directory=pathlib.Path(str(root)+'.chisa-lease'); directory.mkdir(mode=0o700); lease_file=directory/'state.json'; put(lease_file,lease)
        witness=inventory/(preview+'.json')
        put(witness,{'version':1,'userId':USER,'accountRoot':str(account),'root':str(root),'previewId':preview,'lease':{key:lease[key] for key in ('owner','id','epoch','pid','processStartTime','bootId','writerGate')}})
        control=base/'docker.json'; put(control,{})
        binary=base/'bin'; binary.mkdir(); docker=binary/'docker'
        docker.write_text('#!'+sys.executable+'\nimport json,os,sys\nfrom pathlib import Path\nc=json.loads(Path(os.environ["PREVIEW_DOCKER_CONTROL"]).read_text())\nf=sys.argv[sys.argv.index("--filter")+1]\nif c.get("fail"): sys.exit(2)\nif c.get("mutate"):\n p=Path(c["mutate"]); value=json.loads(p.read_text()); value["leaseId"]="replaced"; p.write_text(json.dumps(value))\nif (f.startswith("name=") and c.get("named")) or (f.startswith("label=") and c.get("other")): print("remaining-container")\n')
        docker.chmod(0o700)
        q={'userId':USER,'accountRoot':str(account),'root':str(root),'previewId':preview,'home':str(home)}
        environment={**os.environ,'PATH':str(binary)+os.pathsep+os.environ.get('PATH',''),'PREVIEW_DOCKER_CONTROL':str(control)}
        yield {'root':root,'account':account,'home':home,'runtime':runtime,'inventory':inventory,'witness':witness,'lease':lease,'state':lease_file,'generation':generation,'cap':cap,'guards':guards,'control':control,'q':q,'env':environment}

def invoke(f,script=SCRIPT,crash=False):
    result=subprocess.run([sys.executable,'-I','-c',script],input=json.dumps(f['q']),capture_output=True,text=True,env=f['env'],timeout=10)
    if crash: return result
    if result.returncode!=0: raise AssertionError(result.stderr)
    return json.loads(result.stdout)
def crash_after(operation,predicate):
    needle='try:\n    response=operate(json.load(sys.stdin))'
    if SCRIPT.count(needle)!=1: raise AssertionError('recovery crash injection boundary was not found exactly once')
    hook='\noriginal_operation=os.'+operation+'\ndef interrupted(*args,**kwargs):\n    result=original_operation(*args,**kwargs)\n    if '+predicate+': os._exit(91)\n    return result\nos.'+operation+'=interrupted\n'
    return SCRIPT.replace('try:\n    response=operate(json.load(sys.stdin))',hook+'try:\n    response=operate(json.load(sys.stdin))')

class PreviewRecovery(unittest.TestCase):
    def denied(self,result,code=None):
        self.assertFalse(result.get('ok'),result)
        if code: self.assertEqual(result.get('code'),code,result)
    def test_exact_stopped_preview_completes_cloud_generation_and_retries_from_witness(self):
        with fixture() as f:
            original=load(f['generation']); inodes=[g.stat().st_ino for g in f['guards']]
            self.assertEqual(invoke(f),{'ok':True,'released':True})
            self.assertFalse(f['state'].parent.exists()); self.assertTrue(f['witness'].exists())
            generation=load(f['generation']); self.assertEqual(generation['state'],'complete'); self.assertEqual(generation['leaseId'],f['lease']['id']); self.assertNotEqual(generation['generation'],original['generation'])
            self.assertEqual([g.stat().st_ino for g in f['guards']],inodes)
            self.assertEqual(invoke(f),{'ok':True,'released':True}); self.assertEqual(load(f['generation']),generation)
    def test_server_owned_cloud_capability_recovers_without_native_engine_version(self):
        with fixture() as f:
            put(f['root']/'.chisa-bridge.json',{'protocol':3,'root':str(f['root']),'owner':'cloud-fixture','bindingEpoch':EPOCH})
            put(f['cap'],{'version':1,'root':str(f['root']),'bindingEpoch':EPOCH,'protocol':'chisa-cloud-writer-v1'})
            self.assertEqual(invoke(f),{'ok':True,'released':True})
            self.assertFalse(f['state'].parent.exists())
            self.assertEqual(load(f['generation'])['state'],'complete')
            self.assertEqual(load(f['generation'])['leaseId'],f['lease']['id'])
            self.assertEqual(invoke(f),{'ok':True,'released':True})
    def test_only_stopped_preview_is_removed_and_original_dead_birth_is_retained(self):
        with fixture() as f:
            other=f['q']['previewId'][:-16]+'c'*16
            lease={**f['lease'],'previews':[f['q']['previewId'],other],'cleanupPending':[f['q']['previewId'],'worker-unconfirmed']}; put(f['state'],lease)
            generation=load(f['generation'])
            self.assertEqual(invoke(f),{'ok':True,'released':False})
            remaining=load(f['state']); self.assertEqual(remaining['previews'],[other]); self.assertEqual(remaining['cleanupPending'],['worker-unconfirmed'])
            self.assertEqual(remaining['pid'],lease['pid']); self.assertEqual(remaining['processStartTime'],lease['processStartTime']); self.assertEqual(remaining['id'],lease['id']); self.assertEqual(load(f['generation']),generation)
            self.assertEqual(invoke(f),{'ok':True,'released':False})
    def test_multiple_orphans_release_only_after_last_exact_preview(self):
        with fixture() as f:
            other=f['q']['previewId'][:-16]+'c'*16
            lease={**f['lease'],'previews':[f['q']['previewId'],other]}; put(f['state'],lease)
            second={**load(f['witness']),'previewId':other}; put(f['inventory']/(other+'.json'),second)
            self.assertEqual(invoke(f),{'ok':True,'released':False}); f['q']['previewId']=other
            self.assertEqual(invoke(f),{'ok':True,'released':True}); self.assertFalse(f['state'].parent.exists())
    def test_live_or_unknown_owner_and_replaced_lease_never_recover(self):
        for variant in ('live','missing-birth','different-run','different-epoch','different-owner','legacy'):
            with self.subTest(variant=variant),fixture() as f:
                actual=load(f['state']); witness=load(f['witness'])
                if variant=='live':
                    actual.update(pid=os.getpid(),processStartTime=birth(os.getpid())); witness['lease'].update(pid=actual['pid'],processStartTime=actual['processStartTime'])
                elif variant=='missing-birth': witness['lease'].pop('processStartTime')
                elif variant=='different-run': actual['id']='different'
                elif variant=='different-epoch': actual['epoch']='different'
                elif variant=='different-owner': actual['owner']='sync-needed'
                else: actual['writerGate']=False; witness['lease']['writerGate']=False
                put(f['state'],actual); put(f['witness'],witness); before=f['state'].read_bytes()
                self.denied(invoke(f)); self.assertEqual(f['state'].read_bytes(),before); self.assertEqual(load(f['generation'])['state'],'dirty')
    def test_integration_barriers_jobs_and_isolated_reservations_always_refuse(self):
        for variant in ('marker','dangling','job','unknown','integration-tag','isolated'):
            with self.subTest(variant=variant),fixture() as f:
                marker=pathlib.Path(str(f['root'])+'.chisa-integration.json')
                if variant=='marker': marker.write_text('{')
                elif variant=='dangling': marker.symlink_to(f['root']/'missing')
                elif variant in ('job','unknown'): put(f['state'].parent/('sync-job.json' if variant=='job' else 'unknown.tmp'),{})
                elif variant=='integration-tag': lease=load(f['state']); lease['integrationOperation']='operation'; put(f['state'],lease)
                else: put(f['root']/'.chisa-session.json',{'sourceRoot':str(f['root'])})
                before=f['state'].read_bytes(); self.denied(invoke(f)); self.assertEqual(f['state'].read_bytes(),before)
    def test_docker_absence_and_full_workspace_inventory_are_required(self):
        for control in ({'named':True},{'other':True},{'fail':True}):
            with self.subTest(control=control),fixture() as f:
                put(f['control'],control); self.denied(invoke(f),'WORKSPACE_CLEANUP_FAILED')
                self.assertTrue(f['state'].exists()); self.assertEqual(load(f['generation'])['state'],'dirty')
                put(f['control'],{}); self.assertEqual(invoke(f),{'ok':True,'released':True})
    def test_private_inventory_and_exact_account_witness_cannot_be_redirected(self):
        for variant in ('missing','symlink','hardlink','writable','directory','account','user','root','id','version'):
            with self.subTest(variant=variant),fixture() as f:
                if variant=='missing': f['witness'].unlink()
                elif variant=='symlink':
                    saved=f['witness'].with_suffix('.saved'); f['witness'].rename(saved); f['witness'].symlink_to(saved)
                elif variant=='hardlink': os.link(f['witness'],f['witness'].with_suffix('.link'))
                elif variant=='writable': f['witness'].chmod(0o644)
                elif variant=='directory': f['inventory'].chmod(0o755)
                elif variant=='account': data=load(f['runtime']); data['userId']='other'; put(f['runtime'],data)
                else:
                    data=load(f['witness']); key={'user':'userId','root':'root','id':'previewId','version':'version'}[variant]; data[key]=True if variant=='version' else 'other'; put(f['witness'],data)
                before=f['state'].read_bytes(); self.denied(invoke(f)); self.assertEqual(f['state'].read_bytes(),before)
    def test_guard_contention_and_mutated_generation_never_publish(self):
        for selected in (0,1):
            with self.subTest(selected=selected),fixture() as f:
                with f['guards'][selected].open('r+b') as locked:
                    fcntl.flock(locked,fcntl.LOCK_EX|fcntl.LOCK_NB); self.denied(invoke(f),'WORKSPACE_BUSY')
                self.assertEqual(load(f['state'])['previews'],[f['q']['previewId']])
        with fixture() as f:
            put(f['control'],{'mutate':str(f['generation'])}); self.denied(invoke(f)); self.assertEqual(load(f['generation'])['state'],'dirty'); self.assertTrue(f['state'].exists())
    def test_crashes_after_cleanup_publication_unlink_and_rmdir_are_retryable(self):
        variants=[('replace',"args[1]=='state.json'"),('replace',"args[1].endswith('.chisa-generation.json')"),('unlink',"args[0]=='state.json'"),('rmdir',"args[0].endswith('.chisa-lease')")]
        for operation,predicate in variants:
            with self.subTest(operation=operation,predicate=predicate),fixture() as f:
                result=invoke(f,crash_after(operation,predicate),True); self.assertEqual(result.returncode,91,result.stderr)
                self.assertTrue(f['witness'].exists()); self.assertEqual(invoke(f),{'ok':True,'released':True}); self.assertFalse(f['state'].parent.exists()); self.assertEqual(load(f['generation'])['state'],'complete')
    def test_unknown_current_boot_and_missing_durability_barriers_refuse(self):
        with fixture() as f:
            unknown=SCRIPT.replace("if not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}',boot):", "boot=''\n    if not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}',boot):")
            self.denied(invoke(f,unknown)); self.assertEqual(load(f['state'])['previews'],[f['q']['previewId']])
        with fixture() as f:
            result=invoke(f,crash_after('replace',"args[1].endswith('.chisa-generation.json')"),True); self.assertEqual(result.returncode,91)
            no_sync=SCRIPT.replace('try:\n    response=operate(json.load(sys.stdin))',"def broken_sync(fd): raise OSError('fsync failure')\nos.fsync=broken_sync\ntry:\n    response=operate(json.load(sys.stdin))")
            self.denied(invoke(f,no_sync)); self.assertTrue(f['state'].exists())
            self.assertEqual(invoke(f),{'ok':True,'released':True})
            self.denied(invoke(f,no_sync))
    def test_absent_or_partial_dirty_lease_and_unrelated_completion_never_release(self):
        for variant in ('empty','absent','other-run','completed-dirty-list'):
            with self.subTest(variant=variant),fixture() as f:
                if variant in ('empty','absent'): f['state'].unlink()
                if variant=='absent': f['state'].parent.rmdir()
                if variant in ('other-run','completed-dirty-list'):
                    generation=load(f['generation']); generation['state']='complete'
                    if variant=='other-run': generation['leaseId']='different'
                    put(f['generation'],generation)
                self.denied(invoke(f))

unittest.main(argv=['preview-recovery-tests'],verbosity=2)
`;

test('real Linux orphan preview recovery preserves dead identities and crash-safe completion', { skip: process.platform !== 'linux' }, () => {
  assert.ok(helperScript, 'wrapper verification captures the production helper');
  const runner = 'import io,json,sys; value=json.load(sys.stdin); sys.stdin=io.StringIO(value["helper"]); exec(compile(value["tests"],"preview-recovery-tests","exec"))';
  const result = childProcess.spawnSync('python3', ['-I', '-c', runner], {
    input: JSON.stringify({ helper: helperScript, tests: pythonPreviewRecoveryTests }), encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
