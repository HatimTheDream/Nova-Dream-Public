"""Fixed paired-feed commit/push children with observation-only uncertainty.

Each child has its own durable dispatch. The maintained --only feed commit
preserves all unrelated index entries; there is no reset, force or retry.
"""
from pathlib import Path as P
import argparse,hashlib,importlib.util,json,os,re,subprocess,sys,urllib.request,uuid
HERE=P(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('full_assets',HERE/'release-delivery-full-publication.py');A=importlib.util.module_from_spec(spec);spec.loader.exec_module(A)
F=A.F;need=A.need;sha=A.sha
def git(request,*args,binary=False):
 source=request['sources'][request['side']];tools=request['tools']
 A.ref(tools['git']);path=P(tools['gitExecPath']);need(path.is_absolute() and path.resolve(strict=True)==path and path.is_dir(),'full-feed-git-exec-path')
 env=dict(os.environ,GIT_EXEC_PATH=str(path),GIT_TERMINAL_PROMPT='0',GCM_INTERACTIVE='never')
 out=subprocess.run([tools['git']['path'],'-C',source['root'],*args],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=90,env=env)
 need(out.returncode==0 and len(out.stdout)<=2*1024**2 and len(out.stderr)<=65536,'full-feed-git-response-unavailable')
 return out.stdout if binary else out.stdout.decode('utf8').strip()
def inspect(request):
 need(set(request)=={'format','operationId','version','buildVersion','sourceCommits','priorCandidateId','trustedPublicKeySha256','signed','applicationArchive','tools','releaseIds','helperHashes','key','inputSha256','ledgerDirectory','sources','previousFeed','assetsReceipt','side','phase','commit','outputDirectory'},'full-feed-exact-request-required')
 need(request['format']==1 and request['side'] in ('private','public') and request['phase'] in ('commit','push'),'full-feed-request-schema')
 need(all(str(uuid.UUID(request[k]))==request[k] for k in ('operationId','key')) and re.fullmatch('[a-f0-9]{64}',request['inputSha256']),'full-feed-original-identity-required')
 need(request['helperHashes']=={n:sha(F.raw(HERE/n,2*1024**2)) for n in A.NAMES},'full-feed-helper-changed')
 data=A.verify_signed(request);feed=data['manifest']
 need(isinstance(request['previousFeed'],dict),'full-existing-signed-feed-predecessor-required');previous=A.ref(request['previousFeed'],256*1024)
 source=request['sources'][request['side']];side=request['side'];name='Nova-Dream'+('-Public' if side=='public' else '')
 need(source['repository']=='HatimTheDream/'+name and source['commit']==request['sourceCommits'][side] and source['branch']=='main','full-feed-source-identity')
 root=P(request['outputDirectory']);need(root.name=='full-feed-'+request['key']+'-'+side+'-'+request['phase'],'full-feed-child-directory');A.ordinary(root.parent)
 repo=P(source['root']);A.ordinary(repo);path='edition3/updates/stable.json' if side=='private' else 'updates/stable.json'
 need(git(request,'remote','get-url','--push','origin') in {'https://github.com/'+source['repository']+'.git','https://github.com/'+source['repository'],'git@github.com:'+source['repository']+'.git'},'full-feed-remote-changed')
 need(git(request,'branch','--show-current')=='main','full-feed-branch-changed')
 assets=json.loads(A.ref(request['assetsReceipt']))
 need(assets['kind']=='nova-delivery-full-assets' and assets['operationId']==request['operationId'] and assets['key']==request['key'] and assets['inputSha256']==request['inputSha256'] and len(assets['assets'])==len(data),'full-published-assets-required')
 for role,raw in data.items():
  rows=[r for r in assets['assets'] if r['role']==role];need(len(rows)==1,'full-feed-asset-role-required');a=rows[0]['asset']
  expected=raw if role=='runtime' else {'sha256':sha(raw),'bytes':len(raw)}
  need(a['sha256']==expected['sha256'] and a['bytes']==expected['bytes'] and a['authenticatedDownloadVerified'] is True,'full-feed-asset-readback-changed')
  F.verify_asset_file(a['localPath'],{'role':role,**expected})
 F.ledger_directory(request['ledgerDirectory'])
 return root,repo,path,feed,previous,name
def local_commit(request,path,feed):
 head=git(request,'rev-parse','HEAD');need(re.fullmatch('[a-f0-9]{40}',head),'full-feed-head-invalid')
 need(git(request,'rev-parse','HEAD^')==request['sources'][request['side']]['commit'] and git(request,'diff-tree','--no-commit-id','--name-only','-r','HEAD')==path and git(request,'show','HEAD:'+path,binary=True)==feed,'full-feed-original-commit-not-observed');return head
def produce(mode,request):
 root,repo,path,feed,previous,name=inspect(request);digest=sha(F.enc(request));external=name+':'+request['key']+':'+request['phase']
 result=lambda state,reason,output=None,receipt=None:dict(state=state,reason=reason,externalId=external,output=output,receipt=receipt)
 intent={'format':1,'operationId':request['operationId'],'key':request['key'],'phase':request['phase'],'requestSha256':digest,'automaticReplayPermitted':False}
 if mode=='execute':A.ordinary(root,True);F.save(root/'dispatch.json',intent)
 elif not(root/'dispatch.json').exists():return result('uncertain','full-original-feed-child-not-recorded')
 else:A.ordinary(root)
 need(json.loads(F.raw(root/'dispatch.json'))==intent,'full-original-feed-child-changed')
 parent=request['sources'][request['side']]['commit']
 if request['phase']=='commit':
  if mode=='execute':
   need(request['commit'] is None and git(request,'rev-parse','HEAD')==parent and git(request,'ls-remote','--exit-code','origin','refs/heads/main').split()[0]==parent,'full-feed-original-parent-changed')
   need(git(request,'show','HEAD:'+path,binary=True)==previous and F.raw(repo/path,256*1024).replace(b'\r\n',b'\n')==previous and git(request,'show',':'+path,binary=True)==previous,'full-feed-predecessor-changed')
   ledger=F.ledger_directory(request['ledgerDirectory'])
   F.save(ledger/(name+'-stable-'+str(request['signed']['sequence'])+'.intent.json'),intent)
   unrelated=git(request,'diff','--cached','--raw','-z','--','.',':(exclude)'+path,binary=True);F.save(root/'unrelated-index.raw',unrelated)
   # Every local mutation follows the durable original child and global intent.
   with (repo/path).open('wb') as f:f.write(feed);f.flush();os.fsync(f.fileno())
   git(request,'add','--',path);need(git(request,'show',':'+path,binary=True)==feed,'full-feed-staged-bytes-changed')
   git(request,'diff','--cached','--check','--',path)
   git(request,'-c','user.name=Codex','-c','user.email=codex@openai.com','commit','--only','-m','Publish verified '+request['version']+' update feed [skip ci]','--',path)
  head=local_commit(request,path,feed)
  need(git(request,'diff','--cached','--raw','-z','--','.',':(exclude)'+path,binary=True)==F.raw(root/'unrelated-index.raw',2*1024**2),'full-feed-unrelated-index-changed')
  output={'repository':name,'sourceCommit':parent,'feedParentCommit':parent,'feedCommit':head,'changedOnly':path,'feedSha256':sha(feed),'sequence':request['signed']['sequence'],'pushed':False,'unrelatedIndexPreserved':True}
 else:
  need(isinstance(request['commit'],dict),'full-original-feed-commit-required');original=request['commit'];head=local_commit(request,path,feed)
  need(original['feedCommit']==head and original['feedParentCommit']==parent and original['feedSha256']==sha(feed) and original['repository']==name and original['unrelatedIndexPreserved'] is True,'full-feed-commit-binding-changed')
  if mode=='execute':
   need(git(request,'ls-remote','--exit-code','origin','refs/heads/main').split()[0]==parent,'full-feed-remote-parent-changed')
   git(request,'push','origin',head+':refs/heads/main')
  if git(request,'ls-remote','--exit-code','origin','refs/heads/main').split()[0]!=head:return result('uncertain','full-original-feed-push-not-observed')
  output={**original,'pushed':True}
 out=root/'result.json'
 if out.exists():need(json.loads(F.raw(out))==output,'full-feed-retained-result-conflict')
 else:F.save(out,output)
 return result('completed','full-feed-original-'+request['phase']+'-verified',output,{'path':str(out),'sha256':sha(F.raw(out))})
def public_readback(request):
 feed=A.ref(request['signed']['signedFeed'],256*1024);url='https://raw.githubusercontent.com/HatimTheDream/Nova-Dream-Public/main/updates/stable.json'
 req=urllib.request.Request(url,headers={'Cache-Control':'no-cache','User-Agent':'Nova-Reviewed-Release'})
 with urllib.request.build_opener(F.NoRedirect()).open(req,timeout=30) as r:
  need(r.status==200 and r.url==url,'full-public-feed-readback-route');raw=r.read(256*1024+1)
 need(raw==feed,'full-public-feed-propagation-pending');return {'state':'completed','reason':'full-public-feed-readback-verified','externalId':request['operationId'],'receipt':None,'output':{'publicFeedReadVerified':True,'publicFeedSha256':sha(raw),'sequence':request['signed']['sequence']}}
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('mode',choices=('execute','observe','readback'));p.add_argument('--request',type=P,required=True);p.add_argument('--request-sha256',required=True);a=p.parse_args()
 try:
  raw=F.raw(a.request,2*1024**2);need(sha(raw)==a.request_sha256,'full-feed-request-changed');v=json.loads(raw);value=public_readback(v) if a.mode=='readback' else produce(a.mode,v)
 except Exception as error:value={'state':'uncertain','reason':'full-original-feed-response-unavailable','externalId':None,'output':None,'receipt':None,'privateDiagnostic':{'type':type(error).__name__[:100],'message':str(error)[:1000]}}
 print(json.dumps(value));sys.exit(0 if value['state']=='completed' else 2)
