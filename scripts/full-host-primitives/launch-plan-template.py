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
 os.umask(0o077);stage=checked();intent=stage/('plan-intent-'+V['planId']+'.json');log=stage/('plan-log-'+V['planId']+'.txt')
 need(not os.path.lexists(intent) and not os.path.lexists(log),'Existing plan intent requires reconciliation; never replay.')
 existing=subprocess.run(['/usr/bin/systemctl','show',V['unit']+'.service','--property=LoadState','--value'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,timeout=10).stdout.strip()
 need(existing=='not-found','Existing plan unit requires reconciliation; never replay.')
 command=['/usr/bin/python3','-B',str(stage/'operator_rehearsal.py'),'--plan',str(stage/'operator-review.json')]
 properties=['Type=oneshot','TimeoutStartSec=3600','Restart=no','UMask=0077','RemainAfterExit=yes',
  'StandardOutput=append:'+str(log),'StandardError=append:'+str(log)]
 record={'format':1,'kind':'maintained-operator-plan-intent','planId':V['planId'],'leaseId':V['leaseId'],
  'unit':V['unit'],'command':command,'properties':properties,'reviewSha256':V['files']['operator-review.json'],
  'stageResultSha256':V['stageResultSha256'],'helperHashes':{k:v for k,v in V['files'].items() if k!='operator-review.json'},
  'createdAtMilliseconds':time.time_ns()//1000000,'readOnlyPlan':True,'enterPermitted':False,
  'serviceRestartPermitted':False,'automaticRetryPermitted':False}
 write(intent,json.dumps(record,sort_keys=True,separators=(',',':')).encode());write(log,b'')
 args=['/usr/bin/systemd-run','--unit='+V['unit'],'--no-block']
 for item in properties:args+=['--property='+item]
 result=subprocess.run(args+command,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=20)
 receipt={'format':1,'planId':V['planId'],'unit':V['unit'],'exitCode':result.returncode,
  'stdout':result.stdout.decode('utf8','replace'),'stderr':result.stderr.decode('utf8','replace'),
  'createdAtMilliseconds':time.time_ns()//1000000,'automaticRetryPermitted':False,'planCompletionStillRequired':True}
 write(stage/('plan-launch-'+V['planId']+'.json'),json.dumps(receipt,sort_keys=True,separators=(',',':')).encode())
 need(result.returncode==0,'Plan unit dispatch failed; review existing intent/unit, never replay.')
 print(json.dumps({'format':1,'unit':V['unit'],'planId':V['planId'],'leaseId':V['leaseId'],
  'launched':True,'planCompletionStillRequired':True,'appRestarted':False,'leaseAcquired':False}))
if __name__=='__main__':main()
