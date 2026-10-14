"""Fixed loopback Assistant acceptance transport; no arbitrary routes or code.

Credentials stay in the original root-only acceptance directory. Session and
submit dispatches are one-use. Only exact create/draft bodies admit an explicit
effect-capable same-key continuation. No provider configuration or service writes.
"""
import base64, hashlib, http.cookiejar, importlib.util, json, os, pathlib, re, signal, stat, subprocess, sys, time, urllib.error, urllib.request, uuid
P=pathlib.Path
ORIGIN='http://127.0.0.1:4383'
POSTS={'/api/assistant/conversations','/api/commands','/api/assistant/submit'}
READS={'/api/health','/api/access/context','/api/software-update/acceptance','/api/assistant/service','/api/assistant/state','/api/snapshot'}
def need(v,r):
    if not v:raise RuntimeError(r)
def enc(v):return json.dumps(v,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
def sha(v):return hashlib.sha256(v).hexdigest()
def uid(v):return isinstance(v,str) and str(uuid.UUID(v))==v
def protected(p,directory=False,private=False):
    p=P(p);need(p.is_absolute() and p.resolve(strict=True)==p,'assistant-protected-path-redirected')
    for x in (p,*p.parents):
        s=x.lstat();need(s.st_uid==0 and not stat.S_ISLNK(s.st_mode) and not s.st_mode&0o022,'assistant-protected-authority-changed')
    s=p.lstat();need(stat.S_ISDIR(s.st_mode) if directory else stat.S_ISREG(s.st_mode) and s.st_nlink==1,'assistant-protected-type-changed')
    need(not private or not s.st_mode&0o077,'assistant-private-permissions-changed');return s
def identity(s):return (s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns,s.st_mode,s.st_nlink,s.st_uid,s.st_gid)
def raw(p,limit=131072,private=False):
    p=P(p);s=protected(p,private=private);need(s.st_size<=limit,'assistant-reference-bound')
    fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW)
    try:
        need(identity(os.fstat(fd))==identity(s),'assistant-reference-replaced')
        with os.fdopen(fd,'rb',closefd=False) as f:b=f.read(limit+1)
        need(len(b)==s.st_size and identity(os.fstat(fd))==identity(s) and identity(protected(p,private=private))==identity(s),'assistant-reference-changed')
        return b
    finally:os.close(fd)
RUNTIME_BINARY_MAXIMUM=512*1024**2
def verified_runtime_binary(p,expected_size,expected_sha256):
    # The qualified inventory fixes logical bytes and digest. Read one bounded
    # chunk at a time so a valid large companion does not require a large buffer.
    need(type(expected_size) is int and 0<expected_size<=RUNTIME_BINARY_MAXIMUM
      and isinstance(expected_sha256,str) and re.fullmatch('[a-f0-9]{64}',expected_sha256),'assistant-runtime-binary-evidence-bound')
    p=P(p);before=protected(p)
    need(before.st_size==expected_size and before.st_mode&0o111,'assistant-runtime-binary-size-or-mode-changed')
    fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW)
    try:
        need(identity(os.fstat(fd))==identity(before),'assistant-runtime-binary-replaced')
        digest=hashlib.sha256();remaining=expected_size
        while remaining:
            chunk=os.read(fd,min(1024**2,remaining))
            need(bool(chunk),'assistant-runtime-binary-truncated')
            digest.update(chunk);remaining-=len(chunk)
        need(os.read(fd,1)==b'','assistant-runtime-binary-grew')
        need(identity(os.fstat(fd))==identity(before) and identity(protected(p))==identity(before),'assistant-runtime-binary-changed-during-read')
        need(digest.hexdigest()==expected_sha256,'assistant-runtime-binary-changed')
        return before
    finally:os.close(fd)
def ref(v,limit=131072,private=False):
    need(set(v)=={'path','sha256'} and re.fullmatch('[a-f0-9]{64}',v['sha256']),'assistant-reference-invalid')
    b=raw(v['path'],limit,private);need(sha(b)==v['sha256'],'assistant-reference-hash-changed');return b
def sync(p):
    fd=os.open(p,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:os.fsync(fd)
    finally:os.close(fd)
def save(p,v):
    b=enc(v)+b'\n';fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'wb') as f:f.write(b);f.flush();os.fsync(f.fileno())
    sync(p.parent);return {'path':str(p),'sha256':sha(b)}
def load_module(name,p,b):
    m=importlib.util.module_from_spec(importlib.util.spec_from_loader(name,loader=None));m.__file__=str(p)
    exec(compile(b,str(p),'exec'),m.__dict__);return m
def process_identity():
    b=subprocess.check_output(['/usr/bin/systemctl','show','nova-dream.service','--property=MainPID,NRestarts,ActiveState,SubState,ExecMainStartTimestampMonotonic'],text=True,timeout=10)
    v=dict(line.split('=',1) for line in b.splitlines() if '=' in line)
    need(v['ActiveState']=='active' and v['SubState']=='running' and int(v['MainPID'])>1,'assistant-process-not-running');return v
def installation(binding):
    q=binding['frontendRequest'];executor=load_module('fixed_assistant_frontend_executor',q['executor']['path'],ref(q['executor'],262144,True))
    path=P(q['executor']['path']).parent/'delivery-request.json';request=raw(path,262144,True)
    need(json.loads(request)==q,'assistant-original-frontend-request-changed')
    v,helper=executor.inspect(path,sha(request));out=executor.observe(v,helper,sha(request))
    need(out.get('state')=='completed' and out.get('journalSha256')==binding['journalSha256'],'assistant-original-installation-unsettled')
    current=P('/opt/nova/current');need(current.is_symlink() and current.lstat().st_uid==0,'assistant-current-selector-changed')
    protected(current.parent,True);target=current.resolve(strict=True);protected(target,True)
    pkg=raw(target/'package.json',1024**2);manifest=raw(target/'dist/candidate.json',2*1024**2);j=json.loads(manifest)
    need(sha(pkg+manifest)==binding['input']['installedHealth']['candidateId'] and target==P('/opt/nova/releases')/(j['version']+'-'+sha(pkg+manifest)[:12]),'assistant-installed-candidate-changed')
    return {'installationSha256':binding['input']['installationSha256'],'nativeJournalSha256':out['journalSha256'],'candidateId':sha(pkg+manifest)}
def runtime_inputs(evidence):
    review=json.loads(ref(evidence['startupReview'],131072));r=review['runtime']
    need(review.get('kind')=='fresh-corrected-isolated-bootstrap-qualification' and review.get('format')==1 and r['root']=='/opt/nova/runtime','assistant-maintained-runtime-evidence-required')
    root=P(r['agent']).parent.parent
    need(str(root).startswith('/opt/nova/runtime/managed-updates/') and str(root/'node/bin/node')==r['agentNode'],'assistant-runtime-evidence-path-changed')
    rows=json.loads(ref(r['inventory'],64*1024**2));need(isinstance(rows,dict),'assistant-runtime-inventory-invalid')
    def frozen(path,limit):
        row=rows.get(str(path.relative_to(P(r['root']))));need(row and row['kind']=='file','assistant-runtime-inventory-file-missing')
        b=raw(path,limit);need(sha(b)==row['sha256'],'assistant-runtime-inventory-file-changed');return b
    companion=root/'companions/codex'
    codex=json.loads(frozen(companion/'node_modules/@openai/codex/package.json',1024**2))
    node=root/'node/bin/node';binary=companion/'node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex'
    def digest(path):
        row=rows.get(str(path.relative_to(P(r['root']))));need(row and row['kind']=='file' and re.fullmatch('[a-f0-9]{64}',row['sha256']),'assistant-runtime-binary-evidence-missing');return row['sha256']
    def binary_size(path):
        row=rows.get(str(path.relative_to(P(r['root']))));need(row and row['kind']=='file' and type(row.get('size')) is int and 0<row['size']<=RUNTIME_BINARY_MAXIMUM,'assistant-runtime-binary-evidence-bound');return row['size']
    need(digest(node)==r['agentNodeSha256'],'assistant-runtime-node-evidence-changed')
    return {'hostConfig':evidence['hostConfig'],'root':str(root),'openclawVersion':r['agentVersion'],'codexVersion':codex['version'],'nodeSha256':digest(node),'nodeBytes':binary_size(node),'codexSha256':digest(binary),'codexBytes':binary_size(binary),'codexLockSha256':digest(companion/'package-lock.json'),'inventory':r['inventory'],'startupReview':evidence['startupReview']}
def runtime_identity(evidence,full=True):
    expected=runtime_inputs(evidence)
    configraw=ref(expected['hostConfig'],65536);config=json.loads(configraw);root=P(expected['root'])
    need(re.fullmatch('/opt/nova/runtime/managed-updates/openclaw-'+re.escape(expected['openclawVersion'])+'-[a-f0-9]{12}',str(root)),'assistant-runtime-root-invalid')
    agent=root/'node_modules/openclaw';node=root/'node/bin/node';companion=root/'companions/codex'
    for key,target in [('agentDirectory',agent),('agentNodePath',node)]:
        selector=P(config[key]);protected(selector.parent,True)
        need(selector.is_absolute() and selector.is_symlink() and selector.lstat().st_uid==0 and selector.resolve(strict=True)==target,'assistant-runtime-selector-changed');protected(target,key=='agentDirectory')
    packages=[(agent/'package.json','openclaw',expected['openclawVersion']),
      (companion/'node_modules/@openclaw/codex/package.json','@openclaw/codex',expected['openclawVersion']),
      (companion/'node_modules/@openai/codex/package.json','@openai/codex',expected['codexVersion']),
      (companion/'node_modules/@openai/codex-linux-x64/package.json','@openai/codex',expected['codexVersion']+'-linux-x64')]
    for path,name,version in packages:
        pkg=json.loads(raw(path,1024**2));need(pkg.get('name')==name and pkg.get('version')==version,'assistant-runtime-package-changed')
        if name=='@openclaw/codex':need(pkg.get('dependencies',{}).get('@openai/codex')==expected['codexVersion'],'assistant-runtime-companion-changed')
    need(sha(raw(companion/'package-lock.json',16*1024**2))==expected['codexLockSha256'],'assistant-runtime-lock-changed')
    binary=companion/'node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex';files={}
    for p,digest,size in [(node,expected['nodeSha256'],expected['nodeBytes']),(binary,expected['codexSha256'],expected['codexBytes'])]:
        s=verified_runtime_binary(p,size,digest) if full else protected(p)
        need(s.st_mode&0o111 and s.st_size==size,'assistant-runtime-binary-size-or-mode-changed')
        files[str(p)]={'device':s.st_dev,'inode':s.st_ino,'bytes':s.st_size,'mtimeNanoseconds':str(s.st_mtime_ns),'ctimeNanoseconds':str(s.st_ctime_ns),'mode':stat.S_IMODE(s.st_mode),'sha256':digest}
    # The exact inventoried binary supplies its version; no historical version
    # is reinterpreted as proof of a newly installed runtime.
    return {'openclawVersion':expected['openclawVersion'],'codexVersion':expected['codexVersion'],'configurationSha256':sha(configraw),'files':files,'inventory':expected['inventory'],'startupReview':expected['startupReview']}
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):raise RuntimeError('assistant-loopback-redirect-refused')
class Api:
    def __init__(self,binding,deadline,cookies=None):
        self.binding=binding;self.deadline=deadline;self.jar=http.cookiejar.CookieJar()
        for item in cookies or []:self.jar.set_cookie(http.cookiejar.Cookie(**item))
        self.client=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect(),urllib.request.HTTPCookieProcessor(self.jar))
    def read(self,path,body=None,session=False):
        need(path in (POSTS if body is not None else READS) or session and path=='/api/session' and body==b'{}'
             or body is None and re.fullmatch('/api/assistant/reconcile/[a-f0-9-]{36}',path),'assistant-endpoint-not-allowed')
        remaining=self.deadline-time.monotonic();need(remaining>0,'assistant-original-deadline-exhausted')
        req=urllib.request.Request(ORIGIN+path,data=body,headers={'Origin':ORIGIN,'X-Edition3-Client':'1','X-Edition3-Candidate':self.binding['input']['installedHealth']['candidateId'],'Content-Type':'application/json'})
        try:
            with self.client.open(req,timeout=min(60,remaining)) as response:b=response.read(16*1024**2+1)
        except urllib.error.HTTPError as e:
            b=e.read(65537);need(len(b)<=65536,'assistant-api-error-bound')
            try:code=json.loads(b).get('code')
            except Exception:code=None
            error=RuntimeError('assistant-api-request-refused');error.api_code=code;error.http_status=e.code
            error.private_response={'status':e.code,'bodyBase64':base64.b64encode(b).decode(),'endpoint':path};raise error
        need(len(b)<=16*1024**2,'assistant-api-response-bound');return json.loads(b)
    def cookies(self):
        keys=['version','name','value','port','port_specified','domain','domain_specified','domain_initial_dot','path','path_specified','secure','expires','discard','comment','comment_url','rfc2109']
        return [{**{k:getattr(c,k) for k in keys},'rest':c._rest} for c in self.jar]
def ready(api,binding,full=True):
    proof=installation(binding);process=process_identity();runtime=runtime_identity(binding['runtime'],full)
    health=api.read('/api/health');access=api.read('/api/access/context')
    health={k:health.get(k) for k in ('candidateId','serviceInputsSha256','apiVersion','schemaVersion','processIdentity','frontend')}|{'epoch':access.get('workspaceEpoch')}
    need(health==binding['input']['installedHealth'],'assistant-health-changed')
    state=api.read('/api/assistant/state');state=project_state(state,root_for(binding))
    result={'health':health,'access':access,'acceptance':api.read('/api/software-update/acceptance'),'service':api.read('/api/assistant/service'),
      'state':state,'appProcess':process,'runtimeProof':runtime,'installationProof':proof,'fullRuntimeVerified':full}
    need(process_identity()==process,'assistant-process-changed-during-readiness');return result
def project_state(state,root):
    # Preserve every old unknown's COMPLETE content fingerprint and every active
    # operation. Only our own request/conversation needs its full private body.
    requests=set();conversations=set();markers=list(root.glob('request-*.json'));need(len(markers)<=3,'assistant-original-request-count-changed')
    for marker in markers:
        r=json.loads(raw(marker,65536,True));need(r['endpoint'] in POSTS and uid(r['requestId']) and marker.name=='request-'+r['requestId']+'.json','assistant-original-request-marker-invalid');requests.add(r['requestId'])
        result=root/('result-'+r['requestId']+'.json')
        if r['endpoint']=='/api/assistant/conversations' and result.exists():
            v=json.loads(raw(result,131072,True));need(uid(v['id']),'assistant-created-conversation-id-invalid');conversations.add(v['id'])
    operations=[]
    for item in state['operations']:
        if item.get('requestId') in requests:operations.append(item)
        elif item.get('state') in {'unknown','prepared','dispatching','accepted','running'}:
            operations.append({'id':item['id'],'state':item['state'],'conversationId':item.get('conversationId'),'actualStateSha256':sha(enc(item))})
    return {'connection':state['connection'],'operations':operations,'conversations':[c for c in state['conversations'] if c['id'] in conversations]}
def check_ready(value,binding,retained=None,initial=False):
    epoch=binding['input']['installedHealth']['epoch'];candidate=binding['input']['installedHealth']['candidateId']
    a=value['access'];n=value['acceptance'];s=value['service'];state=value['state'];c=state['connection']
    need(a.get('workspaceEpoch')==epoch and a.get('recovery') is False and a.get('recoveryLocal') is False,'assistant-workspace-or-recovery-changed')
    need(n.get('candidateId')==candidate and n.get('epoch')==epoch and n.get('heldFor') is None and n.get('maintenanceHeld') is False and n.get('nativeSuspended') is False,'assistant-native-hold-not-released')
    need(s.get('id')=='openclaw' and s.get('state')=='ready' and s.get('version')==value['runtimeProof']['openclawVersion'],'assistant-native-not-ready')
    need(c.get('state')=='ready' and c.get('modelAuthReady') is True and {'operator.read','operator.write'}<=set(c.get('grantedScopes',[])) and uid(c['generation']),'assistant-native-model-auth-not-ready')
    need(isinstance(state.get('operations'),list) and isinstance(state.get('conversations'),list),'assistant-native-state-invalid')
    if retained:
        need(all(value[k]==retained[k] for k in ('appProcess','runtimeProof','installationProof')) and c['generation']==retained['connectionGeneration'],'assistant-process-runtime-or-native-identity-changed')
        unknowns={o['id']:sha(enc(o)) for o in state['operations']}
        need(all(unknowns.get(k)==v for k,v in retained['oldUnknownHashes'].items()),'assistant-old-unknown-operation-changed')
    if initial:need(not any(o['state'] in {'prepared','dispatching','accepted','running'} for o in state['operations']),'assistant-existing-active-work-must-settle')
def root_for(binding):return P('/var/lib/nova-update/frontend/operator-inputs')/binding['operationId']/('assistant-'+binding['parentKey'])
def checked_anchor(binding,create=False):
    root=root_for(binding);protected(root.parent,True,True);p=root/'anchor.json';digest=sha(enc(binding))
    if create:
        remaining=binding['deadlineAtMs']/1000-time.time();need(0<remaining<=300,'assistant-original-deadline-invalid')
        root.mkdir(mode=0o700);sync(root.parent)
        save(p,{'bindingSha256':digest,'deadlineAtMs':binding['deadlineAtMs'],'monotonicDeadlineNs':time.monotonic_ns()+int(remaining*1e9),'bootId':P('/proc/sys/kernel/random/boot_id').read_text().strip()})
    protected(root,True,True);a=json.loads(raw(p,8192,True))
    need(a['bindingSha256']==digest and a['deadlineAtMs']==binding['deadlineAtMs'] and a['bootId']==P('/proc/sys/kernel/random/boot_id').read_text().strip(),'assistant-original-anchor-changed')
    need(time.time()*1000<a['deadlineAtMs'] and time.monotonic_ns()<a['monotonicDeadlineNs'],'assistant-original-deadline-exhausted')
    return root,a,a['monotonicDeadlineNs']/1e9
def session_file(binding,common,root):
    s=common['session'];path=P(s['sessionReference']['path'])
    need(path.parent==root and re.fullmatch('session-[a-f0-9-]{36}.json',path.name) and s['sessionSha256']==s['sessionReference']['sha256'],'assistant-original-session-reference-changed')
    v=json.loads(ref(s['sessionReference'],65536,True));need(v['bindingSha256']==sha(enc(binding)) and v['deviceId']==s['deviceId'],'assistant-original-session-changed');return v
def assert_request(binding,common):
    r=common['request'];body=r['bodyBytes'].encode();v=json.loads(body);s=common['session']
    need(r['endpoint'] in POSTS and sha(body)==r['bodySha256'] and body==enc(v) and uid(r['requestId']) and v.get('requestId')==r['requestId']
      and v.get('epoch')==r['epoch']==binding['input']['installedHealth']['epoch'] and r['deviceId']==s['deviceId'] and r['sessionSha256']==s['sessionSha256'],'assistant-exact-request-changed')
    if r['endpoint']=='/api/assistant/conversations':need(set(v)=={'requestId','epoch','space','autoTitle','title','projectId','permissionMode'} and v['space']=='chat' and v['autoTitle'] is False and v['title']=='Nova deployment verification' and v['projectId'] is None and v['permissionMode']=='read-only','assistant-create-body-invalid')
    if r['endpoint']=='/api/commands':
        c=common['conversation'];expected={'space':'chat','workMode':'chat','title':'Nova deployment verification','text':'Connection verification only. Reply exactly: Nova verification '+binding['parentKey']+' passed. Do not use tools or perform any other action.','projectId':None,'conversationId':c['id'],'attachments':[]}
        need(set(v)=={'requestId','epoch','kind','entityId','expectedRevision','payload'} and v['kind']=='draft' and v['entityId']=='draft:'+s['deviceId']+':'+c['id'] and v['expectedRevision']==0 and v['payload']==expected,'assistant-draft-body-invalid')
    if r['endpoint']=='/api/assistant/submit':need(set(v)=={'requestId','epoch','conversationId','conversationRevision','draftId','draftRevision','projectRevision'} and v['conversationId']==common['conversation']['id'] and v['conversationRevision']==common['conversation']['revision'] and v['draftId']=='draft:'+s['deviceId']+':'+v['conversationId'] and v['draftRevision']==1 and v['projectRevision']==0,'assistant-submit-body-invalid')
    return r,body
def post_exact(api,root,binding,common):
    r,body=assert_request(binding,common);marker=root/('request-'+r['requestId']+'.json');result=root/('result-'+r['requestId']+'.json')
    if marker.exists():
        need(json.loads(raw(marker,65536,True))==r,'assistant-original-request-marker-changed')
        if result.exists():
            original=json.loads(raw(result,131072,True))
            if r['endpoint']=='/api/assistant/conversations':return retained_create(api,root,r,original,common['session'])
            return original
        need(r['endpoint']!='/api/assistant/submit' and common['effectCapableContinuation'] is True,'assistant-submit-or-session-replay-refused')
    else:save(marker,r)
    # POST continuation is an effect, never described as read-only observation.
    output=api.read(r['endpoint'],body);save(result,output);return output
def retained_create(api,root,request,original,session):
    # A create receipt may describe the original conversation while its first
    # native await is still running. Preserve that receipt; observe its exact
    # identity instead of permanently replaying a provisional local snapshot.
    need(uid(original['id']) and original['connectionGeneration']==session['readiness']['connectionGeneration'],'assistant-original-create-identity-changed')
    settled=root/('create-settled-'+request['requestId']+'.json');anchor=original;original_hash=sha(enc(original))
    if settled.exists():
        saved=json.loads(raw(settled,131072,True));need(saved['originalResponseSha256']==original_hash,'assistant-create-settlement-binding-changed');anchor=saved['conversation']
    state=api.read('/api/assistant/state');rows=[v for v in state['conversations'] if v['id']==original['id']]
    need(len(rows)==1,'assistant-original-create-not-observed');current=rows[0]
    need(current['connectionGeneration']==original['connectionGeneration']==anchor['connectionGeneration'] and current.get('nativeKey')==original.get('nativeKey')==anchor.get('nativeKey')
      and (anchor.get('nativeId') is None or current.get('nativeId')==anchor['nativeId']) and current['revision']>=anchor['revision'],'assistant-original-create-native-identity-changed')
    if current['state']=='ready':
        need(uid(current['nativeId']),'assistant-create-native-identity-unconfirmed')
        if original.get('nativeId') is None and not settled.exists():save(settled,{'originalResponseSha256':original_hash,'conversation':current})
    return current
def check_effect_state(api,binding,common,current):
    c=common.get('conversation')
    if c:
        matches=[v for v in current['state']['conversations'] if v['id']==c['id']];need(len(matches)==1,'assistant-current-conversation-missing');v=matches[0]
        need(all(v.get(k)==c.get(k) for k in ('id','nativeId','revision','connectionGeneration')) and v.get('state')=='ready' and v.get('permissionMode')=='read-only' and v.get('projectId') is None and not v.get('pendingSettings') and not v.get('archived') and not v.get('deleted'),'assistant-current-conversation-changed')
    if common['request']['endpoint']=='/api/assistant/submit':
        body=json.loads(common['request']['bodyBytes']);snapshot=api.read('/api/snapshot')
        need(snapshot.get('deviceId')==common['session']['deviceId'] and snapshot.get('epoch')==body['epoch'],'assistant-draft-snapshot-identity-changed')
        rows=[v for v in snapshot['drafts'] if v['id']==body['draftId']];need(len(rows)==1,'assistant-original-draft-missing')
        value=rows[0];expected={'space':'chat','workMode':'chat','title':'Nova deployment verification','text':'Connection verification only. Reply exactly: Nova verification '+binding['parentKey']+' passed. Do not use tools or perform any other action.','projectId':None,'conversationId':c['id'],'attachments':[]}
        need(value['revision']==body['draftRevision'] and value['deviceId']==common['session']['deviceId'] and value['value']==expected and not any(o.get('conversationId')==c['id'] for o in current['state']['operations']),'assistant-submit-draft-or-operation-changed')
def original_session(binding,common,root,deadline):
    need(uid(common['childKey']),'assistant-session-key-invalid');path=root/('session-'+common['childKey']+'.json');marker=root/'session-dispatch.json'
    expected={'childKey':common['childKey'],'bindingSha256':sha(enc(binding))}
    if path.exists():
        need(json.loads(raw(marker,8192,True))==expected,'assistant-original-session-marker-changed')
        b=raw(path,65536,True);saved=json.loads(b);need(saved['bindingSha256']==expected['bindingSha256'],'assistant-session-binding-changed');sessionref={'path':str(path),'sha256':sha(b)};api=Api(binding,deadline,saved['cookies'])
    else:
        need(common['observeOnly'] is False and not marker.exists(),'assistant-original-session-unavailable')
        save(marker,expected);api=Api(binding,deadline)
        value=api.read('/api/session',b'{}',session=True);need(uid(value['deviceId']) and api.cookies(),'assistant-session-response-invalid')
        saved={'bindingSha256':expected['bindingSha256'],'deviceId':value['deviceId'],'cookies':api.cookies()};sessionref=save(path,saved)
    return saved,sessionref,api
def main(payload):
    need(sys.platform=='linux' and os.geteuid()==0,'assistant-transport-needs-linux-root');os.umask(0o077)
    binding=payload['binding'];common=payload['common'];mode=payload['mode']
    need(mode in {'session','ready','post','draft','observe'} and all(uid(binding[k]) for k in ('operationId','parentKey')),'assistant-transport-mode-invalid')
    need(all(common[k]==binding[k] for k in ('operationId','parentKey','inputSha256','deadlineAtMs','input')),'assistant-call-binding-changed')
    # Verify real installed authorities before creating a credential directory.
    remaining=binding['deadlineAtMs']/1000-time.time();need(0<remaining<=300,'assistant-original-deadline-exhausted')
    signal.alarm(max(1,min(90,int(remaining))))
    installation(binding)
    if mode=='session':runtime_identity(binding['runtime'],True)
    root=root_for(binding);create=mode=='session' and common.get('observeOnly') is False and not root.exists()
    root,anchor,deadline=checked_anchor(binding,create)
    import fcntl
    fd=os.open(root/'transport.lock',os.O_WRONLY|os.O_CREAT|os.O_NOFOLLOW,0o600);protected(root/'transport.lock',private=True)
    try:
        fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        signal.alarm(max(1,min(90,int(deadline-time.monotonic()))))
        if mode=='session':
            saved,sessionref,api=original_session(binding,common,root,deadline)
            current=ready(api,binding);check_ready(current,binding,initial=True)
            return {'deviceId':saved['deviceId'],'sessionReference':sessionref,'sessionSha256':sessionref['sha256'],'ready':current}
        saved=session_file(binding,common,root);api=Api(binding,deadline,saved['cookies']);current=ready(api,binding,mode=='observe');check_ready(current,binding,common['session']['readiness'])
        if mode=='ready':return current
        if mode=='post':
            check_effect_state(api,binding,common,current);return post_exact(api,root,binding,common)
        if mode=='draft':
            snapshot=api.read('/api/snapshot');need(snapshot.get('epoch')==binding['input']['installedHealth']['epoch'] and snapshot.get('deviceId')==saved['deviceId'],'assistant-draft-snapshot-identity-changed')
            rows=[d for d in snapshot['drafts'] if d['id']==common['draftId']];need(len(rows)==1,'assistant-original-draft-missing');return rows[0]
        c=common['conversation'];submission=common['submission'];need(uid(c['id']) and uid(submission['requestId']) and submission['conversationId']==c['id'],'assistant-observation-identity-invalid')
        matches=[o for o in current['state']['operations'] if o.get('requestId')==submission['requestId'] and o.get('conversationId')==c['id']];need(len(matches)<=1,'assistant-original-submit-not-unique')
        history=api.read('/api/assistant/reconcile/'+c['id']) if matches else None
        final=ready(api,binding,True);check_ready(final,binding,common['session']['readiness'])
        matches=[o for o in final['state']['operations'] if o.get('requestId')==submission['requestId'] and o.get('conversationId')==c['id']];need(len(matches)<=1,'assistant-original-submit-not-unique')
        return {'ready':final,'operation':matches[0] if matches else None,'history':history}
    finally:signal.alarm(0);os.close(fd)
def invoke(payload):
    try:return {'ok':True,'value':main(payload)}
    except Exception as e:
        detail={'mode':payload.get('mode'),'exceptionType':type(e).__name__[:100],'message':str(e)[:2000],'status':getattr(e,'http_status',None),'code':getattr(e,'api_code',None),'response':getattr(e,'private_response',None)}
        stored=None
        try:
            root=root_for(payload['binding']);protected(root,True,True);stored=save(root/('failure-'+str(uuid.uuid4())+'.json'),detail)
        except Exception:pass
        return {'ok':False,'reason':'assistant-original-transport-refused','code':detail['code'],'status':detail['status'],'privateDiagnostic':detail,'hostDiagnostic':stored}
