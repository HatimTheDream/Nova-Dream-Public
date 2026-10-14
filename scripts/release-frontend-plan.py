"""Read-only delegation to the exact installed frontend worker's complete plan.
No staging, intent creation, worker dispatch, selection or recovery writes.
"""
from pathlib import Path as P
import hashlib,importlib.util,json,os,re,stat,subprocess,sys,uuid

WORKER_SHA='73ca5399f703f20512a925b0cdb10dde1dfa9b733966d47b5cbdd1f20c34b171'
def need(v,code):
    if not v:raise RuntimeError(code)
def sha(raw):return hashlib.sha256(raw).hexdigest()
def read(reference,maximum):
    need(set(reference)=={'path','sha256'},'frontend-plan-reference-fields')
    p=P(reference['path']);need(p.is_absolute() and p.resolve(strict=True)==p,'frontend-plan-reference-redirected')
    for part in (p,*p.parents):
        s=part.lstat();need(not stat.S_ISLNK(s.st_mode) and s.st_uid==0 and not s.st_mode&0o022,'frontend-plan-authority-not-protected')
    before=p.lstat();need(stat.S_ISREG(before.st_mode) and before.st_nlink==1 and before.st_size<=maximum,'frontend-plan-input-not-bounded')
    fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW)
    try:
        opened=os.fstat(fd)
        with os.fdopen(fd,'rb',closefd=False) as f:raw=f.read(maximum+1)
        after=os.fstat(fd);current=p.lstat();fields=('st_dev','st_ino','st_mode','st_uid','st_gid','st_nlink','st_size','st_mtime_ns','st_ctime_ns')
        need(all(getattr(before,k)==getattr(opened,k)==getattr(after,k)==getattr(current,k) for k in fields)
             and len(raw)==before.st_size and sha(raw)==reference['sha256'],'frontend-plan-input-changed')
        return raw
    finally:os.close(fd)

def worker_installation(value):
    # Format 1 retains its original coupled identity. Format 2 names the
    # separately installed, hash-pinned tool without changing the service base.
    need(type(value.get('format')) is int and value['format'] in (1,2),'frontend-worker-identity-format')
    if value['format']==1:
        need('workerInstallation' not in value,'frontend-worker-legacy-identity-changed')
        installed={'version':value['baseVersion'],'candidateId':value['baseCandidateId']}
    else:
        installed=value.get('workerInstallation')
        need(isinstance(installed,dict) and set(installed)=={'version','candidateId'},'frontend-worker-installation-required')
    need(isinstance(installed['version'],str) and re.fullmatch(r'(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)',installed['version'])
         and isinstance(installed['candidateId'],str) and re.fullmatch('[a-f0-9]{64}',installed['candidateId']),'frontend-worker-installation-identity')
    need(value['worker']=={'path':'/opt/nova-updater-'+installed['version']+'-'+installed['candidateId'][:12]+'/deploy/update-runner/frontend.py','sha256':WORKER_SHA},'frontend-installed-worker-changed')
    return installed

def worker_arguments(value,mode,plan=None,intent=None):
    need(mode in ('plan','execute','resume'),'frontend-worker-mode-invalid')
    operation=value['operation']['path'];root='/var/lib/nova-update/frontend/operator-inputs/'+value['operationId']
    need(str(uuid.UUID(value['operationId']))==value['operationId'] and operation==root+'/operation.json'
         and value['config']['path']=='/etc/nova-update/frontend.json','frontend-worker-input-path-changed')
    need(re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+',value['baseVersion']) and re.fullmatch('[a-f0-9]{64}',value['baseCandidateId']),'frontend-base-identity-invalid')
    worker_installation(value)
    args=['/usr/bin/python3','-B',value['worker']['path'],'--'+mode,operation,'--config',value['config']['path']]
    if mode=='execute':
        need(plan is not None and intent is not None and plan['path']==root+'/plan.json' and intent['path']==root+'/intent.json','frontend-exact-plan-and-intent-required')
        args+=['--plan-receipt',plan['path'],'--intent',intent['path']]
    else:need(plan is None and intent is None,'frontend-observation-must-use-original-inputs')
    return args

def inspect(value):
    fields={'format','operationId','baseVersion','baseCandidateId','serviceInputsSha256','frontendId','sourceRevision','version','buildVersion','worker','config','operation','assets','processIdentity','workspaceEpoch'}
    need(set(value)==fields|({'workerInstallation'} if value.get('format')==2 else set()),'frontend-plan-input-fields')
    worker_installation(value)
    need(set(value['assets'])=={'manifest','signature','archive'},'frontend-plan-input-format')
    args=worker_arguments(value,'plan');worker=read(value['worker'],256*1024);config=read(value['config'],65536);operation=read(value['operation'],16384)
    root='/var/lib/nova-update/frontend/operator-inputs/'+value['operationId'];op=json.loads(operation)
    need(op=={'format':1,'operationId':value['operationId'],'manifestPath':root+'/frontend.json','signaturePath':root+'/frontend.sig','archivePath':root+'/frontend.tgz'},'frontend-staged-operation-changed')
    for role,suffix,maximum in (('manifest','json',128*1024),('signature','sig',64),('archive','tgz',128*1024**2)):
        need(value['assets'][role]['path']==root+'/frontend.'+suffix,'frontend-staged-asset-path-changed');read(value['assets'][role],maximum)
    manifest=json.loads(read(value['assets']['manifest'],128*1024))
    need(manifest['frontendId']==value['frontendId'] and manifest['base']['candidateId']==value['baseCandidateId']
         and manifest['base']['serviceInputsSha256']==value['serviceInputsSha256'] and manifest['sourceRevision']==value['sourceRevision']
         and manifest['frontendVersion']==value['version'] and manifest['frontendBuildVersion']==value['buildVersion'],'frontend-staged-contract-changed')
    return args

def verify_plan(value,plan):
    worker_installation(value)
    need(plan.get('format')==1 and plan.get('operationId')==value['operationId'] and plan.get('operationSha256')==value['operation']['sha256']
         and plan.get('configSha256')==value['config']['sha256'] and plan.get('manifestSha256')==value['assets']['manifest']['sha256']
         and plan.get('signatureSha256')==value['assets']['signature']['sha256'] and plan.get('archiveSha256')==value['assets']['archive']['sha256']
         and plan.get('frontendId')==value['frontendId'],'frontend-plan-binding-changed')
    for name in ('live','health'):
        observed=plan[name]
        need(observed['candidateId']==value['baseCandidateId'] and observed['serviceInputsSha256']==value['serviceInputsSha256']
             and observed['epoch']==value['workspaceEpoch'],'frontend-plan-service-changed')
    need(plan['health']['processIdentity']==value['processIdentity'] and plan['live']['active'] is False,'frontend-plan-service-process-or-lease-changed')
    need(plan['priorRecovery']['base']=={'candidateId':value['baseCandidateId'],'serviceInputsSha256':value['serviceInputsSha256'],
         'apiVersion':plan['health']['apiVersion'],'schemaVersion':plan['health']['schemaVersion']},'frontend-plan-prior-recovery-changed')
    return plan

def plan(value,run=subprocess.run):
    need(sys.platform=='linux' and os.geteuid()==0,'frontend-plan-needs-linux-root')
    args=inspect(value)
    result=run(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=90,check=False,
               env={'PATH':'/usr/bin:/bin','PYTHONDONTWRITEBYTECODE':'1','PYTHONPATH':'','PYTHONHOME':''})
    need(result.returncode==0 and 0<len(result.stdout)<=128*1024 and len(result.stderr)<=65536,'frontend-worker-plan-unavailable')
    original=json.loads(result.stdout);verify_plan(value,original)
    # Immutable source/staged inputs are checked again after the maintained plan.
    inspect(value)
    return {'format':1,'kind':'nova-maintained-frontend-plan','operationId':value['operationId'],
            'workerSha256':WORKER_SHA,'plan':original,'planRawBase64':__import__('base64').b64encode(result.stdout).decode(),
            'planSha256':sha(result.stdout),'readOnly':True,'capacityQualified':False,'effectDispatchQualified':False}
