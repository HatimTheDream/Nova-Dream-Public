import hashlib,importlib.util,json,pathlib,tempfile,types,unittest,uuid
HERE=pathlib.Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('worker',HERE.parent/'scripts/release-dependency-local-worker.py');w=importlib.util.module_from_spec(spec);spec.loader.exec_module(w)
class Checks(unittest.TestCase):
 def fixture(self,phase='plan',failure=None):
  temp=tempfile.TemporaryDirectory(prefix='nova-local-dependency-worker-');self.addCleanup(temp.cleanup);root=pathlib.Path(temp.name).resolve()
  def sha(raw):return hashlib.sha256(raw).hexdigest()
  def enc(value):return (json.dumps(value,sort_keys=True,indent=2)+'\n').encode()
  def ref(path):return {'path':str(path),'sha256':sha(path.read_bytes())}
  def read(r):
   raw=pathlib.Path(r['path']).read_bytes()
   if sha(raw)!=r['sha256']:raise RuntimeError('evidence-changed')
   return raw
  calls=[]
  def validate(value):
   calls.append('validate')
   if failure:raise RuntimeError(failure)
   return (True,)
  def produce(value,directory):
   calls.append('produce');directory.mkdir();(directory/'result.json').write_bytes(enc({'realSyntheticResult':True}))
  def write(path,raw):
   with path.open('xb') as stream:stream.write(raw)
  engine=types.SimpleNamespace(read=read,ref=ref,write=write,enc=enc,validate=validate,produce=produce)
  (root/'input.json').write_bytes(enc({'synthetic':True}));now=1000
  request={'format':1,'kind':'maintained-local-dependency-request','phase':phase,'operationId':str(uuid.uuid4()),'parentKey':str(uuid.uuid4()),'phaseKey':str(uuid.uuid4()),'inputSha256':'a'*64,'reservedAtMs':now,'deadlineAtMs':now+615000,'producerSha256':w.PRODUCER_SHA,'input':ref(root/'input.json'),'outputDirectory':str(root/'produced') if phase=='execute' else None}
  path=root/(phase+'-request.json');path.write_bytes(enc(request));return root,path,ref,enc,request,engine,calls
 def test_exact_maintained_successor_loaded_without_changes(self):
  m=w.load_producer();self.assertEqual(m.HELPER_SHA,'e7f2617ed8d05b7d83da62e857822b737ff3a1c47b6704af5d3e1783e043b290');self.assertTrue(callable(m.validate));self.assertTrue(callable(m.produce))
 def test_known_refusal_is_persisted_without_opaque_process_error(self):
  root,path,ref,enc,request,engine,calls=self.fixture(failure='dependency-lock-graph-changed');out=w.execute(path,ref(path)['sha256'],engine=engine,clock=lambda:1001)
  self.assertEqual(out['state'],'failed');self.assertEqual(out['reason'],'dependency-lock-graph-changed');self.assertIsNone(out['result']);self.assertEqual(calls,['validate']);self.assertEqual(json.loads((root/'plan-outcome.json').read_bytes()),out)
 def test_plan_and_execute_bind_original_keys_and_real_result(self):
  for phase in ('plan','execute'):
   root,path,ref,enc,request,engine,calls=self.fixture(phase);out=w.execute(path,ref(path)['sha256'],engine=engine,clock=lambda:1001)
   self.assertEqual(out['state'],'completed');self.assertEqual(out['phaseKey'],request['phaseKey']);self.assertEqual(out['request'],ref(path));self.assertFalse(out['hostEffects']);self.assertEqual(calls,['validate' if phase=='plan' else 'produce'])
   if phase=='execute':self.assertEqual(out['result'],ref(root/'produced/result.json'))
   with self.assertRaisesRegex(RuntimeError,'outcome-present'):w.execute(path,ref(path)['sha256'],engine=engine,clock=lambda:1002)
 def test_expired_reservation_records_failure_without_replay(self):
  root,path,ref,enc,request,engine,calls=self.fixture();out=w.execute(path,ref(path)['sha256'],engine=engine,clock=lambda:request['deadlineAtMs'])
  self.assertEqual(out['state'],'failed');self.assertEqual(out['reason'],'original-dependency-deadline-expired');self.assertEqual(calls,[])
 def test_wrong_scope_or_extended_deadline_refuses_before_writes(self):
  for field,value in [('outputDirectory','/unrelated'),('deadlineAtMs',9999999)]:
   root,path,ref,enc,request,engine,calls=self.fixture();request[field]=value;path.write_bytes(enc(request))
   with self.assertRaises(RuntimeError):w.execute(path,ref(path)['sha256'],engine=engine,clock=lambda:1001)
   self.assertFalse((root/'plan-outcome.json').exists());self.assertEqual(calls,[])
if __name__=='__main__':unittest.main()
