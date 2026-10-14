"""Fixed original-operation private artifact transport.

Uses the successful 234 root prestager and its exact finite transfer command.
Every invocation owns one durable child; observation never uploads or copies.
"""
from pathlib import Path as P
import argparse,base64,hashlib,importlib.util,json,os,re,shlex,subprocess,sys,uuid
HERE=P(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('full_prestage_files',HERE/'release-full-publication-primitives.py');F=importlib.util.module_from_spec(spec);spec.loader.exec_module(F)
need=F.need;sha=F.sha
NAMES=('release-delivery-full-prestage.py','release-full-publication-primitives.py','full-host-primitives/asset-stage.py','full-host-primitives/install-facts.py')
def reference(r,maximum=128*1024**2):
 need(set(r)=={'path','sha256'},'prestage-reference-schema');b=F.raw(r['path'],maximum);need(sha(b)==r['sha256'],'prestage-reference-changed');return b
def inspect(request):
 need(set(request)=={'format','operationId','key','inputSha256','transport','binding','files','outputDirectory','helperHashes'},'prestage-exact-request-required')
 need(request['format']==1 and all(str(uuid.UUID(request[n]))==request[n] for n in ('operationId','key')) and re.fullmatch('[a-f0-9]{64}',request['inputSha256']),'prestage-operation-binding')
 need(request['helperHashes']=={n:sha(F.raw(HERE/n,2*1024**2)) for n in NAMES},'prestage-source-closure-changed')
 target=request['transport'];need(set(target)=={'format','hostAlias','sshConfig'} and target['format']==1 and re.fullmatch('[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}',target['hostAlias']),'prestage-fixed-transport-required');reference(target['sshConfig'],65536)
 root=P(request['outputDirectory']);need(root.is_absolute() and root.parent.resolve(strict=True)==root.parent and root.name=='full-prestage-'+request['key'],'prestage-output-scope');need(not root.is_symlink(),'prestage-output-redirected')
 binding=request['binding']
 if binding is not None:
  runtime=binding.get('RUNTIME')
  fields={'BUNDLE','BUNDLE_BYTES','TARGET','PRIOR','PRIOR_VERSION','EPOCH','JOB','LEASE','PROOF','INCOMING','NONCE','SPECS','CURRENT_FACTS','CAPACITY','EXCLUDED','acceptedInstallation','hostConfiguration','STAGE_PLAN','STAGE_INTENT','STAGE_PLAN_RAW_BASE64'}
  need(set(binding)==fields|({'RUNTIME','PRIOR_AGENT_VERSION'} if runtime else set()),'prestage-exact-host-binding')
  need(binding['NONCE']==request['key'] and binding['INCOMING']=='/var/tmp/nova-full-delivery-private-assets-'+request['key'],'prestage-original-transfer-identity')
  need(set(request['files'])=={'bundle.json','app-dependencies.tgz'}|({'runtime.tgz'} if runtime else set()) and set(binding['SPECS'])==set(request['files']),'prestage-exact-assets')
  if runtime:need(runtime['fromVersion']==binding['PRIOR_AGENT_VERSION']=='2026.9.6' and runtime['toVersion']=='2026.9.8' and binding['SPECS']['runtime.tgz']==[runtime['archiveBytes'],runtime['archiveSha256']],'prestage-exact-runtime-transition')
  for name,r in request['files'].items():
   if name=='runtime.tgz':
    need(set(r)=={'path','sha256'} and r['sha256']==runtime['archiveSha256'],'prestage-runtime-ref-changed');F.verify_runtime_file(r['path'],runtime['archiveBytes'],r['sha256'])
   else:b=reference(r);need([len(b),sha(b)]==binding['SPECS'][name],'prestage-authenticated-asset-changed')
 return root
def argv(request):
 target=request['transport'];reference(target['sshConfig'],65536)
 return ['ssh','-F',target['sshConfig']['path'],'-o','BatchMode=yes','-o','ConnectTimeout=15','-o','ConnectionAttempts=1','-T',target['hostAlias']]
def program(request,mode):
 name='install-facts.py' if mode=='facts' else 'asset-stage.py';source=F.raw(HERE/'full-host-primitives'/name,2*1024**2)
 need(sha(source)==request['helperHashes']['full-host-primitives/'+name],'prestage-program-changed')
 b64=base64.b64encode(source).decode();binding={**(request['binding'] or {}),'MODE':mode};data=base64.b64encode(json.dumps(binding).encode()).decode()
 return ("import base64,hashlib,json,signal\nsignal.alarm(300)\ns=base64.b64decode('"+b64+"',validate=True)\nassert hashlib.sha256(s).hexdigest()=='"+sha(source)+"'\nBINDING=json.loads(base64.b64decode('"+data+"',validate=True))\nexec(compile(s,'fixed-original-full-prestage','exec'),{'__name__':'__main__','BINDING':BINDING})\n").encode()
def remote(request,mode):
 p=program(request,mode);r=subprocess.run(argv(request)+['sudo -n /usr/bin/python3 -B -'],input=p,capture_output=True,timeout=360)
 need(r.returncode==0 and len(r.stdout)<=131072 and len(r.stderr)<=4096,'prestage-original-remote-outcome-uncertain')
 return {'remoteResult':json.loads(r.stdout),'stdoutRawBase64':base64.b64encode(r.stdout).decode(),'stdoutSha256':sha(r.stdout),'stderrSha256':sha(r.stderr)}
def produce(mode,request):
 root=inspect(request);effect=mode in ('prepare-input','upload-bundle','upload-dependencies','upload-runtime','stage')
 need(mode in ('facts','plan','prepare-input','upload-bundle','upload-dependencies','upload-runtime','stage','observe','transfer-observe'),'prestage-fixed-mode')
 if not root.exists():root.mkdir(mode=0o700)
 need(root.resolve(strict=True)==root and root.is_dir(),'prestage-output-redirected')
 intent={'format':1,'operationId':request['operationId'],'key':request['key'],'inputSha256':request['inputSha256'],'requestSha256':sha(F.enc(request)),'phase':mode,'automaticReplayPermitted':False}
 if effect:F.save(root/(mode+'-dispatch.json'),intent)
 if mode.startswith('upload-'):
  name={'upload-bundle':'bundle.json','upload-dependencies':'app-dependencies.tgz','upload-runtime':'runtime.tgz'}[mode];path=P(request['files'][name]['path']);expected=request['binding']['SPECS'][name];incoming=request['binding']['INCOMING']
  # Same qualified nonroot, exclusive, 300-second transfer as release234.
  command='/usr/lib/cargo/bin/coreutils/timeout --signal=TERM --kill-after=5s 300s /bin/sh -c '+shlex.quote('umask 077; set -C; cat > '+incoming+'/'+name)
  before=path.stat();identity=lambda s:(s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_nlink)
  with path.open('rb') as source:
   need(identity(os.fstat(source.fileno()))==identity(before),'prestage-transfer-source-replaced')
   r=subprocess.run(argv(request)+[command],stdin=source,capture_output=True,timeout=330)
   need(identity(os.fstat(source.fileno()))==identity(before),'prestage-transfer-source-changed')
  need(identity(path.stat())==identity(before) and r.returncode==0 and len(r.stdout)<=4096 and len(r.stderr)<=4096,'prestage-original-transfer-uncertain')
  value={'format':1,'transferred':True,'name':name,'bytes':expected[0],'sha256':expected[1],'incoming':incoming,'authenticatedSourcePreserved':True}
 else:value=remote(request,mode)
 return {'state':'completed','reason':'full-prestage-'+mode+'-observed','externalId':request['operationId'],'receipt':None,'output':value}
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('mode',choices=('facts','plan','prepare-input','upload-bundle','upload-dependencies','upload-runtime','stage','observe','transfer-observe'));p.add_argument('--request',type=P,required=True);p.add_argument('--request-sha256',required=True);a=p.parse_args()
 try:
  raw=F.raw(a.request,2*1024**2);need(sha(raw)==a.request_sha256,'prestage-request-changed');value=produce(a.mode,json.loads(raw))
 except Exception as error:value={'state':'uncertain','reason':'full-original-prestage-unsettled','externalId':None,'receipt':None,'output':None,'privateDiagnostic':{'type':type(error).__name__[:100],'message':str(error)[:1000]}}
 print(json.dumps(value));sys.exit(0 if value['state']=='completed' else 2)
