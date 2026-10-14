"""One authenticated immutable full-release asset, preserving original intents.

This never signs, starts a host operation or creates a release/tag. A missing
asset after an uncertain POST remains uncertain; it is never posted again.
"""
from pathlib import Path as P
import argparse,base64,hashlib,importlib.util,json,os,re,subprocess,sys,uuid,datetime
HERE=P(__file__).resolve().parent
def load(name,file):
 spec=importlib.util.spec_from_file_location(name,HERE/file);value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
F=load('full_publication_primitives','release-full-publication-primitives.py')
C=load('full_credentials','release-delivery-ci.py')
G=load('full_github','release-frontend-github-primitives.py')
need=F.need;sha=F.sha
NAMES=('release-delivery-full-publication.py','release-full-publication-primitives.py','release-full-feed-publication.py','release-frontend-github-primitives.py','release-delivery-ci.py','release-ci-primitives.py')
SUFFIX={'app':'app.tgz','bundle':'operator-bundle.json','dependencies':'app-dependencies.tgz','manifest':'stable.json','runtime':'runtime.tgz'}
def ordinary(path,create=False):
 need(path.is_absolute(),'full-publication-directory-absolute')
 if create:path.mkdir(mode=0o700,exist_ok=True)
 need(path.resolve(strict=True)==path and path.is_dir() and not any(x.is_symlink() for x in (path,*path.parents)),'full-publication-directory-redirected');return path
def ref(value,maximum=128*1024**2):
 need(set(value)=={'path','sha256'},'full-publication-reference-schema');raw=F.raw(value['path'],maximum);need(sha(raw)==value['sha256'],'full-publication-reference-changed');return raw
def verify_signed(request):
 signed=request['signed'];feed=ref(signed['signedFeed'],256*1024);public=ref(signed['publicKey'],16384)
 need(signed['publicKey']['sha256']==request['trustedPublicKeySha256'],'full-publication-key-changed')
 for name in ('node','python','git'):ref(request['tools'][name])
 program="const c=require('crypto'),fs=require('fs');const i=JSON.parse(fs.readFileSync(0));const k=c.createPublicKey(Buffer.from(i.key,'base64')),e=JSON.parse(Buffer.from(i.feed,'base64'));if(k.asymmetricKeyType!=='ed25519'||!c.verify(null,Buffer.from(e.payload,'base64'),k,Buffer.from(e.signature,'base64')))process.exit(2);"
 checked=subprocess.run([request['tools']['node']['path'],'-e',program],input=json.dumps({'key':base64.b64encode(public).decode(),'feed':base64.b64encode(feed).decode()}).encode(),capture_output=True,timeout=30)
 need(checked.returncode==0,'full-publication-signature-invalid');envelope=json.loads(feed);payload=base64.b64decode(envelope['payload'],validate=True);manifest=json.loads(payload)
 need(base64.b64encode(payload).decode()==envelope['payload'] and manifest['channel']==signed['channel'] and manifest['sequence']==signed['sequence'],'full-publication-feed-identity')
 now=datetime.datetime.now(datetime.timezone.utc);parse=lambda v:datetime.datetime.fromisoformat(v.replace('Z','+00:00'))
 need(parse(manifest['createdAt'])<=now<parse(manifest['expiresAt']),'full-publication-feed-expired')
 rows=[r for r in manifest['releases'] if r['candidateId']==signed['candidateId']]
 need(rows==[signed['release']] and signed['release']['novaVersion']==request['version'] and signed['release']['fromCandidateId']==request['priorCandidateId'] and signed['sourceCommits']==request['sourceCommits'],'full-publication-signed-release-changed')
 bundle=ref(signed['bundle']);deps=ref(signed['dependencies']['archive']);app=ref(request['applicationArchive'])
 entries=json.loads(bundle)['files'];apps=[r for r in entries if r['name']=='app.tgz'];need(len(apps)==1 and base64.b64decode(apps[0]['data'],validate=True)==app and apps[0]['sha256']==sha(app),'full-publication-app-not-bundle-bound')
 prefix='https://github.com/HatimTheDream/Nova-Dream/releases/download/nova-v'+request['version']+'/nova-'+request['version']+'-'
 for role,raw,spec in [('bundle',bundle,signed['release']['bundle']),('dependencies',deps,signed['release']['applicationDependenciesBundle'])]:
  need(spec['sha256']==sha(raw) and spec['bytes']==len(raw) and spec['url']==prefix+SUFFIX[role],'full-publication-signed-artifact-changed')
 data={'app':app,'bundle':bundle,'dependencies':deps,'manifest':feed}
 runtime=signed.get('runtime')
 if runtime:
  need(isinstance(runtime,dict) and isinstance(runtime.get('description'),dict),'runtime-publication-description-required')
  d=runtime['description'];archive=runtime['archive'];spec=signed['release'].get('runtimeBundle')
  need(set(archive)=={'path','sha256'} and d.get('format')==1 and d.get('fromVersion')=='2026.9.6' and d.get('toVersion')=='2026.9.8'
   and signed['release']['agentVersion']=='2026.9.8' and d.get('nodeVersion')=='24.21.0' and d.get('companion',{}).get('pluginVersion')=='2026.9.8'
   and d['companion'].get('codexVersion')=='0.158.0' and spec=={'url':prefix+'runtime.tgz','bytes':d['archiveBytes'],'sha256':d['archiveSha256']}
   and archive['sha256']==d['archiveSha256'],'runtime-publication-signed-transition-changed')
  pair=[r for r in entries if r['name']=='reviewed-pair.json'];need(len(pair)==1,'runtime-publication-pair-required')
  pairraw=base64.b64decode(pair[0]['data'],validate=True);need(sha(pairraw)==pair[0]['sha256'] and json.loads(pairraw).get('runtime')==d,'runtime-publication-pair-changed')
  F.verify_runtime_file(archive['path'],d['archiveBytes'],d['archiveSha256']);data['runtime']={'runtimeFile':archive,'bytes':d['archiveBytes'],'sha256':d['archiveSha256']}
 else:need(not signed['release'].get('runtimeBundle'),'runtime-publication-unbound')
 return data
def inspect(request):
 need(set(request)=={'format','operationId','version','buildVersion','sourceCommits','priorCandidateId','trustedPublicKeySha256','signed','applicationArchive','tools','releaseIds','helperHashes','key','inputSha256','spec','outputDirectory','ledgerDirectory'},'full-publication-request-schema')
 need(request['format']==1 and all(str(uuid.UUID(request[k]))==request[k] for k in ('operationId','key')),'full-publication-operation')
 need(re.fullmatch(r'\d+\.\d+\.\d+',request['version']) and set(request['sourceCommits'])=={'private','public'} and all(re.fullmatch('[a-f0-9]{40}',s) for s in request['sourceCommits'].values()),'full-publication-sources')
 need(set(request['releaseIds'])=={'private','public'} and all(type(n) is int and n>0 for n in request['releaseIds'].values()),'full-publication-release-ids')
 need(request['helperHashes']=={n:sha(F.raw(HERE/n,2*1024**2)) for n in NAMES},'full-publication-helper-changed')
 data=verify_signed(request);spec=request['spec'];role=spec['role'];refs={'app':request['applicationArchive'],'bundle':request['signed']['bundle'],'dependencies':request['signed']['dependencies']['archive'],'manifest':request['signed']['signedFeed']}
 if request['signed'].get('runtime'):refs['runtime']=request['signed']['runtime']['archive']
 need(role in refs and set(spec)=={'role','name','path','bytes','sha256'} and spec['path']==refs[role]['path'] and spec['name']=='nova-'+request['version']+'-'+SUFFIX[role],'full-publication-asset-identity')
 expected=data[role] if role=='runtime' else {'sha256':sha(data[role]),'bytes':len(data[role])}
 need(spec['sha256']==expected['sha256'] and spec['bytes']==expected['bytes'],'full-publication-asset-identity')
 root=P(request['outputDirectory']);need(root.name=='full-publication-'+request['key']+'-'+role,'full-publication-output-scope');ordinary(root.parent)
 F.ledger_directory(request['ledgerDirectory']);return root,spec
class Client:
 def __init__(self,request):self.request=request;self.token=C.credential(request['tools'])
 def releases(self):
  rows={}
  for side in ('private','public'):
   name='Nova-Dream'+('-Public' if side=='public' else '');repo='HatimTheDream/'+name;prefix='/repos/'+repo
   status,metadata=G.api(prefix,self.token);need(status==200 and metadata.get('full_name')==repo and metadata.get('private') is (side=='private') and type(metadata.get('id')) is int,'full-publication-repository-changed')
   tag=('nova-v' if side=='private' else 'v')+self.request['version'];source=self.request['sourceCommits'][side]
   status,gitref=G.api(prefix+'/git/ref/tags/'+tag,self.token);need(status==200 and gitref.get('object')=={'sha':source,'type':'commit','url':'https://api.github.com/repos/'+repo+'/git/commits/'+source},'full-publication-tag-changed')
   status,release=G.api(prefix+'/releases/'+str(self.request['releaseIds'][side]),self.token)
   need(status==200 and release.get('id')==self.request['releaseIds'][side] and release.get('tag_name')==tag and release.get('target_commitish')==source and release.get('draft') is False and release.get('prerelease') is False and isinstance(release.get('assets'),list) and len(release['assets'])<=100,'full-publication-release-changed')
   rows[name]={'repositoryId':metadata['id'],'release':release}
  return rows
 def upload(self,release,spec,out,plan):
  verify_signed(self.request)
  if spec['role']=='runtime':return F.upload_runtime_verified(self.token,plan,release,out,spec)
  return F.upload_verified(G,self.token,plan,release,out,spec['name'],P(spec['path']),spec['bytes'],spec['sha256'])
 def download(self,asset,spec,out):return F.download_verified(self.token,asset,spec,out)
def produce(mode,request,client=None):
 root,spec=inspect(request);digest=sha(F.enc(request));external=str(request['releaseIds']['private'])+':'+request['key']
 result=lambda state,reason,output=None,receipt=None:dict(state=state,reason=reason,externalId=external,output=output,receipt=receipt)
 if mode=='execute':ordinary(root,True);F.save(root/'dispatch.json',{'format':1,'requestSha256':digest,'key':request['key'],'attemptDirectory':str(root/'first')})
 elif not root.exists() or not(root/'dispatch.json').exists():return result('uncertain','full-original-asset-dispatch-not-recorded')
 else:ordinary(root)
 need(json.loads(F.raw(root/'dispatch.json',4096))=={'format':1,'requestSha256':digest,'key':request['key'],'attemptDirectory':str(root/'first')},'full-original-asset-dispatch-changed')
 plan={'format':1,'operationId':request['operationId'],'inputSha256':request['inputSha256'],'sourceReleaseIds':{'Nova-Dream':request['releaseIds']['private'],'Nova-Dream-Public':request['releaseIds']['public']},'specs':[spec]}
 value={'sourceCommits':{'Nova-Dream':request['sourceCommits']['private'],'Nova-Dream-Public':request['sourceCommits']['public']}}
 first=root/'first'
 if mode=='observe' and not(first/'publication.intent.json').exists():return result('uncertain','full-original-publication-not-recorded')
 target=first if mode=='execute' else root/('observe-'+str(uuid.uuid4()))
 try:published=F.publish(value,plan,target,client or Client(request),observe=mode=='observe',original=first if mode=='observe' else None,ledger=P(request['ledgerDirectory']))
 except Exception as error:return result('uncertain','full-original-asset-response-unavailable')
 output={'operationId':request['operationId'],'key':request['key'],'inputSha256':request['inputSha256'],'role':spec['role'],'asset':published['assets'][0]};path=target/'delivery-result.json';F.save(path,output)
 return result('completed','full-private-asset-published',output,{'path':str(path),'sha256':sha(F.raw(path))})
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('mode',choices=('execute','observe'));p.add_argument('--request',type=P,required=True);p.add_argument('--request-sha256',required=True);a=p.parse_args()
 try:
  raw=F.raw(a.request,2*1024**2);need(sha(raw)==a.request_sha256,'full-publication-request-changed');value=produce(a.mode,json.loads(raw))
 except Exception as error:value={'state':'uncertain','reason':'full-publication-response-unavailable','externalId':None,'output':None,'receipt':None,'privateDiagnostic':{'type':type(error).__name__[:100],'message':str(error)[:1000]}}
 print(json.dumps(value));sys.exit(0 if value['state']=='completed' else 2)
