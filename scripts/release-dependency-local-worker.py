"""Fixed local transport for the unchanged maintained dependency successor.

No child process, installation, startup or native probe. Known producer refusals
are retained with the original reservation instead of hidden by process errors.
"""
import argparse, hashlib, json, os, pathlib, re, stat, sys, time, types, uuid
P=pathlib.Path
PRODUCER_SHA='962645b929a50754a6307d64d1ed35ac7bad51a8635737ebcc8d708b433e17c0'
def need(value,reason):
 if not value:raise RuntimeError(reason)
def identity(value):return (value.st_dev,value.st_ino,value.st_size,value.st_mode,value.st_nlink,value.st_mtime_ns,value.st_ctime_ns,getattr(value,'st_birthtime_ns',None))
def common_identity(value):return identity(value)[:6]+identity(value)[7:]
def load_producer():
 p=P(__file__).resolve().parent/'release-dependency-metadata-successor.py'
 s=p.lstat();need(stat.S_ISREG(s.st_mode) and not p.is_symlink() and s.st_nlink==1,'maintained-producer-type-changed')
 with p.open('rb') as stream:
  opened=os.fstat(stream.fileno());need(common_identity(s)==common_identity(opened),'maintained-producer-open-changed')
  raw=stream.read(2*1024**2+1);after=os.fstat(stream.fileno())
 need(identity(opened)==identity(after) and identity(s)==identity(p.lstat()),'maintained-producer-read-changed')
 need(hashlib.sha256(raw).hexdigest()==PRODUCER_SHA,'maintained-producer-bytes-changed')
 m=types.ModuleType('unchanged_dependency_successor');m.__file__=str(p);exec(compile(raw,str(p),'exec'),m.__dict__);return m
def execute(request_path,request_sha,*,engine=None,clock=lambda:time.time_ns()//1000000):
 m=engine or load_producer();request_path=P(request_path).absolute();reference={'path':str(request_path),'sha256':request_sha}
 request=json.loads(m.read(reference));expected={'format','kind','phase','operationId','parentKey','phaseKey','inputSha256','reservedAtMs','deadlineAtMs','producerSha256','input','outputDirectory'}
 need(set(request)==expected and request['format']==1 and request['kind']=='maintained-local-dependency-request','dependency-worker-request-fields')
 need(request['phase'] in ('plan','execute') and request['producerSha256']==PRODUCER_SHA,'dependency-worker-phase-or-producer')
 for name in ('operationId','parentKey','phaseKey'):need(str(uuid.UUID(request[name]))==request[name],'dependency-worker-identity')
 need(re.fullmatch('[a-f0-9]{64}',request['inputSha256']) is not None,'dependency-worker-input-hash')
 need(type(request['reservedAtMs']) is int and request['deadlineAtMs']==request['reservedAtMs']+615000,'dependency-worker-original-deadline')
 root=request_path.parent;need(request_path.name==request['phase']+'-request.json' and P(request['input']['path'])==root/'input.json','dependency-worker-input-scope')
 need(request['outputDirectory']==(str(root/'produced') if request['phase']=='execute' else None),'dependency-worker-output-scope')
 outcome_path=root/(request['phase']+'-outcome.json');need(not outcome_path.exists(),'original-dependency-outcome-present')
 outcome={'format':1,'kind':'maintained-local-dependency-outcome','request':reference,'operationId':request['operationId'],'parentKey':request['parentKey'],'phaseKey':request['phaseKey'],'inputSha256':request['inputSha256'],'reservedAtMs':request['reservedAtMs'],'deadlineAtMs':request['deadlineAtMs'],'producerSha256':PRODUCER_SHA,'phase':request['phase'],'hostEffects':False}
 try:
  need(request['reservedAtMs']<=clock()<request['deadlineAtMs']-15000,'original-dependency-deadline-expired')
  value=json.loads(m.read(request['input']))
  if request['phase']=='plan':
   m.validate(value);result={'passed':True,'readOnly':True,'hostEffects':False}
  else:
   m.produce(value,P(request['outputDirectory']));result=m.ref(root/'produced/result.json')
  need(clock()<request['deadlineAtMs'],'original-dependency-completion-deadline-expired')
  outcome.update(state='completed',reason='maintained-dependency-'+request['phase']+'-completed',result=result)
 except Exception as error:
  code=str(error)
  reason=code if isinstance(error,RuntimeError) and re.fullmatch('[a-z][a-z0-9-]{0,99}',code) else 'maintained-dependency-producer-failed'
  outcome.update(state='failed',reason=reason,result=None)
 outcome['finishedAtMs']=clock();m.write(outcome_path,m.enc(outcome));return outcome
if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--request',type=P,required=True);parser.add_argument('--approved-request-sha',required=True);args=parser.parse_args()
 try:
  outcome=execute(args.request,args.approved_request_sha);print(json.dumps(outcome));sys.exit(0 if outcome['state']=='completed' else 2)
 except Exception as error:
  code=str(error);reason=code if isinstance(error,RuntimeError) and re.fullmatch('[a-z][a-z0-9-]{0,99}',code) else 'dependency-worker-request-rejected'
  print(json.dumps({'state':'failed','reason':reason}));sys.exit(2)
