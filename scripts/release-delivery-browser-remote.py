"""Fixed root caller for one bounded unprivileged browser operation.

DATA is supplied by the maintained local transport, never a shell command.
The caller creates no account, installs no package and changes no existing ACL.
"""
import base64, hashlib, json, os, pathlib, re, signal, subprocess, time, uuid, shutil

NAMES = ('release-delivery-browser-primitives.mjs', 'release-delivery-browser-checks.mjs', 'release-delivery-browser-remote-worker.mjs')
MEMORY_MAX_BYTES = 2 * 1024**3
HOST_RESERVE_BYTES = 2147483648
def need(value, reason):
    if not value: raise RuntimeError(reason)
def available_memory():
    match=re.search(r'^MemAvailable:\s+(\d+) kB$',pathlib.Path('/proc/meminfo').read_text(),re.M)
    need(match is not None,'browser-remote-memory-unavailable')
    return int(match.group(1))*1024
def memory_admission(mode, existing, sample=available_memory):
    if mode not in ('plan','readiness') and (mode!='start' or existing):return None
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
def browser_session_scope(root,binding):
    operation=str(uuid.UUID(binding['operationId']))
    need(operation==binding['operationId'],'browser-remote-input-invalid')
    session=binding.get('sessionId',operation)
    need(str(uuid.UUID(session))==session and ('sessionId' not in binding or session!=operation),'browser-successor-session-invalid')
    return session,pathlib.Path(root)/session,'nova-browser-'+session

def verify_browser_reservation(original,binding,grant):
    reservation=grant.get('browserReservation')
    if reservation is None:return
    need(isinstance(reservation,dict) and set(reservation)=={'sessionId','startedAtMs','deadlineAtMs'}
         and reservation['sessionId']==binding['sessionId'] and binding['options']['timeoutMs']==1800000
         and type(reservation['startedAtMs'])==int and reservation['startedAtMs']==grant['issuedAtMs']
         and type(reservation['deadlineAtMs'])==int and reservation['deadlineAtMs']==reservation['startedAtMs']+1800000
         and reservation['deadlineAtMs']<=grant['expiresAtMs']
         and original['startedAtMs']==reservation['startedAtMs'] and original['deadlineAtMs']==reservation['deadlineAtMs'],
         'browser-window-reservation-changed')

def returned_browser_expiry(directory, before, active, state, owned, files, rows=None):
    operation=before['binding']['operationId'];unit='nova-browser-'+operation+'.service'
    deadline=before['deadlineAtMs'];now=time.time_ns()//1000000
    need(active['operationId']==operation and active['originalSha256']==digest(canonical(before)+b'\n')
         and active['deadlineAtMs']==deadline and before['startedAtMs']<=active['observedAtMs']<deadline<=now
         and active['unit']==unit and active['controlGroup']=='/system.slice/'+unit and active['memberVerified'] is True
         and active['killMode']=='control-group' and active['memoryHighBytes']==1476395008 and active['memoryMaxBytes']==2147483648
         and active['bootId']==pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()
         and re.fullmatch('[a-f0-9]{32}',active['invocationId']),'browser-expiry-original-owner-changed')
    owner=files['worker-identity'];launch=files['launch-result']
    need(files['prepared'] and not files['acceptance'] and owner['operationId']==operation and owner['originalSha256']==active['originalSha256']
         and owner['pid']==active['mainPid'] and launch['returncode']==0 and '--unit='+unit[:-8] in launch['argv']
         and active['runtimeMaxUsec']>0 and active['runtimeMaxUsec']%1000000==0
         and '--property=RuntimeMaxSec='+str(active['runtimeMaxUsec']//1000000) in launch['argv']
         and '--property=KillMode=control-group' in launch['argv'] and not os.path.lexists(directory/'accept-request.json')
         and not os.path.lexists(directory/'close-request.json'),'browser-expiry-original-request-changed')
    need(not owned and 'MainPID=0\n' in state and re.search(r'ActiveState=(inactive|failed)\n',state),'browser-expiry-unit-not-closed')
    process=pathlib.Path('/proc')/str(active['mainPid'])/'stat'
    try:need(int(process.read_text().rsplit(')',1)[1].split()[19])!=active['processStartTicks'],'browser-expiry-original-process-alive')
    except (FileNotFoundError,ProcessLookupError):pass
    cg=pathlib.Path('/sys/fs/cgroup')/active['controlGroup'].lstrip('/')
    if cg.exists():
        need('populated 0' in (cg/'cgroup.events').read_text().splitlines() and not (cg/'cgroup.procs').read_text().strip(),'browser-expiry-cgroup-still-populated')
    fail=files['failed'];closed=files['closed']
    if fail:need(fail.get('operationId')==operation and fail.get('reason')=='browser-original-deadline-exhausted'
                 and deadline<=fail['atMs']<=now,'browser-expiry-different-worker-failure')
    if closed:need(closed.get('operationId')==operation and closed['browserClosed'] is True and closed['tunnelClosed'] is True
                   and deadline<=closed['atMs']<=now,'browser-expiry-different-worker-close')
    proof={'active':active,'originalProcessClosed':True,'groupEmpty':True,'noAcceptanceRequest':True}
    if fail and closed:
        need(closed['atMs']>=fail['atMs'],'browser-expiry-close-order-changed')
        return dict(proof,termination='worker-deadline')
    if rows is None:
        argv=['/usr/bin/journalctl','--no-pager','--output=json','--lines=80','--boot='+active['bootId'],'--unit='+unit,
              '--since=@'+str((before['startedAtMs']-5000)//1000),'--until=@'+str((deadline+20000)//1000),'_PID=1']
        output=subprocess.check_output(argv,timeout=12)
        need(0<len(output)<=512*1024,'browser-expiry-journal-bounds')
        rows=[json.loads(line) for line in output.splitlines()]
    events=manager_timeout_entries(rows,active)
    return dict(proof,termination='systemd-runtime-limit',events=events)

def manager_timeout_entries(rows,active):
    unit=active['unit'];deadline=active['deadlineAtMs'];runtime=active['runtimeMaxUsec']
    start=active['activeEnterMonotonicUsec'];boot=active['bootId'].replace('-','')
    events={};captured_start=False;needs_anchor=False
    for row in rows:
        message=row.get('MESSAGE','')
        if row.get('_PID')!='1' or row.get('_BOOT_ID')!=boot or row.get('UNIT')!=unit or not isinstance(message,str):continue
        inv=row.get('INVOCATION_ID') or row.get('OBJECT_SYSTEMD_INVOCATION_ID')
        mono=int(row['__MONOTONIC_TIMESTAMP'])
        if inv and mono>=start-1000000:need(inv==active['invocationId'],'browser-expiry-journal-invocation-changed')
        if row.get('MESSAGE_ID')=='39f53479d3a045ac8e11786248231fbf':
            anchors=[r for r in active.get('managerJournal',[]) if r.get('category')=='started' and r.get('UNIT')==unit
                     and r.get('_PID')=='1' and r.get('INVOCATION_ID')==active['invocationId'] and r.get('_BOOT_ID')==boot]
            need(not captured_start and inv==active['invocationId'] and any(r['__MONOTONIC_TIMESTAMP']==row['__MONOTONIC_TIMESTAMP']
                 and r['__REALTIME_TIMESTAMP']==row['__REALTIME_TIMESTAMP'] for r in anchors),'browser-expiry-journal-start-changed')
            captured_start=True
        reason=message.removeprefix(unit+': ')
        role='elapsed' if reason=='Service reached runtime time limit. Stopping.' else 'failed' if reason=="Failed with result 'timeout'." else None
        if not role:continue
        if not inv:needs_anchor=True
        real=int(row['__REALTIME_TIMESTAMP']);mono=int(row['__MONOTONIC_TIMESTAMP'])
        need(deadline*1000-5000000<=real<=deadline*1000+20000000 and start+runtime-5000000<=mono<=start+runtime+20000000
             and role not in events,'browser-expiry-journal-time-changed')
        events[role]={'realtimeUsec':real,'monotonicUsec':mono}
    need((captured_start or not needs_anchor) and set(events)=={'elapsed','failed'} and events['elapsed']['monotonicUsec']<=events['failed']['monotonicUsec'],
         'browser-expiry-authenticated-timeout-unavailable')
    return events

def main(data):
    import pwd
    need(os.geteuid()==0,'browser-remote-root-required')
    mode=data['mode'];need(mode in ('readiness','plan','start','status','request','close','screenshot','cleanup','expiry'),'browser-remote-mode-invalid')
    original=data['original'];binding=original['binding'];options=binding['options'];operation=str(uuid.UUID(binding['operationId']))
    need(operation==binding['operationId'] and options['mode']=='remote' and options['baseUrl']=='http://127.0.0.1:4383','browser-remote-input-invalid')
    need(re.fullmatch(r'[a-z][a-z0-9_-]{0,31}',options['user']) and re.fullmatch(r'/opt/[a-z][a-z0-9-]{1,63}',options['directoryRoot']),'browser-remote-scope-invalid')
    who=pwd.getpwnam(options['user']);need(who.pw_uid>0,'browser-remote-user-must-be-unprivileged')
    root=pathlib.Path(options['directoryRoot']);protected(root,True)
    need(root.stat().st_gid==who.pw_gid and root.stat().st_mode&0o777==0o750,'browser-remote-parent-access-changed')
    session,path,unit=browser_session_scope(root,binding)
    unit_state=lambda: subprocess.run(['systemctl','show',unit+'.service','--property=ActiveState,SubState,MainPID,ExecMainStatus'],capture_output=True,text=True,timeout=10).stdout
    if session!=operation:
        lineage=binding.get('browserPredecessor');grant=binding.get('publicationContinuation')
        need(isinstance(lineage,dict) and set(lineage)=={'original','status'} and isinstance(grant,dict) and set(grant) in ({'request','issuedAtMs','expiresAtMs','browserReservation'},{'request','issuedAtMs','expiresAtMs'},{'request','issuedAtMs','expiresAtMs','returnedBrowser'}),'browser-successor-lineage-invalid')
        verify_browser_reservation(original,binding,grant)
        for ref in (lineage['original'],lineage['status'],grant['request']):need(isinstance(ref,dict) and set(ref)=={'path','sha256'} and re.fullmatch('[a-f0-9]{64}',ref['sha256']),'browser-successor-reference-invalid')
        predecessor=root/operation
        need(predecessor.is_dir() and not predecessor.is_symlink(),'browser-successor-predecessor-missing')
        before=json_file(predecessor/'original.json')
        need((predecessor/'original.json').stat().st_uid==0 and digest(canonical(before)+b'\n')==lineage['original']['sha256'],'browser-successor-predecessor-changed')
        base={k:v for k,v in binding.items() if k not in ('sessionId','browserPredecessor','publicationContinuation')}
        need(before['binding']==base and original['startedAtMs']>=before['deadlineAtMs'] and original['startedAtMs']>=grant['issuedAtMs'] and original['deadlineAtMs']<=grant['expiresAtMs'],'browser-successor-target-or-clock-changed')
        if mode in ('readiness','plan','start'):
            failed=json_file(predecessor/'failed.json');closed=json_file(predecessor/'closed.json')
            if 'returnedBrowser' not in grant:
                need(failed and failed.get('operationId')==operation and failed.get('reason')=='browser-original-deadline-exhausted' and closed and closed.get('operationId')==operation and closed.get('browserClosed') is True and closed.get('tunnelClosed') is True and not json_file(predecessor/'acceptance.json'),'browser-successor-closed-predecessor-required')
            old_unit='nova-browser-'+operation+'.service'
            old_state=subprocess.run(['systemctl','show',old_unit,'--property=ActiveState,MainPID'],capture_output=True,text=True,timeout=10).stdout
            need(re.search(r'ActiveState=(inactive|failed)\n',old_state) and 'MainPID=0\n' in old_state,'browser-successor-predecessor-unit-active')
            for proc in pathlib.Path('/proc').iterdir():
                if proc.name.isdigit():
                    try:need(old_unit not in (proc/'cgroup').read_text(),'browser-successor-predecessor-process-active')
                    except (FileNotFoundError,ProcessLookupError):pass
            if 'returnedBrowser' in grant:
                h=grant['returnedBrowser']
                need(session==str(uuid.uuid5(uuid.UUID(operation),'returned-publication-browser')) and 'browserReservation' not in grant
                     and h['prepared']['sha256']==digest((predecessor/'prepared.json').read_bytes()),'browser-expiry-returned-handoff-changed')
                files={n:json_file(predecessor/(n+'.json')) for n in ('worker-identity','launch-result','prepared','failed','closed','acceptance')}
                need(returned_browser_expiry(predecessor,before,h['expiry']['active'],old_state,[],files)==h['expiry'],'browser-expiry-returned-owner-changed')
    original_bytes=canonical(original)+b'\n'
    source={name:base64.b64decode(data['sources'][name]['base64'],validate=True) for name in NAMES}
    for name,value in source.items():need(len(value)<262144 and digest(value)==data['sources'][name]['sha256'],'browser-remote-worker-source-changed')
    worker_sha=digest(canonical({name:digest(source[name]) for name in NAMES}));tool=root/('worker-'+worker_sha)
    plan={'format':1,'kind':'nova-remote-browser-plan','operationId':operation,'directory':str(path),'unit':unit,'uid':who.pw_uid,'gid':who.pw_gid,
          'workerSha256':worker_sha,'originalSha256':digest(original_bytes),'node':options['node'],'executable':options['executable'],'playwrightSha256':options['playwright']['sha256'],
          'memoryMaxBytes':MEMORY_MAX_BYTES,'hostReserveBytes':HOST_RESERVE_BYTES}
    if session!=operation:plan['sessionId']=session
    if 'windowPolicy' in binding:plan['windowPolicy']=binding['windowPolicy']
    if mode in ('readiness','plan','start'):
        need((mode=='readiness' or time.time()*1000<original['deadlineAtMs']) and original['deadlineAtMs']==original['startedAtMs']+options['timeoutMs'] and 300000<=options['timeoutMs']<=1800000,'browser-original-deadline-exhausted')
        bytes_ref(options['node']);bytes_ref(options['executable'],536870912)
        closure=base64.b64decode(data['closure'],validate=True);need(digest(closure)==options['playwright']['sha256'],'browser-remote-closure-changed')
        manifest=json.loads(closure)
        need(manifest['format']==1 and len(manifest['files'])<5000,'browser-remote-closure-invalid')
        for ref in manifest['files']:bytes_ref(ref,67108864)
        need(any(ref['path']==manifest['entry'] for ref in manifest['files']),'browser-remote-entry-unbound')
        if mode=='readiness':
            need(session!=operation and 'browserReservation' not in binding['publicationContinuation'] and not path.exists(),'browser-window-recovery-session-already-exists')
            state=unit_state()
            need(re.search(r'ActiveState=(inactive|failed)\n',state) and 'MainPID=0\n' in state,'browser-window-recovery-session-unit-active')
            for proc in pathlib.Path('/proc').iterdir():
                if proc.name.isdigit():
                    try:need((unit+'.service') not in (proc/'cgroup').read_text(),'browser-window-recovery-session-process-active')
                    except (FileNotFoundError,ProcessLookupError):pass
            return {'state':'ready','plan':plan,'planSha256':digest(canonical(plan)),'existingOperation':False,'sessionAbsent':True,'hostWrites':False,'memoryAdmission':memory_admission(mode,False)}
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
           'memory-tools-verified','memory-first-page-ready','memory-prior-draft-ready','memory-second-page-opened','memory-second-page-ready','memory-new-page-ready','memory-old-page-reloaded','memory-saved-reply-visible','memory-browser-closed')}
    owned=[]
    for proc in pathlib.Path('/proc').iterdir():
        if proc.name.isdigit():
            try:
                if (unit+'.service') in (proc/'cgroup').read_text():owned.append(int(proc.name))
            except (FileNotFoundError,ProcessLookupError,PermissionError):pass
    state=unit_state()
    if mode=='expiry':
        need(session==operation,'browser-expiry-original-session-required')
        return {'state':'observed','operationId':operation,'files':files,'unitState':state,'ownedPids':owned,'originalSha256':plan['originalSha256'],
                'expiry':returned_browser_expiry(path,original,data['active'],state,owned,files),'observedAtMs':int(time.time()*1000)}
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
