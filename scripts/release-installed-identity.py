"""Read-only full-install identity from the original maintained requester/job.
No staging, installation dispatch, session creation or saved-reply admission.
"""
import hashlib,json,pathlib,re,time,uuid
P=pathlib.Path
REQUESTER_SHA='15ae855d7025b9cc267b7a7529ac59c5fdcc1cf960e00104578ba79b3007dc06'
def need(v,r):
    if not v:raise RuntimeError(r)
def enc(v):return json.dumps(v,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
def sha(v):return hashlib.sha256(v).hexdigest()
def validate_observation(value,operation,job_id):
    need(value.get('operationId')==operation['operationId'] and value.get('jobId')==job_id
      and value.get('candidateId')==operation['candidateId'] and value.get('priorCandidateId')==operation['priorCandidateId']
      and value.get('workspaceEpoch')==operation['workspaceEpoch'] and value.get('idempotencyKey')==operation['idempotencyKey']
      and value.get('releaseId')==operation['bundleSha256'] and value.get('state')=='completed'
      and value.get('jobHold') is False and value.get('controllerHoldObserved') is True
      and value.get('controllerHoldFor','missing') is None and value.get('currentJobMatches') is True
      and value.get('automaticResubmissionPermitted') is False,'full-original-completed-installation-required')
def validate_result(value,operation,job_id):
    need(value=={'format':1,'jobId':job_id,'candidateId':operation['candidateId'],'priorCandidateId':operation['priorCandidateId'],
      'outcome':'completed','savedWorkVerified':True,'accountsVerified':True,'recoveryVerified':True,'healthVerified':True},'full-original-installer-result-required')
def validate_health(health,access,operation):
    need(health.get('status')=='ready' and all(health.get(k)==operation[k] for k in ('candidateId','version','buildVersion','apiVersion','schemaVersion'))
      and access.get('workspaceEpoch')==operation['workspaceEpoch'] and access.get('recovery') is False and access.get('recoveryLocal') is False
      and re.fullmatch('[a-f0-9]{64}',health.get('serviceInputsSha256','')) and str(uuid.UUID(health['processIdentity']))==health['processIdentity']
      and isinstance(health.get('frontend'),dict),'full-current-health-identity-required')
    return {k:health[k] for k in ('candidateId','serviceInputsSha256','apiVersion','schemaVersion','processIdentity','frontend')}|{'epoch':access['workspaceEpoch']}
def original(binding,s):
    need(set(binding)=={'format','operation','jobId','requester','runtime'} and binding['format']==1,'full-identity-binding-shape')
    op=binding['operation'];need(str(uuid.UUID(binding['jobId']))==binding['jobId'],'full-original-job-id')
    helper=binding['requester'];need(helper=={'path':'/opt/nova-release-tools/'+REQUESTER_SHA+'/request_install.py','sha256':REQUESTER_SHA},'full-maintained-requester-required')
    client_module=s.load_module('full_identity_original_requester',helper['path'],s.ref(helper,262144,True))
    client_module.validate_operation(op)
    need(op['apiVersion']==1 and op['schemaVersion']==55,'full-supported-api-schema-required')
    config_raw=s.ref(binding['runtime']['hostConfig'],65536);config=json.loads(config_raw)
    need(binding['runtime']['hostConfig']['path']=='/etc/nova-update/config.json' and config.get('stateDirectory')=='/var/lib/nova-update','full-configured-state-root-required')
    state=P(config['stateDirectory']);path=state/'release-coordinator/inputs'/(op['operationId']+'.json')
    operation_raw=s.raw(path,8192,True);need(json.loads(operation_raw)==op,'full-original-operation-changed')
    io=client_module.SystemIO();client=client_module.InstallRequest(str(path),io)
    need(client.operation==op and client.config_sha==sha(config_raw),'full-requester-config-or-operation-changed')
    intent=client.load_intent();observed=client.observe(0);validate_observation(observed,op,binding['jobId'])
    journal=client.read(str(state/'jobs/journal.json'),16*1024**2);job=client_module.matched_job(journal,op)
    need(job and job['id']==binding['jobId']==journal.get('currentId') and job.get('state')=='completed' and job.get('hold') is False,'full-exact-current-original-job-required')
    # The maintained installer keys dependency/runtime releases by bundle hash.
    release=job['release'];folder=op['bundleSha256'] if release.get('runtimeBundle') or release.get('applicationDependenciesBundle') else op['candidateId']
    staged=state/'staging'/folder;result_path=staged/'attempts'/binding['jobId']/'result.json';result_raw=s.raw(result_path,4096,True)
    validate_result(json.loads(result_raw),op,binding['jobId']);client.rehearsal_release()
    current=P('/opt/nova/current');need(current.is_symlink() and current.lstat().st_uid==0,'full-current-selector-changed')
    s.protected(current.parent,True);target=current.resolve(strict=True);s.protected(target,True)
    package=s.raw(target/'package.json',1024**2);candidate=s.raw(target/'dist/candidate.json',2*1024**2);manifest=json.loads(candidate)
    need(sha(package+candidate)==op['candidateId'] and target==P('/opt/nova/releases')/(op['version']+'-'+op['candidateId'][:12])
      and manifest.get('version')==op['version'],'full-installed-candidate-changed')
    pair_raw=s.raw(staged/'reviewed-pair.json',1024**2,True);pair=json.loads(pair_raw)
    need(pair.get('format')==1 and pair.get('candidateId')==op['candidateId'] and pair.get('priorCandidateId')==op['priorCandidateId'],'full-installed-pair-changed')
    dependencies=None;d=pair.get('applicationDependencies');signed=release.get('applicationDependenciesBundle')
    if d is not None or signed is not None:
        need(isinstance(d,dict) and isinstance(signed,dict) and d['archiveSha256']==signed['sha256'] and d['archiveBytes']==signed['bytes'],'full-signed-dependency-pair-changed')
        root=P('/opt/nova/dependencies/managed-updates')/d['archiveSha256'];pointer=target/'node_modules'
        need(pointer.is_symlink() and pointer.lstat().st_uid==0 and pointer.resolve(strict=True)==root/'node_modules','full-installed-dependency-selector-changed')
        s.protected(root,True);s.protected(root/'node_modules',True)
        lock=s.raw(root/'package-lock.json',16*1024**2);need(sha(lock)==d['packageLockSha256'] and sha(s.raw(target/'package-lock.json',16*1024**2))==d['packageLockSha256'],'full-installed-dependency-lock-changed')
        dependencies={'archiveSha256':d['archiveSha256'],'packageLockSha256':sha(lock),'selectedDirectory':str(root/'node_modules')}
    else:
        # This new producer qualifies the maintained offline dependency route.
        # Bundled/in-place dependencies need their own exact closure proof.
        raise RuntimeError('full-offline-dependency-installation-required')
    proof={'jobId':binding['jobId'],'releaseId':op['bundleSha256'],'jobSha256':sha(enc(job)),
      'operationReference':{'path':str(path),'sha256':sha(operation_raw)},'intentSha256':sha(enc(intent)),
      'installerResult':{'path':str(result_path),'sha256':sha(result_raw)},'reviewedPairSha256':sha(pair_raw),
      'applicationDependencies':dependencies,'candidateId':op['candidateId'],'candidateFilesSha256':sha(package+candidate),'hostConfigSha256':sha(config_raw)}
    return proof,client
def observe(binding,s):
    proof,client=original(binding,s);process=s.process_identity();runtime=s.runtime_identity(binding['runtime'],True)
    need(runtime['openclawVersion']==binding['operation']['agentVersion'],'full-installed-runtime-version-changed')
    health=validate_health(client.io.get_json('health'),client.io.get_json('access/context'),binding['operation'])
    after,_=original(binding,s);need(after==proof and s.process_identity()==process,'full-installation-changed-during-observation')
    return {'format':1,'kind':'maintained-installed-acceptance-identity','operationId':binding['operation']['operationId'],
      'candidateId':binding['operation']['candidateId'],'priorCandidateId':binding['operation']['priorCandidateId'],
      'jobId':binding['jobId'],'idempotencyKey':binding['operation']['idempotencyKey'],'request':binding,
      'health':health,'appProcess':process,'runtimeProof':runtime,'installationProof':proof,'readOnly':True,
      'savedReplyAccepted':False,'browserUiVerified':False}
