import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import test, { mock } from 'node:test';

import { recoverStoppedWorkspacePreview } from '../workspace-preview-recovery.service.js';
import { workspaceBrokerRecoveryPython } from '../workspace-broker-recovery.service.js';

const request={ userId: 'fixture-user',accountRoot: '/srv/workspaces',root: '/srv/workspaces/project',previewId: 'fixture-preview' }; let helperScript='';
test('orphan wrapper is bounded Linux-only and passes identity selectors without caller cleanup evidence',() => {
  const platform=mock.method(os,'platform',() => 'linux' as NodeJS.Platform); let response: Partial<childProcess.SpawnSyncReturns<string>>={ status: 0,stdout: '{"ok":true,"released":false}',stderr: '' };
  const launch=mock.method(childProcess,'spawnSync',(command: string,args: string[],options: childProcess.SpawnSyncOptionsWithStringEncoding) => {
    assert.equal(command,'python3'); assert.deepEqual(args.slice(0,2),['-I','-c']); helperScript=args[2]; assert.equal(options.timeout,30000); assert.equal(options.maxBuffer,65536); assert.equal(options.shell,undefined);
    assert.deepEqual(JSON.parse(String(options.input)),{ ...request,home: os.homedir() }); assert.ok(!args[2].includes("['docker'")); assert.ok(!args[2].includes('ProcessLookupError')); return response as childProcess.SpawnSyncReturns<string>;
  }); syncBuiltinESMExports();
  try {
    assert.deepEqual(recoverStoppedWorkspacePreview(request),{ released: false }); response.stdout='{"ok":true,"released":true}'; assert.deepEqual(recoverStoppedWorkspacePreview(request),{ released: true });
    for (const stdout of ['{}','null','{"ok":true}','{"ok":true,"released":"true"}','{']) { response.stdout=stdout; assert.throws(() => recoverStoppedWorkspacePreview(request),{ code: 'WORKSPACE_PREVIEW_RECOVERY_REQUIRED' }); }
    response={ status: null,signal: 'SIGKILL',stdout: '{"ok":true,"released":true}' }; assert.throws(() => recoverStoppedWorkspacePreview(request),{ code: 'WORKSPACE_PREVIEW_RECOVERY_REQUIRED' });
    platform.mock.mockImplementation(() => 'win32'); assert.throws(() => recoverStoppedWorkspacePreview(request),{ code: 'WORKSPACE_PREVIEW_RECOVERY_UNAVAILABLE' });
  } finally { launch.mock.restore(); platform.mock.restore(); syncBuiltinESMExports(); }
});

const pythonTests=String.raw`
import contextlib, fcntl, hashlib, http.server, json, os, pathlib, socket, socketserver, struct, subprocess, sys, tempfile, threading, time, unittest
DOCUMENT=json.load(sys.stdin)
SCRIPT=DOCUMENT['helper']
COORDINATOR=DOCUMENT['coordinator']
EPOCH='fixture-epoch'; USER='fixture-user'; BOOT=pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()
def put(file,value): file.write_text(json.dumps(value)); file.chmod(0o600)
def birth(pid): return pathlib.Path('/proc/'+str(pid)+'/stat').read_text().rsplit(')',1)[1].split()[19]
class UnixServer(socketserver.ThreadingMixIn,socketserver.UnixStreamServer): daemon_threads=True
@contextlib.contextmanager
def fixture():
    with tempfile.TemporaryDirectory(prefix='chisa-trusted-recovery-') as temporary:
        base=pathlib.Path(temporary).resolve(); home=base/'home'; home.mkdir(mode=0o700); account=base/'workspaces'; account.mkdir(); root=account/'project'; root.mkdir()
        state=home/'.chisa-workspace-runtime'; state.mkdir(mode=0o700); inventory=state/'previews'; inventory.mkdir(mode=0o700)
        owner=hashlib.sha256((str(account)+'\0'+USER).encode()).hexdigest(); preview='chisa-account-preview-'+owner[:20]+'-'+'a'*16
        put(state/(hashlib.sha256(str(account).encode()).hexdigest()[:24]+'.json'),{'version':1,'root':str(account),'userId':USER,'owner':owner[:24]})
        child=subprocess.Popen([sys.executable,'-I','-c','import time;time.sleep(60)'])
        writer={'pid':child.pid,'processStartTime':birth(child.pid),'bootId':BOOT,'pidNamespace':os.readlink('/proc/'+str(child.pid)+'/ns/pid')}; child.terminate(); child.wait(timeout=5)
        lease={'owner':'claude','id':'old-run','epoch':EPOCH,**writer,'brokerLeaseId':'independent-broker-lease','brokerSessionId':'session','writerGate':True,'previews':[preview],'cleanupPending':[]}
        directory=pathlib.Path(str(root)+'.chisa-lease'); directory.mkdir(mode=0o700); put(directory/'state.json',lease); (directory/'state.json').chmod(0o600)
        put(root/'.chisa-bridge.json',{'bindingEpoch':EPOCH}); cap=pathlib.Path(str(root)+'.chisa-writer-capability.json'); put(cap,{'version':1,'root':str(root),'bindingEpoch':EPOCH,'protocol':'chisa-cloud-writer-v1'})
        generation=pathlib.Path(str(root)+'.chisa-generation.json'); put(generation,{'version':1,'root':str(root),'generation':'a'*64,'state':'dirty','writer':'cloud','bindingEpoch':EPOCH,'leaseId':lease['id'],'updatedAt':'2026-10-22T12:00:00Z'})
        guards=[pathlib.Path(str(root)+'.chisa-'+kind+'.guard') for kind in ('writer','lease')]
        for guard in guards: guard.touch(mode=0o600)
        witness=inventory/(preview+'.json'); put(witness,{'version':1,'userId':USER,'accountRoot':str(account),'root':str(root),'previewId':preview,'lease':{key:lease[key] for key in ('owner','id','epoch','pid','processStartTime','bootId','pidNamespace','brokerLeaseId','brokerSessionId','writerGate')}}); witness.chmod(0o600)
        trusted=base/'authority'; trusted.mkdir(mode=0o750); stopped=trusted/'stopped.json'; config_path=trusted/'recovery.json'
        scope={'workspaceId':'workspace','generation':'generation','sessionId':'session','bindingEpoch':EPOCH,'root':str(root),'userId':USER,'ownerId':'owner','legacyReservationId':lease['id']}
        trusted_witness={'version':1,**scope,'active':True,'expiresAt':int(time.time()*1000)+60000,'writer':writer,'supervisorStopped':{**writer,'legacyReservationId':lease['id'],'bindingEpoch':EPOCH,'stopped':True,'stopId':'trusted-supervisor-stop'}}; put(stopped,trusted_witness)
        control={'cleanup':True,'resourceId':'b'*64,'operationId':preview,'calls':[],'bodies':[]}
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self,*args): pass
            def do_POST(self):
                body=json.loads(self.rfile.read(int(self.headers['Content-Length']))); control['calls'].append(self.path); control['bodies'].append(body)
                if self.path!='/v1/release' or self.headers.get('Authorization') is not None or body.get('ticket')!='c'*64 or any(body.get(key)!=scope[key] for key in ('workspaceId','generation','sessionId','bindingEpoch','root','userId','legacyReservationId')) or body.get('purpose') not in ('live-writer-release','legacy-writer-release') or body.get('leaseId','independent-broker-lease')!='independent-broker-lease': self.send_error(403); return
                pid,uid,gid=struct.unpack('3i',self.connection.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,struct.calcsize('3i')))
                helper=pathlib.Path('/proc/'+str(pid)+'/stat').read_text().rsplit(')',1)[1].split(); parent=int(helper[1]); parent_start=birth(parent); parent_ns=os.readlink('/proc/'+str(parent)+'/ns/pid'); control['peer']={'pid':pid,'uid':uid,'gid':gid,'parent':parent,'parentStart':parent_start,'parentNamespace':parent_ns}
                expected_parent=control.get('parent')
                if body['purpose']=='live-writer-release' and (not expected_parent or parent!=expected_parent['pid'] or parent_start!=expected_parent['processStartTime'] or parent_ns!=expected_parent['pidNamespace']): self.send_error(403); return
                if body['purpose']=='legacy-writer-release' and control.get('denyLegacy'): self.send_error(403); return
                value={**scope,'leaseId':'independent-broker-lease','profileId':'worker','state':'closed','quiescent':control['cleanup'],'cleanupConfirmed':control['cleanup'],'resourceInventoryComplete':True,'closedAt':1,'confirmedAt':2,'brokerInstanceId':'fixture-broker','resources':[{'operationId':control['operationId'],'resourceId':control['resourceId']}]}
                value.update(control.get('receiptChange',{}))
                for field in control.get('omitReceipt',[]): value.pop(field,None)
                if control.get('mutate'):
                    current=json.loads(generation.read_text()); current['leaseId']='replacement'; put(generation,current)
                encoded=json.dumps(value).encode(); self.send_response(200); self.send_header('Content-Length',str(len(encoded))); self.end_headers(); self.wfile.write(encoded)
        socket_path=trusted/'authority.sock'; server=UnixServer(str(socket_path),Handler); socket_path.chmod(0o660); thread=threading.Thread(target=server.serve_forever,daemon=True); thread.start()
        entry={key:scope[key] for key in ('root','userId','ownerId','workspaceId','generation','bindingEpoch','sessionId')}; entry.update(ticket='c'*64,nativeWitnessPath=str(stopped))
        config={'version':1,'authoritySocketPath':str(socket_path),'authorityUid':0,'supervisorUid':0,'workspaces':[entry]}; put(config_path,config)
        q={'userId':USER,'root':str(root),'accountRoot':str(account),'previewId':preview,'home':str(home)}
        yield {'root':root,'q':q,'lease':lease,'state':directory/'state.json','witness':witness,'generation':generation,'guards':guards,'trusted':stopped,'trustedValue':trusted_witness,'config':config_path,'configValue':config,'control':control}
        server.shutdown(); server.server_close(); thread.join(timeout=5)
def invoke(f,script=SCRIPT):
    exact=script.replace("RECOVERY_CONFIG='/etc/chisa/workspace-broker-recovery.json'",'RECOVERY_CONFIG='+repr(str(f['config'])))
    result=subprocess.run([sys.executable,'-I','-c',exact],input=json.dumps(f['q']),text=True,capture_output=True,timeout=15)
    if result.returncode: raise AssertionError(result.stderr)
    return json.loads(result.stdout)
class Recovery(unittest.TestCase):
    def test_actual_peer_cleanup_preserves_guards_and_witness_then_publishes_complete(self):
        with fixture() as f:
            inodes=[guard.stat().st_ino for guard in f['guards']]
            self.assertEqual(invoke(f),{'ok':True,'released':True}); self.assertFalse(f['state'].parent.exists()); self.assertTrue(f['witness'].exists())
            self.assertEqual([guard.stat().st_ino for guard in f['guards']],inodes); self.assertEqual(json.loads(f['generation'].read_text())['state'],'complete'); self.assertIn('/v1/release',f['control']['calls']); self.assertEqual(set(f['control']['calls']),{'/v1/release'})
            self.assertEqual(invoke(f),{'ok':True,'released':True})
    def test_complete_lease_inventory_can_prove_pre_dispatch_absence_only_with_explicit_independent_flag(self):
        for variant in ('empty','other-complete-operation','missing-flag','false-flag','false-quiescence','false-cleanup'):
            with self.subTest(variant=variant),fixture() as f:
                f['control']['receiptChange']={'resources':[] if variant!='other-complete-operation' else [{'operationId':'other','resourceId':'b'*64}]}
                if variant=='missing-flag': f['control']['omitReceipt']=['resourceInventoryComplete']
                elif variant=='false-flag': f['control']['receiptChange']['resourceInventoryComplete']=False
                elif variant=='false-quiescence': f['control']['receiptChange']['quiescent']=False
                elif variant=='false-cleanup': f['control']['receiptChange']['cleanupConfirmed']=False
                inodes=[guard.stat().st_ino for guard in f['guards']]; before=f['state'].read_bytes()
                if variant in ('empty','other-complete-operation'):
                    self.assertEqual(invoke(f),{'ok':True,'released':True}); self.assertFalse(f['state'].parent.exists()); self.assertEqual(json.loads(f['generation'].read_text())['state'],'complete')
                else:
                    self.assertFalse(invoke(f)['ok']); self.assertEqual(f['state'].read_bytes(),before); self.assertEqual(json.loads(f['generation'].read_text())['state'],'dirty')
                self.assertEqual([guard.stat().st_ino for guard in f['guards']],inodes)
    def test_current_namespace_missing_pid_without_independent_stop_receipt_is_never_death_proof(self):
        for variant in ('missing','wrong-namespace','wrong-birth','false-stop','untrusted-file','untrusted-peer'):
            with self.subTest(variant=variant),fixture() as f:
                value=dict(f['trustedValue']); value['supervisorStopped']=dict(value['supervisorStopped'])
                if variant=='missing': value.pop('supervisorStopped')
                elif variant=='wrong-namespace': value['supervisorStopped']['pidNamespace']='pid:[999]'
                elif variant=='wrong-birth': value['supervisorStopped']['processStartTime']='0'
                elif variant=='false-stop': value['supervisorStopped']['stopped']=False
                elif variant=='untrusted-file': f['trusted'].chmod(0o666)
                elif variant=='untrusted-peer': config=dict(f['configValue']); config['authorityUid']=999; put(f['config'],config)
                if variant not in ('untrusted-file','untrusted-peer'): put(f['trusted'],value)
                before=f['state'].read_bytes(); self.assertFalse(invoke(f)['ok']); self.assertEqual(f['state'].read_bytes(),before); self.assertEqual(json.loads(f['generation'].read_text())['state'],'dirty')
    def test_api_bool_wrong_immutable_resource_or_partial_broker_cleanup_never_releases(self):
        for variant in ('false','wrong-op','bad-resource','forged-bool'):
            with self.subTest(variant=variant),fixture() as f:
                if variant=='false': f['control']['cleanup']=False
                elif variant=='wrong-op': f['control']['operationId']='other'; f['control']['receiptChange']={'resourceInventoryComplete':False}
                elif variant=='bad-resource': f['control']['resourceId']='name-not-id'
                else: f['q']['cleanupConfirmed']=True; f['control']['cleanup']=False
                self.assertFalse(invoke(f)['ok']); self.assertTrue(f['state'].exists())
    def test_permanent_guard_contention_and_generation_races_keep_writer(self):
        for index in (0,1):
            with self.subTest(index=index),fixture() as f:
                with f['guards'][index].open('r+b') as lock:
                    fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB); self.assertEqual(invoke(f)['code'],'WORKSPACE_BUSY')
        with fixture() as f:
            f['control']['mutate']=True; self.assertFalse(invoke(f)['ok']); self.assertTrue(f['state'].exists())
    def test_live_parent_birth_namespace_and_independent_broker_authority_allow_normal_release(self):
        with fixture() as f:
            writer={'pid':os.getpid(),'processStartTime':birth(os.getpid()),'bootId':BOOT,'pidNamespace':os.readlink('/proc/self/ns/pid')}; f['control']['parent']=writer
            # Live release requires a positively observed parent, not an orphan
            # stop file or a previous API-side closed receipt.
            f['trusted'].unlink(); lease={**f['lease'],**writer,'closeReceipt':{'state':'closed','cleanupConfirmed':True}}
            script="import json,os,re,stat,sys\n"+COORDINATOR+"\ntry:\n trusted_workspace_cleanup(sys.argv[1],json.loads(sys.argv[2]),'live-writer-release'); print('confirmed')\nexcept BaseException as error: print(str(error))\n"
            script=script.replace("RECOVERY_CONFIG='/etc/chisa/workspace-broker-recovery.json'",'RECOVERY_CONFIG='+repr(str(f['config'])))
            result=subprocess.run([sys.executable,'-I','-c',script,str(f['root']),json.dumps(lease)],capture_output=True,text=True,timeout=10); self.assertEqual(result.stdout.strip(),'confirmed'); self.assertIn('/v1/release',f['control']['calls']); self.assertEqual(set(f['control']['calls']),{'/v1/release'}); self.assertEqual(f['control']['peer']['parent'],os.getpid()); self.assertEqual(f['control']['peer']['parentStart'],writer['processStartTime']); self.assertEqual(f['control']['peer']['parentNamespace'],writer['pidNamespace'])
    def test_adopted_integration_requires_old_native_stop_current_parent_and_legacy_wire_authority(self):
        for variant in ('valid','missing-native-stop','wrong-native-supervisor-stop','invalid-old-native-writer','expired-native-stop','wrong-native-scope','missing-marker','missing-operation','missing-broker','wrong-session','wrong-parent','wrong-namespace','old-broker-refused','partial-inventory'):
            with self.subTest(variant=variant),fixture() as f:
                writer={'pid':os.getpid(),'processStartTime':birth(os.getpid()),'bootId':BOOT,'pidNamespace':os.readlink('/proc/self/ns/pid')}
                lease={**f['lease'],**writer,'integrationPeerChanged':True,'integrationOperation':'integration-op'}
                self.assertNotEqual(f['trustedValue']['writer']['pid'],writer['pid'])
                if variant=='missing-native-stop': f['trusted'].unlink()
                elif variant=='wrong-native-supervisor-stop':
                    stopped={**f['trustedValue'],'supervisorStopped':{**f['trustedValue']['supervisorStopped'],'pid':writer['pid']}}; put(f['trusted'],stopped)
                elif variant=='invalid-old-native-writer':
                    stopped={**f['trustedValue'],'writer':{**f['trustedValue']['writer'],'pid':0}}; put(f['trusted'],stopped)
                elif variant=='expired-native-stop': put(f['trusted'],{**f['trustedValue'],'expiresAt':0})
                elif variant=='wrong-native-scope': put(f['trusted'],{**f['trustedValue'],'legacyReservationId':'foreign-run'})
                elif variant=='missing-marker': lease.pop('integrationPeerChanged')
                elif variant=='missing-operation': lease.pop('integrationOperation')
                elif variant=='missing-broker': lease.pop('brokerLeaseId')
                elif variant=='wrong-session': lease['brokerSessionId']='foreign-session'
                elif variant=='wrong-parent': lease['processStartTime']='0'
                elif variant=='wrong-namespace': lease['pidNamespace']='pid:[999]'
                elif variant=='old-broker-refused': f['control']['denyLegacy']=True
                elif variant=='partial-inventory': f['control']['omitReceipt']=['resourceInventoryComplete']
                script="import json,os,re,stat,sys\n"+COORDINATOR+"\ntry:\n trusted_workspace_cleanup(sys.argv[1],json.loads(sys.argv[2]),'integration-writer-release'); print('confirmed')\nexcept BaseException: print('retained')\n"
                script=script.replace("RECOVERY_CONFIG='/etc/chisa/workspace-broker-recovery.json'",'RECOVERY_CONFIG='+repr(str(f['config'])))
                before=f['state'].read_bytes(); result=subprocess.run([sys.executable,'-I','-c',script,str(f['root']),json.dumps(lease)],capture_output=True,text=True,timeout=10)
                self.assertEqual(result.returncode,0,result.stderr); self.assertEqual(result.stdout.strip(),'confirmed' if variant=='valid' else 'retained'); self.assertEqual(f['state'].read_bytes(),before)
                if variant in ('valid','old-broker-refused','partial-inventory'):
                    self.assertEqual(f['control']['calls'],['/v1/release']); self.assertEqual(f['control']['bodies'][0]['purpose'],'legacy-writer-release'); self.assertEqual(f['control']['bodies'][0]['leaseId'],lease['brokerLeaseId']); self.assertEqual(f['control']['peer']['parent'],writer['pid'])
                else: self.assertEqual(f['control']['calls'],[])
    def test_fixed_enrollment_and_closed_receipt_must_match_both_ids_and_every_static_identity(self):
        variants=[{'leaseId':'other-independent'},{'leaseId':'old-run'},{'legacyReservationId':'different-old'},{'ownerId':'other-owner'},{'userId':'other-user'},{'root':'/other'},{'workspaceId':'other-workspace'},{'generation':'other-generation'},{'sessionId':'other-session'},{'bindingEpoch':'other-epoch'},{'state':'active'}]
        for change in variants:
            with self.subTest(change=change),fixture() as f:
                f['control']['receiptChange']=change; before=f['state'].read_bytes(); self.assertFalse(invoke(f)['ok']); self.assertEqual(f['state'].read_bytes(),before); self.assertEqual(json.loads(f['generation'].read_text())['state'],'dirty')
    def test_old_preview_inventory_cannot_drop_known_current_broker_identity(self):
        with fixture() as f:
            witness=json.loads(f['witness'].read_text()); witness['lease'].pop('brokerLeaseId'); witness['lease'].pop('brokerSessionId'); put(f['witness'],witness); f['control']['receiptChange']={'leaseId':'other-independent'}
            before=f['state'].read_bytes(); self.assertFalse(invoke(f)['ok']); self.assertEqual(f['state'].read_bytes(),before); self.assertEqual(json.loads(f['generation'].read_text())['state'],'dirty')
    def test_closed_api_receipt_cannot_replace_native_stop_and_cannot_choose_policy(self):
        with fixture() as f:
            f['trusted'].unlink(); lease=json.loads(f['state'].read_text()); lease['closeReceipt']={'state':'closed','quiescent':True,'cleanupConfirmed':True}; put(f['state'],lease); self.assertFalse(invoke(f)['ok']); self.assertEqual(f['control']['calls'],[]); self.assertTrue(f['state'].exists())
        for change in ({'leaseId':'old-run'},{'brokerSocketPath':'/run/docker.sock'},{'issuerSocketPath':'/run/issuer.sock'},{'ticket':'bad'}):
            with self.subTest(change=change),fixture() as f:
                f['configValue']['workspaces'][0].update(change); put(f['config'],f['configValue']); self.assertFalse(invoke(f)['ok']); self.assertEqual(f['control']['calls'],[])
    def test_known_broker_session_and_untrusted_legacy_labels_cannot_switch_mapping(self):
        with fixture() as f:
            lease=json.loads(f['state'].read_text()); lease['brokerSessionId']='other-session'; put(f['state'],lease)
            witness=json.loads(f['witness'].read_text()); witness['lease']['brokerSessionId']='other-session'; put(f['witness'],witness); self.assertFalse(invoke(f)['ok']); self.assertEqual(f['control']['calls'],[])
        with fixture() as f:
            # A missing old broker ID is resolved by the independent service,
            # never constructed from the filesystem label.
            lease=json.loads(f['state'].read_text()); lease.pop('brokerLeaseId'); put(f['state'],lease); witness=json.loads(f['witness'].read_text()); witness['lease'].pop('brokerLeaseId'); put(f['witness'],witness); self.assertTrue(invoke(f)['released']); self.assertNotIn('leaseId',f['control']['bodies'][0]); self.assertEqual(f['control']['bodies'][0]['legacyReservationId'],'old-run')
    def test_live_parent_namespace_uses_positive_birth_and_cannot_reuse_old_dead_identity(self):
        with fixture() as f:
            # Exercise the exact coordinator independently; it cannot interpret a
            # caller's flag or a dead PID from another namespace as live release.
            config=f['configValue']; put(f['config'],config)
            witness=f['trustedValue']; put(f['trusted'],witness)
            script="import json,os,re,stat,sys\n"+COORDINATOR+"\ntry:\n trusted_workspace_cleanup(sys.argv[1],json.loads(sys.argv[2]),'live-writer-release'); print('unsafe')\nexcept BaseException: print('retained')\n"
            script=script.replace("RECOVERY_CONFIG='/etc/chisa/workspace-broker-recovery.json'",'RECOVERY_CONFIG='+repr(str(f['config'])))
            result=subprocess.run([sys.executable,'-I','-c',script,str(f['root']),json.dumps(f['lease'])],capture_output=True,text=True,timeout=10); self.assertEqual(result.stdout.strip(),'retained')
unittest.main(argv=['trusted-recovery'],verbosity=2)
`;
test('real Linux trusted Unix peer quiescence and old guarded recovery preserve negative evidence',{ skip: process.platform!=='linux' || process.getuid?.()!==0 },() => {
  assert.ok(helperScript); const result=childProcess.spawnSync('python3',['-I','-c',pythonTests],{ input: JSON.stringify({ helper: helperScript,coordinator: workspaceBrokerRecoveryPython }),encoding: 'utf8',timeout: 60000,maxBuffer: 1024*1024 }); assert.equal(result.status,0,result.stdout+result.stderr);
});
