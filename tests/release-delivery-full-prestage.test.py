import ast,hashlib,importlib.util,json,pathlib,tempfile,unittest,threading,concurrent.futures
from unittest.mock import patch
HERE=pathlib.Path(__file__).resolve().parents[1]/'scripts'
spec=importlib.util.spec_from_file_location('full_prestage',HERE/'release-delivery-full-prestage.py');M=importlib.util.module_from_spec(spec);spec.loader.exec_module(M)

class OriginalChildTests(unittest.TestCase):
 def test_concurrent_original_prepare_has_one_remote_winner(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=pathlib.Path(tmp);request={'operationId':'op','key':'key','inputSha256':'a'*64};entered=threading.Event();release=threading.Event()
   def first_remote(*_args):
    entered.set();self.assertTrue(release.wait(2));raise TimeoutError('original remote response remains unknown')
   with patch.object(M,'inspect',return_value=root),patch.object(M,'remote',side_effect=first_remote) as remote,concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
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
   root=pathlib.Path(tmp);r={'operationId':'op','key':'key','inputSha256':'a'*64}
   with patch.object(M,'inspect',return_value=root),patch.object(M,'remote',side_effect=TimeoutError('lost')) as remote:
    with self.assertRaises(TimeoutError):M.produce('prepare-input',r)
    self.assertTrue((root/'prepare-input-dispatch.json').is_file())
    with self.assertRaises(FileExistsError):M.produce('prepare-input',r)
    self.assertEqual(remote.call_count,1)
   with patch.object(M,'inspect',return_value=root),patch.object(M,'remote',return_value={'actual':'original'}) as remote:
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

if __name__=='__main__':unittest.main()
