"""Fixed root caller for one bounded unprivileged browser operation.

DATA is supplied by the maintained local transport, never a shell command.
The caller creates no account, installs no package and changes no existing ACL.
"""
import base64, hashlib, json, os, pathlib, re, signal, subprocess, time, uuid, shutil

NAMES = ('release-delivery-browser-primitives.mjs', 'release-delivery-browser-checks.mjs', 'release-delivery-browser-remote-worker.mjs')
MEMORY_MAX_BYTES = 1073741824
HOST_RESERVE_BYTES = 2147483648
def need(value, reason):
    if not value: raise RuntimeError(reason)
def available_memory():
    match=re.search(r'^MemAvailable:\s+(\d+) kB$',pathlib.Path('/proc/meminfo').read_text(),re.M)
    need(match is not None,'browser-remote-memory-unavailable')
    return int(match.group(1))*1024
def memory_admission(mode, existing, sample=available_memory):
    if mode!='plan' and (mode!='start' or existing):return None
    available=sample()
    need(type(available)==int and available>=MEMORY_MAX_BYTES+HOST_RESERVE_BYTES,'browser-remote-memory-headroom-insufficient')
    return {'availableBytes':available,'requiredBytes':MEMORY_MAX_BYTES+HOST_RESERVE_BYTES,'atMs':int(time.time()*1000)}
def canonical(value): return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()
def digest(value): return hashlib.sha256(value).hexdigest()
def protected(path, directory=False):
    path = pathlib.Path(path)
    for part in (path, *path.parents):
        st = part.lstat()
        need(not part.is_symlink() and st.st_uid == 0 and st.st_mode & 0o022 == 0, 'browser-remote-unprotected-path')
    need(path.is_dir() if directory else path.is_file(), 'browser-remote-path-kind')
    return path
def bytes_ref(ref, maximum=134217728):
    path=protected(ref['path']); need(path.stat().st_size<=maximum, 'browser-remote-file-too-large')
    value=path.read_bytes();need(digest(value)==ref['sha256'],'browser-remote-file-changed');return value
def exact(path, value, uid=0, gid=0, mode=0o640):
    if path.exists(): need(not path.is_symlink() and path.read_bytes()==value, 'browser-remote-original-file-changed'); return
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,mode)
    try: os.fchown(fd,uid,gid);os.write(fd,value);os.fsync(fd)
    finally: os.close(fd)
def directory(path, uid, gid, mode):
    if not path.exists():path.mkdir(mode=mode);os.chown(path,uid,gid)
    st=path.lstat();need(path.is_dir() and not path.is_symlink() and st.st_uid==uid and st.st_gid==gid and st.st_mode&0o777==mode,'browser-remote-directory-changed')
def json_file(path):
    if not path.exists():return None
    need(path.is_file() and not path.is_symlink() and path.stat().st_size<2097152,'browser-remote-result-not-bounded-file')
    return json.loads(path.read_bytes())
def main(data):
    import pwd
    need(os.geteuid()==0,'browser-remote-root-required')
    mode=data['mode'];need(mode in ('plan','start','status','request','close','screenshot','cleanup'),'browser-remote-mode-invalid')
    original=data['original'];binding=original['binding'];options=binding['options'];operation=str(uuid.UUID(binding['operationId']))
    need(operation==binding['operationId'] and options['mode']=='remote' and options['baseUrl']=='http://127.0.0.1:4383','browser-remote-input-invalid')
    need(re.fullmatch(r'[a-z][a-z0-9_-]{0,31}',options['user']) and re.fullmatch(r'/opt/[a-z][a-z0-9-]{1,63}',options['directoryRoot']),'browser-remote-scope-invalid')
    who=pwd.getpwnam(options['user']);need(who.pw_uid>0,'browser-remote-user-must-be-unprivileged')
    root=pathlib.Path(options['directoryRoot']);protected(root,True)
    need(root.stat().st_gid==who.pw_gid and root.stat().st_mode&0o777==0o750,'browser-remote-parent-access-changed')
    path=root/operation;unit='nova-browser-'+operation;unit_state=lambda: subprocess.run(['systemctl','show',unit+'.service','--property=ActiveState,SubState,MainPID,ExecMainStatus'],capture_output=True,text=True,timeout=10).stdout
    original_bytes=canonical(original)+b'\n'
    source={name:base64.b64decode(data['sources'][name]['base64'],validate=True) for name in NAMES}
    for name,value in source.items():need(len(value)<262144 and digest(value)==data['sources'][name]['sha256'],'browser-remote-worker-source-changed')
    worker_sha=digest(canonical({name:digest(source[name]) for name in NAMES}));tool=root/('worker-'+worker_sha)
    plan={'format':1,'kind':'nova-remote-browser-plan','operationId':operation,'directory':str(path),'unit':unit,'uid':who.pw_uid,'gid':who.pw_gid,
          'workerSha256':worker_sha,'originalSha256':digest(original_bytes),'node':options['node'],'executable':options['executable'],'playwrightSha256':options['playwright']['sha256'],
          'memoryMaxBytes':MEMORY_MAX_BYTES,'hostReserveBytes':HOST_RESERVE_BYTES}
    if mode in ('plan','start'):
        need(time.time()*1000<original['deadlineAtMs'] and original['deadlineAtMs']==original['startedAtMs']+options['timeoutMs'] and 300000<=options['timeoutMs']<=1800000,'browser-original-deadline-exhausted')
        bytes_ref(options['node']);bytes_ref(options['executable'],536870912)
        closure=base64.b64decode(data['closure'],validate=True);need(digest(closure)==options['playwright']['sha256'],'browser-remote-closure-changed')
        manifest=json.loads(closure)
        need(manifest['format']==1 and len(manifest['files'])<5000,'browser-remote-closure-invalid')
        for ref in manifest['files']:bytes_ref(ref,67108864)
        need(any(ref['path']==manifest['entry'] for ref in manifest['files']),'browser-remote-entry-unbound')
        if mode=='plan':return {'state':'planned','plan':plan,'planSha256':digest(canonical(plan)),'existingOperation':path.exists(),'memoryAdmission':memory_admission(mode,path.exists())}
        need(data['intent']=={'operationId':operation,'planSha256':digest(canonical(plan)),'originalSha256':plan['originalSha256']},'browser-remote-intent-changed')
        # A retained launch reservation is observation-only, even if no unit exists.
        if not path.exists():
            admission=memory_admission(mode,False)
            directory(tool,0,who.pw_gid,0o750)
            for name,value in source.items():exact(tool/name,value,gid=who.pw_gid)
            directory(path,who.pw_uid,who.pw_gid,0o700)
            exact(path/'original.json',original_bytes,gid=who.pw_gid)
            exact(path/'playwright-closure.json',closure,gid=who.pw_gid)
            exact(path/'launch-intent.json',canonical(data['intent'])+b'\n',gid=who.pw_gid)
            exact(path/'memory-admission.json',canonical(admission)+b'\n',gid=who.pw_gid)
            remaining=max(1,int((original['deadlineAtMs']-time.time()*1000)/1000))
            argv=['systemd-run','--quiet','--collect','--unit='+unit,'--uid='+options['user'],'--gid='+str(who.pw_gid),
                  '--property=RuntimeMaxSec='+str(remaining),'--property=TimeoutStopSec=15','--property=KillMode=control-group',
                  '--property=MemoryMax='+str(MEMORY_MAX_BYTES),'--working-directory='+str(path),'--setenv=HOME='+str(path),
                  '--setenv=XDG_CONFIG_HOME='+str(path/'config'),'--setenv=XDG_CACHE_HOME='+str(path/'cache'),
                  options['node']['path'],str(tool/NAMES[-1]),str(path/'original.json')]
            result=subprocess.run(argv,capture_output=True,text=True,timeout=15)
            exact(path/'launch-result.json',canonical({'returncode':result.returncode,'stderr':result.stderr[:2000],'argv':argv})+b'\n',gid=who.pw_gid)
    need(path.exists(),'browser-remote-original-operation-missing');directory(path,who.pw_uid,who.pw_gid,0o700)
    need(json_file(path/'original.json')==original and (path/'original.json').stat().st_uid==0,'browser-remote-original-operation-missing')
    need(json_file(path/'launch-intent.json')=={'operationId':operation,'planSha256':digest(canonical(plan)),'originalSha256':plan['originalSha256']},'browser-remote-launch-intent-changed')
    if mode=='request':
        need(time.time()*1000<original['deadlineAtMs'],'browser-original-deadline-exhausted')
        request=data['request'];need(request['input']['operationId']==operation,'browser-remote-request-operation-changed')
        exact(path/'accept-request.json',canonical(request)+b'\n',gid=who.pw_gid)
    if mode=='close':exact(path/'close-request.json',canonical({'operationId':operation})+b'\n',gid=who.pw_gid)
    if mode=='screenshot':
        need(json_file(path/'acceptance.json') is not None,'browser-remote-acceptance-not-complete')
        screenshot=path/'accepted-ui.png';need(not screenshot.is_symlink() and screenshot.is_file() and screenshot.stat().st_size<=16777216,'browser-remote-screenshot-invalid')
        value=screenshot.read_bytes();offset=data['offset'];need(type(offset)==int and 0<=offset<len(value),'browser-remote-screenshot-offset-invalid')
        return {'state':'screenshot','sha256':digest(value),'bytes':len(value),'offset':offset,'base64':base64.b64encode(value[offset:offset+49152]).decode()}
    files={name:json_file(path/(name+'.json')) for name in ('prepared','heartbeat','failed','closed','acceptance','worker-identity','launch-result','memory-admission',
           'memory-tools-verified','memory-first-page-ready','memory-second-page-opened','memory-second-page-ready','memory-browser-closed')}
    owned=[]
    for proc in pathlib.Path('/proc').iterdir():
        if proc.name.isdigit():
            try:
                if (unit+'.service') in (proc/'cgroup').read_text():owned.append(int(proc.name))
            except (FileNotFoundError,ProcessLookupError,PermissionError):pass
    state=unit_state()
    if mode=='cleanup':
        need(not owned and re.search(r'ActiveState=(inactive|failed)\n',state) and 'MainPID=0\n' in state and files['closed']
             and files['closed'].get('browserClosed') is True and not files['failed'],'browser-remote-cleanup-not-closed')
        if files['acceptance']:
            need(digest((path/'acceptance.json').read_bytes())==data.get('acceptanceSha256'),'browser-remote-cleanup-acceptance-changed')
        else:need(json_file(path/'close-request.json')=={'operationId':operation} and files['prepared'],'browser-remote-cleanup-no-completed-test')
        prior=json_file(path/'cleanup.json')
        if prior:return {'state':'cleaned','cleanup':prior}
        removed=[];allocated=0
        for name in ('profile','config','cache'):
            disposable=path/name
            if not disposable.exists():continue
            need(disposable.is_dir() and not disposable.is_symlink() and disposable.parent==path and disposable.stat().st_uid==who.pw_uid,'browser-remote-disposable-scope-changed')
            for current,dirs,names in os.walk(disposable,followlinks=False):
                for child in names:
                    entry=pathlib.Path(current)/child
                    try:allocated+=entry.lstat().st_blocks*512
                    except FileNotFoundError:pass
            shutil.rmtree(disposable);need(not disposable.exists(),'browser-remote-disposable-removal-incomplete');removed.append(name)
        report={'operationId':operation,'removed':removed,'removedAllocatedBytes':allocated,'evidencePreserved':True,'atMs':int(time.time()*1000)}
        exact(path/'cleanup.json',canonical(report)+b'\n',gid=who.pw_gid);return {'state':'cleaned','cleanup':report}
    return {'state':'observed','operationId':operation,'files':files,'unitState':state,'ownedPids':owned,'originalSha256':plan['originalSha256'],
            'observedAtMs':int(time.time()*1000)}
if __name__=='__main__':
    signal.alarm(90)
    try:print(json.dumps(main(DATA),separators=(',',':'),ensure_ascii=False))
    except Exception as error:
        reason=str(error) if re.fullmatch(r'[a-z][a-z0-9-]{0,99}',str(error)) else 'browser-remote-caller-rejected'
        print(json.dumps({'state':'gap','reason':reason}));raise SystemExit(2)
