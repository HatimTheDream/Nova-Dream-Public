import base64, hashlib, http.client, io, json, os, pathlib, socket, stat, subprocess, tarfile, time, urllib.request

def need(value, message):
    if not value:
        raise RuntimeError(message)

def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def protected(path, directory=False, private=False):
    need(path.is_absolute() and path.resolve(strict=True) == path, 'Protected staging path was redirected.')
    for current in (path, *path.parents):
        info = current.lstat()
        need(not stat.S_ISLNK(info.st_mode) and info.st_uid == 0 and (not stat.S_IMODE(info.st_mode) & 18), 'Staging authority is not root protected.')
    info = path.lstat()
    need(stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode), 'Unexpected protected staging type.')
    need(not private or not stat.S_IMODE(info.st_mode) & 63, 'Private staging authority is not private.')

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
P=pathlib.Path

def immutable():
 need(os.geteuid()==0 and os.name=='posix','Use the provisioned root Linux host.')
 stage=P(V['stage']);protected(stage,True,True)
 for name,digest in V['files'].items():
  protected(stage/name,private=True);need(sha(stage/name)==digest,'Exact frozen helper/review changed.')
 result=stage/'stage-result.json';protected(result,private=True)
 need(sha(result)==V['stageResultSha256'] and json.loads(result.read_bytes())==V['stageResult'],'Actual stage result changed.')
 return stage

def unit_state(unit):
 names='LoadState,ActiveState,SubState,Result,ExecMainStatus,MainPID,ControlPID,TimeoutStartUSec,Restart,UMask,Type,RemainAfterExit'
 raw=subprocess.check_output(['/usr/bin/systemctl','show',unit+'.service','--property='+names],text=True,timeout=10)
 return dict(line.split('=',1) for line in raw.splitlines() if '=' in line)

def terminal_success(state):
 return state.get('ActiveState')=='active' and state.get('SubState')=='exited' and state.get('Result')=='success' and state.get('ExecMainStatus')=='0' and state.get('MainPID')==state.get('ControlPID')=='0'

def main():
 os.umask(0o077);stage=immutable();guard=READINESS
 need(guard.get('format')==1 and guard.get('kind')=='operator-rehearsal-dispatch-readiness'
  and guard.get('leaseId')==V['leaseId'] and guard.get('sourceCommit')==V['sourceCommit']
  and guard.get('priorCandidateId')==V['candidateId'] and guard.get('workspaceEpoch')==V['workspaceEpoch'],
  'Explicit exact root readiness input is required; no placeholder or waiver.')
 need(guard['rootReview']['conclusion']=='ready-for-automatic-rehearsal'
  and -5000<=time.time_ns()//1000000-guard['rootReview']['reviewedAtMilliseconds']<=600000,'Root readiness review is not current.')
 current=P(V['stateDirectory'])/'operator-maintenance/current.json';protected(current,private=True)
 need(current.stat().st_size<=8192 and sha(current)==V['releasedLeaseSha256'],'Prior released lease changed before dispatch.')
 state=operator_status();need(state.get('held') is False and state.get('lease')==V['releasedLease']
  and json.loads(current.read_bytes())==V['releasedLease'],'Exact prior lease is not released and idle.')
 expected={'format':1,'kind':'operator-rehearsal-plan','candidateId':V['candidateId'],'workspaceEpoch':V['workspaceEpoch'],
  'leaseId':V['leaseId'],'threeHeldStarts':True,'closedCapacityRequired':True,'readOnly':True}
 refs=guard['planHostReceipts']
 for role,name in {'intent':'plan-intent-','launch':'plan-launch-','log':'plan-log-'}.items():
  path=stage/(name+V['planId']+('.txt' if role=='log' else '.json'));protected(path,private=True)
  need(path.stat().st_size<=2*1024*1024 and sha(path)==refs[role+'Sha256'],'Actual completed plan receipt changed.')
 need(refs['logSha256']==V['planLogSha256'] and terminal_success(unit_state(V['planUnit'])),'Full maintained plan is not successful.')
 need(json.loads((stage/('plan-log-'+V['planId']+'.txt')).read_bytes())==expected,'Actual full plan JSON changed.')
 plan_intent=json.loads((stage/('plan-intent-'+V['planId']+'.json')).read_bytes())
 plan_launch=json.loads((stage/('plan-launch-'+V['planId']+'.json')).read_bytes())
 need(plan_intent['planId']==plan_launch['planId']==V['planId'] and plan_intent['unit']==plan_launch['unit']==V['planUnit']
  and plan_intent['readOnlyPlan'] is True and plan_launch['exitCode']==0,'Completed plan intent/launch identity changed.')
 for path in (P('/var/lib/nova-operator-rehearsals')/('rehearsal-'+V['leaseId']),
  P('/var/lib/nova-update-recovery')/('operator-rehearsal-'+V['leaseId'])):
  protected(path.parent,True,True);need(not os.path.lexists(path),'Existing rehearsal requires reconciliation; never replay.')
 intent=stage/('execute-intent-'+V['executionId']+'.json');log=stage/('execute-log-'+V['executionId']+'.txt')
 need(not os.path.lexists(intent) and not os.path.lexists(log),'Existing dispatch intent requires reconciliation; never replay.')
 loaded=subprocess.run(['/usr/bin/systemctl','show',V['executionUnit']+'.service','--property=LoadState','--value'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,timeout=10).stdout.strip()
 need(loaded=='not-found','Existing execution unit requires reconciliation; never replay.')
 command=['/usr/bin/python3','-B',str(stage/'operator_rehearsal.py'),'--execute',str(stage/'operator-review.json')]
 properties=['Type=oneshot','TimeoutStartSec=3600','Restart=no','UMask=0077','RemainAfterExit=yes',
  'StandardOutput=append:'+str(log),'StandardError=append:'+str(log)]
 record={'format':1,'kind':'maintained-automatic-rehearsal-dispatch-intent','executionId':V['executionId'],
  'leaseId':V['leaseId'],'unit':V['executionUnit'],'command':command,'properties':properties,
  'reviewSha256':V['files']['operator-review.json'],'helperHashes':{k:v for k,v in V['files'].items() if k!='operator-review.json'},
  'stageResultSha256':V['stageResultSha256'],'rootReadinessSha256':READINESS_SHA256,'rootReadiness':guard,
  'createdAtMilliseconds':time.time_ns()//1000000,'automaticRetryPermitted':False,
  'actualThreeStartsReturnReleaseCleanupOwnedByMaintainedWorker':True}
 write(intent,json.dumps(record,sort_keys=True,separators=(',',':')).encode());write(log,b'')
 args=['/usr/bin/systemd-run','--unit='+V['executionUnit'],'--no-block']
 for item in properties:args+=['--property='+item]
 result=subprocess.run(args+command,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=20)
 receipt={'format':1,'executionId':V['executionId'],'unit':V['executionUnit'],'exitCode':result.returncode,
  'stdout':result.stdout.decode('utf8','replace'),'stderr':result.stderr.decode('utf8','replace'),
  'createdAtMilliseconds':time.time_ns()//1000000,'automaticRetryPermitted':False,'actualRehearsalCompletionStillRequired':True}
 write(stage/('execute-launch-'+V['executionId']+'.json'),json.dumps(receipt,sort_keys=True,separators=(',',':')).encode())
 need(result.returncode==0,'Dispatch failed; reconcile exact unit/intents and preserve data, never replay.')
 print(json.dumps({'format':1,'unit':V['executionUnit'],'executionId':V['executionId'],'leaseId':V['leaseId'],
  'launched':True,'actualRehearsalCompletionStillRequired':True}))
if __name__=='__main__':main()
