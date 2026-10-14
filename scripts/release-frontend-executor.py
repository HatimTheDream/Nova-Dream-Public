"""Finite transport around the unchanged installed frontend worker.

No frontend selection, installation or compensation is implemented here. Each
action is dispatched once. Observation cannot create inputs or repeat execute.
"""
from pathlib import Path as P
import argparse,base64,hashlib,importlib.util,json,os,re,stat,subprocess,sys,time,uuid

PLAN_SHA='ad4a787df77984809f83063394a900b154220ae33fcb40e7b541746c386f9822'
LIMIT=120;STOP=15;MEMORY=768*1024**2
PROPERTIES=('LoadState','ActiveState','SubState','MainPID','ControlPID','ExecMainPID','Result','ExecMainStatus','InvocationID','ControlGroup',
 'Type','RuntimeMaxUSec','TimeoutStopUSec','Restart','KillMode','MemoryMax','MemorySwapMax','CPUQuotaPerSecUSec','NoNewPrivileges','ProtectSystem','ReadWritePaths','User')
def need(v,why):
    if not v:raise RuntimeError(why)
def sha(v):return hashlib.sha256(v).hexdigest()
def encoded(v):return (json.dumps(v,sort_keys=True,separators=(',',':'))+'\n').encode()
def protected(path,directory=False):
    p=P(path);need(p.is_absolute() and p.resolve(strict=True)==p,'frontend-executor-path-redirected')
    for part in (p,*p.parents):
        s=part.lstat();need(not stat.S_ISLNK(s.st_mode) and s.st_uid==0 and not s.st_mode&0o022,'frontend-executor-authority-changed')
    s=p.lstat();need(stat.S_ISDIR(s.st_mode) if directory else stat.S_ISREG(s.st_mode) and s.st_nlink==1,'frontend-executor-path-type')
    return s
def read(path,maximum=256*1024,private=True):
    p=P(path);before=protected(p);need(before.st_size<=maximum and (not private or not before.st_mode&0o077),'frontend-executor-input-not-private')
    fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW)
    try:
        opened=os.fstat(fd)
        with os.fdopen(fd,'rb',closefd=False) as f:data=f.read(maximum+1)
        after=os.fstat(fd);current=p.lstat();fields=('st_dev','st_ino','st_mode','st_uid','st_gid','st_nlink','st_size','st_mtime_ns','st_ctime_ns')
        need(len(data)==before.st_size and all(getattr(before,k)==getattr(opened,k)==getattr(after,k)==getattr(current,k) for k in fields),'frontend-executor-input-changed')
        return data
    finally:os.close(fd)
def save(path,data):
    path=P(path);protected(path.parent,True);data=data if isinstance(data,bytes) else encoded(data)
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'wb') as f:f.write(data);f.flush();os.fsync(f.fileno())
    fd=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:os.fsync(fd)
    finally:os.close(fd)
def ref(v,maximum=256*1024,private=True):
    need(set(v)=={'path','sha256'},'frontend-executor-reference-fields');data=read(v['path'],maximum,private);need(sha(data)==v['sha256'],'frontend-executor-reference-changed');return data
def load_module(name,path,data):
    spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);exec(compile(data,path,'exec'),m.__dict__);return m
def unit_name(v,action):return 'nova-frontend-'+v['runId']+'-'+action+'.service'
def paths(v,action):
    root=P(v['planInput']['operation']['path']).parent
    return {name:root/(action+'.'+name) for name in ('dispatch.json','started.json','result.json','stdout','stderr','launch.stdout','launch.stderr')}
def inspect(path,digest):
    raw=read(path);need(sha(raw)==digest,'frontend-execution-request-changed');v=json.loads(raw)
    need(set(v)=={'format','operationId','runId','planInput','workerPlan','workerIntent','planHelper','executor'} and v['format']==1
         and all(str(uuid.UUID(v[k]))==v[k] for k in ('operationId','runId')),'frontend-execution-request-fields')
    root='/var/lib/nova-update/frontend/operator-inputs/'+v['operationId']
    need(str(path)==root+'/delivery-request.json' and v['planInput']['operationId']==v['operationId']
         and v['planHelper']=={'path':root+'/frontend-plan.py','sha256':PLAN_SHA}
         and v['executor']['path']==root+'/frontend-executor.py' and v['workerPlan']['path']==root+'/plan.json'
         and v['workerIntent']['path']==root+'/intent.json','frontend-execution-staged-path-changed')
    need(ref(v['executor'])==read(__file__), 'frontend-execution-source-changed')
    helper=load_module('frontend_plan',v['planHelper']['path'],ref(v['planHelper']));helper.inspect(v['planInput'])
    planraw=ref(v['workerPlan']);plan=json.loads(planraw);helper.verify_plan(v['planInput'],plan)
    intent=json.loads(ref(v['workerIntent']));need(intent=={'format':1,'operationId':v['operationId'],'planSha256':sha(planraw),'operationSha256':v['planInput']['operation']['sha256']},'frontend-execution-intent-changed')
    return v,helper
def system_state(unit):
    result=subprocess.run(['/usr/bin/systemctl','show',unit,*('--property='+p for p in PROPERTIES)],capture_output=True,timeout=15)
    need(result.returncode in (0,4) and len(result.stdout)<=65536,'frontend-unit-observation-unavailable')
    value=dict(line.split('=',1) for line in result.stdout.decode().splitlines());need(set(value)==set(PROPERTIES),'frontend-unit-observation-incomplete')
    return value
def closed(state):
    need(state['LoadState'] in ('loaded','not-found') and state['ActiveState'] in ('inactive','failed')
         and state['MainPID']==state['ControlPID']=='0','frontend-original-worker-not-closed')
    group=state['ControlGroup']
    if group:
        need(group.startswith('/system.slice/') and '..' not in group.split('/'),'frontend-cgroup-path-changed')
        p=P('/sys/fs/cgroup'+group)
        if p.exists():
            need(not any(x.read_text().strip() for x in p.rglob('cgroup.procs')),'frontend-original-cgroup-not-empty')
    return True
def micros(value):
    if value=='2min':return 120000000
    if value=='15s':return 15000000
    if value=='500ms':return 500000
    if re.fullmatch('[0-9]+us',value):return int(value[:-2])
    raise RuntimeError('frontend-worker-time-format-changed')
def effective_profile(v,state,pid,invocation):
    expected={'Type':'exec','Restart':'no','KillMode':'control-group','MemoryMax':str(MEMORY),'MemorySwapMax':'0',
              'NoNewPrivileges':'yes','ProtectSystem':'strict'}
    need(all(state.get(k)==x for k,x in expected.items()) and micros(state['RuntimeMaxUSec'])==LIMIT*1000000
         and micros(state['TimeoutStopUSec'])==STOP*1000000 and micros(state['CPUQuotaPerSecUSec'])==500000
         and state['User'] in ('','root','0') and state['MainPID']==str(pid) and state['ExecMainPID']==str(pid)
         and re.fullmatch('[a-f0-9]{32}',invocation) and state['InvocationID']==invocation,'frontend-effective-worker-profile-changed')
    need(set(state['ReadWritePaths'].split())=={'/opt/nova/frontend','/var/lib/nova-update/frontend'},'frontend-worker-write-scope-changed')
    return expected|{'RuntimeMaxUSec':120000000,'TimeoutStopUSec':15000000,'CPUQuotaPerSecUSec':500000,'ReadWritePaths':sorted(state['ReadWritePaths'].split())}
def dispatch_binding(v,digest,action):
    return {'format':1,'operationId':v['operationId'],'runId':v['runId'],'action':action,'unit':unit_name(v,action),'requestSha256':digest,
            'runtimeMaxSeconds':LIMIT,'timeoutStopSeconds':STOP}
def original_dispatch(v,digest,action):
    data=json.loads(read(paths(v,action)['dispatch.json']));binding=dispatch_binding(v,digest,action)
    need(all(data.get(k)==x for k,x in binding.items()) and set(data)==set(binding)|{'createdAtMs','deadlineAtMs','bootId','monotonicDeadlineNs'}
         and type(data['createdAtMs']) is int and data['deadlineAtMs']==data['createdAtMs']+(LIMIT+STOP)*1000,'frontend-original-dispatch-changed')
    return data
def verify_started(v,digest,action,state):
    dispatch=original_dispatch(v,digest,action);started=json.loads(read(paths(v,action)['started.json']))
    need(started['binding']==dispatch and type(started['pid']) is int and started['pid']>0
         and effective_profile(v,started['unitProperties'],started['pid'],started['invocationId'])==started['effectiveProfile']
         and started['unitProperties']['ControlGroup']=='/system.slice/'+unit_name(v,action),'frontend-original-worker-start-changed')
    need(state['LoadState']=='not-found' or state['InvocationID']==started['invocationId'],'frontend-original-unit-invocation-changed')
    if state['LoadState']=='not-found':closed(state|{'ControlGroup':started['unitProperties']['ControlGroup']})
    return started
def native_journal(v,helper):
    module=load_module('maintained_frontend',v['planInput']['worker']['path'],helper.read(v['planInput']['worker'],256*1024))
    worker=module.FrontendWorker(v['planInput']['operation']['path'],v['planInput']['config']['path'])
    raw=worker.io.read(worker.journal_path,module.MANIFEST_MAXIMUM,private=True);journal=module.strict_json(raw)
    need(type(journal.get('createdAt')) is int,'frontend-original-journal-time-missing');worker.prepare(now=journal['createdAt']/1000,resume=True)
    need(journal.get('format')==1 and journal.get('operationId')==v['operationId'] and journal.get('operationSha256')==v['planInput']['operation']['sha256']
         and journal.get('configSha256')==v['planInput']['config']['sha256'] and journal.get('manifestSha256')==v['planInput']['assets']['manifest']['sha256']
         and journal.get('planSha256')==v['workerPlan']['sha256'] and journal.get('frontendId')==v['planInput']['frontendId']
         and journal.get('targetSelector')==worker.target_selector,'frontend-original-journal-binding-changed')
    need(journal['health']['processIdentity']==v['planInput']['processIdentity'] and journal['health']['epoch']==v['planInput']['workspaceEpoch'],'frontend-original-service-identity-changed')
    return worker,journal,raw
def resume_eligible(v,helper,digest,action,state):
    if action!='execute':return False
    try:closed(state);verify_started(v,digest,action,state);native_journal(v,helper);return True
    except Exception:return False
def observe(v,helper,digest):
    action='resume' if paths(v,'resume')['dispatch.json'].exists() else 'execute';p=paths(v,action)
    if not p['dispatch.json'].exists():return {'state':'uncertain','reason':'frontend-original-dispatch-not-recorded'}
    dispatch=original_dispatch(v,digest,action);state=system_state(unit_name(v,action))
    if state['ActiveState'] in ('active','activating','deactivating') or state['MainPID']!='0' or state['ControlPID']!='0':
        if not p['started.json'].exists():return {'state':'uncertain','reason':'frontend-worker-start-not-captured','dispatch':dispatch,'unit':state}
        started=verify_started(v,digest,action,state)
        return {'state':'running','reason':'frontend-original-worker-running','dispatch':dispatch,'started':started,'unit':state}
    closed(state)
    if not p['started.json'].exists() or not p['result.json'].exists():return {'state':'uncertain','reason':'frontend-closed-worker-result-missing','dispatch':dispatch,'unit':state,
      'resumeEligible':resume_eligible(v,helper,digest,action,state)}
    started=verify_started(v,digest,action,state);result=json.loads(read(p['result.json']))
    need(started['binding']==dispatch and result['binding']==dispatch and result['invocationId']==started['invocationId']
         and (state['LoadState']=='not-found' or state['InvocationID']==started['invocationId']),'frontend-closed-worker-identity-changed')
    stdout=read(p['stdout'],128*1024);stderr=read(p['stderr'],65536)
    need(result['stdoutSha256']==sha(stdout) and result['stderrSha256']==sha(stderr),'frontend-original-worker-output-changed')
    if result['returncode']!=0:return {'state':'uncertain','reason':'frontend-maintained-worker-needs-resume','dispatch':dispatch,'started':started,'unit':state,'workerResult':result,
      'resumeEligible':resume_eligible(v,helper,digest,action,state)}
    if state['LoadState']=='loaded' and (state['Result']!='success' or state['ExecMainStatus']!='0'):
        return {'state':'uncertain','reason':'frontend-closed-unit-not-successful','dispatch':dispatch,'started':started,'unit':state,'workerResult':result}
    worker,journal,raw=native_journal(v,helper);need(json.loads(stdout)==journal,'frontend-worker-result-journal-mismatch')
    need(journal['phase']=='completed','frontend-successful-worker-incomplete')
    if journal.get('outcome')!='selected':return {'state':'failed','reason':'frontend-not-selected','journal':journal,'dispatch':dispatch,'started':started,'unit':state,'workerResult':result}
    expected=(json.dumps(journal['targetSelector'],separators=(',',':'),ensure_ascii=False)+'\n').encode();need(worker.optional(worker.selector)==expected and worker.optional(worker.current,private=True) is None,'frontend-selected-authority-unsettled')
    worker.verify_materialized();worker.same_health(journal,selected=True);need(worker.observe(False)['active'] is False,'frontend-lease-not-released')
    prior=base64.b64decode(journal['priorSelector'],validate=True) if journal['priorSelector'] is not None else None
    need(worker.prior_recovery(prior,journal['priorRecovery']['frontend'])==journal['priorRecovery'],'frontend-prior-recovery-changed')
    return {'state':'completed','reason':'frontend-selected-original-service-preserved','journal':journal,'journalSha256':sha(raw),'journalRawBase64':base64.b64encode(raw).decode(),
            'dispatch':dispatch,'started':started,'unit':state,'workerResult':result,'savedReplyAccepted':False,'browserAccepted':False}
def launch(v,helper,path,digest,action):
    need(action in ('execute','resume'),'frontend-executor-action-invalid');p=paths(v,action)
    if p['dispatch.json'].exists():return observe(v,helper,digest)
    if action=='execute':
        need(not paths(v,'resume')['dispatch.json'].exists() and not P('/var/lib/nova-update/frontend/'+v['operationId']+'.json').exists(),'frontend-execute-must-not-replay')
        # The maintained worker repeats this exact plan check under its lock.
        current=helper.plan(v['planInput']);need(current['plan']==json.loads(ref(v['workerPlan'])),'frontend-fresh-plan-changed')
    else:
        original_dispatch(v,digest,'execute');state=system_state(unit_name(v,'execute'));closed(state);verify_started(v,digest,'execute',state)
        worker,journal,_=native_journal(v,helper)
        # A completed native journal with a lost transport result is reconciled
        # by maintained resume too; it verifies the selector without reselecting.
    initial=system_state(unit_name(v,action));closed(initial);need(initial['LoadState']=='not-found','frontend-new-worker-unit-already-exists')
    created=int(time.time()*1000);binding=dispatch_binding(v,digest,action)|{'createdAtMs':created,'deadlineAtMs':created+(LIMIT+STOP)*1000,
      'bootId':P('/proc/sys/kernel/random/boot_id').read_text().strip(),'monotonicDeadlineNs':time.monotonic_ns()+(LIMIT+STOP)*1000000000}
    save(p['dispatch.json'],binding)
    save(p['launch.stdout'],b'');save(p['launch.stderr'],b'')
    command=['/usr/bin/systemd-run','--quiet','--collect','--unit='+unit_name(v,action),'--property=Type=exec',
      '--property=RuntimeMaxSec=120','--property=TimeoutStopSec=15','--property=Restart=no','--property=KillMode=control-group',
      '--property=MemoryMax=768M','--property=MemorySwapMax=0','--property=CPUQuota=50%','--property=Nice=10','--property=NoNewPrivileges=yes',
      '--property=ProtectSystem=strict','--property=ReadWritePaths=/opt/nova/frontend /var/lib/nova-update/frontend',
      '--property=StandardOutput=append:'+str(p['launch.stdout']),'--property=StandardError=append:'+str(p['launch.stderr']),'/usr/bin/python3','-B',v['executor']['path'],'worker',
      '--request',str(path),'--request-sha256',digest,'--action',action]
    try:
        result=subprocess.run(command,capture_output=True,timeout=20);need(result.returncode==0,'frontend-dispatch-response-unavailable')
    except Exception:return {'state':'uncertain','reason':'frontend-dispatch-response-unavailable','dispatch':binding}
    return observe(v,helper,digest)
def remaining_child_timeout(binding,now=None):
    # A queued unit may start late. Never restart the original dispatch clock.
    remaining=(binding['monotonicDeadlineNs']-(time.monotonic_ns() if now is None else now))/1000000000-STOP
    need(remaining>0,'frontend-original-dispatch-deadline-expired')
    return min(LIMIT-5,remaining)
def worker(v,helper,path,digest,action):
    binding=original_dispatch(v,digest,action);p=paths(v,action);state=system_state(unit_name(v,action));invocation=os.environ.get('INVOCATION_ID','')
    profile=effective_profile(v,state,os.getpid(),invocation)
    need(any(line.split(':',2)[-1]==state['ControlGroup'] for line in P('/proc/self/cgroup').read_text().splitlines()),'frontend-worker-cgroup-changed')
    need(binding['bootId']==P('/proc/sys/kernel/random/boot_id').read_text().strip() and time.monotonic_ns()<binding['monotonicDeadlineNs'],'frontend-original-dispatch-deadline-expired')
    save(p['started.json'],{'binding':binding,'invocationId':invocation,'pid':os.getpid(),'effectiveProfile':profile,'unitProperties':state})
    args=helper.worker_arguments(v['planInput'],action,v['workerPlan'] if action=='execute' else None,v['workerIntent'] if action=='execute' else None)
    # Captured worker output is private and bounded independently of SSH.
    try:
        result=subprocess.run(args,capture_output=True,timeout=remaining_child_timeout(binding),env={'PATH':'/usr/bin:/bin','PYTHONPATH':'','PYTHONHOME':'','PYTHONDONTWRITEBYTECODE':'1'})
        need(len(result.stdout)<=128*1024 and len(result.stderr)<=65536,'frontend-worker-output-bound')
        save(p['stdout'],result.stdout);save(p['stderr'],result.stderr)
        save(p['result.json'],{'binding':binding,'invocationId':invocation,'returncode':result.returncode,'stdoutSha256':sha(result.stdout),'stderrSha256':sha(result.stderr)})
        return result.returncode
    except subprocess.TimeoutExpired as error:
        stdout=(error.stdout or b'')[:128*1024];stderr=(error.stderr or b'')[:65536]
        save(p['stdout'],stdout);save(p['stderr'],stderr)
        save(p['result.json'],{'binding':binding,'invocationId':invocation,'returncode':124,'stdoutSha256':sha(stdout),'stderrSha256':sha(stderr),'deadlineExpired':True})
        return 2
def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('mode',choices=('execute','resume','observe','worker'));parser.add_argument('--request',type=P,required=True);parser.add_argument('--request-sha256',required=True);parser.add_argument('--action',choices=('execute','resume'))
    a=parser.parse_args();need(sys.platform=='linux' and os.geteuid()==0,'frontend-executor-needs-linux-root');v,helper=inspect(a.request,a.request_sha256)
    if a.mode=='worker':need(a.action is not None,'frontend-worker-action-missing');return worker(v,helper,a.request,a.request_sha256,a.action)
    need(a.action is None,'frontend-caller-action-invalid')
    result=observe(v,helper,a.request_sha256) if a.mode=='observe' else launch(v,helper,a.request,a.request_sha256,a.mode)
    result.update(operationId=v['operationId'],runId=v['runId'],requestSha256=a.request_sha256);print(json.dumps(result,separators=(',',':')));return 0
if __name__=='__main__':
    try:sys.exit(main())
    except Exception as e:
        print(json.dumps({'state':'uncertain','reason':str(e) if re.fullmatch('[a-z][a-z0-9-]{0,99}',str(e)) else 'frontend-executor-response-unavailable'}));sys.exit(2)
