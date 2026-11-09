import importlib.util,pathlib,unittest
from unittest.mock import patch
ROOT=pathlib.Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('operator_ci',ROOT/'scripts/release-operator-ci.py')
M=importlib.util.module_from_spec(spec);spec.loader.exec_module(M)
class OperatorCiTests(unittest.TestCase):
 def fixture(self):
  source={'repository':'HatimTheDream/Nova-Dream','branch':'codex/operator-continuation-31','commit':'a'*40,'root':'/synthetic/operator'}
  request={'format':1,'source':source,'runId':123,'tools':{'synthetic':True}}
  run={'id':123,'run_attempt':1,'head_sha':'a'*40,'head_branch':source['branch'],'event':'push','path':'.github/workflows/operator-continuation-quality.yml','name':'Operator continuation quality','status':'completed','conclusion':'success'}
  return request,run,{'total_count':1,'jobs':[{'id':456}]}
 def test_exact_readonly_auth_and_two_api_calls(self):
  request,run,jobs=self.fixture()
  with patch.object(M.D,'credential',return_value='synthetic-token') as credential,patch.object(M.D.C,'api',side_effect=[(200,run),(200,jobs)]) as api:
   self.assertEqual(M.collect(request),{'run':run,'jobs':jobs,'requestedAttempt':1});credential.assert_called_once_with(request['tools'])
   self.assertEqual([c.args[0] for c in api.call_args_list],['/repos/HatimTheDream/Nova-Dream/actions/runs/123','/repos/HatimTheDream/Nova-Dream/actions/runs/123/attempts/1/jobs?per_page=100'])
 def test_wrong_commit_branch_workflow_event_and_conclusion_refused(self):
  for field,value in [('head_sha','b'*40),('head_branch','main'),('path','other.yml'),('event','pull_request'),('conclusion','failure'),('run_attempt',None)]:
   with self.subTest(field=field):
    request,run,jobs=self.fixture();run[field]=value
    with patch.object(M.D,'credential',return_value='synthetic'),patch.object(M.D.C,'api',return_value=(200,run)):
     with self.assertRaisesRegex(RuntimeError,'exact-success'):M.collect(request)
 def test_api_failure_and_ambiguous_jobs_refused(self):
  for replies in [[(404,{})],[(200,self.fixture()[1]),(200,{'total_count':2,'jobs':[{},{}]})]]:
   with patch.object(M.D,'credential',return_value='synthetic'),patch.object(M.D.C,'api',side_effect=replies):
    with self.assertRaises(RuntimeError):M.collect(self.fixture()[0])
 def test_unknown_repository_never_asks_for_credential(self):
  request,_,_=self.fixture();request['source']['repository']='Other/Repository'
  with patch.object(M.D,'credential') as credential:
   with self.assertRaises(RuntimeError):M.collect(request)
   credential.assert_not_called()
if __name__=='__main__':unittest.main()
