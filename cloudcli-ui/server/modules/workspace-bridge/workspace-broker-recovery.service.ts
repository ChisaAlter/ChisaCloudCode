/** The permanent writer/lease guard and preview/integration helpers embed this
 * coordinator. Root policy enrolls identities, never a caller's legacy label.
 * The authority's SO_PEERCRED front verifies the helper/parent and independent
 * mapping; native stop evidence remains separate from broker quiescence. */
export const workspaceBrokerRecoveryPython = String.raw`
import http.client, socket, struct, time

RECOVERY_CONFIG='/etc/chisa/workspace-broker-recovery.json'

def recovery_fail(message):
    raise RuntimeError('Trusted workspace cleanup was not confirmed: '+message)
def protected(location,uid,kind='file'):
    if not isinstance(location,str) or not location.startswith('/') or location!=os.path.normpath(location) or os.path.realpath(location)!=location: recovery_fail('noncanonical authority path')
    current='/'
    for part in location.split('/')[1:]:
        current=os.path.join(current,part); s=os.lstat(current)
        final=current==location
        sticky_parent=not final and s.st_uid==0 and stat.S_ISDIR(s.st_mode) and s.st_mode&stat.S_ISVTX
        if stat.S_ISLNK(s.st_mode) or s.st_uid not in (0,uid) or (s.st_mode&0o022 and not(final and kind=='socket') and not sticky_parent): recovery_fail('authority path is writable or redirected')
        if not final and not stat.S_ISDIR(s.st_mode): recovery_fail('authority parent is not a directory')
    if kind=='socket':
        if not stat.S_ISSOCK(s.st_mode) or s.st_uid!=uid or s.st_mode&0o007: recovery_fail('authority socket owner or access changed')
    elif not stat.S_ISREG(s.st_mode) or s.st_nlink!=1 or s.st_size>1048576 or s.st_uid!=uid: recovery_fail('authority record is not a bounded protected regular file')
    return s

def authority_json(location,uid):
    before=protected(location,uid)
    fd=os.open(location,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC)
    try:
        original=os.fstat(fd)
        if (before.st_dev,before.st_ino)!=(original.st_dev,original.st_ino): recovery_fail('authority record changed')
        raw=b''
        while len(raw)<=1048576:
            chunk=os.read(fd,65536)
            if not chunk: break
            raw+=chunk
        after=os.fstat(fd); named=protected(location,uid)
        stamp=lambda item:(item.st_size,item.st_mtime_ns,item.st_ctime_ns)
        if len(raw)>1048576 or (original.st_dev,original.st_ino)!=(named.st_dev,named.st_ino) or stamp(original)!=stamp(after) or stamp(after)!=stamp(named): recovery_fail('authority record changed during read')
        value=json.loads(raw)
        if not isinstance(value,dict): recovery_fail('authority record is not an object')
        return value
    finally: os.close(fd)

def authority_request(location,uid,route,body):
    pin=protected(location,uid,'socket')
    connection=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM); connection.settimeout(5)
    try:
        connection.connect(location)
        peer=struct.unpack('3i',connection.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,struct.calcsize('3i')))
        if peer[1]!=uid: recovery_fail('authority peer identity changed')
        encoded=json.dumps(body,separators=(',',':')).encode()
        if len(encoded)>16384: recovery_fail('authority request exceeds the fixed selector budget')
        headers='POST '+route+' HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: '+str(len(encoded))+'\r\n'
        connection.sendall(headers.encode()+b'\r\n'+encoded)
        response=http.client.HTTPResponse(connection); response.begin(); raw=response.read(1048577)
        named=protected(location,uid,'socket')
        if response.status!=200 or len(raw)>1048576 or (pin.st_dev,pin.st_ino)!=(named.st_dev,named.st_ino): recovery_fail('authority refused cleanup or its socket changed')
        value=json.loads(raw)
        if not isinstance(value,dict): recovery_fail('authority returned invalid cleanup evidence')
        return value
    finally: connection.close()

def recovery_identity(value):
    return isinstance(value,str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}',value) is not None

def native_parent():
    pid=os.getppid()
    def sample():
        with open('/proc/'+str(pid)+'/stat') as stream: record=stream.read(); fields=record.rsplit(')',1)[1].split()
        with open('/proc/sys/kernel/random/boot_id') as stream: boot=stream.read().strip()
        if int(record.split(' ',1)[0])!=pid or len(fields)<=19 or fields[0] in ('Z','X') or not re.fullmatch(r'[0-9]+',fields[19]): recovery_fail('live parent is not positively alive')
        return {'pid':pid,'processStartTime':fields[19],'bootId':boot,'pidNamespace':os.readlink('/proc/'+str(pid)+'/ns/pid')}
    first=sample()
    if sample()!=first or os.getppid()!=pid: recovery_fail('live parent changed during verification')
    return first

def trusted_workspace_cleanup(root,lease,purpose,operation=None):
    config=authority_json(RECOVERY_CONFIG,0)
    if config.get('version')!=1 or set(config)-{'version','authoritySocketPath','authorityUid','supervisorUid','workspaces'} or type(config.get('authorityUid')) is not int or config['authorityUid']!=0 or type(config.get('supervisorUid')) is not int or config['supervisorUid']!=0 or not isinstance(config.get('workspaces'),list): recovery_fail('operator independent-authority enrollment missing')
    if not isinstance(lease,dict) or not recovery_identity(lease.get('id')) or not recovery_identity(lease.get('epoch')): recovery_fail('legacy reservation identity is invalid')
    selected=[entry for entry in config['workspaces'] if isinstance(entry,dict) and entry.get('root')==root and entry.get('bindingEpoch')==lease['epoch']]
    if len(selected)!=1: recovery_fail('exact workspace binding is not uniquely enrolled')
    entry=selected[0]
    if set(entry)-{'root','userId','ownerId','workspaceId','generation','bindingEpoch','sessionId','ticket','nativeWitnessPath'}: recovery_fail('recovery enrollment contains a dynamic lease or unrecognized policy')
    for key in ('userId','ownerId','workspaceId','generation','bindingEpoch','sessionId'):
        if not recovery_identity(entry.get(key)): recovery_fail('incomplete fixed recovery enrollment')
    if not isinstance(entry.get('ticket'),str) or not re.fullmatch(r'[a-f0-9]{64,128}',entry['ticket']): recovery_fail('independent authority ticket is not enrolled')
    if lease.get('brokerSessionId') is not None and lease['brokerSessionId']!=entry['sessionId']: recovery_fail('known broker session changed')
    if lease.get('brokerLeaseId') is not None and not recovery_identity(lease['brokerLeaseId']): recovery_fail('known independent lease is invalid')
    if operation is not None and not recovery_identity(operation): recovery_fail('exact operation selector is invalid')
    witness=None
    if purpose in ('live-writer-release','integration-writer-release'):
        if purpose=='integration-writer-release' and (lease.get('integrationPeerChanged') is not True or not recovery_identity(lease.get('integrationOperation')) or not recovery_identity(lease.get('brokerLeaseId')) or lease.get('brokerSessionId')!=entry['sessionId'] or not isinstance(lease.get('pidNamespace'),str) or not re.fullmatch(r'pid:\[[0-9]+\]',lease['pidNamespace'])): recovery_fail('integration release lacks exact adopted native and broker identities')
        writer=native_parent()
        if any(writer[key]!=lease.get(key) for key in ('pid','processStartTime','bootId')) or lease.get('pidNamespace') is not None and lease['pidNamespace']!=writer['pidNamespace']: recovery_fail('live release is not from the exact admitting parent')
    elif purpose!='legacy-writer-release': recovery_fail('invalid release purpose')
    if purpose in ('legacy-writer-release','integration-writer-release'):
        # Both recovery paths require an independent stopped native writer. For
        # integration it is the old root-attested writer, separate from the live
        # adopted parent above; an API-writable marker cannot supply this proof.
        witness=authority_json(entry.get('nativeWitnessPath'),config['supervisorUid'])
        scope={'root':root,'userId':entry['userId'],'ownerId':entry['ownerId'],'workspaceId':entry['workspaceId'],'generation':entry['generation'],'bindingEpoch':entry['bindingEpoch'],'sessionId':entry['sessionId'],'legacyReservationId':lease['id']}
        if witness.get('version')!=1 or witness.get('active') is not True or any(witness.get(key)!=value for key,value in scope.items()) or type(witness.get('expiresAt')) is not int or witness['expiresAt']<=int(time.time()*1000): recovery_fail('trusted native supervisor witness is stale or mismatched')
        native_writer=witness.get('writer'); stopped=witness.get('supervisorStopped')
        if purpose=='integration-writer-release':
            if not isinstance(native_writer,dict) or type(native_writer.get('pid')) is not int or not 0<native_writer['pid']<=2147483647 or not isinstance(native_writer.get('processStartTime'),str) or not re.fullmatch(r'[0-9]{1,20}',native_writer['processStartTime']) or int(native_writer['processStartTime'])<=0 or not isinstance(native_writer.get('bootId'),str) or not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}',native_writer['bootId']) or not isinstance(native_writer.get('pidNamespace'),str) or not re.fullmatch(r'pid:\[[0-9]{1,20}\]',native_writer['pidNamespace']): recovery_fail('trusted stopped integration writer identity is invalid')
        elif not isinstance(native_writer,dict) or any(native_writer.get(key)!=lease.get(key) for key in ('pid','processStartTime','bootId')) or not isinstance(native_writer.get('pidNamespace'),str) or not re.fullmatch(r'pid:\[[0-9]+\]',native_writer['pidNamespace']) or lease.get('pidNamespace') is not None and lease['pidNamespace']!=native_writer['pidNamespace']: recovery_fail('native writer birth/namespace changed')
        if not isinstance(stopped,dict) or stopped.get('stopped') is not True or any(stopped.get(key)!=native_writer[key] for key in ('pid','processStartTime','bootId','pidNamespace')) or stopped.get('legacyReservationId')!=lease['id'] or stopped.get('bindingEpoch')!=lease['epoch'] or not recovery_identity(stopped.get('stopId')): recovery_fail('independent native supervisor did not acknowledge this exact writer stopped')
    request={key:entry[key] for key in ('userId','root','workspaceId','generation','bindingEpoch','sessionId','ticket')}
    # The adopted native parent is alive in its new PID domain. The original
    # broker peer remains stopped: only the authority's legacy route verifies
    # that independent old-peer witness; it never migrates the broker identity.
    request.update(legacyReservationId=lease['id'],purpose='legacy-writer-release' if purpose=='integration-writer-release' else purpose)
    if lease.get('brokerLeaseId') is not None: request['leaseId']=lease['brokerLeaseId']
    if operation is not None: request['operationId']=operation
    # Release resolves the old label only inside independent authority state.
    # Its root peer front observes this helper and actual parent. There is no
    # caller grant, /v1/lookup for an orphan, or legacy issuer fallback.
    result=authority_request(config['authoritySocketPath'],config['authorityUid'],'/v1/release',request)
    fixed={key:entry[key] for key in ('userId','root','ownerId','workspaceId','generation','bindingEpoch','sessionId')}
    if any(result.get(key)!=value for key,value in fixed.items()) or result.get('legacyReservationId')!=lease['id'] or not recovery_identity(result.get('leaseId')) or result['leaseId']==lease['id'] or lease.get('brokerLeaseId') is not None and result['leaseId']!=lease['brokerLeaseId'] or not recovery_identity(result.get('profileId')) or result.get('state')!='closed' or result.get('quiescent') is not True or result.get('cleanupConfirmed') is not True or result.get('resourceInventoryComplete') is not True or not isinstance(result.get('resources'),list) or type(result.get('closedAt')) is not int or type(result.get('confirmedAt')) is not int or result['closedAt']>result['confirmedAt'] or not recovery_identity(result.get('brokerInstanceId')): recovery_fail('independent authority did not close the exact dual-identity mapping')
    resources=result['resources']; ids=set()
    for resource in resources:
        if not isinstance(resource,dict) or not recovery_identity(resource.get('operationId')) or resource['operationId'] in ids or not isinstance(resource.get('resourceId'),str) or not re.fullmatch(r'[a-f0-9]{64}',resource['resourceId']): recovery_fail('immutable cleanup resource inventory is invalid')
        ids.add(resource['operationId'])
    # Complete quiescence permanently fences this exact lease and inventories
    # every immutable resource. An absent preview was never created; its private
    # native witness and both independent stop domains still gate native release.
    # A partial or legacy receipt cannot claim absence because the flag above is
    # required even when the complete resource inventory is empty.
    # Revalidate root policy and both positive identities before the caller's
    # original guard performs its exact native-generation/lease CAS commit.
    if authority_json(RECOVERY_CONFIG,0)!=config or witness is not None and authority_json(entry['nativeWitnessPath'],config['supervisorUid'])!=witness: recovery_fail('trusted recovery enrollment changed before commit')
    if purpose in ('live-writer-release','integration-writer-release') and native_parent()!=writer: recovery_fail('live admitting parent changed before native commit')
    return result
`;
