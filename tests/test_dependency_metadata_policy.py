import base64,copy,hashlib,importlib.util,io,json,pathlib,tarfile,tempfile,unittest
from unittest.mock import patch
from types import SimpleNamespace
ROOT=pathlib.Path(__file__).resolve().parent.parent
def load(name,path):
 spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
m=load('metadata_successor',ROOT/'scripts/release-dependency-metadata-successor.py')
deps=load('maintained_dependency_parser',ROOT/'deploy/update-runner/app_dependencies.py')
class MetadataPolicy(unittest.TestCase):
 def fixture(self,format=2,script=True):
  temp=tempfile.TemporaryDirectory(prefix='nova-metadata-policy-');self.addCleanup(temp.cleanup);root=pathlib.Path(temp.name).resolve()
  def put(name,value):
   path=root/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(value if isinstance(value,bytes) else m.enc(value));return m.ref(path)
  old={'name':'nova-dream-edition-3','version':'2.3.5','edition3':{'buildVersion':'1.0.292'},'dependencies':{'fixture':'1.0.0'},'engines':{'node':'>=22.19.0'},'scripts':{'build':'node build.mjs','postinstall':'node prepare.mjs'}}
  lock={'name':old['name'],'version':old['version'],'lockfileVersion':3,'packages':{'':{'name':old['name'],'version':old['version'],'dependencies':old['dependencies']},'node_modules/fixture':{'version':'1.0.0'}}}
  new=copy.deepcopy(old);new['version']='2.4.0';new['edition3']['buildVersion']='1.0.293'
  if script:new['scripts']['release:deliver']='node scripts/release-deliver.mjs'
  target_lock=copy.deepcopy(lock);target_lock['version']=target_lock['packages']['']['version']=new['version']
  entries=[('package.json',m.enc(old)),('package-lock.json',m.enc(lock)),('node_modules',None),('node_modules/fixture',None),('node_modules/fixture/package.json',m.enc({'name':'fixture','version':'1.0.0'})),('node_modules/fixture/index.js',b'export const fixture = 1;\n'),('node_modules/.bin',None),('node_modules/.bin/fixture','../fixture/index.js')]
  archive=root/'old.tgz';expanded=0
  with tarfile.open(archive,'x:gz',format=tarfile.PAX_FORMAT) as out:
   for name,data in entries:
    item=tarfile.TarInfo(name);item.mode=0o777 if isinstance(data,str) else 0o755 if data is None else 0o644
    if data is None:item.type=tarfile.DIRTYPE;out.addfile(item)
    elif isinstance(data,str):item.type=tarfile.SYMTYPE;item.linkname=data;out.addfile(item)
    else:item.size=len(data);expanded+=len(data);out.addfile(item,io.BytesIO(data))
  description={'format':1,'archiveBytes':archive.stat().st_size,'archiveSha256':m.digest(archive),'expandedBytes':expanded,'fileCount':len(entries),'packageLockSha256':m.sha(m.enc(lock)),'dependencyGraphSha256':deps.dependency_graph_sha256(lock),'platform':'linux','arch':'x64','nodeVersion':'22.23.2','nodeAbi':127}
  helper=m.ref(ROOT/'deploy/update-runner/app_dependencies.py');pair={'candidateId':'a'*64,'applicationDependencies':description};pair_ref=put('pair.json',pair)
  native={'passed':True,'kind':'exact-231-dependency-repack-result','applicationDependencies':description,'dependencyArchive':m.ref(archive),'actualNativeIdentity':{k:description[k] for k in ('platform','arch','nodeVersion','nodeAbi')},'packerSha256':m.HELPER_SHA}
  value={'format':format,'kind':'metadata-only-dependency-successor','helper':helper,'oldArchive':m.ref(archive),'oldMetadata':put('metadata.json',description),'nativeReceipt':put('native-synthetic.json',native),'acceptedPair':pair_ref,'acceptedInstaller':put('installed-synthetic.json',{'outcome':'completed','candidateId':'a'*64,**{k:True for k in ('savedWorkVerified','accountsVerified','recoveryVerified','healthVerified')}}),'acceptedBundle':put('bundle-synthetic.json',{'format':1,'files':[{'name':'reviewed-pair.json','data':base64.b64encode(m.read(pair_ref)).decode(),'sha256':pair_ref['sha256']}]}),'acceptedCandidate':'a'*64,'targetPackage':put('target/package.json',new),'targetLock':put('target/package-lock.json',target_lock),'transition':{'fromVersion':old['version'],'toVersion':new['version'],'fromBuild':old['edition3']['buildVersion'],'toBuild':new['edition3']['buildVersion']}}
  if format==2:value['releaseCommand']={'policy':'release-deliver-script-v1','command':'node scripts/release-deliver.mjs','sourceCommits':{'private':'b'*40,'public':'c'*40},'sources':{side:put(side+'/scripts/release-deliver.mjs',b'// synthetic authenticated command\n') for side in ('private','public')}}
  return root,value,old,lock,new,target_lock,put
 def test_explicit_v2_parser_pack_preserves_every_module_member_and_native_claim(self):
  root,v,*_=self.fixture();out=m.produce(v,root/'produced')
  self.assertEqual(out['format'],2);self.assertEqual(out['metadataPolicy'],'release-deliver-script-v1');self.assertTrue(out['everyRetainedMemberIdentical']);self.assertEqual(out['retainedMemberCount'],6)
  self.assertEqual(out['originalNativeQualificationReused'],v['nativeReceipt']);self.assertFalse(out['newNativeExecutionClaimed']);self.assertFalse(out['newTargetStartupClaimed']);self.assertTrue(out['freshFullRehearsalStillRequired'])
  before=deps.archive_members(v['oldArchive']['path'],json.loads(m.read(v['oldMetadata'])));after=deps.archive_members(out['archive']['path'],out['description'])
  self.assertEqual(m.inventory(v['oldArchive']['path'],before,v['oldArchive']['sha256']),m.inventory(out['archive']['path'],after,out['archive']['sha256']))
 def test_format1_still_refuses_script_addition_but_allows_only_versions(self):
  root,v,*_=self.fixture(format=1)
  with self.assertRaisesRegex(RuntimeError,'package-change-exceeds'):m.produce(v,root/'must-not-exist')
  self.assertFalse((root/'must-not-exist').exists())
  root,v,*_=self.fixture(format=1,script=False);self.assertEqual(m.produce(v,root/'produced')['format'],1)
 def test_all_other_package_metadata_and_complete_lock_remain_exact(self):
  root,v,old,lock,new,new_lock,put=self.fixture()
  changes=[lambda x:x['scripts'].__setitem__('postinstall','changed'),lambda x:x['scripts'].__setitem__('preinstall','new'),lambda x:x['scripts'].__setitem__('prerelease:deliver','new'),lambda x:x['scripts'].__setitem__('build','changed'),lambda x:x['engines'].__setitem__('node','24'),lambda x:x['dependencies'].__setitem__('fixture','2'),lambda x:x.__setitem__('devDependencies',{'new':'1'}),lambda x:x['scripts'].__setitem__('release:deliver','node wrong.mjs')]
  for change in changes:
   candidate=copy.deepcopy(new);change(candidate)
   with self.assertRaises(RuntimeError):m.metadata_delta(old,lock,candidate,new_lock,v['transition'],'release-deliver-script-v1')
  for location in ('','node_modules/fixture'):
   candidate=copy.deepcopy(new_lock);candidate['packages'][location]['unexpected']=True
   with self.assertRaisesRegex(RuntimeError,'dependency-lock-graph'):m.metadata_delta(old,lock,new,candidate,v['transition'],'release-deliver-script-v1')
 def test_source_absence_changed_bytes_and_unbound_path_refuse_before_output(self):
  for change in ('absent','bytes','path','different-public'):
   root,v,*_=self.fixture();ref=v['releaseCommand']['sources']['public'];path=pathlib.Path(ref['path'])
   if change=='absent':path.unlink()
   elif change=='path':ref['path']=str(path.with_name('other.mjs'))
   else:path.write_bytes(b'changed command');ref.update(m.ref(path) if change=='different-public' else {})
   with self.assertRaises((RuntimeError,FileNotFoundError)):m.produce(v,root/'must-not-exist')
   self.assertFalse((root/'must-not-exist').exists())

class FrozenCommandSource(unittest.TestCase):
 def test_optional_command_is_read_from_exact_git_commit_and_absence_is_not_invented(self):
  c=load('artifact_primitives',ROOT/'scripts/release-artifact-primitives.py')
  for enabled,missing in ((False,False),(True,False),(True,True)):
   with tempfile.TemporaryDirectory(prefix='nova-source-policy-') as temporary:
    root=pathlib.Path(temporary).resolve();checkout=root/'checkout';checkout.mkdir();commit='a'*40;calls=[]
    package={'scripts':{'release:deliver':'node scripts/release-deliver.mjs'}} if enabled else {'scripts':{}}
    def run(args,**kwargs):
     command=args[1:];calls.append(command)
     if command[0]=='rev-parse':raw=(commit+'\n').encode()
     elif command[:3]==['remote','get-url','origin']:raw=b'https://github.com/HatimTheDream/Nova-Dream-Public.git\n'
     elif command[0]=='show':
      name=command[1].split(':',1)[1]
      if name=='scripts/release-deliver.mjs' and missing:return SimpleNamespace(returncode=1,stdout=b'',stderr=b'missing')
      raw=json.dumps(package).encode() if name=='package.json' else b'exact committed source'
     else:raise AssertionError(command)
     return SimpleNamespace(returncode=0,stdout=raw,stderr=b'')
    with patch.object(c.subprocess,'run',run):
     if missing:
      with self.assertRaisesRegex(RuntimeError,'Frozen Git source check failed'):c.frozen_source('Nova-Dream-Public',commit,'fixture-git',checkout=checkout,output_root=root,committed_only=True)
     else:
      source,bound=c.frozen_source('Nova-Dream-Public',commit,'fixture-git',checkout=checkout,output_root=root,committed_only=True)
      self.assertEqual('scripts/release-deliver.mjs' in bound,enabled)
      if enabled:self.assertEqual((source/'scripts/release-deliver.mjs').read_bytes(),b'exact committed source')
    self.assertEqual(['show',commit+':scripts/release-deliver.mjs'] in calls,enabled)
if __name__=='__main__':unittest.main()
