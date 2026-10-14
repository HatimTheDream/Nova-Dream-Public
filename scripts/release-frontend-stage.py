"""Exact frontend input staging and plan binding, not an installer.

The file creation pattern is the maintained protected stager's exclusive
directory, separate intent, O_EXCL file creation and fsync sequence. No removal
or overwrite is implemented. Observe never creates a missing path.
"""
from pathlib import Path as P
import base64,datetime,hashlib,importlib.util,json,os,signal,stat,sys,time,uuid
WORKER_SHA='73ca5399f703f20512a925b0cdb10dde1dfa9b733966d47b5cbdd1f20c34b171'
PLAN_SHA='ad4a787df77984809f83063394a900b154220ae33fcb40e7b541746c386f9822'
EXECUTOR_SHA='204516ec085373011b83d0118df473857a78e81a3b9a01be27364ba772f4a1c4'
RESERVE=1536*1024**2;ALLOWANCE=256*1024**2;PACKET_MAX=129*1024**2
def need(value,why):
    if not value:raise RuntimeError(why)
def sha(raw):return hashlib.sha256(raw).hexdigest()
def enc(value):return (json.dumps(value,sort_keys=True,separators=(',',':'))+'\n').encode()
def load(name,path,raw):
    spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);exec(compile(raw,path,'exec'),m.__dict__);return m
def directories(path,io):
    io.protect(path.parent,directory=True,private=True)
    if not os.path.lexists(path):path.mkdir(mode=0o700);io.sync(path.parent)
    io.protect(path,directory=True,private=True)
def exclusive(path,data,io):
    io.protect(path.parent,directory=True,private=True)
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'wb') as f:f.write(data);f.flush();os.fsync(f.fileno())
    io.sync(path.parent)
def files_for(packet):
    fields={'format','operationId','runId','baseVersion','baseCandidateId','serviceInputsSha256','frontendId','sourceRevision','version','buildVersion','workspaceEpoch','worker','config','files'}
    need(type(packet.get('format')) is int and packet['format'] in (1,2) and set(packet)==fields|({'workerInstallation'} if packet['format']==2 else set()),'frontend-stage-packet-fields')
    need(all(str(uuid.UUID(packet[k]))==packet[k] for k in ('operationId','runId','workspaceEpoch')),'frontend-stage-identities')
    root=P('/var/lib/nova-update/frontend/operator-inputs')/packet['operationId'];rows=packet['files']
    need(set(rows)=={'operation.json','frontend.json','frontend.sig','frontend.tgz','frontend-plan.py','frontend-executor.py'},'frontend-stage-exact-files')
    files={}
    for name,row in rows.items():
        need(set(row)=={'sha256','bytes','base64'} and type(row['bytes']) is int and 0<row['bytes']<=128*1024**2,'frontend-stage-file-fields')
        raw=base64.b64decode(row['base64'],validate=True);need(len(raw)==row['bytes'] and sha(raw)==row['sha256'],'frontend-stage-packet-file-changed');files[name]=raw
    need(sum(map(len,files.values()))<=PACKET_MAX and sha(files['frontend-plan.py'])==PLAN_SHA and sha(files['frontend-executor.py'])==EXECUTOR_SHA,'frontend-stage-helper-or-bound-changed')
    operation={'format':1,'operationId':packet['operationId'],'manifestPath':str(root/'frontend.json'),'signaturePath':str(root/'frontend.sig'),'archivePath':str(root/'frontend.tgz')}
    need(json.loads(files['operation.json'])==operation,'frontend-stage-operation-path-changed')
    helper=load('frontend_plan',str(root/'frontend-plan.py'),files['frontend-plan.py'])
    helper.worker_installation(packet)
    need(packet['config']['path']=='/etc/nova-update/frontend.json','frontend-stage-installed-path-changed')
    return root,files
def overlay_io(module,root,files):
    # Only new, exact packet paths are virtual. No configurable allowlist exists.
    allowed={str(root/name):files[name] for name in ('operation.json','frontend.json','frontend.sig','frontend.tgz')}
    class PacketIO(module.FileIO):
        def read(self,path,maximum,private=False):
            if str(path) in allowed:
                raw=allowed[str(path)];need(len(raw)<=maximum,'frontend-stage-overlay-bound');return raw
            return super().read(path,maximum,private=private)
        def write(self,*args,**kwargs):raise RuntimeError('frontend-stage-overlay-write-forbidden')
        def remove(self,*args,**kwargs):raise RuntimeError('frontend-stage-overlay-remove-forbidden')
        def mkdir(self,*args,**kwargs):raise RuntimeError('frontend-stage-overlay-mkdir-forbidden')
    return PacketIO()
def installed(packet,root,files,capacity_only=False):
    helper=load('frontend_plan',str(root/'frontend-plan.py'),files['frontend-plan.py'])
    raw=helper.read(packet['worker'],256*1024);module=load('installed_frontend',packet['worker']['path'],raw);io=module.FileIO()
    config=io.read(packet['config']['path'],65536,private=True);need(sha(config)==packet['config']['sha256'],'frontend-stage-config-changed')
    worker=module.FrontendWorker(root/'operation.json',packet['config']['path'],overlay_io(module,root,files))
    if capacity_only:
        # This is read-only allocation verification, including before recovery
        # of an expired original operation. It cannot admit a fresh selection.
        created=datetime.datetime.fromisoformat(json.loads(files['frontend.json'])['createdAt'].replace('Z','+00:00')).timestamp()
        worker.prepare(now=created);plan={'health':worker.health(),'live':worker.observe()}
    else:plan=worker.plan() # actual protected authorities/control/health; packet assets only
    manifest=worker.manifest
    need(manifest['frontendId']==packet['frontendId'] and manifest['sourceRevision']==packet['sourceRevision']
         and manifest['frontendVersion']==packet['version'] and manifest['frontendBuildVersion']==packet['buildVersion']
         and manifest['base']['candidateId']==packet['baseCandidateId'] and manifest['base']['serviceInputsSha256']==packet['serviceInputsSha256']
         and plan['health']['epoch']==packet['workspaceEpoch'],'frontend-stage-source-or-service-changed')
    # Existing helper copies and all key/config/native/recovery reads were real.
    input={'format':packet['format'],**{k:packet[k] for k in ('operationId','baseVersion','baseCandidateId','serviceInputsSha256','frontendId','sourceRevision','version','buildVersion','worker','config','workspaceEpoch')},
      **({'workerInstallation':packet['workerInstallation']} if packet['format']==2 else {}),
      'operation':{'path':str(root/'operation.json'),'sha256':sha(files['operation.json'])},
      'assets':{role:{'path':str(root/name),'sha256':sha(files[name])} for role,name in (('manifest','frontend.json'),('signature','frontend.sig'),('archive','frontend.tgz'))},'processIdentity':plan['health']['processIdentity']}
    return module,io,worker,input,plan
def allocation(size,block):return ((size+block-1)//block)*block
def capacity(packet,root,files,worker,io,staged=False):
    # Existing selected and rollback data are already paid for in actual free
    # space and remain retained. No expected deletion/reclaim is credited.
    state=P('/var/lib/nova-update/frontend');frontend=P('/opt/nova/frontend')
    for p in (state,frontend):io.protect(p,directory=True,private=p==state)
    groups={}
    def measure(path):
        s=os.statvfs(path);device=path.stat().st_dev;need(s.f_frsize>0 and s.f_bavail>=0 and s.f_favail>=0,'frontend-capacity-filesystem-unavailable')
        if device not in groups:groups[device]={'device':device,'paths':[],'blockBytes':s.f_frsize,'freeBytes':s.f_bavail*s.f_frsize,'freeInodes':s.f_favail,'newBytes':0,'newInodes':0,'reserveBytes':RESERVE,'allowanceBytes':ALLOWANCE}
        g=groups[device];need(g['blockBytes']==s.f_frsize,'frontend-capacity-device-changed');g['paths'].append(str(path));g['freeBytes']=min(g['freeBytes'],s.f_bavail*s.f_frsize);g['freeInodes']=min(g['freeInodes'],s.f_favail);return g
    sg=measure(state);fg=measure(frontend)
    # All initial files, then bounded plan/intent/request, journals and logs.
    if not staged:sg['newBytes']+=sum(allocation(len(raw),sg['blockBytes']) for raw in files.values());sg['newInodes']+=len(files)+2
    sg['newBytes']+=4*1024**2;sg['newInodes']+=32
    parents=set()
    for item in worker.manifest['files']:
        fg['newBytes']+=allocation(item['bytes'],fg['blockBytes']);fg['newInodes']+=1
        parents.update(str(x) for x in P(item['path']).parents if str(x)!='.')
    fg['newBytes']+=len(parents)*fg['blockBytes']+4*allocation(len(files['frontend.json'])+64,fg['blockBytes'])+2*1024**2
    fg['newInodes']+=len(parents)+16
    for g in groups.values():
        g['requiredFreeBytes']=g['newBytes']+RESERVE+ALLOWANCE;g['requiredFreeInodes']=g['newInodes']+1024
        need(g['freeBytes']>=g['requiredFreeBytes'] and g['freeInodes']>=g['requiredFreeInodes'],'frontend-capacity-insufficient')
    return {'format':1,'kind':'measured-frontend-stage-capacity','stagedInputsAlreadyPaid':staged,'filesystemGroups':list(groups.values()),'expectedReclaimBytes':0,'newRecoveryCopies':0,'temporaryWritesBytes':0}
def identity(packet,root,files,input):
    return {'format':1,'operationId':packet['operationId'],'runId':packet['runId'],'packetSha256':sha(enc(packet)),'inputDirectory':str(root),'planInput':input,
            'files':{name:{'path':str(root/name),'sha256':sha(raw),'bytes':len(raw)} for name,raw in files.items()}}
def exact_initial(root,files,io):
    io.protect(root,directory=True,private=True)
    for name,raw in files.items():
        path=root/name;io.protect(path,private=True);need(path.stat().st_nlink==1 and io.read(path,len(raw),private=True)==raw,'frontend-original-stage-files-changed')
def pre_stage(packet):
    root,files=files_for(packet);module,io,worker,input,_=installed(packet,root,files)
    io.protect(root.parent.parent,directory=True,private=True)
    if os.path.lexists(root.parent):io.protect(root.parent,directory=True,private=True)
    need(not os.path.lexists(root),'frontend-stage-original-directory-exists')
    return {'format':1,'kind':'frontend-protected-stage-plan','readOnly':True,'identity':identity(packet,root,files,input),'capacity':capacity(packet,root,files,worker,io),'observedAtMs':int(time.time()*1000)},io
def stage_plan(packet):return pre_stage(packet)[0]
def stage(packet,plan,intent):
    root,files=files_for(packet);current,io=pre_stage(packet);need(current['identity']==plan['identity'] and plan['readOnly'] is True,'frontend-stage-plan-changed')
    binding={'format':1,'operationId':packet['operationId'],'runId':packet['runId'],'packetSha256':sha(enc(packet)),'planSha256':sha(enc(plan))}
    need(intent==binding,'frontend-stage-intent-changed')
    directories(root.parent,io);need(not os.path.lexists(root),'frontend-stage-never-retry-existing');root.mkdir(mode=0o700);io.sync(root.parent)
    exclusive(root/'stage-intent.json',enc(intent),io)
    for name,raw in files.items():exclusive(root/name,raw,io)
    exact_initial(root,files,io)
    receipt={'format':1,'kind':'protected-frontend-input-stage','identity':current['identity'],'intent':intent,'preStageCapacity':current['capacity'],'staged':True}
    exclusive(root/'stage-result.json',enc(receipt),io);return receipt
def stage_observe(packet):
    root,files=files_for(packet);helper=load('frontend_plan',str(root/'frontend-plan.py'),files['frontend-plan.py']);module=load('installed_frontend',packet['worker']['path'],helper.read(packet['worker'],256*1024));io=module.FileIO()
    if not os.path.lexists(root):return {'state':'uncertain','reason':'frontend-stage-original-not-observed'}
    exact_initial(root,files,io);receipt=json.loads(io.read(root/'stage-result.json',256*1024,private=True));intent=json.loads(io.read(root/'stage-intent.json',16384,private=True))
    need(receipt['identity']['packetSha256']==sha(enc(packet)) and receipt['identity']['runId']==packet['runId'] and receipt['intent']==intent and receipt['staged'] is True,'frontend-stage-original-receipt-changed')
    # No plan() here after an install started: original stage identity stays
    # immutable. Fresh capacity/recovery are independently required before effect.
    return receipt
def bind(packet,recovery,request_raw):
    root,files=files_for(packet);prior=stage_observe(packet);need(prior.get('staged') is True,'frontend-bind-needs-original-stage')
    helper=load('frontend_plan',str(root/'frontend-plan.py'),files['frontend-plan.py']);module,io,worker,input,_=installed(packet,root,files)
    planraw=base64.b64decode(recovery['planRawBase64'],validate=True);plan=json.loads(planraw)
    need(sha(planraw)==recovery['planSha256'] and plan==recovery['plan'],'frontend-bind-original-plan-bytes-changed');helper.verify_plan(input,plan)
    # A second full native plan is read-only; exact selector/sequence/service
    # equality is required before authoring the one-use intent.
    actual=helper.plan(input);need(actual['plan']==plan and input==prior['identity']['planInput'],'frontend-bind-live-plan-changed')
    cap=capacity(packet,root,files,worker,io,True)
    intent={'format':1,'operationId':packet['operationId'],'planSha256':sha(planraw),'operationSha256':input['operation']['sha256']};intentraw=enc(intent)
    request=json.loads(request_raw)
    expected={'format':1,'operationId':packet['operationId'],'runId':packet['runId'],'planInput':input,'workerPlan':{'path':str(root/'plan.json'),'sha256':sha(planraw)},'workerIntent':{'path':str(root/'intent.json'),'sha256':sha(intentraw)},'planHelper':{'path':str(root/'frontend-plan.py'),'sha256':PLAN_SHA},'executor':{'path':str(root/'frontend-executor.py'),'sha256':EXECUTOR_SHA}}
    need(request==expected,'frontend-bind-execution-request-changed')
    need(not any(os.path.lexists(root/name) for name in ('bind-intent.json','plan.json','intent.json','delivery-request.json','bind-result.json')),'frontend-bind-original-already-started')
    bindintent={'format':1,'operationId':packet['operationId'],'runId':packet['runId'],'requestSha256':sha(request_raw),'planSha256':sha(planraw)}
    exclusive(root/'bind-intent.json',enc(bindintent),io)
    for name,raw in (('plan.json',planraw),('intent.json',intentraw),('delivery-request.json',request_raw)):exclusive(root/name,raw,io)
    receipt={'format':1,'kind':'protected-frontend-execution-binding','operationId':packet['operationId'],'runId':packet['runId'],'requestSha256':sha(request_raw),'planSha256':sha(planraw),'capacity':cap,'complete':True}
    exclusive(root/'bind-result.json',enc(receipt),io);return receipt
def bind_observe(packet,request_raw):
    root,files=files_for(packet);prior=stage_observe(packet);need(prior.get('staged') is True,'frontend-bind-original-stage-missing')
    helper=load('frontend_plan',str(root/'frontend-plan.py'),files['frontend-plan.py']);module=load('installed_frontend',packet['worker']['path'],helper.read(packet['worker'],256*1024));io=module.FileIO()
    if not os.path.lexists(root/'bind-intent.json'):return {'state':'uncertain','reason':'frontend-original-binding-not-observed'}
    need(io.read(root/'delivery-request.json',256*1024,private=True)==request_raw,'frontend-bound-request-changed')
    request=json.loads(request_raw);executor=load('frontend_executor',str(root/'frontend-executor.py'),files['frontend-executor.py']);executor.inspect(root/'delivery-request.json',sha(request_raw))
    receipt=json.loads(io.read(root/'bind-result.json',256*1024,private=True));intent=json.loads(io.read(root/'bind-intent.json',16384,private=True))
    need(receipt['requestSha256']==intent['requestSha256']==sha(request_raw) and receipt['operationId']==intent['operationId']==packet['operationId'] and receipt['runId']==intent['runId']==packet['runId'] and receipt['planSha256']==request['workerPlan']['sha256'] and receipt['complete'] is True,'frontend-bound-receipt-changed')
    return receipt
def capacity_observe(packet):
    root,files=files_for(packet);prior=stage_observe(packet);need(prior.get('staged') is True,'frontend-capacity-original-stage-missing')
    module,io,worker,input,_=installed(packet,root,files,capacity_only=True)
    need(input==prior['identity']['planInput'],'frontend-capacity-original-service-changed')
    return {'kind':'frontend-stage-capacity-reverified','operationId':packet['operationId'],'runId':packet['runId'],'capacity':capacity(packet,root,files,worker,io,True),'readOnly':True}
def main(value):
    need(sys.platform=='linux' and os.geteuid()==0,'frontend-stage-needs-linux-root');signal.alarm(115);os.umask(0o077)
    mode=value['mode'];packet=value['packet']
    if mode=='plan':return stage_plan(packet)
    if mode=='stage':return stage(packet,value['plan'],value['intent'])
    if mode=='observe':return stage_observe(packet)
    if mode=='capacity':return capacity_observe(packet)
    if mode=='bind':return bind(packet,value['recovery'],base64.b64decode(value['requestBase64'],validate=True))
    if mode=='bind-observe':return bind_observe(packet,base64.b64decode(value['requestBase64'],validate=True))
    raise RuntimeError('frontend-stage-mode-invalid')
