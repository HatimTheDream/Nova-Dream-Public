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
 stage=immutable();state=unit_state(V['executionUnit'])
 need(state.get('LoadState')=='loaded','Exact execution unit is not loaded; reconcile dispatch.')
 socket_status=operator_status();current=P(V['stateDirectory'])/'operator-maintenance/current.json';protected(current,private=True)
 need(current.stat().st_size<=8192,'Operator state exceeded its bound.')
 durable=json.loads(current.read_bytes());lease=socket_status.get('lease') or {}
 log=stage/('execute-log-'+V['executionId']+'.txt');protected(log,private=True)
 need(log.stat().st_size<=2*1024*1024,'Execution log exceeded observation bound.')
 result={'format':1,'executionId':V['executionId'],'unit':V['executionUnit'],'leaseId':V['leaseId'],
  'unitState':state,'operatorState':socket_status,'durableAndSocketAgree':durable==lease,
  'expectedNewLeaseObserved':lease.get('id')==V['leaseId'],'oldReleasedLeaseStillObserved':lease==V['releasedLease'],
  'logSha256':sha(log),'logBytes':log.stat().st_size,'readOnlyObserver':True,'automaticRehearsalPassed':False,
  'observedAtMilliseconds':time.time_ns()//1000000,'automaticRecoveryPermitted':False}
 output=P('/var/lib/nova-operator-rehearsals')/('rehearsal-'+V['leaseId'])
 if os.path.lexists(output):
  protected(output,True,True)
  phases=list(output.glob('phase-*.json'))
  if phases:
   query=subprocess.run(['/usr/bin/python3','-B',str(stage/'operator_rehearsal.py'),'--status',str(stage/'operator-review.json')],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=20)
   need(len(query.stdout)<=65536 and len(query.stderr)<=65536,'Maintained status exceeded observation bound.')
   result.update(maintainedStatusExitCode=query.returncode,maintainedStatusStderrSha256=hashlib.sha256(query.stderr).hexdigest())
   if query.returncode==0:result['maintainedStatus']=json.loads(query.stdout)
 if terminal_success(state) and durable==lease and lease.get('id')==V['leaseId'] and lease.get('phase')=='released' and (result.get('maintainedStatus') or {}).get('lastPhase')=='complete':
  observed=result['maintainedStatus']
  folder=current.parent/V['leaseId'];protected(folder,True,True)
  acceptance=folder/'acceptance.json';evidence=folder/'rehearsal.json'
  for path in (acceptance,evidence):protected(path,private=True);need(path.stat().st_size<=1024*1024,'Automatic proof exceeded bound.')
  proof=json.loads(acceptance.read_bytes());detail=json.loads(evidence.read_bytes())
  need(proof.get('format')==1 and proof.get('kind')=='operator-maintenance-acceptance'
   and proof.get('leaseId')==detail.get('leaseId')==V['leaseId'] and proof.get('outcome')==detail.get('outcome')=='rehearsed'
   and proof.get('candidateId')==detail.get('candidateId')==V['candidateId']
   and proof.get('workspaceEpoch')==detail.get('workspaceEpoch')==V['workspaceEpoch']
   and proof.get('evidenceSha256')==sha(evidence) and detail.get('kind')=='operator-rehearsal-evidence'
   and detail.get('reviewSha256')==V['files']['operator-review.json'] and detail.get('manualResumption') is not True
   and all(proof.get(k) is True for k in ('savedWorkVerified','recoveryVerified','accountsVerified','healthVerified')),
   'Actual automatic rehearsal proof is incomplete or mismatched.')
  result.update(automaticRehearsalPassed=True,acceptanceSha256=sha(acceptance),rehearsalEvidenceSha256=sha(evidence))
 print(json.dumps(result))
if __name__=='__main__':main()
