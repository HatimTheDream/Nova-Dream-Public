"""Read-only protected current controller/job/result; no installation calls."""
import hashlib,http.client,json,os,pathlib,re,socket,stat,time,urllib.request,uuid
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
def controller_view():
 client=Control('localhost',timeout=5)
 try:
  client.request('POST','/v1/status',b'{}',{'Content-Type':'application/json'});response=client.getresponse();b=response.read(65537);need(response.status==200 and len(b)<=65536,'controller-status-failed');return json.loads(b)
 finally:client.close()

def controller_matches(view,job):
 need('holdFor' in view and view['holdFor'] is None and view.get('job',{}).get('id')==job['id'] and view['job']['state']==job['state'] and job['hold'] is False,'controller-journal-disagree')
 if job['state']=='failed':need(view['job'].get('candidateId')==job.get('candidateId') and view['job'].get('releaseId')==job.get('releaseId'),'controller-failed-identity-changed')

def reference(ref,maximum=65536):
 need(type(ref) is dict and set(ref)=={'path','sha256'} and type(ref['path']) is str and type(ref['sha256']) is str and re.fullmatch('[a-f0-9]{64}',ref['sha256']),'invalid-no-start-reference')
 raw=read(P(ref['path']),maximum);need(hashlib.sha256(raw).hexdigest()==ref['sha256'],'no-start-reference-changed');return raw

def members(path):
 need(path.resolve(strict=True)==path,'redirected-attempt')
 for part in (path,*path.parents):
  s=part.lstat();need(stat.S_ISDIR(s.st_mode) and s.st_uid==0 and not s.st_mode&0o022,'unprotected-attempt')
 return sorted(p.name for p in path.iterdir())

def validate_no_start(authority,job,operation,intent,preflight,config_sha):
 need(type(authority) is dict and set(authority)=={'operationId','idempotencyKey','jobId','candidateId','priorCandidateId','workspaceEpoch','bundleSha256'},'exact-no-start-authority-required')
 for name in ('operationId','idempotencyKey','jobId','workspaceEpoch'):need(type(authority[name]) is str and str(uuid.UUID(authority[name]))==authority[name],'no-start-uuid-invalid')
 for name in ('candidateId','priorCandidateId','bundleSha256'):need(type(authority[name]) is str and re.fullmatch('[a-f0-9]{64}',authority[name]),'no-start-hash-invalid')
 need(job.get('id')==authority['jobId'] and job.get('state')=='failed' and job.get('prepared') is True and job.get('started') is False and job.get('hold') is False,'exact-preflight-only-failure-required')
 for job_key,key in (('idempotencyKey','idempotencyKey'),('candidateId','candidateId'),('fromCandidateId','priorCandidateId'),('epoch','workspaceEpoch'),('releaseId','bundleSha256')):
  need(job.get(job_key)==authority[key] and operation.get(key)==authority[key],'no-start-original-identity-changed')
 need(operation.get('format')==1 and operation.get('operationId')==authority['operationId'] and job.get('when')=='now','no-start-original-operation-changed')
 request={'epoch':authority['workspaceEpoch'],'candidateId':authority['candidateId'],'releaseId':authority['bundleSha256'],'currentCandidateId':authority['priorCandidateId'],'idempotencyKey':authority['idempotencyKey'],'when':'now'}
 encoded=json.dumps(request,sort_keys=True,separators=(',',':')).encode()
 need(intent.get('format')==1 and intent.get('kind')=='nova-normal-install-intent' and intent.get('operationId')==authority['operationId'] and intent.get('controllerConfigSha256')==config_sha and intent.get('request')==request and intent.get('requestSha256')==hashlib.sha256(encoded).hexdigest() and intent.get('automaticResubmissionPermitted') is False,'no-start-original-intent-changed')
 need(type(preflight) is dict and set(preflight)=={'format','jobId','release','hostConfiguration','preflightIdentity'} and preflight['format']==1 and preflight['jobId']==authority['jobId'] and preflight['hostConfiguration']=='/etc/nova-update/config.json' and preflight['preflightIdentity']=={'candidateId':authority['priorCandidateId'],'workspaceEpoch':authority['workspaceEpoch']},'no-start-preflight-binding-changed')
 release=preflight['release'];need(release==job.get('release') and release.get('candidateId')==authority['candidateId'] and release.get('fromCandidateId')==authority['priorCandidateId'] and release.get('bundle',{}).get('sha256')==authority['bundleSha256'],'no-start-signed-release-changed')

def prior_identity(config,prior):
 class NoRedirect(urllib.request.HTTPRedirectHandler):
  def redirect_request(self,*args,**kwargs):raise RuntimeError('prior-identity-redirect')
 opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
 def get(name):
  request=urllib.request.Request('http://127.0.0.1:4383/api/'+name,headers={'Origin':'http://127.0.0.1:4383','X-Edition3-Client':'1'})
  with opener.open(request,timeout=5) as response:
   raw=response.read(65537);need(response.status==200 and len(raw)<=65536,'prior-identity-unavailable');return json.loads(raw)
 def selectors():
  result={}
  for name,root in (('appCurrent','releaseDirectory'),('agentDirectory','runtimeDirectory')):
   selector=P(config[name]);target=selector.resolve(strict=True);parent=P(config[root]).resolve(strict=True)
   need(selector.lstat().st_uid==0 and target.is_relative_to(parent) and target!=parent,'prior-selector-outside-root')
   need(selector.parent.resolve(strict=True)==selector.parent,'prior-selector-parent-redirected')
   for part in (selector.parent,*selector.parent.parents):
    s=part.lstat();need(stat.S_ISDIR(s.st_mode) and s.st_uid==0 and not s.st_mode&0o022,'prior-selector-parent-unprotected')
   for part in (target,*target.parents):
    s=part.lstat();need(stat.S_ISDIR(s.st_mode) and s.st_uid==0 and not s.st_mode&0o022,'prior-selector-authority-changed')
   result[name]={'path':str(selector),'target':str(target)}
  return result
 selected=selectors();need(selected['appCurrent']['target']==prior['appRoot'],'prior-app-selector-changed')
 package=json.loads(read(P(selected['agentDirectory']['target'])/'package.json',262144));need(package.get('name')=='openclaw' and package.get('version')==prior['agentVersion'],'prior-runtime-changed')
 health=get('health');context=get('access/context')
 expected={'status':'ready','candidateId':prior['candidateId'],'version':prior['version'],'buildVersion':prior['buildVersion'],'schemaVersion':prior['schemaVersion'],'apiVersion':1}
 need(all(health.get(k)==v for k,v in expected.items()) and context.get('workspaceEpoch')==prior['workspaceEpoch'] and get('health')==health and selectors()==selected,'prior-live-identity-changed')
 return {'health':{k:health[k] for k in expected},'workspaceEpoch':context['workspaceEpoch'],'selectors':selected}

def collect(spec=None):
 need(os.geteuid()==0,'root-readonly-required')
 cpath=P('/etc/nova-update/config.json');cb=read(cpath,65536);config=json.loads(cb);state=P(config['stateDirectory'])
 jpath=state/'jobs/journal.json';jb=read(jpath,16*1024**2);journal=json.loads(jb);jobs=[j for j in journal['jobs'] if j['id']==journal['currentId']];need(len(jobs)==1,'ambiguous-current-job');job=jobs[0]
 controller=controller_view();controller_matches(controller,job);extra={}
 if spec is None:
  rpath=state/'staging'/job['releaseId']/'attempts'/job['id']/'result.json';rb=read(rpath,65536)
 else:
  need(set(spec)=={'kind','hostConfiguration','acceptedInstallation','priorJobId','prior','failure'} and spec['kind']=='explicit-no-start-prior-facts' and state==P('/var/lib/nova-update'),'exact-no-start-facts-input-required')
  need(reference(spec['hostConfiguration'])==cb and spec['hostConfiguration']['path']==str(cpath),'no-start-host-config-changed')
  failure=spec['failure'];need(set(failure)=={'operation','intent','preflight','coordinatorExport','authority'},'exact-no-start-failure-input-required')
  authority=failure['authority'];op_raw=reference(failure['operation'],8192);op=json.loads(op_raw);intent_raw=reference(failure['intent'],16384);intent=json.loads(intent_raw);pf_raw=reference(failure['preflight'],16384);pf=json.loads(pf_raw)
  need(failure['operation']['path']==str(state/'release-coordinator/inputs'/(authority['operationId']+'.json')) and failure['intent']['path']==str(state/'release-coordinator'/authority['operationId']/'intent.json') and intent.get('operationSha256')==failure['operation']['sha256'],'no-start-authority-path-changed')
  validate_no_start(authority,job,op,intent,pf,hashlib.sha256(cb).hexdigest())
  attempt=state/'staging'/authority['bundleSha256']/'attempts'/authority['jobId'];pfpath=P(failure['preflight']['path'])
  need(pfpath.parent==attempt and re.fullmatch(r'preflight-[0-9a-f-]{36}\.json',pfpath.name) and str(uuid.UUID(pfpath.name[10:-5]))==pfpath.name[10:-5] and members(attempt)==[pfpath.name],'original-attempt-not-preflight-only')
  prior=spec['prior'];need(prior['candidateId']==authority['priorCandidateId'] and prior['workspaceEpoch']==authority['workspaceEpoch'] and prior['version']==op['priorVersion'] and prior['buildVersion']==op['priorBuildVersion'] and prior['agentVersion']==op['priorAgentVersion'] and prior['schemaVersion']==op.get('applicationQualification',{}).get('priorSchemaVersion',op['schemaVersion']),'no-start-prior-identity-changed')
  rpath=P(spec['acceptedInstallation']['path']);need(re.fullmatch(re.escape(str(state))+r'/staging/[a-f0-9]{64}/attempts/'+re.escape(spec['priorJobId'])+'/result.json',str(rpath)) and spec['priorJobId']!=job['id'],'separate-accepted-prior-required');rb=reference(spec['acceptedInstallation'])
  accepted=json.loads(rb);need(accepted.get('format')==1 and accepted.get('jobId')==spec['priorJobId'] and accepted.get('candidateId')==prior['candidateId'] and accepted.get('outcome')=='completed' and all(accepted.get(k) is True for k in ('savedWorkVerified','accountsVerified','recoveryVerified','healthVerified')),'accepted-prior-result-incomplete')
  identity=prior_identity(config,prior)
  need(reference(failure['operation'],8192)==op_raw and reference(failure['intent'],16384)==intent_raw and reference(failure['preflight'],16384)==pf_raw and members(attempt)==[pfpath.name],'no-start-evidence-changed')
  extra={'noStartFailure':{'input':spec,'priorIdentity':identity,'attemptMembers':[pfpath.name],'installerArtifactsAbsent':True}}
 need(read(jpath,16*1024**2)==jb and read(cpath,65536)==cb and read(rpath,65536)==rb,'inputs-changed-during-read')
 if spec is not None:controller_matches(controller_view(),job)
 return {'format':1,'kind':'current-install-prestage-facts','readOnly':True,'observedAtMilliseconds':time.time_ns()//1000000,'hostConfiguration':record(cpath,cb),'journal':record(jpath,jb),'currentJob':job,'controller':controller,'result':record(rpath,rb),'resultValue':json.loads(rb),'hostWrites':False,**extra}

if __name__=='__main__':print(json.dumps(collect(BINDING.get('FACTS_INPUT'))))
