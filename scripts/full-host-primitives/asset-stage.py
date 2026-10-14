"""Root-only, two-phase private staging; never dispatches installation."""
import argparse, hashlib, http.client, json, os, pathlib, socket, stat, uuid
P=pathlib.Path
STATE=P('/var/lib/nova-update')
FROZEN = True
BUNDLE = BINDING['BUNDLE']
BUNDLE_BYTES = BINDING['BUNDLE_BYTES']
TARGET = BINDING['TARGET']
PRIOR = BINDING['PRIOR']
EPOCH = BINDING['EPOCH']
JOB = BINDING['JOB']
EXCLUDED = BINDING['EXCLUDED']
LEASE = BINDING['LEASE']
PROOF = BINDING['PROOF']
INCOMING = P(BINDING['INCOMING'])
SPECS = {k:tuple(v) for k,v in BINDING['SPECS'].items()}
RUNTIME = BINDING.get('RUNTIME')
NONCE = BINDING['NONCE']
INTENT = STATE/('private-assets-full-delivery-'+NONCE+'.intent.json')
PREPARED = STATE/('private-assets-full-delivery-'+NONCE+'.prepared.json')
COPY_INTENT = STATE/('private-assets-full-delivery-'+NONCE+'.copy-intent.json')
VERIFIED = STATE/('private-assets-full-delivery-'+NONCE+'.verified.json')
def require(value,message):
 if not value:raise RuntimeError(message)
def protect(path,directory=False):
 require(path.is_absolute() and path.resolve(strict=True)==path,'Redirected private path.')
 for part in (path,*path.parents):
  info=part.lstat();require(info.st_uid==0 and not stat.S_ISLNK(info.st_mode) and not info.st_mode&0o022,'Private path authority changed.')
 info=path.lstat();require(stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode) and info.st_nlink==1,'Private path type changed.')
def raw(path,limit=65536):
 protect(path);info=path.stat();require(info.st_size<=limit,'Oversized evidence.');data=path.read_bytes();require(len(data)==info.st_size,'Evidence changed.');return data
def sync(path):
 fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 try:os.fsync(fd)
 finally:os.close(fd)
def save(path,data):
 fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'wb') as stream:stream.write(data);stream.flush();os.fsync(stream.fileno())
 sync(path.parent)
class Control(http.client.HTTPConnection):
 def connect(self):
  path=P('/run/nova-update/control.sock');protect(path.parent,True);info=path.lstat();require(stat.S_ISSOCK(info.st_mode) and info.st_uid==0 and not info.st_mode&0o007,'Control socket authority changed.')
  self.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);self.sock.settimeout(5);self.sock.connect(str(path))
def frozen_gate():
 require(BINDING['CURRENT_FACTS']['result']['path']==BINDING['acceptedInstallation']['path'] and BINDING['CURRENT_FACTS']['result']['sha256']==BINDING['acceptedInstallation']['sha256'] and BINDING['CURRENT_FACTS']['hostConfiguration']['sha256']==BINDING['hostConfiguration']['sha256'],'Exact configured prior installation and host required.')
 require(CURRENT_FACTS['resultValue']['candidateId']==PRIOR and CURRENT_FACTS['resultValue']['jobId']==JOB and CURRENT_FACTS['resultValue']['outcome']=='completed' and all(CURRENT_FACTS['resultValue'][k] is True for k in ('savedWorkVerified','accountsVerified','recoveryVerified','healthVerified')),'Exact successful prior result required.')
 digest=lambda value:isinstance(value,str) and len(value)==64 and all(c in '0123456789abcdef' for c in value)
 require(set(EXCLUDED)=={'candidateIds','bundleSha256s','rehearsalLeaseIds'} and all(isinstance(v,list) and len(v)<=64 and len(set(v))==len(v) for v in EXCLUDED.values()) and all(digest(v) for k in ('candidateIds','bundleSha256s') for v in EXCLUDED[k]) and all(str(uuid.UUID(v))==v for v in EXCLUDED['rehearsalLeaseIds']),'Private retained exclusion identities changed.')
 require(FROZEN is True and all(digest(v) for v in (BUNDLE,TARGET,PROOF,SPECS['app-dependencies.tgz'][1])) and type(SPECS['app-dependencies.tgz'][0]) is int and SPECS['app-dependencies.tgz'][0]>0 and TARGET not in EXCLUDED['candidateIds'] and BUNDLE not in EXCLUDED['bundleSha256s'] and type(BUNDLE_BYTES) is int and BUNDLE_BYTES>0 and SPECS['bundle.json']==(BUNDLE_BYTES,BUNDLE) and isinstance(LEASE,str) and len(LEASE)==36 and LEASE not in EXCLUDED['rehearsalLeaseIds'] and str(INCOMING).startswith('/var/tmp/nova-full-delivery-private-assets-') and 'PENDING_' not in str(INCOMING) and all(c in 'abcdefghijklmnopqrstuvwxyz0123456789-/' for c in str(INCOMING)),'Exact new delivery pins remain unresolved; no host effects permitted.')
 suffix=str(INCOMING).removeprefix('/var/tmp/nova-full-delivery-private-assets-');nonce=uuid.UUID(suffix)
 require(str(nonce)==suffix and nonce.version==4 and suffix==NONCE and str(uuid.UUID(LEASE))==LEASE,'Incoming and rehearsal reservations need exact canonical UUIDs.')
 require(set(SPECS)=={'bundle.json','app-dependencies.tgz'}|({'runtime.tgz'} if RUNTIME else set()),'Exact staged artifact roles changed.')
 for name,(size,digest_value) in SPECS.items():require(type(size) is int and 0<size<=(512*1024**2 if name=='runtime.tgz' else 128*1024**2) and digest(digest_value),'Bounded staged role identity changed.')
 if RUNTIME:
  require(RUNTIME['format']==1 and RUNTIME['fromVersion']==BINDING['PRIOR_AGENT_VERSION']=='2026.9.6' and RUNTIME['toVersion']=='2026.9.8'
   and RUNTIME['nodeVersion']=='24.21.0' and RUNTIME['companion']['pluginVersion']=='2026.9.8' and RUNTIME['companion']['codexVersion']=='0.158.0'
   and SPECS['runtime.tgz']==(RUNTIME['archiveBytes'],RUNTIME['archiveSha256']),'Exact reviewed runtime transition changed.')
 else:require('PRIOR_AGENT_VERSION' not in BINDING,'Unexpected prior runtime override.')

def runtime_pins():return {'runtimeSha256':SPECS['runtime.tgz'][1]} if RUNTIME else {}

def directory_identity(path):
 info=path.lstat();return {'device':info.st_dev,'inode':info.st_ino,'mode':stat.S_IMODE(info.st_mode),'uid':info.st_uid,'gid':info.st_gid,'size':info.st_size,'mtimeNs':info.st_mtime_ns,'ctimeNs':info.st_ctime_ns,'nlink':info.st_nlink}

def preflight():
 frozen_gate();protect(STATE,True)
 config=json.loads(raw(P('/etc/nova-update/config.json')));require(config['stateDirectory']==str(STATE),'Configured staging root changed.')
 root=STATE/'staging';protect(root,True);destination=root/BUNDLE
 journal_bytes=raw(STATE/'jobs/journal.json',16*1024**2)
 require(hashlib.sha256(journal_bytes).hexdigest()==CURRENT_FACTS['journal']['sha256'],'Exact current journal changed.')
 require(hashlib.sha256(raw(P('/etc/nova-update/config.json'))).hexdigest()==CURRENT_FACTS['hostConfiguration']['sha256'],'Exact host configuration changed.')
 journal=json.loads(journal_bytes);jobs=[j for j in journal['jobs'] if j['id']==journal['currentId']];require(len(jobs)==1,'Current job ambiguous.');job=jobs[0]
 require(job==CURRENT_FACTS['currentJob'],'Actual completed prior job changed.')
 result_ref=CURRENT_FACTS['result'];result_bytes=raw(P(result_ref['path']));require(hashlib.sha256(result_bytes).hexdigest()==result_ref['sha256'] and json.loads(result_bytes)==CURRENT_FACTS['resultValue'],'Actual completed install proof changed.')
 client=Control('localhost',timeout=5)
 try:
  client.request('POST','/v1/status',b'{}',{'Content-Type':'application/json'});response=client.getresponse();data=response.read(65537);require(response.status==200 and len(data)<=65536,'Controller observation failed.');view=json.loads(data)
 finally:client.close()
 require(view.get('holdFor') is None and view.get('job',{}).get('id')==JOB and view['job']['state']=='completed','Controller restored job/hold changed.')
 lease=json.loads(raw(STATE/'operator-maintenance/current.json'))
 require(lease['id']==LEASE and lease['phase']=='released' and lease['releaseKind']=='rehearsed' and lease['candidateId']==PRIOR and lease['workspaceEpoch']==EPOCH and lease['proofSha256']==PROOF,'Actual released automatic rehearsal changed.')
 proof=raw(STATE/'operator-maintenance'/LEASE/'acceptance.json');require(hashlib.sha256(proof).hexdigest()==PROOF,'Automatic proof changed.')
 value=json.loads(proof);require(value['kind']=='operator-maintenance-acceptance' and value['outcome']=='rehearsed' and value['candidateId']==PRIOR and value['workspaceEpoch']==EPOCH and value['leaseId']==LEASE and all(value.get(k) is True for k in ('savedWorkVerified','recoveryVerified','healthVerified','accountsVerified')),'Automatic proof incomplete.')
 import urllib.request
 with urllib.request.build_opener(urllib.request.ProxyHandler({})).open('http://127.0.0.1:4383/api/health',timeout=10) as response:
  data=response.read(65537);require(response.status==200 and len(data)<=65536,'Prior health unavailable.');health=json.loads(data)
 require(health['status']=='ready' and health['candidateId']==PRIOR and health['version']==BINDING['PRIOR_VERSION'],'Working prior changed.')
 agent=P(config['agentDirectory']).resolve(strict=True);protect(agent,True);require(json.loads(raw(agent/'package.json',1024**2))['version']==BINDING.get('PRIOR_AGENT_VERSION','2026.9.8'),'Prior runtime changed.')
 return destination
def input_verified(name,size,digest,uid):
 path=INCOMING/name;info=path.lstat();require(stat.S_ISREG(info.st_mode) and not stat.S_ISLNK(info.st_mode) and info.st_nlink==1 and info.st_uid==uid and info.st_size==size and not info.st_mode&0o022,'Incoming file authority changed.')
 h=hashlib.sha256()
 with path.open('rb') as stream:
  while data:=stream.read(1024**2):h.update(data)
 require(h.hexdigest()==digest,'Incoming hash changed.');return path
CURRENT_FACTS = BINDING['CURRENT_FACTS']
CAPACITY = BINDING['CAPACITY']
STAGE_PLAN = BINDING.get('STAGE_PLAN')
STAGE_INTENT = BINDING.get('STAGE_INTENT')
STAGE_PLAN_RAW_BASE64 = BINDING.get('STAGE_PLAN_RAW_BASE64')
"""Embedded into the exact protected prestager; no standalone execution."""

def allocation_contract(app, dependencies, specs, fragment, runtime=None):
 require(type(fragment) is int and 512 <= fragment <= 65536 and fragment & (fragment-1) == 0,'Bounded observed allocation fragment required.')
 require(set(specs)=={'bundle.json','app-dependencies.tgz'}|({'runtime.tgz'} if runtime else set()),'Exact reviewed artifact roles required.')
 for value in (app['archiveBytes'],app['expandedBytes'],app['fileCount'],dependencies['expandedBytes'],dependencies['fileCount']):
  require(type(value) is int and 0 < value <= 2*1024**3,'Bounded qualified candidate dimensions required.')
 unit=max(fragment,4096);rounded=lambda value:((value+fragment-1)//fragment)*fragment
 artifacts={name:rounded(size) for name,(size,_digest) in specs.items()}
 # Maintained install.py stage_app and app_dependencies.storage_required:
 # complete candidate and dependency expansion remain reserved, with no reuse.
 # Three candidate trees conservatively cover preparation and rollback code.
 candidate=rounded(app['archiveBytes'])+3*(app['expandedBytes']+app['fileCount']*unit)
 dependency=dependencies['expandedBytes']+dependencies['fileCount']*unit
 runtime_expansion=0
 if runtime:
  require(runtime['fromVersion']=='2026.9.6' and runtime['toVersion']=='2026.9.8' and specs['runtime.tgz']==(runtime['archiveBytes'],runtime['archiveSha256'])
   and type(runtime['archiveBytes']) is int and 0<runtime['archiveBytes']<=512*1024**2
   and type(runtime['expandedBytes']) is int and 0<runtime['expandedBytes']<=2*1024**3
   and type(runtime['fileCount']) is int and 0<runtime['fileCount']<=100000,'Bounded runtime expansion required.')
  runtime_expansion=runtime['expandedBytes']+runtime['fileCount']*unit
 records=2*1024**2+8*fragment
 reserve=1610612736;allowance=2*128*1024**2
 return {'phase':'prestop-artifact-and-candidate-staging','artifactAllocationBounds':artifacts,'archiveRoles':len(specs),
  'candidateCodeAllocationBytes':candidate,'dependencyExpansionBytes':dependency,'recordAndDirectoryAllowanceBytes':records,
  'reserveBytes':reserve,'allowanceBytes':allowance,'operatingFloorBytes':reserve+allowance,
  'requiredBeforeCopiesBytes':2*sum(artifacts.values())+candidate+dependency+runtime_expansion+records+reserve+allowance,
  **({'runtimeExpansionBytes':runtime_expansion} if runtime else {}),
  'allocationFragmentBytes':fragment,'futureReclaimCreditBytes':0,'dependencyReuseCreditBytes':0,
  'closedRecoveryCapacityAdmitted':False,'maintainedInstallerCapacityStillRequired':True}

def paid_allocation_credit(size,allocated,reserved):
 require(type(size) is int and size>0 and type(allocated) is int and allocated>=0 and type(reserved) is int and reserved>=size,'Exact paid allocation values required.')
 # Filesystem extent metadata may exceed rounded logical size. Free space
 # already charges that overhead; never credit more than the reserved role.
 return min(allocated,reserved)

def transfer_parent_identity():
 parent=INCOMING.parent;require(parent==P('/var/tmp') and parent.resolve(strict=True)==parent,'Exact canonical transfer parent required.')
 protect(parent.parent,True);info=parent.lstat()
 require(stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode) and info.st_uid==info.st_gid==0 and stat.S_IMODE(info.st_mode)==0o1777,'Protected sticky transfer parent required.')
 return {'path':str(parent),'device':info.st_dev,'inode':info.st_ino,'mode':stat.S_IMODE(info.st_mode),'uid':info.st_uid,'gid':info.st_gid}

def completed_rehearsal_identity():
 import subprocess
 lineage=CAPACITY['rehearsal'];root=P('/var/lib/nova-operator-rehearsals')/('rehearsal-'+LEASE)
 protect(root,True)
 evidence=raw(STATE/'operator-maintenance'/LEASE/'rehearsal.json',2*1024**2)
 require(hashlib.sha256(evidence).hexdigest()==lineage['completedEvidenceSha256'],'Completed rehearsal evidence changed.')
 detail=json.loads(evidence);require(detail['snapshotManifestSha256']==lineage['snapshotManifestSha256'] and detail['sourceRootIdentity']==detail['returnedRootIdentity'] and detail['outcome']=='rehearsed','Complete original return required.')
 for name in ('trial-workspace','restored-workspace','original-workspace'):require(not os.path.lexists(root/name),'Completed rehearsal still owns a workspace role.')
 phases=sorted(root.glob('phase-*.json'));require(0<len(phases)<=100,'Bounded completed rehearsal phases required.')
 last=raw(phases[-1],1024**2);value=json.loads(last)
 require(hashlib.sha256(last).hexdigest()==lineage['finalPhaseSha256'] and value['phase']=='complete' and value['leaseId']==LEASE,'Final rehearsal phase changed.')
 expected={'LoadState':'loaded','ActiveState':'active','SubState':'exited','Type':'oneshot','Restart':'no','MainPID':'0','ControlPID':'0','Result':'success','ExecMainStatus':'0'}
 output=subprocess.check_output(['/usr/bin/systemctl','show',lineage['unitName'],'--property='+','.join(expected)],text=True,timeout=15)
 require(dict(line.split('=',1) for line in output.splitlines() if '=' in line)==expected,'Completed rehearsal worker not closed.')
 return lineage

def stage_capacity(paid_copies=0):
 require(type(paid_copies) is int and paid_copies in (0,1,2),'Exact paid archive role count required.')
 host=json.loads(raw(P('/etc/nova-update/config.json')));runner_raw=raw(P('/etc/nova-update/runner.json'))
 require(hashlib.sha256(runner_raw).hexdigest()==CAPACITY['runnerSha256'],'Exact runner configuration changed.')
 runner=json.loads(runner_raw);volume=os.statvfs(STATE);device=STATE.stat().st_dev
 transfer=transfer_parent_identity();require(transfer['device']==device,'Transfer filesystem differs from reviewed capacity volume.')
 for path in (P(host['releaseDirectory']),P(runner['dependencyDirectory']).parent,P(runner['recoveryDirectory'])):
  protect(path,True);require(path.stat().st_dev==device,'Artifact/candidate/dependency/recovery allocations require one reviewed filesystem.')
 for name,pin in CAPACITY['helperHashes'].items():
  path=P(CAPACITY['helperRoot'])/name;require(hashlib.sha256(raw(path,2*1024**2)).hexdigest()==pin,'Maintained capacity helper source changed.')
 if RUNTIME:
  runtime_root=P(host['runtimeDirectory']);protect(runtime_root,True);require(runtime_root.stat().st_dev==device,'Runtime expansion filesystem differs.')
 contract=allocation_contract(CAPACITY['application'],CAPACITY['dependencyDescription'],SPECS,volume.f_frsize,RUNTIME)
 paid=0;roles=[]
 for parent in (INCOMING,STATE/'staging'/BUNDLE)[:paid_copies]:
  for name,(size,digest) in SPECS.items():
   path=parent/name;before=path.lstat()
   require(stat.S_ISREG(before.st_mode) and not path.is_symlink() and before.st_nlink==1 and before.st_size==size,'Paid artifact identity changed.')
   identity=lambda s:(s.st_dev,s.st_ino,s.st_mode,s.st_uid,s.st_gid,s.st_nlink,s.st_size,s.st_blocks,s.st_mtime_ns,s.st_ctime_ns)
   h=hashlib.sha256();fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
   try:
    require(identity(os.fstat(fd))==identity(before),'Paid artifact replaced.')
    with os.fdopen(fd,'rb',closefd=False) as stream:
     while block:=stream.read(1024**2):h.update(block)
    require(h.hexdigest()==digest and identity(os.fstat(fd))==identity(before) and identity(path.lstat())==identity(before),'Paid artifact bytes changed.')
   finally:os.close(fd)
   credit=paid_allocation_credit(size,before.st_blocks*512,contract['artifactAllocationBounds'][name]);paid+=credit
   roles.append({'path':str(path),'actualAllocatedBytes':before.st_blocks*512,'reservedCreditBytes':credit,'sha256':digest})
 rehearsal=completed_rehearsal_identity()
 volume=os.statvfs(STATE);require(volume.f_frsize==contract['allocationFragmentBytes'],'Allocation geometry changed.')
 free=volume.f_bavail*volume.f_frsize;required=contract['requiredBeforeCopiesBytes']-paid
 require(free>=required,'Remaining current staging allocations and operating reserve do not fit.')
 return {**contract,'requiredFreeBytes':required,'actualPaidReservedRolesBytes':paid,'paidRoles':roles,'freeBytes':free,'completedRehearsal':rehearsal,'transferParentIdentity':transfer}

def transfer_timeout_identity():
 # Exact executable authority, distinct from private single-link evidence.
 # Ubuntu supplies this canonical multicall entry as a protected hardlink.
 path=P('/usr/lib/cargo/bin/coreutils/timeout');protect(path.parent,True)
 require(path.resolve(strict=True)==path,'Timeout executable redirected.')
 def identity(s):return (s.st_dev,s.st_ino,s.st_mode,s.st_uid,s.st_gid,s.st_nlink,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
 before=path.lstat()
 require(stat.S_ISREG(before.st_mode) and before.st_uid==0 and before.st_gid==0 and stat.S_IMODE(before.st_mode)==0o755 and before.st_nlink==115 and before.st_size==11352352,'Exact timeout executable authority changed.')
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
 try:
  require(identity(os.fstat(fd))==identity(before),'Timeout executable replaced.')
  with os.fdopen(fd,'rb',closefd=False) as stream:data=stream.read(11352353)
  require(len(data)==11352352 and hashlib.sha256(data).hexdigest()=='48893b0fb21436b54619db80486e83ef39dfccaf1aefe83dfa00c02d6146e8c0' and identity(os.fstat(fd))==identity(before) and identity(path.lstat())==identity(before),'Timeout executable bytes changed.')
 finally:os.close(fd)
 return {'path':str(path),'sha256':hashlib.sha256(data).hexdigest(),'identity':list(identity(before))}

def read_only_plan():
 timeout_identity=transfer_timeout_identity()
 destination=preflight();require(not os.path.lexists(INCOMING) and not os.path.lexists(destination),'Existing original staging requires observation, never replay.')
 for path in (INTENT,PREPARED,COPY_INTENT,VERIFIED):require(not os.path.lexists(path),'Original one-use receipt already exists.')
 parent=destination.parent.lstat();state=STATE.lstat()
 return {'format':1,'kind':'exact-full-private-prestage-plan','readOnly':True,'bundleSha256':BUNDLE,'candidateId':TARGET,'priorCandidateId':PRIOR,'rehearsalLeaseId':LEASE,'rehearsalProofSha256':PROOF,'incoming':str(INCOMING),'destination':str(destination),'files':{k:{'bytes':v[0],'sha256':v[1]} for k,v in SPECS.items()},'currentJob':CURRENT_FACTS['currentJob'],'currentResult':CURRENT_FACTS['result'],'destinationParentIdentity':[parent.st_dev,parent.st_ino,parent.st_mode,parent.st_uid,parent.st_gid],'stateIdentity':[state.st_dev,state.st_ino,state.st_mode,state.st_uid,state.st_gid],'transferTimeout':timeout_identity,'capacity':stage_capacity(0),'automaticReplayPermitted':False}

def verify_dispatch_plan():
 require(isinstance(STAGE_PLAN,dict) and isinstance(STAGE_INTENT,dict),'Actual readonly plan and separate intent required.')
 current=read_only_plan();expected=dict(STAGE_PLAN);a=current.pop('capacity');b=expected.pop('capacity');require(current==expected,'Exact readonly plan identity changed.')
 require({k:v for k,v in a.items() if k!='freeBytes'}=={k:v for k,v in b.items() if k!='freeBytes'},'Capacity contract changed.')
 import base64
 actual=base64.b64decode(STAGE_PLAN_RAW_BASE64,validate=True);require(len(actual)<=131072 and json.loads(actual)==STAGE_PLAN,'Original raw plan bytes differ.')
 require(STAGE_INTENT=={'format':1,'kind':'execute-exact-full-private-prestage','planSha256':hashlib.sha256(actual).hexdigest(),'bundleSha256':BUNDLE,'nonce':NONCE,'automaticReplayPermitted':False},'Separate exact execution intent differs.')

def observe_original():
 import base64
 frozen_gate();require(os.geteuid()==0,'Root observation required.')
 records={}
 for path in (INTENT,PREPARED,COPY_INTENT,VERIFIED):
  if os.path.lexists(path):
   b=raw(path,131072);records[path.name]={'path':str(path),'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest(),'rawBase64':base64.b64encode(b).decode()}
 result={'format':1,'readOnly':True,'hostWrites':False,'incoming':str(INCOMING),'stagingIdentity':BUNDLE,'records':records,'stageVerified':False,'automaticReplayPermitted':False}
 if not all(os.path.lexists(path) for path in (INTENT,PREPARED,COPY_INTENT)):
  print(json.dumps(result));return
 intent=json.loads(raw(INTENT));prepared_raw=raw(PREPARED);prepared=json.loads(prepared_raw);copy=json.loads(raw(COPY_INTENT));destination=STATE/'staging'/BUNDLE
 uid=int(os.environ['SUDO_UID'])
 pins={'format':1,'bundleSha256':BUNDLE,'dependenciesSha256':SPECS['app-dependencies.tgz'][1],**runtime_pins(),'jobId':JOB,'completedResultSha256':CURRENT_FACTS['result']['sha256'],'proofSha256':PROOF,'incoming':str(INCOMING),'transferUid':uid,'automaticRetry':False}
 require(intent==pins and prepared['format']==1 and prepared['pins']==pins and prepared['destination']==str(destination),'Original prepared receipt identity differs.')
 require(copy=={**pins,'preparedReceiptSha256':hashlib.sha256(prepared_raw).hexdigest(),'destinationIdentity':prepared['destinationIdentity']},'Original copy intent differs.')
 for path,expected,owner in ((destination,prepared['destinationIdentity'],0),(INCOMING,prepared['incomingIdentity'],uid)):
  info=path.lstat();require(path.resolve(strict=True)==path and stat.S_ISDIR(info.st_mode) and not path.is_symlink() and info.st_uid==owner and info.st_gid==expected['gid'] and stat.S_IMODE(info.st_mode)==0o700 and info.st_dev==expected['device'] and info.st_ino==expected['inode'],'Original staging directory changed.')
  require({p.name for p in path.iterdir()}<=set(SPECS),'Unexpected original artifact entry.')
  if {p.name for p in path.iterdir()}!=set(SPECS):
   print(json.dumps(result));return
 require(preflight()==destination,'Current authority changed.')
 for name,spec in SPECS.items():input_verified(name,*spec,uid)
 for name,(size,_digest) in SPECS.items():
  protect(destination/name);info=(destination/name).lstat();require(info.st_uid==info.st_gid==0 and stat.S_IMODE(info.st_mode)==0o600 and info.st_size==size,'Protected artifact authority changed.')
  h=hashlib.sha256()
  with (destination/name).open('rb') as stream:
   while block:=stream.read(1024**2):h.update(block)
  require(h.hexdigest()==_digest,'Observed destination artifact bytes changed.')
 capacity=stage_capacity(2)
 reconciled={'format':1,**pins,'stagingIdentity':BUNDLE,'bundleBytes':SPECS['bundle.json'][0],'dependenciesBytes':SPECS['app-dependencies.tgz'][0],'priorCompletedJobId':JOB,'verified':True,'destination':str(destination),'files':{k:{'bytes':v[0],'sha256':v[1]} for k,v in SPECS.items()},'applicationActivated':False,'installDispatched':False,'preparedReceiptSha256':hashlib.sha256(prepared_raw).hexdigest(),'destinationIdentityBeforeCopy':prepared['destinationIdentity'],'capacity':capacity}
 if os.path.lexists(VERIFIED):
  actual=json.loads(raw(VERIFIED,131072));require(all(actual.get(k)==v for k,v in reconciled.items() if k!='capacity'),'Original verified receipt differs.')
 else:
  reconciled.update(readOnlyReconciliation=True,originalInvocationPassed=False,originalVerifiedReceiptWritten=False,hostWrites=False)
 result.update(stageVerified=True,reconciliation=reconciled);print(json.dumps(result))

def observe_transfers():
 frozen_gate();require(os.geteuid()==0,'Root observation required.');destination=preflight()
 if not all(os.path.lexists(p) for p in (INTENT,PREPARED)):
  print(json.dumps({'format':1,'readOnly':True,'hostWrites':False,'inputPrepared':False,'automaticReplayPermitted':False}));return
 b=raw(PREPARED,131072);prepared=json.loads(b);uid=int(os.environ['SUDO_UID'])
 pins={'format':1,'bundleSha256':BUNDLE,'dependenciesSha256':SPECS['app-dependencies.tgz'][1],**runtime_pins(),'jobId':JOB,'completedResultSha256':CURRENT_FACTS['result']['sha256'],'proofSha256':PROOF,'incoming':str(INCOMING),'transferUid':uid,'automaticRetry':False}
 require(json.loads(raw(INTENT))==pins and prepared['pins']==pins and prepared['destination']==str(destination),'Original transfer preparation changed.')
 for path,expected,owner in ((destination,prepared['destinationIdentity'],0),(INCOMING,prepared['incomingIdentity'],uid)):
  info=path.lstat();require(path.resolve(strict=True)==path and stat.S_ISDIR(info.st_mode) and not path.is_symlink() and info.st_uid==owner and info.st_gid==expected['gid'] and stat.S_IMODE(info.st_mode)==0o700 and info.st_dev==expected['device'] and info.st_ino==expected['inode'],'Original transfer directory changed.')
 require({p.name for p in INCOMING.iterdir()}<=set(SPECS),'Unknown incoming transfer file.')
 transfers={}
 for name,(size,digest) in SPECS.items():
  if os.path.lexists(INCOMING/name):input_verified(name,size,digest,uid);transfers[name]={'bytes':size,'sha256':digest,'complete':True}
 print(json.dumps({'format':1,'readOnly':True,'hostWrites':False,'inputPrepared':True,**pins,**{k:prepared[k] for k in ('destination','destinationIdentity','incomingIdentity')},'preparedReceiptSha256':hashlib.sha256(b).hexdigest(),'transfers':transfers,'automaticReplayPermitted':False}))

def main():
 import signal
 def finite_phase_timeout(_signum,_frame):raise TimeoutError('Original private staging phase exceeded 300 seconds; reconcile original intent and paths, never replay.')
 signal.signal(signal.SIGALRM,finite_phase_timeout);signal.alarm(300)
 parser=argparse.ArgumentParser();parser.add_argument('mode',choices=['plan','prepare-input','stage','observe','transfer-observe']);args=parser.parse_args()
 if args.mode=='transfer-observe':observe_transfers();return
 if args.mode=='observe':observe_original();return
 frozen_gate();require(os.geteuid()==0,'Root required.');os.umask(0o077);destination=preflight();uid=int(os.environ['SUDO_UID']);gid=int(os.environ['SUDO_GID']);require(uid>0,'Fixed SSH nonroot transfer user required.')
 pins={'format':1,'bundleSha256':BUNDLE,'dependenciesSha256':SPECS['app-dependencies.tgz'][1],**runtime_pins(),'jobId':JOB,'completedResultSha256':CURRENT_FACTS['result']['sha256'],'proofSha256':PROOF,'incoming':str(INCOMING),'transferUid':uid,'automaticRetry':False}
 if args.mode=='plan':print(json.dumps(read_only_plan()));return
 if args.mode=='prepare-input':
  verify_dispatch_plan()
  require(not os.path.lexists(INCOMING) and not os.path.lexists(destination),'Existing incoming or destination evidence must be reconciled.')
  require(not any(os.path.lexists(p) for p in (INTENT,PREPARED,COPY_INTENT,VERIFIED)),'Existing one-use evidence must be reconciled.')
  save(INTENT,json.dumps(pins,sort_keys=True).encode());destination.mkdir(mode=0o700);sync(destination.parent);protect(destination,True)
  require(stat.S_IMODE(destination.stat().st_mode)==0o700 and list(destination.iterdir())==[],'New destination is not root0700 empty.')
  INCOMING.mkdir(mode=0o700);os.chown(INCOMING,uid,gid);sync(INCOMING.parent)
  prepared={'format':1,'pins':pins,'destination':str(destination),'destinationIdentity':directory_identity(destination),'incomingIdentity':directory_identity(INCOMING)}
  save(PREPARED,json.dumps(prepared,sort_keys=True).encode())
  print(json.dumps({'inputPrepared':True,**pins,**{k:prepared[k] for k in ('destination','destinationIdentity','incomingIdentity')},'preparedReceiptSha256':hashlib.sha256(raw(PREPARED)).hexdigest()}));return
 require(json.loads(raw(INTENT))==pins,'Staging intent changed.')
 prepared=json.loads(raw(PREPARED));protect(destination,True)
 require(prepared['format']==1 and prepared['pins']==pins and prepared['destination']==str(destination) and directory_identity(destination)==prepared['destinationIdentity'] and stat.S_IMODE(destination.stat().st_mode)==0o700 and list(destination.iterdir())==[],'Prepared destination identity or emptiness changed.')
 require(not os.path.lexists(COPY_INTENT) and not os.path.lexists(VERIFIED),'One-use stage cannot be replayed.')
 info=INCOMING.lstat();require(info.st_dev==prepared['incomingIdentity']['device'] and info.st_ino==prepared['incomingIdentity']['inode'] and info.st_gid==prepared['incomingIdentity']['gid'] and stat.S_ISDIR(info.st_mode) and not INCOMING.is_symlink() and INCOMING.resolve(strict=True)==INCOMING and info.st_uid==uid and stat.S_IMODE(info.st_mode)==0o700,'Incoming directory changed.')
 require({p.name for p in INCOMING.iterdir()}==set(SPECS),'Unexpected incoming file set.')
 paths={name:input_verified(name,*spec,uid) for name,spec in SPECS.items()}
 stage_capacity(1)
 save(COPY_INTENT,json.dumps({**pins,'preparedReceiptSha256':hashlib.sha256(raw(PREPARED)).hexdigest(),'destinationIdentity':prepared['destinationIdentity']},sort_keys=True).encode())
 for name,(size,digest) in SPECS.items():
  fd=os.open(destination/name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600);h=hashlib.sha256();total=0
  with os.fdopen(fd,'wb') as output,paths[name].open('rb') as source:
   while data:=source.read(1024**2):total+=len(data);require(total<=size,'Input grew.');h.update(data);output.write(data)
   output.flush();os.fsync(output.fileno())
  require(total==size and h.hexdigest()==digest,'Copied bytes changed.');sync(destination)
  h=hashlib.sha256()
  with (destination/name).open('rb') as stream:
   while data:=stream.read(1024**2):h.update(data)
  require(h.hexdigest()==digest,'Independent staged hash changed.')
 result={'format':1,**pins,'stagingIdentity':BUNDLE,'bundleBytes':SPECS['bundle.json'][0],'dependenciesBytes':SPECS['app-dependencies.tgz'][0],'priorCompletedJobId':JOB,'verified':True,'destination':str(destination),'files':{k:{'bytes':v[0],'sha256':v[1]} for k,v in SPECS.items()},'applicationActivated':False,'installDispatched':False,'preparedReceiptSha256':hashlib.sha256(raw(PREPARED)).hexdigest(),'destinationIdentityBeforeCopy':prepared['destinationIdentity']}
 result['capacity']=stage_capacity(2)
 save(VERIFIED,json.dumps(result,sort_keys=True).encode());print(json.dumps(result))
if __name__=='__main__':
 import sys
 sys.argv=[sys.argv[0],BINDING['MODE']];main()
