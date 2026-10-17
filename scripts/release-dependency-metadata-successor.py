"""Private metadata-only successor packaging; never installs or probes native code.

Retains the exact accepted Linux module closure. The unchanged maintained parser
validates both archives. Every member outside the two official metadata files
must remain byte-for-byte and metadata-identical. Output is exclusive and partial
outputs are retained. A fresh full rehearsal and live acceptance remain required.
"""
import base64,contextlib,copy,hashlib,io,json,os,pathlib,re,stat,tarfile,time,types
P=pathlib.Path
HELPER_SHA='e7f2617ed8d05b7d83da62e857822b737ff3a1c47b6704af5d3e1783e043b290'
MAXIMUM=128*1024**2
QUALITY_POLICY='release-deliver-quality-script-v1'
OLD_QUALITY='npm run typecheck && npm test && npm run security:audit && npm run validate:release && npm run build'
QUALITY_COMMAND='node scripts/quality.mjs'
OLD_TEST='tsx --test --test-concurrency=2 tests/*.test.ts tests/*.test.mjs'
QUALITY_TEST='tsx --test --test-concurrency=4 tests/*.test.ts tests/*.test.mjs'
def need(value,reason):
 if not value:raise RuntimeError(reason)
def sha(raw):return hashlib.sha256(raw).hexdigest()
def identity(s):return (s.st_dev,s.st_ino,s.st_size,s.st_mode,s.st_nlink,s.st_mtime_ns,s.st_ctime_ns)
def shared_identity(s):return identity(s)[:-1]
def ordinary(path,maximum):
 p=P(path);need(p.is_absolute() and p.resolve(strict=True)==p,'canonical-input-required')
 for q in (p,*p.parents):need(not q.is_symlink(),'redirected-input')
 s=p.lstat();need(stat.S_ISREG(s.st_mode) and s.st_nlink==1 and s.st_size<=maximum,'bounded-independent-input-required');return p,s
def digest(path):
 p,s=ordinary(path,MAXIMUM)
 with p.open('rb') as f:
  opened=os.fstat(f.fileno());need(shared_identity(opened)==shared_identity(s),'file-open-race');h=hashlib.file_digest(f,'sha256').hexdigest()
  need(identity(os.fstat(f.fileno()))==identity(opened),'descriptor-changed')
 need(identity(s)==identity(p.lstat()),'input-changed');return h
def read(ref,maximum=2*1024**2):
 need(set(ref)=={'path','sha256'},'exact-reference-required');p,s=ordinary(ref['path'],maximum)
 with p.open('rb') as f:
  opened=os.fstat(f.fileno());need(shared_identity(opened)==shared_identity(s),'file-open-race');raw=f.read(maximum+1)
  need(identity(os.fstat(f.fileno()))==identity(opened),'descriptor-changed')
 need(len(raw)==s.st_size and identity(s)==identity(p.lstat()) and sha(raw)==ref['sha256'],'evidence-changed');return raw
def enc(value):return (json.dumps(value,sort_keys=True,indent=2)+'\n').encode()
def write(path,raw):
 fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|getattr(os,'O_NOFOLLOW',0),0o600)
 with os.fdopen(fd,'wb') as f:f.write(raw);f.flush();os.fsync(f.fileno())
def ref(path):return {'path':str(P(path).absolute()),'sha256':digest(P(path).absolute())}
def module(reference):
 raw=read(reference);need(sha(raw)==HELPER_SHA,'maintained-parser-changed')
 m=types.ModuleType('unchanged_maintained_dependency_contract');m.__file__=reference['path'];exec(compile(raw,m.__file__,'exec'),m.__dict__);return m
def metadata_delta(old_package,old_lock,new_package,new_lock,transition,policy='version-only'):
 need(set(transition)=={'fromVersion','toVersion','fromBuild','toBuild'},'exact-transition-required')
 a,b=copy.deepcopy(old_package),copy.deepcopy(new_package)
 need(a['version']==transition['fromVersion'] and b['version']==transition['toVersion'] and a['edition3']['buildVersion']==transition['fromBuild'] and b['edition3']['buildVersion']==transition['toBuild'],'official-transition-differs')
 need(policy in ('version-only','release-deliver-script-v1',QUALITY_POLICY),'unsupported-dependency-metadata-policy')
 if policy in ('release-deliver-script-v1',QUALITY_POLICY):
  need(isinstance(a.get('scripts'),dict) and isinstance(b.get('scripts'),dict) and b['scripts'].get('release:deliver')=='node scripts/release-deliver.mjs' and ('release:deliver' not in a['scripts'] or a['scripts']['release:deliver']==b['scripts']['release:deliver']),'release-command-metadata-differs')
  if 'release:deliver' not in a['scripts']:del b['scripts']['release:deliver']
 if policy==QUALITY_POLICY:
  need(a['scripts'].get('quality') in (OLD_QUALITY,QUALITY_COMMAND) and b['scripts'].get('quality')==QUALITY_COMMAND,'quality-command-metadata-differs')
  need(a['scripts'].get('test')==b['scripts'].get('test')==OLD_TEST and b['scripts'].get('test:quality')==QUALITY_TEST and ('test:quality' not in a['scripts'] or a['scripts']['test:quality']==QUALITY_TEST),'quality-test-command-metadata-differs')
  if 'test:quality' not in a['scripts']:del b['scripts']['test:quality']
  b['scripts']['quality']=a['scripts']['quality']
 b['version']=a['version'];b['edition3']['buildVersion']=a['edition3']['buildVersion'];need(a==b,'package-change-exceeds-release-metadata')
 a,b=copy.deepcopy(old_lock),copy.deepcopy(new_lock)
 need(a['version']==a['packages']['']['version']==transition['fromVersion'] and b['version']==b['packages']['']['version']==transition['toVersion'],'root-lock-transition-differs')
 b['version']=a['version'];b['packages']['']['version']=a['packages']['']['version'];need(a==b,'dependency-lock-graph-changed')
@contextlib.contextmanager
def archive_read(path,expected):
 p,s=ordinary(path,MAXIMUM)
 with p.open('rb') as stream:
  opened=os.fstat(stream.fileno());need(shared_identity(opened)==shared_identity(s),'archive-open-race')
  need(hashlib.file_digest(stream,'sha256').hexdigest()==expected,'archive-pass-digest-differs');stream.seek(0)
  with tarfile.open(fileobj=stream,mode='r:gz') as archive:yield archive
  need(identity(os.fstat(stream.fileno()))==identity(opened) and identity(p.lstat())==identity(s),'archive-changed-during-pass')
def member_record(member):
 return {'name':member.name,'type':member.type.decode('ascii'),'bytes':member.size,'mode':member.mode,'uid':member.uid,'gid':member.gid,'uname':member.uname,'gname':member.gname,'mtime':member.mtime,'linkname':member.linkname,'pax':member.pax_headers}
def exact_members(archive,members):
 actual=archive.getmembers();need([member_record(m) for m in actual]==[member_record(m) for m in members],'validated-member-closure-differs');return actual
def inventory(path,members,expected):
 result={}
 with archive_read(path,expected) as archive:
  for member in exact_members(archive,members):
   if member.name in ('package.json','package-lock.json'):continue
   row=member_record(member)
   if member.isfile():
    with archive.extractfile(member) as stream:row['sha256']=hashlib.file_digest(stream,'sha256').hexdigest()
   result[member.name]=row
 return result
def release_command(value):
 command=value['releaseCommand']
 need(set(command)=={'policy','command','sourceCommits','sources'} and command['policy']=='release-deliver-script-v1' and command['command']=='node scripts/release-deliver.mjs','exact-release-command-policy-required')
 need(set(command['sourceCommits'])==set(command['sources'])=={'private','public'} and all(isinstance(v,str) and re.fullmatch('[a-f0-9]{40}',v) for v in command['sourceCommits'].values()),'exact-release-command-sources-required')
 sources=[]
 for source in command['sources'].values():
  need(P(source['path']).parts[-2:]==('scripts','release-deliver.mjs'),'release-command-source-path-changed')
  sources.append(read(source))
 need(sources[0] and sources[0]==sources[1],'paired-release-command-source-changed')
 return command['policy']
def quality_command(value):
 release_command(value)
 command=value['qualityCommand']
 need(set(command)=={'policy','command','sourceCommits','sources'} and command['policy']==QUALITY_POLICY and command['command']==QUALITY_COMMAND,'exact-quality-command-policy-required')
 need(command['sourceCommits']==value['releaseCommand']['sourceCommits'] and set(command['sources'])=={'private','public'},'exact-quality-command-sources-required')
 sources=[]
 for source in command['sources'].values():
  need(P(source['path']).parts[-2:]==('scripts','quality.mjs'),'quality-command-source-path-changed')
  sources.append(read(source))
 need(sources[0] and sources[0]==sources[1],'paired-quality-command-source-changed')
 return command['policy']
def validate(value):
 fields={'format','kind','helper','oldArchive','oldMetadata','nativeReceipt','acceptedPair','acceptedInstaller','acceptedBundle','acceptedCandidate','targetPackage','targetLock','transition'}
 need(set(value)==fields|({'releaseCommand','qualityCommand'} if value.get('format')==3 else {'releaseCommand'} if value.get('format')==2 else set()),'exact-input-schema-required')
 need(value['format'] in (1,2,3) and value['kind']=='metadata-only-dependency-successor','unsupported-successor')
 policy=quality_command(value) if value['format']==3 else release_command(value) if value['format']==2 else 'version-only'
 deps=module(value['helper']);old=P(value['oldArchive']['path']);need(digest(old)==value['oldArchive']['sha256'],'old-archive-changed')
 description=json.loads(read(value['oldMetadata']));members=deps.archive_members(old,description)
 native=json.loads(read(value['nativeReceipt']));pair=json.loads(read(value['acceptedPair']))
 installed=json.loads(read(value['acceptedInstaller']));bundle=json.loads(read(value['acceptedBundle'],16*1024**2))
 need(installed['outcome']=='completed' and installed['candidateId']==value['acceptedCandidate']==pair['candidateId'] and all(installed[k] is True for k in ('savedWorkVerified','accountsVerified','recoveryVerified','healthVerified')),'actual-accepted-installation-required')
 pair_entries=[r for r in bundle['files'] if r['name']=='reviewed-pair.json'];need(bundle['format']==1 and len(pair_entries)==1,'accepted-bundle-pair-required')
 entry=pair_entries[0];pair_raw=base64.b64decode(entry['data'],validate=True)
 need(sha(pair_raw)==entry['sha256']==value['acceptedPair']['sha256'] and pair_raw==read(value['acceptedPair']),'accepted-bundle-pair-changed')
 need(sha(read(value['acceptedBundle'],16*1024**2))==value['acceptedBundle']['sha256'],'accepted-bundle-changed')
 need(native['passed'] is True and native['kind']=='exact-231-dependency-repack-result' and native['applicationDependencies']==description==pair['applicationDependencies'],'original-qualified-native-archive-required')
 need(native['dependencyArchive']['sha256']==description['archiveSha256']==value['oldArchive']['sha256'] and native['actualNativeIdentity']=={k:description[k] for k in ('platform','arch','nodeVersion','nodeAbi')} and native['packerSha256']==HELPER_SHA,'native-identity-differs')
 need(native['actualNativeIdentity']=={'platform':'linux','arch':'x64','nodeVersion':'22.23.2','nodeAbi':127},'unsupported-original-native-context')
 package,lock=read(value['targetPackage']),read(value['targetLock'])
 with archive_read(old,value['oldArchive']['sha256']) as archive:
  exact_members(archive,members)
  old_package=json.load(archive.extractfile('package.json'));old_lock=json.load(archive.extractfile('package-lock.json'))
 metadata_delta(old_package,old_lock,json.loads(package),json.loads(lock),value['transition'],policy)
 need(deps.dependency_graph_sha256(json.loads(lock))==description['dependencyGraphSha256'],'dependency-graph-changed')
 return deps,old,description,members,package,lock
def produce(value,directory):
 started=time.monotonic();deps,old,description,members,package,lock=validate(value)
 directory=P(directory);need(directory.is_absolute() and not directory.exists() and not directory.is_symlink(),'exclusive-new-output-required')
 need(directory.parent.resolve(strict=True)==directory.parent and not directory.parent.is_symlink(),'canonical-output-parent-required')
 directory.mkdir(mode=0o700);output=directory/'app-dependencies.tgz'
 # Input members are already validated by the complete maintained parser.
 replacements={'package.json':package,'package-lock.json':lock};expanded=0
 with archive_read(old,value['oldArchive']['sha256']) as before,tarfile.open(output,'x:gz',format=tarfile.PAX_FORMAT,dereference=False) as after:
  for original in exact_members(before,members):
   member=copy.copy(original);member.pax_headers=dict(original.pax_headers)
   if member.name in replacements:
    need(member.isfile() and not member.pax_headers,'ordinary-official-metadata-required');raw=replacements[member.name];member.size=len(raw);after.addfile(member,io.BytesIO(raw))
   elif member.isfile():
    with before.extractfile(original) as stream:after.addfile(member,stream)
   else:after.addfile(member)
   expanded+=member.size
 need(output.stat().st_size<=MAXIMUM,'successor-archive-exceeds-bound')
 successor={**description,'archiveBytes':output.stat().st_size,'archiveSha256':digest(output),'expandedBytes':expanded,'packageLockSha256':sha(lock)}
 new_members=deps.archive_members(output,successor)
 with archive_read(output,successor['archiveSha256']) as archive:
  actual=exact_members(archive,new_members)
  for name,raw in replacements.items():
   need(archive.extractfile(name).read(len(raw)+1)==raw,'official-successor-metadata-bytes-differ')
   a=member_record(next(m for m in members if m.name==name));b=member_record(next(m for m in actual if m.name==name));a.pop('bytes');b.pop('bytes');need(a==b,'official-metadata-header-changed')
 original_inventory=inventory(old,members,value['oldArchive']['sha256']);new_inventory=inventory(output,new_members,successor['archiveSha256'])
 need(original_inventory==new_inventory and original_inventory,'native-module-closure-changed')
 need(digest(old)==value['oldArchive']['sha256'],'original-archive-changed-during-packaging')
 for name in ('helper','oldMetadata','nativeReceipt','acceptedPair','acceptedInstaller','targetPackage','targetLock'):read(value[name])
 read(value['acceptedBundle'],16*1024**2)
 if value['format']==3:quality_command(value)
 elif value['format']==2:release_command(value)
 write(directory/'app-dependencies.tgz.metadata.json',enc(successor))
 need(digest(output)==successor['archiveSha256'],'successor-archive-changed-after-verification')
 result={'format':1,'kind':'verified-metadata-only-dependency-successor','passed':True,'input':value,'inputSha256':sha(enc(value)),'originalArchive':value['oldArchive'],'archive':ref(output),'metadata':ref(directory/'app-dependencies.tgz.metadata.json'),'description':successor,'retainedMemberCount':len(original_inventory),'retainedInventorySha256':sha(enc(original_inventory)),'everyRetainedMemberIdentical':True,'originalNativeQualificationReused':value['nativeReceipt'],'newNativeExecutionClaimed':False,'newTargetStartupClaimed':False,'hostEffects':False,'deliveryQualification':False,'freshFullRehearsalStillRequired':True,'liveAcceptanceStillRequired':True,'elapsedSeconds':time.monotonic()-started}
 if value['format']==3:result.update(format=3,metadataPolicy=value['qualityCommand']['policy'])
 elif value['format']==2:result.update(format=2,metadataPolicy=value['releaseCommand']['policy'])
 write(directory/'result.json',enc(result));return result
if __name__=='__main__':
 import argparse
 parser=argparse.ArgumentParser();parser.add_argument('--input',type=P,required=True);parser.add_argument('--approved-input-sha',required=True);parser.add_argument('--output',type=P);args=parser.parse_args();p=args.input.resolve(strict=True)
 value=json.loads(read({'path':str(p),'sha256':args.approved_input_sha}))
 print(json.dumps(produce(value,args.output.absolute()) if args.output else {'passed':bool(validate(value)),'readOnly':True,'hostEffects':False}))
