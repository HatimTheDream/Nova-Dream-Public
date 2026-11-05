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
if __name__=='__main__':unittest.main()
