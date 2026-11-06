#!/usr/bin/env python3
"""Root Linux private temporary fixture; never inspects or changes a real service."""
import contextlib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

HERE=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('hardening',HERE/'hardening.py'); h=importlib.util.module_from_spec(spec); spec.loader.exec_module(h)

@unittest.skipUnless(h.sys.platform=='linux' and os.geteuid()==0,'real root Linux filesystem/guard contract')
class LinuxGuardTests(unittest.TestCase):
    def test_real_permanent_guard_contention_and_inode_stability(self):
        base=Path(tempfile.mkdtemp(prefix='chisa-hardening-guard-',dir='/run')); base.chmod(0o700)
        try:
            state=base/'change';
            with h.change_lock(state,True):
                guard=base/'change.guard'; before=guard.stat()
                with self.assertRaisesRegex(h.Blocked,'Another configuration'):
                    with h.change_lock(state,True): self.fail('exclusive guard opened twice')
            with h.change_lock(state,True): self.assertEqual((guard.stat().st_dev,guard.stat().st_ino),(before.st_dev,before.st_ino))
            guard.unlink()
        finally: base.rmdir()
    def test_root_evidence_symlink_hardlink_and_writable_parent_are_refused(self):
        base=Path(tempfile.mkdtemp(prefix='chisa-hardening-evidence-',dir='/run')); base.chmod(0o700)
        try:
            record=base/'record.json'; record.write_text('{}'); record.chmod(0o600); self.assertEqual(h.read_json(record,True),{})
            alias=base/'alias.json'; os.link(record,alias)
            with self.assertRaises(h.Blocked): h.read_json(record,True)
            alias.unlink(); alias.symlink_to(record)
            with self.assertRaises(h.Blocked): h.read_json(alias,True)
            alias.unlink(); base.chmod(0o770)
            with self.assertRaises(h.Blocked): h.read_json(record,True)
            base.chmod(0o700); record.unlink()
        finally: base.rmdir()
    def test_root_recovery_layout_pins_real_permissions_catalogs_and_independent_producer_gate(self):
        base=Path(tempfile.mkdtemp(prefix='chisa-recovery-layout-',dir='/run')); base.chmod(0o700)
        try:
            module=h.deployment_module(); c=json.loads((HERE/'config.example.json').read_text())['deployment']; recovery=c['recovery']; gid=recovery['client_gid']; meta=recovery['metadata_gid']; account=base/'account'; account.mkdir(); os.chown(account,0,meta); account.chmod(0o1770); workspace=account/'project'; workspace.mkdir(); os.chown(workspace,10002,10001); workspace.chmod(0o770); c['api']['workspaces_root']=str(account)
            policy=base/'policy'; policy.mkdir(); os.chown(policy,0,gid); policy.chmod(0o750); stopped=base/'native-stopped'; stopped.mkdir(); os.chown(stopped,0,gid); stopped.chmod(0o750)
            catalog_path=policy/'recovery.json'; client_path=base/'client.json'; authority_path=base/'authority.json'; producer_path=base/'producer.json'
            def put(filename,value,mode=0o600,group=0):
                filename.write_bytes(h.encoded(value)); os.chown(filename,0,group); filename.chmod(mode); return h.sha(filename.read_bytes())
            entry={'root':str(workspace),'userId':'17','ownerId':c['owner_id'],'workspaceId':'workspace','generation':'generation','bindingEpoch':'epoch','sessionId':'session','ticket':'a'*64,'nativeWitnessPath':str(stopped/'project.json')}; catalog={'version':1,'authoritySocketPath':c['gateway']['grant_issuer_socket'],'authorityUid':0,'supervisorUid':0,'workspaces':[entry]}
            recovery.update(config_path=str(catalog_path),config_sha256=put(catalog_path,catalog,0o640,gid),native_witness_directory=str(stopped),authority_manifest=str(authority_path))
            client={'version':1,'brokerSocketPath':c['gateway']['broker_socket'],'authoritySocketPath':catalog['authoritySocketPath'],'accounts':[{'userId':'17','accountRoot':str(account),'workspaces':[{key:entry[key] for key in ('root','workspaceId','generation','ticket')}|{'previewProfileId':'preview'}]}]}; reference=next(item for item in c['authority_files'] if item['env']=='CHISA_WORKSPACE_BROKER_CLIENT_CONFIG'); reference.update(source=str(client_path),sha256=put(client_path,client))
            authority={'version':1,'apiUid':10001,'entries':[{key:entry[key] for key in ('root','userId','ownerId','workspaceId','generation','bindingEpoch','sessionId')}|{'ticketHash':h.sha(entry['ticket'].encode()),'nativeAccountGroupId':meta,'rootUid':10002,'rootDev':str(workspace.stat().st_dev),'rootIno':str(workspace.stat().st_ino)}]}; recovery['authority_manifest_sha256']=put(authority_path,authority)
            with self.assertRaisesRegex(ValueError,'producer evidence is missing'): module.preflight_recovery(c)
            producer={'version':1,'reviewer':'fixture-independent','requestedBy':'fixture-operator','verifiedAt':h.now().isoformat(),'expiresAt':(h.now()+h.dt.timedelta(minutes=30)).isoformat(),'recoveryConfigSha256':recovery['config_sha256'],'apiUid':10001,'nativeMetadataGroupId':meta,'recoveryReadGroupId':gid,'authoritySocketPath':catalog['authoritySocketPath'],'nativeWitnessDirectory':str(stopped),'checks':{key:True for key in ('hostBirthObserved','nativeBirthObserved','positiveWaitOrFence','separatePidDomains','atomicDurableWitnesses','apiCannotWriteEvidence','workerCannotWriteMetadata','workspaceLeafSwapDenied','actualNonrootRecovery')}}; recovery['stop_producer_evidence']={'path':str(producer_path),'sha256':put(producer_path,producer)}
            self.assertTrue(module.preflight_recovery(c))
            for case in ('catalog-mode','catalog-group','catalog-hash','leaf-api-owner','metadata-mode','producer-false'):
                with self.subTest(case=case):
                    if case=='catalog-mode': catalog_path.chmod(0o660)
                    elif case=='catalog-group': os.chown(catalog_path,0,gid+1)
                    elif case=='catalog-hash': recovery['config_sha256']='f'*64
                    elif case=='leaf-api-owner': os.chown(workspace,10001,10001)
                    elif case=='metadata-mode': account.chmod(0o770)
                    else: producer['checks']['positiveWaitOrFence']=False; recovery['stop_producer_evidence']['sha256']=put(producer_path,producer)
                    with self.assertRaises(ValueError): module.preflight_recovery(c)
                    catalog_path.chmod(0o640); os.chown(catalog_path,0,gid); recovery['config_sha256']=h.sha(catalog_path.read_bytes()); os.chown(workspace,10002,10001); account.chmod(0o1770); producer['checks']['positiveWaitOrFence']=True; recovery['stop_producer_evidence']['sha256']=put(producer_path,producer)
            self.assertTrue(module.preflight_recovery(c))
        finally:
            import shutil
            self.assertEqual(base.parent,Path('/run')); self.assertTrue(base.name.startswith('chisa-recovery-layout-')); shutil.rmtree(base)
    def test_actual_directory_fsync_journal_private_backup_and_conditional_rollback(self):
        base=Path(tempfile.mkdtemp(prefix='chisa-hardening-apply-',dir='/run')); base.chmod(0o700)
        try:
            c=json.loads((HERE/'config.example.json').read_text()); bundle=base/'bundle'; h.write_bundle(c,bundle); state=base/'state'
            targets={name:str(base/('target'+str(i))) for i,name in enumerate(h.INSTALL_FILES)}; original=Path(next(iter(targets.values()))); original.write_bytes(b'old-config'); original.chmod(0o640)
            report={'ready':True,'blockers':[],'bundle_sha256':'a'*64}; real_require=h.require
            def scope(ok,code,message):
                if code=='STATE_PATH_INVALID': return
                return real_require(ok,code,message)
            with patch.object(h,'INSTALL_FILES',targets),patch.object(h,'preflight',return_value=report),patch.object(h,'require',side_effect=scope):
                h.apply(c,bundle,state,execute=True)
                # New fixed signer artifacts precede Compose in INSTALL_FILES;
                # the private backup must match the artifact chosen above.
                backup=state/(next(iter(targets)).replace('/','_')+'.before'); self.assertEqual(stat.S_IMODE(backup.stat().st_mode),0o600); self.assertEqual(backup.read_bytes(),b'old-config')
                self.assertEqual(stat.S_IMODE((state/'journal.json').stat().st_mode),0o600)
                h.rollback(c,bundle,state,execute=True); self.assertEqual(original.read_bytes(),b'old-config'); self.assertEqual(stat.S_IMODE(original.stat().st_mode),0o640)
                original.write_bytes(b'new-external-config')
                with self.assertRaisesRegex(h.Blocked,'Newer/foreign'): h.rollback(c,bundle,state,execute=True)
            # All deletion targets are bounded by the fixture's verified root.
            import shutil
            self.assertEqual(base.parent,Path('/run')); self.assertTrue(base.name.startswith('chisa-hardening-apply-')); shutil.rmtree(base)
        finally:
            if base.exists():
                import shutil
                self.assertEqual(base.parent,Path('/run')); self.assertTrue(base.name.startswith('chisa-hardening-apply-')); shutil.rmtree(base)

if __name__=='__main__': unittest.main(verbosity=2)
