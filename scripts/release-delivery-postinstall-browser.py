"""One scoped post-install browser observation; no application or Assistant dispatch."""
import base64,hashlib,json,os,pathlib,pwd,re,signal,sqlite3,stat,subprocess,time,urllib.request,urllib.parse
P=pathlib.Path
MEMORY_MAX=2147483648
HOST_RESERVE=2147483648
def need(v,r):
    if not v:raise RuntimeError(r)
def enc(v):return json.dumps(v,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
def sha(v):return hashlib.sha256(v).hexdigest()
def load(p):return json.loads(P(p).read_bytes())
def meta(s):return (s.st_dev,s.st_ino,s.st_mode,s.st_uid,s.st_gid,s.st_nlink,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
def verified(ref,limit=2097152):
    p=P(ref['path']);need(p.is_absolute() and not p.is_symlink() and p.is_file() and p.stat().st_size<=limit,'postinstall-reference-bound')
    b=p.read_bytes();need(sha(b)==ref['sha256'],'postinstall-reference-changed');return b
def exact(p,value,uid=0,gid=0):
    raw=enc(value)+b'\n'
    if p.exists():need(not p.is_symlink() and p.read_bytes()==raw,'postinstall-existing-file-changed');return
    fd=os.open(p,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o640)
    try:os.fchown(fd,uid,gid);os.write(fd,raw);os.fsync(fd)
    finally:os.close(fd)
def inventory(profile,owner):
    root=profile.lstat();need(stat.S_ISDIR(root.st_mode) and not stat.S_ISLNK(root.st_mode) and root.st_uid==owner,'postinstall-profile-boundary')
    rows=[];logical=0;allocated=0
    for line in P('/proc/self/mountinfo').read_text().splitlines():need(not line.split()[4].startswith(str(profile)+'/'),'postinstall-profile-nested-mount')
    def walk(current,relative,parent_fd=None,child_name=None):
        nonlocal logical,allocated
        fd=os.open(current if parent_fd is None else child_name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_NOATIME,dir_fd=parent_fd)
        try:
            before=os.fstat(fd);need(before.st_dev==root.st_dev and before.st_uid==owner,'postinstall-profile-directory-boundary')
            if parent_fd is None:need(meta(before)==meta(root),'postinstall-profile-root-raced')
            with os.scandir(fd) as scan:names=sorted(e.name for e in scan)
            for name in names:
                s=os.stat(name,dir_fd=fd,follow_symlinks=False);rel=(relative+'/' if relative else '')+name
                need(len(rows)<20000 and s.st_dev==root.st_dev and s.st_uid==owner,'postinstall-profile-entry-boundary')
                row={'path':rel,'metadata':list(meta(s)),'allocatedBytes':s.st_blocks*512};allocated+=s.st_blocks*512
                if stat.S_ISLNK(s.st_mode):need(relative=='' and name in ('SingletonLock','SingletonCookie','SingletonSocket'),'postinstall-profile-symlink-refused');row['kind']='singleton-link'
                elif stat.S_ISDIR(s.st_mode):row['kind']='directory';rows.append(row);walk(current/name,rel,fd,name);continue
                else:
                    need(stat.S_ISREG(s.st_mode) and s.st_size<=536870912 and s.st_nlink==1,'postinstall-profile-file-boundary');logical+=s.st_size;need(logical<=2147483648,'postinstall-profile-logical-bound')
                    content=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NOATIME,dir_fd=fd)
                    try:
                        need(meta(os.fstat(content))==meta(s),'postinstall-profile-file-raced');h=hashlib.sha256()
                        while True:
                            block=os.read(content,1048576)
                            if not block:break
                            h.update(block)
                        need(meta(os.fstat(content))==meta(s),'postinstall-profile-file-changed')
                    finally:os.close(content)
                    row.update(kind='file',sha256=h.hexdigest())
                rows.append(row)
            need(meta(os.fstat(fd))==meta(before),'postinstall-profile-directory-changed')
        finally:os.close(fd)
    walk(profile,'');need(meta(profile.lstat())==meta(root),'postinstall-profile-root-changed')
    return {'path':str(profile),'inventorySha256':sha(enc(rows)),'logicalBytes':logical,'allocatedBytes':allocated,'entryCount':len(rows),'rows':rows}
def old_status(data):
    helper=base64.b64decode(data['legacyHelper']['base64']);need(sha(helper)==data['legacyHelper']['sha256'],'postinstall-status-source-changed');ns={'__name__':'postinstall_original_status'};exec(compile(helper,'frozen-browser-status','exec'),ns)
    def existing(p,uid,gid,mode):
        s=p.lstat();need(stat.S_ISDIR(s.st_mode) and not stat.S_ISLNK(s.st_mode) and s.st_uid==uid and s.st_gid==gid and stat.S_IMODE(s.st_mode)==mode,'postinstall-original-directory-changed')
    ns['directory']=existing
    def deny(*args,**kwargs):raise RuntimeError('postinstall-status-write-forbidden')
    ns['exact']=deny;status=ns['main'](data['legacy'])
    need(status['originalSha256']==data['input']['original']['sha256'] and re.search(r'ActiveState=(inactive|failed)\n',status['unitState']) and 'MainPID=0\n' in status['unitState'] and status['ownedPids']==[],'postinstall-original-unit-not-closed')
    for key,ref in data['failure'].items():
        name='memory-browser-closed' if key=='memory' else key;need(sha(enc(status['files'][name])+b'\n')==ref['sha256'],'postinstall-failure-evidence-changed')
    need(not status['files']['acceptance'],'postinstall-unexpected-original-acceptance');return status
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):raise RuntimeError('postinstall-redirect-refused')
def live(data):
    ref=data['hostConfig'];need(ref['path']=='/etc/nova-update/config.json','postinstall-host-config-scope');config=json.loads(verified(ref,65536))
    for p in (P(ref['path']),*P(ref['path']).parents):need(p.lstat().st_uid==0 and not p.is_symlink() and p.lstat().st_mode&0o022==0,'postinstall-host-config-unprotected')
    workspace=P(config['workspaceDirectory']);db=workspace/'workspace.sqlite';need(db.resolve()==db and db.is_file() and not db.is_symlink(),'postinstall-session-database-path')
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
    def get(path):
        with opener.open('http://127.0.0.1:4383'+path,timeout=15) as response:
            need(response.status==200,'postinstall-health-unavailable');b=response.read(131073);need(len(b)<=131072,'postinstall-health-bound');return json.loads(b)
    h=get('/api/health');access=get('/api/access/context');expected=data['input']['installed']['installedHealth']
    for key in ('candidateId','processIdentity','serviceInputsSha256','apiVersion','schemaVersion','frontend'):need(h.get(key)==expected.get(key),'postinstall-current-health-changed')
    need(h.get('status')=='ready' and access.get('workspaceEpoch')==expected['epoch'] and not access.get('recovery') and not access.get('recoveryLocal'),'postinstall-current-workspace-changed')
    before=db.stat();connection=sqlite3.connect('file:'+urllib.parse.quote(str(db))+'?mode=ro',uri=True,timeout=5)
    try:
        connection.execute('PRAGMA query_only=ON');rows=connection.execute('SELECT digest,device_id,expires FROM sessions WHERE expires>? ORDER BY digest LIMIT 257',(int(time.time()*1000),)).fetchall()
    finally:connection.close()
    need((db.stat().st_dev,db.stat().st_ino)==(before.st_dev,before.st_ino) and len(rows)<=256,'postinstall-session-database-changed-or-unbounded')
    sessions=[{'digest':digest,'deviceId':device,'expiresAtMs':expires} for digest,device,expires in rows]
    need(all(re.fullmatch('[a-f0-9]{64}',r['digest']) and re.fullmatch('[a-f0-9-]{36}',r['deviceId']) and type(r['expiresAtMs'])==int for r in sessions),'postinstall-session-row-invalid')
    return {'health':{k:h[k] for k in expected if k!='epoch'}|{'epoch':expected['epoch']},'sessions':sessions,'sessionDatabase':{'path':str(db),'device':before.st_dev,'inode':before.st_ino,'readOnly':True,'queryOnly':True}}
def unit_status(unit):
    result=subprocess.run(['/usr/bin/systemctl','show',unit,'--property=ActiveState,SubState,MainPID,ExecMainStatus'],capture_output=True,text=True,timeout=10)
    owned=[]
    for p in P('/proc').iterdir():
        if p.name.isdigit():
            try:
                if unit in (p/'cgroup').read_text():owned.append(int(p.name))
            except (FileNotFoundError,ProcessLookupError):pass
    return {'unitState':result.stdout,'ownedPids':owned}
def plan(data):
    status=old_status(data);options=data['legacy']['original']['binding']['options'];who=pwd.getpwnam(options['user']);profile=P(options['directoryRoot'])/data['legacy']['original']['binding']['sessionId']/'profile'
    info=inventory(profile,who.pw_uid);liveState=live(data);v=os.statvfs(profile);free=v.f_bavail*v.f_frsize
    for ref,limit in ((options['node'],134217728),(options['executable'],536870912)):verified(ref,limit)
    closure=base64.b64decode(data['legacy']['closure']);need(sha(closure)==options['playwright']['sha256'],'postinstall-playwright-closure-changed');manifest=json.loads(closure)
    need(manifest['format']==1 and 10<len(manifest['files'])<5000 and any(r['path']==manifest['entry'] for r in manifest['files']),'postinstall-playwright-closure-invalid')
    for ref in manifest['files']:verified(ref,67108864)
    match=re.search(r'^MemAvailable:\s+(\d+) kB$',P('/proc/meminfo').read_text(),re.M);need(match,'postinstall-memory-unavailable');available=int(match.group(1))*1024
    copyBytes=sum(((r['metadata'][6]+v.f_frsize-1)//v.f_frsize)*v.f_frsize if r['kind']=='file' else r['allocatedBytes'] for r in info['rows'])
    tmp=os.statvfs('/tmp');tmpFree=tmp.f_bavail*tmp.f_frsize;sameFs=os.stat('/tmp').st_dev==profile.stat().st_dev;tmpAllowance=134217728
    resources={'tmpAvailableBytes':tmpFree,'tmpSameFilesystem':sameFs,'tmpAllowanceBytes':tmpAllowance,'availableBytes':available,'browserMaxBytes':MEMORY_MAX,'hostReserveBytes':HOST_RESERVE,'filesystemAvailableBytes':free,'filesystemFreeInodes':v.f_favail,'cloneAllocationBytes':copyBytes,**data['capacity']}
    need(available>=MEMORY_MAX+HOST_RESERVE and free>=copyBytes+data['capacity']['workingAllowanceBytes']+data['capacity']['diskReserveBytes']+(tmpAllowance if sameFs else 0) and (sameFs or tmpFree>=tmpAllowance+data['capacity']['diskReserveBytes']) and v.f_favail>info['entryCount']+128,'postinstall-browser-capacity-insufficient')
    sid=data['sessionId'];need(re.fullmatch('[a-f0-9-]{36}',sid) and sid!=data['legacy']['original']['binding']['sessionId'],'postinstall-session-invalid')
    target=P(options['directoryRoot'])/('current-'+sid);need(not target.exists(),'postinstall-recovery-already-reserved')
    clean=unit_status('nova-browser-current-'+sid+'.service');need(re.search(r'ActiveState=(inactive|failed)\n',clean['unitState']) and 'MainPID=0\n' in clean['unitState'] and not clean['ownedPids'],'postinstall-recovery-unit-active')
    return {'format':1,'kind':'nova-postinstall-browser-readiness','operationId':data['input']['operationId'],'sessionId':sid,'inputSha256':sha(enc(data['input'])),'requestSha256':data['requestSha256'],'observedAtMs':int(time.time()*1000),'profile':{k:v for k,v in info.items() if k!='rows'},'resources':resources,**liveState,'originalClosed':True,'remoteRecoveryAbsent':True,'hostWrites':False}
def main(data):
    need(os.geteuid()==0 and data['mode'] in ('plan','start','status','screenshot'),'postinstall-exact-mode-required');options=data['legacy']['original']['binding']['options'];who=pwd.getpwnam(options['user']);root=P(options['directoryRoot']);sid=data['sessionId'];directory=root/('current-'+sid);unit='nova-browser-current-'+sid+'.service'
    if data['mode']=='plan':return plan(data)
    authority=data['authority'];need(authority['sessionId']==sid and authority['operationId']==data['input']['operationId'] and authority['browserInputSha256']==sha(enc(data['input'])) and authority['deadlineAtMs']==authority['startedAtMs']+data['durationMs'],'postinstall-authority-binding-changed')
    request={'input':data['input'],'original':data['legacy']['original'],'prepared':data['prepared'],'authority':authority,'authorityRef':data['authorityRef'],'plan':data['plan'],'sessions':data['plan']['sessions']}
    if data['mode']=='start' and not directory.exists():
        need(authority['startedAtMs']<=time.time()*1000<authority['deadlineAtMs'],'postinstall-authority-expired');fresh=plan(data)
        for key in ('profile','sessions','health','sessionDatabase','inputSha256','requestSha256'):need(fresh[key]==data['plan'][key],'postinstall-readiness-binding-changed')
        need(any(s['expiresAtMs']>authority['deadlineAtMs']+30000 for s in fresh['sessions']),'postinstall-session-window-unavailable')
        directory.mkdir(mode=0o700);os.chown(directory,who.pw_uid,who.pw_gid);exact(directory/'intent.json',{'authority':data['authorityRef'],'requestSha256':sha(enc(request))},gid=who.pw_gid)
        source=P(fresh['profile']['path']);info=inventory(source,who.pw_uid);target=directory/'profile';target.mkdir(mode=0o700);os.chown(target,who.pw_uid,who.pw_gid)
        for row in info['rows']:
            destination=target/row['path'];original=source/row['path']
            if row['kind']=='singleton-link':continue
            if row['kind']=='directory':destination.mkdir(mode=row['metadata'][2]&0o777);os.chown(destination,who.pw_uid,who.pw_gid);continue
            src=os.open(original,os.O_RDONLY|os.O_NOFOLLOW|os.O_NOATIME);out=os.open(destination,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,row['metadata'][2]&0o777)
            try:
                os.fchown(out,who.pw_uid,who.pw_gid);h=hashlib.sha256()
                while True:
                    block=os.read(src,1048576)
                    if not block:break
                    h.update(block);offset=0
                    while offset<len(block):offset+=os.write(out,block[offset:])
                os.fsync(out);need(h.hexdigest()==row['sha256'] and meta(os.fstat(src))==tuple(row['metadata']),'postinstall-profile-copy-changed')
            finally:os.close(src);os.close(out)
        need(inventory(source,who.pw_uid)['inventorySha256']==fresh['profile']['inventorySha256'],'postinstall-original-profile-changed')
        exact(directory/'profile-copy.json',{'source':fresh['profile'],'copiedRegularFiles':sum(r['kind']=='file' for r in info['rows']),'excludedSingletonLinks':[r['path'] for r in info['rows'] if r['kind']=='singleton-link'],'sourceUnchanged':True},gid=who.pw_gid)
        for name,value in data['sources'].items():
            need(re.fullmatch('release-delivery-[a-z-]+\.mjs',name),'postinstall-worker-name-invalid');raw=base64.b64decode(value['base64']);need(sha(raw)==value['sha256'],'postinstall-worker-source-changed');p=directory/name;fd=os.open(p,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o640)
            try:os.fchown(fd,0,who.pw_gid);os.write(fd,raw);os.fsync(fd)
            finally:os.close(fd)
        closure=base64.b64decode(data['legacy']['closure']);need(sha(closure)==options['playwright']['sha256'],'postinstall-playwright-closure-changed');(directory/'playwright-closure.json').write_bytes(closure);os.chown(directory/'playwright-closure.json',0,who.pw_gid);os.chmod(directory/'playwright-closure.json',0o640)
        exact(directory/'request.json',request,gid=who.pw_gid);remaining=max(1,int((authority['deadlineAtMs']-time.time()*1000)/1000));need(remaining>1,'postinstall-authority-expired-before-launch')
        result=subprocess.run(['/usr/bin/systemd-run','--quiet','--collect','--unit='+unit.removesuffix('.service'),'--uid='+options['user'],'--gid='+str(who.pw_gid),'--property=RuntimeMaxSec='+str(remaining),'--property=TimeoutStopSec=15','--property=KillMode=control-group','--property=MemoryMax='+str(MEMORY_MAX),'--working-directory='+str(directory),'--setenv=HOME='+str(directory),'--setenv=XDG_CONFIG_HOME='+str(directory/'config'),'--setenv=XDG_CACHE_HOME='+str(directory/'cache'),options['node']['path'],str(directory/'release-delivery-postinstall-browser-worker.mjs'),str(directory/'request.json')],capture_output=True,text=True,timeout=15)
        exact(directory/'launch.json',{'returncode':result.returncode,'stderr':result.stderr[:2048],'atMs':int(time.time()*1000)},gid=who.pw_gid)
    need(directory.exists() and not directory.is_symlink(),'postinstall-original-recovery-missing');need(load(directory/'intent.json')=={'authority':data['authorityRef'],'requestSha256':sha(enc(request))},'postinstall-recovery-intent-changed')
    if data['mode']=='screenshot':
        need((directory/'result.json').is_file(),'postinstall-screenshot-before-result');need(data.get('screen') in ('screenshot','draftScreenshot'),'postinstall-screenshot-name');p=directory/('accepted-ui.png' if data['screen']=='screenshot' else 'copied-draft-ui.png');need(not p.is_symlink() and p.stat().st_size<=16777216,'postinstall-screenshot-bound');raw=p.read_bytes();offset=data['offset'];need(type(offset)==int and 0<=offset<len(raw),'postinstall-screenshot-offset');return {'offset':offset,'bytes':len(raw),'sha256':sha(raw),'base64':base64.b64encode(raw[offset:offset+49152]).decode()}
    state=unit_status(unit);files={p.stem:load(p) for p in directory.iterdir() if p.is_file() and not p.is_symlink() and p.name in ['result.json','failed.json','closed.json','memory-before-launch.json','memory-accepted.json','memory-closed.json','profile-copy.json']}
    checks=[load(p) for p in sorted(directory.glob('check-*.json'))];need(len(checks)<=16,'postinstall-check-count-bound')
    if 'result' in files:need(not state['ownedPids'] and 'MainPID=0\n' in state['unitState'] and re.search(r'ActiveState=(inactive|failed)\n',state['unitState']),'postinstall-worker-closeout-pending')
    originalUnchanged=inventory(P(data['plan']['profile']['path']),who.pw_uid)['inventorySha256']==data['plan']['profile']['inventorySha256'] if 'result' in files else None
    return {'state':'observed','operationId':authority['operationId'],'sessionId':sid,'files':files,'checks':checks,**state,'originalProfileUnchanged':originalUnchanged,'hostWrites':data['mode']=='start'}
if __name__=='__main__':
    signal.alarm(90)
    try:print(json.dumps(main(DATA),separators=(',',':'),ensure_ascii=False))
    except Exception as e:
        reason=str(e) if re.fullmatch('[a-z][a-z0-9-]{0,99}',str(e)) else 'postinstall-browser-caller-refused'
        print(json.dumps({'state':'gap','reason':reason}));raise SystemExit(2)
