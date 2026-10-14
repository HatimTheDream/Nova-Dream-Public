from pathlib import Path as P
import importlib.util,json,sys,unittest,uuid
from types import SimpleNamespace
from unittest.mock import patch
ROOT=P(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('frontend_plan',ROOT/'scripts/release-frontend-plan.py');M=importlib.util.module_from_spec(spec);spec.loader.exec_module(M)
class Tests(unittest.TestCase):
    def fixture(self):
        op=str(uuid.uuid4());root='/var/lib/nova-update/frontend/operator-inputs/'+op;ref=lambda p,c:{'path':p,'sha256':c*64}
        value={'format':1,'operationId':op,'baseVersion':'2.3.0','baseCandidateId':'a'*64,'serviceInputsSha256':'b'*64,'frontendId':'c'*64,'sourceRevision':'d'*40,'version':'2.3.1','buildVersion':'1.0.288',
               'worker':{'path':'/opt/nova-updater-2.3.0-aaaaaaaaaaaa/deploy/update-runner/frontend.py','sha256':M.WORKER_SHA},'config':ref('/etc/nova-update/frontend.json','e'),'operation':ref(root+'/operation.json','f'),
               'assets':{r:ref(root+'/frontend.'+e,c) for r,e,c in [('manifest','json','1'),('signature','sig','2'),('archive','tgz','3')]},'processIdentity':str(uuid.uuid4()),'workspaceEpoch':str(uuid.uuid4())}
        base={'candidateId':value['baseCandidateId'],'serviceInputsSha256':value['serviceInputsSha256'],'apiVersion':1,'schemaVersion':55}
        plan={'format':1,'operationId':op,'operationSha256':value['operation']['sha256'],'configSha256':value['config']['sha256'],'manifestSha256':value['assets']['manifest']['sha256'],'signatureSha256':value['assets']['signature']['sha256'],'archiveSha256':value['assets']['archive']['sha256'],'frontendId':value['frontendId'],
              'live':{**base,'epoch':value['workspaceEpoch'],'active':False},'health':{**base,'epoch':value['workspaceEpoch'],'processIdentity':value['processIdentity']},'priorRecovery':{'base':base}}
        return value,plan,root
    def test_maintained_arguments_do_not_reissue_execute_on_resume(self):
        value,plan,root=self.fixture();args=M.worker_arguments(value,'resume');self.assertIn('--resume',args);self.assertNotIn('--execute',args);self.assertNotIn('--plan-receipt',args)
        with self.assertRaisesRegex(RuntimeError,'original-inputs'):M.worker_arguments(value,'resume',{'path':root+'/plan.json'},None)
        with self.assertRaisesRegex(RuntimeError,'exact-plan-and-intent'):M.worker_arguments(value,'execute')
    def independent(self):
        value,plan,root=self.fixture()
        value.update(format=2,workerInstallation={'version':'2.3.0','candidateId':'e'*64},baseVersion='2.3.1')
        value['worker']['path']='/opt/nova-updater-2.3.0-eeeeeeeeeeee/deploy/update-runner/frontend.py'
        return value,plan,root
    def test_independent_installed_worker_preserves_current_service_binding(self):
        value,plan,root=self.independent()
        self.assertEqual(M.worker_arguments(value,'plan')[2],value['worker']['path'])
        self.assertIs(M.verify_plan(value,plan),plan)
        plan['health']['candidateId']=value['workerInstallation']['candidateId']
        with self.assertRaisesRegex(RuntimeError,'service-changed'):M.verify_plan(value,plan)
    def test_independent_worker_rejects_wrong_identity_path_hash_and_legacy_reinterpretation(self):
        for name in ('version','candidate','path','hash','missing','extra','legacy','format'):
            value,plan,root=self.independent()
            if name=='version':value['workerInstallation']['version']='2.3.1'
            elif name=='candidate':value['workerInstallation']['candidateId']='f'*64
            elif name=='path':value['worker']['path']='/opt/unreviewed/frontend.py'
            elif name=='hash':value['worker']['sha256']='f'*64
            elif name=='missing':del value['workerInstallation']
            elif name=='extra':value['workerInstallation']['path']='/opt/other'
            elif name=='legacy':value['format']=1
            else:value['format']=True
            with self.subTest(name=name),self.assertRaises(RuntimeError):M.worker_arguments(value,'plan')
    def test_full_plan_delegated_with_finite_readonly_timeout_and_rechecked_inputs(self):
        value,plan,root=self.fixture();raw=json.dumps(plan).encode();calls=[]
        def run(args,**kwargs):calls.append((args,kwargs));return SimpleNamespace(returncode=0,stdout=raw,stderr=b'')
        with patch.object(M.sys,'platform','linux'),patch.object(M.os,'geteuid',return_value=0,create=True),patch.object(M,'inspect',return_value=M.worker_arguments(value,'plan')) as inspect:
            out=M.plan(value,run);self.assertEqual(inspect.call_count,2)
        self.assertEqual(calls[0][1]['timeout'],90);self.assertIn('--plan',calls[0][0]);self.assertNotIn('--execute',calls[0][0]);self.assertFalse(out['capacityQualified']);self.assertFalse(out['effectDispatchQualified'])
    def test_wrong_service_and_conflicting_lease_are_rejected(self):
        for kind in ('process','lease','epoch'):
            value,plan,root=self.fixture()
            if kind=='process':plan['health']['processIdentity']=str(uuid.uuid4())
            elif kind=='lease':plan['live']['active']=True
            else:plan['live']['epoch']=str(uuid.uuid4())
            with self.assertRaises(RuntimeError):M.verify_plan(value,plan)
    def test_nonzero_or_oversized_worker_response_never_becomes_plan(self):
        value,plan,root=self.fixture()
        for response in (SimpleNamespace(returncode=1,stdout=json.dumps(plan).encode(),stderr=b''),SimpleNamespace(returncode=0,stdout=b'x'*(128*1024+1),stderr=b'')):
            with patch.object(M.sys,'platform','linux'),patch.object(M.os,'geteuid',return_value=0,create=True),patch.object(M,'inspect',return_value=[]):
                with self.assertRaisesRegex(RuntimeError,'plan-unavailable'):M.plan(value,lambda *a,**k:response)
if __name__=='__main__':unittest.main()
