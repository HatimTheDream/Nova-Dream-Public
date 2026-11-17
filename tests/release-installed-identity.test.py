import copy,importlib.util,pathlib,types,unittest,uuid
P=pathlib.Path;ROOT=P(__file__).resolve().parent.parent
def module(name,p):
 s=importlib.util.spec_from_file_location(name,p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
m=module('full_identity',ROOT/'scripts/release-installed-identity.py')
r=module('actual_requester',ROOT/'deploy/update-runner/request_install.py')
class Identity(unittest.TestCase):
 def setUp(self):
  self.op={'operationId':str(uuid.uuid4()),'idempotencyKey':str(uuid.uuid4()),'candidateId':'a'*64,'priorCandidateId':'b'*64,'workspaceEpoch':str(uuid.uuid4()),'bundleSha256':'c'*64,'version':'2.3.0','buildVersion':'1.0.287','schemaVersion':55,'apiVersion':1}
  self.job={'id':str(uuid.uuid4()),'hold':False};self.view={'holdFor':None,'job':{'id':self.job['id'],'candidateId':self.op['candidateId'],'releaseId':self.op['bundleSha256']}}
 def test_actual_maintained_result_shape_and_uncertain_loss(self):
  holder=types.SimpleNamespace(operation=self.op);value=r.InstallRequest.result(holder,'completed',self.job,self.view)
  m.validate_observation(value,self.op,self.job['id'])
  for state in ('uncertain','running','failed'):
   with self.assertRaises(RuntimeError):m.validate_observation(r.InstallRequest.result(holder,state,self.job,self.view),self.op,self.job['id'])
 def test_wrong_original_job_key_hold_or_candidate_refused(self):
  value=r.InstallRequest.result(types.SimpleNamespace(operation=self.op),'completed',self.job,self.view)
  for k,v in [('jobId',str(uuid.uuid4())),('idempotencyKey',str(uuid.uuid4())),('candidateId','e'*64),('controllerHoldObserved',False),('controllerHoldFor',str(uuid.uuid4())),('jobHold',True)]:
   changed={**value,k:v}
   with self.assertRaises(RuntimeError):m.validate_observation(changed,self.op,self.job['id'])
 def test_real_installer_completed_shape_rejects_partial(self):
  value={'format':1,'jobId':self.job['id'],'candidateId':self.op['candidateId'],'priorCandidateId':self.op['priorCandidateId'],'outcome':'completed','savedWorkVerified':True,'accountsVerified':True,'recoveryVerified':True,'healthVerified':True}
  m.validate_result(value,self.op,self.job['id'])
  for name in ('savedWorkVerified','accountsVerified','recoveryVerified','healthVerified'):
   with self.assertRaises(RuntimeError):m.validate_result({**value,name:False},self.op,self.job['id'])
 def test_epoch_is_separate_actual_access_context(self):
  health={k:self.op[k] for k in ('candidateId','version','buildVersion','schemaVersion','apiVersion')};health.update(status='ready',serviceInputsSha256='d'*64,processIdentity=str(uuid.uuid4()),frontend={'source':'bundled','id':'e'*64})
  access={'workspaceEpoch':self.op['workspaceEpoch'],'recovery':False,'recoveryLocal':False}
  self.assertEqual(m.validate_health(health,access,self.op)['epoch'],self.op['workspaceEpoch'])
  with self.assertRaises(RuntimeError):m.validate_health(health,{**access,'workspaceEpoch':str(uuid.uuid4())},self.op)
 def test_installed_schema60_must_retain_exact_requester_qualified_pair_and_projection(self):
  pair={'candidateId':self.op['candidateId'],'priorCandidateId':self.op['priorCandidateId']}
  proof={'qualificationBinding':{'workspaceEpoch':self.op['workspaceEpoch']}}
  pair_raw=m.enc(pair);projection_raw=m.enc(proof)
  qualification={'pair':pair,'proof':proof,'reviewedPairSha256':m.sha(pair_raw),'projectionSha256':m.sha(projection_raw)}
  operation={**self.op,'schemaVersion':60,'applicationQualification':{'priorSchemaVersion':55,'reviewedPairSha256':m.sha(pair_raw),'projectionSha256':m.sha(projection_raw)}}
  m.validate_staged_qualification(operation,qualification,pair_raw,projection_raw)
  for a,b in [(pair_raw+b' ',projection_raw),(pair_raw,projection_raw+b' '),(m.enc({**pair,'candidateId':'e'*64}),projection_raw)]:
   with self.assertRaises(RuntimeError):m.validate_staged_qualification(operation,qualification,a,b)
  changed=copy.deepcopy(qualification);changed['proof']['qualificationBinding']['workspaceEpoch']=str(uuid.uuid4())
  with self.assertRaises(RuntimeError):m.validate_staged_qualification(operation,changed,pair_raw,projection_raw)
 def test_same_schema_requester_is_exact_current_source_and_old39_remains_pinned(self):
  current=m.sha((ROOT/'deploy/update-runner/request_install.py').read_bytes())
  old={**self.op,'schemaVersion':60,'applicationQualification':{'priorSchemaVersion':55}}
  new={**self.op,'schemaVersion':60,'applicationQualification':{'priorSchemaVersion':60}}
  self.assertEqual(m.requester_reference(old),{'path':'/opt/nova-release-tools/'+m.REQUESTER_SHA+'/request_install.py','sha256':m.REQUESTER_SHA})
  self.assertEqual(m.requester_reference(new),{'path':'/opt/nova-release-tools/'+current+'/request_install.py','sha256':current})
  self.assertNotEqual(current,m.REQUESTER_SHA)
  self.assertEqual(m.SAME_SCHEMA60_REQUESTER_SHA,current)
  self.assertIn(m.requester_reference(new),m.requester_references(old))
  for operation,helper in [(new,m.requester_reference(old))]:
   binding={'format':1,'operation':operation,'jobId':self.job['id'],'requester':helper,'runtime':{}}
   with self.assertRaisesRegex(RuntimeError,'full-maintained-requester-required'):
    m.original(binding,types.SimpleNamespace())
 def test_current_requester_capability_matrix_and_unknown_helpers(self):
  current=m.sha((ROOT/'deploy/update-runner/request_install.py').read_bytes());self.assertEqual(current,m.SAME_SCHEMA60_REQUESTER_SHA)
  legacy='15ae855d7025b9cc267b7a7529ac59c5fdcc1cf960e00104578ba79b3007dc06'
  for mode,operation in [('plain55',self.op),('transition60',{**self.op,'schemaVersion':60,'applicationQualification':{'priorSchemaVersion':55}}),('same60',{**self.op,'schemaVersion':60,'applicationQualification':{'priorSchemaVersion':60}})]:
   for digest in (current,m.REQUESTER_SHA,legacy,'0'*64):
    with self.subTest(mode=mode,digest=digest):
     helper={'path':'/opt/nova-release-tools/'+digest+'/request_install.py','sha256':digest}
     binding={'format':1,'operation':operation,'jobId':self.job['id'],'requester':helper,'runtime':{}}
     calls=[]
     def load(name,path,raw):calls.append((path,raw));raise LookupError('selected-exact-requester')
     support=types.SimpleNamespace(load_module=load,ref=lambda value,maximum,private: value)
     if digest==current or (digest==m.REQUESTER_SHA and mode!='same60'):
      with self.assertRaisesRegex(LookupError,'selected-exact-requester'):m.original(binding,support)
      self.assertEqual(calls,[(helper['path'],helper)])
     else:
      with self.assertRaisesRegex(RuntimeError,'full-maintained-requester-required'):m.original(binding,support)
      self.assertEqual(calls,[])
  for operation in [{**self.op,'schemaVersion':56},{**self.op,'applicationQualification':None},{**self.op,'schemaVersion':60},{**self.op,'schemaVersion':60,'applicationQualification':{'priorSchemaVersion':True}}]:
   with self.assertRaisesRegex(RuntimeError,'supported-requester-capability'):m.requester_references(operation)
if __name__=='__main__':unittest.main()
