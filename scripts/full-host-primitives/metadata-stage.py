import re

from pathlib import Path as P
import ast,base64,hashlib,io,json,os,pathlib,re,signal,stat,sys,tarfile,time,types
signal.alarm(180);os.umask(0o077);sys.dont_write_bytecode=True
def need(v,r):
 if not v:raise RuntimeError(r)
def sha(b):return hashlib.sha256(b).hexdigest()
def enc(v):return (json.dumps(v,sort_keys=True,separators=(',',':'),allow_nan=False)+'\n').encode()
def stable(s):return tuple(getattr(s,k) for k in ('st_dev','st_ino','st_mode','st_uid','st_gid','st_nlink','st_size','st_mtime_ns','st_ctime_ns'))
def protected(p,directory=False):
 need(p.is_absolute() and p.resolve(strict=True)==p,'canonical-protected-path')
 for a in (p,*p.parents):
  s=a.lstat();need(s.st_uid==0 and not stat.S_ISLNK(s.st_mode) and not s.st_mode&0o022,'root-protected-ancestry')
 s=p.lstat();need(stat.S_ISDIR(s.st_mode) if directory else stat.S_ISREG(s.st_mode) and s.st_nlink==1,'ordinary-independent-path');return s
def raw(p,maximum=128*1024**2):
 p=P(p);s=protected(p);need(s.st_size<=maximum,'bounded-file');b=p.read_bytes();need(stable(s)==stable(p.lstat()) and len(b)==s.st_size,'stable-read');return b
def ref(r):
 b=raw(r['path']);need(sha(b)==r['sha256'] and ('bytes' not in r or len(b)==r['bytes']),'reference-changed');return b
def module(r,name):
 b=ref(r);m=types.ModuleType(name);m.__file__=r['path'];exec(compile(b,r['path'],'exec'),m.__dict__);return m
def put(p,b):
 protected(p.parent,True);fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'wb') as f:f.write(b);f.flush();os.fsync(f.fileno())
 fd=os.open(p.parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 try:os.fsync(fd)
 finally:os.close(fd)

import http.client,socket,subprocess
FROZEN_HELPERS={'app_dependencies.py': 'e7f2617ed8d05b7d83da62e857822b737ff3a1c47b6704af5d3e1783e043b290', 'codex_log_retention.py': 'bc6b09a2b99a9667c9c8fac63f2665362aa3e14b8db10d6be12652250ae2a1f4', 'install.py': 'd417d652163cb134583b1d766c650ad0a8597084bfa25ee876d7cf5155f013c4', 'operator_rehearsal.py': 'cec0f65413550a5872c2e97c0835434647a7aeadccd73e8c812ecda0fe251c3c', 'recovery.py': '03e06cd1e9881cb3814abd91fb91c4486a440e1625c097d12a412a0fb5f2aa71', 'verify-session-bindings.mjs': '1d51c2af378f27f21c9580a367779ab9192c159c600f02938d780a5de467c5c0', 'workspace_key.py': 'e97ae151ff8208c6831e93ef3281e1b1dbff99f4eea4679aa7f6a8ed06c412d2'}
HELPERS=FROZEN_HELPERS
NAMES=('app_dependencies.py', 'codex_log_retention.py', 'install.py', 'operator_rehearsal.py', 'recovery.py', 'verify-session-bindings.mjs', 'workspace_key.py', 'operator-review.json')
def sync(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)

def write(path, data):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 384)
    with os.fdopen(descriptor, 'wb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    sync(path.parent)

class OperatorSocket(http.client.HTTPConnection):

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect('/run/nova-update/operator.sock')

def operator_status():
    path = P('/run/nova-update/operator.sock')
    protected(path.parent, True)
    info = path.lstat()
    need(stat.S_ISSOCK(info.st_mode) and info.st_uid == info.st_gid == 0 and (stat.S_IMODE(info.st_mode) == 384), 'Operator socket is not root-only.')
    client = OperatorSocket('localhost', timeout=5)
    try:
        client.request('POST', '/v1/status', body=b'{}', headers={'Content-Type': 'application/json'})
        response = client.getresponse()
        raw = response.read(8193)
        need(response.status == 200 and len(raw) <= 8192, 'Read-only operator status failed.')
        result = json.loads(raw)
        need(isinstance(result, dict) and result.get('format') == 1, 'Invalid read-only operator status.')
        return result
    finally:
        client.close()

def metadata_capacity(payload, fragment, free):
    need(set(payload) == set(NAMES) and all((isinstance(b, bytes) and 0 < len(b) <= 2 * 1024 ** 2 for b in payload.values())) and (sum(map(len, payload.values())) <= 4 * 1024 ** 2), 'bounded-exact-eight-file-capacity')
    need(type(fragment) is int and 512 <= fragment <= 65536 and (fragment & fragment - 1 == 0) and (type(free) is int) and (free >= 0), 'actual-capacity-observation')
    need(sha(payload['recovery.py']) == HELPERS['recovery.py'], 'unchanged-maintained-recovery-reserve')
    tree = ast.parse(payload['recovery.py'])
    assignments = [n for n in tree.body if isinstance(n, ast.Assign) and len(n.targets) == 1 and isinstance(n.targets[0], ast.Name) and (n.targets[0].id in ('RESERVE', 'ALLOWANCE'))]
    need(len(assignments) == 2, 'exact-maintained-reserve-constants')
    scope = {'__builtins__': {}}
    exec(compile(ast.Module(body=assignments, type_ignores=[]), 'pinned-maintained-reserve', 'exec'), scope)
    reserve = scope['RESERVE']
    allowance = scope['ALLOWANCE']
    need(reserve == 1610612736 and allowance == 128 * 1024 ** 2, 'unchanged-maintained-operating-floor')
    allocated = lambda size: (size + fragment - 1) // fragment * fragment
    increment = sum((allocated(len(b)) for b in payload.values())) + allocated(2 * 1024 ** 2) + 4 * fragment
    floor = reserve + 2 * allowance
    need(free >= floor + increment, 'metadata-stage-plus-maintained-operating-reserve')
    return {'format': 1, 'kind': 'eight-file-metadata-stage-capacity', 'scope': 'metadata-stage-only', 'reserveBytes': reserve, 'allowanceBytes': 2 * allowance, 'operatingFloorBytes': floor, 'allocationFragmentBytes': fragment, 'incrementalAllocatedBytesMaximum': increment, 'recordEnvelopeBytes': 2 * 1024 ** 2, 'directoryAllocationAllowanceBytes': 4 * fragment, 'requiredFreeBytes': floor + increment, 'futureReclaimCreditBytes': 0, 'fullRehearsalCapacityAdmitted': False, 'fullMaintainedPlanStillRequired': True}

v=REQUEST;packet=v['packet'];root=P(packet['root']);stage_parent=P(packet['stageParent'])
need(packet['format']==2 and packet['capacityScope']=='metadata-stage-only','explicit-stage-only-packet')
need(sha(enc(packet))==v['packetSha256'] and packet['runnerSha256']==v['runnerSha256'],'frozen-rehearsal-stage-packet')
need(stage_parent.is_absolute() and stage_parent.is_relative_to(P('/opt/nova-release-tools')) and stage_parent!=P('/opt/nova-release-tools') and not any(x in ('.','..') for x in packet['stageParent'].split('/')),'configured-private-stage-parent')
need(root.parent==stage_parent and root.name=='rehearsal-'+packet['leaseId'],'exact-new-rehearsal-child');protected(root.parent,True)
names={'app_dependencies.py','codex_log_retention.py','install.py','operator_rehearsal.py','recovery.py','verify-session-bindings.mjs','workspace_key.py','operator-review.json'}
need(set(packet['files'])==set(v['files'])==names,'exact-eight-file-allowlist');payload={}
for n,r in packet['files'].items():
 b=base64.b64decode(v['files'][n],validate=True);need(0<len(b)<=2*1024**2 and len(b)==r['bytes'] and sha(b)==r['sha256'] and r['path']==str(root/n),'frozen-eight-file-bytes');payload[n]=b
need(sum(map(len,payload.values()))<=4*1024**2,'bounded-eight-file-payload')
facts=packet['facts'];review=json.loads(payload['operator-review.json']);need(review==facts['review'] and review['leaseId']==packet['leaseId'] and facts['sourceCommit']==packet['sourceCommit'] and re.fullmatch('[a-f0-9]{40}',packet['sourceCommit']),'actual-current-review-lineage')
need(review['helperHashes']==FROZEN_HELPERS=={n:sha(b) for n,b in payload.items() if n!='operator-review.json'},'all-current-helper-bytes')
def result_identity(result):
 need(result['format']==1 and result['staged']==str(root) and result['leaseId']==packet['leaseId'] and result['sourceCommit']==packet['sourceCommit'] and result['reviewSha256']==sha(payload['operator-review.json']) and result['helperHashes']==review['helperHashes'],'original-eight-file-result')
 need(result.get('capacityScope')=='metadata-stage-only' and result.get('fullRehearsalCapacityAdmitted') is False and result.get('fullMaintainedPlanStillRequired') is True,'metadata-is-not-rehearsal-admission')
 need(result['metadataOnly'] is True and result['leaseAcquired'] is False and result['appRestarted'] is False and result['packetSha256']==v['packetSha256'] and result['runnerSha256']==v['runnerSha256'],'original-stage-no-maintenance')
if v['mode']=='observe':
 protected(root,True);records={};verified=False
 for n in ('stage-plan.json','stage-intent.json','stage-result.json','stage-failure.json'):
  if os.path.lexists(root/n):
   b=raw(root/n);records[n]={'path':str(root/n),'sha256':sha(b),'bytes':len(b),'rawBase64':base64.b64encode(b).decode()}
 if 'stage-result.json' in records:
  result_identity(json.loads(base64.b64decode(records['stage-result.json']['rawBase64'])))
  for n,b in payload.items():need(raw(root/n)==b,'original-eight-files-changed')
  verified='stage-failure.json' not in records
 print(json.dumps({'readOnly':True,'stageVerified':verified,'records':records,'automaticReplayPermitted':False}));sys.exit(0)
need(facts['kind']=='current-rehearsal-facts' and facts['readOnly'] is True and facts['noHostWrites'] is True and 0<=time.time_ns()//1000000-facts['observedAtMilliseconds']<=900000,'original-facts-window-not-reset')
def current():
 for p,h in facts['protectedHashes'].items():need(sha(raw(p))==h,'current-protected-facts-changed')
 host=json.loads(raw(review['hostConfiguration']));runner=json.loads(raw(P(review['hostConfiguration']).with_name('runner.json')))
 need(host==facts['hostPaths'] and runner==facts['runnerPaths'],'current-config-routes-changed')
 selected=P(host['appCurrent']);protected(selected.parent,True);need(selected.is_symlink() and selected.lstat().st_uid==0 and str(selected.resolve(strict=True))==facts['appRoot'],'current-app-selection-changed')
 app=P(facts['appRoot']);need(sha(raw(app/'package.json')+raw(app/'dist/candidate.json'))==review['candidateId'],'current-prior-candidate-changed')
 status=operator_status();lease=status.get('lease');need(status.get('held') is False and lease==facts['operatorStatus']['lease'] and lease['phase'] in ('released','cancelled'),'current-operator-not-idle')
 need(sha(raw(P(facts['stateDirectory'])/'operator-maintenance/current.json'))==facts['operatorLeaseSha256'],'original-durable-lease-changed')
 state=dict(line.split('=',1) for line in subprocess.check_output(['/usr/bin/systemctl','show',runner['serviceName'],'-p','ActiveState,SubState,MainPID,ControlPID'],text=True,timeout=10).splitlines() if '=' in line)
 need(state.get('ActiveState')=='active' and state.get('SubState')=='running' and int(state.get('MainPID','0'))>0 and state.get('ControlPID')=='0','original-app-not-running')
 return {'lease':lease,'service':state,'appRoot':facts['appRoot']}
before=current()
for p in (root,P(review['labParent'])/('rehearsal-'+packet['leaseId']),P(facts['runnerPaths']['recoveryDirectory'])/('operator-rehearsal-'+packet['leaseId'])):
 protected(p.parent,True);need(not os.path.lexists(p),'existing-original-operation-observe-only')


# These immutable references document prior completed work; none admits this stage.
provenance={'maintainedMetadataStageSourceSha256':'929799ece19208ec4550ab88a287dc9e26b388b64f7965532f064bb79b11651d'}
sv=os.statvfs(root.parent);free=sv.f_bavail*sv.f_frsize;capacity=metadata_capacity(payload,sv.f_frsize,free);increment=capacity['incrementalAllocatedBytesMaximum']
parent=root.parent.lstat();identity={'root':str(root),'leaseId':packet['leaseId'],'sourceCommit':packet['sourceCommit'],'packetSha256':v['packetSha256'],'runnerSha256':v['runnerSha256'],'files':packet['files'],'parentIdentity':{'dev':parent.st_dev,'ino':parent.st_ino,'mode':parent.st_mode,'uid':parent.st_uid,'gid':parent.st_gid},'metadataIncrementMaximumBytes':increment,'historicalProvenance':provenance,'capacity':capacity,'currentAuthority':before}
plan={'format':2,'kind':'current-rehearsal-metadata-stage-plan','identity':identity,'capacityScope':'metadata-stage-only','freeBytes':free,'readOnly':True,'leaseAcquired':False,'appRestarted':False,'fullRehearsalCapacityAdmitted':False,'fullMaintainedPlanStillRequired':True}
if v['mode']=='plan':print(json.dumps(plan));sys.exit(0)
need(v['mode']=='stage','known-stage-mode');pr=base64.b64decode(v['planRawBase64'],validate=True);saved=json.loads(pr)
need(saved['format']==2 and saved['readOnly'] is True and saved['capacityScope']=='metadata-stage-only' and saved['fullRehearsalCapacityAdmitted'] is False and saved['identity']==identity and v['intent']=={'format':1,'kind':'execute-current-rehearsal-metadata-stage','leaseId':packet['leaseId'],'planSha256':sha(pr),'packetSha256':v['packetSha256'],'runnerSha256':v['runnerSha256'],'automaticReplayPermitted':False},'exact-separate-plan-and-intent')
need(len(pr)+len(enc(v['intent']))+2*131072<=capacity['recordEnvelopeBytes'],'bounded-plan-intent-result-failure-envelope')
root.mkdir(mode=0o700);sync(root.parent);write(root/'stage-plan.json',pr);write(root/'stage-intent.json',enc(v['intent']))
try:
 for n,b in payload.items():write(root/n,b)
 for n,b in payload.items():need(raw(root/n)==b,'staged-exact-helper-readback')
 need(current()==before,'current-authority-changed-during-metadata-stage')
 actual=sum(protected(p,p==root).st_blocks*512 for p in (root,*root.iterdir()))
 reservation=((131072+sv.f_frsize-1)//sv.f_frsize)*sv.f_frsize
 need(actual+reservation<=increment,'exact-stage-allocation-envelope')
 fresh=os.statvfs(root.parent);need(fresh.f_frsize==sv.f_frsize and fresh.f_bavail*fresh.f_frsize>=capacity['operatingFloorBytes']+reservation,'post-stage-maintained-reserve')
 result={'format':1,'staged':str(root),'leaseId':packet['leaseId'],'sourceCommit':packet['sourceCommit'],'reviewSha256':sha(payload['operator-review.json']),'helperHashes':review['helperHashes'],'metadataOnly':True,'leaseAcquired':False,'appRestarted':False,'sourceSqliteOpened':False,'fullMaintainedPlanStillRequired':True,'fullRehearsalCapacityAdmitted':False,'readyForExecution':False,'capacityScope':'metadata-stage-only','packetSha256':v['packetSha256'],'runnerSha256':v['runnerSha256'],'planSha256':sha(pr),'capacity':capacity,'actualStageAllocatedBytesBeforeResult':actual,'resultReservationBytes':reservation,'historicalProvenance':provenance}
 result_identity(result);output=enc(result);need(len(output)<=131072,'bounded-stage-result');write(root/'stage-result.json',output);sys.stdout.buffer.write(output)
except BaseException as error:
 failure=enc({'kind':'current-rehearsal-stage-failure','type':type(error).__name__,'message':str(error)[:16384],'automaticReplayPermitted':False});need(len(failure)<=131072,'bounded-stage-failure');write(root/'stage-failure.json',failure);raise
