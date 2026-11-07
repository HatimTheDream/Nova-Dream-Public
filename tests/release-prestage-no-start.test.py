"""Portable original-job facts regression; filesystem/network boundaries are inert."""
import copy, hashlib, json, pathlib, runpy, stat, unittest
from types import SimpleNamespace
from unittest.mock import patch

F = runpy.run_path(str(pathlib.Path(__file__).resolve().parents[1] / 'scripts/full-host-primitives/install-facts.py'))
G = F['collect'].__globals__
P = pathlib.PurePosixPath
H = lambda b: hashlib.sha256(b).hexdigest()
ENC = lambda v: json.dumps(v, sort_keys=True, separators=(',', ':')).encode()
OP = '10000000-0000-4000-8000-000000000001'
KEY = '10000000-0000-4000-8000-000000000002'
JOB = '10000000-0000-4000-8000-000000000003'
OLD = '10000000-0000-4000-8000-000000000004'
EPOCH = '10000000-0000-4000-8000-000000000005'
PF = 'preflight-10000000-0000-4000-8000-000000000006.json'


class NoStartFacts(unittest.TestCase):
    def fixture(self):
        authority = dict(operationId=OP, idempotencyKey=KEY, jobId=JOB,
                         candidateId='a'*64, priorCandidateId='b'*64, workspaceEpoch=EPOCH, bundleSha256='c'*64)
        config = {'format': 1, 'stateDirectory': '/var/lib/nova-update'}
        operation = {k:v for k,v in authority.items() if k != 'jobId'} | dict(format=1,
            priorVersion='1.2.3', priorBuildVersion='1.0.3', priorAgentVersion='2026.9.8',
            schemaVersion=60, applicationQualification={'priorSchemaVersion':55})
        release = {'candidateId':'a'*64, 'fromCandidateId':'b'*64, 'bundle':{'sha256':'c'*64}}
        job = dict(id=JOB, idempotencyKey=KEY, candidateId='a'*64, fromCandidateId='b'*64,
                   releaseId='c'*64, epoch=EPOCH, state='failed', prepared=True, started=False, hold=False, when='now', release=release)
        request = dict(epoch=EPOCH,candidateId='a'*64,releaseId='c'*64,currentCandidateId='b'*64,idempotencyKey=KEY,when='now')
        intent = dict(format=1,kind='nova-normal-install-intent',operationId=OP,operationSha256=H(ENC(operation)),
                      controllerConfigSha256=H(ENC(config)),request=request,requestSha256=H(ENC(request)),automaticResubmissionPermitted=False)
        preflight = dict(format=1,jobId=JOB,release=release,hostConfiguration='/etc/nova-update/config.json',
                         preflightIdentity=dict(candidateId='b'*64,workspaceEpoch=EPOCH))
        result = dict(format=1,jobId=OLD,candidateId='b'*64,priorCandidateId='d'*64,outcome='completed',
                      savedWorkVerified=True,accountsVerified=True,recoveryVerified=True,healthVerified=True)
        state='/var/lib/nova-update'
        records={}
        def put(path,value):
            raw=ENC(value);records[path]=raw;return dict(path=path,sha256=H(raw))
        config_ref=put('/etc/nova-update/config.json',config)
        op_ref=put(state+'/release-coordinator/inputs/'+OP+'.json',operation)
        intent_ref=put(state+'/release-coordinator/'+OP+'/intent.json',intent)
        pf_ref=put(state+'/staging/'+'c'*64+'/attempts/'+JOB+'/'+PF,preflight)
        accepted=put(state+'/staging/'+'e'*64+'/attempts/'+OLD+'/result.json',result)
        records[state+'/jobs/journal.json']=ENC(dict(currentId=JOB,jobs=[job]))
        prior=dict(candidateId='b'*64,version='1.2.3',buildVersion='1.0.3',agentVersion='2026.9.8',
                   workspaceEpoch=EPOCH,schemaVersion=55,appRoot='/opt/nova/releases/prior/app')
        spec=dict(kind='explicit-no-start-prior-facts',hostConfiguration=config_ref,acceptedInstallation=accepted,
                  priorJobId=OLD,prior=prior,failure=dict(operation=op_ref,intent=intent_ref,preflight=pf_ref,
                  coordinatorExport=dict(path='/private/export.json',sha256='f'*64),authority=authority))
        view=dict(holdFor=None,job={k:job[k] for k in ('id','state','candidateId','releaseId')})
        identity=dict(health=dict(candidateId='b'*64),workspaceEpoch=EPOCH,selectors={})
        return spec,records,job,view,identity

    def observe(self,spec,records,view,identity,names=None,reader=None):
        def read(path,bound):
            raw=records[str(path)];self.assertLessEqual(len(raw),bound);return raw
        with patch.dict(G, P=P,read=reader or read,controller_view=lambda:copy.deepcopy(view),
                        members=lambda _p:list(names if names is not None else [PF]),
                        prior_identity=lambda _c,p:copy.deepcopy(identity)), patch.object(G['os'],'geteuid',return_value=0,create=True):
            return F['collect'](spec)

    def test_separates_failed_current_job_from_authentic_accepted_prior(self):
        spec,records,job,view,identity=self.fixture()
        result=self.observe(spec,records,view,identity)
        self.assertEqual(result['currentJob'],job)
        self.assertEqual(result['currentJob']['state'],'failed')
        self.assertEqual(result['resultValue']['jobId'],OLD)
        self.assertEqual(result['resultValue']['outcome'],'completed')
        self.assertEqual(result['noStartFailure']['input'],spec)
        self.assertTrue(result['noStartFailure']['installerArtifactsAbsent'])

    def test_no_missing_result_fallback_without_explicit_scope(self):
        spec,records,_job,view,identity=self.fixture()
        with self.assertRaises(KeyError):self.observe(None,records,view,identity)

    def test_started_held_unprepared_nonfailed_and_wrong_job_are_refused(self):
        for field,value in [('started',True),('started',0),('prepared',False),('prepared',1),('hold',True),('state','restored'),('candidateId','d'*64),('fromCandidateId','d'*64),('epoch',OP),('idempotencyKey',OP)]:
            with self.subTest(field=field,value=value):
                spec,records,job,view,identity=self.fixture();job[field]=value
                records['/var/lib/nova-update/jobs/journal.json']=ENC(dict(currentId=JOB,jobs=[job]))
                view['job']={k:job[k] for k in ('id','state','candidateId','releaseId')}
                with self.assertRaises(RuntimeError):self.observe(spec,records,view,identity)

    def test_any_installer_artifact_or_missing_preflight_refuses(self):
        for names in ([],[PF,'request.json'],[PF,'driver-attempt.json'],[PF,'result.json'],[PF,'runner.log']):
            with self.subTest(names=names):
                spec,records,_job,view,identity=self.fixture()
                with self.assertRaises(RuntimeError):self.observe(spec,records,view,identity,names)

    def test_original_config_intent_preflight_or_accepted_bytes_cannot_change(self):
        for role in ('operation','intent','preflight','acceptedInstallation','hostConfiguration'):
            with self.subTest(role=role):
                spec,records,_job,view,identity=self.fixture()
                ref=spec[role] if role in spec else spec['failure'][role]
                records[ref['path']]+=b' '
                with self.assertRaises(RuntimeError):self.observe(spec,records,view,identity)

    def test_preflight_request_and_intent_identity_remain_positive_guards(self):
        for role,change in [('preflight',lambda v:v.update(jobId=OLD)),('preflight',lambda v:v.update(preflightIdentity={'candidateId':'d'*64,'workspaceEpoch':EPOCH})),('intent',lambda v:v.update(automaticResubmissionPermitted=True)),('intent',lambda v:v.update(controllerConfigSha256='0'*64))]:
            spec,records,_job,view,identity=self.fixture();ref=spec['failure'][role]
            value=json.loads(records[ref['path']]);change(value);records[ref['path']]=ENC(value);ref['sha256']=H(records[ref['path']])
            with self.subTest(role=role),self.assertRaises(RuntimeError):self.observe(spec,records,view,identity)

    def test_journal_race_and_controller_hold_refuse(self):
        spec,records,_job,view,identity=self.fixture();view['holdFor']=JOB
        with self.assertRaises(RuntimeError):self.observe(spec,records,view,identity)
        spec,records,_job,view,identity=self.fixture();count=0
        def raced(path,bound):
            nonlocal count
            raw=records[str(path)]
            if str(path).endswith('/jobs/journal.json'):
                count+=1
                if count>1:return raw+b' '
            return raw
        with self.assertRaises(RuntimeError):self.observe(spec,records,view,identity,reader=raced)

    def test_ordinary_completed_current_result_is_unchanged(self):
        spec,records,job,view,identity=self.fixture();job.update(id=OLD,state='completed',candidateId='b'*64,releaseId='e'*64)
        records['/var/lib/nova-update/jobs/journal.json']=ENC(dict(currentId=OLD,jobs=[job]))
        view['job']={k:job[k] for k in ('id','state','candidateId','releaseId')}
        facts=self.observe(None,records,view,identity)
        self.assertEqual(facts['resultValue']['jobId'],OLD)
        self.assertNotIn('noStartFailure',facts)

    def test_real_prior_identity_predicate_checks_health_epoch_and_selectors(self):
        spec,_records,_job,_view,_identity=self.fixture();prior=spec['prior']
        config=dict(appCurrent='/opt/nova/current',releaseDirectory='/opt/nova/releases',
                    agentDirectory='/opt/nova/runtime/agent',runtimeDirectory='/opt/nova/runtime')
        baseline=dict(status='ready',candidateId='b'*64,version='1.2.3',buildVersion='1.0.3',schemaVersion=55,apiVersion=1)
        def invoke(change=None):
            health=copy.deepcopy(baseline);epoch=EPOCH;target=prior['appRoot'];agent_version='2026.9.8'
            if change:
                key,value=change
                if key=='epoch':epoch=value
                elif key=='selector':target=value
                elif key=='agentVersion':agent_version=value
                else:health[key]=value
            targets={config['appCurrent']:target,config['agentDirectory']:'/opt/nova/runtime/openclaw'}
            class NativePath(P):
                def resolve(self,strict=False):return NativePath(targets.get(str(self),str(self)))
                def lstat(self):return SimpleNamespace(st_uid=0,st_mode=stat.S_IFDIR|0o700)
            class Response:
                status=200
                def __init__(self,value):self.value=value
                def __enter__(self):return self
                def __exit__(self,*_args):pass
                def read(self,bound):return ENC(self.value)
            class Opener:
                def open(self,request,timeout):
                    self_url=request.full_url
                    return Response({'workspaceEpoch':epoch} if self_url.endswith('/access/context') else health)
            with patch.dict(G,P=NativePath,read=lambda _p,_b:ENC({'name':'openclaw','version':agent_version})),patch.object(G['urllib'].request,'build_opener',return_value=Opener()):
                return F['prior_identity'](config,prior)
        self.assertEqual(invoke()['health'],baseline)
        for change in [('candidateId','d'*64),('version','9.9.9'),('buildVersion','9.9.9'),('schemaVersion',60),('apiVersion',2),('status','starting'),('epoch',OP),('selector','/opt/nova/releases/other/app'),('selector','/tmp/other/app'),('agentVersion','2026.9.6')]:
            with self.subTest(change=change),self.assertRaises(RuntimeError):invoke(change)


if __name__=='__main__':unittest.main()
