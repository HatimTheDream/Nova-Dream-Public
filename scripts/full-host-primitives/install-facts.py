"""Read-only protected current controller/job/result; no installation calls."""
import hashlib,http.client,json,os,pathlib,socket,stat,time
P=pathlib.Path
def need(v,r):
 if not v:raise RuntimeError(r)
def read(p,bound):
 p=P(p);need(p.is_absolute() and p.resolve(strict=True)==p,'redirected-path')
 for q in (p,*p.parents):
  s=q.lstat();need(not stat.S_ISLNK(s.st_mode) and s.st_uid==0 and not s.st_mode&0o022,'unprotected-path')
 s=p.stat();need(stat.S_ISREG(s.st_mode) and s.st_nlink==1 and s.st_size<=bound,'invalid-file')
 b=p.read_bytes();a=p.stat();need((s.st_dev,s.st_ino,s.st_mtime_ns,s.st_size)==(a.st_dev,a.st_ino,a.st_mtime_ns,a.st_size) and len(b)==s.st_size,'file-changed')
 return b
def record(p,b):return {'path':str(p),'sha256':hashlib.sha256(b).hexdigest(),'bytes':len(b)}
class Control(http.client.HTTPConnection):
 def connect(self):
  p=P('/run/nova-update/control.sock');s=p.lstat();need(stat.S_ISSOCK(s.st_mode) and s.st_uid==0 and not s.st_mode&0o007,'unprotected-socket')
  self.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);self.sock.settimeout(5);self.sock.connect(str(p))
need(os.geteuid()==0,'root-readonly-required')
cpath=P('/etc/nova-update/config.json');cb=read(cpath,65536);config=json.loads(cb);state=P(config['stateDirectory'])
jpath=state/'jobs/journal.json';jb=read(jpath,16*1024**2);journal=json.loads(jb);jobs=[j for j in journal['jobs'] if j['id']==journal['currentId']];need(len(jobs)==1,'ambiguous-current-job');job=jobs[0]
client=Control('localhost',timeout=5)
try:
 client.request('POST','/v1/status',b'{}',{'Content-Type':'application/json'});response=client.getresponse();b=response.read(65537);need(response.status==200 and len(b)<=65536,'controller-status-failed');controller=json.loads(b)
finally:client.close()
need(controller.get('holdFor') is None and controller.get('job',{}).get('id')==job['id'] and controller['job']['state']==job['state'] and job['hold'] is False,'controller-journal-disagree')
rpath=state/'staging'/job['releaseId']/'attempts'/job['id']/'result.json';rb=read(rpath,65536)
need(read(jpath,16*1024**2)==jb,'journal-changed-during-read')
print(json.dumps({'format':1,'kind':'current-install-prestage-facts','readOnly':True,'observedAtMilliseconds':time.time_ns()//1000000,'hostConfiguration':record(cpath,cb),'journal':record(jpath,jb),'currentJob':job,'controller':controller,'result':record(rpath,rb),'resultValue':json.loads(rb),'hostWrites':False}))
