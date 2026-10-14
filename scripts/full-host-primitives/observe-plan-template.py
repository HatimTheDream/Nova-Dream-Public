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

def checked():
 need(os.geteuid()==0 and os.name=='posix','Use the provisioned root Linux host.')
 stage=P(V['stage']);protected(stage,True,True)
 for name,digest in V['files'].items():
  protected(stage/name,private=True);need(sha(stage/name)==digest,'Exact helper/review changed.')
 receipt=stage/'stage-result.json';protected(receipt,private=True)
 need(sha(receipt)==V['stageResultSha256'],'Actual completed stage receipt changed.')
 need(json.loads(receipt.read_bytes())==V['stageResult'],'Actual stage result mismatch.')
 current=P(V['stateDirectory'])/'operator-maintenance/current.json';protected(current,private=True)
 need(current.stat().st_size<=8192 and sha(current)==V['releasedLeaseSha256'],'Released lease changed.')
 status=operator_status()
 need(status.get('held') is False and status.get('lease')==V['releasedLease']
  and json.loads(current.read_bytes())==V['releasedLease'] and V['releasedLease']['phase'] in ('released','cancelled'),
  'Exact prior lease is not released and idle.')
 return stage

def main():
 stage=checked();intent=stage/('plan-intent-'+V['planId']+'.json');protected(intent,private=True)
 need(intent.stat().st_size<=16384,'Plan intent exceeded its bound.')
 data=json.loads(intent.read_bytes())
 need(data['planId']==V['planId'] and data['unit']==V['unit'] and data['reviewSha256']==V['files']['operator-review.json']
  and data['stageResultSha256']==V['stageResultSha256'] and data['readOnlyPlan'] is True,'Plan intent changed.')
 names='LoadState,ActiveState,SubState,Result,ExecMainStatus,MainPID,ControlPID,TimeoutStartUSec,Restart,UMask,Type,RemainAfterExit'
 text=subprocess.check_output(['/usr/bin/systemctl','show',V['unit']+'.service','--property='+names],text=True,timeout=10)
 state=dict(line.split('=',1) for line in text.splitlines() if '=' in line)
 need(state.get('LoadState')=='loaded' and state.get('Type')=='oneshot' and state.get('Restart')=='no'
  and state.get('UMask')=='0077' and state.get('RemainAfterExit')=='yes','Plan unit contract changed or missing.')
 log=stage/('plan-log-'+V['planId']+'.txt');protected(log,private=True)
 need(log.stat().st_size<=2*1024*1024,'Plan log exceeded its bounded observation size.')
 result={'format':1,'planId':V['planId'],'unit':V['unit'],'leaseId':V['leaseId'],'unitState':state,
  'readOnlyObserver':True,'logSha256':sha(log),'logBytes':log.stat().st_size,'planPassed':False,
  'fullAutomaticRehearsalStillRequired':True,'observedAtMilliseconds':time.time_ns()//1000000}
 if state.get('ActiveState')=='active' and state.get('SubState')=='exited' and state.get('Result')=='success' and state.get('ExecMainStatus')=='0':
  parsed=json.loads(log.read_bytes())
  expected={'format':1,'kind':'operator-rehearsal-plan','candidateId':V['candidateId'],'workspaceEpoch':V['workspaceEpoch'],
   'leaseId':V['leaseId'],'threeHeldStarts':True,'closedCapacityRequired':True,'readOnly':True}
  need(parsed==expected,'Maintained full plan output failed exact identity/shape.')
  result.update(planPassed=True,maintainedPlan=parsed)
 receipt_hashes={}
 for role,prefix,suffix in [('intent','plan-intent-','.json'),('launch','plan-launch-','.json'),('log','plan-log-','.txt')]:
  path=stage/(prefix+V['planId']+suffix);protected(path,private=True)
  need(path.stat().st_nlink==1 and path.stat().st_size<=(2*1024*1024 if role=='log' else 16384),'Bounded independent plan receipt required.')
  receipt_hashes[role+'Sha256']=sha(path)
 result['planHostReceipts']=receipt_hashes
 print(json.dumps(result))
if __name__=='__main__':main()
