import ast,hashlib,importlib.util,json,pathlib,re,tempfile,unittest,threading,concurrent.futures
from unittest.mock import patch
from full_host_metadata_fixture import frozen_host_metadata
HERE=pathlib.Path(__file__).resolve().parents[1]/'scripts'
spec=importlib.util.spec_from_file_location('full_prestage',HERE/'release-delivery-full-prestage.py');M=importlib.util.module_from_spec(spec);spec.loader.exec_module(M)

def original_prepare_request(directory):
 """Use the real local validator; only the remote boundary is mocked."""
 key='e70e77aa-6494-49ce-b2a7-7359cd1e73f7'
 def put(name,raw):
  path=directory/name;path.write_bytes(raw)
  return {'path':str(path),'sha256':hashlib.sha256(raw).hexdigest()}
 config=put('ssh-config',b'Host test\n')
 files={name:put(name,raw) for name,raw in (('bundle.json',b'{}\n'),('app-dependencies.tgz',b'synthetic dependency archive'))}
 fields=('BUNDLE','BUNDLE_BYTES','TARGET','PRIOR','PRIOR_VERSION','EPOCH','JOB','LEASE','PROOF','INCOMING','NONCE','SPECS','CURRENT_FACTS','CAPACITY','EXCLUDED','acceptedInstallation','hostConfiguration','STAGE_PLAN','STAGE_INTENT','STAGE_PLAN_RAW_BASE64')
 binding=dict.fromkeys(fields)
 binding.update(BUNDLE=files['bundle.json']['sha256'],BUNDLE_BYTES=3,TARGET='b'*64,PRIOR='c'*64,
  PRIOR_VERSION='1.0.0',EPOCH=key,JOB=key,LEASE=key,PROOF='d'*64,NONCE=key,
  INCOMING='/var/tmp/nova-full-delivery-private-assets-'+key,
  SPECS={name:[pathlib.Path(ref['path']).stat().st_size,ref['sha256']] for name,ref in files.items()},
  CURRENT_FACTS={},CAPACITY={},EXCLUDED=[],acceptedInstallation=files['bundle.json'],
  hostConfiguration=files['bundle.json'],STAGE_PLAN={},STAGE_INTENT={},STAGE_PLAN_RAW_BASE64='e30K')
 return {'format':1,'operationId':key,'key':key,'inputSha256':'a'*64,
  'transport':{'format':1,'hostAlias':'test','sshConfig':config},'binding':binding,
  'files':files,'outputDirectory':str(directory/('full-prestage-'+key)),
  'helperHashes':{n:hashlib.sha256((HERE/n).read_bytes()).hexdigest() for n in M.NAMES}}

class OriginalChildTests(unittest.TestCase):
 def test_concurrent_original_prepare_has_one_remote_winner(self):
  with tempfile.TemporaryDirectory() as tmp:
   request=original_prepare_request(pathlib.Path(tmp));root=M.inspect(request);root.mkdir();entered=threading.Event();release=threading.Event()
   def first_remote(*_args):
    entered.set();self.assertTrue(release.wait(2));raise TimeoutError('original remote response remains unknown')
   with patch.object(M,'remote',side_effect=first_remote) as remote,concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
    first=pool.submit(M.produce,'prepare-input',request)
    try:
     self.assertTrue(entered.wait(2));second=pool.submit(M.produce,'prepare-input',request)
     with self.assertRaises(FileExistsError):second.result(timeout=2)
     self.assertEqual(remote.call_count,1)
    finally:release.set()
    with self.assertRaises(TimeoutError):first.result(timeout=2)
   self.assertTrue((root/'prepare-input-dispatch.json').is_file())
 def test_lost_prepare_response_cannot_repeat_effect(self):
  with tempfile.TemporaryDirectory() as tmp:
   r=original_prepare_request(pathlib.Path(tmp));root=M.inspect(r)
   with patch.object(M,'remote',side_effect=TimeoutError('lost')) as remote:
    with self.assertRaises(TimeoutError):M.produce('prepare-input',r)
    self.assertTrue((root/'prepare-input-dispatch.json').is_file())
    with self.assertRaises(FileExistsError):M.produce('prepare-input',r)
    self.assertEqual(remote.call_count,1)
   with patch.object(M,'remote',return_value={'actual':'original'}) as remote:
    result=M.produce('transfer-observe',r);self.assertEqual(remote.call_args.args[1],'transfer-observe');self.assertEqual(result['state'],'completed')
 def test_exact_source_closure_and_transport_are_checked_before_program(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=pathlib.Path(tmp);config=root/'ssh-config';config.write_bytes(b'Host test\n')
   key='e70e77aa-6494-49ce-b2a7-7359cd1e73f7'
   request={'format':1,'operationId':key,'key':key,'inputSha256':'a'*64,'transport':{'format':1,'hostAlias':'test','sshConfig':{'path':str(config),'sha256':hashlib.sha256(config.read_bytes()).hexdigest()}},'binding':None,'files':{},'outputDirectory':str(root/('full-prestage-'+key)),'helperHashes':{n:hashlib.sha256((HERE/n).read_bytes()).hexdigest() for n in M.NAMES}}
   M.inspect(request);request['helperHashes']['full-host-primitives/asset-stage.py']='0'*64
   with self.assertRaisesRegex(RuntimeError,'source-closure'):M.inspect(request)
 def test_fixed_program_checks_source_before_exec_and_keeps_finite_alarm(self):
  request={'binding':None,'helperHashes':{n:hashlib.sha256((HERE/n).read_bytes()).hexdigest() for n in M.NAMES}}
  source=M.program(request,'facts').decode();self.assertLess(source.index('hashlib.sha256'),source.index('exec(compile'));self.assertIn('signal.alarm(300)',source)

 def test_restored_facts_reach_unchanged_remote_boundary_without_projection(self):
  import runpy
  restored_tests=runpy.run_path(str(HERE.parent/'tests/release-prestage-restored.test.py'))
  original=restored_tests['RestoredFacts']().fixture()[0]
  with tempfile.TemporaryDirectory() as tmp:
   request=original_prepare_request(pathlib.Path(tmp));request.update(binding={'FACTS_INPUT':original},files={})
   with patch.object(M,'remote',return_value={'readOnly':True,'hostWrites':False}) as remote:
    result=M.produce('facts',request)
    self.assertEqual(result['state'],'completed')
    self.assertEqual(remote.call_args.args,(request,'facts'))
    self.assertEqual(remote.call_args.args[0]['binding']['FACTS_INPUT'],original)
   root=pathlib.Path(request['outputDirectory'])
   self.assertEqual(list(root.iterdir()),[])
 def test_unknown_facts_kind_or_asset_payload_refuses_before_remote_or_directory(self):
  for kind,with_files in [('explicit-other-prior-facts',False),('explicit-restored-prior-facts',True)]:
   with self.subTest(kind=kind,with_files=with_files),tempfile.TemporaryDirectory() as tmp:
    request=original_prepare_request(pathlib.Path(tmp))
    request['binding']={'FACTS_INPUT':{'kind':kind}}
    if not with_files:request['files']={}
    with patch.object(M,'remote') as remote,self.assertRaisesRegex(RuntimeError,'prestage-facts-input-scope'):
     M.produce('facts',request)
    remote.assert_not_called();self.assertFalse(pathlib.Path(request['outputDirectory']).exists())
 def test_upload_uses_qualified_gnu_timeout_and_keeps_one_exclusive_nonroot_attempt(self):
  import shlex
  from types import SimpleNamespace
  with tempfile.TemporaryDirectory() as tmp:
   request=original_prepare_request(pathlib.Path(tmp))
   with patch.object(M.subprocess,'run',return_value=SimpleNamespace(returncode=0,stdout=b'',stderr=b'')) as remote:
    result=M.produce('upload-bundle',request)
    command=remote.call_args.args[0]
    self.assertEqual(command[:-1],M.argv(request))
    self.assertEqual(shlex.split(command[-1]),['/usr/bin/gnutimeout','--signal=TERM','--kill-after=5s','300s','/bin/sh','-c',
     'umask 077; set -C; cat > '+request['binding']['INCOMING']+'/bundle.json'])
    self.assertEqual(remote.call_args.kwargs['timeout'],330)
    self.assertNotIn('sudo',command[-1])
    self.assertTrue(result['output']['authenticatedSourcePreserved'])
    self.assertTrue(result['output']['transferred'])
    with self.assertRaises(FileExistsError):M.produce('upload-bundle',request)
    self.assertEqual(remote.call_count,1)
 def test_timed_out_upload_keeps_original_dispatch_and_observation_never_resends(self):
  with tempfile.TemporaryDirectory() as tmp:
   request=original_prepare_request(pathlib.Path(tmp));directory=pathlib.Path(request['outputDirectory'])
   with patch.object(M.subprocess,'run',side_effect=M.subprocess.TimeoutExpired('owned-upload',330)) as upload:
    with self.assertRaises(M.subprocess.TimeoutExpired):M.produce('upload-bundle',request)
    intent=(directory/'upload-bundle-dispatch.json').read_bytes()
    with self.assertRaises(FileExistsError):M.produce('upload-bundle',request)
    with patch.object(M,'remote',return_value={'readOnly':True,'hostWrites':False}) as observer:
     result=M.produce('transfer-observe',request)
     self.assertEqual(observer.call_args.args[1],'transfer-observe')
     self.assertEqual(result['state'],'completed')
    self.assertEqual((directory/'upload-bundle-dispatch.json').read_bytes(),intent)
    self.assertEqual(upload.call_count,1)

 def test_verify_plan_is_readonly_and_never_reserves_an_effect(self):
  with tempfile.TemporaryDirectory() as tmp:
   request=original_prepare_request(pathlib.Path(tmp));directory=pathlib.Path(request['outputDirectory'])
   with patch.object(M,'remote',return_value={'readOnly':True,'hostWrites':False}) as remote:
    result=M.produce('verify-plan',request)
    self.assertEqual(result['state'],'completed');self.assertEqual(remote.call_args.args[1],'verify-plan')
   self.assertEqual(list(directory.iterdir()),[])

class RootPrimitiveTests(unittest.TestCase):
 def functions(self,*names):
  source=(HERE/'full-host-primitives/asset-stage.py').read_bytes();tree=ast.parse(source);nodes=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in names]
  scope={'require':lambda v,r:None if v else (_ for _ in ()).throw(RuntimeError(r))};exec(compile(ast.Module(body=nodes,type_ignores=[]),'root-pure-functions','exec'),scope);return scope
 def test_capacity_accounts_two_artifact_copies_and_no_reclaim(self):
  s=self.functions('allocation_contract','paid_allocation_credit');a=s['allocation_contract']({'archiveBytes':500,'expandedBytes':1000,'fileCount':2},{'expandedBytes':5000,'fileCount':10},{'bundle.json':(100,'a'),'app-dependencies.tgz':(200,'b')},4096)
  self.assertEqual(a['operatingFloorBytes'],1879048192);self.assertFalse(a['closedRecoveryCapacityAdmitted']);self.assertEqual(a['futureReclaimCreditBytes'],0);self.assertEqual(a['archiveRoles'],2)
  self.assertEqual(s['paid_allocation_credit'](100,8192,4096),4096)
  with self.assertRaises(RuntimeError):s['allocation_contract']({'archiveBytes':500,'expandedBytes':1000,'fileCount':2},{'expandedBytes':5000,'fileCount':10},{'bundle.json':(100,'a')},4096)
 def test_optional_runtime_reserves_two_archives_and_complete_expansion(self):
  s=self.functions('allocation_contract');app={'archiveBytes':500,'expandedBytes':1000,'fileCount':2};deps={'expandedBytes':5000,'fileCount':10};specs={'bundle.json':(100,'a'),'app-dependencies.tgz':(200,'b')}
  prior=s['allocation_contract'](app,deps,specs,4096)
  runtime={'fromVersion':'2026.9.6','toVersion':'2026.9.8','archiveBytes':393036425,'archiveSha256':'c','expandedBytes':1311821282,'fileCount':53590}
  current=s['allocation_contract'](app,deps,{**specs,'runtime.tgz':(runtime['archiveBytes'],'c')},4096,runtime)
  expanded=runtime['expandedBytes']+runtime['fileCount']*4096
  self.assertEqual(current['archiveRoles'],3);self.assertEqual(current['runtimeExpansionBytes'],expanded)
  self.assertEqual(current['requiredBeforeCopiesBytes']-prior['requiredBeforeCopiesBytes'],2*((runtime['archiveBytes']+4095)//4096*4096)+expanded)
  self.assertFalse(current['closedRecoveryCapacityAdmitted']);self.assertEqual(current['futureReclaimCreditBytes'],0)
  with self.assertRaises(RuntimeError):s['allocation_contract'](app,deps,{**specs,'runtime.tgz':(runtime['archiveBytes'],'c')},4096,{**runtime,'fromVersion':'2026.9.2'})
 def test_observers_contain_no_copy_upload_or_receipt_writes(self):
  tree=ast.parse((HERE/'full-host-primitives/asset-stage.py').read_bytes())
  for node in [n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in ('observe_original','observe_transfers')]:
   calls=[n.func.id for n in ast.walk(node) if isinstance(n,ast.Call) and isinstance(n.func,ast.Name)]
   self.assertNotIn('save',calls);self.assertNotIn('write',calls);self.assertNotIn('sync',calls)
  observe=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='observe_original');self.assertIn('Observed destination artifact bytes changed.',ast.unparse(observe))

 def test_host_verify_plan_delegates_exact_raw_plan_check_and_returns_before_writes(self):
  import argparse,contextlib,io,os,signal,sys
  s=self.functions('main');verified=[]
  s.update(argparse=argparse,json=json,os=os,frozen_gate=lambda:None,preflight=lambda:'/protected/staging',
   BUNDLE='a'*64,SPECS={'app-dependencies.tgz':(1,'b'*64)},JOB='original-job',
   CURRENT_FACTS={'result':{'sha256':'c'*64}},PROOF='d'*64,INCOMING='/var/tmp/original',
   NONCE='original-nonce',STAGE_INTENT={'planSha256':'e'*64},runtime_pins=lambda:{},
   verify_dispatch_plan=lambda:verified.append(True),save=lambda *_args:self.fail('readonly verification wrote host receipt'))
  output=io.StringIO()
  with patch.object(sys,'argv',['asset-stage','verify-plan']),patch.object(os,'geteuid',return_value=0,create=True),\
       patch.object(os,'umask'),patch.dict(os.environ,SUDO_UID='1000',SUDO_GID='1000'),\
       patch.object(signal,'SIGALRM',14,create=True),patch.object(signal,'signal'),patch.object(signal,'alarm',create=True),contextlib.redirect_stdout(output):
   s['main']()
  self.assertEqual(verified,[True]);result=json.loads(output.getvalue())
  self.assertEqual(result,dict(format=1,kind='exact-full-private-prestage-plan-reverified',readOnly=True,hostWrites=False,
   planSha256='e'*64,bundleSha256='a'*64,nonce='original-nonce'))

class MetadataStageTests(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  source=HERE/'full-host-primitives/metadata-stage.py';tree,cls.helpers=frozen_host_metadata(HERE.parent)
  functions={'need','sha','enc','helper_family','checked_payload','metadata_capacity'}
  assignments={'FROZEN_HELPERS','FROZEN_APPLICATION_HELPERS','FROZEN_SAME_SCHEMA60_FAMILIES'}
  nodes=[n for n in tree.body if (isinstance(n,ast.FunctionDef) and n.name in functions) or
   (isinstance(n,ast.Assign) and len(n.targets)==1 and isinstance(n.targets[0],ast.Name) and n.targets[0].id in assignments)]
  cls.scope={'ast':ast,'hashlib':hashlib,'json':json,'base64':__import__('base64'),'re':re,'P':pathlib.PurePosixPath}
  # Only actual pure admission/capacity definitions; no remote entrypoint or effects.
  exec(compile(ast.Module(body=nodes,type_ignores=[]),str(source),'exec'),cls.scope)
  module=(HERE/'release-delivery-full-host.mjs').read_text(encoding='utf-8')
  cls.legacy_helpers=ast.literal_eval(re.search(r'export const FULL_HELPERS=Object.freeze\((\{.*?\})\);',module,re.S).group(1))
  cls.historical_helpers=ast.literal_eval(re.search(r'export const FULL_APPLICATION_HELPERS=Object.freeze\((\{.*?\})\);',module,re.S).group(1))
  cls.same_schema_families=cls.scope['FROZEN_SAME_SCHEMA60_FAMILIES']
  cls.marker=dict(format=1,kind='schema-60-same-runtime',schemaVersion=60,apiVersion=1,agentVersion='2026.9.8')
  cls.transition=dict(format=1,kind='schema-55-to-60-same-runtime',fromSchemaVersion=55,toSchemaVersion=60,apiVersion=1,fromAgentVersion='2026.9.8',toAgentVersion='2026.9.8')
  cls.review=dict(helperHashes=cls.helpers,sameSchemaQualification=cls.marker,leaseId='12942d2f-d9df-4fdf-a617-7833a21cfde7')
  cls.payload={name:(HERE.parent/'deploy/update-runner'/name).read_bytes() for name in cls.helpers}
  cls.payload['operator-review.json']=cls.scope['enc'](cls.review)
 def request(self,payload=None,review=None):
  payload=dict(self.payload if payload is None else payload)
  review=json.loads(payload['operator-review.json']) if review is None else review
  payload['operator-review.json']=self.scope['enc'](review)
  root='/opt/nova-release-tools/test/rehearsal-'+self.review['leaseId']
  packet=dict(format=2,capacityScope='metadata-stage-only',root=root,stageParent='/opt/nova-release-tools/test',
   leaseId=self.review['leaseId'],sourceCommit='a'*40,runnerSha256='b'*64,
   files={n:dict(path=root+'/'+n,bytes=len(b),sha256=hashlib.sha256(b).hexdigest()) for n,b in payload.items()},
   facts=dict(review=review,sourceCommit='a'*40))
  return dict(packet=packet,packetSha256=self.scope['sha'](self.scope['enc'](packet)),runnerSha256='b'*64,
   files={n:__import__('base64').b64encode(b).decode() for n,b in payload.items()})
 def test_every_static_primitive_helper_map_matches_its_qualified_family(self):
  actual={name:hashlib.sha256(self.payload[name]).hexdigest() for name in self.helpers}
  self.assertEqual(self.helpers,actual);self.assertEqual(len(actual),11);self.assertEqual(len(self.legacy_helpers),7)
  self.assertNotEqual(self.helpers,self.historical_helpers)
  expected={'FROZEN_HELPERS':self.legacy_helpers,'FROZEN_APPLICATION_HELPERS':self.historical_helpers};maps=[]
  for path in sorted((HERE/'full-host-primitives').glob('*.py')):
   for node in ast.walk(ast.parse(path.read_bytes())):
    if not isinstance(node,ast.Assign):continue
    try:value=ast.literal_eval(node.value)
    except (ValueError,TypeError,SyntaxError):continue
    if isinstance(value,dict) and any(name in actual and isinstance(pin,str) and re.fullmatch('[a-f0-9]{64}',pin) for name,pin in value.items()):
     name=ast.unparse(node.targets[0]);maps.append((path.name,name));self.assertIn(value,expected.values(),str(path))
     if path.name=='metadata-stage.py':self.assertEqual(value,expected[name])
  for name in expected:self.assertIn(('metadata-stage.py',name),maps)
  self.assertIn(self.helpers,self.same_schema_families)
  for family in self.same_schema_families:self.assertEqual(set(family),set(actual))
 def test_exact_legacy_historical_and_current_marker_map_matrix(self):
  select=self.scope['helper_family']
  rows=[({},[self.legacy_helpers]),({'applicationTransition':self.transition},[self.historical_helpers]),({'sameSchemaQualification':self.marker},self.same_schema_families)]
  for markers,families in rows:
   for family in families:self.assertEqual(select(dict(helperHashes=family,**markers),family),family)
   for wrong in [self.legacy_helpers,self.historical_helpers,*self.same_schema_families]:
    if wrong not in families:
     with self.subTest(markers=markers,wrong=wrong),self.assertRaisesRegex(RuntimeError,'exact-helper-family-required'):
      select(dict(helperHashes=wrong,**markers),wrong)
 def test_malformed_or_conflicting_markers_never_relabel_a_family(self):
  changes=[dict(self.marker,format=True),dict(self.marker,schemaVersion=55),dict(self.marker,apiVersion=2),dict(self.marker,agentVersion='2026.9.9'),dict(self.marker,passed=True),None]
  for marker in changes:
   with self.subTest(marker=marker),self.assertRaises(RuntimeError):self.scope['helper_family'](dict(helperHashes=self.helpers,sameSchemaQualification=marker),self.helpers)
  with self.assertRaisesRegex(RuntimeError,'marker-conflict'):
   self.scope['helper_family'](dict(self.review,applicationTransition=self.transition),self.helpers)
  with self.assertRaises(RuntimeError):self.scope['helper_family'](dict(helperHashes=self.historical_helpers,applicationTransition=dict(self.transition,toSchemaVersion=61)),self.historical_helpers)
 def test_actual_helper_payload_keeps_metadata_only_operating_reserve(self):
  self.assertEqual(self.scope['checked_payload'](self.request()),self.payload)
  result=self.scope['metadata_capacity'](self.payload,4096,2**40)
  self.assertEqual(result['operatingFloorBytes'],1879048192)
  self.assertEqual(result['requiredFreeBytes'],1879048192+result['incrementalAllocatedBytesMaximum'])
  self.assertEqual(result['futureReclaimCreditBytes'],0)
  self.assertFalse(result['fullRehearsalCapacityAdmitted']);self.assertTrue(result['fullMaintainedPlanStillRequired'])
 def test_current_payload_cannot_drop_add_or_mix_any_imported_helper(self):
  variants=[{n:v for n,v in self.payload.items() if n!=name} for name in self.helpers]
  variants += [dict(self.payload,unexpected=b'extra')]
  variants += [{**self.payload,name:self.payload[name]+b'\n# changed fixture\n'} for name in self.helpers]
  for changed in variants:
   with self.subTest(names=list(changed)),self.assertRaises(RuntimeError):self.scope['metadata_capacity'](changed,4096,2**40)
   with self.assertRaises(RuntimeError):self.scope['checked_payload'](self.request(changed))
 def test_rehashed_packet_with_wrong_review_marker_or_map_is_rejected(self):
  reviews=[{k:v for k,v in self.review.items() if k!='sameSchemaQualification'},dict(self.review,helperHashes=self.historical_helpers),dict(self.review,applicationTransition=self.transition),dict(self.review,sameSchemaQualification=dict(self.marker,format=True))]
  for review in reviews:
   with self.subTest(review=review),self.assertRaises(RuntimeError):self.scope['checked_payload'](self.request(review=review))
 def test_packet_hash_bytes_and_review_lineage_still_bind_admission(self):
  for mutation in ('packet','bytes','facts'):
   request=self.request()
   if mutation=='packet':request['packet']['sourceCommit']='c'*40
   elif mutation=='bytes':request['files']['install.py']=__import__('base64').b64encode(b'changed').decode()
   else:
    request['packet']['facts']['sourceCommit']='c'*40
    request['packetSha256']=self.scope['sha'](self.scope['enc'](request['packet']))
   with self.subTest(mutation=mutation),self.assertRaises(RuntimeError):self.scope['checked_payload'](request)
 def test_actual_payload_one_byte_below_operating_floor_and_increment_fails(self):
  capacity=self.scope['metadata_capacity'](self.payload,4096,2**40)
  self.assertEqual(self.scope['metadata_capacity'](self.payload,4096,capacity['requiredFreeBytes']),capacity)
  with self.assertRaisesRegex(RuntimeError,'metadata-stage-plus-maintained-operating-reserve'):
   self.scope['metadata_capacity'](self.payload,4096,capacity['requiredFreeBytes']-1)

if __name__=='__main__':unittest.main()
