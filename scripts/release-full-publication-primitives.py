"""Maintained full immutable-asset publication primitives.
Fixed private repository route; original per-asset intent/readback semantics retained.
No admission, credentials, source publication or worker execution is included.
"""
from pathlib import Path as P
import hashlib,http.client,json,os,re,stat,time,urllib.error,urllib.parse,urllib.request
HERE=P(__file__).resolve().parent
PRIVATE='HatimTheDream/Nova-Dream'
RUNTIME_MAXIMUM=512*1024**2
def need(v,m):
 if not v:raise RuntimeError(m)

def sha(v):return hashlib.sha256(v).hexdigest()

def enc(v):return (json.dumps(v,sort_keys=True,separators=(',',':'))+'\n').encode()

def raw(path,maximum=128*1024**2):
 p=P(path);need(p.is_absolute() and p.resolve(strict=True)==p,'ordinary-absolute-input')
 for x in (p,*p.parents):need(not x.is_symlink(),'input-symlink')
 a=p.lstat();need(p.is_file() and a.st_nlink==1 and a.st_size<=maximum and not getattr(a,'st_file_attributes',0)&1024,'bounded-independent-input')
 with p.open('rb') as f:data=f.read(maximum+1)
 z=p.lstat();need((a.st_dev,a.st_ino,a.st_size,a.st_mtime_ns)==(z.st_dev,z.st_ino,z.st_size,z.st_mtime_ns) and len(data)==a.st_size,'input-changed')
 return data

def stream_chunks(path,expected_bytes,expected_sha,maximum=RUNTIME_MAXIMUM,deadline=None):
 p=P(path);need(type(expected_bytes) is int and 0<expected_bytes<=maximum and isinstance(expected_sha,str) and re.fullmatch('[a-f0-9]{64}',expected_sha),'bounded-runtime-stream-required')
 need(p.is_absolute() and p.resolve(strict=True)==p,'ordinary-absolute-runtime')
 for part in (p,*p.parents):
  s=part.lstat();need(not part.is_symlink() and not getattr(s,'st_file_attributes',0)&1024,'runtime-stream-redirected')
 before=p.lstat();need(stat.S_ISREG(before.st_mode) and before.st_nlink==1 and before.st_size==expected_bytes,'runtime-stream-size-or-link-changed')
 identity=lambda s:(s.st_dev,s.st_ino,s.st_mode,s.st_nlink,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
 shared=lambda s:identity(s)[:-1]
 fd=os.open(p,os.O_RDONLY|getattr(os,'O_NOFOLLOW',0));end=deadline if deadline is not None else time.monotonic()+30
 try:
  opened=os.fstat(fd);need(shared(opened)==shared(before),'runtime-stream-open-identity-changed')
  digest=hashlib.sha256();count=0
  while True:
   need(time.monotonic()<=end,'runtime-stream-deadline-expired');block=os.read(fd,1024**2)
   if not block:break
   count+=len(block);need(count<=expected_bytes,'runtime-stream-grew');digest.update(block);yield block
  need(count==expected_bytes and digest.hexdigest()==expected_sha,'runtime-stream-content-changed')
  need(identity(os.fstat(fd))==identity(opened) and identity(p.lstat())==identity(before),'runtime-stream-identity-changed')
 finally:os.close(fd)

def verify_runtime_file(path,expected_bytes,expected_sha):
 for _block in stream_chunks(path,expected_bytes,expected_sha):pass
 return {'bytes':expected_bytes,'sha256':expected_sha}

def verify_asset_file(path,spec):
 if spec.get('role')=='runtime':return verify_runtime_file(path,spec['bytes'],spec['sha256'])
 data=raw(path);need(len(data)==spec['bytes'] and sha(data)==spec['sha256'],'asset-source-content-changed');return {'bytes':len(data),'sha256':sha(data)}

def save(path,value):
 data=value if isinstance(value,bytes) else enc(value)
 fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|getattr(os,'O_NOFOLLOW',0),0o600)
 with os.fdopen(fd,'wb') as f:f.write(data);f.flush();os.fsync(f.fileno())

def ledger_directory(value):
 # The fixed JS caller checks the existing owner ACL before every child call.
 # Repeat canonical ancestry checks here, and the native POSIX permission check.
 need(isinstance(value,(str,P)),'explicit-publication-ledger-required');path=P(value)
 need(path.is_absolute() and path.resolve(strict=True)==path and path!=P(path.anchor),'ordinary-publication-ledger')
 for part in (path,*path.parents):
  info=part.lstat()
  need(part.is_dir() and not part.is_symlink() and not getattr(info,'st_file_attributes',0)&1024,'redirected-publication-ledger')
  need(not(part/'.git').exists() and not re.fullmatch(r'onedrive(?:\s*-.*)?',part.name,re.I),'private-external-publication-ledger-required')
 for raw in (os.environ.get(k) for k in ('OneDrive','OneDriveConsumer','OneDriveCommercial')):
  if raw:
   synced=P(raw).resolve();need(path!=synced and synced not in path.parents,'synced-publication-ledger-refused')
 if os.name!='nt':
  info=path.lstat();need(info.st_uid==os.getuid() and info.st_mode&0o077==0,'private-publication-ledger-required')
 return path

class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args):return None

def check_asset(asset,spec):
 need(type(asset.get('id')) is int and asset['id']>0 and asset.get('name')==spec['name'] and asset.get('size')==spec['bytes']
  and asset.get('state')=='uploaded' and asset.get('digest') in (None,'sha256:'+spec['sha256'])
  and asset.get('url')=='https://api.github.com/repos/'+PRIVATE+'/releases/assets/'+str(asset['id']),'immutable-existing-asset-metadata')

def download_verified(token,asset,spec,out):
 need(type(spec['bytes']) is int and 0<spec['bytes']<=(RUNTIME_MAXIMUM if spec.get('role')=='runtime' else 128*1024**2),'asset-readback-role-size-bound')
 check_asset(asset,spec);opener=urllib.request.build_opener(NoRedirect())
 request=urllib.request.Request(asset['url'],headers={'Authorization':'Bearer '+token,'Accept':'application/octet-stream','User-Agent':'Nova-Reviewed-Release'})
 try:response=opener.open(request,timeout=30)
 except urllib.error.HTTPError as error:
  need(error.code==302,'authenticated-readback-refused');parsed=urllib.parse.urlsplit(error.headers['Location'])
  need(parsed.scheme=='https' and parsed.hostname=='release-assets.githubusercontent.com' and not parsed.username and not parsed.password and not parsed.fragment,'untrusted-readback-redirect')
  response=opener.open(urllib.request.Request(error.headers['Location'],headers={'User-Agent':'Nova-Reviewed-Release'}),timeout=60)
 path=out/spec['name'];digest=hashlib.sha256();count=0
 with response,path.open('xb') as f:
  need(response.status==200,'readback-refused')
  while block:=response.read(1024**2):
   count+=len(block);need(count<=spec['bytes'],'readback-oversize');digest.update(block);f.write(block)
  f.flush();os.fsync(f.fileno())
 need(count==spec['bytes'] and digest.hexdigest()==spec['sha256'],'complete-readback-mismatch');verify_asset_file(path,spec)
 return {'id':asset['id'],'name':spec['name'],'bytes':count,'sha256':digest.hexdigest(),'authenticatedDownloadVerified':True}

def publish(value,plan,out,client,observe=False,original=None,ledger=None):
 ledger=ledger_directory(ledger)
 if observe:
  need(original is not None,'original-uncertain-publication-required')
  prior=json.loads(raw(original/'publication.intent.json'));need(prior['planSha256']==sha(enc(plan)) and prior['operationId']==plan['operationId'],'original-publication-plan-binding')
 need(out.is_absolute() and not os.path.lexists(out),'new-exclusive-record-directory');out.mkdir(mode=0o700)
 save(out/'publication.intent.json',{'format':1,'planSha256':sha(enc(plan)),'operationId':plan['operationId'],'observeOnly':observe,'automaticRetry':False})
 rows=[]
 try:
  paired=client.releases();release=paired['Nova-Dream']['release']
  for spec in plan['specs']:
   # Refresh the actual source releases immediately before every possible POST.
   fresh=client.releases();need({k:(r['repositoryId'],r['release']['id']) for k,r in fresh.items()}=={k:(r['repositoryId'],r['release']['id']) for k,r in paired.items()},'release-identity-changed')
   matches=[a for a in fresh['Nova-Dream']['release']['assets'] if a['name']==spec['name']]
   need(len(matches)<=1,'duplicate-asset-name')
   target=out/(str(len(rows))+'-readback');target.mkdir(mode=0o700)
   if matches:
    check_asset(matches[0],spec);row=client.download(matches[0],spec,target);row['adoptedExisting']=True
   else:
    need(not observe,'missing-asset-uncertain-no-POST-replay')
    # Fixed release/name authority survives a different output directory or UUID.
    # An uncertain POST cannot be redispatched by manufacturing a fresh caller.
    save(ledger/(str(plan['sourceReleaseIds']['Nova-Dream'])+'-'+spec['name']+'.intent.json'),{'operationId':plan['operationId'],'planSha256':sha(enc(plan)),'spec':spec,'automaticRetry':False})
    save(out/(spec['role']+'-dispatch.intent.json'),spec)
    row=client.upload(fresh['Nova-Dream']['release'],spec,target,plan);row['adoptedExisting']=False
   need(row['name']==spec['name'] and row['bytes']==spec['bytes'] and row['sha256']==spec['sha256'] and row['authenticatedDownloadVerified'] is True,'all-byte-readback-required')
   with (target/spec['name']).open('r+b') as f:f.flush();os.fsync(f.fileno())
   verify_asset_file(target/spec['name'],spec);row['localPath']=str(target/spec['name']);rows.append(row);save(out/(spec['role']+'-verified.json'),row)
  final=client.releases()
  for spec,row in zip(plan['specs'],rows):
   matches=[a for a in final['Nova-Dream']['release']['assets'] if a['name']==spec['name']];need(len(matches)==1 and matches[0]['id']==row['id'],'final-immutable-asset-id-changed');check_asset(matches[0],spec)
  result={'format':1,'status':'private-full-assets-verified','plan':plan,'pairedSourceReleaseReferences':{n:{'repositoryId':r['repositoryId'],'releaseId':r['release']['id'],'sourceCommit':value['sourceCommits'][n]} for n,r in final.items()},'assets':rows,'discoveryImplemented':False,'automaticDeliveryImplemented':False,'hostEffects':False}
  save(out/'publication-verified.json',result);return result
 except Exception as error:
  save(out/'uncertain.json',{'format':1,'errorType':type(error).__name__,'completedAssets':rows,'automaticRetry':False,'observeOnlyRequired':True});raise

require=need
decode=json.loads

def upload_runtime_verified(token,gate,record,out,spec):
 need(spec['role']=='runtime' and type(spec['bytes']) is int and 0<spec['bytes']<=RUNTIME_MAXIMUM,'runtime-upload-role-required')
 verify_runtime_file(spec['path'],spec['bytes'],spec['sha256'])
 save(out/(spec['name']+'.upload.intent.json'),{'format':1,'name':spec['name'],'bytes':spec['bytes'],'sha256':spec['sha256'],**gate,'automaticRetry':False})
 route='/repos/'+PRIVATE+'/releases/'+str(record['id'])+'/assets?name='+urllib.parse.quote(spec['name'])
 end=time.monotonic()+240;connection=http.client.HTTPSConnection('uploads.github.com',timeout=30)
 try:
  connection.putrequest('POST',route);connection.putheader('Authorization','Bearer '+token);connection.putheader('Accept','application/vnd.github+json')
  connection.putheader('Content-Type','application/octet-stream');connection.putheader('Content-Length',str(spec['bytes']));connection.putheader('User-Agent','Nova-Reviewed-Release');connection.endheaders()
  for block in stream_chunks(spec['path'],spec['bytes'],spec['sha256'],deadline=end):connection.send(block)
  need(time.monotonic()<=end,'runtime-upload-deadline-expired');response=connection.getresponse();data=response.read(65537)
  need(response.status==201 and len(data)<=65536,'runtime-upload-unconfirmed');asset=json.loads(data);check_asset(asset,spec)
 finally:connection.close()
 save(out/(spec['name']+'.upload.json'),{'id':asset['id'],'name':asset['name'],'size':asset['size'],'state':asset['state'],'digest':asset.get('digest')})
 return download_verified(token,asset,spec,out)

def upload_verified(module, token, gate, record, out, name, path, expected_bytes, expected_sha):
    content = raw(path, expected_bytes)
    require(len(content) == expected_bytes and sha(content) == expected_sha, 'Upload input differs.')
    save(out / (name + '.upload.intent.json'), {'format': 1, 'name': name, 'bytes': len(content), 'sha256': expected_sha, **gate, 'automaticRetry': False})
    url = 'https://uploads.github.com/repos/HatimTheDream/Nova-Dream/releases/' + str(record['id']) + '/assets?name=' + urllib.parse.quote(name)
    opener = urllib.request.build_opener(NoRedirect())
    request = urllib.request.Request(url, data=content, method='POST', headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/octet-stream', 'User-Agent': 'Nova-Reviewed-Release'})
    with opener.open(request, timeout=120) as response:
        require(response.status == 201, 'Upload not confirmed.')
        data = response.read(65537)
        require(len(data) <= 65536, 'Oversized upload response.')
        asset = decode(data)
    require(asset['name'] == name and asset['size'] == len(content) and asset['state'] == 'uploaded'
            and asset.get('digest') in (None, 'sha256:' + sha(content)), 'Uploaded asset metadata differs.')
    save(out / (name + '.upload.json'), {'id': asset['id'], 'name': asset['name'], 'size': asset['size'], 'state': asset['state'], 'digest': asset.get('digest')})
    request = urllib.request.Request('https://api.github.com/repos/HatimTheDream/Nova-Dream/releases/assets/' + str(asset['id']), headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/octet-stream', 'User-Agent': 'Nova-Reviewed-Release'})
    try:
        response = opener.open(request, timeout=30)
    except urllib.error.HTTPError as error:
        require(error.code == 302, 'Authenticated asset read failed.')
        location = error.headers['Location']
        parsed = urllib.parse.urlparse(location)
        require(parsed.scheme == 'https' and parsed.hostname == 'release-assets.githubusercontent.com'
                and not parsed.username and not parsed.password and not parsed.fragment, 'Untrusted asset redirect.')
        # Never forward the GitHub credential to the signed object-storage URL.
        response = opener.open(urllib.request.Request(location, headers={'User-Agent': 'Nova-Reviewed-Release'}), timeout=60)
    digest, total = hashlib.sha256(), 0
    with response, (out / name).open('xb') as stream:
        require(response.status == 200, 'Asset download failed.')
        while chunk := response.read(1024 * 1024):
            total += len(chunk)
            require(total <= len(content), 'Oversized asset download.')
            digest.update(chunk)
            stream.write(chunk)
    require(total == len(content) and digest.hexdigest() == expected_sha, 'Independent asset hash differs.')
    return {'name': name, 'id': asset['id'], 'bytes': total, 'sha256': digest.hexdigest(), 'authenticatedDownloadVerified': True}
