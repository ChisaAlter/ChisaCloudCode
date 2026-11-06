#!/usr/bin/env python3
"""Offline W10/W12 candidate renderer and independently gated Linux installer.

No command defaults to host mutation. SSH/firewall artifacts are render-only.
Authority records live outside the bundle and are never created by this tool.
"""
from __future__ import annotations
import argparse
import datetime as dt
from contextlib import contextmanager
import hashlib
import importlib.util
import ipaddress
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import sys
import tempfile
from typing import Any

VERSION = 1
WRITERS = {'api', 'worker', 'agent', 'shell', 'preview', 'legacy_sync', 'scheduled', 'host_manual'}
DENIED_PATHS = ('/proc', '/sys', '/dev', '/root', '/var/run/docker.sock', '/run/docker.sock', '/run/containerd')
KINDS = ('g1', 'administration', 'fence', 'acceptance')
class Blocked(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message); self.code = code

def require(ok: Any, code: str, message: str):
    if not ok: raise Blocked(code, message)

def sha(data: bytes) -> str: return hashlib.sha256(data).hexdigest()
def encoded(value: Any) -> bytes: return (json.dumps(value, sort_keys=True, indent=2, ensure_ascii=False) + '\n').encode()
def digest(value: Any) -> str: return sha(encoded(value))
def configuration_digest(config: dict) -> str:
    # Evidence attests the rendered bundle, so references must not themselves
    # participate in that bundle digest (which would create a hash cycle).
    return digest({**config, 'evidence': {kind: None for kind in KINDS}})
def now() -> dt.datetime: return dt.datetime.now(dt.timezone.utc)
def stamp(value: str) -> dt.datetime:
    require(isinstance(value, str), 'TIME_REQUIRED', 'Use an explicit timezone-qualified timestamp')
    try: result = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError: raise Blocked('TIME_INVALID', 'Invalid evidence timestamp')
    require(result.tzinfo is not None, 'TIME_ZONE_REQUIRED', 'Evidence timestamp requires timezone')
    return result

def keys(value: Any, allowed: set[str], required: set[str] | None = None):
    require(isinstance(value, dict) and not (set(value) - allowed) and (required or set()) <= set(value), 'SCHEMA_INVALID', 'Unexpected or missing configuration fields')
def token(value: Any, label='identifier') -> str:
    require(isinstance(value, str) and re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}', value), 'IDENTIFIER_INVALID', label + ' is not a bounded literal identifier'); return value

def absolute(value: Any, allow_root=False) -> str:
    require(isinstance(value, str) and value.startswith('/') and '\\' not in value and '\x00' not in value and '\n' not in value and re.fullmatch(r'/[a-zA-Z0-9_./-]*', value), 'PATH_INVALID', 'Use a literal canonical absolute path without shell/systemd metacharacters')
    require(str(PurePosixPath(value)) == value and '..' not in PurePosixPath(value).parts and (allow_root or value != '/'), 'PATH_INVALID', 'Use a canonical non-root path')
    return value

def pinned_hash(value: Any) -> str:
    require(isinstance(value, str) and re.fullmatch('[a-f0-9]{64}', value), 'HASH_REQUIRED', 'A pinned SHA256 is required'); return value

def protected(path: Path, *, uid=0, directory=False, private=False):
    require(path.is_absolute() and path.resolve() == path, 'AUTHORITY_REDIRECTED', 'Authority path must be canonical')
    for parent in [*reversed(path.parents), path]:
        item = parent.lstat()
        require(not stat.S_ISLNK(item.st_mode) and item.st_uid == uid and not item.st_mode & 0o022, 'AUTHORITY_PERMISSIONS', 'Authority and ancestors must be root-owned and protected')
    item = path.lstat()
    require(stat.S_ISDIR(item.st_mode) if directory else stat.S_ISREG(item.st_mode) and item.st_nlink == 1 and item.st_size <= 4 * 1024 * 1024, 'AUTHORITY_INVALID', 'Authority must be bounded single-link regular data')
    if private: require(item.st_mode & 0o077 == 0, 'AUTHORITY_PRIVATE', 'Private authority evidence must be mode0600')

def read_data(path: Path, trusted=False) -> bytes:
    if trusted: protected(path)
    before = path.lstat(); require(stat.S_ISREG(before.st_mode) and not path.is_symlink() and before.st_nlink == 1 and before.st_size <= 4*1024*1024, 'FILE_INVALID', 'Input must be bounded regular single-link data')
    with path.open('rb') as handle:
        opened = os.fstat(handle.fileno()); data = handle.read(4*1024*1024+1)
    after = path.lstat()
    require((before.st_dev,before.st_ino,before.st_mtime_ns,before.st_size) == (opened.st_dev,opened.st_ino,opened.st_mtime_ns,opened.st_size) == (after.st_dev,after.st_ino,after.st_mtime_ns,after.st_size), 'FILE_CHANGED', 'Input changed while reading')
    return data

def read_json(path: Path, trusted=False) -> Any:
    try: return json.loads(read_data(path,trusted))
    except (ValueError, UnicodeError): raise Blocked('JSON_INVALID', 'Malformed JSON input')

def machine_identity() -> dict:
    return {'machine_id_sha256': sha(Path('/etc/machine-id').read_bytes().strip()), 'boot_id': Path('/proc/sys/kernel/random/boot_id').read_text().strip()}

def validate(config: dict) -> dict:
    keys(config, {'version','change_id','machine','inventory','management','ports','sync','deployment','evidence'}, {'version','change_id','machine','inventory','management','ports','sync','deployment','evidence'})
    require(config['version'] == 1, 'VERSION_INVALID', 'Unsupported contract version'); token(config['change_id'])
    keys(config['machine'], {'machine_id_sha256','boot_id'}, {'machine_id_sha256','boot_id'}); pinned_hash(config['machine']['machine_id_sha256']); token(config['machine']['boot_id'])
    keys(config['inventory'], {'path','sha256'}, {'path','sha256'}); absolute(config['inventory']['path']); pinned_hash(config['inventory']['sha256'])
    management=config['management']; keys(management, {'user','port','sources','host_key_sha256','server_address','ssh_config','ssh_include_verified','firewall_backend','input_chain','forward_chain','upstream_rules'}, {'user','port','sources','host_key_sha256','server_address','ssh_config','ssh_include_verified','firewall_backend','input_chain','forward_chain','upstream_rules'})
    token(management['user']); require(management['user'] != 'root', 'ADMIN_ROOT', 'A separately tested non-root administrator is required')
    require(type(management['port']) is int and 1 <= management['port'] <= 65535, 'PORT_INVALID', 'Invalid SSH port'); pinned_hash(management['host_key_sha256']); absolute(management['ssh_config']); ipaddress.ip_address(management['server_address'])
    require(management['firewall_backend'] == 'iptables', 'FIREWALL_BACKEND_UNSUPPORTED', 'This candidate supports the observed iptables/ip6tables Docker path only; nft backend requires a new verified adapter')
    require(management['input_chain'] == 'INPUT' and management['forward_chain'] == 'DOCKER-USER', 'FIREWALL_CHAIN_INVALID', 'Only explicit INPUT and Docker DOCKER-USER paths are supported')
    sources=management['sources']; require(isinstance(sources,list) and sources, 'ADMIN_SOURCES_REQUIRED', 'Exact trusted management IPv4/IPv6 sources are required')
    for source in sources: require(ipaddress.ip_network(source).prefixlen > 0, 'ADMIN_SOURCE_BROAD', 'Default route is not a management allowlist')
    require({ipaddress.ip_network(s).version for s in sources} == {4,6}, 'ADMIN_DUAL_STACK', 'Both IPv4 and IPv6 management source policy are required')
    require(isinstance(management['upstream_rules'],list), 'UPSTREAM_RULES_REQUIRED', 'Record upstream source-firewall rule identifiers')
    for rule in management['upstream_rules']: token(rule)
    require(isinstance(config['ports'],list) and config['ports'], 'PORT_INVENTORY_REQUIRED', 'A shared-host port inventory is required')
    seen=set()
    for item in config['ports']:
        keys(item, {'port','protocol','owner','business','action','sources','path','container_id','container_port','local_addresses','consumers'}, {'port','protocol','owner','business','action','sources','path','local_addresses','consumers'})
        require(type(item['port']) is int and 1<=item['port']<=65535 and item['protocol'] in ('tcp','udp'), 'PORT_INVALID', 'Invalid port/protocol')
        key=(item['port'],item['protocol']); require(key not in seen,'PORT_DUPLICATE','Duplicate host port'); seen.add(key)
        token(item['owner']); require(isinstance(item['business'],str) and 0<len(item['business'])<=160, 'BUSINESS_REQUIRED','Port business must be inventoried')
        require(item['action'] in ('preserve','restrict','retire') and item['path'] in ('INPUT','DOCKER-USER','both'), 'PORT_ACTION_INVALID','Unsupported port action/path')
        require(isinstance(item['consumers'],list), 'CONSUMER_INVENTORY_REQUIRED','Explicit consumer inventory required')
        for consumer in item['consumers']: token(consumer)
        require(isinstance(item['local_addresses'],list) and item['local_addresses'], 'BIND_ADDRESSES_REQUIRED','Exact destination addresses are required for owned port restrictions')
        for address in item['local_addresses']: ipaddress.ip_address(address)
        require(isinstance(item['sources'],list), 'SOURCES_REQUIRED','Explicit source set required')
        for source in item['sources']: ipaddress.ip_network(source)
        if item['action']=='restrict': require(item['sources'] and all(ipaddress.ip_network(s).prefixlen>0 for s in item['sources']), 'SOURCE_BROAD','Restrictions require exact non-default sources')
        if item['action']!='preserve': require(item['owner']=='chisacloudcode' or item['port']==management['port'], 'SHARED_OWNER','Cannot change an unrelated shared service')
        if item['path']!='INPUT' and item['action']!='preserve':
            pinned_hash(item.get('container_id')); require(type(item.get('container_port')) is int and 1<=item['container_port']<=65535,'CONTAINER_PORT_REQUIRED','Docker original-destination rule requires exact container port')
    sync=config['sync']; keys(sync, {'unit','container_id','image_id','mounts','networks','consumers','retire','supervisors','observed_restart'}, {'unit','container_id','image_id','mounts','networks','consumers','retire','supervisors','observed_restart'})
    require(sync['unit']=='chisa-workspace-sync.service','SYNC_UNIT_INVALID','Legacy supervisor must match reviewed inventory'); pinned_hash(sync['container_id']); require(re.fullmatch('sha256:[a-f0-9]{64}',sync['image_id']), 'IMAGE_ID_REQUIRED','Exact legacy image ID required')
    require(sync['observed_restart']=='always' and sync['supervisors']==[sync['unit']], 'SUPERVISOR_REQUIRED','Observed Restart=always must be explicitly accounted for')
    require(type(sync['retire']) is bool and isinstance(sync['consumers'],list) and isinstance(sync['mounts'],list) and sync['mounts'], 'SYNC_INVENTORY_REQUIRED','Exact sync consumers and mounts required')
    for item in sync['mounts']:
        keys(item, {'source','target','writable'}, {'source','target','writable'}); absolute(item['source']); absolute(item['target']); require(type(item['writable']) is bool,'MOUNT_MODE_INVALID','Explicit mount mode required')
    require(isinstance(sync['networks'],list) and sync['networks'], 'SYNC_NETWORK_REQUIRED','Preserve exact sync account network identity')
    for item in sync['networks']: pinned_hash(item)
    if sync['retire']: require(not sync['consumers'], 'SYNC_CONSUMERS_ACTIVE','Retirement requires independently reviewed zero active consumers')
    require(isinstance(config['evidence'],dict) and set(config['evidence'])==set(KINDS),'EVIDENCE_CONFIG_REQUIRED','All independent evidence references are required (null blocks apply)')
    for reference in config['evidence'].values():
        if reference is not None:
            keys(reference,{'path','sha256'},{'path','sha256'}); absolute(reference['path']); pinned_hash(reference['sha256'])
    deployment_module().validate(config['deployment'])
    return config

def deployment_module():
    location=Path(__file__).resolve().parents[1]/'deployment'/'render.py'
    spec=importlib.util.spec_from_file_location('chisa_deployment_render',location); module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module); return module

def render_firewall(config: dict) -> tuple[str,str]:
    forward=[]; inverse=[]; comment='chisa-'+config['change_id']
    for item in config['ports']:
        if item['action']=='preserve': continue
        paths=['INPUT','DOCKER-USER'] if item['path']=='both' else [item['path']]
        for address in item['local_addresses']:
            version=ipaddress.ip_address(address).version; exe='/usr/sbin/iptables' if version==4 else '/usr/sbin/ip6tables'
            allowed=[s for s in item['sources'] if ipaddress.ip_network(s).version==version] if item['action']=='restrict' else []
            for chain in paths:
                match=['-p',item['protocol']]
                if chain=='INPUT': match += ['-d',address,'--dport',str(item['port'])]
                else: match += ['-m','conntrack','--ctdir','ORIGINAL','--ctorigdst',address,'--ctorigdstport',str(item['port'])]
                # Insert reverse order so exact allows precede the final denial;
                # existing connections retain service until explicit drain.
                rules=[match+['-m','conntrack','--ctstate','NEW','-m','comment','--comment',comment,'-j','DROP']]
                for source in reversed(allowed): rules.append(match+['-s',source,'-m','comment','--comment',comment,'-j','RETURN' if chain=='DOCKER-USER' else 'ACCEPT'])
                for rule in rules:
                    line=' '.join([exe,'-w','5','-I',chain,'1',*rule]); delete=' '.join([exe,'-w','5','-D',chain,*rule])
                    forward.append(line); inverse.insert(0,delete)
    header='#!/bin/sh\nset -eu\n# RENDER ONLY: apply manually only after independent admin/console/source verification.\n# No chain flush, policy reset, unrelated-port changes or automatic execution.\n'
    return header+'\n'.join(forward)+'\n',header+'\n'.join(inverse)+'\n'

def render_isolation_firewall(config: dict) -> tuple[str,str]:
    net=config['deployment']['network']; rules=[]; inverse=[]; comment='chisa-isolation-'+config['change_id']
    # Initial candidate intentionally has no broad network egress. Operator must
    # add separately reviewed DNS/provider/SSH egress and repeat acceptance before
    # production. No host/account/private fallback may silently restore access.
    api=config['deployment']['api']; gateway=config['deployment']['gateway']
    allows={
        net['api_address']:[['-d',net['gateway_address'],'-p','tcp','--dport',str(gateway['listen_port'])]],
        net['proxy_address']:[['-d',net['api_address'],'-p','tcp','--dport',str(api['listen_port'])]],
        net['gateway_address']:[],
        net['account_gateway_address']:[['-d',net['account_subnet'],'-p','tcp','--dport','1024:65535']]
    }
    for item in config['deployment']['egress']:
        allows[net['api_address']].append(['-d',item['destination'],'-p',item['protocol'],'--dport',str(item['port'])])
    for source,allowed in allows.items():
        for chain in ('INPUT','DOCKER-USER'):
            per_source=[['-s',source,'-m','conntrack','--ctstate','NEW','-m','comment','--comment',comment,'-j','DROP']]
            if chain=='DOCKER-USER':
                for destination in reversed(allowed): per_source.append(['-s',source,*destination,'-m','comment','--comment',comment,'-j','RETURN'])
            for rule in per_source:
                line=['/usr/sbin/iptables','-w','5','-I',chain,'1',*rule]; undo=['/usr/sbin/iptables','-w','5','-D',chain,*rule]
                rules.append(' '.join(line)); inverse.insert(0,' '.join(undo))
    header='#!/bin/sh\nset -eu\n# RENDER ONLY. Exact candidate source identities; no shared-chain flush.\n# Apply/verify independently with console rollback.\n'
    return header+'\n'.join(rules)+'\n',header+'\n'.join(inverse)+'\n'

def render(config: dict) -> dict[str,bytes]:
    validate(config); management=config['management']; firewall,rollback=render_firewall(config)
    ssh='''# Candidate only: include before broad settings; verify full effective Match context.
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AuthenticationMethods publickey
X11Forwarding no
AllowAgentForwarding no
AllowTcpForwarding no
GatewayPorts no
PermitTunnel no
'''+ 'AllowUsers '+management['user']+'\n'
    ssh=ssh.replace('AllowUsers '+management['user']+'\n','AllowUsers '+' '.join(management['user']+'@'+source for source in management['sources'])+'\n')
    for source in management['sources']: ssh+='\nMatch User '+management['user']+' Address '+source+'\n    PasswordAuthentication no\n    AuthenticationMethods publickey\n'
    ssh+='\nMatch all\n'
    result={'ssh/60-chisa-admin.conf':ssh.encode(),'firewall/restrict.render.sh':firewall.encode(),'firewall/rollback.render.sh':rollback.encode()}
    result.update(deployment_module().render(config['deployment'],config['change_id']))
    restrictions,inverse=render_isolation_firewall(config)
    result['firewall/account-isolation.render.sh']=restrictions.encode()
    result['firewall/account-isolation.rollback.sh']=inverse.encode()
    result['preview-gateway.mjs']=(Path(__file__).resolve().parents[1]/'deployment'/'preview-gateway.mjs').read_bytes()
    result['deployment/preview-authority.mjs']=(Path(__file__).resolve().parents[1]/'deployment'/'preview-authority.mjs').read_bytes()
    result['workspace-broker/authority/read-peer-namespace.py']=(Path(__file__).resolve().parents[1]/'workspace-broker'/'authority'/'read-peer-namespace.py').read_bytes()
    result['retirement-plan.json']=encoded({'version':1,'change_id':config['change_id'],'render_only':True,'sync':config['sync'],'steps':['verify independent full writer fence and exact current immutable IDs','verify zero live consumers; close admission','mask exact enrolled supervisor, then stop that unit','verify inactive/masked supervisor and unchanged immutable sync identity','stop exact sync container only if still running; never delete data/network/container','inspect no restart path and probe both host IPv4/IPv6 original destinations','retain configuration, data and restricted rollback; observe before independent cleanup']})
    return result

def write_bundle(config: dict, target: Path):
    require(not target.exists(), 'BUNDLE_EXISTS','Render into a new directory')
    files=render(config); target.mkdir(mode=0o700,parents=True)
    try:
        for name,data in files.items():
            filename=target/name; filename.parent.mkdir(mode=0o700,parents=True,exist_ok=True); filename.write_bytes(data); filename.chmod(0o644 if name in ('gateway-config.json','proxy.conf') else 0o600)
        manifest={'version':1,'change_id':config['change_id'],'configuration_sha256':configuration_digest(config),'files':{name:sha(data) for name,data in sorted(files.items())}}
        (target/'manifest.json').write_bytes(encoded(manifest)); (target/'manifest.json').chmod(0o600)
        return manifest
    except BaseException:
        # Keep failed renders for operator inspection; never recursively delete a supplied path.
        raise

def verify_bundle(config: dict, target: Path) -> tuple[dict,str]:
    require(target.is_absolute() and target.resolve()==target and target.is_dir() and not target.is_symlink(),'BUNDLE_PATH_INVALID','Use a canonical rendered directory')
    manifest=read_json(target/'manifest.json'); expected=render(config)
    require(manifest=={'version':1,'change_id':config['change_id'],'configuration_sha256':configuration_digest(config),'files':{name:sha(data) for name,data in sorted(expected.items())}},'BUNDLE_CHANGED','Bundle does not exactly match current generator/configuration')
    actual={str(p.relative_to(target)).replace('\\','/') for p in target.rglob('*') if p.is_file() or p.is_symlink()}
    require(actual==set(expected)|{'manifest.json'},'BUNDLE_EXTRA','Unexpected or missing bundle data')
    for name,data in expected.items():
        filename=target/name; require(filename.resolve()==filename and not filename.is_symlink() and filename.lstat().st_nlink==1 and filename.read_bytes()==data,'BUNDLE_CHANGED','Rendered artifact changed')
    return manifest,digest(manifest)

def load_evidence(config: dict, kind: str, bundle_hash: str, *, trusted=True) -> dict:
    reference=config['evidence'].get(kind); require(reference is not None,'EVIDENCE_MISSING',kind+' evidence is not independently supplied')
    filename=Path(reference['path']); data=read_data(filename,trusted); value=json.loads(data)
    require(sha(data)==reference['sha256'],'EVIDENCE_HASH',kind+' evidence digest changed')
    require(value.get('version')==1 and value.get('kind')==kind and value.get('change_id')==config['change_id'] and value.get('machine')==config['machine'] and value.get('bundle_sha256')==bundle_hash,'EVIDENCE_SCOPE',kind+' evidence is for another host/change/bundle')
    created=stamp(value.get('created_at')); expires=stamp(value.get('expires_at')); current=now()
    require(created<=current<=expires and expires-created<=dt.timedelta(hours=2),'EVIDENCE_STALE',kind+' evidence missing, expired or overlong')
    require(isinstance(value.get('reviewer'),str) and value['reviewer'] and value['reviewer']!=value.get('requested_by'),'REVIEWER_REQUIRED','Independent reviewer must differ from requesting operator')
    artifacts=value.get('artifacts'); require(isinstance(artifacts,list) and artifacts,'ARTIFACT_REQUIRED',kind+' needs independently pinned actual evidence artifacts')
    found={}
    for artifact in artifacts:
        keys(artifact, {'name','path','sha256'},{'name','path','sha256'}); name=token(artifact['name']); absolute(artifact['path']); pinned_hash(artifact['sha256'])
        require(name not in found,'ARTIFACT_DUPLICATE','Duplicate evidence artifact'); path=Path(artifact['path']); protected(path) if trusted else None
        data=read_data(path,trusted); require(sha(data)==artifact['sha256'],'ARTIFACT_CHANGED','Evidence artifact digest mismatch'); found[name]=json.loads(data)
    for artifact_name, artifact in found.items():
        require(isinstance(artifact,dict) and artifact.get('machine')==config['machine'] and artifact.get('change_id')==config['change_id'] and artifact.get('reviewer')==value['reviewer'],'ARTIFACT_SCOPE','Referenced artifact is not independently scoped to this host/change/reviewer')
        require(created<=stamp(artifact.get('verified_at'))<=expires,'ARTIFACT_STALE','Referenced artifact was not verified within this evidence window')
    checks=value.get('checks',{})
    if kind=='g1':
        require(set(found)>={'offsite_commit','isolated_verification','production_drill','monitor_delivery'},'G1_INCOMPLETE','G1 requires offsite, isolated restore, real application drill and received monitoring proof')
        require(found['offsite_commit'].get('committed') is True and found['offsite_commit'].get('independent_storage_verified') is True,'G1_OFFSITE','Independent offsite committed restore point required')
        verification=found['isolated_verification']; drill=found['production_drill']
        restore_point=found['offsite_commit'].get('restore_point_id'); require(isinstance(restore_point,str) and restore_point and all(found[name].get('restore_point_id')==restore_point for name in ('isolated_verification','production_drill')),'G1_RESTORE_POINT','Offsite/restore/business drill must prove the same immutable recovery point')
        require(found['offsite_commit'].get('failure_domain') not in (None,'',config['machine']['machine_id_sha256']) and verification.get('recovery_machine_id_sha256') not in (None,'',config['machine']['machine_id_sha256']),'G1_INDEPENDENCE','Offsite/recovery host must have independent failure domain')
        require(verification.get('verified') is True and verification.get('network_isolated') is True and verification.get('all_scopes_verified') is True,'G1_RESTORE','Full isolated restore verification required')
        require(drill.get('production_drill_passed') is True and drill.get('application_smoke_passed') is True and drill.get('uid_acl_xattr_lease_mapping_passed') is True and drill.get('rollback_passed') is True,'G1_DRILL','Recovery tool verify alone is not application/production acceptance')
        require(type(drill.get('rpo_seconds')) is int and 0<=drill['rpo_seconds']<=3600 and type(drill.get('rto_seconds')) is int and 0<drill['rto_seconds']<=14400,'G1_RPO_RTO','Measured RPO<=1h and RTO<=4h required')
        require(found['monitor_delivery'].get('receiver_confirmed') is True,'G1_MONITOR','Independent alert receiver confirmation required')
    elif kind=='administration':
        require(all(checks.get(key) is True for key in ('second_nonroot_session','sudo_verified','console_verified','rollback_verified','ipv4_verified','ipv6_verified','source_allowlist_verified')),'ADMIN_INCOMPLETE','Second admin, sudo, dual-stack access, console and rollback must be independently verified')
        require(value.get('admin_user')==config['management']['user'] and value.get('host_key_sha256')==config['management']['host_key_sha256'],'ADMIN_IDENTITY','Administrator/host key mismatch')
    elif kind=='fence':
        require(all(checks.get(key) is True for key in ('admission_closed','all_writers_fenced','supervisors_masked','durable_generation','no_old_namespace_writer','consumer_inventory_verified')),'FENCE_INCOMPLETE','All writer classes and restart supervisors need independently confirmed durable fencing')
        require(set(value.get('writer_classes',[]))==WRITERS,'FENCE_CLASSES','Every writer class must be covered')
        require(value.get('sync_container_id')==config['sync']['container_id'] and value.get('sync_consumers')==config['sync']['consumers'],'FENCE_INVENTORY','Fence/consumer inventory mismatch')
    else:
        require(all(checks.get(key) is True for key in ('artifact_scan','sbom_pinned','api_no_daemon','nonroot_restart','uid_home_mapping','provider_positive','shell_positive','json_worker_positive','http_ws_sse_upload','account_isolation','runtime_gateway_acceptance','cleanup_recovery','rollback_candidate','proxy_syntax','egress_policy','candidate_firewall_applied','recovery_readonly_mounts','independent_stop_producer','two_pid_domain_recovery','sticky_metadata_leaf_swap_denied')),'ACCEPTANCE_INCOMPLETE','Real deployment/image/network/provider/gateway/rollback acceptance is required')
        require(value.get('images')==config['deployment']['images'],'IMAGE_ATTESTATION','Acceptance image digest set differs')
    return value

def run(argv: list[str], *, timeout=20) -> str:
    try:
        result=subprocess.run(argv,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,timeout=timeout,env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C','HOME':'/nonexistent'})
    except (OSError,subprocess.TimeoutExpired): raise Blocked('CHECK_UNAVAILABLE','Read-only syntax/inventory check unavailable: '+argv[0])
    require(result.returncode==0,'CHECK_FAILED','Command failed (output redacted): '+argv[0]); require(len(result.stdout)<=8*1024*1024,'CHECK_OUTPUT_LIMIT','Bounded command output exceeded'); return result.stdout

def inventory(config: dict, *, runner=run) -> dict:
    reference=config['inventory']; filename=Path(reference['path']); data=read_data(filename,True); value=json.loads(data)
    require(sha(data)==reference['sha256'],'INVENTORY_HASH','Pinned operator inventory changed')
    require(value.get('version')==1 and value.get('machine')==config['machine'] and value.get('reviewer') and value.get('complete_shared_inventory') is True,'INVENTORY_SCOPE','Complete independently reviewed shared-host inventory required')
    age=now()-stamp(value.get('created_at')); require(dt.timedelta()<=age<=dt.timedelta(minutes=30),'INVENTORY_STALE','Refresh inventory within30minutes before activation')
    require(value.get('ports')==config['ports'] and value.get('sync')==config['sync'],'INVENTORY_CHANGED','Actual shared-host port/sync inventory differs from operator policy')
    sync=config['sync']; data=json.loads(runner(['/usr/bin/docker','inspect',sync['container_id']]))
    require(isinstance(data,list) and len(data)==1,'RESOURCE_UNAVAILABLE','Exact sync resource inspection required'); item=data[0]
    require(item.get('Id')==sync['container_id'] and item.get('Image')==sync['image_id'],'RESOURCE_REPLACED','Sync immutable ID/image changed')
    mounts=sorted([{'source':m['Source'],'target':m['Destination'],'writable':m['RW']} for m in item.get('Mounts',[])],key=lambda m:m['target'])
    require(mounts==sorted(sync['mounts'],key=lambda m:m['target']),'RESOURCE_MOUNTS','Sync mounts changed')
    networks=sorted(n['NetworkID'] for n in item.get('NetworkSettings',{}).get('Networks',{}).values()); require(networks==sorted(sync['networks']),'RESOURCE_NETWORK','Sync account network changed')
    return value

def assert_full_fence(config: dict, bundle_hash: str, *, runner=run) -> dict:
    evidence=load_evidence(config,'fence',bundle_hash)
    identifiers=runner(['/usr/bin/docker','ps','-aq','--no-trunc']).splitlines()
    require(all(re.fullmatch('[a-f0-9]{64}',item) for item in identifiers) and len(set(identifiers))==len(identifiers),'FENCE_DAEMON_INVENTORY','Daemon container inventory is malformed')
    containers=json.loads(runner(['/usr/bin/docker','inspect',*identifiers])) if identifiers else []
    writable=[m['source'] for m in config['deployment']['mounts'] if m['writable']]
    relevant=[]
    for item in containers:
        touched=any(m.get('RW') is True and any(m.get('Source')==root or m.get('Source','').startswith(root+'/') or root.startswith(m.get('Source','')+'/') for root in writable) for m in item.get('Mounts',[]))
        if not touched: continue
        require(item.get('Id') in identifiers,'FENCE_RESOURCE_REPLACED','Invalid immutable writer identity')
        require(item.get('State',{}).get('Running') is False and item.get('State',{}).get('Paused') is False and item.get('State',{}).get('Restarting') is False and item.get('HostConfig',{}).get('RestartPolicy',{}).get('Name')=='no','FENCE_WRITER_ACTIVE','Running, paused or restartable current/historical container retains writable data')
        relevant.append(item['Id'])
    require(sorted(evidence.get('writer_container_ids',[]))==sorted(relevant),'FENCE_CONTAINERS','Independent writer inventory must include every current/historical RW mount consumer')
    units=evidence.get('supervisors'); require(isinstance(units,list) and units and config['sync']['unit'] in units and 'chisa-workspace-api.service' in units,'FENCE_SUPERVISORS','API/sync and every scheduler supervisor must be independently inventoried')
    for unit in units:
        require(isinstance(unit,str) and re.fullmatch('[A-Za-z0-9_.@-]+\\.service',unit),'FENCE_UNIT_INVALID','Only exact enrolled service units may be checked')
        output=runner(['/usr/bin/systemctl','show',unit,'--property=Id,ActiveState,SubState,UnitFileState,Restart']); state=dict(line.split('=',1) for line in output.splitlines() if '=' in line)
        require(state.get('Id')==unit and state.get('ActiveState')=='inactive' and state.get('UnitFileState')=='masked','FENCE_SUPERVISOR_ACTIVE','Supervisor is not independently inactive and masked')
    return evidence

def preflight(config: dict, bundle: Path, *, runner=run, check_host=True, evidence=True, allow_old_ownership=False) -> dict:
    validate(config); _,bundle_hash=verify_bundle(config,bundle); checks=[]; blockers=[]
    def check(name,action):
        try: action(); checks.append(name)
        except (Blocked,OSError,ValueError) as error: blockers.append({'check':name,'code':getattr(error,'code','CHECK_ERROR'),'message':str(error)})
    if not check_host or sys.platform=='linux' and os.geteuid()==0:
        check('deployment',lambda: deployment_module().preflight(config['deployment'],runner=runner,check_paths=check_host,allow_old_ownership=allow_old_ownership))
    if check_host:
        if sys.platform!='linux' or os.geteuid()!=0:
            blockers.append({'check':'linux_root','code':'LINUX_ROOT_REQUIRED','message':'Host checks require independent Linux root operator; no host command was attempted'})
            return {'version':1,'change_id':config['change_id'],'bundle_sha256':bundle_hash,'ready':False,'checks':checks,'blockers':blockers,'production_changed':False}
        check('linux_root',lambda: require(sys.platform=='linux' and os.geteuid()==0,'LINUX_ROOT_REQUIRED','Host checks need independent Linux root operator'))
        check('machine',lambda: require(machine_identity()==config['machine'],'MACHINE_CHANGED','Machine/boot changed'))
        check('configuration_protection',lambda: protected(bundle,directory=True))
        check('inventory',lambda: inventory(config,runner=runner))
        management=config['management']
        check('ssh_include',lambda: require(management['ssh_include_verified'] is True,'SSH_INCLUDE_UNVERIFIED','Candidate include precedence must be independently verified'))
        check('sshd_candidate_syntax',lambda: runner(['/usr/sbin/sshd','-t','-f',str(bundle/'ssh/60-chisa-admin.conf')]))
        check('sshd_syntax',lambda: runner(['/usr/sbin/sshd','-t','-f',management['ssh_config']]))
        for source in management['sources']:
            address=str(ipaddress.ip_network(source).network_address)
            context='user='+management['user']+',host=admin,laddr='+management['server_address']+',addr='+address+',lport='+str(management['port'])
            def effective(context=context):
                output=runner(['/usr/sbin/sshd','-T','-f',management['ssh_config'],'-C',context]); actual=dict(line.split(' ',1) for line in output.splitlines() if ' ' in line)
                require(all(actual.get(key)==value for key,value in {'permitrootlogin':'no','passwordauthentication':'no','kbdinteractiveauthentication':'no','pubkeyauthentication':'yes','allowtcpforwarding':'no','x11forwarding':'no'}.items()),'SSH_EFFECTIVE_POLICY','Full sshd Match context does not satisfy candidate access policy')
            check('sshd_context_'+source,effective)
        for executable in ('/usr/sbin/iptables','/usr/sbin/ip6tables'):
            for chain in ('INPUT','DOCKER-USER'): check(executable+'_'+chain,lambda exe=executable,ch=chain: runner([exe,'-w','5','-S',ch]))
        check('compose_syntax',lambda: runner(['/usr/bin/docker','compose','-f',str(bundle/'compose.json'),'config','--quiet']))
        check('systemd_syntax',lambda: runner(['/usr/bin/systemd-analyze','verify',str(bundle/'systemd/chisa-candidate.service'),str(bundle/'systemd/chisa-preview-authority.service')]))
        # Do not run nginx in a read-only preflight: its -t may create temp/log
        # files. Exact-image nginx -t is a required independent sandbox artifact.
        check('shared_supervisor_inventory',lambda: runner(['/usr/bin/systemctl','show',config['sync']['unit'],'--property=Id,FragmentPath,ActiveState,UnitFileState,Restart,ExecStart,ExecStop']))
    if evidence:
        check('independent_stop_producer',lambda: require(config['deployment']['recovery']['stop_producer_evidence'] is not None,'RECOVERY_STOP_PRODUCER_MISSING','Recovery activation requires independently deployed and verified root stop-witness producer evidence'))
        for kind in KINDS: check('evidence_'+kind,lambda kind=kind: load_evidence(config,kind,bundle_hash))
        if check_host: check('actual_full_writer_fence',lambda: assert_full_fence(config,bundle_hash,runner=runner))
    return {'version':1,'change_id':config['change_id'],'bundle_sha256':bundle_hash,'ready':not blockers,'checks':checks,'blockers':blockers,'production_changed':False}

# The only installation targets. Critical host access files remain render-only.
INSTALL_FILES={'deployment/preview-authority.mjs':'/opt/chisa-deployment/deployment/preview-authority.mjs','workspace-broker/authority/read-peer-namespace.py':'/opt/chisa-deployment/workspace-broker/authority/read-peer-namespace.py','compose.json':'/etc/chisa-deployment/compose.json','systemd/chisa-candidate.service':'/etc/systemd/system/chisa-candidate.service','systemd/chisa-preview-authority.service':'/etc/systemd/system/chisa-preview-authority.service','gateway-config.json':'/etc/chisa-deployment/gateway-config.json','proxy.conf':'/etc/chisa-deployment/proxy.conf'}

def sync_directory(directory: Path):
    fd=os.open(directory,os.O_RDONLY|os.O_DIRECTORY)
    try: os.fsync(fd)
    finally: os.close(fd)

def atomic_write(filename: Path, data: bytes, mode=0o600):
    parent=filename.parent; protected(parent,directory=True)
    descriptor,tmp=tempfile.mkstemp(prefix='.chisa-',dir=parent)
    try:
        with os.fdopen(descriptor,'wb') as handle: handle.write(data); handle.flush(); os.fsync(handle.fileno())
        os.chmod(tmp,mode); os.replace(tmp,filename)
        sync_directory(parent)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)

def _apply_locked(config: dict, bundle: Path, state: Path, *, execute=False, runner=run) -> dict:
    report=preflight(config,bundle,runner=runner,allow_old_ownership=True)
    require(report['ready'],'PREFLIGHT_BLOCKED','No stateful change: '+','.join(item['code'] for item in report['blockers']))
    require(state==Path('/var/lib/chisa-deployment')/config['change_id'],'STATE_PATH_INVALID','Use exact protected per-change state path')
    if not execute: return {**report,'plan':INSTALL_FILES,'execute':False}
    require(not state.exists(),'STATE_EXISTS','Existing change state requires exact recovery/rollback'); protected(state.parent,directory=True); state.mkdir(mode=0o700)
    entries=[]
    for name,target in INSTALL_FILES.items():
        filename=Path(target); protected(filename.parent,directory=True)
        if filename.exists():
            before=read_data(filename,True); before_mode=stat.S_IMODE(filename.lstat().st_mode)
            atomic_write(state/(name.replace('/','_')+'.before'),before)
        else: before=None; before_mode=None
        after=(bundle/name).read_bytes(); entries.append({'artifact':name,'target':target,'before':None if before is None else sha(before),'before_mode':before_mode,'after':sha(after),'backup':None if before is None else name.replace('/','_')+'.before'})
    journal={'version':1,'change_id':config['change_id'],'machine':config['machine'],'bundle_sha256':report['bundle_sha256'],'entries':entries,'installed':False}
    atomic_write(state/'journal.json',encoded(journal))
    for entry in entries:
        filename=Path(entry['target']); current=sha(read_data(filename,True)) if filename.exists() else None
        require(current==entry['before'],'INSTALL_CAS','Target changed during install; retain journal and rollback')
        atomic_write(filename,(bundle/entry['artifact']).read_bytes(),0o644 if entry['artifact'] in ('gateway-config.json','proxy.conf') else 0o600)
    journal['installed']=True; atomic_write(state/'journal.json',encoded(journal))
    return {'installed':True,'activated':False,'state':str(state),'production_changed':True,'note':'No service reload/start, SSH install or firewall command was executed'}

def _rollback_locked(config: dict, bundle: Path, state: Path, *, execute=False, runner=run) -> dict:
    report=preflight(config,bundle,runner=runner); require(report['ready'],'PREFLIGHT_BLOCKED','Rollback needs current independent fence, administration and recovery evidence')
    require(state==Path('/var/lib/chisa-deployment')/config['change_id'],'STATE_PATH_INVALID','Unexpected rollback state path'); journal=read_json(state/'journal.json',True)
    require(journal.get('machine')==config['machine'] and journal.get('bundle_sha256')==report['bundle_sha256'],'ROLLBACK_SCOPE','Journal belongs to another host/bundle')
    entries=journal.get('entries'); require(isinstance(entries,list) and len(entries)==len(INSTALL_FILES),'JOURNAL_INVALID','Unknown rollback entries')
    require(len({entry.get('artifact') for entry in entries})==len(INSTALL_FILES),'JOURNAL_DUPLICATE','Duplicate rollback target')
    for entry in entries:
        require(entry.get('before_mode') is None and entry.get('before') is None or type(entry.get('before_mode')) is int and 0<=entry['before_mode']<=0o777 and not entry['before_mode']&0o022,'JOURNAL_MODE','Invalid rollback permission metadata')
        require(INSTALL_FILES.get(entry.get('artifact'))==entry.get('target'),'JOURNAL_TARGET','Rollback target is not fixed candidate allowlist'); filename=Path(entry['target']); protected(filename.parent,directory=True)
        current=sha(read_data(filename,True)) if filename.exists() else None; require(current in (entry['before'],entry['after']),'ROLLBACK_CAS','Newer/foreign target is retained; do not overwrite')
        if entry['backup'] is not None:
            require(entry['backup']==entry['artifact'].replace('/','_')+'.before','JOURNAL_BACKUP','Unexpected backup path'); protected(state/entry['backup']); require(sha((state/entry['backup']).read_bytes())==entry['before'],'BACKUP_CHANGED','Rollback bytes changed')
    if not execute: return {'rollback_ready':True,'execute':False}
    for entry in reversed(entries):
        filename=Path(entry['target']); current=sha(read_data(filename,True)) if filename.exists() else None
        if current==entry['before']: continue
        require(current==entry['after'],'ROLLBACK_CAS','Target changed during rollback')
        if entry['before'] is None:
            filename.unlink(); sync_directory(filename.parent)
        else: atomic_write(filename,read_data(state/entry['backup'],True),entry['before_mode'])
    return {'rolled_back_configuration':True,'services_restarted':False,'production_changed':True}

@contextmanager
def change_lock(state: Path, execute: bool):
    if not execute:
        yield; return
    require(sys.platform=='linux' and os.geteuid()==0,'LINUX_ROOT_REQUIRED','Stateful changes require the independent Linux root operator')
    protected(state.parent,directory=True)
    import fcntl
    filename=state.parent/'change.guard'
    descriptor=os.open(filename,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
    try:
        item=os.fstat(descriptor); named=filename.lstat()
        require(stat.S_ISREG(item.st_mode) and item.st_uid==0 and item.st_nlink==1 and not item.st_mode&0o077 and (item.st_dev,item.st_ino)==(named.st_dev,named.st_ino),'CHANGE_GUARD_INVALID','Permanent change guard must be exact private root-owned inode')
        try: fcntl.flock(descriptor,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError: raise Blocked('CHANGE_BUSY','Another configuration operation holds the permanent guard')
        yield
    finally: os.close(descriptor)

def apply(config: dict, bundle: Path, state: Path, *, execute=False, runner=run) -> dict:
    # Validate non-mutating gates before even creating the permanent guard.
    report=preflight(config,bundle,runner=runner,allow_old_ownership=True)
    require(report['ready'],'PREFLIGHT_BLOCKED','No stateful change: '+','.join(item['code'] for item in report['blockers']))
    require(state==Path('/var/lib/chisa-deployment')/config['change_id'],'STATE_PATH_INVALID','Use exact protected per-change state path')
    with change_lock(state,execute): return _apply_locked(config,bundle,state,execute=execute,runner=runner)

def rollback(config: dict, bundle: Path, state: Path, *, execute=False, runner=run) -> dict:
    report=preflight(config,bundle,runner=runner); require(report['ready'],'PREFLIGHT_BLOCKED','Rollback has not satisfied current independent evidence')
    with change_lock(state,execute): return _rollback_locked(config,bundle,state,execute=execute,runner=runner)

def migrate_ownership(config: dict, bundle: Path, state: Path, *, execute=False, restore=False, runner=run) -> dict:
    # This is exact path/inode metadata migration only. Child ACL/xattr and
    # restored runtime identities must already pass independent acceptance.
    report=preflight(config,bundle,runner=runner,allow_old_ownership=True)
    require(report['ready'],'PREFLIGHT_BLOCKED','Ownership migration requires fresh full independent gates')
    require(state==Path('/var/lib/chisa-deployment')/config['change_id'],'STATE_PATH_INVALID','Unexpected change state')
    mapping=config['deployment']['mapping']; plan=[]
    for item in mapping:
        filename=Path(item['path']); metadata=filename.lstat()
        require(filename.resolve()==filename and stat.S_ISDIR(metadata.st_mode) and (metadata.st_dev,metadata.st_ino)==(item['device'],item['inode']),'MAPPING_REPLACED','Never re-own a replaced/redirected path')
        old=(item['old_uid'],item['old_gid'],int(item['old_mode'],8)); new=(item['new_uid'],item['new_gid'],int(item['new_mode'],8)); current=(metadata.st_uid,metadata.st_gid,stat.S_IMODE(metadata.st_mode))
        require(current in (old,new),'MAPPING_OWNER_CHANGED','Unregistered owner/permissions are retained')
        plan.append((filename,item,old if restore else new))
    if not execute: return {'ownership_plan':[{'path':str(p),'uid':v[0],'gid':v[1],'mode':oct(v[2])} for p,_,v in plan],'execute':False}
    with change_lock(state,True):
        require(state.exists(),'STATE_REQUIRED','Install/journal the exact gated change before ownership migration')
        journal=state/'ownership.json'
        if journal.exists(): require(read_json(journal,True).get('mapping')==mapping,'MAPPING_JOURNAL_CHANGED','Previous ownership journal changed')
        else: atomic_write(journal,encoded({'version':1,'machine':config['machine'],'bundle_sha256':report['bundle_sha256'],'mapping':mapping}))
        for filename,item,desired in plan:
            metadata=filename.lstat(); require((metadata.st_dev,metadata.st_ino)==(item['device'],item['inode']),'MAPPING_REPLACED','Mapping changed before apply')
            fd=os.open(filename,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
            try:
                opened=os.fstat(fd); require((opened.st_dev,opened.st_ino)==(item['device'],item['inode']),'MAPPING_REPLACED','Mapping inode changed while opening')
                os.fchown(fd,desired[0],desired[1]); os.fchmod(fd,desired[2]); os.fsync(fd)
            finally: os.close(fd)
    return {'exact_ownership_migrated':True,'restored':restore,'recursive':False,'production_changed':True}

def retire_sync(config: dict, bundle: Path, state: Path, *, execute=False, runner=run) -> dict:
    # A full independently fenced state already has sync inactive+masked; this
    # action records/maintains that durable retirement and never restarts it.
    report=preflight(config,bundle,runner=runner); require(report['ready'],'PREFLIGHT_BLOCKED','Sync retirement requires current independent gates')
    require(config['sync']['retire'] is True and not config['sync']['consumers'],'SYNC_CONSUMERS_ACTIVE','No retirement until every actual consumer is independently retired')
    require(state==Path('/var/lib/chisa-deployment')/config['change_id'],'STATE_PATH_INVALID','Unexpected change state')
    plan=[['/usr/bin/systemctl','mask',config['sync']['unit']],['/usr/bin/systemctl','stop',config['sync']['unit']]]
    if not execute: return {'retirement_plan':plan,'immutable_container_id':config['sync']['container_id'],'execute':False}
    with change_lock(state,True):
        require(state.exists(),'STATE_REQUIRED','Install/journal the exact gated change first')
        assert_full_fence(config,report['bundle_sha256'],runner=runner); inventory(config,runner=runner)
        atomic_write(state/'sync-retirement.json',encoded({'version':1,'machine':config['machine'],'bundle_sha256':report['bundle_sha256'],'sync':config['sync'],'state':'retiring'}))
        for argv in plan: runner(argv)
        # Never infer daemon absence from timeout. An already-fenced container is
        # retained rather than deleted; all restart sources remain masked.
        assert_full_fence(config,report['bundle_sha256'],runner=runner)
        atomic_write(state/'sync-retirement.json',encoded({'version':1,'machine':config['machine'],'bundle_sha256':report['bundle_sha256'],'sync':config['sync'],'state':'retired-maintenance','container_and_data_retained':True}))
    return {'retirement_fence_persisted':True,'container_deleted':False,'rollback_auto_restart':False,'production_changed':True}

def main():
    parser=argparse.ArgumentParser(description=__doc__); parser.add_argument('command',choices=['render','preflight','apply','rollback','migrate-ownership','restore-ownership','retire-sync']); parser.add_argument('--config',type=Path,required=True); parser.add_argument('--bundle',type=Path,required=True); parser.add_argument('--state',type=Path); parser.add_argument('--execute',action='store_true'); args=parser.parse_args()
    try:
        require(not args.execute or args.command in ('apply','rollback','migrate-ownership','restore-ownership','retire-sync'),'EXECUTE_INVALID','render/preflight are read-only except explicit output directory')
        config=read_json(args.config,args.command not in ('render','preflight')); validate(config)
        if args.command=='render': result=write_bundle(config,args.bundle.resolve())
        elif args.command=='preflight': result=preflight(config,args.bundle.resolve())
        else:
            require(args.state is not None,'STATE_REQUIRED','Exact per-change state required')
            if args.command in ('migrate-ownership','restore-ownership'): result=migrate_ownership(config,args.bundle.resolve(),args.state,execute=args.execute,restore=args.command=='restore-ownership')
            else: result={'apply':apply,'rollback':rollback,'retire-sync':retire_sync}[args.command](config,args.bundle.resolve(),args.state,execute=args.execute)
        print(json.dumps(result,indent=2)); return 0 if result.get('ready',True) else 2
    except (Blocked,OSError,ValueError) as error:
        print(json.dumps({'ready':False,'production_changed':False,'error':getattr(error,'code','INPUT_OR_HOST_ERROR'),'message':str(error)})); return 2
if __name__=='__main__': sys.exit(main())
