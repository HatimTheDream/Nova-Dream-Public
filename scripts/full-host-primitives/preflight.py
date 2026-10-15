"""Read-only configured directory prerequisites, never release admission."""
import hashlib,json,os,pathlib,re,signal,stat
P=pathlib.Path
def need(v,r):
 if not v:raise RuntimeError(r)
def stable(s):return tuple(getattr(s,k) for k in ('st_dev','st_ino','st_mode','st_uid','st_gid','st_nlink','st_size','st_mtime_ns','st_ctime_ns'))
def protected(p,directory=False):
 need(p.is_absolute() and p.resolve(strict=True)==p,'canonical-protected-path')
 for a in (p,*p.parents):
  s=a.lstat();need(s.st_uid==0 and not stat.S_ISLNK(s.st_mode) and not s.st_mode&0o022,'root-protected-ancestry')
 s=p.lstat();need(stat.S_ISDIR(s.st_mode) if directory else stat.S_ISREG(s.st_mode) and s.st_nlink==1,'ordinary-independent-path');return s
def raw(p,maximum=65536):
 p=P(p);s=protected(p);need(s.st_size<=maximum,'bounded-file');b=p.read_bytes();need(stable(s)==stable(p.lstat()) and len(b)==s.st_size,'stable-read');return b
def collect(v):
 need(set(v)=={'format','stageParent','hostConfiguration'} and v['format']==1,'exact-host-preflight-input')
 path=v['stageParent'];need(isinstance(path,str) and len(path)<=4096 and re.fullmatch(r'/opt/nova-release-tools/(?:[A-Za-z0-9_.-]+/)*[A-Za-z0-9_.-]+',path) and not any(x in ('.','..') for x in path.split('/')),'configured-stage-parent')
 config=v['hostConfiguration'];need(set(config)=={'path','sha256'} and re.fullmatch('[a-f0-9]{64}',config['sha256']),'configured-host-reference')
 gaps=[];directories={}
 def directory(role,name):
  try:
   p=P(name);s=protected(p,True)
   directories[role]={'path':str(p),'dev':s.st_dev,'ino':s.st_ino,'mode':s.st_mode,'uid':s.st_uid,'gid':s.st_gid}
  except FileNotFoundError:gaps.append('full-host-'+role+'-missing')
  except (OSError,RuntimeError):gaps.append('full-host-'+role+'-unsafe')
 directory('stage-parent',path)
 try:
  config_path=P(config['path']);b=raw(config_path);need(hashlib.sha256(b).hexdigest()==config['sha256'],'configured-host-hash')
  json.loads(b);runner=json.loads(raw(config_path.with_name('runner.json')))
  recovery=runner['recoveryDirectory'];need(isinstance(recovery,str) and len(recovery)<=4096,'configured-recovery-parent')
 except (OSError,RuntimeError,KeyError,ValueError,TypeError):gaps.append('full-host-configuration-unavailable');recovery=None
 if recovery is not None:directory('recovery-parent',recovery)
 directory('lab-parent','/var/lib/nova-operator-rehearsals')
 return {'format':1,'kind':'full-host-directory-preflight','stageParent':path,'hostConfiguration':config,'readOnly':True,'noHostWrites':True,'passed':not gaps,'gaps':gaps,'directories':directories,'capacityAdmitted':False,'recoveryAdmitted':False}
