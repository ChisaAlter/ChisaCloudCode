#!/usr/bin/env python3
"""Deterministic, offline non-root deployment candidate generation (no build/pull)."""
from __future__ import annotations
import hashlib
import ipaddress
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat

class Invalid(ValueError): pass
def require(value,message):
    if not value: raise Invalid(message)
def identifier(value):
    require(isinstance(value,str) and re.fullmatch(r'[a-z][a-z0-9_-]{0,47}',value),'Use bounded lower-case literal identifiers'); return value
def absolute(value):
    require(isinstance(value,str) and re.fullmatch(r'/[a-zA-Z0-9_./-]+',value) and str(PurePosixPath(value))==value and '..' not in PurePosixPath(value).parts and value!='/','Use canonical absolute literal paths'); return value
def image(value,optional=False):
    if value is None and optional: return
    require(isinstance(value,str) and re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9._/:\-]*@sha256:[a-f0-9]{64}',value),'Operator must supply immutable registry/repository@sha256 reference; mutable tags are not accepted')
def fields(value,required): require(isinstance(value,dict) and set(value)==set(required),'Unexpected or missing deployment configuration fields')
def bytes_json(value): return (json.dumps(value,sort_keys=True,indent=2)+'\n').encode()
def path_under(child,parent): return child==parent or child.startswith(parent+'/')
def protected_record(filename, *, uid=0, gid=None, mode=None, directory=False):
    require(filename.is_absolute() and filename.resolve()==filename,'Recovery authority path is redirected')
    for location in [*reversed(filename.parents),filename]:
        item=location.lstat(); final=location==filename
        require(not stat.S_ISLNK(item.st_mode) and item.st_uid==uid and not item.st_mode&0o022,'Recovery authority ancestors must be root-owned and nonwritable')
        require(stat.S_ISDIR(item.st_mode) if not final or directory else stat.S_ISREG(item.st_mode) and item.st_nlink==1 and item.st_size<=1024*1024,'Recovery authority must be bounded protected regular data')
    item=filename.lstat()
    if gid is not None: require(item.st_gid==gid,'Recovery authority read group changed')
    if mode is not None: require(stat.S_IMODE(item.st_mode)==mode,'Recovery authority permission mode changed')
    return item

def protected_json(filename, *, gid=None, mode=None):
    before=protected_record(filename,gid=gid,mode=mode)
    descriptor=os.open(filename,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC)
    try:
        opened=os.fstat(descriptor)
        require((opened.st_dev,opened.st_ino)==(before.st_dev,before.st_ino),'Recovery authority changed while opening')
        with os.fdopen(descriptor,'rb',closefd=False) as stream: data=stream.read(1024*1024+1)
        after=os.fstat(descriptor); named=protected_record(filename,gid=gid,mode=mode)
        stamp=lambda value:(value.st_dev,value.st_ino,value.st_size,value.st_mtime_ns,value.st_ctime_ns)
        require(len(data)<=1024*1024 and stamp(opened)==stamp(after)==stamp(named),'Recovery authority changed during read')
        return json.loads(data),hashlib.sha256(data).hexdigest()
    finally: os.close(descriptor)

def validate_recovery_catalog(config, catalog, client):
    fields(catalog,{'version','authoritySocketPath','authorityUid','supervisorUid','workspaces'})
    require(type(catalog['version']) is int and catalog['version']==1 and type(catalog['authorityUid']) is int and catalog['authorityUid']==0 and type(catalog['supervisorUid']) is int and catalog['supervisorUid']==0,'Recovery catalog must enroll the independent root front and supervisor')
    require(catalog['authoritySocketPath']==config['gateway']['grant_issuer_socket'] and client.get('authoritySocketPath')==catalog['authoritySocketPath'] and client.get('brokerSocketPath')==config['gateway']['broker_socket'],'Recovery/client Unix endpoint mismatch')
    require(client.get('version')==1 and isinstance(client.get('accounts'),list) and isinstance(catalog['workspaces'],list) and catalog['workspaces'],'Recovery/client catalog inventory missing')
    seen=set(); witnesses=set()
    for entry in catalog['workspaces']:
        fields(entry,{'root','userId','ownerId','workspaceId','generation','bindingEpoch','sessionId','ticket','nativeWitnessPath'})
        require(entry['ownerId']==config['owner_id'] and all(isinstance(entry[key],str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}',entry[key]) for key in ('userId','ownerId','workspaceId','generation','bindingEpoch','sessionId')),'Recovery static identity is invalid or belongs to another owner')
        absolute(entry['root']); require(path_under(entry['root'],config['api']['workspaces_root']) and entry['root']!=config['api']['workspaces_root'],'Recovery workspace must belong to the exact enrolled account')
        require(isinstance(entry['ticket'],str) and re.fullmatch('[a-f0-9]{64,128}',entry['ticket']),'Recovery requires an actual operator-enrolled opaque ticket')
        absolute(entry['nativeWitnessPath']); require(str(PurePosixPath(entry['nativeWitnessPath']).parent)==config['recovery']['native_witness_directory'] and entry['nativeWitnessPath'].endswith('.json') and entry['nativeWitnessPath'] not in witnesses,'Native stop witnesses use unique leaves of the fixed root directory')
        identity=(entry['root'],entry['bindingEpoch']); require(identity not in seen,'Duplicate recovery workspace/binding enrollment'); seen.add(identity); witnesses.add(entry['nativeWitnessPath'])
        matches=[workspace for account in client['accounts'] if account.get('userId')==entry['userId'] and account.get('accountRoot')==config['api']['workspaces_root'] for workspace in account.get('workspaces',[]) if all(workspace.get(key)==entry[key] for key in ('root','workspaceId','generation','ticket'))]
        require(len(matches)==1,'Recovery static scope/ticket must match exactly one pinned client catalog workspace')
    expected={(account.get('userId'),workspace.get('root')) for account in client['accounts'] if account.get('accountRoot')==config['api']['workspaces_root'] for workspace in account.get('workspaces',[]) if workspace.get('previewProfileId') is not None}
    require({(entry['userId'],entry['root']) for entry in catalog['workspaces']}==expected,'Recovery enrollment must cover exactly every preview-enabled client workspace')
    return True

def preflight_recovery(config):
    recovery=config['recovery']; gid=recovery['client_gid']
    protected_record(Path(recovery['config_path']).parent,gid=gid,mode=0o750,directory=True)
    catalog,digest=protected_json(Path(recovery['config_path']),gid=gid,mode=0o640)
    require(digest==recovery['config_sha256'],'Recovery catalog SHA256 changed')
    protected_record(Path(recovery['native_witness_directory']),gid=gid,mode=0o750,directory=True)
    reference=next(item for item in config['authority_files'] if item['env']=='CHISA_WORKSPACE_BROKER_CLIENT_CONFIG')
    client,client_digest=protected_json(Path(reference['source']))
    require(client_digest==reference['sha256'],'Pinned broker client catalog changed')
    validate_recovery_catalog(config,catalog,client)
    metadata=Path(config['api']['workspaces_root']).lstat()
    require(metadata.st_uid==0 and metadata.st_gid==recovery['metadata_gid'] and stat.S_IMODE(metadata.st_mode)==0o1770,'Native metadata parent must remain root-owned01770 API-group only')
    authority,authority_digest=protected_json(Path(recovery['authority_manifest']),mode=0o600)
    require(authority_digest==recovery['authority_manifest_sha256'] and authority.get('apiUid')==config['api']['uid'] and isinstance(authority.get('entries'),list),'Pinned independent authority enrollment changed')
    for entry in catalog['workspaces']:
        root=Path(entry['root']); item=root.lstat()
        require(root.resolve()==root and stat.S_ISDIR(item.st_mode) and item.st_uid!=config['api']['uid'] and not item.st_mode&0o002,'Workspace leaf must not be API-owned, world writable or redirected')
        require(root.parent==Path(config['api']['workspaces_root']),'Native metadata requires the exact protected account parent')
        matches=[record for record in authority['entries'] if all(record.get(key)==entry[key] for key in ('root','userId','ownerId','workspaceId','generation','bindingEpoch','sessionId')) and record.get('ticketHash')==hashlib.sha256(entry['ticket'].encode()).hexdigest()]
        require(len(matches)==1,'Recovery catalog must match exactly one independent authority enrollment')
        enrolled=matches[0]
        require(enrolled.get('nativeAccountGroupId')==recovery['metadata_gid'] and type(enrolled.get('rootUid')) is int and enrolled['rootUid']==item.st_uid and enrolled['rootUid']!=config['api']['uid'] and str(enrolled.get('rootDev'))==str(item.st_dev) and str(enrolled.get('rootIno'))==str(item.st_ino),'Independent authority native group/leaf owner/device/inode mapping changed')
    reference=recovery['stop_producer_evidence']
    require(reference is not None,'Independent root stop-witness producer evidence is missing; recovery activation remains blocked')
    producer,producer_digest=protected_json(Path(reference['path']),mode=0o600)
    require(producer_digest==reference['sha256'],'Independent stop-witness producer evidence changed')
    fields(producer,{'version','reviewer','requestedBy','verifiedAt','expiresAt','recoveryConfigSha256','apiUid','nativeMetadataGroupId','recoveryReadGroupId','authoritySocketPath','nativeWitnessDirectory','checks'})
    require(type(producer['version']) is int and producer['version']==1 and isinstance(producer['reviewer'],str) and producer['reviewer'] and producer['reviewer']!=producer['requestedBy'],'Stop producer requires independent review')
    import datetime as dt
    created=dt.datetime.fromisoformat(producer['verifiedAt'].replace('Z','+00:00')); expires=dt.datetime.fromisoformat(producer['expiresAt'].replace('Z','+00:00')); current=dt.datetime.now(dt.timezone.utc)
    require(created.tzinfo is not None and expires.tzinfo is not None and created<=current<=expires and expires-created<=dt.timedelta(hours=2),'Stop producer evidence is stale or overlong')
    expected={'recoveryConfigSha256':recovery['config_sha256'],'apiUid':config['api']['uid'],'nativeMetadataGroupId':recovery['metadata_gid'],'recoveryReadGroupId':gid,'authoritySocketPath':config['gateway']['grant_issuer_socket'],'nativeWitnessDirectory':recovery['native_witness_directory']}
    require(all(producer[key]==value for key,value in expected.items()),'Stop producer evidence belongs to another layout')
    fields(producer['checks'],{'hostBirthObserved','nativeBirthObserved','positiveWaitOrFence','separatePidDomains','atomicDurableWitnesses','apiCannotWriteEvidence','workerCannotWriteMetadata','workspaceLeafSwapDenied','actualNonrootRecovery'})
    require(all(value is True for value in producer['checks'].values()),'Stop producer was not verified for exact independent host/native stops and real nonroot recovery')
    return True

def validate(config):
    fields(config,{'version','owner_id','images','api','network','gateway','mounts','authority_files','socket_directories','recovery','secret_env_file','mapping','artifact_root','egress'})
    require(config['version']==1,'Unsupported deployment version'); identifier(config['owner_id']); absolute(config['artifact_root'])
    fields(config['images'],{'node_base','api','gateway','proxy','rollback_api'})
    for value in config['images'].values(): image(value,True)
    api=config['api']; fields(api,{'uid','gid','home','workspaces_root','database_path','listen_port','allowed_hosts','allowed_origins','trusted_proxy','health_path','command','memory_mb','cpus'})
    for name in ('uid','gid'): require(type(api[name]) is int and 1000<=api[name]<=65535,'API must use an explicit non-root UID/GID')
    for name in ('home','workspaces_root','database_path'): absolute(api[name])
    require(api['home']=='/opt/chisacloudcode/home' and api['workspaces_root']=='/opt/chisacloudcode/workspaces','Initial candidate preserves exact historical absolute HOME/workspace identity; a new mapping requires a new reviewed adapter')
    require(path_under(api['database_path'],'/opt/chisacloudcode/data'),'Database must remain in exact dedicated private data path')
    require(type(api['listen_port']) is int and 1024<=api['listen_port']<=65535,'API must use a nonprivileged internal port')
    require(api['command']==['node','dist-server/server/index.js'],'Only the existing compiled API entrypoint is allowed')
    require(isinstance(api['allowed_hosts'],list) and api['allowed_hosts'] and isinstance(api['allowed_origins'],list) and api['allowed_origins'],'Explicit ingress host/origin policy required')
    for host in api['allowed_hosts']: require(isinstance(host,str) and re.fullmatch(r'[a-zA-Z0-9.-]+(?::[0-9]{1,5})?',host) and '*' not in host,'Exact allowed host required')
    for origin in api['allowed_origins']: require(isinstance(origin,str) and re.fullmatch(r'https://[a-zA-Z0-9.-]+(?::[0-9]{1,5})?',origin),'Exact HTTPS allowed origin required')
    require(api['health_path']=='/health','Candidate health check uses the existing narrow health endpoint')
    require(type(api['memory_mb']) is int and 256<=api['memory_mb']<=8192 and isinstance(api['cpus'],(int,float)) and 0<api['cpus']<=8,'Bounded API memory/CPU limits required')
    network=config['network']; fields(network,{'service_name','service_subnet','api_address','gateway_address','proxy_address','account_gateway_address','account_name','account_id','account_subnet','api_loopback_port'})
    identifier(network['service_name']); identifier(network['account_name']); require(re.fullmatch('[a-f0-9]{64}',network['account_id']),'Exact operator-enrolled account network ID required')
    service=ipaddress.ip_network(network['service_subnet']); account=ipaddress.ip_network(network['account_subnet'])
    require(service.version==4 and account.version==4 and 24<=service.prefixlen<=29 and 16<=account.prefixlen<=28 and service.is_private and account.is_private and not service.overlaps(account),'Two distinct private service/account IPv4 subnets required')
    addresses=[ipaddress.ip_address(network[name]) for name in ('api_address','gateway_address','proxy_address')]
    require(len(set(addresses))==3 and all(address in service and address not in (service.network_address,service.broadcast_address) for address in addresses),'Distinct fixed service addresses required')
    account_gateway=ipaddress.ip_address(network['account_gateway_address']); require(account_gateway in account and account_gateway not in (account.network_address,account.broadcast_address),'Fixed gateway account-side address must be in exact account subnet')
    require(api['trusted_proxy']==network['proxy_address'],'Ingress trusts only the exact dedicated proxy address')
    require(type(network['api_loopback_port']) is int and 1024<=network['api_loopback_port']<=65535,'Exact loopback proxy handoff port required')
    gateway=config['gateway']; fields(gateway,{'account_id','audience','key_id','public_key_file','broker_socket','grant_issuer_socket','listen_port','uid','gid','renew_socket','renew_gid','authority_manifest','authority_private_socket'})
    identifier(gateway['account_id']); identifier(gateway['audience']); identifier(gateway['key_id'])
    require(gateway['account_id']==config['owner_id'],'A gateway serves exactly one account')
    require(gateway['renew_socket']=='/run/chisa-preview-renew/renew.sock' and type(gateway['renew_gid']) is int and 1000<=gateway['renew_gid']<=65535,'Dedicated gateway-only renewal Unix channel required')
    require(gateway['authority_manifest']=='/etc/chisa-preview-authority/manifest.json' and gateway['authority_private_socket']=='/run/chisa-preview-authority/private.sock','Signer manifest/private channels must remain root-private fixed paths')
    for name in ('public_key_file','broker_socket','grant_issuer_socket'): absolute(gateway[name])
    require(gateway['broker_socket']=='/run/chisa-broker/broker.sock' and gateway['grant_issuer_socket']=='/run/chisa-authority/issuer.sock','Only fixed private Unix broker/issuer endpoints are allowed')
    require(type(gateway['listen_port']) is int and 1024<=gateway['listen_port']<=65535 and gateway['listen_port']!=api['listen_port'],'Distinct unprivileged gateway port required')
    require(all(type(gateway[name]) is int and 1000<=gateway[name]<=65535 for name in ('uid','gid')),'Gateway must be non-root')
    mounts=config['mounts']; require(isinstance(mounts,list) and len(mounts)>=3,'Exact private data/workspace/state mount inventory required'); sources=set(); targets=set()
    for mount in mounts:
        fields(mount,{'source','target','writable','uid','gid','mode','purpose'}); source=absolute(mount['source']); target=absolute(mount['target']); require(source==target,'Absolute host/runtime identity must be mirrored exactly')
        require(source not in sources and target not in targets,'Duplicate mount'); sources.add(source); targets.add(target)
        require(mount['purpose'] in ('data','workspace','runtime','provider-readonly'),'Only exact data/workspace/runtime/provider read slots are allowed')
        require(type(mount['writable']) is bool and type(mount['uid']) is int and type(mount['gid']) is int and re.fullmatch(r'0(?:1)?[0-7]{3}',mount['mode']),'Explicit mount UID/GID/mode required')
        require(not any(path_under(source,p) for p in ('/proc','/sys','/dev','/run','/etc','/root')) and 'docker.sock' not in source and 'containerd.sock' not in source,'No privileged host/socket source')
        if mount['purpose']=='data': require(source=='/opt/chisacloudcode/data' and mount['writable'] and mount['uid']==api['uid'],'API data needs its exact migrated private owner')
        elif mount['purpose']=='workspace': require(source==api['workspaces_root'] and mount['writable'] and mount['uid']==0 and mount['gid']==config['recovery']['metadata_gid'] and mount['mode']=='01770','Exact workspace metadata parent must remain root-owned01770 with API metadata group')
        elif mount['purpose']=='runtime': require(source==api['home']+'/.chisa-workspace-runtime' and mount['writable'] and mount['uid']==api['uid'] and mount['mode']=='0700','Private runtime state must match process UID and mode0700')
        else: require(not mount['writable'] and path_under(source,'/var/lib/chisa-provider-slots'),'Provider history/cache visibility is fixed read-only slot data only')
    require({m['purpose'] for m in mounts}>={'data','workspace','runtime'},'Every fixed persistent path must be explicitly mapped')
    require(not any(a!=b and path_under(a,b) for a in targets for b in targets),'Nested persistent mounts are not supported')
    authority=config['authority_files']; require(isinstance(authority,list) and authority,'Exact read-only per-owner authority catalogs required'); authority_targets=set()
    for item in authority:
        fields(item,{'source','target','env','sha256'}); absolute(item['source']); absolute(item['target']); require(item['source']==item['target'] and path_under(item['source'],'/etc/chisa-client'),'Only the protected per-owner client directory may be exposed')
        require(item['env'] in ('CHISA_WORKSPACE_BROKER_CLIENT_CONFIG','CHISA_WORKSPACE_BROKER_PROFILE_CONFIG','CHISA_PROVIDER_SLOT_CLIENT_CONFIG'),'No signing-key/private manifest environment path can enter API')
        require(item['target'] not in authority_targets and re.fullmatch('[a-f0-9]{64}',item['sha256']),'Unique pinned client catalog required'); authority_targets.add(item['target'])
    require({a['env'] for a in authority}>={'CHISA_WORKSPACE_BROKER_CLIENT_CONFIG','CHISA_WORKSPACE_BROKER_PROFILE_CONFIG','CHISA_PROVIDER_SLOT_CLIENT_CONFIG'},'All exact client catalogs required')
    sockets=config['socket_directories']; require(isinstance(sockets,list),'Private Unix socket directories required')
    require({s.get('path') for s in sockets}=={'/run/chisa-broker','/run/chisa-authority','/run/chisa-provider-slots'},'Only the three fixed broker/issuer/slot Unix channels are exposed')
    for item in sockets: fields(item,{'path','gid'}); require(type(item['gid']) is int and 1000<=item['gid']<=65535,'Dedicated client groups required')
    recovery=config['recovery']; fields(recovery,{'config_path','config_sha256','client_gid','metadata_gid','native_witness_directory','authority_manifest','authority_manifest_sha256','stop_producer_evidence'})
    require(recovery['config_path']=='/etc/chisa/workspace-broker-recovery.json' and recovery['native_witness_directory']=='/var/lib/chisa-native-stopped','Recovery uses only the fixed operator catalog and native witness directory')
    require(isinstance(recovery['config_sha256'],str) and re.fullmatch('[a-f0-9]{64}',recovery['config_sha256']),'Recovery catalog requires a pinned SHA256')
    require(recovery['authority_manifest']=='/etc/chisa-workspace-authority/manifest.json' and isinstance(recovery['authority_manifest_sha256'],str) and re.fullmatch('[a-f0-9]{64}',recovery['authority_manifest_sha256']),'Independent root authority manifest requires its fixed private path and SHA256')
    require(type(recovery['client_gid']) is int and 1000<=recovery['client_gid']<=65535 and recovery['client_gid'] not in {api['uid'],api['gid'],gateway['uid'],gateway['gid'],gateway['renew_gid'],*(s['gid'] for s in sockets)},'Recovery read group must be dedicated and absent from gateway/socket/primary groups including the renewal GID')
    require(type(recovery['metadata_gid']) is int and 1000<=recovery['metadata_gid']<=65535 and recovery['metadata_gid'] not in {api['uid'],api['gid'],gateway['uid'],gateway['gid'],gateway['renew_gid'],recovery['client_gid'],*(s['gid'] for s in sockets)},'Native metadata GID must be dedicated and isolated from primary, gateway renewal GID, recovery and socket groups')
    producer=recovery['stop_producer_evidence']
    if producer is not None:
        fields(producer,{'path','sha256'}); require(producer['path']=='/etc/chisa-hardening/native-stop-producer.json' and isinstance(producer['sha256'],str) and re.fullmatch('[a-f0-9]{64}',producer['sha256']),'Independent stop producer evidence requires its fixed protected path and SHA256')
    require(gateway['renew_gid'] not in {api['gid'],api['uid'],recovery['client_gid'],recovery['metadata_gid'],*(s['gid'] for s in sockets)},'Gateway renewal GID must be separate from every API primary and supplemental group')
    absolute(config['secret_env_file']); require(config['secret_env_file']=='/opt/chisacloudcode/secrets/api.env','The actual external env secret source is pinned; it is never copied into a bundle/image')
    mapping=config['mapping']; require(isinstance(mapping,list) and mapping,'Exact UID/HOME/namespace mappings need operator-reviewed restore evidence')
    for item in mapping:
        fields(item,{'path','old_uid','old_gid','new_uid','new_gid','expected_type','old_mode','new_mode','device','inode'}); absolute(item['path']); require(item['path'] in sources,'UID migration only for enumerated exact mount paths')
        require(item['expected_type']=='directory' and all(type(item[n]) is int and item[n]>=0 for n in ('old_uid','old_gid','new_uid','new_gid','device','inode')),'Exact old/new owner and inode identity required')
        require(all(re.fullmatch(r'0(?:1)?[0-7]{3}',item[n]) for n in ('old_mode','new_mode')),'Explicit old/new permission mapping required')
        require(item['new_uid']==next(m['uid'] for m in mounts if m['source']==item['path']) and item['new_gid']==next(m['gid'] for m in mounts if m['source']==item['path']),'Mapping must agree with persistent mount ownership')
    require({m['path'] for m in mapping}==sources,'No missing or duplicate UID migration scope')
    require(isinstance(config['egress'],list),'Explicit per-service outbound allowlist required')
    for item in config['egress']:
        fields(item,{'destination','protocol','port','purpose'}); destination=ipaddress.ip_network(item['destination'])
        require(destination.version==4 and destination.prefixlen>=24 and destination.is_global and not destination.overlaps(service) and not destination.overlaps(account),'Only narrow public destination CIDRs can enter candidate egress; private SSH needs a separate reviewed policy')
        require(item['protocol'] in ('tcp','udp') and type(item['port']) is int and 1<=item['port']<=65535 and item['purpose'] in ('dns','provider','public-ssh'),'Exact DNS/provider/publicSSH destination and port required')
    return config

def render(config,change_id):
    validate(config); api=config['api']; net=config['network']; gateway=config['gateway']; artifact=config['artifact_root']; images=config['images']
    env={'NODE_ENV':'production','HOME':api['home'],'WORKSPACES_ROOT':api['workspaces_root'],'DATABASE_PATH':api['database_path'],'HOST':'0.0.0.0','SERVER_PORT':str(api['listen_port']),'CHISA_ALLOWED_HOSTS':','.join(api['allowed_hosts']),'CHISA_ALLOWED_ORIGINS':','.join(api['allowed_origins']),'CHISA_TRUSTED_PROXIES':api['trusted_proxy']}
    env.update({item['env']:item['target'] for item in config['authority_files']})
    volumes=[{'type':'bind','source':m['source'],'target':m['target'],'read_only':not m['writable'],'bind':{'create_host_path':False}} for m in config['mounts']]
    volumes += [{'type':'bind','source':m['source'],'target':m['target'],'read_only':True,'bind':{'create_host_path':False}} for m in config['authority_files']]
    volumes += [{'type':'bind','source':m['path'],'target':m['path'],'read_only':True,'bind':{'create_host_path':False}} for m in config['socket_directories']]
    volumes += [{'type':'bind','source':config['recovery'][name],'target':config['recovery'][name],'read_only':True,'bind':{'create_host_path':False}} for name in ('config_path','native_witness_directory')]
    shared={'read_only':True,'cap_drop':['ALL'],'security_opt':['no-new-privileges:true'],'init':True,'pids_limit':256,'restart':'no','logging':{'driver':'json-file','options':{'max-size':'20m','max-file':'3'}}}
    api_service={
        **shared, 'image': images['api'] or 'OPERATOR_DIGEST_REQUIRED', 'pull_policy':'never',
        'user': str(api['uid'])+':'+str(api['gid']), 'group_add':[str(s['gid']) for s in config['socket_directories']]+[str(config['recovery'][name]) for name in ('client_gid','metadata_gid')],
        'working_dir':'/opt/chisa/app', 'command':api['command'], 'environment':env,
        'env_file':[config['secret_env_file']], 'volumes':volumes,
        'tmpfs':['/tmp:rw,noexec,nosuid,nodev,size=268435456,mode=1777',api['home']+':rw,noexec,nosuid,nodev,size=16777216,mode=0700,uid='+str(api['uid'])+',gid='+str(api['gid'])],
        'networks':{'service':{'ipv4_address':net['api_address']}},
        'mem_limit':str(api['memory_mb'])+'m', 'cpus':str(api['cpus']),
        'healthcheck':{'test':['CMD','node','-e',"require('http').get({host:'127.0.0.1',port:"+str(api['listen_port'])+",path:'/health',headers:{Host:'"+api['allowed_hosts'][0]+"'}},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"], 'interval':'30s','timeout':'5s','retries':3,'start_period':'30s'}
    }
    gateway_volumes=[
        {'type':'bind','source':'/etc/chisa-deployment/gateway-config.json','target':'/etc/chisa-deployment/gateway-config.json','read_only':True,'bind':{'create_host_path':False}},
        {'type':'bind','source':gateway['public_key_file'],'target':gateway['public_key_file'],'read_only':True,'bind':{'create_host_path':False}}
    ]
    gateway_volumes.extend({'type':'bind','source':s['path'],'target':s['path'],'read_only':True,'bind':{'create_host_path':False}} for s in config['socket_directories'] if s['path']=='/run/chisa-broker')
    gateway_volumes.append({'type':'bind','source':'/run/chisa-preview-renew','target':'/run/chisa-preview-renew','read_only':True,'bind':{'create_host_path':False}})
    gateway_service={
        **shared,'image':images['gateway'] or 'OPERATOR_DIGEST_REQUIRED','pull_policy':'never',
        'user':str(gateway['uid'])+':'+str(gateway['gid']),
        'group_add':[str(s['gid']) for s in config['socket_directories'] if s['path']=='/run/chisa-broker']+[str(gateway['renew_gid'])],
        'command':['node','/opt/chisa/gateway/preview-gateway.mjs','/etc/chisa-deployment/gateway-config.json'],
        'volumes':gateway_volumes,'tmpfs':['/tmp:rw,noexec,nosuid,nodev,size=16777216,mode=1777'],
        'networks':{'service':{'ipv4_address':net['gateway_address']},'account':{'ipv4_address':net['account_gateway_address']}},'mem_limit':'128m','cpus':'0.5'
    }
    proxy_service={
        **shared,'image':images['proxy'] or 'OPERATOR_DIGEST_REQUIRED','pull_policy':'never',
        'user':'10003:10003','command':['nginx','-c','/etc/nginx/chisa-candidate.conf','-g','daemon off;'],
        'volumes':[{'type':'bind','source':'/etc/chisa-deployment/proxy.conf','target':'/etc/nginx/chisa-candidate.conf','read_only':True,'bind':{'create_host_path':False}}],
        'tmpfs':['/tmp:rw,noexec,nosuid,nodev,size=33554432,mode=1777'],
        'networks':{'service':{'ipv4_address':net['proxy_address']}},
        'ports':['127.0.0.1:'+str(net['api_loopback_port'])+':8080'],'mem_limit':'128m','cpus':'0.5'
    }
    compose={
        'name':'chisa-'+config['owner_id'],'services':{'api':api_service,'preview_gateway':gateway_service,'ingress_proxy':proxy_service},
        'networks':{
            'service':{'name':net['service_name'],'driver':'bridge','internal':not bool(config['egress']),'enable_ipv6':False,'ipam':{'config':[{'subnet':net['service_subnet']}]}},
            'account':{'external':True,'name':net['account_name']}
        }
    }
    # No API service may use the enrolled account network. Gateway remains a
    # separate account-scoped boundary with no host ports or Docker capability.
    proxy='''# Candidate: current external reverse proxy must hand off through host loopback.
worker_processes 1;
pid /tmp/nginx.pid;
error_log /dev/stderr warn;
events { worker_connections 128; }
http {
    access_log off;
    client_body_temp_path /tmp/client;
    proxy_temp_path /tmp/proxy;
    map $http_upgrade $connection_upgrade { default upgrade; '' close; }
    server {
        listen 8080 default_server;
        server_name _;
        return 444;
    }
    server {
        listen 8080;
        server_name '''+' '.join(host.split(':')[0] for host in api['allowed_hosts'])+''';
        client_max_body_size 16m;
        location / {
            proxy_http_version 1.1;
            proxy_pass http://'''+net['api_address']+':'+str(api['listen_port'])+''';
            proxy_set_header Host $http_host;
            proxy_set_header X-Forwarded-Proto https;
            proxy_set_header X-Forwarded-Host $http_host;
            proxy_set_header X-Forwarded-For $remote_addr;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header Forwarded "";
            proxy_set_header CF-Connecting-IP "";
            proxy_set_header Proxy-Authorization "";
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection $connection_upgrade;
            proxy_buffering off;
            proxy_request_buffering off;
            proxy_read_timeout 300s;
        }
    }
}
'''
    gw={'version':1,'accountId':gateway['account_id'],'audience':gateway['audience'],'keyId':gateway['key_id'],'publicKeyFile':gateway['public_key_file'],'brokerSocket':gateway['broker_socket'],'listenHost':'0.0.0.0','listenPort':gateway['listen_port'],'allowedClientAddress':net['api_address'],'accountSubnet':net['account_subnet'],'maxConnections':64,'maxRequestBytes':16*1024*1024,'maxSeconds':300,'renewSocket':gateway['renew_socket']}
    unit='''[Unit]
Description=Chisa isolated candidate (operator gated; not enabled)
Requires=docker.service
After=docker.service network-online.target chisa-preview-authority.service
Requires=chisa-preview-authority.service
RequiresMountsFor=/opt/chisacloudcode/workspaces /opt/chisacloudcode/data /opt/chisacloudcode/home
ConditionPathExists=/etc/chisa-deployment/compose.json

[Service]
Type=simple
# Host launcher has administrative Docker power; that socket never enters API.
ExecStart=/usr/bin/docker compose --project-name chisa-'''+config['owner_id']+''' -f /etc/chisa-deployment/compose.json up --no-build --pull never --abort-on-container-exit
ExecStop=/usr/bin/docker compose --project-name chisa-'''+config['owner_id']+''' -f /etc/chisa-deployment/compose.json stop --timeout 30
Restart=no
TimeoutStopSec=60
UMask=0077
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
RestrictAddressFamilies=AF_UNIX
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
'''
    node=images['node_base'] or '${OPERATOR_NODE_IMAGE_DIGEST_REQUIRED}'
    dockerfile='''# Build only in the independent release pipeline after artifact/lock/SBOM checks.
# Base arg must be an operator-pinned registry/repository@sha256 reference.
ARG NODE_IMAGE='''+node+'''
FROM ${NODE_IMAGE}
WORKDIR /opt/chisa/app
# Input is a prebuilt, inspected Linux release artifact. No network install here.
COPY --chown='''+str(api['uid'])+':'+str(api['gid'])+''' release/ /opt/chisa/app/
ENV NODE_ENV=production HOME=/opt/chisacloudcode/home
USER '''+str(api['uid'])+':'+str(api['gid'])+'''
EXPOSE '''+str(api['listen_port'])+'''
CMD ["node","dist-server/server/index.js"]
'''
    gatewayfile='ARG NODE_IMAGE='+node+'\nFROM ${NODE_IMAGE}\nCOPY --chown='+str(gateway['uid'])+':'+str(gateway['gid'])+' preview-gateway.mjs /opt/chisa/gateway/preview-gateway.mjs\nUSER '+str(gateway['uid'])+':'+str(gateway['gid'])+'\nENTRYPOINT ["node","/opt/chisa/gateway/preview-gateway.mjs"]\n'
    signer_unit='''[Unit]
Description=Chisa independent preview signer and renewal authority
After=chisa-workspace-authority.service
Requires=chisa-workspace-authority.service
ConditionPathExists=/etc/chisa-preview-authority/manifest.json

[Service]
Type=simple
User=root
Group=root
ExecStart=/usr/bin/node /opt/chisa-deployment/deployment/preview-authority.mjs /etc/chisa-preview-authority/manifest.json
Restart=no
UMask=0077
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
RestrictAddressFamilies=AF_UNIX
CapabilityBoundingSet=CAP_CHOWN CAP_DAC_READ_SEARCH CAP_SETUID CAP_SETGID
ReadWritePaths=/var/lib/chisa-preview-authority /run/chisa-preview-authority /run/chisa-preview-renew
ReadOnlyPaths=/etc/chisa-preview-authority /run/chisa-workspace-authority /run/chisa-broker /proc

[Install]
WantedBy=multi-user.target
'''
    socket_contract={'version':1,'privateSignerSocket':gateway['authority_private_socket'],'privateSignerMode':'0600','renewSocket':gateway['renew_socket'],'renewDirectoryMode':'0750','renewSocketMode':'0660','renewGroupId':gateway['renew_gid'],'apiMayMountRenew':False,'apiFrontOnly':True,'frontRoutes':{'/v1/preview-ticket':'/v1/ticket','/v1/preview-close':'/v1/close'},'rootManifest':gateway['authority_manifest'],'secretValuesIncluded':False}
    recovery_contract={'version':1,'configPath':config['recovery']['config_path'],'configSha256':config['recovery']['config_sha256'],'configOwnerUid':0,'configMode':'0640','clientGroupId':config['recovery']['client_gid'],'nativeWitnessDirectory':config['recovery']['native_witness_directory'],'nativeWitnessDirectoryMode':'0750','nativeWitnessFileMode':'0640','apiReadOnly':True,'stopRecordsGenerated':False,'independentStopProducerEvidence':config['recovery']['stop_producer_evidence'],'workspaceMetadataParent':{'path':api['workspaces_root'],'uid':0,'gid':config['recovery']['metadata_gid'],'mode':'01770','workspaceLeafMustNotBeApiOwned':True},'acceptanceGate':'Independent root supervisor must positively stop/fence the exact host and native writer birth domains; API missing-PID or cleanup booleans cannot create evidence'}
    return {'recovery-mount-contract.json':bytes_json(recovery_contract),'systemd/chisa-preview-authority.service':signer_unit.encode(),'preview-socket-contract.json':bytes_json(socket_contract),'compose.json':bytes_json(compose),'proxy.conf':proxy.encode(),'gateway-config.json':bytes_json(gw),'systemd/chisa-candidate.service':unit.encode(),'Dockerfile.api':dockerfile.encode(),'Dockerfile.gateway':gatewayfile.encode(),'uid-home-mapping.json':bytes_json({'version':1,'change_id':change_id,'operations_render_only':True,'mapping':config['mapping'],'notes':['Full independent writer fence required before any ownership change','Change only exact inode-pinned entries, never recursive chmod/chown','Existing child UID/ACL/xattr/state must match an isolated restore migration artifact','Do not create an empty state directory or claim an unknown owner']})}

def preflight(config,runner,check_paths=True,allow_old_ownership=False):
    validate(config)
    for value in config['images'].values(): image(value)
    if check_paths:
        require(os.name=='posix','Deployment checks require Linux')
        preflight_recovery(config)
        for mount in config['mounts']:
            path=Path(mount['source']); item=path.lstat(); require(path.resolve()==path and stat.S_ISDIR(item.st_mode) and not stat.S_ISLNK(item.st_mode),'Persistent source missing/redirected; never create an empty substitute')
            desired=(mount['uid'],mount['gid'],int(mount['mode'],8)); current=(item.st_uid,item.st_gid,stat.S_IMODE(item.st_mode))
            mapping=next(m for m in config['mapping'] if m['path']==mount['source'])
            old=(mapping['old_uid'],mapping['old_gid'],int(mapping['old_mode'],8))
            require(current==desired or allow_old_ownership and current==old,'UID/GID/private permission mapping not yet independently migrated')
            require((item.st_dev,item.st_ino)==(mapping['device'],mapping['inode']),'Inode mapping is missing or replaced; do not create an empty substitute')
        for item in config['authority_files']:
            path=Path(item['source']); st=path.lstat(); require(path.resolve()==path and st.st_uid==0 and not st.st_mode&0o022 and st.st_nlink==1 and stat.S_ISREG(st.st_mode),'Client catalogs must be operator-owned protected single-link files')
            require(hashlib.sha256(path.read_bytes()).hexdigest()==item['sha256'],'Authority catalog changed')
        for item in config['socket_directories']:
            path=Path(item['path']); st=path.lstat(); require(path.resolve()==path and st.st_uid==0 and st.st_gid==item['gid'] and stat.S_IMODE(st.st_mode)==0o750,'Socket parent must be operator-owned0750 dedicated-clientgroup (not group-writable)')
        for location,directory in ((config['gateway']['authority_manifest'],False),('/run/chisa-preview-authority',True),('/run/chisa-preview-renew',True)):
            record=Path(location); st=record.lstat(); require(record.resolve()==record and st.st_uid==0 and not st.st_mode&0o022,'Signer authority/renew path must be protected root-owned')
            if not directory: require(stat.S_ISREG(st.st_mode) and st.st_nlink==1 and stat.S_IMODE(st.st_mode)==0o600,'Signer private manifest is root0600 and is never copied into the render')
            elif location=='/run/chisa-preview-renew': require(st.st_gid==config['gateway']['renew_gid'] and stat.S_IMODE(st.st_mode)==0o750,'Renew directory is gateway-only0750')
            else: require(stat.S_IMODE(st.st_mode)==0o700,'Private signer directory must deny API/gateway')
        secret=Path(config['secret_env_file']); st=secret.lstat(); require(secret.resolve()==secret and stat.S_ISREG(st.st_mode) and st.st_nlink==1 and st.st_uid==0 and stat.S_IMODE(st.st_mode)==0o600,'External env file must be root-owned0600; contents are not read')
    network=json.loads(runner(['/usr/bin/docker','network','inspect',config['network']['account_id']]))
    require(isinstance(network,list) and len(network)==1,'Missing account network'); item=network[0]
    require(item.get('Id')==config['network']['account_id'] and item.get('Name')==config['network']['account_name'] and item.get('Driver')=='bridge' and item.get('Scope')=='local','Account network identity changed')
    require(item.get('Labels',{}).get('chisa.broker.owner')==config['owner_id'] and item.get('IPAM',{}).get('Config')==[{'Subnet':config['network']['account_subnet']}],'Independent account network owner/subnet must match exactly')
    for name in ('api','gateway','proxy','rollback_api'):
        data=json.loads(runner(['/usr/bin/docker','image','inspect',config['images'][name]])); require(isinstance(data,list) and len(data)==1 and config['images'][name] in data[0].get('RepoDigests',[]),'Image not locally available under exact reviewed digest')
        image_config=data[0].get('Config',{}); require(image_config.get('User') not in (None,'','0','root','0:0'),'Final candidate/rollback image default user cannot be root')
    return True
