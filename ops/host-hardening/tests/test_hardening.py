"""Local fake-data contracts; these are never production G1/admin evidence."""
import copy
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[3]
LOCATION=ROOT/'ops'/'host-hardening'/'hardening.py'
SPEC=importlib.util.spec_from_file_location('candidate_hardening',LOCATION)
h=importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(h)
EXAMPLE=ROOT/'ops'/'host-hardening'/'config.example.json'

def config():
    value=json.loads(EXAMPLE.read_text()); value['deployment']['images']={name:'registry.invalid/chisa/'+name+'@sha256:'+str(index+1)*64 for index,name in enumerate(('node_base','api','gateway','proxy','rollback_api'))}; return value

def fake_runner(c,records):
    def run(argv):
        records.append(argv)
        if argv[1:3]==['network','inspect']:
            net=c['deployment']['network']; return json.dumps([{'Id':net['account_id'],'Name':net['account_name'],'Driver':'bridge','Scope':'local','Labels':{'chisa.broker.owner':c['deployment']['owner_id']},'IPAM':{'Config':[{'Subnet':net['account_subnet']}]}}])
        if argv[1:3]==['image','inspect']: return json.dumps([{'RepoDigests':[argv[-1]],'Config':{'User':'10001:10001'}}])
        if argv[1:2]==['inspect']:
            s=c['sync']; return json.dumps([{'Id':s['container_id'],'Image':s['image_id'],'Mounts':[{'Source':m['source'],'Destination':m['target'],'RW':m['writable']} for m in s['mounts']],'NetworkSettings':{'Networks':{str(i):{'NetworkID':n} for i,n in enumerate(s['networks'])}}}])
        return ''
    return run

class CandidateTests(unittest.TestCase):
    def test_offline_render_preserves_shared_services_and_exact_api_boundary(self):
        c=config(); files=h.render(c); services=json.loads(files['compose.json'])['services']; api=services['api']; gateway=services['preview_gateway']
        self.assertEqual(api['user'],'10001:10001'); self.assertTrue(api['read_only']); self.assertEqual(api['cap_drop'],['ALL']); self.assertEqual(api['restart'],'no')
        self.assertNotIn('network_mode',api); self.assertNotIn('pid',api); self.assertEqual(set(api['networks']),{'service'}); self.assertEqual(set(gateway['networks']),{'service','account'})
        self.assertNotIn('ports',api); self.assertEqual(services['ingress_proxy']['ports'],['127.0.0.1:18791:8080']); self.assertNotIn('ports',gateway)
        self.assertFalse(any('docker.sock' in v['source'] for v in api['volumes'])); self.assertTrue(all(not v['bind']['create_host_path'] for v in api['volumes']))
        self.assertFalse(any(v['source']=='/opt/chisacloudcode/home' for v in api['volumes'])); self.assertNotIn('JWT_SECRET',json.dumps(api['environment']))
        self.assertNotIn('/run/chisa-authority',str(gateway['volumes'])); self.assertIn('/run/chisa-preview-renew',str(gateway['volumes'])); self.assertNotIn('/run/chisa-preview-renew',str(api['volumes'])); self.assertNotIn('/etc/chisa-preview-authority',str(api['volumes'])); self.assertIn('Restart=no',files['systemd/chisa-candidate.service'].decode())
        firewall=files['firewall/restrict.render.sh'].decode(); self.assertIn('iptables -w 5 -I INPUT 1',firewall); self.assertIn('ip6tables -w 5 -I INPUT 1',firewall); self.assertNotIn('6768',firewall); self.assertNotIn('2096',firewall); self.assertNotIn(' -F',firewall)
        ssh=files['ssh/60-chisa-admin.conf'].decode(); self.assertIn('operator_required@192.0.2.10/32',ssh); self.assertIn('operator_required@2001:db8::10/128',ssh)
    def test_bad_host_paths_mounts_privilege_mutable_images_and_account_injection_reject(self):
        mutations=[lambda c:c['management'].update(user='root'),lambda c:c['management'].update(sources=['0.0.0.0/0','::/0']),lambda c:c['management'].update(firewall_backend='nft'),lambda c:c['deployment']['api'].update(uid=0),lambda c:c['deployment']['api'].update(command=['sh','-c','bad']),lambda c:c['deployment']['images'].update(api='registry.invalid/api:latest'),lambda c:c['deployment']['mounts'][0].update(source='/run/docker.sock'),lambda c:c['deployment']['authority_files'][0].update(source='/etc/chisa-broker/private-key'),lambda c:c['deployment']['gateway'].update(account_id='other'),lambda c:c['deployment']['network'].update(account_subnet=c['deployment']['network']['service_subnet']),lambda c:c['ports'][5].update(action='retire'),lambda c:c['sync'].update(retire=True)]
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                c=config(); mutation(c)
                with self.assertRaises((h.Blocked,ValueError)): h.render(c)
    def test_renewal_group_is_never_an_api_primary_or_supplemental_group(self):
        current=config(); forbidden={current['deployment']['api']['uid'],current['deployment']['api']['gid'],current['deployment']['recovery']['client_gid'],current['deployment']['recovery']['metadata_gid'],*(s['gid'] for s in current['deployment']['socket_directories'])}
        for group in forbidden:
            with self.subTest(group=group):
                value=config(); value['deployment']['gateway']['renew_gid']=group
                with self.assertRaisesRegex(ValueError,'renewal GID'): h.render(value)
        services=json.loads(h.render(current)['compose.json'])['services']; group=str(current['deployment']['gateway']['renew_gid'])
        self.assertNotIn(group,services['api']['group_add']); self.assertIn(group,services['preview_gateway']['group_add'])
    def test_recovery_mounts_are_fixed_readonly_and_never_enter_gateway(self):
        c=config(); files=h.render(c); services=json.loads(files['compose.json'])['services']; recovery=c['deployment']['recovery']; api=services['api']; gateway=services['preview_gateway']
        for name in ('config_path','native_witness_directory'):
            volume=next(item for item in api['volumes'] if item['source']==recovery[name]); self.assertEqual(volume['target'],recovery[name]); self.assertTrue(volume['read_only']); self.assertFalse(volume['bind']['create_host_path'])
        self.assertIn(str(recovery['client_gid']),api['group_add']); self.assertNotIn(str(recovery['client_gid']),gateway['group_add']); self.assertNotIn(recovery['native_witness_directory'],str(gateway['volumes']))
        self.assertNotIn(recovery['authority_manifest'],str(api['volumes'])); self.assertNotIn('/var/lib/chisa-workspace-stopped',str(api['volumes']))
        mount=next(item for item in c['deployment']['mounts'] if item['purpose']=='workspace'); self.assertEqual((mount['uid'],mount['gid'],mount['mode']),(0,10105,'01770'))
        contract=json.loads(files['recovery-mount-contract.json']); self.assertFalse(contract['stopRecordsGenerated']); self.assertIsNone(contract['independentStopProducerEvidence'])
    def test_recovery_dynamic_policy_paths_group_collisions_and_weak_metadata_modes_reject(self):
        mutations=[lambda c:c['deployment']['recovery'].update(config_path='/etc/chisa/other.json'),lambda c:c['deployment']['recovery'].update(native_witness_directory='/var/lib/chisa-workspace-stopped'),lambda c:c['deployment']['recovery'].update(authority_manifest='/etc/chisa-client/authority-private.json'),lambda c:c['deployment']['recovery'].update(leaseId='caller-value'),lambda c:c['deployment']['recovery'].update(config_sha256='bad'),lambda c:c['deployment']['recovery'].update(client_gid=c['deployment']['gateway']['renew_gid']),lambda c:c['deployment']['recovery'].update(client_gid=c['deployment']['api']['gid']),lambda c:c['deployment']['mounts'][1].update(uid=10001),lambda c:c['deployment']['mounts'][1].update(mode='0770')]
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                c=config(); mutation(c)
                with self.assertRaises(ValueError): h.render(c)
    def test_recovery_static_catalog_matches_client_and_never_selects_dynamic_broker_state(self):
        c=config()['deployment']; module=h.deployment_module(); root=c['api']['workspaces_root']+'/project'; entry={'root':root,'userId':'17','ownerId':c['owner_id'],'workspaceId':'workspace','generation':'generation','bindingEpoch':'epoch','sessionId':'session','ticket':'a'*64,'nativeWitnessPath':c['recovery']['native_witness_directory']+'/project.json'}
        catalog={'version':1,'authoritySocketPath':c['gateway']['grant_issuer_socket'],'authorityUid':0,'supervisorUid':0,'workspaces':[entry]}; client={'version':1,'brokerSocketPath':c['gateway']['broker_socket'],'authoritySocketPath':catalog['authoritySocketPath'],'accounts':[{'userId':'17','accountRoot':c['api']['workspaces_root'],'workspaces':[{key:entry[key] for key in ('root','workspaceId','generation','ticket')}|{'previewProfileId':'preview'}]}]}
        self.assertTrue(module.validate_recovery_catalog(c,catalog,client))
        for change in ({'ticket':'b'*64},{'ownerId':'other'},{'nativeWitnessPath':'/run/other.json'},{'leaseId':'caller-choice'}):
            with self.subTest(change=change):
                bad=copy.deepcopy(catalog); bad['workspaces'][0].update(change)
                with self.assertRaises(ValueError): module.validate_recovery_catalog(c,bad,client)
        bad=copy.deepcopy(catalog); bad['workspaces'].append(copy.deepcopy(entry))
        with self.assertRaises(ValueError): module.validate_recovery_catalog(c,bad,client)
        bad=copy.deepcopy(client); bad['accounts'][0]['workspaces'].append({**bad['accounts'][0]['workspaces'][0],'root':root+'-missing'})
        with self.assertRaises(ValueError): module.validate_recovery_catalog(c,catalog,bad)
    def test_missing_independent_stop_producer_is_an_explicit_activation_gate(self):
        with tempfile.TemporaryDirectory() as base:
            c=config(); target=Path(base).resolve()/'bundle'; h.write_bundle(c,target)
            report=h.preflight(c,target,runner=fake_runner(c,[]),check_host=False)
            self.assertFalse(report['ready']); self.assertIn('RECOVERY_STOP_PRODUCER_MISSING',[item['code'] for item in report['blockers']])
    def test_bundle_rejects_changed_source_extra_file_and_symlink(self):
        with tempfile.TemporaryDirectory() as base:
            c=config(); target=Path(base).resolve()/'bundle'; h.write_bundle(c,target); h.verify_bundle(c,target)
            (target/'compose.json').write_text('{}')
            with self.assertRaisesRegex(h.Blocked,'artifact changed'): h.verify_bundle(c,target)
        with tempfile.TemporaryDirectory() as base:
            c=config(); target=Path(base).resolve()/'bundle'; h.write_bundle(c,target); (target/'extra').write_text('extra')
            with self.assertRaisesRegex(h.Blocked,'Unexpected'): h.verify_bundle(c,target)
    def test_evidence_reference_update_does_not_create_bundlehash_cycle(self):
        c=config(); before=h.configuration_digest(c); c['evidence']['g1']={'path':'/etc/chisa-hardening/g1.json','sha256':'a'*64}; self.assertEqual(h.configuration_digest(c),before)
        c['ports'][0]['sources']=['192.0.2.11/32']; self.assertNotEqual(h.configuration_digest(c),before)
    def test_default_missing_digests_and_missing_evidence_fail_without_host_mutation(self):
        with tempfile.TemporaryDirectory() as base:
            c=json.loads(EXAMPLE.read_text()); target=Path(base).resolve()/'bundle'; h.write_bundle(c,target); calls=[]
            report=h.preflight(c,target,runner=fake_runner(c,calls),check_host=False)
            self.assertFalse(report['ready']); self.assertIn('deployment',[x['check'] for x in report['blockers']]); self.assertEqual(calls,[])
            self.assertTrue(all(x['code']=='EVIDENCE_MISSING' for x in report['blockers'] if x['check'].startswith('evidence_')))
    def test_configured_readonly_image_network_checks_are_actual_receipt_based(self):
        with tempfile.TemporaryDirectory() as base:
            c=config(); target=Path(base).resolve()/'bundle'; h.write_bundle(c,target); calls=[]
            report=h.preflight(c,target,runner=fake_runner(c,calls),check_host=False,evidence=False); self.assertTrue(report['ready']); self.assertEqual(len(calls),5)
            changed=lambda argv: json.dumps([{'Id':'f'*64}]) if argv[1:3]==['network','inspect'] else fake_runner(c,calls)(argv)
            self.assertFalse(h.preflight(c,target,runner=changed,check_host=False,evidence=False)['ready'])
    def test_docker_forward_rule_uses_original_published_destination_and_exact_inverse(self):
        c=config(); item=c['ports'][6]; item.update(action='restrict',sources=['192.0.2.10/32','2001:db8::10/128'],container_id=c['sync']['container_id'],container_port=2222)
        before,after=h.render_firewall(c); self.assertIn('--ctdir ORIGINAL --ctorigdst 192.0.2.20 --ctorigdstport 32768',before); self.assertIn(' -I DOCKER-USER 1 ',before); self.assertIn(' -D DOCKER-USER ',after); self.assertNotIn('--dport 2222',before); self.assertNotIn('flush',before.splitlines()[-1])
    def test_missing_gate_never_calls_stateful_runner_or_creates_change_state(self):
        with tempfile.TemporaryDirectory() as base:
            c=config(); target=Path(base).resolve()/'bundle'; h.write_bundle(c,target); calls=[]; state=Path(base)/'not-created'
            with patch.object(h,'preflight',return_value={'ready':False,'blockers':[{'code':'EVIDENCE_MISSING'}]}):
                with self.assertRaises(h.Blocked): h.apply(c,target,state,execute=True,runner=lambda argv:calls.append(argv))
            self.assertFalse(state.exists()); self.assertEqual(calls,[])
    def test_guarded_before_after_install_and_rollback_preserve_foreign_content(self):
        with tempfile.TemporaryDirectory() as base:
            root=Path(base).resolve(); state=root/'state'; bundle=root/'bundle'; c=config(); h.write_bundle(c,bundle)
            targets={name:str(root/('target-'+str(index))) for index,name in enumerate(h.INSTALL_FILES)}
            original=list(targets.values())[0]; Path(original).write_bytes(b'original-config'); Path(original).chmod(0o600)
            report={'ready':True,'blockers':[],'bundle_sha256':'a'*64}
            # Only the target sandbox guard is replaced. Actual file writes,
            # hashing, atomic rename and journal read/CAS code are exercised.
            posix_mode=h.stat.S_IMODE
            with patch.object(h,'INSTALL_FILES',targets),patch.object(h,'protected'),patch.object(h,'change_lock',side_effect=lambda state,execute:__import__('contextlib').nullcontext()),patch.object(h,'preflight',return_value=report),patch.object(h,'sync_directory'),patch.object(h.stat,'S_IMODE',side_effect=lambda value:posix_mode(value)&~0o022 if os.name=='nt' else posix_mode(value)):
                with patch.object(h,'require',side_effect=lambda ok,code,msg: None if ok or code=='STATE_PATH_INVALID' else (_ for _ in ()).throw(h.Blocked(code,msg))):
                    if os.name=='nt':
                        # Windows cannot fsync directories; equivalent product
                        # atomic-file contract is isolated from Linux directory fsync.
                        def atomic(filename,data,mode=0o600):
                            temp=filename.with_suffix('.pending'); temp.write_bytes(data); os.replace(temp,filename)
                        context=patch.object(h,'atomic_write',side_effect=atomic)
                    else: context=patch.object(h,'protected')
                    with context:
                        h.apply(c,bundle,state,execute=True); self.assertNotEqual(Path(original).read_bytes(),b'original-config')
                        h.rollback(c,bundle,state,execute=True); self.assertEqual(Path(original).read_bytes(),b'original-config'); self.assertFalse(Path(list(targets.values())[1]).exists())
                        Path(original).write_bytes(b'foreign-newer')
                        with self.assertRaisesRegex(h.Blocked,'Newer/foreign'): h.rollback(c,bundle,state,execute=True)

class EvidenceTests(unittest.TestCase):
    def fixture(self,base,kind):
        c=config(); record={'version':1,'kind':kind,'change_id':c['change_id'],'machine':copy.deepcopy(c['machine']),'bundle_sha256':'b'*64,'created_at':(h.now()-dt.timedelta(seconds=10)).isoformat(),'expires_at':(h.now()+dt.timedelta(minutes=10)).isoformat(),'reviewer':'independent-admin','requested_by':'deploy-admin','artifacts':[],'checks':{}}
        data={'offsite_commit':{'committed':True,'independent_storage_verified':True},'isolated_verification':{'verified':True,'network_isolated':True,'all_scopes_verified':True},'production_drill':{'production_drill_passed':True,'application_smoke_passed':True,'uid_acl_xattr_lease_mapping_passed':True,'rollback_passed':True,'rpo_seconds':60,'rto_seconds':900},'monitor_delivery':{'receiver_confirmed':True}}
        for name,value in data.items():
            value.update(machine=copy.deepcopy(c['machine']),change_id=c['change_id'],reviewer=record['reviewer'],verified_at=h.now().isoformat(),restore_point_id='same-fake-recovery-point',failure_domain='independent-fake-storage',recovery_machine_id_sha256='f'*64)
            file=Path(base)/name; file.write_bytes(h.encoded(value)); record['artifacts'].append({'name':name,'path':file.as_posix(),'sha256':h.sha(file.read_bytes())})
        file=Path(base)/kind; file.write_bytes(h.encoded(record)); c['evidence'][kind]={'path':file.as_posix(),'sha256':h.sha(file.read_bytes())}; return c,record,file
    def load(self,c,kind):
        # Cross-platform fixtures bypass root path ownership only; scope, digest,
        # freshness and actual referenced artifact validation remain exercised.
        with patch.object(h,'absolute',side_effect=lambda value:value),patch.object(h,'protected'): return h.load_evidence(c,kind,'b'*64,trusted=False)
    def test_complete_fake_g1_is_accepted_only_with_all_independent_artifacts(self):
        with tempfile.TemporaryDirectory() as base:
            c,record,file=self.fixture(base,'g1'); self.assertEqual(self.load(c,'g1')['kind'],'g1')
            c['evidence']['g1']['sha256']='e'*64
            with self.assertRaisesRegex(h.Blocked,'digest changed'): self.load(c,'g1')
    def test_stale_cross_machine_self_review_and_verify_only_cannot_satisfy_g1(self):
        for case in ('stale','machine','self','verify-only'):
            with self.subTest(case=case),tempfile.TemporaryDirectory() as base:
                c,record,file=self.fixture(base,'g1')
                if case=='stale': record['expires_at']=(h.now()-dt.timedelta(seconds=1)).isoformat()
                if case=='machine': record['machine']['boot_id']='other'
                if case=='self': record['reviewer']=record['requested_by']
                if case=='verify-only': record['artifacts']=[item for item in record['artifacts'] if item['name']=='isolated_verification']
                file.write_bytes(h.encoded(record)); c['evidence']['g1']['sha256']=h.sha(file.read_bytes())
                with self.assertRaises(h.Blocked): self.load(c,'g1')

class FenceTests(unittest.TestCase):
    def test_all_historical_write_mount_containers_and_supervisors_must_be_fenced(self):
        c=config(); identifier='a'*64; evidence={'writer_container_ids':[identifier],'supervisors':['chisa-workspace-api.service',c['sync']['unit']]}
        container={'Id':identifier,'State':{'Running':False,'Paused':False,'Restarting':False},'HostConfig':{'RestartPolicy':{'Name':'no'}},'Mounts':[{'Source':'/opt/chisacloudcode/data','RW':True}]}
        def runner(argv):
            if argv[1:3]==['ps','-aq']: return identifier+'\n'
            if argv[1:2]==['inspect']: return json.dumps([container])
            if argv[1:2]==['show']: return 'Id='+argv[2]+'\nActiveState=inactive\nUnitFileState=masked\nRestart=always\n'
            raise AssertionError(argv)
        with patch.object(h,'load_evidence',return_value=evidence):
            self.assertEqual(h.assert_full_fence(c,'b'*64,runner=runner),evidence)
            container['HostConfig']['RestartPolicy']['Name']='unless-stopped'
            with self.assertRaisesRegex(h.Blocked,'restartable'): h.assert_full_fence(c,'b'*64,runner=runner)
            container['HostConfig']['RestartPolicy']['Name']='no'; evidence['writer_container_ids']=[]
            with self.assertRaisesRegex(h.Blocked,'every current/historical'): h.assert_full_fence(c,'b'*64,runner=runner)
    def test_retirement_needs_actual_fence_and_zero_consumers_before_any_mask_stop(self):
        c=config(); c['sync']['retire']=True; c['sync']['consumers']=[]; calls=[]
        with patch.object(h,'preflight',return_value={'ready':False,'blockers':[]}):
            with self.assertRaises(h.Blocked): h.retire_sync(c,Path('/unused'),Path('/unused'),execute=True,runner=lambda argv:calls.append(argv))
        self.assertEqual(calls,[])
    def test_non_root_or_non_linux_stateful_change_cannot_create_guard(self):
        if h.sys.platform=='linux' and os.geteuid()==0: self.skipTest('negative unprivileged contract uses actual non-root/Windows process')
        with tempfile.TemporaryDirectory() as base:
            state=Path(base)/'state'
            with self.assertRaises(h.Blocked):
                with h.change_lock(state,True): self.fail('must not enter')
            self.assertFalse((Path(base)/'change.guard').exists())

if __name__=='__main__': unittest.main(verbosity=2)
