"""One exact signed frontend asset through the maintained publication primitive.

The existing delivery journal owns the parent. Its immutable per-asset dispatch
record and the maintained global release/name ledger forbid uncertain POST replay.
No signing, tag/release creation, host operation or manual evidence ingestion.
"""
from pathlib import Path as P
import argparse,base64,hashlib,importlib.util,json,os,re,subprocess,sys,uuid

HERE=P(__file__).resolve().parent
def load(name,file):
    spec=importlib.util.spec_from_file_location(name,HERE/file)
    value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
F=load('frontend_publication','release-frontend-publication-primitives.py')
C=load('frontend_credentials','release-delivery-ci.py')
G=load('frontend_github','release-frontend-github-primitives.py')
need=F.need
sha=F.sha
NAMES=('release-delivery-frontend.py','release-frontend-publication-primitives.py','release-frontend-github-primitives.py','release-delivery-ci.py','release-ci-primitives.py')

def ordinary_directory(path,create=False):
    need(path.is_absolute(),'publication-directory-not-absolute')
    if create:path.mkdir(mode=0o700,exist_ok=True)
    need(path.resolve(strict=True)==path and path.is_dir() and not any(x.is_symlink() for x in (path,*path.parents)),'publication-directory-redirected')
    return path

def ref(value,maximum=128*1024**2):
    need(set(value)=={'path','sha256'},'publication-reference-fields')
    data=F.raw(value['path'],maximum);need(sha(data)==value['sha256'],'publication-reference-changed');return data

def verify_signed(request):
    signed=request['signed'];manifest=ref(signed['manifest'],128*1024);signature=ref(signed['signature'],64)
    archive=ref(signed['archive']);public=ref(signed['publicKey'],16384)
    need(signed['publicKey']['sha256']==request['trustedPublicKeySha256'] and len(signature)==64,'publication-key-changed')
    for name in ('node','git','python'):ref(request['tools'][name])
    program="const c=require('crypto'),fs=require('fs');const i=JSON.parse(fs.readFileSync(0));const k=c.createPublicKey(Buffer.from(i.key,'base64'));if(k.asymmetricKeyType!=='ed25519'||!c.verify(null,Buffer.from(i.manifest,'base64'),k,Buffer.from(i.signature,'base64')))process.exit(2);"
    completed=subprocess.run([request['tools']['node']['path'],'-e',program],input=json.dumps({k:base64.b64encode(v).decode() for k,v in {'key':public,'manifest':manifest,'signature':signature}.items()}).encode(),capture_output=True,timeout=30)
    need(completed.returncode==0,'publication-signature-invalid')
    value=json.loads(manifest)
    need(value['base']['candidateId']==request['baseCandidateId'] and value['base']['serviceInputsSha256']==request['serviceInputsSha256']
         and value['sourceRevision']==request['sourceCommits']['private'] and value['frontendVersion']==request['version']
         and value['frontendBuildVersion']==request['buildVersion'] and value['frontendId']==signed['frontendId']
         and value['sequence']==signed['sequence'] and value['artifact']['sha256']==sha(archive) and value['artifact']['bytes']==len(archive),'publication-signed-contract-changed')
    need(value['artifact']['url']=='https://github.com/'+F.PUBLIC+'/releases/download/v'+request['version']+'/nova-'+request['version']+'-frontend.tgz','publication-url-changed')
    return {'archive':archive,'manifest':manifest,'signature':signature}

def inspect(request):
    need(set(request)=={'format','operationId','version','buildVersion','sourceCommits','baseCandidateId','serviceInputsSha256','trustedPublicKeySha256','signed','tools','releaseIds','helperHashes','key','inputSha256','spec','outputDirectory','ledgerDirectory'},'publication-request-fields')
    need(request['format']==1 and all(str(uuid.UUID(request[k]))==request[k] for k in ('operationId','key')),'publication-operation-invalid')
    need(re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+',request['version']) and set(request['sourceCommits'])=={'private','public'}
         and all(re.fullmatch('[a-f0-9]{40}',x) for x in request['sourceCommits'].values()),'publication-source-invalid')
    need(set(request['releaseIds'])=={'private','public'} and all(type(x) is int and x>0 for x in request['releaseIds'].values()),'publication-release-invalid')
    need(request['helperHashes']=={name:sha(F.raw(HERE/name,2*1024**2)) for name in NAMES},'publication-helper-changed')
    data=verify_signed(request);spec=request['spec'];role=spec['role']
    need(role in data and set(spec)=={'role','name','path','sha256','bytes'} and spec['path']==request['signed'][role]['path']
         and spec['sha256']==sha(data[role]) and spec['bytes']==len(data[role])
         and spec['name']=='nova-'+request['version']+'-frontend.'+{'archive':'tgz','manifest':'json','signature':'sig'}[role],'publication-asset-input-changed')
    root=P(request['outputDirectory']);need(root.name=='frontend-publication-'+request['key']+'-'+role,'publication-output-scope')
    ordinary_directory(root.parent)
    need(P(request['ledgerDirectory'])==HERE.parent/'frontend-publication-ledger','publication-global-ledger-changed')
    return root,spec

class Client:
    def __init__(self,request):self.request=request;self.token=C.credential(request['tools'])
    def releases(self):
        rows={}
        for side in ('private','public'):
            name='Nova-Dream'+('-Public' if side=='public' else '');repo='HatimTheDream/'+name;prefix='/repos/'+repo
            status,metadata=G.api(prefix,self.token)
            need(status==200 and metadata.get('full_name')==repo and metadata.get('private') is (side=='private') and type(metadata.get('id')) is int,'publication-repository-changed')
            tag=('nova-v' if side=='private' else 'v')+self.request['version'];source=self.request['sourceCommits'][side]
            status,gitref=G.api(prefix+'/git/ref/tags/'+tag,self.token)
            need(status==200 and gitref.get('object')=={'sha':source,'type':'commit','url':'https://api.github.com/repos/'+repo+'/git/commits/'+source},'publication-source-tag-changed')
            status,release=G.api(prefix+'/releases/'+str(self.request['releaseIds'][side]),self.token)
            need(status==200 and release.get('id')==self.request['releaseIds'][side] and release.get('tag_name')==tag
                 and release.get('target_commitish')==source and release.get('draft') is False and release.get('prerelease') is False
                 and isinstance(release.get('assets'),list) and len(release['assets'])<=100,'publication-source-release-changed')
            rows[name]={'repositoryId':metadata['id'],'release':release}
        return rows
    def upload(self,release,spec,out,plan):
        # Recheck local signed authority immediately before each POST.
        verify_signed(self.request)
        return F.upload_verified(G,self.token,plan,release,out,spec['name'],P(spec['path']),spec['bytes'],spec['sha256'])
    def download(self,asset,spec,out):return F.download_verified(self.token,asset,spec,out)

def produce(mode,request,client=None):
    root,spec=inspect(request)
    digest=sha(F.enc(request));external=str(request['releaseIds']['public'])+':'+request['key']
    def result(state,reason,output=None,receipt=None):return dict(state=state,reason=reason,externalId=external,output=output,receipt=receipt)
    if mode=='execute':
        ordinary_directory(root,create=True)
        # Exact original intent before client construction/credential lookup/API.
        F.save(root/'dispatch.json',{'format':1,'requestSha256':digest,'key':request['key'],'attemptDirectory':str(root/'first')})
    else:
        if not root.exists() or not (root/'dispatch.json').exists():return result('uncertain','frontend-original-dispatch-not-recorded')
        ordinary_directory(root)
    dispatch=json.loads(F.raw(root/'dispatch.json',4096))
    need(dispatch=={'format':1,'requestSha256':digest,'key':request['key'],'attemptDirectory':str(root/'first')},'publication-original-dispatch-changed')
    plan={'format':1,'operationId':request['operationId'],'inputSha256':request['inputSha256'],'sourceReleaseIds':{'Nova-Dream':request['releaseIds']['private'],'Nova-Dream-Public':request['releaseIds']['public']},'specs':[spec]}
    value={'sourceCommits':{'Nova-Dream':request['sourceCommits']['private'],'Nova-Dream-Public':request['sourceCommits']['public']}}
    first=root/'first'
    if mode=='observe' and not (first/'publication.intent.json').exists():return result('uncertain','frontend-original-publication-not-recorded')
    target=first if mode=='execute' else root/('observe-'+str(uuid.uuid4()))
    try:
        published=F.publish(value,plan,target,client or Client(request),observe=mode=='observe',original=first if mode=='observe' else None,ledger=P(request['ledgerDirectory']))
    except Exception as error:
        why={'missing-asset-uncertain-no-POST-replay':'missing-asset-uncertain-no-post-replay'}.get(str(error),str(error))
        why=why if re.fullmatch('[a-z][a-z0-9-]{0,99}',why) else 'frontend-publication-response-unavailable'
        return result('uncertain',why)
    asset=published['assets'][0]
    output={'operationId':request['operationId'],'key':request['key'],'inputSha256':request['inputSha256'],'role':spec['role'],'asset':asset}
    path=target/'delivery-result.json';F.save(path,output)
    return result('completed','frontend-asset-published',output,{'path':str(path),'sha256':sha(F.raw(path))})

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('mode',choices=('execute','observe'));parser.add_argument('--request',type=P,required=True);parser.add_argument('--request-sha256',required=True)
    args=parser.parse_args()
    try:
        data=F.raw(args.request,1024**2);need(sha(data)==args.request_sha256,'publication-request-changed');out=produce(args.mode,json.loads(data))
    except Exception:
        out={'state':'uncertain','reason':'frontend-publication-response-unavailable','externalId':None,'output':None,'receipt':None}
    print(json.dumps(out));sys.exit(0 if out['state']=='completed' else 2)
